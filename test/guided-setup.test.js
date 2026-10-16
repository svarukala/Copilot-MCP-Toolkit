import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { guidedArguments } from '../src/guided.js';
import { withCliWorkspace, TOOLKIT_ROOT } from '../src/config.js';
import { planMcpResume } from '../src/mcp-resume.js';
import { prepareMcpServer } from '../src/mcp-server.js';

const uuid = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const tenant = uuid(2), subscription = uuid(3);
const group = `/subscriptions/${subscription}/resourceGroups/synthetic-rg`;
const apim = `${group}/providers/Microsoft.ApiManagement/service/synthetic-apim`;
const vault = `${group}/providers/Microsoft.KeyVault/vaults/synthetic-vault`;
const a = value => ['ask', value], c = value => ['choose', value];
function scripted(steps, signal) {
  let output = '';
  const next = async (kind, label, choices, options) => {
    const step = steps.shift();
    assert.ok(step, `Unexpected ${kind}: ${label}`);
    assert.equal(step[0], kind, label);
    const value = typeof step[1] === 'function' ? await step[1](label, choices, output) : step[1];
    if (choices) assert.ok(choices.some(choice => choice.value === value), `${label}: ${value}`);
    if (options?.check) await options.check(value);
    return value;
  };
  return {
    output: { write: value => { output += value; } }, signal,
    ask: (label, options) => next('ask', label, undefined, options),
    choose: (label, choices) => next('choose', label, choices),
    get text() { return output; },
    done: () => assert.equal(steps.length, 0, JSON.stringify(steps)),
  };
}
async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'copilot-mcp-guided-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', () => assert.fail('Guided setup must remain offline'));
  return root;
}
const caller = (direct = false) => [
  ...(direct ? [a(tenant)] : []), a(uuid(4)), a('api://synthetic-resource'), a('access_as_user'), a(uuid(5)),
];
const key = location => [
  a('https://synthetic-vault.vault.azure.net/secrets/provider-key'),
  c(location), a(location === 'headerName' ? 'X-API-Key' : 'api_key'),
];
const get = () => [c('get'), a('https://rates.example.com/v2/latest'), a('getRates'), a('Read synthetic reference rates')];
const target = ({ keyed = false, auth = keyed ? 'api-key' : 'anonymous', apimMode = 'existing', groupMode = 'existing', vaultMode = 'existing' } = {}) => [
  ...(auth === 'anonymous' ? [c('entra')] : []),
  a(tenant), a(subscription), ...caller(),
  c(groupMode), a(group), c(apimMode), a(apim),
  ...(keyed ? [c(vaultMode), a(vault)] : []),
  ...(apimMode === 'new' || groupMode === 'new' || keyed && vaultMode === 'new' ? [a('eastus')] : []),
  ...(apimMode === 'new' ? [a('Synthetic publisher'), a('publisher@example.com'), c('Developer')] : []),
];
const confirmation = (project, value = 'create') => [a(project), c((label, choices, output) => {
  assert.match(label, /No sign-in, deployment, discovery or FCC registration/);
  assert.equal(choices[0].value, 'cancel');
  assert.match(output, /"reviewDigest": "sha256:[a-f0-9]{64}"/);
  assert.ok(output.includes(JSON.stringify(project)));
  assert.match(output, /"mcp-definition.json"/);
  assert.match(choices[1].label, /sha256:[a-f0-9]{64}/);
  return value;
})];

for (const auth of ['anonymous', 'entra', 'oauth']) test(`New references existing ${auth} MCP without Azure settings or network`, async t => {
  const root = await workspace(t), project = path.join(root, 'reference');
  const p = scripted([c('new'), c('mcp'), c(auth), a('Synthetic reference'), a('https://mcp.example.com/mcp'),
    ...(auth === 'entra' ? caller(true) : []), ...confirmation(project)]);
  const args = await guidedArguments(p, { 'workspace-root': root });
  p.done();
  assert.deepEqual(args, ['mcp-resume', '--workspace-root', root, '--project', project, '--json', '--summary']);
  const definition = JSON.parse(await readFile(path.join(project, 'mcp-definition.json')));
  const descriptor = JSON.parse(await readFile(path.join(project, 'mcp-server.json')));
  assert.equal(definition.kind, 'existing-mcp');
  assert.equal(definition.inbound.type, auth);
  assert.equal(definition.azure, undefined);
  assert.equal(descriptor.status, 'referenced-not-verified');
  assert.equal((await prepareMcpServer(definition)).descriptor.descriptorDigest, descriptor.descriptorDigest);
  assert.deepEqual((await readdir(project)).sort(), ['mcp-definition.json', 'mcp-server.json']);
  assert.doesNotMatch(p.text, /Local resource choice/);
  if (auth === 'oauth') assert.match(p.text, /REFERENCE ONLY.*discovery and runtime proof are unsupported/);
  const resume = await withCliWorkspace(root, () => planMcpResume(project));
  assert.equal(resume.replayAuthorized, false);
});

for (const auth of ['anonymous', 'entra', 'api-key', 'managed-identity']) test(`New fixed GET supports ${auth} without changing inbound authentication`, async t => {
  const root = await workspace(t), project = path.join(root, 'rest');
  const p = scripted([c('new'), c('rest'), c(auth), a('Synthetic rates'), ...get(),
    ...(auth === 'api-key' ? key('headerName') : []),
    ...(auth === 'managed-identity' ? [a(uuid(6)), a(uuid(7)), a(uuid(8)), a(uuid(9)), a('Read.All')] : []),
    ...target({ keyed: auth === 'api-key', auth }), ...confirmation(project)]);
  await guidedArguments(p, { 'workspace-root': root });
  p.done();
  const definition = JSON.parse(await readFile(path.join(project, 'mcp-definition.json')));
  assert.equal(definition.backend.auth, auth);
  assert.equal(definition.backend.endpoint, 'https://rates.example.com');
  assert.deepEqual(definition.operationIds, ['getRates']);
  assert.equal(definition.document.paths['/v2/latest'].get.operationId, 'getRates');
  assert.equal(definition.inbound.type, 'entra');
  assert.deepEqual(definition.inbound.allowedClientIds, [uuid(5)]);
  assert.equal(definition.inbound.tenantId, definition.azure.tenantId);
  assert.equal(definition.azure.apimMode, 'existing');
  if (auth === 'managed-identity') assert.equal(definition.backend.managedIdentity.principalId, uuid(6));
  await prepareMcpServer(definition);
  const resume = await withCliWorkspace(root, () => planMcpResume(project));
  assert.equal(resume.next.code, 'AZURE_IDENTITY_REQUIRED');
  assert.equal(resume.replayAuthorized, false);
});

test('New public GET requires declarations and rate limits, omits Entra app questions and still needs Azure identity', async t => {
  const root = await workspace(t), project = path.join(root, 'public');
  const p = scripted([c('new'), c('rest'), c('anonymous'), a('Public rates'), ...get(),
    c('public'), c('declare'), a('60'), a('60'), a(tenant), a(subscription),
    c('existing'), a(group), c('existing'), a(apim), ...confirmation(project)]);
  await guidedArguments(p, { 'workspace-root': root });
  p.done();
  const definition = JSON.parse(await readFile(path.join(project, 'mcp-definition.json')));
  assert.deepEqual(definition.inbound, { type: 'anonymous', publicData: true, readOnly: true,
    rateLimit: { calls: 60, renewalPeriod: 60 } });
  assert.match(p.text, /PUBLIC EXPOSURE/);
  assert.doesNotMatch(p.text, /"allowedClientIds"|"applicationIdUri"/);
  assert.equal((await withCliWorkspace(root, () => planMcpResume(project))).next.code, 'AZURE_IDENTITY_REQUIRED');
});

test('Declining public-data/read-only declaration writes nothing', async t => {
  const root = await workspace(t);
  const p = scripted([c('new'), c('rest'), c('anonymous'), a('Public rates'), ...get(), c('public'), c('cancel')]);
  assert.equal(await guidedArguments(p, { 'workspace-root': root }), undefined);
  p.done();
  assert.deepEqual(await readdir(root), []);
});

for (const source of ['rest', 'mcp']) for (const location of ['headerName', 'queryParameterName']) {
  test(`New ${source} API-key setup preserves a ${location} reference and explicit new-resource choices`, async t => {
    const root = await workspace(t), project = path.join(root, 'keyed');
    const p = scripted([c('new'), c(source), c('api-key'), a('Synthetic keyed setup'),
      ...(source === 'rest' ? get() : [a('https://mcp.example.com/provider/message')]),
      ...key(location), ...target({ keyed: true, apimMode: 'new', groupMode: 'new', vaultMode: 'new' }),
      ...confirmation(project)]);
    await guidedArguments(p, { 'workspace-root': root });
    p.done();
    const definition = JSON.parse(await readFile(path.join(project, 'mcp-definition.json')));
    assert.equal(definition.azure.sku, 'Developer');
    assert.equal(definition.azure.keyVaultMode, 'new');
    assert.equal(definition.azure.resourceGroupMode, 'new');
    assert.equal(definition.backend.apiKey[location], location === 'headerName' ? 'X-API-Key' : 'api_key');
    assert.deepEqual(Object.keys(definition.backend.apiKey).sort(), [location, 'secretIdentifier'].sort());
    assert.equal(definition.inbound.type, 'entra');
    assert.match(p.text, /not-quoted/);
    if (source === 'mcp') {
      assert.equal(definition.schemaVersion, 2);
      assert.equal(definition.kind, 'apim-mcp-proxy');
      assert.equal(definition.experimentalProfile, undefined);
      assert.equal(definition.backend.endpoint, 'https://mcp.example.com/provider/message');
      assert.match(p.text, /compatibility is not guaranteed/);
    }
    await prepareMcpServer(definition);
  });
}

test('OpenAPI import lists operations, exposes only the selection and safely renders untrusted descriptions', async t => {
  const root = await workspace(t), project = path.join(root, 'imported'), filename = path.join(root, 'openapi.json');
  const document = { openapi: '3.0.3', info: { title: 'Synthetic API', version: '1' }, paths: {
    '/read': { get: { operationId: 'read', description: 'Untrusted \u001b[31m\u009b31m', responses: { 200: { description: 'OK' } } } },
    '/write': { post: { operationId: 'write', responses: { 200: { description: 'OK' } } } },
  } };
  await writeFile(filename, JSON.stringify(document));
  const p = scripted([c('new'), c('rest'), c('anonymous'), a('Synthetic import'), c('openapi'),
    a('https://api.example.com/base'), a(filename), a('read'), ...target(), ...confirmation(project)]);
  await guidedArguments(p, { 'workspace-root': root });
  p.done();
  const definition = JSON.parse(await readFile(path.join(project, 'mcp-definition.json')));
  assert.deepEqual(definition.operationIds, ['read']);
  assert.deepEqual(definition.document, document);
  const review = await prepareMcpServer(definition);
  const operations = JSON.parse(review.files['infra/operation-map.json']).server;
  assert.deepEqual(operations.map(op => op.originalOperationId), ['read']);
  assert.match(p.text, /"id": "write"/);
  assert.doesNotMatch(p.text, /[\u001b\u009b]/);
});

test('unsupported REST OAuth and cancellation at each menu write nothing', async t => {
  const root = await workspace(t);
  for (const steps of [
    [c('new'), c('cancel')],
    [c('new'), c('rest'), c('cancel')],
    [c('new'), c('rest'), c('oauth')],
    [c('new'), c('rest'), c('anonymous'), a('Cancelled'), c('cancel')],
    [c('new'), c('rest'), c('api-key'), a('Cancelled'), ...get(), a('https://synthetic-vault.vault.azure.net/secrets/key'), c('cancel')],
    [c('new'), c('rest'), c('anonymous'), a('Cancelled'), ...get(), c('cancel')],
    [c('new'), c('rest'), c('anonymous'), a('Cancelled'), ...get(), c('entra'), a(tenant), a(subscription), ...caller(), c('cancel')],
    [c('new'), c('mcp'), c('anonymous'), a('Cancelled'), a('https://example.com/mcp'), ...confirmation(path.join(root, 'cancelled'), 'cancel')],
    [c('advanced'), c('exit')],
  ]) {
    const p = scripted(steps);
    assert.equal(await guidedArguments(p, { 'workspace-root': root }), undefined);
    p.done();
    assert.deepEqual(await readdir(root), []);
  }
});

test('new setup refuses existing, escaping, linked and toolkit destinations without changing them', async t => {
  const root = await workspace(t), existing = path.join(root, 'existing');
  await mkdir(existing);
  await writeFile(path.join(existing, 'keep.txt'), 'retain');
  const linked = path.join(root, 'linked');
  await symlink(existing, linked, process.platform === 'win32' ? 'junction' : 'dir');
  for (const destination of [existing, root, path.dirname(root), linked, 'relative-output']) {
    const p = scripted([c('new'), c('mcp'), c('anonymous'), a('Synthetic'), a('https://example.com/mcp'), a(destination)]);
    await assert.rejects(guidedArguments(p, { 'workspace-root': root }));
    assert.equal(await readFile(path.join(existing, 'keep.txt'), 'utf8'), 'retain');
  }
  const p = scripted([c('new'), c('mcp'), c('anonymous')]);
  await assert.rejects(guidedArguments(p, { 'workspace-root': TOOLKIT_ROOT }), /outside the toolkit/);
});

test('creation rechecks destination collisions and cancellation after the review', async t => {
  const root = await workspace(t), project = path.join(root, 'raced');
  const p = scripted([c('new'), c('mcp'), c('anonymous'), a('Synthetic'), a('https://example.com/mcp'),
    a(project), c(async () => { await mkdir(project); await writeFile(path.join(project, 'keep.txt'), 'retain'); return 'create'; })]);
  await assert.rejects(guidedArguments(p, { 'workspace-root': root }), { code: 'EEXIST' });
  assert.deepEqual(await readdir(project), ['keep.txt']);
  const controller = new AbortController();
  const cancelledProject = path.join(root, 'aborted');
  const aborted = scripted([c('new'), c('mcp'), c('anonymous'), a('Synthetic'), a('https://example.com/mcp'),
    a(cancelledProject), c(() => { controller.abort(); return 'create'; })], controller.signal);
  await assert.rejects(guidedArguments(aborted, { 'workspace-root': root }), /aborted before writing/);
  assert.deepEqual(await readdir(root), ['raced']);
});

test('new setup rejects execution flags and incompatible existing project/config options before collecting inputs', async t => {
  const root = await workspace(t);
  for (const key of ['approve', 'allow-network', 'allow-cloud', 'interactive', 'output']) {
    await assert.rejects(guidedArguments(scripted([]), { [key]: true }), /never accepts execution approvals/);
  }
  for (const key of ['config', 'project']) {
    await assert.rejects(guidedArguments(scripted([c('new')]), { [key]: 'existing', 'workspace-root': root }), /New setup accepts only/);
  }
  assert.deepEqual(await readdir(root), []);
});

test('invalid endpoints and unsupported OpenAPI inputs fail without publishing a bundle', async t => {
  const root = await workspace(t);
  for (const url of ['http://example.com/rates', 'https://example.com/rates?key=secret',
    'https://user:secret@example.com/rates', 'https://example.com/{pair}', 'https://example.com/a/../b']) {
    const p = scripted([c('new'), c('rest'), c('anonymous'), a('Synthetic'), c('get'), a(url)]);
    await assert.rejects(guidedArguments(p, { 'workspace-root': root }));
  }
  for (const document of [
    { openapi: '3.1.0', info: { title: 'Synthetic', version: '1' }, paths: {} },
    { openapi: '3.0.3', info: { title: 'Synthetic', version: '1' }, paths: {
      '/rates': { get: { operationId: 'read', responses: { 200: { $ref: 'https://example.com/schema' } } } },
    } },
  ]) {
    const filename = path.join(root, 'invalid.json');
    await writeFile(filename, JSON.stringify(document));
    const p = scripted([c('new'), c('rest'), c('anonymous'), a('Synthetic'), c('openapi'),
      a('https://example.com'), a(filename)]);
    await assert.rejects(guidedArguments(p, { 'workspace-root': root }));
  }
  assert.deepEqual(await readdir(root), ['invalid.json']);
});
