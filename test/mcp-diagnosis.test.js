import test from 'node:test';

import assert from 'node:assert/strict';

import path from 'node:path';

import { randomUUID } from 'node:crypto';

import { writeFileSync } from 'node:fs';

import { mkdir, mkdtemp, readFile, rm, writeFile, open } from 'node:fs/promises';

import { prepareMcpServer, createMcpServerProject } from '../src/core.js';

import { TOOLKIT_ROOT } from '../src/config.js';

import { metadataDigest, boundedSnapshot } from '../src/anonymous-metadata.js';

import { readMcpDiagnosis, classifyMcpDiagnostic } from '../src/mcp-diagnosis.js';

import { readMcpStatus } from '../src/mcp-status.js';

import { planMcpResume } from '../src/mcp-resume.js';

import { main } from '../bin/copilot-mcp.js';

const digest = value => metadataDigest(boundedSnapshot(value));

async function fixture(t) {
  await mkdir(path.join(TOOLKIT_ROOT, '.test-output'), { recursive: true });
  const root = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'diagnosis-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'server');
  const review = await prepareMcpServer({ schemaVersion: 1, kind: 'existing-mcp',
    server: { id: '55555555-5555-4555-8555-555555555555', name: 'Diagnostic fixture' },
    endpoint: 'https://fixture.coworktoolkit.dev/mcp', inbound: { type: 'anonymous' } });
  await createMcpServerProject(review, { workspaceRoot: root, projectDir: dir });
  const evidenceTime = Date.now();
  const addFailure = async ({ phase = 'discovery', code = 'AUTHENTICATION_FAILED', time = 1,
    detail = { authStage: 'authority', failureKind: 'timeout' }, unknown = false, operation = 'same' } = {}) => {
    const folder = path.join(dir, '.mcp-observations', randomUUID());
    await mkdir(folder, { recursive: true });
    const intent = { schemaVersion: 1, action: `standalone-mcp-project-${phase}`, status: 'started',
      startedAt: new Date(evidenceTime - 10000 - time).toISOString(), approvalDigest: digest('approved-synthetic'),
      reviewDigest: review.reviewDigest, operationDigest: digest(operation),
      ...(phase === 'proof' ? { executionVersion: 2, previousHistoryDigest: digest('synthetic-history') } : {}) };
    const failure = { schemaVersion: phase === 'proof' ? 3 : 2,
      status: phase === 'proof' ? unknown ? 'unknown-no-replay' : 'not-dispatched' : 'failed-no-capture',
      errorCode: code, finishedAt: new Date(evidenceTime - time).toISOString(), intentDigest: digest(intent),
      ...(phase === 'proof' ? { dispatchContract: 'write-ahead-tools-call-v1' } : {}),
      ...(detail ? { diagnostics: detail } : {}) };
    failure.failureDigest = digest(failure);
    await writeFile(path.join(folder, 'intent.json'), JSON.stringify(intent));
    await writeFile(path.join(folder, 'failure.json'), JSON.stringify(failure));
    return { folder, intent, failure };
  };
  return { dir, root, review, addFailure };
}

test('diagnosis is local, leaves default status/plans unchanged and ignores excluded authentication/log surfaces', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.dir, '.azure-auth'), 'PRIVATE_AUTH_CACHE_NOT_A_DIRECTORY');
  await writeFile(path.join(f.dir, 'unapproved-log.txt'), 'Bearer PRIVATE_UNKNOWN_SURFACE');
  const status = await readMcpStatus(f.dir), resume = await planMcpResume(f.dir);
  t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected network'));
  const result = await readMcpDiagnosis(f.dir);
  assert.equal(result.status, 'local-evidence-only');
  assert.equal(result.layers.project.status, 'generated-bytes-verified');
  assert.equal(result.layers.identity.status, 'not-required-for-reference');
  assert.equal(result.next.authentication, 'not-required-for-anonymous-mcp');
  assert.equal(result.authenticationCacheRead, false);
  assert.equal(result.executionReadiness, false);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(await readMcpStatus(f.dir), status);
  const later = await planMcpResume(f.dir);
  delete resume.evaluatedAt; delete later.evaluatedAt;
  assert.deepEqual(later, resume);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|Bearer|unapproved-log/);
});

test('validated equivalent failures aggregate by operation/phase/stage, with recorded elapsed and unknown budgets', async t => {
  const f = await fixture(t);
  const first = await f.addFailure();
  const second = await f.addFailure({ time: 2 });
  assert.notEqual(first.failure.failureDigest, second.failure.failureDigest);
  await f.addFailure({ phase: 'proof', time: 3 });
  await f.addFailure({ time: 4, detail: { authStage: 'token', failureKind: 'timeout' } });
  await f.addFailure({ time: 5, operation: 'different' });
  const result = await readMcpDiagnosis(f.dir);
  assert.equal(result.failures.length, 4);
  const repeated = result.failures.find(r => r.equivalentFailures === 2);
  assert.equal(repeated.phase, 'discovery');
  assert.equal(repeated.stage, 'authority');
  assert.equal(repeated.errorClass, 'mcp-auth-transient');
  assert.ok(repeated.elapsedMs >= 10000);
  assert.equal(repeated.recordedBudget, null);
  assert.equal(result.budget.actualHistoricalRetryCount, null);
  assert.equal(result.budget.fullInspectionRetries, 0);
  assert.match(result.guidance.join(' '), /Stop repeating equivalent full reads/);
  assert.equal(result.layers.calls.notDispatched, 1);
});

test('timeouts, auth, HTTP metadata, permission denial and unsupported profiles remain distinct closed classes', () => {
  assert.equal(classifyMcpDiagnostic('AZURE_INSPECTION_TIMEOUT', null, 'azure-management').errorClass, 'azure-management-timeout');
  assert.equal(classifyMcpDiagnostic('APIM_PROOF_MAPPING_MISMATCH', { proofStage: 'local-review',
    resource: 'project', failureKind: 'classified-error', causeCode: 'AZURE_INSPECTION_COMMAND_TIMEOUT' }).errorClass, 'azure-management-timeout');
  assert.equal(classifyMcpDiagnostic('AZURE_PERMISSION_DENIED', null).errorClass, 'recorded-authorization-denial');
  assert.equal(classifyMcpDiagnostic('AUTHENTICATION_FAILED', { authStage: 'token',
    failureKind: 'http-status', httpStatus: 403 }).errorClass, 'mcp-auth-unclassified');
  assert.equal(classifyMcpDiagnostic('AUTHENTICATION_FAILED', { authStage: 'metadata',
    failureKind: 'http-status', httpStatus: 401 }).errorClass, 'mcp-protocol');
  assert.equal(classifyMcpDiagnostic('AUTHENTICATION_REJECTED').errorClass, 'mcp-identity-rejected');
  assert.equal(classifyMcpDiagnostic('ACCEPTANCE_PROFILE_UNSUPPORTED').errorClass, 'unsupported-profile');
  assert.equal(classifyMcpDiagnostic('ABORTED').errorClass, 'cancelled');
  assert.equal(classifyMcpDiagnostic('AZURE_CLI_CERTIFICATE_FAILED').errorClass, 'certificate-validation');
  assert.deepEqual(classifyMcpDiagnostic('PRIVATE\u001b[31m', { authStage: 'PRIVATE' }),
    { code: 'UNCLASSIFIED_FAILURE', errorClass: 'unclassified', stage: 'unknown', detail: null });
});

test('unknown dispatch and retained lock presence never become a retry or cleared barrier', async t => {
  const f = await fixture(t);
  const { folder } = await f.addFailure({ phase: 'proof', unknown: true });
  const before = await readFile(path.join(folder, 'failure.json'));
  await writeFile(path.join(f.dir, '.mcp-network.lock'), 'PRIVATE_LOCK');
  const report = await readMcpDiagnosis(f.dir);
  assert.ok(report.barriers.includes('.mcp-network.lock'));
  assert.ok(report.barriers.includes('unresolved-dispatch'));
  assert.equal(report.failures[0].dispatch, 'unknown-no-replay');
  assert.equal(report.next.approval, null);
  assert.match(report.guidance.join(' '), /cannot authorize tool replay/);
  assert.deepEqual(await readFile(path.join(folder, 'failure.json')), before);
  assert.equal(await readFile(path.join(f.dir, '.mcp-network.lock'), 'utf8'), 'PRIVATE_LOCK');
  assert.equal((await planMcpResume(f.dir)).next.diagnosticCommand, 'mcp-diagnose');
});

test('missing, invalid, tampered and unsupported evidence blocks explicitly without echo or fabricated timing', async t => {
  const f = await fixture(t);
  assert.equal((await readMcpDiagnosis(path.join(f.root, 'absent'))).layers.inventory.code, 'ENOENT');
  const config = path.join(f.root, 'selection.json');
  await writeFile(config, JSON.stringify({ acceptanceProfile: 'PRIVATE\u001b[31m' }));
  let report = await readMcpDiagnosis(f.dir, { config });
  assert.equal(report.layers.selection.code, 'ACCEPTANCE_PROFILE_UNSUPPORTED');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|\\u001b/);
  await writeFile(config, '{"device_code":"PRIVATE_CODE"}');
  report = await readMcpDiagnosis(f.dir, { config });
  assert.equal(report.layers.selection.code, 'MCP_ARCHIVE_SENSITIVE_OR_BINARY');
  report = await readMcpDiagnosis(f.dir, { config: path.join(f.dir, '.azure-auth', 'never-read.json') });
  assert.equal(report.layers.selection.code, 'INVALID_CONFIG');
  const { folder, failure } = await f.addFailure({ code: 'UNKNOWN_SYNTHETIC_CODE', detail: null });
  report = await readMcpDiagnosis(f.dir);
  assert.equal(report.failures[0].code, 'UNCLASSIFIED_FAILURE');
  await writeFile(path.join(folder, 'failure.json'), JSON.stringify({ ...failure, errorCode: 'AUTHENTICATION_TIMEOUT' }));
  report = await readMcpDiagnosis(f.dir);
  assert.equal(report.layers.observations.status, 'blocked');
  assert.equal(report.status, 'attention-required');
  assert.deepEqual(report.failures, []);
  await writeFile(path.join(folder, 'failure.json'), '{"truncated": "PRIVATE');
  report = await readMcpDiagnosis(f.dir);
  assert.equal(report.layers.observations.code, 'INVALID_JSON');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
  await writeFile(path.join(folder, 'failure.json'), '{"access_token":"PRIVATE_TOKEN"}');
  report = await readMcpDiagnosis(f.dir);
  assert.equal(report.layers.inventory.status, 'blocked');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_TOKEN|access_token/);
});

test('cancellation and duplicate retained records do not invent retries or extra equivalent failures', async t => {
  const f = await fixture(t);
  const { intent, failure } = await f.addFailure({ code: 'ABORTED', detail: null });
  const copy = path.join(f.dir, '.mcp-observations', randomUUID());
  await mkdir(copy);
  await writeFile(path.join(copy, 'intent.json'), JSON.stringify(intent));
  await writeFile(path.join(copy, 'failure.json'), JSON.stringify(failure));
  const report = await readMcpDiagnosis(f.dir);
  assert.equal(report.failures[0].errorClass, 'cancelled');
  assert.equal(report.failures[0].equivalentFailures, 1);
  assert.equal(report.budget.automaticRetries, 0);
  assert.doesNotMatch(report.guidance.join(' '), /Stop repeating/);
});

test('file size, history entry and output group bounds fail closed', async t => {
  const f = await fixture(t);
  const file = await open(path.join(f.dir, '.mcp-configuration.json'), 'wx');
  await file.truncate(8 * 1048576 + 1); await file.close();
  assert.equal((await readMcpDiagnosis(f.dir)).layers.inventory.status, 'blocked');
  await rm(path.join(f.dir, '.mcp-configuration.json'));
  for (let index = 0; index < 65; index++) await f.addFailure({ operation: `distinct-${index}`, time: index + 1 });
  const report = await readMcpDiagnosis(f.dir);
  assert.equal(report.layers.observations.code, 'LIMIT');
  assert.equal(report.failures.length, 64);
  assert.equal(report.status, 'attention-required');
  for (let index = 0; index < 330; index++) await mkdir(path.join(f.dir, '.mcp-observations', randomUUID()));
  assert.equal((await readMcpDiagnosis(f.dir)).layers.inventory.status, 'blocked');
});

test('CLI emits only structured diagnostic output and rejects execution or probe flags', async t => {
  const f = await fixture(t);
  const output = [], errors = [];
  t.mock.method(process.stdout, 'write', text => { output.push(text); return true; });
  t.mock.method(process.stderr, 'write', text => { errors.push(text); return true; });
  assert.equal(await main(['mcp-diagnose', '--project', f.dir, '--json'], {
    runAzure: () => assert.fail('Unexpected Azure command') }), 0);
  assert.equal(JSON.parse(output.join('')).action, 'standalone-mcp-diagnosis');
  for (const flag of ['--allow-network', '--allow-cloud', '--probe-tools', '--interactive']) {
    output.length = 0;
    assert.equal(await main(['mcp-diagnose', '--project', f.dir, '--json', flag]), 1);
    assert.equal(JSON.parse(output.join('')).success, false);
  }
});

test('concurrent retained state changes are reported without locking, retrying or deleting evidence', async t => {
  const f = await fixture(t);
  await f.addFailure();
  const now = Date.now();
  let changed = false;
  t.mock.method(Date, 'now', () => {
    if (!changed) { changed = true; writeFileSync(path.join(f.dir, '.mcp-network.lock'), 'PRIVATE_NEW_LOCK'); }
    return now;
  });
  const report = await readMcpDiagnosis(f.dir);
  assert.equal(report.layers.concurrentState.code, 'METADATA_MISMATCH');
  assert.equal(report.status, 'attention-required');
  assert.equal(await readFile(path.join(f.dir, '.mcp-network.lock'), 'utf8'), 'PRIVATE_NEW_LOCK');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
});

test('unexpected diagnostic failures fail rather than producing successful defaults or raw errors', async t => {
  const f = await fixture(t);
  await f.addFailure();
  t.mock.method(Date, 'now', () => { throw Error('PRIVATE_UNEXPECTED_FAILURE'); });
  await assert.rejects(readMcpDiagnosis(f.dir), error =>
    error.code === 'MCP_DIAGNOSIS_UNAVAILABLE' && !error.message.includes('PRIVATE'));
});
