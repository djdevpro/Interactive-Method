/**
 * A way out to YouTube other than the machine's own address.
 *
 * - `http`, `https`, `socks4`, `socks5`: a classic proxy, `scheme://user:pass@host:port`.
 *   Plain `fetch` cannot use one: give the client a transport that can
 *   (`nodeTransport` from the local Node module, or a supplied transport).
 * - `relay`: an HTTP endpoint that forwards the request (see `apps/relay`, a
 *   Cloudflare Worker). Works from anywhere `fetch` does, browsers included,
 *   and carries the headers a browser may not set (Cookie, User-Agent).
 */
export type ProxyKind = 'http' | 'https' | 'socks4' | 'socks5' | 'relay';

export interface ProxyConfig {
  /** Stable id, used for health and sessions; defaults to the URL without credentials. */
  id?: string;
  url: string;
  /** Forced kind; otherwise read from the URL scheme (`relay+https://…` for a relay). */
  kind?: ProxyKind;
  /** Relative share of the traffic (default 1). */
  weight?: number;
  /** Shared secret a relay expects (`X-Ytmax-Key`). */
  key?: string;
  label?: string;
}

export interface Proxy {
  id: string;
  kind: ProxyKind;
  /** For a relay: its endpoint. Otherwise the proxy URL, credentials included. */
  url: string;
  host: string;
  port: number | null;
  username: string | null;
  password: string | null;
  weight: number;
  key: string | null;
  label: string;
}

/** What happened through a route, as the pool learns it. */
export type ProxyOutcome =
  | { type: 'ok'; latencyMs: number }
  /** YouTube flagged the address ("confirm you're not a bot"). */
  | { type: 'bot' }
  /** A plain HTTP 403 from YouTube. */
  | { type: 'blocked' }
  | { type: 'rate-limited'; retryAfterMs?: number }
  /** The proxy itself failed: refused, timed out, bad gateway. */
  | { type: 'network' };

export type RotationStrategy =
  /** One after the other. */
  | 'round-robin'
  /** At random, by weight. */
  | 'random'
  /**
   * By weight × success rate × speed, avoiding the route used last and those
   * cooling down after a refusal; the default.
   */
  | 'smart';

/**
 * When the machine's own address is used:
 * `fallback` only when every proxy is cooling down (default when proxies are given),
 * `first` before any proxy, `never`, or `mix` as one more member of the rotation.
 */
export type DirectPolicy = 'fallback' | 'first' | 'never' | 'mix';

export interface ProxyHealth {
  id: string;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  /** Epoch ms before which the pool does not pick it. */
  cooldownUntil: number;
  /** Moving average of successful calls, ms. */
  latencyMs: number | null;
  lastUsedAt: number;
  lastOutcome: ProxyOutcome['type'] | null;
}
