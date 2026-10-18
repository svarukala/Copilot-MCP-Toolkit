import { createHash } from 'node:crypto';
import { apimMode, gatewayApiId, needsGateway, resourceOwnerIdentity, upstreamMcpMapping,
  experimentalProxy, proxyBackendId, SECRET_USER_ROLE } from './contract.js';
import { publicAnonymous } from './apim-public.js';

export const OWNER_TAG = 'cowork-toolkit-project';

export class ApimSafetyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApimSafetyError';
    this.code = code;
  }
}

export function ownerId(config) {
  return createHash('sha256').update(resourceOwnerIdentity(config)).digest('hex').slice(0, 24);
}

export function deploymentTarget(config) {
  const a = config.azure;
  return {
    project: ownerId(config), mode: apimMode(config),
    tenant: a?.tenantId ?? config.connectors?.find(c => c.entra?.tenantId)?.entra.tenantId ?? null,
    subscription: a?.subscriptionId ?? null, resourceGroup: a?.resourceGroup ?? null,
    apim: a?.apimName ?? null, vault: a?.keyVaultName ?? null,
    ...(a?.resourceGroupMode ? { resourceGroupMode: a.resourceGroupMode } : {}),
    ...(a?.keyVaultMode ? { keyVaultMode: a.keyVaultMode } : {}),
    ...(publicAnonymous(config) ? { publicExposure: { profile: 'public-read-only-get-v1', inbound: config.inbound } } : {}),
  };
}

export function serviceResourceId(config) {
  const a = config.azure;
  return `/subscriptions/${a.subscriptionId}/resourceGroups/${a.resourceGroup}/providers/Microsoft.ApiManagement/service/${a.apimName}`;
}

export function managedApis(config) {
  return config.connectors.filter(needsGateway).flatMap(c => {
    const id = gatewayApiId(config, c);
    return [{ id, type: 'mcp', connector: c },
      ...(c.kind === 'rest' ? [{ id: `${id}-rest`, type: 'http', connector: c }] : [])];
  });
}

export function ownerDescription(config) {
  if (config.server) return `Managed MCP server; owner=${ownerId(config)}`;
  return `Managed by Cowork Plugin Toolkit; owner=${ownerId(config)}`;
}

export function managedBackends(config) {
  return experimentalProxy(config) ? config.connectors.map(connector => ({
    id: proxyBackendId(config, connector), connector,
  })) : [];
}

export function proxyBackendProperties(config, connector) {
  return { description: ownerDescription(config), url: upstreamMcpMapping(connector).backendUrl,
    type: 'Single', protocol: 'http', tls: { validateCertificateChain: true, validateCertificateName: true } };
}

export function assertProxyBackend(actual, config, connector) {
  const id = proxyBackendId(config, connector), p = actual?.properties, expected = proxyBackendProperties(config, connector);
  const optional = ['credentials', 'proxy', 'properties', 'circuitBreaker', 'pool', 'resourceId', 'title', 'azureRegion'];
  const empty = value => value == null || value === ''
    || typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
  if (typeof actual?.id !== 'string' || actual.id.toLowerCase() !== `${serviceResourceId(config)}/backends/${id}`.toLowerCase()
    || actual.name !== id || !p
    || Object.keys(p).some(key => ![...Object.keys(expected), ...optional].includes(key))
    || Object.keys(expected).some(key => !Object.hasOwn(p, key) || fingerprint(p[key]) !== fingerprint(expected[key]))
    || optional.some(key => !empty(p[key]))) {
    throw new ApimSafetyError('APIM_PROXY_BACKEND_MISMATCH',
      'Experimental backend readback differs from exact owned origin/protocol/TLS with no alternate routing or credentials. Preserve state; do not activate or normalize it.');
  }
}

export function assertNoBackendCollisions(backends, config, receipt) {
  for (const expected of managedBackends(config)) {
    const present = backends.filter(item => typeof item?.name === 'string' && item.name.toLowerCase() === expected.id.toLowerCase());
    if (present.length > 1 || present.length && (!(receipt.backendIntents ?? []).includes(expected.id)
      || present[0].properties?.description !== ownerDescription(config))) {
      throw new ApimSafetyError('APIM_BACKEND_COLLISION',
        'Experimental backend identifier exists without this project intent and ownership. No adoption, overwrite or deletion is supported.');
    }
    if (present.length) assertProxyBackend(present[0], config, expected.connector);
  }
}

export function proxySecretScope(config) {
  const name = new URL(config.connectors[0].apiKey.secretIdentifier).pathname.split('/')[2];
  return `/subscriptions/${config.azure.subscriptionId}/resourceGroups/${config.azure.resourceGroup}/providers/Microsoft.KeyVault/vaults/${config.azure.keyVaultName}/secrets/${name}`;
}

export function assertExistingProxyGrant(output, config, service) {
  assertCompatibleService(service, config);
  const scope = proxySecretScope(config), principal = service.identity?.principalId;
  const role = `/subscriptions/${config.azure.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${SECRET_USER_ROLE}`;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const assignments = collectionItems(output, 'Secret role assignment');
  if (assignments.length > 5000) throw new ApimSafetyError('APIM_INVENTORY_LIMIT', 'Secret grant inventory exceeds the bounded limit.');
  if (!uuid.test(principal ?? '') || !assignments.some(item => {
    const p = item?.properties;
    const assignmentId = typeof item?.id === 'string' ? item.id.split('/').at(-1) : '';
    return p && ['scope', 'principalId', 'roleDefinitionId'].every(key => typeof p[key] === 'string')
      && p.scope.toLowerCase() === scope.toLowerCase() && p.principalId.toLowerCase() === principal.toLowerCase()
      && p.principalType === 'ServicePrincipal' && p.roleDefinitionId.toLowerCase() === role.toLowerCase()
      && (p.condition == null || p.condition === '') && p.delegatedManagedIdentityResourceId == null
      && uuid.test(assignmentId)
      && item.id.toLowerCase() === `${scope}/providers/Microsoft.Authorization/roleAssignments/${assignmentId}`.toLowerCase();
  })) {
    throw new ApimSafetyError('APIM_SECRET_GRANT_REQUIRED',
      'Experimental proxy requires an existing unconditional exact secret-scoped Key Vault Secrets User assignment to the current APIM system identity. No role grant or secret read/write was attempted.');
  }
}

export function collectionItems(output, label) {
  if (!output || !Array.isArray(output.value) || output.nextLink) {
    throw new ApimSafetyError('APIM_INVENTORY_INCOMPLETE', `${label} inventory is incomplete or paginated. No deployment is allowed without a complete inventory.`);
  }
  return output.value;
}

export function policyValue(output) {
  const policies = collectionItems(output, 'Policy');
  if (policies.length !== 1 || typeof policies[0].properties?.value !== 'string') {
    throw new ApimSafetyError('APIM_POLICY_UNREADABLE', 'Expected one readable APIM policy. Review the service in Azure portal.');
  }
  return policies[0].properties.value;
}

export function fingerprint(value) {
  const canonical = item => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function assertCompatibleGlobalPolicy(value) {
  // Deliberately conservative: custom inherited policies require an owner review,
  // not a heuristic that might bypass authentication, routing, or logging.
  let normalized = value.replace(/^\uFEFF/, '').replace(/<\?xml[^?]*\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/'/g, '"').replace(/\s+/g, '');
  for (const section of ['inbound', 'outbound', 'on-error']) {
    normalized = normalized.replace(`<${section}/>`, `<${section}></${section}>`);
  }
  const passThrough = /^<policies><inbound>(?:<base\/>)?<\/inbound><backend><forward-request(?:buffer-response="(?:false|true)")?\/><\/backend><outbound>(?:<base\/>)?<\/outbound>(?:<on-error>(?:<base\/>)?<\/on-error>)?<\/policies>$/;
  if (!passThrough.test(normalized)) {
    throw new ApimSafetyError('APIM_POLICY_REVIEW_REQUIRED',
      'Existing APIM has custom or deny-all global policies. Automatic reuse supports only a pass-through baseline. Ask the service owner to review integration, or choose a new APIM; do not remove existing protections.');
  }
}

export function assertInheritedOperationPolicies(output) {
  const policies = collectionItems(output, 'Operation policy');
  if (policies.length === 0) return;
  const value = policyValue(output).replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, '');
  if (value !== '<policies><inbound><base/></inbound><backend><base/></backend><outbound><base/></outbound><on-error><base/></on-error></policies>') {
    throw new ApimSafetyError('APIM_OPERATION_POLICY_REVIEW_REQUIRED',
      'An existing operation overrides or customizes inherited API policies. Reconcile it before provisioning; parent API authentication and staging deny must not be bypassed.');
  }
}

export function assertCompatibleService(service, config) {
  if (service?.id?.toLowerCase() !== serviceResourceId(config).toLowerCase()
    || service.provisioningState !== 'Succeeded'
    || !['Developer', 'Basicv2', 'Standardv2', 'Premium'].includes(service.sku)
    || service.gatewayUrl !== `https://${config.azure.apimName}.azure-api.net`) {
    throw new ApimSafetyError('APIM_SERVICE_INCOMPATIBLE',
      'The APIM target must be the selected, successfully provisioned supported-tier service with its standard HTTPS gateway. Its settings will not be changed.');
  }
  if (config.connectors.some(c => c.auth === 'api-key')
    && (!service.identity?.type?.includes('SystemAssigned') || !service.identity.principalId)) {
    throw new ApimSafetyError('APIM_IDENTITY_REQUIRED',
      'Key Vault-backed connectors require a preconfigured APIM system-assigned identity. An administrator must enable it separately; existing service identity settings are never overwritten.');
  }
  for (const connector of config.connectors.filter(c => c.auth === 'managed-identity')) {
    if (!['SystemAssigned', 'SystemAssigned, UserAssigned'].includes(service.identity?.type)
      || service.identity?.principalId?.toLowerCase() !== connector.managedIdentity.principalId.toLowerCase()
      || service.identity?.tenantId?.toLowerCase() !== config.azure.tenantId.toLowerCase()) {
      throw new ApimSafetyError('APIM_BACKEND_PRINCIPAL_MISMATCH',
        'APIM system identity does not match the reviewed backend principal and tenant. Shared identity settings are never changed; ask the owner to inspect and review a new project if identity changed.');
    }
  }
}

export function assertSafeDiagnostics(output, config = {}) {
  for (const diagnostic of collectionItems(output, 'Diagnostics')) {
    const p = diagnostic.properties;
    if (!p) throw new ApimSafetyError('APIM_DIAGNOSTICS_UNREADABLE', 'Cannot inspect inherited APIM diagnostics.');
    for (const direction of ['frontend', 'backend']) for (const message of ['request', 'response']) {
      const log = p[direction]?.[message];
      if ((log?.body?.bytes ?? 0) !== 0 || (log?.headers?.length ?? 0) !== 0) {
        throw new ApimSafetyError('APIM_DIAGNOSTICS_REVIEW_REQUIRED',
          'Inherited APIM diagnostics capture headers or payloads. The service owner must review logging before reuse; the toolkit will not change shared diagnostics.');
      }
    }
    for (const c of (config.connectors ?? []).filter(c => c.apiKey?.queryParameterName)) {
      for (const direction of ['frontend', 'backend']) {
        const masks = p[direction]?.request?.dataMasking?.queryParams ?? [];
        if (!masks.some(mask => ['Hide', 'Mask'].includes(mask.mode) && mask.value === c.apiKey.queryParameterName)) {
          throw new ApimSafetyError('APIM_QUERY_KEY_LOGGING',
            'Query-string API keys require explicit frontend/backend URL query masking in every inherited diagnostic. Ask the service owner to configure masking; shared diagnostics will not be modified.');
        }
      }
    }
  }
}

export function proxyControlPlaneTransport(properties) {
  const m = properties?.mcpProperties;
  if (!m || typeof m !== 'object' || Array.isArray(m)
    || Object.hasOwn(m, 'transportType') && m.transportType !== 'streamable') {
    throw new ApimSafetyError('APIM_PROXY_MAPPING_MISMATCH', 'Experimental transport must be absent or exactly streamable; absence reports no effective transport.');
  }
  return Object.hasOwn(m, 'transportType')
    ? { requested: 'streamable', status: 'reported', reported: 'streamable' }
    : { requested: 'streamable', status: 'unreported' };
}

export function assertProxyApiMapping(properties, connector, { allowStaged = true, config } = {}) {
  if (connector.mcpProxyVersion === 3) {
    const p = properties, m = p?.mcpProperties;
    const shape = p && Array.isArray(p.protocols) && fingerprint(p.protocols) === fingerprint(['https'])
      && (p.serviceUrl == null || p.serviceUrl === '') && (p.sourceApiId == null || p.sourceApiId === '')
      && (p.toolServerId == null || p.toolServerId === '')
      && (p.mcpTools == null || Array.isArray(p.mcpTools) && p.mcpTools.length === 0)
      && m && !Array.isArray(m) && typeof m === 'object'
      && Object.keys(m).every(key => ['transportType', 'endpoints', 'isFederationRouter', 'federation'].includes(key))
      && m.federation == null && (m.isFederationRouter === undefined || m.isFederationRouter === false);
    const transport = proxyControlPlaneTransport(p);
    const staged = shape && allowStaged && p.subscriptionRequired === true && (p.backendId == null || p.backendId === '')
      && (m.endpoints == null || typeof m.endpoints === 'object' && !Array.isArray(m.endpoints) && Object.keys(m.endpoints).length === 0);
    const active = shape && p.subscriptionRequired === false && config && p.backendId === proxyBackendId(config, connector)
      && m.endpoints != null
      && fingerprint(m.endpoints) === fingerprint(upstreamMcpMapping(connector).mcpProperties.endpoints);
    if (!staged && !active) throw new ApimSafetyError('APIM_PROXY_MAPPING_MISMATCH',
      'Experimental API must retain exact owned backendId, streamable message dictionary and /mcp/ mapping, or an inert unbound staging shell. No alternative readback shape is accepted.');
    return transport;
  }
  if (connector.mcpProxyVersion !== 2) return;
  const p = properties, m = p?.mcpProperties;
  const shape = p && Array.isArray(p.protocols) && p.protocols.length === 1 && p.protocols[0] === 'https'
    && (p.sourceApiId == null || p.sourceApiId === '') && m && typeof m === 'object' && !Array.isArray(m)
    && Object.keys(m).every(key => ['transportType', 'endpoints', 'federation', 'isFederationRouter'].includes(key))
    && m.federation == null && (m.isFederationRouter === undefined || m.isFederationRouter === false);
  const staged = shape && allowStaged && p.subscriptionRequired === true && (p.serviceUrl == null || p.serviceUrl === '')
    && (m.transportType === undefined || m.transportType === 'streamable')
    && (m.endpoints == null || Array.isArray(m.endpoints) && m.endpoints.length === 0);
  const expected = upstreamMcpMapping(connector);
  const active = shape && p.subscriptionRequired === false && p.serviceUrl === expected.serviceUrl
    && m.transportType === 'streamable' && Array.isArray(m.endpoints)
    && fingerprint(m.endpoints) === fingerprint(expected.mcpProperties.endpoints);
  if (!staged && !active) throw new ApimSafetyError('APIM_PROXY_MAPPING_MISMATCH',
    'Owned upstream MCP mapping differs from the reviewed HTTPS base/message endpoint or inert staging contract. Do not overwrite or publish it; preserve history and investigate.');
}

export function assertNoApiCollisions(apis, config, receipt, { verifyMapping = true } = {}) {
  const expected = managedApis(config);
  const owned = new Set(receipt.apiIntents ?? []);
  for (const api of apis) {
    const name = api.name;
    const route = api.properties?.path;
    const match = expected.find(item => item.id.toLowerCase() === name?.toLowerCase());
    if (match) {
      if (!owned.has(match.id) || api.properties.description !== ownerDescription(config)
        || route !== match.id || (api.properties.type ?? api.properties.apiType ?? 'http') !== match.type) {
        throw new ApimSafetyError('APIM_API_COLLISION',
          `API ${match.id} already exists without matching project ownership. Choose a new plugin ID; existing APIs will not be adopted or overwritten.`);
      }
      if (verifyMapping) assertProxyApiMapping(api.properties, match.connector, { config });
    } else if (typeof route === 'string' && route && expected.some(item => {
      const existing = route.toLowerCase().replace(/\/+$/, '');
      const desired = item.id.toLowerCase();
      return desired === existing || desired.startsWith(`${existing}/`) || existing.startsWith(`${desired}/`);
    })) {
      throw new ApimSafetyError('APIM_ROUTE_COLLISION', 'An existing APIM route overlaps a generated route. Choose a different plugin/connector identifier.');
    }
  }
}

export function assertNoNamedValueCollisions(values, config, receipt) {
  for (const c of config.connectors.filter(c => c.auth === 'api-key')) {
    const name = `${gatewayApiId(config, c)}-backend-key`;
    const present = values.find(item => item.name?.toLowerCase() === name.toLowerCase()
      || item.properties?.displayName?.toLowerCase() === name.toLowerCase());
    if (present && (!(receipt.namedValueIntents ?? []).includes(name)
      || present.name !== name || present.properties?.displayName !== name
      || present.properties?.secret !== true
      || present.properties?.keyVault?.secretIdentifier !== c.apiKey.secretIdentifier)) {
      throw new ApimSafetyError('APIM_NAMED_VALUE_COLLISION',
        'A generated named-value identifier already belongs to another configuration. No existing value will be overwritten.');
    }
  }
}
