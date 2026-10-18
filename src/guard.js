// -----------------------------------------------------------------------------
// The guard of a production index (energy-production-sensor / index), shared
// by the EZ1 and the ECU. Pure. Same rules as gladys-p1-monitor's guard.
//
// The core turns the deltas of an index into 30-minute production: it skips
// a delta below zero but counts every rise IN FULL. So 5,000 -> 0 -> 5,000
// kWh, or 5,000 -> 4,000 (a drop taken) -> 5,000, would count thousands of
// fictitious kWh. The rules:
// - a value of 0 (or below, or not a number) is never published, first
//   reading included;
// - a value plausible after the last one published (not lower, not more than
//   `maxKw` on average since then, over at least `minHours`, plus `slack`)
//   goes through; a value EQUAL to it goes through and dates the reference;
// - a drop and a jump up are NEVER confirmed by repetition nor by time: they
//   are held, shown in the status and the test button, kept in /data, and
//   taken only by an explicit gesture of the user (the `accept_index`
//   button), and only within bounds: the value shown (`first`, read at
//   `firstAt`) minus `slack`, up to it plus what could be produced since;
//   any other value is held again and the acceptance dropped. A drop taken gives the core a
//   negative delta (nothing counted); a jump taken is counted once;
// - while a jump is held, every value at or above it stays held: the margin
//   growing while nothing is published must never cover it;
// - a value back to the usual rule (the drop or the jump was a glitch) ends
//   the hold.
// -----------------------------------------------------------------------------

const HOUR = 3_600_000;

const validLast = (last) =>
  last && Number.isFinite(last.value) && last.value > 0 && Number.isFinite(last.at)
    ? { value: last.value, at: last.at }
    : undefined;

/**
 * A hold read back from /data: coherent with the reference (`from` is the
 * last value published, `first` and `threshold` on the side of its
 * direction), else dropped. Its date becomes the time of the load: the
 * margin of an acceptance counts from there.
 */
function validHeld(held, last, now) {
  if (
    !held ||
    (held.direction !== 'up' && held.direction !== 'down') ||
    ![held.from, held.to, held.threshold, held.first].every(Number.isFinite) ||
    held.from !== last.value
  ) {
    return undefined;
  }
  const up = held.direction === 'up';
  const side = (v) => (up ? v > held.from : v < held.from && v > 0);
  if (!side(held.first) || !side(held.threshold) || !side(held.to)) {
    return undefined;
  }
  return {
    direction: held.direction,
    from: held.from,
    to: held.to,
    threshold: held.threshold,
    first: held.first,
    firstAt: now,
  };
}

export class IndexGuard {
  /**
   * `known`: the value Gladys holds (`{ value, at }`, `at` from the
   * feature's last_value_changed, or undefined). `saved`: what /data kept
   * (`state()`). `now`: the start time; without any date, the reference is
   * dated 24 hours back (a first reading after a restart gets a day of
   * margin).
   */
  constructor({ known, saved, now }) {
    const kept = validLast(saved?.last);
    const fromGladys =
      known && Number.isFinite(known.value) && known.value > 0
        ? validLast({ value: known.value, at: known.at ?? now - 24 * HOUR })
        : undefined;
    if (kept && fromGladys && kept.value === fromGladys.value) {
      this.last = { value: kept.value, at: Math.min(kept.at, fromGladys.at) };
    } else {
      this.last = kept && (!fromGladys || kept.at >= fromGladys.at) ? kept : fromGladys;
    }
    /**
     * A value held back: `{ direction, from, to, threshold, first, firstAt }`,
     * `first` the value shown to the user, read at `firstAt`.
     */
    this.held = this.last ? validHeld(saved?.held, this.last, now) : undefined;
    /** The acceptance of the user: the hold as shown then (`{ direction, first, firstAt }`). */
    this.accepted = undefined;
  }

  /** What /data keeps (never an acceptance: after a restart the user accepts again). */
  state() {
    return { last: this.last ?? null, held: this.held ?? null };
  }

  /** The user accepts the value held (the `accept_index` button). Resolves whether one was. */
  acceptHeld() {
    if (!this.held) {
      return false;
    }
    const { direction, first, firstAt } = this.held;
    this.accepted = { direction, first, firstAt };
    return true;
  }

  /**
   * Whether `value`, read at `at`, may be published. `limits` is { maxKw,
   * slack, minHours, window }: the margin is `maxKw` over the hours since
   * the last value published (at least `minHours`; exactly `window` when
   * given, e.g. the first reading after the night), plus `slack`. A
   * published value becomes the reference.
   */
  accept(value, at, { maxKw, slack, minHours = 0, window }) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return false;
    }
    if (!this.last) {
      return this.take(value, at);
    }
    if (value === this.last.value) {
      // Unchanged: published, dated now (the margin of the next rise starts here).
      return this.take(value, at);
    }
    if (this.accepted) {
      // Bounded: the value shown to the user, and what could be produced since.
      const { first, firstAt } = this.accepted;
      const top = first + (maxKw * Math.max(0, at - firstAt)) / HOUR + slack;
      if (value >= first - slack && value <= top) {
        return this.take(value, at);
      }
      // Not what the user accepted: held again (from this value), the acceptance dropped.
      this.accepted = undefined;
      this.held = undefined;
    }
    const up = this.held?.direction === 'up';
    if (up && value >= this.held.threshold) {
      this.held = { ...this.held, to: value };
      return false;
    }
    const hours = window ?? Math.max(minHours, Math.max(0, at - this.last.at) / HOUR);
    if (value > this.last.value && value - this.last.value <= maxKw * hours + slack) {
      return this.take(value, at);
    }
    const direction = value > this.last.value ? 'up' : 'down';
    const same = this.held?.direction === direction;
    this.held = {
      direction,
      from: this.last.value,
      to: value,
      threshold: direction === 'up' && up ? Math.min(value, this.held.threshold) : value,
      first: same ? this.held.first : value,
      firstAt: same ? this.held.firstAt : at,
    };
    return false;
  }

  release() {
    this.held = undefined;
    this.accepted = undefined;
  }

  take(value, at) {
    this.last = { value, at };
    this.release();
    return true;
  }
}
