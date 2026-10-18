// -----------------------------------------------------------------------------
// Constants of the APsystems integration (EZ1 local API, ECU gateways).
// -----------------------------------------------------------------------------

/** The EZ1 local API listens on this port once "Local mode" is on. */
export const DEFAULT_PORT = 8050;

export const USER_AGENT = 'gladys-apsystems/0.1 (+https://github.com/LM1LC3N7/gladys-apsystems)';
/**
 * The EZ1 answers over its own Wi-Fi, slowly: Home Assistant waits 8 s, the
 * openHAB binding saw timeouts with 1 s. 8 s per request, one at a time.
 */
export const HTTP_TIMEOUT = 8_000;

/** At most this many inverters in the `hosts` field. */
export const MAX_INVERTERS = 20;

/**
 * The pace (see CLAUDE.md). The output data at the configured interval (30 s
 * by default, never below 10), the rest much slower: nothing else moves fast.
 */
export const PACING = {
  /** Alarms and the on/off status. */
  ALARMS: 5 * 60_000,
  /** Device information (firmware, IP, bounds) and the current power limit. */
  INFO: 60 * 60_000,
  /** One attempt while the inverter is asleep (no sun, no Wi-Fi). */
  ASLEEP: 5 * 60_000,
  /** A configured address that never answered yet (asleep at start). */
  PROBE: 5 * 60_000,
};

/** Consecutive failed readings before an inverter counts as asleep. */
export const MISSES_BEFORE_ASLEEP = 3;
/**
 * An inverter that vanished while producing at least this much did not fall
 * asleep: the sun was up. It is reported unreachable (Wi-Fi, address).
 */
export const AWAKE_POWER = 50;
/** Silent for a whole day: even a dark winter day wakes an EZ1 up. */
export const LONG_SILENCE = 24 * 60 * 60_000;
/** A silence this long between two readings starts a new solar day. */
export const NEW_DAY_GAP = 3 * 60 * 60_000;
/** The margin of the EZ1 lifetime index guard (src/guard.js), on top of 1.5 x its max power. */
export const EZ1_INDEX_SLACK_KWH = 0.2;

/**
 * Production started / stopped, with hysteresis: started after a minute at
 * 10 W or more, stopped after 15 minutes under 5 W (or asleep).
 */
export const PRODUCTION = {
  ON_W: 10,
  OFF_W: 5,
  START_AFTER: 60_000,
  STOP_AFTER: 15 * 60_000,
};

/** The documented bounds of the EZ1-M, used until the inverter says its own. */
export const DEFAULT_LIMITS = { min: 30, max: 800 };

// Modified port of HAEdwin/homeassistant-apsystems_ecu_reader 2.15.0 (const.py:
// PORT, DEFAULT_SCAN_INTERVAL, DEFAULT_PORT_RETRIES) and ksheumaker/homeassistant-
// apsystems_ecur (the 5 s socket pause), Apache-2.0: see THIRD_PARTY_NOTICES.md.
/**
 * The APsystems ECU gateways (ECU-B, ECU-R, ECU-C), TCP port 8899. The ECU
 * is known to hang when it is queried too often: the reference
 * (HAEdwin/homeassistant-apsystems_ecu_reader) recommends 300 s and queries
 * one ECU at a time; ksheumaker's original waited 5 s around each query.
 * Here: a reading every `ecu_poll_interval` (300 s by default and at least),
 * one connection at a time for all the ECUs, PAUSE between two queries, and
 * after a failure a wait that doubles (never shorter than the interval).
 */
export const ECU = {
  PORT: 8899,
  /** At most this many ECUs in the `ecu_hosts` field. */
  MAX: 10,
  /** One query: connect, ask, whole answer (the reference waits 5 to 10 s). */
  TIMEOUT: 10_000,
  /** Between two queries, whichever the ECU. */
  PAUSE: 5_000,
  /** Connection attempts per query (the reference's port_retries). */
  CONNECT_ATTEMPTS: 2,
  /** The longest wait after failures (or the interval, if longer). */
  BACKOFF_MAX: 30 * 60_000,
  /** Failed readings in a row before the ECU is reported (red status). */
  MISSES_BEFORE_UNREACHABLE: 3,
  /**
   * The lifetime index may rise by at most this much power per inverter the
   * ECU knows (kW) over the time since the last published value, plus
   * INDEX_SLACK_KWH, over two intervals at least; a bigger jump, or a fall, is held (src/guard.js).
   */
  INDEX_KW_PER_INVERTER: 2,
  /** The inverters assumed when the ECU says neither how many it knows nor lists them. */
  UNKNOWN_INVERTERS: 80,
  INDEX_SLACK_KWH: 0.5,
};

/** Alarm ids (forever: values of the `alarm` field of inverter_alarm). */
export const ALARMS = {
  OFF_GRID: 'off_grid',
  OUTPUT_FAULT: 'output_fault',
  DC_SHORT_CIRCUIT: 'dc_short_circuit',
};

/** Manifest keys (forever: stored in user scenes and dashboards). */
export const ACTIONS = { TEST: 'test_connection', ACCEPT_INDEX: 'accept_index' };
export const SCENE_ACTIONS = { SET_POWER_LIMIT: 'set_power_limit', PRODUCTION: 'get_production' };
export const SCENE_TRIGGERS = {
  STARTED: 'production_started',
  STOPPED: 'production_stopped',
  ALARM: 'inverter_alarm',
};
export const WIDGETS = { SOLAR: 'solar' };
