import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { YtError } from './errors.js';
import type { Route } from './proxy/pool.js';
import { fetchTransport, type Transport } from './proxy/transport.js';

/**
 * A transport for Node through HTTP(S) proxies (undici's `ProxyAgent`, one
 * per proxy, kept), relays and the direct address. SOCKS proxies need a
 * dispatcher of one's own: pass `dispatcherFor`.
 */
export function nodeTransport(
  options: {
    dispatcherFor?: (route: NonNullable<Route>) => unknown;
  } = {},
): Transport {
  const agents = new Map<string, ProxyAgent>();
  const plain = fetchTransport();
  return async (request, route) => {
    if (route === null || route.kind === 'relay') return plain(request, route);
    let dispatcher = options.dispatcherFor?.(route);
    if (dispatcher === undefined) {
      if (route.kind !== 'http' && route.kind !== 'https')
        throw new YtError('PROXY_UNSUPPORTED', route.kind);
      let agent = agents.get(route.id);
      if (agent === undefined) {
        agent = new ProxyAgent(route.url);
        agents.set(route.id, agent);
      }
      dispatcher = agent;
    }
    const response = await undiciFetch(request.url, {
      method: request.method ?? 'GET',
      headers: request.headers,
      body: request.body,
      signal: request.signal,
      redirect: 'manual',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dispatcher: dispatcher as any,
    });
    return response as unknown as Response;
  };
}
