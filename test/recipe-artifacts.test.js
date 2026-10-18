import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { TOOLKIT_ROOT, withCliWorkspace } from '../src/config.js';
import { planContainerApps, writeContainerApps } from '../src/mcp-container-apps.js';
import { planRecipeRelease, writeRecipeRelease, planRecipeReference, writeRecipeReference,
  recipeSourcePlan, readRecipeProject } from '../src/mcp-recipe-artifacts.js';
import { planMcpProjectDiscovery } from '../src/mcp-discovery-project.js';

async function setup(t) {
  const parent = path.join(TOOLKIT_ROOT, '.test-output'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'recipe-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = JSON.parse(await readFile(new URL('../examples/mcp/container-apps-direct.json', import.meta.url)));
  const config = path.join(root, 'input.json'); await writeFile(config, JSON.stringify(input));
  const generation = { workspaceRoot: root, config, output: path.join(root, 'server') };
  const plan = await planContainerApps(generation);
  await writeContainerApps({ ...generation, approval: plan.approvalToken });
  return { root, input, project: generation.output, workspaceRoot: root };
}
test('release preparation seals source and image, writes a reproducible source-only archive, and never executes', async t => {
  const base = await setup(t), config = path.join(base.root, 'release.json');
  const image = `${base.input.azure.registry.server}/mcp@sha256:${'a'.repeat(64)}`;
  await writeFile(config, JSON.stringify({ schemaVersion: 1, accountName: 'operator@example.com', containerImage: image }));
  const options = { ...base, config, output: path.join(base.root, 'release') };
  const plan = await planRecipeRelease(options);
  assert.equal(plan.review.execution, 'operator-reviewed-not-executed');
  assert.equal(plan.review.artifact.imageSourceCorrespondence, 'operator-asserted-not-verified');
  assert.equal(plan.sourceArchiveSha256, (await recipeSourcePlan(base)).sourceArchiveSha256);
  await assert.rejects(writeRecipeRelease({ ...options, approval: 'wrong' }));
  const result = await writeRecipeRelease({ ...options, approval: plan.approvalToken });
  assert.equal(result.status, 'release-prepared-not-deployed');
  const archive = unzipSync(await readFile(path.join(options.output, 'source.zip')));
  assert.ok(archive['runtime.js']); assert.ok(archive['LICENSE']); assert.ok(archive['THIRD-PARTY-NOTICES.md']);
  assert.ok(!Object.keys(archive).some(name => /node_modules|infra\/|recipe-/.test(name)));
  await assert.rejects(writeRecipeRelease({ ...options, approval: plan.approvalToken }));
  await writeFile(config, JSON.stringify({ schemaVersion: 1, accountName: 'operator@example.com', containerImage: 'other.azurecr.io/mcp:latest' }));
  await assert.rejects(planRecipeRelease({ ...options, output: path.join(base.root, 'other') }), /digest-pinned/);
});
test('edited runtime or target cannot silently enter a release', async t => {
  const base = await setup(t);
  await writeFile(path.join(base.project, 'server.js'), 'edited');
  await assert.rejects(withCliWorkspace(base.workspaceRoot, () => readRecipeProject(base.project)), /source changed/);
});
test('explicit unverified endpoint reference reuses existing discovery without manufactured tools or readiness', async t => {
  const base = await setup(t), config = path.join(base.root, 'reference.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, serverId: '66666666-6666-4666-8666-666666666666',
    endpoint: 'https://new-mcp.example.com/mcp' }));
  const options = { ...base, config, output: path.join(base.root, 'reference') };
  const plan = await planRecipeReference(options);
  assert.equal(plan.review.descriptor.status, 'referenced-not-verified');
  assert.equal(plan.origin.proofReplayAuthorized, false);
  assert.equal(plan.review.files['tools.json'], undefined);
  await assert.rejects(writeRecipeReference({ ...options, approval: 'wrong' }));
  await writeRecipeReference({ ...options, approval: plan.approvalToken });
  const discovery = await withCliWorkspace(base.workspaceRoot, () => planMcpProjectDiscovery(options.output, {
    discoveryClientId: base.input.authentication.allowedClientIds[0],
    expectedUserId: '77777777-7777-4777-8777-777777777777',
  }));
  assert.deepEqual(discovery.operation.methods, ['initialize', 'notifications/initialized', 'tools/list']);
  assert.equal(discovery.operation.source.endpoint, 'https://new-mcp.example.com/mcp');
  assert.equal(discovery.operation.source.inbound.applicationIdUri, base.input.authentication.applicationIdUri);
});
