// -----------------------------------------------------------------------------
// The APsystems ECU local protocol (ECU-B, ECU-R, ECU-C), TCP port 8899.
// Pure: frames in, plain objects out. Ported to JavaScript from
// HAEdwin/homeassistant-apsystems_ecu_reader 2.15.0 (ecu_api.py,
// ecu_helpers.py, const.py) and its source ksheumaker/homeassistant-
// apsystems_ecur (APSystemsSocket.py), both Apache-2.0: see
// THIRD_PARTY_NOTICES.md.
//
// A query is one ASCII line, an answer one binary frame:
//   "APS" "11" LLLL CCCC <payload> "END" <one byte>
// LLLL is the frame length minus one, in 4 ASCII digits (the reference calls
// it the checksum); CCCC the command (0001 the ECU, 0002 the inverters).
// Numbers are big-endian unsigned integers.
//
//   ECU query        APS1100160001END\n
//   inverter query   APS1100280002<ECU id>END\n
//
// Every offset below is the reference's. Every read is checked against the
// frame length: a short or garbled frame is an EcuError('protocol'), never a
// read past the end. The inverter ids come from the network: they are
// validated (12 hexadecimal digits) and kept in a Map, never as object keys.
// The signal-strength query (0030) of the reference is not sent: it is one
// more connection to an ECU known to hang, for a value not exposed here.
// -----------------------------------------------------------------------------

export class EcuError extends Error {
  /**
   * `code`: timeout (no answer in time), network (refused, unreachable,
   * closed early), protocol (not an ECU frame, or a frame that does not
   * hold together).
   */
  constructor(code, message) {
    super(message);
    this.name = 'EcuError';
    this.code = code;
  }

  /** Nobody answered (as opposed to an answer that makes no sense). */
  get silent() {
    return this.code === 'timeout' || this.code === 'network';
  }
}

/** The largest frame LLLL can describe: 9999 + the last byte. */
export const MAX_FRAME = 10_000;
/** The smallest frame: "APS" "11" LLLL CCCC "END" + one byte. */
const MIN_FRAME = 17;

export const ECU_QUERY = 'APS1100160001END\n';

/** An ECU id as the frame carries it: 12 ASCII letters or digits. */
export const isEcuId = (id) => /^[0-9A-Za-z]{12}$/.test(String(id ?? ''));
/** A micro-inverter id: 6 bytes written as 12 hexadecimal digits. */
export const isInverterUid = (uid) => /^[0-9a-f]{12}$/.test(String(uid ?? ''));

export function inverterQuery(ecuId) {
  if (!isEcuId(ecuId)) {
    throw new EcuError('protocol', 'invalid ECU id');
  }
  return `APS1100280002${ecuId}END\n`;
}

/** ECU models by the first 4 digits of the ECU id (const.py). */
export const ECU_MODELS = {
  2160: 'ECU-R',
  2162: 'ECU-R-Pro',
  2163: 'ECU-B',
  2150: 'ECU-C',
  2030: 'ECU-3',
};

/** Micro-inverter series by the first 2 digits of their id (const.py). */
export const INVERTER_MODELS = {
  10: 'YC500',
  40: 'YC600',
  50: 'YC1000',
  70: 'DS3',
  80: 'QS1',
  90: 'QT2',
};

/** Three-phase series: one voltage per phase (sensor.py). */
const THREE_PHASE = new Set(['50', '90']);

/** A table lookup by a prefix that came from the network: own keys only. */
const lookup = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

export const ecuModelOf = (ecuId) => lookup(ECU_MODELS, String(ecuId).slice(0, 4)) ?? 'ECU';

/**
 * Accumulates the bytes of one answer and resolves the frame once it is
 * whole. Bounded: never holds more than `max` bytes, and checks the header
 * as soon as it has arrived, so garbage is refused early.
 */
export class FrameReader {
  constructor(max = MAX_FRAME) {
    this.max = max;
    this.chunks = [];
    this.size = 0;
    this.expected = undefined;
  }

  /** Add a chunk; resolves the frame (a Buffer) when complete, else undefined. */
  push(chunk) {
    this.size += chunk.length;
    if (this.size > this.max + 64) {
      // A little slack for bytes after the frame; never unbounded.
      throw new EcuError('protocol', `answer longer than ${this.max} bytes`);
    }
    this.chunks.push(chunk);
    const buffer = Buffer.concat(this.chunks, this.size);
    this.chunks = [buffer];
    if (this.expected === undefined && buffer.length >= 9) {
      if (buffer.toString('latin1', 0, 3) !== 'APS') {
        throw new EcuError('protocol', 'the answer does not start with APS: is this an ECU?');
      }
      const length = buffer.toString('latin1', 5, 9);
      if (!/^\d{4}$/.test(length)) {
        throw new EcuError('protocol', 'the frame length is not 4 digits');
      }
      this.expected = Number(length) + 1;
      if (this.expected < MIN_FRAME || this.expected > this.max) {
        throw new EcuError('protocol', `impossible frame length ${this.expected}`);
      }
    }
    if (this.expected === undefined || buffer.length < this.expected) {
      return undefined;
    }
    return checkFrame(buffer.subarray(0, this.expected));
  }
}

/** The checks of validate_data: length, start and end signatures. */
export function checkFrame(frame) {
  if (!Buffer.isBuffer(frame) || frame.length < MIN_FRAME) {
    throw new EcuError('protocol', 'frame too short');
  }
  const length = frame.toString('latin1', 5, 9);
  if (!/^\d{4}$/.test(length) || Number(length) !== frame.length - 1) {
    throw new EcuError('protocol', `length check failed (${length} for ${frame.length - 1})`);
  }
  if (
    frame.toString('latin1', 0, 3) !== 'APS' ||
    frame.toString('latin1', frame.length - 4, frame.length - 1) !== 'END'
  ) {
    throw new EcuError('protocol', 'signature check failed (APS ... END)');
  }
  return frame;
}

/** Bounded readers over a frame: the payload ends where "END" starts. */
function reader(frame) {
  const end = frame.length - 4;
  const need = (start, length) => {
    if (start < 0 || length < 0 || start + length > end) {
      throw new EcuError('protocol', `field at ${start} (+${length}) past the end (${end})`);
    }
  };
  return {
    end,
    str(start, length) {
      need(start, length);
      return frame.toString('latin1', start, start + length);
    },
    int(start, length) {
      need(start, length);
      return frame.readUIntBE(start, length);
    },
    hex(start, length) {
      need(start, length);
      return frame.toString('hex', start, start + length);
    },
    byte(start) {
      need(start, 1);
      return frame[start];
    },
  };
}

const command = (frame) => frame.toString('latin1', 9, 13);

/**
 * The ECU frame (process_ecu_data): its id, the lifetime energy (kWh, 0.1),
 * the current power (W), the energy of the day (kWh, 0.01), the inverters
 * known and online, the firmware. Two layouts, "01" and "02" at offset 25;
 * another layout keeps the three energy figures only.
 */
export function parseEcuFrame(frame) {
  checkFrame(frame);
  if (command(frame) !== '0001') {
    throw new EcuError('protocol', `expected an ECU frame (0001), got ${command(frame)}`);
  }
  const r = reader(frame);
  const id = r.str(13, 12);
  if (!isEcuId(id)) {
    throw new EcuError('protocol', 'the ECU frame carries no valid ECU id');
  }
  const ecu = {
    id,
    model: ecuModelOf(id),
    lifetimeEnergy: r.int(27, 4) / 10,
    currentPower: r.int(31, 4),
    todayEnergy: r.int(35, 4) / 100,
    inverters: null,
    online: null,
    firmware: null,
    timezone: null,
  };
  const layout = r.str(25, 2);
  const digits = (start) => {
    const text = r.str(start, 3);
    if (!/^\d{3}$/.test(text)) {
      throw new EcuError('protocol', `expected 3 digits at ${start}`);
    }
    return Number(text);
  };
  if (layout === '01') {
    ecu.inverters = r.int(46, 2);
    ecu.online = r.int(48, 2);
    const vsl = digits(52);
    ecu.firmware = r.str(55, vsl);
    const tsl = digits(55 + vsl);
    ecu.timezone = r.str(58 + vsl, tsl);
  } else if (layout === '02') {
    ecu.inverters = r.int(39, 2);
    ecu.online = r.int(41, 2);
    ecu.firmware = r.str(52, digits(49));
  }
  ecu.firmware = clean(ecu.firmware);
  ecu.timezone = clean(ecu.timezone);
  return ecu;
}

/** Printable ASCII only, trimmed and bounded (it ends up in device params). */
function clean(text) {
  if (text === null || text === undefined) {
    return null;
  }
  const printable = String(text)
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
    .slice(0, 40);
  return printable || null;
}

/**
 * The inverter frame (process_inverter_data): the time of the ECU's last
 * collection and, per inverter, its id, online flag and type, then by type:
 *   01 (YC600/DS3), 04 (DS3-L/DS3-H): 2 channels, 21 bytes
 *   02 (YC1000), 05 (QT2):            4 channels, 3 voltages, 27 bytes
 *   03 (QS1):                         4 channels, 1 voltage, 23 bytes
 * frequency (Hz, 0.1) at +9, temperature (°C, +100) at +11, then the power
 * (W) of each channel and the AC voltages (V). An unknown type takes 9
 * bytes in the reference; here the reading stops there instead: the next
 * offsets would be guesses, and a guess would invent inverters.
 * Resolves { timestamp, inverters: Map(uid -> inverter), truncated }.
 */
export function parseInverterFrame(frame) {
  checkFrame(frame);
  if (command(frame) !== '0002') {
    throw new EcuError('protocol', `expected an inverter frame (0002), got ${command(frame)}`);
  }
  const r = reader(frame);
  const inverters = new Map();
  if (r.str(14, 2) !== '00' || r.str(15, 2) !== '01') {
    // The ECU has no inverter data to give (none paired yet).
    return { timestamp: null, inverters, truncated: false };
  }
  const count = r.int(17, 2);
  const stamp = r.hex(19, 7);
  const timestamp = /^\d{14}$/.test(stamp)
    ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}`
    : null;
  let at = 26;
  let truncated = false;
  for (let i = 0; i < count; i += 1) {
    const uid = r.hex(at, 6);
    if (!isInverterUid(uid)) {
      throw new EcuError('protocol', 'invalid inverter id');
    }
    const online = r.byte(at + 6) !== 0;
    const type = r.str(at + 7, 2);
    const inverter = {
      uid,
      online,
      type,
      model: lookup(INVERTER_MODELS, uid.slice(0, 2)) ?? null,
      channels: 0,
      phases: 1,
      frequency: null,
      temperature: null,
      power: [],
      voltage: [],
    };
    const common = () => {
      inverter.frequency = r.int(at + 9, 2) / 10;
      // The reference reads the temperature only while online.
      inverter.temperature = online ? r.int(at + 11, 2) - 100 : null;
    };
    if (type === '01' || type === '04') {
      common();
      inverter.channels = 2;
      inverter.power = [r.int(at + 13, 2), r.int(at + 17, 2)];
      inverter.voltage = [r.int(at + 15, 2)];
      at += 21;
    } else if (type === '02' || type === '05') {
      common();
      inverter.channels = 4;
      inverter.power = [13, 17, 21, 25].map((o) => r.int(at + o, 2));
      const voltages = [15, 19, 23].map((o) => r.int(at + o, 2));
      if (THREE_PHASE.has(uid.slice(0, 2))) {
        inverter.phases = 3;
        inverter.voltage = voltages;
      } else {
        inverter.voltage = voltages.slice(0, 1);
      }
      at += 27;
    } else if (type === '03') {
      common();
      inverter.channels = 4;
      inverter.power = [13, 17, 19, 21].map((o) => r.int(at + o, 2));
      inverter.voltage = [r.int(at + 15, 2)];
      at += 23;
    } else {
      inverters.set(uid, inverter);
      truncated = i < count - 1;
      break;
    }
    inverters.set(uid, inverter);
  }
  return { timestamp, inverters, truncated };
}
