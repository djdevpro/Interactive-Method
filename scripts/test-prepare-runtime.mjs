import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sourceDigest } from './plugin-files.mjs';
import { prepareRuntime } from './prepare-runtime.mjs';

async function put(root, relative, contents) {
  const filename = path.join(root, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, contents);
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'interactive-method-bootstrap-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.match(path.basename(directory), /^interactive-method-bootstrap-/);
    await rm(directory, { recursive: true, force: true });
  });
  const sourceRoot = path.join(directory, 'source');
  const cacheRoot = path.join(directory, 'cache');
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'plugin.json', 'LICENSE', 'NOTICE.md', 'README.md']) await put(sourceRoot, name, '{}\n');
  await put(sourceRoot, 'package.json', JSON.stringify({ packageManager: 'pnpm@10.22.0', dependencies: { marked: '18.1.1' } }));
  for (const name of ['.codex-plugin', '.claude-plugin', 'assets', 'skills', 'references', 'templates']) await put(sourceRoot, `${name}/fixture.txt`, 'fixture\n');
  await put(sourceRoot, 'src/cli.ts', 'export {};\n');
  await put(sourceRoot, 'scripts/build-runtime.mjs', '// build fixture\n');
  await put(sourceRoot, 'scripts/vuepress-toolchain/package.json', '{}\n');
  await put(sourceRoot, 'scripts/vuepress-toolchain/package-lock.json', '{}\n');
  return { sourceRoot, cacheRoot, npmPath: 'fixture-npm-cli.js' };
}

async function fakeRuntime(root) {
  const runtime = path.join(root, 'runtime');
  const files = {
    cli: 'video.mjs', playbookCli: 'playbook.mjs',
    ffmpeg: `bin/${process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'}`,
    vuepressManifest: 'vuepress-toolchain/package.json', vuepressLock: 'vuepress-toolchain/package-lock.json',
    rendererLicenses: 'licenses/html-renderer-NOTICES.txt',
  };
  const record = { schema: 'video-method-lab.runtime/v1', platform: process.platform, arch: process.arch, minimumNode: '22.19.0', sourceSha256: await sourceDigest(root), dependencies: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).dependencies };
  for (const [key, file] of Object.entries(files)) {
    const bytes = Buffer.from(`fixture ${file}\n`);
    await put(runtime, file, bytes);
    record[key] = { file, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  for (const file of ['undici-MIT.txt', 'ffmpeg-static-GPL-3.0.txt', 'ffmpeg-binary-LICENSE.txt', 'ffmpeg-binary-README.txt']) await put(runtime, `licenses/${file}`, 'fixture license\n');
  await put(runtime, 'build.json', JSON.stringify(record));
}

function fakeRunner(calls) {
  return async (args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === path.join(cwd, 'scripts/build-runtime.mjs')) await fakeRuntime(cwd);
  };
}

async function snapshot(root) {
  const output = {};
  async function visit(relative) {
    for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const next = path.join(relative, item.name);
      if (item.isDirectory()) await visit(next);
      else output[next] = (await readFile(path.join(root, next))).toString('base64');
    }
  }
  await visit('');
  return output;
}

test('source-only installation prepares once, preserves source and reuses the complete cache', async t => {
  const options = await fixture(t);
  const before = await snapshot(options.sourceRoot);
  const calls = [];
  const first = await prepareRuntime({ ...options, runNode: fakeRunner(calls) });
  assert.equal(first.reused, false);
  assert.equal(first.source, 'cache');
  assert.notEqual(first.pluginRoot, options.sourceRoot);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].args.slice(1), ['exec', '--yes', '--package=pnpm@10.22.0', '--', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts']);
  assert.deepEqual(await snapshot(options.sourceRoot), before);
  const second = await prepareRuntime({ ...options, runNode: async () => assert.fail('Reused runtime must not run installers') });
  assert.equal(second.pluginRoot, first.pluginRoot);
  assert.equal(second.reused, true);
});

test('dependency locks, build scripts and agent instructions invalidate prepared copies', async t => {
  const options = await fixture(t);
  const runNode = fakeRunner([]);
  let previous = await prepareRuntime({ ...options, runNode });
  for (const name of ['pnpm-lock.yaml', 'scripts/build-runtime.mjs', 'skills/fixture.txt']) {
    await put(options.sourceRoot, name, 'changed\n');
    const current = await prepareRuntime({ ...options, runNode });
    assert.equal(current.reused, false);
    assert.notEqual(current.pluginRoot, previous.pluginRoot);
    previous = current;
  }
});

test('failed or incomplete preparation is not ready and recovers on the next call', async t => {
  const options = await fixture(t);
  await assert.rejects(prepareRuntime({ ...options, runNode: async () => { throw new Error('network unavailable'); } }), /network unavailable/);
  const [entry] = await readdir(options.cacheRoot);
  await assert.rejects(access(path.join(options.cacheRoot, entry, '.ready')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(options.cacheRoot, entry, '.installing')), { code: 'ENOENT' });
  const result = await prepareRuntime({ ...options, runNode: fakeRunner([]) });
  assert.equal(result.reused, false);
  await access(path.join(result.pluginRoot, 'runtime/video.mjs'));
});

test('corrupt cached runtime is rebuilt instead of accepted from its ready marker', async t => {
  const options = await fixture(t);
  const first = await prepareRuntime({ ...options, runNode: fakeRunner([]) });
  await put(first.pluginRoot, 'runtime/video.mjs', 'corrupted\n');
  const calls = [];
  const second = await prepareRuntime({ ...options, runNode: fakeRunner(calls) });
  assert.equal(second.reused, false);
  assert.equal(second.pluginRoot, first.pluginRoot);
  assert.equal(calls.length, 3);
});

test('a missing cached session helper or changed instruction is repaired before reuse', async t => {
  const options = await fixture(t);
  await put(options.sourceRoot, 'scripts/session.mjs', '// fixture session helper\n');
  const first = await prepareRuntime({ ...options, runNode: fakeRunner([]) });
  await rm(path.join(first.pluginRoot, 'scripts/session.mjs'));
  const calls = [];
  const repaired = await prepareRuntime({ ...options, runNode: fakeRunner(calls) });
  assert.equal(repaired.reused, false);
  await access(path.join(repaired.pluginRoot, 'scripts/session.mjs'));
  await put(repaired.pluginRoot, 'skills/fixture.txt', 'changed cached instruction\n');
  const restored = await prepareRuntime({ ...options, runNode: fakeRunner(calls) });
  assert.equal(restored.reused, false);
  assert.equal(await readFile(path.join(restored.pluginRoot, 'skills/fixture.txt'), 'utf8'), 'fixture\n');
  assert.equal(calls.length, 6);
});

test('concurrent preparations share one installer and both return a complete runtime', async t => {
  const options = await fixture(t);
  const calls = [];
  const runner = fakeRunner(calls);
  const runNode = async (...args) => { await new Promise(resolve => setTimeout(resolve, 30)); await runner(...args); };
  const results = await Promise.all([prepareRuntime({ ...options, runNode }), prepareRuntime({ ...options, runNode })]);
  assert.equal(results[0].pluginRoot, results[1].pluginRoot);
  assert.deepEqual(results.map(result => result.reused).sort(), [false, true]);
  assert.equal(calls.length, 3);
});

async function deadOwner() {
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Fixture process failed: ${code}`)));
  });
  return JSON.stringify({ pid: child.pid, token: 'dead-test-owner' });
}

test('concurrent stale-owner recovery preserves the replacement lock and builds only once', async t => {
  const options = await fixture(t);
  await assert.rejects(prepareRuntime({ ...options, runNode: async () => { throw new Error('interrupted'); } }), /interrupted/);
  const [entry] = await readdir(options.cacheRoot);
  const lock = path.join(options.cacheRoot, entry, '.installing');
  await writeFile(lock, await deadOwner());
  const calls = [];
  const runner = fakeRunner(calls);
  const runNode = async (...args) => { await new Promise(resolve => setTimeout(resolve, 50)); await runner(...args); };
  const results = await Promise.all(Array.from({ length: 12 }, () => prepareRuntime({ ...options, runNode })));
  assert.equal(new Set(results.map(result => result.pluginRoot)).size, 1);
  assert.equal(results.filter(result => !result.reused).length, 1);
  assert.equal(calls.length, 3);
  await assert.rejects(access(lock), { code: 'ENOENT' });
  await assert.rejects(access(`${lock}.recovering`), { code: 'ENOENT' });
});

test('an abandoned recovery guard fails explicitly without deleting either guard', async t => {
  const options = await fixture(t);
  await assert.rejects(prepareRuntime({ ...options, runNode: async () => { throw new Error('interrupted'); } }), /interrupted/);
  const [entry] = await readdir(options.cacheRoot);
  const lock = path.join(options.cacheRoot, entry, '.installing');
  const owner = await deadOwner();
  await writeFile(lock, owner);
  await writeFile(`${lock}.recovering`, owner);
  await assert.rejects(prepareRuntime({ ...options, runNode: fakeRunner([]) }), /recovery guard has no living owner/);
  assert.equal(await readFile(lock, 'utf8'), owner);
  assert.equal(await readFile(`${lock}.recovering`, 'utf8'), owner);
});

test('valid bundled runtime stays offline, while source changes or escaping paths reject it', async t => {
  const options = await fixture(t);
  await fakeRuntime(options.sourceRoot);
  const bundled = await prepareRuntime({ ...options, runNode: async () => assert.fail('Bundled runtime must not install') });
  assert.equal(bundled.source, 'bundled');
  assert.equal(bundled.pluginRoot, options.sourceRoot);
  await put(options.sourceRoot, 'src/cli.ts', 'changed source\n');
  const rebuilt = await prepareRuntime({ ...options, runNode: fakeRunner([]) });
  assert.equal(rebuilt.source, 'cache');
  await fakeRuntime(options.sourceRoot);
  const recordFile = path.join(options.sourceRoot, 'runtime/build.json');
  const record = JSON.parse(await readFile(recordFile, 'utf8'));
  record.cli.file = '../../outside.mjs';
  await writeFile(recordFile, JSON.stringify(record));
  const rejected = await prepareRuntime({ ...options, runNode: fakeRunner([]) });
  assert.equal(rejected.source, 'cache');
});

test('a cache inside the installed source is refused before creating files', async t => {
  const options = await fixture(t);
  const before = await snapshot(options.sourceRoot);
  await assert.rejects(prepareRuntime({ ...options, cacheRoot: path.join(options.sourceRoot, 'cache'), runNode: fakeRunner([]) }), /outside the installed plugin/);
  assert.deepEqual(await snapshot(options.sourceRoot), before);
});

test('repair cannot delete the source when invoked from its own prepared copy', async t => {
  const options = await fixture(t);
  const first = await prepareRuntime({ ...options, runNode: fakeRunner([]) });
  await put(first.pluginRoot, 'runtime/video.mjs', 'corrupted\n');
  const before = await snapshot(first.pluginRoot);
  await assert.rejects(prepareRuntime({ ...options, sourceRoot: first.pluginRoot, runNode: fakeRunner([]) }), /original installed plugin/);
  assert.deepEqual(await snapshot(first.pluginRoot), before);
});
