// -----------------------------------------------------------------------------
// Modified port of HAEdwin/homeassistant-apsystems_ecu_reader 2.15.0
// (ecu_api.py: open_socket, send_read_from_socket, get_update) and
// ksheumaker/homeassistant-apsystems_ecur (APSystemsSocket.py), Apache-2.0:
// see THIRD_PARTY_NOTICES.md.
//
// The ECU client: TCP port 8899 on the LAN, one connection per query (the
// ECU-R-Pro needs a fresh connection for each one, the reference does it for
// every model), ONE connection at a time for all the ECUs together (the
// reference's global lock), and a pause between two queries (the ECU is
// known to hang when asked too often or too fast). The tests replace the
// transport; nothing else opens a socket.
// -----------------------------------------------------------------------------

import net from 'node:net';
import { ECU } from './constants.js';
import {
  ECU_QUERY,
  EcuError,
  FrameReader,
  MAX_FRAME,
  inverterQuery,
  parseEcuFrame,
  parseInverterFrame,
} from './ecu-protocol.js';

/**
 * One query on its own connection: connect, write the line, read one whole
 * frame (bounded), close. Resolves the frame (a Buffer).
 */
/** A connection that could not be opened (refused, unreachable): safe to try again. */
function connectError(err) {
  const error = new EcuError('network', err?.code ?? err?.message ?? String(err));
  error.connectFailed = true;
  return error;
}

export function tcpRequest({
  host,
  port,
  payload,
  timeout = ECU.TIMEOUT,
  maxBytes = MAX_FRAME,
  connect = (options) => net.connect(options),
}) {
  return new Promise((resolve, reject) => {
    const frames = new FrameReader(maxBytes);
    let settled = false;
    let connected = false;
    let socket;
    const finish = (err, frame) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      if (err) {
        reject(err);
      } else {
        resolve(frame);
      }
    };
    const timer = setTimeout(
      () => finish(new EcuError('timeout', `no answer within ${Math.round(timeout / 1000)} s`)),
      Math.max(1, timeout),
    );
    try {
      socket = connect({ host, port });
    } catch (err) {
      finish(connectError(err));
      return;
    }
    socket.on('connect', () => {
      connected = true;
      socket.write(payload);
    });
    socket.on('data', (chunk) => {
      try {
        const frame = frames.push(chunk);
        if (frame) {
          finish(null, frame);
        }
      } catch (err) {
        finish(err);
      }
    });
    socket.on('error', (err) =>
      finish(
        connected
          ? new EcuError('network', err?.code ?? err?.message ?? String(err))
          : connectError(err),
      ),
    );
    socket.on('close', () =>
      finish(new EcuError('network', 'the ECU closed the connection before a whole answer')),
    );
  });
}

/**
 * Runs the queries one after the other, for every ECU, with `pause`
 * milliseconds between the end of one and the start of the next.
 */
export class EcuQueue {
  constructor({ pause = ECU.PAUSE, sleep } = {}) {
    this.pause = pause;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.tail = Promise.resolve();
  }

  run(fn) {
    const job = this.tail.then(fn, fn);
    this.tail = job
      .catch(() => {})
      .then(() => (this.pause > 0 ? this.sleep(this.pause) : undefined));
    return job;
  }
}

export class EcuClient {
  constructor({
    host,
    port,
    queue,
    request = tcpRequest,
    timeout = ECU.TIMEOUT,
    attempts = ECU.CONNECT_ATTEMPTS,
  }) {
    this.host = host;
    this.port = port;
    this.queue = queue ?? new EcuQueue();
    this.request = request;
    this.timeout = timeout;
    this.attempts = Math.max(1, attempts);
  }

  /**
   * One query through the shared queue. Only a connection that could not be
   * opened is tried again (open_socket): a query that reached the ECU is
   * never sent twice.
   */
  async query(payload) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.queue.run(() =>
          this.request({ host: this.host, port: this.port, payload, timeout: this.timeout }),
        );
      } catch (err) {
        const error = err instanceof EcuError ? err : new EcuError('network', err?.message);
        if (!error.connectFailed || attempt >= this.attempts) {
          throw error;
        }
      }
    }
  }

  /**
   * A whole reading: the ECU frame, then the inverter frame. The second one
   * failing does not lose the first: resolves { ecu, inverters,
   * inverterError }.
   */
  async read() {
    const ecu = parseEcuFrame(await this.query(ECU_QUERY));
    let inverters;
    let inverterError;
    try {
      inverters = parseInverterFrame(await this.query(inverterQuery(ecu.id)));
    } catch (err) {
      inverterError = err;
    }
    return { ecu, inverters, inverterError };
  }
}
