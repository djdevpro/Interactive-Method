import { YtError } from '../errors.js';
import type { Route } from './pool.js';
import type { Proxy } from './types.js';

export interface TransportRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * How a request reaches YouTube through a route (`null`: the machine's own
 * address). Redirects are never followed: the client checks where they lead.
 * A transport that cannot use a kind of proxy throws `PROXY_UNSUPPORTED`.
 */
export type Transport = (request: TransportRequest, route: Route) => Promise<Response>;

/** Headers a relay reads and answers. */
export const RELAY_HEADERS = {
  target: 'x-ytmax-target',
  headers: 'x-ytmax-headers',
  key: 'x-ytmax-key',
  setCookie: 'x-ytmax-set-cookie',
  location: 'x-ytmax-location',
} as const;

const encoder = new TextEncoder();

function base64Url(text: string): string {
  let binary = '';
  for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * The request as a relay takes it: sent to the relay itself, the real
 * address and headers carried in headers of its own, so that a browser
 * forwards the ones it would refuse to set (Cookie, User-Agent, Origin).
 */
export function relayRequest(
  proxy: Proxy,
  request: TransportRequest,
): [string, RequestInit] {
  const headers: Record<string, string> = {
    [RELAY_HEADERS.target]: request.url,
    [RELAY_HEADERS.headers]: base64Url(JSON.stringify(request.headers ?? {})),
  };
  if (proxy.key !== null) headers[RELAY_HEADERS.key] = proxy.key;
  if (request.headers?.['Content-Type'])
    headers['content-type'] = request.headers['Content-Type'];
  if (request.headers?.Range) headers.range = request.headers.Range;
  return [
    proxy.url,
    {
      method: request.method ?? 'GET',
      headers,
      body: request.body,
      signal: request.signal,
      credentials: 'omit',
      redirect: 'manual',
    },
  ];
}

/**
 * The cookies a response sets: from a relay's header, else from
 * `Set-Cookie` where the runtime lets it be read (Node, Deno, Bun, workers;
 * never a browser).
 */
export function setCookiesOf(response: Response): string[] {
  const relayed = response.headers.get(RELAY_HEADERS.setCookie);
  if (relayed) {
    try {
      const list: unknown = JSON.parse(relayed);
      if (Array.isArray(list)) return list.filter((v): v is string => typeof v === 'string');
    } catch {
      // A relay of another version: fall through.
    }
  }
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const joined = response.headers.get('set-cookie');
  return joined ? joined.split(/,(?=\s*[^;,=\s]+=)/) : [];
}

/** Where a redirect leads, a relay's or not. */
export function locationOf(response: Response): string | null {
  return (
    response.headers.get(RELAY_HEADERS.location) ?? response.headers.get('location')
  );
}

/**
 * A transport over `fetch`: direct, or through relays. A classic proxy needs
 * a transport of its runtime (`nodeTransport`, the extension's own).
 */
export function fetchTransport(fetchImpl: typeof fetch = globalThis.fetch): Transport {
  return async (request, route) => {
    if (route === null)
      return fetchImpl(request.url, {
        method: request.method ?? 'GET',
        headers: request.headers,
        body: request.body,
        signal: request.signal,
        credentials: 'omit',
        redirect: 'manual',
      });
    if (route.kind === 'relay') return fetchImpl(...relayRequest(route, request));
    throw new YtError('PROXY_UNSUPPORTED', route.kind);
  };
}
