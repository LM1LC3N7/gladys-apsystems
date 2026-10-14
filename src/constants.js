// -----------------------------------------------------------------------------
// Constants of the APsystems EZ1 integration.
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
/** A lifetime index lower than the last one is published only once confirmed. */
export const INDEX_CONFIRMATIONS = 3;

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

/** Alarm ids (forever: values of the `alarm` field of inverter_alarm). */
export const ALARMS = {
  OFF_GRID: 'off_grid',
  OUTPUT_FAULT: 'output_fault',
  DC_SHORT_CIRCUIT: 'dc_short_circuit',
};

/** Manifest keys (forever: stored in user scenes and dashboards). */
export const ACTIONS = { TEST: 'test_connection' };
export const SCENE_ACTIONS = { SET_POWER_LIMIT: 'set_power_limit', PRODUCTION: 'get_production' };
export const SCENE_TRIGGERS = {
  STARTED: 'production_started',
  STOPPED: 'production_stopped',
  ALARM: 'inverter_alarm',
};
export const WIDGETS = { SOLAR: 'solar' };
