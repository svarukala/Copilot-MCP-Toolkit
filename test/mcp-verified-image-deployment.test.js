import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { TOOLKIT_ROOT, withCliWorkspace } from '../src/config.js';
import { boundedSnapshot, metadataDigest } from '../src/anonymous-metadata.js';
import { planHostingRecipe, writeHostingRecipe } from '../src/mcp-container-apps.js';
import { readRecipeProject, planRecipeRelease, sealRecipeFiles } from '../src/mcp-recipe-artifacts.js';
import { planHostExecution, runHostExecution } from '../src/mcp-execution-host.js';
import { planVerifiedImageDeployment, runVerifiedImageDeployment, verifiedImageDeploymentSchema } from '../src/mcp-verified-image-deployment.js';
import { getVerifiedImageDeploymentSchema, planVerifiedImageDeployment as publicPlan } from '../src/core.js';
import { createSyntheticExecutionHost, syntheticExecutionImage } from './support/execution-host.js';
import { main } from '../bin/copilot-mcp.js';

const flags = { allowLocal: true, allowCloud: true, allowNetwork: true };
const digest = value => metadataDigest(boundedSnapshot(value));
const seal = value => { const { contentDigest, ...body } = value; return { ...body, contentDigest: digest(body) }; };
const json = async filename => JSON.parse(await readFile(filename));
async function snapshot(dir) {
  return Object.fromEntries(await Promise.all((await readdir(dir)).sort().map(async name =>
    [name, (await readFile(path.join(dir, name))).toString('base64')])));
}
async function fixture(t, { oci = true } = {}) {
  const root = path.join(TOOLKIT_ROOT, '.test-output', `verified-image-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const definition = await json(new URL('../examples/mcp/container-apps-direct.json', import.meta.url));
  definition.imageBuild = { builderImage: `node:22-bookworm-slim@sha256:${'d'.repeat(64)}`,
    runtimeImage: `gcr.io/distroless/nodejs22-debian13:nonroot@sha256:${'e'.repeat(64)}`, platform: 'linux/amd64' };
  const input = path.join(root, 'source.json'), project = path.join(root, 'source');
  await writeFile(input, JSON.stringify(definition));
  const generation = { workspaceRoot: root, config: input, output: project };
  await writeHostingRecipe({ ...generation, approval: (await planHostingRecipe(generation)).approvalToken });
  const host = { schemaVersion: 1, azureIdentityProject: path.join(root, 'identity'),
    accountName: 'operator@example.com', dockerSocket: String.raw`\\.\pipe\docker_engine`,
    localEngineTrusted: true, scannerImage: `aquasec/trivy@sha256:${'c'.repeat(64)}`, imageRepository: 'reviewed/mcp',
    expiresAt: new Date(Date.now() + 3600000).toISOString(), downloadsReviewed: true,
    resourceCeilingsReviewed: true, createOnlyReviewed: true };
  const old = { workspaceRoot: root, project, config: path.join(root, 'host.json'), output: path.join(root, 'old') };
  await writeFile(old.config, JSON.stringify(host));
  const synthetic = await createSyntheticExecutionHost({ workspaceRoot: root, project, host, oci });
  const plan = await planHostExecution(old);
  const outcome = await runHostExecution({ ...old, ...flags, approval: plan.approvalToken }, {
    ...synthetic.dependencies,
    dockerRequest: async (...args) => {
      const response = await synthetic.dependencies.dockerRequest(...args);
      if (args[1].includes('/push?')) throw Object.assign(new Error('synthetic unknown push'), { code: 'DOCKER_DISPATCH_UNKNOWN' });
      return response;
    },
  });
  assert.equal(outcome.status, 'unknown-no-replay');
  assert.equal(outcome.stage, 'push');
  assert.equal(synthetic.resources.has(synthetic.app), false);
  const source = await withCliWorkspace(root, () => readRecipeProject(project));
  const config = { schemaVersion: 1, oldHostOutput: old.output, oldHostApproval: plan.approvalToken,
    sourceManifestDigest: source.manifest.contentDigest,
    containerImage: `${definition.azure.registry.server}/reviewed/mcp@${syntheticExecutionImage({ oci }).imageId}`,
    azureIdentityProject: host.azureIdentityProject, accountName: host.accountName,
    expiresAt: new Date(Date.now() + 1800000).toISOString(), deploymentOnlyReviewed: true,
    resourceCeilingsReviewed: true, createOnlyReviewed: true };
  const options = { workspaceRoot: root, project, config: path.join(root, 'deploy.json'), output: path.join(root, 'deploy') };
  const save = () => writeFile(options.config, JSON.stringify(config));
  await save();
  const run = synthetic.dependencies.runAzure;
  const dependencies = { ...synthetic.dependencies,
    dockerRequest: () => assert.fail('Deployment-only must never access Docker'),
    runAzure: async (name, args, execution) => {
      if (args[0] === 'acr' && args[1] === 'manifest') {
        synthetic.calls.push({ system: 'azure', args, execution });
        assert.equal(args[2], 'show-metadata');
        assert.equal(args[args.indexOf('--name') + 1], config.containerImage.split('/').slice(1).join('/'));
        assert.equal(execution.allowInspectionRetry, false);
        assert.ok(execution.azureConfigDir.startsWith(path.join(host.azureIdentityProject, '.azure-auth') + path.sep));
        return { digest: config.containerImage.split('@')[1] };
      }
      return run(name, args, execution);
    },
  };
  synthetic.calls.length = 0;
  return { root, old, oldPlan: plan, config, options, save, ...synthetic, dependencies };
}
async function execute(f) {
  const plan = await planVerifiedImageDeployment(f.options);
  return { plan, result: await runVerifiedImageDeployment({ ...f.options, ...flags, approval: plan.approvalToken }, f.dependencies) };
}
async function rechain(f, mutate = () => {}) {
  let previous = f.oldPlan.approvalToken;
  for (const stage of ['identity', 'preflight', 'build', 'scan', 'smoke', 'push']) {
    const intentFile = path.join(f.old.output, `${stage}.intent.json`), resultFile = path.join(f.old.output, `${stage}.result.json`);
    const intent = await json(intentFile), result = await json(resultFile);
    intent.previous = previous;
    const nextIntent = seal(intent);
    result.intentDigest = nextIntent.contentDigest;
    mutate(stage, result);
    const nextResult = seal(result);
    await writeFile(intentFile, JSON.stringify(nextIntent)); await writeFile(resultFile, JSON.stringify(nextResult));
    previous = nextResult.contentDigest;
  }
}

test('deployment contract is closed and public schema copies cannot weaken it', async () => {
  const copy = await getVerifiedImageDeploymentSchema();
  copy.additionalProperties = true;
  assert.equal((await getVerifiedImageDeploymentSchema()).additionalProperties, false);
  const ajv = new Ajv(); addFormats(ajv);
  const validate = ajv.compile(verifiedImageDeploymentSchema);
  assert.equal(validate({}), false);
  assert.equal(Object.hasOwn(verifiedImageDeploymentSchema.properties, 'dockerSocket'), false);
  assert.equal(Object.hasOwn(verifiedImageDeploymentSchema.properties, 'skipStages'), false);
});

test('verified OCI image deploys through shared ACA engine without Docker, push, parent mutation or provider calls', async t => {
  const f = await fixture(t), parent = await snapshot(f.old.output);
  const reservations = await snapshot(path.join(f.root, '.mcp-execution-host-targets'));
  const sourceBefore = await readFile(path.join(f.options.project, 'recipe-manifest.json'));
  const planned = await publicPlan(f.options);
  assert.equal(f.calls.length, 0);
  assert.equal(planned.scope.kind, 'mcp-verified-image-deployment-plan');
  const { plan, result } = await execute(f);
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.containerImage, f.config.containerImage);
  assert.equal(result.providerVerified, false);
  assert.equal(result.authenticationVerified, false);
  assert.equal(f.calls.filter(call => call.system === 'health').length, 1);
  assert.equal(f.calls.filter(call => call.args?.includes('show-metadata')).length, 1);
  assert.equal(f.calls.filter(call => call.args?.includes('PUT')).length, 1);
  const appReceipt = await json(path.join(f.options.output, 'app.result.json'));
  assert.equal(appReceipt.value.registryVerification.containerImage, f.config.containerImage);
  assert.equal(appReceipt.value.registryVerification.retries, 0);
  assert.equal(f.calls.some(call => call.system === 'docker' || call.args?.includes('login')
    || call.args?.includes('--expose-token')), false);
  const dispatch = f.calls.findIndex(call => call.args?.includes('PUT'));
  assert.ok(f.calls.slice(0, dispatch).some(call => call.args?.includes('show-metadata')));
  assert.deepEqual(await snapshot(f.old.output), parent);
  const after = await snapshot(path.join(f.root, '.mcp-execution-host-targets'));
  for (const [name, bytes] of Object.entries(reservations)) assert.equal(after[name], bytes);
  assert.equal(Object.keys(after).length, Object.keys(reservations).length + 1);
  assert.deepEqual(await readFile(path.join(f.options.project, 'recipe-manifest.json')), sourceBefore);
  const count = f.calls.length;
  assert.deepEqual(await runVerifiedImageDeployment({ ...f.options, ...flags, approval: plan.approvalToken }, f.dependencies), result);
  assert.equal(f.calls.length, count, 'Passed results are retained evidence, not repeated health or cloud calls');
  const releaseConfig = path.join(f.root, 'release.json');
  await writeFile(releaseConfig, JSON.stringify({ schemaVersion: 1, accountName: f.config.accountName,
    containerImage: result.containerImage, imageReviewFile: result.imageReviewFile }));
  const release = await planRecipeRelease({ workspaceRoot: f.root, project: f.options.project,
    config: releaseConfig, output: path.join(f.root, 'release') });
  assert.equal(release.review.imageQualification.status, 'passed-operator-evidence-review-not-attestation');
});

async function historicalSource(f, edit) {
  const source = await withCliWorkspace(f.root, () => readRecipeProject(f.options.project));
  edit(source.files);
  sealRecipeFiles(source.files, source.input.recipe);
  for (const [name, bytes] of Object.entries(source.files)) await writeFile(path.join(f.options.project, ...name.split('/')), bytes);
  const manifest = JSON.parse(source.files['recipe-manifest.json']);
  f.config.sourceManifestDigest = manifest.contentDigest;
  f.oldPlan.scope.sourceManifestDigest = manifest.contentDigest;
  f.oldPlan.scope.producerBuild = `sha256:${'a'.repeat(64)}`;
  f.oldPlan.approvalToken = `mcp-host-execution/${digest(f.oldPlan.scope)}`;
  f.config.oldHostApproval = f.oldPlan.approvalToken;
  await writeFile(path.join(f.old.output, 'plan.json'), JSON.stringify(f.oldPlan));
  for (const name of (await readdir(f.old.output)).filter(name => /\.(intent|result)\.json$/.test(name))) {
    const filename = path.join(f.old.output, name), record = await json(filename);
    await writeFile(filename, JSON.stringify(seal({ ...record, plan: f.oldPlan.approvalToken })));
  }
  await rechain(f);
  const dir = path.join(f.root, '.mcp-execution-host-targets'), reservationName = (await readdir(dir))[0];
  const reservation = await json(path.join(dir, reservationName));
  await writeFile(path.join(dir, reservationName), JSON.stringify({ ...reservation, plan: f.oldPlan.approvalToken }));
  await f.save();
}

test('historical sealed review/build metadata needs no regeneration while current compiler rejects changed template/runtime', async t => {
  const f = await fixture(t);
  await historicalSource(f, files => {
    const review = JSON.parse(files['recipe-review.json']);
    review.historicalNote = 'Synthetic earlier toolkit review metadata';
    files['recipe-review.json'] = Buffer.from(JSON.stringify(review));
  });
  const before = await readFile(path.join(f.options.project, 'recipe-manifest.json'));
  const plan = await planVerifiedImageDeployment(f.options);
  assert.notEqual(plan.scope.evidence.parentProducerBuild, plan.scope.producerBuild);
  assert.deepEqual(await readFile(path.join(f.options.project, 'recipe-manifest.json')), before);
  const result = await runVerifiedImageDeployment({ ...f.options, ...flags, approval: plan.approvalToken }, f.dependencies);
  assert.equal(result.status, 'passed');
  for (const target of ['infra/container-app.json', 'runtime-config.json']) {
    const other = await fixture(t);
    await historicalSource(other, files => {
      const value = JSON.parse(files[target]);
      if (target.startsWith('infra/')) value.resources[0].name = 'unapproved-app';
      else value.unapproved = true;
      files[target] = Buffer.from(JSON.stringify(value));
    });
    await assert.rejects(planVerifiedImageDeployment(other.options), { code: 'VERIFIED_IMAGE_TEMPLATE_MISMATCH' });
    assert.equal(other.calls.length, 0);
  }
});

test('full retained scope tampering and wrong private identity project are rejected before dispatch', async t => {
  const f = await fixture(t), plan = await planVerifiedImageDeployment(f.options);
  await mkdir(f.options.output);
  const changed = structuredClone(plan);
  changed.scope.targets.app += '-wrong';
  changed.scope.deployment.runtime.unapproved = true;
  changed.approvalToken = `mcp-verified-image-deployment/${digest(changed.scope)}`;
  await writeFile(path.join(f.options.output, 'plan.json'), JSON.stringify(changed));
  await assert.rejects(runVerifiedImageDeployment({ ...f.options, ...flags, approval: changed.approvalToken }, f.dependencies),
    { code: 'VERIFIED_IMAGE_PLAN_CHANGED' });
  assert.equal(f.calls.length, 0);
  await rm(f.options.output, { recursive: true });
  f.config.azureIdentityProject = f.options.project; await f.save();
  await assert.rejects(planVerifiedImageDeployment(f.options));
  assert.equal(f.calls.length, 0);
});

test('private live account mismatch and scan expiry during registry verification prevent PUT', async t => {
  for (const fault of ['account', 'expiry']) {
    const f = await fixture(t), run = f.dependencies.runAzure;
    f.dependencies.runAzure = async (...args) => {
      const result = await run(...args);
      if (fault === 'account' && args[1][0] === 'account') result.tenantId = '00000000-0000-4000-8000-000000000000';
      if (fault === 'expiry' && args[1].includes('show-metadata')) {
        t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
        t.mock.timers.tick(25 * 3600000);
      }
      return result;
    };
    const { result } = await execute(f);
    t.mock.timers.reset();
    assert.equal(result.status, 'unknown-no-replay');
    assert.equal(f.calls.filter(call => call.args?.includes('PUT')).length, 0);
  }
});

test('CLI schema/plan JSON and stderr approval summary are separate; unknown run returns nonzero without provider access', async t => {
  const f = await fixture(t), stdout = [], stderr = [];
  t.mock.method(process.stdout, 'write', bytes => { stdout.push(String(bytes)); return true; });
  t.mock.method(process.stderr, 'write', bytes => { stderr.push(String(bytes)); return true; });
  assert.equal(await main(['mcp-verified-image-schema', '--json']), 0);
  assert.equal(JSON.parse(stdout.join('')).additionalProperties, false);
  stdout.length = 0;
  const selected = ['--workspace-root', f.root, '--project', f.options.project,
    '--config', f.options.config, '--output', f.options.output, '--json'];
  assert.equal(await main(['mcp-verified-image-plan', ...selected, '--summary']), 0);
  const plan = JSON.parse(stdout.join(''));
  assert.equal(plan.scope.target.appName, f.source.azure.appName);
  assert.equal(plan.scope.deployment.template.resources[0].name, f.source.azure.appName);
  assert.match(stderr.join(''), /EXACT approvalToken/);
  assert.ok(stderr.join('').includes(plan.approvalToken));
  stdout.length = 0; stderr.length = 0;
  assert.equal(await main(['mcp-verified-image-run', ...selected, '--approve', plan.approvalToken,
    '--allow-local', '--allow-network', '--allow-cloud'], {
    runAzure: async (name, args, options) => {
      if (args.includes('show-metadata')) throw new Error('synthetic uncertain registry lookup');
      return f.dependencies.runAzure(name, args, options);
    },
  }), 2);
  assert.equal(JSON.parse(stdout.join('')).status, 'unknown-no-replay');
  assert.equal(f.calls.filter(call => call.args?.includes('PUT')).length, 0);
  assert.equal(f.calls.filter(call => call.system === 'health').length, 0);
});

for (const [name, mutate] of [
  ['wrong image', f => { f.config.containerImage = f.config.containerImage.replace(/sha256:.*$/, `sha256:${'a'.repeat(64)}`); }],
  ['wrong account', f => { f.config.accountName = 'other@example.com'; }],
  ['wrong source digest', f => { f.config.sourceManifestDigest = `sha256:${'a'.repeat(64)}`; }],
  ['wrong parent authority', f => { f.config.oldHostApproval = `mcp-host-execution/sha256:${'a'.repeat(64)}`; }],
  ['old output overlap', f => { f.options.output = path.join(f.old.output, 'nested'); }],
  ['case-aliased output overlap', f => {
    f.options.output = path.join(process.platform === 'win32' ? f.old.output.replace(/old$/, 'OLD') : f.old.output, 'nested');
  }],
]) test(`planning rejects ${name} without calls`, async t => {
  const f = await fixture(t); mutate(f); await f.save();
  await assert.rejects(planVerifiedImageDeployment(f.options));
  assert.equal(f.calls.length, 0);
});

for (const filename of ['scan.result.json', 'scanner.private.json', 'sbom.private.json', 'scanner-database.private.json']) {
  test(`missing or altered ${filename} cannot silently qualify`, async t => {
    const f = await fixture(t);
    const file = path.join(f.old.output, filename), original = await readFile(file);
    await writeFile(file, '{}');
    await assert.rejects(planVerifiedImageDeployment(f.options));
    await writeFile(file, original);
    await rm(file);
    await assert.rejects(planVerifiedImageDeployment(f.options));
    assert.equal(f.calls.length, 0);
  });
}

test('stale scan, nonzero HIGH, broken evidence chain and config-ID-only images fail closed', async t => {
  const f = await fixture(t), before = await snapshot(f.old.output);
  for (const change of [
    (stage, result) => { if (stage === 'scan') result.value.scannedAt = new Date(Date.now() - 25 * 3600000).toISOString(); },
    (stage, result) => { if (stage === 'scan') result.value.high = 1; },
    (stage, result) => { if (stage === 'smoke') result.value.nonroot = false; },
  ]) {
    await rechain(f, change);
    await assert.rejects(planVerifiedImageDeployment(f.options));
    for (const [name, bytes] of Object.entries(before)) await writeFile(path.join(f.old.output, name), Buffer.from(bytes, 'base64'));
  }
  const intentFile = path.join(f.old.output, 'scan.intent.json'), intent = await json(intentFile);
  await writeFile(intentFile, JSON.stringify(seal({ ...intent, previous: 'wrong-chain' })));
  await assert.rejects(planVerifiedImageDeployment(f.options));
  const classic = await fixture(t, { oci: false });
  await assert.rejects(planVerifiedImageDeployment(classic.options), { code: 'VERIFIED_IMAGE_DIGEST_MISMATCH' });
});

test('parent dispatch intent, active parent lock and foreign reservation are never adopted', async t => {
  const f = await fixture(t);
  for (const name of ['app.intent.json', 'app.request.json', '.mcp-execution-host.lock']) {
    await writeFile(path.join(f.old.output, name), '{}');
    await assert.rejects(planVerifiedImageDeployment(f.options));
    await rm(path.join(f.old.output, name));
  }
  const dir = path.join(f.root, '.mcp-execution-host-targets'), name = (await readdir(dir))[0];
  const reservation = await json(path.join(dir, name));
  await writeFile(path.join(dir, name), JSON.stringify({ ...reservation, plan: 'different-owner' }));
  await assert.rejects(planVerifiedImageDeployment(f.options), { code: 'VERIFIED_IMAGE_RESERVATION_MISMATCH' });
  assert.equal(f.calls.length, 0);
});

test('full approval/effect flags required; new output cannot duplicate a consumed target', async t => {
  const f = await fixture(t), plan = await planVerifiedImageDeployment(f.options);
  for (const missing of ['allowLocal', 'allowNetwork', 'allowCloud']) {
    await assert.rejects(runVerifiedImageDeployment({ ...f.options, ...flags, [missing]: false,
      approval: plan.approvalToken }, f.dependencies), { code: 'HOST_EXECUTION_APPROVAL_REQUIRED' });
  }
  await assert.rejects(runVerifiedImageDeployment({ ...f.options, ...flags, approval: f.oldPlan.approvalToken }, f.dependencies));
  assert.equal(f.calls.length, 0);
  await execute(f);
  f.options.output = path.join(f.root, 'other');
  const other = await planVerifiedImageDeployment(f.options), count = f.calls.length;
  await assert.rejects(runVerifiedImageDeployment({ ...f.options, ...flags, approval: other.approvalToken }, f.dependencies),
    { code: 'VERIFIED_IMAGE_CONSUMED' });
  assert.equal(f.calls.length, count);
});

for (const fault of ['existing-target', 'registry-mismatch', 'registry-unknown', 'put-unknown', 'late-target', 'late-evidence']) {
  test(`bounded ${fault} is consumed with no replay or sibling-output bypass`, async t => {
    const f = await fixture(t), run = f.dependencies.runAzure;
    if (fault === 'existing-target') f.resources.set(f.app, { id: f.app });
    let puts = 0, registry = 0;
    f.dependencies.runAzure = async (name, args, options) => {
      if (args.includes('PUT')) {
        puts++;
        if (fault === 'put-unknown') throw new Error('synthetic unknown dispatch');
      }
      if (args.includes('show-metadata')) {
        registry++;
        if (fault === 'registry-unknown') throw new Error('synthetic unknown read');
        if (fault === 'registry-mismatch') return { digest: `sha256:${'0'.repeat(64)}` };
        if (fault === 'late-target') f.resources.set(f.app, { id: f.app });
        if (fault === 'late-evidence') await writeFile(path.join(f.old.output, 'sbom.private.json'), '{}');
      }
      return run(name, args, options);
    };
    const { plan, result } = await execute(f);
    assert.equal(result.status, 'unknown-no-replay', JSON.stringify(result));
    assert.equal(puts, fault === 'put-unknown' ? 1 : 0);
    assert.equal(registry, fault === 'existing-target' ? 0 : 1);
    const count = f.calls.length;
    await assert.rejects(runVerifiedImageDeployment({ ...f.options, ...flags, approval: plan.approvalToken }, f.dependencies));
    f.options.output = path.join(f.root, 'bypass');
    await assert.rejects(execute(f));
    assert.equal(f.calls.length, count);
    assert.equal(puts, fault === 'put-unknown' ? 1 : 0);
  });
}
