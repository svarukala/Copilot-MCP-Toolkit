import { RESTRICTED_DISCOVERY_CLIENT_ID } from './contract.js';

import { requireMetadata } from './anonymous-metadata.js';

export const entraDiscoveryLimits = Object.freeze({ authTimeoutMs: 600000, metadataTimeoutMs: 15000 });

export function entraDiscoveryBinding(entra, discoveryClientId) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  requireMetadata(entra && uuid.test(entra.tenantId ?? '') && uuid.test(entra.clientId ?? '')
    && typeof entra.scope === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,119}$/.test(entra.scope), 'AUTH_CONFIG_INVALID');
  requireMetadata(typeof discoveryClientId === 'string' && uuid.test(discoveryClientId)
    && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(discoveryClientId)
    && ![entra.clientId, RESTRICTED_DISCOVERY_CLIENT_ID].some(id => id.toLowerCase() === discoveryClientId.toLowerCase()), 'AUTH_CONFIG_INVALID');
  const audience = entra.applicationIdUri;
  requireMetadata(audience && audience === audience.trim() && !audience.endsWith('/')
    && !/[\s\\%]/.test(audience) && !audience.includes('//', audience.indexOf('://') + 3)
    && entra.scope !== '.default', 'AUTH_CONFIG_INVALID');
  return {
    discoveryClientId: discoveryClientId.toLowerCase(), tenantId: entra.tenantId.toLowerCase(),
    authority: `https://login.microsoftonline.com/${entra.tenantId.toLowerCase()}`,
    scopes: [`${audience}/${entra.scope}`, 'openid', 'profile', 'offline_access'],
  };
}
