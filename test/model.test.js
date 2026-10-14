// -----------------------------------------------------------------------------
// The pure parts: the EZ1 answers, the counters, the configuration, the
// devices and their states, the transitions, the widget.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
  validateWidgetContent,
} from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig, parseHosts } from '../src/config.js';
import { NEW_DAY_GAP, PRODUCTION, SCENE_TRIGGERS } from '../src/constants.js';
import {
  FEATURE,
  buildInverterDevice,
  inverterStates,
  parseExternalId,
  uuidOf,
} from '../src/devices.js';
import {
  alarmsOf,
  dayEnergyStep,
  deviceInfoOf,
  indexStep,
  limitOf,
  onOffOf,
  outputOf,
} from '../src/model.js';
import { alarmEvent, productionEvent, productionStep, raisedAlarms } from '../src/triggers.js';
import { solarWidget } from '../src/widget.js';
import { fixture } from './helpers/fakeEz1.js';

const NOON = Date.parse('2026-06-15T12:00:00Z');
const MIN = 60_000;
const EZ1M = {
  serial: 'E07000000001',
  model: 'EZ1',
  devVer: 'EZ1 1.6.0',
  hostKey: '192.168.1.50:8050',
  minPower: 30,
  maxPower: 800,
  inputs: 2,
  switchSupported: true,
  limitSupported: true,
  limitVariant: 'MaxPower',
};
const byKey = (device) =>
  Object.fromEntries(device.features.map((f) => [f.external_id.split(':').at(-1), f]));

test('device information: the three firmware families', () => {
  const m = deviceInfoOf(fixture('device-info.json').data);
  assert.deepEqual(
    [m.serial, m.model, m.firmware, m.battery, m.minPower, m.maxPower],
    ['E07000000001', 'EZ1', '1.6.0', false, 30, 800],
  );
  const b = deviceInfoOf(fixture('device-info-2.0.1_b.json').data);
  assert.equal(b.battery, true);
  assert.equal(b.firmware, '2.0.1_b');
  const d = deviceInfoOf(fixture('device-info-ez1d.json').data);
  assert.deepEqual([d.model, d.minPower, d.maxPower], ['EZ1-D', 80, 1800]);
  // The manual's own example has a leading space, and a missing id falls back on the envelope.
  assert.equal(deviceInfoOf({ devVer: ' EZ1 1.0.0' }, 'E0700000000X').serial, 'E0700000000X');
});

test('output data: inputs, sums, numbers as strings, unknown keys ignored', () => {
  const out = outputOf(fixture('output-data.json').data);
  assert.deepEqual(
    out.inputs.map((i) => [i.n, i.power, i.energy, i.lifetime]),
    [
      [1, 152.4, 0.846, 412.337],
      [2, 160, 0.9, 398.1],
    ],
  );
  assert.deepEqual([out.power, out.energy, out.lifetime], [312.4, 1.746, 810.437]);
  const four = outputOf({
    p1: '10',
    p2: '20',
    p3: 30,
    p4: 40,
    e1: 0,
    te1: 1,
    originalData: { x: 1 },
  });
  assert.equal(four.inputs.length, 4);
  assert.equal(four.power, 100);
  assert.equal(outputOf({}).power, 0);
});

test('limit, on/off (inverted) and alarms', () => {
  assert.equal(limitOf(fixture('max-power.json').data), 600);
  assert.equal(limitOf(fixture('max-power-2.0.1_b.json').data), 800, 'the "_b" firmware key');
  assert.equal(limitOf({ maxPower: '' }), null);
  assert.equal(onOffOf({ status: '0' }), true, '0 is ON');
  assert.equal(onOffOf({ status: '1' }), false);
  assert.equal(onOffOf({}), null);
  assert.deepEqual(alarmsOf(fixture('alarm.json').data), {
    off_grid: false,
    output_fault: false,
    dc_1: false,
    dc_2: false,
  });
  assert.equal(alarmsOf({ og: '1', isce2: '1', oe: '0', isce1: '0' }).dc_2, true);
});

test('energy of the day: a restart adds up, a new solar day starts over', () => {
  let day = dayEnergyStep(undefined, 0.5, NOON);
  day = dayEnergyStep(day, 1.2, NOON + 30 * MIN);
  assert.equal(day.value, 1.2);
  // The inverter restarted at 13:00 (a dark cloud): its counter is back to 0.1.
  day = dayEnergyStep(day, 0.1, NOON + 60 * MIN);
  assert.equal(day.value, 1.3);
  day = dayEnergyStep(day, 0.4, NOON + 90 * MIN);
  assert.equal(day.value, 1.6);
  // The next morning, after the night: a fresh day.
  day = dayEnergyStep(day, 0.01, NOON + 90 * MIN + NEW_DAY_GAP);
  assert.equal(day.value, 0.01);
  // A short summer night (2 h) still crosses midnight.
  const late = dayEnergyStep(undefined, 3, Date.parse('2026-06-21T23:00:00Z'));
  assert.equal(dayEnergyStep(late, 0.02, Date.parse('2026-06-22T01:00:00Z')).value, 0.02);
  assert.equal(dayEnergyStep(late, null, NOON), late, 'no counter: unchanged');
});

test('lifetime index: a single low reading is ignored, a lasting one is confirmed', () => {
  let step = indexStep(undefined, 810.4);
  assert.equal(step.publish, 810.4);
  step = indexStep(step.state, 0);
  assert.equal(step.publish, undefined, 'a 0 glitch would count as production once it comes back');
  step = indexStep(step.state, 810.5);
  assert.equal(step.publish, 810.5);
  for (const value of [2.1, 2.2]) {
    step = indexStep(step.state, value);
    assert.equal(step.publish, undefined);
  }
  step = indexStep(step.state, 2.3);
  assert.equal(step.publish, 2.3, 'a firmware reset of the counter, three readings in a row');
  assert.equal(indexStep(step.state, null).publish, undefined);
});

test('the configuration', () => {
  const parsed = parseHosts(
    'http://192.168.1.50/, 192.168.1.51:8051\n192.168.1.50:8050; ez1-garage.lan, 300.1.1.1, x:99999, my inverter',
  );
  assert.deepEqual(
    parsed.hosts.map((h) => h.key),
    ['192.168.1.50:8050', '192.168.1.51:8051', 'ez1-garage.lan:8050'],
  );
  assert.deepEqual(parsed.invalid, [5, 6, 7]);
  const config = normalizeConfig({ hosts: '10.0.0.2', poll_interval: 2 });
  assert.equal(config.pollInterval, 10, 'never below 10 s');
  assert.equal(normalizeConfig({}).pollInterval, 30);
  assert.equal(normalizeConfig({ poll_interval: 'x' }).pollInterval, 30);
});

test('the inverter device: categories, types, units and ids', () => {
  const gladys = createFakeGladys({ selector: 'apsystems' });
  const device = buildInverterDevice(gladys, EZ1M);
  assert.equal(device.external_id, 'ext:apsystems:inverter:E07000000001');
  assert.deepEqual(parseExternalId(device.external_id), { serial: 'E07000000001' });
  const features = byKey(device);
  assert.deepEqual(Object.keys(features), [
    'power',
    'power_1',
    'power_2',
    'energy_today',
    'energy_total',
    'energy_total_production',
    'limit',
    'switch',
    'reachable',
    'alarm_off_grid',
    'alarm_output_fault',
    'alarm_dc_1',
    'alarm_dc_2',
  ]);
  const kind = (key) => [features[key].category, features[key].type, features[key].unit];
  assert.deepEqual(kind('power'), [
    C.ENERGY_PRODUCTION_SENSOR,
    T.ENERGY_PRODUCTION_SENSOR.POWER,
    U.WATT,
  ]);
  assert.deepEqual(kind('energy_total'), [
    C.ENERGY_PRODUCTION_SENSOR,
    T.ENERGY_PRODUCTION_SENSOR.INDEX,
    U.KILOWATT_HOUR,
  ]);
  assert.deepEqual(kind('energy_today'), [
    C.ENERGY_PRODUCTION_SENSOR,
    T.ENERGY_PRODUCTION_SENSOR.DAILY_PRODUCTION,
    U.KILOWATT_HOUR,
  ]);
  assert.deepEqual(kind('limit'), [C.SWITCH, T.SWITCH.DIMMER, U.WATT]);
  assert.deepEqual(
    [features.limit.min, features.limit.max, features.limit.read_only],
    [30, 800, false],
  );
  assert.equal(features.switch.read_only, false);
  const b = buildInverterDevice(gladys, {
    serial: 'E07000000002',
    inputs: 2,
    switchSupported: false,
    limitSupported: false,
  });
  assert.ok(!b.features.some((f) => /:(switch|limit)$/.test(f.external_id)));
  assert.equal(parseExternalId('ext:apsystems:inverter:../x'), undefined);
});

test('the 30-minute production hangs off the index, with stable ids', () => {
  const gladys = createFakeGladys({ selector: 'apsystems' });
  const first = byKey(buildInverterDevice(gladys, EZ1M));
  // A later discovery with other bounds and inputs: the same ids.
  const again = byKey(buildInverterDevice(gladys, { ...EZ1M, maxPower: 600, inputs: 4 }));
  const production = first.energy_total_production;
  assert.deepEqual(
    [production.category, production.type, production.unit, production.read_only],
    [
      C.ENERGY_PRODUCTION_SENSOR,
      T.ENERGY_PRODUCTION_SENSOR.THIRTY_MINUTES_PRODUCTION,
      U.KILOWATT_HOUR,
      true,
    ],
  );
  assert.equal(production.energy_parent_id, first.energy_total.id);
  assert.match(
    first.energy_total.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(first.energy_total.id, uuidOf('ext:apsystems:inverter:E07000000001:energy_total'));
  assert.equal(again.energy_total.id, first.energy_total.id, 'same id at every discovery');
  assert.equal(again.energy_total_production.id, production.id);
  assert.notEqual(production.id, first.energy_total.id);
  assert.notEqual(uuidOf('a'), uuidOf('b'));
  // Another inverter, other ids; only the index and its production carry an id.
  const other = byKey(buildInverterDevice(gladys, { ...EZ1M, serial: 'E07000000002' }));
  assert.notEqual(other.energy_total.id, first.energy_total.id);
  assert.deepEqual(
    Object.entries(first)
      .filter(([, f]) => f.id !== undefined)
      .map(([key]) => key),
    ['energy_total', 'energy_total_production'],
  );
});

test('states: awake, then asleep (powers at 0, counters left alone)', () => {
  const id = 'ext:apsystems:inverter:E07000000001';
  const awake = inverterStates(id, {
    awake: true,
    power: 312.4,
    inputs: [152.4, 160],
    energyToday: 1.746,
    energyTotal: 810.437,
    limit: 600,
    on: true,
    alarms: { off_grid: false, dc_1: true },
  });
  const value = (states, key) =>
    states.find((s) => s.device_feature_external_id === `${id}:${key}`)?.state;
  assert.equal(value(awake, FEATURE.POWER), 312.4);
  assert.equal(value(awake, FEATURE.input(2)), 160);
  assert.equal(value(awake, FEATURE.ENERGY_TOTAL), 810.437);
  assert.equal(value(awake, FEATURE.SWITCH), 1);
  assert.equal(value(awake, FEATURE.alarm('dc_1')), 1);
  assert.equal(value(awake, FEATURE.REACHABLE), 1);
  assert.equal(
    value(awake, FEATURE.PRODUCTION_30MIN),
    undefined,
    'never a state on the 30-minute production: the core writes it',
  );
  const asleep = inverterStates(id, { awake: false, inputs: [0, 0] });
  assert.deepEqual(
    asleep.map((s) => [s.device_feature_external_id.split(':').at(-1), s.state]),
    [
      ['reachable', 0],
      ['power', 0],
      ['power_1', 0],
      ['power_2', 0],
    ],
  );
});

test('production: nothing first, started after a minute, stopped after 15 minutes', () => {
  let step = productionStep(undefined, 300, NOON);
  assert.deepEqual([step.state.producing, step.event], [true, undefined], 'first reading');
  // A cloud: 2 W for 10 minutes, then back: no event (hysteresis).
  step = productionStep(step.state, 2, NOON + MIN);
  step = productionStep(step.state, 2, NOON + 10 * MIN);
  assert.equal(step.event, undefined);
  step = productionStep(step.state, 50, NOON + 11 * MIN);
  step = productionStep(step.state, 0, NOON + 12 * MIN);
  step = productionStep(step.state, 0, NOON + 12 * MIN + PRODUCTION.STOP_AFTER);
  assert.equal(step.event, 'stopped');
  step = productionStep(step.state, 0, NOON + 60 * MIN);
  assert.equal(step.event, undefined, 'one event per transition');
  step = productionStep(step.state, 15, NOON + 70 * MIN);
  assert.equal(step.event, undefined, 'not yet a minute');
  step = productionStep(step.state, 8, NOON + 70.5 * MIN);
  assert.equal(step.event, undefined);
  step = productionStep(step.state, 12, NOON + 71 * MIN);
  assert.equal(step.state.producing, false, 'dipped under 10 W: the minute starts again');
  step = productionStep(step.state, 12, NOON + 72 * MIN);
  assert.equal(step.event, 'started');
});

test('production events: the device select field, the name, the serial', () => {
  const who = { deviceId: 'ext:a:inverter:E1', name: 'Garage', serial: 'E1' };
  assert.deepEqual(productionEvent('started', { ...who, power: 40, energyToday: 0.03 }), {
    key: SCENE_TRIGGERS.STARTED,
    data: {
      inverter: 'ext:a:inverter:E1',
      name: 'Garage',
      serial: 'E1',
      power: 40,
      energy_today: 0.03,
    },
  });
  const stopped = productionEvent('stopped', who);
  assert.equal(stopped.key, SCENE_TRIGGERS.STOPPED);
  assert.deepEqual([stopped.data.power, stopped.data.energy_today], [0, null]);
  assert.equal(productionEvent(undefined, who), undefined);
});

test('alarms: nothing first, one event per raised alarm', () => {
  const clear = { off_grid: false, output_fault: false, dc_1: false, dc_2: false };
  assert.deepEqual(raisedAlarms(undefined, { ...clear, off_grid: true }), []);
  assert.deepEqual(raisedAlarms(clear, { ...clear, off_grid: true, dc_2: true }), [
    'off_grid',
    'dc_2',
  ]);
  assert.deepEqual(raisedAlarms({ ...clear, off_grid: true }, { ...clear, off_grid: true }), []);
  const event = alarmEvent('dc_2', {
    deviceId: 'ext:a:inverter:E1',
    name: 'Garage',
    serial: 'E1',
  });
  assert.equal(event.key, SCENE_TRIGGERS.ALARM);
  assert.deepEqual(event.data, {
    inverter: 'ext:a:inverter:E1',
    name: 'Garage',
    serial: 'E1',
    alarm: 'dc_short_circuit',
    input: 2,
  });
  assert.equal(alarmEvent('off_grid', { deviceId: 'x', name: 'y' }).data.input, null);
});

test('the widget: one inverter, all of them, none, all within the vocabulary', () => {
  const inverters = [
    {
      name: 'EZ1 Balcony',
      deviceId: 'ext:apsystems:inverter:E07000000001',
      status: 'producing',
      power: 312.4,
      inputs: [152.4, 160],
      energyToday: 1.746,
      energyTotal: 810.437,
      limit: 600,
      alarms: { off_grid: false, output_fault: false, dc_1: true, dc_2: false },
    },
    {
      name: 'EZ1 Garage',
      deviceId: 'ext:apsystems:inverter:E07000000002',
      status: 'asleep',
      power: 0,
      inputs: [0, 0],
      energyToday: 2.1,
      energyTotal: 100,
      limit: null,
      alarms: undefined,
    },
  ];
  const one = solarWidget({ inverters, deviceId: inverters[0].deviceId, language: 'fr' });
  assert.deepEqual(validateWidgetContent(one), []);
  assert.equal(one.components[1].device_feature, `${inverters[0].deviceId}:power`);
  const rows = one.components.find((c) => c.type === 'status').items;
  assert.deepEqual(
    rows.map((r) => `${r.label}: ${r.value}`),
    [
      'État: En production',
      'Panneau 1: 152.4 W',
      'Panneau 2: 160 W',
      'Limite de puissance: 600 W',
      'Alarme: Court-circuit DC 1',
    ],
  );
  const all = solarWidget({ inverters, language: 'en' });
  assert.deepEqual(validateWidgetContent(all), []);
  assert.deepEqual(
    all.components.filter((c) => c.type === 'value').map((c) => c.value),
    [312, 3.85, 910.44],
  );
  const list = all.components.find((c) => c.type === 'status').items;
  assert.equal(list[0].value, '312 W · 1.75 kWh · DC 1 short circuit');
  assert.equal(list[1].value, 'Sleeping (night)');
  const none = solarWidget({ inverters: [], language: 'en' });
  assert.deepEqual(validateWidgetContent(none), []);
  assert.match(none.components[0].text.en, /Discovery/);
});
