import type { Proxy, ProxyConfig, ProxyKind } from './types.js';

const KINDS: Record<string, ProxyKind> = {
  'http:': 'http',
  'https:': 'https',
  'socks:': 'socks5',
  'socks4:': 'socks4',
  'socks5:': 'socks5',
  'socks5h:': 'socks5',
};

/** The URL without its credentials: an id that can be shown and stored. */
function publicId(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
}

/**
 * A proxy from its config, or from a line in one of the usual forms:
 * `http://user:pass@host:port`, `socks5://host:port`, `host:port`,
 * `host:port:user:pass` (as proxy sellers list them), `relay+https://relay.example.dev`.
 */
export function parseProxy(input: string | ProxyConfig): Proxy {
  const config: ProxyConfig = typeof input === 'string' ? { url: input } : input;
  let text = config.url.trim();
  let kind = config.kind;
  if (text.startsWith('relay+')) {
    kind = 'relay';
    text = text.slice('relay+'.length);
  }
  if (!/^[a-z0-9+]+:\/\//i.test(text)) {
    const parts = text.split(':');
    // host:port:user:pass
    if (parts.length === 4)
      text = `http://${encodeURIComponent(parts[2]!)}:${encodeURIComponent(parts[3]!)}@${parts[0]}:${parts[1]}`;
    else text = `http://${text}`;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError(`Invalid proxy: ${config.url}`);
  }
  kind ??= KINDS[url.protocol];
  if (kind === undefined)
    throw new TypeError(`Unknown proxy scheme: ${url.protocol}`);
  const port = url.port === '' ? null : Number(url.port);
  return {
    id: config.id ?? publicId(url),
    kind,
    url: url.href,
    host: url.hostname,
    port,
    username: url.username === '' ? null : decodeURIComponent(url.username),
    password: url.password === '' ? null : decodeURIComponent(url.password),
    weight: config.weight !== undefined && config.weight > 0 ? config.weight : 1,
    key: config.key ?? null,
    label: config.label ?? `${url.hostname}${port === null ? '' : `:${port}`}`,
  };
}

/** Every proxy of a text, one per line; blank lines and `#` comments are skipped. */
export function parseProxyList(text: string): Proxy[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .map((line) => parseProxy(line));
}
