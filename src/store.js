// -----------------------------------------------------------------------------
// What survives a restart of the container, in /data/state.json (the only
// writable place): the index guards (EZ1 and ECU: last value published and
// when, the value held) and the pace of each ECU address (next attempt,
// failures in a row, last attempt). Written atomically (a temporary file,
// then a rename); everything read back is validated and bounded.
// -----------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_ENTRIES = 100;
const DAY = 24 * 3_600_000;
const GUARD_KEY = /^(ez1:[A-Za-z0-9_-]{4,40}|ecu:[0-9A-Za-z]{12})$/;
const HOST_KEY = /^[a-z0-9.-]{1,253}:\d{1,5}$/;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function validGuard(raw, now) {
  const last = raw?.last;
  if (!last || !finite(last.value) || last.value <= 0 || !finite(last.at) || last.at > now + DAY) {
    return undefined;
  }
  const held = raw.held;
  // A hold coherent with the reference only (the guard checks the sides again).
  const keepHeld =
    held &&
    (held.direction === 'up' || held.direction === 'down') &&
    [held.from, held.to, held.threshold, held.first].every(finite) &&
    held.from === last.value &&
    (held.direction === 'up' ? held.first > held.from : held.first < held.from);
  return {
    last: { value: last.value, at: last.at },
    held: keepHeld
      ? {
          direction: held.direction,
          from: held.from,
          to: held.to,
          threshold: held.threshold,
          first: held.first,
        }
      : null,
  };
}

function validPace(raw, now, maxWait) {
  if (!raw || !finite(raw.nextAt)) {
    return undefined;
  }
  const misses = Number.isInteger(raw.misses) ? Math.min(Math.max(raw.misses, 0), 100) : 0;
  return {
    // A date far ahead (a clock moved back, a corrupted file) never blocks the ECU for long.
    nextAt: Math.min(raw.nextAt, now + maxWait),
    misses,
    lastAttemptAt:
      finite(raw.lastAttemptAt) && raw.lastAttemptAt <= now ? raw.lastAttemptAt : undefined,
  };
}

/** Own, valid keys only, at most MAX_ENTRIES: never an object key from the file as is. */
function entries(object, keyPattern, validate) {
  const out = new Map();
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    return out;
  }
  for (const key of Object.keys(object)) {
    if (out.size >= MAX_ENTRIES) {
      break;
    }
    if (keyPattern.test(key)) {
      const value = validate(object[key]);
      if (value) {
        out.set(key, value);
      }
    }
  }
  return out;
}

export class StateStore {
  constructor({ dir = process.env.DATA_DIR ?? '/data', io = fs, logger } = {}) {
    this.file = dir ? path.join(dir, 'state.json') : undefined;
    this.io = io;
    this.logger = logger;
    this.writing = Promise.resolve();
  }

  /** { guards: Map, pacing: Map }; empty when there is no file or it is not valid. */
  async load({ now, maxWait }) {
    const empty = { guards: new Map(), pacing: new Map() };
    if (!this.file) {
      return empty;
    }
    let raw;
    try {
      const text = await this.io.readFile(this.file, 'utf8');
      if (text.length > 1_000_000) {
        return empty;
      }
      raw = JSON.parse(text);
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        this.logger?.warn(`state.json not read: ${err.message}`);
      }
      return empty;
    }
    return {
      guards: entries(raw?.guards, GUARD_KEY, (g) => validGuard(g, now)),
      pacing: entries(raw?.pacing, HOST_KEY, (p) => validPace(p, now, maxWait)),
    };
  }

  /** Write { guards, pacing } (Maps) atomically; writes never overlap. */
  save({ guards, pacing }) {
    if (!this.file) {
      return Promise.resolve();
    }
    const body = JSON.stringify({
      version: 1,
      guards: Object.fromEntries([...guards].slice(0, MAX_ENTRIES)),
      pacing: Object.fromEntries([...pacing].slice(0, MAX_ENTRIES)),
    });
    this.writing = this.writing.then(async () => {
      const tmp = `${this.file}.tmp`;
      try {
        await this.io.writeFile(tmp, body, 'utf8');
        await this.io.rename(tmp, this.file);
      } catch (err) {
        this.logger?.warn(`state.json not written: ${err.message}`);
      }
    });
    return this.writing;
  }
}

/** A store in memory (tests, and a container without /data). */
export function memoryIo() {
  const files = new Map();
  return {
    files,
    async readFile(file) {
      if (!files.has(file)) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return files.get(file);
    },
    async writeFile(file, body) {
      files.set(file, body);
    },
    async rename(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
}
