import { YtError } from '../errors.js';
import type {
  AudioStream,
  CaptionTrack,
  Streams,
  TranscriptChoice,
  VideoInfo,
  VideoStream,
} from '../types.js';

// What YouTube's player answer is turned into. Pure: nothing is fetched here.

/* eslint-disable @typescript-eslint/no-explicit-any -- YouTube's answer is untyped. */
type Player = any;

/** A stream address on YouTube's video servers, or an error. */
export function streamUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new YtError('INVALID_RESPONSE', 'stream url');
  }
  if (
    u.protocol !== 'https:' ||
    u.username ||
    u.password ||
    u.port ||
    !u.hostname.endsWith('.googlevideo.com') ||
    u.pathname !== '/videoplayback'
  )
    throw new YtError('INVALID_RESPONSE', 'stream url');
  return u;
}

function captionUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new YtError('INVALID_RESPONSE', 'caption url');
  }
  const host = u.hostname === 'youtube.com' || u.hostname.endsWith('.youtube.com');
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !host || u.pathname !== '/api/timedtext')
    throw new YtError('INVALID_RESPONSE', 'caption url');
  return u;
}

function thumbnailOf(details: Player): string | null {
  let best: { url: string; width: number } | null = null;
  for (const t of details?.thumbnail?.thumbnails ?? []) {
    let u: URL;
    try {
      u = new URL(t.url);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' || !/(^|\.)ytimg\.com$/.test(u.hostname)) continue;
    if (best === null || (t.width || 0) > best.width) best = { url: u.href, width: t.width || 0 };
  }
  return best?.url ?? null;
}

function textOf(value: Player): string | null {
  if (typeof value?.simpleText === 'string') return value.simpleText;
  if (Array.isArray(value?.runs)) return value.runs.map((run: Player) => run?.text ?? '').join('');
  return null;
}

/**
 * The streams YouTube gives a direct address for: none behind DRM, and none
 * that needs the `n` transform, without which YouTube slows it to a crawl.
 */
function streamsOf(p: Player, remember: (u: URL) => void): Streams {
  const streams: Streams = { video: [], audio: [], muxed: [] };
  for (const [key, formats] of [
    ['muxed', p.streamingData?.formats],
    ['adaptive', p.streamingData?.adaptiveFormats],
  ] as const) {
    for (const f of formats ?? []) {
      if (!f.url || f.drmFamilies?.length || !/^(video|audio)\//.test(f.mimeType || '')) continue;
      const u = streamUrl(f.url);
      if (u.searchParams.has('n')) continue;
      remember(u);
      const length = Number(f.contentLength ?? u.searchParams.get('clen'));
      const size = Number.isSafeInteger(length) && length > 0 ? length : null;
      if (f.mimeType.startsWith('audio/')) {
        const item: AudioStream = {
          itag: f.itag,
          mime: f.mimeType,
          url: f.url,
          size,
          bitrate: f.bitrate || null,
          language: f.audioTrack?.id || null,
          default: f.audioTrack?.audioIsDefault ?? null,
          drc: f.isDrc === true || /(^|:)drc=1/.test(u.searchParams.get('xtags') || ''),
        };
        if (key === 'adaptive') streams.audio.push(item);
      } else {
        const item: VideoStream = {
          itag: f.itag,
          mime: f.mimeType,
          url: f.url,
          size,
          quality: f.qualityLabel || null,
          fps: f.fps || null,
        };
        streams[key === 'muxed' ? 'muxed' : 'video'].push(item);
      }
    }
  }
  return streams;
}

/** `fr` of `fr-FR.4`, `fr-CA` or `fr`. */
export const primaryLanguage = (code: unknown): string =>
  String(code || '')
    .toLowerCase()
    .split(/[-_.]/)[0] ?? '';

/**
 * The language spoken, as far as YouTube tells it: the audio track it calls
 * original (the others are dubbings), else the one its captions start from,
 * else the only language its speech recognition ran on.
 */
function spokenLanguage(p: Player, list: Player, tracks: Player[]): string {
  const sounds = (p.streamingData?.adaptiveFormats ?? [])
    .map((f: Player) => f.audioTrack)
    .filter((sound: Player) => typeof sound?.id === 'string');
  const original =
    sounds.find((sound: Player) => /original/i.test(sound.displayName || '')) ||
    sounds.find((sound: Player) => sound.audioIsDefault === true);
  if (original) return primaryLanguage(original.id);
  const audio = list?.audioTracks?.[list?.defaultAudioTrackIndex || 0];
  if (typeof audio?.audioTrackId === 'string') return primaryLanguage(audio.audioTrackId);
  const recognised = new Set(
    tracks.filter((t) => t.kind === 'asr').map((t) => primaryLanguage(t.languageCode)),
  );
  return recognised.size === 1 ? [...recognised][0]! : '';
}

/**
 * Whether YouTube refused the address, not the video: it asks to sign in
 * "to confirm you're not a bot". A private or age-restricted video asks to
 * sign in too, for a reason that says so; another address changes nothing.
 */
export function refusedAsRobot(p: Player): boolean {
  const status = p?.playabilityStatus?.status;
  const reason = String(p?.playabilityStatus?.reason || '');
  return (
    (status === 'LOGIN_REQUIRED' && !/\bage\b|private/i.test(reason)) ||
    /\bbot\b/i.test(reason)
  );
}

export interface ProjectOptions {
  /** Languages wanted for the transcript, best first (`['fr', 'en']`); empty: the one spoken. */
  languages?: readonly string[];
  /** When no track is in a wanted language, let YouTube translate the best one (`tlang`). */
  translate?: boolean;
}

function chooseTrack(
  p: Player,
  list: Player,
  tracks: Player[],
  spoken: string,
  options: ProjectOptions,
): { track: Player; translateTo: string | null } | { track: null; reason: 'NO_CAPTIONS' | 'LANGUAGE_UNAVAILABLE' } {
  if (tracks.length === 0) return { track: null, reason: 'NO_CAPTIONS' };
  const wanted = (options.languages ?? []).map((l) => l.toLowerCase().replaceAll('_', '-'));
  const written = (list: Player[]) => list.find((t) => t.kind !== 'asr') ?? list[0];
  for (const lang of wanted) {
    const exact = tracks.filter((t) => t.languageCode.toLowerCase() === lang);
    const matches = exact.length
      ? exact
      : tracks.filter((t) => primaryLanguage(t.languageCode) === primaryLanguage(lang));
    if (matches.length) return { track: written(matches), translateTo: null };
  }
  // The language spoken, written before recognised: never the track of a
  // dubbing YouTube lists first.
  const said = tracks.filter((t) => primaryLanguage(t.languageCode) === spoken);
  const best =
    written(said) ??
    tracks[list?.audioTracks?.[list?.defaultAudioTrackIndex || 0]?.defaultCaptionTrackIndex] ??
    written(tracks);
  if (wanted.length === 0) return { track: best, translateTo: null };
  if (options.translate && best?.isTranslatable !== false)
    return { track: best, translateTo: wanted[0]! };
  return { track: null, reason: 'LANGUAGE_UNAVAILABLE' };
}

/** What the SDK tells of a video, from YouTube's player answer. */
export function projectPlayer(p: Player, id: string, options: ProjectOptions = {}): VideoInfo {
  const status = p?.playabilityStatus?.status;
  if (status !== 'OK') {
    if (refusedAsRobot(p)) throw new YtError('BOT_CHECK');
    throw new YtError('UNPLAYABLE', [status, p?.playabilityStatus?.reason].filter(Boolean).join(': ') || 'PLAYER_ERROR');
  }
  const details = p.videoDetails;
  if (details?.videoId !== id) throw new YtError('VIDEO_MISMATCH');
  const list = p.captions?.playerCaptionsTracklistRenderer;
  const tracks: Player[] = (list?.captionTracks ?? []).filter(
    (t: Player) => typeof t?.baseUrl === 'string' && typeof t?.languageCode === 'string',
  );
  let expires: number | null = null;
  const remember = (u: URL) => {
    const expire = Number(u.searchParams.get('expire'));
    if (Number.isFinite(expire) && expire > 0) expires = expires === null ? expire : Math.min(expires, expire);
  };
  const streams = streamsOf(p, remember);
  const spoken = spokenLanguage(p, list, tracks);
  const choice = chooseTrack(p, list, tracks, spoken, options);
  let transcript: TranscriptChoice;
  if ('reason' in choice) transcript = { url: null, reason: choice.reason };
  else {
    remember(captionUrl(choice.track.baseUrl));
    // The signed parameters are kept byte for byte; only `fmt` and `tlang` change.
    const raw = String(choice.track.baseUrl).split('#', 1)[0]!;
    const q = raw.indexOf('?');
    const parts = (q < 0 ? '' : raw.slice(q + 1))
      .split('&')
      .filter((part) => part && !/^(fmt|tlang)=/.test(part));
    parts.push('fmt=json3');
    if (choice.translateTo) parts.push(`tlang=${encodeURIComponent(choice.translateTo)}`);
    transcript = {
      language: choice.translateTo ?? choice.track.languageCode,
      name: textOf(choice.track.name),
      automatic: choice.track.kind === 'asr',
      url: (q < 0 ? raw : raw.slice(0, q)) + '?' + parts.join('&'),
    };
  }
  const length = Number(details.lengthSeconds);
  const captions: CaptionTrack[] = tracks.map((t) => ({
    language: t.languageCode,
    name: textOf(t.name),
    automatic: t.kind === 'asr',
  }));
  return {
    id,
    title: typeof details.title === 'string' ? details.title : '',
    author: typeof details.author === 'string' ? details.author : '',
    channelId: typeof details.channelId === 'string' ? details.channelId : null,
    description: typeof details.shortDescription === 'string' ? details.shortDescription : '',
    lengthSeconds: Number.isFinite(length) && length > 0 ? length : null,
    thumbnail: thumbnailOf(details),
    isLive: details.isLiveContent === true && !(length > 0),
    captions,
    spokenLanguage: spoken,
    transcript,
    expires,
    streams,
  };
}
