// -----------------------------------------------------------------------------
// The Gladys devices and their states. Pure.
//
// External id (forever): inverter:<deviceId>, the serial the EZ1 reports
// (E07000000001). Feature keys (forever, shared with gladys-hoymiles): see
// FEATURE below.
//
// The energy monitoring of Gladys turns the deltas of a production index
// (energy-production-sensor / index) into 30-minute production states, but
// only into a `thirty-minutes-production` feature of the same device whose
// `energy_parent_id` is the index feature. The core derives that feature by
// itself for a consumption index only, so the integration declares both,
// with ids it computes (a UUID v5 of the feature external id): stable across
// discoveries, so an "Update" in the Discovery screen keeps the same rows.
// The integration never publishes a state on the 30-minute feature: the core
// writes it. Same approach as gladys-hoymiles.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { DEFAULT_LIMITS } from './constants.js';

export const FEATURE = {
  /** Total AC production, W. */
  POWER: 'power',
  /** DC input (panel) n, 1-based, W. */
  input: (n) => `power_${n}`,
  /** Energy of the solar day, kWh. */
  ENERGY_TODAY: 'energy_today',
  /** Lifetime production index, kWh: the Gladys energy monitoring source. */
  ENERGY_TOTAL: 'energy_total',
  /** 30-minute production: fed by the Gladys core from the index, never by the integration. */
  PRODUCTION_30MIN: 'energy_total_production',
  /** Output power limit, W (writable). */
  LIMIT: 'limit',
  /** Inverter on / off (writable, not on every firmware). */
  SWITCH: 'switch',
  /** The inverter answers (0 at night: it sleeps without sun). */
  REACHABLE: 'reachable',
  /** One binary per alarm: alarm_off_grid, alarm_output_fault, alarm_dc_<n>. */
  alarm: (id) => `alarm_${id}`,
};

export const ids = {
  inverter: (gladys, serial) => gladys.externalId(`inverter:${serial}`),
  ecu: (gladys, ecuId) => gladys.externalId(`ecu:${ecuId}`),
  ecuInverter: (gladys, uid) => gladys.externalId(`ecu_inverter:${uid}`),
  feature: (deviceId, key) => `${deviceId}:${key}`,
};

/** Namespace of the feature ids of this integration (random, fixed forever). */
const ID_NAMESPACE = Buffer.from('948fe8cfafe877cf09a2521286e4edac', 'hex');

/** A deterministic UUID (version 5, RFC 9562) of a name. */
export function uuidOf(name) {
  const hash = createHash('sha1').update(ID_NAMESPACE).update(String(name), 'utf8').digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A serial as the EZ1 reports it, safe in an external id. */
export const isSerial = (serial) => /^[A-Za-z0-9_-]{4,40}$/.test(String(serial ?? ''));

/** { serial } | undefined. */
export function parseExternalId(externalId) {
  const match = /:inverter:([A-Za-z0-9_-]{4,40})$/.exec(String(externalId ?? ''));
  return match ? { serial: match[1] } : undefined;
}

/** The key of a feature external id: "<device>:power_1" -> "power_1". */
export const featureKey = (featureExternalId) =>
  String(featureExternalId ?? '')
    .split(':')
    .at(-1);

/** The params of a device Gladys hands back, as an object. */
export const paramsOf = (device) =>
  Object.fromEntries((device?.params ?? []).map((p) => [p.name, p.value]));

/** The last value Gladys holds for a feature of a created device, if any. */
export function lastValueOf(device, key) {
  const feature = (device?.features ?? []).find((f) => featureKey(f.external_id) === key);
  const value = Number(feature?.last_value);
  return feature && feature.last_value !== null && Number.isFinite(value) ? value : undefined;
}

const feature = (deviceId, key, name, category, type, extra = {}) => ({
  name,
  external_id: ids.feature(deviceId, key),
  category,
  type,
  min: 0,
  max: 1,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...extra,
});

const power = (id, key, name, max) =>
  feature(id, key, name, C.ENERGY_PRODUCTION_SENSOR, T.ENERGY_PRODUCTION_SENSOR.POWER, {
    unit: U.WATT,
    max,
  });

const binary = (id, key, name, extra = {}) =>
  feature(id, key, name, C.UNKNOWN, T.SENSOR.BINARY, extra);

const ALARM_NAMES = {
  off_grid: 'Alarm: off grid',
  output_fault: 'Alarm: output fault',
};

/**
 * The device of one inverter. `inverter` is { serial, model, devVer, hostKey,
 * minPower, maxPower, inputs (count), switchSupported, limitSupported,
 * limitVariant }; the address and the bounds are stored as params, so the
 * poll path finds them on the device Gladys hands back.
 */
export function buildInverterDevice(gladys, inverter) {
  const id = ids.inverter(gladys, inverter.serial);
  const min = inverter.minPower ?? DEFAULT_LIMITS.min;
  const max = inverter.maxPower ?? DEFAULT_LIMITS.max;
  const inputs = Math.max(1, inverter.inputs ?? 2);
  const indexId = ids.feature(id, FEATURE.ENERGY_TOTAL);
  const features = [power(id, FEATURE.POWER, 'Production power', max * 2)];
  for (let n = 1; n <= inputs; n += 1) {
    features.push(power(id, FEATURE.input(n), `Input ${n} power`, max * 2));
  }
  features.push(
    feature(
      id,
      FEATURE.ENERGY_TODAY,
      'Energy today',
      C.ENERGY_PRODUCTION_SENSOR,
      T.ENERGY_PRODUCTION_SENSOR.DAILY_PRODUCTION,
      { unit: U.KILOWATT_HOUR, max: 1000 },
    ),
    feature(
      id,
      FEATURE.ENERGY_TOTAL,
      'Lifetime energy',
      C.ENERGY_PRODUCTION_SENSOR,
      T.ENERGY_PRODUCTION_SENSOR.INDEX,
      { id: uuidOf(indexId), unit: U.KILOWATT_HOUR, max: 100_000_000 },
    ),
    feature(
      id,
      FEATURE.PRODUCTION_30MIN,
      'Lifetime energy (30-minute production)',
      C.ENERGY_PRODUCTION_SENSOR,
      T.ENERGY_PRODUCTION_SENSOR.THIRTY_MINUTES_PRODUCTION,
      {
        id: uuidOf(ids.feature(id, FEATURE.PRODUCTION_30MIN)),
        energy_parent_id: uuidOf(indexId),
        unit: U.KILOWATT_HOUR,
        max: 100_000_000_000,
      },
    ),
  );
  if (inverter.limitSupported !== false) {
    features.push(
      feature(id, FEATURE.LIMIT, 'Power limit', C.SWITCH, T.SWITCH.DIMMER, {
        unit: U.WATT,
        min,
        max,
        read_only: false,
        has_feedback: true,
      }),
    );
  }
  if (inverter.switchSupported) {
    features.push(
      feature(id, FEATURE.SWITCH, 'Inverter on/off', C.SWITCH, T.SWITCH.BINARY, {
        read_only: false,
        has_feedback: true,
      }),
    );
  }
  features.push(binary(id, FEATURE.REACHABLE, 'Reachable', { keep_history: false }));
  for (const alarm of alarmIds(inputs)) {
    const n = /^dc_(\d+)$/.exec(alarm)?.[1];
    features.push(
      binary(id, FEATURE.alarm(alarm), n ? `Alarm: DC ${n} short circuit` : ALARM_NAMES[alarm]),
    );
  }
  return {
    name: `${inverter.model ?? 'EZ1'} ${inverter.serial}`,
    external_id: id,
    features,
    params: [
      { name: 'host', value: inverter.hostKey },
      { name: 'model', value: inverter.model ?? 'EZ1' },
      { name: 'firmware', value: inverter.devVer ?? '' },
      { name: 'min_power', value: String(min) },
      { name: 'max_power', value: String(max) },
      { name: 'inputs', value: String(inputs) },
      { name: 'limit_endpoint', value: inverter.limitVariant ?? '' },
      { name: 'switch', value: inverter.switchSupported ? '1' : '0' },
    ],
  };
}

/** The alarm ids of an inverter with `inputs` DC inputs. */
export function alarmIds(inputs) {
  const list = ['off_grid', 'output_fault'];
  for (let n = 1; n <= inputs; n += 1) {
    list.push(`dc_${n}`);
  }
  return list;
}

// --- ECU gateways ------------------------------------------------------------------
//
// External ids (forever): ecu:<ECU id> (12 characters, e.g. 216300012345)
// and ecu_inverter:<inverter id> (12 hexadecimal digits, e.g. 703000012345)
// for each micro-inverter behind an ECU: the inverter's own id, so it stays
// the same device if the ECU is replaced. Neither matches `parseExternalId`
// (":inverter:"), so the EZ1 code never sees them.

export const ECU_FEATURE = {
  /** Micro-inverters online, as the ECU counts them. */
  ONLINE_COUNT: 'inverters_online',
  /** A micro-inverter is online (0 at night: no sun). */
  ONLINE: 'online',
  /** AC voltage (V): `voltage`, or `voltage_<n>` per phase on a three-phase inverter. */
  VOLTAGE: 'voltage',
  voltage: (n) => `voltage_${n}`,
  /** Grid frequency (Hz). */
  FREQUENCY: 'frequency',
  /** Temperature of the micro-inverter (°C). */
  TEMPERATURE: 'temperature',
};

/** { ecuId } | undefined. */
export function parseEcuExternalId(externalId) {
  const match = /:ecu:([0-9A-Za-z]{12})$/.exec(String(externalId ?? ''));
  return match ? { ecuId: match[1] } : undefined;
}

/** { uid } | undefined. */
export function parseEcuInverterExternalId(externalId) {
  const match = /:ecu_inverter:([0-9a-f]{12})$/.exec(String(externalId ?? ''));
  return match ? { uid: match[1] } : undefined;
}

/** The energy features shared by the EZ1 and the ECU: today, index, 30-minute production. */
function energyFeatures(id) {
  const indexId = ids.feature(id, FEATURE.ENERGY_TOTAL);
  return [
    feature(
      id,
      FEATURE.ENERGY_TODAY,
      'Energy today',
      C.ENERGY_PRODUCTION_SENSOR,
      T.ENERGY_PRODUCTION_SENSOR.DAILY_PRODUCTION,
      { unit: U.KILOWATT_HOUR, max: 10_000 },
    ),
    feature(
      id,
      FEATURE.ENERGY_TOTAL,
      'Lifetime energy',
      C.ENERGY_PRODUCTION_SENSOR,
      T.ENERGY_PRODUCTION_SENSOR.INDEX,
      { id: uuidOf(indexId), unit: U.KILOWATT_HOUR, max: 100_000_000 },
    ),
    feature(
      id,
      FEATURE.PRODUCTION_30MIN,
      'Lifetime energy (30-minute production)',
      C.ENERGY_PRODUCTION_SENSOR,
      T.ENERGY_PRODUCTION_SENSOR.THIRTY_MINUTES_PRODUCTION,
      {
        id: uuidOf(ids.feature(id, FEATURE.PRODUCTION_30MIN)),
        energy_parent_id: uuidOf(indexId),
        unit: U.KILOWATT_HOUR,
        max: 100_000_000_000,
      },
    ),
  ];
}

/**
 * The device of one ECU. `ecu` is { id, model, firmware, hostKey,
 * inverters }: its production (power, today, lifetime index with its
 * 30-minute production), the micro-inverters online, reachable. Read-only.
 */
export function buildEcuDevice(gladys, ecu) {
  const id = ids.ecu(gladys, ecu.id);
  return {
    name: `${ecu.model ?? 'ECU'} ${ecu.id}`,
    external_id: id,
    features: [
      power(id, FEATURE.POWER, 'Production power', 1_000_000),
      ...energyFeatures(id),
      feature(id, ECU_FEATURE.ONLINE_COUNT, 'Inverters online', C.UNKNOWN, T.SENSOR.INTEGER, {
        max: 1000,
      }),
      binary(id, FEATURE.REACHABLE, 'Reachable', { keep_history: false }),
    ],
    params: [
      { name: 'host', value: ecu.hostKey },
      { name: 'model', value: ecu.model ?? 'ECU' },
      { name: 'firmware', value: ecu.firmware ?? '' },
      { name: 'inverters', value: String(ecu.inverters ?? '') },
    ],
  };
}

/**
 * The device of one micro-inverter behind an ECU. `inverter` is { uid,
 * model, type, channels, phases, ecuId }: online, power (total and per
 * channel, i.e. per panel), AC voltage (per phase on a three-phase model),
 * frequency, temperature. A type the reference does not know (no channel)
 * only gets `online`. Read-only.
 */
export function buildEcuInverterDevice(gladys, inverter) {
  const id = ids.ecuInverter(gladys, inverter.uid);
  const features = [binary(id, ECU_FEATURE.ONLINE, 'Online')];
  const channels = inverter.channels ?? 0;
  if (channels > 0) {
    features.push(power(id, FEATURE.POWER, 'Production power', 5000));
    for (let n = 1; n <= channels; n += 1) {
      features.push(power(id, FEATURE.input(n), `Input ${n} power`, 2000));
    }
    const voltage = (key, name) =>
      feature(id, key, name, C.ENERGY_SENSOR, T.ENERGY_SENSOR.VOLTAGE, {
        unit: U.VOLT,
        max: 1000,
      });
    if (inverter.phases === 3) {
      for (let n = 1; n <= 3; n += 1) {
        features.push(voltage(ECU_FEATURE.voltage(n), `AC voltage L${n}`));
      }
    } else {
      features.push(voltage(ECU_FEATURE.VOLTAGE, 'AC voltage'));
    }
    features.push(
      // No frequency category or Hz unit in the core: a plain decimal, named with its unit.
      feature(id, ECU_FEATURE.FREQUENCY, 'Grid frequency (Hz)', C.UNKNOWN, T.SENSOR.DECIMAL, {
        max: 100,
      }),
      feature(
        id,
        ECU_FEATURE.TEMPERATURE,
        'Temperature',
        C.DEVICE_TEMPERATURE_SENSOR,
        T.SENSOR.DECIMAL,
        { unit: U.CELSIUS, min: -100, max: 200 },
      ),
    );
  }
  const model = inverter.model ?? 'Inverter';
  return {
    name: `${model} ${inverter.uid}`,
    external_id: id,
    features,
    params: [
      { name: 'ecu', value: inverter.ecuId ?? '' },
      { name: 'model', value: model },
      { name: 'type', value: inverter.type ?? '' },
      { name: 'channels', value: String(channels) },
    ],
  };
}

/** What a feature declaration holds (a created feature also carries Gladys' own fields). */
const DECLARED = [
  'id',
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'energy_parent_id',
];

/**
 * A device republished in Discovery never loses a feature of the device the
 * user created (the core would mark it `structure_changed`, and "Update"
 * would delete that feature and its history): the features of the created
 * device that the new build lacks are kept as they are.
 */
export function keepCreatedFeatures(built, created) {
  if (!created) {
    return built;
  }
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => f?.external_id && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  return kept.length === 0 ? built : { ...built, features: [...built.features, ...kept] };
}

const state = (deviceId, key, value) =>
  value === null || value === undefined
    ? []
    : [{ device_feature_external_id: ids.feature(deviceId, key), state: value }];

const bit = (value) => (value === null || value === undefined ? undefined : value ? 1 : 0);

/**
 * The states of an inverter. `snapshot` is { awake, power, inputs: [W],
 * energyToday, energyTotal, limit, on, alarms: { id: bool } }; a missing value
 * publishes nothing. Asleep, the powers are 0 and the counters keep their
 * last value (nothing published for them). Never a state on the 30-minute
 * production: the core writes it from the index.
 */
export function inverterStates(deviceId, snapshot) {
  const states = [];
  const awake = snapshot.awake;
  states.push(...state(deviceId, FEATURE.REACHABLE, awake ? 1 : 0));
  states.push(...state(deviceId, FEATURE.POWER, awake ? snapshot.power : 0));
  for (const [index, value] of (snapshot.inputs ?? []).entries()) {
    states.push(...state(deviceId, FEATURE.input(index + 1), awake ? value : 0));
  }
  if (!awake) {
    return states;
  }
  states.push(...state(deviceId, FEATURE.ENERGY_TODAY, snapshot.energyToday));
  states.push(...state(deviceId, FEATURE.ENERGY_TOTAL, snapshot.energyTotal));
  states.push(...state(deviceId, FEATURE.LIMIT, snapshot.limit));
  states.push(...state(deviceId, FEATURE.SWITCH, bit(snapshot.on)));
  for (const [id, active] of Object.entries(snapshot.alarms ?? {})) {
    states.push(...state(deviceId, FEATURE.alarm(id), bit(active)));
  }
  return states;
}

/**
 * The states of an ECU. `snapshot` is { reachable, power, energyToday,
 * energyTotal, online }; a missing value publishes nothing. Unreachable,
 * only `reachable` (0): its production is unknown, not zero.
 */
export function ecuStates(deviceId, snapshot) {
  const states = [...state(deviceId, FEATURE.REACHABLE, snapshot.reachable ? 1 : 0)];
  if (!snapshot.reachable) {
    return states;
  }
  states.push(
    ...state(deviceId, FEATURE.POWER, snapshot.power),
    ...state(deviceId, FEATURE.ENERGY_TODAY, snapshot.energyToday),
    ...state(deviceId, FEATURE.ENERGY_TOTAL, snapshot.energyTotal),
    ...state(deviceId, ECU_FEATURE.ONLINE_COUNT, snapshot.online),
  );
  return states;
}

/**
 * The states of a micro-inverter behind an ECU (`inverter` as
 * parseInverterFrame gives it). Offline (the night), its powers are 0 and
 * the rest keeps its last value.
 */
export function ecuInverterStates(deviceId, inverter) {
  const states = [...state(deviceId, ECU_FEATURE.ONLINE, inverter.online ? 1 : 0)];
  if (!inverter.channels) {
    return states;
  }
  const powers = inverter.power.map((w) => (inverter.online ? w : 0));
  states.push(
    ...state(
      deviceId,
      FEATURE.POWER,
      powers.reduce((total, w) => total + w, 0),
    ),
  );
  for (const [index, watts] of powers.entries()) {
    states.push(...state(deviceId, FEATURE.input(index + 1), watts));
  }
  if (!inverter.online) {
    return states;
  }
  if (inverter.phases === 3) {
    for (const [index, volts] of inverter.voltage.entries()) {
      states.push(...state(deviceId, ECU_FEATURE.voltage(index + 1), volts));
    }
  } else {
    states.push(...state(deviceId, ECU_FEATURE.VOLTAGE, inverter.voltage[0]));
  }
  states.push(
    ...state(deviceId, ECU_FEATURE.FREQUENCY, inverter.frequency),
    ...state(deviceId, ECU_FEATURE.TEMPERATURE, inverter.temperature),
  );
  return states;
}
