import path from 'node:path';
import { renderDocument } from './renderer.js';
import { serveDirectory } from './server.js';

const help = `Interactive Method VuePress document renderer
node runtime/playbook.mjs render <input.md> --out <output.html> [--title <text>] [--language <BCP47>] [--force]
node runtime/playbook.mjs serve <analysis-directory> [--port 0]

Build a VuePress site from Markdown using the official Mermaid chart plugin.
The first build installs the locked toolchain into the user cache using npm.
The HTML entry opens its adjacent <name>-site directory over the local preview server.
Language defaults to session.language, then en. The Markdown author supplies translated text.
Serve only the chosen analysis directory on 127.0.0.1.
Existing outputs are refused unless --force is supplied.`;

function options(args: string[]): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (key === '--force') { values.force = true; continue; }
    if (!['--out', '--title', '--port', '--language'].includes(key) || !args[index + 1] || args[index + 1]!.startsWith('--')) throw new Error(`Invalid or incomplete option: ${key}`);
    values[key.slice(2)] = args[++index]!;
  }
  return values;
}

try {
  const [command, location, ...args] = process.argv.slice(2);
  if (!command || ['--help', '-h', 'help'].includes(command)) console.log(help);
  else {
    if (!location) throw new Error('Input path required.');
    const opts = options(args);
    if (command === 'render') {
      if (typeof opts.out !== 'string' || opts.port !== undefined) throw new Error('render requires --out and does not accept --port.');
      console.log(JSON.stringify(await renderDocument(path.resolve(location), path.resolve(opts.out), { title: typeof opts.title === 'string' ? opts.title : undefined, language: typeof opts.language === 'string' ? opts.language : undefined, overwrite: opts.force === true }), null, 2));
    } else if (command === 'serve') {
      if (Object.keys(opts).some(key => key !== 'port')) throw new Error('serve accepts only --port.');
      const port = Number(opts.port ?? 0);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 through 65535.');
      await serveDirectory(path.resolve(location), port);
    } else throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
