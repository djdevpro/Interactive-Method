import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const requiredSkills = ['guide-session'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const readJson = async filename => JSON.parse(await readFile(filename, 'utf8'));

export function contained(root, relative) {
  const target = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`Path outside plugin: ${relative}`);
  return target;
}

export async function listFiles(directory) {
  const result = [];
  async function visit(current) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic link not allowed in package: ${current}`);
    if (stat.isFile()) { result.push(current); return; }
    if (!stat.isDirectory()) throw new Error(`Unsupported file type: ${current}`);
    for (const name of (await readdir(current)).sort()) await visit(path.join(current, name));
  }
  await visit(directory);
  return result;
}

export async function sourceDigest(root = projectRoot) {
  const hash = createHash('sha256');
  for (const entry of ['src', 'scripts/vuepress-toolchain']) {
    for (const filename of await listFiles(path.join(root, entry))) {
      hash.update(path.relative(root, filename).split(path.sep).join('/')).update('\0');
      hash.update(await readFile(filename)).update('\0');
    }
  }
  return hash.digest('hex');
}

export async function assertGeneratedPath(root, destination) {
  const resolvedRoot = await realpath(root);
  const resolvedDestination = contained(resolvedRoot, path.relative(root, destination));
  if (resolvedDestination === resolvedRoot) throw new Error('Refusing to replace project root');
  let current = path.dirname(resolvedDestination);
  while (current !== resolvedRoot) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Linked parent: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Path outside workspace');
    current = parent;
  }
  try { if ((await lstat(resolvedDestination)).isSymbolicLink()) throw new Error(`Linked output: ${resolvedDestination}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return resolvedDestination;
}
