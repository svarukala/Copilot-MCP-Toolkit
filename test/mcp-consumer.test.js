import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { TOOLKIT_ROOT, withCliWorkspace } from '../src/config.js';
import { prepareMcpServer } from '../src/mcp-server.js';
import { planMcpDiscovery } from '../src/mcp-discovery.js';
import { boundedSnapshot, metadataDigest, savedJson } from '../src/anonymous-metadata.js';
import { planConsumerBundle, writeConsumerBundle, readConsumerBundle, consumerNextSteps } from '../src/mcp-consumer.js';
import { guidedOnboarding } from '../src/guided-onboarding.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const client = '22222222-2222-4222-8222-222222222222';
const user = '33333333-3333-4333-8333-333333333333';
const appId = '44444444-4444-4444-8444-444444444444';
const discoveryClient = '55555555-5555-4555-8555-555555555555';
const reference = { registrationId: '+opaque/synthetic==', applicationIdUri: 'api://synthetic.example.com/token-store' };
const tool = { name: 'get_forecast', description: 'Synthetic forecast <script>never execute</script>',
  inputSchema: { type: 'object', properties: { q: { type: 'string', enum: ['Seattle'] },
    days: { type: 'integer', minimum: 1, maximum: 3 } }, required: ['q', 'days'], additionalProperties: false },
  annotations: { readOnlyHint: true } };
const digest = value => metadataDigest(boundedSnapshot(value));
async function fixture(t, { fresh = false, capture = true } = {}) {
  await mkdir(path.join(TOOLKIT_ROOT, '.test-output'), { recursive: true });
  const root = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'consumer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = (await prepareMcpServer({ schemaVersion: 1, kind: 'existing-mcp',
    server: { id: tenant, name: 'Synthetic forecast' }, endpoint: 'https://synthetic.example.com/mcp',
    inbound: { type: 'entra', tenantId: tenant, clientId: client, applicationIdUri: reference.applicationIdUri,
      scope: 'access_as_user', allowedClientIds: [discoveryClient, 'ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b'] } })).descriptor;
  const registration = { schemaVersion: 1, source: { descriptorFile: 'descriptor.json' },
    operator: { tenantId: tenant, accountName: 'operator@example.com' },
    registration: { type: 'entra-sso', name: 'Synthetic forecast', targetAudience: 'HomeTenant',
      applicableToApps: 'SpecificApp', appId, ...(!fresh ? { reference } : {}) },
    review: { metadataApprovedForExport: true } };
  const fcc = { schemaVersion: 1, connector: { displayName: 'Synthetic forecast', description: 'Synthetic weather review' },
    source: { descriptorFile: 'descriptor.json', ...(capture ? { captureFile: 'capture.json' } : {}) },
    authentication: { type: 'entra-sso', ...(!fresh ? reference : {}) },
    review: { metadataApprovedForExport: true, dataAccess: 'public-data', dataAccessReason: 'Synthetic public data',
      tools: [{ name: tool.name, readOnly: true, reason: 'Synthetic retrieval only' }] } };
  const execution = { schemaVersion: 1, registrationConfig: 'registration.json', providerRoot: path.join(root, 'provider') };
  const onboarding = { schemaVersion: 1, fccConfig: 'fcc.json', registrationConfig: 'registration.json',
    authExecutionConfig: 'execution.json', authProject: 'auth-session', pluginAppId: appId };
  const consumer = { schemaVersion: 1, consumer: 'fcc', fccConfig: 'fcc.json' };
  const save = async () => {
    for (const [name, value] of Object.entries({ descriptor, registration, fcc, execution, onboarding, consumer })) {
      await writeFile(path.join(root, `${name}.json`), savedJson(value));
    }
  };
  await save();
  if (capture) {
    const body = { schemaVersion: 1, kind: 'standalone-mcp-tools-capture', source: descriptor,
      discoveryPlan: planMcpDiscovery(descriptor, { discoveryClientId: discoveryClient, expectedUserId: user }),
      capturedAt: new Date(Date.now() - 1000).toISOString(), tools: { tools: [tool] }, toolsDigest: digest({ tools: [tool] }),
      evidence: 'observed-authenticated-discovery', protocolVersion: '2025-03-26' };
    await writeFile(path.join(root, 'capture.json'), savedJson({ ...body, receiptDigest: digest(body) }));
  }
  const calls = [];
  const identity = operator => ({ ...operator, tenantDisplayName: 'Synthetic organization',
    evidence: 'provider-account-and-selected-tenant-not-token-attestation' });
  const provider = {
    platform: () => 'linux',
    inspect: async () => ({ root: execution.providerRoot, name: '@microsoft/m365agentstoolkit-cli', version: '1.1.17', files: { code: 'synthetic' } }),
    path: owner => path.join(owner.project, 'runtime'),
    async open(owner) { calls.push('initialize'); await mkdir(this.path(owner)); return this.path(owner); },
    async validate(runtime) { await readdir(runtime); },
    async login(p, runtime, owner, operator) { calls.push('login'); return identity(operator); },
    async account(p, runtime, owner, operator) { calls.push('account'); return identity(operator); },
    async register() { calls.push('register'); return reference; },
    async close(runtime) { calls.push('close'); await rm(runtime, { recursive: true }); },
  };
  return { root, fcc, registration, onboarding, consumer, save, provider, calls,
    options: { workspaceRoot: root, config: path.join(root, 'consumer.json'), output: path.join(root, 'export') },
    guided: { workspaceRoot: root, config: path.join(root, 'onboarding.json'), output: path.join(root, 'onboarding') } };
}
function prompt(consumer, stopAt) {
  let output = '', reviews = 0;
  return { output: { write: value => { output += value; } }, get text() { return output; },
    ask: async () => assert.fail('Prepared inputs need no path questions'),
    choose: async (question, choices) => {
      const value = question.startsWith('What would') ? consumer : ++reviews === stopAt ? 'stop' : 'approve';
      assert.ok(choices.some(choice => choice.value === value)); return value;
    } };
}
for (const consumer of ['fcc', 'plugin']) test(`${consumer} writes safe private HTML and faithful observed metadata`, async t => {
  const f = await fixture(t); f.consumer.consumer = consumer; await f.save();
  const plan = await planConsumerBundle(f.options);
  assert.equal(plan.manifest.states.consumerTest, 'not-verified');
  assert.equal(plan.manifest.states.registration, 'reference-provided-settings-unverified');
  const result = await writeConsumerBundle({ ...f.options, approval: plan.approvalToken });
  const manifest = await withCliWorkspace(f.root, () => readConsumerBundle(result.outputPath));
  assert.equal(manifest.contentDigest, result.contentDigest);
  const html = await readFile(result.entryFile, 'utf8');
  assert.match(html, /--cp-bg/); assert.match(html, /data-copy=/);
  assert.match(html, /connect-src &#39;none&#39;/);
  assert.doesNotMatch(html, /<script>never execute/);
  assert.match(html, /&lt;script&gt;never execute/);
  assert.ok(html.includes(reference.registrationId));
  assert.ok(!savedJson(manifest).includes(user)); assert.ok(!html.includes('operator@example.com'));
  assert.ok(!html.includes('discoveryPlan'));
  if (consumer === 'plugin') {
    const plugin = JSON.parse(await readFile(path.join(result.outputPath, 'plugin', 'manifest.template.json')));
    const remote = plugin.agentConnectors[0].toolSource.remoteMcpServer;
    assert.equal(plugin.manifestVersion, '1.28');
    assert.equal(remote.authorization.type, 'OAuthPluginVault');
    assert.equal(remote.authorization.referenceId, reference.registrationId);
    assert.equal(remote.mcpToolDescription.file, './tools/mcp-tools.json');
    const tools = JSON.parse(await readFile(path.join(result.outputPath, 'plugin', 'tools', 'mcp-tools.json')));
    assert.deepEqual(tools.tools, [tool]);
    assert.equal(plugin.id, 'REPLACE_WITH_REAL_TEAMS_APP_ID');
  }
  await assert.rejects(writeConsumerBundle({ ...f.options, approval: plan.approvalToken }), { code: 'MCP_CONSUMER_OUTPUT_EXISTS' });
  await writeFile(result.entryFile, 'changed');
  await assert.rejects(withCliWorkspace(f.root, () => readConsumerBundle(result.outputPath)), { code: 'MCP_CONSUMER_INTEGRITY' });
});
test('missing authentication/capture blocks plugin manifest without fabricating fields', async t => {
  const f = await fixture(t, { fresh: true, capture: false }); f.consumer.consumer = 'plugin'; await f.save();
  const plan = await planConsumerBundle(f.options);
  assert.equal(plan.manifest.states.registration, 'missing');
  assert.ok(plan.manifest.gaps.some(g => g.code === 'PLUGIN_AUTH_OR_TOOLS_MISSING'));
  assert.deepEqual(plan.manifest.onboarding.tools, []);
  assert.ok(!Object.keys(plan.manifest.artifacts).some(name => name.includes('manifest.template')));
});
test('exact export approval binds metadata changes', async t => {
  const f = await fixture(t), plan = await planConsumerBundle(f.options);
  f.fcc.connector.displayName = 'Changed forecast'; await f.save();
  await assert.rejects(writeConsumerBundle({ ...f.options, approval: plan.approvalToken }), { code: 'MCP_CONSUMER_APPROVAL' });
  assert.ok(!(await readdir(f.root)).includes('export'));
});
test('plugin preserves long metadata with blockers and never truncates an oversized auth reference', async t => {
  const f = await fixture(t); f.consumer.consumer = 'plugin';
  f.fcc.connector.displayName = 'A synthetic plugin display name exceeding thirty characters';
  f.fcc.authentication.registrationId = 's'.repeat(129);
  await f.save();
  const plan = await planConsumerBundle(f.options);
  assert.ok(plan.manifest.gaps.some(g => g.code === 'PLUGIN_REFERENCE_TOO_LONG'));
  assert.ok(plan.manifest.gaps.some(g => g.code === 'PLUGIN_SHORT_METADATA_TOO_LONG'));
  assert.equal(plan.manifest.onboarding.authentication.registrationId.length, 129);
  assert.ok(!Object.keys(plan.manifest.artifacts).some(name => name.includes('manifest.template')));
  f.fcc.connector.displayName = 's'.repeat(30);
  f.fcc.connector.description = 'd'.repeat(80);
  f.fcc.authentication.registrationId = 'r'.repeat(128);
  await f.save();
  const boundary = await planConsumerBundle(f.options);
  assert.ok(!boundary.manifest.gaps.some(g => ['PLUGIN_REFERENCE_TOO_LONG', 'PLUGIN_SHORT_METADATA_TOO_LONG'].includes(g.code)));
  assert.ok(Object.keys(boundary.manifest.artifacts).some(name => name.includes('manifest.template')));
});
test('consumer keeps stale captures historical rather than renewing them', async t => {
  const f = await fixture(t);
  const captured = JSON.parse(await readFile(path.join(f.root, 'capture.json')));
  captured.capturedAt = new Date(Date.now() - 86400000).toISOString();
  const { receiptDigest, ...body } = captured;
  await writeFile(path.join(f.root, 'capture.json'), savedJson({ ...body, receiptDigest: digest(body) }));
  const plan = await planConsumerBundle(f.options);
  assert.equal(plan.manifest.onboarding.evidence.discovery.status, 'stale');
  assert.equal(plan.manifest.proofReplayAuthorized, false);
});
test('declined session creation leaves no state or provider effect', async t => {
  const f = await fixture(t);
  const result = await guidedOnboarding(prompt('fcc', 1), f.guided, { provider: f.provider });
  assert.equal(result.writes, false);
  assert.ok(!(await readdir(f.root)).includes('onboarding'));
  assert.deepEqual(f.calls, []);
});
test('changed inputs on resume stop before any registration attempt', async t => {
  const f = await fixture(t, { fresh: true });
  const first = await guidedOnboarding(prompt('fcc', 2), f.guided, { provider: f.provider });
  assert.equal(first.status, 'onboarding-paused');
  f.fcc.connector.description = 'Changed metadata'; await f.save();
  await assert.rejects(guidedOnboarding(prompt('fcc'), { workspaceRoot: f.root, project: f.guided.output },
    { provider: f.provider }), { code: 'MCP_ONBOARD_CHANGED' });
  assert.deepEqual(f.calls, []);
});
test('None exits before inputs, registration, writes or any provider inspection', async t => {
  const f = await fixture(t), result = await guidedOnboarding(prompt('none'), f.guided, { provider: f.provider });
  assert.equal(result.status, 'onboarding-deferred'); assert.equal(result.writes, false);
  assert.deepEqual(f.calls, []); assert.ok(!(await readdir(f.root)).includes('onboarding'));
});
for (const consumer of ['fcc', 'plugin']) test(`${consumer} reuses registration and resumes completed output without provider calls`, async t => {
  const f = await fixture(t), p = prompt(consumer);
  const result = await guidedOnboarding(p, f.guided, { provider: f.provider });
  assert.equal(result.status, 'consumer-draft-written-not-published');
  assert.deepEqual(f.calls, []);
  assert.match(p.text, /exact next operation/i);
  const resumed = await guidedOnboarding(prompt(consumer), { workspaceRoot: f.root, project: f.guided.output }, { provider: f.provider });
  assert.deepEqual(resumed, result); assert.deepEqual(f.calls, []);
});
for (const consumer of ['fcc', 'plugin']) test(`${consumer} creates one shared registration through the existing executor`, async t => {
  const f = await fixture(t, { fresh: true });
  const result = await guidedOnboarding(prompt(consumer), f.guided, { provider: f.provider });
  assert.equal(result.status, 'consumer-draft-written-not-published');
  assert.deepEqual(f.calls, ['initialize', 'login', 'account', 'register', 'close']);
  const html = await readFile(result.entryFile, 'utf8');
  assert.ok(html.includes(reference.registrationId)); assert.ok(html.includes(reference.applicationIdUri));
  assert.ok(!JSON.parse(await readFile(path.join(f.root, 'registration.json'))).registration.reference);
  await guidedOnboarding(prompt(consumer), { workspaceRoot: f.root, project: f.guided.output }, { provider: f.provider });
  assert.equal(f.calls.filter(value => value === 'register').length, 1);
});
test('stopping after registration resumes its receipt, never dispatching twice', async t => {
  const f = await fixture(t, { fresh: true });
  const first = await guidedOnboarding(prompt('fcc', 5), f.guided, { provider: f.provider });
  assert.equal(first.status, 'onboarding-paused');
  assert.equal(f.calls.filter(value => value === 'register').length, 1);
  assert.equal(f.calls.includes('close'), false);
  const second = await guidedOnboarding(prompt('fcc'), { workspaceRoot: f.root, project: f.guided.output }, { provider: f.provider });
  assert.equal(second.status, 'consumer-draft-written-not-published');
  assert.equal(f.calls.filter(value => value === 'register').length, 1);
});
test('unknown registration stays consumed and resuming does not retry', async t => {
  const f = await fixture(t, { fresh: true });
  f.provider.register = async () => { f.calls.push('register'); throw new Error('synthetic disconnected dispatch'); };
  await assert.rejects(guidedOnboarding(prompt('fcc'), f.guided, { provider: f.provider }));
  const next = await guidedOnboarding(prompt('fcc'), { workspaceRoot: f.root, project: f.guided.output }, { provider: f.provider });
  assert.equal(next.status, 'onboarding-paused');
  assert.match(next.reason, /registration-unknown-consumed/);
  assert.equal(f.calls.filter(value => value === 'register').length, 1);
});
test('plugin cannot reuse a different SpecificApp identity', async t => {
  const f = await fixture(t); f.onboarding.pluginAppId = tenant; await f.save();
  await assert.rejects(guidedOnboarding(prompt('plugin'), f.guided, { provider: f.provider }), { code: 'MCP_ONBOARD_APP_RESTRICTION' });
  assert.deepEqual(f.calls, []);
});
test('machine next steps and CLI never implicitly enter a terminal workflow', () => {
  assert.deepEqual(consumerNextSteps('private-workspace').choices.map(choice => choice.value), ['fcc', 'plugin', 'none']);
  for (const [command, expected] of [['mcp-consumer-schema', 0], ['mcp-onboard-schema', 0], ['mcp-onboard', 1]]) {
    const result = spawnSync(process.execPath, [path.join(TOOLKIT_ROOT, 'bin', 'copilot-mcp.js'), command, '--json'],
      { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, expected, result.stderr);
    assert.equal(typeof JSON.parse(result.stdout), 'object'); assert.equal(result.stderr, '');
  }
});
