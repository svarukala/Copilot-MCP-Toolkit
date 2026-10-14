import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { needsGateway, apimMode, keyVaultMode, createsVault, gatewayApiId, inboundAuthorization, upstreamMcpMapping,
  experimentalProxy, proxyBackendId, SECRET_USER_ROLE, requireStandaloneConfig } from './contract.js';
import { backendMappingPolicy } from './rest-authoring.js';
import { OWNER_TAG, ownerId, ownerDescription, managedApis, proxyBackendProperties } from './apim-safety.js';
import { checkManagedIdentityConfig } from './apim-managed-identity.js';

export const MCP_API_VERSION = '2025-09-01-preview';

export const APIM_VERSION = '2024-05-01';

export const DENY_POLICY = '<policies><inbound><return-response><set-status code="403" reason="Not configured" /></return-response></inbound><backend><forward-request buffer-response="false" /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

const xml = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

const literal = value => typeof value === 'string' && value.startsWith('[') ? `[${value}` : value;

const arm = resources => ({
  $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
  contentVersion: '1.0.0.0', resources,
});

const rid = (type, ...names) => `[resourceId('${type}', ${names.map(n => `'${n}'`).join(', ')})]`;

export function requireUuid(value, label) {
  if (!uuid.test(value ?? '')) throw new Error(`${label} must be a UUID.`);
  return value;
}

export function checkConfig(config) {
  requireStandaloneConfig(config);
  if (experimentalProxy(config) || config.connectors?.some(c => c.mcpProxyVersion === 3)) {
    if (!experimentalProxy(config) || !config.server || config.plugin || config.connectors.length !== 1
      || config.connectors[0].mcpProxyVersion !== 3 || config.azure?.apimMode !== 'existing'
      || config.azure.resourceGroupMode !== 'existing' || config.azure.keyVaultMode !== 'existing') {
      throw new Error('Experimental proxy is standalone opt-in only, with one v3 connector and explicitly existing APIM/resource group/vault.');
    }
  }
  const ids = new Set();
  const apiIds = new Set();
  for (const c of config.connectors ?? []) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c.id ?? '') || c.id.length > 64 || ids.has(c.id)) throw new Error('Connector IDs must be unique lowercase route names (1–64 characters).');
    ids.add(c.id);
    if (needsGateway(c)) for (const apiId of c.kind === 'rest' ? [c.id, `${c.id}-rest`] : [c.id]) {
      if (apiIds.has(apiId)) throw new Error('Connector IDs collide with a generated backing REST API ID.');
      apiIds.add(apiId);
    }
    if (!['mcp', 'rest'].includes(c.kind) || !['anonymous', 'api-key', 'entra', 'oauth', 'managed-identity'].includes(c.auth)) throw new Error(`Unsupported connector ${c.id}.`);
    checkManagedIdentityConfig(config, c);
    if (c.mcpProxyVersion !== undefined) upstreamMcpMapping(c);
    if (c.auth === 'oauth' && (c.kind !== 'mcp' || c.entra || c.apiKey
      || new URL(c.endpoint).hostname.endsWith('.azure-api.net'))) {
      throw new Error('Third-party OAuth supports direct MCP only, without Entra, API-key or APIM routing.');
    }
    const endpoint = new URL(c.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || /[{}\r\n]/.test(c.endpoint)) throw new Error(`${c.id}: endpoint must be HTTPS without credentials, query, fragment, or policy substitutions.`);
    if (c.entra?.clientId) requireUuid(c.entra.clientId, `${c.id} clientId`);
    if (c.entra?.tenantId) requireUuid(c.entra.tenantId, `${c.id} tenantId`);
    if (c.entra?.scope && !/^[a-zA-Z][a-zA-Z0-9_.-]{0,119}$/.test(c.entra.scope)) throw new Error(`${c.id}: invalid delegated scope.`);
    if (c.entra?.applicationIdUri && !/^(api|https):\/\/[^\s<>"'{}]+$/.test(c.entra.applicationIdUri)) throw new Error(`${c.id}: invalid application ID URI.`);
    if (c.auth === 'api-key') {
      if (Object.keys(c.apiKey ?? {}).some(k => !['secretIdentifier', 'headerName', 'queryParameterName'].includes(k))) throw new Error('API-key config accepts only a secret identifier and a header or query parameter name, never a secret value.');
      if (Boolean(c.apiKey?.headerName) === Boolean(c.apiKey?.queryParameterName)) throw new Error(`${c.id}: choose exactly one API-key header or query parameter.`);
      if (c.apiKey.headerName && (!/^[A-Za-z][A-Za-z0-9-]{0,99}$/.test(c.apiKey.headerName)
        || /^(host|content-length|transfer-encoding|connection|cookie|set-cookie|proxy-authorization)$/i.test(c.apiKey.headerName))) throw new Error(`${c.id}: unsupported API-key header.`);
      if (c.apiKey.queryParameterName && !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(c.apiKey.queryParameterName)) throw new Error(`${c.id}: unsupported API-key query parameter.`);
      const secret = new URL(c.apiKey.secretIdentifier);
      if (!/^https:\/\/[a-z0-9-]+\.vault\.azure\.net\/secrets\/[a-zA-Z0-9-]+$/.test(secret.href)) throw new Error(`${c.id}: use a versionless Azure Key Vault secret URI.`);
      if (!config.azure?.keyVaultName || secret.hostname !== `${config.azure.keyVaultName}.vault.azure.net`.toLowerCase()) throw new Error(`${c.id}: secret must belong to azure.keyVaultName in this resource group.`);
    }
  }
  if ((config.connectors ?? []).some(needsGateway)) {
    const a = config.azure;
    if (!a) throw new Error('Azure configuration is required for APIM connectors.');
    requireUuid(a.subscriptionId, 'Azure subscriptionId');
    requireUuid(a.tenantId, 'Azure tenantId');
    if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.()-]{0,88}[a-zA-Z0-9_-]$/.test(a.resourceGroup ?? '')) throw new Error('Invalid resource group name.');
    if (!/^[a-z][a-z0-9-]{0,48}[a-z0-9]$/.test(a.apimName ?? '')) throw new Error('Invalid APIM name.');
    if (!['new', 'existing'].includes(apimMode(config))) throw new Error('APIM mode must be new or existing.');
    if (a.resourceGroupMode && !['new', 'existing'].includes(a.resourceGroupMode)) throw new Error('Resource group mode must be new or existing.');
    if (a.resourceGroupMode === 'new' && apimMode(config) === 'existing') throw new Error('An existing APIM requires its existing resource group.');
    if (!['new', 'existing'].includes(keyVaultMode(config))) throw new Error('Key Vault mode must be new or existing.');
    if (a.keyVaultMode && !config.connectors.some(c => c.auth === 'api-key')) throw new Error('Key Vault selection is unnecessary without a secret-backed backend.');
    if (createsVault(config) && !/^[a-z0-9]+$/.test(a.location ?? '')) throw new Error('An explicit location is required to create a Key Vault.');
    if (apimMode(config) === 'new') {
      if (!/^[a-z0-9]+$/.test(a.location ?? '')) throw new Error('Use an Azure location code.');
      if (!['Developer', 'Basicv2', 'Standardv2', 'Premium'].includes(a.sku)) throw new Error('APIM requires Developer, Basicv2, Standardv2, or Premium; Consumption is unsupported.');
      if (!a.publisherName || !a.publisherEmail) throw new Error('APIM publisher name and email are required.');
    } else requireUuid(config.server.id, 'Owner id for existing APIM');
    if (a.keyVaultName && !/^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$/.test(a.keyVaultName)) throw new Error('Invalid Key Vault name.');
  }
}

export function tenant(config, c) {
  return c.entra?.tenantId ?? config.azure?.tenantId;
}

export function buildPolicy(config, c, { backend = true, routing = '' } = {}) {
  if (backend && c.mcpProxyVersion === 3) {
    routing = `<set-backend-service backend-id="${xml(proxyBackendId(config, c))}" /><rewrite-uri template="/mcp/" copy-unmatched-params="false" />`;
  }
  const inbound = inboundAuthorization(config, c);
  if (!inbound?.tenantId || !inbound.applicationIdUri || !inbound.clientId || !inbound.allowedClientIds?.length) return DENY_POLICY;
  // Entra v2 access tokens use the resource client ID; v1 can use its URI or ID.
  const audiences = [inbound.applicationIdUri, inbound.clientId];
  const validation = `<validate-azure-ad-token tenant-id="${xml(inbound.tenantId)}" header-name="Authorization" failed-validation-httpcode="401" failed-validation-error-message="Unauthorized">
      <client-application-ids>${inbound.allowedClientIds.map(id => `<application-id>${xml(id)}</application-id>`).join('')}</client-application-ids>
      <audiences>${audiences.map(value => `<audience>${xml(value)}</audience>`).join('')}</audiences>
      <required-claims><claim name="scp" match="all" separator=" "><value>${xml(inbound.scope ?? 'access_as_user')}</value></claim></required-claims>
    </validate-azure-ad-token>`;
  let outboundAuth = '';
  if (!backend || c.auth === 'entra') outboundAuth += '<set-header name="Authorization" exists-action="override"><value>@(context.Request.Headers.GetValueOrDefault("Authorization", ""))</value></set-header>';
  if (backend) {
    if (c.auth !== 'entra') outboundAuth += '<set-header name="Authorization" exists-action="delete" />';
    if (c.auth === 'managed-identity') {
      checkManagedIdentityConfig(config, c);
      outboundAuth += `<authentication-managed-identity resource="${xml(c.managedIdentity.resource)}" ignore-error="false" />`;
    }
    if (c.auth === 'api-key') {
      const tag = c.apiKey.queryParameterName ? 'set-query-parameter' : 'set-header';
      const name = c.apiKey.queryParameterName ?? c.apiKey.headerName;
      outboundAuth += `<${tag} name="${xml(name)}" exists-action="override"><value>{{${gatewayApiId(config, c)}-backend-key}}</value></${tag}>`;
    }
    if (c.kind === 'rest') outboundAuth += `<set-backend-service base-url="${xml(c.endpoint)}" />`;
  }
  // A dedicated service uses our deny baseline; shared services retain inheritance.
  const inherited = apimMode(config) === 'existing' ? '<base />' : '';
  return `<policies><inbound>${inherited}${validation}${backend ? routing : ''}${outboundAuth}</inbound><backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>`;
}

function policyResource(apimName, apiId, value, dependencies = []) {
  return {
    type: 'Microsoft.ApiManagement/service/apis/policies', apiVersion: APIM_VERSION,
    name: `${apimName}/${apiId}/policy`, dependsOn: [rid('Microsoft.ApiManagement/service/apis', apimName, apiId), ...dependencies],
    properties: { format: 'rawxml', value },
  };
}

function foundationTemplate(config) {
  if (!(config.connectors ?? []).some(needsGateway)) return arm([]);
  const a = config.azure;
  const resources = apimMode(config) === 'new' ? [{
    type: 'Microsoft.ApiManagement/service', apiVersion: APIM_VERSION, name: a.apimName,
    location: a.location, identity: { type: 'SystemAssigned' }, sku: { name: a.sku, capacity: 1 },
    tags: { [OWNER_TAG]: ownerId(config) },
    properties: { publisherEmail: literal(a.publisherEmail), publisherName: literal(a.publisherName) },
  }, {
    type: 'Microsoft.ApiManagement/service/policies', apiVersion: APIM_VERSION, name: `${a.apimName}/policy`,
    dependsOn: [rid('Microsoft.ApiManagement/service', a.apimName)],
    properties: { format: 'rawxml', value: DENY_POLICY },
  }] : [];
  if (createsVault(config)) resources.push({
    type: 'Microsoft.KeyVault/vaults', apiVersion: '2023-07-01', name: a.keyVaultName, location: a.location,
    tags: { [OWNER_TAG]: ownerId(config) },
    properties: { tenantId: a.tenantId, sku: { family: 'A', name: 'standard' }, accessPolicies: [],
      enableRbacAuthorization: true, enableSoftDelete: true, softDeleteRetentionInDays: 90, enablePurgeProtection: true,
      publicNetworkAccess: 'Enabled',
    },
  });
  return arm(resources);
}

function accessTemplate(config) {
  if (experimentalProxy(config)) return arm([]);
  const a = config.azure;
  const keys = (config.connectors ?? []).filter(c => c.auth === 'api-key');
  const seen = new Set();
  return arm(keys.flatMap(c => {
    const secret = new URL(c.apiKey.secretIdentifier).pathname.split('/')[2];
    if (seen.has(secret)) return [];
    seen.add(secret);
    return [{
      type: 'Microsoft.Authorization/roleAssignments', apiVersion: '2022-04-01',
      name: `[guid(resourceId('Microsoft.KeyVault/vaults/secrets', '${a.keyVaultName}', '${secret}'), '${a.apimName}', '${SECRET_USER_ROLE}')]`,
      scope: rid('Microsoft.KeyVault/vaults/secrets', a.keyVaultName, secret),
      properties: {
        roleDefinitionId: `[subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '${SECRET_USER_ROLE}')]`,
        principalId: `[reference(resourceId('Microsoft.ApiManagement/service', '${a.apimName}'), '${APIM_VERSION}', 'Full').identity.principalId]`,
        principalType: 'ServicePrincipal',
      },
    }];
  }));
}

async function importedSpec(c, document = c.rest?.document) {
  let spec = document;
  if (spec === undefined) {
    const info = await lstat(c.rest.openApiPath);
    if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new Error(`${c.id}: OpenAPI must be a regular JSON file no larger than 10 MB.`);
    spec = JSON.parse(await readFile(c.rest.openApiPath, 'utf8'));
  }
  if (!/^3\.0\.\d+$/.test(spec.openapi ?? '')) throw new Error(`${c.id}: provide OpenAPI 3.0.x JSON; convert Swagger or other formats before import.`);
  const checkRefs = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string' && !value.$ref.startsWith('#/')) throw new Error(`${c.id}: bundle external OpenAPI references locally before deployment.`);
    for (const child of Object.values(value)) checkRefs(child);
  };
  checkRefs(spec);
  const selected = new Set(c.rest.operationIds ?? []);
  if (!selected.size) throw new Error(`${c.id}: select at least one REST operation.`);
  const found = new Set();
  const tools = [];
  const review = [];
  const routes = [];
  const paths = {};
  const stripKeyParameter = parameters => c.auth !== 'api-key' ? parameters : parameters?.filter(parameter => {
    let resolved = parameter;
    const seen = new Set();
    while (resolved?.$ref) {
      if (seen.has(resolved.$ref)) throw new Error(`${c.id}: cyclic OpenAPI parameter reference.`);
      seen.add(resolved.$ref);
      if (!resolved.$ref.startsWith('#/components/parameters/')) throw new Error(`${c.id}: unsupported OpenAPI parameter reference.`);
      const name = resolved.$ref.slice('#/components/parameters/'.length).replace(/~1/g, '/').replace(/~0/g, '~');
      resolved = spec.components?.parameters?.[name];
      if (!resolved) throw new Error(`${c.id}: unresolved OpenAPI parameter reference.`);
    }
    return !(resolved?.in === (c.apiKey.queryParameterName ? 'query' : 'header')
      && (c.apiKey.queryParameterName ? resolved?.name === c.apiKey.queryParameterName
        : resolved?.name?.toLowerCase() === c.apiKey.headerName.toLowerCase()));
  });
  for (const [urlPath, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(pathItem)) {
      if (!methods.has(method) || !selected.has(op?.operationId)) continue;
      if (found.has(op.operationId)) throw new Error(`${c.id}: duplicate operationId ${op.operationId}.`);
      found.add(op.operationId);
      // Explicit normalized IDs avoid APIM's lossy operationId normalization and collisions.
      const id = `op-${createHash('sha256').update(op.operationId).digest('hex').slice(0, 24)}`;
      const route = backendMappingPolicy(c, method, op, pathItem, id);
      if (route) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(op.operationId)) throw new Error(`${c.id}: mapped tool names must be simple operation identifiers.`);
        routes.push(route);
      }
      paths[urlPath] ??= pathItem.parameters ? { parameters: stripKeyParameter(pathItem.parameters) } : {};
      const operation = { ...op, operationId: id };
      delete operation.servers;
      delete operation['x-cowork-backend'];
      if (op.parameters) operation.parameters = stripKeyParameter(op.parameters);
      if (c.auth === 'api-key') delete operation.security;
      paths[urlPath][method] = operation;
      tools.push({ id, displayName: route ? op.operationId : op.operationId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 260) + `_${id.slice(-8)}`,
        description: String(op.description ?? op.summary ?? op.operationId).slice(0, 1000), originalOperationId: op.operationId });
      review.push({ operationId: op.operationId, toolName: tools.at(-1).displayName,
        method: method.toUpperCase(), path: urlPath,
        parameters: [...(paths[urlPath].parameters ?? []), ...(operation.parameters ?? [])],
        ...(operation.requestBody ? { requestBody: operation.requestBody } : {}),
        backendMapping: op['x-cowork-backend'] ?? null });
    }
  }
  if (found.size !== selected.size) throw new Error(`${c.id}: selected operation IDs were not found in the OpenAPI document.`);
  const result = { ...spec, paths };
  if (c.auth === 'api-key') delete result.security;
  delete result['x-ms-paths'];
  result.servers = [{ url: c.endpoint }];
  if (routes.length && routes.length !== tools.length) throw new Error(`${c.id}: all selected operations must have explicit backend mappings when any operation is mapped.`);
  const routing = routes.length ? `<choose>${routes.join('')}<otherwise><return-response><set-status code="404" reason="Unknown mapped operation" /></return-response></otherwise></choose>` : '';
  return { spec: result, tools, routing, review };
}

export async function reviewRestOperations(connector) {
  const { review } = await importedSpec(connector);
  return { connectorId: connector.id, operations: review,
    limitations: ['OpenAPI review only; actual MCP input schemas must come from tools/list.',
      'Review fixed backend actions and renamed parameters against requirements; no intent match is inferred.'] };
}

export async function gatewayTemplate(config, documents = {}) {
  const resources = [];
  const operationMap = {};
  const a = config.azure;
  for (const c of (config.connectors ?? []).filter(needsGateway)) {
    const apiId = gatewayApiId(config, c);
    const dependencies = [];
    if (c.auth === 'api-key') {
      resources.push({
        type: 'Microsoft.ApiManagement/service/namedValues', apiVersion: APIM_VERSION,
        name: `${a.apimName}/${apiId}-backend-key`,
        properties: { displayName: `${apiId}-backend-key`, secret: true,
          keyVault: { secretIdentifier: c.apiKey.secretIdentifier } },
      });
      dependencies.push(rid('Microsoft.ApiManagement/service/namedValues', a.apimName, `${apiId}-backend-key`));
    }
    if (c.kind === 'rest') {
      const { spec, tools, routing } = await importedSpec(c, documents[c.id]);
      // APIM imports info.description over the API resource's description.
      spec.info = { ...spec.info, description: ownerDescription(config) };
      // APIM enforces tool resource IDs across the service, not just the parent API.
      operationMap[c.id] = tools.map(tool => ({ ...tool,
        resourceId: `tool-${createHash('sha256').update(JSON.stringify([apiId, tool.id])).digest('hex').slice(0, 32)}` }));
      const restId = `${apiId}-rest`;
      resources.push({
        type: 'Microsoft.ApiManagement/service/apis', apiVersion: MCP_API_VERSION,
        name: `${a.apimName}/${restId}`,
        properties: { displayName: literal(`${c.displayName} REST`), description: ownerDescription(config), type: 'http', path: restId,
          protocols: ['https'], serviceUrl: c.endpoint, subscriptionRequired: false,
          format: 'openapi+json', value: JSON.stringify(spec) },
      });
      resources.push(policyResource(a.apimName, restId, buildPolicy(config, c, { routing }), dependencies));
      resources.push({
        type: 'Microsoft.ApiManagement/service/apis', apiVersion: MCP_API_VERSION,
        name: `${a.apimName}/${apiId}`,
        dependsOn: [rid('Microsoft.ApiManagement/service/apis/policies', a.apimName, restId, 'policy')],
        properties: { displayName: literal(c.displayName), description: ownerDescription(config), type: 'mcp', path: apiId,
          protocols: ['https'], subscriptionRequired: false, mcpProperties: { transportType: 'streamable' } },
      });
      resources.push(policyResource(a.apimName, apiId, buildPolicy(config, c, { backend: false })));
      let previousTool;
      for (const tool of operationMap[c.id]) {
        // APIM tool writes can update the parent API revision; avoid sibling ETag races.
        resources.push({
          type: 'Microsoft.ApiManagement/service/apis/tools', apiVersion: MCP_API_VERSION,
          name: `${a.apimName}/${apiId}/${tool.resourceId}`,
          dependsOn: [rid('Microsoft.ApiManagement/service/apis/policies', a.apimName, apiId, 'policy'),
            ...(previousTool ? [rid('Microsoft.ApiManagement/service/apis/tools', a.apimName, apiId, previousTool)] : [])],
          properties: { displayName: tool.displayName, description: literal(tool.description),
            operationId: `/apis/${restId}/operations/${tool.id}` },
        });
        previousTool = tool.resourceId;
      }
    } else {
      const upstream = upstreamMcpMapping(c);
      if (c.mcpProxyVersion === 3) {
        resources.push({
          type: 'Microsoft.ApiManagement/service/backends', apiVersion: MCP_API_VERSION,
          name: `${a.apimName}/${proxyBackendId(config, c)}`, properties: proxyBackendProperties(config, c),
        });
        dependencies.push(rid('Microsoft.ApiManagement/service/backends', a.apimName, proxyBackendId(config, c)));
      }
      resources.push({
        type: 'Microsoft.ApiManagement/service/apis', apiVersion: MCP_API_VERSION, name: `${a.apimName}/${apiId}`,
        ...(c.mcpProxyVersion === 3 ? { dependsOn: [...dependencies] } : {}),
        properties: { displayName: literal(c.displayName), description: ownerDescription(config), type: 'mcp', path: apiId,
          protocols: ['https'], ...(c.mcpProxyVersion === 3 ? { backendId: proxyBackendId(config, c) } : { serviceUrl: upstream.serviceUrl }),
          subscriptionRequired: false,
          mcpProperties: upstream.mcpProperties },
      });
      resources.push(policyResource(a.apimName, apiId, buildPolicy(config, c), dependencies));
    }
  }
  return { template: arm(resources), operationMap };
}

export async function renderInfrastructure(config, documents = {}) {
  checkConfig(config);
  const { template, operationMap } = await gatewayTemplate(config, documents);
  return {
    'foundation.json': foundationTemplate(config), 'secret-access.json': accessTemplate(config),
    'gateway.json': template, 'staging.json': stagingTemplate(config), 'operation-map.json': operationMap,
    'deny-policy.json': { properties: { format: 'rawxml', value: DENY_POLICY } },
  };
}

function stagingTemplate(config) {
  if (apimMode(config) !== 'existing' || !config.connectors?.some(needsGateway)) return arm([]);
  return arm(managedApis(config).flatMap(({ id, type, connector: c }) => [{
    type: 'Microsoft.ApiManagement/service/apis', apiVersion: MCP_API_VERSION,
    name: `${config.azure.apimName}/${id}`,
    properties: {
      displayName: literal(type === 'http' ? `${c.displayName} REST` : c.displayName),
      description: ownerDescription(config), type, path: id,
      protocols: ['https'], subscriptionRequired: true,
      ...(type === 'mcp' ? { mcpProperties: { transportType: 'streamable' } } : {}),
    },
  }, policyResource(config.azure.apimName, id, DENY_POLICY)]));
}

export async function intendedApiPolicy(config, api) {
  const routing = api.type === 'http' && api.connector.kind === 'rest'
    ? (await importedSpec(api.connector)).routing : '';
  return buildPolicy(config, api.connector, {
    backend: api.type === 'http' || api.connector.kind === 'mcp', routing,
  });
}
