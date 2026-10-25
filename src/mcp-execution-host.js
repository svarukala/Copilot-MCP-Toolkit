import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, lstat, open, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { assertProjectPath, withCliWorkspace } from './config.js';
import { boundedSnapshot, metadataDigest } from './anonymous-metadata.js';
import { readControl, writeControl, controlOutput } from './mcp-control.js';
import { readRecipeProject } from './mcp-recipe-artifacts.js';
import { planHostingRecipe } from './mcp-container-apps.js';
import { getLibraryInfo } from './machine-contract.js';
import { readAzureIdentity, azureIdentityGuard, planAzureAccountSwitch, switchAzureAccount } from './azure-identity.js';
import { runAzureCommand } from './azure.js';
import { dockerSocketSchema, registryAuthHeader } from './docker-engine.js';
import { reviewImage } from './mcp-image-review.js';
import { assertCompatibleGlobalPolicy, assertSafeDiagnostics, collectionItems, policyValue } from './apim-safety.js';
import { executionDockerRequest, executionJson, executionProgress, executionTar, executionTarFile,
  executionImageLimit, executionImageBinding } from './mcp-execution-docker.js';
import { publicHttpsTransport } from './anonymous-network.js';

const digest = value => metadataDigest(boundedSnapshot(value));
const bytesDigest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const requireHost = (ok, code = 'HOST_EXECUTION_INVALID') => {
  if (!ok) throw Object.assign(new Error(`Bounded host execution stopped (${code}); preserve the retained plan and attempts.`), { code });
};
const object = (properties, optional = {}) => ({ type: 'object', additionalProperties: false,
  properties: { ...properties, ...optional }, required: Object.keys(properties) });
export const hostExecutionSchema = object({
  schemaVersion: { const: 1 },
  accountName: { type: 'string', format: 'email', maxLength: 254 },
  dockerSocket: dockerSocketSchema,
  localEngineTrusted: { const: true },
  scannerImage: { type: 'string', pattern: '^aquasec/trivy@sha256:[a-f0-9]{64}$' },
  imageRepository: { type: 'string', maxLength: 120,
    pattern: '^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$' },
  expiresAt: { type: 'string', format: 'date-time' },
  downloadsReviewed: { const: true },
  resourceCeilingsReviewed: { const: true },
  createOnlyReviewed: { const: true },
}, {
  azureIdentityProject: { type: 'string', minLength: 1, maxLength: 1024,
    description: 'Absolute path to an existing project-private selected Azure identity; omission selects the source project.' },
  privateLoginReviewed: { const: true },
  maximumMs: { type: 'integer', minimum: 60000, maximum: 3600000 },
});
const ajv = new Ajv(); addFormats(ajv);
const valid = ajv.compile(hostExecutionSchema);
const api = '/v1.44';
const appVersion = '2025-01-01', apimVersion = '2024-05-01';
const buildFiles = ['Dockerfile', '.dockerignore', '.npmrc', 'package.json', 'package-lock.json',
  'runtime-config.json', 'server.js', 'runtime.js', 'build-runtime.mjs', 'LICENSE', 'THIRD-PARTY-NOTICES.md'];
const database = 'ghcr.io/aquasecurity/trivy-db:2';
const javaDatabase = 'ghcr.io/aquasecurity/trivy-java-db:1';
const healthPolicy = Object.freeze({ method: 'GET', route: '/health', target: 'Exact approved app origin verified against readback.',
  attempts: 1, timeoutMs: 10000, maximumBytes: 1024, redirects: 'never',
  expectedStatus: 200, expectedBody: '{"status":"up"}' });
const smokeCode = `await import('./server.js');
try {
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch('http://127.0.0.1:3000/health', { signal: AbortSignal.timeout(500) });
      if (response.status === 200) process.exit(0);
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  process.exit(1);
} catch { process.exit(1); }`;

export function describeHostExecution(source, config) {
  requireHost(valid(config) && ['container-apps-direct-v1', 'container-apps-apim-v1'].includes(source?.input?.recipe)
    && source.input.imageBuild && typeof source.review?.npmRegistryUrl === 'string'
    && /^sha256:[a-f0-9]{64}$/.test(source.manifest?.files?.['package-lock.json']),
  'HOST_EXECUTION_INVALID');
  return boundedSnapshot({
    effective: { maximumMs: config.maximumMs ?? 1800000, privateLoginReviewed: config.privateLoginReviewed === true,
      maximumImageBytes: executionImageLimit, maximumReportBytes: 16 * 1024 * 1024,
      maximumCloudReads: 160, maximumPolls: 90, pollIntervalMs: 5000 },
    readback: { appRevision: 'Exact latest revision underneath the approved app; bounded readiness polling only.',
      health: healthPolicy,
      authenticationAndSecretResolution: 'Startup and health can confirm configured credential injection, not independent Key Vault access, provider-key validity, rotation or authentication enforcement.' },
    downloads: { builderImage: source.input.imageBuild.builderImage, runtimeImage: source.input.imageBuild.runtimeImage,
      scannerImage: config.scannerImage, database, javaDatabase,
      npmRegistryUrl: source.review.npmRegistryUrl, packageLockDigest: source.manifest.files['package-lock.json'],
      dependencies: 'Exact sealed package-lock URLs/integrities, including build-only bundler; npm ci without scripts/audit/retry; no ambient credentials.' },
    ...(source.review.runtimePackaging ? { runtimePackaging: source.review.runtimePackaging } : {}),
    ceilings: { containerApps: { cpu: 0.25, memory: '0.5Gi', maxReplicas: 1,
      minReplicas: source.input.scaleProfile === 'scale-to-zero' ? 0 : 1 },
    localBuild: { memoryBytes: 1073741824, nanoCpus: 1000000000 },
    localScanner: { memoryBytes: 1073741824, nanoCpus: 1000000000 },
    localSmoke: { memoryBytes: 536870912, nanoCpus: 1000000000 },
    maximumContainerPids: 128, invoiceCapEnforceable: false },
    scanPolicy: { critical: 0, high: 0, maximumAgeHours: 24 },
  });
}

async function exists(filename) {
  await assertProjectPath(filename);
  try { await lstat(filename); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
}
function scoped(options, action) {
  requireHost(['workspaceRoot', 'project', 'config', 'output'].every(key => typeof options[key] === 'string'));
  return withCliWorkspace(options.workspaceRoot, action);
}
function resourceTargets(source) {
  const a = source.input.azure;
  const group = `/subscriptions/${a.subscriptionId}/resourceGroups/${a.resourceGroup}`;
  const app = `${group}/providers/Microsoft.App/containerApps/${a.appName}`;
  const gateway = a.gateway;
  if (!gateway) return { app, children: [] };
  const service = `/subscriptions/${a.subscriptionId}/resourceGroups/${gateway.resourceGroup}/providers/Microsoft.ApiManagement/service/${gateway.serviceName}`;
  const gatewayApi = `${service}/apis/${gateway.apiName}`;
  return { app, service, gatewayApi, children: [
    `${gatewayApi}/operations/mcp-post`, `${gatewayApi}/operations/resource-metadata`, `${gatewayApi}/policies/policy`,
  ] };
}
async function prepare(options) {
  const source = await readRecipeProject(options.project);
  requireHost(['container-apps-direct-v1', 'container-apps-apim-v1'].includes(source.input.recipe)
    && source.input.imageBuild && source.files.Dockerfile, 'HOST_EXECUTION_RECIPE_UNSUPPORTED');
  const configPath = await assertProjectPath(path.resolve(options.config));
  const config = await readControl(configPath);
  requireHost(valid(config));
  const output = await assertProjectPath(path.resolve(options.output));
  requireHost((await lstat(path.dirname(output))).isDirectory()
    && output !== source.projectDir && !output.startsWith(source.projectDir + path.sep));
  requireHost(config.azureIdentityProject === undefined || path.isAbsolute(config.azureIdentityProject));
  const identityProject = await assertProjectPath(config.azureIdentityProject
    ? path.resolve(config.azureIdentityProject) : source.projectDir);
  requireHost((await lstat(identityProject)).isDirectory() && identityProject !== output
    && !output.startsWith(identityProject + path.sep));
  const identity = await readAzureIdentity({ azure: source.input.azure }, identityProject);
  requireHost(identity || !await exists(path.join(identityProject, '.azure-identity.json')),
    'HOST_EXECUTION_IDENTITY_UNRESOLVED');
  requireHost(!identity || identity.target.accountName === config.accountName.toLowerCase(), 'HOST_EXECUTION_IDENTITY_MISMATCH');
  requireHost(identity || config.privateLoginReviewed === true, 'HOST_EXECUTION_IDENTITY_REQUIRED');
  const target = { tenantId: source.input.azure.tenantId, subscriptionId: source.input.azure.subscriptionId,
    accountName: config.accountName.toLowerCase() };
  const login = identity ? null : await planAzureAccountSwitch(identityProject, target, { useDeviceCode: true });
  const producerBuild = (await getLibraryInfo()).contentDigest;
  // Reproduce the current trusted generator without writing or resealing source.
  // Manifest hashes alone are deliberately not treated as authority to run Dockerfiles.
  const generated = await planHostingRecipe({ workspaceRoot: options.workspaceRoot,
    config: path.join(source.projectDir, 'recipe-definition.json'), output: `${output}.source-verification` });
  requireHost(Object.keys(generated.files).length === Object.keys(source.files).length + 1
    && Object.entries(source.files).every(([name, bytes]) => generated.files[name] === bytes.toString('utf8')),
  'HOST_EXECUTION_SOURCE_MISMATCH');
  const description = describeHostExecution(source, config);
  const scope = {
    schemaVersion: 1, kind: 'mcp-host-execution-plan', workspaceRoot: path.resolve(options.workspaceRoot),
    project: source.projectDir, output, configPath,
    config, description, ...description, effective: { ...description.effective, identityProject },
    sourceManifestDigest: source.manifest.contentDigest, producerBuild,
    identity, login, targets: resourceTargets(source),
    effects: [
      'Use only the exact existing private Azure identity, or the explicitly reviewed new private device login. Never copy caches or switch a mismatched identity.',
      'Build only current-generator-matched sealed source on the trusted Docker engine; download the named public images, scanner databases and pinned npm dependencies.',
      'Scan the actual exported image, retain raw scanner files privately, and run nonroot network-disabled health smoke with a synthetic key only when required.',
      'Obtain a transient ACR token in memory; push only the unique source/run-bound repository tag; never perform Docker login.',
      'Create the exact absent app and generated gateway children only, with last-moment absence checks and conditional PUT headers. Never update, grant roles, register apps, resolve secrets or delete cloud resources.',
      'One unauthenticated HTTPS GET to the newly created backend origin /health, with public DNS pinned to TLS, no redirects, a 10-second total deadline and 1 KiB response bound. No backend/provider operation or Key Vault secret read.',
      'Cloud conditional-create behavior is not independently qualified. Workspace target reservations exclude this executor, not unrelated Azure writers. The owner must retain exclusive ownership of these new target names.',
      'Existing environment, registry, pull identity, Key Vault access, Entra applications and gateway role grants are prerequisites. Metadata readback is not independent role, key-resolution, auth or consumer qualification.',
      'Resource ceilings are not a billing/invoice cap; existing resources and downloads can incur additional costs.',
      'All failed/unknown stage intents remain consumed; no retry, replacement output bypass or source resealing. Cancellation may leave owned local artifacts for manual cleanup.',
    ],
  };
  const approvalToken = `mcp-host-execution/${digest(scope)}`;
  return { approvalToken, scope, requiresSignIn: !identity };
}
async function retained(options) {
  const filename = path.join(path.resolve(options.output), 'plan.json');
  if (!await exists(filename)) return prepare(options);
  const plan = await readControl(filename);
  requireHost(plan.approvalToken === `mcp-host-execution/${digest(plan.scope)}`
    && plan.requiresSignIn === !plan.scope.identity, 'HOST_EXECUTION_PLAN_CHANGED');
  const source = await readRecipeProject(options.project), config = await readControl(path.resolve(options.config));
  const description = describeHostExecution(source, config);
  const { identityProject, ...effective } = plan.scope.effective;
  requireHost(digest(plan.scope.description) === digest(description)
    && digest({ ...Object.fromEntries(Object.keys(description).map(key => [key, plan.scope[key]])), effective }) === digest(description),
  'HOST_EXECUTION_PLAN_CHANGED');
  requireHost(plan.scope.workspaceRoot === path.resolve(options.workspaceRoot)
    && plan.scope.project === source.projectDir && plan.scope.output === path.resolve(options.output)
    && plan.scope.configPath === path.resolve(options.config) && digest(config) === digest(plan.scope.config)
    && source.manifest.contentDigest === plan.scope.sourceManifestDigest
    && (await getLibraryInfo()).contentDigest === plan.scope.producerBuild, 'HOST_EXECUTION_PLAN_CHANGED');
  return plan;
}
export const planHostExecution = options => scoped(options, () => retained(options));

async function lock(dir, action) {
  const filename = await assertProjectPath(path.join(dir, '.mcp-execution-host.lock'));
  const handle = await open(filename, 'wx', 0o600).catch(() => {
    requireHost(false, 'HOST_EXECUTION_LOCKED');
  });
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }));
    await handle.sync();
    return await action();
  } finally { await handle.close(); await unlink(filename); }
}
function sealed(body) { return { ...body, contentDigest: digest(body) }; }
function verifySealed(record) {
  const { contentDigest, ...body } = record;
  requireHost(contentDigest === digest(body), 'HOST_EXECUTION_EVIDENCE_CHANGED');
  return body;
}
const canonicalLocation = value => typeof value === 'string' ? value.replace(/\s/g, '').toLowerCase() : undefined;
function subset(expected, actual, field) {
  if (field === 'location') return typeof expected === 'string' && typeof actual === 'string'
    && canonicalLocation(expected) === canonicalLocation(actual);
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length
    && expected.every((value, index) => subset(value, actual[index]));
  if (expected && typeof expected === 'object') return actual && typeof actual === 'object'
    && Object.entries(expected).every(([key, value]) => subset(value, actual[key], key));
  return expected === actual;
}

async function healthOnce(origin, parentSignal, transport) {
  const endpoint = `${origin}${healthPolicy.route}`;
  const controller = new AbortController(), signal = AbortSignal.any([parentSignal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), healthPolicy.timeoutMs);
  let reader, response, abort;
  const aborted = new Promise((_, reject) => {
    abort = () => reject(Object.assign(new Error('Host health deadline/cancellation.'), { code: 'HOST_EXECUTION_HEALTH_TIMEOUT' }));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    const direct = publicHttpsTransport({ requestPolicy: value => {
      const url = new URL(value);
      requireHost(url.href === endpoint && url.protocol === 'https:' && !url.port
        && !url.username && !url.password && !url.search && !url.hash, 'HOST_EXECUTION_HEALTH_TARGET');
      return url;
    } });
    const send = transport ?? ((url, options) => direct(url, { ...options, redirect: 'error' }));
    response = await Promise.race([Promise.resolve().then(() => send(endpoint, {
      method: healthPolicy.method, redirect: 'manual', headers: { accept: 'application/json' }, signal,
    })), aborted]);
    requireHost(response?.status === healthPolicy.expectedStatus && response.redirected !== true
      && (!response.url || response.url === endpoint)
      && /^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers?.get('content-type') ?? ''),
    'HOST_EXECUTION_HEALTH_RESPONSE');
    const length = response.headers.get('content-length');
    requireHost(length === null || /^\d+$/.test(length) && Number(length) <= healthPolicy.maximumBytes, 'HOST_EXECUTION_HEALTH_SIZE');
    requireHost(response.body && typeof response.body.getReader === 'function', 'HOST_EXECUTION_HEALTH_RESPONSE');
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const item = await Promise.race([reader.read(), aborted]);
      if (item.done) break;
      size += item.value.byteLength;
      requireHost(size <= healthPolicy.maximumBytes, 'HOST_EXECUTION_HEALTH_SIZE');
      chunks.push(Buffer.from(item.value));
    }
    const bytes = Buffer.concat(chunks);
    requireHost(bytes.equals(Buffer.from(healthPolicy.expectedBody)), 'HOST_EXECUTION_HEALTH_RESPONSE');
    return { status: 'passed', httpStatus: healthPolicy.expectedStatus, responseDigest: bytesDigest(bytes), responseBytes: size,
      requests: 1, providerCalled: false, keyVaultSecretRead: false };
  } finally {
    controller.abort();
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    } else if (response?.body) void response.body.cancel().catch(() => {});
  }
}
function bodyFromTemplate(template, values) {
  const replace = value => {
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, replace(item)]));
    if (typeof value === 'string' && value.startsWith('[')) {
      if (value === "[parameters('containerImage')]") return values.containerImage;
      if (value === "[parameters('backendOrigin')]") return values.backendOrigin;
      requireHost(value.includes("reference('") && value.endsWith("'/mcp')]"), 'HOST_EXECUTION_TEMPLATE_UNSUPPORTED');
      return `${values.backendOrigin}/mcp`;
    }
    return value;
  };
  // Strip ARM resource envelope keys only; nested configuration names/types matter.
  const { resources, dependsOn, apiVersion, type, name, ...body } = template;
  return replace(body);
}

export const runHostExecution = (options, dependencies = {}) => scoped(options, async () => {
  const plan = await retained(options), scope = plan.scope;
  requireHost(options.approval === plan.approvalToken && options.allowLocal === true
    && options.allowNetwork === true && options.allowCloud === true, 'HOST_EXECUTION_APPROVAL_REQUIRED');
  requireHost(Date.parse(scope.config.expiresAt) > Date.now()
    && Date.parse(scope.config.expiresAt) <= Date.now() + 86400000, 'HOST_EXECUTION_EXPIRED');
  requireHost(!options.signal?.aborted, 'HOST_EXECUTION_CANCELLED');
  if (plan.requiresSignIn && typeof options.onDeviceCode !== 'function'
    && !await exists(path.join(scope.output, 'identity.result.json'))) return { status: 'sign-in-required' };
  const source = await readRecipeProject(scope.project);
  const runAzure = dependencies.runAzure ?? runAzureCommand;
  const requestDocker = dependencies.dockerRequest ?? executionDockerRequest;
  const sleep = dependencies.delay ?? delay;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), Math.min(scope.effective.maximumMs, Date.parse(scope.config.expiresAt) - Date.now()));
  const owner = plan.approvalToken.split(':').at(-1);
  const repository = `${source.input.azure.registry.server}/${scope.config.imageRepository}`;
  const tag = `copilot-${owner.slice(0, 32)}`;
  const taggedImage = `${repository}:${tag}`;
  let identity = scope.identity, azureReads = 0;
  const docker = (route, input = {}) => requestDocker(scope.config.dockerSocket, route, { ...input, signal });
  const guarded = (name, args, input) => {
    requireHost(!signal.aborted && ++azureReads <= scope.effective.maximumCloudReads, 'HOST_EXECUTION_READ_BUDGET');
    return runAzure(name, args, {
      ...input, signal, boundedInspection: true, allowInspectionRetry: false,
    });
  };
  const azure = async (args, extra = {}) => {
    const identityOptions = await azureIdentityGuard({ azure: source.input.azure }, scope.effective.identityProject, identity, guarded);
    return controlOutput(await guarded('az', [...args, '--only-show-errors', '--output', 'json'], { ...identityOptions, ...extra }));
  };
  const rest = (resourceId, version, method = 'GET', file) => azure(['rest', '--method', method,
    '--url', `https://management.azure.com${resourceId}?api-version=${version}${method === 'GET' && resourceId.endsWith('/policies/policy') ? '&format=rawxml' : ''}`,
    ...(file ? ['--headers', 'If-None-Match=*', '--body', `@${file}`] : [])]);
  const absentCloud = async (id, version) => {
    try { await rest(id, version); }
    catch (error) { if (error.code === 'AZURE_RESOURCE_NOT_FOUND') return; throw error; }
    requireHost(false, 'HOST_EXECUTION_TARGET_EXISTS');
  };
  let previous = plan.approvalToken;
  const stage = async (name, action) => {
    const intentFile = path.join(scope.output, `${name}.intent.json`), resultFile = path.join(scope.output, `${name}.result.json`);
    if (await exists(resultFile)) {
      const result = await readControl(resultFile); verifySealed(result);
      const intent = await readControl(intentFile); verifySealed(intent);
      requireHost(result.plan === plan.approvalToken && intent.plan === plan.approvalToken
        && intent.previous === previous && intent.stage === name && result.stage === name
        && result.intentDigest === intent.contentDigest && result.status === 'passed', 'HOST_EXECUTION_CONSUMED');
      previous = result.contentDigest;
      return result.value;
    }
    requireHost(!await exists(intentFile), 'HOST_EXECUTION_CONSUMED');
    requireHost(!signal.aborted, 'HOST_EXECUTION_CANCELLED');
    requireHost((await readRecipeProject(scope.project)).manifest.contentDigest === scope.sourceManifestDigest,
      'HOST_EXECUTION_SOURCE_MISMATCH');
    const intent = sealed({ schemaVersion: 1, plan: plan.approvalToken, previous, stage: name,
      status: 'started-no-replay', startedAt: new Date().toISOString() });
    await writeControl(intentFile, intent, { create: true });
    try {
      const value = await action();
      requireHost(!signal.aborted, 'HOST_EXECUTION_CANCELLED');
      const result = sealed({ schemaVersion: 1, plan: plan.approvalToken, stage: name, intentDigest: intent.contentDigest,
        status: 'passed', value, finishedAt: new Date().toISOString() });
      await writeControl(resultFile, result, { create: true });
      previous = result.contentDigest;
      return value;
    } catch (error) {
      const reasonCode = ['HOST_EXECUTION_SCAN_INCONCLUSIVE', 'HOST_EXECUTION_SCAN_POLICY',
        'HOST_EXECUTION_CONTAINER_FAILED', 'DOCKER_IMAGE_ARCHIVE_INVALID', 'DOCKER_RESPONSE_INVALID',
        'DOCKER_HTTP_FAILED', 'DOCKER_ABORTED', 'DOCKER_OUTPUT_LIMIT'].includes(error?.code)
        ? error.code : 'HOST_EXECUTION_UNCLASSIFIED_FAILURE';
      const result = sealed({ schemaVersion: 1, plan: plan.approvalToken, stage: name, intentDigest: intent.contentDigest,
        status: 'unknown-no-replay', code: 'HOST_EXECUTION_STAGE_STOPPED', reasonCode, finishedAt: new Date().toISOString() });
      await writeControl(resultFile, result, { create: true });
      throw Object.assign(new Error('Host stage stopped; inspect retained nonsecret evidence. No automatic retry.'), {
        code: 'HOST_EXECUTION_STAGE_STOPPED', reasonCode, stage: name, evidenceDigest: result.contentDigest,
      });
    }
  };
  const inspectImage = async image => executionJson(await docker(`${api}/images/${encodeURIComponent(image)}/json`));
  const restricted = (name, image, command, network = false) => ({
    Image: image, Entrypoint: command.entrypoint, Cmd: command.args, User: command.user ?? '65532:65532',
    Env: command.env ?? [], WorkingDir: command.workdir ?? '/app', Labels: { 'copilot-mcp-execution': owner },
    NetworkDisabled: !network, HostConfig: { NetworkMode: network ? 'bridge' : 'none',
      ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
      Memory: network ? scope.ceilings.localScanner.memoryBytes : scope.ceilings.localSmoke.memoryBytes,
      NanoCpus: scope.ceilings.localScanner.nanoCpus, PidsLimit: scope.ceilings.maximumContainerPids,
      LogConfig: { Type: 'none' }, AutoRemove: false,
      ...(command.volume ? { Mounts: [{ Type: 'volume', Source: command.volume, Target: '/work', ReadOnly: false }] } : {}) },
  });
  const container = async (name, body, before, after) => {
    const created = executionJson(await docker(`${api}/containers/create?name=${name}`, { method: 'POST', body }), 201);
    requireHost(/^[a-f0-9]{64}$/.test(created.Id));
    await before?.(created.Id);
    requireHost((await docker(`${api}/containers/${created.Id}/start`, { method: 'POST' })).status === 204);
    const result = executionJson(await docker(`${api}/containers/${created.Id}/wait?condition=not-running`, {
      method: 'POST', timeoutMs: Math.min(scope.effective.maximumMs, 900000),
    }));
    requireHost(result.StatusCode === 0 && !result.Error, 'HOST_EXECUTION_CONTAINER_FAILED');
    const value = await after?.(created.Id);
    const actual = executionJson(await docker(`${api}/containers/${created.Id}/json`));
    requireHost(actual.Config?.Labels?.['copilot-mcp-execution'] === owner && actual.State?.Running === false);
    requireHost((await docker(`${api}/containers/${created.Id}`, { method: 'DELETE' })).status === 204);
    return value ?? { status: 'passed' };
  };
  const gatewayBaseline = async () => {
    const service = await rest(scope.targets.service, apimVersion);
    const g = source.input.azure.gateway;
    requireHost(service.id?.toLowerCase() === scope.targets.service.toLowerCase()
      && service.properties?.provisioningState === 'Succeeded'
      && ['Developer', 'Basicv2', 'Standardv2', 'Premium'].includes(service.sku?.name)
      && service.properties?.gatewayUrl === `https://${g.serviceName}.azure-api.net`
      && service.identity?.type?.includes('SystemAssigned')
      && service.identity?.principalId?.toLowerCase() === g.principalId.toLowerCase()
      && service.identity?.tenantId?.toLowerCase() === source.input.azure.tenantId.toLowerCase());
    const policy = await rest(`${scope.targets.service}/policies`, apimVersion);
    const diagnostics = await rest(`${scope.targets.service}/diagnostics`, apimVersion);
    assertCompatibleGlobalPolicy(policyValue(policy)); assertSafeDiagnostics(diagnostics);
    const apis = collectionItems(await rest(`${scope.targets.service}/apis`, apimVersion), 'API');
    requireHost(apis.length <= 1000 && !apis.some(item => {
      const route = item.properties?.path?.toLowerCase();
      return item.name === g.apiName || typeof route !== 'string' || route === ''
        || route === g.path.toLowerCase() || route.startsWith(`${g.path.toLowerCase()}/`)
        || g.path.toLowerCase().startsWith(`${route}/`);
    }), 'HOST_EXECUTION_TARGET_EXISTS');
    return { policyDigest: digest(policy), diagnosticsDigest: digest(diagnostics),
      unrelatedApisDigest: digest(apis) };
  };
  try {
    if (!await exists(scope.output)) await mkdir(scope.output, { mode: 0o700 });
    return await lock(scope.output, async () => {
      if (!await exists(path.join(scope.output, 'plan.json'))) {
        requireHost((await prepare(options)).approvalToken === plan.approvalToken, 'HOST_EXECUTION_PLAN_CHANGED');
        await writeControl(path.join(scope.output, 'plan.json'), plan, { create: true });
      }
      const reservationDir = await assertProjectPath(path.join(scope.workspaceRoot, '.mcp-execution-host-targets'));
      await mkdir(reservationDir, { recursive: true, mode: 0o700 });
      for (const id of [scope.targets.app, scope.targets.gatewayApi, ...scope.targets.children].filter(Boolean).sort()) {
        const reservation = path.join(reservationDir, `${digest(id.toLowerCase()).slice(7)}.json`);
        if (await exists(reservation)) {
          const value = await readControl(reservation);
          requireHost(value.plan === plan.approvalToken && value.resourceId === id, 'HOST_EXECUTION_CONSUMED');
        } else await writeControl(reservation, { schemaVersion: 1, plan: plan.approvalToken, resourceId: id }, { create: true });
      }
      const identityResult = await stage('identity', async () => {
        if (!identity) {
          requireHost(scope.config.privateLoginReviewed === true && typeof options.onDeviceCode === 'function');
          await switchAzureAccount(scope.effective.identityProject, scope.login.target, {
            approval: scope.login.approvalToken, run: guarded, useDeviceCode: true, signal,
            onAzureDeviceCode: options.onDeviceCode,
          });
          identity = await readAzureIdentity({ azure: source.input.azure }, scope.effective.identityProject, { required: true });
        }
        await azureIdentityGuard({ azure: source.input.azure }, scope.effective.identityProject, identity, guarded);
        return { identity };
      });
      identity = identityResult.identity;
      return await lock(scope.effective.identityProject, async () => {
        const preflight = await stage('preflight', async () => {
          const engine = executionJson(await docker('/version'));
          requireHost(engine.Os === 'linux' && ['amd64', 'x86_64'].includes(engine.Arch)
            && /^1\.\d+$/.test(engine.ApiVersion) && Number(engine.ApiVersion.split('.')[1]) >= 44
            && (engine.MinAPIVersion === undefined || /^1\.\d+$/.test(engine.MinAPIVersion)
              && Number(engine.MinAPIVersion.split('.')[1]) <= 44));
          const info = executionJson(await docker(`${api}/info`));
          requireHost(info.Debug === false && info.RegistryConfig?.InsecureRegistryCIDRs?.every(cidr =>
            ['127.0.0.0/8', '::1/128'].includes(cidr))
            && info.RegistryConfig?.IndexConfigs?.[source.input.azure.registry.server]?.Secure !== false);
          await absentCloud(scope.targets.app, appVersion);
          const environment = await rest(source.input.azure.environmentResourceId, appVersion);
          requireHost(environment.id?.toLowerCase() === source.input.azure.environmentResourceId.toLowerCase()
            && environment.properties?.provisioningState === 'Succeeded'
            && canonicalLocation(environment.location) === canonicalLocation(source.input.azure.location)
            && /^[a-z0-9.-]+\.azurecontainerapps\.io$/.test(environment.properties?.defaultDomain));
          const registry = await azure(['acr', 'show', '--name', source.input.azure.registry.server.split('.')[0],
            '--subscription', identity.target.subscriptionId, '--query', '{id:id,loginServer:loginServer}']);
          requireHost(registry.loginServer === source.input.azure.registry.server
            && registry.id?.toLowerCase().startsWith(`/subscriptions/${identity.target.subscriptionId}/`));
          for (const id of new Set([source.input.azure.registry.pullIdentityResourceId,
            source.input.backend.apiKey?.identityResourceId].filter(Boolean))) {
            const managed = await rest(id, '2023-01-31');
            requireHost(managed.id?.toLowerCase() === id.toLowerCase()
              && managed.properties?.tenantId?.toLowerCase() === identity.target.tenantId);
          }
          if (source.input.backend.apiKey) {
            const key = source.input.backend.apiKey;
            const vault = await rest(key.keyVaultResourceId, '2023-07-01');
            requireHost(vault.id?.toLowerCase() === key.keyVaultResourceId.toLowerCase()
              && vault.properties?.tenantId?.toLowerCase() === identity.target.tenantId);
          }
          let gateway;
          if (scope.targets.service) {
            gateway = await gatewayBaseline();
            for (const id of [scope.targets.gatewayApi, ...scope.targets.children]) await absentCloud(id, apimVersion);
          }
          return { backendOrigin: `https://${source.input.azure.appName}.${environment.properties.defaultDomain}`,
            environmentDigest: digest(environment), registryResourceId: registry.id, ...(gateway ? { gateway } : {}) };
        });
        const built = await stage('build', async () => {
          const current = await readRecipeProject(scope.project);
          requireHost(current.manifest.contentDigest === scope.sourceManifestDigest);
          const body = executionTar(Object.fromEntries(buildFiles.map(name => [name, current.files[name]])));
          const query = new URLSearchParams({ dockerfile: 'Dockerfile', t: taggedImage, version: '1',
            platform: 'linux/amd64', pull: 'true', nocache: 'true', rm: 'true', forcerm: 'true',
            networkmode: 'default', memory: String(scope.ceilings.localBuild.memoryBytes),
            cpuperiod: '100000', cpuquota: String(scope.ceilings.localBuild.nanoCpus / 10000),
            labels: JSON.stringify({ 'copilot-mcp-execution': owner }) });
          executionProgress(await docker(`${api}/build?${query}`, { method: 'POST', body,
            headers: { 'X-Registry-Config': Buffer.from('{}').toString('base64') },
            maxBytes: 8 * 1024 * 1024, timeoutMs: scope.effective.maximumMs }));
          const image = await inspectImage(taggedImage);
          requireHost(/^sha256:[a-f0-9]{64}$/.test(image.Id) && image.Os === 'linux' && image.Architecture === 'amd64'
            && image.Config?.User === '65532:65532' && image.Config?.Labels?.['copilot-mcp-execution'] === owner
            && image.Size <= executionImageLimit);
          return { imageId: image.Id, buildEvidenceDigest: digest({ contextDigest: bytesDigest(body), imageId: image.Id,
            sourceManifestDigest: scope.sourceManifestDigest, build: source.input.imageBuild }) };
        });
        const scan = await stage('scan', async () => {
          executionProgress(await docker(`${api}/images/create?fromImage=${encodeURIComponent(scope.config.scannerImage)}&platform=linux%2Famd64`,
            { method: 'POST', maxBytes: 8 * 1024 * 1024, timeoutMs: 600000 }));
          const scanner = await inspectImage(scope.config.scannerImage);
          requireHost(scanner.Os === 'linux' && scanner.Architecture === 'amd64'
            && scanner.RepoDigests?.some(image => image === scope.config.scannerImage
              || image === `docker.io/${scope.config.scannerImage}`));
          const archive = await docker(`${api}/images/${encodeURIComponent(built.imageId)}/get`, {
            maxBytes: executionImageLimit, timeoutMs: 300000,
          });
          requireHost(archive.status === 200);
          const binding = executionImageBinding(archive.body, built.imageId);
          const volume = `copilot-mcp-${owner.slice(0, 32)}`;
          requireHost((await docker(`${api}/volumes/${volume}`)).status === 404, 'HOST_EXECUTION_LOCAL_TARGET_EXISTS');
          const created = executionJson(await docker(`${api}/volumes/create`, { method: 'POST',
            body: { Name: volume, Labels: { 'copilot-mcp-execution': owner }, Driver: 'local' } }), 201);
          requireHost(created.Name === volume && created.Labels?.['copilot-mcp-execution'] === owner);
          const scanArgs = ['image', '--input', '/work/image.tar', '--cache-dir', '/work/cache', '--scanners', 'vuln',
            '--list-all-pkgs', '--format', 'json', '--output', '/work/report.json', '--db-repository', database,
            '--java-db-repository', javaDatabase, '--timeout', '10m', '--quiet'];
          const readArtifact = async (id, location, filename) => {
            const response = await docker(`${api}/containers/${id}/archive?path=${encodeURIComponent(location)}`, {
              maxBytes: scope.effective.maximumReportBytes + 4096,
            });
            requireHost(response.status === 200);
            return executionTarFile(response.body, filename);
          };
          const output = await container(`${volume}-scan`, restricted(volume, scope.config.scannerImage, {
            entrypoint: ['trivy'], args: scanArgs, user: '0:0', volume, workdir: '/work', env: ['TMPDIR=/work', 'HOME=/work'],
          }, true), async id => {
            requireHost((await docker(`${api}/containers/${id}/archive?path=%2Fwork`, {
              method: 'PUT', body: executionTar({ 'image.tar': archive.body }), timeoutMs: 300000,
            })).status === 200);
          }, async id => ({ report: await readArtifact(id, '/work/report.json', 'report.json'),
            database: await readArtifact(id, '/work/cache/db/metadata.json', 'metadata.json') }));
          // Preserve bounded private diagnostics even when qualification rejects the report.
          const savePrivate = async (filename, bytes) => {
            const handle = await open(await assertProjectPath(path.join(scope.output, filename)), 'wx', 0o600);
            try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
          };
          await savePrivate('scanner.private.json', output.report);
          await savePrivate('scanner-database.private.json', output.database);
          const report = JSON.parse(output.report), db = JSON.parse(output.database);
          requireHost(report.SchemaVersion === 2 && report.ArtifactType === 'container_image'
            && report.Metadata?.ImageID === binding.configDigest && report.Metadata?.OS?.Family === 'debian'
            && JSON.stringify(report.Metadata?.DiffIDs) === JSON.stringify(binding.diffIds)
            && Array.isArray(report.Results) && report.Results.length > 0
            && report.Results.some(result => result.Class === 'os-pkgs' && result.Type === 'debian'
              && Array.isArray(result.Packages) && result.Packages.length > 0)
            && report.Results.some(result => result.Class === 'lang-pkgs' && ['npm', 'node-pkg'].includes(result.Type)
              && Array.isArray(result.Packages) && result.Packages.length > 0),
          'HOST_EXECUTION_SCAN_INCONCLUSIVE');
          const counts = { critical: 0, high: 0, medium: 0, low: 0 };
          for (const result of report.Results) {
            requireHost(result.Vulnerabilities === undefined || Array.isArray(result.Vulnerabilities));
            for (const finding of result.Vulnerabilities ?? []) {
              requireHost(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'].includes(finding.Severity));
              requireHost(finding.Severity !== 'UNKNOWN', 'HOST_EXECUTION_SCAN_INCONCLUSIVE');
              counts[finding.Severity.toLowerCase()]++;
            }
          }
          const scannedAt = new Date().toISOString(), updated = Date.parse(db.UpdatedAt);
          requireHost(Number.isFinite(updated) && updated <= Date.now() && Date.now() - updated <= 86400000);
          requireHost(counts.critical === 0 && counts.high === 0, 'HOST_EXECUTION_SCAN_POLICY');
          const sbom = await container(`${volume}-sbom`, restricted(volume, scope.config.scannerImage, {
            entrypoint: ['trivy'], args: ['image', '--input', '/work/image.tar', '--cache-dir', '/work/cache',
              '--offline-scan', '--skip-db-update', '--skip-java-db-update', '--format', 'cyclonedx',
              '--output', '/work/sbom.json', '--timeout', '10m', '--quiet'], user: '0:0', volume, workdir: '/work',
            env: ['TMPDIR=/work', 'HOME=/work'],
          }), undefined, id => readArtifact(id, '/work/sbom.json', 'sbom.json'));
          const bill = JSON.parse(sbom);
          requireHost(bill.bomFormat === 'CycloneDX' && Array.isArray(bill.components) && bill.components.length > 0);
          await savePrivate('sbom.private.json', sbom);
          const owned = executionJson(await docker(`${api}/volumes/${volume}`));
          requireHost(owned.Labels?.['copilot-mcp-execution'] === owner);
          requireHost((await docker(`${api}/volumes/${volume}`, { method: 'DELETE' })).status === 204);
          return { ...counts, binding, scannedAt, databaseUpdatedAt: new Date(updated).toISOString(),
            reportDigest: bytesDigest(output.report), sbomDigest: bytesDigest(sbom) };
        });
        const smoke = await stage('smoke', async () => {
          const image = await inspectImage(built.imageId);
          requireHost(image.Id === built.imageId && image.Config?.User === '65532:65532');
          const outcome = await container(`copilot-mcp-${owner.slice(0, 32)}-smoke`, restricted('smoke', built.imageId, {
            entrypoint: ['/nodejs/bin/node'], args: ['--input-type=module', '-e', smokeCode],
            env: ['PORT=3000', 'PUBLIC_MCP_URL=http://localhost:3000/mcp',
              ...(source.input.backend.apiKey ? ['MCP_BACKEND_API_KEY=synthetic-host-smoke-not-a-provider-credential'] : [])],
          }));
          return { networkDisabled: true, nonroot: true, status: 'passed',
            evidenceDigest: digest({ imageId: built.imageId, outcome, smokeCode }),
            keyResolutionVerified: false, providerCalled: false };
        });
        const pushed = await stage('push', async () => {
          requireHost((await inspectImage(taggedImage)).Id === built.imageId);
          let credential;
          try {
            credential = await azure(['acr', 'login', '--name', source.input.azure.registry.server.split('.')[0],
              '--subscription', identity.target.subscriptionId, '--expose-token'], { sensitiveOutput: true });
            requireHost(credential.loginServer === source.input.azure.registry.server
              && typeof credential.accessToken === 'string' && /^[A-Za-z0-9._~+/-]{1,65536}={0,2}$/.test(credential.accessToken));
            const pushed = executionProgress(await docker(`${api}/images/${encodeURIComponent(repository)}/push?tag=${tag}`, {
              method: 'POST', headers: { 'X-Registry-Auth': registryAuthHeader(credential.loginServer, credential.accessToken) },
              maxBytes: 8 * 1024 * 1024, timeoutMs: 600000,
            }));
            requireHost(/^sha256:[a-f0-9]{64}$/.test(pushed?.Digest));
            const image = `${repository}@${pushed.Digest}`, actual = await inspectImage(image);
            requireHost(actual.Id === built.imageId && actual.RepoDigests?.includes(image));
            return { containerImage: image };
          } finally { credential = undefined; }
        });
        const qualification = await stage('qualification', async () => {
          const image = pushed.containerImage;
          const input = { schemaVersion: 1, kind: 'image-qualification', image, sourceManifestDigest: scope.sourceManifestDigest,
            build: source.input.imageBuild, builder: { run: `host-${owner.slice(0, 32)}`, evidenceDigest: built.buildEvidenceDigest },
            scan: { image, scanner: 'Trivy pinned execution', databaseUpdatedAt: scan.databaseUpdatedAt, scannedAt: scan.scannedAt,
              critical: scan.critical, high: scan.high, medium: scan.medium, low: scan.low, reportDigest: scan.reportDigest },
            smoke: { image, networkDisabled: true, nonroot: true, status: 'passed', evidenceDigest: smoke.evidenceDigest },
            sbom: { image, reportDigest: scan.sbomDigest } };
          const result = reviewImage(source, input);
          const body = { schemaVersion: 1, kind: 'mcp-recipe-operator-review',
            sourceManifestDigest: scope.sourceManifestDigest, input, result };
          const imageReviewFile = path.join(scope.output, 'image-review.json');
          await writeControl(imageReviewFile, sealed(body), { create: true });
          return { imageReviewFile, expiresAt: result.expiresAt };
        });
        const createResource = async (stageName, id, version, body, expected) => stage(stageName, async () => {
          requireHost(Date.parse(qualification.expiresAt) > Date.now(), 'HOST_EXECUTION_SCAN_STALE');
          await absentCloud(id, version);
          const filename = path.join(scope.output, `${stageName}.request.json`);
          await writeControl(filename, body, { create: true });
          await rest(id, version, 'PUT', filename);
          for (let poll = 0; poll < scope.effective.maximumPolls; poll++) {
            const actual = await rest(id, version);
            requireHost(actual.id?.toLowerCase() === id.toLowerCase(), 'HOST_EXECUTION_READBACK_MISMATCH');
            const state = actual.properties?.provisioningState;
            requireHost(!['Failed', 'Canceled', 'Cancelled'].includes(state), 'HOST_EXECUTION_PROVISION_FAILED');
            if (!state || state === 'Succeeded') {
              const policy = id.endsWith('/policies/policy');
              const matches = policy
                ? [undefined, 'rawxml'].includes(actual.properties?.format)
                  && typeof actual.properties?.value === 'string'
                  && actual.properties.value.replace(/\r\n?/g, '\n').trim()
                    === body.properties.value.replace(/\r\n?/g, '\n').trim()
                : subset(body, actual);
              requireHost(matches && expected(actual), 'HOST_EXECUTION_READBACK_MISMATCH');
              return { resourceId: id, readbackDigest: digest(actual) };
            }
            await sleep(scope.effective.pollIntervalMs, undefined, { signal });
          }
          requireHost(false, 'HOST_EXECUTION_POLL_EXHAUSTED');
        });
        const appTemplate = JSON.parse(source.files['infra/container-app.json']).resources[0];
        const appBody = bodyFromTemplate(appTemplate, { containerImage: pushed.containerImage, backendOrigin: preflight.backendOrigin });
        await createResource('app', scope.targets.app, appVersion, appBody, actual =>
          actual.properties?.provisioningState === 'Succeeded'
          && actual.properties?.configuration?.ingress?.fqdn === new URL(preflight.backendOrigin).hostname
          && actual.properties?.template?.containers?.length === 1
          && actual.properties?.template?.scale?.maxReplicas === 1
          && actual.properties?.template?.containers?.[0]?.resources?.cpu === 0.25
          && actual.properties?.template?.containers?.[0]?.resources?.memory === '0.5Gi'
          && digest(Object.keys(actual.identity?.userAssignedIdentities ?? {}).sort())
            === digest(Object.keys(appBody.identity.userAssignedIdentities).sort()));
        const readiness = await stage('app-readiness', async () => {
          for (let poll = 0; poll < scope.effective.maximumPolls; poll++) {
            const app = await rest(scope.targets.app, appVersion);
            requireHost(app.id?.toLowerCase() === scope.targets.app.toLowerCase()
              && subset(appBody, app)
              && app.properties?.configuration?.ingress?.fqdn === new URL(preflight.backendOrigin).hostname,
            'HOST_EXECUTION_READBACK_MISMATCH');
            const name = app.properties?.latestRevisionName;
            if (name && name === app.properties.latestReadyRevisionName) {
              requireHost(new RegExp(`^${source.input.azure.appName}--[a-z0-9][a-z0-9-]{0,62}$`).test(name),
                'HOST_EXECUTION_READBACK_MISMATCH');
              const id = `${scope.targets.app}/revisions/${name}`;
              const revision = await rest(id, appVersion);
              requireHost(revision.id?.toLowerCase() === id.toLowerCase()
                && subset(appBody.properties.template, revision.properties?.template),
              'HOST_EXECUTION_READBACK_MISMATCH');
              requireHost(revision.properties?.provisioningState !== 'Failed', 'HOST_EXECUTION_PROVISION_FAILED');
              if (revision.properties?.active === true && revision.properties.healthState === 'Healthy'
                && revision.properties.runningState === 'Running') return { revisionId: id,
                readbackDigest: digest(revision), readiness: 'healthy-running-control-plane-readback',
                secretResolutionVerified: false };
            }
            await sleep(scope.effective.pollIntervalMs, undefined, { signal });
          }
          requireHost(false, 'HOST_EXECUTION_POLL_EXHAUSTED');
        });
        await stage('app-health', async () => {
          const checkSelectedRevision = async () => {
            const app = await rest(scope.targets.app, appVersion);
            requireHost(app.id?.toLowerCase() === scope.targets.app.toLowerCase() && subset(appBody, app)
              && app.properties?.configuration?.ingress?.fqdn === new URL(preflight.backendOrigin).hostname
              && `${scope.targets.app}/revisions/${app.properties.latestRevisionName}` === readiness.revisionId
              && app.properties.latestRevisionName === app.properties.latestReadyRevisionName,
            'HOST_EXECUTION_READBACK_MISMATCH');
            const traffic = app.properties.configuration.ingress.traffic;
            requireHost(traffic === undefined || Array.isArray(traffic) && (traffic.length === 0 || traffic.length === 1
              && traffic[0].weight === 100
              && (traffic[0].latestRevision === true || traffic[0].revisionName === app.properties.latestRevisionName)),
            'HOST_EXECUTION_READBACK_MISMATCH');
            const revision = await rest(readiness.revisionId, appVersion);
            requireHost(revision.id?.toLowerCase() === readiness.revisionId.toLowerCase()
              && subset(appBody.properties.template, revision.properties?.template)
              && revision.properties.active === true && revision.properties.healthState === 'Healthy'
              && revision.properties.runningState === 'Running', 'HOST_EXECUTION_READBACK_MISMATCH');
          };
          await checkSelectedRevision();
          const health = await healthOnce(preflight.backendOrigin, signal, dependencies.healthTransport);
          await checkSelectedRevision();
          return { ...health, revisionId: readiness.revisionId,
            credentialInjection: source.input.backend.apiKey ? 'runtime-startup-and-health-confirmed' : 'not-applicable',
            limitations: 'Not independent Key Vault access, provider-key validity, rotation or caller authentication evidence.' };
        });
        if (scope.targets.service) {
          await stage('gateway-recheck', async () => {
            const baseline = await gatewayBaseline();
            requireHost(digest(baseline) === digest(preflight.gateway), 'HOST_EXECUTION_GATEWAY_CHANGED');
            return baseline;
          });
          const template = JSON.parse(source.files['infra/apim-gateway.json']).resources[0];
          const values = { backendOrigin: preflight.backendOrigin };
          await createResource('gateway-api', scope.targets.gatewayApi, apimVersion, bodyFromTemplate(template, values), () => true);
          // Install the exact auth policy before making either new operation routable.
          const children = [...template.resources].sort((a, b) => Number(b.type === 'policies') - Number(a.type === 'policies'));
          for (const child of children) await createResource(`gateway-${child.name}`,
            `${scope.targets.gatewayApi}/${child.type}/${child.name}`, child.apiVersion, bodyFromTemplate(child, values), () => true);
          await stage('gateway-preservation', async () => {
            const policy = await rest(`${scope.targets.service}/policies`, apimVersion);
            const diagnostics = await rest(`${scope.targets.service}/diagnostics`, apimVersion);
            const apis = collectionItems(await rest(`${scope.targets.service}/apis`, apimVersion), 'API');
            const unrelated = apis.filter(item => item.id?.toLowerCase() !== scope.targets.gatewayApi.toLowerCase());
            requireHost(apis.length <= 1001 && digest(policy) === preflight.gateway.policyDigest
              && digest(diagnostics) === preflight.gateway.diagnosticsDigest
              && digest(unrelated) === preflight.gateway.unrelatedApisDigest, 'HOST_EXECUTION_GATEWAY_CHANGED');
            return { inheritedPolicyPreserved: true, diagnosticsPreserved: true, unrelatedApisPreserved: true };
          });
        }
        const result = await stage('completed', async () => ({
          status: 'passed', containerImage: pushed.containerImage, backendOrigin: preflight.backendOrigin,
          endpoint: source.runtime.gateway?.publicUrl ?? `${preflight.backendOrigin}/mcp`,
          imageReviewFile: qualification.imageReviewFile,
          authenticationVerified: false, providerVerified: false, consumerVerified: false,
          observedMilestones: { build: 'passed', zeroCriticalHighScan: 'passed', nonrootNetworkDisabledSmoke: 'passed',
            registryPush: 'passed', appDeploymentReadback: 'passed', appRevisionReadiness: 'healthy-running-control-plane-readback',
            appHealth: 'passed',
            secretResolution: source.input.backend.apiKey ? 'runtime-startup-and-health-confirmed' : 'not-applicable',
            gatewayDeploymentReadback: scope.targets.service ? 'passed' : 'not-applicable',
            authenticationEnforcement: 'not-verified', providerProof: 'not-verified', consumerAcceptance: 'not-verified' },
        }));
        return { ...result, evidenceDigest: previous };
      });
    });
  } catch (error) {
    if (error.code !== 'HOST_EXECUTION_STAGE_STOPPED') throw error;
    return { status: 'unknown-no-replay', stage: error.stage, code: error.code,
      ...(error.reasonCode ? { reasonCode: error.reasonCode } : {}), evidenceDigest: error.evidenceDigest };
  } finally { clearTimeout(timer); controller.abort(); }
});
