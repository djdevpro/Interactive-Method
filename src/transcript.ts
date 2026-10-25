import type { Transcript, TranscriptLine, VideoInfo } from './types.js';
import { watchUrl } from './video-id.js';

/**
 * The lines of a transcript in YouTube's JSON3 format (`fmt=json3`): one per
 * event that holds words, its pieces joined, its spaces folded.
 */
export function parseJson3(json3: unknown): TranscriptLine[] {
  const events =
    typeof json3 === 'object' && json3 !== null
      ? (json3 as { events?: unknown }).events
      : undefined;
  if (!Array.isArray(events)) return [];
  const lines: TranscriptLine[] = [];
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue;
    const { tStartMs, dDurationMs, segs } = event as Record<string, unknown>;
    if (typeof tStartMs !== 'number' || !Array.isArray(segs)) continue;
    const text = segs
      .map((seg) =>
        typeof (seg as { utf8?: unknown })?.utf8 === 'string' ? (seg as { utf8: string }).utf8 : '',
      )
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (text === '') continue;
    lines.push({
      start: tStartMs / 1000,
      duration: typeof dDurationMs === 'number' ? dDurationMs / 1000 : 0,
      text,
    });
  }
  return lines;
}

export type TranscriptFormat = 'text' | 'timed-text' | 'srt' | 'vtt' | 'json' | 'markdown';

export const TRANSCRIPT_FORMATS: Record<TranscriptFormat, { extension: string; mime: string }> = {
  text: { extension: 'txt', mime: 'text/plain' },
  'timed-text': { extension: 'txt', mime: 'text/plain' },
  srt: { extension: 'srt', mime: 'application/x-subrip' },
  vtt: { extension: 'vtt', mime: 'text/vtt' },
  json: { extension: 'json', mime: 'application/json' },
  markdown: { extension: 'md', mime: 'text/markdown' },
};

/** `m:ss`, or `h:mm:ss` from an hour on. */
export function formatTimestamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** `hh:mm:ss,mmm` (SRT) or `hh:mm:ss.mmm` (VTT). */
function clock(seconds: number, separator: ',' | '.'): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = String(Math.floor(ms / 3_600_000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0');
  return `${h}:${m}:${s}${separator}${String(ms % 1000).padStart(3, '0')}`;
}

/** Where a line ends: its duration, cut where the next one starts. */
function endOf(lines: readonly TranscriptLine[], index: number): number {
  const line = lines[index]!;
  const next = lines[index + 1];
  const end = line.start + (line.duration || 2);
  return next ? Math.min(end, next.start) : end;
}

/** The transcript as a file of one of the usual formats. */
export function formatTranscript(
  transcript: Transcript,
  format: TranscriptFormat,
  video?: Pick<VideoInfo, 'title' | 'author'>,
): string {
  const { lines } = transcript;
  switch (format) {
    case 'text':
      return lines.map((line) => line.text).join('\n');
    case 'timed-text':
      return lines.map((line) => `[${formatTimestamp(line.start)}] ${line.text}`).join('\n');
    case 'srt':
      return lines
        .map(
          (line, i) =>
            `${i + 1}\n${clock(line.start, ',')} --> ${clock(endOf(lines, i), ',')}\n${line.text}\n`,
        )
        .join('\n');
    case 'vtt':
      return `WEBVTT\nLanguage: ${transcript.language}\n\n${lines
        .map((line, i) => `${clock(line.start, '.')} --> ${clock(endOf(lines, i), '.')}\n${line.text}\n`)
        .join('\n')}`;
    case 'json':
      return JSON.stringify(transcript, null, 2);
    case 'markdown': {
      const head = video ? `# ${video.title}\n\n${video.author} · ${watchUrl(transcript.videoId)}\n\n` : '';
      return (
        head +
        lines
          .map((line) => `[${formatTimestamp(line.start)}](${watchUrl(transcript.videoId, line.start)}) ${line.text}`)
          .join('  \n')
      );
    }
  }
}

/** A name a file may bear on every system: the title, then the language of the track. */
export function transcriptFileName(
  video: Pick<VideoInfo, 'title'>,
  transcript: Pick<Transcript, 'language' | 'automatic'>,
  format: TranscriptFormat,
): string {
  const title =
    video.title
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100)
      .trim() || 'video';
  return `${title} (${transcript.language}${transcript.automatic ? ' auto' : ''}).${TRANSCRIPT_FORMATS[format].extension}`;
}
