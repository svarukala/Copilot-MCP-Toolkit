import test from 'node:test';

import assert from 'node:assert/strict';

import path from 'node:path';

import { randomUUID } from 'node:crypto';

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { TOOLKIT_ROOT } from '../src/config.js';

import { createMcpAppWorkspace, planMcpAppAccount, switchMcpAppAccount, planMcpAppSetup, applyMcpAppSetup } from '../src/mcp-app-setup.js';

import { prepareResourceSelection, chooseMcpResources, planResourceInventory, inspectResourceInventory } from '../src/mcp-resources.js';

import { prepareMcpServer, createMcpServerProject } from '../src/mcp-server.js';

import { planMcpServerProvision, provisionMcpServer, planMcpServerReconcile, reconcileMcpServer } from '../src/mcp-lifecycle.js';

import { selectMockAzureIdentity, mockAzureUser } from './support/azure-identity.js';

import { azureCliFailure } from '../src/azure.js';

async function fixture(t) {
  await mkdir(path.join(TOOLKIT_ROOT, '.test-output'), { recursive: true });
  const root = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'mcp-automation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const definition = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples', 'mcp', 'catalog.json'), 'utf8'));
  const target = { tenantId: definition.azure.tenantId, subscriptionId: definition.azure.subscriptionId, accountName: mockAzureUser.name };
  const account = { tenantId: target.tenantId, id: target.subscriptionId, user: mockAzureUser };
  const dir = path.join(root, 'app'), me = randomUUID(), calls = [];
  const request = { target, application: { mode: 'new', displayName: 'Offline fixture resource', scope: 'access_as_user', allowedClientIds: [randomUUID(), randomUUID().toUpperCase()] } };
  const cloud = { app: null, failCreate: false, duplicates: false, drift: false };
  const run = async (_, args, options) => {
    calls.push(args);
    assert.ok(options.azureConfigDir?.includes('.azure-auth'));
    if (args[0] === 'account' || args[0] === 'login') return structuredClone(account);
    assert.equal(args[0], 'rest');
    const url = args[args.indexOf('--url') + 1], method = args[args.indexOf('--method') + 1];
    if (method === 'POST') {
      const body = JSON.parse(await readFile(args[args.indexOf('--body') + 1].slice(1), 'utf8'));
      cloud.app = { ...body, id: randomUUID(), appId: randomUUID(), identifierUris: [],
        api: { oauth2PermissionScopes: [], preAuthorizedApplications: [] }, passwordCredentials: [], keyCredentials: [], requiredResourceAccess: [] };
      if (cloud.failCreate) throw new Error('Simulated timeout after accepted create');
      return structuredClone(cloud.app);
    }
    if (method === 'PATCH') {
      const body = JSON.parse(await readFile(args[args.indexOf('--body') + 1].slice(1), 'utf8'));
      for (const client of body.api?.preAuthorizedApplications ?? []) {
        if (client.delegatedPermissionIds.some(id => !cloud.app.api.oauth2PermissionScopes.some(s => s.id === id && s.isEnabled))) {
          throw azureCliFailure(1, "InvalidValue: Property api.preAuthorizedApplications.delegatedPermissionIds has a Permission Id that cannot be found in the AppPermissions sets.");
        }
      }
      if (cloud.rejectPatch) throw new Error('Simulated rejected PATCH, outcome not assumed');
      Object.assign(cloud.app, { ...body, ...(body.api ? { api: { ...cloud.app.api, ...body.api } } : {}) });
      cloud.app.api.preAuthorizedApplications?.reverse();
      for (const client of cloud.app.api.preAuthorizedApplications ?? []) client.appId = client.appId.toLowerCase();
      for (const scope of cloud.app.api?.oauth2PermissionScopes ?? []) {
        scope.userConsentDescription = null; scope.userConsentDisplayName = null;
      }
      if (cloud.failPatch) throw new Error('Simulated timeout after accepted PATCH');
      return { stdout: '', code: 0 };
    }
    assert.equal(method, 'GET');
    if (url.includes('/me?')) return { id: me };
    if (url.includes('/owners?')) return { value: [{ id: me }] };
    if (cloud.resource && url.includes(`appId='${cloud.resource.appId}'`)) return structuredClone(cloud.resource);
    if (url.includes('?$filter=')) return { value: cloud.duplicates ? [cloud.app, cloud.app] : cloud.app ? [structuredClone(cloud.app)] : [] };
    if (cloud.drift) cloud.app.identifierUris.push('api://foreign-preserved');
    return structuredClone(cloud.app);
  };
  async function init(custom = request) {
    await createMcpAppWorkspace(dir, custom);
    const login = await planMcpAppAccount(dir);
    await switchMcpAppAccount(dir, { approval: login.approvalToken, run });
  }
  async function apply(phase, resource) {
    const plan = await planMcpAppSetup(dir, { phase, resource });
    return applyMcpAppSetup(dir, { phase, resource, approval: plan.approvalToken, allowCloud: true, run });
  }
  return { root, dir, definition, target, account, calls, request, cloud, run, init, apply };
}

test('app creation/configuration are separate target-bound approvals, preserve no secrets and return exact resolved input', async t => {
  const f = await fixture(t);
  await createMcpAppWorkspace(f.dir, f.request);
  assert.equal((await planMcpAppSetup(f.dir, { phase: 'create' })).approvalToken, null);
  await assert.rejects(applyMcpAppSetup(f.dir, { phase: 'create', approval: 'ambient', allowCloud: true, run: f.run }), /approval/);
  assert.equal(f.calls.length, 0);
  const login = await planMcpAppAccount(f.dir);
  await switchMcpAppAccount(f.dir, { approval: login.approvalToken, run: f.run });
  const create = await planMcpAppSetup(f.dir, { phase: 'create' });
  assert.ok(!create.write.body.api);
  assert.equal((await f.apply('create')).status, 'created-not-configured');
  const configure = await planMcpAppSetup(f.dir, { phase: 'configure' });
  assert.notEqual(configure.approvalToken, create.approvalToken);
  assert.deepEqual(configure.write.body.api.preAuthorizedApplications, []);
  await assert.rejects(planMcpAppSetup(f.dir, { phase: 'preauthorize' }), /Preauthorization requires/);
  const scoped = await f.apply('configure');
  assert.equal(scoped.status, 'scope-configured-not-preauthorized');
  assert.equal(scoped.inbound, null);
  const preauthorize = await planMcpAppSetup(f.dir, { phase: 'preauthorize' });
  assert.notEqual(preauthorize.approvalToken, configure.approvalToken);
  assert.deepEqual(Object.keys(preauthorize.write.body.api), ['preAuthorizedApplications']);
  assert.deepEqual(preauthorize.write.body.api.preAuthorizedApplications.map(p => p.appId), f.request.application.allowedClientIds);
  await assert.rejects(applyMcpAppSetup(f.dir, { phase: 'preauthorize', approval: configure.approvalToken, allowCloud: true,
    run: () => assert.fail('Scope approval cannot preauthorize') }), /approval/);
  const result = await f.apply('preauthorize');
  assert.equal(result.status, 'configured-not-consented');
  assert.equal(result.cloudConsentGranted, false);
  assert.match(create.checkpoints.join('\n'), /does not create its home-tenant service principal/);
  assert.match(result.manual.join('\n'), /service principal/);
  assert.ok(result.manual.some(message => message.includes(f.cloud.app.appId) && message.includes(f.target.tenantId)));
  assert.equal(f.calls.some(args => args.some(value => typeof value === 'string' && value.includes('/servicePrincipals'))), false);
  assert.equal(result.inbound.clientId, f.cloud.app.appId);
  assert.equal(result.inbound.applicationIdUri, `api://${f.cloud.app.appId}`);
  assert.equal(f.calls.filter(a => a.includes('POST')).length, 1);
  assert.equal(f.calls.filter(a => a.includes('PATCH')).length, 2);
  const generated = await prepareMcpServer({ ...f.definition, inbound: result.inbound });
  assert.equal(generated.descriptor.status, 'generated-not-deployed');
  const nested = path.join(f.root, 'new-parent', 'app');
  assert.equal((await createMcpAppWorkspace(nested, f.request)).status, 'draft');
  await assert.rejects(createMcpAppWorkspace(nested, f.request), { code: 'EEXIST' });
});

test('app creation timeout requires unique intent and owner reconciliation, never display-name adoption or replay', async t => {
  const f = await fixture(t); await f.init(); f.cloud.failCreate = true;
  assert.equal((await f.apply('create')).status, 'blocked-uncertain');
  await assert.rejects(planMcpAppSetup(f.dir, { phase: 'create' }), /uncertain/);
  f.cloud.duplicates = true;
  assert.equal((await f.apply('reconcile')).status, 'blocked-uncertain');
  f.cloud.duplicates = false;
  const originalTag = f.cloud.app.tags;
  f.cloud.app.tags = ['foreign'];
  assert.equal((await f.apply('reconcile')).status, 'blocked-uncertain');
  f.cloud.app.tags = originalTag;
  assert.equal((await f.apply('reconcile')).status, 'created-not-configured');
  assert.equal((await f.apply('configure')).status, 'scope-configured-not-preauthorized');
  assert.equal((await f.apply('preauthorize')).status, 'configured-not-consented');
  assert.equal(f.calls.filter(a => a.includes('POST')).length, 1);
});

test('legacy rejected combined PATCH, including old reconciled-readback journals, requires fresh exact readback before staged approvals', async t => {
  for (const oldStatus of ['uncertain', 'reconciled-readback']) {
    const f = await fixture(t); await f.init(); await f.apply('create');
    const oldPlan = await planMcpAppSetup(f.dir, { phase: 'configure' });
    const filename = path.join(f.dir, 'mcp-app-setup.json');
    const state = JSON.parse(await readFile(filename, 'utf8'));
    const oldBody = structuredClone(oldPlan.write.body);
    oldBody.api.preAuthorizedApplications = f.request.application.allowedClientIds.map(appId =>
      ({ appId, delegatedPermissionIds: [state.scopeId] }));
    const payload = path.join(f.dir, 'old-combined-body.json');
    await writeFile(payload, JSON.stringify(oldBody));
    await assert.rejects(f.run('az', ['rest', '--method', 'PATCH', '--url', oldPlan.write.resource, '--body', `@${payload}`],
      { azureConfigDir: path.join(f.dir, '.azure-auth') }), { code: 'GRAPH_PREAUTH_SCOPE_UNRESOLVED' });
    assert.deepEqual(f.cloud.app.identifierUris, []);
    state.attempts.push({ id: randomUUID(), phase: 'configure', status: oldStatus, writeStatus: 'submitted',
      approval: 'mcp-app/old-consumed-digest', startedAt: new Date().toISOString() });
    if (oldStatus === 'reconciled-readback') state.attempts.push({ id: randomUUID(), phase: 'reconcile', status: 'completed' });
    await writeFile(filename, JSON.stringify(state));
    await assert.rejects(planMcpAppSetup(f.dir, { phase: 'configure' }), /uncertain|Only a freshly/);
    const writes = f.calls.filter(a => a.includes('PATCH') || a.includes('POST')).length;
    f.cloud.app.web = { redirectUris: ['https://foreign.coworktoolkit.dev/callback'] };
    assert.equal((await f.apply('reconcile')).status, 'blocked-uncertain');
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')).application, state.application);
    delete f.cloud.app.web;
    assert.equal((await f.apply('reconcile')).status, 'created-not-configured');
    assert.equal(f.calls.filter(a => a.includes('PATCH') || a.includes('POST')).length, writes);
    const reconciled = JSON.parse(await readFile(filename, 'utf8'));
    const rejected = reconciled.attempts.find(a => a.phase === 'configure');
    assert.equal(rejected.status, 'reconciled-no-change');
    assert.equal(rejected.writeStatus, 'submitted');
    assert.equal(rejected.reconciliation.outcome, 'exact-prior-state');
    const fresh = await planMcpAppSetup(f.dir, { phase: 'configure' });
    assert.notEqual(fresh.approvalToken, oldPlan.approvalToken);
    await assert.rejects(applyMcpAppSetup(f.dir, { phase: 'configure', approval: oldPlan.approvalToken,
      allowCloud: true, run: () => assert.fail('Consumed plan') }), /approval/);
    assert.equal((await f.apply('configure')).status, 'scope-configured-not-preauthorized');
    assert.equal((await f.apply('preauthorize')).status, 'configured-not-consented');
  }
});

test('uncertain staged PATCH requires exact prior/result reconciliation, never replay of an accepted phase', async t => {
  for (const phase of ['configure', 'preauthorize']) for (const accepted of [false, true]) {
    const f = await fixture(t); await f.init(); await f.apply('create');
    if (phase === 'preauthorize') await f.apply('configure');
    const stale = await planMcpAppSetup(f.dir, { phase });
    f.cloud.failPatch = accepted; f.cloud.rejectPatch = !accepted;
    assert.equal((await f.apply(phase)).status, 'blocked-uncertain');
    await assert.rejects(planMcpAppSetup(f.dir, { phase }), /uncertain/);
    f.cloud.failPatch = false; f.cloud.rejectPatch = false;
    const writes = f.calls.filter(a => a.includes('PATCH')).length;
    const result = await f.apply('reconcile');
    assert.equal(result.status, accepted
      ? phase === 'configure' ? 'scope-configured-not-preauthorized' : 'configured-not-consented'
      : phase === 'configure' ? 'created-not-configured' : 'scope-configured-not-preauthorized');
    assert.equal(f.calls.filter(a => a.includes('PATCH')).length, writes);
    if (accepted) await assert.rejects(planMcpAppSetup(f.dir, { phase }), /Only a freshly|Preauthorization requires/);
    else {
      f.cloud.app.web = { redirectUris: ['https://foreign.coworktoolkit.dev/callback'] };
      await f.apply('inspect');
      await assert.rejects(planMcpAppSetup(f.dir, { phase }), /Only a freshly|Preauthorization requires/);
      delete f.cloud.app.web;
      await f.apply('inspect');
      const next = await planMcpAppSetup(f.dir, { phase });
      assert.notEqual(next.approvalToken, stale.approvalToken);
      assert.equal((await f.apply(phase)).status, phase === 'configure' ? 'scope-configured-not-preauthorized' : 'configured-not-consented');
    }
  }
});

test('scope/client drift cannot settle uncertainty or authorize preauthorization; exact original snapshot is retained', async t => {
  const f = await fixture(t); await f.init(); await f.apply('create');
  f.cloud.failPatch = true; await f.apply('configure'); f.cloud.failPatch = false;
  const filename = path.join(f.dir, 'mcp-app-setup.json');
  const before = JSON.parse(await readFile(filename, 'utf8')).application;
  const scope = structuredClone(f.cloud.app.api.oauth2PermissionScopes[0]);
  f.cloud.app.api.oauth2PermissionScopes[0].id = randomUUID();
  const writes = f.calls.filter(a => a.includes('PATCH')).length;
  assert.equal((await f.apply('reconcile')).status, 'blocked-uncertain');
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')).application, before);
  await assert.rejects(planMcpAppSetup(f.dir, { phase: 'preauthorize' }), /uncertain/);
  f.cloud.app.api.oauth2PermissionScopes[0] = scope;
  assert.equal((await f.apply('reconcile')).status, 'scope-configured-not-preauthorized');
  const plan = await planMcpAppSetup(f.dir, { phase: 'preauthorize' });
  f.cloud.app.api.preAuthorizedApplications = [{ appId: randomUUID(), delegatedPermissionIds: [scope.id] }];
  assert.equal((await applyMcpAppSetup(f.dir, { phase: 'preauthorize', approval: plan.approvalToken, allowCloud: true, run: f.run })).status, 'blocked-uncertain');
  assert.equal(f.calls.filter(a => a.includes('PATCH')).length, writes);
  const g = await fixture(t); await g.init(); await g.apply('create'); await g.apply('configure');
  g.cloud.app.web = { redirectUris: ['https://foreign.coworktoolkit.dev/callback'] };
  await g.apply('inspect');
  await assert.rejects(planMcpAppSetup(g.dir, { phase: 'preauthorize' }), /Preauthorization requires/);
  assert.equal(g.calls.filter(a => a.includes('PATCH')).length, 1);
});

test('preauthorization approval is invalidated by account reselection and checks the exact tenant before Graph', async t => {
  const f = await fixture(t); await f.init(); await f.apply('create'); await f.apply('configure');
  const stale = await planMcpAppSetup(f.dir, { phase: 'preauthorize' });
  await selectMockAzureIdentity(f.dir, f.definition.azure);
  await assert.rejects(applyMcpAppSetup(f.dir, { phase: 'preauthorize', approval: stale.approvalToken, allowCloud: true,
    run: () => assert.fail('Stale identity') }), /approval/);
  const plan = await planMcpAppSetup(f.dir, { phase: 'preauthorize' });
  const result = await applyMcpAppSetup(f.dir, { phase: 'preauthorize', approval: plan.approvalToken, allowCloud: true,
    run: async (_, args) => { assert.equal(args[0], 'account'); return { ...f.account, tenantId: randomUUID() }; } });
  assert.equal(result.status, 'blocked-identity');
});

test('app creation rejects wrong authenticated tenant/subscription/user before any Graph read or write', async t => {
  const f = await fixture(t); await f.init();
  for (const account of [{ ...f.account, tenantId: randomUUID() }, { ...f.account, id: randomUUID() },
    { ...f.account, user: { ...mockAzureUser, name: 'different@newtenant.invalid' } }]) {
    const plan = await planMcpAppSetup(f.dir, { phase: 'create' }), calls = [];
    const result = await applyMcpAppSetup(f.dir, { phase: 'create', approval: plan.approvalToken, allowCloud: true,
      run: async (_, args) => { calls.push(args); assert.equal(args[0], 'account'); return account; } });
    assert.equal(result.status, 'blocked-identity');
    assert.equal(f.cloud.app, null);
    assert.ok(calls.length > 0);
  }
});

test('app account switch permits an explicitly selected different user but never retargets tenant ownership', async t => {
  const f = await fixture(t); await f.init();
  const stale = await planMcpAppSetup(f.dir, { phase: 'create' });
  const requested = { ...f.target, accountName: 'reviewed-admin@newtenant.invalid' };
  await assert.rejects(planMcpAppAccount(f.dir, { accountName: requested.accountName }), /Explicit tenant/);
  await assert.rejects(planMcpAppAccount(f.dir, { ...requested, tenantId: randomUUID() }), /immutable/);
  const switchPlan = await planMcpAppAccount(f.dir, requested);
  const switchedAccount = { ...f.account, user: { type: 'user', name: requested.accountName } };
  await switchMcpAppAccount(f.dir, { requested, approval: switchPlan.approvalToken, run: async (_, args) => {
    assert.ok(['login', 'account'].includes(args[0])); return switchedAccount;
  } });
  const fresh = await planMcpAppSetup(f.dir, { phase: 'create' });
  assert.equal(fresh.identity.target.accountName, requested.accountName);
  assert.notEqual(stale.approvalToken, fresh.approvalToken);
  await assert.rejects(applyMcpAppSetup(f.dir, { phase: 'create', approval: stale.approvalToken, allowCloud: true,
    run: () => assert.fail('Old account approval cannot execute') }), /approval/);
});

test('app reuse is read-only and missing configuration has exact admin checkpoint; no foreign collections changed', async t => {
  const f = await fixture(t), clientId = randomUUID();
  f.cloud.app = { id: randomUUID(), appId: clientId, identifierUris: ['api://foreign'],
    api: { oauth2PermissionScopes: [{ id: randomUUID(), value: 'foreign', isEnabled: true }], preAuthorizedApplications: [] } };
  const original = structuredClone(f.cloud.app);
  await f.init({ target: f.target, application: { mode: 'existing', clientId, applicationIdUri: `api://${clientId}`,
    scope: 'access_as_user', allowedClientIds: f.request.application.allowedClientIds } });
  const result = await f.apply('inspect');
  assert.equal(result.status, 'blocked-manual-configuration');
  assert.ok(result.manual[0].includes(clientId));
  assert.deepEqual(f.cloud.app, original);
  await assert.rejects(planMcpAppSetup(f.dir, { phase: 'configure' }), /Only a freshly/);
  assert.equal(f.calls.filter(a => a.includes('POST') || a.includes('PATCH')).length, 0);
});

test('app denial saves actionable delegated-user checkpoint; account changes and app drift block configuration writes', async t => {
  const f = await fixture(t); await f.init();
  const plan = await planMcpAppSetup(f.dir, { phase: 'create' });
  let writes = 0;
  const result = await applyMcpAppSetup(f.dir, { phase: 'create', approval: plan.approvalToken, allowCloud: true,
    run: async (_, args, options) => {
      if (args.includes('POST')) { writes++; throw azureCliFailure(1, 'Authorization_RequestDenied: Insufficient privileges'); }
      return f.run(_, args, options);
    } });
  assert.equal(result.status, 'blocked-permission'); assert.equal(writes, 1);
  assert.match(result.instructions, /delegated Graph/);
  const resumed = await planMcpAppSetup(f.dir, { phase: 'create' });
  assert.notEqual(resumed.approvalToken, plan.approvalToken);
  assert.equal((await f.apply('create')).status, 'created-not-configured');
  const g = await fixture(t); await g.init(); await g.apply('create');
  const config = await planMcpAppSetup(g.dir, { phase: 'configure' });
  await selectMockAzureIdentity(g.dir, g.definition.azure);
  await assert.rejects(applyMcpAppSetup(g.dir, { phase: 'configure', approval: config.approvalToken, allowCloud: true, run: g.run }), /approval/);
  g.cloud.drift = true;
  assert.equal((await g.apply('configure')).status, 'blocked-uncertain');
  assert.equal(g.calls.filter(a => a.includes('PATCH')).length, 0);
});

test('resource selection supports independent create/reuse, excludes needless vault and blocks cross-RG before mutation', async t => {
  const f = await fixture(t), a = f.definition.azure, base = `/subscriptions/${a.subscriptionId}/resourceGroups/${a.resourceGroup}`;
  const keyed = { ...f.definition, azure: { ...a, location: 'eastus', sku: 'Developer', publisherName: 'Offline Publisher',
    publisherEmail: 'owner@coworktoolkit.dev' }, backend: { ...f.definition.backend, auth: 'api-key',
    apiKey: { headerName: 'X-Api-Key', secretIdentifier: `https://${a.keyVaultName ?? 'fixturevault'}.vault.azure.net/secrets/backend` } } };
  for (const apim of ['new', 'existing']) for (const vault of ['new', 'existing']) {
    const selected = await prepareResourceSelection({ definition: keyed, selection: {
      resourceGroup: { mode: 'existing', resourceId: base },
      apim: { mode: apim, resourceId: `${base}/providers/Microsoft.ApiManagement/service/${a.apimName}` },
      keyVault: { mode: vault, resourceId: `${base}/providers/Microsoft.KeyVault/vaults/${a.keyVaultName ?? 'fixturevault'}` },
    } });
    assert.equal(selected.compatibility, 'not-cloud-verified');
    assert.equal(selected.resources.cost.currencyEstimate, null);
    const review = await prepareMcpServer(selected.definition);
    const resources = JSON.parse(review.files['infra/foundation.json']).resources;
    assert.equal(resources.some(r => r.type === 'Microsoft.ApiManagement/service'), apim === 'new');
    assert.equal(resources.some(r => r.type === 'Microsoft.KeyVault/vaults'), vault === 'new');
  }
  const selection = { resourceGroup: { mode: 'existing', resourceId: base },
    apim: { mode: 'existing', resourceId: `${base}/providers/Microsoft.ApiManagement/service/${a.apimName}` },
    keyVault: { mode: 'existing', resourceId: `/subscriptions/${a.subscriptionId}/resourceGroups/elsewhere/providers/Microsoft.KeyVault/vaults/fixturevault` } };
  await assert.rejects(prepareResourceSelection({ definition: keyed, selection }), /Cross-resource-group/);
  await assert.rejects(prepareResourceSelection({ definition: f.definition, selection }), /no Key Vault/);
  let prompts = 0;
  assert.deepEqual(await chooseMcpResources(f.definition, { output: { write() {} }, choose: async () => { prompts++; return 'cancel'; } }), { status: 'cancelled' });
  assert.equal(prompts, 1); assert.equal(f.calls.length, 0);
});

test('separate public discovery client create/configure is secretless, delegated-only and scope-readback bound; reuse stays manual', async t => {
  const f = await fixture(t);
  await f.init({ target: f.target, application: { kind: 'discovery-client', mode: 'new', displayName: 'Offline public discovery' } });
  const created = await f.apply('create');
  assert.equal(created.status, 'created-not-configured');
  assert.equal(f.cloud.app.isFallbackPublicClient, true);
  assert.deepEqual(f.cloud.app.requiredResourceAccess, []);
  const binding = { clientId: randomUUID(), applicationIdUri: 'api://fixture-resource', scope: 'access_as_user', scopeId: randomUUID() };
  f.cloud.resource = { appId: binding.clientId, identifierUris: [binding.applicationIdUri],
    api: { oauth2PermissionScopes: [{ id: binding.scopeId, value: binding.scope, isEnabled: true }] } };
  await assert.rejects(planMcpAppSetup(f.dir, { phase: 'configure' }), /exact delegated resource/);
  await assert.rejects(planMcpAppSetup(f.dir, { phase: 'configure', resource: { ...binding, clientId: created.applicationId } }), /different/);
  const plan = await planMcpAppSetup(f.dir, { phase: 'configure', resource: binding });
  assert.deepEqual(plan.write.body.requiredResourceAccess, [{ resourceAppId: binding.clientId, resourceAccess: [{ id: binding.scopeId, type: 'Scope' }] }]);
  const ready = await f.apply('configure', binding);
  assert.equal(ready.status, 'configured-not-consented');
  assert.equal(ready.discoveryClient.configured, true);
  assert.equal(ready.inbound, null);
  assert.equal(ready.cloudConsentGranted, false);
  assert.match(ready.manual.join('\n'), /has not inspected or created them/);
  assert.ok(ready.manual.some(message => message.includes(created.applicationId)));
  assert.equal(f.calls.some(args => args.some(value => typeof value === 'string' && value.includes('/servicePrincipals'))), false);
  assert.equal(ready.discoveryClient.discoveryClientId, created.applicationId);
  const g = await fixture(t);
  g.cloud.app = structuredClone(f.cloud.app); g.cloud.resource = structuredClone(f.cloud.resource);
  g.cloud.app.isFallbackPublicClient = false;
  await g.init({ target: g.target, application: { kind: 'discovery-client', mode: 'existing', clientId: g.cloud.app.appId } });
  assert.equal((await g.apply('inspect', binding)).status, 'blocked-manual-configuration');
  assert.equal(g.calls.some(a => a.includes('PATCH') || a.includes('POST')), false);
  const h = await fixture(t);
  await h.init({ target: h.target, application: { kind: 'discovery-client', mode: 'new', displayName: 'Wrong scope test' } });
  await h.apply('create'); h.cloud.resource = structuredClone(f.cloud.resource);
  h.cloud.resource.api.oauth2PermissionScopes[0].id = randomUUID();
  assert.equal((await h.apply('configure', binding)).status, 'blocked-uncertain');
  assert.equal(h.calls.some(a => a.includes('PATCH')), false);
});

test('denied resource inventory stays null with manual ID fallback; explicit account required, no mutation', async t => {
  const f = await fixture(t), dir = path.join(f.root, 'server');
  await createMcpServerProject(await prepareMcpServer(f.definition), { workspaceRoot: f.root, projectDir: dir });
  assert.equal((await planResourceInventory(dir)).approvalToken, null);
  await selectMockAzureIdentity(dir, f.definition.azure);
  const plan = await planResourceInventory(dir), calls = [];
  const result = await inspectResourceInventory(dir, { approval: plan.approvalToken, allowCloud: true, run: async (_, args) => {
    calls.push(args);
    if (args[0] === 'account') return f.account;
    assert.deepEqual(args.slice(0, 2), ['resource', 'list']);
    throw azureCliFailure(1, 'AuthorizationFailed');
  } });
  assert.equal(result.status, 'blocked-permission'); assert.equal(result.resources, null);
  assert.ok(plan.effects.some(s => s.includes('manually')));
  assert.ok(calls.every(a => a[0] === 'account' || a[1] === 'list'));
});

test('read-only failed phase reconciles actual app before fresh resume approval; wrong tenant stops readback', async t => {
  const f = await fixture(t), dir = path.join(f.root, 'server');
  await createMcpServerProject(await prepareMcpServer(f.definition), { workspaceRoot: f.root, projectDir: dir });
  await selectMockAzureIdentity(dir, f.definition.azure);
  const phase = await planMcpServerProvision(dir, { phase: 'finalize' });
  await provisionMcpServer(dir, { phase: 'finalize', approval: phase.approvalToken,
    run: async (_, args) => args[0] === 'account' ? f.account : {} });
  const reconcile = await planMcpServerReconcile(dir), calls = [];
  const scopeId = randomUUID(), inbound = f.definition.inbound;
  const application = { appId: inbound.clientId, identifierUris: [inbound.applicationIdUri],
    api: { oauth2PermissionScopes: [{ id: scopeId, value: inbound.scope, isEnabled: true }],
      preAuthorizedApplications: inbound.allowedClientIds.map(appId => ({ appId, delegatedPermissionIds: [scopeId] })) } };
  const readback = async (_, args) => {
    calls.push(args);
    if (args[0] === 'account') return f.account;
    assert.ok(args.includes('GET')); return application;
  };
  const blocked = await reconcileMcpServer(dir, { approval: reconcile.approvalToken, allowCloud: true,
    run: async () => ({ ...f.account, tenantId: randomUUID() }) });
  assert.equal(blocked.lifecycleStatus, 'blocked-unresolved');
  assert.equal((await reconcileMcpServer(dir, { approval: reconcile.approvalToken, allowCloud: true, run: readback })).status, 'reconciled-not-deployed');
  const next = await planMcpServerProvision(dir, { phase: 'finalize' });
  assert.notEqual(next.approvalToken, phase.approvalToken);
  assert.equal((await provisionMcpServer(dir, { phase: 'finalize', approval: next.approvalToken, run: readback })).lifecycleStatus, 'completed');
});
