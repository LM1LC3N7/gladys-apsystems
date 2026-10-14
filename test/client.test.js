// -----------------------------------------------------------------------------
// The EZ1 client and the HTTP layer: one request at a time, the "FAILED"
// answers, the firmware without an endpoint, the silence of the night.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Ez1Client, LIMIT_VARIANTS } from '../src/ez1.js';
import { Ez1Error, setFetch } from '../src/http.js';
import { fakeInverter, installInverters } from './helpers/fakeEz1.js';

let fake;
afterEach(() => fake?.restore());

const HOST = '192.168.1.50:8050';
const client = () => new Ez1Client({ host: '192.168.1.50', port: 8050 });

test('requests to one inverter never overlap', async () => {
  fake = installInverters({ [HOST]: fakeInverter() });
  const ez1 = client();
  const answers = await Promise.all([ez1.deviceInfo(), ez1.outputData(), ez1.alarm(), ez1.onOff()]);
  assert.equal(fake.maxActive, 1);
  assert.deepEqual(
    fake.calls.map((c) => c.endpoint),
    ['getDeviceInfo', 'getOutputData', 'getAlarm', 'getOnOff'],
  );
  assert.equal(answers[0].deviceId, 'E07000000001');
  assert.equal(answers[1].data.p2, 160);
});

test('a FAILED read is retried once, a FAILED write is not', async () => {
  const inverter = fakeInverter({ failNext: 1 });
  fake = installInverters({ [HOST]: inverter });
  const ez1 = client();
  assert.equal((await ez1.outputData()).data.p1, 152.4);
  assert.equal(fake.count('getOutputData'), 2);
  inverter.failNext = 2;
  await assert.rejects(ez1.alarm(), (err) => err.code === 'failed' && !err.silent);
  // Out of the bounds: the EZ1 answers FAILED, the client does not insist.
  await assert.rejects(ez1.setMaxPower(900), /setMaxPower answered FAILED/);
  assert.equal(fake.count('setMaxPower'), 1);
  assert.deepEqual(fake.calls.at(-1).params, { p: '900' });
});

test('a missing endpoint, a stranger and the night', async () => {
  fake = installInverters({ [HOST]: fakeInverter({ firmware: 'b' }) });
  await assert.rejects(client().onOff(), (err) => err.code === 'unsupported' && err.status === 404);
  await assert.rejects(
    client().maxPower(LIMIT_VARIANTS.EZ1D),
    (err) => err instanceof Ez1Error && err.code === 'unsupported',
  );
  fake.restore();
  fake = installInverters({ [HOST]: fakeInverter({ asleep: true }) });
  await assert.rejects(
    client().outputData(),
    (err) => err.silent && /EHOSTUNREACH/.test(err.message),
  );
  fake.restore();
  // A web page at the address (a router, a printer): not an EZ1.
  const previous = setFetch(async () => new Response('<html></html>', { status: 200 }));
  fake = { restore: () => setFetch(previous) };
  await assert.rejects(client().deviceInfo(), (err) => err.code === 'protocol');
  setFetch(async () => new Response(JSON.stringify({ hello: 1 }), { status: 200 }));
  await assert.rejects(client().deviceInfo(), (err) => err.code === 'protocol');
  setFetch(async () => {
    throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
  });
  await assert.rejects(client().deviceInfo(), (err) => err.code === 'timeout' && err.silent);
});

test('on/off speaks the inverted API: status 0 is on', async () => {
  const inverter = fakeInverter();
  fake = installInverters({ [HOST]: inverter });
  const ez1 = client();
  await ez1.setOnOff(false);
  assert.deepEqual(fake.calls.at(-1).params, { status: '1' });
  assert.equal(inverter.on, false);
  await ez1.setOnOff(true);
  assert.deepEqual(fake.calls.at(-1).params, { status: '0' });
});
