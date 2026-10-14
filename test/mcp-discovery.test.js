import test from 'node:test';

import assert from 'node:assert/strict';

import path from 'node:path';

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';

import { PublicClientApplication } from '@azure/msal-node';

import Ajv2020 from 'ajv/dist/2020.js';

import * as core from 'copilot-mcp-toolkit';

import { TOOLKIT_ROOT } from '../src/config.js';

import { RESTRICTED_DISCOVERY_CLIENT_ID } from '../src/contract.js';

import { boundedSnapshot, metadataDigest } from '../src/anonymous-metadata.js';

import { discoverMcpToolsForTest, runMcpReadOnlyProofForTest } from '../src/mcp-discovery.js';

import { planMcpProjectDiscovery, planMcpProjectProof, executeMcpProjectForTest } from '../src/mcp-discovery-project.js';

import { probeMcp, safeMcpDiagnostics } from '../src/mcp-protocol.js';

import { validateToolDescription, toolSchemaIssues } from '../src/mcp-tools.js';

import { safeEntraDiagnostics } from '../src/entra-discovery.js';

import { readMcpStatus } from '../src/mcp-status.js';

import { mcpFailureGuidance } from '../src/mcp-failure.js';

import { nullableSearchTools, nullableSearchArguments } from './support/mcp-nullable.js';

const { planMcpDiscovery, discoverMcpTools, validateMcpObservedCapture,
  planMcpReadOnlyProof } = core;

const tenantId = '11111111-1111-4111-8111-111111111111';

const resourceId = '22222222-2222-4222-8222-222222222222';

const discoveryClientId = '33333333-3333-4333-8333-333333333333';

const expectedUserId = '44444444-4444-4444-8444-444444444444';

const otherId = '55555555-5555-4555-8555-555555555555';

const accessToken = 'opaque-private-fixture-value';

const identity = { discoveryClientId, expectedUserId };

const tool = { name: 'read_record', description: 'Read a permitted record',
  inputSchema: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } }, required: ['id'], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false } };

const tools = { tools: [tool] };

const pretty = value => `${JSON.stringify(value, null, 2)}\n`;

async function descriptor(auth = 'anonymous') {
  return (await core.prepareMcpServer({ schemaVersion: 1, kind: 'existing-mcp',
    server: { id: otherId, name: 'Synthetic fixture' }, endpoint: 'https://fixture.coworktoolkit.dev/mcp',
    inbound: auth === 'entra' ? { type: auth, tenantId, clientId: resourceId, applicationIdUri: `api://${resourceId}`,
      scope: 'records.read', allowedClientIds: [discoveryClientId, RESTRICTED_DISCOVERY_CLIENT_ID] } : { type: auth } })).descriptor;
}

function transportFixture({ authChange, metadata = tools, mcpChange } = {}) {
  const calls = [];
  const authTransport = async (url, options) => {
    const endpoint = new URL(url);
    calls.push(endpoint.pathname);
    let body;
    if (endpoint.pathname.endsWith('/openid-configuration')) {
      body = { authorization_endpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
        token_endpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        end_session_endpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/logout`,
        issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
        jwks_uri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys` };
    } else if (endpoint.pathname.endsWith('/devicecode')) {
      assert.equal(new URLSearchParams(options.body).get('client_id'), discoveryClientId);
      body = { user_code: 'ABCD-1234', device_code: 'private-device-code',
        verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 1 };
    } else if (endpoint.pathname.endsWith('/token')) {
      const claims = { tid: tenantId, oid: expectedUserId, aud: discoveryClientId, sub: 'fixture-sub',
        preferred_username: 'private-user@invalid', iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
        exp: Math.floor(Date.now() / 1000) + 3600 };
      const idToken = [Buffer.from('{"alg":"RS256"}').toString('base64url'),
        Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.');
      body = { token_type: 'Bearer', access_token: accessToken, expires_in: 3600,
        scope: `api://${resourceId}/records.read`, id_token: idToken, refresh_token: 'private-refresh-value',
        client_info: Buffer.from(JSON.stringify({ uid: expectedUserId, utid: tenantId })).toString('base64url') };
    } else throw Error('Unexpected fixture auth endpoint.');
    authChange?.(body, endpoint);
    return new Response(JSON.stringify(body), { status: body.error ? 400 : 200 });
  };
  const mcpTransport = async (url, options) => {
    assert.equal(url, 'https://fixture.coworktoolkit.dev/mcp');
    const message = JSON.parse(options.body);
    calls.push(message.method);
    if (mcpChange) {
      const changed = mcpChange(message, options);
      if (changed) return changed;
    }
    if (message.method === 'notifications/initialized') return new Response(null, { status: 204 });
    let result;
    if (message.method === 'initialize') result = { protocolVersion: '2025-03-26',
      capabilities: { tools: {} }, serverInfo: { name: 'Synthetic', version: '1' } };
    else if (message.method === 'tools/list') result = metadata;
    else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: 'private-business-result' }] };
    else throw Error('Unexpected fixture method.');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  };
  return { authTransport, mcpTransport, calls };
}

async function observed(auth = 'anonymous', fixture = transportFixture()) {
  const source = await descriptor(auth);
  const selection = auth === 'entra' ? identity : {};
  const approval = planMcpDiscovery(source, selection);
  const capture = await discoverMcpToolsForTest(source, { ...selection, approval, allowNetwork: true, onDeviceCode() {} }, fixture);
  return { source, approval, capture, fixture };
}

async function workspace(t) {
  await mkdir(path.join(TOOLKIT_ROOT, '.test-output'), { recursive: true });
  const workspaceRoot = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'mcp-discovery-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  return { workspaceRoot, projectDir: path.join(workspaceRoot, 'project') };
}

function proofSelection(capture) {
  return { capture, toolName: tool.name, arguments: { id: 1 },
    safetyReview: { readOnly: true, reason: 'Owner reviewed this operation as a record lookup only.' } };
}

test('MCP processing diagnostics identify closed method/stage enums for protected and anonymous HTTP failures', async t => {
  const envelope = (message, result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  const cases = [
    ['initialize JSON', 'initialize', 'json-parse', () => new Response('PRIVATE_INVALID_JSON')],
    ['tools JSON', 'tools/list', 'json-parse', () => new Response('PRIVATE_INVALID_JSON')],
    ['SSE JSON', 'tools/list', 'sse-parse', () => new Response('data: PRIVATE_SSE\n\n', { headers: { 'Content-Type': 'text/event-stream' } })],
    ['SSE no matching event', 'initialize', 'sse-event', () => new Response('data: {"id":99,"result":{}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })],
    ['RPC error', 'initialize', 'rpc-error', message => new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'PRIVATE_RPC_ERROR' } }))],
    ['wrong envelope', 'tools/list', 'rpc-envelope', () => new Response('{"jsonrpc":"PRIVATE_VERSION","id":5,"result":{}}')],
    ['uncorrelated error', 'initialize', 'rpc-envelope', () => new Response('{"jsonrpc":"2.0","id":99,"error":{"message":"PRIVATE_ERROR"}}')],
    ['null envelope', 'tools/list', 'rpc-envelope', () => new Response('null')],
    ['unsupported initialization', 'initialize', 'initialization', message => envelope(message, { protocolVersion: 'PRIVATE_UNSUPPORTED', capabilities: {}, serverInfo: { name: 'PRIVATE_SERVER' } })],
    ['invalid input schema', 'tools/list', 'tool-schema', message => envelope(message, { tools: [{ ...tool, name: 'PRIVATE_TOOL', inputSchema: { type: 'array' } }] })],
    ['notification rejection', 'notifications/initialized', 'http-status', () => new Response('PRIVATE_REJECTION', { status: 400 })],
    ['list rejection', 'tools/list', 'http-status', () => new Response('PRIVATE_REJECTION', { status: 500 })],
  ];
  for (const auth of ['anonymous', 'entra']) for (const [label, method, stage, respond] of cases) await t.test(`${auth}: ${label}`, async () => {
    const source = await descriptor(auth), selection = auth === 'entra' ? identity : {};
    const fixture = transportFixture({ mcpChange: message => message.method === method ? respond(message) : undefined });
    await assert.rejects(discoverMcpToolsForTest(source, { ...selection, approval: planMcpDiscovery(source, selection),
      allowNetwork: true, onDeviceCode() {} }, fixture), error => {
      const status = label === 'notification rejection' ? 400 : label === 'list rejection' ? 500 : 200;
      assert.deepEqual(error.diagnostics, { ...(auth === 'entra' ? { authStage: 'metadata',
        failureKind: stage === 'http-status' ? 'http-status' : 'response-shape' } : {}),
        rpcMethod: method, rpcStage: stage, httpStatus: status,
        ...(label === 'invalid input schema' ? { toolSchemaIssue: 'input-root' } : {}) });
      assert.doesNotMatch(error.message + JSON.stringify(error.diagnostics), /PRIVATE|opaque-private|ABCD/);
      const guidance = mcpFailureGuidance(error.diagnostics);
      assert.match(guidance, /MCP metadata\/protocol processing failed/);
      assert.doesNotMatch(guidance, /Runtime authentication failed/);
      if (auth === 'entra') assert.match(guidance, /token validation had completed/);
      return true;
    });
    assert.equal(fixture.calls.filter(value => value === method).length, 1);
    assert.equal(fixture.calls.includes('tools/call'), false);
  });
});

test('tool schema diagnostics identify every existing validation branch without retaining server data', async t => {
  const privateTool = { ...tool, name: 'PRIVATE_TOOL', description: 'PRIVATE_DESCRIPTION' };
  const withTool = patch => ({ tools: [{ ...privateTool, ...patch }] });
  const cases = [
    ['tools-container', { tools: 'PRIVATE_CONTAINER' }],
    ['tools-empty', { tools: [] }],
    ['tool-object', { tools: ['PRIVATE_OBJECT'] }],
    ['tool-name', withTool({ name: 'PRIVATE/NAME' })],
    ['tool-name-duplicate', { tools: [privateTool, privateTool] }],
    ['tool-description', withTool({ description: { PRIVATE_DESCRIPTION: true } })],
    ['input-root', withTool({ inputSchema: { type: 'array' } })],
    ['input-properties', withTool({ inputSchema: { type: 'object', properties: 'PRIVATE_PROPERTIES' } })],
    ['input-required', withTool({ inputSchema: { type: 'object', required: ['PRIVATE_REQUIRED', 'PRIVATE_REQUIRED'] } })],
    ['input-dialect-type', withTool({ inputSchema: { type: 'object', $schema: { PRIVATE_DIALECT: true } } })],
    ['input-dialect-unsupported', withTool({ inputSchema: { type: 'object', $schema: 'https://private.invalid/dialect' } })],
    ['input-schema-invalid', withTool({ inputSchema: { type: 'object', properties: { PRIVATE_PROPERTY: { type: 'PRIVATE_TYPE' } } } })],
    ['output-root', withTool({ outputSchema: { type: 'array' } })],
    ['output-dialect-type', withTool({ outputSchema: { type: 'object', $schema: ['PRIVATE_DIALECT'] } })],
    ['output-dialect-unsupported', withTool({ outputSchema: { type: 'object', $schema: 'https://private.invalid/dialect' } })],
    ['output-schema-invalid', withTool({ outputSchema: { type: 'object', properties: { PRIVATE_PROPERTY: { type: 'PRIVATE_TYPE' } } } })],
  ];
  assert.deepEqual(cases.map(([issue]) => issue), toolSchemaIssues);
  for (const auth of ['anonymous', 'entra']) for (const [issue, metadata] of cases) await t.test(`${auth}: ${issue}`, async () => {
    assert.throws(() => validateToolDescription(metadata), error => error.toolSchemaIssue === issue);
    const source = await descriptor(auth), selection = auth === 'entra' ? identity : {};
    const fixture = transportFixture({ metadata });
    await assert.rejects(discoverMcpToolsForTest(source, { ...selection, approval: planMcpDiscovery(source, selection),
      allowNetwork: true, onDeviceCode() {} }, fixture), error => {
      assert.equal(error.code, 'DISCOVERY_FAILED');
      assert.deepEqual(error.diagnostics, { ...(auth === 'entra' ? { authStage: 'metadata', failureKind: 'response-shape' } : {}),
        rpcMethod: 'tools/list', rpcStage: 'tool-schema', httpStatus: 200, toolSchemaIssue: issue });
      assert.match(mcpFailureGuidance(error.diagnostics), new RegExp(`tools/list/tool-schema/${issue}`));
      assert.doesNotMatch(error.message + JSON.stringify(error.diagnostics), /PRIVATE|private|read_record/);
      return true;
    });
    assert.equal(fixture.calls.filter(method => method === 'tools/list').length, 1);
    assert.equal(fixture.calls.includes('tools/call'), false);
  });
});

test('tool schema diagnostics preserve empty-page aggregation and supported dialect acceptance', async () => {
  for (const dialect of [undefined, 'http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2020-12/schema']) {
    const schema = { type: 'object', ...(dialect === undefined ? {} : { $schema: dialect }) };
    const metadata = { tools: [{ ...tool, inputSchema: schema, outputSchema: schema }] };
    const fixture = transportFixture({ metadata, mcpChange: message => message.method === 'tools/list' && !message.params.cursor
      ? new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [], nextCursor: 'PRIVATE_CURSOR' } })) : undefined });
    const result = await probeMcp('https://fixture.coworktoolkit.dev/mcp', { fetchImpl: fixture.mcpTransport });
    assert.equal(result.toolCount, 1);
    assert.equal(result.pages, 2);
  }
  const fixture = transportFixture({ mcpChange: message => message.method === 'tools/list'
    ? new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id,
      result: { tools: [tool], ...(!message.params.cursor ? { nextCursor: 'PRIVATE_CURSOR' } : {}) } })) : undefined });
  await assert.rejects(probeMcp('https://fixture.coworktoolkit.dev/mcp', { fetchImpl: fixture.mcpTransport }),
    error => error.rpcDiagnostics.toolSchemaIssue === 'tool-name-duplicate');
  const base = { rpcMethod: 'tools/list', rpcStage: 'tool-schema', httpStatus: 200 };
  assert.deepEqual(safeMcpDiagnostics(base), base);
  for (const patch of [{ toolSchemaIssue: 'PRIVATE' }, { toolSchemaIssue: 'input-root', rpcStage: 'json-parse' },
    { toolSchemaIssue: 'input-root', rpcMethod: 'initialize' }, { toolSchemaIssue: 'input-root', body: 'PRIVATE' }]) {
    assert.equal(safeMcpDiagnostics({ ...base, ...patch }), undefined);
    assert.equal(safeEntraDiagnostics({ authStage: 'metadata', failureKind: 'response-shape', ...base, ...patch }), undefined);
  }
  assert.equal(safeEntraDiagnostics({ authStage: 'metadata', failureKind: 'response-shape', toolSchemaIssue: 'input-root' }), undefined);
  assert.equal(safeEntraDiagnostics({ authStage: 'token', failureKind: 'response-shape', ...base, toolSchemaIssue: 'input-root' }), undefined);
});

test('tool schema meta-validation rejects malformed properties/required and sanitizes validator exceptions', async t => {
  for (const dialect of ['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2020-12/schema']) {
    for (const [kind, change, issue] of [
      ['input', { properties: [] }, 'input-properties'],
      ['input', { required: [1] }, 'input-required'],
      ['input', { properties: { PRIVATE_PROPERTY: { type: 'PRIVATE_TYPE' } } }, 'input-schema-invalid'],
      ['output', { properties: [] }, 'output-schema-invalid'],
      ['output', { required: ['PRIVATE_DUPLICATE', 'PRIVATE_DUPLICATE'] }, 'output-schema-invalid'],
    ]) {
      const fixture = transportFixture({ metadata: { tools: [{ ...tool,
        [`${kind}Schema`]: { type: 'object', $schema: dialect, ...change } }] } });
      await assert.rejects(probeMcp('https://fixture.coworktoolkit.dev/mcp', { fetchImpl: fixture.mcpTransport }), error => {
        assert.equal(error.rpcDiagnostics.toolSchemaIssue, issue);
        assert.doesNotMatch(error.message + JSON.stringify(error.rpcDiagnostics), /PRIVATE|json-schema\.org/);
        return true;
      });
    }
  }
  const original = Ajv2020.prototype.validateSchema;
  t.mock.method(Ajv2020.prototype, 'validateSchema', function (schema, ...args) {
    if (schema.title === 'PRIVATE_THROW') throw Error('PRIVATE_VALIDATOR_EXCEPTION');
    return original.call(this, schema, ...args);
  });
  for (const kind of ['input', 'output']) {
    const fixture = transportFixture({ metadata: { tools: [{ ...tool,
      [`${kind}Schema`]: { type: 'object', title: 'PRIVATE_THROW' } }] } });
    await assert.rejects(probeMcp('https://fixture.coworktoolkit.dev/mcp', { fetchImpl: fixture.mcpTransport }), error => {
      assert.equal(error.rpcDiagnostics.toolSchemaIssue, `${kind}-schema-invalid`);
      assert.doesNotMatch(error.message + JSON.stringify(error.rpcDiagnostics), /PRIVATE/);
      return true;
    });
    assert.equal(fixture.calls.includes('tools/call'), false);
  }
});

test('MCP processing diagnostics distinguish bounded reads, pagination, and notification transport without leaking input', async () => {
  for (const [variant, stage] of [['limit', 'response-limit'], ['transport', 'transport'], ['pagination', 'pagination']]) {
    const fixture = transportFixture({ mcpChange: message => {
      if (variant === 'limit' && message.method === 'initialize') return new Response('PRIVATE'.repeat(200));
      if (variant === 'transport' && message.method === 'notifications/initialized') throw Error('PRIVATE_TRANSPORT');
      if (variant === 'pagination' && message.method === 'tools/list') return new Response(JSON.stringify({
        jsonrpc: '2.0', id: message.id, result: { tools: [], nextCursor: 'PRIVATE_CURSOR' },
      }));
    } });
    await assert.rejects(probeMcp('https://fixture.coworktoolkit.dev/mcp', { fetchImpl: fixture.mcpTransport,
      maxBytes: variant === 'limit' ? 100 : 262144, maxPages: 1 }), error => {
      assert.equal(error.rpcDiagnostics.rpcStage, stage);
      assert.doesNotMatch(JSON.stringify(error.rpcDiagnostics), /PRIVATE/);
      return true;
    });
  }
  const base = { rpcMethod: 'tools/list', rpcStage: 'tool-schema', httpStatus: 200 };
  assert.deepEqual(safeMcpDiagnostics(base), base);
  for (const extra of [{ rpcMethod: 'tools/PRIVATE' }, { rpcStage: 'PRIVATE' }, { httpStatus: 600 }, { payload: 'PRIVATE' }]) {
    assert.equal(safeMcpDiagnostics({ ...base, ...extra }), undefined);
    assert.equal(safeEntraDiagnostics({ authStage: 'metadata', failureKind: 'response-shape', ...base, ...extra }), undefined);
  }
  assert.equal(safeEntraDiagnostics({ authStage: 'token', failureKind: 'transport', ...base }), undefined);
  assert.equal(safeEntraDiagnostics({ authStage: 'metadata', failureKind: 'response-shape', rpcStage: 'tool-schema' }), undefined);
  assert.match(mcpFailureGuidance({ authStage: 'metadata', failureKind: 'response-shape', httpStatus: 200 }), /metadata\/unspecified/);
});

test('post-dispatch RPC diagnostics never make a malformed tool response retryable', async () => {
  for (const [stage, respond] of [
    ['json-parse', () => new Response('PRIVATE_RESULT')],
    ['rpc-error', message => new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { message: 'PRIVATE_ERROR' } }))],
    ['tool-response', message => new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: 'PRIVATE_CONTENT' } }))],
  ]) {
    const fixture = transportFixture({ mcpChange: message => message.method === 'tools/call' ? respond(message) : undefined });
    await assert.rejects(probeMcp('https://fixture.coworktoolkit.dev/mcp', { fetchImpl: fixture.mcpTransport,
      toolCall: { name: tool.name, arguments: { id: 1 }, toolsDigest: metadataDigest(boundedSnapshot(tools)) } }), error => {
      assert.equal(error.invocationStatus, 'unknown');
      assert.deepEqual(error.rpcDiagnostics, { rpcMethod: 'tools/call', rpcStage: stage, httpStatus: 200 });
      assert.doesNotMatch(error.message + JSON.stringify(error.rpcDiagnostics), /PRIVATE/);
      return true;
    });
    assert.equal(fixture.calls.filter(method => method === 'tools/call').length, 1);
  }
});

test('MCP processing failure persistence and proof recovery reject unknown or tampered RPC diagnostics', async t => {
  for (const auth of ['anonymous', 'entra']) for (const stage of ['json-parse', 'tool-schema']) await t.test(`${auth}: ${stage}`, async t => {
    const context = await workspace(t), { source, capture } = await observed(auth);
    const review = await core.prepareMcpServer({ schemaVersion: 1, kind: 'existing-mcp',
      server: source.server, endpoint: source.endpoint, inbound: source.inbound });
    await core.createMcpServerProject(review, context);
    const selection = proofSelection(capture), plan = await planMcpProjectProof(context.projectDir, selection);
    const fixture = transportFixture({ metadata: { tools: [{ ...tool, inputSchema: { type: 'object', $schema: 'PRIVATE' } }] },
      mcpChange: message => stage === 'json-parse' && message.method === 'tools/list'
      ? new Response('PRIVATE_MALFORMED') : undefined });
    const run = (descriptor, options, guard, execution) => runMcpReadOnlyProofForTest(descriptor, options, {
      ...fixture, beforeRequest: guard, beforeToolDispatch: execution.beforeToolDispatch });
    await assert.rejects(executeMcpProjectForTest(context.projectDir, { selection, approval: plan,
      allowNetwork: true, onDeviceCode() {} }, true, run));
    const fresh = await planMcpProjectProof(context.projectDir, selection);
    const attempt = fresh.proofHistory.attempts[0];
    assert.equal(attempt.status, 'not-dispatched');
    assert.equal(attempt.diagnostics.rpcMethod, 'tools/list');
    assert.equal(attempt.diagnostics.rpcStage, stage);
    assert.equal(attempt.diagnostics.toolSchemaIssue, stage === 'tool-schema' ? 'input-dialect-unsupported' : undefined);
    assert.deepEqual((await readMcpStatus(context.projectDir)).proofs[0].diagnostics, attempt.diagnostics);
    const file = path.join(context.projectDir, '.mcp-observations', attempt.attemptId, 'failure.json');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE|opaque-private|read_record/);
    assert.equal(fixture.calls.includes('tools/call'), false);
    for (const change of [{ rpcStage: 'PRIVATE' }, { rpcMethod: 'tools/other' }, { body: 'PRIVATE' },
      { toolSchemaIssue: 'PRIVATE' }, { toolSchemaIssue: 'input-root', rpcStage: 'json-parse' },
      { toolSchemaIssue: 'input-root', rpcMethod: 'tools/call' }]) {
      const { failureDigest, ...body } = structuredClone(saved);
      Object.assign(body.diagnostics, change);
      await writeFile(file, pretty({ ...body, failureDigest: metadataDigest(boundedSnapshot(body)) }));
      const blocked = await planMcpProjectProof(context.projectDir, selection);
      assert.equal(blocked.proofHistory.attempts[0].status, 'unresolved');
      assert.equal(blocked.proofHistory.attempts[0].diagnostics, undefined);
      await assert.rejects(executeMcpProjectForTest(context.projectDir, { selection, approval: blocked,
        allowNetwork: true }, true, () => assert.fail('No retry')), { code: 'PROOF_OUTCOME_UNRESOLVED' });
    }
    await writeFile(file, pretty({ ...saved, diagnostics: { ...saved.diagnostics, rpcStage: 'rpc-envelope' } }));
    assert.equal((await planMcpProjectProof(context.projectDir, selection)).proofHistory.attempts[0].status, 'unresolved');
    if (stage === 'tool-schema') {
      await writeFile(file, pretty({ ...saved, diagnostics: { ...saved.diagnostics, toolSchemaIssue: 'input-root' } }));
      assert.equal((await planMcpProjectProof(context.projectDir, selection)).proofHistory.attempts[0].status, 'unresolved');
    }
    await writeFile(file, pretty(saved));
    assert.equal((await planMcpProjectProof(context.projectDir, selection)).proofHistory.attempts[0].status, 'not-dispatched');
  });
});

test('standalone anonymous and real mocked MSAL discovery preserve observed source/time without registration', async () => {
  for (const auth of ['anonymous', 'entra']) {
    const { source, approval, capture, fixture } = await observed(auth);
    assert.equal(capture.source.status, 'referenced-not-verified');
    assert.equal(capture.evidence, auth === 'entra' ? 'observed-authenticated-discovery' : 'observed-discovery');
    assert.deepEqual(capture.source, source);
    assert.deepEqual(capture.discoveryPlan, approval);
    assert.deepEqual(validateMcpObservedCapture(capture), capture);
    assert.deepEqual(capture.tools, tools);
    assert.equal(fixture.calls.filter(method => method === 'tools/call').length, 0);
    for (const forbidden of [accessToken, 'private-device', 'private-refresh', 'private-user', 'ABCD-1234']) {
      assert.ok(!JSON.stringify(capture).includes(forbidden));
    }
    if (auth === 'entra') assert.equal(capture.discoveryPlan.auth.expectedUserId, expectedUserId);
    else assert.equal(capture.discoveryPlan.auth, undefined);
  }
});

test('strict operation approval and source/client/user identity drift fail before any request', async () => {
  const source = await descriptor('entra'), fixture = transportFixture();
  const approval = planMcpDiscovery(source, identity);
  for (const patch of [{ allowNetwork: false }, { expectedUserId: otherId }, { discoveryClientId: otherId },
    { approval: { ...approval, metadataTimeoutMs: 1 } }, { token: 'not-supported' },
    { fetchImpl() {} }, { tokenProvider() {} }, { signal: AbortSignal.abort() }]) {
    await assert.rejects(discoverMcpToolsForTest(source, { ...identity, approval, allowNetwork: true, onDeviceCode() {}, ...patch }, fixture));
  }
  for (const input of [{ discoveryClientId }, { ...identity, discoveryClientId: resourceId },
    { ...identity, discoveryClientId: RESTRICTED_DISCOVERY_CLIENT_ID }, { ...identity, expectedUserId: 'common' }]) {
    assert.throws(() => planMcpDiscovery(source, input));
  }
  const changed = structuredClone(source);
  changed.endpoint += '/changed';
  await assert.rejects(discoverMcpToolsForTest(changed, { ...identity, approval, allowNetwork: true, onDeviceCode() {} }, fixture));
  assert.deepEqual(fixture.calls, []);
});

test('provider OAuth remains a precise manual import checkpoint and anonymous has no implicit Entra identity', async () => {
  const source = await descriptor('oauth');
  assert.throws(() => planMcpDiscovery(source), { code: 'OAUTH_REVIEWED_IMPORT_REQUIRED' });
  await assert.rejects(discoverMcpTools(source, { allowNetwork: true, approval: {} }), { code: 'OAUTH_REVIEWED_IMPORT_REQUIRED' });
  const anonymous = await descriptor();
  assert.throws(() => planMcpDiscovery(anonymous, identity), { code: 'AUTH_CONFIG_INVALID' });
});

test('auth denial, wrong runtime user, expired tokens and cancellation never produce metadata or downgrade', async t => {
  const source = await descriptor('entra'), approval = planMcpDiscovery(source, identity);
  const cases = [
    transportFixture({ authChange: (body, url) => { if (url.pathname.endsWith('/token')) { body.error = 'access_denied'; } } }),
    transportFixture({ mcpChange: () => new Response(null, { status: 403 }) }),
  ];
  for (const fixture of cases) {
    await assert.rejects(discoverMcpToolsForTest(source, { ...identity, approval, allowNetwork: true, onDeviceCode() {} }, fixture),
      error => ['AUTHENTICATION_FAILED', 'AUTHENTICATION_REJECTED'].includes(error.code));
    assert.ok(!fixture.calls.includes('tools/call'));
  }
  const fixture = transportFixture();
  const wrongUser = planMcpDiscovery(source, { ...identity, expectedUserId: otherId });
  await assert.rejects(discoverMcpToolsForTest(source, { ...identity, expectedUserId: otherId, approval: wrongUser,
    allowNetwork: true, onDeviceCode() {} }, fixture), { code: 'AUTHENTICATION_REJECTED' });
  assert.ok(!fixture.calls.includes('initialize'));
  const mock = t.mock.method(PublicClientApplication.prototype, 'acquireTokenByDeviceCode', async () => ({
    tenantId, account: { tenantId, localAccountId: expectedUserId }, tokenType: 'Bearer', accessToken,
    expiresOn: new Date(Date.now() - 1), scopes: [`api://${resourceId}/records.read`],
  }));
  await assert.rejects(discoverMcpToolsForTest(source, { ...identity, approval, allowNetwork: true, onDeviceCode() {} }, transportFixture()),
    { code: 'TOKEN_EXPIRED' });
  mock.mock.restore();
  const controller = new AbortController();
  await assert.rejects(discoverMcpToolsForTest(source, { ...identity, approval, allowNetwork: true, signal: controller.signal,
    onDeviceCode() { controller.abort(); } }, transportFixture()), { code: 'ABORTED' });
});

test('metadata pagination, limits, duplicate schemas and unselected secrets are rejected with no capture', async () => {
  const source = await descriptor(), approval = planMcpDiscovery(source);
  for (const metadata of [
    { tools: [tool], nextCursor: 'repeat' }, { tools: [tool], nextCursor: '' },
    { tools: [{ name: 'bad', inputSchema: { type: 'array' } }] },
    { tools: [tool, tool] }, { tools: [{ ...tool, description: 'x'.repeat(300000) }] },
    { tools: [tool, { ...tool, name: 'unselected', description: `Bearer ${'s'.repeat(30)}` }] },
  ]) {
    await assert.rejects(discoverMcpToolsForTest(source, { approval, allowNetwork: true }, transportFixture({ metadata })));
  }
  let page = 0;
  const fixture = transportFixture({ mcpChange: message => {
    if (message.method !== 'tools/list') return;
    const result = ++page === 1 ? { tools: [tool], nextCursor: 'next' }
      : { tools: [{ ...tool, name: 'read_more' }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  } });
  const capture = await discoverMcpToolsForTest(source, { approval, allowNetwork: true }, fixture);
  assert.equal(capture.tools.tools.length, 2);
  assert.equal(page, 2);
});

test('JWT disclosure guard rejects another tenant, resource, runtime user or delegated client before MCP', async t => {
  const source = await descriptor('entra'), approval = planMcpDiscovery(source, identity);
  const claims = { tid: tenantId, aud: resourceId, oid: expectedUserId, azp: discoveryClientId,
    scp: 'records.read', exp: Math.floor(Date.now() / 1000) + 3600 };
  for (const patch of [{ tid: otherId }, { aud: otherId }, { oid: otherId }, { azp: otherId }, { scp: 'records.write' }]) {
    const token = [Buffer.from('{"alg":"RS256"}').toString('base64url'),
      Buffer.from(JSON.stringify({ ...claims, ...patch })).toString('base64url'), 'signature'].join('.');
    const mock = t.mock.method(PublicClientApplication.prototype, 'acquireTokenByDeviceCode', async () => ({
      tenantId, account: { tenantId, localAccountId: expectedUserId }, tokenType: 'Bearer',
      accessToken: token, expiresOn: new Date(Date.now() + 3600000), scopes: [`api://${resourceId}/records.read`],
    }));
    const fixture = transportFixture();
    await assert.rejects(discoverMcpToolsForTest(source, { ...identity, approval, allowNetwork: true, onDeviceCode() {} }, fixture),
      { code: 'AUTHENTICATION_REJECTED' });
    assert.deepEqual(fixture.calls, []);
    mock.mock.restore();
  }
});

test('proof requires independent safety and schema review, exact arguments and fresh capture', async () => {
  const { source, capture } = await observed();
  const selection = proofSelection(capture), approval = planMcpReadOnlyProof(source, selection);
  assert.equal(approval.safetyReview.verified, false);
  assert.equal(approval.capture.receiptDigest, capture.receiptDigest);
  const fixture = transportFixture();
  for (const patch of [{ safetyReview: { readOnly: false, reason: selection.safetyReview.reason } },
    { safetyReview: { readOnly: true, reason: 'Delete the record after reading it.' } },
    { arguments: { id: '1' } }, { arguments: { id: 1, hidden: true } },
    { arguments: { id: 2 }, approval }, { allowNetwork: false }]) {
    await assert.rejects(runMcpReadOnlyProofForTest(source, { ...selection, approval, allowNetwork: true, ...patch }, fixture));
  }
  assert.deepEqual(fixture.calls, []);
  for (const changedTool of [
    { ...tool, name: 'delete_record' }, { ...tool, annotations: { readOnlyHint: true } },
    { ...tool, inputSchema: { ...tool.inputSchema, patternProperties: {} } },
    { ...tool, inputSchema: { ...tool.inputSchema, $ref: 'https://remote.invalid/schema' } },
  ]) {
    const result = await observed('anonymous', transportFixture({ metadata: { tools: [changedTool] } }));
    assert.throws(() => planMcpReadOnlyProof(result.source, { ...proofSelection(result.capture), toolName: changedTool.name }));
  }
});

test('proof re-lists schemas, sends one exact call and retains no raw data; tool errors differ from success', async () => {
  for (const auth of ['anonymous', 'entra']) {
    const { source, capture } = await observed(auth);
    const selection = proofSelection(capture), approval = planMcpReadOnlyProof(source, selection);
    for (const isError of [false, true]) {
      let callCount = 0;
      const fixture = transportFixture({ mcpChange: message => {
        if (message.method !== 'tools/call') return;
        callCount++;
        assert.deepEqual(message.params, { name: tool.name, arguments: { id: 1 } });
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id,
          result: { isError, content: [{ type: 'text', text: 'private-response-value' }] } }));
      } });
      const result = await runMcpReadOnlyProofForTest(source, { ...selection, approval, allowNetwork: true, onDeviceCode() {} }, fixture);
      assert.equal(result.status, isError ? 'tool-error' : 'protocol-success');
      assert.equal(result.businessCorrectnessVerified, false);
      assert.equal(result.coworkRuntimeVerified, false);
      assert.equal(callCount, 1);
      assert.doesNotMatch(JSON.stringify(result), /private-|ABCD|Bearer/);
    }
    const fixture = transportFixture({ metadata: { tools: [{ ...tool, description: 'Changed on server' }] } });
    await assert.rejects(runMcpReadOnlyProofForTest(source, { ...selection, approval, allowNetwork: true, onDeviceCode() {} }, fixture));
    assert.ok(!fixture.calls.includes('tools/call'));
  }
});

test('public nullable proof planning preserves full capture and validates optional scalar arguments without defaults or coercion', async () => {
  for (const auth of ['anonymous', 'entra']) {
    const metadata = nullableSearchTools();
    const { source, capture } = await observed(auth, transportFixture({ metadata }));
    const original = pretty(capture);
    const selection = { ...proofSelection(capture), toolName: metadata.tools[0].name, arguments: nullableSearchArguments() };
    for (const patch of [{}, { exact_match: null, time_range: null }, { exact_match: false, time_range: 'day' },
      { exact_match: true, time_range: 'week' }, { time_range: 'month' }, { time_range: 'year' }]) {
      const args = { ...selection.arguments, ...patch };
      const plan = planMcpReadOnlyProof(source, { ...selection, arguments: args });
      assert.deepEqual(plan.arguments, args);
      assert.deepEqual(plan.tool.inputSchema, metadata.tools[0].inputSchema);
      assert.equal(plan.capture.receiptDigest, capture.receiptDigest);
      assert.equal(plan.capture.toolsDigest, metadataDigest(boundedSnapshot(metadata)));
    }
    for (const patch of [{ exact_match: 'false' }, { exact_match: 0 }, { exact_match: {} },
      { time_range: 'all' }, { time_range: false }, { time_range: [] }, { max_results: '1' },
      { max_results: 2 }, { include_domains: 'learn.microsoft.com' }, { extra: null }]) {
      assert.throws(() => planMcpReadOnlyProof(source, { ...selection, arguments: { ...selection.arguments, ...patch } }),
        { code: 'PROOF_ARGUMENTS_INVALID' });
    }
    assert.throws(() => planMcpReadOnlyProof(source, { ...selection, arguments: { exact_match: null } }), { code: 'PROOF_ARGUMENTS_INVALID' });
    assert.throws(() => planMcpReadOnlyProof(source, { ...selection, arguments: { query: 'x'.repeat(16385) } }), { code: 'LIMIT' });
    assert.throws(() => planMcpReadOnlyProof(source, { ...selection, safetyReview: { readOnly: false, reason: selection.safetyReview.reason } }),
      { code: 'READ_ONLY_REVIEW_REQUIRED' });
    const stripped = structuredClone(capture);
    delete stripped.tools.tools[0].inputSchema.properties.time_range;
    assert.throws(() => planMcpReadOnlyProof(source, { ...selection, capture: stripped }), { code: 'METADATA_MISMATCH' });
    assert.equal(pretty(capture), original);
  }
});

test('nullable scalar proof branches retain strict constraints, both branch orders and the depth budget', async () => {
  for (const [branch, valid, invalid] of [
    [{ type: 'boolean', const: true }, true, false],
    [{ type: 'string', enum: ['day'], minLength: 3, maxLength: 3 }, 'day', 'week'],
    [{ type: 'number', minimum: 1, maximum: 2 }, 1.5, 3],
    [{ type: 'integer', minimum: 1, maximum: 2 }, 2, 1.5],
  ]) for (const reverse of [false, true]) {
    const metadata = nullableSearchTools(), branches = [branch, { type: 'null' }];
    metadata.tools[0].inputSchema.properties.exact_match = {
      anyOf: reverse ? branches.toReversed() : branches, title: 'Optional filter', description: 'Scalar or null.', default: null,
    };
    const { source, capture } = await observed('anonymous', transportFixture({ metadata }));
    const selection = { ...proofSelection(capture), toolName: metadata.tools[0].name };
    for (const value of [valid, null]) assert.deepEqual(planMcpReadOnlyProof(source, { ...selection,
      arguments: { query: 'Documentation', exact_match: value } }).tool.inputSchema, metadata.tools[0].inputSchema);
    assert.throws(() => planMcpReadOnlyProof(source, { ...selection, arguments: { query: 'Documentation', exact_match: invalid } }),
      { code: 'PROOF_ARGUMENTS_INVALID' });
  }
  for (const wrappers of [9, 10]) {
    const metadata = nullableSearchTools();
    let nested = metadata.tools[0].inputSchema.properties.exact_match;
    for (let index = 0; index < wrappers; index++) nested = { type: 'object', properties: { value: nested } };
    metadata.tools[0].inputSchema.properties.exact_match = nested;
    const { source, capture } = await observed('anonymous', transportFixture({ metadata }));
    const selection = { ...proofSelection(capture), toolName: metadata.tools[0].name, arguments: nullableSearchArguments() };
    if (wrappers === 9) assert.ok(planMcpReadOnlyProof(source, selection));
    else assert.throws(() => planMcpReadOnlyProof(source, selection), { code: 'PROOF_SCHEMA_UNSUPPORTED' });
  }
});

test('nullable proof support rejects general composition, malformed pairs and unknown keywords even on unused fields', async t => {
  const pair = { anyOf: [{ type: 'boolean' }, { type: 'null' }] };
  const cases = [
    ['one branch', { anyOf: [{ type: 'boolean' }] }],
    ['three branches', { anyOf: [{ type: 'boolean' }, { type: 'null' }, { type: 'string' }] }],
    ['two scalars', { anyOf: [{ type: 'boolean' }, { type: 'string' }] }],
    ['two nulls', { anyOf: [{ type: 'null' }, { type: 'null' }] }],
    ['boolean schema', { anyOf: [true, { type: 'null' }] }],
    ['untyped scalar', { anyOf: [{ enum: ['day'] }, { type: 'null' }] }],
    ['object union', { anyOf: [{ type: 'object' }, { type: 'null' }] }],
    ['array union', { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] }],
    ['nested union', { anyOf: [pair, { type: 'null' }] }],
    ['type array', { anyOf: [{ type: ['boolean', 'null'] }, { type: 'null' }] }],
    ['null constraint', { anyOf: [{ type: 'boolean' }, { type: 'null', const: null }] }],
    ['scalar unknown keyword', { anyOf: [{ type: 'string', pattern: 'day' }, { type: 'null' }] }],
    ['scalar structural keyword', { anyOf: [{ type: 'string', properties: {} }, { type: 'null' }] }],
    ['strict scalar keyword mismatch', { anyOf: [{ type: 'boolean', minLength: 1 }, { type: 'null' }] }],
    ['wrapper type', { ...pair, type: 'boolean' }],
    ['wrapper constraint', { ...pair, enum: [true, null] }],
    ['wrapper unknown keyword', { ...pair, unreviewed: true }],
    ['oneOf', { oneOf: pair.anyOf }],
    ['allOf', { allOf: pair.anyOf }],
    ['$ref', { ...pair, $ref: '#' }],
  ];
  for (const [name, field] of cases) await t.test(name, async () => {
    const metadata = nullableSearchTools();
    metadata.tools[0].inputSchema.properties.exact_match = field;
    const { source, capture, fixture } = await observed('anonymous', transportFixture({ metadata }));
    assert.throws(() => planMcpReadOnlyProof(source, { ...proofSelection(capture),
      toolName: metadata.tools[0].name, arguments: nullableSearchArguments() }), { code: 'PROOF_SCHEMA_UNSUPPORTED' });
    assert.equal(fixture.calls.includes('tools/call'), false);
  });
});

test('nullable proof re-list compares unused branches and annotations before any single mock dispatch', async () => {
  const metadata = nullableSearchTools();
  const { source, capture } = await observed('entra', transportFixture({ metadata }));
  const selection = { ...proofSelection(capture), toolName: metadata.tools[0].name, arguments: nullableSearchArguments() };
  const approval = planMcpReadOnlyProof(source, selection);
  for (const change of [
    field => { field.anyOf[0].enum.push('all'); },
    field => { field.default = 'day'; },
    field => { field.anyOf.reverse(); },
  ]) {
    const changed = structuredClone(metadata); change(changed.tools[0].inputSchema.properties.time_range);
    const fixture = transportFixture({ metadata: changed });
    await assert.rejects(runMcpReadOnlyProofForTest(source, { ...selection, approval, allowNetwork: true, onDeviceCode() {} }, fixture));
    assert.equal(fixture.calls.includes('tools/call'), false);
  }
  const fixture = transportFixture({ metadata, mcpChange: message => {
    if (message.method === 'tools/call') assert.deepEqual(message.params, { name: metadata.tools[0].name, arguments: selection.arguments });
  } });
  const result = await runMcpReadOnlyProofForTest(source, { ...selection, approval, allowNetwork: true, onDeviceCode() {} }, fixture);
  assert.equal(result.status, 'protocol-success');
  assert.equal(fixture.calls.filter(method => method === 'tools/call').length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private-business-result/);
});

test('connection loss, malformed/oversize response and cancellation after call yield unknown without retry', async () => {
  const { source, capture } = await observed(), selection = proofSelection(capture);
  const approval = planMcpReadOnlyProof(source, selection);
  for (const outcome of ['loss', 'malformed', 'oversize', 'denied', 'cancel']) {
    const controller = new AbortController();
    const fixture = transportFixture({ mcpChange: message => {
      if (message.method !== 'tools/call') return;
      if (outcome === 'loss') throw Error('private network detail');
      if (outcome === 'cancel') { controller.abort(); throw Error('private aborted detail'); }
      if (outcome === 'denied') return new Response(null, { status: 403 });
      return new Response(outcome === 'malformed' ? 'not-json-private' : 'x'.repeat(300000));
    } });
    const result = await runMcpReadOnlyProofForTest(source, { ...selection, approval, allowNetwork: true,
      signal: controller.signal }, fixture);
    assert.equal(result.status, 'unknown');
    assert.equal(fixture.calls.filter(method => method === 'tools/call').length, 1);
    assert.doesNotMatch(JSON.stringify(result), /private/);
  }
});

test('authenticated call denial or cancellation also preserves unknown instead of retrying login or execution', async () => {
  const { source, capture } = await observed('entra'), selection = proofSelection(capture);
  const approval = planMcpReadOnlyProof(source, selection);
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    const fixture = transportFixture({ mcpChange: message => {
      if (message.method !== 'tools/call') return;
      if (cancel) controller.abort();
      return new Response(null, { status: 401 });
    } });
    const result = await runMcpReadOnlyProofForTest(source, { ...selection, approval, allowNetwork: true,
      signal: controller.signal, onDeviceCode() {} }, fixture);
    assert.equal(result.status, 'unknown');
    assert.equal(result.errorCode, cancel ? 'ABORTED' : 'AUTHENTICATION_REJECTED');
    assert.equal(fixture.calls.filter(method => method === 'tools/call').length, 1);
    assert.equal(fixture.calls.filter(method => method.endsWith('/token')).length, 1);
  }
});

test('project operation revalidates saved sources, persists captures and blocks repeat proof approval', async t => {
  const context = await workspace(t);
  const review = await core.prepareMcpServer({ schemaVersion: 1, kind: 'existing-mcp',
    server: { id: otherId, name: 'Synthetic fixture' }, endpoint: 'https://fixture.coworktoolkit.dev/mcp',
    inbound: { type: 'anonymous' } });
  await core.createMcpServerProject(review, context);
  const approval = await planMcpProjectDiscovery(context.projectDir);
  const run = (source, options, guard) => discoverMcpToolsForTest(source, options, { ...transportFixture(), beforeRequest: guard });
  const saved = await executeMcpProjectForTest(context.projectDir, { selection: {}, approval, allowNetwork: true }, false, run);
  assert.equal(saved.result.evidence, 'observed-discovery');
  assert.equal(saved.descriptorStatus, 'referenced-not-verified');
  assert.deepEqual(JSON.parse(await readFile(saved.resultFile)), saved.result);
  const selection = proofSelection(saved.result);
  const proofApproval = await planMcpProjectProof(context.projectDir, selection);
  const proofRun = (source, options, guard, hooks) => runMcpReadOnlyProofForTest(source, options, { ...transportFixture(), ...hooks, beforeRequest: guard });
  const proof = await executeMcpProjectForTest(context.projectDir, { selection, approval: proofApproval, allowNetwork: true }, true, proofRun);
  assert.equal(proof.result.status, 'protocol-success');
  await assert.rejects(executeMcpProjectForTest(context.projectDir, { selection, approval: proofApproval, allowNetwork: true }, true, proofRun),
    { code: 'PROOF_REPLAY_BLOCKED' });
  assert.ok(!(await readdir(context.projectDir)).includes('.mcp-network.lock'));
  await writeFile(path.join(context.projectDir, 'mcp-server.json'), '{}');
  await assert.rejects(planMcpProjectDiscovery(context.projectDir), /differs/);
});

test('generated APIM discovery stays blocked before approved deployment; source drift stops subsequent requests', async t => {
  const context = await workspace(t);
  const input = { schemaVersion: 1, kind: 'apim-mcp-proxy',
    server: { id: otherId, name: 'Synthetic proxy' },
    azure: { apimMode: 'existing', tenantId, subscriptionId: otherId, resourceGroup: 'fixture-rg',
      apimName: 'fixture-apim', keyVaultName: 'fixture-vault' },
    inbound: (await descriptor('entra')).inbound,
    backend: { endpoint: 'https://backend.coworktoolkit.dev/mcp', auth: 'api-key',
      apiKey: { secretIdentifier: 'https://fixture-vault.vault.azure.net/secrets/backend', headerName: 'X-Key' } } };
  await core.createMcpServerProject(await core.prepareMcpServer(input), context);
  await assert.rejects(planMcpProjectDiscovery(context.projectDir, identity), { code: 'DEPLOYMENT_CHECKPOINT_REQUIRED' });
  const source = await descriptor();
  const approval = planMcpDiscovery(source), fixture = transportFixture();
  let requests = 0;
  await assert.rejects(discoverMcpToolsForTest(source, { approval, allowNetwork: true }, { ...fixture,
    beforeRequest: () => { if (++requests === 2) throw Error('source changed'); } }));
  assert.deepEqual(fixture.calls, ['initialize']);
});

test('project unknown proof result persists without business data and blocks changed-plan replay too', async t => {
  const context = await workspace(t), source = await descriptor();
  const review = await core.prepareMcpServer({ schemaVersion: 1, kind: 'existing-mcp',
    server: source.server, endpoint: source.endpoint, inbound: source.inbound });
  await core.createMcpServerProject(review, context);
  const { capture } = await observed();
  const selection = proofSelection(capture);
  const approval = await planMcpProjectProof(context.projectDir, selection);
  const run = (descriptor, options, guard, hooks) => runMcpReadOnlyProofForTest(descriptor, options, {
    ...hooks,
    ...transportFixture({ mcpChange: message => {
      if (message.method === 'tools/call') throw Error('private disconnected business data');
    } }), beforeRequest: guard,
  });
  const saved = await executeMcpProjectForTest(context.projectDir, { selection, approval, allowNetwork: true }, true, run);
  assert.equal(saved.result.status, 'unknown');
  assert.doesNotMatch(await readFile(saved.resultFile, 'utf8'), /private disconnected/);
  const changed = { ...selection, arguments: { id: 2 } };
  const changedApproval = await planMcpProjectProof(context.projectDir, changed);
  await assert.rejects(executeMcpProjectForTest(context.projectDir, {
    selection: changed, approval: changedApproval, allowNetwork: true,
  }, true, run), { code: 'PROOF_OUTCOME_UNRESOLVED' });
});

test('captured timestamp, authenticated source identity and freshness cannot be renewed by adapter binding', async () => {
  const { capture } = await observed('entra');
  const old = structuredClone(capture);
  old.capturedAt = new Date(Date.now() - 25 * 3600000).toISOString();
  const { receiptDigest: _digest, ...record } = old;
  old.receiptDigest = metadataDigest(boundedSnapshot(record));
  assert.throws(() => validateMcpObservedCapture(old), { code: 'METADATA_STALE' });
  assert.equal(validateMcpObservedCapture(old, { maxAgeHours: 48 }).capturedAt, old.capturedAt);
  const changed = structuredClone(capture);
  changed.discoveryPlan.auth.expectedUserId = otherId;
  assert.throws(() => validateMcpObservedCapture(changed), { code: 'METADATA_MISMATCH' });
});
