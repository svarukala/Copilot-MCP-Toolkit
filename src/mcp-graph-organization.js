export const graphApplicationId = '00000003-0000-0000-c000-000000000000';
export const organizationReadRoleId = '498476ce-e0fe-48b0-b801-37ba7e2685c6';
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...expected].sort().join(',');

// This one fixed mapping is not a general relaxation of facade paths or query names.
export function graphOrganizationOperation(connector, method, operation, pathItem) {
  const identity = connector.managedIdentity, tenant = connector.entra?.tenantId;
  if (connector.auth !== 'managed-identity' || connector.kind !== 'rest'
    || connector.endpoint !== 'https://graph.microsoft.com'
    || identity?.type !== 'system-assigned' || identity.resource !== graphApplicationId
    || identity.appRoleId !== organizationReadRoleId || identity.appRole !== 'Organization.Read.All'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(tenant ?? '')
    || method !== 'get' || pathItem.parameters !== undefined || operation.parameters !== undefined
    || operation.requestBody !== undefined || operation.callbacks !== undefined) return undefined;
  const mapping = operation['x-cowork-backend'];
  const backendPath = `/v1.0/organization/${tenant}`;
  if (!keys(mapping, ['path', 'query', 'parameterNames']) || mapping.path !== backendPath
    || !keys(mapping.query, ['$select']) || mapping.query.$select !== 'id'
    || !keys(mapping.parameterNames, [])) return undefined;
  return { kind: 'graph-organization-v1', organizationId: tenant,
    targetUrl: `https://graph.microsoft.com${backendPath}?$select=id`, backendPath };
}

export function graphOrganizationResponse(value, organizationId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Object.keys(value).every(key => ['id', '@odata.context'].includes(key))
    || value.id !== organizationId || JSON.stringify(value).length > 4096) return false;
  return value['@odata.context'] === undefined || [
    'https://graph.microsoft.com/v1.0/$metadata#organization/$entity',
    'https://graph.microsoft.com/v1.0/$metadata#organization(id)/$entity',
  ].includes(value['@odata.context']);
}
