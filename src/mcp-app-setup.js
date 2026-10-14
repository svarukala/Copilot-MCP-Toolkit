import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { assertProjectPath } from './config.js';
import { boundedSnapshot, metadataDigest } from './anonymous-metadata.js';
import { secretIssues } from './validation.js';
import { RESTRICTED_DISCOVERY_CLIENT_ID } from './contract.js';
import { planAzureAccountSwitch, switchAzureAccount, readAzureIdentity, azureIdentityGuard, validateAzureAccountTarget } from './azure-identity.js';
import { runAzureCommand } from './azure.js';
import { requireControl as ensure, readControl, writeControl, withControlLock, controlOutput, controlFailure } from './mcp-control.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const select = 'id,appId,displayName,tags,signInAudience,identifierUris,api,passwordCredentials,keyCredentials,requiredResourceAccess,isFallbackPublicClient,publicClient,web,spa';
const graph = 'https://graph.microsoft.com/v1.0';
const digest = value => metadataDigest(boundedSnapshot(value));
const discovery = state => state.request.application.kind === 'discovery-client';
function checkedResource(value) {
  if (value === undefined || value === null) return null;
  const resource = boundedSnapshot(value);
  ensure(Object.keys(resource).sort().join(',') === 'applicationIdUri,clientId,scope,scopeId'
    && uuid.test(resource.clientId) && uuid.test(resource.scopeId)
    && /^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(resource.scope), 'Discovery binding requires exact resource clientId/applicationIdUri/scope/scopeId.');
  const uri = new URL(resource.applicationIdUri);
  ensure(['api:', 'https:'].includes(uri.protocol) && !uri.username && !uri.password && !uri.search && !uri.hash
    && !/[\s<>"'{}\\]/.test(resource.applicationIdUri) && !secretIssues(JSON.stringify(resource)), 'Resource URI must be a nonsecret identifier.');
  return resource;
}
function checkedRequest(value) {
  const v = boundedSnapshot(value);
  ensure(Object.keys(v).sort().join(',') === 'application,target', 'App setup requires only explicit target and application.');
  v.target = validateAzureAccountTarget(v.target);
  const a = v.application;
  ensure(a && ['new', 'existing'].includes(a.mode), 'Choose new or existing application explicitly.');
  if (a.kind === 'discovery-client') {
    ensure(Object.keys(a).sort().join(',') === (a.mode === 'new' ? 'displayName,kind,mode' : 'clientId,kind,mode'),
      'Discovery client input requires kind discovery-client, mode, and displayName (new) or exact clientId (reuse). Bind its resource only in a separate configure/inspect plan.');
    if (a.mode === 'new') ensure(/^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,79}$/.test(a.displayName ?? ''), 'Use a bounded discovery-client display name.');
    else ensure(uuid.test(a.clientId) && a.clientId.toLowerCase() !== RESTRICTED_DISCOVERY_CLIENT_ID.toLowerCase(), 'Never use the first-party service client as the discovery client.');
    ensure(!secretIssues(JSON.stringify(v)), 'Setup accepts identifiers only.');
    return v;
  }
  ensure(Object.keys(a).sort().join(',') === (a.mode === 'new'
    ? 'allowedClientIds,displayName,mode,scope' : 'allowedClientIds,applicationIdUri,clientId,mode,scope'),
  'New app requires displayName/scope/allowedClientIds; existing requires exact clientId/applicationIdUri/scope/allowedClientIds.');
  ensure(/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(a.scope) && Array.isArray(a.allowedClientIds)
    && a.allowedClientIds.length > 0 && a.allowedClientIds.length <= 20
    && a.allowedClientIds.every(id => uuid.test(id))
    && new Set(a.allowedClientIds.map(id => id.toLowerCase())).size === a.allowedClientIds.length, 'Explicit scope and unique client IDs are required.');
  if (a.mode === 'new') ensure(typeof a.displayName === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,79}$/.test(a.displayName), 'Use a bounded nonsecret display name.');
  else {
    ensure(uuid.test(a.clientId), 'An exact existing app client ID is required; no display-name adoption.');
    const uri = new URL(a.applicationIdUri);
    ensure(['api:', 'https:'].includes(uri.protocol) && !uri.username && !uri.password && !uri.search && !uri.hash
      && !/[\s<>"'{}\\]/.test(a.applicationIdUri), 'A nonsecret existing Application ID URI is required.');
  }
  ensure(!secretIssues(JSON.stringify(v)), 'Setup input accepts identifiers only, never credentials.');
  return v;
}
export async function createMcpAppWorkspace(projectDir, input) {
  const request = checkedRequest(input), dir = await assertProjectPath(path.resolve(projectDir));
  await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
  await mkdir(dir, { mode: 0o700 });
  const state = { schemaVersion: 1, revision: randomUUID(), request, status: 'draft', intentId: randomUUID(),
    scopeId: randomUUID(), application: null, observedUserId: null, attempts: [] };
  await writeControl(path.join(dir, 'mcp-app-setup.json'), state, { create: true });
  return { projectDir: dir, status: state.status, next: 'Review mcp-app-account-plan; app workspace creation did not sign in or create an application.' };
}
async function setup(projectDir) {
  const dir = await assertProjectPath(path.resolve(projectDir)), filename = path.join(dir, 'mcp-app-setup.json');
  const state = await readControl(filename);
  ensure(state.schemaVersion === 1 && uuid.test(state.intentId) && uuid.test(state.scopeId)
    && uuid.test(state.revision) && Array.isArray(state.attempts) && state.attempts.length < 1000, 'Invalid or exhausted app setup journal.');
  state.request = checkedRequest(state.request);
  const config = { azure: state.request.target, connectors: [] };
  return { dir, filename, state, config };
}
export async function planMcpAppAccount(projectDir, requested) {
  const { dir, state } = await setup(projectDir);
  const target = requested === undefined ? state.request.target : validateAzureAccountTarget(requested);
  ensure(target.tenantId === state.request.target.tenantId && target.subscriptionId === state.request.target.subscriptionId,
    'App setup tenant/subscription is immutable. Create a separate workspace for another tenant; never carry owned app evidence across targets.');
  return planAzureAccountSwitch(dir, target);
}
export async function switchMcpAppAccount(projectDir, { requested, ...options } = {}) {
  const plan = await planMcpAppAccount(projectDir, requested);
  return switchAzureAccount(plan.projectDir, plan.target, { run: runAzureCommand, ...options });
}
function expected(state, application = state.application) {
  const request = state.request.application;
  if (discovery(state)) return { tenantId: state.request.target.tenantId, discoveryClientId: application?.appId ?? request.clientId,
    resource: state.resource ?? null };
  return { type: 'entra', tenantId: state.request.target.tenantId, clientId: application?.appId ?? request.clientId,
    applicationIdUri: request.mode === 'new' ? `api://${application?.appId}` : request.applicationIdUri,
    scope: request.scope, allowedClientIds: request.allowedClientIds };
}
function ready(app, desired) {
  if (Object.hasOwn(desired, 'discoveryClientId')) return app?.appId?.toLowerCase() === desired.discoveryClientId?.toLowerCase()
    && desired.resource && app.isFallbackPublicClient === true
    && !app.passwordCredentials?.length && !app.keyCredentials?.length
    && app.requiredResourceAccess?.some(r => r.resourceAppId?.toLowerCase() === desired.resource.clientId.toLowerCase()
      && r.resourceAccess?.some(p => p.type === 'Scope' && p.id?.toLowerCase() === desired.resource.scopeId.toLowerCase()));
  const scope = app?.api?.oauth2PermissionScopes?.find(s => s.value === desired.scope && s.isEnabled);
  return app?.appId?.toLowerCase() === desired.clientId?.toLowerCase() && app.identifierUris?.includes(desired.applicationIdUri)
    && scope && desired.allowedClientIds.every(client => app.api.preAuthorizedApplications?.some(p =>
      p.appId?.toLowerCase() === client.toLowerCase() && p.delegatedPermissionIds?.includes(scope.id)));
}
function ownedUncredentialed(state, app) {
  return state.request.application.mode === 'new' && app?.tags?.includes(`cowork-mcp-intent:${state.intentId}`)
    && app.displayName === `${state.request.application.displayName} (${state.intentId})` && app.signInAudience === 'AzureADMyOrg'
    && !app.passwordCredentials?.length && !app.keyCredentials?.length && !app.requiredResourceAccess?.length;
}
function blankOwned(state, app) {
  return ownedUncredentialed(state, app) && !app.identifierUris?.length
    && !app.api?.oauth2PermissionScopes?.length && !app.api?.preAuthorizedApplications?.length;
}
function scopeDefinition(state) {
  return { id: state.scopeId, value: state.request.application.scope, isEnabled: true, type: 'Admin',
    adminConsentDisplayName: 'Access this MCP resource', adminConsentDescription: 'Access this MCP resource as the signed-in user.' };
}
function applicationDigest(app) {
  const normalized = structuredClone(app);
  // Graph may return null user-consent labels for an Admin-only scope.
  for (const scope of normalized?.api?.oauth2PermissionScopes ?? []) {
    for (const key of ['userConsentDisplayName', 'userConsentDescription']) if (scope[key] === null) delete scope[key];
  }
  for (const client of normalized?.api?.preAuthorizedApplications ?? []) {
    client.appId = client.appId.toLowerCase();
    client.delegatedPermissionIds = client.delegatedPermissionIds.map(id => id.toLowerCase()).sort();
  }
  normalized?.api?.preAuthorizedApplications?.sort((a, b) => a.appId.localeCompare(b.appId));
  return digest(normalized);
}
function scopedOwned(state, app) {
  return !discovery(state) && ownedUncredentialed(state, app) && !app.api?.preAuthorizedApplications?.length
    && Array.isArray(app.identifierUris) && digest(app.identifierUris) === digest([expected(state, app).applicationIdUri])
    && app.api?.requestedAccessTokenVersion === 2
    && applicationDigest({ api: { oauth2PermissionScopes: app.api.oauth2PermissionScopes } })
      === applicationDigest({ api: { oauth2PermissionScopes: [scopeDefinition(state)] } });
}
function patchedApplication(app, body) {
  return { ...app, ...body, ...(body.api ? { api: { ...app.api, ...body.api } } : {}) };
}
function configBody(state, phase) {
  const desired = expected(state);
  if (discovery(state)) return { isFallbackPublicClient: true,
    requiredResourceAccess: [{ resourceAppId: desired.resource.clientId, resourceAccess: [{ id: desired.resource.scopeId, type: 'Scope' }] }] };
  if (phase === 'preauthorize') return { api: {
    preAuthorizedApplications: desired.allowedClientIds.map(appId => ({ appId, delegatedPermissionIds: [state.scopeId] })) } };
  return { identifierUris: [desired.applicationIdUri], api: { ...state.application.api,
    requestedAccessTokenVersion: 2,
    oauth2PermissionScopes: [scopeDefinition(state)] } };
}
export async function planMcpAppSetup(projectDir, { phase = 'inspect', resource } = {}) {
  const { dir, state, config } = await setup(projectDir);
  ensure(['inspect', 'create', 'configure', 'preauthorize', 'reconcile'].includes(phase), 'App phase must be inspect, create, configure, preauthorize or reconcile.');
  const identity = await readAzureIdentity(config, dir);
  const linkedResource = checkedResource(resource ?? state.resource);
  ensure(discovery(state) || !linkedResource, 'Resource app setup cannot take a discovery-client resource binding.');
  if (discovery(state)) {
    if (['configure', 'inspect'].includes(phase)) ensure(linkedResource, 'Provide --config with the exact delegated resource binding for discovery-client configure/inspect.');
    ensure(!linkedResource || linkedResource.clientId.toLowerCase() !== (state.application?.appId ?? state.request.application.clientId)?.toLowerCase(),
      'Discovery client must be different from the resource application.');
  }
  const plannedState = { ...state, ...(linkedResource ? { resource: linkedResource } : {}) };
  const desired = state.application ? expected(plannedState) : null;
  const unresolved = state.attempts.some(a => ['started', 'uncertain'].includes(a.status));
  ensure(!unresolved || phase === 'reconcile', 'An uncertain app attempt requires reconcile, never replay or ordinary inspect.');
  const priorWrite = name => state.attempts.some(a => a.phase === name
    && !['denied-no-write', 'blocked-before-write'].includes(a.status)
    && !(a.status === 'reconciled-no-change' && ['configure', 'preauthorize'].includes(name)
      && a.reconciliation?.outcome === 'exact-prior-state'
      && a.reconciliation.applicationDigest === applicationDigest(state.application)
      && state.attempts.some(r => r.id === a.reconciliation.attemptId && r.phase === 'reconcile' && r.status === 'completed')));
  if (phase === 'create') ensure(state.request.application.mode === 'new' && !state.application && !unresolved
    && !priorWrite('create'), 'Create cannot be replayed; reconcile saved intent or use a new explicitly reviewed workspace.');
  if (phase === 'configure') ensure(state.request.application.mode === 'new' && blankOwned(state, state.application) && !unresolved
    && !priorWrite('configure'), 'Only a freshly created, untouched, owned app can be configured automatically once. Reused/modified apps need manual owner changes and inspect.');
  if (phase === 'preauthorize') ensure(scopedOwned(state, state.application) && !unresolved && !priorWrite('preauthorize')
    && state.attempts.some(a => a.phase === 'configure' && ['completed', 'reconciled-readback'].includes(a.status)
      && a.afterApplicationDigest === applicationDigest(state.application)),
  'Preauthorization requires the exact owned scope from completed or reconciled configure readback and a separate approval; reused/modified apps need manual owner changes.');
  const plan = { schemaVersion: 1, action: 'mcp-app-setup', phase, projectDir: dir, identity, stateDigest: digest(state),
    configurationVersion: 2,
    request: state.request, desired, resource: linkedResource, intentId: state.intentId,
    write: phase === 'create' ? { method: 'POST', resource: `${graph}/applications`,
      body: { displayName: `${state.request.application.displayName} (${state.intentId})`,
        signInAudience: 'AzureADMyOrg', tags: [`cowork-mcp-intent:${state.intentId}`],
        ...(discovery(state) ? { isFallbackPublicClient: true } : {}) } }
      : ['configure', 'preauthorize'].includes(phase) ? { method: 'PATCH', resource: `${graph}/applications/${state.application.id}`, body: configBody(plannedState, phase) } : null,
    permissions: { status: 'unknown-until-exercised', type: 'delegated-user',
      read: 'Graph User.Read for /me; Application.Read.All (or allowed higher delegated scope) and directory read/owned-app access for exact applications/owners.',
      create: 'Tenant app-registration policy and delegated create permission; Application Developer is a possible least role when user creation is restricted.',
      configure: 'Graph Application.ReadWrite.All delegated access plus ownership/appropriate Entra role. Application.ReadWrite.OwnedBy is application-only, not a substitute for this user login.',
      admin: 'An administrator must separately review consent and client preauthorization. This plan never grants OAuth consent, app-role assignments, secrets or token-store registration.' },
    checkpoints: ['Reuse inspection never changes scopes, URIs, grants, credentials or redirects; missing prerequisites produce exact manual instructions.',
      'Graph application creation does not create its home-tenant service principal. Before runtime sign-in, have the owner verify the resource and discovery-client enterprise applications by exact appId and tenant. This app setup does not inspect/create service principals or establish runtime readiness.',
      'Create approval creates only a single-tenant secretless app, no permissions/scopes. A discovery-client create also enables public-client/device flow. Resource configure creates only the URI/scope; exact readback then separately approved preauthorize adds clients. Discovery-client configure requests its exact delegated permission separately.',
      'Automatic configuration is limited to the newly intent-owned untouched app. Graph app updates provide no documented ETag contract; externally edited/reused apps require manual merge.',
      'Reconcile never writes Graph. Only exact prior-state readback can permit a fresh reviewed retry of a rejected configure/preauthorize; exact approved-result readback consumes that phase instead. Partial or foreign changes remain blocked.',
      'Durable intent precedes mutation. Interrupted create is not retried; reconcile checks unique intent tag, exact display name AND ownership. Duplicate or absent uncertain results require operator investigation.'] };
  return { ...plan, approvalToken: identity ? `mcp-app/${digest(plan)}` : null };
}
export async function applyMcpAppSetup(projectDir, { phase = 'inspect', resource, approval, allowCloud = false, run = runAzureCommand } = {}) {
  const plan = await planMcpAppSetup(projectDir, { phase, resource });
  ensure(allowCloud === true && approval && approval === plan.approvalToken, 'Exact fresh app phase approval and --allow-cloud required; login approval is insufficient.');
  return withControlLock(plan.projectDir, async () => {
    ensure((await planMcpAppSetup(projectDir, { phase, resource })).approvalToken === approval, 'App plan changed; review again.');
    const { state, config, filename, dir } = await setup(projectDir);
    const attempt = { id: randomUUID(), phase, status: 'started', approval, startedAt: new Date().toISOString() };
    if (plan.resource) state.resource = plan.resource;
    state.attempts.push(attempt); state.revision = randomUUID();
    await writeControl(filename, state);
    let knownDigest = digest(state);
    const persist = async () => { await writeControl(filename, state); knownDigest = digest(state); };
    const execute = async args => {
      ensure(digest((await setup(dir)).state) === knownDigest, 'App setup changed during execution.');
      const execution = await azureIdentityGuard(config, dir, plan.identity, run);
      ensure(digest((await setup(dir)).state) === knownDigest, 'App setup changed during identity verification.');
      if (args.includes('--body')) ensure(digest(await readControl(args[args.indexOf('--body') + 1].slice(1))) === digest(plan.write.body),
        'App mutation payload changed after review; no write is allowed.');
      const write = args.includes('POST') || args.includes('PATCH');
      if (write) { attempt.writeStatus = 'submitted'; await persist(); }
      try {
        const response = await run('az', [...args, '--output', 'json', '--only-show-errors'], execution);
        if (write) { attempt.writeStatus = 'accepted'; await persist(); }
        return controlOutput(response);
      } catch (error) {
        if (write && error.code === 'AZURE_PERMISSION_DENIED') attempt.writeStatus = 'denied';
        throw error;
      }
    };
    const getApp = async id => execute(['rest', '--method', 'GET', '--url', `${graph}/applications/${id}?$select=${select}`]);
    const getExisting = async id => execute(['rest', '--method', 'GET', '--url', `${graph}/applications(appId='${id}')?$select=${select}`]);
    const verifyOwned = async app => {
      ensure(uuid.test(app?.id) && uuid.test(app?.appId)
        && (!state.application?.id || state.application.id === app.id)
        && (!state.application?.appId || state.application.appId === app.appId)
        && app.tags?.includes(`cowork-mcp-intent:${state.intentId}`)
        && app.displayName === `${state.request.application.displayName} (${state.intentId})`
        && app.signInAudience === 'AzureADMyOrg', 'Exact unique intent-owned app readback failed; no display-name adoption.');
      const owners = await execute(['rest', '--method', 'GET', '--url', `${graph}/applications/${app.id}/owners?$select=id`]);
      ensure(Array.isArray(owners?.value) && !owners['@odata.nextLink']
        && owners.value.some(o => o.id?.toLowerCase() === state.observedUserId?.toLowerCase()), 'Created app owner readback must include the recorded creating user; admin intervention required.');
    };
    const verifyResource = async () => {
      if (!discovery(state) || !state.resource) return;
      const resourceApp = await getExisting(state.resource.clientId);
      ensure(resourceApp?.appId?.toLowerCase() === state.resource.clientId.toLowerCase()
        && resourceApp.identifierUris?.includes(state.resource.applicationIdUri)
        && resourceApp.api?.oauth2PermissionScopes?.some(s => s.id?.toLowerCase() === state.resource.scopeId.toLowerCase()
          && s.value === state.resource.scope && s.isEnabled), 'Resource scope ID/value/URI readback mismatch; never substitute an application role or guessed scope.');
      ensure(state.application?.appId?.toLowerCase() !== resourceApp.appId.toLowerCase()
        && state.application?.appId?.toLowerCase() !== RESTRICTED_DISCOVERY_CLIENT_ID.toLowerCase(), 'Discovery, resource and first-party service identities must remain distinct.');
    };
    try {
      let app;
      if (phase === 'create') {
        const me = await execute(['rest', '--method', 'GET', '--url', `${graph}/me?$select=id`]);
        ensure(uuid.test(me?.id), 'Exact creating user object ID is required.');
        state.observedUserId = me.id; await persist();
        const payloadFile = path.join(dir, `app-body-${attempt.id}.json`);
        await writeControl(payloadFile, plan.write.body, { create: true });
        const created = await execute(['rest', '--method', 'POST', '--url', plan.write.resource, '--body', `@${payloadFile}`]);
        ensure(uuid.test(created?.id) && uuid.test(created?.appId), 'Create result missing exact object/client IDs; reconcile without replay.');
        state.application = { id: created.id, appId: created.appId }; await persist();
        app = await getApp(created.id); await verifyOwned(app);
        ensure(blankOwned(state, app), 'Created application changed before setup; manual reconciliation required.');
      } else if (['configure', 'preauthorize'].includes(phase)) {
        app = await getApp(state.application.id); await verifyOwned(app);
        ensure(applicationDigest(app) === applicationDigest(state.application)
          && (phase === 'configure' ? blankOwned(state, app) : scopedOwned(state, app)),
        'App drifted since configuration review; do not replace its collections.');
        await verifyResource();
        attempt.beforeApplicationDigest = applicationDigest(app);
        attempt.afterApplicationDigest = applicationDigest(patchedApplication(app, plan.write.body));
        await persist();
        const payloadFile = path.join(dir, `app-body-${attempt.id}.json`);
        await writeControl(payloadFile, plan.write.body, { create: true });
        await execute(['rest', '--method', 'PATCH', '--url', plan.write.resource, '--body', `@${payloadFile}`]);
        app = await getApp(app.id); await verifyOwned(app);
        ensure(applicationDigest(app) === attempt.afterApplicationDigest,
          'Exact approved configuration did not read back; reconcile before any retry.');
      } else if (state.request.application.mode === 'existing') app = await getExisting(state.request.application.clientId);
      else if (state.application?.id) { app = await getApp(state.application.id); await verifyOwned(app); }
      else if (phase === 'reconcile' && state.observedUserId) {
        const name = `${state.request.application.displayName} (${state.intentId})`;
        const response = await execute(['rest', '--method', 'GET', '--url',
          `${graph}/applications?$filter=${encodeURIComponent(`displayName eq '${name}'`)}&$select=${select}`]);
        ensure(Array.isArray(response?.value) && !response['@odata.nextLink'] && response.value.length === 1,
          'Uncertain creation requires exactly one candidate and full ownership readback; zero/duplicate matches do not authorize retry.');
        app = response.value[0]; await verifyOwned(app);
      } else throw new Error('New app has no readback identity; use a separately approved create plan.');
      ensure(uuid.test(app?.id) && uuid.test(app?.appId) && !secretIssues(JSON.stringify(app)),
        'Application readback requires exact nonsecret object/client metadata.');
      if (state.request.application.mode === 'existing') ensure(app.appId.toLowerCase() === state.request.application.clientId.toLowerCase(), 'Existing client ID mismatch.');
      await verifyResource();
      if (phase === 'reconcile') {
        ensure(ready(app, expected(state, app)) || scopedOwned(state, app) || blankOwned(state, app),
          'Observed owned app differs from blank creation or approved configuration; manual investigation required.');
        const observed = applicationDigest(app), resolutions = [];
        for (const previous of state.attempts) {
          if (previous === attempt) continue;
          const legacyConfigure = previous.phase === 'configure' && !previous.beforeApplicationDigest
            && !previous.reconciliation && previous.status === 'reconciled-readback' && previous.writeStatus === 'submitted';
          if (!legacyConfigure && !['started', 'uncertain'].includes(previous.status)) continue;
          let status = 'reconciled-readback';
          if (['configure', 'preauthorize'].includes(previous.phase)) {
            const legacyBlank = previous.phase === 'configure' && !previous.beforeApplicationDigest && blankOwned(state, state.application);
            const before = previous.beforeApplicationDigest ?? (legacyBlank ? applicationDigest(state.application) : null);
            const legacyBody = legacyBlank ? patchedApplication(configBody(state, 'configure'), configBody(state, 'preauthorize')) : null;
            const after = previous.afterApplicationDigest
              ?? (legacyBody ? applicationDigest(patchedApplication(state.application, legacyBody)) : null);
            ensure(observed === before || observed === after,
              'Uncertain configuration matches neither exact prior nor approved result; preserve history and investigate manually.');
            if (observed === before) status = 'reconciled-no-change';
          } else ensure(ready(app, expected(state, app)) || blankOwned(state, app) || scopedOwned(state, app),
            'Observed owned app differs from blank creation or approved configuration; manual investigation required.');
          resolutions.push({ previous, status });
        }
        for (const { previous, status } of resolutions) {
          previous.status = status;
          previous.reconciliation = { attemptId: attempt.id, applicationDigest: observed,
            outcome: status === 'reconciled-no-change' ? 'exact-prior-state' : 'readback' };
        }
      }
      state.application = boundedSnapshot(app, 262144);
      const inbound = expected(state), complete = Boolean(ready(app, inbound));
      const scoped = scopedOwned(state, app);
      state.status = complete ? 'configured-not-consented' : scoped ? 'scope-configured-not-preauthorized'
        : blankOwned(state, app) ? 'created-not-configured' : 'blocked-manual-configuration';
      state.inbound = complete && !discovery(state) ? inbound : null;
      state.manual = complete ? ['Consent and delegated backend permissions still require separate owner/admin review. Any external consumer registration is outside this toolkit.']
        : [discovery(state)
          ? `Owner must enable public-client/device flow on separate client ${app.appId}, configure only the selected resource delegated Scope permission (never Role), and separately review consent. Use a configure plan only for this untouched toolkit-created app; reused client changes are manual.`
          : scoped ? `Scope readback is complete. Review a separate preauthorize plan for clients ${inbound.allowedClientIds.join(', ')}; configure approval does not authorize that write.`
            : `Owner must preserve all existing settings while exposing ${inbound.applicationIdUri}/${inbound.scope} and preauthorizing exactly the requested clients: ${inbound.allowedClientIds.join(', ')}. Then run inspect again.`,
          'No missing scope/client is proof of trust or consent; no foreign collection is replaced.'];
      state.manual.push(`Before runtime sign-in, have the owner verify the home-tenant service principal for application ${app.appId} in tenant ${state.request.target.tenantId}, and the corresponding resource/discovery-client principal. Graph application creation alone does not create it. Missing principals require separately reviewed provisioning; this setup has not inspected or created them and grants no consent.`);
      attempt.status = 'completed'; attempt.finishedAt = new Date().toISOString(); await persist();
      return { status: state.status, applicationId: app.appId, inbound: state.inbound,
        resourceScopeId: !discovery(state) && (complete || scoped) ? app.api.oauth2PermissionScopes.find(s => s.value === inbound.scope && s.isEnabled).id : null,
        discoveryClient: discovery(state) ? { tenantId: state.request.target.tenantId, discoveryClientId: app.appId,
          resource: state.resource ?? null, configured: complete, consent: 'not-granted-or-verified' } : null,
        manual: state.manual, projectDir: dir, cloudConsentGranted: false };
    } catch (error) {
      attempt.status = attempt.writeStatus === 'denied' ? 'denied-no-write'
        : !attempt.writeStatus && !state.attempts.some(a => a !== attempt && ['started', 'uncertain'].includes(a.status))
          ? 'blocked-before-write' : 'uncertain';
      attempt.finishedAt = new Date().toISOString();
      const failure = controlFailure(error, phase); state.status = failure.status; state.failure = failure; await persist();
      return { ...failure, projectDir: dir, ...(error.code === 'CONTROL_VALIDATION' ? { detail: error.message } : {}), inbound: null };
    }
  });
}
