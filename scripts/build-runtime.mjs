import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { projectRoot, readJson, sha256, sourceDigest } from './plugin-files.mjs';
import { bundleNotices } from './runtime-licenses.mjs';

const require = createRequire(import.meta.url);
const runtime = path.join(projectRoot, 'runtime');
const ffmpegPackage = path.dirname(require.resolve('ffmpeg-static/package.json'));
const ffmpegMeta = await readJson(path.join(ffmpegPackage, 'package.json'));
const ffmpegName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const ffmpegSource = path.join(ffmpegPackage, ffmpegName);
const sourceBeforeBuild = await sourceDigest();
let ffmpegBytes;
try { ffmpegBytes = await readFile(ffmpegSource); }
catch { throw new Error('FFmpeg absent. Run pnpm setup:ffmpeg, then pnpm build.'); }

await mkdir(path.join(runtime, 'bin'), { recursive: true });
await mkdir(path.join(runtime, 'licenses'), { recursive: true });
const nodeOptions = {
  absWorkingDir: projectRoot,
  bundle: true,
  platform: 'node',
  target: 'node22.19',
  format: 'esm',
  packages: 'bundle',
  legalComments: 'eof',
  metafile: true,
  banner: { js: "import { createRequire as __createPluginRequire } from 'node:module'; const require = __createPluginRequire(import.meta.url);" },
};
const videoBuild = await build({ ...nodeOptions, entryPoints: ['src/cli.ts'], outfile: path.join(runtime, 'video.mjs') });
const playbookBuild = await build({ ...nodeOptions, entryPoints: ['src/playbook/cli.ts'], outfile: path.join(runtime, 'playbook.mjs') });
await mkdir(path.join(runtime, 'vuepress-toolchain'), { recursive: true });
for (const name of ['package.json', 'package-lock.json']) {
  await copyFile(path.join(projectRoot, 'scripts/vuepress-toolchain', name), path.join(runtime, 'vuepress-toolchain', name));
}
const external = [videoBuild, playbookBuild].flatMap(result => Object.values(result.metafile.outputs)).flatMap(output => output.imports).filter(item => item.external && !item.path.startsWith('node:'));
// esbuild may preserve Node built-ins with their historical bare names.
const { builtinModules } = await import('node:module');
const unresolved = external.filter(item => !builtinModules.includes(item.path));
if (unresolved.length) throw new Error(`Runtime still requires external packages: ${unresolved.map(item => item.path).join(', ')}`);

const ffmpegTarget = path.join(runtime, 'bin', ffmpegName);
let binaryMatches = false;
try { binaryMatches = sha256(await readFile(ffmpegTarget)) === sha256(ffmpegBytes); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
// Windows locks a running executable; preserve the existing copy when it is identical.
if (!binaryMatches) await copyFile(ffmpegSource, ffmpegTarget);
await chmod(ffmpegTarget, 0o755);
const licenseFiles = [
  [path.join(path.dirname(require.resolve('undici/package.json')), 'LICENSE'), 'undici-MIT.txt'],
  [path.join(ffmpegPackage, 'LICENSE'), 'ffmpeg-static-GPL-3.0.txt'],
  [`${ffmpegSource}.LICENSE`, 'ffmpeg-binary-LICENSE.txt'],
  [`${ffmpegSource}.README`, 'ffmpeg-binary-README.txt'],
];
for (const [source, destination] of licenseFiles) await copyFile(source, path.join(runtime, 'licenses', destination));
await writeFile(path.join(runtime, 'licenses/html-renderer-NOTICES.txt'), await bundleNotices([playbookBuild]));
const version = spawnSync(ffmpegTarget, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
if (version.error || version.status !== 0) throw new Error(`Bundled FFmpeg failed: ${version.error?.message ?? version.stderr}`);
for (const entry of ['video.mjs', 'playbook.mjs']) {
  const check = spawnSync(process.execPath, [path.join(runtime, entry), '--help'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (check.error || check.status !== 0) throw new Error(`Bundled ${entry} failed: ${check.error?.message ?? check.stderr}`);
}
const runtimeFile = async file => ({ file, sha256: sha256(await readFile(path.join(runtime, file))) });
const record = {
  schema: 'video-method-lab.runtime/v1',
  platform: process.platform,
  arch: process.arch,
  minimumNode: '22.19.0',
  sourceSha256: sourceBeforeBuild,
  cli: { file: 'video.mjs', sha256: sha256(await readFile(path.join(runtime, 'video.mjs'))) },
  playbookCli: await runtimeFile('playbook.mjs'),
  vuepressManifest: await runtimeFile('vuepress-toolchain/package.json'),
  vuepressLock: await runtimeFile('vuepress-toolchain/package-lock.json'),
  rendererLicenses: await runtimeFile('licenses/html-renderer-NOTICES.txt'),
  dependencies: (await readJson(path.join(projectRoot, 'package.json'))).dependencies,
  ffmpeg: {
    file: `bin/${ffmpegName}`,
    version: version.stdout.split(/\r?\n/)[0],
    package: `ffmpeg-static@${ffmpegMeta.version}`,
    release: ffmpegMeta['ffmpeg-static']['binary-release-tag'],
    download: `https://github.com/eugeneware/ffmpeg-static/releases/download/${ffmpegMeta['ffmpeg-static']['binary-release-tag']}/ffmpeg-${process.platform}-${process.arch}.gz`,
    sha256: sha256(await readFile(ffmpegTarget)),
    license: 'licenses/ffmpeg-binary-LICENSE.txt',
    buildInformation: 'licenses/ffmpeg-binary-README.txt',
  },
};
if (await sourceDigest() !== sourceBeforeBuild) throw new Error('Source changed during compilation; run pnpm build again.');
await writeFile(path.join(runtime, 'build.json'), `${JSON.stringify(record, null, 2)}\n`);
// Remove only the two obsolete outputs from the previous package layout.
for (const obsolete of ['yt-max.mjs', 'licenses/yt-max-MIT.txt', 'playbook-browser.js']) await rm(path.join(runtime, obsolete), { force: true });
console.log(`Video runtime and VuePress launcher ready with bundled FFmpeg (${process.platform}-${process.arch}). VuePress initializes its locked toolchain in the user cache on first render.`);
