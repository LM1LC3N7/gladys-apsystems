// -----------------------------------------------------------------------------
// Modified port of HAEdwin/homeassistant-apsystems_ecu_reader 2.15.0
// (__init__.py: the reading cycle, the cache, the filters of the ECU
// firmware bugs) and ksheumaker/homeassistant-apsystems_ecur, Apache-2.0:
// see THIRD_PARTY_NOTICES.md.
//
// The APsystems ECU gateways (ECU-B, ECU-R, ECU-C) and the micro-inverters
// behind them (DS3, DS3-L, QS1, YC600, YC1000, QT2...), read through the
// ECU's local socket (TCP 8899, see src/ecu.js). Read-only in this version.
//
// Pace (see src/constants.js, ECU): one reading (2 queries) per ECU every
// `ecu_poll_interval` (300 s by default and at least), one connection at a
// time for all the ECUs, a pause between two queries. After a failure the
// next attempt waits the interval, then twice as long, up to 30 minutes:
// never sooner than the interval. The pace of each address lives in its own
// bounded table, kept across a reconnection to Gladys and saved in
// /data/state.json: neither a flapping link nor a restart turns into a burst
// of queries on a fragile ECU.
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

const AWAKE = new Set(['producing', 'idle']);
/** At most this many addresses in the pace table. */
const MAX_PACED = 50;
/** States per request to Gladys. */
const BATCH = 100;

const sumOf = (values) => values.reduce((total, w) => total + w, 0);

export class EcuGateways {
  /**
   * `app` is the ApsystemsApp: its gladys, logger, now, publish,
   * productionEvents, guards and persist. `queue` is shared by every ECU
   * (one connection at a time).
   */
  constructor(app, { queue, clientFactory = (options) => new EcuClient(options) }) {
    this.app = app;
    this.queue = queue;
    this.clientFactory = clientFactory;
    /** `ecu_poll_interval` in ms (set by `configure`). */
    this.interval = 300_000;
    /** "ip:port" -> { key, ecuId, lastError, busy, client }. */
    this.hosts = new Map();
    /** "ip:port" -> { nextAt, misses, lastAttemptAt }: the pace, bounded, saved. */
    this.pacing = new Map();
    /** ECU id -> the ECU (see `ecu`). */
    this.ecus = new Map();
    /** inverter id -> { ...the last data the ECU gave, ecuId, seenAt }. */
    this.micros = new Map();
    this.configured = new Set();
    this.publishedSignature = undefined;
  }

  // --- Configuration ---------------------------------------------------------------

  /**
   * A (re)start: the addresses of the configuration. The pace of an address
   * already known is kept; an address no longer configured nor used by a
   * created ECU is forgotten, its pace too.
   */
  configure(config) {
    this.interval = config.ecuPollInterval * 1000;
    this.configured = new Set(config.ecuHosts.map((h) => h.key));
    for (const key of this.configured) {
      this.host(key);
    }
    this.syncCreated();
    this.prune();
    // The core keeps Discovery in memory: republish at every start.
    this.publishedSignature = undefined;
  }

  /** Forget the addresses nobody uses any more. */
  prune() {
    const used = new Set([
      ...this.configured,
      ...this.createdEcus()
        .map((e) => e.hostKey)
        .filter(Boolean),
    ]);
    for (const key of [...this.hosts.keys()]) {
      if (!used.has(key)) {
        this.hosts.delete(key);
      }
    }
    for (const key of [...this.pacing.keys()]) {
      if (!used.has(key)) {
        this.pacing.delete(key);
      }
    }
  }

  /** The pace read back from /data (already validated and capped by the store). */
  loadPacing(pacing) {
    for (const [key, pace] of pacing) {
      if (this.pacing.size < MAX_PACED && !this.pacing.has(key)) {
        this.pacing.set(key, { ...pace });
      }
    }
  }

  /** Whether the user has anything ECU-related: an address, or a created device. */
  any() {
    return this.hosts.size > 0 || this.createdDevices().length > 0;
  }

  host(key) {
    if (!this.hosts.has(key)) {
      this.hosts.set(key, { key, ecuId: undefined, lastError: undefined, busy: undefined });
    }
    return this.hosts.get(key);
  }

  pace(key) {
    if (!this.pacing.has(key)) {
      if (this.pacing.size >= MAX_PACED) {
        // Bounded: the oldest entry goes (it is no longer configured anyway, see prune).
        this.pacing.delete(this.pacing.keys().next().value);
      }
      this.pacing.set(key, { nextAt: 0, misses: 0, lastAttemptAt: undefined });
    }
    return this.pacing.get(key);
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
        production: undefined,
        status: 'waiting',
        device: undefined,
        uids: [],
        lastInverterError: undefined,
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

  /** The ECUs the user created, their address seeded from their params. */
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
        return ecu;
      });
  }

  /** The micro-inverters the user created: { uid, device, micro, ecuId }. */
  createdMicros() {
    return (this.app.gladys.devices ?? [])
      .filter((d) => parseEcuInverterExternalId(d.external_id))
      .map((device) => {
        const uid = parseEcuInverterExternalId(device.external_id).uid;
        const micro = this.micros.get(uid);
        return { uid, device, micro, ecuId: micro?.ecuId ?? (paramsOf(device).ecu || undefined) };
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

  /** Read the addresses that are due; resolves how many were tried. */
  async refresh() {
    this.syncCreated();
    const now = this.app.now();
    const due = [...this.hosts.values()].filter((h) => now >= this.pace(h.key).nextAt);
    await Promise.all(due.map((h) => this.readHost(h)));
    return due.length;
  }

  /** One reading of an address at a time (the loop, a creation and the test button may meet). */
  readHost(host) {
    if (!host.busy) {
      host.busy = this.doRead(host)
        .catch((err) => this.app.logger.warn(`ECU at ${host.key}: ${err.message}`))
        .finally(() => {
          host.busy = undefined;
        });
    }
    return host.busy;
  }

  async doRead(host) {
    const pace = this.pace(host.key);
    pace.lastAttemptAt = this.app.now();
    let result;
    try {
      result = await this.client(host).read();
    } catch (err) {
      await this.failed(host, err);
      return;
    }
    const at = this.app.now();
    pace.misses = 0;
    pace.nextAt = at + this.interval;
    host.lastError = undefined;
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
    if (data.currentPower > 0) {
      ecu.status = 'producing';
    } else {
      ecu.status = data.online === 0 ? 'asleep' : 'idle';
    }
    if (inverters) {
      ecu.uids = [...inverters.inverters.keys()];
      for (const [uid, inverter] of inverters.inverters) {
        this.micros.set(uid, { ...inverter, ecuId: data.id, seenAt: at });
      }
      if (inverters.truncated && !ecu.truncatedLogged) {
        this.app.logger.warn(
          `ECU ${data.id}: an inverter of an unknown type stops the reading of the list`,
        );
      }
      ecu.truncatedLogged = inverters.truncated;
      ecu.lastInverterError = undefined;
    } else if (inverterError) {
      // The ECU's own figures still count: the inverters wait for the next reading.
      if (ecu.lastInverterError !== inverterError.message) {
        this.app.logger.warn(
          `ECU ${data.id}: inverter data unavailable (${inverterError.message})`,
        );
      }
      ecu.lastInverterError = inverterError.message;
    }
    const guard = this.app.guardFor(`ecu:${ecu.id}`, ecu.device);
    // 2 kW per inverter the ECU knows (80 when it does not say), over two intervals at least.
    const count = Math.max(ecu.inverters ?? 0, ecu.uids.length);
    const accepted = this.app.acceptIndexValue(
      ecu.device?.name ?? `ECU ${ecu.id}`,
      guard,
      data.lifetimeEnergy,
      at,
      {
        maxKw: ECU.INDEX_KW_PER_INVERTER * (count > 0 ? count : ECU.UNKNOWN_INVERTERS),
        slack: ECU.INDEX_SLACK_KWH,
        minHours: (2 * this.interval) / 3_600_000,
      },
    );
    await this.publishEcu(ecu, { at, energyTotal: accepted ? data.lifetimeEnergy : undefined });
    await this.publishMicros(at);
    await this.app.persist({ urgent: true });
    if (this.signature() !== this.publishedSignature) {
      await this.app.publishDevices();
    }
  }

  /** A failed reading: wait longer, and after a few, report the ECU. */
  async failed(host, err) {
    const now = this.app.now();
    const pace = this.pace(host.key);
    pace.misses += 1;
    pace.nextAt =
      now +
      Math.min(this.interval * 2 ** (pace.misses - 1), Math.max(this.interval, ECU.BACKOFF_MAX));
    if (host.lastError !== err.message) {
      this.app.logger.warn(`ECU at ${host.key}: ${err.message}`);
    }
    host.lastError = err.message;
    // Only the ECU that lives at this address (after a restart: the created one stored there).
    const ecu = [...this.ecus.values()].find((e) => e.hostKey === host.key);
    if (ecu && pace.misses >= ECU.MISSES_BEFORE_UNREACHABLE) {
      if (ecu.status !== 'unreachable') {
        this.app.logger.warn(`ECU ${ecu.id} does not answer any more`);
      }
      ecu.status = 'unreachable';
      // Its production is unknown, not zero: only `reachable` changes, no event.
      if (ecu.device) {
        await this.app.publish(ecu, ecuStates(ecu.device.external_id, { reachable: false }), []);
      }
    }
    await this.publishMicros(now);
    await this.app.persist({ urgent: true });
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

  /**
   * Whether the last data of a micro-inverter is too old to show: it is not
   * in the last valid frame of its ECU, or was seen more than 2 intervals ago.
   */
  stale(micro, now) {
    if (!micro) {
      return true;
    }
    const ecu = this.ecus.get(micro.ecuId);
    return !ecu || !ecu.uids.includes(micro.uid) || now - micro.seenAt > 2 * this.interval;
  }

  /** The states of the created micro-inverters: stale ones are offline at 0 W. */
  async publishMicros(now, only) {
    const states = [];
    for (const { uid, device, micro } of this.createdMicros()) {
      if (only && !only.has(uid)) {
        continue;
      }
      if (micro && !this.stale(micro, now)) {
        states.push(...ecuInverterStates(device.external_id, micro));
      } else if (micro) {
        states.push(...ecuInverterStates(device.external_id, { ...micro, online: false }));
      }
    }
    for (let i = 0; i < states.length; i += BATCH) {
      await this.app.publish({ device: { name: 'ECU inverters' } }, states.slice(i, i + BATCH), []);
    }
  }

  /** A device was just created: its states from the last reading, no query. */
  async deviceCreated(device) {
    if (parseEcuExternalId(device.external_id)) {
      const ecu = this.createdEcus().find((e) => e.device.external_id === device.external_id);
      if (ecu?.identified && ecu.status !== 'unreachable') {
        await this.publishEcu(ecu, {
          energyTotal: this.app.guards.get(`ecu:${ecu.id}`)?.last?.value,
        });
      }
      return true;
    }
    if (parseEcuInverterExternalId(device.external_id)) {
      await this.publishMicros(
        this.app.now(),
        new Set([parseEcuInverterExternalId(device.external_id).uid]),
      );
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
          (h) =>
            !h.ecuId &&
            !createdHosts.has(h.key) &&
            this.pace(h.key).misses >= ECU.MISSES_BEFORE_UNREACHABLE,
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

  /** The created micro-inverters whose ECU is not a created device: counted on their own. */
  orphanMicros() {
    const ecus = new Set(this.createdEcus().map((e) => e.id));
    return this.createdMicros().filter((m) => !m.ecuId || !ecus.has(m.ecuId));
  }

  microFigures({ micro }, now) {
    const fresh = micro && !this.stale(micro, now);
    const online = Boolean(fresh && micro.online);
    return {
      power: online ? sumOf(micro.power) : 0,
      panels: micro ? micro.power.map((w) => (online ? w : 0)) : [],
      temperature: online ? micro.temperature : null,
      status: !micro
        ? 'waiting'
        : !online
          ? 'asleep'
          : sumOf(micro.power) > 0
            ? 'producing'
            : 'idle',
    };
  }

  ecuFigures(e) {
    return {
      power: AWAKE.has(e.status) ? (e.power ?? 0) : 0,
      energyToday: e.day?.value ?? lastValueOf(e.device, FEATURE.ENERGY_TODAY) ?? null,
      energyTotal: this.app.indexValue(`ecu:${e.id}`, e.device) ?? null,
      status: e.status,
    };
  }

  /**
   * The production of the created ECUs and of the micro-inverters whose ECU
   * is not created (`externalId` absent), of one ECU, or of one
   * micro-inverter; undefined when `externalId` is not a device of the
   * gateways. From the last readings: never an extra query.
   */
  production(externalId) {
    const now = this.app.now();
    const ofMicro = (m) => {
      const f = this.microFigures(m, now);
      return { power: f.power, energyToday: null, energyTotal: null, status: f.status };
    };
    if (!externalId) {
      return [
        ...this.createdEcus().map((e) => this.ecuFigures(e)),
        ...this.orphanMicros().map(ofMicro),
      ];
    }
    if (parseEcuExternalId(externalId)) {
      const ecu = this.createdEcus().find((e) => e.device.external_id === externalId);
      if (!ecu) {
        throw new Error(`Unknown APsystems ECU ${externalId}`);
      }
      return [this.ecuFigures(ecu)];
    }
    if (parseEcuInverterExternalId(externalId)) {
      const found = this.createdMicros().find((m) => m.device.external_id === externalId);
      if (!found) {
        throw new Error(`Unknown APsystems inverter ${externalId}`);
      }
      return [ofMicro(found)];
    }
    return undefined;
  }

  /**
   * The widget rows: the ECUs, then the micro-inverters (kind 'micro', not
   * summed: the ECU counts them, unless their ECU is not created).
   */
  widgetEntries() {
    const now = this.app.now();
    const orphans = new Set(this.orphanMicros().map((m) => m.uid));
    const ecus = this.createdEcus().map((e) => {
      const f = this.ecuFigures(e);
      return {
        kind: 'ecu',
        name: e.device.name,
        deviceId: e.device.external_id,
        status: f.status,
        power: f.power,
        inputs: [],
        energyToday: f.energyToday,
        energyTotal: f.energyTotal,
        limit: null,
        alarms: {},
        online: e.online ?? null,
        inverters: e.inverters ?? null,
      };
    });
    const micros = this.createdMicros().map((m) => {
      const f = this.microFigures(m, now);
      return {
        kind: 'micro',
        alone: orphans.has(m.uid),
        // An inverter of a type the reference does not know has no power feature.
        hasPower: (m.micro?.channels ?? 0) > 0,
        name: m.device.name,
        deviceId: m.device.external_id,
        status: f.status,
        power: f.power,
        inputs: f.panels,
        temperature: f.temperature,
        energyToday: null,
        energyTotal: null,
        limit: null,
        alarms: {},
      };
    });
    return [...ecus, ...micros];
  }

  /**
   * The test button, every address in parallel: an address that is not due
   * yet is reported from its last reading (a fragile ECU is never asked
   * before its time); a due one is read now, and that reading counts for the
   * pace.
   */
  async testLines() {
    return Promise.all(
      [...this.configured].map(async (key) => {
        const host = this.host(key);
        if (host.busy) {
          await host.busy;
        } else if (this.app.now() >= this.pace(key).nextAt) {
          await this.readHost(host);
        }
        const ecu = host.ecuId ? this.ecus.get(host.ecuId) : undefined;
        if (this.pace(key).misses > 0 || !ecu) {
          return T.test.ecuFailed(key, host.lastError ?? '?');
        }
        return T.test.ecuAnswers(key, ecu);
      }),
    );
  }
}
