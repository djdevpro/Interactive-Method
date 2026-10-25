import { YtError } from './errors.js';
import { type ClientProfile, InnerTube } from './innertube/client.js';
import { projectPlayer, type ProjectOptions } from './innertube/project.js';
import { ProxyPool, type ProxyPoolOptions, type Route } from './proxy/pool.js';
import type { ProxyConfig, ProxyHealth, ProxyOutcome } from './proxy/types.js';
import { fetchTransport, locationOf, type Transport } from './proxy/transport.js';
import { parseJson3 } from './transcript.js';
import type { Stream, Transcript, VideoInfo } from './types.js';
import { videoIdOf } from './video-id.js';

export interface YouTubeClientOptions {
  /** Proxies to rotate through: URLs, `host:port:user:pass` lines, configs. */
  proxies?: ProxyPoolOptions['proxies'];
  rotation?: ProxyPoolOptions['strategy'];
  direct?: ProxyPoolOptions['direct'];
  /** Health saved by `client.proxyHealth()`, to carry it across restarts. */
  proxyHealth?: ProxyHealth[];
  /** Or a pool of one's own, shared between clients. */
  pool?: ProxyPool;
  /** How requests reach YouTube; default: `fetch`, direct or through relays. */
  transport?: Transport;
  fetch?: typeof fetch;
  client?: ClientProfile;
  timeoutMs?: number;
  maxAttempts?: number;
  onAttempt?: (event: { route: string; outcome: ProxyOutcome['type']; attempt: number }) => void;
}

export interface VideoOptions extends ProjectOptions {
  signal?: AbortSignal;
}

export interface TranscriptResult {
  video: VideoInfo;
  transcript: Transcript;
  /** The proxy id the answer came through, or `direct`. */
  route: string;
}

/**
 * YouTube without an API key: what a video is, its caption tracks, its
 * transcript and its streams, through a rotation of proxies when given.
 *
 * ```ts
 * const yt = createYouTubeClient({ proxies: ['http://user:pass@1.2.3.4:8080'] });
 * const { video, transcript } = await yt.getTranscript('https://youtu.be/jNQXAC9IVRw', { languages: ['fr', 'en'] });
 * ```
 */
export class YouTubeClient {
  readonly pool: ProxyPool;
  private readonly innertube: InnerTube;
  private readonly transport: Transport;
  /** The route each video's addresses were issued to, for the transcript. */
  private readonly routes = new Map<string, Route>();

  constructor(options: YouTubeClientOptions = {}) {
    this.pool =
      options.pool ??
      new ProxyPool({
        proxies: options.proxies,
        strategy: options.rotation,
        direct: options.direct,
        health: options.proxyHealth,
      });
    this.transport = options.transport ?? fetchTransport(options.fetch);
    this.innertube = new InnerTube({
      transport: this.transport,
      pool: this.pool,
      client: options.client,
      timeoutMs: options.timeoutMs,
      maxAttempts: options.maxAttempts,
      onAttempt: options.onAttempt,
    });
  }

  /** What a video is, its caption tracks, the one picked, and its streams. */
  async getVideo(idOrUrl: string, options: VideoOptions = {}): Promise<VideoInfo> {
    const id = videoIdOf(idOrUrl);
    if (id === null) throw new YtError('INVALID_VIDEO');
    const { value, route } = await this.innertube.player(id, options.signal);
    this.routes.set(id, route);
    return projectPlayer(value, id, options);
  }

  /** The transcript of a video in the language asked for, or the one spoken. */
  async getTranscript(idOrUrl: string, options: VideoOptions = {}): Promise<TranscriptResult> {
    const video = await this.getVideo(idOrUrl, options);
    const transcript = await this.readTranscript(video, options.signal);
    return { video, transcript, route: this.routeOf(video.id) };
  }

  /** The lines of the transcript `getVideo` picked. */
  async readTranscript(video: VideoInfo, signal?: AbortSignal): Promise<Transcript> {
    if (video.transcript.url === null) throw new YtError(video.transcript.reason);
    let { url, language } = video.transcript;
    let value: string;
    try {
      ({ value } = await this.innertube.text(url, this.routes.get(video.id), signal));
    } catch (error) {
      // YouTube answers its translations with 429 more often than not: the
      // track it would have translated is better than nothing.
      const original = new URL(url);
      if (!(error instanceof YtError) || error.code !== 'RATE_LIMITED' || !original.searchParams.has('tlang'))
        throw error;
      original.searchParams.delete('tlang');
      url = original.href;
      language = original.searchParams.get('lang') ?? language;
      ({ value } = await this.innertube.text(url, this.routes.get(video.id), signal));
    }
    let json: unknown;
    try {
      json = JSON.parse(value);
    } catch {
      throw new YtError('INVALID_RESPONSE', 'transcript');
    }
    return {
      videoId: video.id,
      language,
      automatic: video.transcript.automatic,
      lines: parseJson3(json),
    };
  }

  proxyHealth(): ProxyHealth[] {
    return this.pool.snapshot();
  }

  /** Read a bounded byte range on the same route that issued the signed stream URL. */
  async readStreamRange(video: VideoInfo, stream: Stream, start: number, end: number, signal?: AbortSignal): Promise<Response> {
    let url = new URL(stream.url);
    if (!this.routes.has(video.id) || ![...video.streams.video, ...video.streams.audio, ...video.streams.muxed].some(candidate => candidate === stream))
      throw new YtError('INVALID_RESPONSE', 'stream must come from this client video');
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start >= 8 * 1024 * 1024)
      throw new YtError('INVALID_RESPONSE', 'invalid byte range');
    for (let redirects = 0; redirects <= 4; redirects++) {
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.googlevideo.com') || url.username || url.password)
        throw new YtError('INVALID_RESPONSE', 'unexpected media host');
      const response = await this.transport({ url: url.href, headers: { Range: `bytes=${start}-${end}` }, signal }, this.routes.get(video.id)!);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = locationOf(response);
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new YtError('INVALID_RESPONSE', 'media redirect without location');
      url = new URL(location, url);
    }
    throw new YtError('INVALID_RESPONSE', 'too many media redirects');
  }

  private routeOf(id: string): string {
    const route = this.routes.get(id);
    return route ? route.id : 'direct';
  }
}

export function createYouTubeClient(options?: YouTubeClientOptions): YouTubeClient {
  return new YouTubeClient(options);
}

export type { ProxyConfig };
