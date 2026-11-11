import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { guidedArguments } from '../src/guided.js';
import { withCliWorkspace, TOOLKIT_ROOT } from '../src/config.js';
import { planMcpResume } from '../src/mcp-resume.js';
import { prepareMcpServer } from '../src/mcp-server.js';
import { promptMcpResourceModes, promptMcpResourceSelection, prepareResourceSelection } from '../src/mcp-resources.js';
import { hostingSchema, planHostingRecipe, writeHostingRecipe } from '../src/mcp-container-apps.js';
import { readRecipeProject, recipeSourcePlan } from '../src/mcp-recipe-artifacts.js';

const uuid = n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const tenant = uuid(2), subscription = uuid(3);
const group = `/subscriptions/${subscription}/resourceGroups/synthetic-rg`;
const apim = `${group}/providers/Microsoft.ApiManagement/service/synthetic-apim`;
const vault = `${group}/providers/Microsoft.KeyVault/vaults/synthetic-vault`;
const a = value => ['ask', value], c = value => ['choose', value];
function scripted(steps, signal) {
  let output = '';
  const questions = [];
  const next = async (kind, label, choices, options) => {
    questions.push({ kind, label, choices });
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
    questions,
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
  c(apimMode), ...(keyed ? [c(vaultMode)] : []), c(groupMode),
  ...(auth === 'anonymous' ? [c('entra')] : []),
  a(tenant), a(subscription), ...caller(),
  a(groupMode === 'new' ? 'synthetic-rg' : group), a(apimMode === 'new' ? 'synthetic-apim' : apim),
  ...(keyed ? [a(vaultMode === 'new' ? 'synthetic-vault' : vault)] : []),
  ...(apimMode === 'new' || groupMode === 'new' || keyed && vaultMode === 'new' ? [a('eastus')] : []),
  ...(apimMode === 'new' ? [a('Synthetic publisher'), a('publisher@example.com'), c('Developer')] : []),
];
const confirmation = (project, value = 'create') => [a(project), c(async (label, choices, output) => {
  assert.equal(label, 'Save these setup files to the folder shown above?');
  assert.equal(choices[0].value, 'cancel');
  assert.match(output, /"reviewDigest": "sha256:[a-f0-9]{64}"/);
  assert.ok(output.includes(JSON.stringify(project)));
  assert.match(output, /"mcp-definition.json"/);
  assert.equal(choices[1].label, 'Yes, save the files only');
  assert.match(output, /does not sign in, deploy to Azure, call the endpoint or register an FCC/);
  const shown = JSON.parse(output.split('Full configuration and approval reference:\n').at(-1));
  assert.equal(shown.projectDir, project);
  assert.equal(shown.reviewDigest, (await prepareMcpServer(shown.definition)).reviewDigest);
  return value;
})];

test('resource intake collects all modes before IDs and constructs new IDs only from the selected target', async () => {
  const definition = { backend: { auth: 'api-key' }, azure: { subscriptionId: subscription, resourceGroup: 'old-group' } };
  for (const apimMode of ['existing', 'new']) for (const vaultMode of ['existing', 'new']) {
    const p = scripted([c(apimMode), c(vaultMode), c('existing'), a(group),
      a(apimMode === 'new' ? 'synthetic-apim' : apim), a(vaultMode === 'new' ? 'synthetic-vault' : vault)]);
    assert.deepEqual(await promptMcpResourceSelection(definition, p), {
      resourceGroup: { mode: 'existing', resourceId: group },
      apim: { mode: apimMode, resourceId: apim },
      keyVault: { mode: vaultMode, resourceId: vault },
    });
    p.done();
    assert.deepEqual(p.questions.slice(0, 3).map(q => q.label), [
      'Use an existing APIM service or create a new one?',
      'Use an existing Key Vault or create a new one?',
      'Use an existing resource group or create a new one?',
    ]);
    assert.deepEqual(p.questions.map(q => q.kind), ['choose', 'choose', 'choose', 'ask', 'ask', 'ask']);
    assert.equal(definition.azure.resourceGroup, 'old-group');
  }
});

test('resource modes need no Azure IDs and preserve existing-only and no-vault restrictions', async () => {
  for (const [definition, keys] of [
    [{ backend: { auth: 'managed-identity' } }, ['apim', 'resourceGroup']],
    [{ schemaVersion: 3, backend: { auth: 'api-key' } }, ['apim', 'keyVault', 'resourceGroup']],
  ]) {
    const p = scripted(keys.map(() => c((label, choices) => {
      assert.match(label, /^This setup requires an existing .+\. Continue\?$/);
      assert.deepEqual(choices.map(choice => choice.value), ['cancel', 'existing']);
      return 'existing';
    })));
    assert.deepEqual(await promptMcpResourceModes(definition, p), {
      apim: 'existing', keyVault: keys.includes('keyVault') ? 'existing' : 'none', resourceGroup: 'existing',
    });
    p.done();
  }
});

test('resource intake rejects unsupported modes, bad new names and never guesses an existing resource ID', async () => {
  const definition = { backend: { auth: 'anonymous' }, azure: { subscriptionId: subscription } };
  const noPrompts = { output: { write() {} }, ask: () => assert.fail('Invalid modes must not request an ID') };
  for (const modes of [
    { apim: 'unknown', resourceGroup: 'existing', keyVault: 'none' },
    { apim: 'new', resourceGroup: 'existing', keyVault: 'existing' },
    { apim: 'new', resourceGroup: 'existing' },
  ]) await assert.rejects(promptMcpResourceSelection(definition, noPrompts, { modes }), /Unsupported resource choices/);
  await assert.rejects(promptMcpResourceModes({ backend: { auth: 'managed-identity' } },
    { ...noPrompts, choose: async () => 'new' }), /supported resource options/);

  for (const name of ['not a name', apim, 'https://example.com/apim']) {
    const p = scripted([a(group), a(name)]);
    await assert.rejects(promptMcpResourceSelection(definition, p, {
      modes: { resourceGroup: 'existing', apim: 'new', keyVault: 'none' },
    }), /Invalid resource name/);
    p.done();
  }
  const p = scripted([c('existing'), c('existing'), a(group), a('synthetic-apim')]);
  const selection = await promptMcpResourceSelection(definition, p);
  assert.equal(selection.apim.resourceId, 'synthetic-apim');
  assert.equal(p.questions.at(-1).label, 'Resource ID of the existing APIM service');
  await assert.rejects(prepareResourceSelection({ definition, selection }), /Cross-resource-group or cross-subscription/);
  p.done();
  const cancel = scripted([c('cancel')]);
  assert.deepEqual(await promptMcpResourceSelection(definition, cancel), { status: 'cancelled' });
  cancel.done();
});

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
    ...target({ keyed: auth === 'api-key', auth }),
    ...(auth === 'api-key' ? key('headerName') : []),
    ...(auth === 'managed-identity' ? [a(uuid(6)), a(uuid(7)), a(uuid(8)), a(uuid(9)), a('Read.All')] : []),
    ...confirmation(project)]);
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
    c('existing'), c('existing'),
    c('public'), c('declare'), a('60'), a('60'), a(tenant), a(subscription),
    a(group), a(apim), ...confirmation(project)]);
  await guidedArguments(p, { 'workspace-root': root });
  p.done();
  const definition = JSON.parse(await readFile(path.join(project, 'mcp-definition.json')));
  assert.deepEqual(definition.inbound, { type: 'anonymous', publicData: true, readOnly: true,
    rateLimit: { calls: 60, renewalPeriod: 60 } });
  assert.match(p.text, /PUBLIC EXPOSURE/);
  assert.doesNotMatch(p.text, /"allowedClientIds"|"applicationIdUri"/);
  const labels = p.questions.map(q => q.label);
  assert.ok(labels.indexOf('Use an existing APIM service or create a new one?') < labels.indexOf('Azure tenant ID'));
  assert.ok(!labels.some(label => /Key Vault/.test(label)));
  assert.match(p.text, /This setup does not need Key Vault/);
  assert.equal((await withCliWorkspace(root, () => planMcpResume(project))).next.code, 'AZURE_IDENTITY_REQUIRED');
});

test('Declining public-data/read-only declaration writes nothing', async t => {
  const root = await workspace(t);
  const p = scripted([c('new'), c('rest'), c('anonymous'), a('Public rates'), ...get(),
    c('existing'), c('existing'), c('public'), c('cancel')]);
  assert.equal(await guidedArguments(p, { 'workspace-root': root }), undefined);
  p.done();
  assert.deepEqual(await readdir(root), []);
});

for (const source of ['rest', 'mcp']) for (const location of ['headerName', 'queryParameterName']) {
  test(`New ${source} API-key setup preserves a ${location} reference and explicit new-resource choices`, async t => {
    const root = await workspace(t), project = path.join(root, 'keyed');
    const p = scripted([c('new'), c(source), c('api-key'), a('Synthetic keyed setup'),
      ...(source === 'rest' ? get() : [a('https://mcp.example.com/provider/message')]),
      ...target({ keyed: true, apimMode: 'new', groupMode: 'new', vaultMode: 'new' }), ...key(location),
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
    const labels = p.questions.map(q => q.label);
    assert.ok(labels.indexOf('Use an existing APIM service or create a new one?') < labels.indexOf('Azure tenant ID'));
    assert.ok(labels.indexOf('Use an existing Key Vault or create a new one?') < labels.indexOf('Azure tenant ID'));
    assert.ok(labels.indexOf('Name for the new Key Vault') < labels.findIndex(label => label.startsWith('Versionless Key Vault secret URL')));
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
    [c('new'), c('rest'), c('api-key'), a('Cancelled'), ...get(), ...target({ keyed: true }), a('https://synthetic-vault.vault.azure.net/secrets/key'), c('cancel')],
    [c('new'), c('rest'), c('anonymous'), a('Cancelled'), ...get(), c('cancel')],
    [c('new'), c('rest'), c('anonymous'), a('Cancelled'), ...get(), c('existing'), c('cancel')],
    [c('new'), c('rest'), c('anonymous'), a('Cancelled'), ...get(), c('existing'), c('existing'), c('cancel')],
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

test('new setup menu includes every supported hosting recipe and explains file-based input', async () => {
  const expected = hostingSchema.oneOf.map(schema => schema.properties.recipe.const);
  const p = scripted([c('new'), c((label, choices, output) => {
    assert.equal(label, 'What would you like to set up?');
    for (const recipe of expected) {
      assert.match(choices.find(choice => choice.value === recipe)?.label ?? '', /recipe file/);
    }
    assert.match(choices.find(choice => choice.value === 'functions-sdk-v1').label, /preview/);
    assert.match(output, /prepared recipe JSON file/);
    assert.match(output, /REST API security means how this setup accesses YOUR REST API/);
    assert.match(output, /Native APIM \(option 1\): no authentication, API key from Key Vault, or supported Microsoft Entra access/);
    assert.match(output, /same resource\/audience token through.*no OBO/);
    assert.match(output, /existing APIM system-managed identity with the exact backend application role/);
    assert.match(output, /Only direct\/gateway ACA additionally supports explicit OAuth\/OBO pilot recipes/);
    assert.match(output, /parameter-free fixed GETs and separately reviewed manual hosting/);
    assert.match(output, /bounded execution\/host-execution runners reject them/);
    assert.match(output, /App Service and Functions reject OAuth\/OBO backend profiles/);
    assert.match(output, /Username\/password \(Basic\) REST backends remain unimplemented on every host/);
    assert.match(output, /separate from caller sign-in/);
    assert.equal(choices.at(-1).value, 'cancel');
    return 'cancel';
  })]);
  assert.equal(await guidedArguments(p), undefined);
  p.done();
});

const hostingExamples = [
  ['container-apps-direct-v1', 'container-apps-direct.json'],
  ['container-apps-apim-v1', 'container-apps-apim.json'],
  ['app-service-container-v1', 'app-service-container.json'],
  ['functions-sdk-v1', 'functions-sdk.json'],
  ['container-apps-direct-v1', 'container-apps-direct-api-key.json'],
  ['functions-sdk-v1', 'functions-sdk-api-key.json'],
  ['container-apps-direct-v1', 'container-apps-query-dates.json'],
  ['container-apps-direct-v1', 'container-apps-direct-oauth.json'],
];
async function hostingInput(root, example) {
  const input = await readFile(new URL(`../examples/mcp/${example}`, import.meta.url), 'utf8');
  const config = path.join(root, 'recipe.json');
  await writeFile(config, input);
  return config;
}

test('each hosting choice names both exact templates before asking for the workspace', async () => {
  for (const [recipe, example] of hostingExamples.slice(0, 4)) {
    const templates = [example, example.replace('.json', '-api-key.json')];
    const p = scripted([c('new'), c(recipe), a(async (label, choices, output) => {
      assert.equal(label, 'Existing absolute private workspace directory (outside the toolkit checkout)');
      assert.match(output, /Choose ONE for your REST API's security/);
      assert.match(output, /No authentication:/);
      assert.match(output, /API key:/);
      for (const [index, filename] of templates.entries()) {
        const fullPath = path.join(TOOLKIT_ROOT, 'examples', 'mcp', filename);
        assert.ok(output.includes(`Full template path: ${JSON.stringify(fullPath)}`));
        const input = JSON.parse(await readFile(fullPath, 'utf8'));
        assert.equal(input.recipe, recipe);
        assert.equal(input.backend.auth, index === 0 ? 'anonymous' : 'api-key');
      }
      assert.match(output, /WORKSPACE FOLDER only, not the JSON file/);
      assert.match(output, /neither template supports it/);
      throw Object.assign(new Error('Stopped at workspace question'), { code: 'ABORTED' });
    })]);
    await assert.rejects(guidedArguments(p), { code: 'ABORTED' });
    p.done();
  }
});

for (const [recipe, example] of hostingExamples) {
  test(`guided hosting creates and reviews ${example} without live actions`, async t => {
    const root = await workspace(t), project = path.join(root, 'source');
    const config = await hostingInput(root, example);
    const p = scripted([c('new'), c(recipe), a(config), a(project), c(async (label, choices, output) => {
      assert.equal(label, 'Save these hosting source files to the folder shown above?');
      assert.equal(choices[0].value, 'cancel');
      assert.match(output, /does not install packages, build an image, sign in, deploy to Azure or call a tool/);
      assert.match(output, /wizard does NOT copy this file, fill in Azure IDs, or look up resources/);
      const template = hostingExamples.find(([id]) => id === recipe)[1];
      assert.ok(output.includes(JSON.stringify(path.join(TOOLKIT_ROOT, 'examples', 'mcp', template))));
      assert.ok(output.includes(JSON.stringify(path.join(root, template))));
      assert.match(output, /Fixed paths may accept declared query arguments, including validated date ranges/);
      assert.match(output, /Open YOUR COPY in a text editor and replace the example values manually/);
      assert.match(output, /authentication\.audience:.*Application \(client\) ID, not its object ID/);
      assert.match(output, /allowedClientIds:.*not user IDs/);
      assert.match(output, /Save your edited JSON file.*FULL FILE PATH below without quotes/);
      assert.match(output, /No file has been copied or saved by this wizard yet/);
      const shown = JSON.parse(output.split('Full configuration and approval reference:\n').at(-1));
      const plan = await planHostingRecipe({ workspaceRoot: root, config, output: project });
      assert.equal(shown.approvalToken, plan.approvalToken);
      assert.equal(shown.projectDir, project);
      assert.deepEqual(shown.definition, JSON.parse(await readFile(config, 'utf8')));
      assert.ok(shown.files.includes('recipe-manifest.json'));
      return 'create';
    })]);
    assert.deepEqual(await guidedArguments(p, { 'workspace-root': root }),
      ['mcp-recipe-source-plan', '--workspace-root', root, '--project', project, '--json']);
    p.done();
    const generated = await withCliWorkspace(root, () => readRecipeProject(project));
    assert.equal(generated.input.recipe, recipe);
    assert.equal(generated.review.status, 'generated-source-review-only');
    assert.deepEqual(generated.input, JSON.parse(await readFile(config, 'utf8')));
    assert.ok(!Object.hasOwn(generated.files, 'mcp-server.json'));
    const report = await recipeSourcePlan({ workspaceRoot: root, project });
    assert.equal(report.deployed, false);
    assert.equal(report.built, false);
    assert.match(p.text, /Hosting source files saved/);
    assert.match(p.text, /HTML handover export are separate operations/);
  });
}

test('hosting copy instructions quote paths safely and never copy the example themselves', async t => {
  const parent = await workspace(t), root = path.join(parent, "User's private workspace");
  await mkdir(root);
  const p = scripted([c('new'), c('container-apps-direct-v1'), a(() => {
    throw Object.assign(new Error('Stopped before supplying a recipe'), { code: 'ABORTED' });
  })]);
  await assert.rejects(guidedArguments(p, { 'workspace-root': root }), { code: 'ABORTED' });
  p.done();
  const source = path.join(TOOLKIT_ROOT, 'examples', 'mcp', 'container-apps-direct.json');
  const destination = path.join(root, 'container-apps-direct.json');
  assert.ok(p.text.includes(`[System.IO.File]::Copy('${source.replaceAll("'", "''")}', '${destination.replaceAll("'", "''")}')`));
  assert.match(p.text, /copy command refuses to overwrite an existing file/);
  assert.deepEqual(await readdir(root), []);
});

test('hosting input requires a full edited file path, not a folder or relative filename', async t => {
  const root = await workspace(t);
  await hostingInput(root, 'container-apps-direct.json');
  for (const value of ['recipe.json', root, `"${path.join(root, 'recipe.json')}"`]) {
    const p = scripted([c('new'), c('container-apps-direct-v1'), a(value)]);
    await assert.rejects(guidedArguments(p, { 'workspace-root': root }));
    p.done();
  }
  assert.deepEqual(await readdir(root), ['recipe.json']);
});

test('hosting guidance distinguishes explicit ACA pilots from unsupported generic auth values', async t => {
  const root = await workspace(t);
  for (const [recipe, example] of hostingExamples.slice(0, 4)) {
    const config = await hostingInput(root, example);
    const input = JSON.parse(await readFile(config, 'utf8'));
    for (const auth of ['entra', 'oauth']) {
      input.backend.auth = auth;
      await writeFile(config, JSON.stringify(input));
      const p = scripted([c('new'), c(recipe), a(config)]);
      await assert.rejects(guidedArguments(p, { 'workspace-root': root }), { code: 'MCP_CONTAINER_APPS_INPUT' });
      p.done();
      assert.match(p.text, /REST API access \(backend.auth\): anonymous.*api-key/);
      assert.match(p.text, /ACA OAuth\/OBO needs an explicit versioned pilot profile, not a generic entra or oauth value/);
      assert.match(p.text, /OAuth\/OBO pilots remain parameter-free/);
      assert.match(p.text, /App Service and Functions reject those profiles/);
      assert.doesNotMatch(p.text, /hosting recipes do NOT support Entra-protected|Entra and other OAuth REST backends are NOT supported here/);
      assert.match(p.text, /MCP caller access \(authentication\): Microsoft Entra sign-in is required/);
      assert.doesNotMatch(p.text, /Hosting source files saved/);
    }
  }
  assert.deepEqual(await readdir(root), ['recipe.json']);
});

test('native APIM OAuth rejection points to ACA pilots without changing route or writing', async t => {
  const root = await workspace(t);
  const p = scripted([c('new'), c('rest'), c((label, choices) => {
    assert.match(choices.find(choice => choice.value === 'oauth').label, /not supported by native APIM REST/);
    return 'oauth';
  })]);
  assert.equal(await guidedArguments(p, { 'workspace-root': root }), undefined);
  p.done();
  assert.match(p.text, /Third-party OAuth REST backends are not supported by native APIM/);
  assert.match(p.text, /see docs\/backend-oauth.md for parameter-free GETs and manual-hosting limits/);
  assert.match(p.text, /Your host and authentication choices were not changed/);
  assert.deepEqual(await readdir(root), []);
});

test('hosting cancellation, abort and changed review never publish a project', async t => {
  const root = await workspace(t), project = path.join(root, 'source');
  const config = await hostingInput(root, 'container-apps-direct.json');
  const cancelled = scripted([c('new'), c('container-apps-direct-v1'), a(config), a(project), c('cancel')]);
  assert.equal(await guidedArguments(cancelled, { 'workspace-root': root }), undefined);
  cancelled.done();
  const controller = new AbortController();
  const aborted = scripted([c('new'), c('container-apps-direct-v1'), a(config), a(project),
    c(() => { controller.abort(); return 'create'; })], controller.signal);
  await assert.rejects(guidedArguments(aborted, { 'workspace-root': root }), { code: 'ABORTED' });
  aborted.done();
  const changed = scripted([c('new'), c('container-apps-direct-v1'), a(config), a(project), c(async () => {
    const input = JSON.parse(await readFile(config, 'utf8'));
    input.requestsPerMinute += 1;
    await writeFile(config, JSON.stringify(input));
    return 'create';
  })]);
  await assert.rejects(guidedArguments(changed, { 'workspace-root': root }), { code: 'MCP_CONTAINER_APPS_APPROVAL_REQUIRED' });
  changed.done();
  assert.deepEqual(await readdir(root), ['recipe.json']);
});

test('hosting cancellation during approval revalidation stops before the first write', async t => {
  const root = await workspace(t), output = path.join(root, 'source');
  const config = await hostingInput(root, 'container-apps-direct.json');
  const selected = { workspaceRoot: root, config, output };
  const plan = await planHostingRecipe(selected);
  const controller = new AbortController();
  const pending = writeHostingRecipe({ ...selected, approval: plan.approvalToken, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'MCP_CONTAINER_APPS_ABORTED' });
  assert.deepEqual(await readdir(root), ['recipe.json']);
});

test('hosting rejects mismatched recipes, credentials and unsafe output paths', async t => {
  const root = await workspace(t), config = await hostingInput(root, 'container-apps-direct.json');
  const mismatch = scripted([c('new'), c('functions-sdk-v1'), a(config)]);
  await assert.rejects(guidedArguments(mismatch, { 'workspace-root': root }), /does not match/);
  mismatch.done();
  const existing = path.join(root, 'existing');
  await mkdir(existing);
  await writeFile(path.join(existing, 'keep.txt'), 'keep');
  const linked = path.join(root, 'linked');
  await symlink(existing, linked, process.platform === 'win32' ? 'junction' : 'dir');
  for (const output of [existing, linked, path.dirname(root), 'relative-output']) {
    const p = scripted([c('new'), c('container-apps-direct-v1'), a(config), a(output)]);
    await assert.rejects(guidedArguments(p, { 'workspace-root': root }));
    p.done();
    assert.equal(await readFile(path.join(existing, 'keep.txt'), 'utf8'), 'keep');
  }
  const race = scripted([c('new'), c('container-apps-direct-v1'), a(config), a(path.join(root, 'raced')),
    c(async () => { await mkdir(path.join(root, 'raced')); return 'create'; })]);
  await assert.rejects(guidedArguments(race, { 'workspace-root': root }), { code: 'MCP_CONTAINER_APPS_OUTPUT_EXISTS' });
  race.done();
  const unsafe = JSON.parse(await readFile(config, 'utf8'));
  unsafe.name = 'api_key=PRIVATE_VALUE';
  await writeFile(config, JSON.stringify(unsafe));
  const secrets = scripted([c('new'), c('container-apps-direct-v1'), a(config)]);
  await assert.rejects(guidedArguments(secrets, { 'workspace-root': root }), { code: 'MCP_CONTAINER_APPS_INPUT' });
  assert.doesNotMatch(secrets.text, /PRIVATE_VALUE/);
  secrets.done();
  const toolkit = scripted([c('new'), c('container-apps-direct-v1')]);
  await assert.rejects(guidedArguments(toolkit, { 'workspace-root': TOOLKIT_ROOT }), /outside the toolkit/);
  toolkit.done();
});
