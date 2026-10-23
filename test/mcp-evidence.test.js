import test from 'node:test';

import assert from 'node:assert/strict';

import path from 'node:path';

import fs from 'node:fs/promises';

import { createHash } from 'node:crypto';

import { spawnSync } from 'node:child_process';

import { syncBuiltinESMExports } from 'node:module';

import { pathToFileURL } from 'node:url';

import { zipSync, unzipSync } from 'fflate';

import { TOOLKIT_ROOT } from '../src/config.js';

import { prepareMcpServer, createMcpServerProject } from '../src/core.js';

import { readMcpServerProject } from '../src/mcp-lifecycle.js';

import { planMcpResume } from '../src/mcp-resume.js';

import { readMcpStatus } from '../src/mcp-status.js';
import { readMcpDiagnosis } from '../src/mcp-diagnosis.js';
import { readMcpProofHistory } from '../src/mcp-proof-history.js';

import { planMcpProjectDiscovery, planMcpProjectProof, executeMcpProjectForTest } from '../src/mcp-discovery-project.js';

import { discoverMcpToolsForTest, runMcpReadOnlyProofForTest } from '../src/mcp-discovery.js';

import { planMcpEvidenceExport, exportMcpEvidence, inspectMcpEvidence, planMcpEvidenceRestore, restoreMcpEvidence } from '../src/mcp-evidence.js';

import { boundedSnapshot, metadataDigest, savedJson } from '../src/anonymous-metadata.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => metadataDigest(boundedSnapshot(value));
const resultProfile = { kind: 'json-array-string-field-v1', field: 'fact', maxItems: 1, maxStringLength: 100 };

const zip = entries => Buffer.from(zipSync(Object.fromEntries(Object.keys(entries).sort().map(k => [k, entries[k]])),
  { level: 0, mtime: new Date(1980, 0, 1) }));

async function fixture(t) {
  await fs.mkdir(path.join(TOOLKIT_ROOT, '.test-output'), { recursive: true });
  const root = await fs.mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'evidence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'source'), output = path.join(root, 'checkpoint.zip');
  const review = await prepareMcpServer({ schemaVersion: 1, kind: 'existing-mcp',
    server: { id: '55555555-5555-4555-8555-555555555555', name: 'Evidence fixture' },
    endpoint: 'https://fixture.coworktoolkit.dev/mcp', inbound: { type: 'anonymous' } });
  await createMcpServerProject(review, { workspaceRoot: root, projectDir: dir });
  t.mock.method(globalThis, 'fetch', () => { throw Error('Network forbidden'); });
  const create = async () => {
    const plan = await planMcpEvidenceExport(dir, { output });
    const result = await exportMcpEvidence(dir, { output, approval: plan.approvalToken });
    return { plan, result, bytes: await fs.readFile(output) };
  };
  return { root, dir, output, create };
}

async function historyFixture(dir, outcome, resultAssertion) {
  const calls = [];
  const operation = (source, options, guard, hooks, proof) => (proof ? runMcpReadOnlyProofForTest : discoverMcpToolsForTest)(
    source, options, { ...hooks, beforeRequest: guard, mcpTransport: async (url, request) => {
      const rpc = JSON.parse(request.body); calls.push(rpc.method);
      if (rpc.method === 'notifications/initialized') return new Response(null, { status: 204 });
      if (rpc.method === 'tools/call' && outcome === 'unknown') throw Error('PRIVATE_RAW_FAILURE');
      const result = rpc.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : rpc.method === 'tools/list' ? { tools: [{ name: 'read_record', description: 'Read record', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true, destructiveHint: false } }] }
          : { content: [{ type: 'text', text: resultAssertion && outcome !== 'mismatch'
            ? '[{"fact":"PRIVATE_BUSINESS_RESULT"}]' : 'PRIVATE_BUSINESS_RESULT' }],
          ...(outcome === 'failed' ? { isError: true } : {}) };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } });
  const discovery = await planMcpProjectDiscovery(dir, {});
  const capture = await executeMcpProjectForTest(dir, { selection: {}, approval: discovery, allowNetwork: true }, false,
    (s, o, g, h) => operation(s, o, g, h, false));
  const selection = { capture: capture.resultFile, toolName: 'read_record', arguments: {},
    safetyReview: { readOnly: true, reason: 'Owner reviewed one public read.' },
    ...(resultAssertion ? { resultAssertion } : {}) };
  const proof = await planMcpProjectProof(dir, selection);
  const execute = () => executeMcpProjectForTest(dir, { selection, approval: proof, allowNetwork: true }, true,
    (s, o, g, h) => operation(s, o, g, h, true));
  const completed = await execute();
  if (outcome === 'unknown') assert.equal(completed.result.status, 'unknown');
  assert.equal(calls.filter(x => x === 'tools/call').length, 1);
  return { calls, completed, selection, capture: capture.result };
}

for (const outcome of ['passed', 'mismatch', 'failed', 'unknown']) {
  test(`same-call assertion ${outcome} survives status, resume, diagnosis and byte-preserving recovery without replay`, async t => {
    const f = await fixture(t);
    const { calls, completed, selection, capture } = await historyFixture(f.dir, outcome, resultProfile);
    const expected = outcome === 'unknown' ? 'not-evaluated' : outcome === 'passed' ? 'passed' : 'failed';
    const historyStatus = outcome === 'unknown' ? 'unresolved' : 'completed';
    const callCount = calls.length;
    assert.equal(completed.result.backendAssertion.status, expected);
    const original = await fs.readFile(completed.resultFile);
    assert.doesNotMatch(original.toString(), /PRIVATE_BUSINESS_RESULT|PRIVATE_RAW_FAILURE/);
    const check = async dir => {
      const history = await readMcpProofHistory(dir), status = await readMcpStatus(dir);
      const attempt = status.proofs.find(a => a.status !== 'not-proof');
      assert.equal(attempt.status, historyStatus);
      assert.deepEqual(attempt.backendAssertion, completed.result.backendAssertion);
      assert.deepEqual(history.attempts.find(a => a.status !== 'not-proof').backendAssertion, attempt.backendAssertion);
      if (outcome !== 'unknown') assert.equal(attempt.protocolStatus, outcome === 'failed' ? 'tool-error' : 'protocol-success');
      assert.equal(status.status, 'local-evidence-only');
      assert.equal(status.coworkRuntimeVerified, false);
      assert.equal(status.replayAuthorized, false);
      const resume = await planMcpResume(dir, { phase: 'proof' });
      assert.equal(resume.next.code, outcome === 'unknown' ? 'OUTCOME_UNRESOLVED' : 'PURPOSE_CONSUMED');
      assert.equal(resume.next.command, null);
      assert.equal(resume.next.approval, null);
      assert.equal(resume.layers.resultAssertions.historicalOnly, true);
      assert.equal(resume.layers.resultAssertions.businessCorrectnessVerified, false);
      assert.deepEqual(resume.layers.resultAssertions.findings, [{ attemptId: attempt.attemptId, assertion: attempt.backendAssertion }]);
      const diagnosis = await readMcpDiagnosis(dir);
      assert.equal(diagnosis.executionReadiness, false);
      assert.equal(diagnosis.replayAuthorized, false);
      assert.equal(diagnosis.layers.calls[historyStatus], 1);
      assert.equal(diagnosis.layers.calls.businessCorrectnessVerified, false);
      assert.deepEqual(diagnosis.layers.calls.assertions, [{ kind: resultProfile.kind, status: expected, historicalOnly: true }]);
      assert.doesNotMatch(JSON.stringify({ status, resume, diagnosis }), /PRIVATE_BUSINESS_RESULT|PRIVATE_RAW_FAILURE/);
      await assert.rejects(planMcpProjectProof(dir, { ...selection, capture }), { code: 'PROOF_REPLAY_BLOCKED' });
      await assert.rejects(planMcpProjectProof(dir, { ...selection, capture,
        resultAssertion: { ...resultProfile, maxItems: 2 } }), { code: 'PROOF_REPLAY_BLOCKED' });
      const { resultAssertion, ...ordinary } = { ...selection, capture };
      ordinary.safetyReview = { readOnly: true, reason: 'Another review does not reopen the same call.' };
      const approval = await planMcpProjectProof(dir, ordinary);
      await assert.rejects(executeMcpProjectForTest(dir, { selection: ordinary, approval, allowNetwork: true }, true,
        () => assert.fail('Consumed call must be rejected before transport.')),
      { code: outcome === 'unknown' ? 'PROOF_OUTCOME_UNRESOLVED' : 'PROOF_REPLAY_BLOCKED' });
    };
    await check(f.dir);
    const { plan, result, bytes } = await f.create();
    assert.equal(plan.semanticEvidence.history, 'cross-record-bindings-not-validated');
    assert.doesNotMatch(bytes.toString(), /PRIVATE_BUSINESS_RESULT|PRIVATE_RAW_FAILURE/);
    const inspected = await inspectMcpEvidence(f.output, { sha256: result.archiveSha256 });
    assert.equal(inspected.executionReadiness, false);
    const output = path.join(f.root, 'restored'), args = { output, sha256: result.archiveSha256 };
    const restore = await planMcpEvidenceRestore(f.output, args);
    await restoreMcpEvidence(f.output, { ...args, approval: restore.approvalToken });
    for (const file of inspected.manifest.files) {
      assert.deepEqual(await fs.readFile(path.join(output, ...file.path.split('/'))),
        await fs.readFile(path.join(f.dir, ...file.path.split('/'))));
    }
    await check(output);
    assert.deepEqual(await fs.readFile(completed.resultFile), original);
    assert.equal(calls.length, callCount);
  });
}

test('generic assertion receipts reject rehashed schema, verdict and binding tampering across strict readers', async t => {
  const f = await fixture(t);
  const { completed, calls } = await historyFixture(f.dir, 'passed', resultProfile), callCount = calls.length;
  const original = JSON.parse(await fs.readFile(completed.resultFile));
  const rejectReaders = async dir => {
    await assert.rejects(readMcpProofHistory(dir), { code: 'METADATA_MISMATCH' });
    await assert.rejects(readMcpStatus(dir), { code: 'METADATA_MISMATCH' });
    await assert.rejects(planMcpResume(dir), { code: 'METADATA_MISMATCH' });
    const diagnosis = await readMcpDiagnosis(dir);
    assert.deepEqual(diagnosis.layers.observations, { status: 'blocked', code: 'METADATA_MISMATCH' });
    assert.ok(diagnosis.barriers.includes('invalid-or-missing-evidence'));
    assert.equal(diagnosis.layers.calls, undefined);
    assert.equal(diagnosis.executionReadiness, false);
  };
  for (const change of [
    p => { p.resultAssertion.kind = 'unsupported-v1'; },
    p => { p.resultAssertion.maxItems = 101; },
    p => { p.resultAssertion.field = 'constructor'; },
    p => { p.resultAssertion.extra = true; },
    p => { delete p.resultAssertion; },
    p => { delete p.backendAssertion; },
    p => { p.backendAssertion.kind = 'graph-organization-v1'; },
    p => { p.backendAssertion.assertionDigest = `sha256:${'a'.repeat(64)}`; },
    p => { p.backendAssertion.rawResultRetained = true; },
    p => { p.backendAssertion.content = 'untrusted extra result'; },
    p => { p.backendAssertion.status = 'not-evaluated'; },
    p => { p.status = 'tool-error'; },
    p => { p.errorCode = 'UNEXPECTED_ERROR'; },
    p => { p.sourceDigest = `sha256:${'a'.repeat(64)}`; },
    p => { p.approvalDigest = `sha256:${'a'.repeat(64)}`; },
    p => { p.captureDigest = 'not-a-digest'; },
    p => { p.argumentsDigest = 'not-a-digest'; },
    p => { p.completedAt = '2099-01-01T00:00:00.000Z'; },
    p => { p.businessCorrectnessVerified = true; },
    p => { p.coworkRuntimeVerified = true; },
    p => { p.rawResult = 'untrusted extra result'; },
  ]) {
    const { receiptDigest, ...proof } = structuredClone(original);
    change(proof);
    await fs.writeFile(completed.resultFile, savedJson({ ...proof, receiptDigest: digest(proof) }));
    await rejectReaders(f.dir);
  }
  const { plan, result } = await f.create();
  assert.equal(plan.semanticEvidence.history, 'cross-record-bindings-not-validated');
  const args = { output: path.join(f.root, 'invalid-restored'), sha256: result.archiveSha256 };
  const restore = await planMcpEvidenceRestore(f.output, args);
  await restoreMcpEvidence(f.output, { ...args, approval: restore.approvalToken });
  assert.deepEqual(await fs.readFile(path.join(args.output, path.relative(f.dir, completed.resultFile))),
    await fs.readFile(completed.resultFile));
  await rejectReaders(args.output);
  assert.equal(calls.length, callCount);
});

test('unknown assertion and missing dispatch remain unresolved; malformed dispatch cannot certify completion', async t => {
  const f = await fixture(t);
  const { completed, calls } = await historyFixture(f.dir, 'unknown', resultProfile), callCount = calls.length;
  const original = JSON.parse(await fs.readFile(completed.resultFile));
  for (const change of [
    p => { p.backendAssertion.status = 'passed'; },
    p => { p.backendAssertion.assertionDigest = digest(resultProfile); },
    p => { delete p.errorCode; },
    p => { p.errorCode = 'unbounded error text'; },
  ]) {
    const { receiptDigest, ...proof } = structuredClone(original);
    change(proof);
    await fs.writeFile(completed.resultFile, savedJson({ ...proof, receiptDigest: digest(proof) }));
    await assert.rejects(readMcpStatus(f.dir), { code: 'METADATA_MISMATCH' });
  }
  await fs.writeFile(completed.resultFile, savedJson(original));
  const filename = path.join(completed.outputDir, 'dispatch.json');
  const dispatch = JSON.parse(await fs.readFile(filename));
  for (const change of [
    d => { d.intentDigest = `sha256:${'a'.repeat(64)}`; },
    d => { d.operationDigest = `sha256:${'a'.repeat(64)}`; },
    d => { d.preparedAt = '2099-01-01T00:00:00.000Z'; },
    d => { d.extra = true; },
  ]) {
    const { receiptDigest, ...body } = structuredClone(dispatch);
    change(body);
    await fs.writeFile(filename, savedJson({ ...body, receiptDigest: digest(body) }));
    await assert.rejects(readMcpProofHistory(f.dir), { code: 'METADATA_MISMATCH' });
  }
  await fs.unlink(filename);
  assert.equal((await readMcpStatus(f.dir)).proofs.find(a => a.status !== 'not-proof').status, 'unresolved');
  assert.equal((await planMcpResume(f.dir, { phase: 'proof' })).next.code, 'OUTCOME_UNRESOLVED');
  assert.equal(calls.length, callCount);
});

test('safe export preserves exact bytes, ignores auth/unknown surfaces and restores only to a new root', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.dir, '.azure-auth'));
  await fs.writeFile(path.join(f.dir, '.azure-auth', 'msal.json'), '{"access_token":"PRIVATE_AUTH_CACHE"}');
  await fs.writeFile(path.join(f.dir, 'unknown.log'), 'PRIVATE_RAW_LOG');
  await fs.writeFile(path.join(f.dir, '.azure-identity.json'), '{"schemaVersion":1,"status":"pending"}');
  const original = await fs.readFile(path.join(f.dir, 'mcp-server.json'));
  const { plan, result, bytes } = await f.create();
  assert.equal(plan.manifest.runtime.sourceCommit, null);
  assert.equal(plan.persistence.status, 'unknown');
  assert.equal(plan.manifest.excluded.entries, 2);
  assert.doesNotMatch(bytes.toString(), /PRIVATE|msal\.json/);
  assert.equal(plan.semanticEvidence.generation, 'matches-current-generator');
  const report = await inspectMcpEvidence(f.output, { sha256: result.archiveSha256 });
  assert.equal(report.executionReadiness, false);
  assert.equal(report.semanticEvidence.history, 'cross-record-bindings-not-validated');
  const destination = path.join(f.root, 'restored');
  const restorePlan = await planMcpEvidenceRestore(f.output, { output: destination, sha256: result.archiveSha256 });
  await assert.rejects(restoreMcpEvidence(f.output, { output: destination, sha256: result.archiveSha256, approval: plan.approvalToken }), { code: 'APPROVAL_REQUIRED' });
  await restoreMcpEvidence(f.output, { output: destination, sha256: result.archiveSha256, approval: restorePlan.approvalToken });
  assert.deepEqual(await fs.readFile(path.join(destination, 'mcp-server.json')), original);
  assert.deepEqual(await fs.readFile(path.join(destination, '.azure-identity.json')), await fs.readFile(path.join(f.dir, '.azure-identity.json')));
  await assert.rejects(fs.lstat(path.join(destination, '.azure-auth')), { code: 'ENOENT' });
  assert.equal((await readMcpServerProject(destination)).review.descriptor.kind, 'existing-mcp');
  assert.equal((await planMcpResume(destination)).status, 'input-required');
  await assert.rejects(planMcpEvidenceRestore(f.output, { output: destination, sha256: result.archiveSha256 }), { code: 'MCP_ARCHIVE_DESTINATION_EXISTS' });
  await assert.rejects(planMcpEvidenceExport(f.dir, { output: path.join(f.dir, 'not-allowed.zip') }), { code: 'MCP_ARCHIVE_DESTINATION' });
});

test('retained locks and interrupted/unsupported history remain non-authorizing barriers across repeated backups', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.dir, '.mcp-network.lock'), 'PRIVATE_LOCK_CONTENT');
  await fs.mkdir(path.join(f.dir, '.mcp-observations', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), { recursive: true });
  await fs.writeFile(path.join(f.dir, '.mcp-observations', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'unknown.log'), 'PRIVATE_LOG');
  const { plan, result, bytes } = await f.create();
  assert.deepEqual(plan.manifest.locks, [{ path: '.mcp-network.lock', present: true, authority: false }]);
  assert.equal(plan.manifest.excluded.unsupportedHistory, true);
  assert.doesNotMatch(bytes.toString(), /PRIVATE/);
  const destination = path.join(f.root, 'blocked');
  const args = { output: destination, sha256: result.archiveSha256 };
  const approved = await planMcpEvidenceRestore(f.output, args);
  await restoreMcpEvidence(f.output, { ...args, approval: approved.approvalToken });
  await assert.rejects(fs.lstat(path.join(destination, '.mcp-network.lock')), { code: 'ENOENT' });
  await assert.rejects(readMcpServerProject(destination), { code: 'MCP_RECOVERY_REVIEW_REQUIRED' });
  assert.equal((await planMcpResume(destination)).next.code, 'MCP_RECOVERY_REVIEW_REQUIRED');
  const secondZip = path.join(f.root, 'second.zip');
  const second = await planMcpEvidenceExport(destination, { output: secondZip });
  await exportMcpEvidence(destination, { output: secondZip, approval: second.approvalToken });
  const secondDest = path.join(f.root, 'second-destination'), secondArgs = { output: secondDest, sha256: second.archiveSha256 };
  const secondPlan = await planMcpEvidenceRestore(secondZip, secondArgs);
  await restoreMcpEvidence(secondZip, { ...secondArgs, approval: secondPlan.approvalToken });
  await assert.rejects(readMcpServerProject(secondDest), { code: 'MCP_RECOVERY_REVIEW_REQUIRED' });
});

test('missing and malformed records are preserved as incomplete evidence, never repaired', async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.dir, 'mcp-server.json'));
  await fs.mkdir(path.join(f.dir, '.mcp-lifecycle'));
  await fs.writeFile(path.join(f.dir, '.mcp-lifecycle', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json'), '{broken');
  const { plan, result } = await f.create();
  assert.deepEqual(plan.semanticEvidence.missingGenerated, ['mcp-server.json']);
  assert.equal(plan.semanticEvidence.invalidJson.length, 1);
  const args = { output: path.join(f.root, 'incomplete'), sha256: result.archiveSha256 };
  const approved = await planMcpEvidenceRestore(f.output, args);
  await restoreMcpEvidence(f.output, { ...args, approval: approved.approvalToken });
  await assert.rejects(readMcpServerProject(args.output));
  assert.equal(await fs.readFile(path.join(args.output, '.mcp-lifecycle', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json'), 'utf8'), '{broken');
});

test('source changes, target collisions and interrupted writes never publish admitted recovery or overwrite', async t => {
  const f = await fixture(t);
  const stale = await planMcpEvidenceExport(f.dir, { output: f.output });
  await fs.writeFile(path.join(f.dir, '.mcp-configuration.json'), '{}');
  await assert.rejects(exportMcpEvidence(f.dir, { output: f.output, approval: stale.approvalToken }), { code: 'APPROVAL_REQUIRED' });
  const { result } = await f.create();
  const args = { output: path.join(f.root, 'partial'), sha256: result.archiveSha256 };
  const plan = await planMcpEvidenceRestore(f.output, args);
  const realOpen = fs.open;
  const injected = t.mock.method(fs, 'open', async (filename, ...rest) => {
    if (filename === path.join(args.output, 'mcp-server.json')) throw Object.assign(new Error('Synthetic disk failure'), { code: 'EIO' });
    return realOpen(filename, ...rest);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(restoreMcpEvidence(f.output, { ...args, approval: plan.approvalToken }), { code: 'EIO' }); }
  finally { injected.mock.restore(); syncBuiltinESMExports(); }
  assert.equal((await planMcpResume(args.output)).next.code, 'MCP_RECOVERY_INCOMPLETE');
  await assert.rejects(readMcpServerProject(args.output), { code: 'MCP_RECOVERY_INCOMPLETE' });
  await assert.rejects(restoreMcpEvidence(f.output, { ...args, approval: plan.approvalToken }), { code: 'MCP_ARCHIVE_DESTINATION_EXISTS' });
  const collision = path.join(f.root, 'collision'), collisionArgs = { output: collision, sha256: result.archiveSha256 };
  const collisionPlan = await planMcpEvidenceRestore(f.output, collisionArgs);
  await fs.mkdir(collision);
  await assert.rejects(restoreMcpEvidence(f.output, { ...collisionArgs, approval: collisionPlan.approvalToken }), { code: 'MCP_ARCHIVE_DESTINATION_EXISTS' });
  assert.deepEqual(await fs.readdir(collision), []);
});

test('archive screening rejects credentials, binary data and aliases without traversing unknown surfaces', async t => {
  const f = await fixture(t);
  const filename = path.join(f.dir, '.mcp-configuration.json');
  for (const content of ['{"access_token":"PRIVATE_TOKEN_VALUE"}', '{"userCode":"ABCDE1234"}',
    '{"\\u0072efreshToken":"PRIVATE"}', '{"access\\u0054oken":"PRIVATE","accessToken":null}',
    '{"message":"To sign in enter the code ABCDE1234"}', '{"stderr":"PRIVATE_RAW"}', Buffer.from([255, 254])]) {
    await fs.writeFile(filename, content);
    await assert.rejects(planMcpEvidenceExport(f.dir, { output: f.output }), { code: 'MCP_ARCHIVE_SENSITIVE_OR_BINARY' });
  }
  await fs.unlink(filename);
  const hidden = path.join(f.root, 'hidden'); await fs.mkdir(hidden);
  await fs.writeFile(path.join(hidden, 'secret'), 'PRIVATE');
  await fs.symlink(hidden, path.join(f.dir, '.azure-auth'), process.platform === 'win32' ? 'junction' : 'dir');
  await f.create();
  await fs.unlink(path.join(f.dir, 'mcp-server.json'));
  await fs.symlink(hidden, path.join(f.dir, 'mcp-server.json'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(planMcpEvidenceExport(f.dir, { output: path.join(f.root, 'links.zip') }));
});

test('changes during publication are detected and conflicting files or partial destinations remain untouched', async t => {
  const f = await fixture(t), plan = await planMcpEvidenceExport(f.dir, { output: f.output });
  const realOpen = fs.open, realLink = fs.link;
  let changed = false;
  let intercept = t.mock.method(fs, 'open', async (filename, ...args) => {
    if (!changed && filename.startsWith(`${f.output}.`) && filename.endsWith('.pending')) {
      changed = true; await fs.writeFile(path.join(f.dir, '.mcp-configuration.json'), '{}');
    }
    return realOpen(filename, ...args);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(exportMcpEvidence(f.dir, { output: f.output, approval: plan.approvalToken }), { code: 'MCP_ARCHIVE_CHANGED' }); }
  finally { intercept.mock.restore(); syncBuiltinESMExports(); }
  await assert.rejects(fs.lstat(f.output), { code: 'ENOENT' });
  const fresh = await planMcpEvidenceExport(f.dir, { output: f.output });
  intercept = t.mock.method(fs, 'link', async (source, destination) => {
    await fs.writeFile(destination, 'collision sentinel', { flag: 'wx' });
    return realLink(source, destination);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(exportMcpEvidence(f.dir, { output: f.output, approval: fresh.approvalToken }), { code: 'EEXIST' }); }
  finally { intercept.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(await fs.readFile(f.output, 'utf8'), 'collision sentinel');
  await fs.unlink(f.output);
  const { result, bytes } = await f.create();
  const args = { output: path.join(f.root, 'archive-changed'), sha256: result.archiveSha256 };
  const restore = await planMcpEvidenceRestore(f.output, args);
  intercept = t.mock.method(fs, 'open', async (filename, ...rest) => {
    if (filename === path.join(args.output, 'mcp-server.json') && rest[0] === 'wx') {
      await fs.writeFile(f.output, Buffer.concat([bytes, Buffer.from('changed')]));
    }
    return realOpen(filename, ...rest);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(restoreMcpEvidence(f.output, { ...args, approval: restore.approvalToken }), { code: 'MCP_ARCHIVE_HASH_MISMATCH' }); }
  finally { intercept.mock.restore(); syncBuiltinESMExports(); }
  assert.equal((await planMcpResume(args.output)).next.code, 'MCP_RECOVERY_INCOMPLETE');
});

test('archive bounds and independently invalid capture evidence fail closed without renewal', async t => {
  const f = await fixture(t);
  await historyFixture(f.dir, 'passed');
  const directory = path.join(f.dir, '.mcp-observations');
  for (const name of await fs.readdir(directory)) {
    const capture = path.join(directory, name, 'capture.json');
    try {
      const value = JSON.parse(await fs.readFile(capture));
      value.receiptDigest = `sha256:${'0'.repeat(64)}`;
      await fs.writeFile(capture, JSON.stringify(value));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const reviewed = await planMcpEvidenceExport(f.dir, { output: f.output });
  assert.equal(reviewed.semanticEvidence.captures[0].status, 'invalid');
  assert.equal(reviewed.semanticEvidence.status, 'incomplete-or-invalid');
  const file = await fs.open(path.join(f.dir, '.mcp-configuration.json'), 'wx');
  await file.truncate(8 * 1048576 + 1); await file.close();
  await assert.rejects(planMcpEvidenceExport(f.dir, { output: f.output }), { code: 'MCP_ARCHIVE_FILE_BOUNDARY' });
});

test('reserved case aliases and hard-linked control files cannot disappear into excluded surfaces', async t => {
  const f = await fixture(t);
  const alias = path.join(f.dir, '.MCP-observations');
  await fs.mkdir(alias);
  await assert.rejects(planMcpEvidenceExport(f.dir, { output: f.output }), { code: 'MCP_ARCHIVE_PATH_ALIAS' });
  await fs.rmdir(alias);
  const original = path.join(f.root, 'hard-link-original.json');
  await fs.writeFile(original, '{}');
  await fs.link(original, path.join(f.dir, '.mcp-configuration.json'));
  await assert.rejects(planMcpEvidenceExport(f.dir, { output: f.output }), { code: 'MCP_ARCHIVE_FILE_BOUNDARY' });
});

test('ZIP verifier rejects external hash mismatch, tampering, traversal, aliases, links, bombs and duplicate headers', async t => {
  const f = await fixture(t), { bytes, result } = await f.create();
  await assert.rejects(inspectMcpEvidence(f.output), { code: 'MCP_ARCHIVE_HASH_REQUIRED' });
  await assert.rejects(inspectMcpEvidence(f.output, { sha256: '0'.repeat(64) }), { code: 'MCP_ARCHIVE_HASH_MISMATCH' });
  const original = unzipSync(bytes), attacks = [];
  for (const name of ['../escape.json', '/absolute.json', 'project\\mcp-server.json', 'project/./mcp-server.json',
    'project/MCP-server.json', 'project/con.json', 'project/mcp-server.json.', 'project/mcp-server.json:stream',
    'project/.azure-auth/cache.json', 'project/unapproved.json', 'project/infra/']) {
    attacks.push(zip({ ...original, [name]: Buffer.from('{}') }));
  }
  attacks.push(zip({ ...original, 'project/mcp-server.json': Buffer.from('{}') }));
  const missing = { ...original }; delete missing['project/mcp-server.json']; attacks.push(zip(missing));
  const changedManifest = JSON.parse(Buffer.from(original['manifest.json']).toString());
  changedManifest.originalProjectRoot = '/changed';
  attacks.push(zip({ ...original, 'manifest.json': Buffer.from(savedJson(changedManifest)) }));
  const malformedManifest = { ...changedManifest, schemaVersion: 2 };
  const { manifestDigest, ...body } = malformedManifest;
  malformedManifest.manifestDigest = metadataDigest(body);
  attacks.push(zip({ ...original, 'manifest.json': Buffer.from(savedJson(malformedManifest)) }));
  attacks.push(Buffer.from(zipSync(original, { level: 9, mtime: new Date(1980, 0, 1) })));
  const central = bytes.readUInt32LE(bytes.length - 6);
  const linkArchive = Buffer.from(bytes); linkArchive.writeUInt32LE(0xa1ff0000, central + 38); attacks.push(linkArchive);
  const bomb = Buffer.from(bytes); bomb.writeUInt32LE(0x7fffffff, central + 24); attacks.push(bomb);
  const flags = Buffer.from(bytes); flags.writeUInt16LE(1, 6); attacks.push(flags);
  const dupManifest = zip({ ...original, 'manifest.jsox': original['manifest.json'] });
  for (let offset = 0; (offset = dupManifest.indexOf('manifest.jsox', offset)) !== -1; offset += 13) {
    dupManifest.write('manifest.json', offset);
  }
  attacks.push(dupManifest);
  for (let i = 0; i < attacks.length; i++) {
    const filename = path.join(f.root, `attack-${i}.zip`);
    await fs.writeFile(filename, attacks[i]);
    await assert.rejects(inspectMcpEvidence(filename, { sha256: hash(attacks[i]) }), e => /^MCP_ARCHIVE_/.test(e.code), `attack ${i}`);
  }
  assert.equal((await inspectMcpEvidence(f.output, { sha256: result.archiveSha256 })).status, 'byte-verified-not-execution-ready');
});

test('packed CLI exports, inspects and restores expired consumed/failed/unknown histories without new network', { timeout: 180000 }, async t => {
  const f = await fixture(t);
  const workspace = path.join(f.root, 'workspace'); await fs.mkdir(workspace);
  const packedDir = path.join(f.root, 'pack'); await fs.mkdir(packedDir);
  const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const pack = spawnSync(process.execPath, [npmCli, 'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', packedDir],
    { cwd: TOOLKIT_ROOT, encoding: 'utf8', timeout: 60000, env: { ...process.env, npm_config_cache: path.join(f.root, 'cache') } });
  assert.equal(pack.status, 0, pack.stderr);
  const runtime = path.join(f.root, 'runtime'); await fs.mkdir(runtime);
  const tar = spawnSync('tar', ['-xzf', path.join(packedDir, JSON.parse(pack.stdout)[0].filename), '-C', runtime], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  const installed = path.join(runtime, 'package');
  await fs.cp(path.join(TOOLKIT_ROOT, 'node_modules'), path.join(installed, 'node_modules'), { recursive: true });
  const launcher = path.join(f.root, 'offline-cli.mjs');
  await fs.writeFile(launcher, `
import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls';
import child from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
import dns from 'node:dns'; import dgram from 'node:dgram'; import fs from 'node:fs'; import fsp from 'node:fs/promises';
const deny=()=>{throw Error('UNEXPECTED_NETWORK_OR_PROCESS')};
globalThis.fetch=deny; http.request=deny; http.get=deny; https.request=deny; https.get=deny;
net.connect=deny; net.createConnection=deny; net.Socket.prototype.connect=deny; tls.connect=deny;
dgram.createSocket=deny;
for(const name of ['lookup','lookupService','resolve','resolve4','resolve6','resolveAny','resolveCname','resolveMx','resolveNaptr','resolveNs','resolvePtr','resolveSoa','resolveSrv','resolveTxt','reverse']) {
  dns[name]=deny; dns.promises[name]=deny;
}
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) child[name]=deny;
for(const [api,names] of [[fs,['readFileSync','readdirSync','lstatSync','statSync','openSync']], [fsp,['readFile','readdir','lstat','stat','open']]]) {
  for(const name of names) {
    const original=api[name];
    api[name]=function(file,...args) {
      if(String(file).includes('.azure-auth')) throw Error('UNEXPECTED_AUTH_CACHE_ACCESS');
      return original.call(this,file,...args);
    };
  }
}
syncBuiltinESMExports();
Date.now=()=>${Date.now() + 2 * 86400000};
const {main}=await import(${JSON.stringify(pathToFileURL(path.join(installed, 'bin', 'copilot-mcp.js')).href)});
process.exitCode=await main(process.argv.slice(2),{runAzure(){throw Error('UNEXPECTED_AZURE')}});`);
  const invoke = (args, expected = 0) => {
    const child = spawnSync(process.execPath, [launcher, ...args, '--workspace-root', workspace, '--json'], { encoding: 'utf8', timeout: 20000 });
    assert.equal(child.status, expected, child.stdout + child.stderr);
    assert.doesNotMatch(child.stdout + child.stderr, /PRIVATE|UNEXPECTED_NETWORK|UNEXPECTED_AZURE/);
    return JSON.parse(child.stdout);
  };
  for (const outcome of ['passed', 'failed', 'unknown']) {
    const source = path.join(workspace, `source-${outcome}`); await fs.cp(f.dir, source, { recursive: true });
    const { calls } = await historyFixture(source, outcome), callCount = calls.length;
    const archive = path.join(workspace, `${outcome}.zip`), destination = path.join(workspace, `restored-${outcome}`);
    const plan = invoke(['mcp-export-plan', '--project', source, '--output', archive, '--persistence', 'ephemeral', '--summary']);
    const exported = invoke(['mcp-export', '--project', source, '--output', archive, '--persistence', 'ephemeral', '--approve', plan.approvalToken]);
    const inspected = invoke(['mcp-archive-inspect', '--archive', archive, '--sha256', exported.archiveSha256]);
    assert.equal(inspected.executionReadiness, false);
    const restoredPlan = invoke(['mcp-restore-plan', '--archive', archive, '--sha256', exported.archiveSha256, '--output', destination, '--summary']);
    invoke(['mcp-restore', '--archive', archive, '--sha256', exported.archiveSha256, '--output', destination, '--approve', restoredPlan.approvalToken]);
    for (const file of inspected.manifest.files) {
      assert.deepEqual(await fs.readFile(path.join(destination, ...file.path.split('/'))), await fs.readFile(path.join(source, ...file.path.split('/'))));
    }
    const status = invoke(['mcp-status', '--project', destination]);
    assert.equal(status.proofs.find(item => item.status !== 'not-proof').status, outcome === 'unknown' ? 'unresolved' : 'completed');
    const diagnosis = invoke(['mcp-diagnose', '--project', destination], 2);
    assert.equal(diagnosis.executionReadiness, false);
    assert.equal(diagnosis.layers.calls[outcome === 'unknown' ? 'unresolved' : 'completed'], 1);
    assert.equal(diagnosis.layers.captures.expired, 1);
    assert.equal(diagnosis.authenticationCacheRead, false);
    if (outcome === 'failed') assert.equal(diagnosis.layers.calls.toolError, 1);
    if (outcome === 'unknown') assert.ok(diagnosis.barriers.includes('unresolved-dispatch'));
    const resume = invoke(['mcp-resume', '--project', destination, '--phase', 'proof', '--persistence', 'unknown'], 2);
    assert.equal(resume.next.code, outcome === 'unknown' ? 'OUTCOME_UNRESOLVED' : 'PURPOSE_CONSUMED');
    assert.equal(resume.layers.discovery.status, 'stale');
    assert.equal(calls.length, callCount);
  }
});
