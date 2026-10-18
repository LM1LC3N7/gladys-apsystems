// -----------------------------------------------------------------------------
// EZ1 JSON -> plain objects, and the two counters the integration keeps on
// top of the inverter's own (energy of the day, lifetime index). Pure: the
// times are parameters (milliseconds).
//
// Every field name of the EZ1 answers lives here (see src/ez1.js for the
// endpoints). The manual sends numbers as strings in some answers and as
// numbers in others: `num` takes both.
// -----------------------------------------------------------------------------

import { NEW_DAY_GAP } from './constants.js';

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
    // A counter missing or not a number is unknown (null), never 0: a sum
    // with a 0 in it would be a fall of the index.
    const counter = (value) => (num(value) === null ? null : round(Math.max(0, num(value)), 3));
    inputs.push({
      n,
      power: round(Math.max(0, num(data[`p${n}`]) ?? 0), 1),
      energy: counter(data[`e${n}`]),
      lifetime: counter(data[`te${n}`]),
    });
  }
  inputs.sort((a, b) => a.n - b.n);
  const sum = (field, digits) =>
    inputs.some((input) => input[field] === null)
      ? null
      : round(
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
