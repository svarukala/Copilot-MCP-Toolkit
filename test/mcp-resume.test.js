import test from 'node:test';

import assert from 'node:assert/strict';

import path from 'node:path';

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { prepareMcpServer, createMcpServerProject } from '../src/core.js';

import { TOOLKIT_ROOT } from '../src/config.js';

import { main } from '../bin/copilot-mcp.js';

import { planMcpResume, resumeFreshness, resumeLayers } from '../src/mcp-resume.js';

import { planMcpProjectDiscovery, executeMcpProjectForTest } from '../src/mcp-discovery-project.js';

import { discoverMcpToolsForTest, runMcpReadOnlyProofForTest } from '../src/mcp-discovery.js';

async function fixture(t) {
  await mkdir(path.join(TOOLKIT_ROOT, '.test-output'), { recursive: true });
  const root = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'server'), config = path.join(root, 'selection.json');
  const review = await prepareMcpServer({ schemaVersion: 1, kind: 'existing-mcp',
    server: { id: '55555555-5555-4555-8555-555555555555', name: 'Resume fixture' },
    endpoint: 'https://fixture.coworktoolkit.dev/mcp', inbound: { type: 'anonymous' } });
  await createMcpServerProject(review, { workspaceRoot: root, projectDir: dir });
  await writeFile(config, '{}');
  const calls = [], state = { fail: false, lost: false, toolError: false };
  t.mock.method(globalThis, 'fetch', () => { throw Error('Unexpected network'); });
  const transport = { mcpTransport: async (url, request) => {
    const rpc = JSON.parse(request.body); calls.push(rpc.method);
    if (state.fail) throw Error('PRIVATE_SYNTHETIC_FAILURE');
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 204 });
    if (rpc.method === 'tools/call' && state.lost) throw Error('PRIVATE_LOST_RESPONSE');
    const result = rpc.method === 'initialize' ? { protocolVersion: '2025-03-26',
      capabilities: { tools: {} }, serverInfo: { name: 'Fixture', version: '1' } }
      : rpc.method === 'tools/list' ? { tools: [{ name: 'read_record', description: 'Read a public record',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false } }] }
        : { content: [{ type: 'text', text: 'PRIVATE_RESULT' }], ...(state.toolError ? { isError: true } : {}) };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  } };
  const dependencies = { runAzure() { throw Error('Unexpected Azure'); },
    mcpProjectOperation: (dir, options, proof) => executeMcpProjectForTest(dir, options, proof,
      (source, options, guard, hooks) => (proof ? runMcpReadOnlyProofForTest : discoverMcpToolsForTest)(
        source, options, { ...transport, ...hooks, beforeRequest: guard })) };
  const invoke = async (args, expected = 0) => {
    const output = [], errors = [];
    const out = t.mock.method(process.stdout, 'write', value => { output.push(value); return true; });
    const err = t.mock.method(process.stderr, 'write', value => { errors.push(value); return true; });
    try {
      assert.equal(await main([...args, '--project', dir, '--json'], dependencies), expected, output.join('') + errors.join(''));
      assert.doesNotMatch(output.join('') + errors.join(''), /PRIVATE/);
      return JSON.parse(output.join(''));
    } finally { out.mock.restore(); err.mock.restore(); }
  };
  const capture = async () => {
    const plan = await planMcpResume(dir, { config });
    const result = await invoke(['mcp-resume', '--config', config, '--approve', plan.next.approval, '--allow-network']);
    await writeFile(config, JSON.stringify({ capture: result.resultFile, toolName: 'read_record', arguments: {},
      safetyReview: { readOnly: true, reason: 'Owner reviewed this public record lookup only.' } }));
    return result;
  };
  return { root, dir, config, calls, state, invoke, capture };
}

test('resume is local, binds current history, delegates exact plans and consumes completed purposes', async t => {
  const f = await fixture(t);
  assert.equal((await planMcpResume(f.dir)).status, 'input-required');
  const reviewed = await f.invoke(['mcp-resume', '--config', f.config, '--summary']);
  assert.deepEqual(reviewed.next.plan, await planMcpProjectDiscovery(f.dir, {}));
  assert.equal(reviewed.next.phaseApproval, reviewed.next.plan.approvalDigest);
  assert.match(reviewed.next.approval, /^mcp-resume\/sha256:/);
  assert.equal(f.calls.length, 0);
  await f.invoke(['mcp-resume', '--config', f.config, '--approve', reviewed.next.phaseApproval, '--allow-network'], 1);
  await f.invoke(['mcp-resume', '--config', f.config, '--approve', reviewed.next.approval], 1);
  assert.equal(f.calls.length, 0);
  const captured = await f.capture();
  const bytes = await readFile(captured.resultFile);
  const next = await planMcpResume(f.dir, { config: f.config });
  assert.equal(next.next.command, 'mcp-proof');
  await f.invoke(['mcp-resume', '--phase', 'discovery', '--config', f.config,
    '--approve', reviewed.next.approval, '--allow-network'], 1);
  f.state.fail = true;
  await f.invoke(['mcp-resume', '--config', f.config, '--approve', next.next.approval, '--allow-network'], 1);
  f.state.fail = false;
  const retry = await planMcpResume(f.dir, { config: f.config });
  assert.equal(retry.layers.proof.status, 'not-dispatched');
  assert.notEqual(retry.next.approval, next.next.approval);
  const count = f.calls.length;
  await f.invoke(['mcp-resume', '--config', f.config, '--approve', next.next.approval, '--allow-network'], 1);
  assert.equal(f.calls.length, count);
  await f.invoke(['mcp-resume', '--config', f.config, '--approve', retry.next.approval, '--allow-network']);
  assert.equal(f.calls.filter(m => m === 'tools/call').length, 1);
  const consumed = await planMcpResume(f.dir, { phase: 'proof', config: f.config });
  assert.equal(consumed.next.code, 'PURPOSE_CONSUMED');
  assert.equal(consumed.layers.proof.attempts.find(a => a.status === 'completed').protocolStatus, 'protocol-success');
  const handoff = await planMcpResume(f.dir);
  assert.equal(handoff.status, 'handoff');
  assert.equal(handoff.layers.callerRejection.status, 'not-applicable');
  assert.equal(handoff.layers.backendEnforcement.status, 'not-supported');
  const clock = t.mock.method(Date, 'now', () => Date.parse(JSON.parse(bytes).capturedAt) + 86400001);
  const stale = await planMcpResume(f.dir, { phase: 'proof', config: f.config });
  assert.equal(stale.layers.discovery.status, 'stale');
  assert.ok(stale.layers.discovery.observations[0].freshness.expiresAt);
  assert.equal(stale.layers.proof.status, 'consumed');
  assert.equal(stale.next.command, null);
  clock.mock.restore();
  assert.deepEqual(await readFile(captured.resultFile), bytes);
});

test('resume distinguishes insufficient, expired and malformed captures without renewal', async t => {
  const f = await fixture(t), captured = await f.capture();
  const bytes = await readFile(captured.resultFile), time = Date.parse(JSON.parse(bytes).capturedAt);
  let clock = t.mock.method(Date, 'now', () => time + 86400000 - 1);
  const nearExpiry = await planMcpResume(f.dir, { phase: 'proof', config: f.config });
  assert.equal(nearExpiry.freshness.status, 'insufficient-lifetime');
  assert.equal(nearExpiry.next.approval, null);
  clock.mock.restore();
  clock = t.mock.method(Date, 'now', () => time + 86400001);
  const expired = await planMcpResume(f.dir, { phase: 'proof', config: f.config });
  assert.equal(expired.next.code, 'PROOF_CAPTURE_INVALID');
  assert.equal(expired.layers.discovery.status, 'stale');
  clock.mock.restore();
  await writeFile(captured.resultFile, JSON.stringify({ ...JSON.parse(bytes), receiptDigest: 'sha256:bad' }));
  assert.equal((await planMcpResume(f.dir, { config: f.config })).next.code, 'INVALID_CAPTURE_HISTORY');
  assert.equal(f.calls.includes('tools/call'), false);
});

test('resume blocks locks, interrupted observations, unknown dispatch and consumed tool errors', async t => {
  const f = await fixture(t);
  for (const lock of ['.provisioning.lock', '.mcp-network.lock']) {
    const file = path.join(f.dir, lock);
    await writeFile(file, 'owned synthetic lock');
    assert.equal((await planMcpResume(f.dir, { config: f.config })).next.code, 'WORKSPACE_LOCKED');
    assert.equal(await readFile(file, 'utf8'), 'owned synthetic lock');
    await rm(file);
  }
  await f.capture();
  f.state.lost = true;
  const plan = await planMcpResume(f.dir, { config: f.config });
  await f.invoke(['mcp-resume', '--config', f.config, '--approve', plan.next.approval, '--allow-network'], 2);
  assert.equal((await planMcpResume(f.dir, { config: f.config })).next.code, 'OUTCOME_UNRESOLVED');
  assert.equal(f.calls.filter(m => m === 'tools/call').length, 1);
  const other = await fixture(t);
  const approval = await planMcpProjectDiscovery(other.dir, {});
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', folder = path.join(other.dir, '.mcp-observations', id);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'intent.json'), JSON.stringify({ schemaVersion: 1,
    approvalDigest: approval.approvalDigest, action: approval.action }));
  assert.equal((await planMcpResume(other.dir, { config: other.config })).next.code, 'OUTCOME_UNRESOLVED');
  await writeFile(path.join(folder, 'intent.json'), '{"truncated":');
  await assert.rejects(planMcpResume(other.dir, { config: other.config }), SyntaxError);
  const failed = await fixture(t);
  await failed.capture(); failed.state.toolError = true;
  const failedPlan = await planMcpResume(failed.dir, { config: failed.config });
  await failed.invoke(['mcp-resume', '--config', failed.config, '--approve', failedPlan.next.approval, '--allow-network'], 2);
  const retained = await planMcpResume(failed.dir, { phase: 'proof', config: failed.config });
  assert.equal(retained.next.code, 'PURPOSE_CONSUMED');
  assert.equal(retained.layers.proof.attempts[0].protocolStatus, 'tool-error');
});

test('resume budgets are exact known stages; independent inconclusive findings never become pass', () => {
  const now = Date.now(), configuration = { expiresAt: new Date(now + 900000).toISOString() };
  const plan = { readiness: { experimental: { configuration } }, operation: {
    discoveryPlan: { authTimeoutMs: 600000, metadataTimeoutMs: 10000 },
    nativeGetMapping: { maximumReadbackMs: 120000 },
    capture: { capturedAt: new Date(now - 1000).toISOString() } } };
  assert.equal(resumeFreshness(plan, now).requiredKnownMs, 730000);
  assert.equal(resumeFreshness(plan, now + 170000).status, 'insufficient-lifetime');
  delete plan.operation.discoveryPlan.authTimeoutMs;
  assert.equal(resumeFreshness(plan, now).status, 'unknown-budget');
  for (const verdict of ['passed', 'failed', 'inconclusive', 'not-evaluated']) {
    const layers = resumeLayers({ proofs: [{ status: 'completed', protocolStatus: 'protocol-success' }],
      observations: [], qualifications: [{ status: verdict === 'not-evaluated' ? 'unresolved' : 'completed',
        backendAssertion: { kind: 'tavily-search-result-v1', status: verdict } }],
      authRejections: { attempts: [{ status: 'passed' }] },
      backendRejections: { attempts: [{ status: 'inconclusive' }] } });
    assert.equal(layers.qualification.status, verdict === 'not-evaluated' ? 'unknown' : 'consumed');
    assert.equal(layers.backendEnforcement.status, 'inconclusive');
    assert.equal(layers.resultAssertions.findings[0].assertion.status, verdict);
    assert.equal(layers.cowork.status, 'not-verified');
    assert.equal(layers.backendEnforcement.endToEndCredentialPropagationVerified, false);
  }
});
