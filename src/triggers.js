// -----------------------------------------------------------------------------
// Readings -> scene events. Pure. One event per transition, and nothing on
// the first reading (no transition without a previous value).
//
//   production_started   a minute at 10 W or more after a stop (the morning)
//   production_stopped   15 minutes under 5 W, or asleep (the evening)
//   inverter_alarm       an alarm flag went from 0 to 1 between two alarm
//                        readings of the same waking period
//
// The data (shared with gladys-hoymiles): `inverter` is the device external
// id (the core matches the device select field by equality), `name` the
// device name and `serial` the EZ1 deviceId, for messages.
// -----------------------------------------------------------------------------

import { ALARMS, PRODUCTION, SCENE_TRIGGERS } from './constants.js';

/**
 * One step of the production state: { producing, since } where `since` is
 * when the opposite condition started to hold. Resolves { state, event }
 * with event 'started', 'stopped' or undefined.
 */
export function productionStep(previous, power, at) {
  const watts = power ?? 0;
  if (!previous) {
    return { state: { producing: watts >= PRODUCTION.ON_W, since: null }, event: undefined };
  }
  if (previous.producing) {
    if (watts >= PRODUCTION.OFF_W) {
      return { state: { producing: true, since: null }, event: undefined };
    }
    const since = previous.since ?? at;
    return at - since >= PRODUCTION.STOP_AFTER
      ? { state: { producing: false, since: null }, event: 'stopped' }
      : { state: { producing: true, since }, event: undefined };
  }
  if (watts < PRODUCTION.ON_W) {
    return { state: { producing: false, since: null }, event: undefined };
  }
  const since = previous.since ?? at;
  return at - since >= PRODUCTION.START_AFTER
    ? { state: { producing: true, since: null }, event: 'started' }
    : { state: { producing: false, since }, event: undefined };
}

/**
 * The production event of a step, or undefined. Both carry the same data:
 * the power of the reading and the energy of the day so far.
 */
export function productionEvent(event, { deviceId, name, serial, power, energyToday }) {
  if (event !== 'started' && event !== 'stopped') {
    return undefined;
  }
  return {
    key: event === 'started' ? SCENE_TRIGGERS.STARTED : SCENE_TRIGGERS.STOPPED,
    data: {
      inverter: deviceId,
      name,
      serial,
      power: power ?? 0,
      energy_today: energyToday ?? null,
    },
  };
}

/**
 * The alarms raised between two alarm readings ({ id: bool }). Without a
 * previous reading nothing fires: an alarm present at start-up, or at the
 * first reading after waking up (the EZ1 checks the grid for a while each
 * morning), only arms.
 */
export function raisedAlarms(previous, current) {
  if (!previous) {
    return [];
  }
  return Object.entries(current ?? {})
    .filter(([id, active]) => active && previous[id] === false)
    .map(([id]) => id);
}

/** The inverter_alarm event of an alarm id (dc_<n> is a DC short circuit on input n). */
export function alarmEvent(id, { deviceId, name, serial }) {
  const dc = /^dc_(\d+)$/.exec(id);
  return {
    key: SCENE_TRIGGERS.ALARM,
    data: {
      inverter: deviceId,
      name,
      serial,
      alarm: dc ? ALARMS.DC_SHORT_CIRCUIT : id,
      input: dc ? Number(dc[1]) : null,
    },
  };
}
