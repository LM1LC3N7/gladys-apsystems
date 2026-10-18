// -----------------------------------------------------------------------------
// The integration itself: identifying the inverters typed in the
// configuration, the reading loop over the inverters the user created, the
// night, the commands (power limit, on/off), the scene triggers and actions,
// the widget. index.js only wires the SDK handlers to it. The ECU gateways
// (src/gateways.js) run beside the EZ1, at their own pace, from the same loop.
//
// Pace (see CLAUDE.md): every `poll_interval` seconds the output data of
// each created inverter; its alarms and on/off status every 5 minutes; its
// device information and power limit every hour. Requests to one inverter
// never overlap (the client queues them). An inverter that stops answering
// for 3 readings in a row is asleep (no sun, no Wi-Fi): it is then tried
// every 5 minutes only, its powers read 0 and its counters keep their value.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, parseHost } from './config.js';
import {
  AWAKE_POWER,
  DEFAULT_LIMITS,
  LONG_SILENCE,
  MISSES_BEFORE_ASLEEP,
  PACING,
  WIDGETS,
} from './constants.js';
import {
  FEATURE,
  buildInverterDevice,
  featureKey,
  ids,
  inverterStates,
  isSerial,
  keepCreatedFeatures,
  lastValueOf,
  paramsOf,
  parseEcuExternalId,
  parseEcuInverterExternalId,
  parseExternalId,
} from './devices.js';
import { EcuQueue } from './ecu.js';
import { Ez1Client, LIMIT_VARIANTS } from './ez1.js';
import { EcuGateways } from './gateways.js';
import { Ez1Error } from './http.js';
import { T } from './i18n.js';
import {
  alarmsOf,
  dayEnergyStep,
  deviceInfoOf,
  indexStep,
  limitOf,
  num,
  onOffOf,
  outputOf,
} from './model.js';
import { alarmEvent, productionEvent, productionStep, raisedAlarms } from './triggers.js';
import { solarWidget } from './widget.js';

const defaultTimers = { setTimeout, clearTimeout, setInterval, clearInterval };
const AWAKE = new Set(['producing', 'idle', 'off']);
const SILENT = new Set(['asleep', 'unreachable']);

/** Join several { en, fr } texts into one. */
const joinTexts = (...texts) => ({
  en: texts.map((t) => t.en).join(' '),
  fr: texts.map((t) => t.fr).join(' '),
});

export class ApsystemsApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'apsystems' }),
    now = Date.now,
    timers = defaultTimers,
    clientFactory = (options) => new Ez1Client(options),
    ecuQueue,
    ecuClientFactory,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.clientFactory = clientFactory;
    /** The ECU gateways (src/gateways.js); their pacing survives a restart of the app. */
    this.gateways = new EcuGateways(this, {
      queue:
        ecuQueue ??
        new EcuQueue({ sleep: (ms) => new Promise((resolve) => timers.setTimeout(resolve, ms)) }),
      ...(ecuClientFactory ? { clientFactory: ecuClientFactory } : {}),
    });
    this.config = normalizeConfig();
    /** "ip:port" -> Ez1Client (one queue per inverter). */
    this.clients = new Map();
    /** "ip:port" of the configuration -> { serial, probedAt }. */
    this.hosts = new Map();
    /** serial -> what the integration knows of an inverter (see `inverter`). */
    this.inverters = new Map();
    this.startedAt = this.now();
    this.refreshTimer = undefined;
    this.refreshing = undefined;
    this.lastStatus = undefined;
    this.generation = 0;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    const generation = ++this.generation;
    this.config = normalizeConfig(raw);
    this.clients.clear();
    this.inverters.clear();
    this.hosts = new Map(this.config.hosts.map((h) => [h.key, { serial: undefined, probedAt: 0 }]));
    this.startedAt = this.now();
    // The core keeps the connection status in memory: send it again at every start.
    this.lastStatus = undefined;
    this.gateways.configure(this.config);
    if (this.config.invalidHosts.length > 0) {
      this.logger.warn(`Ignored entries of the address list: ${this.config.invalidHosts}`);
    }
    if (this.config.invalidEcuHosts.length > 0) {
      this.logger.warn(`Ignored entries of the ECU address list: ${this.config.invalidEcuHosts}`);
    }
    if (
      this.config.hosts.length === 0 &&
      this.createdDevices().length === 0 &&
      !this.gateways.any()
    ) {
      await this.updateStatus();
      return;
    }
    try {
      await this.probeHosts({ force: true });
      await this.refresh();
    } catch (err) {
      this.logger.warn(`Start: ${err.message}`);
    }
    if (generation !== this.generation) {
      return;
    }
    this.refreshTimer = this.timers.setInterval(
      () => this.refresh().catch((err) => this.logger.warn(`Refresh: ${err.message}`)),
      this.config.pollInterval * 1000,
    );
  }

  /** The user saved the configuration: that save accepts an ECU index jump held back. */
  configUpdated(raw) {
    this.gateways.acceptHeldJumps();
    return this.start(raw);
  }

  stop() {
    this.generation += 1;
    this.timers.clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** The EZ1 part of the connection status, or undefined without any EZ1. */
  ez1StatusPart() {
    const created = this.createdInverters();
    if (this.config.hosts.length === 0 && created.length === 0) {
      return undefined;
    }
    if (created.length === 0) {
      const found = [...this.hosts.values()].filter((h) => h.serial).length;
      return { connected: true, message: found > 0 ? T.notCreated(found) : T.nobodyAnswers };
    }
    const unreachable = created.filter((i) => i.status === 'unreachable');
    if (unreachable.length > 0) {
      return { connected: false, message: T.unreachable(unreachable.map((i) => i.device.name)) };
    }
    return {
      connected: true,
      message: T.ok({
        total: created.length,
        producing: created.filter((i) => i.status === 'producing').length,
        asleep: created.filter((i) => i.status === 'asleep').length,
      }),
    };
  }

  /** Red only for a real problem: an inverter that vanished in daylight, an ECU that hangs. */
  async updateStatus() {
    const parts = [this.ez1StatusPart(), this.gateways.statusPart()].filter(Boolean);
    const connected = parts.length > 0 && parts.every((p) => p.connected);
    let message = parts.length > 0 ? joinTexts(...parts.map((p) => p.message)) : T.noHost;
    if (this.config.invalidHosts.length > 0) {
      message = joinTexts(message, T.invalidHosts(this.config.invalidHosts));
    }
    if (this.config.invalidEcuHosts.length > 0) {
      message = joinTexts(message, T.invalidEcuHosts(this.config.invalidEcuHosts));
    }
    await this.setStatus(connected, message);
  }

  // --- Inverters ---------------------------------------------------------------

  client(hostKey) {
    if (!this.clients.has(hostKey)) {
      const { host, port } = parseHost(hostKey);
      this.clients.set(hostKey, this.clientFactory({ host, port }));
    }
    return this.clients.get(hostKey);
  }

  /** The state of an inverter, created on first use. */
  inverter(serial) {
    if (!this.inverters.has(serial)) {
      this.inverters.set(serial, {
        serial,
        hostKey: undefined,
        device: undefined,
        info: undefined,
        infoAt: 0,
        identified: false,
        limitVariant: undefined,
        limitSupported: undefined,
        switchSupported: undefined,
        inputs: 2,
        limit: undefined,
        on: undefined,
        alarms: undefined,
        previousAlarms: undefined,
        alarmsAt: 0,
        output: undefined,
        day: undefined,
        index: undefined,
        production: undefined,
        status: 'waiting',
        misses: 0,
        lastSeenAt: undefined,
        nextAt: 0,
        busy: undefined,
      });
    }
    return this.inverters.get(serial);
  }

  /** The devices of this integration Gladys hands back. */
  createdDevices() {
    return (this.gladys.devices ?? []).filter((d) => parseExternalId(d.external_id));
  }

  /**
   * The inverters the user created, their state seeded from the device params
   * (the address, the bounds) and the last values Gladys holds, so a restart
   * at night knows them without asking the sleeping inverter.
   */
  createdInverters() {
    return this.createdDevices().map((device) => {
      const inverter = this.inverter(parseExternalId(device.external_id).serial);
      inverter.device = device;
      const params = paramsOf(device);
      if (!inverter.hostKey && parseHost(params.host)) {
        inverter.hostKey = parseHost(params.host).key;
      }
      if (!inverter.identified) {
        inverter.inputs = Math.max(1, num(params.inputs) ?? inverter.inputs);
        inverter.switchSupported = params.switch === '1';
        if (params.limit_endpoint === 'none') {
          inverter.limitSupported = false;
        } else if (Object.values(LIMIT_VARIANTS).includes(params.limit_endpoint)) {
          inverter.limitVariant = params.limit_endpoint;
          inverter.limitSupported = true;
        }
        inverter.boundsFromParams = { min: num(params.min_power), max: num(params.max_power) };
      }
      if (!inverter.index) {
        const last = lastValueOf(device, FEATURE.ENERGY_TOTAL);
        inverter.index = last === undefined ? undefined : { value: last, lower: 0 };
      }
      return inverter;
    });
  }

  bounds(inverter) {
    return {
      min: inverter.info?.minPower ?? inverter.boundsFromParams?.min ?? DEFAULT_LIMITS.min,
      max: inverter.info?.maxPower ?? inverter.boundsFromParams?.max ?? DEFAULT_LIMITS.max,
    };
  }

  // --- Identification and discovery ----------------------------------------------

  /**
   * Ask an address who answers there, and what its firmware offers: the
   * power limit (getMaxPower, else the EZ1-D's getDefaultMaxPower), the
   * on/off switch (getOnOff, absent from the "_b" firmware), the number of
   * DC inputs. All or nothing: a half-read inverter is asked again later.
   */
  async identify(hostKey) {
    const client = this.client(hostKey);
    const answer = await client.deviceInfo();
    const info = deviceInfoOf(answer.data, answer.deviceId);
    if (!isSerial(info.serial)) {
      throw new Ez1Error('protocol', `${hostKey} answered getDeviceInfo without a device id`);
    }
    let limit;
    let limitVariant;
    for (const variant of Object.values(LIMIT_VARIANTS)) {
      try {
        limit = limitOf((await client.maxPower(variant)).data);
        limitVariant = variant;
        break;
      } catch (err) {
        if (err.silent) {
          throw err;
        }
      }
    }
    let on = null;
    try {
      on = onOffOf((await client.onOff()).data);
    } catch (err) {
      if (err.silent) {
        throw err;
      }
    }
    const output = outputOf((await client.outputData()).data);
    const inverter = this.inverter(info.serial);
    Object.assign(inverter, {
      hostKey,
      info,
      infoAt: this.now(),
      identified: true,
      limitVariant,
      limitSupported: Boolean(limitVariant),
      limit: limit ?? inverter.limit,
      // The battery-capable firmware has no on/off (Home Assistant hides it too).
      switchSupported: on !== null && !info.battery,
      on: on ?? undefined,
      inputs: Math.max(1, output.inputs.length),
    });
    return inverter;
  }

  /** Identify the configured addresses that are not yet (or all with `force`). */
  async probeHosts({ force = false } = {}) {
    const now = this.now();
    const due = [...this.hosts].filter(
      ([, host]) => force || (!host.serial && now - host.probedAt >= PACING.PROBE),
    );
    if (due.length === 0 && !force) {
      return;
    }
    let changed = false;
    await Promise.all(
      due.map(async ([key, host]) => {
        host.probedAt = now;
        try {
          const inverter = await this.identify(key);
          changed = changed || host.serial !== inverter.serial;
          host.serial = inverter.serial;
        } catch (err) {
          this.logger.debug?.(`${key} does not answer: ${err.message}`);
        }
      }),
    );
    if (changed || force) {
      await this.publishDevices();
    }
  }

  /**
   * Discovery lists every inverter that answered at a configured address,
   * every ECU and the micro-inverters behind it; a device the user created
   * keeps every feature it has.
   */
  async publishDevices() {
    const created = new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
    const ez1 = [...this.inverters.values()]
      .filter((i) => i.identified)
      .map((i) =>
        buildInverterDevice(this.gladys, {
          serial: i.serial,
          model: i.info.model,
          devVer: i.info.devVer,
          hostKey: i.hostKey,
          minPower: i.info.minPower,
          maxPower: i.info.maxPower,
          inputs: i.inputs,
          switchSupported: i.switchSupported,
          limitSupported: i.limitSupported,
          limitVariant: i.limitVariant ?? 'none',
        }),
      );
    const devices = [...ez1, ...this.gateways.devices()].map((d) =>
      keepCreatedFeatures(d, created.get(d.external_id)),
    );
    this.gateways.publishedSignature = this.gateways.signature();
    await this.gladys.publishDiscoveredDevices(devices);
  }

  /** The Discovery screen asked for a scan: ask every address now. */
  async scan() {
    await this.probeHosts({ force: true });
  }

  // --- Reading ---------------------------------------------------------------------

  refresh() {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  async doRefresh() {
    await Promise.all([
      (async () => {
        await this.probeHosts();
        // Different inverters in parallel: each one has its own queue.
        await Promise.all(this.createdInverters().map((i) => this.refreshInverter(i)));
      })(),
      // The ECUs at their own pace (they skip the ticks before they are due).
      this.gateways.refresh(),
    ]);
    await this.updateStatus();
    this.gladys.requestWidgetRefresh(WIDGETS.SOLAR);
  }

  /** A device was just created (or updated): read it now (an ECU: its last reading). */
  async deviceCreated(device) {
    if (await this.gateways.deviceCreated(device)) {
      await this.updateStatus();
      return;
    }
    const parsed = parseExternalId(device.external_id);
    if (!parsed) {
      return;
    }
    const inverter = this.createdInverters().find((i) => i.serial === parsed.serial);
    if (inverter) {
      inverter.nextAt = 0;
      await this.refreshInverter(inverter);
      await this.updateStatus();
    }
  }

  /** One reading of an inverter at a time (the loop and a device creation may meet). */
  refreshInverter(inverter) {
    if (!inverter.busy) {
      inverter.busy = this.readInverter(inverter).finally(() => {
        inverter.busy = undefined;
      });
    }
    return inverter.busy;
  }

  async readInverter(inverter) {
    const now = this.now();
    if (now < inverter.nextAt) {
      return;
    }
    if (!inverter.hostKey) {
      if (inverter.status !== 'unreachable') {
        this.logger.warn(`${inverter.device.name}: no address known, type it in the configuration`);
      }
      inverter.status = 'unreachable';
      return;
    }
    const client = this.client(inverter.hostKey);
    let output;
    try {
      const answer = await client.outputData();
      if (answer.deviceId && answer.deviceId !== inverter.serial) {
        throw new Ez1Error('mismatch', `${answer.deviceId} answers at ${inverter.hostKey}`);
      }
      output = outputOf(answer.data);
    } catch (err) {
      await this.missed(inverter, err);
      return;
    }
    if (SILENT.has(inverter.status)) {
      this.logger.info(`${inverter.device.name} answers again`);
      // The first alarm reading after waking up only arms: the EZ1 checks
      // the grid for a while each morning.
      inverter.previousAlarms = undefined;
      inverter.alarmsAt = 0;
    }
    inverter.misses = 0;
    inverter.lastSeenAt = now;
    inverter.nextAt = 0;
    inverter.output = output;
    const events = [];
    await this.readSlowData(inverter, client, events);
    inverter.day = dayEnergyStep(inverter.day, output.energy, now);
    const index = indexStep(inverter.index, output.lifetime);
    inverter.index = index.state;
    inverter.status = inverter.on === false ? 'off' : output.power > 0 ? 'producing' : 'idle';
    events.push(...this.productionEvents(inverter, output.power, now));
    await this.publish(
      inverter,
      inverterStates(inverter.device.external_id, {
        awake: true,
        power: output.power,
        inputs: output.inputs.map((i) => i.power),
        energyToday: inverter.day?.value,
        energyTotal: index.publish,
        limit: inverter.limitSupported === false ? undefined : inverter.limit,
        on: inverter.switchSupported ? inverter.on : undefined,
        alarms: inverter.alarms,
      }),
      events,
    );
  }

  /** The alarms and on/off every 5 minutes, the information and limit every hour. */
  async readSlowData(inverter, client, events) {
    const now = this.now();
    if (now - inverter.alarmsAt >= PACING.ALARMS) {
      try {
        const alarms = alarmsOf((await client.alarm()).data);
        for (const id of raisedAlarms(inverter.previousAlarms, alarms)) {
          events.push(alarmEvent(id, this.who(inverter)));
        }
        inverter.previousAlarms = alarms;
        inverter.alarms = alarms;
        if (inverter.switchSupported) {
          inverter.on = onOffOf((await client.onOff()).data) ?? inverter.on;
        }
        inverter.alarmsAt = now;
      } catch (err) {
        this.logger.debug?.(`${inverter.device.name}: alarms unavailable (${err.message})`);
      }
    }
    if (now - inverter.infoAt >= PACING.INFO) {
      try {
        const answer = await client.deviceInfo();
        inverter.info = deviceInfoOf(answer.data, answer.deviceId);
        if (inverter.limitSupported !== false) {
          const variant = inverter.limitVariant ?? LIMIT_VARIANTS.STANDARD;
          inverter.limit = limitOf((await client.maxPower(variant)).data) ?? inverter.limit;
        }
        inverter.infoAt = now;
      } catch (err) {
        this.logger.debug?.(`${inverter.device.name}: information unavailable (${err.message})`);
      }
    }
  }

  /** A reading failed. Three in a row: asleep (the night) or unreachable (by day). */
  async missed(inverter, err) {
    const now = this.now();
    inverter.misses += 1;
    if (err.code === 'mismatch') {
      // The address now belongs to another inverter (DHCP): look for this one.
      const host = this.hosts.get(inverter.hostKey);
      if (host) {
        host.serial = undefined;
      }
    }
    if (!err.silent) {
      this.logger.warn(`${inverter.device.name}: ${err.message}`);
    }
    if (inverter.misses < MISSES_BEFORE_ASLEEP) {
      return; // a hiccup: the EZ1 drops a request now and then
    }
    // Asleep: nobody answers (no error page, no other inverter), it had
    // little or no production at its last answer (the evening), and not for a
    // whole day. Otherwise something is wrong: unreachable.
    const silentFor = now - (inverter.lastSeenAt ?? this.startedAt);
    let status;
    if (!err.silent || silentFor >= LONG_SILENCE) {
      status = 'unreachable';
    } else if (SILENT.has(inverter.status)) {
      status = inverter.status;
    } else {
      status = (inverter.output?.power ?? 0) < AWAKE_POWER ? 'asleep' : 'unreachable';
    }
    const asleep = status === 'asleep';
    if (status !== inverter.status) {
      this.logger.info(
        `${inverter.device.name} ${asleep ? 'is asleep (no sun)' : 'does not answer'}: ${err.message}`,
      );
    }
    inverter.status = status;
    inverter.nextAt = now + PACING.ASLEEP;
    // Only a sleeping inverter stops producing for sure; an unreachable one
    // is unknown, its production state waits.
    const events = asleep ? this.productionEvents(inverter, 0, now) : [];
    await this.publish(
      inverter,
      inverterStates(inverter.device.external_id, {
        awake: false,
        inputs: Array.from({ length: inverter.inputs }, () => 0),
      }),
      events,
    );
  }

  /** Who an event is about: the device (the trigger field), its name and serial. */
  who(inverter) {
    return {
      deviceId: inverter.device.external_id,
      name: inverter.device.name,
      serial: inverter.serial,
    };
  }

  productionEvents(inverter, power, now) {
    const step = productionStep(inverter.production, power, now);
    inverter.production = step.state;
    const event = productionEvent(step.event, {
      ...this.who(inverter),
      power,
      energyToday: inverter.day?.value,
    });
    return event ? [event] : [];
  }

  async publish(inverter, states, events) {
    await this.gladys
      .publishChangedStates(states, { heartbeat: 30 * 60_000 })
      .catch((err) => this.logger.warn(`${inverter.device.name}: states failed: ${err.message}`));
    for (const event of events) {
      await this.gladys
        .publishSceneEvent(event.key, event.data)
        .catch((err) => this.logger.warn(`Scene event ${event.key} failed: ${err.message}`));
    }
  }

  // --- Commands --------------------------------------------------------------------

  createdInverter(externalId) {
    const parsed = parseExternalId(externalId);
    const inverter = parsed && this.createdInverters().find((i) => i.serial === parsed.serial);
    if (!inverter) {
      throw new Error(`Unknown APsystems inverter ${externalId}`);
    }
    return inverter;
  }

  /** The queue of a created inverter, for a command. */
  commandClient(inverter) {
    if (!inverter.hostKey) {
      throw new Error(`${inverter.device.name}: no address known, type it in the configuration.`);
    }
    return this.client(inverter.hostKey);
  }

  /** A command on a sleeping inverter cannot work: say why. */
  commandError(inverter, err) {
    if (err instanceof Ez1Error && err.silent) {
      return new Error(
        `${inverter.device.name} does not answer (${err.message}): it sleeps without sun, try again once it produces.`,
      );
    }
    if (err instanceof Ez1Error && err.code === 'unsupported') {
      return new Error(`${inverter.device.name}: its firmware does not offer this command.`);
    }
    return new Error(`${inverter.device.name}: ${err.message}`);
  }

  /** The devices of the ECU gateways: read-only in this version. */
  static isGatewayDevice(externalId) {
    return Boolean(parseEcuExternalId(externalId) || parseEcuInverterExternalId(externalId));
  }

  async setValue(device, feature, value) {
    if (ApsystemsApp.isGatewayDevice(device.external_id)) {
      throw new Error(
        `${featureKey(feature.external_id)} is read-only (ECU devices are read-only)`,
      );
    }
    const inverter = this.createdInverter(device.external_id);
    const key = featureKey(feature.external_id);
    if (key === FEATURE.LIMIT) {
      await this.applyLimit(inverter, value);
    } else if (key === FEATURE.SWITCH) {
      await this.applySwitch(inverter, Number(value) === 1);
    } else {
      throw new Error(`${key} is read-only`);
    }
  }

  /**
   * Set the power limit. Never written on the integration's own initiative,
   * and not rewritten when the inverter already has it: whether the EZ1
   * keeps it in flash memory is not documented, so writes stay rare.
   */
  async applyLimit(inverter, value) {
    const watts = Math.round(Number(value));
    const { min, max } = this.bounds(inverter);
    if (inverter.limitSupported === false) {
      throw new Error(`${inverter.device.name}: its firmware offers no power limit.`);
    }
    if (!Number.isFinite(watts) || watts < min || watts > max) {
      throw new Error(
        `${inverter.device.name}: the power limit goes from ${min} to ${max} W (asked: ${value}).`,
      );
    }
    const client = this.commandClient(inverter);
    const variant = inverter.limitVariant ?? LIMIT_VARIANTS.STANDARD;
    let applied;
    try {
      const current = limitOf((await client.maxPower(variant)).data);
      applied =
        current === watts
          ? current
          : (limitOf((await client.setMaxPower(watts, variant)).data) ?? watts);
    } catch (err) {
      throw this.commandError(inverter, err);
    }
    inverter.limit = applied;
    await this.gladys
      .publishState(ids.feature(inverter.device.external_id, FEATURE.LIMIT), applied)
      .catch((err) => this.logger.warn(`Limit state failed: ${err.message}`));
    return applied;
  }

  async applySwitch(inverter, on) {
    if (!inverter.switchSupported) {
      throw new Error(`${inverter.device.name}: its firmware offers no on/off command.`);
    }
    let result;
    try {
      result = onOffOf((await this.commandClient(inverter).setOnOff(on)).data) ?? on;
    } catch (err) {
      throw this.commandError(inverter, err);
    }
    inverter.on = result;
    if (AWAKE.has(inverter.status)) {
      inverter.status = result ? inverter.status : 'off';
    }
    await this.gladys
      .publishState(ids.feature(inverter.device.external_id, FEATURE.SWITCH), result ? 1 : 0)
      .catch((err) => this.logger.warn(`Switch state failed: ${err.message}`));
  }

  // --- Scene actions -----------------------------------------------------------------

  async setPowerLimit(fields = {}) {
    if (ApsystemsApp.isGatewayDevice(fields.inverter)) {
      throw new Error('The power limit is not available through an ECU gateway (read-only).');
    }
    const inverter = this.createdInverter(fields.inverter);
    const limit = await this.applyLimit(inverter, fields.value);
    return { limit };
  }

  /**
   * The production of one inverter or of all of them, from the last
   * readings (the loop reads every `poll_interval`); only an inverter never
   * tried since the start is read first. No event: no scene loop.
   */
  async getProduction(fields = {}) {
    // An ECU (or a micro-inverter behind one): its last reading, never an extra query.
    const gateways = this.gateways.production(fields.inverter || undefined) ?? [];
    let inverters = [];
    if (!fields.inverter) {
      inverters = this.createdInverters();
    } else if (!ApsystemsApp.isGatewayDevice(fields.inverter)) {
      inverters = [this.createdInverter(fields.inverter)];
    }
    if (inverters.length + gateways.length === 0) {
      throw new Error('No APsystems inverter device yet: add one in Discovery.');
    }
    await Promise.all(
      inverters
        .filter((i) => i.status === 'waiting' && i.misses === 0)
        .map((i) => this.refreshInverter(i)),
    );
    const sum = (values, digits) =>
      Number(values.reduce((total, value) => total + (value ?? 0), 0).toFixed(digits));
    const rows = [
      ...inverters.map((i) => ({
        power: AWAKE.has(i.status) ? i.output?.power : 0,
        energyToday: i.day?.value ?? lastValueOf(i.device, FEATURE.ENERGY_TODAY),
        energyTotal: i.index?.value,
        status: i.status,
      })),
      ...gateways,
    ];
    const totals = rows.map((r) => r.energyTotal);
    return {
      power: sum(
        rows.map((r) => r.power),
        1,
      ),
      energy_today: sum(
        rows.map((r) => r.energyToday),
        3,
      ),
      energy_total: totals.every((t) => t !== undefined && t !== null) ? sum(totals, 3) : null,
      producing: rows.some((r) => r.status === 'producing'),
      sleeping: rows.every((r) => r.status === 'asleep'),
      inverters: rows.length,
    };
  }

  // --- Widget ------------------------------------------------------------------------

  async getWidget(key, { settings = {}, language } = {}) {
    const ez1 = this.createdInverters().map((i) => ({
      kind: 'ez1',
      name: i.device.name,
      deviceId: i.device.external_id,
      status: i.status,
      power: i.output?.power ?? 0,
      inputs: i.output
        ? i.output.inputs.map((input) => input.power)
        : Array.from({ length: i.inputs }, () => 0),
      energyToday: i.day?.value ?? lastValueOf(i.device, FEATURE.ENERGY_TODAY) ?? null,
      energyTotal: i.index?.value ?? null,
      limit: i.limitSupported === false ? null : (i.limit ?? null),
      alarms: i.alarms,
    }));
    const inverters = [...ez1, ...this.gateways.widgetEntries()];
    return solarWidget({ inverters, deviceId: settings.inverter, language: language ?? 'en' });
  }

  // --- Configuration screen button -----------------------------------------------------

  async testConnection() {
    const invalid = [
      ...(this.config.invalidHosts.length > 0 ? [T.invalidHosts(this.config.invalidHosts)] : []),
      ...(this.config.invalidEcuHosts.length > 0
        ? [T.invalidEcuHosts(this.config.invalidEcuHosts)]
        : []),
    ];
    if (this.config.hosts.length === 0 && this.config.ecuHosts.length === 0) {
      return invalid.length > 0 ? joinTexts(T.noHost, ...invalid) : T.noHost;
    }
    const lines = await Promise.all(
      this.config.hosts.map(async ({ key }) => {
        const client = this.client(key);
        try {
          const answer = await client.deviceInfo();
          const info = deviceInfoOf(answer.data, answer.deviceId);
          const output = outputOf((await client.outputData()).data);
          return T.test.answers(key, info, output);
        } catch (err) {
          return err.silent ? T.test.silent(key, err.message) : T.test.failed(key, err.message);
        }
      }),
    );
    lines.push(...(await this.gateways.testLines()), ...invalid);
    return { en: lines.map((l) => l.en).join('\n'), fr: lines.map((l) => l.fr).join('\n') };
  }
}
