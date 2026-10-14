// -----------------------------------------------------------------------------
// A fake EZ1 local API behind `fetch`: one simulated inverter per "ip:port",
// built from the fixtures (shaped after the APsystems manual and the answers
// users posted), with the firmware variants the integration must survive:
//   standard   getMaxPower { maxPower }, getOnOff
//   b          the 2.x "_b" firmware: getMaxPower { power }, no getOnOff (404)
//   ez1d       getDefaultMaxPower / setDefaultMaxPower instead of MaxPower
// A sleeping inverter (`asleep: true`) does not answer at all, like an EZ1
// at night. Every call is recorded. No test touches the network.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { setFetch } from '../../src/http.js';

setFetch(async (url) => {
  throw new Error(`Network call without a fake fetch in a test: ${url}`);
});

export function fixture(name) {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// What the "_b" firmware answers for a missing endpoint (Home Assistant issue 136288).
const notFound = () =>
  new Response('<html><body>404 Not Found</body></html>', {
    status: 404,
    headers: { 'content-type': 'text/html' },
  });

const INFO = {
  standard: 'device-info.json',
  b: 'device-info-2.0.1_b.json',
  ez1d: 'device-info-ez1d.json',
};

/** A simulated inverter; `overrides` replace any field. */
export function fakeInverter(overrides = {}) {
  const firmware = overrides.firmware ?? 'standard';
  const info = fixture(INFO[firmware]).data;
  return {
    firmware,
    info,
    output: { ...fixture('output-data.json').data },
    limit: Number(
      firmware === 'standard'
        ? fixture('max-power.json').data.maxPower
        : fixture(firmware === 'b' ? 'max-power-2.0.1_b.json' : 'default-max-power-ez1d.json').data
            .power,
    ),
    alarms: { ...fixture('alarm.json').data },
    on: fixture('on-off.json').data.status === '0',
    asleep: false,
    /** Answer "FAILED" to the next N calls. */
    failNext: 0,
    /** Answer as this other device id (a DHCP swap). */
    answerAs: undefined,
    ...overrides,
  };
}

/** Install the fake inverters: { "192.168.1.50:8050": fakeInverter(), ... }. */
export function installInverters(inverters) {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const previous = setFetch(async (url) => {
    const u = new URL(url);
    const call = {
      host: u.host,
      endpoint: u.pathname.slice(1),
      params: Object.fromEntries(u.searchParams),
    };
    calls.push(call);
    const inv = inverters[u.host];
    if (!inv || inv.asleep) {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'EHOSTUNREACH' } });
    }
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    const deviceId = inv.answerAs ?? inv.info.deviceId;
    const ok = (data) => json({ data, message: 'SUCCESS', deviceId });
    if (inv.failNext > 0) {
      inv.failNext -= 1;
      return json(fixture('failed.json'));
    }
    const limitPair = inv.firmware === 'ez1d' ? 'DefaultMaxPower' : 'MaxPower';
    const limitData = () =>
      inv.firmware === 'standard' ? { maxPower: String(inv.limit) } : { power: String(inv.limit) };
    switch (call.endpoint) {
      case 'getDeviceInfo':
        return ok({ ...inv.info, deviceId });
      case 'getOutputData':
        return ok(inv.output);
      case 'getAlarm':
        return ok(inv.alarms);
      case 'getOnOff':
        return inv.firmware === 'b' ? notFound() : ok({ status: inv.on ? '0' : '1' });
      case 'setOnOff':
        if (inv.firmware === 'b') {
          return notFound();
        }
        inv.on = call.params.status === '0';
        return ok({ status: inv.on ? '0' : '1' });
      case `get${limitPair}`:
        return ok(limitData());
      case `set${limitPair}`: {
        const p = Number(call.params.p);
        if (!(p >= Number(inv.info.minPower) && p <= Number(inv.info.maxPower))) {
          return json({ data: limitData(), message: 'FAILED', deviceId });
        }
        inv.limit = p;
        return ok(limitData());
      }
      default:
        return notFound();
    }
  });
  return {
    calls,
    get maxActive() {
      return maxActive;
    },
    /** The calls to one endpoint ("getOutputData"), optionally of one host. */
    count: (endpoint, host) =>
      calls.filter((c) => c.endpoint === endpoint && (!host || c.host === host)).length,
    restore: () => setFetch(previous),
  };
}
