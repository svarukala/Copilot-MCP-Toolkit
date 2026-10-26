import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { TOOLKIT_ROOT, withCliWorkspace } from '../src/config.js';
import { savedJson } from '../src/anonymous-metadata.js';
import { digest } from '../src/mcp-validation.js';
import { planExecution, startExecution, runExecution, executionStatus, recordExecutionEvidence } from '../src/mcp-execution.js';
import { readMcpServerProject } from '../src/mcp-lifecycle.js';
import { prepareMcpServer } from '../src/mcp-server.js';
import { compileHostingRecipe } from '../src/mcp-container-apps.js';
import { executeMcpProjectForTest } from '../src/mcp-discovery-project.js';
import { discoverMcpToolsForTest, runMcpReadOnlyProofForTest } from '../src/mcp-discovery.js';
import { observationTransport } from './support/mcp-observation.js';
import { createSyntheticExecutionHost, syntheticHostScannerImage } from './support/execution-host.js';
import { main } from '../bin/copilot-mcp.js';
import { nextValidation, runValidation } from '../src/mcp-validation-journey.js';

const user = '77777777-7777-4777-8777-777777777777';
const evidence = `sha256:${'a'.repeat(64)}`;
async function setup(t, example = 'existing-anonymous', scenario = 'existing-mcp-create-v2') {
  t.mock.method(globalThis, 'fetch', () => { throw Error('Unexpected external request'); });
  await mkdir(path.join(TOOLKIT_ROOT, '.test-output'), { recursive: true });
  const root = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'execution-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const json = async (name, value) => {
    const target = path.join(root, name); await writeFile(target, savedJson(value)); return target;
  };
  const definition = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples', 'mcp', `${example}.json`)));
  const managed = scenario !== 'existing-mcp-create-v2';
  const hosting = scenario.startsWith('container-apps-'), inbound = definition.inbound ?? definition.authentication;
  if (hosting) definition.imageBuild = {
    builderImage: `node:22-bookworm-slim@sha256:${'a'.repeat(64)}`,
    runtimeImage: `gcr.io/distroless/nodejs22-debian13:nonroot@sha256:${'b'.repeat(64)}`, platform: 'linux/amd64',
  };
  const creation = { schemaVersion: 2, scenario, definitionFile: await json('definition.json', definition),
    discovery: inbound.type === 'anonymous' ? {} : {
      discoveryClientId: inbound.allowedClientIds[0], expectedUserId: user },
    proof: { toolName: definition.operationIds?.[0] ?? 'read_record', arguments: {},
      safetyReview: { readOnly: true, reason: 'Reviewed synthetic fixed GET.' } },
    probeMode: 'separate', consumer: 'none', relatedProjects: [], historyReviewed: true, privateExportReviewed: true,
    ...(managed && !hosting ? { azureAccount: { tenantId: definition.azure.tenantId, subscriptionId: definition.azure.subscriptionId,
      accountName: 'operator@example.com' } } : {}) };
  const input = { schemaVersion: 1, scenarioFile: await json('scenario.json', creation),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    limits: { maximumSteps: 30, maximumAzureCommands: managed ? 80 : 0, maximumProviderCalls: 1, maximumRunMs: 600000 },
    ...(managed ? { cloud: { resourcePolicy: 'pinned-scenario-only', spendingPolicy: 'resource-limits-not-an-invoice-cap',
      ongoingChargesReviewed: true, allowSecretAccessGrants: !hosting && definition.backend?.auth === 'api-key' } } : {}),
    minimumProofDelayMs: hosting ? 65000 : 0, ownerEvidence: [] };
  if (hosting) Object.assign(input, { referenceServerId: user,
    host: { ...JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples', 'mcp', 'execution-container-apps.json'))).host,
      expiresAt: input.expiresAt },
    ownerEvidence: [{ name: 'prerequisites', outcome: 'passed', evidenceDigest: evidence,
      note: 'Owner reviewed the synthetic pre-existing directory and resource prerequisites.' }] });
  const output = path.join(root, 'execution');
  const options = { workspaceRoot: root, config: path.join(root, 'execution-input.json'), output };
  const active = { workspaceRoot: root, project: output };
  const rewrite = async () => {
    await json('definition.json', definition); await json('scenario.json', creation);
    await json('execution-input.json', input);
  };
  const start = async () => {
    await rewrite(); const plan = await planExecution(options);
    await startExecution({ ...options, approval: plan.approvalToken }); return plan;
  };
  let fixture;
  const state = { calls: [], tools: [], auth: 0 };
  const deps = {
    mcpProjectOperation: async (project, opts, proof, guard) => {
      if (!fixture) {
        const server = await withCliWorkspace(root, () => readMcpServerProject(project));
        fixture = observationTransport(server.review.descriptor, creation.discovery, { tools: [{
          name: creation.proof.toolName, description: 'Read synthetic data',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true, destructiveHint: false },
        }] });
        const base = fixture.mcpTransport;
        fixture.mcpTransport = async (url, request) => {
          const rpc = JSON.parse(request.body); state.calls.push(rpc.method);
          if (rpc.method !== 'tools/call') return base(url, request);
          state.tools.push(rpc.method);
          if (state.unknown) throw Error('PRIVATE_PROVIDER_ERROR');
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {
            ...(state.toolError ? { isError: true } : {}),
            content: [{ type: 'text', text: '[{"name":"Synthetic"}]' }],
          } }));
        };
      }
      const result = await executeMcpProjectForTest(project, opts, proof,
        (source, execution, internalGuard, hooks) => (proof ? runMcpReadOnlyProofForTest : discoverMcpToolsForTest)(
          source, execution, { ...fixture, beforeRequest: internalGuard, ...hooks }), undefined, guard);
      if (!proof) state.afterDiscovery?.();
      return result;
    },
    runAzure: async () => { throw Error('Unexpected Azure request'); },
  };
  await rewrite();
  return { root, json, definition, creation, input, options, active, output, rewrite, start, deps, state };
}

test('one execution grant advances anonymous generation/discovery/proof without per-phase approvals', async t => {
  const f = await setup(t);
  f.creation.proof.resultAssertion = { kind: 'json-array-string-field-v1', field: 'name', maxItems: 5, maxStringLength: 40 };
  const plan = await f.start();
  assert.match(plan.approvalToken, /^mcp-execution\/sha256:/);
  assert.equal(plan.grants.includes('account'), false);
  assert.equal(plan.grants.includes('sdk-host'), false);
  const result = await runExecution(f.active, f.deps);
  assert.equal(result.status, 'execution-completed');
  assert.equal(result.protocol, 'passed-historical');
  assert.equal(result.consumption.providerCalls, 1);
  assert.equal(result.consumption.azureCommands, 0);
  assert.equal(result.proofReplayAuthorized, false);
  assert.equal(f.state.tools.length, 1);
  const again = await runExecution(f.active, f.deps);
  assert.equal(again.status, 'execution-completed');
  assert.equal(f.state.tools.length, 1);
  assert.equal((await executionStatus(f.active)).journalDigest, again.journalDigest);
});

for (const parameterized of [false, true]) test(`Entra existing execution uses one sign-in with parameterized=${parameterized}`, async t => {
  const f = await setup(t);
  const catalog = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples', 'mcp', 'catalog.json')));
  f.definition.inbound = catalog.inbound;
  f.creation.discovery = { discoveryClientId: catalog.inbound.allowedClientIds[0], expectedUserId: user };
  if (parameterized) f.creation.proof.arguments = { id: 'sample' };
  const descriptor = (await prepareMcpServer(f.definition)).descriptor;
  const fixture = observationTransport(descriptor, f.creation.discovery, { tools: [{
    name: 'read_record', description: 'Read a synthetic record',
    inputSchema: { type: 'object', properties: parameterized ? { id: { type: 'string' } } : {},
      ...(parameterized ? { required: ['id'] } : {}), additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }] });
  let auth = 0, calls = 0;
  const acquire = fixture.authTransport, transport = fixture.mcpTransport;
  fixture.authTransport = (...args) => {
    if (new URL(args[0]).pathname.endsWith('/devicecode')) auth++;
    return acquire(...args);
  };
  fixture.mcpTransport = async (url, request) => {
    const rpc = JSON.parse(request.body);
    if (rpc.method !== 'tools/call') return transport(url, request);
    assert.deepEqual(rpc.params.arguments, f.creation.proof.arguments);
    calls++;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {
      content: [{ type: 'text', text: '{"ok":true}' }],
    } }));
  };
  const plan = await f.start();
  assert.equal(plan.creation.probeMode, 'session');
  const result = await runExecution({ ...f.active, onDeviceCode() {} }, { sessionDependencies: fixture });
  assert.equal(result.status, 'execution-completed');
  assert.equal(auth, 1); assert.equal(calls, 1);
  assert.equal(result.consumption.providerCalls, 1);
});

for (const condition of ['toolError', 'unknown']) test(`${condition} remains consumed and blocks resume without raw diagnostics`, async t => {
  const f = await setup(t); f.state[condition] = true;
  await f.start();
  const result = await runExecution(f.active, f.deps);
  assert.equal(result.status, 'blocked');
  assert.equal(result.consumption.providerCalls, 1);
  assert.equal(f.state.tools.length, 1);
  assert.equal((await runExecution(f.active, f.deps)).status, 'blocked');
  assert.equal(f.state.tools.length, 1);
  const journal = (await Promise.all((await readdir(path.join(f.output, 'events'))).map(name =>
    readFile(path.join(f.output, 'events', name), 'utf8')))).join('');
  assert.doesNotMatch(journal + JSON.stringify(result), /PRIVATE_PROVIDER_ERROR/);
  const checkpoint = await f.json('owner.json', { schemaVersion: 2, kind: 'checkpoint', milestones: [
    { name: 'prerequisites', outcome: 'passed', evidenceDigest: evidence, note: 'Cannot clear consumed work.' },
  ] });
  await assert.rejects(recordExecutionEvidence({ ...f.active, config: checkpoint }), /cannot clear/);
});

test('cancellation between phases can resume the same grant without repeating discovery', async t => {
  const f = await setup(t), controller = new AbortController();
  await f.start(); f.state.afterDiscovery = () => controller.abort();
  const paused = await runExecution({ ...f.active, signal: controller.signal }, f.deps);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.consumption.providerCalls, 0);
  assert.equal(f.state.calls.filter(method => method === 'tools/list').length, 1);
  const finished = await runExecution(f.active, f.deps);
  assert.equal(finished.status, 'execution-completed');
  assert.equal(f.state.calls.filter(method => method === 'tools/list').length, 2);
  assert.equal(f.state.tools.length, 1);
});

test('closed execution input rejects universal grants, old tokens, altered scope and invalid budgets locally', async t => {
  const f = await setup(t);
  const original = structuredClone(f.input);
  for (const mutate of [
    input => { input.allowEverything = true; },
    input => { input.limits.maximumProviderCalls = 2; },
    input => { input.expiresAt = new Date(Date.now() - 1000).toISOString(); },
    input => { input.expiresAt = new Date(Date.now() + 90000000).toISOString(); },
    input => { input.limits.maximumAzureCommands = 1; },
    input => { input.ownerEvidence = [{ name: 'prerequisites', outcome: 'passed', note: 'No evidence supplied.' }]; },
  ]) {
    Object.keys(f.input).forEach(key => delete f.input[key]); Object.assign(f.input, structuredClone(original));
    mutate(f.input); await f.rewrite();
    await assert.rejects(planExecution(f.options));
  }
  Object.keys(f.input).forEach(key => delete f.input[key]); Object.assign(f.input, original);
  await f.rewrite();
  const plan = await planExecution(f.options);
  await assert.rejects(startExecution({ ...f.options, approval: plan.approvalToken.replace('mcp-execution/', 'mcp-validation/') }),
    { code: 'MCP_VALIDATION_EXECUTION_APPROVAL' });
  f.creation.proof.toolName = 'different_tool'; await f.rewrite();
  await assert.rejects(startExecution({ ...f.options, approval: plan.approvalToken }));
  assert.equal((await readdir(f.root)).includes('execution'), false);
});

test('grant expiry and parent/child input drift stop before any external operation', async t => {
  for (const mode of ['expired', 'parent', 'child']) await t.test(mode, async t => {
    const f = await setup(t); await f.start();
    if (mode === 'expired') t.mock.method(Date, 'now', () => Date.parse(f.input.expiresAt) + 1);
    else {
      const target = path.join(f.output, ...(mode === 'child' ? ['journey', 'definition.json'] : ['definition.json']));
      await writeFile(target, savedJson({ ...f.definition, endpoint: 'https://other.example.com/mcp' }));
    }
    await assert.rejects(runExecution(f.active, f.deps), {
      code: mode === 'expired' ? 'MCP_VALIDATION_EXECUTION_EXPIRED' : 'MCP_VALIDATION_EXECUTION_CHANGED',
    });
    assert.equal(f.state.calls.length, 0);
  });
});

test('interrupted parent intent and active locks prevent a new run', async t => {
  const f = await setup(t); await f.start();
  const before = await executionStatus(f.active);
  const event = { schemaVersion: 1, previous: before.journalDigest, recordedAt: new Date().toISOString(),
    kind: 'intent', data: { phase: 'proof', providerCalls: 1, planDigest: evidence, childApprovalDigest: evidence } };
  await writeFile(path.join(f.output, 'events', '0003.json'), savedJson({ ...event, contentDigest: digest(event) }));
  const blocked = await runExecution(f.active, f.deps);
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.barrier, 'interrupted-intent');
  assert.equal(blocked.consumption.providerCalls, 1); assert.equal(f.state.calls.length, 0);
  await writeFile(path.join(f.output, '.provisioning.lock'), 'synthetic active lock');
  await assert.rejects(runExecution(f.active, f.deps), { code: 'PROVISIONING_LOCKED' });
});

test('an externally advanced legacy child cannot be adopted by the execution grant', async t => {
  const f = await setup(t); await f.start();
  const selected = { workspaceRoot: f.root, project: path.join(f.output, 'journey') };
  const external = await nextValidation(selected);
  await runValidation({ ...selected, approval: external.approvalToken });
  await assert.rejects(runExecution(f.active, f.deps), { code: 'MCP_VALIDATION_EXECUTION_CHANGED' });
  await assert.rejects(executionStatus(f.active), { code: 'MCP_VALIDATION_EXECUTION_CHANGED' });
  assert.equal(f.state.calls.length, 0);
});

for (const [example, scenario] of [['catalog', 'native-apim-create-v2'], ['upstream-key', 'mcp-proxy-create-v2']]) {
  test(`${scenario} includes scoped lifecycle and pauses only for real prerequisites/sign-in`, async t => {
    const f = await setup(t, example, scenario); await f.start();
    const paused = await runExecution(f.active, f.deps);
    assert.equal(paused.status, 'waiting-for-owner'); assert.equal(paused.gate, 'prerequisites');
    const config = await f.json('prerequisites.json', { schemaVersion: 2, kind: 'checkpoint', milestones: [
      { name: 'prerequisites', outcome: 'passed', evidenceDigest: evidence, note: 'Owner reviewed synthetic prerequisites.' },
    ] });
    await recordExecutionEvidence({ ...f.active, config });
    const signin = await runExecution(f.active, f.deps);
    assert.equal(signin.status, 'sign-in-required');
    assert.equal(signin.consumption.azureCommands, 0);
    assert.equal(signin.milestones.find(row => row.name === 'prerequisites').provenance, 'owner-reported-not-independently-verified');
  });
}

test('a locked explicit host identity rejects planning before creating a grant', async t => {
  const f = await setup(t, 'container-apps-direct', 'container-apps-create-v2');
  const identity = path.join(f.root, 'identity');
  await mkdir(identity);
  f.input.host.azureIdentityProject = identity;
  const filename = path.join(identity, '.mcp-execution-host.lock'), contents = '{"pid":123456}';
  await writeFile(filename, contents);
  await f.rewrite();
  await assert.rejects(planExecution(f.options), { code: 'MCP_VALIDATION_EXECUTION_IDENTITY_LOCKED' });
  assert.equal((await readdir(f.root)).includes('execution'), false);
  assert.equal(await readFile(filename, 'utf8'), contents);
});

for (const explicit of [false, true]) test(`host identity lock arriving after grant pauses without spending host authorization: explicit=${explicit}`, async t => {
  const f = await setup(t, 'container-apps-direct', 'container-apps-create-v2');
  const identity = explicit ? path.join(f.root, 'identity') : path.join(f.output, 'journey', 'source');
  if (explicit) {
    await mkdir(identity);
    f.input.host.azureIdentityProject = identity;
  }
  await f.start();
  const before = await runExecution(f.active, f.deps);
  assert.equal(before.status, 'sign-in-required');
  const filename = path.join(identity, '.mcp-execution-host.lock'), contents = '{"pid":123456}';
  await writeFile(filename, contents);
  const paused = await runExecution(f.active, f.deps);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.gate, 'identity-lock');
  assert.deepEqual(paused.consumption, before.consumption);
  assert.equal(await readFile(filename, 'utf8'), contents);
  await rm(filename);
  const resumed = await runExecution(f.active, f.deps);
  assert.equal(resumed.status, 'sign-in-required');
  assert.deepEqual(resumed.consumption, before.consumption);
});

for (const gateway of [false, true]) test(`SDK ${gateway ? 'gateway' : 'direct'} grant pauses before sign-in without spending host authorization`, async t => {
  const f = await setup(t, gateway ? 'container-apps-apim' : 'container-apps-direct',
    gateway ? 'container-apps-apim-create-v2' : 'container-apps-create-v2');
  const plan = await f.start();
  assert.ok(plan.grants.includes('sdk-host'));
  assert.ok(plan.resourceDefinitions['infra/container-app.json']);
  assert.equal(plan.creation.probeMode, 'session');
  const result = await runExecution(f.active, f.deps);
  assert.equal(result.status, 'sign-in-required');
  assert.equal(result.consumption.azureCommands, 0);
  assert.equal(result.consumption.providerCalls, 0);
  const resumed = await runExecution(f.active, f.deps);
  assert.equal(resumed.status, 'sign-in-required');
  assert.deepEqual(resumed.consumption, result.consumption);
});

for (const gateway of [false, true]) for (const key of [false, true]) {
  test(`SDK complete bounded journey: gateway=${gateway}, key=${key}`, async t => {
    const f = await setup(t, `container-apps-${gateway ? 'apim' : 'direct'}${key ? '-api-key' : ''}`,
      gateway ? 'container-apps-apim-create-v2' : 'container-apps-create-v2');
    f.input.host.scannerImage = syntheticHostScannerImage;
    f.input.limits.maximumAzureCommands = 200;
    if (!gateway && !key) {
      const client = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      f.definition.authentication.allowedClientIds = [client.toUpperCase()];
      f.creation.discovery.discoveryClientId = client;
    }
    const plan = await f.start();
    assert.equal(plan.hostReview.downloads.scannerImage, syntheticHostScannerImage);
    assert.equal(plan.hostReview.ceilings.containerApps.maxReplicas, 1);
    assert.equal(plan.hostReview.readback.health.attempts, 1);
    assert.match(plan.hostSourceManifestDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal((await runExecution(f.active, f.deps)).status, 'sign-in-required');
    const synthetic = await createSyntheticExecutionHost({ workspaceRoot: f.root,
      project: path.join(f.output, 'journey', 'source'), host: f.input.host });
    const runtime = compileHostingRecipe(f.definition).runtime;
    const endpoint = runtime.gateway?.publicUrl
      ?? `https://${f.definition.azure.appName}.synthetic.eastus.azurecontainerapps.io/mcp`;
    const auth = runtime.authentication;
    const descriptor = { endpoint, inbound: { type: 'entra', tenantId: auth.tenantId, clientId: auth.audience,
      applicationIdUri: auth.applicationIdUri, scope: auth.scope, allowedClientIds: auth.allowedClientIds } };
    const fixture = observationTransport(descriptor, f.creation.discovery, { tools: [{
      name: f.creation.proof.toolName, description: 'Read a synthetic record',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
    }] });
    const waits = [];
    fixture.waitForProof = async ms => { waits.push(ms); };
    const dependencies = { runAzure: synthetic.dependencies.runAzure,
      hostDependencies: synthetic.dependencies, sessionDependencies: fixture };
    if (!key) {
      const paused = await runExecution(f.active, dependencies);
      assert.equal(paused.status, 'sign-in-required');
      assert.equal(paused.consumption.providerCalls, 0);
      assert.equal(paused.milestones.find(row => row.name === 'runtime-deployment').outcome, 'passed');
      assert.equal(fixture.calls.length, 0);
      const hostCalls = synthetic.calls.length;
      const stillPaused = await runExecution(f.active, dependencies);
      assert.equal(stillPaused.status, 'sign-in-required');
      assert.deepEqual(stillPaused.consumption, paused.consumption);
      assert.equal(synthetic.calls.length, hostCalls);
      assert.equal(fixture.calls.length, 0);
    }
    const result = await runExecution({ ...f.active, onDeviceCode() {} }, dependencies);
    assert.equal(result.status, 'execution-completed', JSON.stringify(result));
    assert.equal(result.protocol, 'passed-historical');
    assert.equal(result.consumption.providerCalls, 1);
    assert.equal(fixture.calls.filter(call => call === 'tools/call').length, 1);
    assert.equal(fixture.calls.filter(call => call.endsWith('/devicecode')).length, 1);
    assert.deepEqual(waits, [65000]);
    assert.equal(result.milestones.find(row => row.name === 'image-build').outcome, 'passed');
    assert.equal(result.milestones.find(row => row.name === 'runtime-deployment').outcome, 'passed');
    if (key) {
      assert.equal(result.milestones.find(row => row.name === 'secret-resolution').outcome, 'passed');
      assert.match(result.milestones.find(row => row.name === 'secret-resolution').note, /validity and rotation remain unverified/);
    }
    const writes = synthetic.calls.filter(call => call.system === 'azure' && call.args.includes('PUT')).length;
    assert.equal(writes, gateway ? 5 : 1);
    assert.equal(synthetic.calls.filter(call => call.route?.includes('/build?')).length, 1);
    assert.equal(synthetic.calls.filter(call => call.route?.includes('/push?')).length, 1);
    await runExecution({ ...f.active, onDeviceCode() {} }, dependencies);
    assert.equal(synthetic.calls.filter(call => call.system === 'azure' && call.args.includes('PUT')).length, writes);
    assert.equal(fixture.calls.filter(call => call === 'tools/call').length, 1);
  });
}

test('the Azure command budget is write-ahead and an exhausted account phase cannot restart', async t => {
  const f = await setup(t, 'catalog', 'native-apim-create-v2');
  f.input.limits.maximumAzureCommands = 1;
  f.input.ownerEvidence = [{ name: 'prerequisites', outcome: 'passed', evidenceDigest: evidence,
    note: 'Owner reviewed synthetic prerequisites.' }];
  await f.start();
  let requests = 0;
  f.deps.runAzure = async () => { requests++; return [{ tenantId: f.creation.azureAccount.tenantId,
    id: f.creation.azureAccount.subscriptionId, user: { type: 'user', name: f.creation.azureAccount.accountName } }]; };
  await assert.rejects(runExecution({ ...f.active, onDeviceCode() {} }, f.deps),
    { code: 'MCP_VALIDATION_EXECUTION_UNKNOWN' });
  const status = await executionStatus(f.active);
  assert.equal(requests, 1); assert.equal(status.consumption.azureCommands, 1);
  assert.equal(status.status, 'blocked');
  assert.equal((await runExecution({ ...f.active, onDeviceCode() {} }, f.deps)).status, 'blocked');
  assert.equal(requests, 1);
});

test('related consumed endpoint history cannot obtain a new execution grant', async t => {
  const f = await setup(t); await f.start(); await runExecution(f.active, f.deps);
  f.creation.relatedProjects = [path.join(f.output, 'journey', 'source')]; await f.rewrite();
  await assert.rejects(planExecution({ ...f.options, output: path.join(f.root, 'replacement') }),
    { code: 'MCP_VALIDATION_EXECUTION_HISTORY' });
  assert.equal(f.state.tools.length, 1);
});

test('CLI execution plan/start/run has JSON stdout, a single review summary and no repeated proof question', async t => {
  const f = await setup(t), stdout = [], stderr = [];
  t.mock.method(process.stdout, 'write', value => { stdout.push(String(value)); return true; });
  t.mock.method(process.stderr, 'write', value => { stderr.push(String(value)); return true; });
  const base = ['--workspace-root', f.root, '--json'];
  assert.equal(await main(['mcp-execution-plan', ...base, '--config', f.options.config, '--output', f.output, '--summary']), 0);
  const plan = JSON.parse(stdout.join('')); stdout.length = 0;
  assert.match(stderr.join(''), /EXACT approvalToken: mcp-execution\//);
  assert.equal(await main(['mcp-execution-start', ...base, '--config', f.options.config,
    '--output', f.output, '--approve', plan.approvalToken]), 0);
  assert.equal(JSON.parse(stdout.join('')).status, 'authorized-not-executed'); stdout.length = 0;
  assert.equal(await main(['mcp-execution-run', ...base, '--project', f.output], f.deps), 0);
  assert.equal(JSON.parse(stdout.join('')).status, 'execution-completed');
  assert.doesNotMatch(stderr.join(''), /Paste the exact proof|Separate exact proof review/);
  assert.equal(f.state.tools.length, 1);
});
