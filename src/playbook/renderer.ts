import { lstat, readFile, realpath, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { Marked, type Tokens } from 'marked';
import { vuepressConfig, clientConfig } from './config.js';
import { ensureToolchain, runNode } from './toolchain.js';
import { collectToolchainNotices } from './licenses.js';
import { publishDocument } from './publish.js';

const MAX_MARKDOWN_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const imageTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const marker = '.learningcoder-vuepress.json';
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function normalizeLanguage(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A valid BCP 47 document language is required.');
  try { return Intl.getCanonicalLocales(value)[0]!; }
  catch { throw new Error(`Invalid document language: ${value}`); }
}

async function documentLanguage(root: string, explicit?: string): Promise<string> {
  if (explicit !== undefined) return normalizeLanguage(explicit);
  try {
    const session = JSON.parse(await readFile(path.join(root, 'session.json'), 'utf8'));
    return normalizeLanguage(session.language ?? 'en');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'en'; throw error; }
}

async function embedImage(root: string, href: string): Promise<string> {
  if (/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(href) || href.includes('?') || href.includes('#')) throw new Error(`Only contained local image paths are supported: ${href}`);
  let decoded: string;
  try { decoded = decodeURIComponent(href); } catch { throw new Error(`Invalid image path: ${href}`); }
  if (/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(decoded) || decoded.includes('\0')) throw new Error(`Invalid image path: ${href}`);
  const target = path.resolve(root, decoded);
  if (!contained(root, target)) throw new Error(`Image path is outside the Markdown directory: ${href}`);
  const resolved = await realpath(target);
  if (!contained(root, resolved)) throw new Error(`Image link is outside the Markdown directory: ${href}`);
  const mime = imageTypes[path.extname(resolved).toLowerCase()];
  if (!mime) throw new Error(`Unsupported image type: ${href}`);
  const stat = await lstat(resolved);
  if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error(`Image is not a file or exceeds 20 MiB: ${href}`);
  const bytes = await readFile(resolved);
  const valid = mime === 'image/png' ? bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
    : mime === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8
      : mime === 'image/webp' ? bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
        : bytes.subarray(0, 6).toString() === 'GIF87a' || bytes.subarray(0, 6).toString() === 'GIF89a';
  if (!valid) throw new Error(`Image bytes do not match its type: ${href}`);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

export async function prepareMarkdown(source: string, site: string): Promise<{ markdown: string; title: string; images: number; diagrams: number }> {
  const stat = await lstat(source);
  if (!stat.isFile() || stat.size > MAX_MARKDOWN_BYTES) throw new Error('Markdown must be a file no larger than 10 MiB.');
  let markdown = (await readFile(source, 'utf8')).replace(/^\uFEFF/, '');
  const parser = new Marked();
  const tokens = parser.lexer(markdown);
  let images = 0, diagrams = 0, title = '';
  const replacements = new Map<string, string>();
  await Promise.all(parser.walkTokens(tokens, token => {
    if (['text', 'html', 'image', 'heading', 'link'].includes(token.type) && 'text' in token && /\{\{/.test(String(token.text))) throw new Error('Vue template expressions are not supported in document prose. Put examples in a code block.');
    if (token.type === 'heading' && (token as Tokens.Heading).depth === 1 && !title) title = (token as Tokens.Heading).text.replace(/[*_`]/g, '');
    if (token.type === 'image') {
      const image = token as Tokens.Image;
      images++;
      return embedImage(path.dirname(source), image.href).then(href => {
        const label = image.text.replace(/[\[\]<>\r\n]/g, ' ');
        replacements.set(image.raw, `![${label}](${href})`);
      });
    }
    if (token.type === 'link') {
      const link = token as Tokens.Link;
      if (!/^(?:[a-z][a-z\d+.-]*:|\/|\\|#)/i.test(link.href)) {
        const [pathname, suffix = ''] = link.href.split(/(?=[?#])/s, 2);
        const target = path.resolve(path.dirname(source), decodeURIComponent(pathname!));
        if (!contained(path.dirname(source), target) || !contained(path.dirname(site), target)) throw new Error('Evidence links must stay inside the analysis directory.');
        const relative = path.relative(site, target).split(path.sep).map(part => encodeURIComponent(part)).join('/') + suffix;
        replacements.set(link.raw, `[${link.text}](${relative})`);
      }
    }
    if (token.type === 'code') {
      const code = token as Tokens.Code;
      if (/:no-v-pre\b/.test(code.lang ?? '')) throw new Error('Executable Vue code blocks are not supported in analysis documents.');
      if (code.lang?.trim() === 'mermaid') {
        diagrams++;
        const diagram = code.text.replace(/%%\{[\s\S]*?\}%%/g, '').replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, '').replace(/^\s*(?:click|style|classDef|linkStyle)\b.*$/gm, '');
        replacements.set(code.raw, '\`\`\`mermaid\n' + diagram + '\n\`\`\`\n');
      }
    }
    return undefined;
  }));
  for (const [before, after] of replacements) markdown = markdown.split(before).join(after);
  return { markdown, title: title || path.basename(source, '.md'), images, diagrams };
}

async function checkOutput(output: string, site: string, overwrite: boolean): Promise<void> {
  try {
    const info = await lstat(output);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Refusing to replace a linked or non-file output.');
    if (!overwrite) throw new Error('EEXIST: Output exists. Use --force to regenerate it.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try {
    const info = await lstat(site);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Refusing to replace a linked or non-directory site.');
    const ownership = JSON.parse(await readFile(path.join(site, marker), 'utf8'));
    if (ownership.output !== output || ownership.engine !== 'vuepress') throw new Error('The existing site directory is not owned by this document.');
    if (!overwrite) throw new Error('EEXIST: Site exists. Use --force to regenerate it.');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; else {
    try { await lstat(site); throw new Error('Refusing to replace an unowned site directory.'); } catch (missing) { if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing; }
  } }
}

export async function renderDocument(input: string, output: string, options: { title?: string; language?: string; overwrite?: boolean } = {}) {
  const source = await realpath(input);
  output = path.resolve(output);
  if (!/\.md$/i.test(source)) throw new Error('Input must be a Markdown (.md) file.');
  if (!/\.html?$/i.test(output)) throw new Error('Output must be an HTML file.');
  await mkdir(path.dirname(output), { recursive: true });
  const parent = await realpath(path.dirname(output));
  output = path.join(parent, path.basename(output));
  const siteName = path.basename(output).replace(/\.html?$/i, '') + '-site';
  const site = path.join(parent, siteName);
  await checkOutput(output, site, options.overwrite === true);
  const language = await documentLanguage(path.dirname(source), options.language);
  const prepared = await prepareMarkdown(source, site);
  const title = options.title?.trim() || prepared.title;
  const sourceRoot = path.join(parent, '.vuepress-source');
  await mkdir(sourceRoot, { recursive: true });
  if ((await lstat(sourceRoot)).isSymbolicLink()) throw new Error('Refusing a linked VuePress source directory.');
  const savedSource = path.join(sourceRoot, path.basename(output).replace(/\.html?$/i, ''));
  await checkOutput(output, savedSource, options.overwrite === true);
  const toolchain = await ensureToolchain();
  const jobs = path.join(toolchain, 'jobs');
  await mkdir(jobs, { recursive: true });
  const job = await mkdtemp(path.join(jobs, 'build-'));
  const docs = path.join(job, 'source');
  const configDirectory = path.join(docs, '.vuepress');
  const dist = path.join(job, 'dist');
  const base = '/' + encodeURIComponent(siteName) + '/';
  try {
    await mkdir(configDirectory, { recursive: true });
    await writeFile(path.join(docs, 'README.md'), prepared.markdown);
    await writeFile(path.join(configDirectory, 'config.mjs'), vuepressConfig(base, title, language));
    await writeFile(path.join(configDirectory, 'client.mjs'), clientConfig(language));
    const ownership = JSON.stringify({ engine: 'vuepress', output, language, source });
    await writeFile(path.join(docs, marker), ownership);
    await runNode([path.join(toolchain, 'node_modules/vuepress/bin/vuepress.js'), 'build', docs, '--dest', dist, '--clean-cache', '--clean-temp'], job);
    const built = await readFile(path.join(dist, 'index.html'), 'utf8');
    if (!built.includes('vuepress') && !built.includes('__VUEPRESS')) throw new Error('VuePress output could not be verified.');
    await writeFile(path.join(dist, 'THIRD-PARTY-NOTICES.txt'), await collectToolchainNotices(toolchain));
    await writeFile(path.join(dist, marker), ownership);
    const target = './' + encodeURIComponent(siteName) + '/';
    const linkLabel = language.toLowerCase().startsWith('fr') ? 'Ouvrir le document' : title;
    const html = `<!doctype html><html lang="${escapeHtml(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><meta http-equiv="refresh" content="0;url=${target}"></head><body><a href="${target}">${escapeHtml(linkLabel)}</a></body></html>\n`;
    await publishDocument({
      parent, builtSite: dist, sourceProject: docs, site, sourceDirectory: savedSource, output, html,
      validate: async () => {
        await checkOutput(output, site, options.overwrite === true);
        await checkOutput(output, savedSource, options.overwrite === true);
      },
    });
    return { output, engine: 'vuepress', siteDirectory: site, sourceDirectory: savedSource, language, title, images: prepared.images, diagrams: prepared.diagrams };
  } finally {
    if (path.dirname(job) !== jobs || !path.basename(job).startsWith('build-') || (await lstat(job)).isSymbolicLink()) throw new Error('Unexpected VuePress job directory.');
    await rm(job, { recursive: true, force: true });
  }
}
