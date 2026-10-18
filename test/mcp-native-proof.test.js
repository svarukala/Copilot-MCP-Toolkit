import test from 'node:test';

import assert from 'node:assert/strict';

import path from 'node:path';

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, cp, symlink } from 'node:fs/promises';

import { spawnSync } from 'node:child_process';

import { pathToFileURL } from 'node:url';

import { TOOLKIT_ROOT } from '../src/config.js';

import { prepareMcpServer, createMcpServerProject, mcpRuntimeConfig } from '../src/mcp-server.js';

import { discoverMcpToolsForTest, planMcpDiscovery, planMcpReadOnlyProof, runMcpProjectMappedProof } from '../src/mcp-discovery.js';

import { executeMcpProjectForTest, planMcpProjectProof } from '../src/mcp-discovery-project.js';

import { deploymentTarget, fingerprint, serviceResourceId } from '../src/apim-safety.js';

import { boundedSnapshot, metadataDigest } from '../src/anonymous-metadata.js';

import { observationTransport } from './support/mcp-observation.js';

import { selectMockAzureIdentity, mockAzureUser } from './support/azure-identity.js';

import { main } from '../bin/copilot-mcp.js';

import { probeMcp } from '../src/mcp-protocol.js';

import { nativeProofFailure, sanitizeNativeProofDiagnostics } from '../src/mcp-native-proof.js';

import { mappedOperationMatches, mappedSchemaReference, mappedLinkedSchemaMatches } from '../src/mcp-mapped-get.js';

import { planMcpProofPreflight, preflightMcpProof } from '../src/mcp-discovery-project.js';

import { readMcpStatus } from '../src/mcp-status.js';

import { planMcpPrerequisites, inspectMcpPrerequisites, planMcpIdentityPrerequisite } from '../src/mcp-prerequisites.js';

import { prepareDelegatedFixture, createDelegatedFixture } from '../src/mcp-delegated-fixture.js';

import { managedIdentityRequests } from '../src/apim-managed-identity.js';

import { planMcpAuthRejection, executeMcpAuthRejection, readMcpAuthRejections } from '../src/mcp-auth-rejection.js';

const baseline = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples', 'mcp', 'catalog.json'), 'utf8'));

const passthrough = '<policies><inbound /><backend><forward-request /></backend><outbound /></policies>';

const reason = 'I reviewed the fixed GET as retrieval of one public synthetic record with no side effects.';

const list = value => ({ value });

const save = (filename, value) => writeFile(filename, JSON.stringify(value));

const secretMetadataFixture = plan => ({ id: plan.keyVault.secretScope, name: 'backend-reference',
  type: 'Microsoft.KeyVault/vaults/secrets',
  properties: { secretUri: plan.keyVault.secretIdentifier, attributes: { enabled: true } } });

test('application identity cannot reuse the native delegated or anonymous unannotated proof exception', async t => {
  const example = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples', 'mcp', 'application-access.json'), 'utf8'));
  const f = await fixture(t, input => { input.backend = example.backend; });
  const before = f.calls.length;
  await assert.rejects(planMcpProjectProof(f.dir, f.selection), { code: 'READ_ONLY_REVIEW_REQUIRED' });
  await assert.rejects(planMcpProjectProof(f.dir, { ...f.selection, responseAssertion: 'controlled-delegated-v1' }));
  assert.equal(f.calls.length, before);
});

async function fixture(t, changeInput = () => {}, proofOptions = {}) {
  await mkdir(path.join(TOOLKIT_ROOT, '.test-output'), { recursive: true });
  const root = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'native-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = structuredClone(baseline);
  input.backend.endpoint = 'https://jsonplaceholder.typicode.com';
  input.operationIds = ['getSamplePost'];
  input.document.paths = { '/posts/1': { get: { operationId: 'getSamplePost',
    description: 'Retrieve only public synthetic sample post 1. No user-supplied URL, write methods or credentials.',
    responses: { 200: { description: 'One sample record' } } } } };
  changeInput(input);
  const review = await prepareMcpServer(input), dir = path.join(root, 'project');
  await createMcpServerProject(review, { workspaceRoot: root, projectDir: dir });
  await selectMockAzureIdentity(dir, input.azure);
  const cfg = mcpRuntimeConfig(input), apiId = review.descriptor.ownership.apiId;
  const template = JSON.parse(review.files['infra/gateway.json']);
  const map = JSON.parse(review.files['infra/operation-map.json']).server[0];
  const tool = { name: map.displayName, description: map.description,
    inputSchema: proofOptions.schema ?? { additionalProperties: false, properties: {}, required: [], type: 'object' } };
  const tools = { tools: [tool] };
  const identity = input.inbound.type === 'anonymous' ? {} : { discoveryClientId: input.inbound.allowedClientIds[0],
    expectedUserId: '77777777-7777-4777-8777-777777777777' };
  const dependencies = observationTransport(review.descriptor, identity, tools);
  const capture = await discoverMcpToolsForTest(review.descriptor, { ...identity,
    approval: planMcpDiscovery(review.descriptor, identity), allowNetwork: true, onDeviceCode() {} }, dependencies);
  const selection = { capture, toolName: tool.name, arguments: proofOptions.arguments ?? {}, safetyReview: { readOnly: true, reason },
    ...(proofOptions.responseAssertion ? { responseAssertion: proofOptions.responseAssertion } : {}) };
  // Synthetic deployment/readback fixtures only: no cloud commands are executed by these tests.
  const receipt = { target: deploymentTarget(cfg), apiIntents: [apiId, `${apiId}-rest`],
    preservation: { verified: true, globalPolicyHash: fingerprint(passthrough) },
    completedSteps: [{ phase: 'gateway', id: 'verify-owned-apis' }] };
  const history = { schemaVersion: 1, status: 'completed', phase: 'gateway', reviewDigest: review.reviewDigest };
  await mkdir(path.join(dir, '.mcp-lifecycle'));
  const historyFile = path.join(dir, '.mcp-lifecycle', '11111111-1111-4111-8111-111111111111.json');
  await save(historyFile, history);
  await save(path.join(dir, 'infra', 'provisioning-receipt.json'), receipt);
  const outputs = new Map([['policies', list([{ properties: { value: passthrough } }])], ['diagnostics', list([])]]);
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
  for (const id of [apiId, `${apiId}-rest`]) outputs.set(`apis/${id}/diagnostics`, list([]));
  const operationPath = `apis/${apiId}-rest/operations/${map.id}`, toolPath = `apis/${apiId}/tools/${map.resourceId}`;
  outputs.set(operationPath, { id: `${serviceResourceId(cfg)}/${operationPath}`, name: map.id,
    properties: { method: 'GET', urlTemplate: '/posts/1', templateParameters: [],
      request: { queryParameters: [], headers: [], representations: [] } } });
  outputs.set(`${operationPath}/policies`, list([]));
  const vaultId = `/subscriptions/${cfg.azure.subscriptionId}/resourceGroups/${cfg.azure.resourceGroup}/providers/Microsoft.KeyVault/vaults/${cfg.azure.keyVaultName}`;
  if (proofOptions.mappedKey) {
    outputs.get(operationPath).properties = { method: 'GET', urlTemplate: '/get-bill', templateParameters: [],
      request: { queryParameters: [{ name: 'bill_id', type: 'integer', required: true }], headers: [], representations: [] } };
    outputs.set('proof-service-identity', { id: serviceResourceId(cfg), sku: 'Developer', provisioningState: 'Succeeded',
      gatewayUrl: `https://${cfg.azure.apimName}.azure-api.net`, identity: { type: 'SystemAssigned',
      tenantId: cfg.azure.tenantId, principalId: '88888888-8888-4888-8888-888888888888' } });
    outputs.set('proof-key-reference', { id: `${serviceResourceId(cfg)}/namedValues/${apiId}-backend-key`, name: `${apiId}-backend-key`,
      properties: { displayName: `${apiId}-backend-key`, secret: true, keyVault: { secretIdentifier: input.backend.apiKey.secretIdentifier } } });
    outputs.set('proof-key-vault', { id: vaultId, properties: { tenantId: cfg.azure.tenantId, enableRbacAuthorization: true } });
  }
  const calls = [];
  const runAzure = async (command, args, options) => {
    assert.equal(command, 'az');
    assert.ok(options.azureConfigDir.startsWith(path.join(dir, '.azure-auth')));
    assert.ok(options.signal);
    calls.push(args);
    if (args[0] === 'account') return { id: input.azure.subscriptionId, tenantId: input.azure.tenantId, user: mockAzureUser };
    assert.equal(args[0], 'rest');
    assert.equal(args[args.indexOf('--method') + 1], 'GET');
    const url = new URL(args[args.indexOf('--url') + 1]);
    assert.equal(url.hostname, 'management.azure.com');
    const suffix = proofOptions.mappedKey && url.pathname === serviceResourceId(cfg) ? 'proof-service-identity'
      : proofOptions.mappedKey && url.pathname === vaultId ? 'proof-key-vault'
        : proofOptions.mappedKey && url.pathname === `${serviceResourceId(cfg)}/namedValues/${apiId}-backend-key` ? 'proof-key-reference'
          : url.pathname.slice(serviceResourceId(cfg).length + 1);
    assert.ok(url.pathname.startsWith(`${serviceResourceId(cfg)}/`) || proofOptions.mappedKey && [serviceResourceId(cfg), vaultId].includes(url.pathname));
    assert.ok(outputs.has(suffix), suffix);
    if (suffix.startsWith('proof-')) {
      assert.ok(args.includes('--query'));
      assert.doesNotMatch(args[args.indexOf('--query') + 1], /properties\.value|listValue/);
    }
    return proofOptions.mappedKey ? { stdout: JSON.stringify(outputs.get(suffix)), code: 0 } : structuredClone(outputs.get(suffix));
  };
  return { root, dir, input, cfg, review, map, tool, tools, identity, dependencies, selection, receipt,
    history, historyFile, outputs, calls, runAzure, apiId, operationPath, toolPath };
}

const execute = async (f, approval, overrides = {}, dependencies = f.dependencies, runAzure = f.runAzure) =>
  executeMcpProjectForTest(f.dir, { selection: f.selection, approval, allowNetwork: true, allowCloud: true,
    onDeviceCode() {}, ...overrides }, true, (source, options, guard, context) =>
    runMcpProjectMappedProof(source, options, context.mapping,
      { ...dependencies, beforeRequest: guard, beforeToolCall: context.beforeToolCall, beforeToolDispatch: context.beforeToolDispatch }), runAzure);

test('public native discovery and proof omit caller auth, retain private ARM readback and consume the single call', async t => {
  const input = JSON.parse(await readFile(new URL('../examples/mcp/public-rates.json', import.meta.url)));
  const f = await fixture(t, value => { value.inbound = input.inbound; });
  f.dependencies.authTransport = () => assert.fail('Anonymous MCP must not request an auth token');
  const transport = f.dependencies.mcpTransport;
  f.dependencies.mcpTransport = (url, options) => {
    assert.equal(new Headers(options.headers).has('Authorization'), false);
    return transport(url, options);
  };
  assert.equal(f.selection.capture.evidence, 'observed-discovery');
  assert.equal((await planMcpAuthRejection(f.dir)).status, 'not-applicable');
  const plan = await planMcpProjectProof(f.dir, f.selection);
  assert.equal(plan.operation.auth, undefined);
  assert.equal(plan.operation.nativeGetMapping.annotations, 'absent');
  assert.ok(plan.operation.nativeGetMapping.requests.length > 0);
  const result = await execute(f, plan);
  assert.equal(result.result.status, 'protocol-success');
  assert.equal(f.dependencies.calls.filter(method => method === 'tools/call').length, 1);
  assert.ok(f.calls.some(args => args[0] === 'account'));
  await assert.rejects(execute(f, plan), { code: 'PROOF_REPLAY_BLOCKED' });
});

test('public native proof refuses changed throttle policy before dispatch', async t => {
  const input = JSON.parse(await readFile(new URL('../examples/mcp/public-rates.json', import.meta.url)));
  const f = await fixture(t, value => { value.inbound = input.inbound; });
  f.outputs.get(`apis/${f.apiId}/policies/policy`).properties.value =
    f.outputs.get(`apis/${f.apiId}/policies/policy`).properties.value.replace('calls="60"', 'calls="10000"');
  await assert.rejects(execute(f, await planMcpProjectProof(f.dir, f.selection)), { code: 'APIM_PROOF_MAPPING_MISMATCH' });
  assert.equal(f.dependencies.calls.filter(method => method === 'tools/call').length, 0);
});

async function delegatedFixture(t) {
  let reviewed;
  const f = await fixture(t, input => {
    input.azure.apimMode = 'existing';
    reviewed = prepareDelegatedFixture({ schemaVersion: 1, id: '99999999-9999-4999-8999-999999999999',
      azure: input.azure, inbound: input.inbound, expectedUserId: '77777777-7777-4777-8777-777777777777' });
    input.backend = { auth: 'entra', endpoint: reviewed.endpoint };
    input.document.paths = { [reviewed.path]: input.document.paths['/posts/1'] };
  });
  const directory = path.join(f.root, 'fixture');
  await createDelegatedFixture(reviewed.input, { output: directory, approval: reviewed.reviewDigest });
  f.selection.delegatedFixture = { path: directory, approval: reviewed.reviewDigest };
  f.selection.responseAssertion = 'controlled-delegated-v1';
  f.outputs.get(f.operationPath).properties.urlTemplate = reviewed.path;
  const prefix = `apis/${reviewed.apiId}`, activation = JSON.parse(reviewed.files['activation.json']);
  f.outputs.set(prefix, { id: reviewed.resourceId, name: reviewed.apiId, properties: activation.resources[0].properties });
  f.outputs.set(`${prefix}/policies/policy`, { properties: { value: reviewed.policy } });
  f.outputs.set(`${prefix}/diagnostics`, list([]));
  f.outputs.set(`${prefix}/operations`, list([{ id: `${reviewed.resourceId}/operations/${reviewed.operationId}`,
    name: reviewed.operationId, properties: activation.resources[1].properties }]));
  f.outputs.set(`${prefix}/operations/${reviewed.operationId}/policies`, list([]));
  const run = f.runAzure;
  f.runAzure = async (...args) => ({ code: 0, stdout: JSON.stringify(await run(...args)) });
  return { ...f, reviewed, directory, prefix };
}

async function graphFixture(t) {
  const definition = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples', 'mcp', 'graph-organization.json'), 'utf8'));
  const f = await fixture(t, input => Object.assign(input, definition), { responseAssertion: 'graph-organization-v1' });
  f.outputs.get(f.operationPath).properties.urlTemplate = '/organization-check';
  const mi = f.input.backend.managedIdentity;
  const graphOutputs = new Map([
    ['backend-principal', { id: mi.principalId, appId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', servicePrincipalType: 'ManagedIdentity', accountEnabled: true }],
    ['backend-application', { id: mi.servicePrincipalId, appId: mi.resource, accountEnabled: true, servicePrincipalType: 'Application',
      appOwnerOrganizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      appRoles: [{ id: mi.appRoleId, value: mi.appRole, isEnabled: true, allowedMemberTypes: ['Application'] }] }],
    ['backend-assignment', list([{ principalId: mi.principalId, principalType: 'ServicePrincipal', resourceId: mi.servicePrincipalId, appRoleId: mi.appRoleId }])],
    ['service', { id: serviceResourceId(f.cfg), sku: 'Developer', provisioningState: 'Succeeded', gatewayUrl: `https://${f.cfg.azure.apimName}.azure-api.net`,
      identity: { type: 'SystemAssigned', principalId: mi.principalId, tenantId: f.cfg.azure.tenantId } }],
  ]);
  const run = f.runAzure;
  f.runAzure = async (command, args, options) => {
    const url = args[args.indexOf('--url') + 1];
    const request = managedIdentityRequests(f.cfg.connectors[0]).find(item => item.url === url);
    const key = request?.kind ?? (url === `https://management.azure.com${serviceResourceId(f.cfg)}?api-version=2024-05-01` ? 'service' : undefined);
    if (!key) return run(command, args, options);
    assert.equal(command, 'az'); assert.ok(args.includes('GET'));
    assert.ok(options.signal); assert.ok(options.azureConfigDir.startsWith(path.join(f.dir, '.azure-auth')));
    if (request) assert.equal(args[args.indexOf('--query') + 1], request.query);
    f.calls.push(args);
    return { code: 0, stdout: JSON.stringify(graphOutputs.get(key)) };
  };
  return { ...f, graphOutputs };
}

test('standalone auth rejection sends only four fixed unauthenticated requests and retains status-only evidence', async t => {
  const f = await graphFixture(t), plan = await planMcpAuthRejection(f.dir), requests = [];
  const before = await readFile(path.join(f.dir, 'mcp-server.json'));
  const result = await executeMcpAuthRejection(f.dir, { approval: plan.approvalDigest, allowNetwork: true }, {
    transport: async (url, options) => {
      requests.push([url, options]);
      assert.equal(options.redirect, 'error');
      assert.equal(new URL(url).hostname, `${f.input.azure.apimName}.azure-api.net`);
      if (options.body) assert.equal(JSON.parse(options.body).method, 'initialize');
      return new Response('PRIVATE_RESPONSE_NEVER_RETAIN', { status: 401, headers: { secret: 'PRIVATE_HEADER' } });
    },
  });
  assert.equal(result.status, 'passed');
  assert.deepEqual(requests.map(([, x]) => x.method), ['POST', 'POST', 'GET', 'GET']);
  assert.deepEqual(requests.map(([, x]) => x.headers.Authorization), [undefined, 'Bearer invalid-non-jwt', undefined, 'Bearer invalid-non-jwt']);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readFile(path.join(f.dir, 'mcp-server.json')), before);
  const history = await readMcpAuthRejections(f.dir);
  assert.equal(history.attempts[0].cases.length, 4);
  assert.equal((await readMcpStatus(f.dir)).authRejections.attempts[0].status, 'passed');
  for (const name of await readdir(result.outputDir)) assert.doesNotMatch(await readFile(path.join(result.outputDir, name), 'utf8'),
    /PRIVATE_RESPONSE|PRIVATE_HEADER|invalid-non-jwt|opaque-mocked-access-value/);
  await assert.rejects(executeMcpAuthRejection(f.dir, { approval: plan.approvalDigest, allowNetwork: true }), { code: 'AUTH_REJECTION_BLOCKED' });
});

test('standalone auth rejection never passes non-401, transport, oversized or incomplete responses', async t => {
  for (const variant of [200, 302, 403, 429, 500, 'transport', 'oversize', 'cancel']) await t.test(String(variant), async t => {
    const f = await graphFixture(t), plan = await planMcpAuthRejection(f.dir), controller = new AbortController();
    let calls = 0;
    const result = await executeMcpAuthRejection(f.dir, { approval: plan.approvalDigest, allowNetwork: true, signal: controller.signal }, {
      transport: async () => {
        calls++;
        if (variant === 'transport') throw Error('PRIVATE_PROVIDER_FAILURE');
        if (variant === 'cancel') { controller.abort(); throw Error('PRIVATE_CANCEL'); }
        return new Response(variant === 'oversize' ? 'x'.repeat(16385) : '', { status: typeof variant === 'number' ? variant : 401 });
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.status, [200, 302, 403].includes(variant) ? 'failed' : 'inconclusive');
    assert.equal((await planMcpAuthRejection(f.dir)).status, 'blocked-prior-attempt');
    for (const name of await readdir(result.outputDir)) assert.doesNotMatch(await readFile(path.join(result.outputDir, name), 'utf8'), /PRIVATE_/);
  });
});

test('standalone auth rejection timeout is bounded and cannot authorize a retry', async t => {
  const f = await graphFixture(t), plan = await planMcpAuthRejection(f.dir);
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = executeMcpAuthRejection(f.dir, { approval: plan.approvalDigest, allowNetwork: true }, {
    transport: () => { entered(); return new Promise(() => {}); },
  });
  await ready;
  t.mock.timers.tick(10001);
  const result = await pending;
  assert.equal(result.status, 'inconclusive');
  assert.equal((await readMcpAuthRejections(f.dir)).attempts[0].cases[0].cause, 'timeout');
});

test('standalone auth rejection reports anonymous references as not applicable and refuses broader routes', async t => {
  const f = await fixture(t);
  const review = await prepareMcpServer({ schemaVersion: 1, kind: 'existing-mcp', server: f.input.server,
    endpoint: 'https://learn.microsoft.com/api/mcp', inbound: { type: 'anonymous' } });
  const dir = path.join(f.root, 'anonymous-reference');
  await createMcpServerProject(review, { workspaceRoot: f.root, projectDir: dir });
  assert.equal((await planMcpAuthRejection(dir)).status, 'not-applicable');
  await assert.rejects(executeMcpAuthRejection(dir, { allowNetwork: true }), { code: 'AUTH_REJECTION_BLOCKED' });
  const input = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples', 'mcp', 'graph-organization.json'), 'utf8'));
  input.document.paths['/nested/check'] = input.document.paths['/organization-check'];
  delete input.document.paths['/organization-check'];
  const nested = await fixture(t, x => Object.assign(x, input));
  await assert.rejects(planMcpAuthRejection(nested.dir), { code: 'AUTH_REJECTION_UNSUPPORTED' });
});

test('standalone auth rejection refuses cancellation before dispatch and symlinked history', async t => {
  const f = await graphFixture(t), plan = await planMcpAuthRejection(f.dir), controller = new AbortController();
  controller.abort();
  await assert.rejects(executeMcpAuthRejection(f.dir, { approval: plan.approvalDigest, allowNetwork: true, signal: controller.signal },
    { transport: () => assert.fail('No cancelled request') }), { code: 'ABORTED' });
  assert.equal((await readMcpAuthRejections(f.dir)).attempts.length, 0);
  const target = path.join(f.root, 'other-history');
  await mkdir(target);
  await symlink(target, path.join(f.dir, '.mcp-auth-rejections'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(planMcpAuthRejection(f.dir), /[Ss]ymlink|junction/);
});

test('standalone auth rejection refuses stale approvals, active network locks, unsafe routes and tampered journals', async t => {
  const f = await graphFixture(t), plan = await planMcpAuthRejection(f.dir);
  const never = { transport: () => assert.fail('No request authorized') };
  await assert.rejects(executeMcpAuthRejection(f.dir, { approval: plan.approvalDigest, allowNetwork: true, headers: {} }, never), { code: 'INVALID_CONFIG' });
  await assert.rejects(executeMcpAuthRejection(f.dir, { approval: 'stale', allowNetwork: true }, never), { code: 'APPROVAL_REQUIRED' });
  await assert.rejects(executeMcpAuthRejection(f.dir, { approval: plan.approvalDigest }, never), { code: 'APPROVAL_REQUIRED' });
  await writeFile(path.join(f.dir, '.mcp-network.lock'), 'existing-owner');
  await assert.rejects(executeMcpAuthRejection(f.dir, { approval: plan.approvalDigest, allowNetwork: true }, never), { code: 'MCP_NETWORK_LOCKED' });
  assert.equal(await readFile(path.join(f.dir, '.mcp-network.lock'), 'utf8'), 'existing-owner');
  await rm(path.join(f.dir, '.mcp-network.lock'));
  f.receipt.extraReview = 'changed';
  await save(path.join(f.dir, 'infra', 'provisioning-receipt.json'), f.receipt);
  await assert.rejects(executeMcpAuthRejection(f.dir, { approval: plan.approvalDigest, allowNetwork: true }, never), { code: 'APPROVAL_REQUIRED' });
  const current = await planMcpAuthRejection(f.dir);
  const result = await executeMcpAuthRejection(f.dir, { approval: current.approvalDigest, allowNetwork: true }, {
    transport: async () => new Response('', { status: 401 }),
  });
  const file = path.join(result.outputDir, 'case-0.json'), { receiptDigest, ...record } = JSON.parse(await readFile(file, 'utf8'));
  record.providerBody = 'PRIVATE';
  await save(file, { ...record, receiptDigest: metadataDigest(boundedSnapshot(record)) });
  await assert.rejects(readMcpAuthRejections(f.dir), { code: 'METADATA_MISMATCH' });
  const other = await fixture(t);
  await assert.rejects(planMcpAuthRejection(other.dir), { code: 'AUTH_REJECTION_UNSUPPORTED' });
});

test('standalone auth rejection excludes concurrent proof and retains interrupted local drift as inconclusive', async t => {
  const f = await graphFixture(t), plan = await planMcpAuthRejection(f.dir), proof = await planMcpProjectProof(f.dir, f.selection);
  let calls = 0;
  await assert.rejects(executeMcpAuthRejection(f.dir, { approval: plan.approvalDigest, allowNetwork: true }, {
    transport: async () => {
      calls++;
      await assert.rejects(execute(f, proof), { code: 'EEXIST' });
      f.receipt.localChange = true;
      await save(path.join(f.dir, 'infra', 'provisioning-receipt.json'), f.receipt);
      return new Response('', { status: 401 });
    },
  }), { code: 'METADATA_MISMATCH' });
  assert.equal(calls, 1);
  assert.equal((await readMcpAuthRejections(f.dir)).attempts[0].status, 'inconclusive');
  assert.equal((await planMcpAuthRejection(f.dir)).status, 'blocked-prior-attempt');
  assert.equal(f.dependencies.calls.includes('tools/call'), false);
});

test('new proof failures retain only validated diagnostic fields and unknown fields block recovery', async t => {
  const f = await fixture(t), plan = await planMcpProjectProof(f.dir, f.selection);
  const transport = { ...f.dependencies, authTransport: (url, options) => {
    if (new URL(url).pathname.endsWith('/token')) throw Error('PRIVATE_TOKEN_TRANSPORT');
    return f.dependencies.authTransport(url, options);
  } };
  await assert.rejects(execute(f, plan, {}, transport), { code: 'AUTHENTICATION_FAILED' });
  const [name] = await readdir(path.join(f.dir, '.mcp-observations'));
  const filename = path.join(f.dir, '.mcp-observations', name, 'failure.json');
  const original = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(original.schemaVersion, 3);
  assert.deepEqual(original.diagnostics, { authStage: 'token', failureKind: 'transport' });
  const fresh = await planMcpProjectProof(f.dir, f.selection);
  assert.equal(fresh.proofHistory.attempts[0].status, 'not-dispatched');
  assert.match(fresh.proofHistory.attempts[0].next, /does not establish consent or permission denial/);
  assert.doesNotMatch(JSON.stringify(fresh), /PRIVATE_TOKEN/);
  for (const signed of [false, true]) {
    const { failureDigest, ...body } = structuredClone(original);
    body.diagnostics.providerBody = 'PRIVATE_RESPONSE';
    await save(filename, { ...body, failureDigest: signed ? metadataDigest(boundedSnapshot(body)) : failureDigest });
    const blocked = await planMcpProjectProof(f.dir, f.selection);
    assert.equal(blocked.proofHistory.attempts[0].status, 'unresolved');
    assert.equal(blocked.proofHistory.attempts[0].diagnostics, undefined);
    await assert.rejects(execute(f, blocked), { code: 'PROOF_OUTCOME_UNRESOLVED' });
  }
  const { failureDigest, diagnostics, ...legacy } = original;
  legacy.schemaVersion = 2;
  await save(filename, { ...legacy, failureDigest: metadataDigest(boundedSnapshot(legacy)) });
  assert.equal((await planMcpProjectProof(f.dir, f.selection)).proofHistory.attempts[0].status, 'not-dispatched');
});

test('Graph organization proof binds fixed MI route, fresh directory metadata and verdict-only response', async t => {
  const f = await graphFixture(t), plan = await planMcpProjectProof(f.dir, f.selection);
  const mapping = plan.operation.nativeGetMapping;
  assert.equal(mapping.kind, 'native-apim-graph-organization-get');
  assert.equal(mapping.targetUrl, `https://graph.microsoft.com/v1.0/organization/${f.input.azure.tenantId}?$select=id`);
  assert.equal(mapping.requests.length, 15);
  assert.equal(mapping.applicationClaimsAttested, false);
  assert.throws(() => planMcpReadOnlyProof(f.review.descriptor, f.selection), { code: 'INVALID_CONFIG' });
  const preflight = await planMcpProofPreflight(f.dir, f.selection), before = [...f.dependencies.calls];
  await preflightMcpProof(f.dir, f.selection, { approval: preflight.approvalDigest, allowCloud: true, runAzure: f.runAzure });
  assert.deepEqual(f.dependencies.calls, before);
  const body = { id: f.input.azure.tenantId, '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#organization(id)/$entity' };
  const result = await execute(f, plan, {}, billTransport(f, { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body }));
  assert.equal(result.result.status, 'protocol-success');
  assert.deepEqual(result.result.backendAssertion, { kind: 'graph-organization-v1', status: 'passed' });
  assert.equal((await readMcpStatus(f.dir)).proofs[0].backendAssertion.kind, 'graph-organization-v1');
  const persisted = (await Promise.all((await readdir(result.outputDir)).map(file => readFile(path.join(result.outputDir, file), 'utf8')))).join('');
  assert.doesNotMatch(persisted, /@odata.context|opaque-mocked-access-value|mock@invalid|appOwnerOrganizationId/);
  await assert.rejects(execute(f, plan), { code: 'PROOF_REPLAY_BLOCKED' });
});

test('Graph profile rejects any broader local route, permission, host, inputs or delegated assertion', async t => {
  const example = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples', 'mcp', 'graph-organization.json'), 'utf8'));
  for (const change of [
    x => { x.backend.endpoint = 'https://graph.microsoft.com.attacker.example'; },
    x => { x.backend.endpoint += '/v1.0'; },
    x => { x.backend.managedIdentity.resource = x.inbound.clientId; },
    x => { x.backend.managedIdentity.appRoleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; },
    x => { x.backend.managedIdentity.appRole = 'Directory.Read.All'; },
    x => { x.document.paths['/organization-check'].get['x-cowork-backend'].path = '/v1.0/organization/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; },
    x => { x.document.paths['/organization-check'].get['x-cowork-backend'].query.$select = 'displayName'; },
    x => { x.document.paths['/organization-check'].get['x-cowork-backend'].query.$expand = 'extensions'; },
    x => { x.document.paths['/organization-check'].get.parameters = [{ in: 'query', name: 'select', schema: { type: 'string' } }]; },
    x => { x.document.paths['/organization-check'].post = x.document.paths['/organization-check'].get; delete x.document.paths['/organization-check'].get; },
  ]) {
    const input = structuredClone(example); change(input);
    await assert.rejects(prepareMcpServer(input));
  }
  const f = await graphFixture(t);
  for (const selection of [{ ...f.selection, responseAssertion: undefined }, { ...f.selection, responseAssertion: 'controlled-delegated-v1' },
    { ...f.selection, arguments: { id: f.input.azure.tenantId } }, { ...f.selection, delegatedFixture: { path: '..', approval: 'wrong' } }]) {
    await assert.rejects(planMcpProjectProof(f.dir, selection));
  }
  assert.equal(f.calls.length, 0);
});

test('Graph proof accepts only the documented singleton metadata variants', async t => {
  for (const context of [undefined, 'https://graph.microsoft.com/v1.0/$metadata#organization/$entity']) await t.test(context ?? 'no context', async t => {
    const f = await graphFixture(t), plan = await planMcpProjectProof(f.dir, f.selection);
    const body = { id: f.input.azure.tenantId, ...(context ? { '@odata.context': context } : {}) };
    const result = await execute(f, plan, {}, billTransport(f, { content: [], structuredContent: body }));
    assert.equal(result.result.backendAssertion.status, 'passed');
  });
});

test('Graph execution refuses fresh directory drift or denied metadata after re-list without dispatch', async t => {
  for (const denied of [false, true]) await t.test(denied ? 'directory denied' : 'assignment revoked after discovery', async t => {
    const f = await graphFixture(t), plan = await planMcpProjectProof(f.dir, f.selection);
    const original = f.runAzure;
    if (denied) f.runAzure = (command, args, options) => args.includes('rest')
      && args[args.indexOf('--url') + 1].startsWith('https://graph.microsoft.com/')
      ? { code: 1, stderr: 'Authorization_RequestDenied PRIVATE_DIRECTORY_ERROR' } : original(command, args, options);
    else f.graphOutputs.get('backend-assignment').value = [];
    const before = f.dependencies.calls.filter(call => call === 'tools/list').length;
    await assert.rejects(execute(f, plan));
    assert.equal(f.dependencies.calls.filter(call => call === 'tools/list').length, before + 1);
    assert.equal(f.dependencies.calls.includes('tools/call'), false);
    const observations = path.join(f.dir, '.mcp-observations');
    for (const directory of await readdir(observations)) {
      const files = await readdir(path.join(observations, directory));
      assert.equal(files.includes('dispatch.json'), false);
      for (const file of files) assert.doesNotMatch(await readFile(path.join(observations, directory, file), 'utf8'),
        /PRIVATE_DIRECTORY_ERROR|opaque-mocked-access-value/);
    }
  });
});

test('Graph fresh readback rejects MI/Graph-role and exact routing/auth/preservation drift before dispatch', async t => {
  const f = await graphFixture(t), plan = await planMcpProofPreflight(f.dir, f.selection);
  const originals = structuredClone(f.outputs), identities = structuredClone(f.graphOutputs);
  const restPolicy = `apis/${f.apiId}-rest/policies/policy`;
  for (const [label, mutate] of [
    ['wrong system principal', () => { f.graphOutputs.get('service').identity.principalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; }],
    ['wrong MI tenant', () => { f.graphOutputs.get('service').identity.tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; }],
    ['wrong Graph SP', () => { f.graphOutputs.get('backend-application').id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; }],
    ['wrong Graph audience', () => { f.graphOutputs.get('backend-application').appId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; }],
    ['disabled role', () => { f.graphOutputs.get('backend-application').appRoles[0].isEnabled = false; }],
    ['delegated only', () => { f.graphOutputs.get('backend-application').appRoles[0].allowedMemberTypes = ['User']; }],
    ['missing assignment', () => { f.graphOutputs.get('backend-assignment').value = []; }],
    ['wrong assignment', () => { f.graphOutputs.get('backend-assignment').value[0].appRoleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; }],
    ['partial assignments', () => { f.graphOutputs.get('backend-assignment').nextLink = 'https://graph.microsoft.com/other'; }],
    ['wrong backend', () => { f.outputs.get(`apis/${f.apiId}-rest`).properties.serviceUrl = 'https://other.example'; }],
    ['owner drift', () => { f.outputs.get(`apis/${f.apiId}-rest`).properties.description = 'foreign'; }],
    ['query widening', () => { f.outputs.get(restPolicy).properties.value = f.outputs.get(restPolicy).properties.value.replace('?$select=id', '?$select=displayName'); }],
    ['query passthrough', () => { f.outputs.get(restPolicy).properties.value = f.outputs.get(restPolicy).properties.value.replace('copy-unmatched-params="false"', 'copy-unmatched-params="true"'); }],
    ['removed MI', () => { f.outputs.get(restPolicy).properties.value = f.outputs.get(restPolicy).properties.value.replace(/<authentication-managed-identity[^>]+\/>/, ''); }],
    ['fail open MI', () => { f.outputs.get(restPolicy).properties.value = f.outputs.get(restPolicy).properties.value.replace('ignore-error="false"', 'ignore-error="true"'); }],
    ['removed caller scp', () => { f.outputs.get(restPolicy).properties.value = f.outputs.get(restPolicy).properties.value.replace(/<required-claims>.*?<\/required-claims>/, ''); }],
    ['operation query', () => { f.outputs.get(f.operationPath).properties.request.queryParameters.push({ name: '$select' }); }],
    ['wrong operation', () => { f.outputs.get(f.operationPath).properties.method = 'POST'; }],
    ['unsafe logging', () => { f.outputs.get('diagnostics').value.push({ properties: { backend: { request: { headers: ['Authorization'] } } } }); }],
  ]) await t.test(label, async () => {
    f.outputs.clear(); for (const [key, value] of structuredClone(originals)) f.outputs.set(key, value);
    f.graphOutputs.clear(); for (const [key, value] of structuredClone(identities)) f.graphOutputs.set(key, value);
    mutate();
    await assert.rejects(preflightMcpProof(f.dir, f.selection, { approval: plan.approvalDigest, allowCloud: true, runAzure: f.runAzure }));
    assert.equal(f.dependencies.calls.includes('tools/call'), false);
  });
});

test('Graph response assertion rejects wrong IDs, extra data, error/collection/conflicting envelopes and consumes the call', async t => {
  for (const variant of ['wrong-id', 'extra-property', 'collection', 'wrong-context', 'error', 'conflict', 'oversized']) await t.test(variant, async t => {
    const f = await graphFixture(t), plan = await planMcpProjectProof(f.dir, f.selection);
    let body = { id: f.input.azure.tenantId }, reply;
    if (variant === 'wrong-id') body.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    if (variant === 'extra-property') body.displayName = 'PRIVATE_RESPONSE_MUST_NOT_PERSIST';
    if (variant === 'collection') body = { value: [body] };
    if (variant === 'wrong-context') body['@odata.context'] = 'https://other.example/$metadata';
    if (variant === 'oversized') body['@odata.context'] = 'x'.repeat(4097);
    reply = { content: [{ type: 'text', text: JSON.stringify(body) }],
      ...(variant === 'error' ? { isError: true } : {}),
      ...(variant === 'conflict' ? { structuredContent: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } } : {}) };
    const result = await execute(f, plan, {}, billTransport(f, reply));
    assert.equal(result.result.backendAssertion.status, 'failed');
    const bytes = (await Promise.all((await readdir(result.outputDir)).map(file => readFile(path.join(result.outputDir, file), 'utf8')))).join('');
    assert.doesNotMatch(bytes, /PRIVATE_RESPONSE_MUST_NOT_PERSIST|@odata.context|opaque-mocked-access-value/);
    await assert.rejects(execute(f, plan), { code: 'PROOF_REPLAY_BLOCKED' });
  });
});

test('Graph lost response remains unknown and never authorizes another dispatch', async t => {
  const f = await graphFixture(t), plan = await planMcpProjectProof(f.dir, f.selection);
  let sent = 0;
  const transport = { ...f.dependencies, mcpTransport: async (url, options) => {
    if (JSON.parse(options.body).method === 'tools/call') { sent++; throw Error('private-lost-response'); }
    return f.dependencies.mcpTransport(url, options);
  } };
  const result = await execute(f, plan, {}, transport);
  assert.equal(result.result.status, 'unknown'); assert.equal(sent, 1);
  f.selection = { ...f.selection, safetyReview: { readOnly: true, reason: 'Another reviewed organization lookup.' } };
  await assert.rejects(execute(f, await planMcpProjectProof(f.dir, f.selection), {}, transport), { code: 'PROOF_OUTCOME_UNRESOLVED' });
  assert.equal(sent, 1);
});

for (const literalQuotes of [false, true]) test(`controlled delegated fixture proof verifies fresh ARM and only retains a verdict (${literalQuotes ? 'literal' : 'encoded'} body quotes)`, async t => {
  const f = await delegatedFixture(t), plan = await planMcpProjectProof(f.dir, f.selection);
  assert.equal(f.reviewed.reviewDigest, 'sha256:8bacd38b29a593d32f3aa5c72a1b78914cc6d4985c692946e4f493fed371735f');
  assert.equal(metadataDigest(f.reviewed.files), 'sha256:b2c96ace3ffc9112ab1eb2646ed63cfe589dba05eda81860c002ffad0ae6cc74');
  if (literalQuotes) {
    f.outputs.get(`${f.prefix}/policies/policy`).properties.value =
      f.reviewed.policy.replace(/<set-body>.*?<\/set-body>/, body => body.replaceAll('&quot;', '"'));
  }
  assert.deepEqual(await planMcpProjectProof(f.dir, f.selection), plan);
  for (const [name, contents] of Object.entries(f.reviewed.files)) {
    assert.equal(await readFile(path.join(f.directory, name), 'utf8'), contents);
  }
  assert.equal(plan.operation.nativeGetMapping.targetUrl, `${f.reviewed.endpoint}${f.reviewed.path}`);
  assert.equal(plan.operation.nativeGetMapping.kind, 'native-apim-controlled-delegated-get');
  assert.equal(plan.operation.nativeGetMapping.requests.length, 16);
  assert.throws(() => planMcpReadOnlyProof(f.review.descriptor, f.selection), { code: 'INVALID_CONFIG' });
  const preflight = await planMcpProofPreflight(f.dir, f.selection);
  const before = [...f.dependencies.calls];
  await preflightMcpProof(f.dir, f.selection, { approval: preflight.approvalDigest, allowCloud: true, runAzure: f.runAzure });
  assert.deepEqual(f.dependencies.calls, before);
  const result = await execute(f, plan, {}, billTransport(f, { content: [{ type: 'text', text: JSON.stringify(f.reviewed.marker) }] }));
  assert.deepEqual(result.result.backendAssertion, { kind: 'controlled-delegated-v1', status: 'passed' });
  assert.equal((await readMcpStatus(f.dir)).proofs[0].backendAssertion.status, 'passed');
  const files = await readdir(result.outputDir);
  const bytes = (await Promise.all(files.map(file => readFile(path.join(result.outputDir, file), 'utf8')))).join('');
  assert.doesNotMatch(bytes, /opaque-mocked-access-value|mock@invalid|"accepted":true/);
  await assert.rejects(execute(f, plan), { code: 'PROOF_REPLAY_BLOCKED' });
});

test('controlled delegated literal-quote compatibility rejects all marker and surrounding policy drift', async t => {
  const f = await delegatedFixture(t), plan = await planMcpProofPreflight(f.dir, f.selection);
  const literal = f.reviewed.policy.replace(/<set-body>.*?<\/set-body>/, body => body.replaceAll('&quot;', '"'));
  const marker = /<set-body>(.*?)<\/set-body>/.exec(literal)[1];
  const replaceMarker = change => literal.replace(marker, JSON.stringify(change(JSON.parse(marker))));
  const policies = [
    ['extra marker field', replaceMarker(value => ({ ...value, extra: true }))],
    ['accepted false', replaceMarker(value => ({ ...value, accepted: false }))],
    ['wrong marker kind', replaceMarker(value => ({ ...value, kind: 'different' }))],
    ['wrong fixture digest', replaceMarker(value => ({ ...value, fixtureDigest: `sha256:${'0'.repeat(64)}` }))],
    ['marker text whitespace', literal.replace(marker, ` ${marker}`)],
    ['marker key order', literal.replace(marker, JSON.stringify(f.reviewed.marker))],
    ['removed oid', literal.replace(/<claim name="oid"[\s\S]*?<\/claim>/, '')],
    ['removed scp', literal.replace(/<claim name="scp"[\s\S]*?<\/claim>/, '')],
    ['claim whitespace drift', literal.replace('<value>access_as_user</value>', '<value> access_as_user</value>')],
    ['validation header drift', literal.replace('header-name="Authorization"', 'header-name="X-Authorization"')],
    ['return status drift', literal.replace('code="200"', 'code="201"')],
    ['expression quotes decoded', literal.replaceAll('&quot;', '"')],
    ['different quote entity', literal.replace(marker, marker.replaceAll('"', '&#34;'))],
    ['duplicate body', literal.replace('</set-body>', `</set-body><set-body>${marker}</set-body>`)],
  ];
  const before = [...f.dependencies.calls];
  for (const [name, value] of policies) await t.test(name, async () => {
    assert.notEqual(value, literal);
    f.outputs.get(`${f.prefix}/policies/policy`).properties.value = value;
    await assert.rejects(preflightMcpProof(f.dir, f.selection, {
      approval: plan.approvalDigest, allowCloud: true, runAzure: f.runAzure,
    }), { code: 'APIM_PROOF_MAPPING_MISMATCH', diagnostics: {
      proofStage: 'mapping-check', resource: 'delegated-fixture', predicate: 'policy',
      failureKind: 'mismatch', causeCode: 'APIM_PROOF_MAPPING_MISMATCH',
    } });
  });
  assert.deepEqual(f.dependencies.calls, before);
  await assert.rejects(readdir(path.join(f.dir, '.mcp-observations')), { code: 'ENOENT' });
  await assert.rejects(execute(f, plan.proof), { code: 'APIM_PROOF_MAPPING_MISMATCH' });
  assert.equal(f.dependencies.calls.includes('tools/call'), false);
  for (const dir of await readdir(path.join(f.dir, '.mcp-observations'))) {
    await assert.rejects(readFile(path.join(f.dir, '.mcp-observations', dir, 'dispatch.json')), { code: 'ENOENT' });
  }
});

for (const [name, alter] of [
  ['absent', f => f.outputs.set(f.prefix, null)],
  ['unowned', f => { f.outputs.get(f.prefix).properties.description = 'unrelated'; }],
  ['partial', f => { f.outputs.get(`${f.prefix}/operations`).value = []; }],
  ['extra operation', f => { f.outputs.get(`${f.prefix}/operations`).value.push({}); }],
  ['pagination', f => { f.outputs.get(`${f.prefix}/operations`).nextLink = 'https://invalid'; }],
  ['backend drift', f => { f.outputs.get(f.prefix).properties.serviceUrl = 'https://invalid'; }],
  ['user-claim removal', f => { f.outputs.get(`${f.prefix}/policies/policy`).properties.value = f.reviewed.policy.replace(/<claim name="oid"[\s\S]*?<\/claim>/, ''); }],
  ['scope whitespace drift', f => { f.outputs.get(`${f.prefix}/policies/policy`).properties.value = f.reviewed.policy.replace('<value>access_as_user</value>', '<value>access_as_user other</value>'); }],
  ['operation override', f => f.outputs.set(`${f.prefix}/operations/${f.reviewed.operationId}/policies`, list([{ properties: { value: '<policies />' } }]))],
  ['unsafe diagnostics', f => f.outputs.set(`${f.prefix}/diagnostics`, list([{ properties: { frontend: { request: { headers: ['Authorization'] } } } }]))],
  ['bearer deletion', f => { const key = `apis/${f.apiId}-rest/policies/policy`; f.outputs.get(key).properties.value = f.outputs.get(key).properties.value.replace('exists-action="override"', 'exists-action="delete"'); }],
]) test(`controlled delegated proof rejects ${name} before dispatch`, async t => {
  const f = await delegatedFixture(t), plan = await planMcpProjectProof(f.dir, f.selection);
  alter(f);
  await assert.rejects(execute(f, plan), error => {
    assert.ok(error.diagnostics?.proofStage);
    assert.doesNotMatch(JSON.stringify(error), /opaque-mocked|<policies/);
    return true;
  });
  assert.equal(f.dependencies.calls.includes('tools/call'), false);
  for (const dir of await readdir(path.join(f.dir, '.mcp-observations'))) {
    await assert.rejects(readFile(path.join(f.dir, '.mcp-observations', dir, 'dispatch.json')), { code: 'ENOENT' });
  }
});

for (const [name, body] of [
  ['HTTP 200 wrong marker', { accepted: true }],
  ['wrong fixture', { kind: 'controlled-delegated-v1', fixtureDigest: 'sha256:wrong', accepted: true }],
  ['backend denial', { status: 'Unauthorized' }],
]) test(`controlled delegated proof fails ${name} and consumes the call`, async t => {
  const f = await delegatedFixture(t), plan = await planMcpProjectProof(f.dir, f.selection);
  const result = await execute(f, plan, {}, billTransport(f, { content: [{ type: 'text', text: JSON.stringify(body) }] }));
  assert.equal(result.result.backendAssertion.status, 'failed');
  await assert.rejects(execute(f, plan), { code: 'PROOF_REPLAY_BLOCKED' });
});

test('controlled delegated proof refuses stale separate review and unknown sent-response replay', async t => {
  const f = await delegatedFixture(t), plan = await planMcpProjectProof(f.dir, f.selection);
  await assert.rejects(planMcpProjectProof(f.dir, { ...f.selection, delegatedFixture: {
    ...f.selection.delegatedFixture, approval: 'wrong' } }), { code: 'APPROVAL_REQUIRED' });
  const deps = { ...f.dependencies, mcpTransport: async (url, options) => {
    if (JSON.parse(options.body).method === 'tools/call') throw new Error('private-lost-response');
    return f.dependencies.mcpTransport(url, options);
  } };
  const result = await execute(f, plan, {}, deps);
  assert.equal(result.result.status, 'unknown');
  await assert.rejects(execute(f, await planMcpProjectProof(f.dir, { ...f.selection,
    safetyReview: { readOnly: true, reason: `${reason} Additional review.` } })), { code: 'PROOF_OUTCOME_UNRESOLVED' });
});

for (const claim of ['tid', 'oid', 'aud', 'azp', 'scp']) for (const missing of [false, true]) {
  test(`controlled delegated proof rejects ${missing ? 'missing' : 'wrong'} ${claim} before disclosure`, async t => {
    const f = await delegatedFixture(t), plan = await planMcpProjectProof(f.dir, f.selection);
    const before = [...f.dependencies.calls];
    const authTransport = async (url, options) => {
      const response = await f.dependencies.authTransport(url, options);
      if (!new URL(url).pathname.endsWith('/token')) return response;
      const result = await response.json();
      const claims = { tid: f.input.inbound.tenantId, oid: f.identity.expectedUserId, aud: f.input.inbound.clientId,
        azp: f.identity.discoveryClientId, scp: f.input.inbound.scope, exp: Math.floor(Date.now() / 1000) + 3600 };
      if (missing) delete claims[claim]; else claims[claim] = 'wrong';
      result.access_token = `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.mock`;
      return new Response(JSON.stringify(result));
    };
    await assert.rejects(execute(f, plan, {}, { ...f.dependencies, authTransport }), { code: 'AUTHENTICATION_REJECTED' });
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.dependencies.calls.filter(call => ['initialize', 'tools/list', 'tools/call'].includes(call)),
      before.filter(call => ['initialize', 'tools/list', 'tools/call'].includes(call)));
  });
}

test('controlled delegated fixture rejects changed bundle, changed principal and unsafe selection without dispatch', async t => {
  const f = await delegatedFixture(t), plan = await planMcpProjectProof(f.dir, f.selection);
  for (const selection of [
    { ...f.selection, arguments: { url: 'https://invalid' } },
    { ...f.selection, responseAssertion: undefined },
    { ...f.selection, delegatedFixture: undefined },
  ]) await assert.rejects(planMcpProjectProof(f.dir, selection));
  assert.throws(() => prepareDelegatedFixture({ ...f.reviewed.input, expectedUserId: '00000000-0000-0000-0000-000000000000' }), { code: 'INVALID_CONFIG' });
  assert.throws(() => prepareDelegatedFixture({ ...f.reviewed.input, applicationSecret: 'unsupported' }));
  for (const [name, change] of [
    ['principal', value => { value.expectedUserId = '66666666-6666-4666-8666-666666666666'; }],
    ['audience', value => { value.inbound.clientId = '66666666-6666-4666-8666-666666666666'; }],
  ]) {
    const input = structuredClone(f.reviewed.input); change(input);
    const review = prepareDelegatedFixture(input), output = path.join(f.root, name);
    await createDelegatedFixture(input, { output, approval: review.reviewDigest });
    await assert.rejects(planMcpProjectProof(f.dir, { ...f.selection, delegatedFixture: {
      path: output, approval: review.reviewDigest } }), { code: 'READ_ONLY_REVIEW_REQUIRED' });
  }
  const before = [...f.dependencies.calls];
  await writeFile(path.join(f.directory, 'activation.json'), f.reviewed.files['activation.json'] + '\n');
  await assert.rejects(execute(f, plan), { code: 'METADATA_MISMATCH' });
  assert.deepEqual(f.dependencies.calls, before);
  assert.equal(f.calls.length, 0);
});

test('shipping preflight accepts bounded capture files without authentication or reusable proof evidence', async t => {
  const f = await mappedKeyFixture(t);
  const file = path.join(f.dir, 'capture-input.json');
  await save(file, f.selection.capture);
  const selection = { ...f.selection, capture: 'capture-input.json' };
  const plan = await planMcpProofPreflight(f.dir, selection);
  assert.deepEqual(plan.proof, await planMcpProjectProof(f.dir, f.selection));
  const before = [...f.dependencies.calls];
  await assert.rejects(preflightMcpProof(f.dir, selection, { approval: plan.approvalDigest, runAzure: f.runAzure }), { code: 'APPROVAL_REQUIRED' });
  const result = await preflightMcpProof(f.dir, selection, { approval: plan.approvalDigest, allowCloud: true, runAzure: f.runAzure });
  assert.equal(result.toolDispatched, false);
  assert.equal(result.reusableEvidence, false);
  assert.deepEqual(f.dependencies.calls, before);
  await assert.rejects(readdir(path.join(f.dir, '.mcp-observations')), { code: 'ENOENT' });
  const completed = await execute({ ...f, selection }, plan.proof, {}, billTransport(f));
  assert.equal(completed.result.backendAssertion.status, 'passed');
  assert.equal((await readMcpStatus(f.dir)).proofs[0].status, 'completed');
  await assert.rejects(planMcpProofPreflight(f.dir, selection), { code: 'PROOF_REPLAY_BLOCKED' });
});

test('shipping capture field failures are precise and preflight detects source-file drift', async t => {
  const f = await mappedKeyFixture(t), file = path.join(f.dir, 'capture-input.json');
  for (const capture of ['missing.json', false, null]) {
    await assert.rejects(planMcpProjectProof(f.dir, { ...f.selection, capture }), error =>
      error.code === 'PROOF_CAPTURE_INVALID' && error.field === 'capture');
  }
  await save(file, f.selection.capture);
  const selection = { ...f.selection, capture: 'capture-input.json' };
  const plan = await planMcpProofPreflight(f.dir, selection);
  let reads = 0;
  const run = async (...args) => {
    const value = await f.runAzure(...args);
    if (++reads === 1) await save(file, {});
    return value;
  };
  await assert.rejects(preflightMcpProof(f.dir, selection, { approval: plan.approvalDigest, allowCloud: true, runAzure: run }));
  assert.equal(f.dependencies.calls.includes('tools/call'), false);
});

test('shipping preflight CLI reports sanitized real-verifier predicates and never starts MCP', async t => {
  const f = await mappedKeyFixture(t);
  const selectionFile = path.join(f.dir, 'selection.json');
  await save(selectionFile, f.selection);
  const plan = await planMcpProofPreflight(f.dir, f.selection);
  f.outputs.get(f.operationPath).properties.request.queryParameters[0].type = 'string';
  const before = [...f.dependencies.calls], output = [];
  const stdout = t.mock.method(process.stdout, 'write', value => { output.push(String(value)); return true; });
  const stderr = t.mock.method(process.stderr, 'write', () => true);
  try {
    const code = await main(['mcp-proof-preflight', '--project', f.dir, '--config', selectionFile,
      '--approve', plan.approvalDigest, '--allow-cloud', '--json'], {
      runAzure: f.runAzure, mcpProjectOperation() { assert.fail('Preflight cannot use MCP'); },
      onMcpDeviceCode() { assert.fail('Preflight cannot sign in'); },
    });
    assert.equal(code, 1);
    const result = JSON.parse(output.join(''));
    assert.equal(result.diagnostics.resource, 'operation');
    assert.equal(result.diagnostics.predicate, 'query-parameters');
    assert.match(result.checkpoint, /before another device sign-in/);
    assert.doesNotMatch(JSON.stringify(result), /<policies>|backend-reference|bill_id/);
    output.length = 0;
    await save(selectionFile, { ...f.selection, capture: 'missing.json' });
    assert.equal(await main(['mcp-proof-plan', '--project', f.dir, '--config', selectionFile, '--json']), 1);
    assert.equal(JSON.parse(output.join('')).field, 'capture');
    assert.equal(JSON.parse(output.join('')).reason, 'ENOENT');
  } finally { stdout.mock.restore(); stderr.mock.restore(); }
  assert.deepEqual(f.dependencies.calls, before);
  await assert.rejects(readdir(path.join(f.dir, '.mcp-observations')), { code: 'ENOENT' });
});

test('shipping preflight enforces separate approval, cancellation and bounded unchanged capture', async t => {
  const f = await mappedKeyFixture(t), plan = await planMcpProofPreflight(f.dir, f.selection);
  let reads = 0;
  const runAzure = async () => { reads++; assert.fail('Unapproved/cancelled preflight must not read Azure'); };
  await assert.rejects(preflightMcpProof(f.dir, f.selection, { allowCloud: true, approval: plan.proof.approvalDigest, runAzure }),
    { code: 'APPROVAL_REQUIRED' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(preflightMcpProof(f.dir, f.selection, {
    allowCloud: true, approval: plan.approvalDigest, runAzure, signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(reads, 0);
  const file = path.join(f.dir, 'oversized-capture.json');
  await writeFile(file, ' '.repeat(1048577));
  await assert.rejects(planMcpProjectProof(f.dir, { ...f.selection, capture: file }), { code: 'PROOF_CAPTURE_INVALID', field: 'capture' });
});

test('shipping prerequisite readback separates operator and service access without shared mutation', async t => {
  const f = await mappedKeyFixture(t), plan = await planMcpPrerequisites(f.dir);
  assert.equal(plan.keyVault.operator.role, 'Key Vault Secrets Officer');
  assert.equal(plan.keyVault.apim.role, 'Key Vault Secrets User');
  assert.match(plan.keyVault.apim.scope, /\/secrets\/backend-reference$/);
  assert.equal((await planMcpIdentityPrerequisite(f.dir)).mutationSupported, false);
  const run = async (command, args, options) => {
    assert.equal(command, 'az'); assert.ok(options.azureConfigDir.startsWith(f.dir));
    if (args[0] === 'account') return { id: f.input.azure.subscriptionId, tenantId: f.input.azure.tenantId, user: mockAzureUser };
    assert.equal(args[args.indexOf('--method') + 1], 'GET');
    assert.doesNotMatch(args.join(' '), /listValue|properties\.value/);
    if (args[args.indexOf('--url') + 1].includes('/secrets/')) return secretMetadataFixture(plan);
    return args[args.indexOf('--url') + 1].includes('Microsoft.KeyVault')
      ? f.outputs.get('proof-key-vault')
      : { id: serviceResourceId(f.cfg), identity: null, properties: { provisioningState: 'Succeeded', customProperties: {} } };
  };
  await assert.rejects(inspectMcpPrerequisites(f.dir, { approval: plan.approvalDigest, run }), { code: 'APPROVAL_REQUIRED' });
  const result = await inspectMcpPrerequisites(f.dir, { approval: plan.approvalDigest, allowCloud: true, run });
  assert.equal(result.service.systemIdentity, false);
  assert.equal(result.secretVerified, false);
  assert.equal(result.permissionsVerified, false);
  assert.match(result.next, /service owner/);
  const status = await readMcpStatus(f.dir);
  assert.equal(status.deployment, 'recorded-completed');
  assert.equal(status.coworkRuntimeVerified, false);
  assert.equal(status.replayAuthorized, false);
});

test('shipping prerequisite metadata is exact-target fail-closed and does not leak read payloads', async t => {
  const f = await mappedKeyFixture(t), plan = await planMcpPrerequisites(f.dir);
  const service = { id: serviceResourceId(f.cfg), identity: f.outputs.get('proof-service-identity').identity,
    properties: { provisioningState: 'Succeeded', customProperties: { tls: 'false' } } };
  let vault = f.outputs.get('proof-key-vault'), failure = false, reads = 0;
  const run = async (_, args) => {
    if (args[0] === 'account') return { id: f.input.azure.subscriptionId, tenantId: f.input.azure.tenantId, user: mockAzureUser };
    assert.equal(args[args.indexOf('--method') + 1], 'GET'); reads++;
    if (failure) throw Object.assign(new Error('private-response-body'), { code: 'private-error-code' });
    const url = args[args.indexOf('--url') + 1];
    return { stdout: JSON.stringify(url.includes('/secrets/') ? secretMetadataFixture(plan) : url.includes('Microsoft.KeyVault') ? vault : service), code: 0 };
  };
  const options = { allowCloud: true, approval: plan.approvalDigest, run };
  const result = await inspectMcpPrerequisites(f.dir, options);
  assert.equal(result.status, 'metadata-inspected-not-runtime-qualified');
  assert.equal(result.service.systemIdentity, true);
  assert.equal(result.secretVerified, false);
  for (const invalid of [null, { ...vault, id: `${vault.id}-wrong` },
    { ...vault, properties: { ...vault.properties, tenantId: '99999999-9999-4999-8999-999999999999' } }]) {
    vault = invalid;
    await assert.rejects(inspectMcpPrerequisites(f.dir, options), { code: 'METADATA_MISMATCH' });
  }
  failure = true; reads = 0;
  await assert.rejects(inspectMcpPrerequisites(f.dir, options), error => {
    assert.equal(error.code, 'MCP_PREREQUISITE_READ_FAILED');
    assert.equal(error.diagnostics.resource, 'service');
    assert.doesNotMatch(error.message + JSON.stringify(error.diagnostics), /private-/);
    return true;
  });
  assert.equal(reads, 1);
});

test('shipping secret metadata reads are approval-bound, distinguish blocked states and never fetch values', async t => {
  const f = await mappedKeyFixture(t), plan = await planMcpPrerequisites(f.dir);
  const expectedUrl = `https://management.azure.com${plan.keyVault.secretScope}?api-version=2023-07-01`;
  assert.equal(plan.requests.length, 3);
  assert.equal(plan.requests[2].url, expectedUrl);
  assert.doesNotMatch(plan.requests[2].query, /\bvalue\b|secretUriWithVersion/);
  const { approvalDigest, ...oldPlan } = plan;
  oldPlan.requests = oldPlan.requests.slice(0, 2);
  let secret = secretMetadataFixture(plan), failure, calls = [];
  const run = async (_, args, options) => {
    assert.ok(options.azureConfigDir.startsWith(f.dir));
    if (args[0] === 'account') return { id: f.input.azure.subscriptionId, tenantId: f.input.azure.tenantId, user: mockAzureUser };
    assert.equal(args[args.indexOf('--method') + 1], 'GET');
    const url = args[args.indexOf('--url') + 1]; calls.push(url);
    assert.ok(plan.requests.some(request => request.url === url));
    if (url === expectedUrl) {
      if (failure) throw failure;
      return { stdout: JSON.stringify(secret), code: 0 };
    }
    return url.includes('Microsoft.KeyVault') ? f.outputs.get('proof-key-vault')
      : { id: plan.serviceId, identity: f.outputs.get('proof-service-identity').identity, properties: { provisioningState: 'Succeeded' } };
  };
  await assert.rejects(inspectMcpPrerequisites(f.dir, { allowCloud: true, approval: metadataDigest(oldPlan), run }), { code: 'APPROVAL_REQUIRED' });
  assert.deepEqual(calls, []);
  for (const [label, enabled, errorCode] of [
    ['enabled', true], ['disabled', false], ['unreadable', null],
    ['missing', true, 'AZURE_RESOURCE_NOT_FOUND'], ['unreadable', true, 'AZURE_PERMISSION_DENIED'],
    ['unreadable', true, 'AZURE_CLI_EXIT'],
  ]) {
    secret = secretMetadataFixture(plan); secret.properties.attributes.enabled = enabled;
    failure = errorCode ? Object.assign(new Error('PRIVATE-ERROR-PAYLOAD'), { code: errorCode }) : undefined;
    calls = [];
    const result = await inspectMcpPrerequisites(f.dir, { allowCloud: true, approval: approvalDigest, run });
    assert.equal(result.secretMetadata.status, label);
    assert.equal(result.status, label === 'enabled' ? 'metadata-inspected-not-runtime-qualified' : 'blocked-prerequisites');
    assert.equal(result.permissionsVerified, false);
    assert.equal(result.secretVerified, false);
    assert.equal(calls.filter(url => url === expectedUrl).length, 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-ERROR-PAYLOAD/);
  }
  failure = undefined;
  for (const change of [
    value => { value.id += '-foreign'; },
    value => { value.name = 'another-secret'; },
    value => { value.properties.secretUri = 'https://another-vault.vault.azure.net/secrets/backend-reference'; },
    value => { value.properties.secretUri += '/a-version'; },
    value => { value.type = 'Microsoft.KeyVault/vaults'; },
  ]) {
    secret = secretMetadataFixture(plan); change(secret);
    await assert.rejects(inspectMcpPrerequisites(f.dir, { allowCloud: true, approval: approvalDigest, run }), { code: 'METADATA_MISMATCH' });
  }
});

test('shipping capture CLI gives field-specific malformed, missing, JSON and stale reasons without changing evidence', async t => {
  const f = await mappedKeyFixture(t), selectionFile = path.join(f.dir, 'selection.json'), captureFile = path.join(f.dir, 'capture-input.json');
  const original = JSON.stringify(f.selection.capture);
  await writeFile(captureFile, original);
  const stale = structuredClone(f.selection.capture);
  stale.capturedAt = new Date(Date.now() - 25 * 3600000).toISOString();
  const { receiptDigest, ...body } = stale;
  stale.receiptDigest = metadataDigest(boundedSnapshot(body));
  await writeFile(path.join(f.dir, 'bad.json'), '{PRIVATE-MALFORMED');
  const output = [], stdout = t.mock.method(process.stdout, 'write', value => { output.push(String(value)); return true; });
  const stderr = t.mock.method(process.stderr, 'write', () => true);
  try {
    for (const [capture, reason] of [[{}, 'INVALID_CONFIG'], ['bad.json', 'INVALID_JSON'], ['missing.json', 'ENOENT'],
      [stale, 'METADATA_STALE']]) {
      await save(selectionFile, { ...f.selection, capture });
      output.length = 0;
      assert.equal(await main(['mcp-proof-plan', '--project', f.dir, '--config', selectionFile, '--json']), 1);
      const result = JSON.parse(output.join(''));
      assert.equal(result.code, 'PROOF_CAPTURE_INVALID');
      assert.equal(result.field, 'capture');
      assert.equal(result.reason, reason);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE-MALFORMED|bill_id/);
    }
    await save(path.join(f.dir, 'malformed-object.json'), {});
    await save(selectionFile, { ...f.selection, capture: 'malformed-object.json' });
    output.length = 0;
    assert.equal(await main(['mcp-proof-plan', '--project', f.dir, '--config', selectionFile, '--json']), 1);
    assert.equal(JSON.parse(output.join('')).reason, 'INVALID_CONFIG');
    const plans = [];
    for (const capture of [f.selection.capture, 'capture-input.json']) {
      await save(selectionFile, { ...f.selection, capture }); output.length = 0;
      assert.equal(await main(['mcp-proof-plan', '--project', f.dir, '--config', selectionFile, '--json']), 0);
      plans.push(JSON.parse(output.join('')));
    }
    assert.deepEqual(plans[0], plans[1]);
  } finally { stdout.mock.restore(); stderr.mock.restore(); }
  assert.equal(await readFile(captureFile, 'utf8'), original);
  assert.equal(JSON.stringify(f.selection.capture), original);
  assert.equal(f.dependencies.calls.includes('tools/call'), false);
});

function replaceCaptureTools(f, tools) {
  const { receiptDigest, ...record } = f.selection.capture;
  record.tools = tools; record.toolsDigest = metadataDigest(boundedSnapshot(tools));
  f.selection.capture = boundedSnapshot({ ...record, receiptDigest: metadataDigest(boundedSnapshot(record)) });
}

async function mappedKeyFixture(t, changeInput = () => {}, options = {}) {
  return fixture(t, input => {
    input.azure.keyVaultName = 'fixture-vault';
    input.azure.keyVaultMode = 'existing';
    input.backend = { endpoint: 'https://api.legiscan.com', auth: 'api-key',
      apiKey: { queryParameterName: 'key', secretIdentifier: 'https://fixture-vault.vault.azure.net/secrets/backend-reference' } };
    input.operationIds = ['get_bill'];
    input.document.paths = { '/get-bill': { get: { operationId: 'get_bill', description: 'Retrieve a legislative bill.',
      'x-cowork-backend': { path: '/', query: { op: 'getBill' }, parameterNames: { bill_id: 'id' } },
      parameters: [{ name: 'bill_id', in: 'query', required: true, schema: { type: 'integer', minimum: 1 } }],
      responses: { 200: { description: 'Backend response envelope' } } } } };
    changeInput(input);
  }, { mappedKey: true, schema: { type: 'object', additionalProperties: false, properties: { bill_id: { type: 'integer', minimum: 1 } },
    required: ['bill_id'] }, arguments: { bill_id: 123 }, responseAssertion: 'legiscan-bill-v1', ...options });
}

function billTransport(f, reply = { content: [{ type: 'text', text: JSON.stringify({ status: 'OK', bill: { bill_id: 123 } }) }] }) {
  return { ...f.dependencies, mcpTransport: async (url, options) => {
    const response = await f.dependencies.mcpTransport(url, options);
    const rpc = JSON.parse(options.body);
    if (rpc.method !== 'tools/call') return response;
    assert.deepEqual(rpc.params, { name: f.tool.name, arguments: f.selection.arguments });
    if (reply === 'unknown') throw new Error('PRIVATE-RESPONSE-DO-NOT-PERSIST');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: reply }));
  } };
}

test('mapped API-key GET verifies serialized ARM metadata then calls once with an approved bill assertion', async t => {
  for (const promoted of [false, true]) await t.test(promoted ? 'promoted query template' : 'request query parameters', async t => {
    const f = await mappedKeyFixture(t);
    if (promoted) {
      const operation = f.outputs.get(f.operationPath).properties;
      operation.urlTemplate = '/get-bill?bill_id={bill_id}';
      operation.templateParameters = operation.request.queryParameters;
      operation.request.queryParameters = [];
    }
    const approval = await planMcpProjectProof(f.dir, f.selection), mapping = approval.operation.nativeGetMapping;
    assert.equal(mapping.kind, 'native-apim-mapped-key-get');
    assert.deepEqual(mapping.backendQuery, { id: 123, op: 'getBill' });
    assert.equal(mapping.requests.length, 14);
    assert.equal(mapping.targetUrl, 'https://api.legiscan.com/');
    assert.equal(mapping.keyReference.identity, 'SystemAssigned');
    assert.doesNotMatch(JSON.stringify(mapping.requests), /listValue|\/secrets\/|properties\.value/);
    const before = JSON.stringify(f.selection.capture);
    const result = await execute(f, approval, {}, billTransport(f));
    assert.equal(result.result.status, 'protocol-success');
    assert.deepEqual(result.result.backendAssertion, { kind: 'legiscan-bill-v1', status: 'passed' });
    assert.equal(result.result.businessCorrectnessVerified, false);
    assert.equal(f.dependencies.calls.filter(method => method === 'tools/call').length, 1);
    assert.equal(JSON.stringify(f.selection.capture), before);
    assert.equal(f.calls.filter(args => args[0] === 'rest').length, 14);
    assert.equal(result.result.nativeGetReadback.kind, 'native-apim-mapped-key-get-readback');
    assert.doesNotMatch(await readFile(result.resultFile, 'utf8'), /"bill"\s*:|"status":\s*"OK"|opaque-mocked|MOCK-ONLY/);
    await assert.rejects(execute(f, await planMcpProjectProof(f.dir, f.selection)), { code: 'PROOF_REPLAY_BLOCKED' });
  });

});

test('mapped API-key planning rejects argument overrides, unsupported schemas and stale approvals offline', async t => {
  const f = await mappedKeyFixture(t), selection = structuredClone(f.selection);
  const approval = await planMcpProjectProof(f.dir, f.selection);
  for (const argumentsValue of [{}, { bill_id: 0 }, { bill_id: -1 }, { bill_id: 1.5 }, { bill_id: Number.MAX_SAFE_INTEGER + 1 },
    { bill_id: '123' }, { bill_id: [123] }, { bill_id: 123, key: 'not-a-secret' }, { bill_id: 123, op: 'getOther' },
    { bill_id: 123, url: 'https://unrelated.example.com' }]) {
    f.selection = { ...selection, arguments: argumentsValue };
    await assert.rejects(planMcpProjectProof(f.dir, f.selection), { code: 'PROOF_ARGUMENTS_INVALID' });
  }
  for (const schema of [
    { ...f.tool.inputSchema, required: [] },
    { ...f.tool.inputSchema, properties: { bill_id: { type: 'number' } } },
    { ...f.tool.inputSchema, properties: { bill_id: { type: 'integer', oneOf: [{ minimum: 1 }] } } },
    { ...f.tool.inputSchema, properties: { bill_id: { type: 'integer', default: 1 } } },
  ]) {
    f.selection = structuredClone(selection);
    replaceCaptureTools(f, { tools: [{ ...f.tool, inputSchema: schema }] });
    await assert.rejects(planMcpProjectProof(f.dir, f.selection), { code: 'PROOF_SCHEMA_UNSUPPORTED' });
  }
  f.selection = { ...selection, responseAssertion: 'arbitrary-script' };
  await assert.rejects(planMcpProjectProof(f.dir, f.selection), { code: 'READ_ONLY_REVIEW_REQUIRED' });
  f.selection = { ...selection, arguments: { bill_id: 124 } };
  await assert.rejects(execute(f, approval), { code: 'APPROVAL_REQUIRED' });
  f.selection = selection;
  const changed = structuredClone(approval);
  changed.operation.nativeGetMapping.keyReference.secretIdentifier = 'https://unrelated.vault.azure.net/secrets/ref';
  await assert.rejects(execute(f, changed), { code: 'APPROVAL_REQUIRED' });
  assert.throws(() => planMcpReadOnlyProof(f.review.descriptor, selection), { code: 'INVALID_CONFIG' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.dependencies.calls.includes('tools/call'), false);
});

test('mapped API-key planner keeps optional/default/pattern/union and action overrides outside proof support', async t => {
  for (const [name, change] of [
    ['optional', op => { op.parameters[0].required = false; }],
    ['default', op => { op.parameters[0].schema.default = 1; }],
    ['pattern', op => { op.parameters[0].schema = { type: 'string', pattern: '^(?:[A-Z]{2}|ALL)$' }; }],
    ['union', op => { op.parameters[0].schema = { type: 'integer', oneOf: [{ type: 'integer', enum: [1, 2] }, { type: 'integer', minimum: 1901 }] }; }],
    ['action argument', op => { op.parameters[0].name = 'op'; op['x-cowork-backend'].parameterNames = { op: 'id' }; }],
    ['renamed action', op => { op['x-cowork-backend'].query = {}; op['x-cowork-backend'].parameterNames.bill_id = 'op'; }],
  ]) await t.test(name, async t => {
    const f = await mappedKeyFixture(t, input => change(input.document.paths['/get-bill'].get), { responseAssertion: undefined });
    await assert.rejects(planMcpProjectProof(f.dir, f.selection), { code: 'PROOF_SCHEMA_UNSUPPORTED' });
    assert.equal(f.calls.length, 0);
  });
  await t.test('fixed destructive action', async t => {
    const f = await mappedKeyFixture(t, input => { input.document.paths['/get-bill'].get['x-cowork-backend'].query.op = 'deleteBill'; },
      { responseAssertion: undefined });
    await assert.rejects(planMcpProjectProof(f.dir, f.selection), { code: 'UNSAFE_PROOF' });
  });
});

test('mapped API-key ARM policy, operation, key reference, identity and logging drift never dispatch', async t => {
  const cases = {
    'method': f => { f.outputs.get(f.operationPath).properties.method = 'POST'; },
    'wrong argument': f => { f.outputs.get(f.operationPath).properties.request.queryParameters[0].name = 'id'; },
    'wrong scalar type': f => { f.outputs.get(f.operationPath).properties.request.queryParameters[0].type = 'string'; },
    'optional argument': f => { f.outputs.get(f.operationPath).properties.request.queryParameters[0].required = false; },
    'extra key': f => { f.outputs.get(f.operationPath).properties.request.queryParameters.push({ name: 'key', type: 'string' }); },
    'body': f => { f.outputs.get(f.operationPath).properties.request.representations = [{ contentType: 'application/json' }]; },
    'header': f => { f.outputs.get(f.operationPath).properties.request.headers = [{ name: 'Authorization' }]; },
    'foreign full reference': f => { f.outputs.get(f.toolPath).properties.operationId = `/subscriptions/foreign${f.outputs.get(f.toolPath).properties.operationId}`; },
    'renaming policy': f => { const p = f.outputs.get(`apis/${f.apiId}-rest/policies/policy`).properties; p.value = p.value.replace('name="id"', 'name="other"'); },
    'literal policy whitespace': f => { const p = f.outputs.get(`apis/${f.apiId}-rest/policies/policy`).properties; p.value = p.value.replace('getBill', 'get Bill'); },
    'versioned reference': f => { f.outputs.get('proof-key-reference').properties.keyVault.secretIdentifier += '/version'; },
    'foreign vault': f => { f.outputs.get('proof-key-reference').properties.keyVault.secretIdentifier = 'https://foreign.vault.azure.net/secrets/ref'; },
    'nonsecret value': f => { f.outputs.get('proof-key-reference').properties.secret = false; },
    'plaintext value': f => { f.outputs.get('proof-key-reference').properties.value = 'PRIVATE-SECRET-DO-NOT-OUTPUT'; },
    'named user identity': f => { f.outputs.get('proof-key-reference').properties.keyVault.identityClientId = '88888888-8888-4888-8888-888888888888'; },
    'no system identity': f => { f.outputs.get('proof-service-identity').identity.type = 'UserAssigned'; },
    'empty principal': f => { f.outputs.get('proof-service-identity').identity.principalId = '00000000-0000-0000-0000-000000000000'; },
    'wrong identity tenant': f => { f.outputs.get('proof-service-identity').identity.tenantId = '99999999-9999-4999-8999-999999999999'; },
    'unsettled service': f => { f.outputs.get('proof-service-identity').provisioningState = 'Updating'; },
    'wrong vault tenant': f => { f.outputs.get('proof-key-vault').properties.tenantId = '99999999-9999-4999-8999-999999999999'; },
    'vault access policy': f => { f.outputs.get('proof-key-vault').properties.enableRbacAuthorization = false; },
    'unmasked query logging': f => { f.outputs.set('diagnostics', list([{ properties: {} }])); },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async t => {
    const f = await mappedKeyFixture(t), approval = await planMcpProjectProof(f.dir, f.selection);
    change(f);
    await assert.rejects(execute(f, approval, {}, billTransport(f)), error => {
      assert.ok(error.code === 'APIM_PROOF_MAPPING_MISMATCH' || ['APIM_IDENTITY_REQUIRED', 'APIM_SERVICE_INCOMPATIBLE', 'APIM_QUERY_KEY_LOGGING'].includes(error.code));
      assert.equal(error.diagnostics.proofStage, 'mapping-check');
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE|<policies|Bearer/);
      return true;
    });
    assert.equal(f.dependencies.calls.includes('tools/call'), false);
    const [attempt] = await readdir(path.join(f.dir, '.mcp-observations'));
    const attemptDir = path.join(f.dir, '.mcp-observations', attempt);
    assert.deepEqual((await readdir(attemptDir)).sort(), ['failure.json', 'intent.json']);
    const failure = JSON.parse(await readFile(path.join(attemptDir, 'failure.json'), 'utf8'));
    assert.equal(failure.status, 'not-dispatched');
    assert.equal((await planMcpProjectProof(f.dir, f.selection)).proofHistory.attempts[0].status, 'not-dispatched');
  });
});

test('mapped API-key response assertions keep backend failures and unknown calls non-replayable without saving payloads', async t => {
  const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  const ok = { status: 'OK', bill: { bill_id: 123, title: 'PRIVATE-BILL-CONTENT-DO-NOT-PERSIST' } };
  for (const [name, reply, verdict, status = 'protocol-success'] of [
    ['structured', { content: [], structuredContent: ok }, 'passed'],
    ['consistent dual', { ...text(ok), structuredContent: ok }, 'passed'],
    ['backend error', text({ status: 'ERROR', alert: { message: 'PRIVATE-KEY-ERROR-DO-NOT-PERSIST' } }), 'failed'],
    ['wrong bill', text({ status: 'OK', bill: { bill_id: 124 } }), 'failed'],
    ['missing bill', text({ status: 'OK' }), 'failed'],
    ['unrecognized text', { content: [{ type: 'text', text: 'PRIVATE-MALFORMED-DO-NOT-PERSIST' }] }, 'failed'],
    ['contradictory dual', { ...text({ status: 'ERROR' }), structuredContent: ok }, 'failed'],
    ['tool error', { ...text(ok), isError: true }, 'failed', 'tool-error'],
    ['unknown after send', 'unknown', 'not-evaluated', 'unknown'],
  ]) await t.test(name, async t => {
    const f = await mappedKeyFixture(t), approval = await planMcpProjectProof(f.dir, f.selection);
    const result = await execute(f, approval, {}, billTransport(f, reply));
    assert.equal(result.result.status, status);
    assert.deepEqual(result.result.backendAssertion, { kind: 'legiscan-bill-v1', status: verdict });
    assert.equal(f.dependencies.calls.filter(method => method === 'tools/call').length, 1);
    for (const filename of await readdir(result.outputDir)) {
      assert.doesNotMatch(await readFile(path.join(result.outputDir, filename), 'utf8'), /PRIVATE|opaque-mocked|MOCK-ONLY|"bill":/);
    }
    const next = await planMcpProjectProof(f.dir, f.selection);
    await assert.rejects(execute(f, next), { code: status === 'unknown' ? 'PROOF_OUTCOME_UNRESOLVED' : 'PROOF_REPLAY_BLOCKED' });
    const retained = await readMcpStatus(f.dir);
    assert.equal(retained.replayAuthorized, false);
    assert.equal(retained.proofs[0].status, status === 'unknown' ? 'unresolved' : 'completed');
    if (status !== 'unknown') assert.equal(retained.proofs[0].backendAssertion.status, verdict);
    assert.doesNotMatch(JSON.stringify(retained), /PRIVATE|opaque-mocked|MOCK-ONLY|"bill":/);
  });
});

test('mapped API-key CLI serializes only backend verdicts and exits nonzero for ERROR envelopes', async t => {
  for (const successful of [true, false]) await t.test(successful ? 'OK' : 'ERROR', async t => {
    const f = await mappedKeyFixture(t), plan = await planMcpProjectProof(f.dir, f.selection);
    const filename = path.join(f.root, 'selection.json');
    await save(filename, f.selection);
    const response = successful ? { status: 'OK', bill: { bill_id: 123 } } : { status: 'ERROR', alert: { message: 'PRIVATE-RESPONSE' } };
    const output = [], errors = [];
    const stdout = t.mock.method(process.stdout, 'write', value => { output.push(String(value)); return true; });
    const stderr = t.mock.method(process.stderr, 'write', value => { errors.push(String(value)); return true; });
    let code;
    try {
      code = await main(['mcp-proof', '--project', f.dir, '--config', filename, '--approve', plan.approvalDigest,
        '--allow-network', '--allow-cloud', '--json'], { onMcpDeviceCode() {},
        mcpProjectOperation: (dir, options) => execute(f, options.approval, {}, billTransport(f,
          { content: [{ type: 'text', text: JSON.stringify(response) }] })) });
    } finally { stdout.mock.restore(); stderr.mock.restore(); }
    assert.equal(code, successful ? 0 : 2);
    const result = JSON.parse(output.join(''));
    assert.equal(result.status, 'protocol-success');
    assert.equal(result.backendAssertion.status, successful ? 'passed' : 'failed');
    if (!successful) assert.match(result.recovery, /without replaying/);
    assert.doesNotMatch(output.join('') + errors.join(''), /PRIVATE|opaque-mocked|MOCK-ONLY|<policies|"bill":/);
  });
});

test('mapped API-key generic scalar GET retains other tools and does not imply backend qualification', async t => {
  const schema = { type: 'object', properties: { sku: { type: 'string', minLength: 1, maxLength: 40 } }, required: ['sku'] };
  const f = await mappedKeyFixture(t, input => {
    input.backend.endpoint = 'https://catalog.example.com';
    const operation = input.document.paths['/get-bill'].get;
    operation.parameters = [{ name: 'sku', in: 'query', required: true, schema: schema.properties.sku }];
    operation['x-cowork-backend'] = { path: '/', query: { op: 'getItem' }, parameterNames: { sku: 'id' } };
    input.document.paths['/search'] = { get: { operationId: 'search', description: 'Read a catalog selection',
      'x-cowork-backend': { path: '/', query: { op: 'getSearch' } },
      parameters: [{ name: 'state', in: 'query', schema: { type: 'string', pattern: '^(?:[A-Z]{2}|ALL)$', default: 'ALL' } }],
      responses: { 200: { description: 'Selection' } } } };
    input.operationIds.push('search');
  }, { schema, arguments: { sku: 'SKU-123' }, responseAssertion: undefined });
  f.outputs.get(f.operationPath).properties.request.queryParameters = [{ name: 'sku', type: 'string', required: true }];
  f.outputs.get('proof-service-identity').identity.type = 'SystemAssigned, UserAssigned';
  f.outputs.get('proof-key-reference').properties.keyVault.identityClientId = null;
  for (const suffix of ['diagnostics', `apis/${f.apiId}/diagnostics`, `apis/${f.apiId}-rest/diagnostics`]) {
    f.outputs.set(suffix, list([{ properties: Object.fromEntries(['frontend', 'backend'].map(direction =>
      [direction, { request: { dataMasking: { queryParams: [{ mode: 'Hide', value: 'key' }] } } }])) }]));
  }
  for (const id of [f.apiId, `${f.apiId}-rest`]) {
    const policy = f.outputs.get(`apis/${id}/policies/policy`).properties;
    policy.value = policy.value.replace(/></g, '>\n  <');
  }
  const otherTool = { name: 'search', description: 'Read a catalog selection',
    inputSchema: { type: 'object', properties: { state: { type: 'string', pattern: '^(?:[A-Z]{2}|ALL)$' } } } };
  f.tools.tools.push(otherTool);
  replaceCaptureTools(f, f.tools);
  for (const value of ['', 'https://example.com', 'x&key=y', 'x\n', 'a'.repeat(257)]) {
    await assert.rejects(planMcpProjectProof(f.dir, { ...f.selection, arguments: { sku: value } }), { code: 'PROOF_ARGUMENTS_INVALID' });
  }
  const approval = await planMcpProjectProof(f.dir, f.selection);
  assert.equal(approval.operation.capture.tools.tools.length, 2);
  assert.deepEqual(approval.operation.nativeGetMapping.backendQuery, { id: 'SKU-123', op: 'getItem' });
  assert.match(approval.operation.limitations.join(' '), /cannot establish API-key validity/);
  const result = await execute(f, approval);
  assert.equal(result.result.status, 'protocol-success');
  assert.equal(Object.hasOwn(result.result, 'backendAssertion'), false);
  assert.equal(result.result.businessCorrectnessVerified, false);
  assert.equal(f.dependencies.calls.filter(method => method === 'tools/call').length, 1);
});

test('mapped API-key query normalization rejects ambiguous ARM representations', async t => {
  const f = await mappedKeyFixture(t), mapping = (await planMcpProjectProof(f.dir, f.selection)).operation.nativeGetMapping;
  const operation = f.outputs.get(f.operationPath).properties;
  for (const change of [
    op => { op.urlTemplate += '?bill_id=123'; },
    op => { op.urlTemplate += '?bill_id={id}'; },
    op => { op.urlTemplate += '?bill_id={bill_id}&bill_id={bill_id}'; },
    op => { op.urlTemplate += '?bill_id={bill_id}?other'; },
    op => { op.request.queryParameters.push({ ...op.request.queryParameters[0] }); },
    op => { op.request.queryParameters[0].defaultValue = '123'; },
    op => { op.request.queryParameters[0].schemaId = 'foreign'; },
    op => { op.request.queryParameters[0].values = ['123']; },
    op => { op.request.queryParameters = null; },
    op => { op.templateParameters = null; },
    op => { op.templateParameters = op.request.queryParameters; op.request.queryParameters = []; },
  ]) {
    const changed = structuredClone(operation); change(changed);
    assert.equal(mappedOperationMatches(changed, mapping), false);
  }
});

test('mapped API-key query references require verified linked schema evidence', async t => {
  const f = await mappedKeyFixture(t);
  const mapping = (await planMcpProjectProof(f.dir, f.selection)).operation.nativeGetMapping;
  const operation = {
    method: 'GET', urlTemplate: '/get-bill?bill_id={bill_id}',
    request: { headers: [], queryParameters: [], representations: [] },
    templateParameters: [{
      description: 'Positive bill_id from a search result, not a session or roll-call ID.',
      name: 'bill_id', required: true, schemaId: '6ac97d934634611c3cbf337e',
      type: 'integer', typeName: 'Get-billGetRequest', values: [],
    }],
  };
  assert.equal(mappedOperationMatches(operation, mapping), false);
});

function linkedSchemaFixture(f) {
  const schemaId = '6ac97d934634611c3cbf337e', typeName = 'Get-billGetRequest';
  const operation = f.outputs.get(f.operationPath).properties;
  operation.urlTemplate = '/get-bill?bill_id={bill_id}';
  operation.request.queryParameters = [];
  operation.templateParameters = [{
    description: 'Positive bill_id from a search result, not a session or roll-call ID.',
    name: 'bill_id', required: true, schemaId, type: 'integer', typeName, values: [],
  }];
  const prefix = `${serviceResourceId(f.cfg)}/apis/${f.apiId}-rest/schemas/`;
  const suffix = `apis/${f.apiId}-rest/schemas/${schemaId}`;
  const resource = { id: `${prefix}${schemaId}`, name: schemaId,
    properties: { contentType: 'application/vnd.oai.openapi.components+json',
      document: { components: { schemas: {
        [typeName]: { minimum: 1, type: 'integer', 'x-apim-inline': true },
        UnrelatedResponse: { type: 'object', properties: { external: { $ref: 'https://unrelated.example.com/schema' } } },
      } } } } };
  f.outputs.set(suffix, resource);
  return { parameter: operation.templateParameters[0], resource, prefix, suffix, typeName };
}

test('linked APIM inline scalar schema matches the reviewed constraints, not only the captured type', async t => {
  const f = await mappedKeyFixture(t, () => {}, { schema: {
    type: 'object', additionalProperties: false, required: ['bill_id'],
    properties: { bill_id: { description: 'Positive bill_id from a search result, not a session or roll-call ID.', type: 'integer' } },
  } });
  const linked = linkedSchemaFixture(f), approval = await planMcpProjectProof(f.dir, f.selection);
  const mapping = approval.operation.nativeGetMapping;
  assert.equal(mapping.schemaReadback.maximumResources, 1);
  assert.equal(mapping.schemaReadback.resourcePrefix, linked.prefix);
  assert.equal(mapping.requests.length, 14);
  const priorApproval = structuredClone(approval);
  delete priorApproval.operation.nativeGetMapping.schemaReadback;
  await assert.rejects(execute(f, priorApproval), { code: 'APPROVAL_REQUIRED' });
  const before = JSON.stringify(f.selection.capture);
  const result = await execute(f, approval, {}, billTransport(f));
  assert.equal(result.result.status, 'protocol-success');
  assert.equal(result.result.backendAssertion.status, 'passed');
  const reads = f.calls.filter(args => args[0] === 'rest');
  assert.equal(reads.length, 15);
  assert.equal(reads.filter(args => args[args.indexOf('--url') + 1] === mapping.schemaReadback.urlTemplate
    .replace('{schemaId}', linked.parameter.schemaId)).length, 1);
  assert.equal(JSON.stringify(f.selection.capture), before);
  assert.equal(f.dependencies.calls.filter(method => method === 'tools/call').length, 1);
  assert.doesNotMatch(await readFile(result.resultFile, 'utf8'), /UnrelatedResponse|x-apim-inline|6ac97d934634611c3cbf337e/);
  await assert.rejects(execute(f, await planMcpProjectProof(f.dir, f.selection)), { code: 'PROOF_REPLAY_BLOCKED' });
});

test('linked APIM schema validation rejects changed, missing, opaque and foreign definitions', async t => {
  const f = await mappedKeyFixture(t), linked = linkedSchemaFixture(f);
  const expected = (await planMcpProjectProof(f.dir, f.selection)).operation.nativeGetMapping.parameters[0];
  assert.equal(mappedLinkedSchemaMatches(linked.resource, linked.parameter, expected, linked.prefix), true);
  for (const change of [
    resource => { resource.id = `/foreign${resource.id}`; },
    resource => { resource.name = 'other'; },
    resource => { resource.properties.contentType = 'application/json'; },
    resource => { resource.properties.document = JSON.stringify(resource.properties.document); },
    resource => { resource.properties.document.$ref = 'https://unrelated.example.com/schema'; },
    resource => { resource.properties.document.components.$ref = 'https://unrelated.example.com/schema'; },
    resource => { delete resource.properties.document.components.schemas[linked.typeName]; },
    resource => { resource.properties.document.components.schemas[linked.typeName] = { $ref: '#/components/schemas/Other' }; },
    resource => { resource.properties.document.components.schemas[linked.typeName].$ref = 'https://unrelated.example.com/schema'; },
    resource => { resource.properties.document.components.schemas[linked.typeName].minimum = 0; },
    resource => { delete resource.properties.document.components.schemas[linked.typeName].minimum; },
    resource => { resource.properties.document.components.schemas[linked.typeName].maximum = 10; },
    resource => { resource.properties.document.components.schemas[linked.typeName].type = 'string'; },
    resource => { resource.properties.document.components.schemas[linked.typeName]['x-apim-inline'] = false; },
    resource => { delete resource.properties.document.components.schemas[linked.typeName]['x-apim-inline']; },
    resource => { resource.properties.document.components.schemas[linked.typeName].nullable = true; },
    resource => { resource.properties.document.components.schemas[linked.typeName].oneOf = [{ type: 'integer' }]; },
    resource => { resource.properties.document.components.schemas[linked.typeName].default = 123; },
  ]) {
    const resource = structuredClone(linked.resource); change(resource);
    assert.equal(mappedLinkedSchemaMatches(resource, linked.parameter, expected, linked.prefix), false);
  }
  for (const change of [
    parameter => { delete parameter.schemaId; },
    parameter => { delete parameter.typeName; },
    parameter => { parameter.schemaId = '../../foreign'; },
    parameter => { parameter.schemaId = 'foo?api-version=other'; },
    parameter => { parameter.schemaId = '%2e%2e'; },
    parameter => { parameter.typeName = '#/components/schemas/Other'; },
    parameter => { parameter.typeName = ''; },
    parameter => { parameter.schemaId = null; },
  ]) {
    const parameter = { ...linked.parameter }; change(parameter);
    assert.equal(mappedSchemaReference(parameter), false);
    assert.equal(mappedLinkedSchemaMatches(linked.resource, parameter, expected, linked.prefix), false);
  }
});

test('linked APIM schema read drift and errors stop the real wrapper before dispatch', async t => {
  for (const mode of ['constraint', 'foreign-resource', 'missing-definition', 'read-error', 'invalid-json', 'unsafe-reference']) await t.test(mode, async t => {
    const f = await mappedKeyFixture(t), linked = linkedSchemaFixture(f);
    const approval = await planMcpProjectProof(f.dir, f.selection);
    if (mode === 'constraint') linked.resource.properties.document.components.schemas[linked.typeName].minimum = 0;
    if (mode === 'foreign-resource') linked.resource.id = linked.resource.id.replace(`/${f.apiId}-rest/`, '/foreign-api/');
    if (mode === 'missing-definition') delete linked.resource.properties.document.components.schemas[linked.typeName];
    if (mode === 'unsafe-reference') linked.parameter.schemaId = '../foreign';
    let schemaReads = 0;
    const runAzure = async (command, args, options) => {
      if (args[0] === 'rest' && args[args.indexOf('--url') + 1].includes('/schemas/')) {
        schemaReads++;
        if (mode === 'read-error') throw Object.assign(new Error('PRIVATE-SCHEMA-READ-DETAIL'), { code: 'AZURE_CLI_EXIT' });
        if (mode === 'invalid-json') return { stdout: '{"PRIVATE-SCHEMA-READ-DETAIL":', code: 0 };
      }
      return f.runAzure(command, args, options);
    };
    await assert.rejects(execute(f, approval, {}, billTransport(f), runAzure), error => {
      assert.equal(error.code, mode === 'read-error' ? 'AZURE_CLI_EXIT' : 'APIM_PROOF_MAPPING_MISMATCH');
      assert.equal(error.diagnostics.resource, mode === 'unsafe-reference' ? 'operation' : 'operation-schema');
      assert.equal(error.diagnostics.proofStage, mode === 'read-error' ? 'arm-read' : mode === 'invalid-json' ? 'arm-parse' : 'mapping-check');
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE-SCHEMA/);
      return true;
    });

    assert.equal(schemaReads, mode === 'unsafe-reference' ? 0 : 1);
    assert.equal(f.dependencies.calls.includes('tools/call'), false);
    const [attempt] = await readdir(path.join(f.dir, '.mcp-observations'));
    const dir = path.join(f.dir, '.mcp-observations', attempt);
    assert.deepEqual((await readdir(dir)).sort(), ['failure.json', 'intent.json']);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'failure.json'), 'utf8')).status, 'not-dispatched');
    assert.equal((await planMcpProjectProof(f.dir, f.selection)).proofHistory.attempts[0].status, 'not-dispatched');
  });
});

test('linked APIM schemas are read once when reviewed scalar parameters share a definition', async t => {
  const f = await mappedKeyFixture(t, input => {
    input.document.paths['/get-bill'].get.parameters.push({ name: 'other_id', in: 'query', required: true,
      schema: { type: 'integer', minimum: 1 } });
  }, { responseAssertion: undefined, arguments: { bill_id: 123, other_id: 456 },
    schema: { type: 'object', additionalProperties: false, required: ['bill_id', 'other_id'],
      properties: { bill_id: { type: 'integer' }, other_id: { type: 'integer' } } } });
  const linked = linkedSchemaFixture(f), operation = f.outputs.get(f.operationPath).properties;
  operation.urlTemplate += '&other_id={other_id}';
  operation.templateParameters.push({ ...linked.parameter, name: 'other_id' });
  const approval = await planMcpProjectProof(f.dir, f.selection);
  assert.equal(approval.operation.nativeGetMapping.schemaReadback.maximumResources, 2);
  const result = await execute(f, approval);
  assert.equal(result.result.status, 'protocol-success');
  assert.equal(f.calls.filter(args => args[0] === 'rest' && args[args.indexOf('--url') + 1].includes('/schemas/')).length, 1);
  assert.equal(f.dependencies.calls.filter(method => method === 'tools/call').length, 1);
});

test('linked APIM schema CLI diagnostics are classified without exposing the schema payload', async t => {
  const f = await mappedKeyFixture(t), linked = linkedSchemaFixture(f);
  linked.resource.properties.document.components.schemas[linked.typeName].$ref = 'https://PRIVATE-SCHEMA-PAYLOAD.example.com';
  const approval = await planMcpProjectProof(f.dir, f.selection);
  const filename = path.join(f.root, 'selection.json');
  await save(filename, f.selection);
  const output = [], errors = [];
  const stdout = t.mock.method(process.stdout, 'write', value => { output.push(String(value)); return true; });
  const stderr = t.mock.method(process.stderr, 'write', value => { errors.push(String(value)); return true; });
  let code;
  try {
    code = await main(['mcp-proof', '--project', f.dir, '--config', filename, '--approve', approval.approvalDigest,
      '--allow-network', '--allow-cloud', '--json'], { onMcpDeviceCode() {},
      mcpProjectOperation: (dir, options) => execute(f, options.approval) });
  } finally { stdout.mock.restore(); stderr.mock.restore(); }
  assert.equal(code, 1);
  const result = JSON.parse(output.join(''));
  assert.equal(result.error, 'APIM_PROOF_MAPPING_MISMATCH');
  assert.equal(result.diagnostics.resource, 'operation-schema');
  assert.equal(result.diagnostics.predicate, 'linked-schema');
  assert.doesNotMatch(output.join('') + errors.join(''), /PRIVATE|opaque-mocked|MOCK-ONLY|components|x-apim-inline/);
  assert.equal(f.dependencies.calls.includes('tools/call'), false);
});

test('mapped API-key re-list drift and failed ARM reads stop before dispatch without retry', async t => {
  for (const mode of ['relist', 'read', 'identity']) await t.test(mode, async t => {
    const f = await mappedKeyFixture(t), approval = await planMcpProjectProof(f.dir, f.selection);
    const dependencies = mode === 'relist'
      ? observationTransport(f.review.descriptor, f.identity, { tools: [{ ...f.tool, description: 'Changed' }] })
      : f.dependencies;
    let reads = 0;
    const runAzure = async (...args) => {
      reads++;
      if (mode === 'read' && args[1][0] === 'rest') {
        throw Object.assign(new Error('PRIVATE-AZURE-PAYLOAD'), { code: 'AZURE_CLI_TRANSPORT_INTERRUPTED' });
      }
      if (mode === 'identity') return { id: f.input.azure.subscriptionId, tenantId: '99999999-9999-4999-8999-999999999999', user: mockAzureUser };
      return f.runAzure(...args);
    };
    await assert.rejects(execute(f, approval, {}, dependencies, runAzure));
    assert.equal(dependencies.calls.includes('tools/call'), false);
    assert.equal(reads, mode === 'relist' ? 0 : mode === 'identity' ? 1 : 2);
    assert.equal((await planMcpProjectProof(f.dir, f.selection)).proofHistory.attempts[0].status, 'not-dispatched');
  });
});

test('unannotated native fixed GET uses exact full or relative ARM mapping, unchanged capture and real one-call protocol', async t => {
  for (const relative of [false, true]) await t.test(relative ? 'relative' : 'canonical full ID', async t => {
    const f = await fixture(t);
    if (relative) f.outputs.get(f.toolPath).properties.operationId = `/${f.operationPath}`;
    const before = JSON.stringify(f.selection.capture);
    assert.throws(() => planMcpReadOnlyProof(f.review.descriptor, f.selection), { code: 'READ_ONLY_REVIEW_REQUIRED' });
    const approval = await planMcpProjectProof(f.dir, f.selection);
    assert.equal(f.calls.length, 0);
    assert.equal(approval.operation.nativeGetMapping.annotations, 'absent');
    assert.equal(approval.operation.nativeGetMapping.targetUrl, 'https://jsonplaceholder.typicode.com/posts/1');
    assert.equal(approval.operation.safetyReview.verified, false);
    assert.match(approval.operation.limitations.join(' '), /non-atomic/);
    f.dependencies.calls.length = 0;
    const order = [];
    const transport = f.dependencies.mcpTransport;
    const dependencies = { ...f.dependencies, mcpTransport: async (url, options) => {
      const rpc = JSON.parse(options.body);
      order.push(rpc.method);
      if (rpc.method === 'tools/call') assert.deepEqual(rpc.params, { name: f.tool.name, arguments: {} });
      return transport(url, options);
    } };
    const runAzure = async (...args) => { order.push('arm-read'); return f.runAzure(...args); };
    const result = await execute(f, approval, {}, dependencies, runAzure);
    assert.equal(result.result.status, 'protocol-success');
    assert.equal(order.filter(item => item === 'tools/call').length, 1);
    assert.ok(order.indexOf('arm-read') > order.indexOf('tools/list'));
    assert.ok(order.lastIndexOf('arm-read') < order.indexOf('tools/call'));
    assert.equal(f.calls.filter(args => args[0] === 'rest').length, approval.operation.nativeGetMapping.requests.length);
    assert.equal(result.result.nativeGetReadback.mappingDigest, metadataDigest(approval.operation.nativeGetMapping));
    assert.equal(JSON.stringify(f.selection.capture), before);
    assert.equal(Object.hasOwn(result.result, 'content'), false);
    assert.doesNotMatch(await readFile(result.resultFile, 'utf8'), /inert private fixture response|opaque-mocked|MOCK-ONLY/);
    await assert.rejects(execute(f, approval), { code: 'PROOF_REPLAY_BLOCKED' });
  });
});

test('native ARM transport defaults and explicit streamable metadata preserve the exact one-call proof', async t => {
  for (const [name, mcpProperties, serviceUrl] of [
    ['omitted', undefined, undefined], ['null', null, null], ['empty', {}, ''],
    ['explicit streamable', { transportType: 'streamable' }, undefined],
    ['ARM native defaults', { endpoints: null, federation: null, isFederationRouter: false }, undefined],
    ['ARM defaults with explicit streamable', { transportType: 'streamable', endpoints: null, federation: null, isFederationRouter: false }, undefined],
  ]) await t.test(name, async t => {
    const f = await fixture(t);
    const properties = f.outputs.get(`apis/${f.apiId}`).properties;
    if (mcpProperties === undefined) delete properties.mcpProperties;
    else properties.mcpProperties = mcpProperties;
    if (serviceUrl !== undefined) properties.serviceUrl = serviceUrl;
    const before = JSON.stringify(f.selection.capture);
    f.dependencies.calls.length = 0;
    const runAzure = async (...args) => ({ stdout: JSON.stringify(await f.runAzure(...args)), code: 0 });
    const result = await execute(f, await planMcpProjectProof(f.dir, f.selection), {}, f.dependencies, runAzure);
    assert.equal(result.result.status, 'protocol-success');
    assert.equal(f.dependencies.calls.filter(method => method === 'tools/call').length, 1);
    assert.equal(JSON.stringify(f.selection.capture), before);
    await assert.rejects(execute(f, await planMcpProjectProof(f.dir, f.selection)), { code: 'PROOF_REPLAY_BLOCKED' });
  });
});

test('approval and opt-ins fail before any authentication or ARM request; direct public options cannot enable the exception', async t => {
  const f = await fixture(t), approval = await planMcpProjectProof(f.dir, f.selection);
  const before = f.dependencies.calls.length;
  for (const overrides of [{ allowCloud: undefined }, { allowNetwork: false }, { approval: { ...approval, reviewDigest: 'changed' } }]) {
    await assert.rejects(execute(f, approval, overrides));
  }
  assert.equal(f.dependencies.calls.length, before);
  assert.equal(f.calls.length, 0);
  assert.throws(() => planMcpReadOnlyProof(f.review.descriptor, { ...f.selection,
    nativeGetMapping: approval.operation.nativeGetMapping }), { code: 'INVALID_CONFIG' });
  f.selection.safetyReview.readOnly = false;
  await assert.rejects(planMcpProjectProof(f.dir, f.selection), { code: 'READ_ONLY_REVIEW_REQUIRED' });
});

test('local mapping, schema, source, approval identity and deployment bindings fail closed', async t => {
  for (const change of ['artifact', 'history', 'history-binding', 'receipt', 'receipt-binding', 'identity', 'schema', 'description', 'source', 'arguments', 'unsafe-hint']) {
    await t.test(change, async t => {
      const f = await fixture(t), approval = await planMcpProjectProof(f.dir, f.selection);
      if (change === 'artifact') await writeFile(path.join(f.dir, 'infra', 'operation-map.json'), '{}');
      if (change === 'history') await save(f.historyFile, { ...f.history, status: 'failed-uncertain' });
      if (change === 'history-binding') await save(f.historyFile, { ...f.history, finishedAt: '2026-01-01T00:00:00.000Z' });
      if (change === 'receipt') await save(path.join(f.dir, 'infra', 'provisioning-receipt.json'),
        { ...f.receipt, preservation: { ...f.receipt.preservation, verified: false } });
      if (change === 'receipt-binding') await save(path.join(f.dir, 'infra', 'provisioning-receipt.json'), { ...f.receipt, revision: 2 });
      if (change === 'identity') await selectMockAzureIdentity(f.dir, f.input.azure);
      if (change === 'schema') replaceCaptureTools(f, { tools: [{ ...f.tool,
        inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: [], additionalProperties: false } }] });
      if (change === 'description') replaceCaptureTools(f, { tools: [{ ...f.tool, description: 'Another mapping' }] });
      if (change === 'source') f.selection.capture.source.endpoint = 'https://unrelated.example.com/mcp';
      if (change === 'arguments') f.selection.arguments = { url: 'https://unrelated.example.com' };
      if (change === 'unsafe-hint') replaceCaptureTools(f, { tools: [{ ...f.tool, annotations: { readOnlyHint: false } }] });
      const before = f.dependencies.calls.length;
      await assert.rejects(execute(f, approval));
      assert.equal(f.calls.length, 0);
      assert.equal(f.dependencies.calls.length, before);
    });
  }
});

test('parameterized, non-GET and rewritten generated routes never qualify for native GET proof', async t => {
  for (const mode of ['method', 'parameter', 'request-body', 'rewrite']) await t.test(mode, async t => {
    const f = await fixture(t, input => {
      const operation = input.document.paths['/posts/1'].get;
      if (mode === 'method') { input.document.paths['/posts/1'].post = operation; delete input.document.paths['/posts/1'].get; }
      if (mode === 'parameter') operation.parameters = [{ name: 'filter', in: 'query', schema: { type: 'string' } }];
      if (mode === 'request-body') operation.requestBody = { content: { 'application/json': { schema: { type: 'object' } } } };
      if (mode === 'rewrite') operation['x-cowork-backend'] = { path: '/posts/2', query: {} };
    });
    await assert.rejects(planMcpProjectProof(f.dir, f.selection), { code: 'READ_ONLY_REVIEW_REQUIRED' });
    assert.equal(f.calls.length, 0);
  });
});

test('control-plane check has a separate bound without resetting MCP I/O time, and cancellation never sends a late call', async t => {
  const endpoint = 'https://example.com/mcp';
  const tools = { tools: [{ name: 'readRecord', inputSchema: { type: 'object', properties: {} } }] };
  const call = { name: 'readRecord', arguments: {}, toolsDigest: metadataDigest(boundedSnapshot(tools)) };
  for (const mode of ['success', 'mcp-timeout', 'cancel', 'inspection-timeout']) await t.test(mode, async t => {
    const net = observationTransport({ endpoint, inbound: {} }, {}, tools), controller = new AbortController();
    if (mode === 'inspection-timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = probeMcp(endpoint, { timeoutMs: 500, signal: controller.signal, toolCall: call,
      beforeToolCall: async signal => {
        if (mode === 'cancel') controller.abort();
        else if (mode === 'inspection-timeout') { t.mock.timers.tick(120001); assert.equal(signal.aborted, true); }
        else await new Promise(resolve => setTimeout(resolve, 650));
      },
      fetchImpl: async (url, options) => {
        if (mode === 'mcp-timeout' && JSON.parse(options.body).method === 'tools/call') return new Promise(() => {});
        return net.mcpTransport(url, options);
      } });
    if (mode === 'success') assert.equal((await pending).toolCall.status, 'protocol-success');
    else {
      await assert.rejects(pending, error => mode === 'mcp-timeout' ? error.invocationStatus === 'unknown'
        : /aborted|timeout/.test(error.message) && error.invocationStatus === undefined);
      assert.equal(net.calls.includes('tools/call'), false);
    }
  });
});

test('fresh ARM mapping, policy, ownership, identity and pagination drift block the call', async t => {
  const expected = {
    'wrong tool name': ['tool', 'display-name'],
    'wrong operation': ['operation', 'method'],
    'wrong path': ['operation', 'path'],
    'parameter injection': ['operation', 'template-parameters'],
    'body injection': ['operation', 'representations'],
    'backend drift': ['rest-api', 'backend'],
    'owner drift': ['rest-api', 'owner'],
    'API policy drift': ['native-policy', 'policy'],
    'SSE transport': ['native-api', 'transport'],
    'federation configured': ['native-api', 'federation'],
    'federation router enabled': ['native-api', 'federation-router'],
    'unknown native metadata': ['native-api', 'metadata-shape'],
    'non-null native endpoints': ['native-api', 'endpoints'],
    'foreign full ID suffix': ['tool', 'operation-reference'],
  };
  const changes = {
    'wrong service prefix': f => { f.outputs.get(f.toolPath).properties.operationId = `/${f.operationPath}`.replace('/apis/', '/unrelated/apis/'); },
    'foreign full ID suffix': f => { f.outputs.get(f.toolPath).properties.operationId = `${serviceResourceId(f.cfg).replace(f.cfg.azure.apimName, 'foreign')}/${f.operationPath}`; },
    'foreign resource identity': f => { f.outputs.get(f.toolPath).id += '/extra'; },
    'wrong tool name': f => { f.outputs.get(f.toolPath).properties.displayName = 'other'; },
    'non-MCP API': f => { f.outputs.get(`apis/${f.apiId}`).properties.type = 'http'; },
    'passthrough backend': f => { f.outputs.get(`apis/${f.apiId}`).properties.serviceUrl = 'https://external.example.com/mcp'; },
    'SSE transport': f => { f.outputs.get(`apis/${f.apiId}`).properties.mcpProperties = { transportType: 'sse' }; },
    'unknown transport': f => { f.outputs.get(`apis/${f.apiId}`).properties.mcpProperties = { transportType: 'unknown' }; },
    'null transport': f => { f.outputs.get(`apis/${f.apiId}`).properties.mcpProperties = { transportType: null }; },
    'passthrough endpoints without transport': f => { f.outputs.get(`apis/${f.apiId}`).properties.mcpProperties = { endpoints: [{ uriTemplate: '/external' }] }; },
    'passthrough endpoints with transport': f => { f.outputs.get(`apis/${f.apiId}`).properties.mcpProperties = { transportType: 'streamable', endpoints: [{ uriTemplate: '/external' }] }; },
    'malformed MCP properties': f => { f.outputs.get(`apis/${f.apiId}`).properties.mcpProperties = []; },
    'federation configured': f => { f.outputs.get(`apis/${f.apiId}`).properties.mcpProperties.federation = {}; },
    'federation router enabled': f => { f.outputs.get(`apis/${f.apiId}`).properties.mcpProperties.isFederationRouter = true; },
    'invalid federation router flag': f => { f.outputs.get(`apis/${f.apiId}`).properties.mcpProperties.isFederationRouter = null; },
    'unknown native metadata': f => { f.outputs.get(`apis/${f.apiId}`).properties.mcpProperties.futureRouting = false; },
    'non-null native endpoints': f => { f.outputs.get(`apis/${f.apiId}`).properties.mcpProperties.endpoints = []; },
    'wrong operation': f => { f.outputs.get(f.operationPath).properties.method = 'POST'; },
    'wrong path': f => { f.outputs.get(f.operationPath).properties.urlTemplate = '/posts/2'; },
    'parameter injection': f => { f.outputs.get(f.operationPath).properties.templateParameters = [{ name: 'url' }]; },
    'body injection': f => { f.outputs.get(f.operationPath).properties.request.representations = [{ contentType: 'application/json' }]; },
    'backend drift': f => { f.outputs.get(`apis/${f.apiId}-rest`).properties.serviceUrl = 'https://other.example.com'; },
    'owner drift': f => { f.outputs.get(`apis/${f.apiId}-rest`).properties.description = 'Foreign owner'; },
    'API policy drift': f => { f.outputs.get(`apis/${f.apiId}/policies/policy`).properties.value = passthrough; },
    'operation policy drift': f => { f.outputs.set(`${f.operationPath}/policies`, list([{ properties: { value: passthrough } }])); },
    'global policy drift': f => { f.outputs.set('policies', list([{ properties: { value: '<policies />' } }])); },
    'diagnostic body capture': f => { f.outputs.set('diagnostics', list([{ properties: { backend: { response: { body: { bytes: 100 } } } } }])); },
    'incomplete diagnostics': f => { f.outputs.set('diagnostics', { value: [], nextLink: 'https://management.azure.com/more' }); },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
    const f = await fixture(t), approval = await planMcpProjectProof(f.dir, f.selection);
    change(f);
    f.dependencies.calls.length = 0;
    await assert.rejects(execute(f, approval), error => {
      assert.equal(error.diagnostics.proofStage, 'mapping-check');
      if (expected[name]) assert.deepEqual([error.diagnostics.resource, error.diagnostics.predicate], expected[name]);
      return true;
    });
    assert.equal(f.dependencies.calls.includes('tools/call'), false);
  });
});

test('re-list drift, wrong Azure account, cancellation and late project drift never send a tool call', async t => {
  for (const mode of ['re-list', 'account', 'cancel', 'late-drift']) await t.test(mode, async t => {
    const f = await fixture(t), approval = await planMcpProjectProof(f.dir, f.selection), controller = new AbortController();
    if (mode === 're-list') f.tools.tools[0].description = 'Metadata changed';
    const runAzure = async (...args) => {
      if (mode === 'account') return { id: f.input.azure.subscriptionId, tenantId: f.input.azure.tenantId,
        user: { ...mockAzureUser, name: 'other@example.com' } };
      const result = await f.runAzure(...args);
      if (mode === 'cancel') controller.abort();
      if (mode === 'late-drift' && args[1][0] === 'rest') await save(f.historyFile, { ...f.history, status: 'failed-uncertain' });
      return result;
    };
    f.dependencies.calls.length = 0;
    await assert.rejects(execute(f, approval, { signal: controller.signal }, f.dependencies, runAzure));
    assert.equal(f.dependencies.calls.includes('tools/call'), false);
    if (mode === 're-list') assert.equal(f.calls.length, 0);
  });
});

test('lost mapped proof response remains unknown and blocks changed-plan attempts without replay', async t => {
  const f = await fixture(t), approval = await planMcpProjectProof(f.dir, f.selection);
  const original = f.dependencies.mcpTransport;
  let sent = 0;
  const dependencies = { ...f.dependencies, mcpTransport: async (url, options) => {
    if (JSON.parse(options.body).method === 'tools/call') { sent++; throw Error('lost response'); }
    return original(url, options);
  } };
  const result = await execute(f, approval, {}, dependencies);
  assert.equal(result.result.status, 'unknown');
  assert.equal(sent, 1);
  f.selection.safetyReview.reason += ' Reviewed again.';
  const revised = await planMcpProjectProof(f.dir, f.selection);
  await assert.rejects(execute(f, revised), { code: 'PROOF_OUTCOME_UNRESOLVED' });
  assert.equal(sent, 1);
});

test('denied or exhausted ARM reads retain safe diagnostics, no call and no automatic phase retry', async t => {
  for (const code of ['AZURE_PERMISSION_DENIED', 'AZURE_CLI_TRANSIENT_TRANSPORT']) await t.test(code, async t => {
    const f = await fixture(t), approval = await planMcpProjectProof(f.dir, f.selection);
    let reads = 0;
    const runAzure = async (...args) => {
      if (args[1][0] === 'rest') {
        reads++;
        throw Object.assign(new Error('RAW-DIAGNOSTIC-MUST-NOT-PERSIST'), { code });
      }
      return f.runAzure(...args);
    };
    f.dependencies.calls.length = 0;
    await assert.rejects(execute(f, approval, {}, f.dependencies, runAzure), { code, message: code });
    assert.equal(reads, 1);
    assert.equal(f.dependencies.calls.includes('tools/call'), false);
    const [attempt] = await readdir(path.join(f.dir, '.mcp-observations'));
    const failure = await readFile(path.join(f.dir, '.mcp-observations', attempt, 'failure.json'), 'utf8');
    assert.equal(JSON.parse(failure).errorCode, code);
    assert.doesNotMatch(failure, /RAW-DIAGNOSTIC/);
    const replanned = await planMcpProjectProof(f.dir, f.selection);
    assert.equal(replanned.proofHistory.attempts[0].status, 'not-dispatched');
    await assert.rejects(execute(f, approval), { code: 'APPROVAL_REQUIRED' });
    assert.equal(reads, 1);
  });
});

test('CLI requires explicit cloud opt-in, then forwards the exact reviewed mapped proof', async t => {
  const f = await fixture(t), approval = await planMcpProjectProof(f.dir, f.selection);
  const selectionFile = path.join(f.root, 'selection.json');
  await save(selectionFile, f.selection);
  let executions = 0;
  const dependencies = { onMcpDeviceCode() {}, runAzure: f.runAzure,
    mcpProjectOperation: async (dir, options, proof) => {
      executions++;
      assert.equal(dir, f.dir); assert.equal(proof, true); assert.equal(options.allowCloud, true);
      return execute(f, options.approval);
    } };
  const args = ['mcp-proof', '--project', f.dir, '--config', selectionFile, '--approve', approval.approvalDigest, '--allow-network', '--json'];
  assert.notEqual(await main(args, dependencies), 0);
  assert.equal(executions, 0);
  assert.equal(await main([...args, '--allow-cloud'], dependencies), 0);
  assert.equal(executions, 1);
  assert.equal((await readdir(path.join(f.dir, '.mcp-observations'))).length, 1);
});

test('native failure diagnostics survive the real verifier, wrapper and CLI without raw payloads or journal changes', async t => {
  const privateValue = 'PRIVATE-POLICY-TOKEN-PAYLOAD-NEVER-OUTPUT';
  const cases = [
    { name: 'malformed ARM JSON', stage: 'arm-parse', cause: 'SYNTAX_ERROR',
      read: () => ({ stdout: `{"private":"${privateValue}`, code: 0 }) },
    { name: 'failed result envelope', stage: 'arm-parse', cause: 'CONTROL_VALIDATION',
      read: () => ({ stdout: privateValue, code: 1 }) },
    { name: 'permission denial', stage: 'arm-read', cause: 'AZURE_PERMISSION_DENIED', code: 'AZURE_PERMISSION_DENIED',
      read: () => { throw Object.assign(new Error(privateValue), { code: 'AZURE_PERMISSION_DENIED', diagnostics: { raw: privateValue } }); } },
    { name: 'unknown error code', stage: 'arm-read', kind: 'unclassified',
      read: () => { throw Object.assign(new Error(privateValue), { code: 'APIM_PRIVATE_TOKEN_PAYLOAD', diagnostics: { raw: privateValue } }); } },
    { name: 'local filesystem classification', stage: 'arm-read', cause: 'EACCES',
      read: () => { throw Object.assign(new Error(privateValue), { code: 'EACCES', path: privateValue }); } },
    { name: 'identity JSON parse', stage: 'azure-identity', cause: 'SYNTAX_ERROR', identity: true,
      read: () => ({ stdout: `{${privateValue}`, code: 0 }) },
    { name: 'tool description drift', stage: 'mapping-check', resource: 'tool', predicate: 'description', cause: 'APIM_PROOF_MAPPING_MISMATCH',
      change: f => { f.outputs.get(f.toolPath).properties.description = privateValue; } },
    { name: 'text federation diagnostic', stage: 'mapping-check', resource: 'native-api', predicate: 'federation-router',
      cause: 'APIM_PROOF_MAPPING_MISMATCH', text: true,
      change: f => { f.outputs.get(`apis/${f.apiId}`).properties.mcpProperties.isFederationRouter = true; } },
  ];
  for (const item of cases) await t.test(item.name, async t => {
    const f = await fixture(t), approval = await planMcpProjectProof(f.dir, f.selection);
    item.change?.(f);
    const selectionFile = path.join(f.root, 'diagnostic-selection.json');
    await save(selectionFile, f.selection);
    let inspected = 0;
    const runAzure = async (...args) => {
      if (item.read && (args[1][0] === 'account') === Boolean(item.identity)) {
        inspected++;
        return item.read();
      }
      return f.runAzure(...args);
    };
    const stdout = [], stderr = [];
    const out = t.mock.method(process.stdout, 'write', chunk => { stdout.push(String(chunk)); return true; });
    const err = t.mock.method(process.stderr, 'write', chunk => { stderr.push(String(chunk)); return true; });
    let exit;
    try {
      exit = await main(['mcp-proof', '--project', f.dir, '--config', selectionFile,
        '--approve', approval.approvalDigest, '--allow-network', '--allow-cloud', ...(item.text ? [] : ['--json'])],
      { onMcpDeviceCode() {}, mcpProjectOperation: async (dir, options) => {
        try { return await execute(f, options.approval, {}, f.dependencies, runAzure); }
        catch (error) {
          error.diagnostics.raw = privateValue;
          throw error;
        }
      } });
    } finally { out.mock.restore(); err.mock.restore(); }
    assert.equal(exit, 1);
    const text = stdout.join('') + stderr.join('');
    assert.doesNotMatch(text, /PRIVATE|opaque-mocked|MOCK-ONLY|<policies|access_token|Bearer/);
    if (!item.text) {
      const result = JSON.parse(stdout.join(''));
      assert.equal(result.error, item.code ?? 'APIM_PROOF_MAPPING_MISMATCH');
      assert.deepEqual(result.diagnostics, {
        proofStage: item.stage, resource: item.resource ?? 'global-policy',
        failureKind: item.kind ?? (item.cause === 'SYNTAX_ERROR' ? 'invalid-json'
          : item.cause === 'EACCES' ? 'filesystem' : item.predicate ? 'mismatch' : 'classified-error'),
        ...(item.predicate ? { predicate: item.predicate } : {}), ...(item.cause ? { causeCode: item.cause } : {}),
      });
      assert.match(result.checkpoint, /before another device sign-in/);
    } else {
      assert.match(stderr.join(''), /mapping-check\/native-api\/federation-router/);
      assert.match(stderr.join(''), /Diagnostics:.*"proofStage":"mapping-check"/);
    }
    if (item.read) assert.equal(inspected, 1);
    assert.equal(f.dependencies.calls.includes('tools/call'), false);
    const [attempt] = await readdir(path.join(f.dir, '.mcp-observations'));
    const attemptDir = path.join(f.dir, '.mcp-observations', attempt);
    const failure = JSON.parse(await readFile(path.join(attemptDir, 'failure.json'), 'utf8'));
    assert.deepEqual(Object.keys(failure).sort(), ['schemaVersion', 'status', 'errorCode', 'finishedAt',
      'intentDigest', 'dispatchContract', 'failureDigest', 'diagnostics'].sort());
    assert.ok(failure.diagnostics.proofStage);
    assert.equal(failure.status, 'not-dispatched');
    for (const name of await readdir(attemptDir)) assert.doesNotMatch(await readFile(path.join(attemptDir, name), 'utf8'), /PRIVATE-POLICY-TOKEN/);
    const replanned = await planMcpProjectProof(f.dir, f.selection);
    assert.equal(replanned.proofHistory.attempts[0].status, 'not-dispatched');
    await assert.rejects(execute(f, approval), { code: 'APPROVAL_REQUIRED' });
  });
});

test('native diagnostic allowlists strip extras, reject invented labels and preserve unknown invocation provenance', () => {
  const context = { proofStage: 'readback-persist', resource: 'project' };
  const failure = nativeProofFailure(Object.assign(new Error('PRIVATE'), { code: 'ENOSPC', invocationStatus: 'unknown',
    diagnostics: { proofStage: 'PRIVATE', resource: 'PRIVATE', failureKind: 'PRIVATE' } }), context);
  assert.equal(failure.invocationStatus, 'unknown');
  assert.deepEqual(failure.diagnostics, { ...context, failureKind: 'filesystem', causeCode: 'ENOSPC' });
  assert.doesNotMatch(JSON.stringify(failure), /PRIVATE/);
  assert.deepEqual(sanitizeNativeProofDiagnostics({ ...failure.diagnostics, token: 'PRIVATE', payload: 'PRIVATE' }), failure.diagnostics);
  for (const code of ['METADATA_STALE', 'METADATA_SELECTION', 'AZURE_IDENTITY_REQUIRED', 'ABORTED', 'PROOF_REPLAY_BLOCKED']) {
    const preserved = nativeProofFailure(Object.assign(new Error('PRIVATE'), { code }), { proofStage: 'project-guard', resource: 'project' });
    assert.equal(preserved.code, code);
    assert.equal(preserved.diagnostics.causeCode, code);
  }
  for (const extra of [{ proofStage: 'PRIVATE' }, { resource: 'PRIVATE' }, { predicate: 'PRIVATE' },
    { causeCode: 'APIM_PRIVATE_TOKEN' }, { failureKind: 'PRIVATE' }]) {
    assert.equal(sanitizeNativeProofDiagnostics({ ...failure.diagnostics, ...extra }), undefined);
  }
});

async function legacyTimeoutAttempt(f) {
  const { receiptDigest, ...capture } = f.selection.capture;
  capture.capturedAt = new Date(Date.now() - 1200000).toISOString();
  f.selection.capture = boundedSnapshot({ ...capture, receiptDigest: metadataDigest(boundedSnapshot(capture)) });
  const { approvalDigest, executionVersion, proofHistory, ...oldPlan } = await planMcpProjectProof(f.dir, f.selection);
  const original = boundedSnapshot({ ...oldPlan, approvalDigest: metadataDigest(boundedSnapshot(oldPlan)) });
  const dir = path.join(f.dir, '.mcp-observations', '99999999-9999-4999-8999-999999999999');
  await mkdir(dir, { recursive: true });
  const started = Date.now() - 610000;
  const intent = { schemaVersion: 1, approvalDigest: original.approvalDigest,
    action: 'standalone-mcp-project-proof', status: 'started', startedAt: new Date(started).toISOString(),
    reviewDigest: original.reviewDigest, operationDigest: original.operation.approvalDigest };
  const failure = { schemaVersion: 1, status: 'unknown-no-replay', errorCode: 'AUTHENTICATION_TIMEOUT',
    finishedAt: new Date(started + 602442).toISOString() };
  await save(path.join(dir, 'intent.json'), intent);
  await save(path.join(dir, 'failure.json'), failure);
  return { dir, intent, failure, original };
}

test('actual wrapped device authentication expiry records not-dispatched evidence and requires fresh approval before one call', async t => {
  const f = await fixture(t), approval = await planMcpProjectProof(f.dir, f.selection);
  f.dependencies.calls.length = 0;
  const pending = { ...f.dependencies, authTimeoutMs: 2000, authTransport: async (url, options) => {
    if (new URL(url).pathname.endsWith('/token')) return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 });
    return f.dependencies.authTransport(url, options);
  } };
  await assert.rejects(execute(f, approval, {}, pending), error => {
    assert.equal(error.code, 'AUTHENTICATION_TIMEOUT');
    assert.deepEqual(error.diagnostics, { authStage: 'token', failureKind: 'timeout' });
    return true;
  });
  assert.equal(f.calls.length, 0);
  assert.equal(f.dependencies.calls.includes('initialize'), false);
  assert.equal(f.dependencies.calls.filter(value => value.endsWith('/devicecode')).length, 1);
  const [id] = await readdir(path.join(f.dir, '.mcp-observations'));
  const dir = path.join(f.dir, '.mcp-observations', id);
  const rawFailure = await readFile(path.join(dir, 'failure.json'), 'utf8'), failure = JSON.parse(rawFailure);
  assert.equal(failure.schemaVersion, 3);
  assert.equal(failure.status, 'not-dispatched');
  assert.equal(failure.dispatchContract, 'write-ahead-tools-call-v1');
  assert.deepEqual((await readdir(dir)).sort(), ['failure.json', 'intent.json']);
  const fresh = await planMcpProjectProof(f.dir, f.selection);
  assert.notEqual(fresh.approvalDigest, approval.approvalDigest);
  assert.equal(fresh.proofHistory.attempts[0].evidence, 'write-ahead-dispatch-contract');
  await assert.rejects(execute(f, approval), { code: 'APPROVAL_REQUIRED' });
  const completed = await execute(f, fresh);
  assert.equal(completed.result.status, 'protocol-success');
  assert.ok((await readdir(completed.outputDir)).includes('dispatch.json'));
  assert.equal(f.dependencies.calls.filter(value => value === 'tools/call').length, 1);
  assert.equal(f.dependencies.calls.filter(value => value.endsWith('/devicecode')).length, 2);
  assert.equal(await readFile(path.join(dir, 'failure.json'), 'utf8'), rawFailure);
  await assert.rejects(execute(f, await planMcpProjectProof(f.dir, f.selection)), { code: 'PROOF_REPLAY_BLOCKED' });
});

test('exact legacy expired-auth journal is preserved and can restart once under a fresh history-bound approval', async t => {
  const f = await fixture(t), old = await legacyTimeoutAttempt(f);
  const intentBytes = await readFile(path.join(old.dir, 'intent.json'), 'utf8');
  const failureBytes = await readFile(path.join(old.dir, 'failure.json'), 'utf8');
  const plan = await planMcpProjectProof(f.dir, f.selection);
  assert.equal(plan.proofHistory.attempts[0].evidence, 'legacy-authentication-timeout');
  assert.notEqual(plan.approvalDigest, old.original.approvalDigest);
  await assert.rejects(execute(f, old.original), { code: 'APPROVAL_REQUIRED' });
  const completed = await execute(f, plan);
  assert.equal(completed.result.status, 'protocol-success');
  assert.equal(f.dependencies.calls.filter(value => value === 'tools/call').length, 1);
  assert.equal(await readFile(path.join(old.dir, 'intent.json'), 'utf8'), intentBytes);
  assert.equal(await readFile(path.join(old.dir, 'failure.json'), 'utf8'), failureBytes);
  assert.deepEqual((await readdir(old.dir)).sort(), ['failure.json', 'intent.json']);
  const retry = await planMcpProjectProof(f.dir, f.selection);
  await assert.rejects(execute(f, retry), { code: 'PROOF_REPLAY_BLOCKED' });
  f.selection.safetyReview.reason += ' Additional review.';
  const changed = await planMcpProjectProof(f.dir, f.selection);
  assert.equal(changed.proofHistory.attempts.find(item => item.attemptId === path.basename(old.dir)).status, 'not-dispatched');
});

test('legacy auth recovery rejects mismatched, missing, post-dispatch and conflicting evidence without network', async t => {
  for (const mode of ['approval', 'operation', 'review', 'error-code', 'extra-field', 'timestamp',
    'missing-failure', 'dispatch', 'mapping', 'unknown-result']) await t.test(mode, async t => {
    const f = await fixture(t), old = await legacyTimeoutAttempt(f);
    if (['approval', 'operation', 'review'].includes(mode)) {
      const field = { approval: 'approvalDigest', operation: 'operationDigest', review: 'reviewDigest' }[mode];
      await save(path.join(old.dir, 'intent.json'), { ...old.intent, [field]: `sha256:${'0'.repeat(64)}` });
    }
    if (mode === 'error-code') await save(path.join(old.dir, 'failure.json'), { ...old.failure, errorCode: 'DISCOVERY_TIMEOUT' });
    if (mode === 'extra-field') await save(path.join(old.dir, 'failure.json'), { ...old.failure, invocationStatus: 'unknown' });
    if (mode === 'timestamp') await save(path.join(old.dir, 'failure.json'), { ...old.failure, finishedAt: old.intent.startedAt });
    if (mode === 'missing-failure') await rm(path.join(old.dir, 'failure.json'));
    if (mode === 'dispatch') await save(path.join(old.dir, 'dispatch.json'), { schemaVersion: 1, state: 'sent' });
    if (mode === 'mapping') await save(path.join(old.dir, 'mapping-readback.json'), { schemaVersion: 1 });
    if (mode === 'unknown-result') {
      const result = { schemaVersion: 1, kind: 'standalone-mcp-read-only-proof',
        approvalDigest: old.intent.operationDigest, status: 'unknown' };
      await save(path.join(old.dir, 'proof.json'), { ...result, receiptDigest: metadataDigest(boundedSnapshot(result)) });
    }
    const plan = await planMcpProjectProof(f.dir, f.selection), before = f.dependencies.calls.length;
    assert.equal(plan.proofHistory.attempts[0].status, 'unresolved');
    await assert.rejects(execute(f, plan), { code: 'PROOF_OUTCOME_UNRESOLVED' });
    assert.equal(f.dependencies.calls.length, before); assert.equal(f.calls.length, 0);
  });
});

test('recovery approval binds unchanged evidence; a new not-dispatched record cannot override a dispatch marker', async t => {
  const f = await fixture(t), old = await legacyTimeoutAttempt(f);
  const plan = await planMcpProjectProof(f.dir, f.selection);
  await save(path.join(old.dir, 'failure.json'), { ...old.failure,
    finishedAt: new Date(Date.parse(old.failure.finishedAt) + 1).toISOString() });
  await assert.rejects(execute(f, plan), { code: 'APPROVAL_REQUIRED' });
  const fresh = await planMcpProjectProof(f.dir, f.selection), controller = new AbortController();
  await assert.rejects(execute(f, fresh, { onDeviceCode() { controller.abort(); }, signal: controller.signal }), { code: 'ABORTED' });
  const [attempt] = (await readdir(path.join(f.dir, '.mcp-observations'))).filter(id => id !== path.basename(old.dir));
  const dir = path.join(f.dir, '.mcp-observations', attempt);
  const failure = JSON.parse(await readFile(path.join(dir, 'failure.json'), 'utf8'));
  assert.equal(failure.status, 'not-dispatched');
  await save(path.join(dir, 'dispatch.json'), { schemaVersion: 1, state: 'possibly-sent' });
  const blocked = await planMcpProjectProof(f.dir, f.selection);
  await assert.rejects(execute(f, blocked), { code: 'PROOF_OUTCOME_UNRESOLVED' });
  assert.equal(f.dependencies.calls.includes('tools/call'), false);
});

test('post-dispatch timeouts remain unknown even when an error carries the authentication-timeout label', async t => {
  for (const authLabel of [false, true]) await t.test(authLabel ? 'misleading label' : 'protocol timeout', async t => {
    const f = await fixture(t), plan = await planMcpProjectProof(f.dir, f.selection);
    let sent = 0;
    const transport = { ...f.dependencies, mcpTransport: async (url, options) => {
      if (JSON.parse(options.body).method === 'tools/call') {
        sent++;
        throw authLabel ? Object.assign(new Error('AUTHENTICATION_TIMEOUT'), {
          name: 'AnonymousMetadataError', code: 'AUTHENTICATION_TIMEOUT',
        }) : new Error('Probe timeout.');
      }
      return f.dependencies.mcpTransport(url, options);
    } };
    const result = await execute(f, plan, {}, transport);
    assert.equal(result.result.status, 'unknown');
    assert.equal(result.result.errorCode, authLabel ? 'AUTHENTICATION_TIMEOUT' : 'DISCOVERY_TIMEOUT');
    assert.equal(sent, 1);
    await assert.rejects(execute(f, await planMcpProjectProof(f.dir, f.selection)), { code: 'PROOF_OUTCOME_UNRESOLVED' });
    assert.equal(sent, 1);
  });
});

test('new pre-dispatch evidence with a bad digest, changed intent, conflict or missing final failure is blocked', async t => {
  const f = await fixture(t), controller = new AbortController();
  const plan = await planMcpProjectProof(f.dir, f.selection);
  await assert.rejects(execute(f, plan, { onDeviceCode() { controller.abort(); }, signal: controller.signal }), { code: 'ABORTED' });
  const [id] = await readdir(path.join(f.dir, '.mcp-observations'));
  const dir = path.join(f.dir, '.mcp-observations', id);
  const intent = JSON.parse(await readFile(path.join(dir, 'intent.json'), 'utf8'));
  const failure = JSON.parse(await readFile(path.join(dir, 'failure.json'), 'utf8'));
  const calls = f.dependencies.calls.length;
  for (const mode of ['bad-digest', 'intent', 'extra-field', 'missing-final-record', 'null-proof', 'null-dispatch', 'null-failure']) {
    await save(path.join(dir, 'intent.json'), intent);
    await save(path.join(dir, 'failure.json'), failure);
    for (const file of ['proof.json', 'dispatch.json']) await rm(path.join(dir, file), { force: true });
    if (mode === 'bad-digest') await save(path.join(dir, 'failure.json'), { ...failure, errorCode: 'AUTHENTICATION_TIMEOUT' });
    if (mode === 'intent') await save(path.join(dir, 'intent.json'), { ...intent, operationDigest: `sha256:${'0'.repeat(64)}` });
    if (mode === 'extra-field') await save(path.join(dir, 'failure.json'), { ...failure, invocationStatus: 'unknown' });
    if (mode === 'missing-final-record') await rm(path.join(dir, 'failure.json'));
    if (mode.startsWith('null-')) await save(path.join(dir, `${mode.slice(5)}.json`), null);
    await assert.rejects(async () => execute(f, await planMcpProjectProof(f.dir, f.selection)),
      { code: mode.startsWith('null-') ? 'METADATA_MISMATCH' : 'PROOF_OUTCOME_UNRESOLVED' });
    assert.equal(f.dependencies.calls.length, calls);
  }
});

test('unsupported execution versions cannot reinterpret a completed proof or bypass unresolved history', async t => {
  const f = await fixture(t);
  const result = await execute(f, await planMcpProjectProof(f.dir, f.selection));
  const filename = path.join(result.outputDir, 'intent.json');
  const intent = JSON.parse(await readFile(filename, 'utf8'));
  await save(filename, { ...intent, executionVersion: 99 });
  f.selection.safetyReview.reason += ' Additional review.';
  await assert.rejects(execute(f, await planMcpProjectProof(f.dir, f.selection)), { code: 'PROOF_OUTCOME_UNRESOLVED' });
  assert.equal(f.dependencies.calls.filter(value => value === 'tools/call').length, 1);
});
