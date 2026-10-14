import path from 'node:path';
import { mcpRuntimeConfig } from './mcp-server.js';
import { readMcpLifecycleAttempts } from './mcp-lifecycle.js';
import { readAzureIdentity, azureIdentityGuard } from './azure-identity.js';
import { runAzureCommand, sanitizeProvisioningErrorCode } from './azure.js';
import { reviewRestOperations } from './apim-renderer.js';
import { readControl, controlOutput } from './mcp-control.js';
import { boundedSnapshot, metadataDigest, requireMetadata } from './anonymous-metadata.js';
import { validateMcpObservedCapture } from './mcp-discovery.js';
import { planMappedKeyGet, mappedOperationMatches, mappedSchemaReference, mappedLinkedSchemaMatches } from './mcp-mapped-get.js';
import { readDelegatedFixture, delegatedFixtureReads, verifyDelegatedFixture } from './mcp-delegated-fixture.js';
import { graphOrganizationOperation } from './mcp-graph-organization.js';
import { managedIdentityRequests, assertManagedIdentityMetadata } from './apim-managed-identity.js';
import { assertCompatibleGlobalPolicy, assertCompatibleService, assertInheritedOperationPolicies, assertSafeDiagnostics,
  deploymentTarget, fingerprint, ownerDescription, policyValue, serviceResourceId } from './apim-safety.js';

const equal = (a, b) => metadataDigest(boundedSnapshot(a)) === metadataDigest(boundedSnapshot(b));
const empty = value => value === undefined || Array.isArray(value) && value.length === 0;
const stages = new Set(['local-review', 'local-read', 'project-guard', 'azure-identity', 'arm-read', 'arm-parse', 'mapping-check', 'readback-persist']);
const resources = ['project', 'global-policy', 'service-diagnostics', 'native-api', 'native-policy', 'native-diagnostics',
  'rest-api', 'rest-policy', 'rest-diagnostics', 'operation-policy', 'operation', 'tool',
  'apim-identity', 'key-reference', 'key-vault', 'operation-schema', 'delegated-fixture', 'backend-identity'];
const predicates = new Set(['source', 'mapping-count', 'resource-count', 'operation-count', 'tool-definition', 'deployment-evidence',
  'receipt-digest', 'global-policy-hash', 'id', 'name', 'owner', 'path', 'api-type', 'subscription-required', 'protocols',
  'backend', 'metadata-shape', 'transport', 'endpoints', 'federation', 'federation-router', 'policy',
  'method', 'template-parameters', 'query-parameters', 'headers', 'representations', 'display-name', 'description', 'operation-reference',
  'managed-identity', 'tenant', 'secret-reference', 'rbac', 'schema-reference', 'linked-schema']);
const localCodes = new Set(['APIM_PROOF_MAPPING_MISMATCH', 'METADATA_MISMATCH', 'METADATA_INVALID', 'METADATA_STALE',
  'METADATA_SELECTION', 'ABORTED', 'PROOF_REPLAY_BLOCKED']);
const causeCodes = new Set(['CONTROL_VALIDATION', 'INVALID_CONFIG', 'LIMIT', 'SYNTAX_ERROR', 'TYPE_ERROR',
  'ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EROFS', 'EEXIST', 'ENOTDIR', 'EISDIR']);
const failureKinds = new Set(['mismatch', 'classified-error', 'invalid-json', 'invalid-response', 'filesystem', 'unclassified']);

export function sanitizeNativeProofDiagnostics(value) {
  if (!value || !stages.has(value.proofStage) || !resources.includes(value.resource)
    || !failureKinds.has(value.failureKind) || value.predicate !== undefined && !predicates.has(value.predicate)
    || value.causeCode !== undefined && !causeCodes.has(value.causeCode) && !localCodes.has(value.causeCode)
      && !sanitizeProvisioningErrorCode(value.causeCode)) return undefined;
  return { proofStage: value.proofStage, resource: value.resource, failureKind: value.failureKind,
    ...(value.predicate === undefined ? {} : { predicate: value.predicate }),
    ...(value.causeCode === undefined ? {} : { causeCode: value.causeCode }) };
}

export function nativeProofFailure(error, context) {
  const code = localCodes.has(error?.code) || sanitizeProvisioningErrorCode(error?.code)
    ? error.code : 'APIM_PROOF_MAPPING_MISMATCH';
  const causeCode = localCodes.has(error?.code) || causeCodes.has(error?.code) || sanitizeProvisioningErrorCode(error?.code)
    ? error.code : error instanceof SyntaxError ? 'SYNTAX_ERROR' : error instanceof TypeError ? 'TYPE_ERROR' : undefined;
  const failureKind = causeCode === 'SYNTAX_ERROR' ? 'invalid-json' : causeCode === 'TYPE_ERROR' ? 'invalid-response'
    : ['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EROFS', 'EEXIST', 'ENOTDIR', 'EISDIR'].includes(causeCode) ? 'filesystem'
    : causeCode === 'APIM_PROOF_MAPPING_MISMATCH' ? 'mismatch' : causeCode ? 'classified-error' : 'unclassified';
  const diagnostics = sanitizeNativeProofDiagnostics(error?.diagnostics)
    ?? sanitizeNativeProofDiagnostics({ ...context, failureKind, ...(causeCode ? { causeCode } : {}) });
  return Object.assign(new Error(code), { code, ...(diagnostics ? { diagnostics } : {}),
    ...(error?.invocationStatus === 'unknown' ? { invocationStatus: 'unknown' } : {}) });
}

const check = (condition, predicate, resource = 'project', proofStage = 'local-review') => {
  if (!condition) throw nativeProofFailure({ code: 'APIM_PROOF_MAPPING_MISMATCH' }, { proofStage, resource, predicate });
};
const normalizePolicy = value => value.replace(/\s+/g, '');
const fullId = (actual, expected) => typeof actual === 'string' && actual.toLowerCase() === expected.toLowerCase();

function artifacts(project) {
  const config = mcpRuntimeConfig(project.review.input);
  const template = JSON.parse(project.review.files['infra/gateway.json']);
  const map = JSON.parse(project.review.files['infra/operation-map.json']);
  return { config, template, map };
}

// Called only after immutable project and settled deployment validation, never from public JSON options.
export async function planNativeGetMapping(project, selection) {
  if (project.review.descriptor.kind !== 'native-apim-mcp') return undefined;
  const capture = validateMcpObservedCapture(selection.capture);
  const tool = capture.tools.tools.find(item => item.name === selection.toolName);
  if (!tool || tool.annotations !== undefined) return undefined;
  const { config, template, map } = artifacts(project);
  const apiKey = project.review.input.backend.auth === 'api-key';
  const delegated = project.review.input.backend.auth === 'entra';
  const application = project.review.input.backend.auth === 'managed-identity';
  requireMetadata(apiKey || delegated || application || project.review.input.backend.auth === 'anonymous', 'READ_ONLY_REVIEW_REQUIRED');
  const fixture = delegated ? await readDelegatedFixture(project.projectDir, selection.delegatedFixture) : undefined;
  if (fixture) requireMetadata(equal(fixture.input.azure, project.review.input.azure)
    && equal(fixture.input.inbound, project.review.input.inbound)
    && fixture.input.expectedUserId.toLowerCase() === capture.discoveryPlan.auth?.expectedUserId
    && selection.responseAssertion === 'controlled-delegated-v1', 'READ_ONLY_REVIEW_REQUIRED');
  check(equal(capture.source, project.review.descriptor), 'source');
  if (!apiKey) requireMetadata(equal(tool.inputSchema, { type: 'object', properties: {}, required: [], additionalProperties: false })
    && equal(selection.arguments, {}), 'PROOF_ARGUMENTS_INVALID');
  const matches = map.server.filter(item => item.displayName === tool.name);
  check(matches.length === 1, 'mapping-count');
  const mapped = matches[0], apiId = project.review.descriptor.ownership.apiId, restId = `${apiId}-rest`;
  const original = (await reviewRestOperations(config.connectors[0])).operations
    .find(operation => operation.operationId === mapped.originalOperationId);
  const mappedGet = apiKey ? planMappedKeyGet(config, original, tool, selection) : undefined;
  if (!apiKey && !application) requireMetadata(original?.backendMapping === null, 'READ_ONLY_REVIEW_REQUIRED');
  const resource = (type, name) => {
    const found = template.resources.filter(item => item.type === `Microsoft.ApiManagement/service/${type}`
      && item.name === `${config.azure.apimName}/${name}`);
    check(found.length === 1, 'resource-count');
    return found[0];
  };
  const native = resource('apis/tools', `${apiId}/${mapped.resourceId}`);
  const rest = resource('apis', restId), openapi = JSON.parse(rest.properties.value);
  const operations = Object.entries(openapi.paths).flatMap(([urlPath, item]) =>
    Object.entries(item).filter(([, operation]) => operation?.operationId === mapped.id)
      .map(([method, operation]) => ({ urlPath, item, method, operation })));
  check(operations.length === 1, 'operation-count');
  const { urlPath, item, method, operation } = operations[0];
  const sourcePaths = project.review.input.document.paths;
  const sourceItem = sourcePaths[urlPath];
  const graph = application ? graphOrganizationOperation(config.connectors[0], method, sourceItem?.[method] ?? {}, sourceItem ?? {}) : undefined;
  if (application) requireMetadata(graph && selection.responseAssertion === 'graph-organization-v1'
    && project.review.input.operationIds.length === 1 && map.server.length === 1, 'READ_ONLY_REVIEW_REQUIRED');
  requireMetadata(method === 'get' && /^\/[A-Za-z0-9._~/-]+$/.test(urlPath) && !urlPath.includes('//')
    && !urlPath.split('/').some(part => part === '.' || part === '..')
    && empty(item.parameters) && (apiKey || empty(operation.parameters)) && operation.requestBody === undefined
    && operation.callbacks === undefined, 'READ_ONLY_REVIEW_REQUIRED');
  check(tool.description === mapped.description && native.properties.displayName === tool.name
    && native.properties.operationId === `/apis/${restId}/operations/${mapped.id}`, 'tool-definition');
  const backend = new URL(rest.properties.serviceUrl);
  requireMetadata(fixture ? backend.href === fixture.endpoint && urlPath === fixture.path
    : backend.pathname === '/' && !backend.search && !backend.hash, 'READ_ONLY_REVIEW_REQUIRED');
  const receipt = await readControl(path.join(project.projectDir, 'infra', 'provisioning-receipt.json'));
  const history = await readMcpLifecycleAttempts(project.projectDir);
  check(equal(receipt.target, deploymentTarget(config)) && receipt.preservation?.verified === true
    && [apiId, restId].every(id => receipt.apiIntents?.includes(id))
    && receipt.completedSteps?.some(step => step.phase === 'gateway' && step.id === 'verify-owned-apis')
    && history.some(record => record.status === 'completed' && record.phase === 'gateway'
      && record.reviewDigest === project.review.reviewDigest)
    && history.every(record => ['completed', 'reconciled'].includes(record.status)), 'deployment-evidence');
  const serviceId = serviceResourceId(config);
  const vaultId = `/subscriptions/${config.azure.subscriptionId}/resourceGroups/${config.azure.resourceGroup}/providers/Microsoft.KeyVault/vaults/${config.azure.keyVaultName}`;
  const requests = [
    { suffix: 'policies' }, { suffix: 'diagnostics' },
    ...[apiId, restId].flatMap(id => [{ suffix: `apis/${id}` },
      { suffix: `apis/${id}/policies/policy`, rawPolicy: true }, { suffix: `apis/${id}/diagnostics` }]),
    { suffix: `apis/${restId}/operations/${mapped.id}/policies` },
    { suffix: `apis/${restId}/operations/${mapped.id}` },
    { suffix: `apis/${apiId}/tools/${mapped.resourceId}` },
  ].map(request => ({ ...request, method: 'GET',
    url: `https://management.azure.com${serviceId}/${request.suffix}?api-version=2025-09-01-preview${request.rawPolicy ? '&format=rawxml' : ''}` }));
  if (mappedGet) {
    mappedGet.schemaReadback = {
      contractVersion: 1, maximumResources: mappedGet.parameters.length,
      resourcePrefix: `${serviceId}/apis/${restId}/schemas/`,
      urlTemplate: `https://management.azure.com${serviceId}/apis/${restId}/schemas/{schemaId}?api-version=2024-05-01`,
      method: 'GET', contentType: 'application/vnd.oai.openapi.components+json',
      rule: 'Only safe schemaId/typeName pairs from the freshly verified operation; selected inline scalar must equal reviewed constraints. No reference traversal.',
    };
    mappedGet.keyReference.name = `${apiId}-backend-key`;
    mappedGet.keyReference.serviceId = serviceId;
    mappedGet.keyReference.vaultId = vaultId;
    const namedValue = resource('namedValues', mappedGet.keyReference.name);
    check(namedValue.properties.secret === true && namedValue.properties.keyVault?.secretIdentifier === mappedGet.keyReference.secretIdentifier
      && namedValue.properties.keyVault.identityClientId == null && namedValue.properties.value === undefined, 'secret-reference');
    requests.push(
      { suffix: 'proof-service-identity', method: 'GET', url: `https://management.azure.com${serviceId}?api-version=2024-05-01`,
        query: '{id:id,sku:sku.name,provisioningState:properties.provisioningState,gatewayUrl:properties.gatewayUrl,identity:{type:identity.type,principalId:identity.principalId,tenantId:identity.tenantId}}' },
      { suffix: 'proof-key-reference', method: 'GET', url: `https://management.azure.com${serviceId}/namedValues/${mappedGet.keyReference.name}?api-version=2024-05-01`,
        query: '{id:id,name:name,properties:{displayName:properties.displayName,secret:properties.secret,keyVault:properties.keyVault}}' },
      { suffix: 'proof-key-vault', method: 'GET', url: `https://management.azure.com${vaultId}?api-version=2023-07-01`,
        query: '{id:id,properties:{tenantId:properties.tenantId,enableRbacAuthorization:properties.enableRbacAuthorization}}' },
    );
  }
  if (fixture) requests.push(...delegatedFixtureReads(fixture));
  if (graph) requests.push(
    { suffix: 'proof-graph-service', method: 'GET', url: `https://management.azure.com${serviceId}?api-version=2024-05-01`,
      query: '{id:id,sku:sku.name,provisioningState:properties.provisioningState,gatewayUrl:properties.gatewayUrl,identity:{type:identity.type,principalId:identity.principalId,tenantId:identity.tenantId}}' },
    ...managedIdentityRequests(config.connectors[0]).map(request => ({ ...request, suffix: `proof-graph-${request.kind}`, method: 'GET' })),
  );
  return boundedSnapshot({
    kind: graph ? 'native-apim-graph-organization-get' : fixture ? 'native-apim-controlled-delegated-get' : mappedGet ? 'native-apim-mapped-key-get' : 'native-apim-fixed-get',
    ...(graph ? { responseAssertion: { kind: graph.kind, organizationId: graph.organizationId },
      backendApplication: config.connectors[0].managedIdentity, applicationClaimsAttested: false } : {}),
    ...(mappedGet ? { ...mappedGet } : {}),
    ...(fixture ? { delegatedFixture: fixture, fixtureSelection: selection.delegatedFixture,
      responseAssertion: { kind: 'controlled-delegated-v1', marker: fixture.marker } } : {}),
    sourceDigest: capture.source.descriptorDigest, captureDigest: capture.receiptDigest,
    reviewDigest: project.review.reviewDigest, artifactsDigest: metadataDigest(project.review.files),
    historyDigest: metadataDigest(history), receiptDigest: metadataDigest(receipt),
    azureIdentity: await readAzureIdentity(config, project.projectDir, { required: true }),
    serviceId, apiId, restApiId: restId, toolResourceId: mapped.resourceId, operationId: mapped.id,
    toolName: tool.name, toolDescription: tool.description, schemaDigest: metadataDigest(tool.inputSchema), method: 'GET', path: urlPath,
    backend: rest.properties.serviceUrl, targetUrl: graph ? graph.targetUrl : fixture ? `${fixture.endpoint}${fixture.path}`
      : new URL(mappedGet?.backendMapping.path ?? urlPath, backend).href,
    annotations: 'absent', sideEffectsVerified: false,
    verification: 'required-after-tool-relist-before-single-call', maximumReadbackMs: 120000,
    permissions: ['Read the exact selected Azure account and APIM API/tool/operation/policy/diagnostic resources. No writes or consent.',
      ...(graph ? ['Read the exact APIM system identity and selected-tenant Graph service principal, Organization.Read.All role and identity assignment. No grants or Graph business request during preflight. Incomplete assignment pagination blocks.'] : []),
      ...(fixture ? ['Read the separately reviewed controlled fixture API, exact policy, diagnostics, sole GET operation and inherited operation policy. Manual owner provisioning is required; local bundles are not deployment evidence.'] : []),
      ...(mappedGet ? ['Read only APIM system-identity, named-value Key Vault reference and vault tenant/RBAC metadata. Never retrieve a secret or call listValue.',
        'Conditionally read at most one same-backing-API schema resource per reviewed parameter, using the approved schemaReadback contract. No external or nested schema references.'] : [])],
    requests,
  });
}

export async function verifyNativeGetMapping(project, mapping, { run = runAzureCommand, signal, guard }) {
  let context = { proofStage: 'local-read', resource: 'project' };
  const at = (proofStage, resource) => { context = { proofStage, resource }; };
  const verify = (condition, predicate) => check(condition, predicate, context.resource, 'mapping-check');
  const projectGuard = async resource => { at('project-guard', resource); await guard(); };
  try {
    const { config, template } = artifacts(project);
    const receipt = await readControl(path.join(project.projectDir, 'infra', 'provisioning-receipt.json'));
    verify(metadataDigest(receipt) === mapping.receiptDigest, 'receipt-digest');
    const outputs = new Map();
    const guardedRun = async (command, args, options) => {
      requireMetadata(!signal?.aborted, 'ABORTED');
      return run(command, args, { ...options, signal });
    };
    const inspect = async (request, resource) => {
      await projectGuard(resource);
      at('azure-identity', resource);
      const identity = await azureIdentityGuard(config, project.projectDir, mapping.azureIdentity, guardedRun);
      await projectGuard(resource);
      at('arm-read', resource);
      const result = await guardedRun('az', ['rest', '--method', 'GET', '--url', request.url,
        '--headers', 'Accept=application/json', '--subscription', config.azure.subscriptionId,
        ...(request.query ? ['--query', request.query] : []),
        '--output', 'json', '--only-show-errors'], identity);
      at('arm-parse', resource);
      outputs.set(request.suffix, boundedSnapshot(controlOutput(result), 1048576));
      await projectGuard(resource);
    };
    for (const [index, request] of mapping.requests.entries()) {
      await inspect(request, request.suffix.startsWith('proof-graph-') ? 'backend-identity'
        : request.suffix.startsWith('delegated-fixture-') ? 'delegated-fixture' : resources[index + 1] ?? 'project');
    }
    const get = suffix => outputs.get(suffix);
    at('mapping-check', 'global-policy');
    const globalPolicy = policyValue(get('policies'));
    assertCompatibleGlobalPolicy(globalPolicy);
    verify(fingerprint(globalPolicy) === receipt.preservation.globalPolicyHash, 'global-policy-hash');
    at('mapping-check', 'service-diagnostics');
    assertSafeDiagnostics(get('diagnostics'), config);
    for (const [id, type] of [[mapping.apiId, 'mcp'], [mapping.restApiId, 'http']]) {
      at('mapping-check', type === 'mcp' ? 'native-api' : 'rest-api');
      const actual = get(`apis/${id}`), properties = actual?.properties;
      verify(fullId(actual?.id, `${mapping.serviceId}/apis/${id}`), 'id');
      verify(actual.name === id, 'name');
      verify(properties?.description === ownerDescription(config), 'owner');
      verify(properties.path === id, 'path');
      verify((properties.type ?? properties.apiType ?? 'http') === type, 'api-type');
      verify(properties.subscriptionRequired === false, 'subscription-required');
      verify(equal(properties.protocols ?? null, ['https']), 'protocols');
      if (type === 'http') verify(properties.serviceUrl === mapping.backend, 'backend');
      else {
        const { serviceUrl, mcpProperties } = properties;
        // Native ARM readback can omit transport or return disabled passthrough/federation defaults.
        verify(serviceUrl === undefined || serviceUrl === null || serviceUrl === '', 'backend');
        if (mcpProperties !== undefined && mcpProperties !== null) {
          verify(typeof mcpProperties === 'object' && !Array.isArray(mcpProperties)
            && Object.keys(mcpProperties).every(key => ['transportType', 'endpoints', 'federation', 'isFederationRouter'].includes(key)), 'metadata-shape');
          verify(mcpProperties.transportType === undefined || mcpProperties.transportType === 'streamable', 'transport');
          verify(mcpProperties.endpoints === undefined || mcpProperties.endpoints === null, 'endpoints');
          verify(mcpProperties.federation === undefined || mcpProperties.federation === null, 'federation');
          verify(mcpProperties.isFederationRouter === undefined || mcpProperties.isFederationRouter === false, 'federation-router');
        }
      }
      at('mapping-check', type === 'mcp' ? 'native-policy' : 'rest-policy');
      const intended = template.resources.find(item => item.type === 'Microsoft.ApiManagement/service/apis/policies'
        && item.name === `${config.azure.apimName}/${id}/policy`);
      const actualPolicy = get(`apis/${id}/policies/policy`);
      verify(typeof actualPolicy?.properties?.value === 'string'
        && (mapping.kind !== 'native-apim-fixed-get'
          ? actualPolicy.properties.value.trim().replace(/>\s+</g, '><') === intended.properties.value.trim().replace(/>\s+</g, '><')
          : normalizePolicy(actualPolicy.properties.value) === normalizePolicy(intended.properties.value)), 'policy');
      at('mapping-check', type === 'mcp' ? 'native-diagnostics' : 'rest-diagnostics');
      assertSafeDiagnostics(get(`apis/${id}/diagnostics`), config);
    }
    const operationPath = `apis/${mapping.restApiId}/operations/${mapping.operationId}`;
    at('mapping-check', 'operation-policy');
    assertInheritedOperationPolicies(get(`${operationPath}/policies`));
    at('mapping-check', 'operation');
    const operation = get(operationPath);
    verify(fullId(operation?.id, `${mapping.serviceId}/${operationPath}`), 'id');
    verify(operation.name === mapping.operationId, 'name');
    verify(operation.properties?.method === 'GET', 'method');
    if (mapping.kind === 'native-apim-mapped-key-get') {
      verify(operation.properties.urlTemplate?.split('?')[0] === mapping.path, 'path');
      const references = [];
      verify(mappedOperationMatches(operation.properties, mapping, (parameter, expected) => {
        if (!mappedSchemaReference(parameter)) return false;
        references.push({ parameter, expected });
        return true;
      }), 'query-parameters');
      if (references.length) {
        at('mapping-check', 'operation-schema');
        const prefix = `${mapping.serviceId}/apis/${mapping.restApiId}/schemas/`;
        verify(mapping.schemaReadback?.contractVersion === 1
          && mapping.schemaReadback.resourcePrefix === prefix
          && mapping.schemaReadback.maximumResources === mapping.parameters.length
          && references.length <= mapping.schemaReadback.maximumResources, 'schema-reference');
        for (const { parameter, expected } of references) {
          const suffix = `apis/${mapping.restApiId}/schemas/${parameter.schemaId}`;
          if (!outputs.has(suffix)) await inspect({ suffix,
            url: `https://management.azure.com${prefix}${parameter.schemaId}?api-version=2024-05-01` }, 'operation-schema');
          at('mapping-check', 'operation-schema');
          verify(mappedLinkedSchemaMatches(get(suffix), parameter, expected, prefix), 'linked-schema');
        }
      }
    } else {
      verify(operation.properties.urlTemplate === mapping.path, 'path');
      verify(Array.isArray(operation.properties.templateParameters) && operation.properties.templateParameters.length === 0, 'template-parameters');
      verify(empty(operation.properties.request?.queryParameters), 'query-parameters');
    }
    verify(empty(operation.properties.request?.headers), 'headers');
    verify(empty(operation.properties.request?.representations), 'representations');
    at('mapping-check', 'tool');
    const toolPath = `apis/${mapping.apiId}/tools/${mapping.toolResourceId}`, tool = get(toolPath);
    const expectedReference = `/${operationPath}`;
    verify(fullId(tool?.id, `${mapping.serviceId}/${toolPath}`), 'id');
    verify(tool.name === mapping.toolResourceId, 'name');
    verify(tool.properties?.displayName === mapping.toolName, 'display-name');
    verify(tool.properties.description === mapping.toolDescription, 'description');
    verify(tool.properties.operationId === expectedReference
      || fullId(tool.properties.operationId, `${mapping.serviceId}${expectedReference}`), 'operation-reference');
    if (mapping.kind === 'native-apim-mapped-key-get') {
      at('mapping-check', 'apim-identity');
      const service = get('proof-service-identity'), reference = mapping.keyReference;
      verify(fullId(service?.id, mapping.serviceId), 'id');
      assertCompatibleService(service, config);
      verify(['SystemAssigned', 'SystemAssigned, UserAssigned'].includes(service.identity?.type)
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(service.identity.principalId)
        && service.identity.principalId !== '00000000-0000-0000-0000-000000000000', 'managed-identity');
      verify(fullId(service.identity.tenantId, reference.tenantId), 'tenant');
      at('mapping-check', 'key-reference');
      const named = get('proof-key-reference');
      verify(fullId(named?.id, `${mapping.serviceId}/namedValues/${reference.name}`) && named.name === reference.name, 'id');
      verify(named.properties?.displayName === reference.name && named.properties.secret === true
        && named.properties.keyVault?.secretIdentifier === reference.secretIdentifier
        && named.properties.keyVault.identityClientId == null && named.properties.value === undefined, 'secret-reference');
      at('mapping-check', 'key-vault');
      const vault = get('proof-key-vault');
      verify(fullId(vault?.id, reference.vaultId), 'id');
      verify(fullId(vault.properties?.tenantId, reference.tenantId), 'tenant');
      verify(vault.properties.enableRbacAuthorization === true, 'rbac');
    }
    if (mapping.kind === 'native-apim-controlled-delegated-get') {
      at('mapping-check', 'delegated-fixture');
      verifyDelegatedFixture(mapping.delegatedFixture, outputs, verify, config);
    }
    if (mapping.kind === 'native-apim-graph-organization-get') {
      at('mapping-check', 'backend-identity');
      assertCompatibleService(get('proof-graph-service'), config);
      for (const request of managedIdentityRequests(config.connectors[0])) {
        assertManagedIdentityMetadata(request.kind, get(`proof-graph-${request.kind}`), config.connectors[0]);
      }
    }
    await projectGuard('project');
    requireMetadata(!signal?.aborted, 'ABORTED');
    return boundedSnapshot({ kind: `${mapping.kind}-readback`,
      mappingDigest: metadataDigest(mapping),
      observedDigest: metadataDigest(Object.fromEntries(outputs)), verifiedAt: new Date().toISOString(),
      method: mapping.method, targetUrl: mapping.targetUrl, sideEffectsVerified: false });
  } catch (error) { throw nativeProofFailure(error, context); }
}
