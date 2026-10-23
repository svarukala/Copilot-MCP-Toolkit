import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { TOOLKIT_ROOT } from '../src/config.js';
import { savedJson } from '../src/anonymous-metadata.js';
import { planHostingRecipe, writeHostingRecipe } from '../src/mcp-container-apps.js';
import { recipeSourcePlan, planRecipeRelease, writeRecipeRelease,
  planRecipeReference, writeRecipeReference } from '../src/mcp-recipe-artifacts.js';
import { planAuthRegistrationBundle, writeAuthRegistrationBundle } from '../src/mcp-auth-registration.js';
import { planOperatorRecord, writeOperatorRecord } from '../src/mcp-operator.js';
import { planHandover, writeHandover } from '../src/mcp-handover.js';

const recipes = ['container-apps-direct', 'container-apps-apim', 'app-service-container', 'functions-sdk'];
for (const recipe of recipes) test(`${recipe}: paused source/release/reference/auth journey survives a fresh CLI without live effects`, async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network'); });
  const parent = path.join(TOOLKIT_ROOT, '.test-output');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'hosting-journey-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const json = async (name, value) => {
    const file = path.join(root, name);
    await writeFile(file, savedJson(value));
    return file;
  };
  const input = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples', 'mcp', `${recipe}.json`)));
  const project = path.join(root, 'source');
  const sourceOptions = { workspaceRoot: root, output: project, config: await json('source.json', input) };
  const sourcePlan = await planHostingRecipe(sourceOptions);
  await writeHostingRecipe({ ...sourceOptions, approval: sourcePlan.approvalToken });
  const source = await recipeSourcePlan({ workspaceRoot: root, project });
  const releaseOptions = { workspaceRoot: root, project, output: path.join(root, 'release'),
    config: await json('release.json', { schemaVersion: 1, accountName: 'operator@example.com',
      ...(recipe === 'functions-sdk' ? { sourceArchiveSha256: source.sourceArchiveSha256 }
        : { containerImage: `${input.azure.registry.server}/mcp@sha256:${'a'.repeat(64)}` }),
      ...(input.azure.gateway ? { backendOrigin: `https://${input.azure.appName}.synthetic.eastus.azurecontainerapps.io` } : {}),
    }) };
  const releasePlan = await planRecipeRelease(releaseOptions);
  await writeRecipeRelease({ ...releaseOptions, approval: releasePlan.approvalToken });
  const runtime = JSON.parse(await readFile(path.join(project, 'runtime-config.json')));
  const referenceOptions = { workspaceRoot: root, project, output: path.join(root, 'reference'),
    config: await json('reference.json', { schemaVersion: 1,
      serverId: '66666666-6666-4666-8666-666666666666',
      endpoint: runtime.gateway?.publicUrl ?? 'https://synthetic.example.com/mcp' }) };
  const referencePlan = await planRecipeReference(referenceOptions);
  await writeRecipeReference({ ...referenceOptions, approval: referencePlan.approvalToken });
  const authOptions = { workspaceRoot: root, output: path.join(root, 'auth-preparation.json'),
    config: await json('auth-input.json', { schemaVersion: 1,
      source: { descriptorFile: 'reference/mcp-server.json' },
      operator: { tenantId: input.authentication.tenantId, accountName: 'operator@example.com' },
      registration: { type: 'entra-sso', name: 'Synthetic journey SSO',
        targetAudience: 'HomeTenant', applicableToApps: 'SpecificApp' },
      review: { metadataApprovedForExport: true } }) };
  const authPlan = await planAuthRegistrationBundle(authOptions);
  await writeAuthRegistrationBundle({ ...authOptions, approval: authPlan.approvalToken });
  const record = async event => {
    const options = { workspaceRoot: root, project, config: await json('operator.json', event) };
    const plan = await planOperatorRecord(options);
    return writeOperatorRecord({ ...options, approval: plan.approvalToken });
  };
  const wait = await record({ schemaVersion: 1, action: 'wait', phase: 'Registration',
    reason: 'owner-unavailable', resumeWhen: 'Owner chooses registration review' });
  const preload = path.join(root, 'deny.cjs');
  await writeFile(preload, `
const {syncBuiltinESMExports}=require('node:module');
const denied=()=>{throw Error('Unexpected live effect')};
globalThis.fetch=denied;
for(const [name,methods] of [['node:http',['request','get']],['node:https',['request','get']],
 ['node:net',['connect','createConnection']],['node:tls',['connect']],
 ['node:child_process',['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']]])
 for(const method of methods)require(name)[method]=denied;
syncBuiltinESMExports();
`);
  const fresh = (command, target, expectedStatus = 0) => {
    const result = spawnSync(process.execPath, ['--require', preload, path.join(TOOLKIT_ROOT, 'bin', 'copilot-mcp.js'),
      command, '--workspace-root', root, '--project', target, '--json'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, expectedStatus, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const status = fresh('mcp-operator-status', project);
  assert.equal(status.waiting.waitDigest, wait.contentDigest);
  assert.equal(status.waiting.repeatPrompt, false);
  assert.equal(fresh('mcp-recipe-source-plan', project).sourceManifestDigest, source.sourceManifestDigest);
  assert.equal(fresh('mcp-status', referenceOptions.output).deployment, 'not-managed');
  assert.equal(fresh('mcp-resume', referenceOptions.output, 2).status, 'input-required');
  const snapshotAt = new Date().toISOString();
  const handoverOptions = { workspaceRoot: root, project, output: path.join(root, 'paused-handover'),
    config: await json('handover.json', { schemaVersion: 1, snapshotAt, privateExportReviewed: true,
      releaseDirectory: 'release', referenceProject: 'reference',
      milestones: [{ name: 'auth-registration', outcome: 'deferred', observedAt: snapshotAt }] }) };
  const handover = await planHandover(handoverOptions);
  assert.equal(handover.manifest.sourceManifestDigest, source.sourceManifestDigest);
  assert.equal(handover.manifest.waiting.waitDigest, wait.contentDigest);
  assert.equal(handover.manifest.milestones.find(m => m.name === 'auth-registration').status, 'deferred');
  assert.equal(handover.manifest.milestones.find(m => m.name === 'consumer-call').status, 'pending');
  assert.equal(handover.manifest.executionReadiness, false);
  assert.equal(handover.manifest.proofReplayAuthorized, false);
  await writeHandover({ ...handoverOptions, approval: handover.approvalToken });
  await record({ schemaVersion: 1, action: 'resume', waitDigest: wait.contentDigest,
    ownerInputDigest: `sha256:${'b'.repeat(64)}` });
  assert.equal(fresh('mcp-operator-status', project).waiting, null);
  const retained = JSON.parse(await readFile(path.join(handoverOptions.output, 'handover-manifest.json')));
  assert.equal(retained.waiting.waitDigest, wait.contentDigest);
  assert.deepEqual(fresh('mcp-status', referenceOptions.output).proofs, []);
  assert.equal(fresh('mcp-recipe-source-plan', project).sourceManifestDigest, source.sourceManifestDigest);
});
