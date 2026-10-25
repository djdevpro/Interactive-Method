import { YtError } from '../errors.js';
import { type ProxyPool, type Route, routeId } from '../proxy/pool.js';
import type { ProxyOutcome } from '../proxy/types.js';
import { setCookiesOf, type Transport, type TransportRequest } from '../proxy/transport.js';

// YouTube's own API (InnerTube), as its visionOS application calls it: that
// client gets direct stream addresses and caption addresses that need no
// proof-of-origin token, from an anonymous visitor session.

const ORIGIN = 'https://www.youtube.com';

export interface ClientProfile {
  clientName: string;
  clientVersion: string;
  /** The number YouTube knows the client by (`X-Youtube-Client-Name`). */
  clientId: string;
  userAgent: string;
  context: Record<string, string>;
}

export const VISIONOS_CLIENT: ClientProfile = Object.freeze({
  clientName: 'VISIONOS',
  clientVersion: '1.02',
  clientId: '101',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  context: {
    deviceMake: 'Apple',
    deviceModel: 'RealityDevice17,1',
    osName: 'visionOS',
    osVersion: '26.5.23O471',
    hl: 'en',
    gl: 'US',
  },
});

const FORMAT_FIELDS =
  'itag,mimeType,qualityLabel,fps,bitrate,contentLength,url,audioTrack,isDrc,drmFamilies';
const FIELDS =
  'playabilityStatus(status,reason),' +
  `streamingData(formats(${FORMAT_FIELDS}),adaptiveFormats(${FORMAT_FIELDS})),` +
  'videoDetails(videoId,title,author,channelId,lengthSeconds,isLiveContent,shortDescription,thumbnail(thumbnails(url,width,height))),' +
  'captions(playerCaptionsTracklistRenderer(captionTracks(baseUrl,languageCode,kind,name,isTranslatable),audioTracks(defaultCaptionTrackIndex,audioTrackId),defaultAudioTrackIndex))';
const PLAYER = `${ORIGIN}/youtubei/v1/player?prettyPrint=false&fields=${encodeURIComponent(FIELDS)}`;
const MAX_BODY = 4 * 1024 * 1024;

interface Session {
  visitor: string;
  cookie: string;
  until: number;
}

export interface InnerTubeOptions {
  transport: Transport;
  pool: ProxyPool;
  client?: ClientProfile;
  /** Per request (default 15 s). */
  timeoutMs?: number;
  /** How long a visitor session is reused on one route (default 3 min). */
  sessionTtlMs?: number;
  /** Attempts per call, each on another route when there is one (default 4). */
  maxAttempts?: number;
  now?: () => number;
  /** Called on each refused attempt, for logs: no URL, cookie or video data. */
  onAttempt?: (event: { route: string; outcome: ProxyOutcome['type']; attempt: number }) => void;
}

export interface Fetched<T> {
  value: T;
  route: Route;
}

/** How a failure counts against the route it went through; `null`: not the route's fault. */
function outcomeOf(error: unknown): ProxyOutcome | null {
  if (!(error instanceof YtError)) return { type: 'network' };
  switch (error.code) {
    case 'BOT_CHECK':
      return { type: 'bot' };
    case 'RATE_LIMITED':
      return {
        type: 'rate-limited',
        retryAfterMs: typeof error.detail === 'number' ? error.detail : undefined,
      };
    case 'UPSTREAM_HTTP':
      return error.detail === 403 ? { type: 'blocked' } : { type: 'network' };
    case 'NETWORK':
    case 'TIMEOUT':
    case 'INVALID_RESPONSE':
      return { type: 'network' };
    default:
      return null;
  }
}

export class InnerTube {
  private readonly sessions = new Map<string, Session>();
  private readonly transport: Transport;
  private readonly pool: ProxyPool;
  private readonly client: ClientProfile;
  private readonly timeoutMs: number;
  private readonly sessionTtlMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;
  private readonly onAttempt: InnerTubeOptions['onAttempt'];

  constructor(options: InnerTubeOptions) {
    this.transport = options.transport;
    this.pool = options.pool;
    this.client = options.client ?? VISIONOS_CLIENT;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.sessionTtlMs = options.sessionTtlMs ?? 180_000;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.now = options.now ?? Date.now;
    this.onAttempt = options.onAttempt;
  }

  /** YouTube's player answer for a video, through the first route that is not refused. */
  player(videoId: string, signal?: AbortSignal): Promise<Fetched<unknown>> {
    return this.withRoutes(signal, async (route) => {
      const session = await this.sessionOf(route, signal);
      const { text } = await this.read(
        {
          url: PLAYER,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': this.client.userAgent,
            'X-Youtube-Client-Name': this.client.clientId,
            'X-Youtube-Client-Version': this.client.clientVersion,
            'X-Goog-Visitor-Id': session.visitor,
            ...(session.cookie ? { Cookie: session.cookie } : {}),
            Origin: ORIGIN,
          },
          body: JSON.stringify({
            context: {
              client: {
                clientName: this.client.clientName,
                clientVersion: this.client.clientVersion,
                ...this.client.context,
                userAgent: this.client.userAgent,
                visitorData: session.visitor,
              },
            },
            videoId,
            contentCheckOk: true,
            racyCheckOk: true,
          }),
          signal,
        },
        route,
      );
      let player: { playabilityStatus?: { status?: string; reason?: string } };
      try {
        player = JSON.parse(text);
      } catch {
        throw new YtError('INVALID_RESPONSE', 'player');
      }
      const status = player.playabilityStatus?.status;
      const reason = String(player.playabilityStatus?.reason ?? '');
      if (status === 'LOGIN_REQUIRED') this.sessions.delete(routeId(route));
      if ((status === 'LOGIN_REQUIRED' && !/\bage\b|private/i.test(reason)) || /\bbot\b/i.test(reason))
        throw new YtError('BOT_CHECK');
      return player;
    });
  }

  /**
   * A text from YouTube (a transcript, say), through `preferred` first — the
   * route its address was issued to — then any other.
   */
  text(url: string, preferred: Route | undefined, signal?: AbortSignal): Promise<Fetched<string>> {
    return this.withRoutes(
      signal,
      async (route) =>
        (
          await this.read(
            { url, headers: { 'User-Agent': this.client.userAgent }, signal },
            route,
          )
        ).text,
      preferred,
    );
  }

  /** Tries routes in turn while the failure is the route's, telling the pool each outcome. */
  private async withRoutes<T>(
    signal: AbortSignal | undefined,
    run: (route: Route) => Promise<T>,
    preferred?: Route,
  ): Promise<Fetched<T>> {
    const tried = new Set<string>();
    let last: unknown = new YtError('NETWORK', 'no route');
    let lastOutcome: ProxyOutcome['type'] | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (signal?.aborted) throw new YtError('ABORTED');
      let route =
        attempt === 1 && preferred !== undefined ? preferred : this.pool.pick(tried);
      if (route === undefined) {
        // Every route tried once: start over with fresh sessions, which only
        // helps against a refused session, not against a rate limit.
        if (lastOutcome !== 'bot' && lastOutcome !== 'network') break;
        tried.clear();
        this.sessions.clear();
        route = this.pool.pick(tried);
        if (route === undefined) break;
      }
      tried.add(routeId(route));
      const started = this.now();
      try {
        const value = await run(route);
        this.pool.report(route, { type: 'ok', latencyMs: this.now() - started });
        return { value, route };
      } catch (error) {
        if (signal?.aborted) throw new YtError('ABORTED');
        const outcome = outcomeOf(error);
        if (outcome === null) throw error;
        this.pool.report(route, outcome);
        this.sessions.delete(routeId(route));
        this.onAttempt?.({ route: routeId(route), outcome: outcome.type, attempt });
        last = error;
        lastOutcome = outcome.type;
      }
    }
    throw last;
  }

  private async sessionOf(route: Route, signal?: AbortSignal): Promise<Session> {
    const id = routeId(route);
    const known = this.sessions.get(id);
    if (known && known.until > this.now()) return known;
    const { text, response } = await this.read(
      {
        url: `${ORIGIN}/sw.js_data`,
        headers: {
          'User-Agent': this.client.userAgent,
          'Accept-Language': 'en-US',
          Referer: `${ORIGIN}/sw.js`,
        },
        signal,
      },
      route,
    );
    if (!text.startsWith(")]}'")) throw new YtError('INVALID_RESPONSE', 'session');
    let data: unknown;
    try {
      data = JSON.parse(text.slice(4));
    } catch {
      throw new YtError('INVALID_RESPONSE', 'session');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const visitor = (data as any)?.[0]?.[2]?.[0]?.[0]?.[13];
    if (typeof visitor !== 'string' || !visitor || visitor.length > 8192)
      throw new YtError('INVALID_RESPONSE', 'session');
    const session: Session = {
      visitor,
      cookie: setCookiesOf(response)
        .map((cookie) => cookie.split(';', 1)[0])
        .filter(Boolean)
        .join('; '),
      until: this.now() + this.sessionTtlMs,
    };
    this.sessions.set(id, session);
    return session;
  }

  /** One request, its body read whole (bounded), its failures as `YtError`s. */
  private async read(
    request: TransportRequest,
    route: Route,
  ): Promise<{ text: string; response: Response }> {
    const abort = new AbortController();
    const stop = () => abort.abort();
    const timer = setTimeout(stop, this.timeoutMs);
    request.signal?.addEventListener('abort', stop, { once: true });
    let response: Response;
    try {
      try {
        response = await this.transport({ ...request, signal: abort.signal }, route);
      } catch (error) {
        if (error instanceof YtError) throw error;
        if (request.signal?.aborted) throw new YtError('ABORTED');
        if (abort.signal.aborted) throw new YtError('TIMEOUT');
        throw new YtError('NETWORK', undefined, { cause: error });
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 429) {
          const after = Number(response.headers.get('retry-after'));
          throw new YtError('RATE_LIMITED', Number.isFinite(after) && after > 0 ? after * 1000 : undefined);
        }
        throw new YtError('UPSTREAM_HTTP', response.status);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new YtError('INVALID_RESPONSE', 'empty');
      const decoder = new TextDecoder();
      let text = '';
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_BODY) throw new YtError('RESPONSE_TOO_LARGE');
          text += decoder.decode(value, { stream: true });
        }
      } catch (error) {
        if (error instanceof YtError) throw error;
        if (abort.signal.aborted) throw new YtError(request.signal?.aborted ? 'ABORTED' : 'TIMEOUT');
        throw new YtError('NETWORK', undefined, { cause: error });
      } finally {
        reader.releaseLock();
      }
      return { text: text + decoder.decode(), response };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', stop);
    }
  }
}
