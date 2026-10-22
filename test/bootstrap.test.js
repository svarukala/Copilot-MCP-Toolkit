import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { TOOLKIT_ROOT } from '../src/config.js';
import { compileBootstrap, planBootstrap, writeBootstrap } from '../src/mcp-bootstrap.js';
const tenant = '11111111-1111-4111-8111-111111111111';
const subscription = '22222222-2222-4222-8222-222222222222';
function input() {
  return { schemaVersion: 1, recipe: 'container-apps-direct-v1',
    target: { tenantId: tenant, subscriptionId: subscription, accountName: 'owner@example.com', location: 'eastus' },
    resources: Object.fromEntries(Object.entries({ resourceGroup: 'synthetic-rg', environment: 'synthetic-env',
      registry: 'syntheticregistry', vault: 'synthetic-vault', pullIdentity: 'synthetic-pull', secretIdentity: 'synthetic-reader' })
      .map(([key, name]) => [key, { mode: 'new', name }])),
    discoveryClient: { mode: 'new', displayName: 'Synthetic discovery' },
    resourceApplication: { displayName: 'Synthetic MCP API', scope: 'access_as_user' },
    review: { privateIdentityRequired: true, newResourceAbsenceMustBeChecked: true } };
}
test('all-new bootstrap produces separate resource and directory phases without invented IDs or secrets', () => {
  const result = compileBootstrap(input());
  assert.equal(result.resourceGroupTemplate.resources.length, 1);
  assert.equal(result.resourceTemplate.resources.length, 5);
  assert.equal(result.resourceSetup.status, 'awaiting-actual-discovery-client-id');
  assert.equal(result.discoveryClientSetup.application.kind, 'discovery-client');
  assert.ok(result.permissionIntents.every(p => p.principalId === null));
  const vault = result.resourceTemplate.resources.find(r => r.type === 'Microsoft.KeyVault/vaults');
  assert.equal(vault.properties.enableRbacAuthorization, true);
  assert.equal(vault.properties.enablePurgeProtection, true);
  assert.ok(!JSON.stringify(result).includes('"destination":"none"'));
});
test('existing resources are omitted from create templates and target/identity collisions fail', () => {
  const definition = input(), newResult = compileBootstrap(definition);
  for (const key of Object.keys(definition.resources)) definition.resources[key] =
    { mode: 'existing', resourceId: newResult.resourceIds[key] };
  definition.discoveryClient = { mode: 'existing', clientId: '33333333-3333-4333-8333-333333333333' };
  const result = compileBootstrap(definition);
  assert.deepEqual(result.resourceTemplate.resources, []); assert.equal(result.resourceGroupTemplate, null);
  assert.equal(result.resourceSetup.input.application.allowedClientIds[0], definition.discoveryClient.clientId);
  definition.resources.secretIdentity = definition.resources.pullIdentity;
  assert.throws(() => compileBootstrap(definition), { code: 'MCP_BOOTSTRAP_IDENTITY' });
  definition.resources.registry.resourceId = newResult.resourceIds.registry.replace(subscription, tenant);
  assert.throws(() => compileBootstrap(definition), { code: 'MCP_BOOTSTRAP_TARGET' });
});
test('bootstrap writes only a new reviewed private artifact', async t => {
  await mkdir(path.join(TOOLKIT_ROOT, '.test-output'), { recursive: true });
  const root = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { workspaceRoot: root, config: path.join(root, 'input.json'), output: path.join(root, 'bundle.json') };
  await writeFile(options.config, JSON.stringify(input()));
  const plan = await planBootstrap(options);
  await assert.rejects(writeBootstrap({ ...options, approval: 'incorrect' }));
  const written = await writeBootstrap({ ...options, approval: plan.approvalToken });
  assert.equal(written.executionReadiness, false);
  await assert.rejects(writeBootstrap({ ...options, approval: plan.approvalToken }));
});
