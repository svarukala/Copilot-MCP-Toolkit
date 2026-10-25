import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { TOOLKIT_ROOT, withCliWorkspace } from '../src/config.js';
import { planHostingRecipe, writeHostingRecipe } from '../src/mcp-container-apps.js';
import { readRecipeProject, planRecipeRelease } from '../src/mcp-recipe-artifacts.js';
import { planHostExecution, runHostExecution, hostExecutionSchema, describeHostExecution } from '../src/mcp-execution-host.js';
import { executionDockerRequest, executionTar, executionTarFile, executionJson } from '../src/mcp-execution-docker.js';
import { sealRecipeFiles } from '../src/mcp-recipe-artifacts.js';
import { createSyntheticExecutionHost } from './support/execution-host.js';

const imageId = `sha256:${'a'.repeat(64)}`, imageDigest = `sha256:${'b'.repeat(64)}`;
const scannerImage = `aquasec/trivy@sha256:${'c'.repeat(64)}`;
const socket = String.raw`\\.\pipe\docker_engine`;
const response = (value, status = 200) => ({ status, body: Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)) });
const flags = { allowLocal: true, allowCloud: true, allowNetwork: true };
const secret = 'synthetic-registry-token-never-persist';
async function fixture(t, { gateway = false, key = false, login = false } = {}) {
  const root = path.join(TOOLKIT_ROOT, '.test-output', `host-execution-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = JSON.parse(await readFile(new URL('../examples/mcp/container-apps-direct.json', import.meta.url)));
  source.imageBuild = { builderImage: `node:22-bookworm-slim@sha256:${'d'.repeat(64)}`,
    runtimeImage: `gcr.io/distroless/nodejs22-debian13:nonroot@sha256:${'e'.repeat(64)}`, platform: 'linux/amd64' };
  if (gateway) {
    source.recipe = 'container-apps-apim-v1';
    source.azure.gateway = { serviceName: 'synthetic-apim', resourceGroup: 'synthetic-gateway-rg',
      apiName: 'reviewed-mcp', path: 'reviewed-mcp', audience: '88888888-8888-4888-8888-888888888888',
      applicationIdUri: 'api://88888888-8888-4888-8888-888888888888',
      principalId: '99999999-9999-4999-8999-999999999999', role: 'Mcp.Gateway' };
  }
  if (key) source.backend = { origin: source.backend.origin, auth: 'api-key', apiKey: {
    tenantId: source.azure.tenantId,
    keyVaultResourceId: `/subscriptions/${source.azure.subscriptionId}/resourceGroups/synthetic-rg/providers/Microsoft.KeyVault/vaults/synthetic-vault`,
    identityResourceId: `/subscriptions/${source.azure.subscriptionId}/resourceGroups/synthetic-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/synthetic-key`,
    secretIdentifier: 'https://synthetic-vault.vault.azure.net/secrets/backend-key',
    headerName: 'X-Api-Key', sharedAccessReviewed: true,
  } };
  const input = path.join(root, 'source.json'), project = path.join(root, 'source');
  await writeFile(input, JSON.stringify(source));
  const generation = { workspaceRoot: root, config: input, output: project };
  await writeHostingRecipe({ ...generation, approval: (await planHostingRecipe(generation)).approvalToken });
  const identityProject = path.join(root, 'identity');
  await mkdir(identityProject);
  const config = { schemaVersion: 1, azureIdentityProject: identityProject, accountName: 'operator@example.com',
    dockerSocket: socket, localEngineTrusted: true, scannerImage, imageRepository: 'reviewed/mcp',
    expiresAt: new Date(Date.now() + 3600000).toISOString(), downloadsReviewed: true,
    resourceCeilingsReviewed: true, createOnlyReviewed: true, ...(login ? { privateLoginReviewed: true } : {}) };
  const options = { workspaceRoot: root, project, config: path.join(root, 'host.json'), output: path.join(root, 'run') };
  await writeFile(options.config, JSON.stringify(config));
  const synthetic = await createSyntheticExecutionHost({ workspaceRoot: root, project, host: config, seedIdentity: !login });
  return { root, options, config, ...synthetic,
    save: () => writeFile(options.config, JSON.stringify(config)) };
}
async function execute(f) {
  const plan = await planHostExecution(f.options);
  return { plan, result: await runHostExecution({ ...f.options, ...flags, approval: plan.approvalToken }, f.dependencies) };
}

test('host config is closed, pins scanner and bounds resource/download approvals', () => {
  const validator = new Ajv(); addFormats(validator);
  const validate = validator.compile(hostExecutionSchema);
  assert.equal(hostExecutionSchema.additionalProperties, false);
  assert.equal(validate({ schemaVersion: 1, accountName: 'operator@example.com', dockerSocket: socket,
    localEngineTrusted: true, scannerImage, imageRepository: 'bounded/mcp',
    expiresAt: new Date().toISOString(), downloadsReviewed: true, resourceCeilingsReviewed: true, createOnlyReviewed: true }), true);
  assert.equal(validate({}), false);
});

test('initial host description is pure, explicit and does not inspect the identity project', () => {
  const source = { input: { recipe: 'container-apps-apim-v1', imageBuild: {
    builderImage: `node:22-bookworm-slim@sha256:${'d'.repeat(64)}`,
    runtimeImage: `gcr.io/distroless/nodejs22-debian13:nonroot@sha256:${'e'.repeat(64)}`,
  } }, review: { npmRegistryUrl: 'https://packages.example.com/npm/' },
  manifest: { files: { 'package-lock.json': imageId } } };
  const host = { schemaVersion: 1, accountName: 'operator@example.com', dockerSocket: socket,
    azureIdentityProject: 'Z:\\not-an-existing-identity', localEngineTrusted: true, scannerImage, imageRepository: 'bounded/mcp',
    expiresAt: '2000-01-01T00:00:00Z', downloadsReviewed: true, resourceCeilingsReviewed: true, createOnlyReviewed: true };
  const description = describeHostExecution(source, host);
  assert.equal(description.effective.maximumMs, 1800000);
  assert.equal(description.effective.identityProject, undefined);
  assert.equal(description.downloads.database, 'ghcr.io/aquasecurity/trivy-db:2');
  assert.equal(description.downloads.javaDatabase, 'ghcr.io/aquasecurity/trivy-java-db:1');
  assert.equal(description.downloads.npmRegistryUrl, source.review.npmRegistryUrl);
  assert.equal(description.readback.health.timeoutMs, 10000);
  assert.equal(description.readback.health.maximumBytes, 1024);
  assert.equal(description.scanPolicy.high, 0);
  description.readback.health.timeoutMs = 1;
  assert.equal(describeHostExecution(source, host).readback.health.timeoutMs, 10000);
  assert.equal(describeHostExecution(source, { ...host, maximumMs: 60000 }).effective.maximumMs, 60000);
});

for (const gateway of [false, true]) for (const key of [false, true]) {
  test(`real staged adapter uses only synthetic transports: gateway=${gateway}, key=${key}`, async t => {
    const f = await fixture(t, { gateway, key });
    const before = await readFile(path.join(f.options.project, 'recipe-manifest.json'));
    const planned = await planHostExecution(f.options);
    assert.equal(f.calls.length, 0, 'Planning must remain local');
    assert.equal(planned.scope.ceilings.invoiceCapEnforceable, false);
    const projection = await withCliWorkspace(f.root, () => readRecipeProject(f.options.project));
    assert.deepEqual(planned.scope.description, describeHostExecution(projection, f.config));
    const { result, plan } = await execute(f);
    assert.equal(result.status, 'passed', JSON.stringify(result));
    assert.equal(result.endpoint, gateway ? 'https://synthetic-apim.azure-api.net/reviewed-mcp/mcp'
      : `${result.backendOrigin}/mcp`);
    assert.equal(result.containerImage, `${f.source.azure.registry.server}/reviewed/mcp@${imageDigest}`);
    assert.equal(result.observedMilestones.secretResolution, key ? 'runtime-startup-and-health-confirmed' : 'not-applicable');
    assert.equal(f.calls.filter(call => call.system === 'health').length, 1);
    assert.ok(!f.calls.some(call => call.args?.some(arg => typeof arg === 'string' && arg.includes('.vault.azure.net/secrets/'))));
    assert.equal(f.resources.get(f.app).properties.template.containers[0].resources.cpu, 0.25);
    assert.equal(f.resources.get(f.app).properties.template.scale.maxReplicas, 1);
    const puts = f.calls.filter(call => call.system === 'azure' && call.args.includes('PUT'));
    assert.equal(puts.length, gateway ? 5 : 1);
    if (gateway) assert.ok(puts[2].args.find(arg => arg.includes('/policies/policy?')), 'Policy precedes routes');
    const smoke = f.calls.find(call => call.route?.includes('/containers/create?') && call.execution.body.User === '65532:65532');
    assert.equal(smoke.execution.body.NetworkDisabled, true);
    assert.equal(smoke.execution.body.HostConfig.NetworkMode, 'none');
    assert.equal(smoke.execution.body.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(smoke.execution.body.HostConfig.CapDrop, ['ALL']);
    assert.equal(f.containers.size, 0); assert.equal(f.volumes.size, 0);
    assert.deepEqual(await readFile(path.join(f.options.project, 'recipe-manifest.json')), before);
    const releaseConfig = path.join(f.root, 'release.json');
    await writeFile(releaseConfig, JSON.stringify({ schemaVersion: 1, accountName: f.config.accountName,
      containerImage: result.containerImage, imageReviewFile: result.imageReviewFile,
      ...(gateway ? { backendOrigin: result.backendOrigin } : {}) }));
    const release = await planRecipeRelease({ ...f.options, config: releaseConfig, output: path.join(f.root, 'release') });
    assert.equal(release.review.imageQualification.image, result.containerImage);
    for (const filename of await readdir(f.options.output)) {
      const bytes = await readFile(path.join(f.options.output, filename), 'utf8');
      assert.ok(!bytes.includes(secret));
      if (!filename.endsWith('.private.json')) assert.ok(!bytes.includes('synthetic-linux'));
    }
    const count = f.calls.length;
    assert.deepEqual(await runHostExecution({ ...f.options, ...flags, approval: plan.approvalToken }, f.dependencies), result);
    assert.equal(f.calls.length, count, 'Completed immutable stages must not replay Docker or Azure');
  });
}

test('zero high policy failure is consumed and never pushes or creates resources', async t => {
  const f = await fixture(t);
  f.findings.push({ Severity: 'HIGH', VulnerabilityID: 'SYNTHETIC-1', Description: secret });
  const { result, plan } = await execute(f);
  assert.equal(result.status, 'unknown-no-replay'); assert.equal(result.stage, 'scan');
  assert.ok(!f.calls.some(call => call.route?.includes('/push?') || call.args?.includes('PUT')));
  const count = f.calls.length;
  await assert.rejects(runHostExecution({ ...f.options, ...flags, approval: plan.approvalToken }, f.dependencies),
    { code: 'HOST_EXECUTION_CONSUMED' });
  assert.equal(f.calls.length, count);
  const summary = await readFile(path.join(f.options.output, 'scan.result.json'), 'utf8');
  assert.ok(!summary.includes(secret));
  assert.ok((await readFile(path.join(f.options.output, 'scanner.private.json'), 'utf8')).includes(secret));
});

test('a zero-finding but incomplete scanner report is not image qualification', async t => {
  const f = await fixture(t), original = f.dependencies.dockerRequest;
  f.dependencies.dockerRequest = (socket, route, options) => {
    if (route.includes('/archive?') && route.endsWith('report.json')) return response(executionTar({
      'report.json': JSON.stringify({ SchemaVersion: 2, ArtifactType: 'container_image',
        Metadata: { ImageID: imageId, OS: { Family: 'debian' } },
        Results: [{ Class: 'os-pkgs', Type: 'debian', Packages: [{ Name: 'synthetic' }], Vulnerabilities: [] }] }),
    }));
    return original(socket, route, options);
  };
  const { result } = await execute(f);
  assert.equal(result.stage, 'scan');
  assert.equal(result.status, 'unknown-no-replay');
  assert.ok(!f.calls.some(call => call.route?.includes('/push?') || call.args?.includes('PUT')));
});

test('unknown push outcome persists sanitized barrier and new output cannot replay target', async t => {
  const f = await fixture(t);
  const original = f.dependencies.dockerRequest;
  f.dependencies.dockerRequest = (socket, route, execution) => {
    if (route.includes('/push?')) throw new Error(`uncertain ${secret}`);
    return original(socket, route, execution);
  };
  const { result } = await execute(f);
  assert.equal(result.stage, 'push'); assert.equal(result.status, 'unknown-no-replay');
  assert.ok(!JSON.stringify(result).includes(secret));
  const other = { ...f.options, output: path.join(f.root, 'replacement') };
  const plan = await planHostExecution(other), count = f.calls.length;
  await assert.rejects(runHostExecution({ ...other, ...flags, approval: plan.approvalToken }, f.dependencies),
    { code: 'HOST_EXECUTION_CONSUMED' });
  assert.equal(f.calls.length, count);
});

test('existing app and gateway targets stop before download and are never overwritten', async t => {
  for (const gateway of [false, true]) {
    const f = await fixture(t, { gateway });
    f.resources.set(gateway ? `${f.service}/apis/${f.source.azure.gateway.apiName}` : f.app,
      { id: 'existing-unowned', properties: {} });
    const before = structuredClone([...f.resources]);
    const { result } = await execute(f);
    assert.equal(result.stage, 'preflight');
    assert.ok(!f.calls.some(call => call.route?.includes('/build?') || call.args?.includes('PUT')));
    assert.deepEqual([...f.resources], before);
  }
});

test('altered sealed Dockerfile cannot be authorized by resealing an edited manifest', async t => {
  const f = await fixture(t);
  const source = await withCliWorkspace(f.root, () => readRecipeProject(f.options.project));
  const files = Object.fromEntries(Object.entries(source.files).map(([name, value]) => [name, value.toString('utf8')]));
  files.Dockerfile += '\nRUN echo unapproved\n';
  sealRecipeFiles(files, source.input.recipe);
  await writeFile(path.join(f.options.project, 'Dockerfile'), files.Dockerfile);
  await writeFile(path.join(f.options.project, 'recipe-manifest.json'), files['recipe-manifest.json']);
  await assert.rejects(planHostExecution(f.options), { code: 'HOST_EXECUTION_SOURCE_MISMATCH' });
  assert.equal(f.calls.length, 0);
});

test('approval, changed configuration, expiry and wrong private identity deny before execution', async t => {
  const f = await fixture(t), plan = await planHostExecution(f.options);
  await assert.rejects(runHostExecution({ ...f.options, ...flags, approval: 'wrong' }, f.dependencies),
    { code: 'HOST_EXECUTION_APPROVAL_REQUIRED' });
  f.config.imageRepository = 'changed'; await f.save();
  await assert.rejects(runHostExecution({ ...f.options, ...flags, approval: plan.approvalToken }, f.dependencies),
    { code: 'HOST_EXECUTION_APPROVAL_REQUIRED' });
  f.config.accountName = 'another@example.com'; await f.save();
  await assert.rejects(planHostExecution(f.options), { code: 'HOST_EXECUTION_IDENTITY_MISMATCH' });
  f.config.accountName = 'operator@example.com'; f.config.expiresAt = '2000-01-01T00:00:00Z'; await f.save();
  const expired = await planHostExecution(f.options);
  await assert.rejects(runHostExecution({ ...f.options, ...flags, approval: expired.approvalToken }, f.dependencies),
    { code: 'HOST_EXECUTION_EXPIRED' });
  assert.equal(f.calls.length, 0);
});

test('reviewed missing identity uses only one private device login and never persists the challenge', async t => {
  const f = await fixture(t, { login: true });
  const plan = await planHostExecution(f.options), challenges = [];
  assert.equal(f.calls.length, 0);
  assert.equal(plan.requiresSignIn, true);
  assert.deepEqual(await runHostExecution({ ...f.options, ...flags, approval: plan.approvalToken }, f.dependencies),
    { status: 'sign-in-required' });
  assert.equal(f.calls.length, 0);
  const result = await runHostExecution({ ...f.options, ...flags, approval: plan.approvalToken,
    onDeviceCode: value => challenges.push(value) }, f.dependencies);
  assert.equal(result.status, 'passed');
  assert.equal(challenges.length, 1);
  assert.equal(f.calls.filter(call => call.args?.[0] === 'login').length, 1);
  const count = f.calls.length;
  assert.equal((await runHostExecution({ ...f.options, ...flags, approval: plan.approvalToken,
    onDeviceCode: () => assert.fail('no second sign-in') }, f.dependencies)).status, 'passed');
  assert.equal(f.calls.length, count);
  for (const file of await readdir(f.options.output))
    assert.ok(!(await readFile(path.join(f.options.output, file), 'utf8')).includes('ABCDE1234'));
});

test('missing unreviewed identity never signs out, selects accounts or imports another profile', async t => {
  const f = await fixture(t, { login: true });
  delete f.config.privateLoginReviewed; await f.save();
  await assert.rejects(planHostExecution(f.options), { code: 'HOST_EXECUTION_IDENTITY_REQUIRED' });
  assert.equal(f.calls.length, 0);
});

test('pending private identity is not mistaken for an absent identity or silently replaced', async t => {
  const f = await fixture(t, { login: true });
  await writeFile(path.join(f.config.azureIdentityProject, '.azure-identity.json'), JSON.stringify({
    schemaVersion: 1, status: 'pending', epoch: randomUUID(), target: {
      tenantId: f.source.azure.tenantId, subscriptionId: f.source.azure.subscriptionId, accountName: 'other@example.com',
    },
  }));
  await assert.rejects(planHostExecution(f.options), { code: 'HOST_EXECUTION_IDENTITY_UNRESOLVED' });
  assert.equal(f.calls.length, 0);
});

test('omitted identity location means source while relative configured locations are rejected', async t => {
  const f = await fixture(t, { login: true });
  delete f.config.azureIdentityProject; await f.save();
  const plan = await planHostExecution(f.options);
  assert.equal(plan.scope.effective.identityProject, f.options.project);
  assert.equal(plan.requiresSignIn, true);
  f.config.azureIdentityProject = '..\\identity'; await f.save();
  await assert.rejects(planHostExecution(f.options), { code: 'HOST_EXECUTION_INVALID' });
  assert.equal(f.calls.length, 0);
});

test('a dispatched Azure failure is consumed even when the target was created', async t => {
  const f = await fixture(t), original = f.dependencies.runAzure;
  f.dependencies.runAzure = async (name, args, options) => {
    const value = await original(name, args, options);
    if (args.includes('PUT')) throw new Error(`lost response ${secret}`);
    return value;
  };
  const { result, plan } = await execute(f);
  assert.equal(result.stage, 'app'); assert.equal(result.status, 'unknown-no-replay');
  assert.ok(f.resources.has(f.app));
  const count = f.calls.length;
  await assert.rejects(runHostExecution({ ...f.options, ...flags, approval: plan.approvalToken }, f.dependencies),
    { code: 'HOST_EXECUTION_CONSUMED' });
  assert.equal(f.calls.length, count);
  assert.ok(!(await readFile(path.join(f.options.output, 'app.result.json'), 'utf8')).includes(secret));
});

test('wrong app domain or unhealthy running revision never produces a passed deployment', async t => {
  for (const mismatch of ['domain', 'revision']) {
    const f = await fixture(t), original = f.dependencies.runAzure;
    f.dependencies.runAzure = async (name, args, options) => {
      const value = await original(name, args, options);
      if (args.includes('GET') && value?.id === f.app && mismatch === 'domain')
        value.properties.configuration.ingress.fqdn = 'unapproved.example.com';
      if (args.includes('GET') && value?.id?.includes('/revisions/') && mismatch === 'revision')
        value.properties.provisioningState = 'Failed';
      return value;
    };
    const { result } = await execute(f);
    assert.equal(result.status, 'unknown-no-replay');
    assert.equal(result.stage, mismatch === 'domain' ? 'app' : 'app-readiness');
    assert.equal(result.endpoint, undefined);
  }
});

test('direct health rejects failed, redirected, malformed and oversized responses without retry', async t => {
  for (const kind of ['failure', 'redirect', 'body', 'type', 'declared-size', 'stream-size']) {
    const f = await fixture(t, { key: true });
    let attempts = 0, cancelled = false;
    f.dependencies.healthTransport = async (endpoint, options) => {
      attempts++;
      assert.equal(endpoint, `https://${f.source.azure.appName}.synthetic.eastus.azurecontainerapps.io/health`);
      assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
      const headers = { 'content-type': 'application/json' };
      if (kind === 'failure') return new Response(secret, { status: 503, headers });
      if (kind === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://unapproved.example.com/health' } });
      if (kind === 'body') return new Response(`{"status":"up","extra":"${secret}"}`, { headers });
      if (kind === 'type') return new Response('{"status":"up"}', { headers: { 'content-type': 'text/plain' } });
      if (kind === 'declared-size') return new Response('{"status":"up"}', { headers: { ...headers, 'content-length': '1025' } });
      return new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(2048)); },
        cancel() { cancelled = true; },
      }), { headers });
    };
    const { result, plan } = await execute(f);
    assert.equal(result.status, 'unknown-no-replay'); assert.equal(result.stage, 'app-health');
    assert.equal(attempts, 1);
    if (kind === 'stream-size') assert.equal(cancelled, true);
    await assert.rejects(runHostExecution({ ...f.options, ...flags, approval: plan.approvalToken }, f.dependencies),
      { code: 'HOST_EXECUTION_CONSUMED' });
    assert.equal(attempts, 1);
    assert.equal(result.endpoint, undefined);
    assert.ok(!(await readFile(path.join(f.options.output, 'app-health.result.json'), 'utf8')).includes(secret));
  }
});

test('health total deadline covers stalled response body and cancels it with no retry', async t => {
  const f = await fixture(t, { key: true });
  let attempts = 0, cancelled = false, requestSignal;
  f.dependencies.healthTransport = async (_endpoint, options) => {
    attempts++; requestSignal = options.signal;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }),
      { headers: { 'content-type': 'application/json' } });
  };
  const { result } = await execute(f);
  assert.equal(result.stage, 'app-health'); assert.equal(result.status, 'unknown-no-replay');
  assert.equal(attempts, 1); assert.equal(requestSignal.aborted, true); assert.equal(cancelled, true);
});

test('Azure display-name location readback is canonicalized, but a different region is rejected', async t => {
  for (const matches of [true, false]) {
    const f = await fixture(t), original = f.dependencies.runAzure;
    assert.equal(f.source.azure.location, 'eastus');
    // The source fixture already selects eastus; only cloud readback is changed.
    f.resources.get(f.source.azure.environmentResourceId).location = matches ? 'East US' : 'West US';
    f.dependencies.runAzure = async (name, args, options) => {
      const result = await original(name, args, options);
      if (args.includes('GET') && result?.id === f.app) result.location = 'EAST US';
      return result;
    };
    const { result } = await execute(f);
    assert.equal(result.status, matches ? 'passed' : 'unknown-no-replay');
    if (!matches) assert.equal(result.stage, 'preflight');
  }
});

test('gateway inherited logging and policy changes remain untouched and block creation', async t => {
  const f = await fixture(t, { gateway: true });
  f.resources.set(`${f.service}/diagnostics`, { value: [{ properties: {
    frontend: { request: { headers: ['Authorization'] } },
  } }] });
  const before = structuredClone([...f.resources]);
  const { result } = await execute(f);
  assert.equal(result.stage, 'preflight');
  assert.deepEqual([...f.resources], before);
  assert.ok(!f.calls.some(call => call.args?.includes('PUT') || call.route?.includes('/build?')));
});

test('exclusive locks and incomplete immutable intent prevent any dispatch', async t => {
  const f = await fixture(t), plan = await planHostExecution(f.options);
  await mkdir(f.options.output);
  await writeFile(path.join(f.options.output, '.mcp-execution-host.lock'), '{"pid":123}');
  await assert.rejects(runHostExecution({ ...f.options, ...flags, approval: plan.approvalToken }, f.dependencies),
    { code: 'HOST_EXECUTION_LOCKED' });
  assert.equal(f.calls.length, 0);
  assert.equal(await readFile(path.join(f.options.output, '.mcp-execution-host.lock'), 'utf8'), '{"pid":123}');
  const other = await fixture(t), otherPlan = await planHostExecution(other.options);
  await mkdir(other.options.output);
  await writeFile(path.join(other.options.output, 'plan.json'), JSON.stringify(otherPlan));
  await writeFile(path.join(other.options.output, 'identity.intent.json'), '{"interrupted":');
  await assert.rejects(runHostExecution({ ...other.options, ...flags, approval: otherPlan.approvalToken }, other.dependencies),
    { code: 'HOST_EXECUTION_CONSUMED' });
  assert.equal(other.calls.length, 0);
  assert.equal(await readFile(path.join(other.options.output, 'identity.intent.json'), 'utf8'), '{"interrupted":');
});

test('binary Docker transport and tar reader are bounded and shell-free', async () => {
  const archive = executionTar({ 'report.json': '{"bounded":true}' });
  assert.deepEqual(executionTarFile(archive, 'report.json'), Buffer.from('{"bounded":true}'));
  assert.throws(() => executionTarFile(archive, '../report.json'));
  const corrupt = Buffer.from(archive); corrupt[1] ^= 1;
  assert.throws(() => executionTarFile(corrupt, 'report.json'));
  assert.throws(() => executionTar({ '../escape': 'x' }));
  const received = [];
  const requestImpl = (options, receive) => {
    received.push(options);
    const req = new EventEmitter();
    req.destroy = error => req.emit('error', error);
    req.end = body => {
      received.push(body);
      const stream = Readable.from([Buffer.from('{"passed":true}')]);
      stream.statusCode = 200; receive(stream);
    };
    return req;
  };
  assert.deepEqual(executionJson(await executionDockerRequest(socket, '/v1.44/build?version=1', {
    method: 'POST', body: archive,
  }, { requestImpl })), { passed: true });
  assert.equal(received[0].socketPath, socket);
  assert.equal(received[0].headers['Content-Type'], 'application/x-tar');
  assert.deepEqual(received[1], archive);
  await assert.rejects(executionDockerRequest(socket, '/version', { maxBytes: 1 }, { requestImpl }),
    { code: 'DOCKER_OUTPUT_LIMIT' });
  await assert.rejects(executionDockerRequest('tcp://untrusted:2375', '/version', {}, { requestImpl }));
});
