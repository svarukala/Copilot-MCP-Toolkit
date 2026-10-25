import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { generateKeyPair, SignJWT } from 'jose';
import { compileHostingRecipe, compileContainerApps, planHostingRecipe, writeHostingRecipe } from '../src/mcp-container-apps.js';
import { planRecipeRelease, recipeSourcePlan } from '../src/mcp-recipe-artifacts.js';
import { createProtocolServer, createRequestHandler, createTokenVerifier, createGatewayVerifier,
  resolveBackendCredential, validateRuntimeConfig } from '../src/recipes/container-apps/runtime.js';
import { TOOLKIT_ROOT } from '../src/config.js';
import { main } from '../bin/copilot-mcp.js';

const recipes = ['container-apps-direct', 'container-apps-apim', 'app-service-container', 'functions-sdk'];
const inputs = Object.fromEntries(await Promise.all(recipes.map(async recipe => [recipe,
  JSON.parse(await readFile(new URL(`../examples/mcp/${recipe}.json`, import.meta.url)))])));
const credential = 'synthetic-only+key/with=encoding%42';
const env = { MCP_BACKEND_API_KEY: credential };
function secured(recipe = recipes[0], placement = 'header') {
  const input = structuredClone(inputs[recipe]);
  input.backend = { origin: 'https://private-data.example.com', auth: 'api-key', apiKey: {
    tenantId: input.azure.tenantId,
    keyVaultResourceId: `/subscriptions/${input.azure.subscriptionId}/resourceGroups/synthetic-secrets/providers/Microsoft.KeyVault/vaults/synthetic-vault`,
    identityResourceId: `/subscriptions/${input.azure.subscriptionId}/resourceGroups/synthetic-secrets/providers/Microsoft.ManagedIdentity/userAssignedIdentities/synthetic-secret-reader`,
    secretIdentifier: 'https://synthetic-vault.vault.azure.net/secrets/backend-access/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sharedAccessReviewed: true,
    ...(placement === 'header' ? { headerName: 'X-Backend-Key' } : { queryParameterName: 'api_key', queryExposureReviewed: true }),
  } };
  input.document.components = { securitySchemes: {
    backendKey: { type: 'apiKey', in: placement, name: placement === 'header' ? 'X-Backend-Key' : 'api_key' },
  } };
  input.document.security = [{ backendKey: [] }];
  return input;
}
async function workspace(t, input) {
  const parent = path.join(TOOLKIT_ROOT, '.test-output');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'hosting-key-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'input.json');
  await writeFile(config, JSON.stringify(input));
  return { workspaceRoot: root, config, output: path.join(root, 'server') };
}
async function protocol(t, runtime, dependencies = {}) {
  const server = createProtocolServer(runtime, { env, ...dependencies });
  const client = new Client({ name: 'synthetic-offline-key-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}
const call = client => client.callTool({ name: 'get_information', arguments: {} });

for (const recipe of recipes) for (const placement of ['header', 'query']) {
  test(`${recipe}: ${placement} key references are explicit, separate, sealed and bound to release`, async t => {
    const input = secured(recipe, placement), key = input.backend.apiKey;
    const options = await workspace(t, input);
    const plan = await planHostingRecipe(options);
    const { runtime } = compileHostingRecipe(input);
    assert.deepEqual(plan.review.backend, input.backend);
    if (recipe === 'container-apps-direct') assert.deepEqual(compileContainerApps(input).runtime, runtime);
    const name = recipe.startsWith('container-apps') ? 'container-app' : recipe === 'functions-sdk' ? 'functions' : 'app-service';
    const template = JSON.parse(plan.files[`infra/${name}.json`]), resource = template.resources[0];
    assert.deepEqual(Object.keys(resource.identity.userAssignedIdentities).sort(),
      [key.identityResourceId, input.azure.registry?.pullIdentityResourceId ?? input.azure.storage.identityResourceId].sort());
    assert.doesNotMatch(JSON.stringify(template), /roleAssignments|accessPolicies|listKeys/);
    if (recipe.startsWith('container-apps')) {
      assert.deepEqual(resource.properties.configuration.secrets,
        [{ name: 'mcp-backend-api-key', keyVaultUrl: key.secretIdentifier, identity: key.identityResourceId }]);
      assert.deepEqual(resource.properties.template.containers[0].env.at(-1),
        { name: 'MCP_BACKEND_API_KEY', secretRef: 'mcp-backend-api-key' });
      assert.equal(resource.properties.configuration.registries[0].identity, input.azure.registry.pullIdentityResourceId);
    } else {
      assert.equal(resource.properties.keyVaultReferenceIdentity, key.identityResourceId);
      assert.deepEqual(resource.properties.siteConfig.appSettings.find(s => s.name === 'MCP_BACKEND_API_KEY'),
        { name: 'MCP_BACKEND_API_KEY', value: `@Microsoft.KeyVault(SecretUri=${key.secretIdentifier})` });
    }
    if (recipe === 'container-apps-apim') {
      const anonymous = await planHostingRecipe(await workspace(t, inputs[recipe]));
      assert.equal(plan.files['infra/apim-gateway.json'], anonymous.files['infra/apim-gateway.json']);
    }
    assert.equal(runtime.backendAuthentication.type, 'api-key');
    assert.ok(!JSON.stringify(runtime).includes('vault.azure.net'));
    assert.ok(!JSON.stringify(plan).includes(credential));
    await writeHostingRecipe({ ...options, approval: plan.approvalToken });
    const source = await recipeSourcePlan({ ...options, project: options.output });
    const releaseConfig = path.join(options.workspaceRoot, 'release.json');
    await writeFile(releaseConfig, JSON.stringify({
      schemaVersion: 1, accountName: 'operator@example.com',
      ...(recipe === 'functions-sdk' ? { sourceArchiveSha256: source.sourceArchiveSha256 }
        : { containerImage: `${input.azure.registry.server}/mcp@sha256:${'a'.repeat(64)}` }),
      ...(recipe === 'container-apps-apim' ? { backendOrigin: `https://${input.azure.appName}.synthetic.azurecontainerapps.io` } : {}),
    }));
    const release = await planRecipeRelease({ ...options, project: options.output, config: releaseConfig,
      output: path.join(options.workspaceRoot, 'release') });
    assert.deepEqual(release.review.backend, input.backend);
    assert.ok(release.review.checkpoints.some(c => c.includes('Key Vault')));
    assert.ok(!JSON.stringify(release).includes(credential));
    const calls = [];
    const client = await protocol(t, runtime, { request: async (...args) => { calls.push(args); return Response.json({ result: 42 }); } });
    assert.equal((await client.listTools()).tools[0].annotations.readOnlyHint, true);
    assert.equal(calls.length, 0);
    assert.equal((await call(client)).isError, undefined);
    assert.equal(calls.length, 1);
    const [url, request] = calls[0];
    const parsed = new URL(url);
    assert.equal(parsed.origin, input.backend.origin);
    assert.equal(parsed.pathname, '/information');
    assert.equal(request.redirect, 'error');
    assert.equal(request.method, 'GET');
    assert.deepEqual(request.headers, placement === 'header' ? { accept: 'application/json', 'X-Backend-Key': credential }
      : { accept: 'application/json' });
    assert.equal(parsed.searchParams.get('api_key'), placement === 'query' ? credential : null);
    await assert.rejects(client.callTool({ name: 'get_information', arguments: { api_key: 'replacement' } }), /empty arguments/);
    assert.equal(calls.length, 1);
  });
}

test('percent-encoded form reflection is rejected independent of escape casing', async t => {
  const runtime = compileHostingRecipe(secured(recipes[0], 'query')).runtime;
  const key = 'synthetic+key!~()';
  const reflected = new URLSearchParams({ api_key: key }).toString().replace('%2B', '%2b').replace('%7E', '%7e');
  const client = await protocol(t, runtime, { env: { MCP_BACKEND_API_KEY: key }, log: () => {},
    request: async () => Response.json({ url: `https://private-data.example.com/?${reflected}` }) });
  const result = await call(client);
  assert.equal(result.isError, true);
  assert.ok(!JSON.stringify(result).includes(key));
  assert.ok(!JSON.stringify(result).includes(reflected));
});

test('closed key schema rejects literals, malformed/cross-target references, identity reuse and reserved placement', () => {
  const mutations = [
    x => { x.backend.apiKey = credential; },
    x => { x.backend.apiKey.value = credential; },
    x => { delete x.backend.apiKey.sharedAccessReviewed; },
    x => { x.backend.apiKey.sharedAccessReviewed = false; },
    x => { x.backend.apiKey.secret = credential; },
    x => { x.backend.apiKey.secretIdentifier = credential; },
    x => { x.backend.apiKey.secretIdentifier += '?secret=value'; },
    x => { x.backend.apiKey.secretIdentifier += '#fragment'; },
    x => { x.backend.apiKey.secretIdentifier = 'https://synthetic-vault.vault.azure.net:443/secrets/backend-access'; },
    x => { x.backend.apiKey.secretIdentifier = 'https://another-vault.vault.azure.net/secrets/backend-access'; },
    x => { x.backend.apiKey.secretIdentifier = 'https://synthetic-vault.vault.azure.net/secrets/name/not-a-version'; },
    x => { x.backend.apiKey.secretIdentifier = 'https://synthetic-vault.vault.azure.net/secrets/%2e%2e'; },
    x => { x.backend.apiKey.secretIdentifier = 'https://synthetic-vault.vault.azure.net/keys/name'; },
    x => { x.backend.apiKey.keyVaultResourceId = x.backend.apiKey.keyVaultResourceId.replace(x.azure.subscriptionId, x.azure.tenantId); },
    x => { x.backend.apiKey.identityResourceId = x.backend.apiKey.identityResourceId.replace(x.azure.subscriptionId, x.azure.tenantId); },
    x => { x.backend.apiKey.identityResourceId = x.backend.apiKey.identityResourceId.replace('Microsoft.ManagedIdentity', 'MicrosoftXManagedIdentity'); },
    x => { x.backend.apiKey.keyVaultResourceId = x.backend.apiKey.keyVaultResourceId.replace('Microsoft.KeyVault', 'MicrosoftXKeyVault'); },
    x => { x.backend.apiKey.tenantId = x.azure.subscriptionId; },
    x => { x.backend.apiKey.identityResourceId = x.azure.registry?.pullIdentityResourceId ?? x.azure.storage.identityResourceId; },
    x => { x.backend.apiKey.queryParameterName = 'key'; },
    x => { delete x.backend.apiKey.headerName; },
    x => { x.backend.apiKey.headerName = 'bad\r\nheader'; },
    x => { x.backend.apiKey.headerName = 'X-Backend:Key'; },
    x => { x.backend.apiKey.headerName = 'X'.repeat(101); },
    x => { x.backend.auth = 'anonymous'; },
    x => { x.backend.origin += '?api_key=literal'; },
    x => { x.document.paths['/information'].get.parameters = [{ in: 'query', name: 'api_key', schema: { type: 'string' } }]; },
  ];
  for (const recipe of recipes) for (const mutate of mutations) {
    const input = secured(recipe); mutate(input);
    assert.throws(() => compileHostingRecipe(input), undefined, `${recipe}: ${mutate}`);
  }
  for (const headerName of ['Authorization', 'Proxy-Authorization', 'Cookie', 'Host', 'Content-Length', 'Connection',
    'Accept', 'Transfer-Encoding', 'X-Copilot-MCP-Gateway-Authorization', 'X-Forwarded-Host', 'Mcp-Session-Id', 'Traceparent',
    'Proxy', 'X-HTTP-Method-Override', 'X-HTTP-Method', 'X-Method-Override', 'X-Original-URL', 'X-Rewrite-URL',
    'X-Real-IP', 'X-MS-Client-Principal', 'X-MS-Token-AAD-Access-Token']) {
    const input = secured(); input.backend.apiKey.headerName = headerName;
    assert.throws(() => compileHostingRecipe(input), /dedicated/);
  }
  for (const queryParameterName of ['authorization', 'access_token', 'client_secret', 'url', 'op', 'code', 'state', 'key&other', 'key=value', 'key#', 'key%20']) {
    const input = secured(recipes[0], 'query'); input.backend.apiKey.queryParameterName = queryParameterName;
    assert.throws(() => compileHostingRecipe(input));
  }
  for (const headerName of ['X-API-Key', 'Ocp-Apim-Subscription-Key', 'x-functions-key']) {
    const input = secured();
    input.backend.apiKey.headerName = headerName;
    input.document.components.securitySchemes.backendKey.name = headerName;
    assert.doesNotThrow(() => compileHostingRecipe(input));
  }
});

test('selected OpenAPI security must match exactly, never downgrade or combine profiles', () => {
  for (const mutate of [
    x => { x.document.security = []; },
    x => { x.document.security = [{}]; },
    x => { x.document.security.push({}); },
    x => { x.document.security[0].oauth = []; },
    x => { x.document.security[0].backendKey = ['scope']; },
    x => { x.document.security = [{ missing: [] }]; },
    x => { x.document.components.securitySchemes.backendKey.type = 'oauth2'; },
    x => { x.document.components.securitySchemes.backendKey.in = 'cookie'; },
    x => { x.document.components.securitySchemes.backendKey.name = 'Another-Key'; },
    x => { x.document.components.securitySchemes.backendKey.$ref = '#/components/securitySchemes/other'; },
    x => { x.document.paths['/information'].get.security = []; },
    x => { x.document.paths['/information'].get.security = [{ oauth: [] }]; },
    x => { x.backend = inputs[recipes[0]].backend; },
  ]) {
    const input = secured(); mutate(input);
    assert.throws(() => compileHostingRecipe(input), undefined, mutate.toString());
  }
  const input = secured();
  input.document.components.securitySchemes.backendKey.name = 'x-backend-key';
  assert.doesNotThrow(() => compileHostingRecipe(input));
  input.document.paths['/information'].get.security = input.document.security;
  delete input.document.security;
  assert.doesNotThrow(() => compileHostingRecipe(input));
  delete input.document.paths['/information'].get.security;
  delete input.document.components;
  input.backend.apiKey.secretIdentifier = 'https://synthetic-vault.vault.azure.net/secrets/backend-access';
  assert.doesNotThrow(() => compileHostingRecipe(input));
  const query = secured(recipes[0], 'query');
  delete query.backend.apiKey.queryExposureReviewed;
  assert.throws(() => compileHostingRecipe(query));
  query.backend.apiKey.queryExposureReviewed = true;
  query.document.components.securitySchemes.backendKey.name = 'API_KEY';
  assert.throws(() => compileHostingRecipe(query), /exactly match/);
});

test('startup refuses unavailable or unresolved keys before health or any dispatch, without echoing values', () => {
  const runtime = compileHostingRecipe(secured()).runtime;
  for (const value of [undefined, '', ' ', 'line\nbreak', 'tabs\there', 'trailing ', 'nonascii\u00e9',
    'x'.repeat(4097), '@Microsoft.KeyVault(SecretUri=https://synthetic-vault.vault.azure.net/secrets/backend-access)',
    'keyvaultref:https://synthetic-vault.vault.azure.net/secrets/backend-access', '<placeholder>',
    'https://synthetic-vault.vault.azure.net/secrets/backend-access']) {
    const environment = { MCP_BACKEND_API_KEY: value };
    assert.throws(() => resolveBackendCredential(runtime, environment), /configuration is unavailable/);
    assert.throws(() => createProtocolServer(runtime, { env: environment }), /configuration is unavailable/);
    assert.throws(() => createRequestHandler(runtime, 'http://localhost:3000/mcp', { env: environment }), /configuration is unavailable/);
  }
  assert.equal(resolveBackendCredential(runtime, { MCP_BACKEND_API_KEY: 'x'.repeat(4096) }).length, 4096);
  const anonymous = compileHostingRecipe(inputs[recipes[0]]).runtime;
  assert.equal(resolveBackendCredential(anonymous, env), undefined);
  assert.throws(() => validateRuntimeConfig({ ...runtime, backendAuthentication: { type: 'api-key', headerName: 'Authorization' } }));
  assert.throws(() => validateRuntimeConfig({ ...runtime, backendAuthentication: { type: 'api-key', headerName: 'X-Key', value: credential } }));
});

test('secret-bearing backend errors, redirects and obvious encoded reflections fail without leakage or retry', async t => {
  const runtime = compileHostingRecipe(secured(recipes[0], 'query')).runtime;
  const failureCases = [
    () => { throw new Error(`https://private-data.example.com/information?api_key=${credential}`); },
    () => Response.json({ secret: credential }, { status: 401 }),
    () => new Response(credential, { status: 302, headers: { location: `https://other.example.com/?key=${credential}` } }),
    () => Response.json({ value: credential }),
    () => Response.json({ [`reflected-${credential}`]: 'value' }),
    () => Response.json({ nested: [{ url: `https://private-data.example.com/?api_key=${encodeURIComponent(credential)}` }] }),
    () => Response.json({ encoded: Buffer.from(credential).toString('base64') }),
    () => Response.json({ encoded: Buffer.from(credential).toString('base64url') }),
    () => new Response(JSON.stringify({ key: credential }).replace('synthetic', '\\u0073ynthetic'),
      { headers: { 'content-type': 'application/json' } }),
    () => new Response(credential, { headers: { 'content-type': 'text/plain' } }),
  ];
  const diagnostics = [
    { failureKind: 'request' },
    { failureKind: 'http-status', httpStatus: 401 },
    { failureKind: 'http-status', httpStatus: 302 },
    ...Array.from({ length: 6 }, () => ({ failureKind: 'credential-reflection', httpStatus: 200 })),
    { failureKind: 'content-type', httpStatus: 200 },
  ];
  for (const [index, failure] of failureCases.entries()) {
    let calls = 0; const logs = [];
    const client = await protocol(t, runtime, { request: async () => { calls++; return failure(); }, log: e => logs.push(e) });
    const result = await call(client);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No retry/);
    assert.equal(calls, 1);
    assert.deepEqual(logs, [{ event: 'backend-call-failed', tool: 'get_information', ...diagnostics[index] }]);
    for (const secret of [credential, encodeURIComponent(credential), Buffer.from(credential).toString('base64')]) {
      assert.ok(!JSON.stringify({ result, logs }).includes(secret));
    }
  }
});

test('API key does not replace caller or gateway signatures and never forwards either token', async t => {
  const runtime = compileHostingRecipe(secured('container-apps-apim')).runtime;
  const keys = await generateKeyPair('RS256');
  const sign = (claims, audience) => new SignJWT({ tid: runtime.authentication.tenantId, ver: '2.0', ...claims })
    .setProtectedHeader({ alg: 'RS256' }).setIssuer(`https://login.microsoftonline.com/${runtime.authentication.tenantId}/v2.0`)
    .setAudience(audience).setIssuedAt().setNotBefore('0s').setExpirationTime('5m').sign(keys.privateKey);
  const caller = await sign({ oid: '55555555-5555-4555-8555-555555555555',
    azp: runtime.authentication.allowedClientIds[0], scp: runtime.authentication.scope }, runtime.authentication.audience);
  const gateway = await sign({ oid: runtime.gateway.principalId, roles: [runtime.gateway.role] }, runtime.gateway.audience);
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const endpoint = `http://127.0.0.1:${server.address().port}/mcp`, calls = [];
  server.on('request', createRequestHandler(runtime, endpoint, { env, log: () => {},
    verify: createTokenVerifier(runtime.authentication, keys.publicKey), verifyGateway: createGatewayVerifier(runtime.gateway, keys.publicKey),
    request: async (...args) => { calls.push(args); return Response.json({ value: 42 }); },
  }));
  const post = headers => fetch(endpoint, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_information', arguments: {} } }),
  });
  assert.equal((await post({ authorization: `Bearer ${caller}` })).status, 401);
  assert.equal((await post({ 'x-copilot-mcp-gateway-authorization': `Bearer ${gateway}` })).status, 401);
  assert.equal((await post({ authorization: `Bearer ${caller}`, 'x-copilot-mcp-gateway-authorization': 'Bearer forged' })).status, 403);
  assert.equal(calls.length, 0);
  const result = await post({ authorization: `Bearer ${caller}`, 'x-copilot-mcp-gateway-authorization': `Bearer ${gateway}`,
    'X-Backend-Key': 'caller-cannot-select-this', cookie: 'private=synthetic' });
  assert.equal((await result.json()).result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1].headers, { accept: 'application/json', 'X-Backend-Key': credential });
});

test('nonsecret authentication changes invalidate exact creation approval and CLI summaries expose bindings', async t => {
  const input = secured(), options = await workspace(t, input), plan = await planHostingRecipe(options);
  for (const mutate of [
    x => { x.backend.apiKey.secretIdentifier = x.backend.apiKey.secretIdentifier.replace(/a{32}$/, 'b'.repeat(32)); },
    x => { x.backend.apiKey.secretIdentifier = x.backend.apiKey.secretIdentifier.replace(/\/a{32}$/, ''); },
    x => { x.backend.apiKey.identityResourceId += '-other'; },
    x => {
      x.backend.apiKey.keyVaultResourceId = x.backend.apiKey.keyVaultResourceId.replace('synthetic-vault', 'another-vault');
      x.backend.apiKey.secretIdentifier = x.backend.apiKey.secretIdentifier.replace('synthetic-vault', 'another-vault');
    },
    x => {
      x.backend.apiKey.headerName = 'X-Another-Key';
      x.document.components.securitySchemes.backendKey.name = 'X-Another-Key';
    },
  ]) {
    const changed = structuredClone(input); mutate(changed);
    await writeFile(options.config, JSON.stringify(changed));
    const next = await planHostingRecipe(options);
    assert.notEqual(next.approvalToken, plan.approvalToken);
    assert.notEqual(JSON.parse(next.files['recipe-manifest.json']).contentDigest, JSON.parse(plan.files['recipe-manifest.json']).contentDigest);
    await assert.rejects(writeHostingRecipe({ ...options, approval: plan.approvalToken }), /approval/);
  }
  await writeFile(options.config, JSON.stringify(input));
  const stdout = [], stderr = [];
  t.mock.method(process.stdout, 'write', text => { stdout.push(String(text)); return true; });
  t.mock.method(process.stderr, 'write', text => { stderr.push(String(text)); return true; });
  assert.equal(await main(['mcp-hosting-plan', '--workspace-root', options.workspaceRoot, '--config', options.config,
    '--output', options.output, '--summary', '--json']), 0);
  assert.equal(JSON.parse(stdout.join('')).review.backend.auth, 'api-key');
  assert.ok(stderr.join('').includes(input.backend.apiKey.secretIdentifier));
  assert.ok(stderr.join('').includes(input.backend.apiKey.identityResourceId));
  assert.ok(stderr.join('').includes(plan.approvalToken));
});
