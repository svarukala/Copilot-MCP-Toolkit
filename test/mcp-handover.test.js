import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { TOOLKIT_ROOT, withCliWorkspace } from '../src/config.js';
import { boundedSnapshot, metadataDigest, savedJson } from '../src/anonymous-metadata.js';
import { planHostingRecipe, writeHostingRecipe } from '../src/mcp-container-apps.js';
import { planRecipeRelease, writeRecipeRelease, recipeSourcePlan, planRecipeReference, writeRecipeReference } from '../src/mcp-recipe-artifacts.js';
import { planOperatorRecord, writeOperatorRecord } from '../src/mcp-operator.js';
import { readMcpServerProject } from '../src/mcp-lifecycle.js';
import { planHandover, writeHandover } from '../src/mcp-handover.js';
import { assessResultAssertion } from '../src/mcp-result-assertion.js';
import { planMcpDiscovery, discoverMcpToolsForTest } from '../src/mcp-discovery.js';

const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const digest = value => metadataDigest(boundedSnapshot(value));
const recipes = ['container-apps-direct', 'container-apps-apim', 'app-service-container', 'functions-sdk'];
async function setup(t, name = recipes[0], key = false, configure = () => {}) {
  const parent = path.join(TOOLKIT_ROOT, '.test-output');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'handover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = JSON.parse(await readFile(new URL(`../examples/mcp/${name}${key ? '-api-key' : ''}.json`, import.meta.url)));
  configure(input);
  const config = path.join(root, 'recipe.json');
  await writeFile(config, savedJson(input));
  const generation = { workspaceRoot: root, config, output: path.join(root, 'source') };
  const plan = await planHostingRecipe(generation);
  await writeHostingRecipe({ ...generation, approval: plan.approvalToken });
  const options = { workspaceRoot: root, project: generation.output,
    config: path.join(root, 'handover.json'), output: path.join(root, 'handover') };
  const setConfig = async (extra = {}) => {
    const value = { schemaVersion: 1, snapshotAt: new Date().toISOString(), privateExportReviewed: true, ...extra };
    await writeFile(options.config, savedJson(value));
    return value;
  };
  const record = async event => {
    const config = path.join(root, 'operator.json');
    await writeFile(config, savedJson(event));
    const review = await planOperatorRecord({ ...options, config });
    return writeOperatorRecord({ ...options, config, approval: review.approvalToken });
  };
  await setConfig();
  return { ...options, options, input, setConfig, record, root };
}
async function release(f) {
  const source = await recipeSourcePlan(f.options);
  const config = path.join(f.root, 'release.json');
  await writeFile(config, savedJson({ schemaVersion: 1, accountName: 'operator@example.com',
    ...(f.input.recipe === 'functions-sdk-v1' ? { sourceArchiveSha256: source.sourceArchiveSha256 }
      : { containerImage: `${f.input.azure.registry.server}/mcp@sha256:${'a'.repeat(64)}` }),
    ...(f.input.azure.gateway ? { backendOrigin: `https://${f.input.azure.appName}.synthetic.eastus.azurecontainerapps.io` } : {}),
  }));
  const options = { ...f.options, config, output: path.join(f.root, 'release') };
  const plan = await planRecipeRelease(options);
  await writeRecipeRelease({ ...options, approval: plan.approvalToken });
  return options.output;
}
async function reference(f) {
  const config = path.join(f.root, 'reference.json');
  await writeFile(config, savedJson({ schemaVersion: 1, serverId: '66666666-6666-4666-8666-666666666666',
    endpoint: 'https://synthetic.example.com/mcp' }));
  const options = { ...f.options, config, output: path.join(f.root, 'reference') };
  const plan = await planRecipeReference(options);
  await writeRecipeReference({ ...options, approval: plan.approvalToken });
  return options.output;
}

test('mixed-case source authentication survives canonical reference and handover binding', async t => {
  const f = await setup(t, recipes[0], false, input => {
    input.authentication.allowedClientIds = ['CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC'];
  });
  const directory = await reference(f);
  const sourceBefore = await readFile(path.join(f.project, 'recipe-manifest.json'));
  const ref = await withCliWorkspace(f.root, () => readMcpServerProject(directory));
  assert.deepEqual(ref.review.input.inbound.allowedClientIds, ['cccccccc-cccc-4ccc-8ccc-cccccccccccc']);
  await f.setConfig({ referenceProject: 'reference' });
  const plan = await planHandover(f.options);
  assert.equal(plan.manifest.executionReadiness, false);
  assert.deepEqual(await readFile(path.join(f.project, 'recipe-manifest.json')), sourceBefore);
});

for (const recipe of recipes) for (const secured of [false, true]) {
  test(`${recipe} ${secured ? 'API-key' : 'anonymous'} handover preserves source, diagrams, release and honest scope`, async t => {
    const f = await setup(t, recipe, secured);
    await release(f);
    await f.setConfig({ releaseDirectory: 'release' });
    await mkdir(path.join(f.project, '.azure'));
    await writeFile(path.join(f.project, '.azure', 'tokens.json'), 'DO_NOT_COPY_PRIVATE_CACHE');
    const plan = await planHandover(f.options);
    assert.equal(plan.manifest.executionReadiness, false);
    assert.equal(plan.manifest.proofReplayAuthorized, false);
    assert.ok(plan.manifest.milestones.every(m => m.status === 'pending'));
    assert.ok(plan.manifest.resources.every(r => ['configured-reuse', 'planned-create'].includes(r.disposition)));
    assert.equal(plan.manifest.architecture.nodes.some(n => n.id === 'gateway'), recipe === 'container-apps-apim');
    assert.equal(plan.manifest.architecture.nodes.some(n => n.id === 'vault'), secured);
    assert.equal(plan.manifest.architecture.nodes.find(n => n.id === 'supply').label,
      recipe === 'functions-sdk' ? 'Storage + identity' : 'ACR + pull identity');
    if (recipe === 'container-apps-apim') {
      const ids = plan.manifest.steps.map(s => s.id);
      assert.ok(ids.indexOf('host-stage') < ids.indexOf('release-plan'));
      assert.match(plan.manifest.steps.find(s => s.id === 'deploy').instruction, /do not replay/);
    }
    const result = await writeHandover({ ...f.options, approval: plan.approvalToken });
    assert.equal(result.status, 'handover-written-not-executed');
    const manifest = JSON.parse(await readFile(path.join(f.output, 'handover-manifest.json')));
    const { contentDigest, ...body } = manifest;
    assert.equal(contentDigest, digest(body));
    for (const [name, expected] of Object.entries(manifest.artifacts)) {
      const bytes = await readFile(path.join(f.output, ...name.split('/')));
      assert.equal(hash(bytes), expected.sha256);
      assert.equal(bytes.length, expected.bytes);
    }
    assert.equal(await readFile(path.join(f.output, 'source', 'server.js'), 'utf8'), await readFile(path.join(f.project, 'server.js'), 'utf8'));
    assert.doesNotMatch(JSON.stringify(manifest), /DO_NOT_COPY|tokens\.json|authorization.*basis/);
    assert.ok(!Object.keys(manifest.artifacts).some(name => /(?:^|\/)\.azure(?:\/|$)|capture\.json|proof\.json/.test(name)));
    const html = await readFile(result.entryFile, 'utf8');
    assert.equal((html.match(/<button[^>]+role="tab"/g) ?? []).length, 2);
    assert.match(html, /<svg /);
    assert.match(html, /connect-src &#39;none&#39;/);
    assert.match(html, /registry \/ resolved URLs/);
    assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|fetch\(|XMLHttpRequest|eval\(|onclick=/i);
    for (const match of html.matchAll(/href="([^"]+)"/g)) {
      assert.doesNotMatch(match[1], /^\w+:|^\/|(?:^|\/)\.\.(?:\/|$)/);
      await readFile(path.join(f.output, ...match[1].split('/')));
    }
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      const value = createHash('sha256').update(script[1]).digest('base64');
      assert.ok(html.includes(`sha256-${value}`));
    }
    const drawing = JSON.parse(await readFile(path.join(f.output, 'architecture.excalidraw')));
    assert.equal(drawing.type, 'excalidraw');
    assert.equal(new Set(drawing.elements.map(e => e.id)).size, drawing.elements.length);
    for (const e of drawing.elements.filter(e => e.type === 'text')) {
      assert.ok(e.width > 0 && e.height >= e.fontSize * 2.5);
      assert.equal(e.strokeColor, '#000000');
    }
    assert.ok(drawing.elements.filter(e => e.type === 'rectangle').every(e => e.backgroundColor === 'transparent'));
    await assert.rejects(writeHandover({ ...f.options, approval: plan.approvalToken }), { code: 'MCP_HANDOVER_OUTPUT_EXISTS' });
  });
}
test('owner reports, deferred work and waiting remain declarations; changed journals invalidate approval', async t => {
  const f = await setup(t);
  const reservation = await planHandover(f.options);
  const resource = reservation.manifest.resources.find(r => r.disposition === 'planned-create').resourceId;
  const reserved = await f.record({ schemaVersion: 1, action: 'reserve', operation: { kind: 'deployment',
    tenantId: f.input.azure.tenantId, subscriptionId: f.input.azure.subscriptionId,
    accountName: 'operator@example.com', target: resource, purpose: 'Synthetic deployment',
    inputsDigest: `sha256:${'b'.repeat(64)}`,
    authorization: { basis: 'explicit-operation-review', reviewDigest: `sha256:${'c'.repeat(64)}` } } });
  const [operationKey] = Object.keys(reserved.operations);
  await f.record({ schemaVersion: 1, action: 'dispatch', operationKey });
  await f.record({ schemaVersion: 1, action: 'owner-result', milestone: 'runtime-deployment', outcome: 'passed', evidenceDigest: `sha256:${'b'.repeat(64)}` });
  await f.record({ schemaVersion: 1, action: 'wait', phase: 'Registration', reason: 'owner-unavailable', resumeWhen: 'Owner chooses a new registration review' });
  await f.setConfig({ milestones: [{ name: 'auth-registration', outcome: 'deferred', observedAt: new Date().toISOString(),
    note: 'Prior spike sign-in is not registration qualification.' }] });
  const plan = await planHandover(f.options);
  assert.equal(plan.manifest.milestones.find(m => m.name === 'runtime-deployment').status, 'user-reported-passed');
  assert.equal(plan.manifest.milestones.find(m => m.name === 'auth-registration').status, 'deferred');
  assert.equal(plan.manifest.waiting.phase, 'Registration');
  assert.equal(plan.manifest.operatorActivity[0].status, 'unknown');
  assert.equal(plan.manifest.operatorActivity[0].replayAuthorized, false);
  assert.doesNotMatch(JSON.stringify(plan.manifest.operatorActivity), /authorization|accountName/);
  await f.record({ schemaVersion: 1, action: 'owner-result', milestone: 'consumer-call', outcome: 'failed', evidenceDigest: `sha256:${'c'.repeat(64)}` });
  await assert.rejects(writeHandover({ ...f.options, approval: plan.approvalToken }));
  assert.ok(!(await readdir(f.root)).includes('handover'));
});
test('new resource outcomes require exact configured IDs and never become service-attested', async t => {
  const f = await setup(t), original = await planHandover(f.options);
  const resourceId = original.manifest.resources.find(r => r.disposition === 'planned-create').resourceId;
  await f.setConfig({ resourceOutcomes: [{ resourceId, disposition: 'created', observedAt: new Date().toISOString() }] });
  const result = await planHandover(f.options);
  assert.equal(result.manifest.resources.find(r => r.resourceId === resourceId).provenance, 'owner-reported-not-service-readback');
  await f.setConfig({ resourceOutcomes: [{ resourceId: `${resourceId}-foreign`, disposition: 'created', observedAt: new Date().toISOString() }] });
  await assert.rejects(planHandover(f.options), { code: 'MCP_HANDOVER_RESOURCE' });
});
test('handover rejects invalid/private inputs, future dates, duplicate claims and status inflation', async t => {
  const f = await setup(t);
  for (const patch of [
    { privateExportReviewed: false }, { snapshotAt: '2099-01-01T00:00:00.000Z' }, { rawLogs: 'not supported' },
    { milestones: [{ name: 'runtime-deployment', outcome: 'verified', observedAt: new Date().toISOString() }] },
    { operationsNote: 'line\ncontrol' },
    { milestones: ['passed', 'failed'].map(outcome => ({ name: 'authorization', outcome, observedAt: new Date().toISOString() })) },
  ]) {
    await f.setConfig(patch);
    await assert.rejects(planHandover(f.options));
  }
  await assert.rejects(planHandover({ project: f.project }), { code: 'MCP_HANDOVER_WORKSPACE' });
  await f.setConfig();
  await assert.rejects(planHandover({ ...f.options, output: path.join(f.project, 'handover') }), { code: 'MCP_HANDOVER_OUTPUT' });
  await assert.rejects(writeHandover({ ...f.options, approval: 'wrong' }), { code: 'MCP_HANDOVER_APPROVAL' });
});
test('all dynamic HTML is text, commands contain no source IDs and approval binds changed inputs', async t => {
  const f = await setup(t), note = '</script><script>alert("x")</script><img src=x onerror="boom">';
  await f.setConfig({ operationsNote: note });
  const plan = await planHandover(f.options);
  assert.ok(plan.manifest.steps.filter(s => s.command).every(s => !s.command.includes(f.input.azure.subscriptionId)));
  await writeHandover({ ...f.options, approval: plan.approvalToken });
  const html = await readFile(path.join(f.output, 'index.html'), 'utf8');
  assert.ok(html.includes('&lt;/script&gt;&lt;script&gt;'));
  assert.ok(!html.includes(note));
  assert.equal((html.match(/<script>/g) ?? []).length, 2);
  const next = { ...f.options, output: path.join(f.root, 'next') };
  const before = await planHandover(next);
  await f.setConfig({ costNote: 'Changed cost review.' });
  await assert.rejects(writeHandover({ ...next, approval: before.approvalToken }), { code: 'MCP_HANDOVER_APPROVAL' });
  await writeFile(path.join(f.project, 'server.js'), 'changed source');
  await assert.rejects(planHandover(next), /source changed/);
});
test('tampered releases are rejected, including archive bytes and destination parameters', async t => {
  const f = await setup(t);
  const dir = await release(f);
  await f.setConfig({ releaseDirectory: 'release' });
  const params = path.join(dir, 'infra', 'container-app.parameters.json'), original = await readFile(params);
  const bad = JSON.parse(original);
  bad.parameters.containerImage.value = `other.azurecr.io/mcp@sha256:${'b'.repeat(64)}`;
  await writeFile(params, savedJson(bad));
  await assert.rejects(planHandover(f.options), { code: 'MCP_HANDOVER_RELEASE' });
  await writeFile(params, original);
  await writeFile(path.join(dir, 'source.zip'), 'not source archive');
  await assert.rejects(planHandover(f.options), { code: 'MCP_HANDOVER_RELEASE' });
});
test('reference proofs remain scoped historical results and export no replay authority or raw records', async t => {
  const f = await setup(t), dir = await reference(f);
  const project = await withCliWorkspace(f.root, () => readMcpServerProject(dir));
  const attemptId = '77777777-7777-4777-8777-777777777777';
  const folder = path.join(dir, '.mcp-observations', attemptId);
  await mkdir(folder, { recursive: true });
  const startedAt = new Date().toISOString(), operationDigest = `sha256:${'a'.repeat(64)}`;
  const intent = { schemaVersion: 1, action: 'standalone-mcp-project-proof', status: 'started', startedAt,
    approvalDigest: `sha256:${'b'.repeat(64)}`, reviewDigest: project.review.reviewDigest, operationDigest,
    executionVersion: 2, previousHistoryDigest: `sha256:${'c'.repeat(64)}` };
  const dispatch = { schemaVersion: 1, kind: 'standalone-mcp-proof-dispatch', intentDigest: digest(intent),
    operationDigest, preparedAt: startedAt };
  const assertion = { kind: 'json-array-string-field-v1', field: 'fact', maxItems: 1, maxStringLength: 100 };
  const proof = { schemaVersion: 1, kind: 'standalone-mcp-read-only-proof', approvalDigest: operationDigest,
    sourceDigest: project.review.descriptor.descriptorDigest, captureDigest: `sha256:${'d'.repeat(64)}`,
    toolName: f.input.operationIds[0], argumentsDigest: digest({}), status: 'protocol-success',
    completedAt: startedAt, resultAssertion: assertion,
    backendAssertion: assessResultAssertion({ content: [{ type: 'text', text: '[{"fact":"Synthetic result not retained"}]' }] }, assertion),
    businessCorrectnessVerified: false, coworkRuntimeVerified: false };
  await writeFile(path.join(folder, 'intent.json'), savedJson(intent));
  await writeFile(path.join(folder, 'dispatch.json'), savedJson({ ...dispatch, receiptDigest: digest(dispatch) }));
  await writeFile(path.join(folder, 'proof.json'), savedJson({ ...proof, receiptDigest: digest(proof) }));
  await f.setConfig({ referenceProject: 'reference' });
  const plan = await planHandover(f.options);
  const evidence = plan.manifest.evidence.find(e => e.kind.startsWith('tools/call'));
  assert.equal(evidence.status, 'verified-historical');
  assert.match(evidence.meaning, /Scoped backend assertion: passed/);
  assert.equal(plan.manifest.milestones.find(m => m.name === 'consumer-call').status, 'pending');
  assert.doesNotMatch(JSON.stringify(plan.manifest), /Synthetic result not retained|previousHistoryDigest|approvalDigest/);
  for (const change of [
    p => { p.sourceDigest = `sha256:${'e'.repeat(64)}`; },
    p => { p.backendAssertion.content = 'untrusted extra result'; },
    p => { p.backendAssertion.rawResultRetained = true; },
    p => { p.status = 'tool-error'; },
  ]) {
    const changed = structuredClone(proof);
    change(changed);
    await writeFile(path.join(folder, 'proof.json'), savedJson({ ...changed, receiptDigest: digest(changed) }));
    await assert.rejects(planHandover(f.options), { code: 'METADATA_MISMATCH' });
  }
});
test('foreign endpoint references, paths and junctions do not enter a handover', async t => {
  const f = await setup(t), dir = await reference(f);
  await f.setConfig({ referenceProject: 'reference' });
  const original = JSON.parse(await readFile(path.join(dir, 'recipe-origin.json')));
  original.sourceManifestDigest = `sha256:${'a'.repeat(64)}`;
  await writeFile(path.join(dir, 'recipe-origin.json'), savedJson(original));
  await assert.rejects(planHandover(f.options), { code: 'MCP_HANDOVER_REFERENCE' });
  await f.setConfig({ releaseDirectory: '../outside' });
  await assert.rejects(planHandover(f.options), /inside --workspace-root/);
  const alias = path.join(f.root, 'linked');
  await symlink(f.project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await f.setConfig();
  await assert.rejects(planHandover({ ...f.options, project: alias }), /symbolic|junction/i);
});
test('stale discovery stays stale and unresolved dispatch cannot turn into success or replay permission', async t => {
  const f = await setup(t), dir = await reference(f);
  const project = await withCliWorkspace(f.root, () => readMcpServerProject(dir));
  const source = project.review.descriptor, capturedAt = new Date(Date.now() - 48 * 3600000).toISOString();
  const selection = { discoveryClientId: f.input.authentication.allowedClientIds[0],
    expectedUserId: '99999999-9999-4999-8999-999999999999' };
  const approval = planMcpDiscovery(source, selection);
  const capture = await discoverMcpToolsForTest(source, { ...selection, approval, allowNetwork: true }, {
    entraSession: { run: async () => ({ capturedAt, protocolVersion: '2025-03-26', tools: { tools: [{
      name: f.input.operationIds[0], description: 'Synthetic tool metadata.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
    }] } }) },
  });
  const folder = path.join(dir, '.mcp-observations', '77777777-7777-4777-8777-777777777777');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'capture.json'), savedJson(capture));
  await writeFile(path.join(folder, 'intent.json'), savedJson({ schemaVersion: 1,
    action: 'standalone-mcp-project-discovery', status: 'started', startedAt: capturedAt,
    approvalDigest: approval.approvalDigest, reviewDigest: project.review.reviewDigest }));
  const unknown = path.join(dir, '.mcp-observations', '88888888-8888-4888-8888-888888888888');
  await mkdir(unknown);
  await writeFile(path.join(unknown, 'intent.json'), savedJson({ schemaVersion: 1, action: 'standalone-mcp-project-proof',
    status: 'started', startedAt: new Date().toISOString(), approvalDigest: `sha256:${'a'.repeat(64)}`,
    operationDigest: `sha256:${'b'.repeat(64)}`, reviewDigest: project.review.reviewDigest }));
  await f.setConfig({ referenceProject: 'reference' });
  const plan = await planHandover(f.options);
  assert.equal(plan.manifest.evidence.find(e => e.kind === 'tools/list').status, 'stale-historical');
  assert.equal(plan.manifest.evidence.find(e => e.kind === 'tools/call').status, 'unresolved');
  assert.equal(plan.manifest.proofReplayAuthorized, false);
  assert.equal(plan.manifest.executionReadiness, false);
  assert.equal(await readFile(path.join(folder, 'capture.json'), 'utf8'), savedJson(capture));
});
test('incomplete or wrong-recipe template inventories are rejected even with recomputed unkeyed manifests', async t => {
  const f = await setup(t);
  const file = path.join(f.project, 'recipe-manifest.json');
  const original = JSON.parse(await readFile(file));
  for (const name of ['README.md', 'infra/container-app.json']) {
    const { contentDigest, ...body } = structuredClone(original);
    delete body.files[name];
    await writeFile(file, savedJson({ ...body, contentDigest: digest(body) }));
    await assert.rejects(planHandover(f.options), { code: 'MCP_HANDOVER_SOURCE' });
  }
});
test('input changes during a write leave an incomplete folder without a success manifest', async t => {
  const f = await setup(t), plan = await planHandover(f.options);
  let mutate;
  const changed = new Promise((resolve, reject) => {
    const watcher = watch(f.root, (event, name) => {
      if (String(name) !== path.basename(f.output)) return;
      watcher.close();
      mutate = f.setConfig({ operationsNote: 'Changed after output reservation.' });
      mutate.then(resolve, reject);
    });
    t.after(() => watcher.close());
  });
  await assert.rejects(writeHandover({ ...f.options, approval: plan.approvalToken }), { code: 'MCP_HANDOVER_INPUT_CHANGED' });
  await changed;
  assert.ok((await readdir(f.output)).includes('index.html'));
  assert.ok(!(await readdir(f.output)).includes('handover-manifest.json'));
});
test('concurrent writes publish at most one complete handover and never overwrite', async t => {
  const f = await setup(t), plan = await planHandover(f.options);
  const results = await Promise.allSettled([1, 2].map(() => writeHandover({ ...f.options, approval: plan.approvalToken })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(JSON.parse(await readFile(path.join(f.output, 'handover-manifest.json'))).contentDigest);
});
test('handover CLI schema, plan summaries and flags stay local and JSON parseable', async t => {
  const f = await setup(t);
  const run = args => spawnSync(process.execPath, [path.join(TOOLKIT_ROOT, 'bin', 'copilot-mcp.js'), ...args, '--json'],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1048576 });
  const schema = run(['mcp-handover-schema']);
  assert.equal(schema.status, 0, schema.stderr);
  assert.equal(JSON.parse(schema.stdout).properties.privateExportReviewed.const, true);
  for (const flag of ['--allow-cloud', '--allow-network', '--allow-provider', '--progress']) {
    assert.notEqual(run(['mcp-handover-schema', flag]).status, 0);
  }
  const args = ['--workspace-root', f.root, '--project', f.project, '--config', f.config, '--output', f.output];
  const plan = run(['mcp-handover-plan', ...args, '--summary']);
  assert.equal(plan.status, 0, plan.stderr);
  const token = JSON.parse(plan.stdout).approvalToken;
  assert.ok(plan.stderr.includes(token));
  assert.notEqual(run(['mcp-handover-bundle', ...args, '--approve', 'wrong']).status, 0);
  const result = run(['mcp-handover-bundle', ...args, '--approve', token]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'handover-written-not-executed');
});
