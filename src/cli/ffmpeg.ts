import { spawn } from 'node:child_process';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandError, ensureAbsent, jsonText, localFile, numberOption, outputFile, publishFile, removeOwned, required, sha256, temporaryPath, writeNew } from './files.js';

type ProcessResult = { stdout: string; stderr: string };
const MAX_OUTPUT = 64 * 1024;

/** No shell interpolation; output and execution time are bounded. */
export function runProcess(executable: string, args: string[], timeoutMs = 120_000): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-MAX_OUTPUT); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-MAX_OUTPUT); });
    child.on('error', error => { clearTimeout(timer); reject(new CommandError('FFMPEG_UNAVAILABLE', error.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new CommandError('FFMPEG_TIMEOUT', 'FFmpeg exceeded the allowed execution time.'));
      else if (code !== 0) reject(new CommandError('FFMPEG_FAILED', `FFmpeg exited with ${code}: ${stderr.trim().slice(-4000)}`));
      else resolvePromise({ stdout, stderr });
    });
  });
}

export async function resolveFfmpeg(): Promise<string> {
  if (process.env.YT_MAX_FFMPEG) return resolve(process.env.YT_MAX_FFMPEG);
  const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, 'bin', executable), join(here, '..', 'bin', executable),
    join(here, '..', '..', '..', 'runtime', 'bin', executable), join(here, '..', '..', '..', '..', 'runtime', 'bin', executable)];
  for (const path of candidates) { try { await access(path); return path; } catch { /* Try next packaged layout. */ } }
  return executable;
}

export async function doctor(): Promise<object> {
  const executable = await resolveFfmpeg();
  const node = process.versions.node.split('.').map(Number);
  const nodeOk = node[0]! > 22 || (node[0] === 22 && node[1]! >= 19);
  try {
    const { stdout } = await runProcess(executable, ['-version'], 15_000);
    return { node: process.versions.node, nodeOk, requiredNode: '>=22.19.0', ffmpeg: executable,
      ffmpegOk: true, ffmpegVersion: stdout.split(/\r?\n/)[0], ready: nodeOk };
  } catch (error) {
    return { node: process.versions.node, nodeOk, requiredNode: '>=22.19.0', ffmpeg: executable,
      ffmpegOk: false, ready: false, message: error instanceof Error ? error.message : String(error),
      action: 'Use the complete platform plugin package, set YT_MAX_FFMPEG to an installed executable, or install FFmpeg on PATH.' };
  }
}

interface CapturePoint { time: number; reason: string; role?: string }

function validatePoint(value: unknown): CapturePoint {
  if (typeof value !== 'object' || value === null) throw new CommandError('USAGE', 'Each capture plan item must be an object.');
  const point = value as Record<string, unknown>;
  if (typeof point.time !== 'number' || !Number.isFinite(point.time) || point.time < 0 || point.time > 172_800)
    throw new CommandError('USAGE', 'Capture times must be seconds between 0 and 172800.');
  const reason = required(point.reason, 'capture reason');
  if (reason.length > 1000) throw new CommandError('USAGE', 'Capture reason is limited to 1000 characters.');
  if (point.role !== undefined && typeof point.role !== 'string') throw new CommandError('USAGE', 'Capture role must be a string.');
  return { time: Math.round(point.time * 1000) / 1000, reason, ...(point.role ? { role: String(point.role) } : {}) };
}

export async function capturePoints(options: { plan?: string; times?: string; reason?: string }): Promise<CapturePoint[]> {
  if (Boolean(options.plan) === Boolean(options.times)) throw new CommandError('USAGE', 'Provide exactly one of --plan or --times.');
  let values: unknown;
  if (options.plan) {
    const path = await localFile(options.plan);
    if ((await stat(path)).size > 128 * 1024) throw new CommandError('INPUT_TOO_LARGE', 'Capture plans are limited to 128 KiB.');
    values = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  } else {
    const reason = required(options.reason, '--reason');
    values = required(options.times, '--times').split(',').map(value => {
      if (!value.trim()) throw new CommandError('USAGE', 'Empty capture timestamp.');
      return { time: Number(value.trim()), reason };
    });
  }
  if (!Array.isArray(values) || values.length < 1 || values.length > 12) throw new CommandError('USAGE', 'Use 1–12 targeted captures per invocation.');
  const points = values.map(validatePoint).sort((a, b) => a.time - b.time);
  if (new Set(points.map(point => point.time)).size !== points.length) throw new CommandError('USAGE', 'Duplicate capture timestamps.');
  return points;
}

export async function extractFrames(input: string, options: {
  directory: string; method: string; points: CapturePoint[]; width?: string; video?: string;
}): Promise<object> {
  const source = await localFile(input);
  const method = required(options.method, '--method');
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(method)) throw new CommandError('USAGE', 'Method ID must use 1–64 letters, numbers, underscores or hyphens.');
  const width = numberOption(options.width, '--width', 1280, 320, 3840);
  if (!Number.isInteger(width)) throw new CommandError('USAGE', '--width must be an integer.');
  const directory = resolve(options.directory);
  await mkdir(directory, { recursive: true });
  const manifestPath = join(directory, 'captures.json');
  const names = options.points.map(point => `${method}-${String(Math.round(point.time * 1000)).padStart(9, '0')}ms.png`);
  for (const name of [...names, 'captures.json']) await ensureAbsent(join(directory, name));
  const ffmpeg = await resolveFfmpeg();
  const written: string[] = []; const temporary: string[] = [];
  const captures: object[] = [];
  try {
    const sourceHash = await sha256(source);
    for (let i = 0; i < options.points.length; i++) {
      const point = options.points[i]!; const path = join(directory, names[i]!);
      const temp = temporaryPath(path); temporary.push(temp);
      await runProcess(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n',
        '-protocol_whitelist', 'file,pipe', '-ss', String(point.time), '-i', source, '-map', '0:v:0',
        '-frames:v', '1', '-an', '-vf', `scale='min(${width},iw)':-2`, '-threads', '2', '-f', 'image2', '-vcodec', 'png', temp]);
      if (!(await stat(temp).catch(() => null))?.size) throw new CommandError('FRAME_MISSING', `No image at ${point.time}s; check video length.`);
      await publishFile(temp, path); written.push(path);
      captures.push({ file: names[i], timestampSeconds: point.time, method, reason: point.reason,
        ...(point.role ? { role: point.role } : {}), sha256: await sha256(path), reviewed: false });
    }
    const manifest = { schema: 'yt-max.captures/v1', createdAt: new Date().toISOString(),
      source: { file: source, sha256: sourceHash, ...(options.video ? { video: options.video } : {}) },
      method, captures, note: 'Candidates extracted at requested times. Visual inspection is still required; identical or uninformative images must be rejected by the analyst.' };
    await writeNew(manifestPath, jsonText(manifest)); written.push(manifestPath);
    return { directory, manifest: manifestPath, ...manifest };
  } catch (error) { await removeOwned(written); throw error; }
  finally { await removeOwned(temporary); }
}

export async function extractClip(input: string, options: { out: string; start?: string; duration?: string }): Promise<object> {
  const source = await localFile(input);
  const out = await outputFile(options.out);
  if (extname(out).toLowerCase() !== '.mp4') throw new CommandError('USAGE', 'Clip output must use .mp4.');
  const start = numberOption(required(options.start, '--start'), '--start', 0, 0, 172_800);
  const duration = numberOption(required(options.duration, '--duration'), '--duration', 0, 0.1, 120);
  const manifestPath = `${out}.json`; await ensureAbsent(manifestPath);
  const temporary = temporaryPath(out); const written: string[] = [];
  try {
    const { stdout } = await runProcess(await resolveFfmpeg(), ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n',
      '-protocol_whitelist', 'file,pipe', '-ss', String(start), '-i', source, '-t', String(duration),
      '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-threads', '2', '-c:a', 'aac', '-movflags', '+faststart', '-progress', 'pipe:1', '-f', 'mp4', temporary], 600_000);
    if (![...stdout.matchAll(/^frame=(\d+)/gm)].some(match => Number(match[1]) > 0)) throw new CommandError('CLIP_EMPTY', 'The requested interval contains no decoded video frames.');
    await publishFile(temporary, out); written.push(out);
    const manifest = { schema: 'yt-max.clip/v1', createdAt: new Date().toISOString(), source: { file: source, sha256: await sha256(source) },
      file: basename(out), startSeconds: start, requestedDurationSeconds: duration, sha256: await sha256(out) };
    await writeNew(manifestPath, jsonText(manifest)); written.push(manifestPath);
    return { out, manifest: manifestPath, ...manifest };
  } catch (error) { await removeOwned(written); throw error; }
  finally { await removeOwned([temporary]); }
}
