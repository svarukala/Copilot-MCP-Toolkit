import test from 'node:test';

import assert from 'node:assert/strict';

import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';

import path from 'node:path';

import { fileURLToPath } from 'node:url';

import { createHash } from 'node:crypto';

import { prepareMcpServer, createMcpServerProject, getMcpServerInputSchema, getLibraryInfo, prepareRestToolDocument } from 'copilot-mcp-toolkit';

import { RESTRICTED_DISCOVERY_CLIENT_ID, gatewayApiId } from '../src/contract.js';

import { buildPolicy } from '../src/azure.js';

import { ownerId } from '../src/apim-safety.js';

const root = fileURLToPath(new URL('..', import.meta.url));

const tenantId = '11111111-1111-4111-8111-111111111111';

const clientId = '22222222-2222-4222-8222-222222222222';

const subscriptionId = '33333333-3333-4333-8333-333333333333';

const serverId = '44444444-4444-4444-8444-444444444444';

const consumerId = '55555555-5555-4555-8555-555555555555';

export function serverInput() {
  const authored = prepareRestToolDocument({ title: 'Catalog', tools: [
    { name: 'read_items', description: 'List catalog items', backendPath: '/items', fixedQuery: {},
      arguments: [{ name: 'page', description: 'Page number', type: 'integer', required: false, default: 1 }] },
    { name: 'read_extra', description: 'Unselected operation', backendPath: '/extra', fixedQuery: {}, arguments: [] },
  ] });
  return { schemaVersion: 1, server: { id: serverId, name: 'Catalog' },
    azure: { apimMode: 'existing', tenantId, subscriptionId, resourceGroup: 'catalog-rg', apimName: 'catalog-apim' },
    inbound: { type: 'entra', tenantId, clientId, applicationIdUri: 'api://catalog.example.com', scope: 'access_as_user',
      allowedClientIds: [consumerId] },
    backend: { endpoint: 'https://backend.example.com', auth: 'anonymous' },
    document: authored.document, operationIds: ['read_items'] };
}

async function fixture(t) {
  await mkdir(path.join(root, '.test-output'), { recursive: true });
  const workspaceRoot = await mkdtemp(path.join(root, '.test-output', 'standalone-mcp-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  return { workspaceRoot, projectDir: path.join(workspaceRoot, 'server') };
}

test('standalone review and persisted inventory contain only independent server artifacts and selected REST operations', async t => {
  const context = await fixture(t), input = serverInput();
  const original = structuredClone(input);
  const review = await prepareMcpServer(input);
  assert.deepEqual(input, original);
  assert.equal(review.descriptor.status, 'generated-not-deployed');
  assert.deepEqual(review.descriptor.operationIds, ['read_items']);
  assert.match(review.reviewDigest, /^sha256:[a-f0-9]{64}$/);
  const gateway = JSON.parse(review.files['infra/gateway.json']);
  const spec = JSON.parse(gateway.resources.find(r => r.properties.type === 'http').properties.value);
  assert.equal(Object.keys(spec.paths).length, 1);
  assert.equal(gateway.resources.filter(r => r.type.endsWith('/tools')).length, 1);
  const policies = gateway.resources.filter(r => r.type.endsWith('/policies'));
  assert.ok(policies.every(r => r.properties.value.includes(consumerId)));
  assert.ok(policies.every(r => !r.properties.value.includes(RESTRICTED_DISCOVERY_CLIENT_ID)));
  assert.ok(policies.every(r => r.properties.value.includes('<base />')));
  assert.match(policies.find(r => r.name.includes('-rest/')).properties.value, /Authorization" exists-action="delete"/);
  assert.deepEqual(JSON.parse(review.files['infra/foundation.json']).resources, []);
  const saved = await createMcpServerProject(review, context);
  assert.equal(saved.status, 'generated-not-deployed');
  assert.deepEqual((await readdir(context.projectDir)).sort(), ['infra', 'mcp-definition.json', 'mcp-server.json']);
  for (const [filename, text] of Object.entries(review.files)) {
    assert.equal(await readFile(path.join(context.projectDir, ...filename.split('/')), 'utf8'), text);
  }
  assert.deepEqual(saved.files, Object.keys(review.files));
  await assert.rejects(createMcpServerProject(review, context), { code: 'IO' });
});

test('source, selection, authorization, target and ownership change the review; consumer metadata cannot change infrastructure', async () => {
  const input = serverInput(), baseline = await prepareMcpServer(input);
  for (const mutate of [
    x => { x.server.id = consumerId; }, x => { x.operationIds.push('read_extra'); },
    x => { x.document.info.title = 'Changed'; }, x => { x.inbound.allowedClientIds.push(RESTRICTED_DISCOVERY_CLIENT_ID); },
    x => { x.azure.subscriptionId = consumerId; }, x => { x.backend.endpoint = 'https://new.example.com'; },
  ]) {
    const changed = structuredClone(input); mutate(changed);
    assert.notEqual((await prepareMcpServer(changed)).reviewDigest, baseline.reviewDigest);
  }
  const anonymous = baseline.files['infra/gateway.json'];
  for (const auth of ['api-key', 'entra']) {
    const changed = structuredClone(input);
    changed.backend.auth = auth;
    if (auth === 'api-key') {
      changed.azure.keyVaultName = 'catalog-vault';
      changed.backend.apiKey = { secretIdentifier: 'https://catalog-vault.vault.azure.net/secrets/backend', headerName: 'X-Api-Key' };
    }
    const next = await prepareMcpServer(changed);
    assert.notEqual(next.files['infra/gateway.json'], anonymous);
    if (auth === 'api-key') {
      assert.match(next.files['infra/gateway.json'], /secretIdentifier/);
      assert.match(next.files['infra/secret-access.json'], /vaults\/secrets/);
    } else {
      assert.doesNotMatch(next.files['infra/gateway.json'], /Authorization\\?" exists-action=\\?"delete/);
    }
  }
});

test('invalid input, changed reviews, unsafe paths and pre-abort never create a project', async t => {
  const context = await fixture(t), review = await prepareMcpServer(serverInput());
  for (const mutate of [
    x => { delete x.inbound; }, x => { x.inbound.allowedClientIds = []; },
    x => { x.inbound.type = 'anonymous'; }, x => { x.inbound.tenantId = consumerId; },
    x => { x.plugin = {}; }, x => { x.backend.auth = 'oauth'; },
    x => { x.backend.apiKey = { value: 'not-allowed' }; },
    x => { x.backend.endpoint = 'https://user:password@example.com'; },
    x => { x.document.paths['/escape'] = { $ref: 'https://example.com/external.json' }; },
    x => { x.operationIds = ['invented']; },
  ]) {
    const input = serverInput(); mutate(input);
    await assert.rejects(prepareMcpServer(input), { name: 'McpToolkitError' });
  }
  const changed = structuredClone(review); changed.files['infra/gateway.json'] = '{}';
  await assert.rejects(createMcpServerProject(changed, context), /review changed/);
  await assert.rejects(createMcpServerProject(review, { ...context, signal: AbortSignal.abort() }), { code: 'ABORTED' });
  await assert.rejects(createMcpServerProject(review, { ...context, projectDir: path.dirname(context.workspaceRoot) }));
  assert.deepEqual(await readdir(context.workspaceRoot), []);
  await mkdir(path.join(context.workspaceRoot, 'other'));
  await symlink(path.join(context.workspaceRoot, 'other'), path.join(context.workspaceRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createMcpServerProject(review, { ...context, projectDir: path.join(context.workspaceRoot, 'linked', 'server') }));
});

test('package metadata covers independent CLI assets without exporting cloud execution through the library', async () => {
  const info = await getLibraryInfo();
  assert.equal(info.mcpServerContractVersion, 1);
  assert.ok(info.files.includes('src/mcp-server.js'));
  assert.ok(info.files.includes('src/apim-renderer.js'));
  assert.ok(info.files.includes('src/apim-managed-identity.js'));
  assert.ok(info.files.includes('src/azure.js'));
  assert.ok(info.files.includes('src/azure-identity.js'));
  const api = await import('copilot-mcp-toolkit');
  assert.equal(api.provisionProject, undefined);
  assert.equal(api.prepareCoworkMcpConnector, undefined);
  const schema = getMcpServerInputSchema(); schema.properties = {};
  assert.ok(getMcpServerInputSchema().oneOf[0].properties.inbound);
});
