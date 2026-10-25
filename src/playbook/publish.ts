import { cp, lstat, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function publishDocument(options: {
  parent: string;
  builtSite: string;
  sourceProject: string;
  site: string;
  sourceDirectory: string;
  output: string;
  html: string;
  validate: () => Promise<void>;
}): Promise<void> {
  const staging = await mkdtemp(path.join(options.parent, '.learningcoder-publish-'));
  const entries = [
    { target: options.site, staged: path.join(staging, 'site'), backup: path.join(staging, 'previous-site'), saved: false, published: false },
    { target: options.sourceDirectory, staged: path.join(staging, 'source'), backup: path.join(staging, 'previous-source'), saved: false, published: false },
    { target: options.output, staged: path.join(staging, 'entry.html'), backup: path.join(staging, 'previous-entry.html'), saved: false, published: false },
  ];
  let preserveBackup = false;
  try {
    // Copy everything first, leaving the previous working site intact if a copy fails.
    await cp(options.builtSite, entries[0]!.staged, { recursive: true, errorOnExist: true });
    await cp(options.sourceProject, entries[1]!.staged, { recursive: true, filter: item => !['.temp', '.cache'].includes(path.basename(item)) });
    await writeFile(entries[2]!.staged, options.html, { flag: 'wx' });
    await options.validate();
    try {
      for (const entry of entries) {
        try { await lstat(entry.target); await rename(entry.target, entry.backup); entry.saved = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await rename(entry.staged, entry.target);
        entry.published = true;
      }
    } catch (error) {
      const failures: unknown[] = [];
      for (const entry of [...entries].reverse()) {
        try {
          if (entry.published) await rm(entry.target, { recursive: true, force: true });
          if (entry.saved) await rename(entry.backup, entry.target);
        } catch (restoreError) { failures.push(restoreError); }
      }
      if (failures.length) {
        preserveBackup = true;
        throw new Error(`Document publication failed and recovery files were preserved at ${staging}. ${String(error)}`);
      }
      throw error;
    }
  } finally {
    if (!preserveBackup) {
      if (path.dirname(staging) !== options.parent || !path.basename(staging).startsWith('.learningcoder-publish-') || (await lstat(staging)).isSymbolicLink()) throw new Error('Unexpected publication staging directory.');
      await rm(staging, { recursive: true, force: true });
    }
  }
}
