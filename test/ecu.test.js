// -----------------------------------------------------------------------------
// The ECU protocol (frames, bounds, checks), the socket reader, the queue,
// the client, the lifetime index guard, the ECU devices. Pure or faked: no
// socket is opened.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig } from '../src/config.js';
import { ECU } from '../src/constants.js';
import {
  ECU_FEATURE,
  buildEcuDevice,
  buildEcuInverterDevice,
  ecuInverterStates,
  ecuStates,
  keepCreatedFeatures,
  parseEcuExternalId,
  parseEcuInverterExternalId,
  parseExternalId,
  uuidOf,
} from '../src/devices.js';
import { EcuClient, EcuQueue, tcpRequest } from '../src/ecu.js';
import {
  ECU_QUERY,
  EcuError,
  FrameReader,
  checkFrame,
  inverterQuery,
  parseEcuFrame,
  parseInverterFrame,
} from '../src/ecu-protocol.js';
import { IndexGuard } from '../src/guard.js';
import { ecuFrame, frame, inverterFrame } from './helpers/fakeEcu.js';

const HOUR = 3_600_000;
const NOON = Date.parse('2026-06-15T12:00:00Z');

test('the ECU frame, layout 01 (ECU-B, ECU-R) and 02', () => {
  const b = parseEcuFrame(ecuFrame());
  assert.deepEqual(b, {
    id: '216300012345',
    model: 'ECU-B',
    lifetimeEnergy: 1234.5,
    currentPower: 456,
    todayEnergy: 3.21,
    inverters: 1,
    online: 1,
    firmware: 'ECU_B_1.2.24',
    timezone: 'Europe/Paris',
  });
  const c = parseEcuFrame(
    ecuFrame({ id: '215000001234', layout: '02', inverters: 12, online: 0, firmware: 'C1.2.3' }),
  );
  assert.deepEqual(
    [c.model, c.inverters, c.online, c.firmware, c.timezone],
    ['ECU-C', 12, 0, 'C1.2.3', null],
  );
  // An unknown layout keeps the three energy figures, nothing it cannot read.
  const other = parseEcuFrame(ecuFrame({ id: '216200000001', layout: '03' }));
  assert.deepEqual(
    [other.model, other.currentPower, other.inverters, other.online],
    ['ECU-R-Pro', 456, null, null],
  );
});

test('the ECU frame is checked: length, signatures, command, id, bounds', () => {
  const good = ecuFrame();
  assert.throws(() => parseEcuFrame(frame('0001', Buffer.alloc(30), { badLength: true })), {
    message: /length check failed/,
  });
  assert.throws(() => checkFrame(frame('0001', Buffer.alloc(30), { end: 'ENX\n' })), {
    message: /signature/,
  });
  const notAps = Buffer.from(good);
  notAps.write('XPS', 0, 'latin1');
  assert.throws(() => checkFrame(notAps), { message: /signature/ });
  assert.throws(() => parseEcuFrame(inverterFrame([])), { message: /expected an ECU frame/ });
  // A frame that ends before the firmware it announces: no read past the
  // end, the figures kept, the firmware and the time zone left unknown.
  const cut = Buffer.concat([
    Buffer.from('216300012345' + '01', 'latin1'),
    Buffer.alloc(25),
    Buffer.from('099ab'),
  ]);
  cut.writeUInt32BE(4560, 14); // the lifetime energy, at offset 27 of the frame
  const short = parseEcuFrame(frame('0001', cut));
  assert.deepEqual(
    [short.lifetimeEnergy, short.firmware, short.timezone, short.inverters],
    [456, null, null, 0],
  );
  // An inverter frame too short for its header: no inverter, not an error.
  assert.equal(parseInverterFrame(frame('0002', Buffer.from('0001'))).inverters.size, 0);
  // A type that is not two letters or digits is unknown: the list stops there.
  const odd = parseInverterFrame(inverterFrame([{ uid: '703000012345', type: '\u0001!' }]));
  assert.deepEqual([odd.inverters.get('703000012345').type, odd.truncated], [null, false]);
  // The figures themselves past the end: an error.
  assert.throws(
    () => parseEcuFrame(frame('0001', Buffer.from('216300012345' + '01', 'latin1'))),
    (err) => err instanceof EcuError && err.code === 'protocol',
  );
  // An id that is not 12 letters or digits.
  const badId = Buffer.from(good);
  badId.write('2163/0012345', 13, 'latin1');
  assert.throws(() => parseEcuFrame(badId), { message: /no valid ECU id/ });
  assert.throws(() => checkFrame(Buffer.from('APS1100')), { message: /too short/ });
});

test('the inverter frame: every type of the reference, and its bounds', () => {
  const parsed = parseInverterFrame(
    inverterFrame([
      { uid: '703000012345', type: '01', power: [120, 130], voltage: [231], temperature: 41 },
      { uid: '501000000001', type: '02', power: [10, 20, 30, 40], voltage: [230, 231, 232] },
      { uid: '801000000002', type: '03', power: [1, 2, 3, 4], voltage: [229] },
      { uid: '704000000003', type: '04', online: false, power: [0, 0], voltage: [0] },
    ]),
  );
  assert.equal(parsed.timestamp, '2026-06-15 12:00:00');
  assert.ok(parsed.inverters instanceof Map);
  const ds3 = parsed.inverters.get('703000012345');
  assert.deepEqual(
    [
      ds3.model,
      ds3.online,
      ds3.channels,
      ds3.phases,
      ds3.power,
      ds3.voltage,
      ds3.frequency,
      ds3.temperature,
    ],
    ['DS3', true, 2, 1, [120, 130], [231], 50.1, 41],
  );
  const yc1000 = parsed.inverters.get('501000000001');
  assert.deepEqual(
    [yc1000.model, yc1000.channels, yc1000.phases, yc1000.power, yc1000.voltage],
    ['YC1000', 4, 3, [10, 20, 30, 40], [230, 231, 232]],
  );
  const qs1 = parsed.inverters.get('801000000002');
  assert.deepEqual(
    [qs1.model, qs1.channels, qs1.power, qs1.voltage],
    ['QS1', 4, [1, 2, 3, 4], [229]],
  );
  const offline = parsed.inverters.get('704000000003');
  assert.deepEqual([offline.online, offline.temperature], [false, null], 'no temperature offline');
  // More inverters announced than the frame holds: an error, never a read past the end.
  assert.throws(
    () => parseInverterFrame(inverterFrame([{ uid: '703000012345' }], { count: 3 })),
    /past the end/,
  );
  // No inverter data (none paired yet).
  assert.equal(parseInverterFrame(inverterFrame([], { empty: true })).inverters.size, 0);
});

test('an unknown inverter type stops the list there (the next offsets would be guesses)', () => {
  const parsed = parseInverterFrame(
    inverterFrame([
      { uid: '703000012345', type: '01' },
      { uid: 'a00000000001', type: '09' },
      { uid: '703000012346', type: '01' },
    ]),
  );
  assert.deepEqual([...parsed.inverters.keys()], ['703000012345', 'a00000000001']);
  assert.equal(parsed.inverters.get('a00000000001').channels, 0);
  assert.equal(parsed.truncated, true);
});

test('ids from the network never pollute a prototype', () => {
  // "__proto__" is not 12 hex digits: no id can be one; they live in a Map anyway.
  const parsed = parseInverterFrame(inverterFrame([{ uid: '5f5f70726f74' }]));
  assert.equal(Object.prototype.polluted, undefined);
  assert.ok(parsed.inverters.has('5f5f70726f74'));
  assert.throws(() => inverterQuery('__proto__xx'), /invalid ECU id/);
  assert.throws(() => inverterQuery('216300012345END\nAPS'), /invalid ECU id/);
  assert.equal(inverterQuery('216300012345'), 'APS1100280002216300012345END\n');
  assert.equal(ECU_QUERY, 'APS1100160001END\n');
});

test('the frame reader: chunks, early refusal of garbage, bounded size', () => {
  const whole = ecuFrame();
  const reader = new FrameReader();
  assert.equal(reader.push(whole.subarray(0, 5)), undefined);
  assert.equal(reader.push(whole.subarray(5, 40)), undefined);
  assert.deepEqual(reader.push(Buffer.concat([whole.subarray(40), Buffer.from('xx')])), whole);
  assert.throws(
    () => new FrameReader().push(Buffer.from('HTTP/1.1 400 Bad')),
    /does not start with APS/,
  );
  assert.throws(() => new FrameReader().push(Buffer.from('APS11ab120001')), /not 4 digits/);
  assert.throws(
    () => new FrameReader().push(Buffer.from('APS1100050001')),
    /impossible frame length/,
  );
  const big = new FrameReader(100);
  assert.throws(() => big.push(Buffer.from('APS1199990001')), /impossible frame length/);
  const flood = new FrameReader(100);
  assert.throws(() => flood.push(Buffer.alloc(500, 0x41)), /longer than 100 bytes/);
});

/** A fake socket for tcpRequest: the test drives its events. */
function fakeSocket() {
  const socket = new EventEmitter();
  socket.written = [];
  socket.destroyed = false;
  socket.write = (data) => socket.written.push(data);
  socket.destroy = () => {
    socket.destroyed = true;
  };
  return socket;
}

test('one query per connection: written on connect, whole frame, then closed', async () => {
  const socket = fakeSocket();
  const pending = tcpRequest({
    host: '192.168.1.60',
    port: 8899,
    payload: ECU_QUERY,
    connect: (options) => {
      assert.deepEqual(options, { host: '192.168.1.60', port: 8899 });
      return socket;
    },
  });
  socket.emit('connect');
  assert.deepEqual(socket.written, [ECU_QUERY]);
  const whole = ecuFrame();
  socket.emit('data', whole.subarray(0, 20));
  socket.emit('data', whole.subarray(20));
  assert.deepEqual(await pending, whole);
  assert.equal(socket.destroyed, true);
});

test('a query fails cleanly: refused, closed early, garbage, silence', async () => {
  const run = (drive, timeout = 1000) => {
    const socket = fakeSocket();
    const pending = tcpRequest({
      host: 'h',
      port: 1,
      payload: 'x',
      timeout,
      connect: () => socket,
    });
    drive(socket);
    return pending;
  };
  await assert.rejects(
    run((s) => s.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))),
    (err) => err.code === 'network' && err.message === 'ECONNREFUSED' && err.silent,
  );
  await assert.rejects(
    run((s) => {
      s.emit('data', ecuFrame().subarray(0, 30));
      s.emit('close');
    }),
    (err) => err.code === 'network' && /closed the connection/.test(err.message),
  );
  await assert.rejects(
    run((s) => s.emit('data', Buffer.from('<html>hello</html>'))),
    (err) => err.code === 'protocol' && !err.silent,
  );
  await assert.rejects(
    run(() => {}, 20),
    (err) => err.code === 'timeout',
  );
});

test('the queue: one query at a time for every ECU, a pause between two', async () => {
  const slept = [];
  const queue = new EcuQueue({ pause: 5000, sleep: async (ms) => slept.push(ms) });
  let active = 0;
  let max = 0;
  const job = async () => {
    active += 1;
    max = Math.max(max, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
  };
  await Promise.all([
    queue.run(job),
    queue.run(job),
    queue.run(() => Promise.reject(new Error('x'))).catch(() => {}),
    queue.run(job),
  ]);
  assert.equal(max, 1);
  assert.ok(slept.length >= 3, 'a pause between every two queries, a failed one included');
  assert.ok(slept.every((ms) => ms === 5000));
});

test('the client: a refused connection is tried again, the inverters failing keep the ECU', async () => {
  const calls = [];
  let refusals = 1;
  const client = new EcuClient({
    host: '192.168.1.60',
    port: 8899,
    queue: new EcuQueue({ pause: 0 }),
    request: async ({ payload }) => {
      calls.push(payload);
      if (refusals > 0) {
        refusals -= 1;
        throw Object.assign(new EcuError('network', 'ECONNREFUSED'), { connectFailed: true });
      }
      if (payload === ECU_QUERY) {
        return ecuFrame();
      }
      throw new EcuError('timeout', 'no answer within 10 s');
    },
  });
  const result = await client.read();
  assert.equal(result.ecu.id, '216300012345');
  assert.equal(result.inverters, undefined);
  assert.equal(result.inverterError.code, 'timeout');
  assert.equal(
    calls.length,
    3,
    'ECU refused once then answered; the inverter query timed out once',
  );
  // A timeout is not retried: the ECU is busy, asking again would not help it.
  const silent = new EcuClient({
    host: 'h',
    port: 1,
    queue: new EcuQueue({ pause: 0 }),
    request: async () => {
      calls.push('t');
      throw new EcuError('timeout', 'slow');
    },
  });
  const before = calls.length;
  await assert.rejects(silent.read(), { code: 'timeout' });
  assert.equal(calls.length, before + 1);
});

test('the index guard: never 0, jumps and falls held, accepted only in their direction', () => {
  const limits = { maxKw: 2, slack: 0.5, minHours: 0 };
  const guard = new IndexGuard({ now: NOON });
  assert.equal(guard.accept(0, NOON, limits), false, 'never 0, first reading included');
  assert.equal(guard.accept(1000, NOON, limits), true);
  assert.equal(guard.accept(1001.5, NOON + HOUR, limits), true, '1.5 kWh in an hour with 2 kW');
  assert.equal(guard.accept(0, NOON + HOUR + 5 * 60_000, limits), false);
  // A jump: held, NOT confirmed by repetition nor by time.
  let t = NOON + 2 * HOUR;
  for (let i = 0; i < 10; i += 1) {
    assert.equal(guard.accept(20_000, t, limits), false, `repetition ${i}`);
    t += 5 * 60_000;
  }
  assert.equal(guard.accept(25_000, t + 1000 * HOUR, limits), false, 'above it, even much later');
  assert.deepEqual(
    [guard.held.direction, guard.held.from, guard.held.first],
    ['up', 1001.5, 20_000],
  );
  // A plausible value below the jump goes through and ends the hold.
  assert.equal(guard.accept(1002, t, limits), true);
  assert.equal(guard.held, undefined);
  // The jump again; the user accepts it: taken once.
  assert.equal(guard.accept(20_000, t + 60_000, limits), false);
  assert.equal(guard.acceptHeld(), true);
  assert.equal(guard.accept(20_001, t + 120_000, limits), true);
  assert.equal(guard.acceptHeld(), false, 'nothing held any more');
});

test('a fall 5000 -> 4000, then back to 5000.x: no fictitious kWh', () => {
  const limits = { maxKw: 2, slack: 0.5, minHours: 0 };
  const guard = new IndexGuard({ now: NOON });
  const published = [];
  const read = (value, at) => {
    if (guard.accept(value, at, limits)) {
      published.push(value);
    }
  };
  read(5000, NOON);
  for (let i = 1; i <= 12; i += 1) {
    read(4000, NOON + i * 5 * 60_000); // an hour of a low counter: still held
  }
  assert.equal(guard.held.direction, 'down');
  read(5000.4, NOON + 2 * HOUR);
  assert.deepEqual(published, [5000, 5000.4]);
  const counted = published.slice(1).reduce((sum, v, i) => sum + Math.max(0, v - published[i]), 0);
  assert.ok(Math.abs(counted - 0.4) < 1e-9, 'only the real 0.4 kWh');
  // Accepting a fall takes the next LOWER value only; a jump stays held.
  read(4000, NOON + 3 * HOUR);
  guard.acceptHeld();
  read(9000, NOON + 3 * HOUR + 60_000);
  assert.equal(published.at(-1), 5000.4, 'a jump is not taken by a fall accepted');
  assert.equal(guard.held.direction, 'up');
});

test('the margin: two intervals at least, a day for a reference without a date', () => {
  const limits = { maxKw: 2, slack: 0.5, minHours: (2 * 300) / 3600 };
  const guard = new IndexGuard({ known: { value: 1000, at: NOON }, now: NOON });
  // 0.8 kWh one second later: within 2 kW x 10 minutes + 0.5.
  assert.equal(guard.accept(1000.8, NOON + 1000, limits), true);
  const undated = new IndexGuard({ known: { value: 1000 }, now: NOON });
  assert.equal(undated.accept(1040, NOON, limits), true, 'a day of margin after a restart');
  const dated = new IndexGuard({ known: { value: 1000, at: NOON - 60_000 }, now: NOON });
  assert.equal(dated.accept(1040, NOON, limits), false, '40 kWh in a minute: held');
  // What /data kept wins over an older Gladys value, its hold included.
  const saved = { last: { value: 1100, at: NOON - 60_000 }, held: dated.state().held };
  const restored = new IndexGuard({ known: { value: 1000, at: NOON - HOUR }, saved, now: NOON });
  assert.equal(restored.last.value, 1100);
  assert.equal(restored.held.direction, 'up');
});

test('the configuration: ECU addresses on port 8899, an interval of 300 s at least', () => {
  const config = normalizeConfig({
    hosts: '192.168.1.50',
    ecu_hosts: '192.168.1.60, 192.168.1.61:9000, nope!, 192.168.1.60',
    ecu_poll_interval: 60,
  });
  assert.deepEqual(
    config.ecuHosts.map((h) => h.key),
    ['192.168.1.60:8899', '192.168.1.61:9000'],
  );
  assert.deepEqual(config.invalidEcuHosts, [3]);
  assert.equal(config.ecuPollInterval, 300);
  assert.deepEqual(
    config.hosts.map((h) => h.key),
    ['192.168.1.50:8050'],
    'the EZ1 field is unchanged',
  );
  assert.equal(normalizeConfig({}).ecuPollInterval, 300);
  assert.deepEqual(normalizeConfig({}).ecuHosts, []);
  assert.equal(normalizeConfig({ ecu_poll_interval: 99999 }).ecuPollInterval, 3600);
});

test('the ECU devices: external ids, features, units the core accepts', () => {
  const gladys = createFakeGladys({ selector: 'apsystems' });
  const ecu = buildEcuDevice(gladys, {
    id: '216300012345',
    model: 'ECU-B',
    firmware: 'ECU_B_1.2.24',
    hostKey: '192.168.1.60:8899',
    inverters: 1,
  });
  assert.equal(ecu.external_id, 'ext:apsystems:ecu:216300012345');
  assert.equal(ecu.name, 'ECU-B 216300012345');
  assert.deepEqual(parseEcuExternalId(ecu.external_id), { ecuId: '216300012345' });
  assert.equal(parseExternalId(ecu.external_id), undefined, 'never taken for an EZ1');
  const keys = ecu.features.map((f) => f.external_id.split(':').at(-1));
  assert.deepEqual(keys, [
    'power',
    'energy_today',
    'energy_total',
    'energy_total_production',
    'inverters_online',
    'reachable',
  ]);
  const index = ecu.features[2];
  const thirty = ecu.features[3];
  assert.equal(index.id, uuidOf(index.external_id));
  assert.equal(thirty.energy_parent_id, index.id);
  assert.ok(ecu.features.every((f) => f.read_only));
  const ds3 = buildEcuInverterDevice(gladys, {
    uid: '703000012345',
    model: 'DS3',
    type: '01',
    channels: 2,
    phases: 1,
    ecuId: '216300012345',
  });
  assert.equal(ds3.external_id, 'ext:apsystems:ecu_inverter:703000012345');
  assert.deepEqual(parseEcuInverterExternalId(ds3.external_id), { uid: '703000012345' });
  assert.equal(parseExternalId(ds3.external_id), undefined, 'never taken for an EZ1');
  const byKey = Object.fromEntries(ds3.features.map((f) => [f.external_id.split(':').at(-1), f]));
  assert.deepEqual(Object.keys(byKey), [
    'online',
    'power',
    'power_1',
    'power_2',
    'voltage',
    'frequency',
    'temperature',
  ]);
  assert.deepEqual([byKey.voltage.category, byKey.voltage.unit], [C.ENERGY_SENSOR, U.VOLT]);
  assert.deepEqual(
    [byKey.temperature.category, byKey.temperature.unit],
    [C.DEVICE_TEMPERATURE_SENSOR, U.CELSIUS],
  );
  const qt2 = buildEcuInverterDevice(gladys, { uid: '901000000001', channels: 4, phases: 3 });
  assert.ok(
    ['voltage_1', 'voltage_2', 'voltage_3', 'power_4'].every((k) =>
      qt2.features.some((f) => f.external_id.endsWith(`:${k}`)),
    ),
  );
  const unknown = buildEcuInverterDevice(gladys, { uid: 'a00000000001', channels: 0 });
  assert.deepEqual(
    unknown.features.map((f) => f.external_id.split(':').at(-1)),
    [ECU_FEATURE.ONLINE],
  );
});

test('the ECU states: unreachable publishes reachable only; an offline inverter reads 0 W', () => {
  const id = 'ext:apsystems:ecu:216300012345';
  assert.deepEqual(ecuStates(id, { reachable: false, power: 100 }), [
    { device_feature_external_id: `${id}:reachable`, state: 0 },
  ]);
  assert.deepEqual(
    ecuStates(id, { reachable: true, power: 250, energyToday: 3.21, online: 1 }).map((s) => [
      s.device_feature_external_id.split(':').at(-1),
      s.state,
    ]),
    [
      ['reachable', 1],
      ['power', 250],
      ['energy_today', 3.21],
      ['inverters_online', 1],
    ],
  );
  const micro = 'ext:apsystems:ecu_inverter:703000012345';
  const night = ecuInverterStates(micro, {
    online: false,
    channels: 2,
    phases: 1,
    power: [3, 4],
    voltage: [0],
    frequency: 0,
    temperature: null,
  });
  assert.deepEqual(
    night.map((s) => [s.device_feature_external_id.split(':').at(-1), s.state]),
    [
      ['online', 0],
      ['power', 0],
      ['power_1', 0],
      ['power_2', 0],
    ],
  );
});

test('a republished device keeps every feature of the created one', () => {
  const gladys = createFakeGladys({ selector: 'apsystems' });
  const built = buildEcuInverterDevice(gladys, { uid: '703000012345', channels: 0 });
  const created = buildEcuInverterDevice(gladys, { uid: '703000012345', channels: 2, phases: 1 });
  created.features = created.features.map((f) => ({ ...f, last_value: 1, device_id: 'x' }));
  const merged = keepCreatedFeatures(built, created);
  assert.deepEqual(
    merged.features.map((f) => f.external_id),
    [built.features[0].external_id, ...created.features.slice(1).map((f) => f.external_id)],
  );
  assert.ok(merged.features.every((f) => f.last_value === undefined && f.device_id === undefined));
  assert.equal(keepCreatedFeatures(built, undefined), built);
  assert.equal(ECU.PORT, 8899);
});
