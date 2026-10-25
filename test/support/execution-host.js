import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { withCliWorkspace } from '../../src/config.js';
import { readRecipeProject } from '../../src/mcp-recipe-artifacts.js';
import { readAzureIdentity, planAzureAccountSwitch, switchAzureAccount } from '../../src/azure-identity.js';
import { executionTar } from '../../src/mcp-execution-docker.js';

export const syntheticHostImageId = `sha256:${'a'.repeat(64)}`;
export const syntheticHostImageDigest = `sha256:${'b'.repeat(64)}`;
export const syntheticHostScannerImage = `aquasec/trivy@sha256:${'c'.repeat(64)}`;
export const syntheticHostRegistryToken = 'synthetic-registry-token-never-persist';
const response = (value, status = 200) => ({ status, body: Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)) });

// Test-only factory for an ALREADY GENERATED trusted source. No Azure, Docker,
// HTTP, install or subprocess is used. Only seedIdentity writes private local state.
export async function createSyntheticExecutionHost({ workspaceRoot, project, host, seedIdentity = true }) {
  const source = (await withCliWorkspace(workspaceRoot, () => readRecipeProject(project))).input;
  const identityProject = host.azureIdentityProject ?? project;
  const calls = [], resources = new Map(), containers = new Map(), volumes = new Map(), findings = [];
  const a = source.azure;
  let counter = 0, tag, owner, pushed = false;
  const app = `/subscriptions/${a.subscriptionId}/resourceGroups/${a.resourceGroup}/providers/Microsoft.App/containerApps/${a.appName}`;
  const service = a.gateway ? `/subscriptions/${a.subscriptionId}/resourceGroups/${a.gateway.resourceGroup}/providers/Microsoft.ApiManagement/service/${a.gateway.serviceName}` : undefined;
  resources.set(a.environmentResourceId, { id: a.environmentResourceId, location: a.location, properties: {
    provisioningState: 'Succeeded', defaultDomain: 'synthetic.eastus.azurecontainerapps.io' } });
  for (const id of [a.registry.pullIdentityResourceId, source.backend.apiKey?.identityResourceId].filter(Boolean))
    resources.set(id, { id, properties: { tenantId: a.tenantId } });
  if (source.backend.apiKey) resources.set(source.backend.apiKey.keyVaultResourceId, {
    id: source.backend.apiKey.keyVaultResourceId, properties: { tenantId: a.tenantId } });
  if (service) {
    resources.set(service, { id: service, sku: { name: 'Developer' }, identity: { type: 'SystemAssigned',
      tenantId: a.tenantId, principalId: a.gateway.principalId }, properties: {
      provisioningState: 'Succeeded', gatewayUrl: `https://${a.gateway.serviceName}.azure-api.net` } });
    resources.set(`${service}/policies`, { value: [{ properties: { value:
      '<policies><inbound/><backend><forward-request/></backend><outbound/><on-error/></policies>' } }] });
    resources.set(`${service}/diagnostics`, { value: [] });
    resources.set(`${service}/apis`, { value: [] });
  }
  const account = { id: a.subscriptionId, tenantId: a.tenantId, user: { name: host.accountName, type: 'user' } };
  const runAzure = async (name, args, execution) => {
    calls.push({ system: 'azure', args, execution });
    assert.equal(name, 'az');
    assert.ok(execution.azureConfigDir.startsWith(path.join(identityProject, '.azure-auth') + path.sep));
    assert.equal(execution.allowInspectionRetry, false);
    if (args[0] === 'login') {
      execution.onAzureDeviceCode?.({ verificationUri: 'https://microsoft.com/devicelogin', userCode: 'ABCDE1234' });
      return null;
    }
    if (args[0] === 'account') return account;
    if (args[0] === 'acr') {
      if (args[1] === 'login') {
        assert.equal(execution.sensitiveOutput, true);
        return { loginServer: a.registry.server, accessToken: syntheticHostRegistryToken };
      }
      return { id: `/subscriptions/${a.subscriptionId}/resourceGroups/synthetic-registry-rg/providers/Microsoft.ContainerRegistry/registries/${a.registry.server.split('.')[0]}`,
        loginServer: a.registry.server };
    }
    assert.equal(args[0], 'rest');
    const url = new URL(args[args.indexOf('--url') + 1]), id = url.pathname;
    const method = args[args.indexOf('--method') + 1];
    if (method === 'PUT') {
      assert.equal(args[args.indexOf('--headers') + 1], 'If-None-Match=*');
      assert.equal(resources.has(id), false, 'Never update an existing target');
      const filename = args[args.indexOf('--body') + 1].slice(1);
      const body = JSON.parse(await readFile(filename));
      if (id === app) {
        body.properties.provisioningState = 'Succeeded';
        body.properties.configuration.ingress.fqdn = `${a.appName}.synthetic.eastus.azurecontainerapps.io`;
        const revisionName = `${a.appName}--synthetic`;
        body.properties.latestRevisionName = revisionName;
        body.properties.latestReadyRevisionName = revisionName;
        const revisionId = `${app}/revisions/${revisionName}`;
        resources.set(revisionId, { id: revisionId, properties: { active: true, healthState: 'Healthy',
          runningState: 'Running', provisioningState: 'Provisioned', template: structuredClone(body.properties.template) } });
      }
      const result = { ...body, id };
      resources.set(id, result);
      if (service && id === `${service}/apis/${a.gateway.apiName}`) resources.get(`${service}/apis`).value.push({
        id, name: a.gateway.apiName, properties: structuredClone(body.properties),
      });
      return result;
    }
    assert.equal(method, 'GET');
    if (!resources.has(id)) throw Object.assign(new Error(`not found ${syntheticHostRegistryToken}`), { code: 'AZURE_RESOURCE_NOT_FOUND' });
    return structuredClone(resources.get(id));
  };
  const seed = async () => withCliWorkspace(workspaceRoot, async () => {
    await mkdir(identityProject, { recursive: true });
    const target = { tenantId: a.tenantId, subscriptionId: a.subscriptionId, accountName: host.accountName };
    const planned = await planAzureAccountSwitch(identityProject, target);
    await switchAzureAccount(identityProject, target, { approval: planned.approvalToken,
      run: (name, args, execution) => runAzure(name, args, { ...execution, allowInspectionRetry: false }) });
    return readAzureIdentity({ azure: a }, identityProject, { required: true });
  });
  const dockerRequest = async (selected, route, execution = {}) => {
    calls.push({ system: 'docker', route, execution });
    assert.equal(selected, host.dockerSocket);
    assert.equal(execution.signal instanceof AbortSignal, true);
    if (route === '/version') return response({ Os: 'linux', Arch: 'amd64', ApiVersion: '1.47', MinAPIVersion: '1.44' });
    if (route === '/v1.44/info') return response({ Debug: false,
      RegistryConfig: { InsecureRegistryCIDRs: ['127.0.0.0/8'], IndexConfigs: {} } });
    if (route.startsWith('/v1.44/build?')) {
      const params = new URLSearchParams(route.split('?')[1]);
      tag = params.get('t'); owner = JSON.parse(params.get('labels'))['copilot-mcp-execution'];
      assert.equal(params.get('platform'), 'linux/amd64');
      assert.equal(params.get('memory'), '1073741824');
      assert.equal(execution.headers['X-Registry-Config'], Buffer.from('{}').toString('base64'));
      assert.ok(Buffer.isBuffer(execution.body));
      return response({ aux: { ID: syntheticHostImageId } });
    }
    if (route.startsWith('/v1.44/images/create?')) return response({ status: 'Downloaded exact scanner image' });
    if (route.startsWith('/v1.44/images/') && route.endsWith('/json')) {
      const name = decodeURIComponent(route.slice('/v1.44/images/'.length, -'/json'.length));
      if (name === host.scannerImage) return response({ Id: `sha256:${'c'.repeat(64)}`, Os: 'linux',
        Architecture: 'amd64', RepoDigests: [host.scannerImage] });
      assert.ok([syntheticHostImageId, tag, `${a.registry.server}/${host.imageRepository}@${syntheticHostImageDigest}`].includes(name));
      return response({ Id: syntheticHostImageId, Os: 'linux', Architecture: 'amd64', Size: 100,
        RepoDigests: pushed ? [`${a.registry.server}/${host.imageRepository}@${syntheticHostImageDigest}`] : [],
        Config: { User: '65532:65532', Labels: { 'copilot-mcp-execution': owner } } });
    }
    if (route.endsWith('/get')) return response(Buffer.from('synthetic-image-archive'));
    if (route.includes('/push?')) {
      const auth = JSON.parse(Buffer.from(execution.headers['X-Registry-Auth'], 'base64url'));
      assert.equal(auth.password, syntheticHostRegistryToken); assert.equal(auth.serveraddress, a.registry.server);
      pushed = true;
      return response({ aux: { Digest: syntheticHostImageDigest } });
    }
    if (route === '/v1.44/volumes/create') {
      volumes.set(execution.body.Name, structuredClone(execution.body));
      return response(execution.body, 201);
    }
    if (route.startsWith('/v1.44/volumes/')) {
      const name = route.split('/').at(-1);
      if (execution.method === 'DELETE') { volumes.delete(name); return response(null, 204); }
      return volumes.has(name) ? response(volumes.get(name)) : response(null, 404);
    }
    if (route.startsWith('/v1.44/containers/create?')) {
      const id = (++counter).toString(16).padStart(64, '0');
      containers.set(id, structuredClone(execution.body));
      return response({ Id: id }, 201);
    }
    if (route.startsWith('/v1.44/containers/')) {
      const id = route.split('/')[3], body = containers.get(id);
      assert.ok(body);
      if (route.includes('/archive?')) {
        if (execution.method === 'PUT') return response(null);
        const target = decodeURIComponent(route.split('path=')[1]);
        if (target.endsWith('report.json')) return response(executionTar({ 'report.json': JSON.stringify({
          SchemaVersion: 2, ArtifactType: 'container_image', Metadata: { ImageID: syntheticHostImageId, OS: { Family: 'debian' } },
          Results: [{ Target: 'synthetic-linux', Class: 'os-pkgs', Type: 'debian',
            Packages: [{ Name: 'synthetic-os' }], Vulnerabilities: findings },
          { Target: 'Node.js', Class: 'lang-pkgs', Type: 'node-pkg', Packages: [{ Name: 'synthetic-node' }] }],
        }) }));
        if (target.endsWith('metadata.json')) return response(executionTar({
          'metadata.json': JSON.stringify({ UpdatedAt: new Date(Date.now() - 60000).toISOString() }),
        }));
        if (target.endsWith('sbom.json')) return response(executionTar({
          'sbom.json': JSON.stringify({ bomFormat: 'CycloneDX', components: [{ name: 'synthetic-package' }] }),
        }));
      }
      if (route.endsWith('/start')) return response(null, 204);
      if (route.includes('/wait?')) return response({ StatusCode: 0 });
      if (route.endsWith('/json')) return response({ Config: { Labels: body.Labels }, State: { Running: false } });
      if (execution.method === 'DELETE') { containers.delete(id); return response(null, 204); }
    }
    assert.fail(`Unexpected synthetic Docker request: ${route}`);
  };
  if (seedIdentity) await seed();
  calls.length = 0;
  const healthTransport = async (endpoint, options) => {
    calls.push({ system: 'health', endpoint, options });
    assert.equal(endpoint, `https://${a.appName}.synthetic.eastus.azurecontainerapps.io/health`);
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
    assert.deepEqual(options.headers, { accept: 'application/json' });
    assert.equal(options.signal instanceof AbortSignal, true);
    return new Response('{"status":"up"}', { headers: { 'content-type': 'application/json' } });
  };
  return { source, app, service, resources, containers, volumes, findings, calls, seedIdentity: seed,
    dependencies: { runAzure, dockerRequest, healthTransport, delay: async () => {} } };
}
