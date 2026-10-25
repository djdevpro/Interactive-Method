#!/usr/bin/env node
import { readFile, writeFile, mkdir, access, realpath, stat, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const help = `Video Method Lab - analysis sessions
node scripts/session.mjs init <new-directory> --video <id-or-url> [--language <BCP-47-tag>] [--objective <text>] [--depth initial|deep|complete] [--mermaid] [--supplementary-sources]
node scripts/session.mjs deepen <directory> [--supplementary-sources]
node scripts/session.mjs status <directory>
node scripts/session.mjs resume <directory>
node scripts/session.mjs validate <directory>
Initialization always starts with an overview, reviewed captures and a neutral Mermaid diagram.
Pass the user's requested or conversational language with --language. The context-free CLI default is en.
Use deepen only after presenting the first pass and receiving the user's request to continue.
Use --supplementary-sources only for a separate explicit request for external research.
Validation checks structure and references. Evidence still requires human review.`;
const [command, location, ...args] = process.argv.slice(2);
const phases = ['created', 'mapping', 'analyzing', 'first-pass-ready', 'investigating', 'consolidating', 'writing', 'completed'];
const detectionStates = ['pending', 'identified', 'none', 'uncertain'];
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const exists = async file => { try { await access(file); return true; } catch { return false; } };

function languageTag(value = 'en') {
  if (!nonempty(value) || value !== value.trim()) throw new Error('Language must be a valid BCP 47 tag, such as fr or en-US.');
  try { return Intl.getCanonicalLocales(value)[0]; }
  catch { throw new Error('Language must be a valid BCP 47 tag, such as fr or en-US.'); }
}

function inside(root, relative) {
  if (!nonempty(relative) || path.isAbsolute(relative)) throw new Error(`Relative path required: ${relative}`);
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`Path outside session: ${relative}`);
  return target;
}
async function checkedPath(root, relative) {
  const target = inside(root, relative);
  if (await exists(target)) {
    const rel = path.relative(await realpath(root), await realpath(target));
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`Link outside session: ${relative}`);
  }
  return target;
}
function videoId(value) {
  if (/^[\w-]{11}$/.test(value ?? '')) return value;
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid YouTube ID or URL.'); }
  const host = url.hostname.replace(/^www\./, '');
  if (!['youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) throw new Error('YouTube URL required.');
  const id = host === 'youtu.be' ? url.pathname.slice(1) : (url.searchParams.get('v') ?? url.pathname.match(/^\/(?:shorts|embed)\/([\w-]{11})/)?.[1]);
  if (!/^[\w-]{11}$/.test(id ?? '')) throw new Error('Invalid video ID.');
  return id;
}
function options(values, mode = 'init') {
  const out = {};
  for (let i = 0; i < values.length; i++) {
    const key = values[i];
    if (key === '--supplementary-sources') { out.supplementarySourcesRequested = true; continue; }
    if (mode === 'init' && key === '--mermaid') continue;
    if (mode !== 'init' || !['--video', '--language', '--objective', '--depth'].includes(key) || !values[i + 1] || values[i + 1].startsWith('--')) throw new Error(`Invalid or incomplete option: ${key}`);
    out[key.slice(2)] = values[++i];
  }
  return out;
}
function checkState(session, fail) {
  if (!session.id || !session.objective || !session.video?.id) fail('Session identity, objective or video is missing.');
  try { languageTag(session.language); } catch (error) { fail(error.message); }
  if (!phases.includes(session.phase)) fail('Unknown phase.');
  if (!['active', 'awaiting-user', 'blocked', 'completed'].includes(session.status)) fail('Unknown status.');
  if (!['initial', 'deep', 'complete'].includes(session.scope?.depth)) fail('Unknown depth.');
  for (const key of ['deepDiveRequested', 'supplementarySourcesRequested']) {
    if (session[key] !== undefined && typeof session[key] !== 'boolean') fail(`${key} must be a boolean.`);
  }
  if (session.methodDetection && !detectionStates.includes(session.methodDetection.status)) fail('Unknown method detection status.');
  if (session.firstPass && !['pending', 'ready'].includes(session.firstPass.status)) fail('Unknown first-pass status.');
  if (session.firstPass && !['pending', 'reviewed', 'unavailable'].includes(session.firstPass.visualStatus)) fail('Unknown first-pass visual status.');
  if (session.firstPass && session.scope?.mermaid !== true) fail('The first pass requires a Mermaid diagram.');
  if (['investigating', 'consolidating', 'writing'].includes(session.phase) && session.deepDiveRequested !== true) fail('Deep analysis requires an explicit user request after the first pass.');
  if (session.phase === 'investigating' && session.supplementarySourcesRequested !== true) fail('Supplementary research requires an explicit user request.');
  if (session.status === 'completed' && session.phase !== 'completed') fail('Completed session has an unfinished phase.');
  if (session.deepDiveRequested === true && session.firstPass?.status !== 'ready') fail('Deep analysis requires a ready first pass.');
  if (session.phase === 'first-pass-ready' && session.firstPass?.status !== 'ready') fail('The first-pass-ready phase requires a ready first pass.');
  if (session.firstPass?.status === 'ready' && session.deepDiveRequested !== true && !['awaiting-user', 'completed'].includes(session.status)) fail('Present the ready first pass and await the user before continuing.');
  if (session.firstPass?.status === 'ready' && session.deepDiveRequested !== true && !['first-pass-ready', 'completed'].includes(session.phase)) fail('A ready overview must remain at the first-pass-ready phase until the user continues.');
}
function checkEvidence(value, evidenceIds, label, fail) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (key !== 'evidenceIds') { checkEvidence(nested, evidenceIds, label, fail); continue; }
    if (!Array.isArray(nested)) { fail(`Invalid evidence list in ${label}`); continue; }
    for (const id of nested) if (!evidenceIds.has(id)) fail(`Unknown evidence ${id} in ${label}`);
  }
}
async function checkFirstPass(session, context) {
  const { fail, pathCheck, registers, sourceIds, evidenceIds } = context;
  const ready = session.firstPass?.status === 'ready';
  if (!ready) {
    if (session.status === 'completed') fail('Completed session requires a ready first pass.');
    return;
  }
  const detection = session.methodDetection ?? {};
  if (!['identified', 'none', 'uncertain'].includes(detection.status) || !nonempty(detection.reason)) fail('The first pass needs a supported method detection decision and reason.');
  if (detection.status === 'identified' && !session.methods?.length) fail('Identified methods need method records.');
  if (['none', 'uncertain'].includes(detection.status) && session.methods?.length) fail('Do not invent method records when no method has been identified.');
  if (!sourceIds.size) fail('The first pass needs a source record for the requested video.');
  checkEvidence(detection, evidenceIds, 'method detection', fail);
  if (registers.videoMap && registers.videoMap.methods?.length !== (session.methods ?? []).length) fail('Video map and session method counts differ.');
  if (session.scope?.mermaid !== true) fail('The first pass requires a Mermaid diagram.');
  const firstPass = session.firstPass;
  if (firstPass.visualStatus === 'unavailable') {
    if (!firstPass.limitations?.some(nonempty)) fail('Explain why first-pass screenshots were unavailable.');
    return;
  }
  if (firstPass.visualStatus !== 'reviewed' || !firstPass.captures?.length) {
    fail('Review targeted screenshots before presenting the first pass, or document their unavailability.');
    return;
  }
  for (const capture of firstPass.captures) {
    await pathCheck(capture.path);
    if (!Number.isFinite(capture.timestampSeconds) || capture.timestampSeconds < 0 || !nonempty(capture.reviewedAt) || !Number.isFinite(Date.parse(capture.reviewedAt)) || !nonempty(capture.observation)) fail('First-pass captures need a timestamp, review date and observation.');
    checkEvidence(capture, evidenceIds, 'first-pass capture', fail);
  }
}
async function checkMethods(session, context) {
  const { fail, pathCheck, sourceIds, evidenceIds, methodIds, deepFinal } = context;
  for (const method of session.methods ?? []) {
    const target = await pathCheck(method.path);
    if (!target) continue;
    let data;
    try { data = await json(target); } catch { fail(`Invalid method JSON: ${method.path}`); continue; }
    if (data.id !== method.id) fail(`Inconsistent ID: ${method.path}`);
    if (!sourceIds.has(data.sourceId)) fail(`Unknown source for ${method.id}`);
    for (const interval of data.intervals ?? []) if (!(Number.isFinite(interval.start) && interval.start >= 0 && interval.end > interval.start)) fail(`Invalid interval: ${method.id}`);
    for (const dep of data.dependencies ?? []) if (!methodIds.has(typeof dep === 'string' ? dep : dep.methodId)) fail(`Unknown dependency: ${method.id}`);
    checkEvidence(data, evidenceIds, method.id, fail);
    for (const capture of data.visual?.captures ?? []) if (capture.path) await pathCheck(capture.path);
    if (!deepFinal) continue;
    if (!data.authorVersion?.steps?.length) fail(`Missing author steps: ${method.id}`);
    if (!['reviewed-useful', 'reviewed-no-added-value', 'unavailable'].includes(data.visual?.status)) fail(`Visual inspection unfinished: ${method.id}`);
    if (data.visual?.status === 'unavailable' && !data.limitations?.length) fail(`Visual limitation not explained: ${method.id}`);
    if (data.audit?.remainingRequirements?.length) fail(`Remaining requirements: ${method.id}`);
    if (!['reviewed', 'reviewed-with-limitations', 'passed', 'completed'].includes(data.audit?.status)) fail(`Method audit not approved: ${method.id}`);
  }
}
async function validate(root, session) {
  const errors = [], warnings = [];
  const fail = text => errors.push(text);
  checkState(session, fail);
  const final = session.status === 'completed';
  const deepFinal = final && session.deepDiveRequested === true;
  const ready = session.firstPass?.status === 'ready';
  const pathCheck = async (relative, required = true) => {
    try {
      const target = await checkedPath(root, relative);
      if (!await exists(target)) { if (required) fail(`Missing file: ${relative}`); return null; }
      const info = await stat(target);
      if (!info.isFile()) { fail(`Expected file: ${relative}`); return null; }
      if (info.size === 0) { fail(`Empty file: ${relative}`); return null; }
      return target;
    } catch (error) { fail(error.message); return null; }
  };
  const requiredArtifacts = new Set(['videoMap', 'domainMap', 'sources', 'audit']);
  if (ready || final) { requiredArtifacts.add('overview'); requiredArtifacts.add('diagram'); }
  if (deepFinal) {
    requiredArtifacts.add('playbook');
    requiredArtifacts.add('playbookHtml');
    if (session.supplementarySourcesRequested === true) requiredArtifacts.add('researchPlan');
  }
  for (const key of requiredArtifacts) if (!nonempty(session.artifacts?.[key])) fail(`Missing required artifact reference: ${key}`);
  const registers = {};
  for (const [key, relative] of Object.entries(session.artifacts ?? {})) {
    const target = await pathCheck(relative, requiredArtifacts.has(key));
    if (!target) continue;
    if (relative.endsWith('.json')) {
      try { registers[key] = await json(target); } catch (error) { fail(`Invalid JSON ${relative}: ${error.message}`); }
    }
  }
  const unique = (items, label) => {
    const ids = new Set();
    for (const item of items ?? []) { if (!item.id || ids.has(item.id)) fail(`Missing or duplicate ID in ${label}: ${item.id}`); ids.add(item.id); }
    return ids;
  };
  const sourceIds = unique(registers.sources?.sources, 'sources');
  const evidenceIds = unique(registers.sources?.evidence, 'evidence');
  const methodIds = unique(session.methods, 'methods');
  unique(session.missions, 'missions');
  for (const source of registers.sources?.sources ?? []) if (source.localPath) await pathCheck(source.localPath);
  for (const evidence of registers.sources?.evidence ?? []) {
    if (!sourceIds.has(evidence.sourceId)) fail(`Unknown source for ${evidence.id}`);
    if (evidence.locator?.path) await pathCheck(evidence.locator.path);
  }
  const context = { fail, pathCheck, registers, sourceIds, evidenceIds, methodIds, deepFinal };
  await checkFirstPass(session, context);
  await checkMethods(session, context);
  for (const mission of session.missions ?? []) {
    if (mission.path) await pathCheck(mission.path);
    if (mission.resultPath) await pathCheck(mission.resultPath);
    if (mission.status === 'running') warnings.push(`Check the process for ${mission.id} before resuming; this is only a saved status.`);
    if (session.deepDiveRequested !== true && ['queued', 'running'].includes(mission.status)) fail('Deep-analysis missions require an explicit deepening request.');
    if (deepFinal && mission.status !== 'completed') fail(`Mission unfinished or not reviewed: ${mission.id}`);
  }
  if (final) {
    if (session.completion?.remainingRequirements?.length) fail('The session has remaining requirements.');
    if (!session.completion?.completedAt) fail('Missing completion date.');
    if (deepFinal && (!registers.audit || registers.audit.remainingRequirements?.length || !['passed', 'completed'].includes(registers.audit.status))) fail('Audit missing or not satisfied.');
  }
  return { valid: errors.length === 0, errors, warnings, limitation: 'Structural checks do not prove that sources were read or conclusions are true.' };
}
async function saveSession(root, session) {
  const target = await checkedPath(root, 'session.json');
  const temporary = inside(root, `.session-${randomUUID()}.tmp`);
  const content = `${JSON.stringify(session, null, 2)}\n`;
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    try { await rename(temporary, target); }
    catch (error) {
      // Some Windows hosts permit writes but not replacement by rename.
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EEXIST'].includes(error.code)) throw error;
      await writeFile(await checkedPath(root, 'session.json'), content);
    }
  } finally { await rm(temporary, { force: true }); }
}
async function initialize(root, values) {
  const opts = options(values), id = videoId(opts.video);
  const language = languageTag(opts.language);
  if (opts.objective !== undefined && !opts.objective.trim()) throw new Error('Objective cannot be empty.');
  if (opts.depth && !['initial', 'deep', 'complete'].includes(opts.depth)) throw new Error('Invalid depth.');
  if (await exists(root)) throw new Error('Directory already exists; use status/resume or choose a new directory.');
  const session = await json(path.join(pluginRoot, 'templates/session.json'));
  const now = new Date().toISOString();
  Object.assign(session, {
    id, language, createdAt: now, updatedAt: now,
    objective: opts.objective ?? 'Summarize the video, identify any demonstrated methods and inspect targeted screenshots.',
    deepDiveRequested: false, supplementarySourcesRequested: opts.supplementarySourcesRequested === true,
    nextAction: 'Acquire the transcript, identify candidate methods and inspect targeted screenshots before presenting the overview.',
  });
  session.video = { id, url: `https://www.youtube.com/watch?v=${id}`, title: null };
  Object.assign(session.scope, { depth: opts.depth ?? 'initial', mermaid: true, decisionBasis: 'Start with the automatic first pass. Depth does not authorize deepening or external research.' });
  await mkdir(path.dirname(root), { recursive: true });
  await mkdir(root);
  for (const name of ['sources', 'media', 'methods', 'missions', 'synthesis']) await mkdir(path.join(root, name));
  for (const name of ['video-map', 'domain-map', 'sources', 'audit']) await writeFile(path.join(root, `${name}.json`), await readFile(path.join(pluginRoot, `templates/${name}.json`)), { flag: 'wx' });
  await writeFile(path.join(root, 'session.json'), `${JSON.stringify(session, null, 2)}\n`, { flag: 'wx' });
  return { created: root, session: 'session.json', language: session.language, nextAction: session.nextAction };
}
async function deepen(root, values) {
  const opts = options(values, 'deepen');
  const session = await json(await checkedPath(root, 'session.json'));
  if (session.firstPass?.status !== 'ready' || session.phase !== 'first-pass-ready' || session.status !== 'awaiting-user') throw new Error('Present a valid first pass and await the user before deepening.');
  const check = await validate(root, session);
  if (!check.valid) throw new Error(`First pass is not ready: ${check.errors.join(' ')}`);
  session.language = languageTag(session.language);
  session.deepDiveRequested = true;
  session.supplementarySourcesRequested = session.supplementarySourcesRequested === true || opts.supplementarySourcesRequested === true;
  session.status = 'active';
  session.phase = 'analyzing';
  session.scope.depth = 'complete';
  session.scope.mermaid = true;
  session.updatedAt = new Date().toISOString();
  session.nextAction = 'Delegate bounded analysis missions using the transcript and reviewed screenshots, then consolidate the Markdown and HTML playbook.';
  await saveSession(root, session);
  return { deepened: root, language: session.language, deepDiveRequested: true, supplementarySourcesRequested: session.supplementarySourcesRequested, nextAction: session.nextAction };
}

try {
  if (!command || ['--help', '-h', 'help'].includes(command)) { console.log(help); process.exit(0); }
  if (!location) throw new Error('Directory required.');
  const root = path.resolve(location);
  if (command === 'init') console.log(JSON.stringify(await initialize(root, args), null, 2));
  else if (command === 'deepen') console.log(JSON.stringify(await deepen(root, args), null, 2));
  else if (['status', 'resume', 'validate'].includes(command)) {
    if (args.length) throw new Error('Unknown extra arguments.');
    const session = await json(await checkedPath(root, 'session.json'));
    const check = await validate(root, session);
    console.log(JSON.stringify(command === 'validate' ? check : {
      id: session.id, objective: session.objective,
      language: check.valid ? languageTag(session.language) : session.language ?? 'en',
      deepDiveRequested: session.deepDiveRequested === true,
      supplementarySourcesRequested: session.supplementarySourcesRequested === true,
      methodDetection: session.methodDetection ?? { status: 'pending', reason: null },
      firstPass: session.firstPass ?? { status: 'pending', visualStatus: 'pending', captures: [], limitations: [] },
      status: session.status, phase: session.phase, methods: session.methods, missions: session.missions,
      openQuestions: session.openQuestions, limitations: session.limitations, nextAction: session.nextAction, validation: check,
    }, null, 2));
    if (!check.valid) process.exitCode = 1;
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; }
