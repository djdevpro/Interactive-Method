import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Keep license texts with the generated site when it is copied away from the cache. */
export async function collectToolchainNotices(toolchain: string): Promise<string> {
  const cached = path.join(toolchain, '.third-party-notices.txt');
  try { return await readFile(cached, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const root = await realpath(toolchain);
  const visited = new Set<string>();
  const notices: { name: string; text: string }[] = [];
  const inside = (filename: string) => {
    const relative = path.relative(root, filename);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  async function visitPackage(directory: string): Promise<void> {
    const resolved = await realpath(directory);
    if (!inside(resolved) || visited.has(resolved)) return;
    visited.add(resolved);
    let metadata: { name: string; version: string; license?: unknown };
    try { metadata = JSON.parse(await readFile(path.join(resolved, 'package.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const name = `${metadata.name}@${metadata.version}`;
    const chunks = [`${name}\nDeclared license: ${JSON.stringify(metadata.license ?? 'See package license')}\n`];
    for (const filename of (await readdir(resolved)).sort()) {
      if (!/^(?:licen[sc]e|copying|notice|copyright)(?:[.-].*)?$/i.test(filename)) continue;
      const file = path.join(resolved, filename);
      const stat = await lstat(file);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;
      chunks.push(`${filename}\n\n${await readFile(file, 'utf8')}`);
    }
    notices.push({ name, text: chunks.join('\n') });
    await visitModules(path.join(resolved, 'node_modules'));
  }
  async function visitModules(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const target = path.join(directory, entry.name);
      if (entry.name.startsWith('@')) {
        for (const child of await readdir(target, { withFileTypes: true })) if (child.isDirectory()) await visitPackage(path.join(target, child.name));
      } else await visitPackage(target);
    }
  }
  await visitModules(path.join(root, 'node_modules'));
  const text = 'Third-party notices for the locked VuePress build toolchain and generated assets.\nNot every toolchain dependency is shipped in the browser.\n\n'
    + notices.sort((a, b) => a.name.localeCompare(b.name)).map(item => `${'='.repeat(72)}\n${item.text}`).join('\n\n') + '\n';
  await writeFile(cached, text);
  return text;
}
