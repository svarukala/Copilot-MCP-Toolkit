import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { jwtVerify } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { compileHostingRecipe, planHostingRecipe, writeHostingRecipe } from '../src/mcp-container-apps.js';
import { createBackendAuthorization, createOAuthClient, loadCredential, pilotLimits, pkce } from '../src/recipes/container-apps/backend-auth.js';
import { createAuthPortal } from '../src/recipes/container-apps/auth-portal.js';
import { createProtocolServer, createRequestHandler } from '../src/recipes/container-apps/runtime.js';
import { planValidation, startValidation, nextValidation, runValidation, validationStatus } from '../src/mcp-validation-journey.js';
import { planHandover } from '../src/mcp-handover.js';
import { planRecipeReference, writeRecipeReference } from '../src/mcp-recipe-artifacts.js';
import { planMcpProjectDiscovery } from '../src/mcp-discovery-project.js';
import { TOOLKIT_ROOT, withCliWorkspace } from '../src/config.js';

const base = JSON.parse(await readFile(new URL('../examples/mcp/container-apps-direct.json', import.meta.url)));
const gateway = JSON.parse(await readFile(new URL('../examples/mcp/container-apps-apim.json', import.meta.url)));
const secret = 'synthetic-client-credential-not-a-real-secret';
const env = { MCP_BACKEND_CLIENT_CREDENTIAL: secret, MCP_PORTAL_CLIENT_CREDENTIAL: 'synthetic-portal-credential' };
const user = { tid: base.authentication.tenantId, oid: '77777777-7777-4777-8777-777777777777' };
const other = { ...user, oid: '88888888-8888-4888-8888-888888888888' };
function fixture(profile = 'oauth-client-credentials-v1', behindGateway = false) {
  const input = structuredClone(behindGateway ? gateway : base);
  const reference = {
    tenantId: input.azure.tenantId,
    keyVaultResourceId: `/subscriptions/${input.azure.subscriptionId}/resourceGroups/synthetic-secrets/providers/Microsoft.KeyVault/vaults/synthetic-vault`,
    identityResourceId: `/subscriptions/${input.azure.subscriptionId}/resourceGroups/synthetic-secrets/providers/Microsoft.ManagedIdentity/userAssignedIdentities/synthetic-reader`,
    secretIdentifier: `https://synthetic-vault.vault.azure.net/secrets/backend-client/${'a'.repeat(32)}`,
  };
  const oauth = { schemaVersion: 1, issuer: 'https://identity.example.com/issuer', tokenEndpoint: 'https://identity.example.com/token',
    clientId: 'synthetic-provider-client', scopes: ['data.read'], credential: { method: 'client_secret_post' } };
  input.backend = { origin: 'https://data.example.com', auth: profile, oauth, credentialReferences: { backend: reference } };
  if (profile === 'oauth-client-credentials-v1') oauth.sharedAccessReviewed = true;
  else if (profile === 'oauth-authorization-code-v1') {
    const portalClient = '99999999-9999-4999-8999-999999999999';
    input.authentication.allowedClientIds.push(portalClient);
    const publicBaseUrl = behindGateway ? `https://${input.azure.gateway.serviceName}.azure-api.net/${input.azure.gateway.path}` : 'https://mcp.example.com';
    Object.assign(oauth, { authorizationEndpoint: 'https://identity.example.com/authorize',
      redirectUri: `${publicBaseUrl}/auth/provider/callback`, revocationEndpoint: 'https://identity.example.com/revoke',
      consentReviewed: true, portal: { clientId: portalClient, credential: { method: 'client_secret_post' }, publicBaseUrl } });
    input.backend.credentialReferences.portal = { ...reference, secretIdentifier: reference.secretIdentifier.replace('backend-client', 'portal-client') };
  } else {
    Object.assign(oauth, { issuer: `https://login.microsoftonline.com/${input.azure.tenantId}/v2.0`,
      tokenEndpoint: `https://login.microsoftonline.com/${input.azure.tenantId}/oauth2/v2.0/token`,
      clientId: input.authentication.audience, resource: 'api://synthetic-downstream',
      scopes: ['api://synthetic-downstream/data.read'], consentReviewed: true });
  }
  const flowName = profile === 'oauth-client-credentials-v1' ? 'clientCredentials' : 'authorizationCode';
  input.document.components = { securitySchemes: { oauth: { type: 'oauth2', flows: {
    [flowName]: { tokenUrl: oauth.tokenEndpoint,
      ...(flowName === 'authorizationCode' ? { authorizationUrl: oauth.authorizationEndpoint
        ?? `https://login.microsoftonline.com/${input.azure.tenantId}/oauth2/v2.0/authorize` } : {}),
      scopes: Object.fromEntries(oauth.scopes.map(s => [s, 'Synthetic read scope'])) },
  } } } };
  input.document.security = [{ oauth: oauth.scopes }];
  return input;
}
const response = (access = 'synthetic.access.token', extra = {}) => Response.json({
  access_token: access, token_type: 'Bearer', expires_in: 3600, ...extra,
});
async function workspace(t, input) {
  const parent = path.join(TOOLKIT_ROOT, '.test-output');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'oauth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'input.json');
  await writeFile(config, JSON.stringify(input));
  return { workspaceRoot: root, config, output: path.join(root, 'source') };
}
async function protocol(t, runtime, authorization, request, caller = user) {
  const server = createProtocolServer(runtime, { env, backendAuthorization: authorization, request, caller, log: () => {} });
  const client = new Client({ name: 'offline-auth-fixture', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}
const call = client => client.callTool({ name: 'get_information', arguments: {} });

for (const profile of ['oauth-client-credentials-v1', 'oauth-authorization-code-v1', 'entra-obo-v1']) {
  for (const behindGateway of [false, true]) test(`${profile}: ${behindGateway ? 'gateway' : 'direct'} generation and handover are sealed and credential-free`, async t => {
    const input = fixture(profile, behindGateway), options = await workspace(t, input);
    const plan = await planHostingRecipe(options);
    assert.equal(JSON.parse(plan.files['runtime-config.json']).schemaVersion, 2);
    assert.ok(plan.files['backend-auth.js'] && plan.files['auth-portal.js']);
    const infra = JSON.parse(plan.files['infra/container-app.json']).resources[0];
    assert.equal(infra.properties.configuration.activeRevisionsMode, 'Single');
    assert.equal(infra.properties.template.scale.maxReplicas, 1);
    assert.equal(infra.properties.configuration.secrets.length, profile === 'oauth-authorization-code-v1' ? 2 : 1);
    assert.doesNotMatch(JSON.stringify(plan), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(infra), /roleAssignments|accessPolicies/);
    if (profile === 'oauth-authorization-code-v1' && behindGateway) {
      const api = JSON.parse(plan.files['infra/apim-gateway.json']).resources[0];
      assert.equal(api.resources.filter(r => r.type === 'operations').length, 7);
      assert.match(api.resources.find(r => r.type === 'policies').properties.value, /copilotPortalGatewayToken/);
    }
    await writeHostingRecipe({ ...options, approval: plan.approvalToken });
    const handoverConfig = path.join(options.workspaceRoot, 'handover.json');
    await writeFile(handoverConfig, JSON.stringify({ schemaVersion: 1, snapshotAt: new Date().toISOString(), privateExportReviewed: true }));
    const handover = await planHandover({ ...options, project: options.output, config: handoverConfig,
      output: path.join(options.workspaceRoot, 'handover') });
    assert.ok(JSON.stringify(handover).includes('backend-auth.js'));
  });
}

test('contract rejects unsafe grants, aliases, incompatible hosts, security downgrades and portal topology', () => {
  for (const change of [
    i => { i.backend.auth = 'http-basic-v1'; },
    i => { i.backend.oauth.credential.method = 'none'; },
    i => { i.backend.oauth.tokenEndpoint = 'http://identity.example.com/token'; },
    i => { i.backend.oauth.tokenEndpoint = 'https://127.0.0.1/token'; },
    i => { i.backend.oauth.client_secret = secret; },
    i => { i.backend.credentialReferences.backend.secretIdentifier = 'https://synthetic-vault.vault.azure.net/secrets/backend'; },
    i => { i.backend.credentialReferences.backend.identityResourceId = i.azure.registry.pullIdentityResourceId; },
    i => { i.backend.oauth.sharedAccessReviewed = false; },
    i => { i.document.security = []; },
    i => { i.document.security = [{ oauth: [] }]; },
    i => { i.document.paths['/information'].get.security = []; },
  ]) {
    const input = fixture(); change(input);
    assert.throws(() => compileHostingRecipe(input));
  }
  const badOBO = fixture('entra-obo-v1');
  badOBO.backend.oauth.clientId = other.oid;
  assert.throws(() => compileHostingRecipe(badOBO));
  const portal = fixture('oauth-authorization-code-v1');
  portal.scaleProfile = 'scale-to-zero';
  assert.throws(() => compileHostingRecipe(portal));
  const appService = fixture();
  appService.recipe = 'app-service-container-v1';
  assert.throws(() => compileHostingRecipe(appService));
});

test('portal app and credential separation cannot be bypassed with identifier casing', () => {
  const input = fixture('oauth-authorization-code-v1');
  input.authentication.audience = 'abcdefab-abcd-4bcd-8bcd-abcdefabcdef';
  input.backend.oauth.portal.clientId = input.authentication.audience.toUpperCase();
  input.authentication.allowedClientIds.push(input.backend.oauth.portal.clientId);
  assert.throws(() => compileHostingRecipe(input));
  const shared = fixture('oauth-authorization-code-v1');
  shared.backend.credentialReferences.portal.secretIdentifier =
    shared.backend.credentialReferences.backend.secretIdentifier.replace('backend-client', 'Backend-Client');
  assert.throws(() => compileHostingRecipe(shared));
});

test('reference auth metadata is closed and cannot export injected credentials in plans', async t => {
  const options = await workspace(t, fixture());
  const generated = await planHostingRecipe(options);
  await writeHostingRecipe({ ...options, approval: generated.approvalToken });
  const config = path.join(options.workspaceRoot, 'reference.json'), output = path.join(options.workspaceRoot, 'reference');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, serverId: user.oid, endpoint: 'https://mcp.example.com/mcp' }));
  const reference = { ...options, project: options.output, config, output };
  const planned = await planRecipeReference(reference);
  await writeRecipeReference({ ...reference, approval: planned.approvalToken });
  const originFile = path.join(output, 'recipe-origin.json');
  const original = JSON.parse(await readFile(originFile));
  const discovery = { discoveryClientId: base.authentication.allowedClientIds[0], expectedUserId: user.oid };
  const read = () => withCliWorkspace(options.workspaceRoot, () => planMcpProjectDiscovery(output, discovery));
  assert.equal((await read()).backendAuthorization.profile, 'oauth-client-credentials-v1');
  for (const mutate of [
    origin => { origin.backendAuthorization.client_secret = secret; },
    origin => { origin.extra = secret; },
    origin => { origin.backendAuthorization.settings.clientId = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaa'; },
  ]) {
    const changed = structuredClone(original); mutate(changed);
    await writeFile(originFile, JSON.stringify(changed));
    await assert.rejects(read(), error => error.code === 'AUTH_CONFIG_INVALID' && !error.message.includes(secret));
  }
});

test('app grant is exact, single-flight, memory-only and never runs for discovery', async t => {
  const { runtime } = compileHostingRecipe(fixture());
  let exchanges = 0, gets = 0;
  const authorization = createBackendAuthorization(runtime, { env, request: async (url, options) => {
    exchanges++;
    assert.equal(url, runtime.backendAuthentication.settings.tokenEndpoint);
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('grant_type'), 'client_credentials');
    assert.equal(form.get('client_secret'), secret);
    assert.equal(form.get('scope'), 'data.read');
    assert.equal(options.redirect, 'error');
    await new Promise(resolve => setTimeout(resolve, 5));
    return response();
  } });
  const client = await protocol(t, runtime, authorization, async (_, options) => {
    gets++; assert.equal(options.headers.authorization, 'Bearer synthetic.access.token'); return Response.json({ ok: true });
  });
  await client.listTools(); assert.equal(exchanges, 0);
  await Promise.all([call(client), call(client)]);
  assert.equal(exchanges, 1); assert.equal(gets, 2);
});

test('token errors and uncertain dispatch stay blocked, and backend 401 never refreshes or replays', async t => {
  const { runtime } = compileHostingRecipe(fixture());
  for (const result of [
    () => { throw new Error('private raw transport diagnostic'); },
    () => Response.json({ error: 'invalid_client', error_description: secret }, { status: 400 }),
    () => response('bad token with whitespace'),
    () => response(secret),
    () => response('valid.token', { expires_in: 1 }),
    () => response('valid.token', { scope: 'data.read data.write' }),
    () => new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } }),
  ]) {
    let attempts = 0;
    const authorization = createBackendAuthorization(runtime, { env, request: async () => { attempts++; return result(); } });
    await assert.rejects(authorization.authorize(user), /authorization is unavailable/);
    await assert.rejects(authorization.authorize(user));
    assert.equal(attempts, 1);
  }
  let attempts = 0, gets = 0;
  const authorization = createBackendAuthorization(runtime, { env, request: async () => { attempts++; return response(); } });
  const client = await protocol(t, runtime, authorization, async () => { gets++; return Response.json({}, { status: 401 }); });
  assert.equal((await call(client)).isError, true);
  assert.equal((await call(client)).isError, true);
  assert.equal(attempts, 1); assert.equal(gets, 1);
});

test('client_secret_basic uses form encoding and never falls back to body authentication', async () => {
  const settings = fixture().backend.oauth;
  settings.clientId = 'synthetic:client+id';
  settings.credential.method = 'client_secret_basic';
  let calls = 0;
  const client = createOAuthClient(settings, 'synthetic:secret+value', { request: async (_, options) => {
    calls++;
    assert.equal(Buffer.from(options.headers.authorization.slice(6), 'base64').toString(),
      'synthetic%3Aclient%2Bid:synthetic%3Asecret%2Bvalue');
    assert.equal(new URLSearchParams(options.body).has('client_secret'), false);
    return Response.json({ error: 'invalid_client' }, { status: 400 });
  } });
  await assert.rejects(client.acquire({ grant_type: 'client_credentials' }));
  assert.equal(calls, 1);
});

test('provider access and client credential reflection never reach the MCP result', async t => {
  const { runtime } = compileHostingRecipe(fixture());
  for (const leaked of ['synthetic.access.token', secret, encodeURIComponent(secret)]) {
    const authorization = createBackendAuthorization(runtime, { env, request: async () => response() });
    const client = await protocol(t, runtime, authorization, async () => Response.json({ reflected: leaked }));
    const result = await call(client);
    assert.equal(result.isError, true);
    assert.ok(!JSON.stringify(result).includes(leaked));
  }
});

test('gateway portal routes cannot bypass the gateway or replace MCP caller authentication', async t => {
  const { runtime } = compileHostingRecipe(fixture('oauth-authorization-code-v1', true));
  let backendRequests = 0;
  const server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  server.on('request', createRequestHandler(runtime, `${origin}/mcp`, {
    env, log: () => {}, request: async () => { backendRequests++; throw Error('No provider request permitted'); },
    verifyGateway: async token => {
      if (token !== 'synthetic-gateway-token') throw Object.assign(new Error('rejected'), { code: 'CALLER_FORBIDDEN' });
    },
    verify: async () => { throw Object.assign(new Error('rejected'), { code: 'CALLER_FORBIDDEN' }); },
  }));
  assert.equal((await fetch(`${origin}/auth`)).status, 401);
  const headers = { 'x-copilot-mcp-gateway-authorization': 'Bearer synthetic-gateway-token' };
  const page = await fetch(`${origin}/auth`, { headers });
  assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(`${origin}/mcp`, { method: 'POST', headers })).status, 401);
  assert.equal((await fetch(`${origin}/mcp`, { method: 'POST',
    headers: { ...headers, authorization: 'Bearer synthetic-caller-token' } })).status, 403);
  assert.equal(backendRequests, 0);
});

test('connection capacity, restart loss and refresh uncertainty fail closed', async () => {
  const { runtime } = compileHostingRecipe(fixture('oauth-authorization-code-v1'));
  const authorization = createBackendAuthorization(runtime, { env, request: async () => { throw Error('uncertain refresh'); } });
  const token = { access: 'synthetic.access', refresh: 'synthetic-refresh', expiresAt: Date.now() + 50000 };
  authorization.connect(user, token);
  await assert.rejects(authorization.authorize(user), /unavailable/);
  assert.equal(authorization.connected(user), false);
  assert.equal(authorization.hasConnection(user), true);
  await authorization.disconnect(user, false);
  for (let i = 0; i < pilotLimits.connections; i++) {
    authorization.connect({ ...user, oid: `77777777-7777-4777-8777-${String(i).padStart(12, '0')}` }, token);
  }
  assert.throws(() => authorization.connect(other, token), /unavailable/);
  const restarted = createBackendAuthorization(runtime, { env, request: async () => { throw Error('unexpected'); } });
  await assert.rejects(restarted.authorize(user), /unavailable/);
});

test('revocation locks reconnection until its one dispatched request finishes', async () => {
  const { runtime } = compileHostingRecipe(fixture('oauth-authorization-code-v1'));
  let release, dispatched;
  const ready = new Promise(resolve => { dispatched = resolve; });
  const authorization = createBackendAuthorization(runtime, { env, request: async (_, options) => {
    assert.equal(new URLSearchParams(options.body).get('token_type_hint'), 'access_token');
    dispatched();
    await new Promise(resolve => { release = resolve; });
    return new Response(null, { status: 200 });
  } });
  const token = { access: 'synthetic.revocable.token', expiresAt: Date.now() + 3600000 };
  authorization.connect(user, token);
  const revocation = authorization.disconnect(user, true);
  await ready;
  assert.throws(() => authorization.connect(user, token), /unavailable/);
  await assert.rejects(authorization.disconnect(user, true));
  release(); await revocation;
  authorization.connect(user, token);
  assert.equal(await authorization.authorize(user), token.access);
});

test('per-user refresh rotates atomically, isolates users, expires and distinguishes local from remote revocation', async () => {
  const { runtime } = compileHostingRecipe(fixture('oauth-authorization-code-v1'));
  let now = 1000000, exchanges = 0, revoked = 0;
  const authorization = createBackendAuthorization(runtime, { env, now: () => now, request: async (url, options) => {
    if (url.endsWith('/revoke')) { revoked++; return new Response(null, { status: 200 }); }
    exchanges++;
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('refresh_token'), 'first-refresh');
    await new Promise(resolve => setTimeout(resolve, 5));
    return response('rotated.access', { refresh_token: 'second-refresh' });
  } });
  authorization.connect(user, { access: 'user.access', refresh: 'first-refresh', expiresAt: now + 61000 });
  authorization.connect(other, { access: 'other.access', expiresAt: now + 200000 });
  assert.equal(await authorization.authorize(user), 'user.access');
  now += 2000;
  assert.deepEqual(await Promise.all([authorization.authorize(user), authorization.authorize(user)]), ['rotated.access', 'rotated.access']);
  assert.equal(exchanges, 1); assert.equal(await authorization.authorize(other), 'other.access');
  await authorization.disconnect(user, true); assert.equal(revoked, 1);
  await assert.rejects(authorization.authorize(user));
  await authorization.disconnect(other, false); assert.equal(revoked, 1);
  authorization.connect(user, { access: 'new.access', expiresAt: now + 3600000 });
  now += pilotLimits.sessionMs + 1;
  await assert.rejects(authorization.authorize(user));
  assert.equal(exchanges, 1);
});

test('OBO uses only the current user assertion and partitions by user and assertion', async () => {
  const { runtime } = compileHostingRecipe(fixture('entra-obo-v1'));
  const forms = [];
  const authorization = createBackendAuthorization(runtime, { env, request: async (_, options) => {
    const form = new URLSearchParams(options.body); forms.push(form);
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.equal(form.get('requested_token_use'), 'on_behalf_of');
    assert.equal(form.get('resource'), null);
    return response(`downstream.${forms.length}`);
  } });
  assert.equal(await authorization.authorize({ ...user, assertion: 'first-user-assertion' }), 'downstream.1');
  assert.equal(await authorization.authorize({ ...user, assertion: 'first-user-assertion' }), 'downstream.1');
  assert.equal(await authorization.authorize({ ...other, assertion: 'other-user-assertion' }), 'downstream.2');
  assert.equal(await authorization.authorize({ ...user, assertion: 'replacement-assertion' }), 'downstream.3');
  assert.equal(forms[0].get('assertion'), 'first-user-assertion');
  await assert.rejects(authorization.authorize(user));
});

function syntheticCertificate() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = (tag, ...items) => {
    const body = Buffer.concat(items.map(x => Buffer.isBuffer(x) ? x : Buffer.from(x)));
    const len = body.length < 128 ? Buffer.from([body.length])
      : body.length < 256 ? Buffer.from([0x81, body.length]) : Buffer.from([0x82, body.length >> 8, body.length & 255]);
    return Buffer.concat([Buffer.from([tag]), len, body]);
  };
  const algorithm = der(0x30, der(6, Buffer.from('2a864886f70d01010b', 'hex')), der(5, Buffer.alloc(0)));
  const name = der(0x30, der(0x31, der(0x30, der(6, Buffer.from('550403', 'hex')), der(12, 'synthetic-offline-only'))));
  const tbs = der(0x30, der(0xa0, der(2, Buffer.from([2]))), der(2, Buffer.from([1])), algorithm, name,
    der(0x30, der(0x17, '200101000000Z'), der(0x17, '491231235959Z')), name,
    publicKey.export({ type: 'spki', format: 'der' }));
  const certificate = der(0x30, tbs, algorithm, der(3, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  return { publicKey, material: JSON.stringify({
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    certificatePem: `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`,
  }) };
}
test('certificate assertions bind client, endpoint, key and short lifetime for provider and Entra', async () => {
  const pair = syntheticCertificate(), seen = [];
  for (const entra of [false, true]) {
    const settings = fixture().backend.oauth;
    settings.credential = { method: 'private_key_jwt', keyId: 'synthetic-key-id' };
    const client = createOAuthClient(settings, pair.material, { entra, request: async (_, options) => {
      const assertion = new URLSearchParams(options.body).get('client_assertion');
      const { payload, protectedHeader } = await jwtVerify(assertion, pair.publicKey, {
        issuer: settings.clientId, subject: settings.clientId, audience: settings.tokenEndpoint, algorithms: [entra ? 'PS256' : 'RS256'],
      });
      assert.equal(payload.exp - payload.iat, 60);
      assert.ok(payload.jti && !seen.includes(payload.jti)); seen.push(payload.jti);
      assert.ok(entra ? protectedHeader['x5t#S256'] : protectedHeader.kid);
      return response();
    } });
    await client.acquire({ grant_type: 'client_credentials' });
  }
  assert.throws(() => loadCredential({ method: 'private_key_jwt' }, secret));
  assert.throws(() => loadCredential({ method: 'private_key_jwt' }, pair.material, Date.parse('2050-01-01')));
});

test('v3 runner generates OAuth source, preserves v2 rejection and requires owner auth gates', async t => {
  const definition = fixture(), options = await workspace(t, definition);
  const config = path.join(options.workspaceRoot, 'run.json'), output = path.join(options.workspaceRoot, 'run');
  const input = { schemaVersion: 3, scenario: 'container-apps-create-v3', definitionFile: options.config,
    discovery: { discoveryClientId: definition.authentication.allowedClientIds[0], expectedUserId: user.oid },
    proof: { toolName: 'get_information', arguments: {}, safetyReview: { readOnly: true, reason: 'Synthetic fixed GET review.' } },
    probeMode: 'separate', consumer: 'none', relatedProjects: [], historyReviewed: true, privateExportReviewed: true };
  await writeFile(config, JSON.stringify(input));
  const runOptions = { workspaceRoot: options.workspaceRoot, config, output };
  const plan = await planValidation(runOptions);
  await startValidation({ ...runOptions, approval: plan.approvalToken });
  const active = { workspaceRoot: options.workspaceRoot, project: output };
  const next = await nextValidation(active);
  assert.equal(next.phase, 'generate');
  await runValidation({ ...active, approval: next.approvalToken });
  const status = await validationStatus(active);
  assert.equal(status.schemaVersion, 3);
  assert.ok(status.milestones.some(m => m.name === 'client-registration' && m.outcome === 'pending'));
  assert.equal((await nextValidation(active)).gate, 'prerequisites');
  await writeFile(config, JSON.stringify({ ...input, schemaVersion: 2, scenario: 'container-apps-create-v2' }));
  await assert.rejects(planValidation({ ...runOptions, output: `${output}-old` }), /does not support/);
});

test('hosted connection ceremony binds browser, Entra user, PKCE, provider issuer and CSRF', async t => {
  const { runtime } = compileHostingRecipe(fixture('oauth-authorization-code-v1'));
  const settings = runtime.backendAuthentication.settings;
  let nonce, providerVerifier, requests = 0;
  const caller = { ...user, azp: settings.portal.clientId, exp: Math.floor(Date.now() / 1000) + 900 };
  const deps = { env, log: () => {}, verify: async () => caller,
    verifyPortalId: async () => ({ ...caller, nonce }),
    request: async (url, options) => {
      requests++;
      const form = new URLSearchParams(options.body);
      assert.ok(form.get('code_verifier'));
      if (url === settings.tokenEndpoint) {
        assert.equal(pkce(form.get('code_verifier')), providerVerifier);
        return response('provider.user.token', { refresh_token: 'provider-refresh' });
      }
      return response('portal.api.token', { id_token: 'synthetic-id-token' });
    } };
  const backend = createBackendAuthorization(runtime, deps);
  const portal = createAuthPortal(runtime, backend, deps);
  const server = createServer(async (req, res) => { if (!await portal(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (url, cookie) => fetch(`${origin}${url}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  const login = await get('/auth/login');
  const target = new URL(login.headers.get('location'));
  nonce = target.searchParams.get('nonce');
  const initialCookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  const rejected = await get(`/auth/entra/callback?code=synthetic&state=${target.searchParams.get('state')}`, 'wrong=cookie');
  assert.equal(rejected.status, 400); assert.equal(requests, 0);
  const callback = await get(`/auth/entra/callback?code=synthetic&state=${target.searchParams.get('state')}`, initialCookie);
  assert.equal(callback.status, 303);
  const sessionCookie = callback.headers.get('set-cookie').split(';')[0];
  const html = await (await get('/auth', sessionCookie)).text();
  assert.doesNotMatch(html, /provider\.user\.token|portal\.api\.token/);
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
  const action = await fetch(`${origin}/auth/action`, { method: 'POST', redirect: 'manual',
    headers: { cookie: sessionCookie, origin: 'https://mcp.example.com', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ action: 'connect', csrf }) });
  assert.equal(action.status, 303);
  const provider = new URL(action.headers.get('location'));
  providerVerifier = provider.searchParams.get('code_challenge');
  const providerPath = `/auth/provider/callback?${new URLSearchParams({ code: 'provider-code',
    state: provider.searchParams.get('state'), iss: settings.issuer })}`;
  assert.equal((await get(providerPath, sessionCookie)).status, 303);
  assert.equal(await backend.authorize(user), 'provider.user.token');
  await assert.rejects(backend.authorize(other));
  assert.equal((await get(providerPath, sessionCookie)).status, 400);
  assert.equal(requests, 2);
});
