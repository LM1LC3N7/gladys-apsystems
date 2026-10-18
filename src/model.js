// -----------------------------------------------------------------------------
// EZ1 JSON -> plain objects, and the two counters the integration keeps on
// top of the inverter's own (energy of the day, lifetime index). Pure: the
// times are parameters (milliseconds).
//
// Every field name of the EZ1 answers lives here (see src/ez1.js for the
// endpoints). The manual sends numbers as strings in some answers and as
// numbers in others: `num` takes both.
// -----------------------------------------------------------------------------

import { INDEX_CONFIRMATIONS, NEW_DAY_GAP } from './constants.js';

/** A number from a string or a number; null when there is none. */
export function num(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export const round = (value, digits) =>
  value === null || value === undefined ? null : Number(value.toFixed(digits));

/**
 * The model and firmware out of `devVer`: "EZ1 1.6.0" -> EZ1, "EZ1D1.0.0" ->
 * EZ1-D, "EZ1 2.0.1_b" -> EZ1 with the "_b" (battery-capable) firmware.
 */
export function modelOf(devVer) {
  const text = String(devVer ?? '').trim();
  const match = /^(EZ1)[\s-]?([A-Z])?\s*(\d[\w.]*)?$/i.exec(text);
  if (!match) {
    return { model: 'EZ1', firmware: text || null, battery: false };
  }
  return {
    model: match[2] ? `EZ1-${match[2].toUpperCase()}` : 'EZ1',
    firmware: match[3] ?? null,
    battery: /_b$/i.test(text),
  };
}

/** getDeviceInfo -> the identity and the power bounds of an inverter. */
export function deviceInfoOf(data = {}, deviceId = null) {
  const serial = String(data.deviceId ?? deviceId ?? '').trim();
  const { model, firmware, battery } = modelOf(data.devVer);
  return {
    serial,
    devVer: String(data.devVer ?? '').trim() || null,
    model,
    firmware,
    battery,
    ip: data.ipAddr ? String(data.ipAddr) : null,
    minPower: num(data.minPower),
    maxPower: num(data.maxPower),
  };
}

/**
 * getOutputData -> the DC inputs (p<n> W, e<n> kWh since the inverter started
 * this morning, te<n> kWh lifetime) and their sums. Any number of inputs:
 * the EZ1-M has 2, a 4-input model would send p3/p4. Unknown keys (some
 * firmware adds `originalData`) are ignored.
 */
export function outputOf(data = {}) {
  const inputs = [];
  for (const key of Object.keys(data)) {
    const match = /^p(\d{1,2})$/.exec(key);
    if (!match) {
      continue;
    }
    const n = Number(match[1]);
    inputs.push({
      n,
      power: round(Math.max(0, num(data[`p${n}`]) ?? 0), 1),
      energy: round(Math.max(0, num(data[`e${n}`]) ?? 0), 3),
      lifetime: round(Math.max(0, num(data[`te${n}`]) ?? 0), 3),
    });
  }
  inputs.sort((a, b) => a.n - b.n);
  const sum = (field, digits) =>
    round(
      inputs.reduce((total, input) => total + input[field], 0),
      digits,
    );
  return {
    inputs,
    power: sum('power', 1),
    energy: sum('energy', 3),
    lifetime: sum('lifetime', 3),
  };
}

/** getMaxPower -> the current limit in W ("maxPower", or "power" on the 2.x "_b" firmware). */
export function limitOf(data = {}) {
  return num(data.maxPower ?? data.power);
}

/** getOnOff / setOnOff -> true (on, "0"), false (off, "1"), null (unknown). */
export function onOffOf(data = {}) {
  const status = String(data.status ?? '').trim();
  if (status === '0') {
    return true;
  }
  return status === '1' ? false : null;
}

/**
 * getAlarm -> { off_grid, output_fault, dc_1, dc_2, ... } (true = alarm).
 * og = off grid, oe = output fault, isce<n> = DC <n> short circuit.
 */
export function alarmsOf(data = {}) {
  const flag = (value) => String(value ?? '0').trim() === '1';
  const alarms = { off_grid: flag(data.og), output_fault: flag(data.oe) };
  for (const key of Object.keys(data).sort()) {
    const match = /^isce(\d{1,2})$/.exec(key);
    if (match) {
      alarms[`dc_${Number(match[1])}`] = flag(data[key]);
    }
  }
  return alarms;
}

const utcDay = (at) => new Date(at).toISOString().slice(0, 10);

/**
 * The energy of the solar day. The EZ1 counts e1 + e2 "since start-up": it
 * starts every morning, so it is today's energy, except that it restarts
 * from zero when the inverter restarts during the day (a cloud too dark, a
 * grid dip). Like the Python library's debounce, a counter that went down is
 * added to a base; the base starts over on a new solar day: the counter went
 * down after a silence of NEW_DAY_GAP, or across midnight (UTC: the night in
 * Europe, where these inverters are sold).
 */
export function dayEnergyStep(previous, counter, at) {
  if (counter === null || counter === undefined) {
    return previous;
  }
  if (!previous) {
    return { base: 0, last: counter, at, value: round(counter, 3) };
  }
  let base = previous.base;
  if (counter < previous.last - 0.0005) {
    const newDay = at - previous.at >= NEW_DAY_GAP || utcDay(at) !== utcDay(previous.at);
    base = newDay ? 0 : base + previous.last;
  }
  return { base, last: counter, at, value: round(base + counter, 3) };
}

/**
 * The lifetime index Gladys turns into 30-minute production: it must never
 * jump down then up again (the core would count the jump back as
 * production). A lower value is published only once INDEX_CONFIRMATIONS
 * readings in a row agree (a firmware reset of the counter is real), a
 * single low reading is ignored. Resolves { state, publish }.
 */
export function indexStep(state, value) {
  if (value === null || value === undefined || value < 0) {
    return { state, publish: undefined };
  }
  if (!state || state.value === undefined || value >= state.value) {
    return { state: { value, lower: 0 }, publish: value };
  }
  const lower = state.lower + 1;
  if (lower >= INDEX_CONFIRMATIONS) {
    return { state: { value, lower: 0 }, publish: value };
  }
  return { state: { value: state.value, lower }, publish: undefined };
}

const HOUR = 3_600_000;

/**
 * The lifetime index of an ECU, stricter than the EZ1's `indexStep` (the
 * rules of the energy indexes the core bills: it skips a fall but counts
 * every rise IN FULL). `state` is { value, at, drop, held, accept }: the last
 * value published and when, the lower values read since, a jump held back.
 * - never 0 (nor below): the ECU firmware sometimes answers 0 (the reference
 *   filters it too);
 * - a rise plausible since the last value published (at most `maxKw` on
 *   average, plus ECU.INDEX_SLACK_KWH) goes through;
 * - a bigger rise is held: NEVER confirmed by repetition nor by time (every
 *   value at or above it stays held), taken only after an explicit gesture
 *   of the user (a save of the configuration: `accept`);
 * - a fall goes through once INDEX_CONFIRMATIONS readings in a row agree,
 *   never decreasing (a counter reset is real; a single low reading is not).
 * Resolves { state, publish }.
 */
export function ecuIndexStep(state, value, at, { maxKw, slack }) {
  const s = state ?? {};
  const take = () => ({ state: { value, at, drop: undefined, held: undefined }, publish: value });
  if (!Number.isFinite(value) || value <= 0) {
    return { state: { ...s, drop: undefined }, publish: undefined };
  }
  if (!Number.isFinite(s.value) || s.value <= 0) {
    return take();
  }
  if (value >= s.value) {
    const hours = Number.isFinite(s.at) ? Math.max(0, at - s.at) / HOUR : 0;
    const plausible = value - s.value <= maxKw * hours + slack;
    const aboveHeld = Number.isFinite(s.held) && value >= s.held;
    if ((plausible && !aboveHeld) || (s.accept && Number.isFinite(s.held))) {
      return take();
    }
    const held = Math.min(value, Number.isFinite(s.held) ? s.held : Infinity);
    return { state: { ...s, drop: undefined, held }, publish: undefined };
  }
  const drop =
    s.drop && value >= s.drop.value ? { value, count: s.drop.count + 1 } : { value, count: 1 };
  if (drop.count >= INDEX_CONFIRMATIONS) {
    return take();
  }
  return { state: { ...s, drop, held: undefined, accept: false }, publish: undefined };
}
