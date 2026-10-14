import { createHash } from 'node:crypto';

// A known first-party service client is not an operator-owned public discovery client.
export const RESTRICTED_DISCOVERY_CLIENT_ID = 'ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b';

export function apimMode(config) {
  return config.azure?.apimMode ?? 'new';
}

export function keyVaultMode(config) {
  return config.azure?.keyVaultMode ?? apimMode(config);
}

export function createsVault(config) {
  return keyVaultMode(config) === 'new' && (config.connectors ?? []).some(c => c.auth === 'api-key');
}

export const EXPERIMENTAL_PROXY_PROFILE = 'owned-backend-routing-v1';
export const SECRET_USER_ROLE = '4633458b-17de-408a-b874-0445c86b69e6';

export function experimentalProxy(config) {
  return config.experimentalProfile === EXPERIMENTAL_PROXY_PROFILE;
}

export function proxyBackendId(config, connector) {
  return `${gatewayApiId(config, connector)}-upstream`;
}

export function upstreamMcpMapping(connector) {
  if (connector.mcpProxyVersion === undefined) {
    return { serviceUrl: connector.endpoint, mcpProperties: { transportType: 'streamable' } };
  }
  if (connector.mcpProxyVersion === 3) {
    const url = new URL(connector.endpoint);
    if (connector.kind !== 'mcp' || connector.auth !== 'api-key' || !connector.apiKey?.headerName
      || connector.apiKey.queryParameterName || url.port || url.pathname !== '/mcp/'
      || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]+$/.test(url.hostname)
      || connector.endpoint !== `https://${url.hostname}/mcp/`) {
      throw new Error('Experimental proxy requires a canonical HTTPS DNS origin plus exact /mcp/, header API-key only; ports, encoded paths, query and fragment are unsupported.');
    }
    return { backendUrl: url.origin,
      mcpProperties: { transportType: 'streamable', endpoints: { message: { uriTemplate: '/mcp/' } } } };
  }
  if (connector.mcpProxyVersion !== 2 || connector.kind !== 'mcp' || connector.auth !== 'api-key') {
    throw new Error('Explicit MCP proxy mapping version 2 requires an API-key upstream MCP connector.');
  }
  const endpoint = connector.endpoint;
  const url = new URL(endpoint);
  const parts = /^(https:\/\/[^/?#]+)(\/[^?#]*)?$/.exec(endpoint);
  if (!parts || url.username || url.password || /[{}\\\s<>"']/.test(endpoint)
    || /%(?![a-f0-9]{2})/i.test(endpoint) || (parts[2] ?? '/') !== url.pathname) {
    throw new Error('MCP proxy endpoint requires an exact HTTPS origin and encoded path without credentials, query, fragment, substitutions or path normalization.');
  }
  return { serviceUrl: parts[1],
    mcpProperties: { transportType: 'streamable', endpoints: [{ name: 'message', uriTemplate: parts[2] ?? '/' }] } };
}

export function approvalToken(config, phase) {
  requireStandaloneConfig(config);
  return `${config.azure.subscriptionId}/${config.azure.resourceGroup}/${apimMode(config)}/${config.azure.apimName}/${phase}`;
}

export function gatewayApiId(config, connector) {
  if (!config.server?.id || config.plugin) throw new Error('Explicit standalone server identity required.');
  return `mcp-${createHash('sha256').update(config.server.id).digest('hex').slice(0, 12)}`;
}

export function resourceOwnerIdentity(config) {
  if (!config.server?.id || config.plugin) throw new Error('Explicit standalone server identity required.');
  return config.server.id;
}

export function inboundAuthorization(config, connector) {
  requireStandaloneConfig(config);
  return config.inbound;
}

export function requireStandaloneConfig(config) {
  if (!config?.server?.id || config.plugin || config.inbound?.type !== 'entra'
    || !Array.isArray(config.inbound.allowedClientIds) || !config.inbound.allowedClientIds.length) {
    throw new Error('An explicit standalone server and Entra inbound client allowlist are required; consumer defaults are unsupported.');
  }
}

export function needsGateway(connector) {
  return connector.kind === 'rest' || connector.auth === 'api-key';
}

export function needsSso(connector) {
  return needsGateway(connector) || connector.auth === 'entra';
}

export function needsOAuth(connector) {
  return needsSso(connector) || connector.auth === 'oauth';
}

export function connectorUrl(config, connector) {
  if (!needsGateway(connector)) return connector.endpoint;
  if (!config.azure?.apimName) throw new Error('An APIM service name is required.');
  return `https://${config.azure.apimName}.azure-api.net/${gatewayApiId(config, connector)}/mcp`;
}
