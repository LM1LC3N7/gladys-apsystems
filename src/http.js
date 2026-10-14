// -----------------------------------------------------------------------------
// The only place that talks to the network: one GET on the LAN, with a
// timeout, no redirect, JSON expected. The tests replace `fetch` with
// `setFetch()`.
// -----------------------------------------------------------------------------

import { HTTP_TIMEOUT, USER_AGENT } from './constants.js';

let fetchImpl = (...args) => globalThis.fetch(...args);

/** Replace the fetch implementation (tests only). Returns the previous one. */
export function setFetch(impl) {
  const previous = fetchImpl;
  fetchImpl = impl;
  return previous;
}

/**
 * A failed request. `code` is one of:
 *   timeout      no answer in time (an EZ1 asleep at night, mostly)
 *   network      refused, unreachable, DNS (asleep too, or a wrong address)
 *   unsupported  404: this firmware has no such endpoint
 *   http         another HTTP status
 *   protocol     an answer that is not the EZ1 JSON
 *   failed       the EZ1 answered "message": "FAILED"
 *   mismatch     another inverter answers at this address
 */
export class Ez1Error extends Error {
  constructor(code, message, { status } = {}) {
    super(message);
    this.name = 'Ez1Error';
    this.code = code;
    this.status = status;
  }

  /** Nobody answered: the night, or a wrong address. */
  get silent() {
    return this.code === 'timeout' || this.code === 'network';
  }
}

/** GET a JSON document on the LAN; resolves the parsed body. */
export async function getJson(url, { timeout = HTTP_TIMEOUT } = {}) {
  const path = new URL(url).pathname;
  let response;
  let text;
  try {
    response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(Math.max(1, timeout)),
    });
    text = await response.text();
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Ez1Error('timeout', `no answer within ${Math.round(timeout / 1000)} s`);
    }
    const cause = err?.cause?.code ?? err?.code;
    throw new Ez1Error('network', cause ? `${cause}` : (err?.message ?? String(err)));
  }
  if (response.status === 404) {
    throw new Ez1Error('unsupported', `${path} is not supported by this firmware`, {
      status: 404,
    });
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Ez1Error('http', `HTTP ${response.status} on ${path}`, { status: response.status });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Ez1Error('protocol', `${path} did not answer JSON: is this an APsystems EZ1?`);
  }
}
