// -----------------------------------------------------------------------------
// Fake APsystems ECUs: binary frames built at the offsets of the reference
// (HAEdwin/homeassistant-apsystems_ecu_reader 2.15.0, ecu_api.py), and a
// fake transport that answers the two queries per "ip:port". No socket.
// -----------------------------------------------------------------------------

import { EcuError } from '../../src/ecu-protocol.js';

const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const ascii = (s) => Buffer.from(s, 'latin1');

/** "APS" "11" LLLL CCCC <payload from offset 13> "END\n", LLLL = length - 1. */
export function frame(command, payload, { badLength = false, end = 'END\n' } = {}) {
  const buffer = Buffer.concat([ascii('APS110000'), ascii(command), payload, ascii(end)]);
  const length = badLength ? buffer.length + 3 : buffer.length - 1;
  buffer.write(String(length).padStart(4, '0'), 5, 'latin1');
  return buffer;
}

/** The ECU frame (0001), layout "01" (ECU-R, ECU-B) or "02". */
export function ecuFrame({
  id = '216300012345',
  layout = '01',
  lifetime = 1234.5,
  power = 456,
  today = 3.21,
  inverters = 1,
  online = 1,
  firmware = 'ECU_B_1.2.24',
  timezone = 'Europe/Paris',
} = {}) {
  const head = Buffer.concat([
    ascii(id),
    ascii(layout),
    u32(Math.round(lifetime * 10)),
    u32(power),
    u32(Math.round(today * 100)),
  ]);
  const version = ascii(`${String(firmware.length).padStart(3, '0')}${firmware}`);
  const tail =
    layout === '01'
      ? Buffer.concat([
          Buffer.alloc(7),
          u16(inverters),
          u16(online),
          Buffer.alloc(2),
          version,
          ascii(`${String(timezone.length).padStart(3, '0')}${timezone}`),
        ])
      : layout === '02'
        ? Buffer.concat([u16(inverters), u16(online), Buffer.alloc(6), version])
        : Buffer.alloc(20);
  return frame('0001', Buffer.concat([head, tail]));
}

/**
 * One inverter entry. `type` 01/04: 2 channels; 02/05: 4 channels and 3
 * voltages; 03: 4 channels and 1 voltage; anything else: id, online, type.
 */
export function inverterEntry({
  uid = '703000012345',
  online = true,
  type = '01',
  frequency = 50.1,
  temperature = 35,
  power = [120, 130],
  voltage = [231, 0, 0],
}) {
  const head = Buffer.concat([Buffer.from(uid, 'hex'), Buffer.from([online ? 1 : 0]), ascii(type)]);
  const common = [u16(Math.round(frequency * 10)), u16(temperature + 100)];
  const p = (i) => u16(power[i] ?? 0);
  const v = (i) => u16(voltage[i] ?? 0);
  if (type === '01' || type === '04') {
    return Buffer.concat([head, ...common, p(0), v(0), p(1), v(0)]);
  }
  if (type === '02' || type === '05') {
    return Buffer.concat([head, ...common, p(0), v(0), p(1), v(1), p(2), v(2), p(3)]);
  }
  if (type === '03') {
    return Buffer.concat([head, ...common, p(0), v(0), p(1), p(2), p(3)]);
  }
  return head;
}

/** The inverter frame (0002): status "0001", count, BCD time, entries. */
export function inverterFrame(entries, { count = entries.length, empty = false } = {}) {
  const status = empty ? ascii('0000') : ascii('0001');
  const time = Buffer.from('20260615120000', 'hex');
  return frame(
    '0002',
    Buffer.concat([status, u16(count), time, ...entries.map((e) => inverterEntry(e))]),
  );
}

/** A simulated ECU; `overrides` replace any field. */
export function fakeEcu(overrides = {}) {
  return {
    id: '216300012345',
    layout: '01',
    lifetime: 1234.5,
    power: 250,
    today: 3.21,
    firmware: 'ECU_B_1.2.24',
    inverters: [
      { uid: '703000012345', online: true, type: '01', power: [120, 130], voltage: [231] },
    ],
    /** Nobody answers (a hung ECU, a wrong address). */
    down: false,
    /** The inverter query fails (the ECU answers its own frame). */
    inverterFails: false,
    ...overrides,
  };
}

/** The fake transport: { "192.168.1.60:8899": fakeEcu(), ... }; every query is recorded. */
export function installEcus(ecus) {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const request = async ({ host, port, payload }) => {
    const key = `${host}:${port}`;
    calls.push({ key, payload });
    const ecu = ecus[key];
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    if (!ecu || ecu.down) {
      throw Object.assign(new EcuError('network', 'ECONNREFUSED'), { connectFailed: true });
    }
    if (payload === 'APS1100160001END\n') {
      const online = ecu.inverters.filter((i) => i.online).length;
      return ecuFrame({
        id: ecu.id,
        layout: ecu.layout,
        lifetime: ecu.lifetime,
        power: ecu.power,
        today: ecu.today,
        inverters: ecu.inverters.length,
        online,
        firmware: ecu.firmware,
      });
    }
    if (payload === `APS1100280002${ecu.id}END\n`) {
      if (ecu.inverterFails) {
        throw new EcuError('timeout', 'no answer within 10 s');
      }
      return inverterFrame(ecu.inverters);
    }
    throw new EcuError('timeout', `unexpected query ${payload.trim()}`);
  };
  return {
    request,
    calls,
    get maxActive() {
      return maxActive;
    },
    count: (key) => calls.filter((c) => !key || c.key === key).length,
  };
}
