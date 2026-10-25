import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const sessionCli = fileURLToPath(new URL('./session.mjs', import.meta.url));
const prefix = 'learningcoder-session-test-';
let temporary;
before(async () => { temporary = await mkdtemp(path.join(tmpdir(), prefix)); });
after(async () => {
  if (!temporary) return;
  assert.equal(path.dirname(temporary), path.resolve(tmpdir()));
  assert.ok(path.basename(temporary).startsWith(prefix));
  assert.equal((await lstat(temporary)).isSymbolicLink(), false);
  assert.equal(path.dirname(await realpath(temporary)), await realpath(tmpdir()));
  await rm(temporary, { recursive: true, force: true });
});

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [sessionCli, ...args], { cwd: temporary, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
  return JSON.parse(expectedStatus && result.stderr ? result.stderr : result.stdout);
}
const readSession = async root => JSON.parse(await readFile(path.join(root, 'session.json'), 'utf8'));
function validate(root, expectedStatus = 0) {
  const result = run(['validate', root], expectedStatus);
  assert.equal(result.valid, expectedStatus === 0);
  return result;
}
async function fixture(label, change = () => {}) {
  const root = await mkdtemp(path.join(temporary, `${label}-`));
  const step = {
    id: 'M01-ST01', title: 'Synthetic check', inputs: ['input'], actions: ['check'],
    outputs: ['result'], checks: ['observation'], failureModes: [], evidenceIds: ['E001'],
    execution: { status: 'executed-locally', details: 'Test fixture', evidenceIds: ['E001'] },
  };
  const files = {
    'session.json': {
      schemaVersion: 'video-method-lab.session/v1', id: 'fixture', objective: 'Explain the video',
      video: { id: '8w6EhLPyNXU' }, scope: { depth: 'initial', mermaid: true },
      status: 'awaiting-user', phase: 'first-pass-ready',
      deepDiveRequested: false, supplementarySourcesRequested: false,
      methodDetection: { status: 'identified', reason: 'The video demonstrates one repeatable sequence.', evidenceIds: ['E001'] },
      firstPass: {
        status: 'ready', visualStatus: 'reviewed', limitations: [],
        captures: [{ path: 'captures/initial.png', timestampSeconds: 1, reviewedAt: '2026-10-25T10:00:00Z', observation: 'The initial state is visible.', evidenceIds: ['E001'] }],
      },
      artifacts: { overview: 'overview.md', diagram: 'overview.mmd', videoMap: 'video-map.json', domainMap: 'domain-map.json', sources: 'sources.json', researchPlan: 'research-plan.md', audit: 'audit.json', playbook: 'playbook.md', playbookHtml: 'playbook.html' },
      methods: [{ id: 'M01', path: 'methods/M01.json', status: 'analyzed' }], missions: [],
      completion: { remainingRequirements: [], completedAt: null },
    },
    'overview.md': '# Video overview\nOne method is demonstrated.\n',
    'overview.mmd': 'flowchart LR\n  A[Initial state] --> B[Check result]\n',
    'video-map.json': { methods: [{ id: 'M01' }] },
    'domain-map.json': { concepts: [] },
    'sources.json': { sources: [{ id: 'S001', type: 'video' }], evidence: [{ id: 'E001', sourceId: 'S001' }] },
    'audit.json': { status: 'pending', remainingRequirements: [] },
    'captures/initial.png': 'Synthetic image fixture for file-reference validation.',
    'methods/M01.json': {
      id: 'M01', sourceId: 'S001', intervals: [{ start: 0, end: 2 }],
      authorVersion: { steps: [step] }, enrichedVersion: null,
      visual: { status: 'reviewed-no-added-value', captures: [] }, audit: { status: 'pending', remainingRequirements: [] },
    },
  };
  change(files);
  for (const [relative, data] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
  }
  return root;
}
function complete(files) {
  const session = files['session.json'];
  session.deepDiveRequested = true;
  session.status = 'completed';
  session.phase = 'completed';
  session.scope.depth = 'complete';
  session.completion.completedAt = '2026-10-25T12:00:00Z';
  files['audit.json'].status = 'passed';
  files['methods/M01.json'].audit.status = 'passed';
  files['playbook.md'] = '# Playbook\nFollow the demonstrated sequence.\n';
  files['playbook.html'] = '<!doctype html><html lang="en"><title>Playbook</title><body><h1>Playbook</h1></body></html>';
}
function noMethod(files, status = 'none') {
  files['session.json'].methodDetection = { status, reason: status === 'none' ? 'The available video presents opinions without a repeatable procedure.' : 'The unavailable transcript prevents a reliable determination.', evidenceIds: ['E001'] };
  files['session.json'].methods = [];
  files['video-map.json'].methods = [];
  delete files['methods/M01.json'];
  files['overview.md'] = '# Video overview\nNo demonstrated method has been identified.\n';
}

test('A video-only invocation starts the first pass with no depth question', async () => {
  const root = path.join(temporary, 'video-only');
  run(['init', root, '--video', 'https://youtu.be/8w6EhLPyNXU']);
  const session = await readSession(root);
  assert.equal(session.deepDiveRequested, false);
  assert.equal(session.supplementarySourcesRequested, false);
  assert.equal(session.scope.mermaid, true);
  assert.equal(session.firstPass.status, 'pending');
  assert.equal(session.language, 'en');
  assert.ok(session.objective);
  assert.deepEqual(validate(root).errors, []);
});
test('The requested document language is canonicalized and exposed without a language question', async () => {
  const root = path.join(temporary, 'french-document');
  const result = run(['init', root, '--video', '8w6EhLPyNXU', '--language', 'fr-fr']);
  assert.equal(result.language, 'fr-FR');
  assert.equal((await readSession(root)).language, 'fr-FR');
  assert.equal(run(['status', root]).language, 'fr-FR');
  assert.equal(run(['resume', root]).language, 'fr-FR');
  const scriptLanguage = path.join(temporary, 'script-language');
  run(['init', scriptLanguage, '--video', '8w6EhLPyNXU', '--language', 'zh-hant']);
  assert.equal((await readSession(scriptLanguage)).language, 'zh-Hant');
});
test('Invalid document languages fail before creating a session and are caught in saved sessions', async () => {
  for (const [index, language] of ['fr_FR', 'French language', ' en', '<script>', 'en--US'].entries()) {
    const root = path.join(temporary, `invalid-language-${index}`);
    assert.match(run(['init', root, '--video', '8w6EhLPyNXU', '--language', language], 1).error, /valid BCP 47 tag/);
    await assert.rejects(lstat(root), { code: 'ENOENT' });
  }
  for (const language of [null, '', 'fr_FR', 42]) {
    const root = await fixture('invalid-saved-language', files => { files['session.json'].language = language; });
    assert.ok(validate(root, 1).errors.some(message => message.includes('valid BCP 47 tag')));
    assert.equal(run(['resume', root], 1).validation.valid, false);
  }
});
test('Deepening preserves the chosen language and safely upgrades legacy sessions', async () => {
  const french = await fixture('french-deepen', files => { files['session.json'].language = 'fr-FR'; });
  assert.equal(run(['deepen', french]).language, 'fr-FR');
  assert.equal((await readSession(french)).language, 'fr-FR');
  assert.equal(run(['resume', french]).language, 'fr-FR');
  const legacy = await fixture('legacy-language');
  assert.equal(run(['resume', legacy]).language, 'en');
  assert.equal((await readSession(legacy)).language, undefined);
  assert.equal(run(['deepen', legacy]).language, 'en');
  assert.equal((await readSession(legacy)).language, 'en');
});
test('Depth never authorizes deepening or supplementary research', async () => {
  for (const depth of ['initial', 'deep', 'complete']) {
    const root = path.join(temporary, `depth-${depth}`);
    run(['init', root, '--video', '8w6EhLPyNXU', '--depth', depth]);
    const session = await readSession(root);
    assert.equal(session.deepDiveRequested, false);
    assert.equal(session.supplementarySourcesRequested, false);
    assert.equal(session.scope.depth, depth);
    assert.equal(session.scope.mermaid, true);
  }
});
test('A ready overview needs neither playbook nor deep method audit', async () => {
  const check = validate(await fixture('overview'));
  assert.deepEqual(check.errors, []);
  assert.deepEqual(check.warnings, []);
});
test('No method and uncertain detection are honest valid first-pass outcomes', async () => {
  for (const status of ['none', 'uncertain']) {
    const root = await fixture(`detection-${status}`, files => noMethod(files, status));
    assert.deepEqual(validate(root).errors, []);
  }
});
test('Method detection cannot hide missing records or fabricate methods', async () => {
  const missing = await fixture('missing-method', files => { files['session.json'].methods = []; files['video-map.json'].methods = []; });
  assert.ok(validate(missing, 1).errors.some(message => message.includes('Identified methods need')));
  const invented = await fixture('invented-method', files => { files['session.json'].methodDetection.status = 'none'; });
  assert.ok(validate(invented, 1).errors.some(message => message.includes('Do not invent')));
});
test('First-pass screenshots must be reviewed or honestly unavailable', async () => {
  const pending = await fixture('pending-visuals', files => { files['session.json'].firstPass.visualStatus = 'pending'; });
  assert.ok(validate(pending, 1).errors.some(message => message.includes('Review targeted screenshots')));
  const missingCapture = await fixture('missing-capture', files => { delete files['captures/initial.png']; });
  assert.ok(validate(missingCapture, 1).errors.some(message => message.includes('Missing file: captures/initial.png')));
  const unreviewed = await fixture('unreviewed-capture', files => { delete files['session.json'].firstPass.captures[0].reviewedAt; });
  assert.ok(validate(unreviewed, 1).errors.some(message => message.includes('review date')));
  const unavailable = await fixture('unavailable-visuals', files => {
    Object.assign(files['session.json'].firstPass, { visualStatus: 'unavailable', captures: [], limitations: ['Video download was unavailable.'] });
  });
  assert.deepEqual(validate(unavailable).errors, []);
  const unexplained = await fixture('unexplained-visuals', files => {
    Object.assign(files['session.json'].firstPass, { visualStatus: 'unavailable', captures: [], limitations: [] });
  });
  assert.ok(validate(unexplained, 1).errors.some(message => message.includes('Explain why')));
});
test('Every first pass requires an overview and nonempty Mermaid source', async () => {
  for (const file of ['overview.md', 'overview.mmd']) {
    const root = await fixture('missing-overview', files => { delete files[file]; });
    assert.ok(validate(root, 1).errors.some(message => message.includes(`Missing file: ${file}`)));
  }
  const empty = await fixture('empty-diagram', files => { files['overview.mmd'] = ''; });
  assert.ok(validate(empty, 1).errors.some(message => message.includes('Empty file: overview.mmd')));
});
test('Deepening rejects incomplete first passes without changing authorization', async () => {
  const root = path.join(temporary, 'premature-deepen');
  run(['init', root, '--video', '8w6EhLPyNXU']);
  assert.ok(run(['deepen', root], 1).error.includes('Present a valid first pass'));
  assert.equal((await readSession(root)).deepDiveRequested, false);
  const badReady = await fixture('incomplete-ready', files => { delete files['overview.mmd']; });
  assert.ok(run(['deepen', badReady], 1).error.includes('First pass is not ready'));
  assert.equal((await readSession(badReady)).deepDiveRequested, false);
});
test('Deepening is persisted and remains separate from supplementary research', async () => {
  const root = await fixture('deepen');
  const result = run(['deepen', root]);
  assert.equal(result.deepDiveRequested, true);
  assert.equal(result.supplementarySourcesRequested, false);
  const resumed = run(['resume', root]);
  assert.equal(resumed.deepDiveRequested, true);
  assert.equal(resumed.supplementarySourcesRequested, false);
  assert.equal(resumed.phase, 'analyzing');
  assert.equal((await readSession(root)).scope.depth, 'complete');
  const withResearch = await fixture('deepen-research');
  assert.equal(run(['deepen', withResearch, '--supplementary-sources']).supplementarySourcesRequested, true);
});
test('Missing legacy opt-ins remain false and cannot authorize deep phases', async () => {
  const root = await fixture('legacy-optins', files => {
    delete files['session.json'].deepDiveRequested;
    delete files['session.json'].supplementarySourcesRequested;
  });
  const result = run(['resume', root]);
  assert.equal(result.deepDiveRequested, false);
  assert.equal(result.supplementarySourcesRequested, false);
  const unauthorized = await fixture('unauthorized-deep-phase', files => { files['session.json'].phase = 'writing'; });
  assert.ok(validate(unauthorized, 1).errors.some(message => message.includes('explicit user request after the first pass')));
});
test('Deep completion requires both Markdown and HTML deliverables', async () => {
  assert.deepEqual(validate(await fixture('complete', complete)).errors, []);
  for (const key of ['playbook', 'playbookHtml']) {
    const root = await fixture('missing-playbook', files => {
      complete(files);
      delete files[files['session.json'].artifacts[key]];
      delete files['session.json'].artifacts[key];
    });
    assert.ok(validate(root, 1).errors.some(message => message.includes(`Missing required artifact reference: ${key}`)));
  }
});
test('No-method deepening never requires invented method records', async () => {
  const root = await fixture('complete-no-method', files => { complete(files); noMethod(files); });
  assert.deepEqual(validate(root).errors, []);
});
test('Evidence and method audit checks remain enforced for deep completion', async () => {
  const evidence = await fixture('missing-evidence', files => {
    complete(files);
    files['methods/M01.json'].authorVersion.steps[0].execution.evidenceIds = ['E_MISSING'];
  });
  assert.ok(validate(evidence, 1).errors.some(message => message.includes('E_MISSING')));
  const audit = await fixture('pending-audit', files => { complete(files); files['methods/M01.json'].audit.status = 'pending'; });
  assert.ok(validate(audit, 1).errors.some(message => message.includes('Method audit not approved')));
  const source = await fixture('missing-source', files => { files['sources.json'].evidence[0].sourceId = 'S_MISSING'; });
  assert.ok(validate(source, 1).errors.some(message => message.includes('Unknown source')));
});
test('Supplementary research requires explicit authorization and a plan at completion', async () => {
  for (const authorization of [false, undefined, 'true']) {
    const root = await fixture('unauthorized-research', files => {
      files['session.json'].deepDiveRequested = true;
      files['session.json'].status = 'active';
      files['session.json'].phase = 'investigating';
      files['session.json'].supplementarySourcesRequested = authorization;
    });
    assert.ok(validate(root, 1).errors.some(message => message.includes('Supplementary research requires an explicit user request')));
  }
  const noPlan = await fixture('research-no-plan', files => { complete(files); files['session.json'].supplementarySourcesRequested = true; });
  assert.ok(validate(noPlan, 1).errors.some(message => message.includes('Missing file: research-plan.md')));
  const planned = await fixture('research-plan', files => {
    complete(files);
    files['session.json'].supplementarySourcesRequested = true;
    files['research-plan.md'] = '# Scoped research\nOnly the requested question.\n';
  });
  assert.deepEqual(validate(planned).errors, []);
});
