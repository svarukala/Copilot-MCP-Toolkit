import test from 'node:test';

import assert from 'node:assert/strict';

import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';

import { spawnSync } from 'node:child_process';

import { pathToFileURL } from 'node:url';

import path from 'node:path';

import { TOOLKIT_ROOT } from '../src/config.js';

import { apimMode, gatewayApiId, RESTRICTED_DISCOVERY_CLIENT_ID, experimentalProxy, proxyBackendId, SECRET_USER_ROLE } from '../src/contract.js';

import { planProvisioning, provisionProject } from '../src/azure.js';

import { OWNER_TAG, ownerId, ownerDescription, deploymentTarget, serviceResourceId, assertCompatibleGlobalPolicy, assertSafeDiagnostics, assertNoApiCollisions, proxySecretScope, proxyBackendProperties, ApimSafetyError } from '../src/apim-safety.js';

import { approvalToken, main } from '../bin/copilot-mcp.js';

import { unzipSync } from 'fflate';

import { prepareRestToolDocument } from '../src/rest-authoring.js';

import { selectMockAzureIdentity, mockAzureUser } from './support/azure-identity.js';

import { readAzureIdentity } from '../src/azure-identity.js';

import { prepareMcpServer, createMcpServerProject, mcpRuntimeConfig } from '../src/mcp-server.js';

import { planMcpServerProvision, provisionMcpServer, planMcpServerCapture, planMcpServerReconcile, reconcileMcpServer } from '../src/mcp-lifecycle.js';

import { executeMcpProjectForTest, planMcpProjectDiscovery, planMcpProjectProof, planMcpProjectQualification } from '../src/mcp-discovery-project.js';

import { discoverMcpToolsForTest, runMcpReadOnlyProofForTest, runMcpQualifiedProof, runMcpAcceptedProof } from '../src/mcp-discovery.js';

import { firstCallProfileBinding, tavilyFirstCallProfile } from '../src/mcp-tavily-qualification.js';

import { observationTransport } from './support/mcp-observation.js';

import { tavilyQualificationTools, tavilyQualificationArguments } from './support/mcp-nullable.js';

import { planMcpAuthRejection, executeMcpAuthRejection, readMcpAuthRejections, planMcpBackendRejection, executeMcpBackendRejection, readMcpBackendRejections } from '../src/mcp-auth-rejection.js';

import { planMcpPrerequisites, inspectMcpPrerequisites } from '../src/mcp-prerequisites.js';

import { managedIdentityRequests } from '../src/apim-managed-identity.js';

import { readExperimentalConfiguration, CONFIGURATION_AGE_MS } from '../src/mcp-configuration.js';

import { metadataDigest, boundedSnapshot } from '../src/anonymous-metadata.js';

import { readMcpStatus } from '../src/mcp-status.js';

import { planMcpResume } from '../src/mcp-resume.js';

import { planMcpEvidenceExport, exportMcpEvidence, planMcpEvidenceRestore, restoreMcpEvidence } from '../src/mcp-evidence.js';

import { readMcpDiagnosis } from '../src/mcp-diagnosis.js';

import { InspectionError } from '../src/inspection-budget.js';

const passthrough = '<policies><inbound /><backend><forward-request /></backend><outbound /></policies>';

const principalId = '88888888-8888-4888-8888-888888888888';

const list = value => ({ value: structuredClone(value) });

function runner(cfg, application, options = {}) {
  const calls = [];
  const apis = new Map([['unrelated', { name: 'unrelated', properties: { path: 'original', type: 'http', description: 'Do not modify' } }]]);
  const policies = new Map([['unrelated', passthrough]]);
  const apiDiagnostics = new Map();
  const operations = new Map();
  const tools = new Map();
  const operationPolicies = new Map();
  const values = new Map();
  const proxyBackends = new Map([['unrelated-backend', {
    id: `${serviceResourceId(cfg)}/backends/unrelated-backend`, name: 'unrelated-backend',
    properties: { url: 'https://unrelated.example.com/base', protocol: 'http', description: 'Preserve backend settings' },
  }]]);
  const grants = experimentalProxy(cfg) ? [{
    id: `${proxySecretScope(cfg)}/providers/Microsoft.Authorization/roleAssignments/${principalId}`,
    properties: { scope: proxySecretScope(cfg), principalId, principalType: 'ServicePrincipal',
      roleDefinitionId: `/subscriptions/${cfg.azure.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${SECRET_USER_ROLE}` },
  }] : [];
  const service = {
    id: serviceResourceId(cfg), sku: 'Developer', provisioningState: 'Succeeded',
    gatewayUrl: `https://${cfg.azure.apimName}.azure-api.net`,
    identity: { type: 'SystemAssigned', principalId, tenantId: cfg.azure.tenantId }, tags: { [OWNER_TAG]: ownerId(cfg) },
  };
  const backend = new Map();
  const mi = cfg.connectors.find(c => c.auth === 'managed-identity')?.managedIdentity;
  if (mi) {
    backend.set('backend-principal', { id: mi.principalId, appId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', servicePrincipalType: 'ManagedIdentity', accountEnabled: true });
    backend.set('backend-application', { id: mi.servicePrincipalId, appId: mi.resource, accountEnabled: true,
      servicePrincipalType: 'Application', appRoles: [{ id: mi.appRoleId, value: mi.appRole, isEnabled: true, allowedMemberTypes: ['Application'] }] });
    backend.set('backend-assignment', list([{ principalId: mi.principalId, principalType: 'ServicePrincipal',
      resourceId: mi.servicePrincipalId, appRoleId: mi.appRoleId }]));
  }
  let globalPolicy = options.globalPolicy ?? passthrough;
  const run = async (_, args) => {
    calls.push(args);
    if (args[0] === 'account') return { id: cfg.azure.subscriptionId, tenantId: cfg.azure.tenantId, user: mockAzureUser };
    if (args[0] === 'resource') return options.resources ?? [];
    if (args[0] === 'group') return args[1] === 'exists' ? true : {};
    if (args[0] === 'apim') return structuredClone(service);
    if (args[0] === 'keyvault') return {
      id: `/subscriptions/${cfg.azure.subscriptionId}/resourceGroups/${cfg.azure.resourceGroup}/providers/Microsoft.KeyVault/vaults/${cfg.azure.keyVaultName}`,
      tenantId: cfg.azure.tenantId, rbac: true, tags: { [OWNER_TAG]: ownerId(cfg) },
    };
    if (args[0] === 'deployment') {
      if (args[2] === 'validate') return {};
      const template = JSON.parse(await readFile(args[args.indexOf('--template-file') + 1], 'utf8'));
      for (const resource of template.resources) {
        const id = resource.name.split('/')[1];
        if (resource.type.endsWith('/apis')) {
          const properties = structuredClone(resource.properties);
          if (properties.format === 'openapi+json') {
            const document = JSON.parse(properties.value);
            properties.description = document.info.description;
            operations.set(id, Object.entries(document.paths).flatMap(([urlTemplate, item]) =>
              Object.entries(item).filter(([, op]) => op.operationId).map(([method, op]) => ({
                id: `${serviceResourceId(cfg)}/apis/${id}/operations/${op.operationId}`, name: op.operationId,
                properties: { method: method.toUpperCase(), urlTemplate, templateParameters: [],
                  request: { queryParameters: [], headers: [], representations: [] } },
              }))));
          }

          apis.set(id, { name: id, properties });
          if (options.failDuringStaging && args.includes(path.join(options.dir, 'infra', 'staging.json'))) {
            options.failDuringStaging = false;
            throw new Error('Simulated interruption');
          }
        }
        if (resource.type.endsWith('/apis/policies')) policies.set(id, resource.properties.value);
        if (resource.type.endsWith('/apis/tools')) {
          const name = resource.name.split('/')[2];
          tools.set(`${id}/${name}`, { id: `${serviceResourceId(cfg)}/apis/${id}/tools/${name}`, name, properties: resource.properties });
        }
        if (resource.type.endsWith('/service/policies')) globalPolicy = resource.properties.value;
        if (resource.type.endsWith('/namedValues')) values.set(id, { name: id, properties: resource.properties });
        if (resource.type.endsWith('/backends')) proxyBackends.set(id, {
          id: `${serviceResourceId(cfg)}/backends/${id}`, name: id, properties: structuredClone(resource.properties),
        });
      }
      return {};
    }
    assert.equal(args[0], 'rest');
    const url = new URL(args[args.indexOf('--url') + 1]);
    if (url.hostname === 'graph.microsoft.com') {
      for (const c of cfg.connectors) for (const request of managedIdentityRequests(c)) {
        if (url.href === request.url) {
          assert.ok(args.includes('GET'));
          assert.equal(args[args.indexOf('--query') + 1], request.query);
          return structuredClone(backend.get(request.kind));
        }
      }
      if (url.pathname.includes('servicePrincipals')) return list([{ id: principalId, appId: application.appId }]);
      return application;
    }
    const method = args[args.indexOf('--method') + 1];
    if (experimentalProxy(cfg) && url.pathname === `${proxySecretScope(cfg)}/providers/Microsoft.Authorization/roleAssignments`) {
      assert.equal(method, 'GET');
      return list(grants);
    }
    if (url.pathname === serviceResourceId(cfg)) return args[args.indexOf('--query') + 1]?.includes('sku:')
      ? structuredClone(service) : {
        id: service.id, identity: structuredClone(service.identity), properties: { provisioningState: service.provisioningState },
      };
    const suffix = url.pathname.split(`/service/${cfg.azure.apimName}/`)[1];
    if (suffix === 'apis') {
      const result = list([...apis.values()]);
      if (options.sparseUnrelatedMcp) {
        const unrelated = result.value.find(api => api.name === 'unrelated');
        delete unrelated.properties.mcpProperties;
        delete unrelated.properties.serviceUrl;
      }
      return result;
    }
    if (suffix === 'namedValues') return list([...values.values()]);
    if (suffix === 'backends') return list([...proxyBackends.values()].map(item => ({ name: item.name })));
    if (suffix?.startsWith('backends/')) return structuredClone(proxyBackends.get(suffix.slice('backends/'.length)));
    if (suffix === 'diagnostics') return list(options.diagnostics ?? []);
    if (suffix === 'policies') return list([{ name: 'policy', properties: { value: globalPolicy } }]);
    const apiMatch = /^apis\/([^/]+)$/.exec(suffix);
    if (apiMatch) return { ...apis.get(apiMatch[1]), id: `${serviceResourceId(cfg)}/${suffix}` };
    const toolMatch = /^apis\/([^/]+)\/tools\/([^/]+)$/.exec(suffix);
    if (toolMatch) return tools.get(`${toolMatch[1]}/${toolMatch[2]}`);
    const operationMatch = /^apis\/([^/]+)\/operations\/([^/]+)$/.exec(suffix);
    if (operationMatch) return operations.get(operationMatch[1])?.find(op => op.name === operationMatch[2]);
    const childMatch = /^apis\/([^/]+)\/(diagnostics|operations|tools)$/.exec(suffix);
    if (childMatch) {
      if (childMatch[2] === 'diagnostics') return list(apiDiagnostics.get(childMatch[1]) ?? []);
      if (childMatch[2] === 'operations') return list(operations.get(childMatch[1]) ?? []);
      return list(options.tools ?? [...tools.values()].filter(tool => tool.id.includes(`/apis/${childMatch[1]}/tools/`)));
    }
    const opPolicyMatch = /^apis\/([^/]+)\/operations\/([^/]+)\/policies$/.exec(suffix);
    if (opPolicyMatch) return list(operationPolicies.get(`${opPolicyMatch[1]}/${opPolicyMatch[2]}`) ?? []);
    const match = /^apis\/([^/]+)\/policies(?:\/policy)?$/.exec(suffix);
    assert.ok(match, `Unexpected mock command path ${suffix}`);
    if (method === 'PUT') {
      const body = JSON.parse(await readFile(args[args.indexOf('--body') + 1].slice(1), 'utf8'));
      policies.set(match[1], body.properties.value);
      return options.xmlPolicyResponse ? { code: 0, stdout: `\uFEFF${body.properties.value}` } : {};
    }
    if (url.searchParams.get('format') === 'rawxml') {
      assert.ok(args.includes('Accept=application/json'));
      return { name: 'policy', properties: { format: 'rawxml', value: policies.get(match[1]) } };
    }
    if (options.escapedPolicyListing && policies.has(match[1])) {
      return list([{ name: 'policy', properties: { format: 'xml',
        value: policies.get(match[1]).replace(/&quot;/g, '&amp;quot;').replace(/&amp;&amp;/g, '&amp;amp;&amp;amp;') } }]);
    }
    return list(policies.has(match[1]) ? [{ name: 'policy', properties: { value: policies.get(match[1]) } }] : []);
  };
  return { run, calls, apis, policies, values, service, backend, proxyBackends, grants, apiDiagnostics, operations, tools, operationPolicies, global: () => globalPolicy };
}

async function experimentalFixture(t, { tavily = false } = {}) {
  await mkdir(path.join(TOOLKIT_ROOT, '.test-output'), { recursive: true });
  const root = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'experimental-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples/mcp/upstream-key.json'), 'utf8'));
  input.schemaVersion = 3; input.experimentalProfile = 'owned-backend-routing-v1';
  input.backend.endpoint = 'https://upstream.example.com/mcp/';
  if (tavily) { input.backend.endpoint = 'https://mcp.tavily.com/mcp/'; input.backend.apiKey.headerName = 'Authorization'; }
  Object.assign(input.azure, { resourceGroupMode: 'existing', keyVaultMode: 'existing' });
  const review = await prepareMcpServer(input), dir = path.join(root, 'project'), cfg = mcpRuntimeConfig(input);
  await createMcpServerProject(review, { workspaceRoot: root, projectDir: dir });
  await selectMockAzureIdentity(dir, cfg.azure);
  const application = { appId: input.inbound.clientId, identifierUris: [input.inbound.applicationIdUri],
    api: { oauth2PermissionScopes: [{ id: principalId, value: input.inbound.scope, isEnabled: true }],
      preAuthorizedApplications: input.inbound.allowedClientIds.map(appId => ({ appId, delegatedPermissionIds: [principalId] })) } };
  const mock = runner(cfg, application);
  const backendId = proxyBackendId(cfg, cfg.connectors[0]);
  const backendResource = { name: backendId, id: `${serviceResourceId(cfg)}/backends/${backendId}`,
    properties: proxyBackendProperties(cfg, cfg.connectors[0]) };
  const execute = async (run = mock.run, phase = 'gateway') => {
    const plan = await planMcpServerProvision(dir, { phase });
    assert.ok(plan.plan.steps.some(step => step.id === 'check-proxy-grant'));
    assert.ok(plan.plan.steps.some(step => step.id === 'check-proxy-backends'));
    assert.ok(!plan.plan.steps.some(step => /secret-access|create-app|merge-app|create-principal/.test(step.id)));
    return provisionMcpServer(dir, { phase, approval: plan.approvalToken, run });
  };
  return { dir, cfg, mock, review, execute, backendId, backendResource };
}

async function configurationFixture(t, { historical = true, tavily = false } = {}) {
  const f = await experimentalFixture(t, { tavily });
  let activated = false, rejected = false;
  const result = await f.execute(async (command, args) => {
    if (historical && activated && !rejected && args[0] === 'rest' && args.some(value => value.endsWith('/apis?api-version=2025-09-01-preview'))) {
      rejected = true;
      throw new ApimSafetyError('APIM_PROXY_MAPPING_MISMATCH', 'Pinned old verifier required transportType presence.');
    }
    const output = await f.mock.run(command, args);
    if (args[0] === 'deployment' && args[2] === 'create' && args.includes(path.join(f.dir, 'infra', 'gateway.json'))) {
      activated = true;
      delete f.mock.apis.get(f.review.descriptor.ownership.apiId).properties.mcpProperties.transportType;
    }
    return output;
  });
  assert.equal(result.lifecycleStatus, historical ? 'failed-uncertain' : 'completed');
  if (historical) assert.equal(result.failedStep, 'verify-owned-apis');
  f.inspect = async (run = f.mock.run) => {
    const plan = await planMcpServerReconcile(f.dir, { experimentalConfiguration: true });
    return reconcileMcpServer(f.dir, { experimentalConfiguration: true, approval: plan.approvalToken, allowCloud: true, run });
  };
  return f;
}

const configurationTools = { tools: [{ name: 'readFixture', description: 'Read synthetic test data.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] };

function configurationObservation(f) {
  const identity = { discoveryClientId: f.cfg.inbound.allowedClientIds[0], expectedUserId: '77777777-7777-4777-8777-777777777777' };
  return { identity, network: observationTransport(f.review.descriptor, identity, configurationTools) };
}

async function qualificationFixture(t, { skipProof = false } = {}) {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected live network'));
  const f = await configurationFixture(t, { tavily: true }); await f.inspect();
  const identity = configurationObservation(f).identity, metadata = tavilyQualificationTools();
  const network = observationTransport(f.review.descriptor, identity, metadata);
  const discovery = await planMcpProjectDiscovery(f.dir, identity);
  const capture = await executeMcpProjectForTest(f.dir, { selection: identity, approval: discovery, allowNetwork: true, onDeviceCode() {} }, false,
    (source, options, guard) => discoverMcpToolsForTest(source, options, { ...network, beforeRequest: guard }));
  const selection = { capture: capture.result, toolName: 'tavily_search', arguments: tavilyQualificationArguments(),
    safetyReview: { readOnly: true, reason: 'Owner reviewed one public documentation search with bounded result predicates.' } };
  await assert.rejects(planMcpProjectQualification(f.dir, selection), { code: 'QUALIFICATION_PRIOR_PROOF_REQUIRED' });
  if (skipProof) return { ...f, selection, capture, network, metadata };
  const priorApproval = await planMcpProjectProof(f.dir, selection);
  const prior = await executeMcpProjectForTest(f.dir, { selection, approval: priorApproval, allowNetwork: true, onDeviceCode() {} }, true,
    (source, options, guard, hooks) => runMcpReadOnlyProofForTest(source, options, { ...network, ...hooks, beforeRequest: guard }));
  f.qualify = async (approval, mcpTransport = network.mcpTransport, selected = selection) =>
    executeMcpProjectForTest(f.dir, { selection: selected, approval, allowNetwork: true, onDeviceCode() {} }, 'qualification',
      (source, options, guard, hooks) => runMcpQualifiedProof(source, options, options.approval.qualification,
        { ...network, mcpTransport, ...hooks, beforeRequest: guard }));
  return { ...f, selection, priorApproval, prior, capture, network, metadata };
}

function qualifiedResponse(request, query) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    content: [], structuredContent: { query, images: [], results: [{
      url: 'https://learn.microsoft.com/en-us/azure/api-management/mcp', title: 'PRIVATE_TITLE', content: 'PRIVATE_CONTENT',
    }] },
  } }));
}

test('local diagnosis reads retained managed failures and deadlines without auth cache or extra commands', async t => {
  const f = await qualificationFixture(t);
  const calls = f.mock.calls.length;
  const original = await readFile(path.join(f.dir, '.mcp-configuration.json'));
  const hidden = path.join(f.dir, 'excluded-synthetic-cache');
  await rename(path.join(f.dir, '.azure-auth'), hidden);
  await writeFile(path.join(f.dir, '.azure-auth'), 'PRIVATE_NOT_A_CACHE_DIRECTORY');
  let report = await readMcpDiagnosis(f.dir);
  assert.equal(report.layers.identity.status, 'selection-retained-session-not-checked');
  assert.equal(report.layers.configuration.status, 'recorded-unexpired', JSON.stringify(report));
  assert.equal(report.layers.calls.completed, 1);
  assert.equal(report.layers.calls.protocolSuccess, 1);
  assert.equal(report.authenticationCacheRead, false);
  const clock = t.mock.method(Date, 'now', () => Date.parse(f.capture.result.capturedAt) + 2 * 86400000);
  report = await readMcpDiagnosis(f.dir);
  assert.equal(report.layers.configuration.status, 'expired');
  assert.equal(report.layers.calls.completed, 1);
  assert.equal(report.layers.captures.expired, 1);
  assert.ok(report.deadlines.every(d => d.remainingMs === 0));
  assert.equal(f.mock.calls.length, calls);
  assert.deepEqual(await readFile(path.join(f.dir, '.mcp-configuration.json')), original);
  clock.mock.restore();
  await unlink(path.join(f.dir, '.azure-auth'));
  await rename(hidden, path.join(f.dir, '.azure-auth'));
  for (let index = 0; index < 2; index++) {
    const result = await f.inspect(async (command, args) => {
      if (args[0] === 'apim' && args[1] === 'show') throw new InspectionError('AZURE_INSPECTION_COMMAND_TIMEOUT');
      return f.mock.run(command, args);
    });
    assert.equal(result.errorCode, 'AZURE_INSPECTION_COMMAND_TIMEOUT');
  }
  const distinct = await f.inspect(async (command, args) => {
    if (args[0] === 'keyvault' && args[1] === 'show') throw new InspectionError('AZURE_INSPECTION_COMMAND_TIMEOUT');
    return f.mock.run(command, args);
  });
  assert.equal(distinct.failedStep, 'check-vault');
  const afterFailures = f.mock.calls.length;
  report = await readMcpDiagnosis(f.dir);
  const failure = report.failures.find(r => r.errorClass === 'azure-management-timeout' && r.stage === 'check-service');
  assert.equal(failure.stage, 'check-service');
  assert.equal(failure.operation.resource, 'apim-service');
  assert.equal(failure.equivalentFailures, 2, JSON.stringify(report));
  assert.equal(failure.elapsedMs, null, 'No inspection start timestamp was retained');
  assert.equal(failure.recordedBudget.commandTimeoutMs, 60000);
  assert.equal(failure.recordedBudget.overallTimeoutMs, 300000);
  assert.equal(report.failures.find(r => r.stage === 'check-vault').equivalentFailures, 1);
  assert.equal(report.layers.calls.completed, 1);
  assert.equal(f.mock.calls.length, afterFailures);
  assert.match(report.guidance.join(' '), /Stop repeating/);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|excluded-synthetic-cache/);
  await unlink(path.join(f.dir, '.azure-identity.json'));
  report = await readMcpDiagnosis(f.dir);
  assert.equal(report.layers.identity.status, 'missing');
  assert.equal(report.next.authentication, 'fresh-private-account-selection-required');
});

test('evidence recovery preserves expired managed configuration and consumed proof without porting current identity', async t => {
  const f = await qualificationFixture(t);
  const root = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'managed-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'checkpoint.zip'), destination = path.join(root, 'restored');
  const beforeCalls = f.mock.calls.length;
  const clock = t.mock.method(Date, 'now', () => Date.parse(f.capture.result.capturedAt) + 2 * 86400000);
  const plan = await planMcpEvidenceExport(f.dir, { output });
  assert.equal(plan.semanticEvidence.generation, 'matches-current-generator');
  assert.equal(plan.semanticEvidence.captures[0].status, 'stale');
  const exported = await exportMcpEvidence(f.dir, { output, approval: plan.approvalToken });
  const options = { output: destination, sha256: exported.archiveSha256 };
  const restore = await planMcpEvidenceRestore(output, options);
  await restoreMcpEvidence(output, { ...options, approval: restore.approvalToken });
  for (const file of plan.manifest.files) {
    assert.deepEqual(await readFile(path.join(destination, ...file.path.split('/'))), await readFile(path.join(f.dir, ...file.path.split('/'))));
  }
  assert.equal(existsSync(path.join(destination, '.azure-auth')), false);
  const status = await readMcpStatus(destination, { journey: true });
  assert.equal(status.proofs.find(p => p.status === 'completed').protocolStatus, 'protocol-success');
  assert.equal(status.experimental.configuration.status, 'invalid');
  assert.equal((await planMcpResume(destination, { phase: 'proof' })).next.code, 'PURPOSE_CONSUMED');
  assert.equal((await planMcpResume(destination, { phase: 'configuration' })).next.code, 'AZURE_IDENTITY_REQUIRED');
  await assert.rejects(readAzureIdentity(mcpRuntimeConfig(f.review.input), destination, { required: true }), { code: 'AZURE_IDENTITY_REQUIRED' });
  const oldIdentity = JSON.parse(await readFile(path.join(destination, '.azure-identity.json')));
  await selectMockAzureIdentity(destination, f.review.input.azure);
  const freshIdentity = await readAzureIdentity(mcpRuntimeConfig(f.review.input), destination, { required: true });
  assert.notEqual(freshIdentity.epoch, oldIdentity.epoch);
  assert.equal(freshIdentity.projectDir, destination);
  assert.equal((await planMcpResume(destination, { phase: 'proof' })).next.code, 'PURPOSE_CONSUMED');
  assert.equal(f.mock.calls.length, beforeCalls);
  clock.mock.restore();
});

for (const outcome of ['passed', 'failed', 'inconclusive', 'unknown', 'tool-error']) test(`first-call Tavily profile binds and consumes ${outcome} without extra calls or content`, async t => {
  const f = await qualificationFixture(t, { skipProof: true });
  const baseline = await planMcpProjectProof(f.dir, f.selection);
  const baselineBytes = JSON.stringify(baseline);
  const selection = { ...f.selection, acceptanceProfile: 'tavily-search-result-v1' };
  let approval = await planMcpProjectProof(f.dir, selection);
  assert.equal(JSON.stringify(await planMcpProjectProof(f.dir, f.selection)), baselineBytes);
  assert.equal(baseline.operation.acceptanceProfile, undefined);
  assert.equal(baseline.executionVersion, 2);
  assert.equal(approval.executionVersion, 4);
  assert.notEqual(approval.approvalDigest, baseline.approvalDigest);
  assert.notEqual(approval.operation.approvalDigest, baseline.operation.approvalDigest);
  assert.deepEqual(approval.operation.acceptanceProfile, tavilyFirstCallProfile());
  for (const bad of ['script-v1', null, { kind: 'tavily-search-result-v1' }]) {
    await assert.rejects(planMcpProjectProof(f.dir, { ...selection, acceptanceProfile: bad }), { code: 'ACCEPTANCE_PROFILE_UNSUPPORTED' });
  }
  await assert.rejects(planMcpProjectProof(f.dir, { ...selection, arguments: { ...selection.arguments, max_results: 2 } }),
    { code: 'ACCEPTANCE_ARGUMENTS_INVALID' });
  const core = await import('../src/core.js');
  assert.throws(() => core.planMcpReadOnlyProof(f.review.descriptor, selection), { code: 'INVALID_CONFIG' });
  let calls = 0;
  const transport = async (url, options) => {
    const request = JSON.parse(options.body);
    if (request.method !== 'tools/call') return f.network.mcpTransport(url, options);
    calls++;
    assert.deepEqual(request.params.arguments, tavilyQualificationArguments());
    if (outcome === 'unknown') throw Error('PRIVATE_LOST_RESPONSE');
    if (outcome === 'passed') return qualifiedResponse(request, selection.arguments.query);
    const result = outcome === 'failed' ? { content: [], structuredContent: { results: [] } }
      : outcome === 'tool-error' ? { content: [], isError: true }
        : { content: [{ type: 'text', text: 'PRIVATE_PROSE' }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  };
  const execute = (reviewed, mcpTransport = transport) => executeMcpProjectForTest(f.dir,
    { selection, approval: reviewed, allowNetwork: true, onDeviceCode() {} }, true,
    (source, options, guard, hooks) => runMcpAcceptedProof(source, options, { ...f.network, mcpTransport, ...hooks, beforeRequest: guard }));
  await assert.rejects(execute(baseline), { code: 'APPROVAL_REQUIRED' });
  const tamperedPlan = structuredClone(approval);
  tamperedPlan.operation.acceptanceProfile.resultCount = 2;
  await assert.rejects(execute(tamperedPlan), { code: 'APPROVAL_REQUIRED' });
  assert.equal(calls, 0);
  if (outcome === 'passed') {
    await assert.rejects(execute(approval, () => { throw Error('PRIVATE_BEFORE_DISPATCH'); }));
    const fresh = await planMcpProjectProof(f.dir, selection);
    assert.equal(fresh.proofHistory.attempts.filter(a => a.acceptanceProfile)[0].status, 'not-dispatched');
    assert.notEqual(fresh.approvalDigest, approval.approvalDigest);
    await assert.rejects(execute(approval), { code: 'APPROVAL_REQUIRED' });
    approval = fresh;
  }
  const result = await execute(approval);
  assert.equal(calls, 1);
  assert.equal(result.result.backendAssertion.status, outcome === 'unknown' ? 'not-evaluated' : outcome === 'tool-error' ? 'failed' : outcome);
  assert.deepEqual(result.result.acceptanceProfile, firstCallProfileBinding());
  assert.equal(result.result.businessCorrectnessVerified, false);
  assert.equal(result.result.coworkRuntimeVerified, false);
  const bytes = await readFile(result.resultFile);
  assert.doesNotMatch(bytes.toString(), /PRIVATE|https:\/\/learn.microsoft.com/);
  const status = await readMcpStatus(f.dir), attempt = status.proofs.find(a => a.status !== 'not-proof' && a.status !== 'not-dispatched');
  assert.equal(attempt.status, outcome === 'unknown' ? 'unresolved' : 'completed');
  assert.deepEqual(attempt.backendAssertion, result.result.backendAssertion);
  const blocked = outcome === 'unknown' ? 'PROOF_OUTCOME_UNRESOLVED' : 'PROOF_REPLAY_BLOCKED';
  await assert.rejects(planMcpProjectProof(f.dir, selection), { code: blocked });
  await assert.rejects(planMcpProjectQualification(f.dir, f.selection),
    { code: outcome === 'unknown' ? 'PROOF_OUTCOME_UNRESOLVED' : 'QUALIFICATION_CONSUMED' });
  const ordinary = await planMcpProjectProof(f.dir, f.selection);
  await assert.rejects(executeMcpProjectForTest(f.dir, { selection: f.selection, approval: ordinary, allowNetwork: true }, true,
    () => assert.fail('No default-profile replay')), { code: blocked });
  const resumed = await planMcpResume(f.dir, { phase: 'qualification' });
  assert.equal(resumed.next.code, outcome === 'unknown' ? 'OUTCOME_UNRESOLVED' : 'PURPOSE_CONSUMED');
  if (outcome === 'passed') {
    const discovery = await planMcpProjectDiscovery(f.dir, f.capture.result.discoveryPlan.auth
      ? { discoveryClientId: f.capture.result.discoveryPlan.auth.discoveryClientId,
        expectedUserId: f.capture.result.discoveryPlan.auth.expectedUserId } : {});
    const observed = await executeMcpProjectForTest(f.dir, {
      selection: { discoveryClientId: discovery.operation.auth.discoveryClientId, expectedUserId: discovery.operation.auth.expectedUserId },
      approval: discovery, allowNetwork: true, onDeviceCode() {} }, false,
    (source, options, guard) => discoverMcpToolsForTest(source, options, { ...f.network, beforeRequest: guard }));
    assert.notEqual(observed.result.receiptDigest, f.capture.result.receiptDigest);
    await assert.rejects(planMcpProjectProof(f.dir, { ...selection, capture: observed.result }), { code: 'PROOF_REPLAY_BLOCKED' });
    const changed = await planMcpProjectProof(f.dir, { ...f.selection, capture: observed.result });
    await assert.rejects(executeMcpProjectForTest(f.dir, { selection: { ...f.selection, capture: observed.result },
      approval: changed, allowNetwork: true }, true, () => assert.fail('No changed-capture replay')), { code: 'PROOF_REPLAY_BLOCKED' });
    for (const mutate of [
      proof => { proof.acceptanceProfile.profileDigest = `sha256:${'a'.repeat(64)}`; },
      proof => { proof.backendAssertion.predicate = 'custom-script'; },
      proof => { proof.backendAssertion.content = 'PRIVATE_FORBIDDEN'; },
      proof => { proof.status = 'tool-error'; },
      proof => { delete proof.acceptanceProfile; },
    ]) {
      const copy = JSON.parse(bytes); mutate(copy);
      const { receiptDigest, ...body } = copy;
      copy.receiptDigest = metadataDigest(boundedSnapshot(body));
      await writeFile(result.resultFile, JSON.stringify(copy));
      await assert.rejects(readMcpStatus(f.dir), { code: 'METADATA_MISMATCH' });
      await writeFile(result.resultFile, bytes);
    }
  }
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(f.capture.resultFile), Buffer.from(JSON.stringify(f.capture.result, null, 2) + '\n'));
});

const historyDigest = value => metadataDigest(boundedSnapshot(value));

async function syntheticHistoricalRejection(outputDir, origin, mutate = () => {}) {
  const intentFile = path.join(outputDir, 'intent.json');
  const intent = JSON.parse(await readFile(intentFile));
  intent.plan.projectDir = origin;
  intent.plan.binding.identity.projectDir = origin;
  mutate(intent);
  const { approvalDigest, ...planBody } = intent.plan;
  intent.plan.approvalDigest = historyDigest(planBody);
  const { receiptDigest, ...intentBody } = intent;
  intent.receiptDigest = historyDigest(intentBody);
  await writeFile(intentFile, JSON.stringify(intent));
  const evidence = {}, bytes = new Map();
  for (const file of (await readdir(outputDir)).filter(name => name !== 'intent.json')) {
    const { receiptDigest: oldDigest, ...body } = JSON.parse(await readFile(path.join(outputDir, file)));
    body.intentDigest = intent.receiptDigest;
    evidence[file] = { ...body, receiptDigest: historyDigest(body) };
    await writeFile(path.join(outputDir, file), JSON.stringify(evidence[file]));
  }
  for (const file of await readdir(outputDir)) bytes.set(path.join(outputDir, file), await readFile(path.join(outputDir, file)));
  return { bytes, approvalDigest: intent.plan.approvalDigest, evidenceDigest: historyDigest({ intent, evidence }) };
}

async function relocatedQualificationHistories(f) {
  const bytes = new Map();
  for (const provider of [false, true]) {
    const plan = await (provider ? planMcpBackendRejection : planMcpAuthRejection)(f.dir);
    const result = await (provider ? executeMcpBackendRejection : executeMcpAuthRejection)(f.dir,
      { approval: plan.approvalDigest, allowNetwork: true }, { transport: async () => new Response(null, { status: 401 }) });
    const historical = await syntheticHistoricalRejection(result.outputDir, 'C:\\original-workspace\\tavily-mcp-v3');
    for (const entry of historical.bytes) bytes.set(...entry);
  }
  return bytes;
}

async function unchangedHistory(bytes) {
  for (const [file, original] of bytes) assert.deepEqual(await readFile(file), original);
}

test('Tavily qualification is a linked singleton purpose, preserves consumed proof and publishes only closed predicates', async t => {
  const f = await qualificationFixture(t), priorBytes = await readFile(f.prior.resultFile);
  await assert.rejects(planMcpProjectProof(f.dir, { ...f.selection, acceptanceProfile: 'tavily-search-result-v1' }),
    { code: 'PROOF_REPLAY_BLOCKED' });
  const historicalBytes = await relocatedQualificationHistories(f);
  const approval = await planMcpProjectQualification(f.dir, f.selection);
  for (const history of Object.values(approval.rejectionHistory)) {
    assert.equal(history.historicalProvenance.historicalOnly, true);
    assert.equal(history.historicalProvenance.authorizesExecution, false);
    assert.equal(history.historicalProvenance.currentProjectDir, f.dir);
  }
  const configurationFile = path.join(f.dir, '.mcp-configuration.json');
  const configurationBytes = await readFile(configurationFile), configuration = JSON.parse(configurationBytes);
  const clock = t.mock.method(Date, 'now', () => Date.parse(configuration.expiresAt));
  await assert.rejects(planMcpProjectQualification(f.dir, f.selection), { code: 'MCP_CONFIGURATION_STALE' });
  clock.mock.restore();
  const { evidenceDigest, ...wrongRoot } = configuration;
  wrongRoot.projectDir = 'C:\\original-workspace\\tavily-mcp-v3';
  await writeFile(configurationFile, JSON.stringify({ ...wrongRoot, evidenceDigest: historyDigest(wrongRoot) }));
  await assert.rejects(planMcpProjectQualification(f.dir, f.selection), { code: 'MCP_CONFIGURATION_INVALID' });
  await writeFile(configurationFile, configurationBytes);
  const identityFile = path.join(f.dir, '.azure-identity.json'), identityBytes = await readFile(identityFile);
  await selectMockAzureIdentity(f.dir, f.cfg.azure);
  await assert.rejects(planMcpProjectQualification(f.dir, f.selection), { code: 'MCP_CONFIGURATION_INVALID' });
  await writeFile(identityFile, identityBytes);
  assert.deepEqual(await planMcpProjectQualification(f.dir, f.selection), approval);
  assert.equal(approval.executionVersion, 3);
  assert.equal(approval.operation.additionalToolCalls, 1);
  assert.equal(approval.operation.qualification.priorOperationDigest, f.priorApproval.operation.approvalDigest);
  await assert.rejects(f.qualify(f.priorApproval), { code: 'APPROVAL_REQUIRED' });
  await assert.rejects(planMcpProjectQualification(f.dir, { ...f.selection, arguments: { ...f.selection.arguments, query: 'Different' } }),
    { code: 'QUALIFICATION_ARGUMENTS_INVALID' });
  await assert.rejects(executeMcpProjectForTest(f.dir, { selection: f.selection, approval: f.priorApproval, allowNetwork: true }, true,
    () => assert.fail('Consumed protocol proof')), { code: 'PROOF_REPLAY_BLOCKED' });
  const cosmetic = { ...f.selection, safetyReview: { readOnly: true, reason: 'Another description of this same public documentation search.' } };
  const cosmeticPlan = await planMcpProjectProof(f.dir, cosmetic);
  await assert.rejects(executeMcpProjectForTest(f.dir, { selection: cosmetic, approval: cosmeticPlan, allowNetwork: true }, true,
    () => assert.fail('Consumed proof cannot escape by editing its reason')), { code: 'PROOF_REPLAY_BLOCKED' });
  let calls = 0;
  const outcome = await f.qualify(approval, async (url, options) => {
    const request = JSON.parse(options.body);
    if (request.method === 'tools/call') {
      calls++; assert.deepEqual(request.params.arguments, f.selection.arguments);
      await assert.rejects(f.inspect(), { code: 'PROVISIONING_LOCKED' });
      return qualifiedResponse(request, f.selection.arguments.query);
    }
    return f.network.mcpTransport(url, options);
  });
  assert.equal(calls, 1);
  assert.equal(outcome.result.backendAssertion.status, 'passed');
  assert.equal(outcome.result.businessCorrectnessVerified, false);
  assert.doesNotMatch(await readFile(outcome.resultFile, 'utf8'), /PRIVATE_|learn\.microsoft\.com/);
  assert.deepEqual(await readFile(f.prior.resultFile), priorBytes);
  await unchangedHistory(historicalBytes);
  const status = await readMcpStatus(f.dir);
  assert.equal(status.qualifications[0].backendAssertion.resultCount, 1);
  assert.equal(status.proofs.filter(item => item.status === 'completed').length, 1);
  await assert.rejects(planMcpProjectQualification(f.dir, f.selection), { code: 'QUALIFICATION_CONSUMED' });
  const changed = { ...f.selection, safetyReview: { readOnly: true, reason: 'A different cosmetic reason cannot authorize another search.' } };
  const ordinary = await planMcpProjectProof(f.dir, changed);
  await assert.rejects(executeMcpProjectForTest(f.dir, { selection: changed, approval: ordinary, allowNetwork: true }, true,
    () => assert.fail('Qualification cannot be bypassed by ordinary proof')), { code: 'QUALIFICATION_CONSUMED' });
  const resultFile = outcome.resultFile, original = await readFile(resultFile), result = JSON.parse(original);
  result.backendAssertion.extra = true;
  const { receiptDigest, ...body } = result;
  result.receiptDigest = metadataDigest(boundedSnapshot(body));
  await writeFile(resultFile, JSON.stringify(result));
  await assert.rejects(readMcpStatus(f.dir), { code: 'METADATA_MISMATCH' });
  await writeFile(resultFile, original);
  for (const [name, mutate] of [
    ['intent.json', value => { value.executionVersion = 4; }],
    ['intent.json', value => { value.qualification.extra = true; }],
    ['intent.json', value => { value.qualification.priorEvidenceDigest = `sha256:${'0'.repeat(64)}`; }],
    ['dispatch.json', value => { value.extra = true; }],
  ]) {
    const filename = path.join(outcome.outputDir, name), bytes = await readFile(filename), value = JSON.parse(bytes);
    mutate(value); await writeFile(filename, JSON.stringify(value));
    await assert.rejects(readMcpStatus(f.dir), { code: 'METADATA_MISMATCH' });
    await writeFile(filename, bytes);
  }
  await f.inspect();
  await assert.rejects(planMcpProjectQualification(f.dir, f.selection), { code: 'QUALIFICATION_CONSUMED' });
});

for (const failed of [false, true]) test(`Tavily qualification consumes ${failed ? 'failed predicates' : 'unsupported prose'} without retaining the response`, async t => {
  const f = await qualificationFixture(t);
  const historicalBytes = await relocatedQualificationHistories(f);
  const approval = await planMcpProjectQualification(f.dir, f.selection);
  let calls = 0;
  const outcome = await f.qualify(approval, async (url, options) => {
    const request = JSON.parse(options.body);
    if (request.method !== 'tools/call') return f.network.mcpTransport(url, options);
    calls++;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: failed
      ? { content: [], structuredContent: { results: [] } }
      : { content: [{ type: 'text', text: 'PRIVATE_UNSUPPORTED_PROSE' }] } }));
  });
  assert.equal(calls, 1);
  assert.equal(outcome.result.backendAssertion.status, failed ? 'failed' : 'inconclusive');
  assert.equal((await readMcpStatus(f.dir)).qualifications[0].status, 'completed');
  const resume = await planMcpResume(f.dir, { phase: 'qualification' });
  assert.equal(resume.next.code, 'PURPOSE_CONSUMED');
  assert.equal(resume.layers.qualification.attempts[0].backendAssertion.status, failed ? 'failed' : 'inconclusive');
  assert.doesNotMatch(await readFile(outcome.resultFile, 'utf8'), /PRIVATE/);
  await assert.rejects(planMcpProjectQualification(f.dir, f.selection), { code: 'QUALIFICATION_CONSUMED' });
  await unchangedHistory(historicalBytes);
});

test('Tavily qualification keeps not-dispatched recovery distinct from post-dispatch expiry and blocks both command families', async t => {
  const f = await qualificationFixture(t);
  await relocatedQualificationHistories(f);
  const approval = await planMcpProjectQualification(f.dir, f.selection);
  await assert.rejects(f.qualify(approval, () => { throw Error('Offline pre-dispatch disconnect'); }));
  const fresh = await planMcpProjectQualification(f.dir, f.selection);
  assert.notEqual(fresh.approvalDigest, approval.approvalDigest);
  assert.equal(fresh.proofHistory.attempts.filter(item => item.qualification)[0].status, 'not-dispatched');
  const config = path.join(f.dir, 'resume-selection.json');
  await writeFile(config, JSON.stringify(f.selection));
  const resume = await planMcpResume(f.dir, { phase: 'qualification', config });
  assert.equal(resume.next.command, 'mcp-qualification');
  assert.equal(resume.next.phaseApproval, fresh.approvalDigest);
  const evidence = await readExperimentalConfiguration(f.dir);
  let clock, calls = 0;
  await assert.rejects(f.qualify(fresh, async (url, options) => {
    const request = JSON.parse(options.body);
    if (request.method === 'tools/call') {
      calls++; clock = t.mock.method(Date, 'now', () => Date.parse(evidence.expiresAt));
      return qualifiedResponse(request, f.selection.arguments.query);
    }
    return f.network.mcpTransport(url, options);
  }));
  clock.mock.restore(); assert.equal(calls, 1);
  await f.inspect();
  await assert.rejects(planMcpProjectQualification(f.dir, f.selection), { code: 'PROOF_OUTCOME_UNRESOLVED' });
  const proof = await planMcpProjectProof(f.dir, f.selection);
  await assert.rejects(executeMcpProjectForTest(f.dir, { selection: f.selection, approval: proof, allowNetwork: true }, true,
    () => assert.fail('No unknown qualification retry')), { code: 'PROOF_OUTCOME_UNRESOLVED' });
  assert.equal((await readMcpStatus(f.dir)).qualifications.filter(item => item.status === 'unresolved').length, 1);
  assert.equal((await planMcpResume(f.dir, { phase: 'qualification', config })).next.code, 'OUTCOME_UNRESOLVED');
});

for (const origin of ['C:\\original-workspace\\tavily-mcp-v3', '/home/original/project']) {
  for (const provider of [false, true]) test(`historical rejection ${provider ? 'provider' : 'caller'} anchors ${origin} without altering history digests`, async t => {
    const f = await configurationFixture(t, { tavily: true }); await f.inspect();
    const planner = provider ? planMcpBackendRejection : planMcpAuthRejection;
    const execute = provider ? executeMcpBackendRejection : executeMcpAuthRejection;
    const reader = provider ? readMcpBackendRejections : readMcpAuthRejections;
    const plan = await planner(f.dir);
    const result = await execute(f.dir, { approval: plan.approvalDigest, allowNetwork: true },
      { transport: async () => new Response(null, { status: 401 }) });
    const sameRoot = await reader(f.dir);
    assert.equal(sameRoot.historicalProvenance, undefined);
    const historical = await syntheticHistoricalRejection(result.outputDir, origin);
    const relocated = await reader(f.dir);
    const expected = [{ ...sameRoot.attempts[0], approvalDigest: historical.approvalDigest, evidenceDigest: historical.evidenceDigest }];
    assert.deepEqual(relocated.attempts, expected);
    assert.equal(relocated.historyDigest, historyDigest(expected));
    assert.deepEqual(relocated.historicalProvenance, { contractVersion: 1, kind: 'receipt-lifecycle-anchored-history',
      currentProjectDir: f.dir, historicalOnly: true, authorizesExecution: false,
      origins: [{ attemptId: sameRoot.attempts[0].attemptId, historicalProjectDir: origin,
        receiptDigest: plan.binding.receiptDigest, lifecycleDigest: plan.binding.lifecycleDigest }] });
    assert.equal((await planner(f.dir)).status, 'blocked-prior-attempt');
    await assert.rejects(execute(f.dir, { approval: plan.approvalDigest, allowNetwork: true },
      { transport: () => assert.fail('Historical matrix is consumed') }), { code: 'AUTH_REJECTION_BLOCKED' });
    await unchangedHistory(historical.bytes);
    for (const mutate of [
      value => { value.plan.binding.receiptDigest = `sha256:${'0'.repeat(64)}`; },
      value => { value.plan.binding.lifecycleDigest = `sha256:${'0'.repeat(64)}`; },
      value => { value.plan.binding.identity.projectDir = '/different/origin'; },
      value => { value.plan.binding.identity.target.tenantId = '00000000-0000-4000-8000-000000000000'; },
      value => { value.plan.binding.identity.target.subscriptionId = '00000000-0000-4000-8000-000000000000'; },
      value => { value.plan.profile = 'unrecognized'; },
      value => { value.schemaVersion = 1; delete value.plan.profile; },
    ]) {
      await syntheticHistoricalRejection(result.outputDir, origin, mutate);
      await assert.rejects(reader(f.dir), { code: 'METADATA_MISMATCH' });
      for (const [file, bytes] of historical.bytes) await writeFile(file, bytes);
    }
    for (const invalid of ['relative/path', 'C:relative', 'C:\\project\\..\\other', 'C:\\project\\',
      'C:\\project.\\child', 'C:\\project\\file:stream', '\\\\server\\share\\project',
      '/home/../project', '/home//project', '/home/project/', '/home\\project', '/home/\u001bproject', 'x'.repeat(4097)]) {
      await syntheticHistoricalRejection(result.outputDir, invalid);
      await assert.rejects(reader(f.dir), { code: 'METADATA_MISMATCH' });
      for (const [file, bytes] of historical.bytes) await writeFile(file, bytes);
    }
    const receiptFile = path.join(f.dir, 'infra', 'provisioning-receipt.json');
    const receiptBytes = await readFile(receiptFile), changed = JSON.parse(receiptBytes);
    changed.extra = true; await writeFile(receiptFile, JSON.stringify(changed));
    await assert.rejects(reader(f.dir), { code: 'METADATA_MISMATCH' });
    await writeFile(receiptFile, receiptBytes);
    const lifecycleDir = path.join(f.dir, '.mcp-lifecycle'), lifecycleFile = path.join(lifecycleDir, (await readdir(lifecycleDir))[0]);
    const lifecycleBytes = await readFile(lifecycleFile), lifecycle = JSON.parse(lifecycleBytes);
    lifecycle.extra = true; await writeFile(lifecycleFile, JSON.stringify(lifecycle));
    await assert.rejects(reader(f.dir), { code: 'METADATA_MISMATCH' });
    await writeFile(lifecycleFile, lifecycleBytes);
    // An intact interrupted record is still consumed, never upgraded into a passing matrix.
    await unlink(path.join(result.outputDir, 'result.json'));
    assert.equal((await reader(f.dir)).attempts[0].status, 'inconclusive');
    assert.equal((await planner(f.dir)).status, 'blocked-prior-attempt');
  });
}

for (const provider of [false, true]) test(`experimental ${provider ? 'provider' : 'caller'} rejection is two fixed initialize requests with status-only evidence`, async t => {
  const f = await configurationFixture(t, { tavily: true }); await f.inspect();
  t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected live network'));
  const plan = await (provider ? planMcpBackendRejection : planMcpAuthRejection)(f.dir);
  const execute = provider ? executeMcpBackendRejection : executeMcpAuthRejection;
  const otherPlan = await (provider ? planMcpAuthRejection : planMcpBackendRejection)(f.dir);
  assert.equal(plan.requests.length, 2);
  let count = 0;
  const result = await execute(f.dir, { approval: plan.approvalDigest, allowNetwork: true }, { transport: async (url, options) => {
    const index = count++;
    assert.equal(url, provider ? 'https://mcp.tavily.com/mcp/' : f.review.descriptor.endpoint);
    assert.equal(options.redirect, 'error'); assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(options.body).method, 'initialize');
    assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'Content-Type', ...(index ? ['Authorization'] : [])].sort());
    assert.equal(index === 0 ? options.headers.Authorization === undefined : typeof options.headers.Authorization === 'string', true);
    await assert.rejects(f.inspect(), { code: 'PROVISIONING_LOCKED' });
    return new Response('PRIVATE_BODY', { status: 401, headers: { 'set-cookie': 'PRIVATE_COOKIE', location: 'https://private.invalid' } });
  } });
  assert.equal(result.status, 'passed'); assert.equal(count, 2);
  assert.equal(result.backendCredentialPropagationVerified, false);
  const history = await (provider ? readMcpBackendRejections : readMcpAuthRejections)(f.dir);
  assert.equal(history.attempts[0].cases.length, 2);
  assert.doesNotMatch(JSON.stringify(history), /PRIVATE|Cookie|Bearer/);
  await assert.rejects(execute(f.dir, { approval: plan.approvalDigest, allowNetwork: true }), { code: 'AUTH_REJECTION_BLOCKED' });
  await assert.rejects((provider ? executeMcpAuthRejection : executeMcpBackendRejection)(f.dir,
    { approval: otherPlan.approvalDigest, allowNetwork: true }, { transport: () => assert.fail('Other gate changed history') }),
  { code: 'APPROVAL_REQUIRED' });
  const filename = path.join(result.outputDir, 'intent.json'), bytes = await readFile(filename);
  for (const mutate of [
    value => { value.plan.schemaVersion = 3; },
    value => { value.plan.binding.identity.extra = true; },
    value => { value.plan.requests[0].extra = true; },
  ]) {
    const value = JSON.parse(bytes); mutate(value);
    const { approvalDigest, ...planBody } = value.plan;
    value.plan.approvalDigest = metadataDigest(boundedSnapshot(planBody));
    const { receiptDigest, ...intentBody } = value;
    value.receiptDigest = metadataDigest(boundedSnapshot(intentBody));
    await writeFile(filename, JSON.stringify(value));
    await assert.rejects((provider ? readMcpBackendRejections : readMcpAuthRejections)(f.dir), { code: 'METADATA_MISMATCH' });
  }
  await writeFile(filename, bytes);
});

for (const provider of [false, true]) test(`experimental ${provider ? 'provider' : 'caller'} rejection retains expiry after dispatch as inconclusive and forbids retry`, async t => {
  const f = await configurationFixture(t, { tavily: true }); await f.inspect();
  const planner = provider ? planMcpBackendRejection : planMcpAuthRejection;
  const execute = provider ? executeMcpBackendRejection : executeMcpAuthRejection;
  const plan = await planner(f.dir), evidence = await readExperimentalConfiguration(f.dir);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(execute(f.dir, { approval: plan.approvalDigest, allowNetwork: true, signal: cancelled.signal },
    { transport: () => assert.fail('Cancelled before intent') }), { code: 'ABORTED' });
  assert.equal((await planner(f.dir)).approvalDigest, plan.approvalDigest);
  let clock, count = 0;
  await assert.rejects(execute(f.dir, { approval: plan.approvalDigest, allowNetwork: true }, { transport: async () => {
    count++; clock = t.mock.method(Date, 'now', () => Date.parse(evidence.expiresAt));
    return new Response(null, { status: 401 });
  } }));
  clock.mock.restore(); assert.equal(count, 1);
  const history = await (provider ? readMcpBackendRejections : readMcpAuthRejections)(f.dir);
  assert.equal(history.attempts[0].status, 'inconclusive');
  await f.inspect();
  assert.equal((await planner(f.dir)).status, 'blocked-prior-attempt');
});

for (const provider of [false, true]) for (const code of [200, 403, 302, 429, 503, 'large', 'transport']) {
  test(`experimental ${provider ? 'provider' : 'caller'} rejection stops without escalation for ${code}`, async t => {
    const f = await configurationFixture(t, { tavily: true }); await f.inspect();
    const plan = await (provider ? planMcpBackendRejection : planMcpAuthRejection)(f.dir);
    let count = 0;
    const result = await (provider ? executeMcpBackendRejection : executeMcpAuthRejection)(f.dir,
      { approval: plan.approvalDigest, allowNetwork: true }, { transport: async () => {
        count++; if (code === 'transport') throw Error('PRIVATE_ERROR');
        return new Response(code === 'large' ? 'x'.repeat(16385) : null, { status: typeof code === 'number' ? code : 401 });
      } });
    assert.equal(count, 1);
    assert.equal(result.status, !provider && [200, 403, 302].includes(code) ? 'failed' : 'inconclusive');
    assert.equal((await (provider ? planMcpBackendRejection : planMcpAuthRejection)(f.dir)).status, 'blocked-prior-attempt');
  });
}

test('experimental configuration inspection preserves failure history and immutable artifacts, then allows genuine fresh discovery', async t => {
  const f = await configurationFixture(t), { identity, network } = configurationObservation(f);
  await assert.rejects(planMcpProjectDiscovery(f.dir, identity));
  const receipt = await readFile(path.join(f.dir, 'infra', 'provisioning-receipt.json'));
  const historyDir = path.join(f.dir, '.mcp-lifecycle'), [historyFile] = await readdir(historyDir);
  const original = JSON.parse(await readFile(path.join(historyDir, historyFile)));
  const plan = await planMcpServerReconcile(f.dir, { experimentalConfiguration: true });
  assert.equal(plan.maximumAgeMs, 900000);
  await assert.rejects(reconcileMcpServer(f.dir, { experimentalConfiguration: true, approval: plan.approvalToken, run: f.mock.run }));
  const before = f.mock.calls.length, result = await f.inspect();
  assert.equal(result.status, 'configuration-observed-not-runtime-tested');
  assert.deepEqual(result.controlPlaneTransport, { requested: 'streamable', status: 'unreported' });
  assert.ok(f.mock.calls.slice(before).every(args => args[0] === 'account' || args[1] === 'show' || args.includes('GET')));
  assert.deepEqual(await readFile(path.join(f.dir, 'infra', 'provisioning-receipt.json')), receipt);
  const record = JSON.parse(await readFile(path.join(historyDir, historyFile)));
  assert.deepEqual({ ...record, status: original.status, previousStatus: undefined, reconciliation: undefined },
    { ...original, previousStatus: undefined, reconciliation: undefined });
  const report = JSON.parse(await readFile(result.reportFile));
  assert.deepEqual(report.originalHistory, [original]);
  const evidence = await readExperimentalConfiguration(f.dir);
  assert.equal(Date.parse(evidence.expiresAt) - Date.parse(evidence.observedAt), CONFIGURATION_AGE_MS);
  await assert.rejects(planMcpServerProvision(f.dir, { phase: 'gateway' }), /Never replay/);
  const approval = await planMcpProjectDiscovery(f.dir, identity);
  assert.equal(approval.readiness.gatewayLifecycle, 'configuration-observed-not-runtime-tested');
  const discovered = await executeMcpProjectForTest(f.dir, { selection: identity, approval, allowNetwork: true, onDeviceCode() {} }, false,
    (source, options, guard) => discoverMcpToolsForTest(source, options, { ...network, beforeRequest: guard }));
  assert.equal(discovered.result.tools.tools.length, 1);
  assert.ok(network.calls.includes('tools/list') && !network.calls.includes('tools/call'));
  const status = await readMcpStatus(f.dir);
  assert.equal(status.experimental.configuration.controlPlaneTransport.status, 'unreported');
  assert.equal(status.deployment, 'not-verified');
  for (const [name, bytes] of Object.entries(f.review.files)) assert.equal(await readFile(path.join(f.dir, name), 'utf8'), bytes);
});

for (const stalled of ['identity', 'read', 'unconfirmed']) test(`experimental inspection budget bounds ${stalled} without publication or replay`, async t => {
  const f = await configurationFixture(t);
  const before = await readFile(path.join(f.dir, 'infra', 'provisioning-receipt.json'));
  const histories = await readdir(path.join(f.dir, '.mcp-lifecycle'));
  const original = await readFile(path.join(f.dir, '.mcp-lifecycle', histories[0]));
  const plan = await planMcpServerReconcile(f.dir, { experimentalConfiguration: true });
  assert.deepEqual(plan.inspection.inspectionBudget, { commandTimeoutMs: 60000, overallTimeoutMs: 300000, terminationGraceMs: 5000 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let held = false;
  const result = await f.inspect(async (command, args, options) => {
    assert.equal(options.signal.aborted, false);
    if (!held && (stalled === 'identity' ? args[0] === 'account' : args[0] === 'rest')) {
      held = true;
      return new Promise((resolve, reject) => {
        if (stalled !== 'unconfirmed') options.signal.addEventListener('abort', () => reject(Error('PRIVATE_STALL')), { once: true });
        else options.onInspectionProcess(43210);
        queueMicrotask(() => {
          t.mock.timers.tick(60000);
          if (stalled === 'unconfirmed') queueMicrotask(() => t.mock.timers.tick(5000));
        });
      });
    }
    assert.equal(held, false, 'No reads after the stalled command');
    return f.mock.run(command, args, options);
  });
  assert.equal(result.errorCode, stalled === 'unconfirmed' ? 'AZURE_CLI_TERMINATION_UNCONFIRMED' : 'AZURE_INSPECTION_COMMAND_TIMEOUT');
  assert.equal(result.lifecycleStatus, 'blocked-unresolved');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_STALL/);
  assert.deepEqual(await readFile(path.join(f.dir, 'infra', 'provisioning-receipt.json')), before);
  assert.deepEqual(await readFile(path.join(f.dir, '.mcp-lifecycle', histories[0])), original);
  await assert.rejects(readExperimentalConfiguration(f.dir));
  if (stalled === 'unconfirmed') {
    const lock = JSON.parse(await readFile(path.join(f.dir, '.provisioning.lock')));
    assert.equal(lock.status, 'termination-unconfirmed'); assert.equal(lock.ownedProcessPid, 43210);
    await assert.rejects(f.inspect(), { code: 'PROVISIONING_LOCKED' });
  } else {
    await assert.rejects(readFile(path.join(f.dir, '.provisioning.lock')), { code: 'ENOENT' });
    t.mock.timers.reset();
    assert.equal((await f.inspect()).status, 'configuration-observed-not-runtime-tested');
  }
});

test('experimental inspection budget prevents publication after overall expiry while holding the same lock', async t => {
  const f = await configurationFixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let published = false;
  await assert.rejects(provisionProject(f.cfg, f.dir, {
    inspectOnly: true, experimentalConfiguration: true, phase: 'gateway', run: f.mock.run, approve: async () => true,
    afterInspection: async (result, check) => {
      assert.equal(result.status, 'inspected-not-deployed');
      await readFile(path.join(f.dir, '.provisioning.lock'));
      t.mock.timers.tick(300000);
      check();
      published = true;
    },
  }), { code: 'AZURE_INSPECTION_TIMEOUT' });
  assert.equal(published, false);
  await assert.rejects(readExperimentalConfiguration(f.dir));
  await assert.rejects(readFile(path.join(f.dir, '.provisioning.lock')), { code: 'ENOENT' });
});

test('experimental inspection expiry after report write leaves original history and no ready evidence', async t => {
  const f = await configurationFixture(t);
  const [filename] = await readdir(path.join(f.dir, '.mcp-lifecycle'));
  const historyFile = path.join(f.dir, '.mcp-lifecycle', filename), history = await readFile(historyFile);
  const before = new Set(readdirSync(f.dir));
  const started = performance.now();
  t.mock.method(performance, 'now', () => readdirSync(f.dir).some(name => name.startsWith('reconcile-') && !before.has(name))
    ? started + 300000 : started);
  await assert.rejects(f.inspect(), { code: 'AZURE_INSPECTION_TIMEOUT' });
  assert.deepEqual(await readFile(historyFile), history);
  await assert.rejects(readExperimentalConfiguration(f.dir));
  await assert.rejects(readFile(path.join(f.dir, '.provisioning.lock')), { code: 'ENOENT' });
});

test('experimental inspection expiry during evidence publication invalidates it and remains explicitly refreshable', async t => {
  const f = await configurationFixture(t);
  const evidenceFile = path.join(f.dir, '.mcp-configuration.json'), started = performance.now();
  let expired = false;
  const clock = t.mock.method(performance, 'now', () => {
    if (existsSync(evidenceFile) && JSON.parse(readFileSync(evidenceFile, 'utf8')).evidenceDigest) expired = true;
    return started + (expired ? 300000 : 0);
  });
  await assert.rejects(f.inspect(), { code: 'AZURE_INSPECTION_TIMEOUT' });
  assert.equal(JSON.parse(await readFile(evidenceFile)).status, 'inspection-started');
  await assert.rejects(readExperimentalConfiguration(f.dir));
  await assert.rejects(readFile(path.join(f.dir, '.provisioning.lock')), { code: 'ENOENT' });
  clock.mock.restore();
  assert.equal((await f.inspect()).status, 'configuration-observed-not-runtime-tested');
});

test('experimental inspection CLI cancellation propagates into identity read and removes signal handlers', async t => {
  const f = await configurationFixture(t);
  const plan = await planMcpServerReconcile(f.dir, { experimentalConfiguration: true });
  const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  let count = 0;
  const exit = await main(['mcp-reconcile', '--project', f.dir, '--experimental-configuration',
    '--approve', plan.approvalToken, '--allow-cloud', '--json'], {
    runAzure: (command, args, { signal }) => {
      count++; assert.equal(args[0], 'account');
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Error('PRIVATE_CANCEL')), { once: true });
        process.emit('SIGINT');
      });
    },
  });
  assert.equal(exit, 2); assert.equal(count, 1);
  assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], listeners);
  await assert.rejects(readExperimentalConfiguration(f.dir));
  await assert.rejects(readFile(path.join(f.dir, '.provisioning.lock')), { code: 'ENOENT' });
});

test('experimental configuration completed gateway still requires explicit fresh evidence; expiry and report-only states refresh without replay', async t => {
  const f = await configurationFixture(t, { historical: false });
  assert.equal((await planMcpServerCapture(f.dir)).gatewayLifecycle, 'not-verified');
  await f.inspect();
  const original = await readExperimentalConfiguration(f.dir);
  const clock = t.mock.method(Date, 'now', () => Date.parse(original.expiresAt));
  await assert.rejects(readExperimentalConfiguration(f.dir), { code: 'MCP_CONFIGURATION_STALE' });
  assert.equal((await readMcpStatus(f.dir)).experimental.configuration.status, 'stale');
  await assert.rejects(planMcpServerProvision(f.dir, { phase: 'gateway' }), /already completed/);
  clock.mock.restore();
  await unlink(path.join(f.dir, '.mcp-configuration.json'));
  await assert.rejects(planMcpProjectDiscovery(f.dir, configurationObservation(f).identity));
  const result = await f.inspect();
  assert.notEqual(result.evidenceDigest, original.evidenceDigest);
  assert.equal((await readExperimentalConfiguration(f.dir)).controlPlaneTransport.status, 'unreported');
});

test('experimental configuration failed-history settlement without publication is refreshable but never discovery-ready', async t => {
  const f = await configurationFixture(t);
  const result = await f.inspect();
  await unlink(result.evidenceFile);
  await assert.rejects(planMcpProjectDiscovery(f.dir, configurationObservation(f).identity));
  await assert.rejects(planMcpServerProvision(f.dir, { phase: 'gateway' }), /Never replay/);
  assert.equal((await f.inspect()).status, 'configuration-observed-not-runtime-tested');
});

for (const drift of ['transport-null', 'transport-wrong', 'policy', 'backend', 'dictionary', 'named-value', 'grant', 'global-snapshot', 'api-snapshot', 'backend-snapshot']) {
  test(`experimental configuration ${drift} cannot establish evidence from a fresh baseline`, async t => {
    const f = await configurationFixture(t), id = f.review.descriptor.ownership.apiId;
    if (drift === 'transport-null') f.mock.apis.get(id).properties.mcpProperties.transportType = null;
    if (drift === 'transport-wrong') f.mock.apis.get(id).properties.mcpProperties.transportType = 'sse';
    if (drift === 'policy') f.mock.policies.set(id, '<policies />');
    if (drift === 'backend') f.mock.proxyBackends.get(f.backendId).properties.tls.validateCertificateName = false;
    if (drift === 'dictionary') f.mock.apis.get(id).properties.mcpProperties.endpoints.message.uriTemplate = '/other';
    if (drift === 'named-value') f.mock.values.clear();
    if (drift === 'grant') f.mock.grants.length = 0;
    if (drift.endsWith('-snapshot')) {
      const filename = path.join(f.dir, 'infra', 'provisioning-receipt.json'), receipt = JSON.parse(await readFile(filename));
      if (drift === 'global-snapshot') receipt.preservation.globalPolicyHash = '0'.repeat(64);
      if (drift === 'api-snapshot') receipt.preservation.unrelatedApis = [];
      if (drift === 'backend-snapshot') receipt.preservation.unrelatedBackends = [];
      await writeFile(filename, JSON.stringify(receipt));
    }
    assert.equal((await f.inspect()).lifecycleStatus, 'blocked-unresolved');
    assert.equal(JSON.parse(await readFile(path.join(f.dir, '.mcp-configuration.json'))).status, 'inspection-started');
    await assert.rejects(planMcpProjectDiscovery(f.dir, configurationObservation(f).identity));
  });
}

test('experimental configuration rejects unrelated failures, missing original snapshots and diagnostic-only substitution', async t => {
  const f = await configurationFixture(t), { identity } = configurationObservation(f);
  await writeFile(path.join(f.dir, '.mcp-configuration.json'), JSON.stringify({ action: 'separate-metadata-only-diagnostic',
    protocolVersion: '2025-03-26', toolCount: 5, lifecycleQualified: false, captureRetained: false }));
  await assert.rejects(planMcpProjectDiscovery(f.dir, identity));
  const filename = path.join(f.dir, 'infra', 'provisioning-receipt.json'), bytes = await readFile(filename), receipt = JSON.parse(bytes);
  receipt.lastAttempt.errorCode = 'AZURE_CLI_EXIT';
  await writeFile(filename, JSON.stringify(receipt));
  await assert.rejects(planMcpServerReconcile(f.dir, { experimentalConfiguration: true }));
  receipt.lastAttempt.errorCode = 'APIM_PROXY_MAPPING_MISMATCH'; delete receipt.preservation;
  await writeFile(filename, JSON.stringify(receipt));
  await assert.rejects(planMcpServerReconcile(f.dir, { experimentalConfiguration: true }));
  await writeFile(filename, bytes);
});

test('experimental configuration final active recheck rejects a policy reverting to deny-only', async t => {
  const f = await configurationFixture(t), id = f.review.descriptor.ownership.apiId;
  const deny = JSON.parse(f.review.files['infra/deny-policy.json']).properties.value;
  let policyReads = 0;
  const result = await f.inspect(async (command, args) => {
    const output = await f.mock.run(command, args);
    if (args.some(value => value.includes(`/apis/${id}/policies/policy?`) && value.includes('format=rawxml'))) {
      policyReads++;
      if (policyReads === 2) f.mock.policies.set(id, deny);
    }
    return output;
  });
  assert.equal(policyReads, 3);
  assert.equal(result.lifecycleStatus, 'blocked-unresolved');
  assert.equal(result.errorCode, 'APIM_OWNED_POLICY_CHANGED');
  await assert.rejects(readExperimentalConfiguration(f.dir));
});

test('experimental configuration report-only and interrupted refresh invalidate readiness without authorizing mutation', async t => {
  const f = await configurationFixture(t), directory = path.join(f.dir, '.mcp-lifecycle');
  const [name] = await readdir(directory), filename = path.join(directory, name), original = await readFile(filename);
  const result = await f.inspect();
  await writeFile(filename, original);
  await unlink(result.evidenceFile);
  await assert.rejects(planMcpProjectDiscovery(f.dir, configurationObservation(f).identity));
  await f.inspect();
  const planned = await planMcpServerReconcile(f.dir, { experimentalConfiguration: true });
  const failed = await f.inspect(async () => { throw new Error('Synthetic interrupted read'); });
  assert.equal(failed.lifecycleStatus, 'blocked-unresolved');
  await assert.rejects(readExperimentalConfiguration(f.dir));
  let calls = 0;
  await assert.rejects(reconcileMcpServer(f.dir, { experimentalConfiguration: true, approval: planned.approvalToken, allowCloud: true, run: () => calls++ }));
  assert.equal(calls, 0);
  assert.equal((await f.inspect()).status, 'configuration-observed-not-runtime-tested');
  await assert.rejects(planMcpServerProvision(f.dir, { phase: 'gateway' }), /Never replay/);
});

test('experimental configuration network and inspection share exclusion and reject stale discovery approvals', async t => {
  const f = await configurationFixture(t); await f.inspect();
  const { identity, network } = configurationObservation(f), approval = await planMcpProjectDiscovery(f.dir, identity);
  let tested = false;
  await executeMcpProjectForTest(f.dir, { selection: identity, approval, allowNetwork: true, onDeviceCode() {} }, false,
    (source, options, guard) => discoverMcpToolsForTest(source, options, { ...network, beforeRequest: guard,
      mcpTransport: async (url, request) => {
        if (!tested) {
          tested = true;
          await assert.rejects(f.inspect(), { code: 'PROVISIONING_LOCKED' });
        }
        return network.mcpTransport(url, request);
      } }));
  assert.equal(tested, true);
  await f.inspect();
  await assert.rejects(executeMcpProjectForTest(f.dir, { selection: identity, approval, allowNetwork: true }, false,
    () => assert.fail('Refreshed evidence must invalidate prior discovery approval')));
});

test('experimental configuration rejects evidence/report/history/receipt/identity tampering and future observations', async t => {
  const f = await configurationFixture(t);
  const result = await f.inspect(), filename = result.evidenceFile, original = await readFile(filename);
  for (const change of [
    value => value.unreviewed = true,
    value => value.controlPlaneTransport.reported = 'streamable',
    value => value.reportFile = '..\\outside.json',
    value => value.expiresAt = new Date(Date.parse(value.expiresAt) + 1).toISOString(),
  ]) {
    const value = JSON.parse(original); change(value);
    const { evidenceDigest, ...body } = value;
    value.evidenceDigest = metadataDigest(boundedSnapshot(body));
    await writeFile(filename, JSON.stringify(value));
    await assert.rejects(readExperimentalConfiguration(f.dir));
  }
  await writeFile(filename, original);
  const evidence = JSON.parse(original);
  const clock = t.mock.method(Date, 'now', () => Date.parse(evidence.observedAt) - 1);
  await assert.rejects(readExperimentalConfiguration(f.dir), { code: 'MCP_CONFIGURATION_STALE' });
  clock.mock.restore();
  for (const file of [result.reportFile, path.join(f.dir, 'infra', 'provisioning-receipt.json'),
    path.join(f.dir, '.mcp-lifecycle', (await readdir(path.join(f.dir, '.mcp-lifecycle')))[0])]) {
    const bytes = await readFile(file), value = JSON.parse(bytes); value.extra = true;
    await writeFile(file, JSON.stringify(value)); await assert.rejects(readExperimentalConfiguration(f.dir));
    await writeFile(file, bytes);
  }
  await selectMockAzureIdentity(f.dir, f.cfg.azure);
  await assert.rejects(readExperimentalConfiguration(f.dir));
  assert.equal((await f.inspect()).status, 'configuration-observed-not-runtime-tested');
});

test('experimental configuration proof expiry after dispatch retains unknown outcome and blocks retry after refresh', async t => {
  const f = await configurationFixture(t); await f.inspect();
  const { identity, network } = configurationObservation(f);
  const approval = await planMcpProjectDiscovery(f.dir, identity);
  const observed = await executeMcpProjectForTest(f.dir, { selection: identity, approval, allowNetwork: true, onDeviceCode() {} }, false,
    (source, options, guard) => discoverMcpToolsForTest(source, options, { ...network, beforeRequest: guard }));
  const selection = { capture: observed.result, toolName: 'readFixture', arguments: {},
    safetyReview: { readOnly: true, reason: 'Offline synthetic read-only fixture.' } };
  const proof = await planMcpProjectProof(f.dir, selection), evidence = await readExperimentalConfiguration(f.dir);
  let clock;
  await assert.rejects(executeMcpProjectForTest(f.dir, { selection, approval: proof, allowNetwork: true, onDeviceCode() {} }, true,
    (source, options, guard, hooks) => runMcpReadOnlyProofForTest(source, options, { ...network, ...hooks, beforeRequest: guard,
      mcpTransport: async (url, options) => {
        const response = await network.mcpTransport(url, options);
        if (JSON.parse(options.body).method === 'tools/call') clock = t.mock.method(Date, 'now', () => Date.parse(evidence.expiresAt));
        return response;
      } })));
  assert.match((await readMcpStatus(f.dir)).next, /cannot authorize a tool retry/);
  clock?.mock.restore();
  assert.equal(network.calls.filter(value => value === 'tools/call').length, 1);
  const directories = await readdir(path.join(f.dir, '.mcp-observations'));
  const failures = [];
  for (const dir of directories) {
    try { failures.push(JSON.parse(await readFile(path.join(f.dir, '.mcp-observations', dir, 'failure.json')))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.equal(failures.at(-1).status, 'unknown-no-replay');
  await f.inspect();
  const nextProof = await planMcpProjectProof(f.dir, selection);
  await assert.rejects(executeMcpProjectForTest(f.dir, { selection, approval: nextProof, allowNetwork: true }, true, () => assert.fail('No replay')));
});

for (const phase of ['foundation', 'finalize', 'gateway']) test(`experimental ${phase} checks the existing secret grant read-only and never creates it`, async t => {
  const f = await experimentalFixture(t); f.mock.grants.length = 0;
  const result = await f.execute(undefined, phase);
  assert.equal(result.errorCode, 'APIM_SECRET_GRANT_REQUIRED');
  assert.equal(result.lifecycleStatus, 'failed-uncertain');
  assert.equal(result.experimental.status, 'experimental-not-forwarding-verified');
  assert.ok(f.mock.calls.every(args => args[0] === 'account' || args[1] === 'show' || args.includes('GET')));
  assert.equal(f.mock.proxyBackends.size, 1);
});

for (const mismatch of ['principal', 'scope', 'role', 'condition', 'assignment-id', 'assignment-child', 'assignment-uuid']) test(`experimental rejects ${mismatch} secret-grant mismatch`, async t => {
  const f = await experimentalFixture(t), assignment = f.mock.grants[0];
  if (mismatch === 'principal') assignment.properties.principalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  if (mismatch === 'scope') assignment.properties.scope = assignment.properties.scope.split('/secrets/')[0];
  if (mismatch === 'role') assignment.properties.roleDefinitionId += 'bad';
  if (mismatch === 'condition') assignment.properties.condition = '@Resource[restricted]';
  if (mismatch === 'assignment-id') assignment.id = assignment.id.replace('/secrets/upstream', '/secrets/other');
  if (mismatch === 'assignment-child') assignment.id = assignment.id.replace('/roleAssignments/', '/roleAssignments/child/');
  if (mismatch === 'assignment-uuid') assignment.id = assignment.id.replace(/[^/]+$/, 'a'.repeat(36));
  assert.equal((await f.execute()).errorCode, 'APIM_SECRET_GRANT_REQUIRED');
  assert.ok(!f.mock.calls.some(args => args[0] === 'deployment' && args[2] === 'create'));
});

test('experimental backend presence or matching owner never substitutes for persisted creation intent', async t => {
  const f = await experimentalFixture(t);
  f.mock.proxyBackends.set(f.backendId, f.backendResource);
  assert.equal((await f.execute()).errorCode, 'APIM_BACKEND_COLLISION');
  assert.ok(!f.mock.calls.some(args => args[0] === 'deployment'));
});

for (const drift of ['grant', 'backend-collision', 'unrelated-backend']) test(`experimental fresh ${drift} drift blocks the next mutation`, async t => {
  const f = await experimentalFixture(t);
  const result = await f.execute(async (command, args) => {
    const output = await f.mock.run(command, args);
    if (args[0] === 'deployment' && args[2] === 'validate' && args.includes(path.join(f.dir, 'infra', 'staging.json'))) {
      if (drift === 'grant') f.mock.grants.length = 0;
      if (drift === 'backend-collision') f.mock.proxyBackends.set(f.backendId, f.backendResource);
      if (drift === 'unrelated-backend') f.mock.proxyBackends.get('unrelated-backend').properties.url += '/drift';
    }
    return output;
  });
  assert.equal(result.errorCode, { grant: 'APIM_SECRET_GRANT_REQUIRED', 'backend-collision': 'APIM_BACKEND_COLLISION',
    'unrelated-backend': 'APIM_PRESERVATION_FAILED' }[drift]);
  assert.ok(!f.mock.calls.some(args => args[0] === 'deployment' && args[2] === 'create'));
});

test('experimental backend-only partial activation reconciles without adoption, retry or completed-gateway evidence', async t => {
  const f = await experimentalFixture(t);
  const result = await f.execute(async (command, args) => {
    if (args[0] === 'deployment' && args[2] === 'create' && args.includes(path.join(f.dir, 'infra', 'gateway.json'))) {
      const receipt = JSON.parse(await readFile(path.join(f.dir, 'infra', 'provisioning-receipt.json')));
      assert.ok(receipt.backendIntents.includes(f.backendId));
      assert.equal(f.mock.apis.get(f.review.descriptor.ownership.apiId).properties.subscriptionRequired, true);
      assert.ok(f.mock.policies.get(f.review.descriptor.ownership.apiId).includes('Not configured'));
      f.mock.proxyBackends.set(f.backendId, f.backendResource);
      throw new Error('Mock interruption after backend write');
    }
    return f.mock.run(command, args);
  });
  assert.equal(result.lifecycleStatus, 'failed-uncertain');
  await assert.rejects(planMcpServerProvision(f.dir, { phase: 'gateway' }), /uncertain/);
  const plan = await planMcpServerReconcile(f.dir), count = f.mock.calls.length;
  assert.equal((await reconcileMcpServer(f.dir, { approval: plan.approvalToken, allowCloud: true, run: f.mock.run })).status, 'reconciled-not-deployed');
  assert.ok(f.mock.calls.slice(count).every(args => args[0] === 'account' || args[1] === 'show' || args.includes('GET')));
  assert.equal((await planMcpServerCapture(f.dir)).gatewayLifecycle, 'not-verified');
  assert.ok((await planMcpServerProvision(f.dir, { phase: 'gateway' })).approvalToken);
});

test('experimental activation refuses fresh policy drift rather than overwriting it', async t => {
  const f = await experimentalFixture(t), apiId = f.review.descriptor.ownership.apiId;
  const changed = '<policies><inbound><return-response><set-status code="451" reason="Owner restriction" /></return-response></inbound></policies>';
  const result = await f.execute(async (command, args) => {
    const output = await f.mock.run(command, args);
    if (args[0] === 'deployment' && args[2] === 'validate' && args.includes(path.join(f.dir, 'infra', 'gateway.json'))) {
      f.mock.policies.set(apiId, changed);
    }
    return output;
  });
  assert.equal(result.errorCode, 'APIM_OWNED_POLICY_CHANGED');
  assert.equal(f.mock.policies.get(apiId), changed);
  assert.ok(!f.mock.calls.some(args => args[0] === 'deployment' && args[2] === 'create' && args.includes(path.join(f.dir, 'infra', 'gateway.json'))));
});

for (const failure of ['duplicate', 'wrong-exact-id', 'pagination-escape', 'limit']) test(`experimental backend inventory ${failure} fails closed before mutation`, async t => {
  const f = await experimentalFixture(t);
  const result = await f.execute(async (command, args) => {
    const output = await f.mock.run(command, args), url = args[args.indexOf('--url') + 1];
    if (typeof url === 'string' && url.endsWith('/backends?api-version=2025-09-01-preview')) {
      if (failure === 'duplicate') output.value.push(output.value[0]);
      if (failure === 'pagination-escape') output.nextLink = 'https://outside.example.com/backends';
      if (failure === 'limit') output.value = Array.from({ length: 5001 }, () => output.value[0]);
    }
    if (failure === 'wrong-exact-id' && typeof url === 'string' && url.includes('/backends/unrelated-backend?')) output.id += '-wrong';
    return output;
  });
  assert.equal(result.status, 'failed');
  assert.ok(['APIM_PROXY_BACKEND_MISMATCH', 'APIM_PAGINATION_INVALID', 'APIM_INVENTORY_LIMIT'].includes(result.errorCode));
  assert.ok(!f.mock.calls.some(args => args[0] === 'deployment' || args.some(value => value.includes('outside.example.com'))));
});

for (const drift of ['backend-missing', 'backend-url', 'api-endpoints', 'api-transport', 'api-backend', 'policy', 'staging-binding']) test(`experimental ${drift} readback cannot complete or reconcile as passed`, async t => {
  const f = await experimentalFixture(t), apiId = f.review.descriptor.ownership.apiId;
  const result = await f.execute(async (command, args) => {
    const output = await f.mock.run(command, args);
    const template = args[args.indexOf('--template-file') + 1];
    if (args[0] === 'deployment' && args[2] === 'create') {
      if (drift === 'staging-binding' && template === path.join(f.dir, 'infra', 'staging.json')) {
        f.mock.apis.get(apiId).properties.backendId = f.backendId;
      } else if (template === path.join(f.dir, 'infra', 'gateway.json')) {
        if (drift === 'backend-missing') f.mock.proxyBackends.delete(f.backendId);
        if (drift === 'backend-url') f.mock.proxyBackends.get(f.backendId).properties.url += '/mcp/';
        if (drift === 'api-endpoints') f.mock.apis.get(apiId).properties.mcpProperties.endpoints = [];
        if (drift === 'api-transport') f.mock.apis.get(apiId).properties.mcpProperties.transportType = null;
        if (drift === 'api-backend') f.mock.apis.get(apiId).properties.backendId = 'unrelated-backend';
        if (drift === 'policy') f.mock.policies.set(apiId, f.mock.policies.get(apiId).replace('template="/mcp/"', 'template="/other"'));
      }
    }
    return output;
  });
  assert.equal(result.lifecycleStatus, 'failed-uncertain');
  const plan = await planMcpServerReconcile(f.dir);
  assert.equal((await reconcileMcpServer(f.dir, { approval: plan.approvalToken, allowCloud: true, run: f.mock.run })).lifecycleStatus, 'blocked-unresolved');
  assert.equal((await planMcpServerCapture(f.dir)).gatewayLifecycle, 'not-verified');
});

async function applicationFixture(t) {
  const root = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'application-access-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples', 'mcp', 'application-access.json'), 'utf8'));
  const review = await prepareMcpServer(input), dir = path.join(root, 'server'), cfg = mcpRuntimeConfig(input);
  await createMcpServerProject(review, { workspaceRoot: root, projectDir: dir });
  await selectMockAzureIdentity(dir, cfg.azure);
  const application = { appId: input.inbound.clientId, identifierUris: [input.inbound.applicationIdUri],
    api: { oauth2PermissionScopes: [{ id: principalId, value: input.inbound.scope, isEnabled: true }],
      preAuthorizedApplications: input.inbound.allowedClientIds.map(appId => ({ appId, delegatedPermissionIds: [principalId] })) } };
  const mock = runner(cfg, application);
  return { root, input, review, dir, cfg, mock };
}

test('application access rejects wrong/disabled/missing identity or role before any write', async t => {
  for (const [label, mutate, code] of [
    ['system identity absent', m => { m.service.identity = null; }, 'APIM_BACKEND_PRINCIPAL_MISMATCH'],
    ['wrong tenant', m => { m.service.identity.tenantId = principalId; }, 'APIM_BACKEND_PRINCIPAL_MISMATCH'],
    ['rotated principal', m => { m.service.identity.principalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; }, 'APIM_BACKEND_PRINCIPAL_MISMATCH'],
    ['user assigned only', m => { m.service.identity.type = 'UserAssigned'; }, 'APIM_BACKEND_PRINCIPAL_MISMATCH'],
    ['disabled principal', m => { m.backend.get('backend-principal').accountEnabled = false; }, 'APIM_BACKEND_PRINCIPAL_MISMATCH'],
    ['application not MI', m => { m.backend.get('backend-principal').servicePrincipalType = 'Application'; }, 'APIM_BACKEND_PRINCIPAL_MISMATCH'],
    ['wrong audience', m => { m.backend.get('backend-application').appId = principalId; }, 'APIM_BACKEND_ROLE_MISMATCH'],
    ['wrong resource object', m => { m.backend.get('backend-application').id = principalId; }, 'APIM_BACKEND_ROLE_MISMATCH'],
    ['disabled app', m => { m.backend.get('backend-application').accountEnabled = false; }, 'APIM_BACKEND_ROLE_MISMATCH'],
    ['disabled role', m => { m.backend.get('backend-application').appRoles[0].isEnabled = false; }, 'APIM_BACKEND_ROLE_MISMATCH'],
    ['delegated only', m => { m.backend.get('backend-application').appRoles[0].allowedMemberTypes = ['User']; }, 'APIM_BACKEND_ROLE_MISMATCH'],
    ['changed role value', m => { m.backend.get('backend-application').appRoles[0].value = 'Other'; }, 'APIM_BACKEND_ROLE_MISMATCH'],
    ['malformed roles', m => { m.backend.get('backend-application').appRoles = {}; }, 'APIM_BACKEND_ROLE_MISMATCH'],
    ['missing assignment', m => { m.backend.get('backend-assignment').value = []; }, 'APIM_BACKEND_ASSIGNMENT_REQUIRED'],
    ['wrong grantee', m => { m.backend.get('backend-assignment').value[0].principalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; }, 'APIM_BACKEND_ASSIGNMENT_REQUIRED'],
    ['wrong assignment resource', m => { m.backend.get('backend-assignment').value[0].resourceId = principalId; }, 'APIM_BACKEND_ASSIGNMENT_REQUIRED'],
    ['default role', m => { m.backend.get('backend-assignment').value[0].appRoleId = '00000000-0000-0000-0000-000000000000'; }, 'APIM_BACKEND_ASSIGNMENT_REQUIRED'],
    ['pagination escape', m => { m.backend.get('backend-assignment').nextLink = 'https://foreign.example.com/'; }, 'APIM_PAGINATION_INVALID'],
  ]) await t.test(label, async t => {
    const f = await applicationFixture(t);
    mutate(f.mock);
    const plan = await planMcpServerProvision(f.dir, { phase: 'gateway' });
    const result = await provisionMcpServer(f.dir, { phase: 'gateway', approval: plan.approvalToken, run: f.mock.run });
    assert.equal(result.errorCode, code);
    assert.equal(result.lifecycleStatus, 'failed-uncertain');
    assert.equal(f.mock.calls.some(args => args[0] === 'deployment' || args.includes('PUT') || args.includes('POST') || args.includes('PATCH')), false);
    await assert.rejects(planMcpServerProvision(f.dir, { phase: 'gateway' }), /uncertain/);
    const receipt = JSON.parse(await readFile(path.join(f.dir, 'infra', 'provisioning-receipt.json')));
    assert.equal(receipt.apiIntents, undefined);
  });
});

test('application-access assignment drift at activation blocks gateway, retains staging, and cannot replay', async t => {
  const f = await applicationFixture(t);
  const run = async (command, args, options) => {
    const output = await f.mock.run(command, args, options);
    if (args[0] === 'deployment' && args[2] === 'create' && args.some(arg => arg.endsWith('staging.json'))) {
      f.mock.backend.get('backend-assignment').value = [];
    }
    return output;
  };
  const plan = await planMcpServerProvision(f.dir, { phase: 'gateway' });
  const result = await provisionMcpServer(f.dir, { phase: 'gateway', approval: plan.approvalToken, run });
  assert.equal(result.errorCode, 'APIM_BACKEND_ASSIGNMENT_REQUIRED');
  assert.equal(result.failedStep, 'deploy-gateway');
  assert.equal(f.mock.calls.some(args => args[2] === 'create' && args.some(arg => arg.endsWith('gateway.json'))), false);
  assert.match(f.mock.policies.get(f.review.descriptor.ownership.apiId), /Not configured/);
  assert.equal(f.mock.global(), passthrough);
  assert.equal(f.mock.policies.get('unrelated'), passthrough);
  await assert.rejects(provisionMcpServer(f.dir, { phase: 'gateway', approval: plan.approvalToken,
    run: () => assert.fail('No replay') }), /uncertain/);
});

test('application-access gateway readback refuses a fail-open backend policy and retains uncertainty', async t => {
  const f = await applicationFixture(t);
  const run = async (command, args, options) => {
    const output = await f.mock.run(command, args, options);
    if (args[0] === 'deployment' && args[2] === 'create' && args.some(arg => arg.endsWith('gateway.json'))) {
      const api = `${f.review.descriptor.ownership.apiId}-rest`;
      f.mock.policies.set(api, f.mock.policies.get(api).replace('ignore-error="false"', 'ignore-error="true"'));
    }
    return output;
  };
  const plan = await planMcpServerProvision(f.dir, { phase: 'gateway' });
  const result = await provisionMcpServer(f.dir, { phase: 'gateway', approval: plan.approvalToken, run });
  assert.equal(result.errorCode, 'APIM_AUTH_POLICY_MISMATCH');
  assert.equal(result.lifecycleStatus, 'failed-uncertain');
  assert.equal(f.mock.global(), passthrough);
  await assert.rejects(planMcpServerProvision(f.dir, { phase: 'gateway' }), /uncertain/);
});

test('application-access prerequisites bind identity, require role metadata, and never claim runtime access', async t => {
  const f = await applicationFixture(t);
  const plan = await planMcpPrerequisites(f.dir);
  assert.equal(plan.requests.length, 4);
  assert.equal(plan.applicationAccess.assignmentMutationSupported, false);
  const run = async (command, args, options) => {
    if (args.includes(plan.requests[0].url)) return { id: serviceResourceId(f.cfg),
      identity: f.mock.service.identity, properties: { provisioningState: 'Succeeded' } };
    return f.mock.run(command, args, options);
  };
  await assert.rejects(inspectMcpPrerequisites(f.dir, { approval: 'stale', allowCloud: true,
    run: () => assert.fail('Stale approval must not query') }), { code: 'APPROVAL_REQUIRED' });
  const observed = await inspectMcpPrerequisites(f.dir, { approval: plan.approvalDigest, allowCloud: true, run });
  assert.equal(observed.status, 'metadata-inspected-not-runtime-qualified');
  assert.equal(observed.applicationAccess.directoryMetadataVerified, true);
  assert.equal(observed.applicationAccess.effectiveAccessVerified, false);
  assert.equal(observed.permissionsVerified, false);
  assert.equal(observed.vault, undefined);
  await assert.rejects(inspectMcpPrerequisites(f.dir, { approval: plan.approvalDigest, allowCloud: true,
    run: async (command, args, options) => {
      if (args.includes(plan.requests[2].url)) throw Object.assign(new Error('RAW_DIRECTORY_RESPONSE_MUST_NOT_ESCAPE'), { code: 'AZURE_PERMISSION_DENIED' });
      return run(command, args, options);
    } }), error => error.code === 'MCP_PREREQUISITE_READ_FAILED'
      && error.diagnostics.resource === 'backend-application' && error.diagnostics.causeCode === 'AZURE_PERMISSION_DENIED'
      && !JSON.stringify(error).includes('RAW_DIRECTORY_RESPONSE'));
  f.mock.backend.get('backend-assignment').nextLink = 'https://graph.microsoft.com/v1.0/other';
  await assert.rejects(inspectMcpPrerequisites(f.dir, { approval: plan.approvalDigest, allowCloud: true, run }), { code: 'APIM_BACKEND_ASSIGNMENT_REQUIRED' });
  delete f.mock.backend.get('backend-assignment').nextLink;
  f.mock.service.identity.principalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.deepEqual((await inspectMcpPrerequisites(f.dir, { approval: plan.approvalDigest, allowCloud: true, run })).blockers, ['backend-principal-mismatch']);
  f.mock.backend.get('backend-assignment').value = [];
  await assert.rejects(inspectMcpPrerequisites(f.dir, { approval: plan.approvalDigest, allowCloud: true, run }), { code: 'APIM_BACKEND_ASSIGNMENT_REQUIRED' });
  await selectMockAzureIdentity(f.dir, f.cfg.azure);
  await assert.rejects(inspectMcpPrerequisites(f.dir, { approval: plan.approvalDigest, allowCloud: true,
    run: () => assert.fail('Identity change invalidates approval') }), { code: 'APPROVAL_REQUIRED' });
});

test('installed CLI controlled delegated fixture and real external MCP lifecycle discover and prove offline', async t => {
  const root = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'installed-delegated-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installed = path.join(root, 'installed'), workspace = path.join(root, 'workspace');
  await mkdir(installed); await mkdir(workspace);
  const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const packed = spawnSync(process.execPath, [npmCli, 'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', root],
    { cwd: TOOLKIT_ROOT, encoding: 'utf8', timeout: 60000, env: { ...process.env, npm_config_cache: path.join(root, 'cache') } });
  assert.equal(packed.status, 0, packed.stdout + packed.stderr);
  const [archive] = JSON.parse(packed.stdout);
  assert.equal(spawnSync('tar', ['-xzf', path.join(root, archive.filename), '--strip-components=1', '-C', installed]).status, 0);
  await cp(path.join(TOOLKIT_ROOT, 'node_modules'), path.join(installed, 'node_modules'), { recursive: true });
  const bytes = await Promise.all(archive.files.map(file => readFile(path.join(installed, file.path))));
  const entries = await readdir(installed), load = name => import(pathToFileURL(path.join(installed, name)).href);
  const { main: installedMain } = await load('bin/copilot-mcp.js');
  const execution = await load('src/mcp-discovery-project.js'), protocol = await load('src/mcp-discovery.js');
  t.mock.method(globalThis, 'fetch', () => assert.fail('No live network is allowed'));
  const input = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples', 'mcp', 'catalog.json'), 'utf8'));
  input.azure.apimMode = 'existing';
  const identity = { discoveryClientId: input.inbound.allowedClientIds[0], expectedUserId: '77777777-7777-4777-8777-777777777777' };
  const fixtureFile = path.join(workspace, 'fixture-input.json'), fixtureDir = path.join(workspace, 'fixture');
  await writeFile(fixtureFile, JSON.stringify({ schemaVersion: 1, id: '99999999-9999-4999-8999-999999999999',
    azure: input.azure, inbound: input.inbound, expectedUserId: identity.expectedUserId }));
  let dependencies = { runAzure() { assert.fail('Local bundle cannot call Azure'); } };
  const invoke = async (args, expected = 0) => {
    const output = [], errors = [];
    const stdout = t.mock.method(process.stdout, 'write', value => { output.push(String(value)); return true; });
    const stderr = t.mock.method(process.stderr, 'write', value => { errors.push(String(value)); return true; });
    try {
      assert.equal(await installedMain([...args, '--workspace-root', workspace, '--json'], dependencies), expected, output.join('') + errors.join(''));
      return JSON.parse(output.join(''));
    } finally { stdout.mock.restore(); stderr.mock.restore(); }
  };
  const fixtureReview = await invoke(['mcp-fixture-plan', '--config', fixtureFile]);
  assert.equal(fixtureReview.cloudApplySupported, false);
  const bundleArgs = ['mcp-fixture-bundle', '--config', fixtureFile, '--output', fixtureDir];
  await invoke([...bundleArgs, '--approve', 'wrong'], 1);
  await invoke([...bundleArgs, '--approve', fixtureReview.reviewDigest, '--allow-cloud'], 1);
  await invoke(['mcp-fixture-bundle', '--config', fixtureFile, '--output', path.join(installed, 'fixture'),
    '--approve', fixtureReview.reviewDigest], 1);
  await invoke([...bundleArgs, '--approve', fixtureReview.reviewDigest]);
  await invoke([...bundleArgs, '--approve', fixtureReview.reviewDigest], 1);
  await invoke(['mcp-fixture-apply', '--project', fixtureDir], 1);
  assert.deepEqual((await readdir(fixtureDir)).sort(), ['activation.json', 'fixture-definition.json', 'fixture-review.json', 'staging.json']);
  input.backend = { auth: 'entra', endpoint: fixtureReview.endpoint };
  input.operationIds = ['readPrincipal'];
  input.document.paths = { [fixtureReview.path]: { get: { operationId: 'readPrincipal',
    description: 'Retrieve the controlled delegated result.', responses: { 200: { description: 'Controlled result' } } } } };
  const definition = path.join(workspace, 'definition.json'), dir = path.join(workspace, 'server');
  await writeFile(definition, JSON.stringify(input));
  const review = await invoke(['mcp-server-plan', '--config', definition]);
  await invoke(['mcp-server-create', '--config', definition, '--output', dir, '--approve', review.reviewDigest]);
  const cfg = mcpRuntimeConfig(review.input);
  const application = { appId: input.inbound.clientId, identifierUris: [input.inbound.applicationIdUri],
    api: { oauth2PermissionScopes: [{ id: principalId, value: input.inbound.scope, isEnabled: true }],
      preAuthorizedApplications: input.inbound.allowedClientIds.map(appId => ({ appId, delegatedPermissionIds: [principalId] })) } };
  const mock = runner(cfg, application);
  const runAzure = async (command, args, options) => {
    assert.ok(options.azureConfigDir.startsWith(path.join(dir, '.azure-auth') + path.sep));
    const result = args[0] === 'login'
      ? [{ id: cfg.azure.subscriptionId, tenantId: cfg.azure.tenantId, user: mockAzureUser }]
      : await mock.run(command, args, options);
    return { code: 0, stdout: JSON.stringify(result) };
  };
  dependencies = { runAzure };
  const loginArgs = ['--project', dir, '--tenant-id', cfg.azure.tenantId, '--subscription-id', cfg.azure.subscriptionId, '--account-name', mockAzureUser.name];
  const login = await invoke(['mcp-account-plan', ...loginArgs]);
  await invoke(['mcp-account-switch', ...loginArgs, '--approve', login.approvalToken]);
  await assert.rejects(readFile(path.join(dir, 'infra', 'provisioning-receipt.json')), { code: 'ENOENT' });
  for (const phase of ['foundation', 'finalize', 'gateway']) {
    const plan = await invoke(['mcp-provision-plan', '--project', dir, '--phase', phase]);
    assert.equal((await invoke(['mcp-provision', '--project', dir, '--phase', phase, '--approve', plan.approvalToken])).lifecycleStatus, 'completed');
  }
  const lifecycle = await readFile(path.join(dir, 'infra', 'provisioning-receipt.json'));
  const map = JSON.parse(review.files['infra/operation-map.json']).server[0];
  const tools = { tools: [{ name: map.displayName, description: map.description,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }] };
  const transport = observationTransport(review.descriptor, identity, tools);
  const mcpTransport = async (url, options) => {
    if (JSON.parse(options.body).method !== 'tools/call') return transport.mcpTransport(url, options);
    assert.equal(options.headers.Authorization, 'Bearer opaque-mocked-access-value');
    transport.calls.push('tools/call');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(options.body).id,
      result: { content: [{ type: 'text', text: JSON.stringify(fixtureReview.marker) }] } }));
  };
  dependencies = { runAzure, onMcpDeviceCode() {}, mcpProjectOperation: (projectDir, options, proof) =>
    execution.executeMcpProjectForTest(projectDir, options, proof, (source, request, guard, context) => proof
      ? protocol.runMcpProjectMappedProof(source, request, context.mapping, { ...transport, mcpTransport,
        beforeRequest: guard, beforeToolCall: context.beforeToolCall, beforeToolDispatch: context.beforeToolDispatch })
      : protocol.discoverMcpToolsForTest(source, request, { ...transport, beforeRequest: guard }), runAzure) };
  const identityFile = path.join(workspace, 'identity.json');
  await writeFile(identityFile, JSON.stringify(identity));
  const discovery = await invoke(['mcp-discovery-plan', '--project', dir, '--config', identityFile]);
  const observed = await invoke(['mcp-discover', '--project', dir, '--config', identityFile, '--approve', discovery.approvalDigest, '--allow-network']);
  const selectionFile = path.join(workspace, 'selection.json');
  await writeFile(selectionFile, JSON.stringify({ capture: observed.resultFile, toolName: map.displayName, arguments: {},
    safetyReview: { readOnly: true, reason: 'I reviewed the sole fixed GET controlled delegated principal check.' },
    delegatedFixture: { path: fixtureDir, approval: fixtureReview.reviewDigest }, responseAssertion: 'controlled-delegated-v1' }));
  const preflight = await invoke(['mcp-proof-preflight-plan', '--project', dir, '--config', selectionFile]);
  await invoke(['mcp-proof-preflight', '--project', dir, '--config', selectionFile, '--approve', preflight.approvalDigest, '--allow-cloud'], 1);
  assert.equal(transport.calls.includes('tools/call'), false);
  // Independent owner setup is simulated in ARM only, not by a fixture apply or a successful lifecycle receipt.
  const activation = JSON.parse(fixtureReview.files['activation.json']), fixtureId = fixtureReview.apiId;
  mock.apis.set(fixtureId, { name: fixtureId, properties: activation.resources[0].properties });
  mock.policies.set(fixtureId, fixtureReview.policy.replace(/<set-body>.*?<\/set-body>/,
    body => body.replaceAll('&quot;', '"')));
  mock.operations.set(fixtureId, [{ id: `${fixtureReview.resourceId}/operations/${fixtureReview.operationId}`,
    name: fixtureReview.operationId, properties: activation.resources[1].properties }]);
  const before = [...transport.calls];
  await invoke(['mcp-proof-preflight', '--project', dir, '--config', selectionFile, '--approve', preflight.approvalDigest, '--allow-cloud']);
  assert.deepEqual(transport.calls, before);
  const proof = await invoke(['mcp-proof-plan', '--project', dir, '--config', selectionFile]);
  const link = path.join(workspace, 'fixture-link');
  await symlink(fixtureDir, link, process.platform === 'win32' ? 'junction' : 'dir');
  const selected = await readFile(selectionFile, 'utf8'), linked = JSON.parse(selected);
  linked.delegatedFixture.path = link;
  await writeFile(selectionFile, JSON.stringify(linked));
  await invoke(['mcp-proof-plan', '--project', dir, '--config', selectionFile], 1);
  await writeFile(selectionFile, selected);
  const result = await invoke(['mcp-proof', '--project', dir, '--config', selectionFile, '--approve', proof.approvalDigest, '--allow-cloud', '--allow-network']);
  assert.equal(result.backendAssertion.status, 'passed');
  assert.equal(transport.calls.filter(value => value === 'tools/call').length, 1);
  await invoke(['mcp-proof', '--project', dir, '--config', selectionFile, '--approve', proof.approvalDigest, '--allow-cloud', '--allow-network'], 1);
  assert.deepEqual(await readFile(path.join(dir, 'infra', 'provisioning-receipt.json')), lifecycle);
  assert.equal(mock.global(), passthrough);
  assert.equal(mock.apis.get('unrelated').properties.description, 'Do not modify');
  assert.deepEqual(await readdir(installed), entries);
  for (const [index, file] of archive.files.entries()) assert.deepEqual(await readFile(path.join(installed, file.path)), bytes[index]);
});

test('standalone REST and upstream MCP lifecycle uses original guarded APIM execution in both modes without plugin identity', async t => {
  const baseline = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples', 'mcp', 'catalog.json'), 'utf8'));
  for (const mode of ['new', 'existing']) for (const route of ['rest-anonymous', 'rest-api-key', 'rest-entra', 'proxy']) {
    const parent = path.join(TOOLKIT_ROOT, '.test-output');
    await mkdir(parent, { recursive: true });
    const workspaceRoot = await mkdtemp(path.join(parent, 'standalone-execution-'));
    t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
    const input = structuredClone(baseline);
    Object.assign(input.azure, { apimMode: mode, location: 'eastus', sku: 'Developer', publisherName: 'Fixture',
      publisherEmail: 'fixture@example.com' });
    if (route === 'proxy') { input.kind = 'apim-mcp-proxy'; delete input.document; delete input.operationIds; }
    if (route === 'proxy' || route === 'rest-api-key') {
      input.azure.keyVaultName = 'catalog-vault';
      input.backend.auth = 'api-key';
      input.backend.apiKey = { secretIdentifier: 'https://catalog-vault.vault.azure.net/secrets/backend', headerName: 'X-Api-Key' };
    } else if (route === 'rest-entra') input.backend.auth = 'entra';
    const projectDir = path.join(workspaceRoot, 'server');
    const review = await prepareMcpServer(input);
    await createMcpServerProject(review, { workspaceRoot, projectDir });
    await selectMockAzureIdentity(projectDir, input.azure);
    const cfg = mcpRuntimeConfig(review.input);
    const application = { appId: input.inbound.clientId, identifierUris: [input.inbound.applicationIdUri],
      api: { oauth2PermissionScopes: [{ id: principalId, value: input.inbound.scope, isEnabled: true }],
        preAuthorizedApplications: input.inbound.allowedClientIds.map(appId => ({ appId, delegatedPermissionIds: [principalId] })) } };
    const blockedDir = path.join(workspaceRoot, 'missing-preauthorization');
    await createMcpServerProject(review, { workspaceRoot, projectDir: blockedDir });
    await selectMockAzureIdentity(blockedDir, input.azure);
    const blockedMock = runner(cfg, { ...application, api: { ...application.api, preAuthorizedApplications: [] } });
    const blockedPlan = await planMcpServerProvision(blockedDir);
    assert.deepEqual(blockedPlan.prerequisites.existingResourceApplication, input.inbound);
    const blocked = await provisionMcpServer(blockedDir, { approval: blockedPlan.approvalToken, run: blockedMock.run });
    assert.equal(blocked.errorCode, 'ENTRA_INBOUND_PREREQUISITES', JSON.stringify({ mode, route, blocked }));
    assert.ok(blockedMock.calls.every(args => !args.includes('create') && !args.includes('PUT') && !args.includes('POST') && !args.includes('PATCH')));
    const mock = runner(cfg, application);
    const untouched = structuredClone(mock.apis.get('unrelated'));
    for (const phase of ['foundation', 'finalize', 'gateway']) {
      const plan = await planMcpServerProvision(projectDir, { phase });
      assert.ok(plan.approvalToken);
      assert.ok(!plan.plan.steps.some(step => /create-app|merge-app|create-principal|register-/.test(step.id)));
      const result = await provisionMcpServer(projectDir, { phase, approval: plan.approvalToken, run: mock.run });
      assert.equal(result.lifecycleStatus, 'completed', JSON.stringify({ mode, route, result }));
    }
    assert.equal(cfg.plugin, undefined);
    assert.deepEqual(mock.apis.get('unrelated'), untouched);
    assert.ok(!mock.calls.some(args => args.includes('POST') || args.includes('PATCH')));
    if (mode === 'existing') assert.equal(mock.global(), passthrough);
    const capturePlan = await planMcpServerCapture(projectDir);
    assert.equal(capturePlan.gatewayLifecycle, 'completed-not-runtime-tested');
    assert.equal(capturePlan.metadataCaptured, false);
    for (const [name, contents] of Object.entries(review.files)) {
      assert.equal(await readFile(path.join(projectDir, ...name.split('/')), 'utf8'), contents);
    }
  }
});
