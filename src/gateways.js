// -----------------------------------------------------------------------------
// The APsystems ECU gateways (ECU-B, ECU-R, ECU-C) and the micro-inverters
// behind them (DS3, DS3-L, QS1, YC600, YC1000, QT2...), read through the
// ECU's local socket (TCP 8899, see src/ecu.js). Read-only in this version.
//
// Pace (see src/constants.js, ECU): one reading (2 queries) per ECU every
// `ecu_poll_interval` (300 s by default and at least), one connection at a
// time for all the ECUs, a pause between two queries. After a failure the
// next attempt waits the interval, then twice as long, up to 30 minutes:
// never sooner than the interval. This pacing survives a reconnection to
// Gladys (`connected` restarts the app): a flapping link never turns into a
// burst of queries on a fragile ECU.
//
// The night: the ECU is powered by the grid and keeps answering, its
// micro-inverters go offline with the sun. 0 inverter online is "asleep",
// never an error. Red only for an ECU that stops answering
// (ECU.MISSES_BEFORE_UNREACHABLE readings in a row).
// -----------------------------------------------------------------------------

import { parseHost } from './config.js';
import { ECU } from './constants.js';
import {
  FEATURE,
  buildEcuDevice,
  buildEcuInverterDevice,
  ecuInverterStates,
  ecuStates,
  lastValueOf,
  paramsOf,
  parseEcuExternalId,
  parseEcuInverterExternalId,
} from './devices.js';
import { EcuClient } from './ecu.js';
import { T } from './i18n.js';
import { ecuIndexStep } from './model.js';

const AWAKE = new Set(['producing', 'idle']);

export class EcuGateways {
  /**
   * `app` is the ApsystemsApp: its gladys, logger, now, publish and
   * productionEvents. `queue` is shared by every ECU (one connection at a
   * time).
   */
  constructor(app, { queue, clientFactory = (options) => new EcuClient(options) }) {
    this.app = app;
    this.queue = queue;
    this.clientFactory = clientFactory;
    /** `ecu_poll_interval` in ms (set by `configure`). */
    this.interval = 300_000;
    /** "ip:port" -> what is known of that address (pacing included). */
    this.hosts = new Map();
    /** ECU id -> the ECU (see `ecu`). */
    this.ecus = new Map();
    /** inverter id -> the last data the ECU gave about it. */
    this.micros = new Map();
    this.configured = new Set();
    this.publishedSignature = undefined;
  }

  // --- Configuration ---------------------------------------------------------------

  /**
   * A (re)start: the addresses of the configuration. The pacing of an address
   * already known is kept; an address no longer configured nor used by a
   * created ECU is forgotten.
   */
  configure(config) {
    this.interval = config.ecuPollInterval * 1000;
    this.configured = new Set(config.ecuHosts.map((h) => h.key));
    for (const h of config.ecuHosts) {
      this.host(h.key);
    }
    const used = new Set(this.createdEcus().map((e) => e.hostKey));
    for (const key of [...this.hosts.keys()]) {
      if (!this.configured.has(key) && !used.has(key)) {
        this.hosts.delete(key);
      }
    }
    // The core keeps Discovery in memory: republish at every start.
    this.publishedSignature = undefined;
  }

  /** A save of the configuration accepts a lifetime index jump held back. */
  acceptHeldJumps() {
    for (const ecu of this.ecus.values()) {
      if (Number.isFinite(ecu.index?.held)) {
        ecu.index = { ...ecu.index, accept: true };
        this.app.logger.info(`${ecu.id}: the lifetime index jump held back will be accepted`);
      }
    }
  }

  /** Whether the user has anything ECU-related: an address, or a created device. */
  any() {
    return this.hosts.size > 0 || this.createdDevices().length > 0;
  }

  host(key) {
    if (!this.hosts.has(key)) {
      this.hosts.set(key, {
        key,
        ecuId: undefined,
        nextAt: 0,
        misses: 0,
        lastAttemptAt: undefined,
        lastError: undefined,
        busy: undefined,
        client: undefined,
      });
    }
    return this.hosts.get(key);
  }

  client(host) {
    if (!host.client) {
      const { host: address, port } = parseHost(host.key, ECU.PORT);
      host.client = this.clientFactory({ host: address, port, queue: this.queue });
    }
    return host.client;
  }

  /** The state of an ECU, created on first use. */
  ecu(id) {
    if (!this.ecus.has(id)) {
      this.ecus.set(id, {
        id,
        serial: id,
        identified: false,
        hostKey: undefined,
        model: undefined,
        firmware: undefined,
        inverters: undefined,
        online: undefined,
        power: undefined,
        day: undefined,
        index: undefined,
        production: undefined,
        status: 'waiting',
        device: undefined,
        uids: [],
      });
    }
    return this.ecus.get(id);
  }

  // --- Created devices ---------------------------------------------------------------

  createdDevices() {
    return (this.app.gladys.devices ?? []).filter(
      (d) => parseEcuExternalId(d.external_id) || parseEcuInverterExternalId(d.external_id),
    );
  }

  /**
   * The ECUs the user created, seeded from their params (the address) and
   * the last values Gladys holds (the lifetime index and when it was set).
   */
  createdEcus() {
    return (this.app.gladys.devices ?? [])
      .filter((d) => parseEcuExternalId(d.external_id))
      .map((device) => {
        const ecu = this.ecu(parseEcuExternalId(device.external_id).ecuId);
        ecu.device = device;
        const params = paramsOf(device);
        if (!ecu.hostKey && parseHost(params.host, ECU.PORT)) {
          ecu.hostKey = parseHost(params.host, ECU.PORT).key;
        }
        ecu.model = ecu.model ?? params.model;
        if (ecu.index === undefined) {
          const last = lastValueOf(device, FEATURE.ENERGY_TOTAL);
          const feature = device.features?.find((f) =>
            String(f.external_id).endsWith(`:${FEATURE.ENERGY_TOTAL}`),
          );
          const at = Date.parse(feature?.last_value_changed ?? '');
          ecu.index =
            last === undefined
              ? undefined
              : { value: last, at: Number.isFinite(at) ? at : this.app.startedAt };
        }
        return ecu;
      });
  }

  /** The micro-inverters the user created: { uid, device, data }. */
  createdMicros() {
    return (this.app.gladys.devices ?? [])
      .filter((d) => parseEcuInverterExternalId(d.external_id))
      .map((device) => {
        const uid = parseEcuInverterExternalId(device.external_id).uid;
        return { uid, device, micro: this.micros.get(uid) };
      });
  }

  /** The created ECUs whose address is not configured any more are still read. */
  syncCreated() {
    for (const ecu of this.createdEcus()) {
      if (ecu.hostKey) {
        this.host(ecu.hostKey);
      }
    }
  }

  // --- Reading -----------------------------------------------------------------------

  async refresh() {
    this.syncCreated();
    const now = this.app.now();
    await Promise.all(
      [...this.hosts.values()].filter((h) => now >= h.nextAt).map((h) => this.readHost(h)),
    );
  }

  /** One reading of an address at a time (the loop, a creation and the test button may meet). */
  readHost(host) {
    if (!host.busy) {
      host.busy = this.doRead(host).finally(() => {
        host.busy = undefined;
      });
    }
    return host.busy;
  }

  async doRead(host) {
    host.lastAttemptAt = this.app.now();
    let result;
    try {
      result = await this.client(host).read();
    } catch (err) {
      await this.failed(host, err);
      return;
    }
    const at = this.app.now();
    host.misses = 0;
    host.lastError = undefined;
    host.nextAt = at + this.interval;
    const { ecu: data, inverters, inverterError } = result;
    if (host.ecuId && host.ecuId !== data.id) {
      // The address now belongs to another ECU (DHCP): the old one is lost.
      this.app.logger.warn(`${host.key}: ECU ${data.id} answers instead of ${host.ecuId}`);
      const previous = this.ecus.get(host.ecuId);
      if (previous && previous.hostKey === host.key) {
        previous.hostKey = undefined;
        previous.status = 'unreachable';
      }
    }
    host.ecuId = data.id;
    const ecu = this.ecu(data.id);
    if (ecu.status === 'unreachable') {
      this.app.logger.info(`ECU ${data.id} answers again`);
    }
    Object.assign(ecu, {
      identified: true,
      hostKey: host.key,
      model: data.model,
      firmware: data.firmware ?? ecu.firmware,
      timezone: data.timezone ?? ecu.timezone,
      // The reference's filters for an ECU firmware bug: a count at 0 is ignored.
      inverters: data.inverters || ecu.inverters,
      online: data.online ?? ecu.online,
      power: data.currentPower,
      lastSeenAt: at,
    });
    // The energy of the day at 0 while inverters are online is the same bug.
    if (!(data.todayEnergy === 0 && (data.online ?? 0) > 0)) {
      ecu.day = { value: data.todayEnergy };
    }
    const index = ecuIndexStep(ecu.index, data.lifetimeEnergy, at, {
      maxKw: ECU.INDEX_KW_PER_INVERTER * Math.max(1, ecu.inverters ?? 1),
      slack: ECU.INDEX_SLACK_KWH,
    });
    if (Number.isFinite(index.state.held) && !Number.isFinite(ecu.index?.held)) {
      this.app.logger.warn(
        `ECU ${data.id}: the lifetime energy jumped from ${ecu.index?.value} to ${data.lifetimeEnergy} kWh, ` +
          'held back (save the configuration to accept it)',
      );
    }
    ecu.index = index.state;
    ecu.status = data.online === 0 ? 'asleep' : data.currentPower > 0 ? 'producing' : 'idle';
    if (inverters) {
      ecu.uids = [...inverters.inverters.keys()];
      for (const [uid, inverter] of inverters.inverters) {
        this.micros.set(uid, { ...inverter, ecuId: data.id, seenAt: at });
      }
      if (inverters.truncated) {
        this.app.logger.warn(
          `ECU ${data.id}: an inverter of an unknown type stops the reading of the list`,
        );
      }
    } else if (inverterError) {
      // The ECU's own figures still count: the inverters wait for the next reading.
      this.app.logger.warn(`ECU ${data.id}: inverter data unavailable (${inverterError.message})`);
    }
    await this.publishEcu(ecu, { at, energyTotal: index.publish });
    if (inverters) {
      await this.publishMicros(new Set(inverters.inverters.keys()));
    }
    if (this.signature() !== this.publishedSignature) {
      await this.app.publishDevices();
    }
  }

  /** A failed reading: wait longer, and after a few, report the ECU. */
  async failed(host, err) {
    const now = this.app.now();
    host.misses += 1;
    host.lastError = err.message;
    host.nextAt =
      now +
      Math.min(this.interval * 2 ** (host.misses - 1), Math.max(this.interval, ECU.BACKOFF_MAX));
    this.app.logger.warn(`ECU at ${host.key}: ${err.message} (attempt ${host.misses})`);
    // After a restart the address may not have answered yet: the created ECU stored there.
    const ecu = host.ecuId
      ? this.ecus.get(host.ecuId)
      : [...this.ecus.values()].find((e) => e.hostKey === host.key);
    if (!ecu || host.misses < ECU.MISSES_BEFORE_UNREACHABLE) {
      return;
    }
    if (ecu.status !== 'unreachable') {
      this.app.logger.warn(`ECU ${ecu.id} does not answer any more`);
    }
    ecu.status = 'unreachable';
    // Its production is unknown, not zero: only `reachable` changes, no event.
    if (ecu.device) {
      await this.app.publish(ecu, ecuStates(ecu.device.external_id, { reachable: false }), []);
    }
  }

  /** The states and the production events of a created ECU. */
  async publishEcu(ecu, { at, energyTotal }) {
    if (!ecu.device) {
      return;
    }
    const power = AWAKE.has(ecu.status) ? ecu.power : 0;
    const events = at === undefined ? [] : this.app.productionEvents(ecu, power, at);
    await this.app.publish(
      ecu,
      ecuStates(ecu.device.external_id, {
        reachable: ecu.status !== 'unreachable',
        power,
        energyToday: ecu.day?.value,
        energyTotal,
        online: ecu.online,
      }),
      events,
    );
  }

  /** The states of the created micro-inverters (`only`: those of this reading). */
  async publishMicros(only) {
    const states = [];
    for (const { uid, device, micro } of this.createdMicros()) {
      if (micro && (!only || only.has(uid))) {
        states.push(...ecuInverterStates(device.external_id, micro));
      }
    }
    if (states.length > 0) {
      await this.app.publish({ device: { name: 'ECU inverters' } }, states, []);
    }
  }

  /** A device was just created: its states from the last reading, no query. */
  async deviceCreated(device) {
    if (parseEcuExternalId(device.external_id)) {
      const ecu = this.createdEcus().find((e) => e.device.external_id === device.external_id);
      if (ecu?.identified && ecu.status !== 'unreachable') {
        await this.publishEcu(ecu, { energyTotal: ecu.index?.value });
      }
      return true;
    }
    if (parseEcuInverterExternalId(device.external_id)) {
      await this.publishMicros(new Set([parseEcuInverterExternalId(device.external_id).uid]));
      return true;
    }
    return false;
  }

  // --- Discovery ---------------------------------------------------------------------

  /** Every ECU that answered and every micro-inverter it listed. */
  devices() {
    const gladys = this.app.gladys;
    return [
      ...[...this.ecus.values()]
        .filter((e) => e.identified)
        .map((e) =>
          buildEcuDevice(gladys, {
            id: e.id,
            model: e.model,
            firmware: e.firmware,
            hostKey: e.hostKey,
            inverters: e.inverters,
          }),
        ),
      ...[...this.micros.values()].map((m) => buildEcuInverterDevice(gladys, m)),
    ];
  }

  /** What Discovery shows, to republish only when it changes. */
  signature() {
    return JSON.stringify([
      [...this.ecus.values()]
        .filter((e) => e.identified)
        .map((e) => [e.id, e.hostKey, e.model, e.firmware, e.inverters]),
      [...this.micros.values()].map((m) => [m.uid, m.ecuId, m.type, m.channels, m.phases]),
    ]);
  }

  // --- Status, scenes, widget, test button -------------------------------------------

  /** The ECU part of the connection status, or undefined without any ECU. */
  statusPart() {
    if (!this.any()) {
      return undefined;
    }
    const created = this.createdEcus();
    const createdHosts = new Set(created.map((e) => e.hostKey));
    const down = [
      ...created.filter((e) => e.status === 'unreachable' || !e.hostKey).map((e) => e.device.name),
      ...[...this.hosts.values()]
        .filter(
          (h) => !h.ecuId && !createdHosts.has(h.key) && h.misses >= ECU.MISSES_BEFORE_UNREACHABLE,
        )
        .map((h) => h.key),
    ];
    if (down.length > 0) {
      return { connected: false, message: T.ecu.unreachable(down) };
    }
    if (created.length === 0) {
      const found = [...this.ecus.values()].filter((e) => e.identified).length;
      return { connected: true, message: found > 0 ? T.ecu.notCreated(found) : T.ecu.waiting };
    }
    return {
      connected: true,
      message: T.ecu.ok({
        total: created.length,
        producing: created.filter((e) => e.status === 'producing').length,
        asleep: created.filter((e) => e.status === 'asleep').length,
      }),
    };
  }

  /**
   * The production of the created ECUs (`externalId` absent), of one ECU, or
   * of one micro-inverter; undefined when `externalId` is not a device of
   * the gateways. From the last readings: never an extra query.
   */
  production(externalId) {
    const ofEcu = (e) => ({
      power: AWAKE.has(e.status) ? (e.power ?? 0) : 0,
      energyToday: e.day?.value ?? lastValueOf(e.device, FEATURE.ENERGY_TODAY) ?? null,
      energyTotal: e.index?.value ?? lastValueOf(e.device, FEATURE.ENERGY_TOTAL) ?? null,
      status: e.status,
    });
    if (!externalId) {
      return this.createdEcus().map(ofEcu);
    }
    if (parseEcuExternalId(externalId)) {
      const ecu = this.createdEcus().find((e) => e.device.external_id === externalId);
      if (!ecu) {
        throw new Error(`Unknown APsystems ECU ${externalId}`);
      }
      return [ofEcu(ecu)];
    }
    if (parseEcuInverterExternalId(externalId)) {
      const found = this.createdMicros().find((m) => m.device.external_id === externalId);
      if (!found) {
        throw new Error(`Unknown APsystems inverter ${externalId}`);
      }
      const micro = found.micro;
      return [
        {
          power: micro?.online ? micro.power.reduce((t, w) => t + w, 0) : 0,
          energyToday: null,
          energyTotal: null,
          status: microStatus(micro),
        },
      ];
    }
    return undefined;
  }

  /** The widget rows: the ECUs, then the micro-inverters (flagged, not summed). */
  widgetEntries() {
    const ecus = this.createdEcus().map((e) => ({
      kind: 'ecu',
      name: e.device.name,
      deviceId: e.device.external_id,
      status: e.status,
      power: AWAKE.has(e.status) ? (e.power ?? 0) : 0,
      inputs: [],
      energyToday: e.day?.value ?? lastValueOf(e.device, FEATURE.ENERGY_TODAY) ?? null,
      energyTotal: e.index?.value ?? lastValueOf(e.device, FEATURE.ENERGY_TOTAL) ?? null,
      limit: null,
      alarms: {},
      online: e.online ?? null,
      inverters: e.inverters ?? null,
    }));
    const micros = this.createdMicros().map(({ device, micro }) => ({
      kind: 'micro',
      name: device.name,
      deviceId: device.external_id,
      status: microStatus(micro),
      power: micro?.online ? micro.power.reduce((t, w) => t + w, 0) : 0,
      inputs: micro ? micro.power.map((w) => (micro.online ? w : 0)) : [],
      temperature: micro?.online ? micro.temperature : null,
      limit: null,
      alarms: {},
    }));
    return [...ecus, ...micros];
  }

  /**
   * The test button: an address read within the interval is reported from
   * that reading (a fragile ECU is not queried on every click); otherwise
   * it is read now, and that reading counts for the pace.
   */
  async testLines() {
    const lines = [];
    for (const key of this.configured) {
      const host = this.host(key);
      if (host.busy) {
        await host.busy;
      } else if (
        host.lastAttemptAt === undefined ||
        this.app.now() - host.lastAttemptAt >= this.interval
      ) {
        await this.readHost(host);
      }
      const ecu = host.ecuId ? this.ecus.get(host.ecuId) : undefined;
      if (host.misses > 0 || !ecu) {
        lines.push(T.test.ecuFailed(key, host.lastError ?? '?'));
      } else {
        lines.push(T.test.ecuAnswers(key, ecu));
      }
    }
    return lines;
  }
}

/** A micro-inverter's state: offline is the night (asleep), never an error. */
function microStatus(micro) {
  if (!micro) {
    return 'waiting';
  }
  if (!micro.online) {
    return 'asleep';
  }
  return micro.power.reduce((t, w) => t + w, 0) > 0 ? 'producing' : 'idle';
}
