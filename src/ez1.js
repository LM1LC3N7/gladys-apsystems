// -----------------------------------------------------------------------------
// The EZ1 local API client (APsystems "EZ1 Local API User Manual" v1.1,
// 2023-11-07): plain GETs on http://<ip>:8050/<endpoint>, every answer
// { data: {...}, message: "SUCCESS" | "FAILED", deviceId }.
//
// Every endpoint name lives here, and every field name in src/model.js, so
// a firmware change reported by a user is fixed in one place:
//   getDeviceInfo   deviceId, devVer, ssid, ipAddr, minPower, maxPower
//   getOutputData   p1 e1 te1 p2 e2 te2 (W, kWh since start-up, kWh lifetime)
//   getMaxPower     maxPower ("power" on the 2.x "_b" firmware)
//   setMaxPower?p=  the new limit, in W
//   getAlarm        og, isce1, isce2, oe ("0" normal, "1" alarm)
//   getOnOff        status "0" = on, "1" = off (inverted: it is an alarm flag)
//   setOnOff?status=
// The EZ1-D answers getDefaultMaxPower / setDefaultMaxPower instead of the
// MaxPower pair (a user report, see TODO.md): `variant` picks the pair.
//
// The EZ1 serves one request at a time, slowly: the client queues them.
// -----------------------------------------------------------------------------

import { HTTP_TIMEOUT } from './constants.js';
import { Ez1Error, getJson } from './http.js';

/** The two names of the power limit endpoints. */
export const LIMIT_VARIANTS = { STANDARD: 'MaxPower', EZ1D: 'DefaultMaxPower' };

export class Ez1Client {
  constructor({ host, port, timeout = HTTP_TIMEOUT }) {
    this.base = `http://${host}:${port}`;
    this.timeout = timeout;
    this.tail = Promise.resolve();
  }

  /** Run `fn` once every request queued before it has finished. */
  serial(fn) {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => {});
    return run;
  }

  /**
   * One endpoint; resolves { data, deviceId }. A "FAILED" answer of a read is
   * retried once (the EZ1 sometimes fails for no reason, the Python library
   * retries too); a write is never retried.
   */
  call(endpoint, { retry = 1 } = {}) {
    return this.serial(async () => {
      for (let attempt = 0; ; attempt += 1) {
        const body = await getJson(`${this.base}/${endpoint}`, { timeout: this.timeout });
        if (!body || typeof body !== 'object' || typeof body.message !== 'string') {
          throw new Ez1Error('protocol', `${endpoint} answered without a message`);
        }
        if (body.message === 'SUCCESS' && body.data && typeof body.data === 'object') {
          return { data: body.data, deviceId: body.deviceId ? String(body.deviceId) : null };
        }
        if (attempt >= retry) {
          throw new Ez1Error('failed', `${endpoint.split('?')[0]} answered ${body.message}`);
        }
      }
    });
  }

  deviceInfo() {
    return this.call('getDeviceInfo');
  }

  outputData() {
    return this.call('getOutputData');
  }

  alarm() {
    return this.call('getAlarm');
  }

  onOff() {
    return this.call('getOnOff');
  }

  /** On: status 0, off: status 1 (the API's own inverted convention). */
  setOnOff(on) {
    return this.call(`setOnOff?status=${on ? 0 : 1}`, { retry: 0 });
  }

  maxPower(variant = LIMIT_VARIANTS.STANDARD) {
    return this.call(`get${variant}`);
  }

  setMaxPower(watts, variant = LIMIT_VARIANTS.STANDARD) {
    return this.call(`set${variant}?p=${Math.round(watts)}`, { retry: 0 });
  }
}
