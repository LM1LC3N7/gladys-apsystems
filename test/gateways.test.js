// -----------------------------------------------------------------------------
// The ECU gateways against the SDK's fake Gladys and fake ECUs: Discovery,
// the pace (never faster than the interval, a reconnection included), the
// night, the failures, the index guard, the scenes, the widget, the test
// button, and the EZ1 untouched beside them.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ApsystemsApp } from '../src/app.js';
import { ACTIONS, SCENE_ACTIONS, SCENE_TRIGGERS, WIDGETS } from '../src/constants.js';
import { buildEcuDevice } from '../src/devices.js';
import { EcuClient, EcuQueue } from '../src/ecu.js';
import { fakeEcu, installEcus } from './helpers/fakeEcu.js';
import { fakeInverter, installInverters } from './helpers/fakeEz1.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

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
const E = '192.168.1.60:8899';
const ID_ECU = 'ext:apsystems:ecu:216300012345';
const ID_DS3 = 'ext:apsystems:ecu_inverter:703000012345';
const ID_EZ1 = 'ext:apsystems:inverter:E07000000001';

async function setup({ ecus, ecuHosts, hosts = '', inverters = {}, devices = [] }) {
  fake = installInverters(inverters);
  const transport = installEcus(ecus);
  const config = {
    hosts,
    poll_interval: 30,
    ecu_hosts: ecuHosts ?? Object.keys(ecus).join(', '),
    ecu_poll_interval: 300,
  };
  const gladys = createFakeGladys({ selector: 'apsystems', config, devices });
  const timers = createFakeTimers();
  const clock = { now: NOON };
  const app = new ApsystemsApp({
    gladys,
    logger: quiet,
    now: () => clock.now,
    timers,
    ecuQueue: new EcuQueue({ pause: 0 }),
    ecuClientFactory: (options) => new EcuClient({ ...options, request: transport.request }),
  });
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));
  gladys.onSceneAction(SCENE_ACTIONS.SET_POWER_LIMIT, (fields) => app.setPowerLimit(fields));
  gladys.onSceneAction(SCENE_ACTIONS.PRODUCTION, (fields) => app.getProduction(fields));
  gladys.onWidgetGet(WIDGETS.SOLAR, (request) => app.getWidget(WIDGETS.SOLAR, request));
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  await gladys.connect();
  const ctx = { app, gladys, timers, clock, config, ecus, transport };
  ctx.advance = async (ms) => {
    clock.now += ms;
    await timers.runIntervals();
  };
  ctx.state = (id, key) => gladys.fake.lastState(`${id}:${key}`);
  ctx.status = () => gladys.fake.connectionStatus;
  return ctx;
}

async function startAndCreate(ctx) {
  await ctx.app.start(ctx.config);
  for (const device of ctx.gladys.fake.discoveredDevices) {
    await ctx.gladys.fake.deviceCreated(device);
  }
}

const eventKeys = (ctx) => ctx.gladys.fake.sceneEvents.map((e) => e.key);
const deviceOf = (ctx, id) => ctx.gladys.fake.devices.find((d) => d.external_id === id);

test('Discovery lists the ECU and the micro-inverters behind it; states once created', async () => {
  const ctx = await setup({ ecus: { [E]: fakeEcu() } });
  await ctx.app.start(ctx.config);
  const found = ctx.gladys.fake.discoveredDevices;
  assert.deepEqual(
    found.map((d) => [d.external_id, d.name]),
    [
      [ID_ECU, 'ECU-B 216300012345'],
      [ID_DS3, 'DS3 703000012345'],
    ],
  );
  assert.deepEqual(
    found[0].params.map((p) => `${p.name}=${p.value}`),
    ['host=192.168.1.60:8899', 'model=ECU-B', 'firmware=ECU_B_1.2.24', 'inverters=1'],
  );
  assert.match(ctx.status().message.en, /1 ECU gateway answers: open Discovery/);
  assert.equal(ctx.transport.count(), 2, 'one reading: the ECU query, then the inverter query');
  for (const device of found) {
    await ctx.gladys.fake.deviceCreated(device);
  }
  const s = (key) => ctx.state(ID_ECU, key);
  assert.deepEqual(
    [s('power'), s('energy_today'), s('energy_total'), s('inverters_online'), s('reachable')],
    [250, 3.21, 1234.5, 1, 1],
  );
  const m = (key) => ctx.state(ID_DS3, key);
  assert.deepEqual(
    [
      m('online'),
      m('power'),
      m('power_1'),
      m('power_2'),
      m('voltage'),
      m('frequency'),
      m('temperature'),
    ],
    [1, 250, 120, 130, 231, 50.1, 35],
  );
  assert.equal(ctx.transport.count(), 2, 'a creation publishes the last reading, no new query');
  assert.equal(ctx.status().connected, true);
  assert.match(ctx.status().message.en, /1 ECU gateway: 1 producing/);
});

test('the pace: one reading per interval, a reconnection does not query again', async () => {
  const ctx = await setup({ ecus: { [E]: fakeEcu() } });
  await startAndCreate(ctx);
  const reads = ctx.transport.count();
  for (let i = 0; i < 9; i += 1) {
    await ctx.advance(30 * SEC);
  }
  assert.equal(ctx.transport.count(), reads, '270 s: not yet');
  await ctx.advance(30 * SEC);
  assert.equal(ctx.transport.count(), reads + 2, '300 s: one reading');
  // Gladys reconnects (`connected` restarts the app) twice in a row.
  const statuses = ctx.gladys.fake.connectionStatuses.length;
  let discoveries = 0;
  const publish = ctx.gladys.publishDiscoveredDevices.bind(ctx.gladys);
  ctx.gladys.publishDiscoveredDevices = (devices) => {
    discoveries += 1;
    return publish(devices);
  };
  await ctx.app.start(ctx.config);
  await ctx.app.start(ctx.config);
  assert.equal(ctx.transport.count(), reads + 2, 'the ECU is not queried again');
  assert.equal(discoveries, 2, 'Discovery republished at every start');
  assert.equal(
    ctx.gladys.fake.connectionStatuses.length,
    statuses + 2,
    'the status republished at every start',
  );
  assert.equal(ctx.transport.maxActive, 1, 'one connection at a time');
});

test('the night: the ECU answers, its inverters are offline: asleep, never an error', async () => {
  const ctx = await setup({ ecus: { [E]: fakeEcu() } });
  await startAndCreate(ctx);
  const ecu = ctx.ecus[E];
  await ctx.advance(5 * MIN); // a reading while producing
  // Dusk.
  ecu.power = 0;
  ecu.inverters = ecu.inverters.map((i) => ({ ...i, online: false, power: [0, 0] }));
  for (let i = 0; i < 4; i += 1) {
    await ctx.advance(5 * MIN);
  }
  assert.equal(ctx.status().connected, true);
  assert.match(ctx.status().message.en, /every inverter asleep \(night, normal\)/);
  assert.deepEqual(
    [
      ctx.state(ID_ECU, 'power'),
      ctx.state(ID_ECU, 'inverters_online'),
      ctx.state(ID_ECU, 'reachable'),
    ],
    [0, 0, 1],
  );
  assert.deepEqual([ctx.state(ID_DS3, 'online'), ctx.state(ID_DS3, 'power')], [0, 0]);
  assert.equal(ctx.state(ID_DS3, 'voltage'), 231, 'the rest keeps its last value');
  assert.deepEqual(eventKeys(ctx), [SCENE_TRIGGERS.STOPPED]);
  assert.deepEqual(ctx.gladys.fake.sceneEvents[0].data, {
    inverter: ID_ECU,
    name: 'ECU-B 216300012345',
    serial: '216300012345',
    power: 0,
    energy_today: 3.21,
  });
  // Dawn.
  ecu.power = 40;
  ecu.today = 0.01;
  ecu.inverters = ecu.inverters.map((i) => ({ ...i, online: true, power: [20, 20] }));
  await ctx.advance(5 * MIN);
  await ctx.advance(5 * MIN);
  assert.deepEqual(eventKeys(ctx), [SCENE_TRIGGERS.STOPPED, SCENE_TRIGGERS.STARTED]);
  assert.equal(ctx.state(ID_ECU, 'energy_today'), 0.01);
  const widget = await ctx.gladys.fake.widgetGet(WIDGETS.SOLAR, {
    settings: { inverter: ID_DS3 },
    language: 'fr',
  });
  const content = widget.data.content;
  assert.equal(content.components[1].device_feature, `${ID_DS3}:power`);
  assert.equal(
    content.components.filter((c) => c.type === 'value').length,
    1,
    'a micro-inverter: no energy tiles (the ECU counts it)',
  );
});

test('a hung ECU: spaced retries, never faster than the interval, then a red status', async () => {
  const ctx = await setup({ ecus: { [E]: fakeEcu() } });
  await startAndCreate(ctx);
  ctx.ecus[E].down = true;
  const states = ctx.gladys.fake.states.length;
  const reads = () => ctx.transport.count();
  const before = reads();
  await ctx.advance(5 * MIN); // miss 1, next in 5 min
  assert.equal(reads(), before + 2, 'a refused connection is tried twice');
  await ctx.advance(5 * MIN); // miss 2, next in 10 min
  assert.equal(reads(), before + 4);
  await ctx.advance(5 * MIN);
  assert.equal(reads(), before + 4, 'the second wait is twice as long');
  assert.equal(ctx.status().connected, true, 'not red after two misses');
  await ctx.advance(5 * MIN); // miss 3: red
  assert.equal(reads(), before + 6);
  assert.equal(ctx.status().connected, false);
  assert.match(ctx.status().message.en, /ECU not answering: ECU-B 216300012345/);
  assert.equal(ctx.state(ID_ECU, 'reachable'), 0);
  assert.equal(ctx.state(ID_ECU, 'power'), 250, 'its production is unknown, not zero');
  assert.ok(ctx.gladys.fake.states.length > states);
  for (let i = 0; i < 6; i += 1) {
    await ctx.advance(30 * SEC);
  }
  assert.equal(reads(), before + 6, 'the third wait: 20 minutes');
  ctx.ecus[E].down = false;
  await ctx.advance(20 * MIN);
  assert.equal(ctx.status().connected, true);
  assert.equal(ctx.state(ID_ECU, 'reachable'), 1);
  assert.deepEqual(eventKeys(ctx), [], 'unknown is not stopped');
});

test('the inverter query failing never blocks the figures of the ECU', async () => {
  const ctx = await setup({ ecus: { [E]: fakeEcu() } });
  await startAndCreate(ctx);
  ctx.ecus[E].inverterFails = true;
  ctx.ecus[E].power = 300;
  ctx.ecus[E].inverters = ctx.ecus[E].inverters.map((i) => ({ ...i, power: [150, 150] }));
  await ctx.advance(5 * MIN);
  assert.equal(ctx.state(ID_ECU, 'power'), 300);
  assert.equal(ctx.state(ID_DS3, 'power'), 250, 'the inverter keeps its last reading');
  assert.equal(ctx.status().connected, true);
});

test('the lifetime index: a 0 is never published, a jump waits for a save of the configuration', async () => {
  const ctx = await setup({ ecus: { [E]: fakeEcu() } });
  await startAndCreate(ctx);
  ctx.ecus[E].lifetime = 0;
  await ctx.advance(5 * MIN);
  assert.equal(ctx.state(ID_ECU, 'energy_total'), 1234.5);
  ctx.ecus[E].lifetime = 99_999;
  for (let i = 0; i < 4; i += 1) {
    await ctx.advance(5 * MIN);
  }
  assert.equal(ctx.state(ID_ECU, 'energy_total'), 1234.5, 'held, whatever the repetitions');
  await ctx.app.configUpdated(ctx.config);
  await ctx.advance(5 * MIN);
  assert.equal(ctx.state(ID_ECU, 'energy_total'), 99_999);
});

test('scenes and widget: the ECU counts once, its inverters never twice; read-only', async () => {
  const ctx = await setup({
    ecus: { [E]: fakeEcu() },
    hosts: '192.168.1.50',
    inverters: { '192.168.1.50:8050': fakeInverter() },
  });
  await startAndCreate(ctx);
  const all = await ctx.gladys.fake.sceneAction(SCENE_ACTIONS.PRODUCTION, {});
  assert.deepEqual(all.data.outputs, {
    power: 562.4,
    energy_today: 4.956,
    energy_total: 2044.937,
    producing: true,
    sleeping: false,
    inverters: 2,
  });
  const one = await ctx.gladys.fake.sceneAction(SCENE_ACTIONS.PRODUCTION, { inverter: ID_ECU });
  assert.deepEqual([one.data.outputs.power, one.data.outputs.inverters], [250, 1]);
  const micro = await ctx.gladys.fake.sceneAction(SCENE_ACTIONS.PRODUCTION, { inverter: ID_DS3 });
  assert.deepEqual([micro.data.outputs.power, micro.data.outputs.energy_total], [250, null]);
  const reads = ctx.transport.count();
  assert.equal(reads, 2, 'the scene action used the last reading');
  const limit = await ctx.gladys.fake.sceneAction(SCENE_ACTIONS.SET_POWER_LIMIT, {
    inverter: ID_ECU,
    value: 300,
  });
  assert.match(limit.error, /not available through an ECU/);
  const ecuDevice = deviceOf(ctx, ID_ECU);
  const refused = await ctx.gladys.fake.setValue(ecuDevice, ecuDevice.features[0], 1);
  assert.match(refused.error, /read-only/);
  const widget = (await ctx.gladys.fake.widgetGet(WIDGETS.SOLAR, { settings: {}, language: 'en' }))
    .data.content;
  assert.equal(widget.components[1].value, 562, 'EZ1 312.4 W + ECU 250 W, not the DS3 again');
  assert.deepEqual(
    widget.components.find((c) => c.type === 'status').items.map((i) => i.label),
    ['EZ1 E07000000001', 'ECU-B 216300012345'],
  );
  const single = (
    await ctx.gladys.fake.widgetGet(WIDGETS.SOLAR, {
      settings: { inverter: ID_ECU },
      language: 'en',
    })
  ).data.content;
  const items = single.components.find((c) => c.type === 'status').items;
  assert.deepEqual(items[1], {
    label: 'Inverters online',
    value: '1 / 1',
    icon: 'cpu',
    color: items[1].color,
  });
  assert.match(ctx.status().message.en, /^1 inverter: 1 producing\. 1 ECU gateway: 1 producing\.$/);
  assert.equal(ctx.state(ID_EZ1, 'power'), 312.4, 'the EZ1 is read as before');
});

test('the test button reports the last reading instead of querying a fragile ECU again', async () => {
  const ctx = await setup({
    ecus: { [E]: fakeEcu(), '192.168.1.61:8899': fakeEcu({ id: '216300099999', down: true }) },
    ecuHosts: `${E}, 192.168.1.61, bad address!`,
  });
  await ctx.app.start(ctx.config);
  const reads = ctx.transport.count();
  const result = await ctx.gladys.fake.action(ACTIONS.TEST);
  const lines = result.data.message.en.split('\n');
  assert.match(
    lines[0],
    /^192\.168\.1\.60:8899: ECU-B 216300012345 \(firmware ECU_B_1\.2\.24\), 1 of 1 inverters online, 250 W now\./,
  );
  assert.match(lines[1], /^192\.168\.1\.61:8899: the ECU does not answer \(ECONNREFUSED\)/);
  assert.match(lines[2], /Entry 3 of the ECU address list is not valid/);
  assert.equal(ctx.transport.count(), reads, 'no new query within the interval');
});

test('a restart with the ECU address removed: the created ECU is still read at its address', async () => {
  const gladys = createFakeGladys({ selector: 'apsystems' });
  const created = buildEcuDevice(gladys, {
    id: '216300012345',
    model: 'ECU-B',
    hostKey: E,
    inverters: 1,
  });
  const index = created.features.find((f) => f.external_id.endsWith(':energy_total'));
  // Published by the last run, the day before: 34.5 kWh in 24 h is plausible for one inverter.
  Object.assign(index, {
    last_value: 1200,
    last_value_changed: new Date(NOON - 24 * 60 * MIN).toISOString(),
  });
  const ctx = await setup({ ecus: { [E]: fakeEcu() }, ecuHosts: '', devices: [created] });
  await ctx.app.start({ ...ctx.config, ecu_hosts: '' });
  assert.equal(ctx.transport.count(), 2);
  assert.equal(ctx.state(ID_ECU, 'energy_total'), 1234.5);
  assert.equal(ctx.state(ID_ECU, 'power'), 250);
});

test('a restart: the reference of the index is the value Gladys holds, a jump from it is held', async () => {
  const gladys = createFakeGladys({ selector: 'apsystems' });
  const created = buildEcuDevice(gladys, { id: '216300012345', model: 'ECU-B', hostKey: E });
  Object.assign(
    created.features.find((f) => f.external_id.endsWith(':energy_total')),
    { last_value: 1200, last_value_changed: new Date(NOON - 10 * MIN).toISOString() },
  );
  const ctx = await setup({ ecus: { [E]: fakeEcu() }, devices: [created] });
  await ctx.app.start(ctx.config);
  assert.equal(ctx.state(ID_ECU, 'power'), 250);
  assert.equal(ctx.state(ID_ECU, 'energy_total'), undefined, '34.5 kWh in 10 minutes: held');
});

test('no address at all: the status says what to type, EZ1 and ECU', async () => {
  const ctx = await setup({ ecus: {}, ecuHosts: '' });
  await ctx.app.start({});
  assert.equal(ctx.status().connected, false);
  assert.match(ctx.status().message.en, /port 8050\), or of your ECU gateway \(port 8899\)/);
  assert.equal(ctx.transport.count(), 0);
});
