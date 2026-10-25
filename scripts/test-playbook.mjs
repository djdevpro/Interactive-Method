import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { projectRoot } from './plugin-files.mjs';
import { publishDocument } from '../src/playbook/publish.ts';

const run = promisify(execFile);
const cli = path.join(projectRoot, 'runtime/playbook.mjs');
const prefix = 'learningcoder-playbook-';
const temporary = await mkdtemp(path.join(tmpdir(), prefix));
const workspace = path.join(temporary, 'analysis with spaces');
await mkdir(path.join(workspace, 'captures'), { recursive: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/mXcAAAAASUVORK5CYII=', 'base64');
await writeFile(path.join(workspace, 'captures/frame.png'), png);
await writeFile(path.join(temporary, 'outside.png'), png);
const source = path.join(workspace, 'playbook.md');
const output = path.join(workspace, 'playbook.html');
let server;

async function render(input, destination, extra = []) {
  const result = await run(process.execPath, [cli, 'render', input, '--out', destination, ...extra], { windowsHide: true, timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(result.stdout);
}

async function rejection(markdown, label, message) {
  const input = path.join(workspace, `${label}.md`);
  await writeFile(input, markdown);
  await assert.rejects(() => render(input, path.join(workspace, `${label}.html`)), error => {
    assert.match(error.stderr, message); return true;
  });
}

async function startPreview() {
  server = spawn(process.execPath, [cli, 'serve', workspace, '--port', '0'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let output = '', errors = '';
    const timeout = setTimeout(() => reject(new Error('Preview server did not start')), 15000);
    server.stderr.on('data', data => { errors += data; });
    server.once('error', reject);
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Preview server exited ${code}: ${errors}`)); });
    server.stdout.on('data', data => {
      output += data;
      if (output.includes('\n')) { clearTimeout(timeout); resolve(JSON.parse(output.trim())); }
    });
  });
}

function http(port, target, method = 'GET', host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: target, method, headers: { Host: host } }, res => {
      const chunks = [];
      res.on('data', data => chunks.push(data));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    req.on('error', reject); req.end();
  });
}

try {
  const publication = path.join(workspace, 'publication-check');
  await mkdir(path.join(publication, 'old-site'), { recursive: true });
  await mkdir(path.join(publication, 'new-site'));
  await mkdir(path.join(publication, 'new-source'));
  await writeFile(path.join(publication, 'old-site/index.html'), 'Previous site');
  await writeFile(path.join(publication, 'new-site/index.html'), 'New site');
  await writeFile(path.join(publication, 'entry.html'), 'Previous entry');
  await assert.rejects(() => publishDocument({ parent: publication, builtSite: path.join(publication, 'new-site'), sourceProject: path.join(publication, 'new-source'), site: path.join(publication, 'old-site'), sourceDirectory: path.join(publication, 'missing-parent/source'), output: path.join(publication, 'entry.html'), html: 'New entry', validate: async () => {} }), /ENOENT/);
  assert.equal(await readFile(path.join(publication, 'old-site/index.html'), 'utf8'), 'Previous site');
  assert.equal(await readFile(path.join(publication, 'entry.html'), 'utf8'), 'Previous entry');
  await writeFile(path.join(workspace, 'session.json'), JSON.stringify({ language: 'fr' }));
  await writeFile(source, '# Synthèse\n\n## Méthode\n\nAucune méthode identifiée.\n\n![Capture](captures/frame.png)\n\n| Observation | État |\n| --- | --- |\n| Exemple | Vérifié |\n\n\`\`\`mermaid\n%%{init: {"theme":"forest"}}%%\nflowchart LR\nA[Vidéo] --> B[Résumé]\n\`\`\`\n\n<script>alert("unsafe")</script>\n\n[Unsafe](javascript:alert(1))\n');
  await rejection('![escape](../outside.png)', 'escape', /outside the Markdown directory/);
  await rejection('![external](https://example.com/image.png)', 'external', /Only contained local image paths/);
  await rejection('![data](data:image/png;base64,AAAA)', 'data', /Only contained local image paths/);
  await rejection('{{ globalThis.process }}', 'expression', /Vue template expressions/);
  await rejection('<span>{{ globalThis.process }}</span>', 'html-expression', /Vue template expressions/);
  await rejection('\`\`\`js:no-v-pre\n{{ 1+1 }}\n\`\`\`', 'executable', /Executable Vue code blocks/);
  await writeFile(path.join(workspace, 'fake.png'), '<script>bad</script>');
  await rejection('![fake](fake.png)', 'fake', /bytes do not match/);
  await assert.rejects(() => render(source, output, ['--language', 'invalid_tag']), error => /Invalid document language/.test(error.stderr));
  const result = await render(source, output);
  assert.equal(result.engine, 'vuepress');
  assert.equal(result.language, 'fr');
  assert.equal(result.images, 1);
  assert.equal(result.diagrams, 1);
  const launcher = await readFile(output, 'utf8');
  assert.ok(launcher.includes('lang="fr"'));
  assert.ok(launcher.includes('./playbook-site/'));
  const html = await readFile(path.join(result.siteDirectory, 'index.html'), 'utf8');
  assert.ok(html.includes('lang="fr"'));
  assert.ok(html.includes('Aucune méthode'));
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('data:image/png;base64,'));
  assert.ok(!html.includes('class="language-mermaid"'), 'The chart plugin replaces the Mermaid code fence');
  assert.ok(!html.includes('<script>alert("unsafe")'));
  assert.ok(!html.includes('href="javascript:'));
  const config = await readFile(path.join(result.sourceDirectory, '.vuepress/config.mjs'), 'utf8');
  const client = await readFile(path.join(result.sourceDirectory, '.vuepress/client.mjs'), 'utf8');
  const generatedMarkdown = await readFile(path.join(result.sourceDirectory, 'README.md'), 'utf8');
  assert.ok(config.includes('markdownChartPlugin({ mermaid: true })'));
  assert.ok(client.includes("theme: 'neutral'"));
  assert.ok(client.includes("securityLevel: 'strict'"));
  assert.ok(!generatedMarkdown.includes('theme":"forest'));
  assert.ok((await readFile(source, 'utf8')).includes('theme":"forest'));
  await assert.rejects(() => render(source, output), error => /EEXIST/.test(error.stderr));
  const regenerated = await render(source, output, ['--force', '--language', 'fr-FR']);
  assert.equal(regenerated.language, 'fr-FR');
  assert.ok((await readFile(path.join(regenerated.siteDirectory, 'index.html'), 'utf8')).includes('lang="fr-FR"'));
  const unowned = path.join(workspace, 'unowned-site');
  await mkdir(unowned);
  await writeFile(path.join(unowned, 'keep.txt'), 'Keep this');
  await assert.rejects(() => render(source, path.join(workspace, 'unowned.html'), ['--force']), error => /unowned site directory/.test(error.stderr));
  assert.equal(await readFile(path.join(unowned, 'keep.txt'), 'utf8'), 'Keep this');
  let symlinkChecked = false;
  try {
    await symlink(temporary, path.join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await rejection('![linked](linked/outside.png)', 'linked-image', /Image link is outside/);
    symlinkChecked = true;
  } catch (error) { if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error; }
  await writeFile(path.join(workspace, '.private.json'), '{"hidden":true}');
  await writeFile(path.join(workspace, 'source.js'), 'console.log("not served")');
  const preview = await startPreview();
  assert.equal(preview.host, '127.0.0.1');
  const page = await http(preview.port, '/');
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('./playbook-site/'));
  assert.equal((await http(preview.port, '/playbook-site/')).status, 200);
  const latestHtml = await readFile(path.join(regenerated.siteDirectory, 'index.html'), 'utf8');
  const asset = latestHtml.match(/(?:src|href)="(\/playbook-site\/assets\/[^"]+\.js)"/)?.[1];
  assert.ok(asset);
  const javascript = await http(preview.port, asset);
  assert.equal(javascript.status, 200);
  assert.ok(javascript.headers['content-type'].startsWith('text/javascript'));
  assert.equal((await http(preview.port, '/playbook-site/index.html', 'HEAD')).body, '');
  assert.equal((await http(preview.port, '/captures/frame.png')).headers['content-type'], 'image/png');
  assert.equal((await http(preview.port, '/%2e%2e/outside.png')).status, 403);
  assert.equal((await http(preview.port, '/.private.json')).status, 403);
  assert.equal((await http(preview.port, '/source.js')).status, 404);
  assert.equal((await http(preview.port, '/captures/')).status, 404);
  assert.equal((await http(preview.port, '/', 'POST')).status, 405);
  assert.equal((await http(preview.port, '/', 'GET', 'untrusted.example')).status, 403);
  if (symlinkChecked) assert.equal((await http(preview.port, '/linked/outside.png')).status, 403);
  console.log(JSON.stringify({ passed: true, engine: 'vuepress', checks: ['real VuePress build from Markdown', 'French session language', 'official Mermaid neutral config', 'embedded capture and tables', 'unsafe Markdown safeguards', 'owned output protection', 'image containment', 'loopback asset serving and HTTP restrictions'], symlinkEscapeChecked: symlinkChecked }, null, 2));
} finally {
  if (server && server.exitCode === null) {
    const stopped = new Promise(resolve => server.once('exit', resolve));
    server.kill();
    await stopped;
  }
  assert.equal(path.dirname(temporary), path.resolve(tmpdir()));
  assert.ok(path.basename(temporary).startsWith(prefix));
  assert.equal((await lstat(temporary)).isSymbolicLink(), false);
  assert.equal(path.dirname(await realpath(temporary)), await realpath(tmpdir()));
  await rm(temporary, { recursive: true, force: true });
}
