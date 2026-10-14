// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, MAX_INVERTERS } from './constants.js';

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = {
  hosts: '',
  poll_interval: 30,
};

/** The bounds of `poll_interval` (seconds): the EZ1 is slow, never below 10. */
export const BOUNDS = { poll_interval: { min: 10, max: 300 } };

const number = (value, fallback, { min, max }) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * One entry of `hosts`: "192.168.1.50", "192.168.1.50:8050", "ez1.lan",
 * "http://192.168.1.50:8050/". Resolves { key, host, port } or undefined.
 */
export function parseHost(entry) {
  const text = String(entry ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  const match = /^([^:/\s]+)(?::(\d{1,5}))?$/.exec(text);
  if (!match) {
    return undefined;
  }
  const host = match[1].toLowerCase();
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  // Digits and dots only: an IPv4 address or nothing ("300.1.1.1" is no host name).
  const valid = /^[\d.]+$/.test(host) ? IPV4.test(host) : HOSTNAME.test(host);
  if (!valid || port < 1 || port > 65535) {
    return undefined;
  }
  return { key: `${host}:${port}`, host, port };
}

/**
 * The `hosts` field: entries separated by commas, semicolons or new lines
 * (not spaces: "my inverter" is a typo to report, not two host names).
 * Duplicates are dropped; an invalid entry is reported by its position.
 */
export function parseHosts(text) {
  const hosts = [];
  const invalid = [];
  const entries = String(text ?? '')
    .split(/[,;\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const [index, entry] of entries.entries()) {
    const parsed = parseHost(entry);
    if (!parsed) {
      invalid.push(index + 1);
    } else if (!hosts.some((h) => h.key === parsed.key) && hosts.length < MAX_INVERTERS) {
      hosts.push(parsed);
    }
  }
  return { hosts, invalid };
}

export function normalizeConfig(raw = {}) {
  const { hosts, invalid } = parseHosts(raw.hosts ?? DEFAULTS.hosts);
  return {
    hosts,
    invalidHosts: invalid,
    pollInterval: number(raw.poll_interval, DEFAULTS.poll_interval, BOUNDS.poll_interval),
  };
}
