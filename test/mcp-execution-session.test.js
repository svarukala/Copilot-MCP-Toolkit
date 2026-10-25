import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { prepareMcpServer, createMcpServerProject } from 'copilot-mcp-toolkit';
import { TOOLKIT_ROOT } from '../src/config.js';
import { planInteractiveSession } from '../src/mcp-interactive-session.js';
import { planMcpProjectProof } from '../src/mcp-discovery-project.js';
import { discoverMcpToolsForTest } from '../src/mcp-discovery.js';
import { planExecutionSession, runExecutionSession, createExecutionProofApproval } from '../src/mcp-execution-session.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const discoveryClientId = '33333333-3333-4333-8333-333333333333';
const expectedUserId = '44444444-4444-4444-8444-444444444444';
const endpoint = 'https://fixture.coworktoolkit.dev/mcp';
const privateValues = ['private-access-fixture', 'private-refresh-fixture', 'private-device-fixture', 'private-business-fixture'];
const tool = { name: 'read_records', description: 'Read permitted records',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false } };
function fixture({ onCall, onAuth } = {}) {
  const calls = [];
  return { calls,
    authTransport: async (url, options) => {
      const name = new URL(url).pathname;
      calls.push(name);
      let body;
      if (name.endsWith('/openid-configuration')) body = {
        authorization_endpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
        token_endpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        end_session_endpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/logout`,
        issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
        jwks_uri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
      };
      else if (name.endsWith('/devicecode')) body = {
        user_code: 'ABCD-1234', device_code: privateValues[2],
        verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 1,
      };
      else if (name.endsWith('/token')) {
        assert.notEqual(new URLSearchParams(options.body).get('grant_type'), 'refresh_token');
        const claims = { tid: tenantId, oid: expectedUserId, aud: discoveryClientId, sub: 'fixture-sub',
          preferred_username: 'private-user@invalid', iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
          exp: Math.floor(Date.now() / 1000) + 3600 };
        body = { token_type: 'Bearer', access_token: privateValues[0], expires_in: 3600,
          scope: `api://${clientId}/records.read`, refresh_token: privateValues[1],
          id_token: [Buffer.from('{"alg":"RS256"}').toString('base64url'),
            Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.'),
          client_info: Buffer.from(JSON.stringify({ uid: expectedUserId, utid: tenantId })).toString('base64url') };
      } else assert.fail('Unexpected authentication request');
      onAuth?.(body, name);
      return new Response(JSON.stringify(body));
    },
    mcpTransport: async (url, options) => {
      assert.equal(url, endpoint);
      const message = JSON.parse(options.body);
      calls.push(message.method);
      onCall?.(message);
      if (message.method === 'notifications/initialized') return new Response(null, { status: 204 });
      const result = message.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'Synthetic', version: '1' } }
        : message.method === 'tools/list' ? { tools: [tool] }
          : { content: [{ type: 'text', text: JSON.stringify([{ fact: privateValues[3] }]) }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    },
  };
}

async function setup(t, minimumProofDelayMs = 0) {
  const root = path.join(TOOLKIT_ROOT, '.test-output');
  await mkdir(root, { recursive: true });
  const workspaceRoot = await mkdtemp(path.join(root, 'execution-session-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const project = path.join(workspaceRoot, 'project'), config = path.join(workspaceRoot, 'session.json');
  await createMcpServerProject(await prepareMcpServer({ schemaVersion: 1, kind: 'existing-mcp',
    server: { id: '55555555-5555-4555-8555-555555555555', name: 'Synthetic fixture' }, endpoint,
    inbound: { type: 'entra', tenantId, clientId, applicationIdUri: `api://${clientId}`, scope: 'records.read',
      allowedClientIds: [discoveryClientId] } }), { workspaceRoot, projectDir: project });
  const input = { schemaVersion: 1, discovery: { discoveryClientId, expectedUserId },
    proof: { toolName: tool.name, arguments: {},
      safetyReview: { readOnly: true, reason: 'Owner reviewed this operation as a record lookup only.' },
      resultAssertion: { kind: 'json-array-string-field-v1', field: 'fact', maxItems: 1, maxStringLength: 100 } } };
  await writeFile(config, JSON.stringify(input));
  const options = { workspaceRoot, project, config };
  const childPlan = await planInteractiveSession(options);
  const authorization = await planExecutionSession(options, { minimumProofDelayMs });
  return { options: { ...options, approval: childPlan.approvalDigest, allowNetwork: true, onDeviceCode() {} },
    input, childPlan, authorization };
}

async function actualProof(context) {
  const discovery = context.childPlan.discovery.operation;
  const capture = await discoverMcpToolsForTest(discovery.source, { ...context.input.discovery,
    approval: discovery, allowNetwork: true, onDeviceCode() {} }, fixture());
  return planMcpProjectProof(context.options.project, { ...context.input.proof, capture });
}

test('one reviewed execution uses one in-memory sign-in, paced proof and no second approval or raw credential evidence', async t => {
  const context = await setup(t, 65000), transport = fixture();
  let waits = 0, guards = 0;
  const result = await runExecutionSession({ ...context.options,
    approveProof: () => assert.fail('No second approval prompt') }, context.authorization, {
    ...transport, validationGuard: () => { guards++; },
    waitForProof: async (milliseconds, signal) => {
      assert.equal(milliseconds, 65000);
      assert.equal(signal.aborted, false);
      assert.equal(transport.calls.filter(call => call === 'tools/list').length, 1);
      assert.equal(transport.calls.includes('tools/call'), false);
      waits++;
    },
  });
  assert.equal(result.status, 'protocol-success');
  assert.equal(result.tokenPersistence, 'none');
  assert.equal(waits, 1);
  assert.ok(guards >= 2);
  assert.equal(transport.calls.filter(call => call.endsWith('/devicecode')).length, 1);
  assert.equal(transport.calls.filter(call => call.endsWith('/token')).length, 1);
  assert.equal(transport.calls.filter(call => call === 'tools/list').length, 2);
  assert.equal(transport.calls.filter(call => call === 'tools/call').length, 1);
  for (const value of [JSON.stringify(context.authorization), JSON.stringify(result),
    await readFile(result.captureFile, 'utf8'), await readFile(result.proofFile, 'utf8')]) {
    for (const sensitive of privateValues) assert.ok(!value.includes(sensitive));
  }
  const count = transport.calls.length;
  await assert.rejects(runExecutionSession(context.options, context.authorization, transport), { code: 'PROOF_REPLAY_BLOCKED' });
  assert.equal(transport.calls.length, count);
});

test('authorization projection is closed, local, bounded, and pinned to original config', async t => {
  const context = await setup(t);
  assert.equal((await planExecutionSession(context.options)).minimumProofDelayMs, 65000);
  for (const minimumProofDelayMs of [-1, 65001, 1.5, '0']) {
    await assert.rejects(planExecutionSession(context.options, { minimumProofDelayMs }), { code: 'INVALID_CONFIG' });
  }
  assert.throws(() => createExecutionProofApproval({ ...context,
    authorization: { ...context.authorization, extraAuthority: true } }), { code: 'APPROVAL_REQUIRED' });
  context.input.proof.arguments = { id: 1 };
  await writeFile(context.options.config, JSON.stringify(context.input));
  await assert.rejects(planExecutionSession(context.options), { code: 'INVALID_CONFIG' });
});

test('callback approves only an exact discovered proof once and rejects every changed binding', async t => {
  const context = await setup(t), proof = await actualProof(context);
  const callback = createExecutionProofApproval(context);
  assert.equal(await callback(proof), proof.approvalDigest);
  await assert.rejects(callback(proof), { code: 'PROOF_REPLAY_BLOCKED' });
  for (const mutate of [
    value => { value.operation.tool.name = 'other_records'; },
    value => { value.operation.arguments = { id: 1 }; },
    value => { value.operation.source.endpoint = 'https://other.coworktoolkit.dev/mcp'; },
    value => { value.operation.discoveryPlan.auth.expectedUserId = tenantId; },
    value => { value.operation.source.descriptorDigest = `sha256:${'0'.repeat(64)}`; },
    value => { value.operation.safetyReview.reason = 'A different reviewed reason for records.'; },
    value => { delete value.operation.resultAssertion; },
    value => { value.operation.resultAssertion.field = 'other'; },
    value => { value.operation.tool.annotations.readOnlyHint = false; },
    value => { value.approvalDigest = `sha256:${'0'.repeat(64)}`; },
  ]) {
    const changed = structuredClone(proof);
    mutate(changed);
    const approve = createExecutionProofApproval(context);
    await assert.rejects(approve(changed), { code: 'METADATA_MISMATCH' });
    await assert.rejects(approve(proof), { code: 'PROOF_REPLAY_BLOCKED' });
  }
});

test('cancellation, time budgets, config drift and consumed history prevent proof after pacing', async t => {
  for (const mode of ['cancel', 'expire', 'config', 'history', 'child-cancel']) {
    const context = await setup(t, 65000), proof = await actualProof(context);
    const controller = new AbortController();
    let time = Date.now();
    const approve = createExecutionProofApproval({ ...context,
      signal: mode === 'child-cancel' ? undefined : controller.signal }, {
      now: () => time,
      waitForProof: async () => {
        if (mode === 'cancel' || mode === 'child-cancel') controller.abort();
        if (mode === 'expire') time += 900000;
        if (mode === 'config') {
          context.input.proof.safetyReview.reason = 'A different reviewed record lookup reason.';
          await writeFile(context.options.config, JSON.stringify(context.input));
        }
      },
    });
    if (mode === 'history') proof.proofHistory.attempts.push({ status: 'unresolved' });
    await assert.rejects(approve(proof, mode === 'child-cancel' ? controller.signal : undefined),
      { code: mode.includes('cancel') ? 'ABORTED' : mode === 'expire' ? 'AUTH_SESSION_EXPIRED'
        : mode === 'history' ? 'PROOF_OUTCOME_UNRESOLVED' : 'METADATA_MISMATCH' });
  }
});

test('expired session budget refuses pacing and cancellation refuses authentication', async t => {
  const context = await setup(t, 65000), proof = await actualProof(context);
  let time = Date.now();
  const approve = createExecutionProofApproval(context, {
    now: () => time, waitForProof: () => assert.fail('Not enough budget to pace'),
  });
  time += 900000 - 65000;
  await assert.rejects(approve(proof), { code: 'AUTH_SESSION_EXPIRED' });
  const controller = new AbortController();
  controller.abort();
  const transport = fixture();
  await assert.rejects(runExecutionSession({ ...context.options, signal: controller.signal },
    context.authorization, transport), { code: 'ABORTED' });
  assert.equal(transport.calls.length, 0);
});

test('expired cached tokens never refresh after a bounded wait', async t => {
  const context = await setup(t, 65000);
  let time = Date.now();
  const transport = fixture({ onAuth: (body, name) => {
    if (name.endsWith('/token')) body.expires_in = 60;
  } });
  await assert.rejects(runExecutionSession(context.options, context.authorization, {
    ...transport, now: () => time, waitForProof: async () => { time += 65000; },
  }));
  assert.equal(transport.calls.filter(call => call.endsWith('/token')).length, 1);
  assert.equal(transport.calls.includes('tools/call'), false);
});

test('unknown dispatch is consumed without retry, refresh or a second sign-in', async t => {
  const context = await setup(t);
  const transport = fixture({ onCall: message => {
    if (message.method === 'tools/call') throw Error('Synthetic lost response');
  } });
  const result = await runExecutionSession(context.options, context.authorization, transport);
  assert.equal(result.status, 'unknown');
  const proof = await planMcpProjectProof(context.options.project,
    { ...context.input.proof, capture: result.captureFile }).catch(error => error);
  assert.equal(proof.code, 'PROOF_REPLAY_BLOCKED');
  await assert.rejects(runExecutionSession(context.options, context.authorization, transport), { code: 'PROOF_REPLAY_BLOCKED' });
  assert.equal(transport.calls.filter(call => call.endsWith('/token')).length, 1);
  assert.equal(transport.calls.filter(call => call === 'tools/call').length, 1);
});
