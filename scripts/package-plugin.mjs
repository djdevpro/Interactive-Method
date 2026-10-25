import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { assertGeneratedPath, listFiles, projectRoot, readJson, sha256 } from './plugin-files.mjs';
import { validatePlugin } from './validate-plugin.mjs';

const build = spawnSync(process.execPath, [path.join(projectRoot, 'scripts/build-runtime.mjs')], { cwd: projectRoot, stdio: 'inherit', windowsHide: true });
if (build.error || build.status !== 0) throw build.error ?? new Error('Runtime build failed');
const validation = await validatePlugin();
const manifest = await readJson(path.join(projectRoot, 'plugin.json'));
const staging = await assertGeneratedPath(projectRoot, path.join(projectRoot, '.build', manifest.name));
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
const roots = [
  'plugin.json', '.codex-plugin', '.claude-plugin', 'assets', 'skills', 'references', 'templates', 'runtime',
  'LICENSE', 'NOTICE.md', 'README.md', 'scripts/session.mjs',
];
for (const entry of roots) {
  for (const source of await listFiles(path.join(projectRoot, entry))) {
    const relative = path.relative(projectRoot, source);
    const target = path.join(staging, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
}
await validatePlugin(staging);
const entries = {};
const inventory = [];
for (const filename of await listFiles(staging)) {
  const relative = path.relative(staging, filename).split(path.sep).join('/');
  if (relative.split('/').some(part => ['node_modules', '.git', 'investigations', 'releases', '.build', 'src', 'docs', 'packages'].includes(part)) || /(^|\/)\.env(?:\.|$)/.test(relative)) throw new Error(`Forbidden packaged path: ${relative}`);
  const bytes = await readFile(filename);
  inventory.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
  entries[`${manifest.name}/${relative}`] = [bytes, { mtime: new Date('2020-01-01T00:00:00Z'), os: 3, attrs: (relative === 'runtime/bin/ffmpeg' ? 0o100755 : 0o100644) << 16 }];
}
const integrity = Buffer.from(`${JSON.stringify({ schema: 'video-method-lab.package/v1', ...validation, files: inventory }, null, 2)}\n`);
await writeFile(path.join(staging, 'integrity.json'), integrity);
entries[`${manifest.name}/integrity.json`] = [integrity, { mtime: new Date('2020-01-01T00:00:00Z') }];
const archive = zipSync(entries, { level: 6 });
const extracted = unzipSync(archive);
if (Object.keys(extracted).length !== inventory.length + 1) throw new Error('Archive inventory differs');
for (const file of inventory) if (!extracted[`${manifest.name}/${file.path}`] || sha256(extracted[`${manifest.name}/${file.path}`]) !== file.sha256) throw new Error(`Archive integrity mismatch: ${file.path}`);
const releases = path.join(projectRoot, 'releases');
await mkdir(releases, { recursive: true });
const basename = `${manifest.name}-${manifest.version}-${process.platform}-${process.arch}.zip`;
await writeFile(path.join(releases, basename), archive);
await writeFile(path.join(releases, `${basename}.sha256`), `${sha256(archive)}  ${basename}\n`);
const marketplaceRoot = path.join(releases, 'local-marketplace');
const installCopy = await assertGeneratedPath(projectRoot, path.join(marketplaceRoot, manifest.name));
await rm(installCopy, { recursive: true, force: true });
for (const source of await listFiles(staging)) {
  const destination = path.join(installCopy, path.relative(staging, source));
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
const catalogDirectory = path.join(marketplaceRoot, '.agents/plugins');
await mkdir(catalogDirectory, { recursive: true });
await writeFile(path.join(catalogDirectory, 'marketplace.json'), `${JSON.stringify({
  name: 'learning-coder-local',
  interface: { displayName: 'Interactive Method local' },
  plugins: [{ name: manifest.name, source: { source: 'local', path: `./${manifest.name}` }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: manifest.extensions['com.openai'].interface.category }],
}, null, 2)}\n`);
// Keep the installable marketplace, but discard the redundant staging copy.
await rm(await assertGeneratedPath(projectRoot, staging), { recursive: true, force: true });
const buildDirectory = await assertGeneratedPath(projectRoot, path.join(projectRoot, '.build'));
if ((await readdir(buildDirectory)).length === 0) await rmdir(buildDirectory);
console.log(JSON.stringify({ archive: `releases/${basename}`, bytes: archive.length, sha256: sha256(archive), files: inventory.length + 1, stagingRemoved: true, marketplace: marketplaceRoot, ...validation }, null, 2));
