import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { assertProjectPath, withCliWorkspace } from './config.js';
import { boundedSnapshot, metadataDigest, requireMetadata } from './anonymous-metadata.js';
import { readControl, writeControl, withControlLock, controlOutput } from './mcp-control.js';
import { readRecipeProject } from './mcp-recipe-artifacts.js';
import { getLibraryInfo } from './machine-contract.js';
import { readAzureIdentity, azureIdentityGuard, validateAzureAccountTarget, planAzureAccountSwitch, switchAzureAccount } from './azure-identity.js';
import { runAzureCommand } from './azure.js';
import { dockerSocketSchema, dockerEngineRequest, dockerJson, dockerError, registryAuthHeader } from './docker-engine.js';
import { registryProbeSchema, registryProbeTarget, npmProbe, registryContainerCode } from './npm-registry-diagnostic.js';

const object = (properties, optional = {}) => ({ type: 'object', additionalProperties: false,
  properties: { ...properties, ...optional }, required: Object.keys(properties) });
const base = { schemaVersion: { const: 1 } };
const engine = { dockerSocket: dockerSocketSchema, localEngineTrusted: { const: true } };
export const hostOperationSchema = { oneOf: [
  object({ ...base, kind: { const: 'engine-diagnostic' }, ...engine }),
  object({ ...base, kind: { const: 'host-npm-diagnostic' } }, { registryProbe: registryProbeSchema }),
  object({ ...base, kind: { const: 'container-npm-diagnostic' }, ...engine,
    image: { type: 'string', pattern: '^node:22-bookworm-slim@sha256:[a-f0-9]{64}$' } }, { registryProbe: registryProbeSchema }),
  object({ ...base, kind: { const: 'private-image-pull' }, ...engine,
    image: { type: 'string', maxLength: 512, pattern: '^[a-z0-9]+\\.azurecr\\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$' },
    accountName: { type: 'string', format: 'email', maxLength: 254 } }),
] };
const ajv = new Ajv(); addFormats(ajv);
const valid = ajv.compile(hostOperationSchema);
const digest = value => metadataDigest(boundedSnapshot(value));
const api = '/v1.44';
async function absent(filename) {
  await assertProjectPath(filename);
  try { await lstat(filename); throw Object.assign(new Error('Output or prior pull reservation exists; preserve it and reconcile, never overwrite or replay.'),
    { code: 'HOST_OPERATION_CONSUMED' }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function prepare(options) {
  const projectDir = await assertProjectPath(path.resolve(options.project));
  requireMetadata((await lstat(projectDir)).isDirectory(), 'INVALID_CONFIG');
  const input = await readControl(path.resolve(options.config));
  requireMetadata(valid(input), 'INVALID_CONFIG');
  const registryProbe = ['host-npm-diagnostic', 'container-npm-diagnostic'].includes(input.kind)
    ? registryProbeTarget(input.registryProbe) : undefined;
  const output = await assertProjectPath(path.resolve(options.output));
  requireMetadata(path.extname(output) === '.json' && (await lstat(path.dirname(output))).isDirectory(), 'INVALID_CONFIG');
  await absent(output); await absent(`${output}.intent.json`);
  let sourceManifestDigest, identity, reservation;
  if (input.kind === 'private-image-pull') {
    const source = await readRecipeProject(projectDir);
    requireMetadata(source.input.recipe !== 'functions-sdk-v1'
      && input.image.startsWith(`${source.input.azure.registry.server}/`), 'INVALID_CONFIG');
    identity = await readAzureIdentity({ azure: source.input.azure }, projectDir, { required: true });
    requireMetadata(identity.target.accountName === input.accountName.toLowerCase(), 'INVALID_CONFIG');
    sourceManifestDigest = source.manifest.contentDigest;
    reservation = path.join(projectDir, '.mcp-host-operations',
      `${digest({ image: input.image, socket: input.dockerSocket }).slice(7)}.json`);
    await absent(reservation);
  }
  const body = { action: 'mcp-host-run', projectDir, output, input,
    ...(registryProbe ? { registryProbe } : {}),
    ...(identity ? { identity, sourceManifestDigest, reservation } : {}),
    producerBuild: (await getLibraryInfo()).contentDigest,
    maximumMs: input.kind === 'private-image-pull' ? 600000 : 60000,
    cleanupMaximumMs: input.kind === 'container-npm-diagnostic' ? 20000 : 0,
    networkRequired: input.kind !== 'engine-diagnostic', cloudRequired: input.kind === 'private-image-pull',
    localEngineRequired: input.kind !== 'host-npm-diagnostic',
    effects: input.kind === 'private-image-pull'
      ? ['Verify the selected project-private Azure user; obtain a transient ACR credential without Docker login.',
        'Reserve this exact image/engine purpose before dispatch. Pull the exact digest into the explicitly trusted local daemon.',
        'Keep credentials only in process memory and the local daemon request; never print/save them. No image execution.',
        'Timeout or ambiguous response stays consumed. A new output name does not authorize another pull.']
      : [input.kind === 'container-npm-diagnostic'
        ? `Run a previously present, explicitly reviewed Node image as a temporary restricted container; one ${registryProbe.kind} HTTPS probe to ${registryProbe.endpoint}, then remove only that owned container.`
        : input.kind === 'host-npm-diagnostic' ? `One ${registryProbe.kind} DNS/TLS/HTTP probe to ${registryProbe.endpoint} from this Node process; no package installation.`
          : 'Read only the explicitly selected local Docker engine version; no process start or context change.',
      'No auto-pull, build, TLS bypass, dependency install, provider call or paid cloud fallback.'] };
  return boundedSnapshot({ ...body, approvalDigest: digest(body) });
}
function scoped(options, action) {
  requireMetadata(['workspaceRoot', 'project', 'config', 'output'].every(key => typeof options[key] === 'string'), 'INVALID_CONFIG');
  return withCliWorkspace(options.workspaceRoot, action);
}
export const planHostOperation = options => scoped(options, () => prepare(options));
export async function hostingAccount(projectDir, requested, options = {}, execute = false) {
  const source = await readRecipeProject(projectDir);
  const target = validateAzureAccountTarget(requested);
  requireMetadata(target.tenantId === source.input.azure.tenantId.toLowerCase()
    && target.subscriptionId === source.input.azure.subscriptionId.toLowerCase(), 'INVALID_CONFIG');
  return (execute ? switchAzureAccount : planAzureAccountSwitch)(source.projectDir, target, options);
}

async function inspectEngine(call) {
  const value = dockerJson(await call('/version'));
  requireMetadata(value.Os === 'linux' && ['amd64', 'x86_64'].includes(value.Arch)
    && /^1\.[0-9]+$/.test(value.ApiVersion) && Number(value.ApiVersion.split('.')[1]) >= 44
    && (value.MinAPIVersion === undefined || /^1\.[0-9]+$/.test(value.MinAPIVersion)
      && Number(value.MinAPIVersion.split('.')[1]) <= 44), 'DOCKER_PLATFORM_UNSUPPORTED');
  return { status: 'passed', os: 'linux', architecture: 'amd64', apiVersion: value.ApiVersion };
}
async function containerProbe(input, target, call, cleanupCall, owner) {
  const image = dockerJson(await call(`${api}/images/${encodeURIComponent(input.image)}/json`));
  requireMetadata(image.Os === 'linux' && image.Architecture === 'amd64'
    && image.RepoDigests?.some(value => [input.image.replace('node:22-bookworm-slim@', 'node@'),
      input.image.replace('node:22-bookworm-slim@', 'docker.io/library/node@')].includes(value)), 'DOCKER_IMAGE_MISMATCH');
  const name = `copilot-mcp-probe-${randomUUID()}`;
  let attempted = false, result, failure;
  try {
    attempted = true;
    const created = dockerJson(await call(`${api}/containers/create?name=${name}`, { method: 'POST', body: {
      Image: input.image, Entrypoint: ['node'], Cmd: ['-e', registryContainerCode(target)], User: '65532:65532',
      Env: [], WorkingDir: '/', Labels: { 'copilot-mcp-probe': owner }, NetworkDisabled: false,
      HostConfig: { ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
        NetworkMode: 'bridge', Memory: 134217728, NanoCpus: 1000000000, PidsLimit: 32,
        LogConfig: { Type: 'none' }, AutoRemove: false },
    } }), 201);
    requireMetadata(/^[a-f0-9]{64}$/.test(created.Id), 'DOCKER_RESPONSE_INVALID');
    const started = await call(`${api}/containers/${created.Id}/start`, { method: 'POST' });
    requireMetadata(started.status === 204, 'DOCKER_START_FAILED');
    const waited = dockerJson(await call(`${api}/containers/${created.Id}/wait?condition=not-running`, {
      method: 'POST', timeoutMs: 20000,
    }));
    requireMetadata(!waited.Error && Number.isInteger(waited.StatusCode), 'DOCKER_RESPONSE_INVALID');
    result = { status: waited.StatusCode === 0 ? 'passed' : 'failed',
      stage: ({ 0: 'http', 2: 'dns', 3: 'tls', 4: 'timeout', 5: 'http', 6: 'network-policy' })[waited.StatusCode] ?? 'container-execution' };
  } catch (error) { failure = error; }
  if (attempted) {
    try {
      const found = await cleanupCall(`${api}/containers/${name}/json`);
      if (found.status !== 404) {
        const owned = dockerJson(found);
        requireMetadata(owned.Config?.Labels?.['copilot-mcp-probe'] === owner
          && /^[a-f0-9]{64}$/.test(owned.Id), 'DOCKER_CLEANUP_OWNERSHIP');
        requireMetadata((await cleanupCall(`${api}/containers/${owned.Id}?force=true`, { method: 'DELETE' })).status === 204,
          'DOCKER_CLEANUP_UNKNOWN');
      }
    } catch {
      throw Object.assign(dockerError('DOCKER_CLEANUP_UNKNOWN'), { containerName: name });
    }
  }
  if (failure) throw failure;
  return { ...result, cleanup: 'owned-container-removed-or-absent', image: input.image };
}
async function privatePull(plan, call, run, signal, reserve) {
  const source = await readRecipeProject(plan.projectDir);
  requireMetadata(source.manifest.contentDigest === plan.sourceManifestDigest, 'METADATA_MISMATCH');
  const guardedRun = (name, args, options) => run(name, args, { ...options, signal, allowInspectionRetry: false });
  const identityOptions = await azureIdentityGuard({ azure: source.input.azure }, plan.projectDir, plan.identity, guardedRun);
  const host = source.input.azure.registry.server;
  const daemon = dockerJson(await call(`${api}/info`));
  requireMetadata(daemon.Debug === false && daemon.RegistryConfig && Array.isArray(daemon.RegistryConfig.InsecureRegistryCIDRs)
    && daemon.RegistryConfig.InsecureRegistryCIDRs.every(cidr => ['127.0.0.0/8', '::1/128'].includes(cidr))
    && daemon.RegistryConfig.IndexConfigs?.[host]?.Secure !== false, 'DOCKER_INSECURE_REGISTRY');
  let credential;
  try {
    credential = controlOutput(await run('az', ['acr', 'login', '--name', host.split('.')[0],
      '--subscription', plan.identity.target.subscriptionId, '--expose-token', '--only-show-errors', '--output', 'json'],
    { ...identityOptions, signal, sensitiveOutput: true, boundedInspection: true, allowInspectionRetry: false }));
    requireMetadata(credential?.loginServer === host && typeof credential.accessToken === 'string'
      && /^[A-Za-z0-9._~+/-]{1,65536}={0,2}$/.test(credential.accessToken), 'REGISTRY_CREDENTIAL_INVALID');
    await azureIdentityGuard({ azure: source.input.azure }, plan.projectDir, plan.identity, guardedRun);
    requireMetadata((await readRecipeProject(plan.projectDir)).manifest.contentDigest === plan.sourceManifestDigest
      && !signal.aborted, 'METADATA_MISMATCH');
    const authorization = registryAuthHeader(host, credential.accessToken);
    await reserve();
    const response = await call(`${api}/images/create?fromImage=${encodeURIComponent(plan.input.image)}&platform=linux%2Famd64`, {
      method: 'POST', headers: { 'X-Registry-Auth': authorization }, timeoutMs: 540000, maxBytes: 8388608,
    });
    requireMetadata(response.status === 200 && response.text.trim(), 'DOCKER_PULL_UNKNOWN');
    for (const line of response.text.trim().split(/\r?\n/)) {
      let value;
      try { value = JSON.parse(line); } catch { throw dockerError('DOCKER_PULL_UNKNOWN'); }
      requireMetadata(![401, 403].includes(value?.errorDetail?.code), 'DOCKER_AUTHORIZATION_FAILED');
      requireMetadata(value && !value.error && !value.errorDetail, 'DOCKER_PULL_FAILED');
    }
    const image = dockerJson(await call(`${api}/images/${encodeURIComponent(plan.input.image)}/json`));
    requireMetadata(image.Os === 'linux' && image.Architecture === 'amd64'
      && image.RepoDigests?.includes(plan.input.image), 'DOCKER_IMAGE_MISMATCH');
    return { status: 'pulled-digest-verified-not-executed', image: plan.input.image, architecture: 'amd64' };
  } finally { credential = undefined; }
}
export const runHostOperation = (options, dependencies = {}) => scoped(options, async () => {
  const plan = await prepare(options);
  requireMetadata(options.approval === plan.approvalDigest
    && (!plan.networkRequired || options.allowNetwork === true)
    && (!plan.cloudRequired || options.allowCloud === true)
    && (!plan.localEngineRequired || options.allowLocal === true), 'APPROVAL_REQUIRED');
  requireMetadata((plan.networkRequired || options.allowNetwork === undefined)
    && (plan.cloudRequired || options.allowCloud === undefined)
    && (plan.localEngineRequired || options.allowLocal === undefined), 'INVALID_CONFIG');
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), plan.maximumMs);
  const requestEngine = dependencies.dockerRequest ?? dockerEngineRequest;
  const call = (route, input = {}) => requestEngine(plan.input.dockerSocket, route, { ...input, signal });
  const cleanupCall = (route, input = {}) => requestEngine(plan.input.dockerSocket, route, { ...input, timeoutMs: 10000 });
  try {
    return await withControlLock(plan.projectDir, async () => {
      requireMetadata((await prepare(options)).approvalDigest === plan.approvalDigest && !signal.aborted, 'METADATA_MISMATCH');
      const intent = { schemaVersion: 1, kind: 'mcp-host-operation-intent', plan,
        startedAt: new Date().toISOString(), status: 'started-no-replay' };
      await writeControl(`${plan.output}.intent.json`, intent, { create: true });
      let pullPrepared = false;
      const reserve = async () => {
        await assertProjectPath(path.dirname(plan.reservation));
        await mkdir(path.dirname(plan.reservation), { recursive: true, mode: 0o700 });
        pullPrepared = true;
        await writeControl(plan.reservation, { ...intent, intentDigest: digest(intent) }, { create: true });
      };
      let result;
      try {
        if (plan.localEngineRequired) await inspectEngine(call);
        result = plan.input.kind === 'private-image-pull'
          ? await privatePull(plan, call, dependencies.runAzure ?? runAzureCommand, signal, reserve)
          : plan.input.kind === 'host-npm-diagnostic'
            ? await (dependencies.npmProbe ?? npmProbe)(signal, plan.registryProbe)
            : plan.input.kind === 'container-npm-diagnostic'
              ? await containerProbe(plan.input, plan.registryProbe, call, cleanupCall, plan.approvalDigest)
              : { status: 'passed', stage: 'engine', os: 'linux', architecture: 'amd64' };
      } catch (error) {
        const known = /^(?:DOCKER_[A-Z_]+|AZURE_[A-Z_]+|REGISTRY_CREDENTIAL_INVALID|METADATA_MISMATCH)$/.test(error.code ?? '');
        result = { status: plan.cloudRequired ? pullPrepared ? 'unknown-no-replay' : 'blocked-before-pull' : 'failed',
          code: known ? error.code : 'HOST_OPERATION_FAILED',
          ...(error.code === 'DOCKER_CLEANUP_UNKNOWN' ? { cleanup: 'unknown', containerName: error.containerName } : {}) };
      }
      const body = { schemaVersion: 1, kind: 'mcp-host-operation-result', approvalDigest: plan.approvalDigest,
        intentDigest: digest(intent), result, finishedAt: new Date().toISOString(),
        liveDeploymentQualified: false, providerVerified: false };
      const report = boundedSnapshot({ ...body, contentDigest: digest(body) });
      await writeControl(plan.output, report, { create: true });
      return { ...report, output: plan.output };
    });
  } finally { clearTimeout(timer); controller.abort(); }
});
