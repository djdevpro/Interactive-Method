import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import type { TranscriptResult } from '../client.js';
import { formatTranscript } from '../transcript.js';
import type { Transcript, TranscriptLine, VideoInfo } from '../types.js';
import { videoIdOf, watchUrl } from '../video-id.js';
import { CommandError, ensureAbsent, jsonText, localFile, removeOwned, required, sha256, writeNew } from './files.js';

export function publicVideo(video: VideoInfo): Omit<VideoInfo, 'streams' | 'transcript'> & { transcript: object } {
  const { streams: _streams, transcript, ...metadata } = video;
  const { url: _url, ...track } = transcript;
  return { ...metadata, transcript: track };
}

function validateLines(lines: unknown): TranscriptLine[] {
  if (!Array.isArray(lines) || lines.length === 0) throw new CommandError('EMPTY_TRANSCRIPT', 'No timestamped transcript lines found.');
  let lastStart = -1;
  return lines.map((value, index) => {
    if (typeof value !== 'object' || value === null) throw new CommandError('INVALID_TRANSCRIPT', `Invalid line ${index + 1}.`);
    const { start, duration, text } = value as Record<string, unknown>;
    if (typeof start !== 'number' || !Number.isFinite(start) || start < lastStart || start < 0 ||
        typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 ||
        typeof text !== 'string' || !text.trim()) throw new CommandError('INVALID_TRANSCRIPT', `Line ${index + 1} needs ordered, nonnegative start/duration and nonempty text.`);
    lastStart = start;
    return { start, duration, text: text.trim() };
  });
}

export async function saveAcquisition(options: {
  directory: string;
  video: object & { id: string; title: string; author: string };
  transcript: Transcript;
  mode: 'innertube' | 'file-import';
  source: object;
}): Promise<object> {
  const transcript = { ...options.transcript, lines: validateLines(options.transcript.lines) };
  const directory = resolve(options.directory);
  await mkdir(directory, { recursive: true });
  const files = ['video.json', 'transcript.json', 'transcript.srt', 'transcript.md', 'acquisition.json'];
  for (const file of files) await ensureAbsent(join(directory, file));
  const manifest = {
    schema: 'yt-max.acquisition/v1', acquiredAt: new Date().toISOString(), mode: options.mode,
    videoId: transcript.videoId, videoUrl: watchUrl(transcript.videoId), source: options.source,
    language: transcript.language, automatic: transcript.automatic, lineCount: transcript.lines.length,
    transcriptEndSeconds: transcript.lines.reduce((end, line) => Math.max(end, line.start + line.duration), 0), files,
  };
  const contents = [jsonText(options.video), jsonText(transcript), `${formatTranscript(transcript, 'srt')}\n`,
    `${formatTranscript(transcript, 'markdown', options.video)}\n`, jsonText(manifest)];
  const written: string[] = [];
  try {
    for (let i = 0; i < files.length; i++) { const path = join(directory, files[i]!); await writeNew(path, contents[i]!); written.push(path); }
  } catch (error) { await removeOwned(written); throw error; }
  return { directory, ...manifest };
}

export async function collectResult(result: TranscriptResult, directory: string): Promise<object> {
  return saveAcquisition({ directory, video: publicVideo(result.video), transcript: result.transcript,
    mode: 'innertube', source: { type: 'youtube-captions', url: watchUrl(result.video.id) } });
}

function cueTime(value: string): number {
  const parts = value.replace(',', '.').split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !Number.isFinite(part) || part < 0) ||
      parts.at(-1)! >= 60 || (parts.length === 3 && parts[1]! >= 60)) throw new CommandError('INVALID_TRANSCRIPT', 'Invalid subtitle timestamp.');
  return parts.reduce((seconds, part) => seconds * 60 + part, 0);
}

function parseSubtitles(content: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const block of content.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n\s*\n/)) {
    if (/^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(block.trimStart())) continue;
    const rows = block.split('\n');
    const at = rows.findIndex(row => row.includes('-->'));
    if (at === -1) continue;
    const match = /^\s*((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}[.,]\d{3})/.exec(rows[at]!);
    if (!match) throw new CommandError('INVALID_TRANSCRIPT', 'Malformed subtitle cue.');
    const start = cueTime(match[1]!);
    const end = cueTime(match[2]!);
    const text = rows.slice(at + 1).join(' ').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
    if (text) lines.push({ start, duration: end - start, text });
  }
  return validateLines(lines);
}

export async function importTranscript(file: string, options: {
  video: string; directory: string; source: string; title?: string; author?: string; language?: string;
}): Promise<object> {
  const id = videoIdOf(options.video);
  if (!id) throw new CommandError('INVALID_VIDEO', 'The import needs a valid --video URL or ID.');
  const source = required(options.source, '--source');
  const path = await localFile(file);
  if ((await stat(path)).size > 25 * 1024 * 1024) throw new CommandError('INPUT_TOO_LARGE', 'Transcript imports are limited to 25 MiB.');
  const text = await readFile(path, 'utf8');
  let transcript: Transcript;
  let automaticStatusKnown = false;
  if (extname(path).toLowerCase() === '.json') {
    const data: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    const object = typeof data === 'object' && data !== null && !Array.isArray(data) ? data as Record<string, unknown> : {};
    if (object.videoId !== undefined && object.videoId !== id) throw new CommandError('VIDEO_MISMATCH', 'Imported transcript videoId differs from --video.');
    automaticStatusKnown = typeof object.automatic === 'boolean';
    transcript = { videoId: id, language: options.language ?? (typeof object.language === 'string' ? object.language : 'und'),
      automatic: object.automatic === true, lines: validateLines(Array.isArray(data) ? data : object.lines) };
  } else if (['.srt', '.vtt'].includes(extname(path).toLowerCase())) {
    transcript = { videoId: id, language: options.language ?? 'und', automatic: false, lines: parseSubtitles(text) };
  } else throw new CommandError('INPUT_FORMAT', 'Import accepts .srt, .vtt or .json with timestamped lines.');
  const video = { id, title: options.title ?? id, author: options.author ?? '', url: watchUrl(id), metadataVerified: false };
  return saveAcquisition({ directory: options.directory, transcript, mode: 'file-import', video,
    source: { type: 'local-transcript', description: source, fileName: basename(path), sha256: await sha256(path),
      automaticStatusKnown, metadata: 'Title and author are supplied by the caller, not fetched from YouTube.' } });
}
