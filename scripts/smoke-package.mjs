import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { contained, projectRoot, readJson, sha256 } from './plugin-files.mjs';

const manifest = await readJson(path.join(projectRoot, 'plugin.json'));
const archivePath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(projectRoot, 'releases', `${manifest.name}-${manifest.version}-${process.platform}-${process.arch}.zip`);
const entries = unzipSync(await readFile(archivePath));
const integrityName = `${manifest.name}/integrity.json`;
const integrity = JSON.parse(Buffer.from(entries[integrityName]).toString('utf8'));
assert.equal(Object.keys(entries).length, integrity.files.length + 1, 'Archive contains unexpected files');
for (const file of integrity.files) {
  const entry = entries[`${manifest.name}/${file.path}`];
  assert.ok(entry, `Missing ${file.path}`);
  assert.equal(sha256(entry), file.sha256, `Hash differs for ${file.path}`);
}
const temporary = await mkdtemp(path.join(tmpdir(), 'learningcoder-package-'));
const environment = { ...process.env, NODE_PATH: '', PATH: path.dirname(process.execPath) };
delete environment.YT_MAX_FFMPEG;
delete environment.FFMPEG_BIN;
function run(executable, args, cwd, expectedStatus = 0) {
  const result = spawnSync(executable, args, { cwd, env: environment, encoding: 'utf8', windowsHide: true, timeout: 300000 });
  if (result.error || result.status !== expectedStatus) throw result.error ?? new Error(`Command failed (${result.status}): ${args.join(' ')}\n${result.stderr}`);
  return result;
}
try {
  for (const [name, bytes] of Object.entries(entries)) {
    assert.ok(name.startsWith(`${manifest.name}/`), 'Archive contains more than one plugin');
    assert.ok(!name.split('/').some(part => ['..', 'node_modules', 'investigations', '.git', 'releases', 'src', 'docs', 'packages'].includes(part)), `Forbidden path: ${name}`);
    const output = contained(temporary, name);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, bytes);
  }
  const plugin = path.join(temporary, manifest.name);
  const cli = path.join(plugin, 'runtime/video.mjs');
  const doctor = JSON.parse(run(process.execPath, [cli, 'doctor'], temporary).stdout);
  assert.equal(doctor.ready, true);
  assert.equal(path.resolve(doctor.ffmpeg), path.join(plugin, 'runtime/bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'));
  const help = run(process.execPath, [cli, '--help'], temporary).stdout;
  for (const command of ['collect', 'import', 'download', 'frames', 'clip', 'doctor']) assert.ok(help.includes(command), `Missing ${command}`);

  const work = path.join(temporary, 'analysis with spaces');
  const sessionCli = path.join(plugin, 'scripts/session.mjs');
  run(process.execPath, [sessionCli, 'init', work, '--video', '8w6EhLPyNXU', '--language', 'fr'], temporary);
  const session = await readJson(path.join(work, 'session.json'));
  assert.equal(session.video.id, '8w6EhLPyNXU');
  assert.equal(session.scope.depth, 'initial');
  assert.equal(session.scope.mermaid, true);
  assert.equal(session.deepDiveRequested, false);
  assert.equal(session.supplementarySourcesRequested, false);
  assert.equal(session.language, 'fr');
  for (const command of ['status', 'resume', 'validate']) run(process.execPath, [sessionCli, command, work], temporary);

  const fixture = path.join(temporary, 'fixture.mp4');
  run(doctor.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=2', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', fixture], temporary);
  const captureDirectory = path.join(work, 'captures', 'smoke');
  run(process.execPath, [cli, 'frames', fixture, '--out', captureDirectory, '--method', 'm01', '--times', '0.5', '--reason', 'Check bundled FFmpeg'], temporary);
  const captures = await readJson(path.join(captureDirectory, 'captures.json'));
  assert.equal(captures.captures.length, 1);
  assert.equal(captures.captures[0].timestampSeconds, 0.5);
  assert.equal(captures.captures[0].reviewed, false);
  const png = await readFile(path.join(captureDirectory, captures.captures[0].file));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(sha256(png), captures.captures[0].sha256);
  const markdownPath = path.join(work, 'overview.md');
  await writeFile(markdownPath, `# Package verification\n\nNo method was identified in this synthetic test video.\n\n## Evidence\n\n![Synthetic frame](captures/smoke/${captures.captures[0].file})\n\n\`\`\`mermaid\nflowchart LR\n  A[Video] --> B[Reviewed frame]\n  B --> C[Overview]\n\`\`\`\n`);
  const htmlPath = path.join(work, 'overview.html');
  const rendered = JSON.parse(run(process.execPath, [path.join(plugin, 'runtime/playbook.mjs'), 'render', markdownPath, '--out', htmlPath], temporary).stdout);
  assert.equal(rendered.images, 1);
  assert.equal(rendered.diagrams, 1);
  assert.equal(rendered.engine, 'vuepress');
  assert.equal(rendered.language, 'fr');
  const launcher = await readFile(htmlPath, 'utf8');
  assert.ok(launcher.includes('overview-site/'));
  const html = await readFile(path.join(work, 'overview-site/index.html'), 'utf8');
  assert.ok(html.includes('lang="fr"'));
  assert.ok(html.includes('No method was identified'));
  assert.ok(html.includes('vp-theme-container'));
  assert.ok(/<script[^>]+src=/.test(html));
  const config = await readFile(path.join(work, '.vuepress-source/overview/.vuepress/config.mjs'), 'utf8');
  assert.ok(config.includes('markdownChartPlugin'));
  assert.ok(config.includes('mermaid: true'));
  console.log(JSON.stringify({ archive: path.relative(projectRoot, archivePath), files: integrity.files.length + 1, isolatedOutsideWorkspace: true, nodeModulesInPlugin: false, cachedVuePressToolchain: true, doctor: 'passed', sessionCommands: ['init', 'status', 'resume', 'validate'], bundledFfmpegCapture: 'passed', vuepressSite: 'passed', language: 'fr' }, null, 2));
} finally {
  if (path.dirname(temporary) !== path.resolve(tmpdir()) || !path.basename(temporary).startsWith('learningcoder-package-')) throw new Error('Unexpected temporary directory');
  await rm(temporary, { recursive: true, force: true });
}
