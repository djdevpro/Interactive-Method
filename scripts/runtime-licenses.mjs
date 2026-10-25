import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { projectRoot } from './plugin-files.mjs';

export async function bundleNotices(results) {
  const packages = new Map();
  for (const filename of results.flatMap(result => Object.keys(result.metafile.inputs))) {
    if (!filename.replaceAll('\\', '/').includes('node_modules/')) continue;
    let directory = path.dirname(path.resolve(projectRoot, filename));
    while (directory !== path.dirname(directory)) {
      try {
        const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
        if (metadata.name && metadata.version) { packages.set(directory, metadata); break; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      directory = path.dirname(directory);
    }
  }
  const notices = ['Third-party components included in the HTML renderer.\nOriginal license texts follow.'];
  for (const [directory, metadata] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const candidates = (await readdir(directory)).filter(name => /^(licen[sc]e|copying|notice|copyright)(?:[.-].*)?$/i.test(name));
    const files = [];
    for (const name of candidates) if ((await stat(path.join(directory, name))).isFile()) files.push(name);
    if (!files.length) throw new Error(`Missing bundled license text for ${metadata.name}@${metadata.version}`);
    notices.push(`\n${'='.repeat(72)}\n${metadata.name}@${metadata.version}\nDeclared license: ${JSON.stringify(metadata.license ?? metadata.licenses ?? 'See text below')}\n`);
    for (const name of files) notices.push(`${name}\n\n${await readFile(path.join(directory, name), 'utf8')}`);
  }
  return notices.join('\n');
}
