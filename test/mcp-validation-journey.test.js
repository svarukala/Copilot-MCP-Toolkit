import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { TOOLKIT_ROOT, withCliWorkspace } from '../src/config.js';
import { savedJson } from '../src/anonymous-metadata.js';
import { digest } from '../src/mcp-validation.js';
import { planValidation, startValidation, nextValidation, runValidation, validationStatus } from '../src/mcp-validation-journey.js';
import { readMcpServerProject } from '../src/mcp-lifecycle.js';
import { prepareMcpServer } from '../src/mcp-server.js';
import { executeMcpProjectForTest } from '../src/mcp-discovery-project.js';
import { discoverMcpToolsForTest, runMcpReadOnlyProofForTest } from '../src/mcp-discovery.js';
import { observationTransport } from './support/mcp-observation.js';
import { selectMockAzureIdentity } from './support/azure-identity.js';

const evidenceDigest = `sha256:${'a'.repeat(64)}`;
const uid = '77777777-7777-4777-8777-777777777777';
const assertion = { kind: 'json-array-string-field-v1', field: 'name', maxItems: 5, maxStringLength: 40 };
async function setup(t, example = 'existing-anonymous', scenario = 'existing-mcp-create-v2', change = () => {}) {
  t.mock.method(globalThis, 'fetch', () => { throw Error('Unexpected external request'); });
  await mkdir(path.join(TOOLKIT_ROOT, '.test-output'), { recursive: true });
  const root = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'creation-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const json = async (name, value) => { const file = path.join(root, name); await writeFile(file, savedJson(value)); return file; };
  const definition = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples', 'mcp', `${example}.json`)));
  change(definition);
  const hosting = scenario.startsWith('container-apps-'), existing = scenario === 'existing-mcp-create-v2';
  const auth = definition.authentication ?? definition.inbound;
  const input = { schemaVersion: 2, scenario, definitionFile: await json('definition.json', definition),
    discovery: hosting || auth.type === 'entra' ? { discoveryClientId: auth.allowedClientIds[0], expectedUserId: uid } : {},
    proof: { toolName: definition.operationIds?.[0] ?? 'read_record', arguments: {},
      safetyReview: { readOnly: true, reason: 'Owner reviewed the fixed synthetic GET.' } },
    probeMode: 'separate', consumer: 'none', relatedProjects: [], historyReviewed: true, privateExportReviewed: true,
    ...(!hosting && !existing ? { azureAccount: { tenantId: definition.azure.tenantId,
      subscriptionId: definition.azure.subscriptionId, accountName: 'operator@example.com' } } : {}) };
  const config = await json('validation.json', input), run = path.join(root, 'run');
  const options = { workspaceRoot: root, config, output: run }, active = { workspaceRoot: root, project: run };
  const rewrite = () => json('validation.json', input);
  const start = async () => { await rewrite(); return startValidation({ ...options, approval: (await planValidation(options)).approvalToken }); };
  const step = async (extra = {}, deps = {}) => {
    const selected = { ...active, ...extra }, plan = await nextValidation(selected);
    assert.ok(plan.approvalToken, JSON.stringify(plan));
    const flags = Object.fromEntries(plan.requiredFlags.map(f => [({ '--allow-network': 'allowNetwork',
      '--interactive': 'interactive', '--allow-cloud': 'allowCloud' })[f], true]));
    const report = await runValidation({ ...selected, ...flags, approval: plan.approvalToken,
      onDeviceCode() {}, approveProof: proof => proof.approvalDigest }, deps);
    return { plan, report };
  };
  const checkpoint = async (names, outcome = 'passed') => step({ config: await json('checkpoint.json', {
    schemaVersion: 2, kind: 'checkpoint', milestones: names.map(name => ({ name, outcome, evidenceDigest, note: 'Owner reviewed synthetic evidence.' })),
  }) });
  const artifact = async (kind, value) => step({ config: await json('request.json', {
    schemaVersion: 2, kind, file: await json(`${kind}.json`, value),
  }) });
  const transport = async (state = {}) => {
    const project = path.join(run, hosting ? 'reference' : 'source');
    const server = await withCliWorkspace(root, () => readMcpServerProject(project));
    const tools = { tools: [{ name: input.proof.toolName, description: 'Read a synthetic record',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false } }] };
    const fixture = observationTransport(server.review.descriptor, input.discovery, tools), base = fixture.mcpTransport;
    fixture.mcpTransport = async (url, request) => {
      const rpc = JSON.parse(request.body);
      if (state.beforeRequest) await state.beforeRequest(rpc);
      if (rpc.method !== 'tools/call') return base(url, request);
      fixture.calls.push(rpc.method);
      if (state.unknown) throw Error('PRIVATE_PROVIDER_ERROR');
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {
        ...(state.toolError ? { isError: true } : {}),
        content: [{ type: 'text', text: JSON.stringify(state.invalid ? [{ wrong: true }] : [{ name: 'Synthetic' }]) }],
      } }));
    };
    return { fixture, deps: { sessionDependencies: fixture,
      mcpProjectOperation: (dir, opts, proof, guard) => executeMcpProjectForTest(dir, opts, proof,
        (source, execution, internalGuard, hooks) => (proof ? runMcpReadOnlyProofForTest : discoverMcpToolsForTest)(
          source, execution, { ...fixture, beforeRequest: internalGuard, ...hooks }), undefined, guard) } };
  };
  return { root, run, input, definition, options, active, json, start, rewrite, step, checkpoint, artifact, transport };
}

for (const gateway of [false, true]) for (const key of ['header', 'query']) {
  test(`creation runner generates ${gateway ? 'gateway' : 'direct'} ACA ${key}-key release and reference without hidden deployment`, async t => {
    const f = await setup(t, `container-apps-${gateway ? 'apim' : 'direct'}-api-key`,
      gateway ? 'container-apps-apim-create-v2' : 'container-apps-create-v2', d => {
        delete d.backend.apiKey.headerName; delete d.backend.apiKey.queryParameterName;
        delete d.backend.apiKey.queryExposureReviewed;
        d.backend.apiKey[key === 'query' ? 'queryParameterName' : 'headerName'] = key === 'query' ? 'access_key' : 'X-Api-Key';
        if (key === 'query') d.backend.apiKey.queryExposureReviewed = true;
        for (const scheme of Object.values(d.document.components.securitySchemes)) {
          scheme.in = key; scheme.name = key === 'query' ? 'access_key' : 'X-Api-Key';
        }
      });
    const initial = await f.start();
    assert.equal(initial.coverage.backend, `api-key-${key}`);
    assert.equal(initial.coverage.caller, 'entra');
    await f.step();
    assert.equal((await nextValidation(f.active)).gate, 'prerequisites');
    await f.checkpoint(['prerequisites', 'image-build', ...(gateway ? ['host-deployment'] : [])]);
    const release = { schemaVersion: 1, accountName: 'operator@example.com',
      containerImage: `${f.definition.azure.registry.server}/mcp@sha256:${'a'.repeat(64)}`,
      ...(gateway ? { backendOrigin: `https://${f.definition.azure.appName}.synthetic.eastus.azurecontainerapps.io` } : {}) };
    assert.equal((await f.artifact('release', release)).plan.phase, 'release');
    assert.equal((await nextValidation(f.active)).gate, 'runtime-deployment');
    await f.checkpoint(['runtime-deployment', 'secret-resolution']);
    const endpoint = gateway ? (await import('../src/mcp-container-apps.js')).compileHostingRecipe(f.definition).runtime.gateway.publicUrl
      : 'https://synthetic.example.com/mcp';
    await f.artifact('reference', { schemaVersion: 1, serverId: uid, endpoint });
    const pending = await nextValidation(f.active);
    assert.equal(pending.phase, 'discovery'); assert.deepEqual(pending.requiredFlags, ['--allow-network', '--interactive']);
    const { fixture, deps } = await f.transport();
    await f.step({}, deps);
    assert.equal((await nextValidation(f.active)).phase, 'proof');
    const proved = await f.step({}, deps);
    assert.equal(proved.report.protocol, 'passed-historical');
    assert.equal(proved.report.outcome, 'incomplete');
    assert.equal(fixture.calls.filter(c => c === 'tools/call').length, 1);
    assert.equal((await nextValidation(f.active)).status, 'checks-recorded');
    const handover = await f.step({ phase: 'handover' });
    assert.equal(handover.plan.phase, 'handover');
    assert.equal(handover.report.executionReadiness, false);
    const stored = JSON.parse(await readFile(path.join(f.run, 'events', '0004.json')));
    assert.equal(stored.data.phase, 'release');
  });
}

test('native header/query keys and Entra backend profiles generate then require explicit private identity', async t => {
  for (const mode of ['header', 'query', 'delegated', 'managed-identity']) await t.test(mode, async t => {
    const example = mode === 'managed-identity' ? 'graph-organization' : 'catalog';
    const f = await setup(t, example, 'native-apim-create-v2', d => {
      if (mode === 'header' || mode === 'query') {
        d.azure.keyVaultName = 'catalog-vault';
        d.backend = { endpoint: 'https://catalog.example.com', auth: 'api-key',
          apiKey: { secretIdentifier: 'https://catalog-vault.vault.azure.net/secrets/upstream',
            [mode === 'header' ? 'headerName' : 'queryParameterName']: mode === 'header' ? 'X-Api-Key' : 'access_key' } };
      } else if (mode === 'delegated') d.backend.auth = 'entra';
    });
    await f.start(); await f.step(); await f.checkpoint(['prerequisites']);
    const login = await nextValidation(f.active);
    assert.equal(login.phase, 'account');
    assert.deepEqual(login.requiredFlags, ['--allow-network', '--interactive']);
    assert.equal(login.childPlan.target.accountName, f.input.azureAccount.accountName);
    assert.equal(login.childPlan.loginMode, 'device-code');
  });
});

for (const mode of ['header', 'query']) test(`proxy v2 ${mode}-key creation keeps lifecycle separate`, async t => {
  const f = await setup(t, 'upstream-key', 'mcp-proxy-create-v2', d => {
    if (mode === 'query') { delete d.backend.apiKey.headerName; d.backend.apiKey.queryParameterName = 'access_key'; }
  });
  await f.start(); await f.step(); await f.checkpoint(['prerequisites']);
  assert.equal((await nextValidation(f.active)).phase, 'account');
});

test('unsupported SDK Entra backends, OAuth references, legacy proxies and password profiles fail before generation', async t => {
  const f = await setup(t, 'container-apps-direct-api-key', 'container-apps-create-v2');
  for (const auth of ['entra', 'oauth', 'basic', 'password']) {
    await f.json('definition.json', { ...f.definition, backend: { origin: 'https://fixture.example.com', auth } });
    await assert.rejects(planValidation(f.options), { code: 'MCP_VALIDATION_UNSUPPORTED' });
  }
  const x = await setup(t);
  await x.json('definition.json', { ...x.definition, inbound: { type: 'oauth' } });
  await assert.rejects(planValidation(x.options), { code: 'MCP_VALIDATION_UNSUPPORTED' });
  const p = await setup(t, 'upstream-key', 'mcp-proxy-create-v2', d => { d.schemaVersion = 1; });
  await assert.rejects(planValidation(p.options), { code: 'MCP_VALIDATION_INPUT' });
  assert.deepEqual(await readdir(f.root), ['definition.json', 'validation.json']);
});

test('experimental proxy v3 is explicit and rejects query-key routing before creating a run', async t => {
  const f = await setup(t, 'upstream-key', 'mcp-proxy-create-v2', d => {
    d.schemaVersion = 3; d.experimentalProfile = 'owned-backend-routing-v1';
    d.backend.endpoint = 'https://upstream.example.com/mcp/';
    Object.assign(d.azure, { resourceGroupMode: 'existing', keyVaultMode: 'existing' });
  });
  await f.start(); await f.step(); await f.checkpoint(['prerequisites']);
  assert.equal((await nextValidation(f.active)).phase, 'account');
  delete f.definition.backend.apiKey.headerName;
  f.definition.backend.apiKey.queryParameterName = 'access_key';
  await f.json('definition.json', f.definition);
  await assert.rejects(planValidation({ ...f.options, output: path.join(f.root, 'invalid-query') }));
});

test('native unannotated header-key proof surfaces its unsupported boundary without dispatch', async t => {
  const f = await setup(t, 'catalog', 'native-apim-create-v2', d => {
    d.azure.keyVaultName = 'catalog-vault';
    d.backend = { endpoint: 'https://catalog.example.com', auth: 'api-key', apiKey: {
      secretIdentifier: 'https://catalog-vault.vault.azure.net/secrets/upstream', headerName: 'X-Api-Key' } };
  });
  const review = await prepareMcpServer(f.definition);
  const map = JSON.parse(review.files['infra/operation-map.json']).server[0];
  f.input.proof.toolName = map.displayName;
  f.input.azureAccount.accountName = 'fixture-user@example.com';
  await f.start(); await f.step(); await f.checkpoint(['prerequisites', 'secret-resolution']);
  const source = path.join(f.run, 'source');
  await withCliWorkspace(f.root, () => selectMockAzureIdentity(source, f.definition.azure));
  // Synthetic retained deployment only; the runner must still use the real guarded proof planner.
  await mkdir(path.join(source, '.mcp-lifecycle'));
  await writeFile(path.join(source, '.mcp-lifecycle', 'aaaaaaaa.json'), savedJson({
    schemaVersion: 1, phase: 'gateway', status: 'completed', reviewDigest: review.reviewDigest,
  }));
  const fixture = observationTransport(review.descriptor, f.input.discovery, { tools: [{
    name: map.displayName, description: map.description,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  }] });
  await f.step({}, { mcpProjectOperation: (project, options, proof, guard) =>
    executeMcpProjectForTest(project, options, proof, (descriptor, selection, beforeRequest) =>
      discoverMcpToolsForTest(descriptor, selection, { ...fixture, beforeRequest }), undefined, guard) });
  const blocked = await nextValidation(f.active);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.code, 'READ_ONLY_REVIEW_REQUIRED');
  assert.equal(fixture.calls.filter(c => c === 'tools/call').length, 0);
});

for (const state of [{}, { invalid: true }, { toolError: true }, { unknown: true }]) {
  test(`existing MCP runner executes injected proof and retains ${JSON.stringify(state)} outcome`, async t => {
    const f = await setup(t); f.input.proof.resultAssertion = assertion;
    await f.start(); await f.step();
    const { fixture, deps } = await f.transport(state);
    await f.step({}, deps);
    const proof = await nextValidation(f.active);
    assert.equal(proof.phase, 'proof');
    assert.equal(proof.approvalToken, (await nextValidation(f.active)).approvalToken);
    await assert.rejects(runValidation({ ...f.active, approval: proof.approvalToken }), { code: 'MCP_VALIDATION_FLAGS' });
    const result = await f.step({}, deps);
    assert.equal(result.report.protocol, state.unknown ? 'unknown' : state.invalid || state.toolError ? 'failed-historical' : 'passed-historical');
    assert.equal(fixture.calls.filter(m => m === 'tools/call').length, 1);
    const after = await nextValidation(f.active);
    assert.equal(after.approvalToken, null);
    assert.equal(after.status, Object.keys(state).length ? 'blocked' : 'checks-recorded');
    const report = await validationStatus(f.active);
    assert.equal(report.outcome, state.unknown ? 'blocked' : state.invalid || state.toolError ? 'failed' : 'passed-with-owner-and-historical-evidence');
    assert.equal(report.proofReplayAuthorized, false);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE_PROVIDER_ERROR|private fixture response/);
    await f.step({ phase: 'archive' });
    assert.equal((await nextValidation(f.active)).approvalToken, null);
    assert.equal(fixture.calls.filter(m => m === 'tools/call').length, 1);
  });
}

test('related retained history blocks fresh references and rechecks at dispatch after sign-in', async t => {
  const old = await setup(t);
  await old.start(); await old.step();
  const older = await old.transport();
  await old.step({}, older.deps);
  const f = await setup(t);
  // A private workspace can intentionally contain multiple old/new project roots.
  const workspaceRoot = path.dirname(f.root);
  f.options.workspaceRoot = workspaceRoot; f.active.workspaceRoot = workspaceRoot;
  f.input.relatedProjects = [path.join(old.run, 'source')];
  await f.start(); await f.step();
  const current = await f.transport({ beforeRequest: async rpc => {
    if (rpc.method === 'tools/list') await old.step({}, older.deps);
  } });
  await assert.rejects(f.step({}, current.deps), { code: 'MCP_VALIDATION_STEP_UNKNOWN' });
  assert.equal(current.fixture.calls.filter(c => c === 'tools/call').length, 0);
  assert.equal((await validationStatus(f.active)).relatedHistory[0].consumed, true);
  assert.equal((await nextValidation(f.active)).status, 'blocked');
  const another = await setup(t);
  another.options.workspaceRoot = workspaceRoot; another.active.workspaceRoot = workspaceRoot;
  another.input.relatedProjects = [path.join(old.run, 'source')];
  await another.start();
  assert.equal((await nextValidation(another.active)).status, 'blocked');
});

test('creation journal preserves interrupted steps and rejects changed build, source, selection and owner protocol assertions', async t => {
  const f = await setup(t); await f.start();
  const rootFile = path.join(f.run, 'validation-run.json'), original = await readFile(rootFile);
  const { contentDigest, ...body } = JSON.parse(original);
  assert.ok(contentDigest);
  body.buildId = evidenceDigest;
  await writeFile(rootFile, savedJson({ ...body, contentDigest: digest(body) }));
  await assert.rejects(validationStatus(f.active), { code: 'MCP_VALIDATION_BUILD' });
  await writeFile(rootFile, original);
  await f.step();
  const selectionFile = path.join(f.run, 'discovery.json');
  await writeFile(selectionFile, '{"extra":true}');
  await assert.rejects(nextValidation(f.active), { code: 'MCP_VALIDATION_CHANGED' });
  await writeFile(selectionFile, '{}');
  await assert.rejects(f.checkpoint(['protocol']), { code: 'MCP_VALIDATION_INPUT' });
  const entries = (await readdir(path.join(f.run, 'events'))).sort();
  const previous = JSON.parse(await readFile(path.join(f.run, 'events', entries.at(-1)))).contentDigest;
  const event = { schemaVersion: 2, previous, recordedAt: new Date().toISOString(), kind: 'intent',
    data: { phase: 'proof', approvalDigest: evidenceDigest } };
  await writeFile(path.join(f.run, 'events', '0003.json'), savedJson({ ...event, contentDigest: digest(event) }));
  assert.equal((await nextValidation(f.active)).status, 'blocked');
  assert.equal((await nextValidation({ ...f.active, phase: 'archive' })).approvalToken, null);
});

test('managed runner enforces explicit private device login, exact identity and cloud opt-in', async t => {
  const f = await setup(t, 'catalog', 'native-apim-create-v2');
  await f.start(); await f.step(); await f.checkpoint(['prerequisites']);
  const calls = [];
  const runAzure = async (_, args, options) => {
    calls.push(args);
    assert.ok(options.azureConfigDir.startsWith(path.join(f.run, 'source', '.azure-auth')));
    if (args[0] === 'login') options.onAzureDeviceCode({ verificationUri: 'https://microsoft.com/devicelogin', userCode: 'ABCD12345' });
    return { tenantId: f.definition.azure.tenantId, id: f.definition.azure.subscriptionId,
      user: { name: f.input.azureAccount.accountName, type: 'user' } };
  };
  await f.step({}, { runAzure });
  assert.equal(calls.length, 3);
  assert.ok(calls[0].includes('--use-device-code'));
  const provision = await nextValidation(f.active);
  assert.equal(provision.phase, 'provision'); assert.deepEqual(provision.requiredFlags, ['--allow-cloud']);
  await assert.rejects(runValidation({ ...f.active, approval: provision.approvalToken }, { runAzure }), { code: 'MCP_VALIDATION_FLAGS' });
  await withCliWorkspace(f.root, () => selectMockAzureIdentity(path.join(f.run, 'source'), f.definition.azure));
  await assert.rejects(nextValidation(f.active), { code: 'MCP_VALIDATION_IDENTITY' });
});

test('managed phase delegates real finalize executor and an uncertain gateway stays blocked', async t => {
  const f = await setup(t, 'catalog', 'native-apim-create-v2');
  f.input.azureAccount.accountName = 'fixture-user@example.com';
  await f.start(); await f.step(); await f.checkpoint(['prerequisites']);
  const source = path.join(f.run, 'source'), review = await prepareMcpServer(f.definition);
  await withCliWorkspace(f.root, () => selectMockAzureIdentity(source, f.definition.azure));
  // Synthetic completed prerequisite; finalize and failed gateway use the actual executors.
  await mkdir(path.join(source, '.mcp-lifecycle'));
  await writeFile(path.join(source, '.mcp-lifecycle', 'aaaaaaaa.json'), savedJson({
    schemaVersion: 1, phase: 'foundation', status: 'completed', reviewDigest: review.reviewDigest,
  }));
  const calls = [], controller = new AbortController();
  const runAzure = async (_, args, options) => {
    calls.push(args);
    assert.equal(options.signal, controller.signal);
    assert.ok(options.azureConfigDir.startsWith(path.join(source, '.azure-auth')));
    if (args[0] === 'account') return { tenantId: f.definition.azure.tenantId,
      id: f.definition.azure.subscriptionId, user: { name: f.input.azureAccount.accountName, type: 'user' } };
    assert.equal(args[0], 'rest'); assert.ok(args.includes('GET'));
    return { appId: f.definition.inbound.clientId, identifierUris: [f.definition.inbound.applicationIdUri],
      api: { oauth2PermissionScopes: [{ id: uid, value: f.definition.inbound.scope, isEnabled: true }],
        preAuthorizedApplications: f.definition.inbound.allowedClientIds.map(appId => ({ appId, delegatedPermissionIds: [uid] })) } };
  };
  const done = await f.step({ signal: controller.signal }, { runAzure });
  assert.equal(done.plan.selected.phase, 'finalize');
  assert.equal(done.report.steps.at(-1).status, 'passed');
  assert.deepEqual(calls.map(args => args[0]), ['account', 'account', 'account', 'rest']);
  assert.equal((await nextValidation(f.active)).selected.phase, 'gateway');
  const failed = await f.step({}, { runAzure() { throw Error('PRIVATE_UNCERTAIN_COMMAND'); } });
  assert.equal(failed.report.status, 'blocked');
  assert.equal(failed.report.steps.at(-1).status, 'unknown');
  assert.equal((await nextValidation(f.active)).approvalToken, null);
  assert.doesNotMatch(JSON.stringify(failed.report), /PRIVATE_UNCERTAIN_COMMAND/);
});

test('Entra existing MCP single sign-in declines proof without rediscovery and binds later proof', async t => {
  const f = await setup(t, 'catalog', 'existing-mcp-create-v2', d => {
    const inbound = d.inbound;
    for (const key of Object.keys(d)) delete d[key];
    Object.assign(d, { schemaVersion: 1, kind: 'existing-mcp', server: { id: uid, name: 'Synthetic Entra MCP' },
      endpoint: 'https://synthetic.example.com/mcp', inbound });
  });
  f.input.probeMode = 'session'; f.input.proof.resultAssertion = assertion;
  await f.start(); await f.step();
  const { fixture, deps } = await f.transport();
  const session = await nextValidation(f.active);
  const declined = await runValidation({ ...f.active, approval: session.approvalToken,
    allowNetwork: true, interactive: true, onDeviceCode() {}, approveProof: () => '' }, deps);
  assert.equal(declined.protocol, 'pending');
  assert.equal((await nextValidation(f.active)).phase, 'proof');
  assert.equal(fixture.calls.filter(c => c === 'tools/list').length, 1);
  await f.step({}, deps);
  assert.equal((await validationStatus(f.active)).protocol, 'passed-historical');
  assert.equal(fixture.calls.filter(c => c === 'tools/call').length, 1);
});

test('new CLI schema, fresh-process creation and fail-closed effect flags remain JSON-only', async t => {
  const f = await setup(t);
  const invoke = (args, code = 0) => {
    const child = spawnSync(process.execPath, [path.join(TOOLKIT_ROOT, 'bin', 'copilot-mcp.js'),
      ...args, '--json'], { cwd: f.root, encoding: 'utf8', timeout: 60000 });
    assert.equal(child.status, code, child.stdout + child.stderr);
    return JSON.parse(child.stdout);
  };
  assert.equal(invoke(['mcp-validation-schema']).creationScenario.properties.schemaVersion.const, 2);
  const args = ['--workspace-root', f.root, '--config', f.options.config, '--output', f.run];
  const plan = invoke(['mcp-validation-plan', ...args, '--summary']);
  invoke(['mcp-validation-start', ...args, '--approve', plan.approvalToken]);
  const active = ['--workspace-root', f.root, '--project', f.run];
  const generation = invoke(['mcp-validation-next', ...active]);
  invoke(['mcp-validation-run', ...active, '--approve', generation.approvalToken, '--allow-cloud'], 1);
  invoke(['mcp-validation-run', ...active, '--approve', generation.approvalToken]);
  assert.equal(invoke(['mcp-validation-next', ...active]).phase, 'discovery');
  assert.equal(invoke(['mcp-validation-status', ...active]).schemaVersion, 2);
});
