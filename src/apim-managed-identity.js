import { ApimSafetyError } from './apim-safety.js';
import { graphOrganizationOperation } from './mcp-graph-organization.js';

const uuid = { type: 'string', format: 'uuid' };
export const managedIdentitySchema = {
  type: 'object', additionalProperties: false,
  required: ['type', 'principalId', 'resource', 'servicePrincipalId', 'appRoleId', 'appRole'],
  properties: {
    type: { const: 'system-assigned' }, principalId: uuid, resource: uuid,
    servicePrincipalId: uuid, appRoleId: uuid,
    appRole: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_.-]{0,119}$' },
  },
};
const same = (actual, expected) => typeof actual === 'string' && actual.toLowerCase() === expected.toLowerCase();
const fail = (code, message) => { throw new ApimSafetyError(code, message); };

export function checkManagedIdentityConfig(config, connector) {
  if (connector.auth !== 'managed-identity') {
    if (connector.managedIdentity !== undefined) throw new Error('Managed identity metadata is accepted only for managed-identity backend authentication.');
    return;
  }
  const identity = connector.managedIdentity;
  if (!config.server || config.plugin || config.azure?.apimMode !== 'existing' || connector.kind !== 'rest'
    || connector.apiKey || !identity || identity.type !== 'system-assigned'
    || Object.keys(identity).sort().join(',') !== [...managedIdentitySchema.required].sort().join(',')
    || ['principalId', 'resource', 'servicePrincipalId', 'appRoleId'].some(key =>
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity[key])
        || identity[key] === '00000000-0000-0000-0000-000000000000')
    || !/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(identity.appRole)
    || same(identity.resource, config.inbound?.clientId ?? '')
    || same(identity.principalId, identity.servicePrincipalId)) {
    throw new Error(
      'Application access requires standalone REST on an existing APIM, an exact system-assigned principal, a separate backend application client ID, and one explicit application role. No delegated, key, user-assigned or default-role fallback is supported.');
  }
}

export function managedIdentityRequests(connector) {
  const identity = connector.managedIdentity;
  if (connector.auth !== 'managed-identity') return [];
  const base = 'https://graph.microsoft.com/v1.0/servicePrincipals';
  return [
    { kind: 'backend-principal', url: `${base}/${identity.principalId}?$select=id,appId,servicePrincipalType,accountEnabled`,
      query: '{id:id,appId:appId,servicePrincipalType:servicePrincipalType,accountEnabled:accountEnabled}' },
    { kind: 'backend-application', url: `${base}/${identity.servicePrincipalId}?$select=id,appId,servicePrincipalType,accountEnabled,appRoles`,
      query: '{id:id,appId:appId,servicePrincipalType:servicePrincipalType,accountEnabled:accountEnabled,appRoles:appRoles[].{id:id,value:value,isEnabled:isEnabled,allowedMemberTypes:allowedMemberTypes}}' },
    { kind: 'backend-assignment', url: `${base}/${identity.principalId}/appRoleAssignments?$select=principalId,principalType,resourceId,appRoleId`,
      query: '{value:value[].{principalId:principalId,principalType:principalType,resourceId:resourceId,appRoleId:appRoleId},nextLink:"@odata.nextLink"}' },
  ];
}

export function assertManagedIdentityMetadata(kind, value, connector) {
  const identity = connector.managedIdentity;
  if (kind === 'backend-principal') {
    if (!same(value?.id, identity.principalId) || value.accountEnabled !== true
      || value.servicePrincipalType !== 'ManagedIdentity'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.appId ?? '')) {
      fail('APIM_BACKEND_PRINCIPAL_MISMATCH', 'The selected APIM principal must be an enabled managed-identity service principal in the selected tenant. Ask its owner to verify the exact identity; no identity is enabled or replaced.');
    }
  } else if (kind === 'backend-application') {
    const roles = Array.isArray(value?.appRoles) ? value.appRoles.filter(role => same(role?.id, identity.appRoleId)) : [];
    if (!same(value?.id, identity.servicePrincipalId) || !same(value.appId, identity.resource)
      || value.accountEnabled !== true || value.servicePrincipalType !== 'Application'
      || !Array.isArray(roles) || roles.length !== 1 || roles[0].isEnabled !== true
      || roles[0].value !== identity.appRole || !Array.isArray(roles[0].allowedMemberTypes) || !roles[0].allowedMemberTypes.includes('Application')) {
      fail('APIM_BACKEND_ROLE_MISMATCH', 'The exact backend application must expose the reviewed enabled application role. Delegated scopes, default access and disabled roles are not substitutes.');
    }
  } else if (kind === 'backend-assignment') {
    if (!Array.isArray(value?.value) || value.nextLink || value['@odata.nextLink']
      || value.value.filter(role => same(role?.principalId, identity.principalId)
        && role?.principalType === 'ServicePrincipal' && same(role?.resourceId, identity.servicePrincipalId)
        && same(role?.appRoleId, identity.appRoleId)).length !== 1) {
      fail('APIM_BACKEND_ASSIGNMENT_REQUIRED', 'The exact application-role assignment to the APIM system identity is missing or unreadable. A backend/tenant owner must separately authorize setup; this toolkit never grants application permissions. Directory replication and cached tokens may delay changes.');
    }
  } else fail('APIM_BACKEND_IDENTITY_CONFIG', 'Unexpected backend identity metadata request.');
}

export function managedIdentityGuidance(connector) {
  const graph = Object.values(connector.rest?.document?.paths ?? {})
    .some(item => item.get && graphOrganizationOperation(connector, 'get', item.get, item));
  return {
    ...connector.managedIdentity, endpoint: connector.endpoint,
    assignmentMutationSupported: false, effectiveAccessVerified: false,
    instructions: [
      'A service owner must configure the existing APIM system identity separately. Re-enabling identity changes its principal and requires a new immutable project review.',
      'A backend/tenant owner must separately authorize the exact appRoleId assignment from principalId to servicePrincipalId. Do not substitute delegated consent or assign broad directory/Azure roles.',
      'The system identity is shared by the APIM service, not isolated to this project. Policy editors can use its granted backend access; the service/backend owners must accept that trust boundary or select separately owner-provisioned APIM.',
      graph
        ? 'Graph enforces its own authorization and also supports delegated access. This fixed organization profile verifies the MI policy and directory assignment plus the expected response, not backend token claims, delegated-token rejection or exclusive principal/role access.'
        : 'The backend must validate token signature, issuer/tenant, its own audience, the expected managed-identity principal and application role; reject delegated user tokens and unauthorized applications.',
      'The operator needs authorized directory metadata read access (Graph Application.Read.All and a supported directory role). Read failure blocks deployment, not permission expansion.',
      'Metadata is not effective-access proof: assignment replication, managed-identity token caching, backend enforcement and responses need separate approved live qualification.',
    ],
  };
}
