import { YtError } from './errors.js';
import { formatTranscript, TRANSCRIPT_FORMATS, type TranscriptFormat } from './transcript.js';
import type { Transcript, VideoInfo } from './types.js';
import { watchUrl } from './video-id.js';

/** The version of the JSON a destination receives; raised when its shape changes. */
export const PAYLOAD_SCHEMA = 'yt-max.transcript/v1';

/** What a destination receives as JSON: the video, its transcript, where it comes from. */
export interface TranscriptPayload {
  schema: typeof PAYLOAD_SCHEMA;
  capturedAt: string;
  source: string;
  video: {
    id: string;
    url: string;
    title: string;
    author: string;
    channelId: string | null;
    lengthSeconds: number | null;
    description: string;
    thumbnail: string | null;
  };
  transcript: Transcript & {
    /** The lines joined, without timestamps. */
    text: string;
  };
}

export function transcriptPayload(
  video: VideoInfo,
  transcript: Transcript,
  source = 'yt-max',
): TranscriptPayload {
  return {
    schema: PAYLOAD_SCHEMA,
    capturedAt: new Date().toISOString(),
    source,
    video: {
      id: video.id,
      url: watchUrl(video.id),
      title: video.title,
      author: video.author,
      channelId: video.channelId,
      lengthSeconds: video.lengthSeconds,
      description: video.description,
      thumbnail: video.thumbnail,
    },
    transcript: { ...transcript, text: formatTranscript(transcript, 'text') },
  };
}

/**
 * Any HTTP endpoint that takes the transcript: a webhook (n8n, Make, Zapier),
 * an API of one's own (Rilby), a Notion or Airtable proxy…
 */
export interface Destination {
  id: string;
  name: string;
  url: string;
  method?: 'POST' | 'PUT' | 'PATCH';
  /** Sent as they are: `Authorization: Bearer …`, an API key… */
  headers?: Record<string, string>;
  /** `json` (default) sends `TranscriptPayload`; the others send the file, video in `X-Ytmax-*` headers. */
  format?: TranscriptFormat;
  /**
   * A JSON body of one's own instead of the payload: `{{video.title}}`,
   * `{{transcript.text}}`… are replaced by their values (JSON-escaped).
   */
  template?: string;
  /** Sent on its own each time a video is opened (the extension reads it). */
  auto?: boolean;
  enabled?: boolean;
}

function valueAt(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (value, key) => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined),
    source,
  );
}

/** A template with each `{{path}}` replaced by the value of the payload there, as JSON. */
export function renderTemplate(template: string, payload: TranscriptPayload): string {
  return template.replace(/"?\{\{\s*([\w.]+)\s*\}\}"?/g, (match, path: string) => {
    const value = valueAt(payload, path);
    const quoted = match.startsWith('"') && match.endsWith('"');
    if (value === undefined) return quoted ? '""' : 'null';
    if (quoted || typeof value !== 'string') return JSON.stringify(value);
    // Inside a longer string: escaped, without its quotes.
    return JSON.stringify(value).slice(1, -1);
  });
}

export interface UploadResult {
  status: number;
  /** The start of the answer, for the user to see. */
  body: string;
}

/** Sends a transcript to a destination; throws `UPLOAD_FAILED` on a refusal or a network error. */
export async function uploadTranscript(
  destination: Destination,
  payload: TranscriptPayload,
  options: { fetch?: typeof fetch; signal?: AbortSignal; video?: Pick<VideoInfo, 'title' | 'author'> } = {},
): Promise<UploadResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const format = destination.format ?? 'json';
  const headers: Record<string, string> = { ...destination.headers };
  let body: string;
  if (destination.template) {
    body = renderTemplate(destination.template, payload);
    headers['Content-Type'] ??= 'application/json';
  } else if (format === 'json') {
    body = JSON.stringify(payload);
    headers['Content-Type'] ??= 'application/json';
  } else {
    body = formatTranscript(payload.transcript, format, options.video ?? payload.video);
    headers['Content-Type'] ??= `${TRANSCRIPT_FORMATS[format].mime}; charset=utf-8`;
    headers['X-Ytmax-Video-Id'] = payload.video.id;
    headers['X-Ytmax-Language'] = payload.transcript.language;
    headers['X-Ytmax-Title'] = encodeURIComponent(payload.video.title);
  }
  let response: Response;
  try {
    response = await fetchImpl(destination.url, {
      method: destination.method ?? 'POST',
      headers,
      body,
      signal: options.signal,
    });
  } catch (error) {
    throw new YtError('UPLOAD_FAILED', 'network', { cause: error });
  }
  const text = (await response.text().catch(() => '')).slice(0, 500);
  if (!response.ok) throw new YtError('UPLOAD_FAILED', `${response.status} ${text}`.trim());
  return { status: response.status, body: text };
}
