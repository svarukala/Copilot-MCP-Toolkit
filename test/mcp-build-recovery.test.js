import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { TOOLKIT_ROOT, withCliWorkspace } from '../src/config.js';
import { digest } from '../src/mcp-validation.js';
import { planHostingRecipe, writeHostingRecipe } from '../src/mcp-container-apps.js';
import { readRecipeProject, sealRecipeFiles } from '../src/mcp-recipe-artifacts.js';
import { planHostExecution, runHostExecution } from '../src/mcp-execution-host.js';
import { assessBuildRecoveryEngine, inspectBuildRecovery, planBuildRecovery, runBuildRecovery } from '../src/mcp-build-recovery.js';
import { planRecoveredImage, runRecoveredImage } from '../src/mcp-recovered-image.js';
import { getBuildRecoverySchema, getRecoveredImageSchema, planBuildRecovery as publicPlan } from '../src/core.js';
import { createSyntheticExecutionHost } from './support/execution-host.js';
import { main } from '../bin/copilot-mcp.js';

const flags = { allowLocal: true, allowNetwork: true };
const json = async filename => JSON.parse(await readFile(filename, 'utf8'));
const save = (filename, value) => writeFile(filename, JSON.stringify(value));
const seal = value => { const { contentDigest, ...body } = value; return { ...body, contentDigest: digest(body) }; };
const response = (value, status = 200) => ({ status, body: Buffer.from(JSON.stringify(value)) });
async function snapshot(dir) {
  return Object.fromEntries(await Promise.all((await readdir(dir, { withFileTypes: true })).map(async entry =>
    [entry.name, entry.isDirectory() ? await snapshot(path.join(dir, entry.name))
      : (await readFile(path.join(dir, entry.name))).toString('base64')])));
}
async function fixture(t, example = 'container-apps-direct', { identityInSource = false } = {}) {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected external fetch'));
  const root = path.join(TOOLKIT_ROOT, '.test-output', `build-recovery-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const definition = await json(new URL(`../examples/mcp/${example}.json`, import.meta.url));
  definition.imageBuild = { builderImage: `node:22-bookworm-slim@sha256:${'d'.repeat(64)}`,
    runtimeImage: `gcr.io/distroless/nodejs22-debian13:nonroot@sha256:${'e'.repeat(64)}`, platform: 'linux/amd64' };
  const input = path.join(root, 'source.json'), project = path.join(root, 'source');
  await save(input, definition);
  const generation = { workspaceRoot: root, config: input, output: project };
  await writeHostingRecipe({ ...generation, approval: (await planHostingRecipe(generation)).approvalToken });
  const host = { schemaVersion: 1, azureIdentityProject: identityInSource ? project : path.join(root, 'identity'),
    accountName: 'operator@example.com', dockerSocket: String.raw`\\.\pipe\docker_engine`,
    localEngineTrusted: true, scannerImage: `aquasec/trivy@sha256:${'c'.repeat(64)}`, imageRepository: 'reviewed/mcp',
    expiresAt: new Date(Date.now() + 3600000).toISOString(), downloadsReviewed: true,
    resourceCeilingsReviewed: true, createOnlyReviewed: true };
  const old = { workspaceRoot: root, project, config: path.join(root, 'host.json'), output: path.join(root, 'old') };
  await save(old.config, host);
  const synthetic = await createSyntheticExecutionHost({ workspaceRoot: root, project, host });
  const oldPlan = await planHostExecution(old);
  const outcome = await runHostExecution({ ...old, ...flags, allowCloud: true, approval: oldPlan.approvalToken }, {
    ...synthetic.dependencies,
    dockerRequest: async (...args) => {
      const observed = await synthetic.dependencies.dockerRequest(...args);
      return args[1].includes('/build?') ? response({ error: 'manifest unknown synthetic-private-error' }) : observed;
    },
  });
  assert.equal(outcome.stage, 'build');
  assert.equal(outcome.status, 'unknown-no-replay');
  // Model a historical receipt from before safe Docker diagnostics existed.
  const failedPath = path.join(old.output, 'build.result.json');
  const failed = await json(failedPath); delete failed.dockerFailure;
  await save(failedPath, seal(failed));
  const source = await withCliWorkspace(root, () => readRecipeProject(project));
  const config = { schemaVersion: 1, oldHostOutput: old.output, oldHostApproval: oldPlan.approvalToken,
    sourceManifestDigest: source.manifest.contentDigest, accountName: host.accountName,
    expiresAt: new Date(Date.now() + 1800000).toISOString(), localEngineTrusted: true,
    previousBuildStoppedReviewed: true, buildOnlyReviewed: true, downloadsReviewed: true, resourceCeilingsReviewed: true };
  const options = { workspaceRoot: root, project, config: path.join(root, 'recovery.json'), output: path.join(root, 'recovery') };
  await save(options.config, config);
  const behavior = {};
  let builtTag;
  const dependencies = {
    runAzure: () => assert.fail('Recovery must never contact Azure'),
    dockerRequest: async (socket, route, execution) => {
      assert.equal(socket, host.dockerSocket);
      assert.ok(execution.signal instanceof AbortSignal);
      const record = value => { synthetic.calls.push({ system: 'docker', route, execution }); return value; };
      if (route === '/version' && behavior.versionFailure) {
        record(null);
        throw Object.assign(new Error('synthetic unavailable socket'), { code: 'DOCKER_RESPONSE_UNKNOWN' });
      }
      if (route === '/v1.44/info' && Object.hasOwn(behavior, 'engineInfo')) return record(response(behavior.engineInfo));
      if (route.includes('/containers/json?')) return record(response(behavior.containers ?? []));
      if (route.includes('/images/json?')) return record(response(behavior.images ?? []));
      if (route.startsWith('/v1.44/images/') && route.endsWith('/json')
        && decodeURIComponent(route.slice('/v1.44/images/'.length, -'/json'.length)) !== builtTag) {
        return record(behavior.tagExists && route.includes('copilot-mcp-recovery')
          ? response({ Id: `sha256:${'f'.repeat(64)}` }) : response(null, 404));
      }
      if (route.includes('/build?')) {
        if (behavior.beforeBuild) await behavior.beforeBuild();
        if (behavior.failure) return record(response({ error: behavior.failure }));
        builtTag = new URLSearchParams(route.split('?')[1]).get('t');
      }
      return synthetic.dependencies.dockerRequest(socket, route, execution);
    },
  };
  synthetic.calls.length = 0;
  return { root, source, config, options, old, oldPlan, calls: synthetic.calls, dependencies, behavior, synthetic };
}
const execute = async f => {
  const plan = await planBuildRecovery(f.options);
  return { plan, result: await runBuildRecovery({ ...f.options, ...flags, approval: plan.approvalToken }, f.dependencies) };
};

async function revise(f, changes, suffix = 'revised') {
  const previous = await withCliWorkspace(f.root, () => readRecipeProject(f.config.replacementProject ?? f.options.project));
  const definition = { ...previous.input, ...changes };
  const generation = { workspaceRoot: f.root, config: path.join(f.root, `${suffix}-recipe.json`),
    output: path.join(f.root, `${suffix}-source`) };
  await save(generation.config, definition);
  const plan = await planHostingRecipe(generation);
  await writeHostingRecipe({ ...generation, approval: plan.approvalToken });
  const source = await withCliWorkspace(f.root, () => readRecipeProject(generation.output));
  const predecessor = f.options.output;
  const { rejectedRecoveryOutput, connectionRecoveryOutput, scanRejectedContinuationOutput, ...config } = f.config;
  f.config = { ...config, supersededRecoveryOutput: predecessor, replacementProject: source.projectDir,
    replacementSourceManifestDigest: source.manifest.contentDigest, sourceChangesReviewed: true };
  f.options = { ...f.options, config: path.join(f.root, `${suffix}-recovery.json`), output: path.join(f.root, suffix) };
  await save(f.options.config, f.config);
  return source;
}

async function continuation(f, recovery, suffix = 'continuation') {
  const config = {
    schemaVersion: 1, recoveryOutput: f.options.output, recoveryApproval: recovery.plan.approvalToken,
    sourceManifestDigest: recovery.plan.scope.sourceManifestDigest,
    azureIdentityProject: f.oldPlan.scope.effective.identityProject, accountName: f.config.accountName,
    scannerImage: f.oldPlan.scope.config.scannerImage, expiresAt: new Date(Date.now() + 1800000).toISOString(),
    localEngineTrusted: true, exclusiveControlReviewed: true, downloadsReviewed: true,
    resourceCeilingsReviewed: true, createOnlyReviewed: true, qualificationPushDeploymentReviewed: true,
  };
  const options = { workspaceRoot: f.root, project: recovery.plan.scope.project,
    config: path.join(f.root, `${suffix}.json`), output: path.join(f.root, suffix) };
  await save(options.config, config);
  const plan = await planRecoveredImage(options);
  return { config, options, plan, run: dependencies => runRecoveredImage({ ...options, ...flags,
    allowCloud: true, approval: plan.approvalToken }, dependencies ?? f.synthetic.dependencies) };
}

async function rejectedScan(t, example = 'container-apps-direct', severity = 'HIGH') {
  const f = await fixture(t, example, { identityInSource: example === 'container-apps-direct' });
  const recovery = await execute(f), prepared = await continuation(f, recovery);
  f.synthetic.findings.push({ Severity: severity });
  const result = await prepared.run();
  assert.equal(result.status, 'unknown-no-replay');
  assert.equal(result.stage, 'scan');
  return { f, recovery, prepared };
}
async function remediate(f, prepared, suffix = 'remediation', digit = '2') {
  const source = await revise(f, { imageBuild: { ...f.source.input.imageBuild,
    runtimeImage: `gcr.io/distroless/nodejs22-debian13:nonroot@sha256:${digit.repeat(64)}` } }, suffix);
  f.config.scanRejectedContinuationOutput = prepared.options.output;
  await save(f.options.config, f.config);
  return source;
}

test('Node slim source revision recovers a failed build and uses the matching continuation smoke binary', async t => {
  const f = await fixture(t);
  f.behavior.failure = 'The command returned a non-zero code: 1';
  const failed = await execute(f), retained = await snapshot(f.options.output);
  assert.equal(failed.result.status, 'unknown-no-replay');
  await revise(f, { imageBuild: { builderImage: `node:22-trixie-slim@sha256:${'1'.repeat(64)}`,
    runtimeImage: `node:22-trixie-slim@sha256:${'2'.repeat(64)}`, platform: 'linux/amd64' } }, 'node-slim');
  delete f.behavior.failure;
  const recovery = await execute(f);
  assert.equal(recovery.result.status, 'built-unqualified', JSON.stringify(recovery.result));
  const next = await continuation(f, recovery);
  f.calls.length = 0;
  const result = await next.run();
  assert.equal(result.status, 'passed', JSON.stringify(result));
  const smoke = f.calls.find(call => call.route?.includes('/containers/create?') && call.route.includes('-smoke'));
  assert.deepEqual(smoke.execution.body.Entrypoint, ['/usr/local/bin/node']);
  assert.equal(smoke.execution.body.User, '65532:65532');
  assert.equal(f.calls.some(call => call.route?.includes('/build?')), false);
  assert.deepEqual(await snapshot(failed.plan.scope.output), retained);
});

test('Node slim recovery checks Docker Hub runtime security without requiring unrelated gcr settings', () => {
  const info = { Debug: false, RegistryConfig: { InsecureRegistryCIDRs: ['127.0.0.0/8'],
    IndexConfigs: { 'gcr.io': { Secure: false } } } };
  const runtimeImage = `node:22-trixie-slim@sha256:${'a'.repeat(64)}`;
  assert.equal(assessBuildRecoveryEngine(info).checks.runtimeRegistry, 'failed');
  assert.equal(assessBuildRecoveryEngine(info, runtimeImage).checks.runtimeRegistry, 'passed');
  info.RegistryConfig.IndexConfigs['docker.io'] = { Secure: false };
  assert.equal(assessBuildRecoveryEngine(info, runtimeImage).checks.runtimeRegistry, 'failed');
  assert.equal(assessBuildRecoveryEngine(info, runtimeImage).checks.builderRegistry, 'failed');
});

test('scan remediation preserves rejected scans and separately qualifies the replacement runtime without weakening policy', async t => {
  for (const [example, severity] of [['container-apps-direct', 'UNKNOWN'], ['container-apps-apim', 'CRITICAL']]) {
    await t.test(example, async t => {
      const { f, recovery, prepared } = await rejectedScan(t, example, severity);
      const original = await snapshot(f.old.output), built = await snapshot(f.options.output);
      const scan = await snapshot(prepared.options.output), oldClaim = await readFile(prepared.plan.scope.claim);
      const volumes = [...f.synthetic.volumes.keys()];
      assert.equal(volumes.length, 1);
      await remediate(f, prepared);
      f.calls.length = 0;
      const replacement = await execute(f);
      assert.equal(replacement.result.status, 'built-unqualified', JSON.stringify(replacement.result));
      assert.equal(replacement.result.dockerRequests, 12);
      assert.equal(replacement.plan.scope.revisedSource.scanRejection.plan, prepared.plan.approvalToken);
      assert.deepEqual(replacement.plan.scope.priorScanOwners, [prepared.plan.approvalToken.split(':').at(-1)]);
      assert.equal(f.calls.filter(call => call.route?.includes('/containers/json?')).length, 3);
      assert.equal(f.calls.filter(call => call.route?.includes('/build?')).length, 1);
      assert.equal(f.calls.some(call => call.system !== 'docker' || call.route?.includes('/images/create?')), false);
      assert.deepEqual([...f.synthetic.volumes.keys()], volumes);
      const inspected = await withCliWorkspace(f.root, () => inspectBuildRecovery(f.options.output, f.root));
      assert.equal(inspected.scanRejections.length, 1);
      const next = await continuation(f, replacement, 'replacement-continuation');
      assert.notEqual(next.plan.scope.claim, prepared.plan.scope.claim);
      assert.ok(next.plan.scope.claim.endsWith(`.recovered-image-${digest(replacement.plan.approvalToken).slice(7)}.json`));
      assert.equal(next.plan.scope.evidence.plan, replacement.plan.approvalToken);
      f.synthetic.findings.length = 0; f.calls.length = 0;
      const result = await next.run();
      assert.equal(result.status, 'passed', JSON.stringify(result));
      assert.equal(f.calls.some(call => call.route?.includes('/build?')), false);
      assert.equal(f.calls.filter(call => call.route?.includes('/push?')).length, 1);
      assert.deepEqual([...f.synthetic.volumes.keys()], volumes);
      assert.deepEqual(await snapshot(f.old.output), original);
      assert.deepEqual(await snapshot(recovery.plan.scope.output), built);
      assert.deepEqual(await snapshot(prepared.options.output), scan);
      assert.deepEqual(await readFile(prepared.plan.scope.claim), oldClaim);
      await assert.rejects(planRecoveredImage({ ...next.options, output: path.join(f.root, 'rescan') }),
        { code: 'RECOVERED_IMAGE_CONSUMED' });
    });
  }
});

test('scan remediation requires a changed runtime and complete terminal scan evidence from the exact successful build', async t => {
  const { f, prepared } = await rejectedScan(t);
  await revise(f, { npmRegistryUrl: 'https://packages.example.com/npm/' }, 'registry-only');
  f.config.scanRejectedContinuationOutput = prepared.options.output;
  await save(f.options.config, f.config);
  await assert.rejects(planBuildRecovery(f.options), { code: 'BUILD_RECOVERY_RUNTIME_REVISION_REQUIRED' });
  // Keep the successful build selected while preparing the actual runtime revision.
  f.options.output = f.config.supersededRecoveryOutput;
  await remediate(f, prepared);
  const plan = await planBuildRecovery(f.options), calls = f.calls.length;
  const missingScan = { ...f.config }; delete missingScan.scanRejectedContinuationOutput;
  await save(f.options.config, missingScan);
  await assert.rejects(planBuildRecovery(f.options), { code: 'BUILD_RECOVERY_FAILURE_INELIGIBLE' });
  for (const field of ['supersededRecoveryOutput', 'replacementProject', 'replacementSourceManifestDigest', 'sourceChangesReviewed']) {
    const config = { ...f.config }; delete config[field];
    await save(f.options.config, config);
    await assert.rejects(planBuildRecovery(f.options), { code: 'BUILD_RECOVERY_CONFIG_INVALID' });
  }
  await save(f.options.config, f.config);
  const file = path.join(prepared.options.output, 'scan.result.json'), original = await readFile(file);
  for (const changes of [{ status: 'passed' }, { reasonCode: 'DOCKER_RESPONSE_UNKNOWN' }, { stage: 'smoke' },
    { intentDigest: `sha256:${'0'.repeat(64)}` }]) {
    await save(file, seal({ ...JSON.parse(original), ...changes }));
    await assert.rejects(planBuildRecovery(f.options), { code: 'RECOVERED_IMAGE_SCAN_REJECTION_INVALID' });
  }
  await writeFile(file, original);
  const imageFile = path.join(prepared.options.output, 'recovered-build.result.json');
  const imageOriginal = await readFile(imageFile), imageResult = JSON.parse(imageOriginal);
  await save(imageFile, seal({ ...imageResult, value: { ...imageResult.value, imageId: `sha256:${'f'.repeat(64)}` } }));
  await assert.rejects(planBuildRecovery(f.options), { code: 'RECOVERED_IMAGE_SCAN_REJECTION_INVALID' });
  await writeFile(imageFile, imageOriginal);
  const savedReceipts = new Map();
  let previous = prepared.plan.approvalToken;
  for (const stage of ['identity', 'preflight', 'recovered-build', 'scan']) {
    const intentPath = path.join(prepared.options.output, `${stage}.intent.json`);
    const resultPath = path.join(prepared.options.output, `${stage}.result.json`);
    for (const filename of [intentPath, resultPath]) savedReceipts.set(filename, await readFile(filename));
    const intent = seal({ ...await json(intentPath), previous,
      ...(stage === 'identity' ? { startedAt: '2000-01-01T00:00:00.000Z' } : {}) });
    const result = seal({ ...await json(resultPath), intentDigest: intent.contentDigest });
    await save(intentPath, intent); await save(resultPath, result);
    previous = result.contentDigest;
  }
  await assert.rejects(planBuildRecovery(f.options), { code: 'RECOVERED_IMAGE_SCAN_REJECTION_INVALID' });
  for (const [filename, bytes] of savedReceipts) await writeFile(filename, bytes);
  for (const name of ['smoke.intent.json', 'push.intent.json', '.mcp-execution-host.lock']) {
    await save(path.join(prepared.options.output, name), {});
    await assert.rejects(planBuildRecovery(f.options), { code: 'RECOVERED_IMAGE_SCAN_REJECTION_INVALID' });
    await rm(path.join(prepared.options.output, name));
  }
  const reportFile = path.join(prepared.options.output, 'scanner.private.json'), report = await readFile(reportFile);
  await rm(reportFile);
  await assert.rejects(planBuildRecovery(f.options), { code: 'RECOVERED_IMAGE_SCAN_REJECTION_INVALID' });
  await writeFile(reportFile, report);
  assert.equal((await planBuildRecovery(f.options)).approvalToken, plan.approvalToken);
  assert.equal(f.calls.length, calls);
});

test('scan remediation rejects a changed runtime tag that still names the same pinned digest', async t => {
  const { f, prepared } = await rejectedScan(t);
  await revise(f, { imageBuild: { ...f.source.input.imageBuild,
    runtimeImage: f.source.input.imageBuild.runtimeImage.replace('debian13', 'debian12') } });
  f.config.scanRejectedContinuationOutput = prepared.options.output;
  await save(f.options.config, f.config);
  const calls = f.calls.length;
  await assert.rejects(planBuildRecovery(f.options), { code: 'BUILD_RECOVERY_RUNTIME_REVISION_REQUIRED' });
  assert.equal(f.calls.length, calls);
});

test('scan remediation binds raw report bytes and rejects late evidence changes before building', async t => {
  const { f, prepared } = await rejectedScan(t);
  await remediate(f, prepared);
  const plan = await planBuildRecovery(f.options), request = f.dependencies.dockerRequest;
  f.calls.length = 0;
  const result = await runBuildRecovery({ ...f.options, ...flags, approval: plan.approvalToken }, {
    ...f.dependencies,
    dockerRequest: async (...args) => {
      if (args[1] === '/v1.44/info') await save(path.join(prepared.options.output, 'scanner.private.json'), { changed: true });
      return request(...args);
    },
  });
  assert.equal(result.status, 'unknown-no-replay');
  assert.equal(result.reasonCode, 'BUILD_RECOVERY_EVIDENCE_CHANGED');
  assert.equal(f.calls.some(call => call.route?.includes('/build?')), false);
  assert.equal((await json(plan.scope.claim)).plan, plan.approvalToken);
  await assert.rejects(planBuildRecovery({ ...f.options, output: path.join(f.root, 'another-attempt') }),
    { code: 'BUILD_RECOVERY_CONSUMED' });
});

test('scan remediation blocks leftover scanner containers and cannot branch concurrent builds', async t => {
  for (const blocked of [true, false]) await t.test(blocked ? 'scanner container' : 'competing plans', async t => {
    const { f, prepared } = await rejectedScan(t);
    await remediate(f, prepared);
    const plan = await planBuildRecovery(f.options), other = { ...f.options, output: path.join(f.root, 'competing') };
    const second = await planBuildRecovery(other), request = f.dependencies.dockerRequest;
    f.calls.length = 0;
    const dependencies = { ...f.dependencies, dockerRequest: async (...args) => {
      if (blocked && args[1].includes('/containers/json?')
        && decodeURIComponent(args[1]).includes(prepared.plan.approvalToken.split(':').at(-1))) {
        f.calls.push({ system: 'docker', route: args[1] });
        return response([{ Id: 'unreconciled-scanner-container' }]);
      }
      return request(...args);
    } };
    const results = await Promise.allSettled([
      runBuildRecovery({ ...f.options, ...flags, approval: plan.approvalToken }, dependencies),
      runBuildRecovery({ ...other, ...flags, approval: second.approvalToken }, dependencies),
    ]);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const result = results.find(result => result.status === 'fulfilled').value;
    assert.equal(result.status, blocked ? 'unknown-no-replay' : 'built-unqualified');
    if (blocked) assert.equal(result.reasonCode, 'BUILD_RECOVERY_PARENT_CONTAINERS');
    assert.equal(f.calls.filter(call => call.route?.includes('/build?')).length, blocked ? 0 : 1);
  });
});

test('scan remediation retains repeated scan rejection ancestry and allows no unchanged-image retry', async t => {
  const { f, prepared } = await rejectedScan(t);
  await remediate(f, prepared);
  const replacement = await execute(f), next = await continuation(f, replacement, 'replacement-continuation');
  const failed = await next.run();
  assert.equal(failed.reasonCode, 'HOST_EXECUTION_SCAN_POLICY');
  await assert.rejects(next.run(), { code: 'RECOVERED_IMAGE_CONSUMED' });
  await remediate(f, next, 'second-remediation', '3');
  const plan = await planBuildRecovery(f.options);
  assert.equal(plan.scope.priorScanOwners.length, 2);
  assert.equal(plan.scope.effective.maximumDockerRequests, 16);
  // A subsequent build failure must retain both rejected scans on its changed-source successor.
  f.behavior.failure = 'npm error code E404';
  await execute(f);
  await revise(f, { npmRegistryUrl: 'https://packages.example.com/npm/' }, 'third-revision');
  delete f.behavior.failure;
  const built = await execute(f);
  assert.equal(built.result.status, 'built-unqualified', JSON.stringify(built.result));
  assert.equal(built.result.dockerRequests, 19);
  const evidence = await withCliWorkspace(f.root, () => inspectBuildRecovery(f.options.output, f.root));
  assert.equal(evidence.scanRejections.length, 2);
  const latest = await continuation(f, built, 'latest-continuation');
  assert.notEqual(latest.plan.scope.claim, next.plan.scope.claim);
});

test('a revised-source successor after a failed connection-linked build preserves the complete lineage', async t => {
  const f = await connectionFailedSuccessor(t);
  f.behavior.failure = 'npm error code E404';
  const failed = await execute(f);
  assert.equal(failed.result.stage, 'build');
  const old = await snapshot(f.old.output), predecessor = await snapshot(f.options.output), original = await snapshot(f.options.project);
  const priorOutput = f.options.output;
  const selected = await revise(f, { npmRegistryUrl: 'https://packages.example.com/npm/' });
  delete f.behavior.failure; f.calls.length = 0;
  const { plan, result } = await execute(f);
  assert.equal(result.status, 'built-unqualified', JSON.stringify(result));
  assert.equal(plan.scope.project, selected.projectDir);
  assert.equal(plan.scope.revisedSource.predecessor.output, priorOutput);
  assert.deepEqual(plan.scope.revisedSource.changes, { npmRegistryUrl: {
    before: 'https://registry.npmjs.org/', after: 'https://packages.example.com/npm/',
  } });
  assert.equal(result.dockerRequests, 11);
  assert.equal(f.calls.filter(call => call.route.includes('/build?')).length, 1);
  assert.equal(f.calls.filter(call => call.route.includes('/containers/json?')).length, 2);
  assert.deepEqual(await snapshot(f.old.output), old);
  assert.deepEqual(await snapshot(priorOutput), predecessor);
  assert.deepEqual(await snapshot(f.options.project), original);
  const inspected = await withCliWorkspace(f.root, () => inspectBuildRecovery(f.options.output, f.root));
  assert.equal(inspected.built.imageId, result.imageId);
  assert.equal(inspected.artifacts.length, 3);
  await assert.rejects(planBuildRecovery({ ...f.options, output: path.join(f.root, 'branch') }),
    { code: 'BUILD_RECOVERY_CONSUMED' });
});

test('source revisions reject unchanged build inputs, runtime changes and changed failure evidence before dispatch', async t => {
  const f = await fixture(t);
  f.behavior.failure = 'npm error code E404';
  await execute(f);
  const previous = f.options.output, previousConfig = structuredClone(f.config), previousOptions = { ...f.options };
  for (const [index, changes] of [
    {}, { name: 'changed-name' }, { npmRegistryUrl: 'https://packages.example.com/npm/', requestsPerMinute: 61 },
  ].entries()) {
    f.config = structuredClone(previousConfig); f.options = { ...previousOptions };
    await revise(f, changes, `invalid-${index}`);
    await assert.rejects(planBuildRecovery(f.options));
  }
  f.config = structuredClone(previousConfig); f.options = { ...previousOptions };
  await revise(f, { npmRegistryUrl: 'https://packages.example.com/npm/' }, 'valid');
  const plan = await planBuildRecovery(f.options), calls = f.calls.length;
  await assert.rejects(runBuildRecovery({ ...f.options, ...flags, approval: f.oldPlan.approvalToken }, f.dependencies));
  const filename = path.join(previous, 'result.json'), saved = await readFile(filename);
  for (const changed of [{ dockerRequests: 6 }, { status: 'built-unqualified' }, { azureCommands: 1 },
    { reasonCode: 'BUILD_RECOVERY_EVIDENCE_CHANGED' }, { stage: 'reconcile' }]) {
    await save(filename, seal({ ...JSON.parse(saved), ...changed }));
    await assert.rejects(planBuildRecovery(f.options));
  }
  await writeFile(filename, saved);
  await save(path.join(previous, 'push.intent.json'), {});
  await assert.rejects(planBuildRecovery(f.options));
  await rm(path.join(previous, 'push.intent.json'));
  assert.equal(f.calls.length, calls);
  assert.equal((await planBuildRecovery(f.options)).approvalToken, plan.approvalToken);
});

test('explicit revised build failures form a single-child lineage and competing approvals cannot branch', async t => {
  const f = await fixture(t);
  f.behavior.failure = 'npm error code E404';
  await execute(f);
  await revise(f, { npmRegistryUrl: 'https://packages.example.com/npm/' });
  const failed = await execute(f);
  assert.equal(failed.result.stage, 'build');
  await revise(f, { imageBuild: { ...f.source.input.imageBuild,
    builderImage: `node:22-bookworm-slim@sha256:${'1'.repeat(64)}` } }, 'next-revision');
  const other = { ...f.options, output: path.join(f.root, 'competing') };
  const first = await planBuildRecovery(f.options), second = await planBuildRecovery(other);
  assert.equal(first.scope.effective.maximumDockerRequests, 14);
  delete f.behavior.failure; f.calls.length = 0;
  const results = await Promise.allSettled([
    runBuildRecovery({ ...f.options, ...flags, approval: first.approvalToken }, f.dependencies),
    runBuildRecovery({ ...other, ...flags, approval: second.approvalToken }, f.dependencies),
  ]);
  assert.equal(results.filter(row => row.status === 'fulfilled' && row.value.status === 'built-unqualified').length, 1);
  assert.equal(results.filter(row => row.status === 'rejected').length, 1);
  assert.equal(f.calls.filter(call => call.route.includes('/build?')).length, 1);
});

test('recovered images run the shared scan, smoke, unique-tag, push and create-only stages without rebuilding', async t => {
  for (const example of ['container-apps-direct', 'container-apps-apim']) await t.test(example, async t => {
    const f = await fixture(t, example);
    f.behavior.failure = 'npm error code E404';
    await execute(f);
    await revise(f, { npmRegistryUrl: 'https://packages.example.com/npm/' });
    delete f.behavior.failure;
    const recovery = await execute(f), prepared = await continuation(f, recovery);
    const original = await snapshot(f.old.output), before = await snapshot(f.options.output);
    f.calls.length = 0;
    assert.equal(prepared.plan.scope.config.dockerSocket, f.oldPlan.scope.config.dockerSocket);
    assert.equal(prepared.plan.scope.downloads.npmRegistryUrl, undefined);
    const result = await prepared.run();
    assert.equal(result.status, 'passed', JSON.stringify(result));
    assert.equal(result.providerVerified, false);
    assert.equal(result.observedMilestones.build, 'recovery-passed-image-reverified');
    assert.equal(result.observedMilestones.zeroCriticalHighScan, 'passed');
    assert.equal(result.observedMilestones.registryPush, 'passed');
    assert.equal(f.calls.some(call => call.route?.includes('/build?')), false);
    assert.equal(f.calls.filter(call => call.route?.includes('/tag?')).length, 1);
    assert.equal(f.calls.filter(call => call.route?.includes('/push?')).length, 1);
    assert.equal(f.calls.filter(call => call.system === 'health').length, 1);
    assert.equal(f.synthetic.containers.size, 0);
    assert.equal(f.synthetic.volumes.size, 0);
    assert.deepEqual(await snapshot(f.old.output), original);
    assert.deepEqual(await snapshot(f.options.output), before);
    const count = f.calls.length;
    await assert.rejects(prepared.run(), { code: 'RECOVERED_IMAGE_CONSUMED' });
    await assert.rejects(planRecoveredImage({ ...prepared.options, output: path.join(f.root, 'bypass-continuation') }),
      { code: 'RECOVERED_IMAGE_CONSUMED' });
    assert.equal(f.calls.length, count);
  });
});

test('recovered-image approvals are independent and fail closed before mutation on changed source or evidence', async t => {
  const f = await fixture(t), recovery = await execute(f), prepared = await continuation(f, recovery);
  f.calls.length = 0;
  for (const changed of [{ approval: recovery.plan.approvalToken }, { allowCloud: false }, { allowNetwork: false },
    { allowLocal: false }, { signal: AbortSignal.abort() }]) {
    await assert.rejects(runRecoveredImage({ ...prepared.options, ...flags, allowCloud: true,
      approval: prepared.plan.approvalToken, ...changed }, f.synthetic.dependencies));
  }
  const filename = path.join(f.options.output, 'result.json'), original = await readFile(filename);
  for (const changed of [{ pushed: true }, { scanPassed: true }, { imageId: `sha256:${'f'.repeat(64)}` },
    { buildEvidenceDigest: `sha256:${'1'.repeat(64)}` }]) {
    await save(filename, seal({ ...JSON.parse(original), ...changed }));
    await assert.rejects(planRecoveredImage(prepared.options));
  }
  await writeFile(filename, original);
  await save(prepared.options.config, { ...prepared.config, accountName: 'another@example.com' });
  await assert.rejects(planRecoveredImage(prepared.options), { code: 'RECOVERED_IMAGE_IDENTITY_MISMATCH' });
  assert.equal(f.calls.length, 0);
});

test('a recovered image failing scan never reaches tagging, credentials, push or deployment and remains consumed', async t => {
  const f = await fixture(t), recovery = await execute(f), prepared = await continuation(f, recovery);
  f.synthetic.findings.push({ Severity: 'HIGH' }); f.calls.length = 0;
  const result = await prepared.run();
  assert.equal(result.status, 'unknown-no-replay');
  assert.equal(result.stage, 'scan');
  assert.equal(f.calls.some(call => call.route?.includes('/tag?') || call.route?.includes('/push?')
    || call.args?.[0] === 'acr' && call.args[1] === 'login' || call.args?.includes('PUT')), false);
  await assert.rejects(prepared.run(), { code: 'RECOVERED_IMAGE_CONSUMED' });
});

test('a revised-source attempt rechecks prior evidence after reconciliation and blocks stale authority', async t => {
  const f = await fixture(t);
  f.behavior.failure = 'npm error code E404'; await execute(f);
  const prior = path.join(f.options.output, 'result.json');
  await revise(f, { npmRegistryUrl: 'https://packages.example.com/npm/' });
  delete f.behavior.failure; f.calls.length = 0;
  const plan = await planBuildRecovery(f.options);
  const request = f.dependencies.dockerRequest;
  const result = await runBuildRecovery({ ...f.options, ...flags, approval: plan.approvalToken }, {
    ...f.dependencies,
    dockerRequest: async (...args) => {
      if (args[1] === '/v1.44/info') await save(prior, { ...await json(prior), providerCalls: 1 });
      return request(...args);
    },
  });
  assert.equal(result.status, 'unknown-no-replay');
  assert.equal(result.reasonCode, 'BUILD_RECOVERY_EVIDENCE_INVALID');
  assert.equal(f.calls.some(call => call.route.includes('/build?')), false);
  assert.equal((await json(plan.scope.claim)).plan, plan.approvalToken);
});

test('recovered-image local identity and immutable lineage are checked before scan or retagging', async t => {
  const f = await fixture(t), recovery = await execute(f), prepared = await continuation(f, recovery);
  f.calls.length = 0;
  const request = f.synthetic.dependencies.dockerRequest;
  const result = await prepared.run({
    ...f.synthetic.dependencies,
    dockerRequest: async (...args) => {
      const observed = await request(...args);
      if (args[1].includes(encodeURIComponent(recovery.plan.localImage))) {
        const value = JSON.parse(observed.body);
        value.Config.Labels['copilot-mcp-execution'] = 'another-owner';
        return response(value);
      }
      return observed;
    },
  });
  assert.equal(result.stage, 'recovered-build');
  assert.equal(result.status, 'unknown-no-replay');
  assert.equal(f.calls.some(call => call.route?.includes('/images/create?') || call.route?.includes('/tag?')), false);
});

test('competing recovered-image plans cannot qualify the same recovered build twice', async t => {
  const f = await fixture(t), recovery = await execute(f), prepared = await continuation(f, recovery);
  const other = { ...prepared.options, output: path.join(f.root, 'competing-continuation') };
  const second = await planRecoveredImage(other);
  f.calls.length = 0;
  const results = await Promise.allSettled([
    prepared.run(),
    runRecoveredImage({ ...other, ...flags, allowCloud: true, approval: second.approvalToken }, f.synthetic.dependencies),
  ]);
  assert.equal(results.filter(row => row.status === 'fulfilled' && row.value.status === 'passed').length, 1);
  assert.equal(results.filter(row => row.status === 'rejected').length, 1);
  assert.equal(f.calls.filter(call => call.route?.includes('/push?')).length, 1);
});

test('recovered-image CLI and public schema expose only separate reviewed authority', async t => {
  const f = await fixture(t), recovery = await execute(f), prepared = await continuation(f, recovery);
  const schema = await getRecoveredImageSchema();
  schema.additionalProperties = true;
  assert.equal((await getRecoveredImageSchema()).additionalProperties, false);
  assert.equal(Object.hasOwn(schema.properties, 'dockerRequest'), false);
  const out = [], err = [];
  t.mock.method(process.stdout, 'write', text => { out.push(String(text)); return true; });
  t.mock.method(process.stderr, 'write', text => { err.push(String(text)); return true; });
  assert.equal(await main(['mcp-recovered-image-schema', '--json']), 0);
  assert.equal(JSON.parse(out.join('')).additionalProperties, false); out.length = 0;
  const selected = ['--workspace-root', f.root, '--project', prepared.options.project,
    '--config', prepared.options.config, '--output', prepared.options.output];
  assert.equal(await main(['mcp-recovered-image-plan', ...selected, '--json', '--summary']), 0);
  assert.equal(JSON.parse(out.join('')).scope.kind, 'mcp-recovered-image-plan');
  assert.match(err.join(''), /EXACT approvalToken:/);
  out.length = 0;
  assert.notEqual(await main(['mcp-recovered-image-run', ...selected, '--approve', recovery.plan.approvalToken,
    '--allow-local', '--allow-network', '--allow-cloud']), 0);
});

test('a source-local private identity allows only the continuation-owned lock, not an existing parent lock', async t => {
  const f = await fixture(t, 'container-apps-direct', { identityInSource: true });
  const recovery = await execute(f), prepared = await continuation(f, recovery);
  const lock = path.join(f.options.project, '.mcp-execution-host.lock');
  await save(lock, { pid: 0 });
  await assert.rejects(planRecoveredImage(prepared.options), { code: 'BUILD_RECOVERY_PARENT_LOCKED' });
  await rm(lock);
  f.calls.length = 0;
  const result = await prepared.run();
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(f.calls.some(call => call.route?.includes('/build?')), false);
  await assert.rejects(readFile(lock), { code: 'ENOENT' });
});

test('a recovered-image output with historical stage files cannot be adopted even without its claim', async t => {
  const f = await fixture(t), recovery = await execute(f), prepared = await continuation(f, recovery);
  await mkdir(prepared.options.output);
  await save(path.join(prepared.options.output, 'plan.json'), prepared.plan);
  await save(path.join(prepared.options.output, 'identity.intent.json'), {});
  f.calls.length = 0;
  await assert.rejects(prepared.run(), { code: 'RECOVERED_IMAGE_OUTPUT_EXISTS' });
  assert.equal(f.calls.length, 0);
});

test('build recovery schema and public API are closed and planning has no external effects', async t => {
  const f = await fixture(t);
  const schema = await getBuildRecoverySchema();
  schema.additionalProperties = true;
  assert.equal((await getBuildRecoverySchema()).additionalProperties, false);
  assert.equal(Object.hasOwn(schema.properties, 'dockerRequest'), false);
  const plan = await publicPlan(f.options);
  assert.equal(plan.scope.kind, 'mcp-build-recovery-plan');
  assert.equal(f.calls.length, 0);
  await assert.rejects(readFile(path.join(f.options.output, 'plan.json')), { code: 'ENOENT' });
  for (const change of [{ previousBuildStoppedReviewed: false }, { accountName: 'different@example.com' },
    { expiresAt: '2000-01-01T00:00:00.000Z' }, { retry: true }]) {
    await save(f.options.config, { ...f.config, ...change });
    await assert.rejects(planBuildRecovery(f.options));
  }
});

test('one linked local build preserves legacy evidence and cannot replay through another output', async t => {
  const f = await fixture(t);
  f.behavior.engineInfo = { Debug: false, RegistryConfig: {
    InsecureRegistryCIDRs: ['127.0.0.0/8', '::1/128'],
    IndexConfigs: { 'unrelated.synthetic.invalid:5000': { Secure: false },
      'docker.io': { Secure: true }, 'gcr.io': { Secure: true } },
  } };
  const parent = await snapshot(f.old.output), source = await snapshot(f.options.project);
  f.behavior.images = [{ Id: `sha256:${'f'.repeat(64)}`,
    Labels: { 'copilot-mcp-execution': f.oldPlan.approvalToken.split(':').at(-1) } }];
  const reservations = await snapshot(path.join(f.root, '.mcp-execution-host-targets'));
  const { plan, result } = await execute(f);
  assert.equal(result.status, 'built-unqualified', JSON.stringify(result));
  assert.equal(result.providerCalls, 0);
  assert.equal(result.azureCommands, 0);
  assert.equal(result.scanPassed, false);
  assert.equal(result.deployed, false);
  assert.deepEqual(result.engineSecurity.checks, {
    debugDisabled: 'passed', insecureRegistryCidrs: 'passed', builderRegistry: 'passed', runtimeRegistry: 'passed',
  });
  assert.equal(f.calls.length, 8);
  assert.equal(f.calls.filter(call => call.execution.method === 'POST').length, 1);
  assert.ok(f.calls.every(call => call.system === 'docker'));
  assert.equal(f.calls.filter(call => call.route.includes('/build?')).length, 1);
  assert.deepEqual(await snapshot(f.old.output), parent);
  assert.deepEqual(await snapshot(f.options.project), source);
  assert.deepEqual((await json(path.join(f.options.output, 'reconcile.result.json'))).value.parentImageIds,
    [`sha256:${'f'.repeat(64)}`]);
  const after = await snapshot(path.join(f.root, '.mcp-execution-host-targets'));
  for (const [name, bytes] of Object.entries(reservations)) assert.equal(after[name], bytes);
  assert.equal(Object.keys(after).length, Object.keys(reservations).length + 1);
  const receipt = await json(path.join(f.options.output, 'result.json'));
  assert.deepEqual(receipt, result);
  const { contentDigest, ...body } = receipt; assert.equal(contentDigest, digest(body));
  const count = f.calls.length;
  await assert.rejects(runBuildRecovery({ ...f.options, ...flags, approval: plan.approvalToken }, f.dependencies));
  f.options.output = path.join(f.root, 'replacement');
  await assert.rejects(planBuildRecovery(f.options), { code: 'BUILD_RECOVERY_CONSUMED' });
  assert.equal(f.calls.length, count);
});

test('failed recovery retains only safe diagnostics and permanently consumes its target claim', async t => {
  const f = await fixture(t);
  f.behavior.failure = 'getaddrinfo ENOTFOUND https://example.com/?api_key=synthetic-private-error';
  const { result } = await execute(f);
  assert.equal(result.status, 'unknown-no-replay');
  assert.equal(result.stage, 'build');
  assert.equal(result.dockerFailure.category, 'name-resolution');
  assert.equal((await readFile(path.join(f.options.output, 'result.json'), 'utf8')).includes('synthetic-private-error'), false);
  assert.equal(f.calls.filter(call => call.route.includes('/build?')).length, 1);
  f.options.output = path.join(f.root, 'retry');
  await assert.rejects(planBuildRecovery(f.options), { code: 'BUILD_RECOVERY_CONSUMED' });
});

test('engine security rejection names failed checks without persisting raw daemon data or building', async t => {
  const f = await fixture(t), parent = await snapshot(f.old.output);
  f.behavior.engineInfo = { Debug: true, Name: 'synthetic-private-marker', RegistryConfig: {
    InsecureRegistryCIDRs: ['0.0.0.0/0'],
    IndexConfigs: { 'docker.io': { Secure: false, privateField: 'synthetic-private-marker' },
      'gcr.io': { Secure: true } },
  } };
  const { result } = await execute(f);
  assert.equal(result.status, 'unknown-no-replay');
  assert.equal(result.reasonCode, 'BUILD_RECOVERY_ENGINE_UNTRUSTED');
  assert.deepEqual(result.engineSecurity, { schemaVersion: 1, checks: {
    debugDisabled: 'failed', insecureRegistryCidrs: 'failed', builderRegistry: 'failed', runtimeRegistry: 'passed',
  } });
  assert.equal(result.dockerFailure, undefined);
  assert.equal(result.dockerRequests, 2);
  assert.equal(f.calls.some(call => call.execution.method === 'POST'), false);
  assert.deepEqual(await snapshot(f.old.output), parent);
  const text = await readFile(path.join(f.options.output, 'result.json'), 'utf8');
  assert.equal(text.includes('synthetic-private-marker'), false);
  assert.equal(text.includes('0.0.0.0/0'), false);
  assert.deepEqual(JSON.parse(text), result);
  const { contentDigest, ...body } = result; assert.equal(contentDigest, digest(body));
  f.options.output = path.join(f.root, 'retry');
  await assert.rejects(planBuildRecovery(f.options), { code: 'BUILD_RECOVERY_CONSUMED' });
});

test('engine security assessment is scoped, fails closed and never copies arbitrary metadata', () => {
  const clean = () => ({ Debug: false, RegistryConfig: { InsecureRegistryCIDRs: ['127.0.0.0/8'], IndexConfigs: {} } });
  const passed = { debugDisabled: 'passed', insecureRegistryCidrs: 'passed', builderRegistry: 'passed', runtimeRegistry: 'passed' };
  assert.deepEqual(assessBuildRecoveryEngine(clean()).checks, passed);
  for (const [alias, field] of [['docker.io', 'builderRegistry'], ['index.docker.io', 'builderRegistry'],
    ['registry-1.docker.io', 'builderRegistry'], ['https://index.docker.io/v1/', 'builderRegistry'],
    ['gcr.io', 'runtimeRegistry'], ['GCR.IO', 'runtimeRegistry']]) {
    const info = clean(); info.RegistryConfig.IndexConfigs[alias] = { Secure: false };
    assert.deepEqual(assessBuildRecoveryEngine(info).checks, { ...passed, [field]: 'failed' });
  }
  const named = clean();
  named.RegistryConfig.IndexConfigs['synthetic-private-marker'] = { Name: 'docker.io', Secure: false };
  assert.equal(assessBuildRecoveryEngine(named).checks.builderRegistry, 'failed');
  for (const value of [undefined, null, [], 'synthetic-private-marker']) {
    const info = clean(); info.RegistryConfig.IndexConfigs = value;
    assert.deepEqual(assessBuildRecoveryEngine(info).checks,
      { ...passed, builderRegistry: 'unknown', runtimeRegistry: 'unknown' });
  }
  for (const value of [null, [], {}, { Secure: 'false' }, { Secure: 1 }]) {
    const info = clean(); info.RegistryConfig.IndexConfigs['gcr.io'] = value;
    assert.equal(assessBuildRecoveryEngine(info).checks.runtimeRegistry, 'unknown');
  }
  for (const value of [null, [], {}]) {
    assert.deepEqual(assessBuildRecoveryEngine(value).checks, Object.fromEntries(Object.keys(passed).map(key => [key, 'unknown'])));
  }
  const missing = clean(); delete missing.Debug; delete missing.RegistryConfig.InsecureRegistryCIDRs;
  assert.deepEqual(assessBuildRecoveryEngine(missing).checks,
    { ...passed, debugDisabled: 'unknown', insecureRegistryCidrs: 'unknown' });
  const invalid = clean(); invalid.RegistryConfig.InsecureRegistryCIDRs = [null];
  assert.equal(assessBuildRecoveryEngine(invalid).checks.insecureRegistryCidrs, 'unknown');
  assert.equal(JSON.stringify(assessBuildRecoveryEngine(named)).includes('synthetic-private-marker'), false);
});

async function engineRejectedSuccessor(t) {
  const f = await fixture(t);
  f.behavior.engineInfo = { Debug: true, RegistryConfig: { InsecureRegistryCIDRs: [], IndexConfigs: {} } };
  const { result } = await execute(f);
  assert.equal(result.reasonCode, 'BUILD_RECOVERY_ENGINE_UNTRUSTED');
  const rejected = f.options.output;
  // The initial implementation did not retain individual engine check outcomes.
  delete result.engineSecurity;
  await save(path.join(rejected, 'result.json'), seal(result));
  f.options = { ...f.options, config: path.join(f.root, 'successor.json'), output: path.join(f.root, 'successor') };
  f.config = { ...f.config, rejectedRecoveryOutput: rejected };
  await save(f.options.config, f.config);
  delete f.behavior.engineInfo;
  f.calls.length = 0;
  return { ...f, rejected };
}

test('one approved engine-rejection successor preserves both failures and their claims', async t => {
  const f = await engineRejectedSuccessor(t);
  const rejected = await snapshot(f.rejected), parent = await snapshot(f.old.output);
  const before = await snapshot(path.join(f.root, '.mcp-execution-host-targets'));
  const { plan, result } = await execute(f);
  assert.equal(result.status, 'built-unqualified');
  assert.equal(plan.scope.rejectedRecovery.output, f.rejected);
  assert.equal(plan.scope.rejectedRecovery.resultDigest, JSON.parse(await readFile(path.join(f.rejected, 'result.json'))).contentDigest);
  assert.equal(f.calls.filter(call => call.route.includes('/build?')).length, 1);
  assert.deepEqual(await snapshot(f.rejected), rejected);
  assert.deepEqual(await snapshot(f.old.output), parent);
  const after = await snapshot(path.join(f.root, '.mcp-execution-host-targets'));
  for (const [name, bytes] of Object.entries(before)) assert.equal(after[name], bytes);
  assert.equal(Object.keys(after).length, Object.keys(before).length + 1);
  const count = f.calls.length;
  const completedOutput = f.options.output;
  f.options.output = path.join(f.root, 'second-successor');
  await assert.rejects(planBuildRecovery(f.options), { code: 'BUILD_RECOVERY_CONSUMED' });
  f.config.rejectedRecoveryOutput = completedOutput; await save(f.options.config, f.config);
  await assert.rejects(planBuildRecovery(f.options), { code: 'BUILD_RECOVERY_REJECTION_INVALID' });
  assert.equal(f.calls.length, count);
});

test('engine-rejection successor requires fresh approval and exact read-only terminal evidence', async t => {
  const f = await engineRejectedSuccessor(t), plan = await planBuildRecovery(f.options);
  const prior = await json(path.join(f.rejected, 'plan.json'));
  await assert.rejects(runBuildRecovery({ ...f.options, ...flags, approval: prior.approvalToken }, f.dependencies),
    { code: 'BUILD_RECOVERY_APPROVAL_REQUIRED' });
  const filename = path.join(f.rejected, 'result.json'), original = await readFile(filename);
  for (const change of [{ dockerRequests: 3 }, { status: 'built-unqualified' }, { stage: 'build' },
    { reasonCode: 'DOCKER_DISPATCH_FAILED' }, { providerCalls: 1 }, { azureCommands: 1 },
    { plan: 'foreign-plan' }]) {
    await save(filename, seal({ ...JSON.parse(original), ...change }));
    await assert.rejects(planBuildRecovery(f.options), { code: 'BUILD_RECOVERY_REJECTION_INVALID' });
  }
  await writeFile(filename, original);
  for (const name of ['build.intent.json', 'reconcile.result.json', '.mcp-execution-host.lock']) {
    const added = path.join(f.rejected, name); await save(added, {});
    await assert.rejects(planBuildRecovery(f.options), { code: 'BUILD_RECOVERY_REJECTION_INVALID' });
    await rm(added);
  }
  const changed = seal({ ...JSON.parse(original), finishedAt: new Date().toISOString() });
  await save(filename, changed);
  await assert.rejects(runBuildRecovery({ ...f.options, ...flags, approval: plan.approvalToken }, f.dependencies),
    { code: 'BUILD_RECOVERY_APPROVAL_REQUIRED' });
  assert.equal(f.calls.length, 0);
});

test('a failed successor is consumed and cannot authorize a further engine recheck', async t => {
  const f = await engineRejectedSuccessor(t);
  f.behavior.engineInfo = { Debug: true, RegistryConfig: { InsecureRegistryCIDRs: [], IndexConfigs: {} } };
  const { result } = await execute(f);
  assert.equal(result.reasonCode, 'BUILD_RECOVERY_ENGINE_UNTRUSTED');
  assert.equal(result.dockerRequests, 2);
  const output = f.options.output;
  f.options.output = path.join(f.root, 'third');
  await assert.rejects(planBuildRecovery(f.options), { code: 'BUILD_RECOVERY_CONSUMED' });
  f.config.rejectedRecoveryOutput = output; await save(f.options.config, f.config);
  await assert.rejects(planBuildRecovery(f.options), { code: 'BUILD_RECOVERY_REJECTION_INVALID' });
  assert.equal(f.calls.some(call => call.route.includes('/build?')), false);
});

test('rejected evidence changed during successor reconciliation prevents build dispatch', async t => {
  const f = await engineRejectedSuccessor(t), plan = await planBuildRecovery(f.options);
  const original = f.dependencies.dockerRequest;
  const dependencies = { ...f.dependencies, dockerRequest: async (...args) => {
    const response = await original(...args);
    if (args[1].includes('copilot-mcp-recovery') && args[1].endsWith('/json')) {
      const filename = path.join(f.rejected, 'result.json'), result = await json(filename);
      await save(filename, seal({ ...result, finishedAt: new Date().toISOString() }));
    }
    return response;
  } };
  const result = await runBuildRecovery({ ...f.options, ...flags, approval: plan.approvalToken }, dependencies);
  assert.equal(result.status, 'unknown-no-replay');
  assert.equal(result.reasonCode, 'BUILD_RECOVERY_EVIDENCE_CHANGED');
  assert.equal(f.calls.some(call => call.route.includes('/build?')), false);
});

async function connectionFailedSuccessor(t) {
  const f = await engineRejectedSuccessor(t);
  f.behavior.versionFailure = true;
  const { result } = await execute(f);
  assert.equal(result.reasonCode, 'DOCKER_RESPONSE_UNKNOWN');
  assert.equal(result.dockerRequests, 1);
  const stopped = f.options.output;
  f.options = { ...f.options, config: path.join(f.root, 'connection.json'), output: path.join(f.root, 'connection') };
  delete f.config.rejectedRecoveryOutput;
  f.config.connectionRecoveryOutput = stopped;
  await save(f.options.config, f.config);
  delete f.behavior.versionFailure;
  f.calls.length = 0;
  return { ...f, stopped };
}

test('explicit connection retry preserves the full lineage and consumes one deterministic child claim', async t => {
  const f = await connectionFailedSuccessor(t);
  const stopped = await snapshot(f.stopped), rejected = await snapshot(f.rejected), original = await snapshot(f.old.output);
  const claims = await snapshot(path.join(f.root, '.mcp-execution-host-targets'));
  const plan = await planBuildRecovery(f.options);
  const otherOptions = { ...f.options, output: path.join(f.root, 'competing') };
  const other = await planBuildRecovery(otherOptions);
  assert.equal(plan.scope.claim, other.scope.claim);
  const results = await Promise.allSettled([
    runBuildRecovery({ ...f.options, ...flags, approval: plan.approvalToken }, f.dependencies),
    runBuildRecovery({ ...otherOptions, ...flags, approval: other.approvalToken }, f.dependencies),
  ]);
  assert.equal(results.filter(row => row.status === 'fulfilled' && row.value.status === 'built-unqualified').length, 1);
  assert.equal(results.filter(row => row.status === 'rejected').length, 1);
  assert.equal(f.calls.filter(call => call.route.includes('/build?')).length, 1);
  assert.deepEqual(await snapshot(f.stopped), stopped);
  assert.deepEqual(await snapshot(f.rejected), rejected);
  assert.deepEqual(await snapshot(f.old.output), original);
  const after = await snapshot(path.join(f.root, '.mcp-execution-host-targets'));
  for (const [name, bytes] of Object.entries(claims)) assert.equal(after[name], bytes);
  assert.equal(Object.keys(after).length, Object.keys(claims).length + 1);
  f.options.output = path.join(f.root, 'bypass');
  await assert.rejects(planBuildRecovery(f.options), { code: 'BUILD_RECOVERY_CONSUMED' });
});

test('connection retry rejects ambiguous, mutated or dispatched-build evidence and requires a fresh approval', async t => {
  const f = await connectionFailedSuccessor(t), plan = await planBuildRecovery(f.options);
  const previous = await json(path.join(f.stopped, 'plan.json'));
  await assert.rejects(runBuildRecovery({ ...f.options, ...flags, approval: previous.approvalToken }, f.dependencies),
    { code: 'BUILD_RECOVERY_APPROVAL_REQUIRED' });
  const filename = path.join(f.stopped, 'result.json'), original = await readFile(filename);
  for (const change of [{ dockerRequests: 2 }, { stage: 'build' }, { reasonCode: 'DOCKER_ABORTED' },
    { providerCalls: 1 }, { azureCommands: 1 }, { status: 'passed' }]) {
    await save(filename, seal({ ...JSON.parse(original), ...change }));
    await assert.rejects(planBuildRecovery(f.options), { code: 'BUILD_RECOVERY_REJECTION_INVALID' });
  }
  await writeFile(filename, original);
  const buildIntent = path.join(f.stopped, 'build.intent.json');
  await save(buildIntent, {});
  await assert.rejects(planBuildRecovery(f.options), { code: 'BUILD_RECOVERY_REJECTION_INVALID' });
  await rm(buildIntent);
  await save(f.options.config, { ...f.config, rejectedRecoveryOutput: f.rejected });
  await assert.rejects(planBuildRecovery(f.options), { code: 'BUILD_RECOVERY_CONFIG_INVALID' });
  await save(f.options.config, { ...f.config, connectionRecoveryOutput: f.rejected });
  await assert.rejects(planBuildRecovery(f.options), { code: 'BUILD_RECOVERY_REJECTION_INVALID' });
  assert.equal(f.calls.length, 0);
  await save(f.options.config, f.config);
  f.behavior.versionFailure = true;
  const result = await runBuildRecovery({ ...f.options, ...flags, approval: plan.approvalToken }, f.dependencies);
  assert.equal(result.reasonCode, 'DOCKER_RESPONSE_UNKNOWN');
  const failed = f.options.output;
  f.options = { ...f.options, config: path.join(f.root, 'next-connection.json'), output: path.join(f.root, 'next-connection') };
  f.config.connectionRecoveryOutput = failed;
  await save(f.options.config, f.config);
  delete f.behavior.versionFailure;
  const next = await execute(f);
  assert.equal(next.result.status, 'built-unqualified');
  assert.equal(f.calls.filter(call => call.route.includes('/build?')).length, 1);
});

test('ACA behind APIM preserves every gateway reservation without gateway access', async t => {
  const f = await fixture(t, 'container-apps-apim');
  const before = await snapshot(path.join(f.root, '.mcp-execution-host-targets'));
  const { result } = await execute(f);
  assert.equal(result.status, 'built-unqualified');
  const after = await snapshot(path.join(f.root, '.mcp-execution-host-targets'));
  assert.ok(Object.keys(before).length > 1);
  for (const [name, bytes] of Object.entries(before)) assert.equal(after[name], bytes);
  assert.equal(f.calls.every(call => call.system === 'docker'), true);
});

test('parent containers stop reconciliation without a build or deletion and remain consumed', async t => {
  const f = await fixture(t);
  f.behavior.containers = [{ Id: 'synthetic-container', State: 'running' }];
  const { result } = await execute(f);
  assert.equal(result.status, 'unknown-no-replay');
  assert.equal(result.reasonCode, 'BUILD_RECOVERY_PARENT_CONTAINERS');
  assert.equal(f.calls.some(call => call.execution.method === 'POST' || call.execution.method === 'DELETE'), false);
  f.options.output = path.join(f.root, 'retry');
  await assert.rejects(planBuildRecovery(f.options), { code: 'BUILD_RECOVERY_CONSUMED' });
});

test('invalid approval, cancelled intent and changed inputs cannot acquire a claim or dispatch', async t => {
  const f = await fixture(t), plan = await planBuildRecovery(f.options);
  for (const change of [{ approval: f.oldPlan.approvalToken }, { allowLocal: false }, { allowNetwork: false },
    { allowCloud: true }, { signal: AbortSignal.abort() }]) {
    await assert.rejects(runBuildRecovery({ ...f.options, ...flags, approval: plan.approvalToken, ...change }, f.dependencies));
  }
  f.config.maximumMs = 60000; await save(f.options.config, f.config);
  await assert.rejects(runBuildRecovery({ ...f.options, ...flags, approval: plan.approvalToken }, f.dependencies),
    { code: 'BUILD_RECOVERY_APPROVAL_REQUIRED' });
  assert.equal(f.calls.length, 0);
  assert.equal((await readdir(path.join(f.root, '.mcp-execution-host-targets'))).some(name => name.includes('build-recovery')), false);
});

test('a pre-existing recovery image tag blocks before build and is never overwritten', async t => {
  const f = await fixture(t); f.behavior.tagExists = true;
  const { result } = await execute(f);
  assert.equal(result.reasonCode, 'BUILD_RECOVERY_LOCAL_TARGET_EXISTS');
  assert.equal(f.calls.some(call => call.execution.method === 'POST' || call.execution.method === 'DELETE'), false);
});

test('concurrent recovery plans for the same parent dispatch at most one build', async t => {
  const f = await fixture(t);
  const other = { ...f.options, output: path.join(f.root, 'concurrent') };
  const first = await planBuildRecovery(f.options), second = await planBuildRecovery(other);
  const results = await Promise.allSettled([
    runBuildRecovery({ ...f.options, ...flags, approval: first.approvalToken }, f.dependencies),
    runBuildRecovery({ ...other, ...flags, approval: second.approvalToken }, f.dependencies),
  ]);
  assert.equal(results.filter(row => row.status === 'fulfilled' && row.value.status === 'built-unqualified').length, 1);
  assert.equal(results.filter(row => row.status === 'rejected').length, 1);
  assert.equal(f.calls.filter(call => call.route.includes('/build?')).length, 1);
});

test('cancellation after dispatch remains inconclusive and prevents image inspection or replay', async t => {
  const f = await fixture(t), controller = new AbortController();
  const plan = await planBuildRecovery(f.options);
  f.behavior.beforeBuild = () => controller.abort();
  const result = await runBuildRecovery({ ...f.options, ...flags, approval: plan.approvalToken,
    signal: controller.signal }, f.dependencies);
  assert.equal(result.status, 'unknown-no-replay');
  assert.equal(result.reasonCode, 'BUILD_RECOVERY_CANCELLED');
  assert.equal(f.calls.at(-1).route.includes('/build?'), true);
  f.options.output = path.join(f.root, 'retry');
  await assert.rejects(planBuildRecovery(f.options), { code: 'BUILD_RECOVERY_CONSUMED' });
});

test('broken chain, later stage, parent lock and changed reservation fail before Docker', async t => {
  const f = await fixture(t);
  const failedPath = path.join(f.old.output, 'build.result.json'), original = await readFile(failedPath);
  const altered = JSON.parse(original); altered.reasonCode = 'DOCKER_ABORTED';
  await save(failedPath, altered);
  await assert.rejects(planBuildRecovery(f.options));
  await writeFile(failedPath, original);
  for (const name of ['scan.intent.json', '.mcp-execution-host.lock']) {
    const filename = path.join(f.old.output, name);
    await save(filename, {});
    await assert.rejects(planBuildRecovery(f.options));
    await rm(filename);
  }
  const directory = path.join(f.root, '.mcp-execution-host-targets');
  const filename = path.join(directory, (await readdir(directory))[0]), reservation = await json(filename);
  reservation.plan = 'foreign-plan'; await save(filename, reservation);
  await assert.rejects(planBuildRecovery(f.options), { code: 'BUILD_RECOVERY_RESERVATION_MISMATCH' });
  assert.equal(f.calls.length, 0);
});

async function changeHistoricalSource(f, edit) {
  const files = { ...f.source.files };
  edit(files); sealRecipeFiles(files, f.source.input.recipe);
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(f.options.project, ...name.split('/')), bytes);
  f.config.sourceManifestDigest = JSON.parse(files['recipe-manifest.json']).contentDigest;
  await save(f.options.config, f.config);
  f.oldPlan.scope.sourceManifestDigest = f.config.sourceManifestDigest;
  f.oldPlan.scope.producerBuild = `sha256:${'0'.repeat(64)}`;
  f.oldPlan.approvalToken = `mcp-host-execution/${digest(f.oldPlan.scope)}`;
  f.config.oldHostApproval = f.oldPlan.approvalToken;
  await save(f.options.config, f.config); await save(path.join(f.old.output, 'plan.json'), f.oldPlan);
  let previous = f.oldPlan.approvalToken;
  for (const stage of ['identity', 'preflight', 'build']) {
    const intentPath = path.join(f.old.output, `${stage}.intent.json`), resultPath = path.join(f.old.output, `${stage}.result.json`);
    const intent = seal({ ...await json(intentPath), plan: f.oldPlan.approvalToken, previous });
    const result = seal({ ...await json(resultPath), plan: f.oldPlan.approvalToken, intentDigest: intent.contentDigest });
    await save(intentPath, intent); await save(resultPath, result);
    previous = result.contentDigest;
  }
  const directory = path.join(f.root, '.mcp-execution-host-targets');
  for (const name of await readdir(directory)) {
    const filename = path.join(directory, name);
    await save(filename, { ...await json(filename), plan: f.oldPlan.approvalToken });
  }
}
test('historical metadata stays sealed but modified executable input cannot be recovered', async t => {
  const f = await fixture(t);
  await changeHistoricalSource(f, files => {
    const review = JSON.parse(files['recipe-review.json']); review.historicalNote = 'synthetic older generator';
    files['recipe-review.json'] = Buffer.from(JSON.stringify(review));
  });
  const parent = await snapshot(f.old.output);
  const { result } = await execute(f);
  assert.equal(result.status, 'built-unqualified');
  assert.deepEqual(await snapshot(f.old.output), parent);
  const g = await fixture(t);
  await changeHistoricalSource(g, files => { files.Dockerfile = Buffer.concat([files.Dockerfile, Buffer.from('\nRUN echo forbidden\n')]); });
  await assert.rejects(planBuildRecovery(g.options), { code: 'BUILD_RECOVERY_SOURCE_MISMATCH' });
  assert.equal(g.calls.length, 0);
});

test('CLI exposes recovery JSON and stderr review without accepting cloud flags', async t => {
  const f = await fixture(t), out = [], err = [];
  t.mock.method(process.stdout, 'write', text => { out.push(String(text)); return true; });
  t.mock.method(process.stderr, 'write', text => { err.push(String(text)); return true; });
  assert.equal(await main(['mcp-build-recovery-schema', '--json']), 0);
  assert.equal(JSON.parse(out.join('')).additionalProperties, false);
  out.length = 0;
  const selected = ['--workspace-root', f.root, '--project', f.options.project, '--config', f.options.config, '--output', f.options.output];
  assert.equal(await main(['mcp-build-recovery-plan', ...selected, '--json', '--summary']), 0);
  const plan = JSON.parse(out.join(''));
  assert.equal(plan.scope.kind, 'mcp-build-recovery-plan');
  assert.match(err.join(''), /EXACT approvalToken:/);
  assert.equal(f.calls.length, 0);
  out.length = 0;
  assert.notEqual(await main(['mcp-build-recovery-run', ...selected, '--approve', plan.approvalToken,
    '--allow-local', '--allow-network', '--allow-cloud']), 0);
});
