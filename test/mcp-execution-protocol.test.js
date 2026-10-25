import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { TOOLKIT_ROOT } from '../src/config.js';
import { prepareMcpServer, createMcpServerProject, mcpRuntimeConfig } from '../src/mcp-server.js';
import { planMcpProjectDiscovery, planMcpProjectProof } from '../src/mcp-discovery-project.js';
import { deploymentTarget, fingerprint, serviceResourceId } from '../src/apim-safety.js';
import { createExecutionProtocolAdapter } from '../src/mcp-execution-protocol.js';
import { observationTransport } from './support/mcp-observation.js';
import { selectMockAzureIdentity, mockAzureUser } from './support/azure-identity.js';
import { prepareDelegatedFixture, createDelegatedFixture } from '../src/mcp-delegated-fixture.js';

const save = (file, value) => writeFile(file, JSON.stringify(value));
const passthrough = '<policies><inbound /><backend><forward-request /></backend><outbound /></policies>';
async function setup(t, family = 'native', anonymous = false, delegated = false) {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected network'));
  const root = path.join(TOOLKIT_ROOT, '.test-output');
  await mkdir(root, { recursive: true });
  const workspaceRoot = await mkdtemp(path.join(root, 'execution-protocol-')), project = path.join(workspaceRoot, 'project');
  t.after(() => rm(workspaceRoot, { force: true, recursive: true }));
  const input = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples', 'mcp',
    family === 'native' ? 'catalog.json' : 'upstream-key.json')));
  if (anonymous) {
    const publicInput = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples', 'mcp', 'public-rates.json')));
    input.inbound = publicInput.inbound;
  }
  if (family === 'native') {
    input.backend.endpoint = 'https://jsonplaceholder.typicode.com';
    input.operationIds = ['getSamplePost'];
    input.document.paths = { '/posts/1': { get: { operationId: 'getSamplePost',
      description: 'Retrieve one public synthetic sample record.',
      responses: { 200: { description: 'One sample record' } } } } };
  }
  let delegatedReview, delegatedDirectory;
  if (delegated) {
    delegatedReview = prepareDelegatedFixture({ schemaVersion: 1, id: '99999999-9999-4999-8999-999999999999',
      azure: input.azure, inbound: input.inbound, expectedUserId: '77777777-7777-4777-8777-777777777777' });
    input.backend = { auth: 'entra', endpoint: delegatedReview.endpoint };
    input.document.paths = { [delegatedReview.path]: input.document.paths['/posts/1'] };
    delegatedDirectory = path.join(workspaceRoot, 'delegated-fixture');
    await createDelegatedFixture(delegatedReview.input, { output: delegatedDirectory, approval: delegatedReview.reviewDigest });
  }
  const review = await prepareMcpServer(input);
  await createMcpServerProject(review, { workspaceRoot, projectDir: project });
  await selectMockAzureIdentity(project, input.azure);
  const cfg = mcpRuntimeConfig(input), apiId = review.descriptor.ownership.apiId;
  const template = JSON.parse(review.files['infra/gateway.json']);
  const map = family === 'native' ? JSON.parse(review.files['infra/operation-map.json']).server[0] : null;
  const tool = { name: map?.displayName ?? 'read_records', description: map?.description ?? 'Read synthetic records',
    inputSchema: { additionalProperties: false, properties: {}, required: [], type: 'object' },
    ...(family === 'native' ? {} : { annotations: { readOnlyHint: true, destructiveHint: false } }) };
  const identity = anonymous ? {} : { discoveryClientId: input.inbound.allowedClientIds[0],
    expectedUserId: '77777777-7777-4777-8777-777777777777' };
  const transport = observationTransport(review.descriptor, identity, { tools: [tool] });
  await mkdir(path.join(project, '.mcp-lifecycle'));
  await save(path.join(project, '.mcp-lifecycle', '11111111-1111-4111-8111-111111111111.json'),
    { schemaVersion: 1, status: 'completed', phase: 'gateway', reviewDigest: review.reviewDigest });
  await save(path.join(project, 'infra', 'provisioning-receipt.json'), {
    target: deploymentTarget(cfg), apiIntents: family === 'native' ? [apiId, `${apiId}-rest`] : [apiId],
    preservation: { verified: true, globalPolicyHash: fingerprint(passthrough) },
    completedSteps: [{ phase: 'gateway', id: 'verify-owned-apis' }],
  });
  const outputs = new Map([['policies', { value: [{ properties: { value: passthrough } }] }], ['diagnostics', { value: [] }]]);
  for (const resource of template.resources) {
    const suffix = resource.name.split('/').slice(1);
    if (resource.type.endsWith('/apis')) {
      const properties = structuredClone(resource.properties);
      if (properties.type === 'mcp') properties.mcpProperties = { endpoints: null, federation: null, isFederationRouter: false };
      outputs.set(`apis/${suffix[0]}`, { id: `${serviceResourceId(cfg)}/apis/${suffix[0]}`, name: suffix[0], properties });
    } else if (resource.type.endsWith('/apis/policies')) {
      outputs.set(`apis/${suffix[0]}/policies/policy`, { properties: resource.properties });
    } else if (resource.type.endsWith('/apis/tools')) {
      const key = `apis/${suffix[0]}/tools/${suffix[1]}`;
      outputs.set(key, { id: `${serviceResourceId(cfg)}/${key}`, name: suffix[1],
        properties: { ...resource.properties, operationId: `${serviceResourceId(cfg)}${resource.properties.operationId}` } });
    }
  }
  for (const id of [apiId, `${apiId}-rest`]) outputs.set(`apis/${id}/diagnostics`, { value: [] });
  if (map) {
    const operationPath = `apis/${apiId}-rest/operations/${map.id}`;
    outputs.set(operationPath, { id: `${serviceResourceId(cfg)}/${operationPath}`, name: map.id,
      properties: { method: 'GET', urlTemplate: delegatedReview?.path ?? '/posts/1', templateParameters: [],
        request: { queryParameters: [], headers: [], representations: [] } } });
    outputs.set(`${operationPath}/policies`, { value: [] });
  }
  if (delegatedReview) {
    const prefix = `apis/${delegatedReview.apiId}`, activation = JSON.parse(delegatedReview.files['activation.json']);
    outputs.set(prefix, { id: delegatedReview.resourceId, name: delegatedReview.apiId, properties: activation.resources[0].properties });
    outputs.set(`${prefix}/policies/policy`, { properties: { value: delegatedReview.policy } });
    outputs.set(`${prefix}/diagnostics`, { value: [] });
    outputs.set(`${prefix}/operations`, { value: [{ id: `${delegatedReview.resourceId}/operations/${delegatedReview.operationId}`,
      name: delegatedReview.operationId, properties: activation.resources[1].properties }] });
    outputs.set(`${prefix}/operations/${delegatedReview.operationId}/policies`, { value: [] });
  }
  const azureCalls = [], order = [];
  const runAzure = async (command, args, options) => {
    assert.equal(command, 'az');
    assert.ok(options.azureConfigDir.startsWith(path.join(project, '.azure-auth')));
    assert.ok(options.signal);
    azureCalls.push(args);
    order.push('azure-read');
    if (args[0] === 'account') return { id: input.azure.subscriptionId, tenantId: input.azure.tenantId, user: mockAzureUser };
    assert.equal(args[0], 'rest');
    assert.equal(args[args.indexOf('--method') + 1], 'GET');
    const url = new URL(args[args.indexOf('--url') + 1]);
    assert.equal(url.hostname, 'management.azure.com');
    const suffix = url.pathname.slice(serviceResourceId(cfg).length + 1);
    assert.ok(outputs.has(suffix), suffix);
    return structuredClone(outputs.get(suffix));
  };
  const original = transport.mcpTransport;
  transport.mcpTransport = async (url, options) => {
    const rpc = JSON.parse(options.body);
    order.push(rpc.method);
    const response = await original(url, options);
    return delegatedReview && rpc.method === 'tools/call'
      ? new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [
        { type: 'text', text: JSON.stringify(delegatedReview.marker) },
      ] } })) : response;
  };
  const selectProof = capture => ({ capture, toolName: tool.name, arguments: {},
    safetyReview: { readOnly: true, reason: 'Owner reviewed retrieval of one public synthetic record.' },
    ...(delegatedReview ? { delegatedFixture: { path: delegatedDirectory, approval: delegatedReview.reviewDigest },
      responseAssertion: 'controlled-delegated-v1' } : {}) });
  const discovery = async adapter => adapter.mcpProjectOperation(project, {
    selection: identity, approval: await planMcpProjectDiscovery(project, identity), allowNetwork: true, onDeviceCode() {},
  }, false, () => { order.push('guard'); });
  const proof = async (adapter, capture) => {
    const selection = selectProof(capture), approval = await planMcpProjectProof(project, selection);
    return adapter.mcpProjectOperation(project, { selection, approval, allowNetwork: true,
      ...(approval.operation.nativeGetMapping ? { allowCloud: true } : {}), onDeviceCode() {} }, true,
    () => { order.push('guard'); });
  };
  const adapter = createExecutionProtocolAdapter({ ...transport, runAzure });
  t.after(adapter.close);
  return { project, transport, runAzure, adapter, discovery, proof, order, outputs, apiId, azureCalls, selectProof };
}

for (const family of ['native', 'proxy']) test(`${family} separate phases reuse one sign-in and preserve guarded proof dispatch`, async t => {
  const f = await setup(t, family);
  const capture = await f.discovery(f.adapter), result = await f.proof(f.adapter, capture.resultFile);
  assert.equal(result.result.status, 'protocol-success');
  assert.equal(f.transport.calls.filter(call => call.endsWith('/devicecode')).length, 1);
  assert.equal(f.transport.calls.filter(call => call.endsWith('/token')).length, 1);
  assert.equal(f.transport.calls.filter(call => call === 'tools/list').length, 2);
  assert.equal(f.transport.calls.filter(call => call === 'tools/call').length, 1);
  if (family === 'native') {
    assert.ok(result.result.nativeGetReadback);
    assert.ok(f.order.lastIndexOf('azure-read') < f.order.indexOf('tools/call'));
    assert.ok(f.azureCalls.length > 0);
  }
  const saved = await readFile(result.resultFile, 'utf8');
  assert.ok(!saved.includes('opaque-mocked-access-value'));
  assert.ok(!saved.includes('inert private fixture response'));
  const calls = f.transport.calls.length;
  await assert.rejects(f.proof(f.adapter, capture.resultFile));
  assert.equal(f.transport.calls.length, calls);
});

test('native mapping drift rejects the call without replacing the reused sign-in', async t => {
  const f = await setup(t), capture = await f.discovery(f.adapter);
  f.outputs.get(`apis/${f.apiId}/policies/policy`).properties.value = passthrough;
  await assert.rejects(f.proof(f.adapter, capture.resultFile), { code: 'APIM_PROOF_MAPPING_MISMATCH' });
  assert.equal(f.transport.calls.filter(call => call.endsWith('/token')).length, 1);
  assert.equal(f.transport.calls.includes('tools/call'), false);
});

test('a restarted proof-only adapter acquires once without rediscovery or fabricated reuse', async t => {
  const f = await setup(t, 'proxy'), capture = await f.discovery(f.adapter);
  f.adapter.close();
  const restarted = createExecutionProtocolAdapter({ ...f.transport, runAzure: f.runAzure });
  t.after(restarted.close);
  const result = await f.proof(restarted, capture.resultFile);
  assert.equal(result.result.status, 'protocol-success');
  assert.equal(f.transport.calls.filter(call => call.endsWith('/token')).length, 2);
  assert.equal(f.transport.calls.filter(call => call === 'tools/list').length, 2);
});

test('expiry, cancellation and binding drift terminate the adapter without restart', async t => {
  for (const mode of ['expired', 'cancelled', 'binding']) {
    const f = await setup(t, 'proxy'), controller = new AbortController();
    let time = Date.now();
    const adapter = createExecutionProtocolAdapter({ ...f.transport, now: () => time, signal: controller.signal });
    t.after(adapter.close);
    const capture = await f.discovery(adapter), count = f.transport.calls.length;
    if (mode === 'expired') time += 900000;
    if (mode === 'cancelled') controller.abort();
    if (mode === 'binding') {
      const selection = f.selectProof(capture.resultFile), approval = await planMcpProjectProof(f.project, selection);
      approval.operation.discoveryPlan.auth.expectedUserId = '66666666-6666-4666-8666-666666666666';
      await assert.rejects(adapter.mcpProjectOperation(f.project, { selection, approval, allowNetwork: true,
        onDeviceCode() {} }, true), { code: 'AUTH_CONFIG_INVALID' });
    } else await assert.rejects(f.proof(adapter, capture.resultFile));
    assert.equal(f.transport.calls.length, count);
    await assert.rejects(f.proof(adapter, capture.resultFile));
    assert.equal(f.transport.calls.length, count);
  }
});

test('anonymous native phases retain ARM verification without acquiring caller credentials', async t => {
  const f = await setup(t, 'native', true), capture = await f.discovery(f.adapter);
  const result = await f.proof(f.adapter, capture.resultFile);
  assert.equal(result.result.status, 'protocol-success');
  assert.ok(result.result.nativeGetReadback);
  assert.equal(f.transport.calls.some(call => call.endsWith('/token')), false);
});

test('unknown proxy call consumes proof and cannot restart the adapter or authenticate twice', async t => {
  const f = await setup(t, 'proxy'), original = f.transport.mcpTransport;
  const adapter = createExecutionProtocolAdapter({ ...f.transport, mcpTransport: (url, options) => {
    if (JSON.parse(options.body).method === 'tools/call') {
      f.transport.calls.push('tools/call');
      throw Error('Synthetic lost response');
    }
    return original(url, options);
  } });
  t.after(adapter.close);
  const capture = await f.discovery(adapter), result = await f.proof(adapter, capture.resultFile);
  assert.equal(result.result.status, 'unknown');
  assert.equal(f.transport.calls.filter(call => call.endsWith('/token')).length, 1);
  assert.equal(f.transport.calls.filter(call => call === 'tools/call').length, 1);
  await assert.rejects(f.proof(adapter, capture.resultFile));
  const restarted = createExecutionProtocolAdapter({ ...f.transport });
  t.after(restarted.close);
  await assert.rejects(f.proof(restarted, capture.resultFile));
  assert.equal(f.transport.calls.filter(call => call.endsWith('/token')).length, 1);
});

test('native ARM cancellation preserves no-dispatch and closes the reused token', async t => {
  const f = await setup(t), controller = new AbortController();
  const adapter = createExecutionProtocolAdapter({ ...f.transport, signal: controller.signal,
    runAzure: async (...args) => {
      const result = await f.runAzure(...args);
      controller.abort();
      return result;
    } });
  t.after(adapter.close);
  const capture = await f.discovery(adapter);
  await assert.rejects(f.proof(adapter, capture.resultFile));
  assert.equal(f.transport.calls.includes('tools/call'), false);
  assert.equal(f.transport.calls.filter(call => call.endsWith('/token')).length, 1);
});

test('native delegated response assertion and mapping readback survive one-sign-in reuse', async t => {
  const f = await setup(t, 'native', false, true), capture = await f.discovery(f.adapter);
  const result = await f.proof(f.adapter, capture.resultFile);
  assert.equal(result.result.status, 'protocol-success');
  assert.equal(result.result.backendAssertion.kind, 'controlled-delegated-v1');
  assert.equal(result.result.backendAssertion.status, 'passed');
  assert.ok(result.result.nativeGetReadback);
  assert.equal(f.transport.calls.filter(call => call.endsWith('/token')).length, 1);
});

test('factory does not start the session clock or acquire credentials before protocol discovery', async t => {
  const f = await setup(t, 'proxy');
  let clockReads = 0;
  const adapter = createExecutionProtocolAdapter({ ...f.transport,
    now: () => { clockReads++; return Date.now(); } });
  t.after(adapter.close);
  assert.equal(clockReads, 0);
  assert.equal(f.transport.calls.length, 0);
  await f.discovery(adapter);
  assert.ok(clockReads > 0);
  assert.equal(f.transport.calls.filter(call => call.endsWith('/token')).length, 1);
});
