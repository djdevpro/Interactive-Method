import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { contained, listFiles, projectRoot, readJson, requiredSkills, sha256, sourceDigest } from './plugin-files.mjs';

const categories = new Set(['Business & Operations', 'Communication', 'Creativity', 'Data & Analytics', 'Developer Tools', 'Education & Research', 'Entertainment', 'Finance', 'Healthcare', 'Other', 'Productivity', 'Scientific Research', 'Security', 'Travel']);
const fail = message => { throw new Error(message); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export async function validatePlugin(root = projectRoot) {
  const manifest = await readJson(path.join(root, 'plugin.json'));
  if (manifest.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') fail('Missing Agent Plugins 1.0 schema');
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(manifest.name) || manifest.name.length > 64) fail('Invalid plugin name');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) fail('Invalid SemVer');
  if (!nonempty(manifest.description) || !nonempty(manifest.author?.name)) fail('Missing description/author');
  for (const key of ['skills', 'mcpServers', 'apps', 'interface']) if (key in manifest) fail(`Portable manifest cannot contain top-level ${key}`);
  const ui = manifest.extensions?.['com.openai']?.interface;
  if (!ui || !nonempty(ui.shortDescription) || ui.shortDescription.length > 30) fail('Invalid subtitle (maximum 30 characters)');
  if (!categories.has(ui.category)) fail('Unsupported plugin category');
  for (const key of ['logo', 'composerIcon']) if (ui[key]) await access(contained(root, ui[key]));
  if (!Array.isArray(ui.capabilities) || ui.capabilities.some(item => !nonempty(item))) fail('Invalid capabilities');
  const prompts = Array.isArray(ui.defaultPrompt) ? ui.defaultPrompt : [ui.defaultPrompt];
  if (!prompts.length || prompts.length > 3 || prompts.some(item => !nonempty(item) || item.length > 128 || /[\r\n]/.test(item))) fail('Invalid default prompt');

  for (const compatibility of ['.codex-plugin', '.claude-plugin']) {
    const legacy = await readJson(path.join(root, compatibility, 'plugin.json'));
    for (const key of ['name', 'version', 'description', 'license']) if (legacy[key] !== manifest[key]) fail(`${compatibility} has different ${key}`);
    if (legacy.author?.name !== manifest.author.name) fail(`${compatibility} has different author`);
    if (compatibility === '.codex-plugin' && JSON.stringify(legacy.interface) !== JSON.stringify(ui)) fail('Codex display metadata differs');
  }

  const names = new Set();
  const skillRoot = path.join(root, 'skills');
  for (const entry of await readdir(skillRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const filename = path.join(skillRoot, entry.name, 'SKILL.md');
    const raw = await readFile(filename, 'utf8');
    if (Buffer.byteLength(raw) > 1024 * 1024) fail(`Skill too large: ${entry.name}`);
    const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!frontmatter) fail(`Missing skill frontmatter: ${entry.name}`);
    const data = parse(frontmatter[1]);
    if (!nonempty(data.name) || !nonempty(data.description) || data.name !== entry.name || names.has(data.name)) fail(`Invalid or duplicate skill: ${entry.name}`);
    names.add(data.name);
    const agentFile = path.join(skillRoot, entry.name, 'agents/openai.yaml');
    try {
      await access(agentFile);
      const agent = parse(await readFile(agentFile, 'utf8'));
      if (agent.interface && (!nonempty(agent.interface.display_name) || !nonempty(agent.interface.short_description))) fail(`Invalid skill interface: ${entry.name}`);
      if (agent.policy?.allow_implicit_invocation != null && typeof agent.policy.allow_implicit_invocation !== 'boolean') fail(`Invalid invocation policy: ${entry.name}`);
      if (entry.name === 'guide-session' && agent.policy?.allow_implicit_invocation !== true) fail('The video entry point must allow implicit invocation');
    } catch (error) { if (error.code !== 'ENOENT' || entry.name === 'guide-session') throw error; }
  }
  for (const name of requiredSkills) if (!names.has(name)) fail(`Missing required skill: ${name}`);
  if (names.size !== requiredSkills.length) fail('Expose only the automatic video entry point; keep worker workflows in references');

  for (const directory of ['skills', 'references', 'templates', 'README.md', 'NOTICE.md']) {
    for (const filename of await listFiles(path.join(root, directory))) {
      if (filename.endsWith('.json')) await readJson(filename);
      if (!filename.endsWith('.md')) continue;
      const text = await readFile(filename, 'utf8');
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1].replace(/^<|>$/g, '').split('#')[0];
        if (!target || /^(?:https?:|mailto:|plugin:)/.test(target) || /[{}<>]/.test(target)) continue;
        const absolute = contained(root, path.relative(root, path.resolve(path.dirname(filename), target)));
        try { await access(absolute); } catch { fail(`Missing referenced file in ${path.relative(root, filename)}: ${target}`); }
      }
    }
  }

  const runtime = await readJson(path.join(root, 'runtime/build.json'));
  if (runtime.platform !== process.platform || runtime.arch !== process.arch) fail('Runtime is built for another operating system/architecture');
  if (!/^[a-f0-9]{64}$/.test(runtime.sourceSha256 ?? '')) fail('Missing runtime source fingerprint');
  let hasSources = true;
  try { await access(path.join(root, 'src')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; hasSources = false; }
  if (!hasSources && path.resolve(root) === path.resolve(projectRoot)) fail('Development source directory is missing');
  if (hasSources && runtime.sourceSha256 !== await sourceDigest(root)) fail('Runtime is stale: rebuild after editing sources');
  for (const item of [runtime.cli, runtime.ffmpeg, runtime.playbookCli, runtime.vuepressManifest, runtime.vuepressLock, runtime.rendererLicenses]) {
    if (!item?.file || !item.sha256) fail('Missing runtime component');
    const filename = contained(path.join(root, 'runtime'), item.file);
    if (sha256(await readFile(filename)) !== item.sha256) fail(`Runtime integrity mismatch: ${item.file}`);
  }
  for (const filename of ['LICENSE', 'NOTICE.md', 'runtime/licenses/undici-MIT.txt', 'runtime/licenses/ffmpeg-static-GPL-3.0.txt', runtime.ffmpeg.license && `runtime/${runtime.ffmpeg.license}`, runtime.ffmpeg.buildInformation && `runtime/${runtime.ffmpeg.buildInformation}`]) {
    if (!filename) fail('Missing license declaration');
    await access(contained(root, filename));
  }
  // A temporary folder outside the workspace makes missing bundled dependencies visible.
  const isolation = await mkdtemp(path.join(tmpdir(), 'learningcoder-runtime-'));
  try {
    const isolatedCli = path.join(isolation, 'video.mjs');
    await copyFile(path.join(root, 'runtime/video.mjs'), isolatedCli);
    const help = spawnSync(process.execPath, [isolatedCli, '--help'], { encoding: 'utf8', windowsHide: true, timeout: 15000, cwd: isolation, env: { ...process.env, NODE_PATH: '' } });
    if (help.error || help.status !== 0) fail(`Isolated CLI cannot start without node_modules: ${help.error?.message ?? help.stderr}`);
    if (!help.stdout.includes('transcript')) fail('Isolated CLI help is incomplete');
    const isolatedPlaybook = path.join(isolation, 'playbook.mjs');
    await copyFile(path.join(root, 'runtime/playbook.mjs'), isolatedPlaybook);
    const rendererHelp = spawnSync(process.execPath, [isolatedPlaybook, '--help'], { encoding: 'utf8', windowsHide: true, timeout: 15000, cwd: isolation, env: { ...process.env, NODE_PATH: '' } });
    if (rendererHelp.error || rendererHelp.status !== 0 || !rendererHelp.stdout.includes('render')) fail(`Isolated renderer cannot start: ${rendererHelp.error?.message ?? rendererHelp.stderr}`);
  } finally {
    if (path.dirname(isolation) !== path.resolve(tmpdir()) || !path.basename(isolation).startsWith('learningcoder-runtime-')) fail('Unexpected temporary directory');
    await rm(isolation, { recursive: true, force: true });
  }
  return { name: manifest.name, version: manifest.version, skills: [...names].sort(), platform: `${runtime.platform}-${runtime.arch}`, runtimeSha256: runtime.cli.sha256 };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await validatePlugin(process.argv[2] ? path.resolve(process.argv[2]) : projectRoot), null, 2)); }
  catch (error) { console.error(`Plugin validation failed: ${error.message}`); process.exitCode = 1; }
}
