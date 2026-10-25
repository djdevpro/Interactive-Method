import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, realpath, stat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

export class CommandError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new CommandError('USAGE', `${name} is required.`);
  return value;
}

export function numberOption(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.trim() === '') throw new CommandError('USAGE', `${name} must be a number.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new CommandError('USAGE', `${name} must be between ${min} and ${max}.`);
  return parsed;
}

export async function localFile(value: string): Promise<string> {
  const path = await realpath(resolve(value));
  if (!(await stat(path)).isFile()) throw new CommandError('INPUT_FILE', 'The input must be a local regular file.');
  return path;
}

export async function ensureAbsent(path: string): Promise<void> {
  try { await stat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new CommandError('OUTPUT_EXISTS', `Output already exists: ${path}. Choose a new output path.`);
}

export async function outputFile(value: string): Promise<string> {
  const path = resolve(required(value, '--out'));
  await mkdir(dirname(path), { recursive: true });
  await ensureAbsent(path);
  return path;
}

export async function writeNew(path: string, content: string): Promise<void> {
  const handle = await open(path, 'wx');
  try { await handle.writeFile(content, 'utf8'); }
  catch (error) { await handle.close().catch(() => undefined); await unlink(path).catch(() => undefined); throw error; }
  finally { await handle.close().catch(() => undefined); }
}

export const jsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
export const temporaryPath = (path: string): string => `${path}.partial-${randomUUID()}`;

/** Publish without replacement, even if another process creates the target after preflight. */
export async function publishFile(temporary: string, path: string): Promise<void> {
  await copyFile(temporary, path, constants.COPYFILE_EXCL);
  await unlink(temporary).catch(() => undefined);
}

export async function removeOwned(paths: readonly string[]): Promise<void> {
  for (const path of paths) await unlink(path).catch(() => undefined);
}

export async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
