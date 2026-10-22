import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { generateKeyPair, SignJWT } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { compileContainerApps, planContainerApps, writeContainerApps } from '../src/mcp-container-apps.js';
import { createProtocolServer, createTokenVerifier, createRequestHandler } from '../src/recipes/container-apps/runtime.js';
import { TOOLKIT_ROOT } from '../src/config.js';
import { main } from '../bin/copilot-mcp.js';

const example = JSON.parse(await readFile(new URL('../examples/mcp/container-apps-direct.json', import.meta.url)));
const { runtime } = compileContainerApps(example);
const keys = await generateKeyPair('RS256');
async function token(claims = {}, options = {}) {
  return new SignJWT({ tid: runtime.authentication.tenantId, oid: '55555555-5555-4555-8555-555555555555',
    azp: runtime.authentication.allowedClientIds[0], scp: runtime.authentication.scope, ver: '2.0', ...claims })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(options.issuer ?? `https://login.microsoftonline.com/${runtime.authentication.tenantId}/v2.0`)
    .setAudience(options.audience ?? runtime.authentication.audience)
    .setIssuedAt().setNotBefore(options.notBefore ?? '0s').setExpirationTime(options.expiration ?? '5m')
    .sign(options.key ?? keys.privateKey);
}
async function workspace(t) {
  const parent = path.join(TOOLKIT_ROOT, '.test-output');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'container-apps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'input.json');
  await writeFile(config, JSON.stringify(example));
  return { workspaceRoot: root, config, output: path.join(root, 'generated') };
}

test('recipe rejects unsupported mappings, auth, targets and unreviewed read-only declarations', () => {
  const mutations = [
    x => { x.review.readOnlyOperationIds = []; },
    x => { x.review.readOnlyOperationIds = ['another']; },
    x => { x.backend.auth = 'api-key'; },
    x => { x.backend.origin = 'http://public-data.example.com'; },
    x => { x.backend.origin = 'https://user:password@example.com'; },
    x => { x.backend.origin = 'https://127.0.0.1'; },
    x => { x.backend.origin = 'https://example.com/path'; },
    x => { x.backend.origin = 'https://example.com?api_key=hidden'; },
    x => { x.authentication.tenantId = x.azure.subscriptionId; },
    x => { x.authentication.allowedClientIds = []; },
    x => { x.azure.environmentResourceId = x.azure.environmentResourceId.replace(x.azure.subscriptionId, x.azure.tenantId); },
    x => { x.document.paths['/information'].get.parameters = [{ in: 'query', name: 'q', schema: { type: 'string' } }]; },
    x => { x.document.paths['/information'].get.requestBody = {}; },
    x => { x.document.paths['/information'].get['x-cowork-backend'] = { path: '/other' }; },
    x => { x.document.paths['/information'].get.servers = [{ url: 'https://other.example.com' }]; },
    x => { x.document.paths['/information'].servers = [{ url: 'https://other.example.com' }]; },
    x => { x.document.servers = [{ url: 'https://other.example.com' }]; },
    x => { x.document.paths['/information'].get.callbacks = {}; },
    x => { x.document.paths['/information'].get.security = [{ oauth: ['read'] }]; },
    x => { x.document.paths['/information'].get.$ref = '#/components/other'; },
    x => { x.document.paths['/information'].post = x.document.paths['/information'].get; delete x.document.paths['/information'].get; },
    x => { x.document.paths['/../private'] = x.document.paths['/information']; delete x.document.paths['/information']; },
    x => { x.requestsPerMinute = 0; },
  ];
  for (const mutate of mutations) {
    const input = structuredClone(example); mutate(input);
    assert.throws(() => compileContainerApps(input), undefined, mutate.toString());
  }
  assert.deepEqual(compileContainerApps(example).runtime.tools.map(t => t.name), ['get_information']);
});

test('generation binds reviewed source, destination and target without APIM or effects', async t => {
  const options = await workspace(t);
  const plan = await planContainerApps(options);
  assert.equal(plan.review.evidence, 'generated-definitions-not-observed-tools-list');
  assert.equal(plan.review.toolDefinitions[0].annotations.readOnlyHint, true);
  assert.match(plan.files['runtime.js'], /jwtVerify/);
  assert.equal(plan.files.Dockerfile, undefined);
  assert.equal(plan.review.imageBuild.status, 'blocked-missing-digest-pinned-inputs');
  const template = JSON.parse(plan.files['infra/container-app.json']);
  assert.equal(template.resources.length, 1);
  assert.equal(template.resources[0].type, 'Microsoft.App/containerApps');
  assert.equal(template.resources[0].properties.configuration.ingress.allowInsecure, false);
  assert.equal(template.parameters.containerImage.defaultValue, undefined);
  assert.equal(template.resources[0].properties.template.scale.minReplicas, 1);
  assert.equal(template.resources[0].properties.configuration.registries[0].identity, example.azure.registry.pullIdentityResourceId);
  assert.equal(plan.files['mcp-server.json'], undefined);
  const lock = JSON.parse(plan.files['package-lock.json']);
  assert.deepEqual(lock.packages[''].dependencies, JSON.parse(plan.files['package.json']).dependencies);
  for (const [name, pkg] of Object.entries(lock.packages)) if (name) {
    assert.ok(pkg.resolved.startsWith('https://registry.npmjs.org/'));
    assert.ok(pkg.integrity);
  }
  await assert.rejects(writeContainerApps({ ...options, approval: 'wrong' }), /approval/);
  await assert.rejects(writeContainerApps({ ...options, output: path.join(options.workspaceRoot, 'other'), approval: plan.approvalToken }), /approval/);
  const changed = structuredClone(example); changed.requestsPerMinute++;
  await writeFile(options.config, JSON.stringify(changed));
  await assert.rejects(writeContainerApps({ ...options, approval: plan.approvalToken }), /approval/);
  await writeFile(options.config, JSON.stringify(example));
  const written = await writeContainerApps({ ...options, approval: plan.approvalToken });
  assert.equal(written.status, 'generated-not-deployed');
  for (const [name, content] of Object.entries(plan.files)) assert.equal(await readFile(path.join(options.output, name), 'utf8'), content);
  await assert.rejects(writeContainerApps({ ...options, approval: plan.approvalToken }), /exists/);
  assert.equal((await readdir(options.output)).length, Object.keys(plan.files).length);
});

test('scale-to-zero is an explicit newly reviewed source choice, never an implicit cost default', async t => {
  const options = await workspace(t);
  const initial = await planContainerApps(options);
  const input = structuredClone(example); input.scaleProfile = 'scale-to-zero';
  await writeFile(options.config, JSON.stringify(input));
  const plan = await planContainerApps(options);
  assert.notEqual(plan.approvalToken, initial.approvalToken);
  const template = JSON.parse(plan.files['infra/container-app.json']);
  assert.equal(template.resources[0].properties.template.scale.minReplicas, 0);
  assert.equal(template.resources[0].properties.template.scale.maxReplicas, 1);
  await assert.rejects(writeContainerApps({ ...options, approval: initial.approvalToken }));
});

test('CLI exposes closed recipe commands and keeps summaries separate from JSON', async t => {
  const options = await workspace(t);
  const chunks = [], errors = [];
  t.mock.method(process.stdout, 'write', value => { chunks.push(String(value)); return true; });
  t.mock.method(process.stderr, 'write', value => { errors.push(String(value)); return true; });
  assert.equal(await main(['mcp-container-apps-plan', '--workspace-root', options.workspaceRoot,
    '--config', options.config, '--output', options.output, '--summary', '--json']), 0);
  const plan = JSON.parse(chunks.join(''));
  assert.match(errors.join(''), /EXACT approvalToken/);
  assert.equal(plan.review.authentication.audience, example.authentication.audience);
  chunks.length = 0;
  assert.equal(await main(['mcp-container-apps-create', '--workspace-root', options.workspaceRoot,
    '--config', options.config, '--output', options.output, '--approve', plan.approvalToken, '--json']), 0);
  assert.equal(JSON.parse(chunks.join('')).liveQualified, false);
  chunks.length = 0;
  assert.notEqual(await main(['mcp-container-apps-schema', '--allow-cloud', '--json']), 0);
  assert.doesNotThrow(() => JSON.parse(chunks.join('')));
});

test('actual MCP SDK publishes accurate hints and invokes only the fixed reviewed GET', async t => {
  const calls = [];
  const server = createProtocolServer(runtime, { request: async (...args) => {
    calls.push(args); return Response.json({ value: 42 });
  } });
  const client = new Client({ name: 'offline-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const { tools } = await client.listTools();
  assert.deepEqual(tools[0].annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  assert.equal(tools[0].inputSchema.additionalProperties, false);
  assert.equal(calls.length, 0);
  const result = await client.callTool({ name: 'get_information', arguments: {} });
  assert.deepEqual(JSON.parse(result.content[0].text), { value: 42 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://public-data.example.com/information');
  assert.deepEqual(calls[0][1].headers, { accept: 'application/json' });
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].signal.aborted, false);
  await assert.rejects(client.callTool({ name: 'get_information', arguments: { url: 'https://other.example.com' } }), /empty arguments/);
  await assert.rejects(client.callTool({ name: 'missing', arguments: {} }), /listed tool/);
  assert.equal(calls.length, 1);
});

test('backend failures are explicit, bounded and never retried or reflected into logs', async () => {
  const failures = [
    () => { throw new Error('private backend detail'); },
    () => new Response('private backend detail', { status: 401 }),
    () => new Response('redirect detail', { status: 302, headers: { location: 'https://other.example.com' } }),
    () => new Response('text', { headers: { 'content-type': 'text/plain' } }),
    () => new Response('not JSON', { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1048577' } }),
    () => new Response(' '.repeat(1048577), { headers: { 'content-type': 'application/json' } }),
  ];
  for (const failure of failures) {
    let calls = 0; const logs = [];
    const server = createProtocolServer(runtime, { request: async () => { calls++; return failure(); }, log: e => logs.push(e) });
    const client = new Client({ name: 'offline-test', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st); await client.connect(ct);
      const result = await client.callTool({ name: 'get_information', arguments: {} });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /No retry/);
      assert.equal(calls, 1);
      assert.deepEqual(logs, [{ event: 'backend-call-failed', tool: 'get_information' }]);
      assert.doesNotMatch(JSON.stringify(result), /private backend detail|redirect detail/);
    } finally { await client.close(); await server.close(); }
  }
});

test('real signature validation enforces delegated tenant, audience, scope, client and token lifetime', async () => {
  const verify = createTokenVerifier(runtime.authentication, keys.publicKey);
  assert.equal((await verify(await token())).tid, runtime.authentication.tenantId);
  const otherKeys = await generateKeyPair('RS256');
  for (const [claims, options] of [
    [{ tid: example.azure.subscriptionId }, {}],
    [{ ver: '1.0' }, {}],
    [{ scp: 'another_scope' }, {}],
    [{ scp: undefined, roles: ['access_as_user'] }, {}],
    [{ azp: example.azure.subscriptionId }, {}],
    [{ oid: undefined }, {}],
    [{}, { audience: example.azure.subscriptionId }],
    [{}, { issuer: 'https://issuer.example.com' }],
    [{}, { expiration: '-30s' }],
    [{}, { notBefore: '5m' }],
    [{}, { key: otherKeys.privateKey }],
  ]) await assert.rejects(verify(await token(claims, options)));
  await assert.rejects(verify('invalid'));
});

async function httpFixture(t, config = runtime, overrides = {}) {
  let handler;
  const server = createServer((req, res) => handler(req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const calls = [], logs = [];
  handler = createRequestHandler(config, `${base}/mcp`, {
    verify: createTokenVerifier(config.authentication, keys.publicKey),
    request: async (...args) => { calls.push(args); return Response.json({ ok: true }); },
    log: event => logs.push(event), ...overrides,
  });
  const post = async (body, headers = {}) => fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { base, calls, logs, post };
}

test('HTTP handler requires real Entra signatures and does not forward caller credentials', async t => {
  const { base, calls, post } = await httpFixture(t);
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal(calls.length, 0);
  const missing = await post(list);
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get('www-authenticate'), /oauth-protected-resource/);
  assert.equal((await post(list, { authorization: 'Bearer invalid' })).status, 401);
  assert.equal((await post(list, { authorization: `Bearer ${await token({ scp: 'wrong' })}` })).status, 403);
  const auth = { authorization: `Bearer ${await token()}` };
  assert.equal((await post(list, { ...auth, origin: 'https://evil.example.com' })).status, 403);
  const response = await post(list, auth);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.tools[0].annotations.readOnlyHint, true);
  assert.equal(calls.length, 0);
  const call = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'get_information', arguments: {} } }, { ...auth, cookie: 'private=example' });
  assert.equal(call.status, 200);
  assert.equal((await call.json()).result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1].headers, { accept: 'application/json' });
  assert.equal((await fetch(`${base}/mcp`)).status, 405);
  const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  assert.equal(metadata.resource, `${base}/mcp`);
  assert.deepEqual(metadata.scopes_supported, [`${runtime.authentication.applicationIdUri}/${runtime.authentication.scope}`]);
});

test('HTTP bounds reject batches, large payloads, encodings and aggregate excess', async t => {
  const { post, calls } = await httpFixture(t);
  const auth = { authorization: `Bearer ${await token()}` };
  assert.equal((await post([], auth)).status, 400);
  assert.equal((await post({ value: 'x'.repeat(65536) }, auth)).status, 413);
  assert.equal((await post({}, { ...auth, 'content-encoding': 'gzip' })).status, 415);
  assert.equal(calls.length, 0);
  const limited = await httpFixture(t, { ...runtime, requestsPerMinute: 1 });
  assert.equal((await limited.post({})).status, 401);
  assert.equal((await limited.post({})).status, 429);
  const unavailable = await httpFixture(t, runtime, { verify: async () => { throw new Error('private identity service detail'); } });
  const result = await unavailable.post({}, auth);
  assert.equal(result.status, 503);
  assert.doesNotMatch(await result.text(), /private identity service detail/);
  assert.deepEqual(unavailable.logs, [{ event: 'authentication-unavailable' }]);
});

test('request and backend size limits admit the exact boundary and reject the next byte', async t => {
  const { post } = await httpFixture(t);
  const auth = { authorization: `Bearer ${await token()}` };
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { padding: '' } } };
  body.params._meta.padding = 'x'.repeat(65536 - Buffer.byteLength(JSON.stringify(body)));
  assert.equal(Buffer.byteLength(JSON.stringify(body)), 65536);
  assert.equal((await post(body, auth)).status, 200);
  body.params._meta.padding += 'x';
  assert.equal((await post(body, auth)).status, 413);
  const data = `"${'x'.repeat(1048574)}"`;
  assert.equal(Buffer.byteLength(data), 1048576);
  const exact = await httpFixture(t, runtime, { request: async () => new Response(data, {
    headers: { 'content-type': 'application/json' },
  }) });
  const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_information', arguments: {} } };
  const response = await exact.post(call, auth);
  const result = (await response.json()).result;
  assert.equal(result.isError, undefined);
  assert.equal(Buffer.byteLength(result.content[0].text), 1048576);
});

test('backend timeout cancels one dispatched call without retry', { timeout: 15000 }, async t => {
  let calls = 0, aborted = false;
  const fixture = await httpFixture(t, runtime, { request: async (_url, { signal }) => {
    calls++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      aborted = true; reject(signal.reason);
    }, { once: true }));
  } });
  const started = performance.now();
  const response = await fixture.post({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'get_information', arguments: {} } }, { authorization: `Bearer ${await token()}` });
  assert.equal((await response.json()).result.isError, true);
  assert.equal(calls, 1);
  assert.equal(aborted, true);
  assert.ok(performance.now() - started >= 9900);
  assert.ok(performance.now() - started < 14000);
});
