// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and fake EZ1 inverters:
// identification and Discovery, the reading loop, the night, the commands,
// the scene triggers and action, the widget, the test button.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ApsystemsApp } from '../src/app.js';
import { ACTIONS, PACING, SCENE_ACTIONS, SCENE_TRIGGERS, WIDGETS } from '../src/constants.js';
import { buildInverterDevice } from '../src/devices.js';
import { fakeInverter, installInverters } from './helpers/fakeEz1.js';
import { createFakeTimers } from './helpers/fakeTimers.js';
import { StateStore, memoryIo } from '../src/store.js';

const quiet = {
  info() {},
  warn: (...a) => process.env.DEBUG_TEST && console.error(...a),
  error() {},
  debug() {},
};

let fake;
afterEach(() => fake?.restore());

const NOON = Date.parse('2026-06-15T12:00:00Z');
const SEC = 1000;
const MIN = 60 * SEC;
const A = '192.168.1.50:8050';
const B = '192.168.1.51:8050';
const D = '192.168.1.52:8050';
const ID_A = 'ext:apsystems:inverter:E07000000001';
const ID_B = 'ext:apsystems:inverter:E07000000002';
const ID_D = 'ext:apsystems:inverter:E07000000003';

async function setup({ inverters, hosts = Object.keys(inverters).join(', '), devices = [] }) {
  fake = installInverters(inverters);
  const config = { hosts, poll_interval: 30 };
  const gladys = createFakeGladys({ selector: 'apsystems', config, devices });
  const timers = createFakeTimers();
  const clock = { now: NOON };
  const io = memoryIo();
  const app = new ApsystemsApp({
    gladys,
    logger: quiet,
    now: () => clock.now,
    timers,
    store: new StateStore({ dir: '/data', io }),
  });
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));
  gladys.onSceneAction(SCENE_ACTIONS.SET_POWER_LIMIT, (fields) => app.setPowerLimit(fields));
  gladys.onSceneAction(SCENE_ACTIONS.PRODUCTION, (fields) => app.getProduction(fields));
  gladys.onWidgetGet(WIDGETS.SOLAR, (request) => app.getWidget(WIDGETS.SOLAR, request));
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  await gladys.connect();
  const ctx = { app, gladys, timers, clock, config, inverters };
  ctx.advance = async (ms) => {
    clock.now += ms;
    await timers.runIntervals();
  };
  ctx.state = (id, key) => gladys.fake.lastState(`${id}:${key}`);
  ctx.status = () => gladys.fake.connectionStatus;
  return ctx;
}

/** Start, then create every discovered inverter like the user would. */
async function startAndCreate(ctx) {
  await ctx.app.start(ctx.config);
  for (const device of ctx.gladys.fake.discoveredDevices) {
    await ctx.gladys.fake.deviceCreated(device);
  }
}

const deviceOf = (ctx, id) => ctx.gladys.fake.devices.find((d) => d.external_id === id);
const featureOf = (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));
const eventKeys = (ctx) => ctx.gladys.fake.sceneEvents.map((e) => e.key);

test('no address: the status says what to do, nothing is read', async () => {
  const ctx = await setup({ inverters: {}, hosts: '' });
  await ctx.app.start({});
  assert.equal(ctx.status().connected, false);
  assert.match(ctx.status().message.fr, /saisissez l’adresse IP/);
  assert.equal(fake.calls.length, 0);
  assert.equal(ctx.timers.intervals().length, 0);
});

test('start identifies each address; Discovery lists what each firmware offers', async () => {
  const ctx = await setup({
    inverters: {
      [A]: fakeInverter(),
      [B]: fakeInverter({ firmware: 'b' }),
      '192.168.1.53:8050': fakeInverter({ asleep: true }),
    },
  });
  await ctx.app.start(ctx.config);
  const [a, b] = ctx.gladys.fake.discoveredDevices;
  assert.equal(ctx.gladys.fake.discoveredDevices.length, 2, 'the sleeping one is not listed');
  assert.equal(a.external_id, ID_A);
  assert.equal(a.name, 'EZ1 E07000000001');
  assert.deepEqual(
    a.params.map((p) => `${p.name}=${p.value}`),
    [
      'host=192.168.1.50:8050',
      'model=EZ1',
      'firmware=EZ1 1.6.0',
      'min_power=30',
      'max_power=800',
      'inputs=2',
      'limit_endpoint=MaxPower',
      'switch=1',
    ],
  );
  assert.ok(featureOf(a, 'switch') && featureOf(a, 'limit'));
  assert.equal(b.external_id, ID_B);
  assert.ok(featureOf(b, 'limit'), 'the "_b" firmware still reports its limit');
  assert.equal(featureOf(b, 'switch'), undefined, 'no getOnOff on the "_b" firmware');
  assert.equal(ctx.status().connected, true);
  assert.match(ctx.status().message.en, /2 inverters answer: open Discovery/);
  assert.equal(ctx.timers.intervals()[0].ms, 30 * SEC);
});

test('a created inverter is read, then each kind of data at its own pace', async () => {
  const ctx = await setup({ inverters: { [A]: fakeInverter() } });
  await startAndCreate(ctx);
  const s = (key) => ctx.state(ID_A, key);
  assert.deepEqual(
    [s('power'), s('power_1'), s('power_2'), s('energy_today'), s('energy_total')],
    [312.4, 152.4, 160, 1.746, 810.437],
  );
  assert.deepEqual([s('limit'), s('switch'), s('reachable'), s('alarm_off_grid')], [600, 1, 1, 0]);
  assert.match(ctx.status().message.en, /1 inverter: 1 producing/);
  const before = {
    output: fake.count('getOutputData'),
    alarm: fake.count('getAlarm'),
    info: fake.count('getDeviceInfo'),
  };
  await ctx.advance(30 * SEC);
  assert.equal(fake.count('getOutputData'), before.output + 1);
  assert.equal(fake.count('getAlarm'), before.alarm, 'the alarms every 5 minutes only');
  await ctx.advance(PACING.ALARMS);
  assert.equal(fake.count('getAlarm'), before.alarm + 1);
  assert.equal(fake.count('getDeviceInfo'), before.info, 'the information every hour only');
  await ctx.advance(PACING.INFO);
  assert.equal(fake.count('getDeviceInfo'), before.info + 1);
  assert.equal(ctx.gladys.fake.sceneEvents.length, 0, 'no transition, no event');
});

test('the night: asleep, quiet, no red status; one event at dusk, one at dawn', async () => {
  const ctx = await setup({ inverters: { [A]: fakeInverter() } });
  await startAndCreate(ctx);
  const inv = ctx.inverters[A];
  // Dusk: 3 W, then the Wi-Fi goes away with the sun.
  inv.output = { p1: 1, e1: 2.5, te1: 413, p2: 2, e2: 2.6, te2: 399 };
  await ctx.advance(30 * SEC);
  inv.asleep = true;
  for (let i = 0; i < 3; i += 1) {
    await ctx.advance(30 * SEC);
  }
  assert.deepEqual(
    [ctx.state(ID_A, 'power'), ctx.state(ID_A, 'power_1'), ctx.state(ID_A, 'reachable')],
    [0, 0, 0],
  );
  assert.equal(ctx.state(ID_A, 'energy_today'), 5.1, 'the counters keep their value');
  assert.equal(ctx.status().connected, true);
  assert.match(ctx.status().message.en, /1 asleep \(night, normal\)/);
  const tries = fake.count('getOutputData');
  await ctx.advance(30 * SEC);
  assert.equal(fake.count('getOutputData'), tries, 'asleep: tried every 5 minutes only');
  for (let i = 0; i < 3; i += 1) {
    await ctx.advance(PACING.ASLEEP);
  }
  assert.deepEqual(eventKeys(ctx), [SCENE_TRIGGERS.STOPPED]);
  assert.deepEqual(ctx.gladys.fake.sceneEvents[0].data, {
    inverter: ID_A,
    name: 'EZ1 E07000000001',
    serial: 'E07000000001',
    power: 0,
    energy_today: 5.1,
  });
  // Dawn, ten hours later: the counter of the day restarted.
  ctx.clock.now += 10 * 60 * MIN;
  inv.asleep = false;
  inv.output = { p1: 20, e1: 0.01, te1: 413, p2: 20, e2: 0.02, te2: 399 };
  await ctx.advance(30 * SEC);
  assert.equal(ctx.state(ID_A, 'energy_today'), 0.03);
  assert.equal(ctx.state(ID_A, 'reachable'), 1);
  await ctx.advance(30 * SEC);
  assert.equal(eventKeys(ctx).length, 1, 'started only after a minute');
  await ctx.advance(30 * SEC);
  assert.deepEqual(eventKeys(ctx), [SCENE_TRIGGERS.STOPPED, SCENE_TRIGGERS.STARTED]);
  assert.equal(ctx.gladys.fake.sceneEvents[1].data.power, 40);
});

test('a creation during a reading does not read the inverter twice', async () => {
  const ctx = await setup({ inverters: { [A]: fakeInverter() } });
  await startAndCreate(ctx);
  const before = fake.count('getOutputData');
  ctx.clock.now += 30 * SEC;
  await Promise.all([ctx.timers.runIntervals(), ctx.app.deviceCreated(deviceOf(ctx, ID_A))]);
  assert.equal(fake.count('getOutputData'), before + 1);
});

test('an inverter that vanishes in full sun is reported by name', async () => {
  const ctx = await setup({ inverters: { [A]: fakeInverter() } });
  await startAndCreate(ctx);
  ctx.inverters[A].asleep = true;
  for (let i = 0; i < 3; i += 1) {
    await ctx.advance(30 * SEC);
  }
  assert.equal(ctx.status().connected, false);
  assert.match(ctx.status().message.en, /Not answering while the sun is up: EZ1 E07000000001/);
  for (let i = 0; i < 4; i += 1) {
    await ctx.advance(PACING.ASLEEP);
  }
  assert.deepEqual(eventKeys(ctx), [], 'unknown is not stopped');
  ctx.inverters[A].asleep = false;
  await ctx.advance(PACING.ASLEEP);
  assert.equal(ctx.status().connected, true);
});

test('alarms: the first reading arms, an alarm fires once, waking up arms again', async () => {
  const ctx = await setup({ inverters: { [A]: fakeInverter() } });
  await startAndCreate(ctx);
  const inv = ctx.inverters[A];
  inv.alarms.og = '1';
  await ctx.advance(PACING.ALARMS);
  assert.deepEqual(ctx.gladys.fake.sceneEvents, [
    {
      key: SCENE_TRIGGERS.ALARM,
      data: {
        inverter: ID_A,
        name: 'EZ1 E07000000001',
        serial: 'E07000000001',
        alarm: 'off_grid',
        input: null,
      },
    },
  ]);
  assert.equal(ctx.state(ID_A, 'alarm_off_grid'), 1);
  await ctx.advance(PACING.ALARMS);
  inv.alarms.og = '0';
  await ctx.advance(PACING.ALARMS);
  assert.equal(ctx.state(ID_A, 'alarm_off_grid'), 0);
  // Night, then a morning that starts with the grid check flag up: no event.
  inv.output = { ...inv.output, p1: 0, p2: 0 };
  await ctx.advance(30 * SEC);
  inv.asleep = true;
  for (let i = 0; i < 3; i += 1) {
    await ctx.advance(30 * SEC);
  }
  inv.asleep = false;
  inv.alarms.og = '1';
  await ctx.advance(PACING.ASLEEP);
  inv.alarms.isce2 = '1';
  await ctx.advance(PACING.ALARMS);
  const alarms = ctx.gladys.fake.sceneEvents.filter((e) => e.key === SCENE_TRIGGERS.ALARM);
  assert.deepEqual(
    alarms.map((e) => [e.data.alarm, e.data.input]),
    [
      ['off_grid', null],
      ['dc_short_circuit', 2],
    ],
  );
});

test('the power limit: bounds, never rewritten, written once, not at night', async () => {
  const ctx = await setup({ inverters: { [A]: fakeInverter() } });
  await startAndCreate(ctx);
  const device = deviceOf(ctx, ID_A);
  const limit = featureOf(device, 'limit');
  const tooHigh = await ctx.gladys.fake.setValue(device, limit, 900);
  assert.equal(tooHigh.success, false);
  assert.match(tooHigh.error, /from 30 to 800 W/);
  assert.equal((await ctx.gladys.fake.setValue(device, limit, 600)).success, true);
  assert.equal(fake.count('setMaxPower'), 0, 'the inverter already has 600 W');
  assert.equal((await ctx.gladys.fake.setValue(device, limit, 450)).success, true);
  assert.deepEqual(fake.calls.filter((c) => c.endpoint === 'setMaxPower')[0].params, { p: '450' });
  assert.equal(ctx.inverters[A].limit, 450);
  assert.equal(ctx.state(ID_A, 'limit'), 450);
  ctx.inverters[A].asleep = true;
  const night = await ctx.gladys.fake.setValue(device, limit, 300);
  assert.equal(night.success, false);
  assert.match(night.error, /sleeps without sun/);
  const power = await ctx.gladys.fake.setValue(device, featureOf(device, 'power'), 1);
  assert.match(power.error, /read-only/);
});

test('on/off, and the firmware that has none', async () => {
  const ctx = await setup({
    inverters: { [A]: fakeInverter(), [B]: fakeInverter({ firmware: 'b' }) },
  });
  await startAndCreate(ctx);
  const a = deviceOf(ctx, ID_A);
  assert.equal((await ctx.gladys.fake.setValue(a, featureOf(a, 'switch'), 0)).success, true);
  assert.deepEqual(fake.calls.at(-1).params, { status: '1' }, 'status 1 is OFF');
  assert.equal(ctx.state(ID_A, 'switch'), 0);
  const widget = await ctx.gladys.fake.widgetGet(WIDGETS.SOLAR, {
    settings: { inverter: ID_A },
    language: 'en',
  });
  const rows = widget.data.content.components.find((c) => c.type === 'status').items;
  assert.equal(rows[0].value, 'Switched off');
  const b = deviceOf(ctx, ID_B);
  const refused = await ctx.gladys.fake.setValue(b, { external_id: `${ID_B}:switch` }, 0);
  assert.match(refused.error, /offers no on\/off/);
});

test('the scene action, on an EZ1-D and its own limit endpoints', async () => {
  const ctx = await setup({ inverters: { [D]: fakeInverter({ firmware: 'ez1d' }) } });
  await startAndCreate(ctx);
  const device = deviceOf(ctx, ID_D);
  assert.equal(device.name, 'EZ1-D E07000000003');
  assert.equal(device.params.find((p) => p.name === 'limit_endpoint').value, 'DefaultMaxPower');
  const done = await ctx.gladys.fake.sceneAction(SCENE_ACTIONS.SET_POWER_LIMIT, {
    inverter: ID_D,
    value: 1200,
  });
  assert.equal(done.success, true);
  assert.deepEqual(done.data.outputs, { limit: 1200 });
  assert.equal(fake.count('setDefaultMaxPower'), 1);
  assert.equal(fake.count('setMaxPower'), 0);
  const low = await ctx.gladys.fake.sceneAction(SCENE_ACTIONS.SET_POWER_LIMIT, {
    inverter: ID_D,
    value: 50,
  });
  assert.match(low.error, /from 80 to 1800 W/);
  const unknown = await ctx.gladys.fake.sceneAction(SCENE_ACTIONS.SET_POWER_LIMIT, {
    inverter: 'ext:apsystems:inverter:E00000000000',
    value: 300,
  });
  assert.equal(unknown.success, false);
  assert.equal(eventKeys(ctx).length, 0, 'no event from an action');
});

test('get_production: all inverters or one, from the last readings, at night too', async () => {
  const ctx = await setup({
    inverters: { [A]: fakeInverter(), [B]: fakeInverter({ firmware: 'b' }) },
  });
  await startAndCreate(ctx);
  const reads = fake.count('getOutputData');
  const all = await ctx.gladys.fake.sceneAction(SCENE_ACTIONS.PRODUCTION, {});
  assert.equal(all.success, true);
  assert.deepEqual(all.data.outputs, {
    power: 624.8,
    energy_today: 3.492,
    energy_total: 1620.874,
    producing: true,
    sleeping: false,
    inverters: 2,
  });
  assert.equal(fake.count('getOutputData'), reads, 'the last readings: no request');
  // A falls asleep: 0 W, its counters kept.
  ctx.inverters[A].output = { ...ctx.inverters[A].output, p1: 0, p2: 0 };
  await ctx.advance(30 * SEC);
  ctx.inverters[A].asleep = true;
  for (let i = 0; i < 3; i += 1) {
    await ctx.advance(30 * SEC);
  }
  const one = await ctx.gladys.fake.sceneAction(SCENE_ACTIONS.PRODUCTION, { inverter: ID_A });
  assert.deepEqual(one.data.outputs, {
    power: 0,
    energy_today: 1.746,
    energy_total: 810.437,
    producing: false,
    sleeping: true,
    inverters: 1,
  });
  const both = await ctx.gladys.fake.sceneAction(SCENE_ACTIONS.PRODUCTION, {});
  assert.deepEqual([both.data.outputs.power, both.data.outputs.sleeping], [312.4, false]);
  const unknown = await ctx.gladys.fake.sceneAction(SCENE_ACTIONS.PRODUCTION, {
    inverter: 'ext:apsystems:inverter:E00000000000',
  });
  assert.equal(unknown.success, false);
  assert.ok(
    !eventKeys(ctx).includes(SCENE_TRIGGERS.STARTED),
    'no event from an action (the evening stop may fire, never a start)',
  );
});

test('get_production before the first reading reads the inverter once; none: an error', async () => {
  const none = await setup({ inverters: {}, hosts: '' });
  const empty = await none.gladys.fake.sceneAction(SCENE_ACTIONS.PRODUCTION, {});
  assert.match(empty.error, /add one in Discovery/);
  fake.restore();
  const gladys = createFakeGladys({ selector: 'apsystems' });
  const created = buildInverterDevice(gladys, {
    serial: 'E07000000001',
    model: 'EZ1',
    hostKey: A,
    inputs: 2,
    switchSupported: true,
    limitSupported: true,
    limitVariant: 'MaxPower',
  });
  const ctx = await setup({ inverters: { [A]: fakeInverter() }, devices: [created] });
  // A scene reaches the action before the integration's first reading.
  const result = await ctx.gladys.fake.sceneAction(SCENE_ACTIONS.PRODUCTION, {});
  assert.deepEqual(
    [result.data.outputs.power, result.data.outputs.producing, result.data.outputs.inverters],
    [312.4, true, 1],
  );
  assert.equal(fake.count('getOutputData'), 1);
  await ctx.gladys.fake.sceneAction(SCENE_ACTIONS.PRODUCTION, {});
  assert.equal(fake.count('getOutputData'), 1, 'read once, then the readings of the loop');
  assert.equal(eventKeys(ctx).length, 0);
});

test('the widget through Gladys: one inverter, or all of them', async () => {
  const ctx = await setup({
    inverters: { [A]: fakeInverter(), [B]: fakeInverter({ firmware: 'b' }) },
  });
  await startAndCreate(ctx);
  const one = (
    await ctx.gladys.fake.widgetGet(WIDGETS.SOLAR, { settings: { inverter: ID_A }, language: 'fr' })
  ).data.content;
  assert.equal(one.components[0].text, 'EZ1 E07000000001');
  assert.equal(one.components[1].device_feature, `${ID_A}:power`);
  const all = (await ctx.gladys.fake.widgetGet(WIDGETS.SOLAR, { settings: {}, language: 'en' }))
    .data.content;
  assert.equal(all.components[1].value, 625, 'two inverters at 312.4 W');
  assert.equal(all.components.find((c) => c.type === 'status').items.length, 2);
});

test('the test button: who answers, who sleeps, what is not an address', async () => {
  const ctx = await setup({
    inverters: { [A]: fakeInverter(), '192.168.1.53:8050': fakeInverter({ asleep: true }) },
    hosts: '192.168.1.50, 192.168.1.53, not an address!',
  });
  await ctx.app.start(ctx.config);
  const result = await ctx.gladys.fake.action(ACTIONS.TEST);
  const lines = result.data.message.en.split('\n');
  assert.match(
    lines[0],
    /^192\.168\.1\.50:8050: EZ1 E07000000001 \(firmware EZ1 1\.6\.0\), 312\.4 W/,
  );
  assert.match(lines[1], /^192\.168\.1\.53:8050: no answer \(EHOSTUNREACH\)\. Normal at night/);
  assert.match(lines[2], /Entry 3 of the address list is not/);
  assert.match(ctx.status().message.en, /Entry 3 of the address list/);
});

test('another inverter at the address is never taken for this one', async () => {
  const ctx = await setup({ inverters: { [A]: fakeInverter() } });
  await startAndCreate(ctx);
  // The router gave the address to another inverter, producing 999 W.
  Object.assign(ctx.inverters[A], { answerAs: 'E07000000009' });
  ctx.inverters[A].output = { ...ctx.inverters[A].output, p1: 999 };
  for (let i = 0; i < 3; i += 1) {
    await ctx.advance(30 * SEC);
  }
  assert.ok(!ctx.gladys.fake.states.some((s) => s.state >= 999));
  assert.equal(ctx.status().connected, false);
  assert.equal(ctx.app.hosts.get(A).serial, undefined, 'the address will be asked again');
});

test('a restart at night: the device is enough, the lifetime index is guarded', async () => {
  const gladys = createFakeGladys({ selector: 'apsystems' });
  const created = buildInverterDevice(gladys, {
    serial: 'E07000000001',
    model: 'EZ1',
    devVer: 'EZ1 1.6.0',
    hostKey: A,
    minPower: 30,
    maxPower: 800,
    inputs: 2,
    switchSupported: true,
    limitSupported: true,
    limitVariant: 'MaxPower',
  });
  featureOf(created, 'energy_total').last_value = 810.437;
  // The configuration was emptied: the device keeps working on its params.
  const ctx = await setup({
    inverters: { [A]: fakeInverter({ asleep: true }) },
    hosts: '',
    devices: [created],
  });
  await ctx.app.start({ hosts: '' });
  await ctx.advance(30 * SEC);
  await ctx.advance(30 * SEC);
  assert.equal(ctx.state(ID_A, 'reachable'), 0);
  assert.equal(ctx.status().connected, true);
  assert.match(ctx.status().message.en, /asleep/);
  // Morning: the first answer carries a lifetime counter at 0 (a glitch).
  const inv = ctx.inverters[A];
  inv.asleep = false;
  inv.output = { p1: 25, e1: 0.01, te1: 0, p2: 25, e2: 0.01, te2: 0 };
  await ctx.advance(PACING.ASLEEP);
  assert.equal(ctx.state(ID_A, 'power'), 50);
  assert.equal(ctx.state(ID_A, 'energy_total'), undefined, 'a jump down is not published');
  inv.output = { ...inv.output, te1: 412.4, te2: 398.2 };
  await ctx.advance(30 * SEC);
  assert.equal(ctx.state(ID_A, 'energy_total'), 810.6);
});
