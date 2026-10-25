import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { YouTubeClient } from '../client.js';
import type { VideoInfo, VideoStream } from '../types.js';
import { watchUrl } from '../video-id.js';
import { CommandError, ensureAbsent, jsonText, outputFile, publishFile, removeOwned, temporaryPath, writeNew } from './files.js';

const PIECE_BYTES = 8 * 1024 * 1024;

function selectStream(video: VideoInfo, height: number, extension: string): { stream: VideoStream; hasAudio: boolean } {
  const wanted = extension === '.mp4' ? 'video/mp4' : 'video/webm';
  const choices = [...video.streams.muxed.map(stream => ({ stream, hasAudio: true })),
    ...video.streams.video.map(stream => ({ stream, hasAudio: false }))]
    .map(choice => ({ ...choice, height: Number(/^(\d+)p/.exec(choice.stream.quality ?? '')?.[1] ?? 0) }))
    .filter(choice => choice.stream.mime.split(';')[0] === wanted && choice.height > 0 && choice.height <= height)
    .sort((a, b) => b.height - a.height || Number(b.hasAudio) - Number(a.hasAudio));
  const choice = choices[0];
  if (!choice) throw new CommandError('STREAM_UNAVAILABLE', `No direct ${wanted} stream at or below ${height}p. Try the other container, a higher --max-height, or a supplied local video.`);
  return choice;
}

/** Writes stream chunks directly to disk; memory never scales with video size. */
export async function downloadVideo(client: YouTubeClient, video: VideoInfo, options: {
  out: string; maxHeight: number; maxBytes: number;
}): Promise<object> {
  const out = await outputFile(options.out);
  const extension = extname(out).toLowerCase();
  if (extension !== '.mp4' && extension !== '.webm') throw new CommandError('USAGE', 'Download output must use .mp4 or .webm.');
  const { stream, hasAudio } = selectStream(video, options.maxHeight, extension);
  if (stream.size !== null && stream.size > options.maxBytes) throw new CommandError('DOWNLOAD_TOO_LARGE', 'Stream exceeds --max-mb; select a lower resolution or increase the explicit limit.');
  const sidecar = `${out}.json`; await ensureAbsent(sidecar);
  const temporary = temporaryPath(out); const written: string[] = [];
  const file = await open(temporary, 'wx');
  const hash = createHash('sha256');
  let received = 0; let expected = stream.size; let failures = 0;
  try {
    for (;;) {
      if (expected !== null && received >= expected) break;
      const begin = received;
      const end = Math.min(received + PIECE_BYTES - 1, (expected ?? options.maxBytes) - 1);
      if (end < begin) throw new CommandError('DOWNLOAD_TOO_LARGE', 'Stream exceeds --max-mb.');
      const signal = AbortSignal.timeout(60_000);
      let response: Response;
      try { response = await client.readStreamRange(video, stream, begin, end, signal); }
      catch (error) {
        if (++failures >= 3) throw new CommandError('DOWNLOAD_NETWORK', `Media request failed after three attempts: ${error instanceof Error ? error.message : 'network error'}`);
        continue;
      }
      if (![200, 206].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        throw new CommandError(response.status === 429 ? 'RATE_LIMITED' : 'DOWNLOAD_HTTP', `Media server returned HTTP ${response.status}. Signed URLs may have expired; acquire the video again.`);
      }
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') ?? '');
      if ((response.status === 206 && !range) || (range && Number(range[1]) !== received) || (!range && received > 0)) {
        await response.body?.cancel().catch(() => undefined);
        throw new CommandError('DOWNLOAD_RANGE', 'Media server returned an unexpected byte range.');
      }
      const declaredSize = range ? Number(range[3]) : Number(response.headers.get('content-length')) || null;
      if (declaredSize !== null && (!Number.isSafeInteger(declaredSize) || declaredSize <= 0 || declaredSize > options.maxBytes)) {
        await response.body?.cancel().catch(() => undefined);
        throw new CommandError('DOWNLOAD_TOO_LARGE', 'Invalid or excessive media size.');
      }
      if (expected !== null && declaredSize !== null && expected !== declaredSize) {
        await response.body?.cancel().catch(() => undefined);
        throw new CommandError('DOWNLOAD_SIZE', 'Media size changed between requests.');
      }
      expected ??= declaredSize;
      const reader = response.body?.getReader();
      if (!reader) throw new CommandError('DOWNLOAD_EMPTY', 'Media response has no body.');
      let interrupted = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (received + value.length > (expected ?? options.maxBytes)) throw new CommandError('DOWNLOAD_SIZE', 'Media response exceeds its declared or allowed size.');
          let offset = 0;
          while (offset < value.length) {
            const { bytesWritten } = await file.write(value, offset, value.length - offset, received + offset);
            if (!bytesWritten) throw new CommandError('DOWNLOAD_WRITE', 'Could not write media chunk.');
            offset += bytesWritten;
          }
          hash.update(value); received += value.length;
        }
      } catch (error) {
        if (error instanceof CommandError) throw error;
        interrupted = true;
        if (++failures >= 3) throw new CommandError('DOWNLOAD_NETWORK', 'Media transfer interrupted three times.');
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      if (!interrupted && response.status === 200 && received > 0 && expected === null) break;
      if (received === begin && !interrupted && ++failures >= 3) throw new CommandError('DOWNLOAD_EMPTY', 'Media server repeatedly returned an empty body.');
      if (received > begin && !interrupted) failures = 0;
    }
    if (received === 0 || (expected !== null && received !== expected)) throw new CommandError('DOWNLOAD_INCOMPLETE', 'Media transfer did not reach the complete declared size.');
    await file.close();
    await publishFile(temporary, out); written.push(out);
    const manifest = { schema: 'yt-max.download/v1', downloadedAt: new Date().toISOString(),
      source: { videoId: video.id, url: watchUrl(video.id), title: video.title, author: video.author, lengthSeconds: video.lengthSeconds },
      file: basename(out), bytes: received, sha256: hash.digest('hex'), itag: stream.itag, mime: stream.mime,
      quality: stream.quality, hasAudio, note: hasAudio ? 'Muxed video and audio stream.' : 'Video-only stream for visual analysis; audio was not downloaded.' };
    await writeNew(sidecar, jsonText(manifest)); written.push(sidecar);
    return { out, manifest: sidecar, ...manifest };
  } catch (error) { await removeOwned(written); throw error; }
  finally { await file.close().catch(() => undefined); await removeOwned([temporary]); }
}
