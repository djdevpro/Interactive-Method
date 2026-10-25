import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function runNode(args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_PATH: '', NO_COLOR: '1' } });
    let tail = '';
    const log = (chunk: Buffer) => { const text = chunk.toString(); tail = (tail + text).slice(-16000); process.stderr.write(text); };
    child.stdout.on('data', log); child.stderr.on('data', log);
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`VuePress command failed (${code}). ${tail}`)));
  });
}

async function npmCli(): Promise<string> {
  const roots = [path.dirname(process.execPath), ...((process.env.PATH ?? '').split(path.delimiter))];
  const candidates = roots.flatMap(root => [path.join(root, 'node_modules/npm/bin/npm-cli.js'), path.join(root, '../lib/node_modules/npm/bin/npm-cli.js')]);
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm/node_modules/npm/bin/npm-cli.js'));
  for (const filename of candidates) { try { await access(filename); return filename; } catch { /* Try another Node installation. */ } }
  throw new Error('npm is required for the first VuePress build. Install the Node.js distribution with npm, then rerun render.');
}

async function acquireInstallGuard(filename: string): Promise<() => Promise<void>> {
  const identity = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token: randomUUID() });
  for (let attempt = 0; attempt < 3; attempt++) {
    let guard;
    try { guard = await open(filename, 'wx'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (guard) {
      try { await guard.writeFile(identity); }
      catch (error) { await guard.close(); await unlink(filename); throw error; }
      return async () => {
        await guard.close();
        try { if ((await readFile(filename, 'utf8')) === identity) await unlink(filename); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      };
    }

    let saved: string;
    try { saved = await readFile(filename, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    let owner: { pid?: number; createdAt?: string };
    try {
      owner = JSON.parse(saved);
      if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid! <= 0 || typeof owner.createdAt !== 'string' || !Number.isFinite(Date.parse(owner.createdAt))) throw new Error('Invalid owner');
    } catch {
      throw new Error(`The VuePress installation lock has no valid owner: ${filename}. Remove it only after confirming no installation is running.`);
    }
    let gone = false;
    try { process.kill(owner.pid!, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') gone = true;
      else if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    if (!gone) throw new Error(`The VuePress toolchain is being prepared by process ${owner.pid}. Retry after that build finishes.`);
    // Reclaim only a dead owner's unchanged lock. Never expire a healthy installer.
    try { if ((await readFile(filename, 'utf8')) === saved) await unlink(filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  throw new Error('The VuePress installation lock changed during recovery. Retry the build.');
}

export async function ensureToolchain(): Promise<string> {
  const packaged = fileURLToPath(new URL('./vuepress-toolchain/', import.meta.url));
  const manifest = await readFile(path.join(packaged, 'package.json'));
  const lock = await readFile(path.join(packaged, 'package-lock.json'));
  const digest = createHash('sha256').update(manifest).update(lock).digest('hex');
  const cacheRoot = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'LearningCoder', 'vuepress') : path.join(homedir(), '.cache', 'LearningCoder', 'vuepress');
  const directory = path.join(cacheRoot, digest);
  const ready = path.join(directory, '.ready');
  try {
    if ((await readFile(ready, 'utf8')) === digest) {
      await access(path.join(directory, 'node_modules/vuepress/bin/vuepress.js'));
      return directory;
    }
  } catch { /* Install or repair this exact locked toolchain. */ }
  await mkdir(directory, { recursive: true });
  const releaseGuard = await acquireInstallGuard(path.join(directory, '.installing'));
  try {
    await copyFile(path.join(packaged, 'package.json'), path.join(directory, 'package.json'));
    await copyFile(path.join(packaged, 'package-lock.json'), path.join(directory, 'package-lock.json'));
    process.stderr.write('Preparing the locked VuePress and Mermaid toolchain in the user cache.\n');
    await runNode([await npmCli(), 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], directory);
    await access(path.join(directory, 'node_modules/vuepress/bin/vuepress.js'));
    await writeFile(ready, digest);
  } finally {
    await releaseGuard();
  }
  return directory;
}
