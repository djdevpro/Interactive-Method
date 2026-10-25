import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, open, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceEntries = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'plugin.json', '.codex-plugin', '.claude-plugin', 'src', 'scripts', 'assets', 'skills', 'references', 'templates', 'LICENSE', 'NOTICE.md', 'README.md'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sourceDefault = fileURLToPath(new URL('../', import.meta.url));

function inside(root, relative) {
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`Invalid runtime path: ${relative}`);
  return target;
}

async function inventory(root, entries) {
  const files = [];
  async function visit(relative) {
    const filename = inside(root, relative);
    const stat = await lstat(filename);
    if (stat.isSymbolicLink()) throw new Error(`Linked source is not supported: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(filename)).sort()) await visit(path.join(relative, name));
    } else if (stat.isFile()) files.push({ relative: relative.split(path.sep).join('/'), bytes: await readFile(filename) });
    else throw new Error(`Unsupported source file: ${relative}`);
  }
  for (const entry of entries) await visit(entry);
  return files;
}

function digest(files) {
  const hash = createHash('sha256');
  for (const { relative, bytes } of files) hash.update(relative).update('\0').update(bytes).update('\0');
  return hash.digest('hex');
}

async function validRuntime(root) {
  try {
    const directory = path.join(root, 'runtime');
    const record = JSON.parse(await readFile(path.join(directory, 'build.json'), 'utf8'));
    if (record.schema !== 'video-method-lab.runtime/v1' || record.platform !== process.platform || record.arch !== process.arch) return false;
    const components = [
      [record.cli, 'video.mjs'], [record.playbookCli, 'playbook.mjs'],
      [record.ffmpeg, `bin/${process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'}`],
      [record.vuepressManifest, 'vuepress-toolchain/package.json'], [record.vuepressLock, 'vuepress-toolchain/package-lock.json'],
      [record.rendererLicenses, 'licenses/html-renderer-NOTICES.txt'],
    ];
    for (const [item, expected] of components) {
      if (item?.file !== expected || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')) return false;
      const filename = inside(directory, item.file);
      if (path.relative(await realpath(directory), await realpath(filename)) !== path.relative(directory, filename)) return false;
      if (sha256(await readFile(filename)) !== item.sha256) return false;
    }
    for (const name of ['undici-MIT.txt', 'ffmpeg-static-GPL-3.0.txt', 'ffmpeg-binary-LICENSE.txt', 'ffmpeg-binary-README.txt']) await access(path.join(directory, 'licenses', name));
    let hasSources = false;
    try { await access(path.join(root, 'src')); hasSources = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (hasSources) {
      if (record.sourceSha256 !== digest(await inventory(root, ['src', 'scripts/vuepress-toolchain']))) return false;
      const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
      if (JSON.stringify(metadata.dependencies) !== JSON.stringify(record.dependencies)) return false;
    }
    return true;
  } catch { return false; }
}

async function npmCli() {
  const roots = [path.dirname(process.execPath), ...(process.env.PATH ?? '').split(path.delimiter)];
  const candidates = roots.flatMap(root => [path.join(root, 'node_modules/npm/bin/npm-cli.js'), path.join(root, '../lib/node_modules/npm/bin/npm-cli.js')]);
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm/node_modules/npm/bin/npm-cli.js'));
  for (const filename of candidates) { try { await access(filename); return filename; } catch { /* Try the next Node installation. */ } }
  throw new Error('Node.js with npm is required to prepare Interactive Method.');
}

async function runNode(args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_PATH: '', NO_COLOR: '1' } });
    const log = data => process.stderr.write(data);
    child.stdout.on('data', log); child.stderr.on('data', log);
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Runtime preparation command failed (${code}): ${args[0]}`)));
  });
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function recoverDeadOwner(filename, saved, identity) {
  const recoveryFile = `${filename}.recovering`;
  let guard;
  try { guard = await open(recoveryFile, 'wx'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!guard) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if ((await lstat(recoveryFile)).isSymbolicLink()) throw new Error('Runtime recovery guard is a symbolic link.');
        const text = await readFile(recoveryFile, 'utf8');
        if (!text) { await pause(25); continue; }
        const owner = JSON.parse(text);
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !isAlive(owner.pid)) throw new Error('Runtime recovery guard has no living owner. Inspect it before retrying.');
        return;
      } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    }
    throw new Error('Runtime recovery guard has no owner. Inspect it before retrying.');
  }
  try {
    await guard.writeFile(identity);
    // Only this recovery process can remove the old lock. Re-read under the guard
    // so another recoverer cannot delete a replacement acquired by a live caller.
    try {
      const current = await readFile(filename, 'utf8');
      if (current === saved && !isAlive(JSON.parse(current).pid)) await unlink(filename);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } finally {
    await guard.close();
    await unlink(recoveryFile);
  }
}

async function acquireGuard(filename) {
  const identity = JSON.stringify({ pid: process.pid, token: randomUUID() });
  const deadline = Date.now() + 15 * 60 * 1000;
  let emptyReads = 0;
  while (Date.now() < deadline) {
    let handle;
    try { handle = await open(filename, 'wx'); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (handle) {
      try { await handle.writeFile(identity); } finally { await handle.close(); }
      return async () => {
        try { if (await readFile(filename, 'utf8') === identity) await unlink(filename); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    }
    let saved;
    try {
      if ((await lstat(filename)).isSymbolicLink()) throw new Error('Runtime preparation lock is a symbolic link.');
      saved = await readFile(filename, 'utf8');
    }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    // An exclusive lock may still be receiving its owner record.
    if (!saved) {
      if (++emptyReads > 20) throw new Error('Runtime preparation lock has no owner.');
      await pause(100); continue;
    }
    let owner;
    try { owner = JSON.parse(saved); } catch { throw new Error('Runtime preparation lock has an invalid owner.'); }
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') throw new Error('Runtime preparation lock has an invalid owner.');
    if (!isAlive(owner.pid)) await recoverDeadOwner(filename, saved, identity);
    await pause(250);
  }
  throw new Error('Another process is still preparing this runtime. Retry after it finishes.');
}

async function removePrepared(directory, cacheRoot) {
  const expected = inside(cacheRoot, path.relative(cacheRoot, directory));
  try {
    if ((await lstat(expected)).isSymbolicLink()) throw new Error('Refusing to replace a linked runtime cache.');
    if (await realpath(expected) !== expected) throw new Error('Refusing to replace a redirected runtime cache.');
    await rm(expected, { recursive: true, force: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function resolvedDestination(directory) {
  try { return await realpath(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return path.join(await resolvedDestination(path.dirname(directory)), path.basename(directory));
  }
}

export async function prepareRuntime(options = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error('Interactive Method requires Node.js >=22.19.0.');
  const sourceRoot = await realpath(options.sourceRoot ?? sourceDefault);
  if (await validRuntime(sourceRoot)) return { pluginRoot: sourceRoot, reused: true, source: 'bundled' };
  const files = await inventory(sourceRoot, sourceEntries);
  const fingerprint = digest(files);
  const platformCache = `${process.platform}-${process.arch}`;
  const base = options.cacheRoot ?? path.join(process.env.LOCALAPPDATA || path.join(homedir(), '.cache'), 'InteractiveMethod', 'runtime');
  const cacheRoot = await resolvedDestination(path.resolve(base));
  const sourceRelative = path.relative(sourceRoot, cacheRoot);
  if (!sourceRelative || (!sourceRelative.startsWith(`..${path.sep}`) && sourceRelative !== '..' && !path.isAbsolute(sourceRelative))) throw new Error('Runtime cache must be outside the installed plugin.');
  await mkdir(cacheRoot, { recursive: true });
  // Keep Windows executable paths short; the full digest still guards readiness.
  const directory = inside(cacheRoot, `${platformCache}-${fingerprint.slice(0, 20)}`);
  const prepared = path.join(directory, 'plugin');
  const sourceWithinPrepared = path.relative(prepared, sourceRoot);
  if (!sourceWithinPrepared || (!sourceWithinPrepared.startsWith(`..${path.sep}`) && sourceWithinPrepared !== '..' && !path.isAbsolute(sourceWithinPrepared))) throw new Error('Runtime preparation would replace its source. Run this helper from the original installed plugin.');
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Refusing a redirected runtime cache.');
  const ready = path.join(directory, '.ready');
  const isReady = async () => {
    try {
      if ((await lstat(prepared)).isSymbolicLink() || await realpath(prepared) !== prepared) return false;
      return await readFile(ready, 'utf8') === fingerprint
        && digest(await inventory(prepared, sourceEntries)) === fingerprint
        && await validRuntime(prepared);
    }
    catch { return false; }
  };
  if (await isReady()) return { pluginRoot: prepared, reused: true, source: 'cache' };
  const release = await acquireGuard(path.join(directory, '.installing'));
  try {
    if (await isReady()) return { pluginRoot: prepared, reused: true, source: 'cache' };
    await unlink(ready).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await removePrepared(prepared, cacheRoot);
    for (const file of files) {
      const filename = inside(prepared, file.relative);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, file.bytes);
    }
    process.stderr.write('Preparing Interactive Method video tools in the user cache.\n');
    const run = options.runNode ?? runNode;
    await run([options.npmPath ?? await npmCli(), 'exec', '--yes', '--package=pnpm@10.22.0', '--', 'pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'], prepared);
    await run([path.join(prepared, 'node_modules/ffmpeg-static/install.js')], prepared);
    await run([path.join(prepared, 'scripts/build-runtime.mjs')], prepared);
    if (!await validRuntime(prepared)) throw new Error('Prepared runtime failed its integrity check.');
    await writeFile(ready, fingerprint);
    return { pluginRoot: prepared, reused: false, source: 'cache' };
  } finally { await release(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--cache-dir')) throw new Error('Usage: node scripts/prepare-runtime.mjs [--cache-dir PATH]');
    console.log(JSON.stringify(await prepareRuntime({ cacheRoot: args[1] && path.resolve(args[1]) })));
  } catch (error) { console.error(`Runtime preparation failed: ${error.message}`); process.exitCode = 1; }
}
