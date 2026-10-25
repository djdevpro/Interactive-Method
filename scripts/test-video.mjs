import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { projectRoot } from './plugin-files.mjs';
const run = promisify(execFile);
const root = projectRoot;
const cli = join(root, 'runtime/video.mjs');
const ffmpeg = join(root, 'runtime/bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const folder = await mkdtemp(join(tmpdir(), 'learningcoder-video-'));
async function command(...args) { const { stdout } = await run(process.execPath, [cli, ...args], { windowsHide: true }); return JSON.parse(stdout); }
async function rejection(expected, ...args) {
  try { await command(...args); assert.fail('Command unexpectedly succeeded'); }
  catch (error) { assert.equal(JSON.parse(error.stderr).error, expected); }
}
try {
const health = await command('doctor');
assert.equal(health.ready, true);
const input = join(folder, 'synthetic.mp4');
await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '2', input]);
const srt = join(folder, 'input.srt');
await writeFile(srt, '1\n00:00:00,000 --> 00:00:01,000\nFirst step.\n\n2\n00:00:01,500 --> 00:00:03,000\nResult &amp; verification.\n');
const source = await command('import', srt, '--video', '8w6EhLPyNXU', '--out', join(folder, 'source'), '--source', 'Synthetic smoke fixture', '--lang', 'en', '--title', 'Fixture');
assert.equal(source.lineCount, 2);
const transcript = JSON.parse(await readFile(join(folder, 'source/transcript.json'), 'utf8'));
assert.equal(transcript.lines[1].start, 1.5);
assert.equal(transcript.lines[1].text, 'Result & verification.');
await rejection('OUTPUT_EXISTS', 'import', srt, '--video', '8w6EhLPyNXU', '--out', join(folder, 'source'), '--source', 'Repeated synthetic fixture');
const vtt = join(folder, 'input.vtt');
await writeFile(vtt, 'WEBVTT\n\n00:00.000 --> 00:01.000\nFirst point.\n\n00:01.500 --> 00:03.000\nSecond point.\n');
const importedVtt = await command('import', vtt, '--video', '8w6EhLPyNXU', '--out', join(folder, 'vtt-source'), '--source', 'VTT synthetic fixture');
assert.equal(importedVtt.lineCount, 2);
const mismatch = join(folder, 'mismatch.json');
await writeFile(mismatch, JSON.stringify({ ...transcript, videoId: 'jNQXAC9IVRw' }));
await rejection('VIDEO_MISMATCH', 'import', mismatch, '--video', '8w6EhLPyNXU', '--out', join(folder, 'mismatch'), '--source', 'Mismatched fixture');
const plan = join(folder, 'plan.json');
await writeFile(plan, JSON.stringify([{ time: 0.5, reason: 'Initial state', role: 'initial' }, { time: 2.5, reason: 'Result', role: 'result' }]));
const frames = await command('frames', input, '--out', join(folder, 'frames'), '--method', 'm01', '--plan', plan);
assert.equal(frames.captures.length, 2);
for (const image of frames.captures) {
  const bytes = await readFile(join(folder, 'frames', image.file));
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(image.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(image.reviewed, false);
}
await rejection('OUTPUT_EXISTS', 'frames', input, '--out', join(folder, 'frames'), '--method', 'm01', '--plan', plan);
await rejection('USAGE', 'frames', input, '--out', join(folder, 'bad-frames'), '--method', 'm01', '--times', '0.5,0.5', '--reason', 'Duplicate');
await rejection('FRAME_MISSING', 'frames', input, '--out', join(folder, 'out-of-range'), '--method', 'm01', '--times', '99', '--reason', 'Beyond source');
const clip = await command('clip', input, '--out', join(folder, 'clip.mp4'), '--start', '1', '--duration', '1.5');
assert.equal(clip.startSeconds, 1);
assert.equal(clip.requestedDurationSeconds, 1.5);
await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', join(folder, 'clip.mp4'), '-f', 'null', '-']);
await rejection('USAGE', 'clip', input, '--out', join(folder, 'long.mp4'), '--start', '0', '--duration', '121');
await rejection('CLIP_EMPTY', 'clip', input, '--out', join(folder, 'empty.mp4'), '--start', '99', '--duration', '1');
console.log(JSON.stringify({ passed: true, checks: ['doctor', 'SRT import', 'VTT import', 'video mismatch', 'exclusive writes', 'PNG extraction and SHA-256', 'duplicate times rejected', 'out-of-range frame rejected', 'clip decoded', 'clip duration bounded', 'empty clip rejected'] }, null, 2));

} finally {
  assert.equal(dirname(folder), resolve(tmpdir()));
  assert.equal((await lstat(folder)).isSymbolicLink(), false);
  assert.equal(dirname(await realpath(folder)), await realpath(tmpdir()));
  await rm(folder, { recursive: true, force: true });
}
