import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { TOOLKIT_ROOT, withCliWorkspace } from '../src/config.js';
import { savedJson, metadataDigest, boundedSnapshot } from '../src/anonymous-metadata.js';
import { planHostingRecipe, writeHostingRecipe } from '../src/mcp-container-apps.js';
import { planRecipeReference, writeRecipeReference, planRecipeRelease, writeRecipeRelease } from '../src/mcp-recipe-artifacts.js';
import { planValidation, startValidation, nextValidation, runValidation, validationStatus } from '../src/mcp-validation.js';
import { executeMcpProjectForTest } from '../src/mcp-discovery-project.js';
import { runMcpReadOnlyProofForTest } from '../src/mcp-discovery.js';
import { main } from '../bin/copilot-mcp.js';

const evidenceDigest = `sha256:${'a'.repeat(64)}`;
const assertion = { kind: 'json-array-string-field-v1', field: 'name', maxItems: 5, maxStringLength: 40 };
async function setup(t, { consumer = 'none', resultAssertion = assertion, apiKey = false, release = false } = {}) {
  t.mock.method(globalThis, 'fetch', () => { throw Error('Unexpected external request'); });
  const parent = path.join(TOOLKIT_ROOT, '.test-output');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const json = async (name, input) => {
    const filename = path.join(root, name);
    await writeFile(filename, savedJson(input)); return filename;
  };
  const input = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples', 'mcp',
    `container-apps-direct${apiKey ? '-api-key' : ''}.json`)));
  const source = path.join(root, 'source'), reference = path.join(root, 'reference'), run = path.join(root, 'run');
  const sourceOptions = { workspaceRoot: root, output: source, config: await json('source.json', input) };
  const sourcePlan = await planHostingRecipe(sourceOptions);
  await writeHostingRecipe({ ...sourceOptions, approval: sourcePlan.approvalToken });
  const referenceOptions = { workspaceRoot: root, project: source, output: reference, config: await json('reference.json', {
    schemaVersion: 1, serverId: '66666666-6666-4666-8666-666666666666', endpoint: 'https://synthetic.example.com/mcp',
  }) };
  const referencePlan = await planRecipeReference(referenceOptions);
  await writeRecipeReference({ ...referenceOptions, approval: referencePlan.approvalToken });
  if (release) {
    const selected = { workspaceRoot: root, project: source, output: path.join(root, 'release'),
      config: await json('release.json', { schemaVersion: 1, accountName: 'operator@example.com',
        containerImage: `${input.azure.registry.server}/mcp@sha256:${'a'.repeat(64)}` }) };
    await writeRecipeRelease({ ...selected, approval: (await planRecipeRelease(selected)).approvalToken });
  }
  const definition = { schemaVersion: 1, scenario: 'container-apps-existing-v1', sourceProject: 'source',
    referenceProject: 'reference', consumer, privateExportReviewed: true, ...(release ? { releaseDirectory: 'release' } : {}),
    discovery: { discoveryClientId: input.authentication.allowedClientIds[0], expectedUserId: '55555555-5555-4555-8555-555555555555' },
    proof: { toolName: input.operationIds[0], arguments: {},
      safetyReview: { readOnly: true, reason: 'Owner reviewed the fixed GET.' },
      ...(resultAssertion ? { resultAssertion } : {}) } };
  const config = await json('validation.json', definition);
  const options = { workspaceRoot: root, output: run, config };
  const active = { workspaceRoot: root, project: run };
  const start = async () => startValidation({ ...options, approval: (await planValidation(options)).approvalToken });
  const record = async (milestones = [{ name: 'runtime-deployment', outcome: 'passed', evidenceDigest, note: 'Owner reviewed existing deployment.' }]) => {
    const config = await json('checkpoint.json', { schemaVersion: 1, milestones });
    const selected = { ...active, config };
    const plan = await nextValidation(selected);
    return runValidation({ ...selected, approval: plan.approvalToken });
  };
  const transport = ({ response = [{ name: 'Synthetic' }], unknown = false, toolError = false } = {}) => {
    const calls = [], { tenantId, audience, applicationIdUri, scope } = input.authentication;
    const { discoveryClientId, expectedUserId } = definition.discovery;
    return { calls,
      authTransport: async (url, request) => {
        const endpoint = new URL(url); calls.push(endpoint.pathname);
        let body;
        if (endpoint.pathname.endsWith('/openid-configuration')) body = {
          authorization_endpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
          token_endpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
          end_session_endpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/logout`,
          issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
          jwks_uri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
        };
        else if (endpoint.pathname.endsWith('/devicecode')) {
          assert.equal(new URLSearchParams(request.body).get('client_id'), discoveryClientId);
          body = { user_code: 'ABCD-1234', device_code: 'private-device-code',
            verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 1 };
        } else if (endpoint.pathname.endsWith('/token')) {
          const claims = { tid: tenantId, oid: expectedUserId, aud: discoveryClientId, sub: 'fixture',
            preferred_username: 'private@invalid', iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
            exp: Math.floor(Date.now() / 1000) + 3600 };
          const idToken = [Buffer.from('{"alg":"RS256"}').toString('base64url'),
            Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.');
          body = { token_type: 'Bearer', access_token: 'private-access-value', expires_in: 3600,
            scope: `${applicationIdUri}/${scope}`, id_token: idToken, refresh_token: 'private-refresh-value',
            client_info: Buffer.from(JSON.stringify({ uid: expectedUserId, utid: tenantId })).toString('base64url') };
        } else throw Error(`Unexpected auth endpoint for ${audience}`);
        return new Response(JSON.stringify(body));
      },
      mcpTransport: async (url, request) => {
        assert.equal(url, 'https://synthetic.example.com/mcp');
        const message = JSON.parse(request.body); calls.push(message.method);
        if (message.method === 'notifications/initialized') return new Response(null, { status: 204 });
        let result;
        if (message.method === 'initialize') result = { protocolVersion: '2025-03-26',
          capabilities: { tools: {} }, serverInfo: { name: 'Synthetic', version: '1' } };
        else if (message.method === 'tools/list') result = { tools: [{ name: definition.proof.toolName, description: 'Read reviewed data',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true, destructiveHint: false } }] };
        else if (message.method === 'tools/call') {
          if (unknown) throw Error('private-provider-failure');
          result = { ...(toolError ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(response) }] };
        } else throw Error('Unexpected method');
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      },
    };
  };
  const execute = async (fixture = transport(), approveProof = plan => plan.approvalDigest) => {
    const plan = await nextValidation(active);
    const report = await runValidation({ ...active, approval: plan.approvalToken, allowNetwork: true,
      interactive: true, onDeviceCode() {}, approveProof }, { sessionDependencies: fixture,
      mcpProjectOperation: (project, opts, proof) => executeMcpProjectForTest(project, opts, proof,
        (source, execution, guard, hooks) => runMcpReadOnlyProofForTest(source, execution,
          { ...fixture, beforeRequest: guard, ...hooks })) });
    return { report, fixture };
  };
  return { root, json, source, reference, run, options, active, definition, start, record, transport, execute };
}

test('validation local start, exact checkpoints, fresh-process status and paused handover are network-free', async t => {
  const c = await setup(t, { consumer: 'fcc' });
  const plan = await planValidation(c.options);
  await assert.rejects(startValidation({ ...c.options, approval: 'yes' }), { code: 'MCP_VALIDATION_APPROVAL' });
  assert.equal((await c.start()).status, 'waiting-for-owner');
  assert.equal((await nextValidation(c.active)).approvalToken, null);
  await assert.rejects(c.start(), { code: 'MCP_VALIDATION_EXISTS' });
  const report = await c.record();
  assert.equal(report.milestones[0].provenance, 'owner-reported-not-independently-verified');
  assert.equal((await nextValidation(c.active)).phase, 'session');
  const fresh = spawnSync(process.execPath, [path.join(TOOLKIT_ROOT, 'bin', 'copilot-mcp.js'), 'mcp-validation-status',
    '--workspace-root', c.root, '--project', c.run, '--json'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(fresh.status, 2, fresh.stdout + fresh.stderr);
  assert.equal(JSON.parse(fresh.stdout).protocol.status, 'pending');
  const selection = { ...c.active, phase: 'handover' }, handover = await nextValidation(selection);
  assert.equal(handover.childPlan.manifest.executionReadiness, false);
  const exported = await runValidation({ ...selection, approval: handover.approvalToken });
  assert.equal(exported.handovers.length, 1);
  assert.equal((await nextValidation(selection)).status, 'complete');
  assert.equal(plan.input.sourceProject, c.source);
});

test('validation session reuses sign-in, separately approves proof and retains historical results without replay', async t => {
  const c = await setup(t); await c.start(); await c.record();
  const fixture = c.transport();
  let approvals = 0;
  const { report } = await c.execute(fixture, plan => {
    approvals++; assert.equal(fixture.calls.includes('tools/call'), false); return plan.approvalDigest;
  });
  assert.equal(approvals, 1);
  assert.equal(fixture.calls.filter(v => v.endsWith('/devicecode')).length, 1);
  assert.equal(fixture.calls.filter(v => v === 'tools/list').length, 2);
  assert.equal(fixture.calls.filter(v => v === 'tools/call').length, 1);
  assert.equal(report.protocol.status, 'passed-historical');
  assert.equal(report.outcome, 'passed-with-owner-and-historical-evidence');
  assert.equal((await nextValidation(c.active)).phase, 'handover');
  const second = { ...c.options, output: path.join(c.root, 'another-run') };
  const another = await startValidation({ ...second, approval: (await planValidation(second)).approvalToken });
  assert.equal(another.protocol.status, 'passed-historical');
  for (const dir of ['events', 'reports']) for (const name of await readdir(path.join(c.run, dir))) {
    const contents = await readFile(path.join(c.run, dir, name), 'utf8');
    for (const value of ['ABCD-1234', 'private-access-value', 'private-refresh-value', 'private-device-code', 'private@invalid']) {
      assert.ok(!contents.includes(value), value);
    }
  }
});

test('declined session proof resumes from capture with a separate proof approval, never repeats discovery', async t => {
  const c = await setup(t); await c.start(); await c.record();
  const fixture = c.transport();
  assert.equal((await c.execute(fixture, () => '')).report.lastStep.status, 'declined');
  assert.equal(fixture.calls.includes('tools/call'), false);
  assert.equal((await nextValidation(c.active)).phase, 'proof');
  const second = c.transport();
  const { report } = await c.execute(second);
  assert.equal(report.protocol.status, 'passed-historical');
  assert.equal(second.calls.filter(v => v === 'tools/list').length, 1);
  assert.equal(second.calls.filter(v => v === 'tools/call').length, 1);
});

for (const mode of ['structural-failure', 'tool-error', 'unknown']) {
  test(`validation ${mode} stays consumed through checkpoint, refresh and paused export`, async t => {
    const c = await setup(t); await c.start(); await c.record();
    const fixture = c.transport({ response: mode === 'structural-failure' ? [] : [{ name: 'Synthetic' }],
      unknown: mode === 'unknown', toolError: mode === 'tool-error' });
    const { report } = await c.execute(fixture);
    assert.equal(report.status, 'blocked');
    assert.equal((await nextValidation(c.active)).approvalToken, null);
    await c.record();
    assert.equal((await validationStatus(c.active)).status, 'blocked');
    const refresh = { ...c.active, phase: 'refresh' }, refreshPlan = await nextValidation(refresh);
    await runValidation({ ...refresh, approval: refreshPlan.approvalToken });
    const selected = { ...c.active, phase: 'handover' }, plan = await nextValidation(selected);
    await runValidation({ ...selected, approval: plan.approvalToken });
    assert.equal((await validationStatus(c.active)).status, 'blocked');
    assert.equal(fixture.calls.filter(v => v === 'tools/call').length, 1);
  });
}

test('stale approvals, immutable input drift, invalid checkpoints and effect escalation are rejected', async t => {
  const c = await setup(t); await c.start();
  await assert.rejects(c.record([{ name: 'protocol', outcome: 'passed', evidenceDigest, note: 'Not owner-verifiable.' }]),
    { code: 'MCP_VALIDATION_INPUT' });
  await c.record();
  const stale = await nextValidation(c.active);
  await c.record();
  await assert.rejects(runValidation({ ...c.active, approval: stale.approvalToken, allowNetwork: true, interactive: true,
    onDeviceCode() {}, approveProof() {} }), { code: 'MCP_VALIDATION_APPROVAL' });
  const refresh = { ...c.active, phase: 'refresh' }, plan = await nextValidation(refresh);
  await assert.rejects(runValidation({ ...refresh, approval: plan.approvalToken, allowNetwork: true }),
    { code: 'MCP_VALIDATION_FLAGS' });
  const origin = path.join(c.reference, 'recipe-origin.json');
  const original = JSON.parse(await readFile(origin));
  await writeFile(origin, savedJson({ ...original, endpoint: 'https://different.example.com/mcp' }));
  await assert.rejects(validationStatus(c.active), { code: 'MCP_VALIDATION_REFERENCE' });
});

test('interrupted validation intent blocks execution and checkpoints without repeating sign-in', async t => {
  const c = await setup(t); await c.start(); await c.record();
  const directory = path.join(c.run, 'events'), previous = JSON.parse(await readFile(path.join(directory, '0001.json')));
  const body = { schemaVersion: 1, previous: previous.contentDigest, recordedAt: new Date().toISOString(),
    kind: 'intent', data: { phase: 'session', approvalDigest: evidenceDigest } };
  await writeFile(path.join(directory, '0002.json'), savedJson({ ...body, contentDigest: metadataDigest(boundedSnapshot(body)) }));
  assert.equal((await nextValidation(c.active)).status, 'blocked');
  assert.equal((await validationStatus(c.active)).lastStep.status, 'unknown');
  await assert.rejects(c.record(), { code: 'MCP_VALIDATION_APPROVAL' });
  await withCliWorkspace(c.root, async () => {
    const corrupt = { ...body, recordedAt: 'not-a-date' };
    await writeFile(path.join(directory, '0002.json'), savedJson({ ...corrupt, contentDigest: metadataDigest(boundedSnapshot(corrupt)) }));
    await assert.rejects(validationStatus(c.active), { code: 'MCP_VALIDATION_STATE' });
  });
});

test('validation CLI emits JSON and rejects missing terminal or unrelated cloud flags before effects', async t => {
  const c = await setup(t); await c.start(); await c.record();
  const output = [], stderr = [];
  t.mock.method(process.stdout, 'write', chunk => { output.push(String(chunk)); return true; });
  t.mock.method(process.stderr, 'write', chunk => { stderr.push(String(chunk)); return true; });
  const args = ['--workspace-root', c.root, '--project', c.run, '--json'];
  assert.equal(await main(['mcp-validation-next', ...args, '--summary']), 0);
  const plan = JSON.parse(output.splice(0).join(''));
  assert.match(stderr.join(''), /EXACT approvalToken/);
  assert.equal(await main(['mcp-validation-run', ...args, '--approve', plan.approvalToken, '--allow-cloud']), 1);
  assert.equal(JSON.parse(output.splice(0).join('')).success, false);
  const fixture = c.transport();
  assert.equal(await main(['mcp-validation-run', ...args, '--approve', plan.approvalToken, '--allow-network', '--interactive'],
    { sessionDependencies: fixture, onMcpDeviceCode() {}, sessionProofApproval: p => p.approvalDigest }), 0);
  assert.equal(JSON.parse(output.splice(0).join('')).protocol.status, 'passed-historical');
  assert.ok(!stderr.join('').includes('ABCD-1234'));
});

test('run locks, pre-dispatch cancellation, changed build and unsafe paths fail before network', async t => {
  const c = await setup(t); await c.start(); await c.record();
  const plan = await nextValidation(c.active), controller = new AbortController();
  controller.abort();
  await assert.rejects(runValidation({ ...c.active, approval: plan.approvalToken, allowNetwork: true,
    interactive: true, onDeviceCode() {}, approveProof() {}, signal: controller.signal }),
  { code: 'MCP_VALIDATION_ABORTED' });
  assert.equal((await readdir(path.join(c.run, 'events'))).length, 1);
  const lock = path.join(c.run, '.provisioning.lock');
  await writeFile(lock, 'interrupted-owner');
  await assert.rejects(runValidation({ ...c.active, approval: plan.approvalToken }), { code: 'PROVISIONING_LOCKED' });
  assert.equal(await readFile(lock, 'utf8'), 'interrupted-owner');
  const networkLock = path.join(c.reference, '.mcp-network.lock');
  await writeFile(networkLock, 'interrupted-network');
  assert.equal((await nextValidation(c.active)).status, 'blocked');
  assert.equal(await readFile(networkLock, 'utf8'), 'interrupted-network');
  const empty = { ...c.options, output: path.join(c.root, 'build-change') };
  await startValidation({ ...empty, approval: (await planValidation(empty)).approvalToken });
  const file = path.join(empty.output, 'validation-run.json'), { contentDigest, ...record } = JSON.parse(await readFile(file));
  const changed = { ...record, buildId: evidenceDigest };
  await writeFile(file, savedJson({ ...changed, contentDigest: metadataDigest(boundedSnapshot(changed)) }));
  await assert.rejects(validationStatus({ ...c.active, project: empty.output }), { code: 'MCP_VALIDATION_BUILD' });
  await assert.rejects(planValidation({ ...c.options, output: path.join(c.source, 'run') }), { code: 'MCP_VALIDATION_OUTPUT' });
  await assert.rejects(planValidation({ ...c.options, output: path.join(c.root, '..', 'escape') }), /inside --workspace-root/);
});

test('historical proof for a different requested user or assertion blocks instead of starting another session', async t => {
  const c = await setup(t); await c.start(); await c.record(); await c.execute();
  for (const variant of ['identity', 'assertion']) {
    const input = structuredClone(c.definition);
    if (variant === 'identity') input.discovery.expectedUserId = '77777777-7777-4777-8777-777777777777';
    else input.proof.resultAssertion.maxItems = 4;
    const options = { ...c.options, output: path.join(c.root, variant), config: await c.json(`${variant}.json`, input) };
    const plan = await planValidation(options);
    const report = await startValidation({ ...options, approval: plan.approvalToken });
    assert.equal(report.protocol.status, 'consumed-other-proof');
    assert.equal((await nextValidation({ ...c.active, project: options.output })).approvalToken, null);
  }
});

test('externally changed evidence requires a local refresh; edited snapshot cannot relabel a checkpoint', async t => {
  const c = await setup(t); await c.start(); await c.record();
  const { planOperatorRecord, writeOperatorRecord } = await import('../src/mcp-operator.js');
  const external = { workspaceRoot: c.root, project: c.source, config: await c.json('operator.json', {
    schemaVersion: 1, action: 'wait', phase: 'Registration', reason: 'owner-unavailable',
    resumeWhen: 'Owner returns to the exact checkpoint',
  }) };
  await writeOperatorRecord({ ...external, approval: (await planOperatorRecord(external)).approvalToken });
  assert.equal((await nextValidation(c.active)).status, 'waiting-for-owner');
  await assert.rejects(nextValidation({ ...c.active, phase: 'handover' }), { code: 'MCP_VALIDATION_SNAPSHOT' });
  const refresh = { ...c.active, phase: 'refresh' }, plan = await nextValidation(refresh);
  await runValidation({ ...refresh, approval: plan.approvalToken });
  const paused = await nextValidation({ ...c.active, phase: 'handover' });
  assert.equal(paused.childPlan.manifest.waiting.repeatPrompt, false);
  const file = path.join(c.run, 'reports', '0002-handover.json'), value = JSON.parse(await readFile(file));
  await writeFile(file, savedJson({ ...value, milestones: [{ name: 'consumer-call', outcome: 'passed',
    observedAt: value.snapshotAt, note: 'Forged declaration outside the checkpoint.' }] }));
  await assert.rejects(nextValidation({ ...c.active, phase: 'handover' }), { code: 'MCP_VALIDATION_SNAPSHOT' });
});

test('terminal failure retains unknown outcome without raw error contents or later replay', async t => {
  const c = await setup(t); await c.start(); await c.record();
  const fixture = c.transport();
  fixture.authTransport = async () => { throw Error('private-auth-service-response'); };
  await assert.rejects(c.execute(fixture), { code: 'MCP_VALIDATION_STEP_UNKNOWN' });
  assert.equal((await validationStatus(c.active)).status, 'blocked');
  assert.equal((await nextValidation(c.active)).approvalToken, null);
  const result = await readFile(path.join(c.run, 'events', '0003.json'), 'utf8');
  assert.ok(!result.includes('private-auth-service-response'));
  assert.equal(JSON.parse(result).data.status, 'unknown');
});

test('API-key deployment requires an owner resolution checkpoint; FCC deferrals and exact release stay honest', async t => {
  const c = await setup(t, { apiKey: true, release: true, consumer: 'fcc' });
  await c.start(); await c.record();
  const waiting = await nextValidation(c.active);
  assert.equal(waiting.status, 'waiting-for-owner');
  assert.match(waiting.reason, /secret-resolution/);
  await c.record([{ name: 'secret-resolution', outcome: 'passed', evidenceDigest,
    note: 'Owner inspected platform reference status without exporting credentials.' }]);
  const { report } = await c.execute();
  assert.equal(report.protocol.status, 'passed-historical');
  assert.equal(report.localChecks.release, 'source-matched-not-deployed');
  assert.equal((await nextValidation(c.active)).status, 'waiting-for-owner');
  await c.record(report.milestones.filter(m => m.outcome === 'pending')
    .map(m => ({ name: m.name, outcome: 'deferred', note: 'Owner deferred consumer acceptance.' })));
  const plan = await nextValidation(c.active);
  assert.equal(plan.phase, 'handover');
  assert.equal(plan.report.outcome, 'incomplete');
  assert.equal(plan.childPlan.manifest.milestones.find(m => m.name === 'consumer-call').status, 'deferred');
  const output = await runValidation({ ...c.active, approval: plan.approvalToken });
  assert.equal(output.outcome, 'incomplete');
  assert.equal((await nextValidation(c.active)).status, 'complete');
  const file = path.join(c.root, 'release', 'release-review.json'), review = JSON.parse(await readFile(file));
  await writeFile(file, savedJson({ ...review, accountName: 'different@example.com' }));
  await assert.rejects(validationStatus(c.active), { code: 'MCP_VALIDATION_CHANGED' });
});
