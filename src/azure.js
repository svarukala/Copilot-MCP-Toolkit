import { MCP_API_VERSION, APIM_VERSION, DENY_POLICY, requireUuid, checkConfig, tenant, buildPolicy, reviewRestOperations, gatewayTemplate, renderInfrastructure, intendedApiPolicy } from './apim-renderer.js';

export { MCP_API_VERSION, buildPolicy, reviewRestOperations, gatewayTemplate, renderInfrastructure } from './apim-renderer.js';

import { spawn } from 'node:child_process';

import { createHash } from 'node:crypto';

import { access, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';

import path from 'node:path';

import { setTimeout as delay } from 'node:timers/promises';

import { needsGateway, needsSso, apimMode, keyVaultMode, createsVault, gatewayApiId, approvalToken, experimentalProxy, upstreamMcpMapping } from './contract.js';
import { publicAnonymous, publicExposureWarnings } from './apim-public.js';

import { readAzureIdentity, azureIdentityGuard, AzureIdentityError } from './azure-identity.js';

import { assertProjectPath } from './config.js';

import { assertSafeLocation } from './validation.js';

import { createInspectionBudget, inspectionBudget, InspectionError } from './inspection-budget.js';

import { azureDeviceCodeReader } from './azure-device-code.js';

import { cliStage, cliInspectionStep } from './cli-feedback.js';

import { normalizeDeploymentOperationDiagnostic } from './deployment-diagnostic.js';

import { managedIdentityRequests, assertManagedIdentityMetadata, managedIdentityGuidance } from './apim-managed-identity.js';

import { OWNER_TAG, ApimSafetyError, ownerId, deploymentTarget, serviceResourceId, managedApis, collectionItems, policyValue, fingerprint, assertCompatibleGlobalPolicy, assertCompatibleService, assertSafeDiagnostics, assertNoApiCollisions, assertNoNamedValueCollisions, assertInheritedOperationPolicies, assertProxyApiMapping, managedBackends, assertNoBackendCollisions, assertProxyBackend, proxySecretScope, assertExistingProxyGrant } from './apim-safety.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const provisioningErrorCodes = new Set([
  'APIM_BACKEND_COLLISION', 'APIM_PROXY_BACKEND_MISMATCH', 'APIM_SECRET_GRANT_REQUIRED',
  'APIM_PROXY_MAPPING_MISMATCH',
  'APIM_API_COLLISION', 'APIM_API_ID_UNSUPPORTED', 'APIM_AUTH_POLICY_MISMATCH', 'APIM_BASELINE_CHANGED',
  'APIM_DEPLOYMENT_INCOMPLETE', 'APIM_DIAGNOSTICS_REVIEW_REQUIRED', 'APIM_DIAGNOSTICS_UNREADABLE',
  'APIM_GLOBAL_POLICY_CHANGED', 'APIM_IDENTITY_REQUIRED', 'APIM_INVENTORY_INCOMPLETE',
  'APIM_INVENTORY_LIMIT', 'APIM_LEGACY_TOOL_IDS_REQUIRE_REVIEW', 'APIM_NAMED_VALUE_COLLISION',
  'APIM_OPERATION_ID_UNSUPPORTED', 'APIM_OPERATION_POLICY_REVIEW_REQUIRED', 'APIM_OWNED_POLICY_CHANGED',
  'APIM_PAGINATION_INVALID', 'APIM_POLICY_REVIEW_REQUIRED', 'APIM_POLICY_UNREADABLE',
  'APIM_PRESERVATION_FAILED', 'APIM_QUERY_KEY_LOGGING', 'APIM_ROUTE_COLLISION', 'APIM_SERVICE_INCOMPATIBLE',
  'APIM_SERVICE_NOT_OWNED', 'APIM_STAGING_NOT_PROTECTED', 'AZURE_CLI_EXIT', 'AZURE_CLI_LAYOUT_UNSUPPORTED',
  'AZURE_CLI_MFA_REQUIRED', 'AZURE_CLI_NOT_FOUND', 'AZURE_CLI_OUTPUT_LIMIT', 'AZURE_CLI_START_FAILED',
  'AZURE_GROUP_CHECK_FAILED', 'AZURE_INVENTORY_INCOMPLETE', 'AZURE_RESOURCE_ALREADY_EXISTS',
  'KEY_VAULT_INCOMPATIBLE', 'PROVISIONING_LOCKED', 'PROVISIONING_TARGET_CHANGED', 'AZURE_IDENTITY_REQUIRED',
  'ENTRA_INBOUND_PREREQUISITES',
  'AZURE_PERMISSION_DENIED', 'AZURE_RESOURCE_GROUP_SELECTION', 'GRAPH_PREAUTH_SCOPE_UNRESOLVED',
  'AZURE_CLI_TRANSIENT_TRANSPORT', 'AZURE_CLI_CERTIFICATE_FAILED', 'AZURE_CLI_AUTHENTICATION_FAILED', 'AZURE_CLI_ABORTED',
  'AZURE_APIM_ACTIVATION_FAILED',
  'AZURE_INSPECTION_COMMAND_TIMEOUT', 'AZURE_INSPECTION_TIMEOUT', 'AZURE_CLI_TERMINATION_UNCONFIRMED',
  'AZURE_DEVICE_CODE_INVALID', 'AZURE_DEVICE_CODE_NOT_DELIVERED', 'AZURE_DEVICE_CODE_DISPLAY_FAILED',
  'APIM_BACKEND_IDENTITY_CONFIG', 'APIM_BACKEND_PRINCIPAL_MISMATCH',
  'APIM_BACKEND_ROLE_MISMATCH', 'APIM_BACKEND_ASSIGNMENT_REQUIRED',
]);

const json = value => `${JSON.stringify(value, null, 2)}\n`;

export class ProvisioningCommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProvisioningCommandError';
    this.code = code;
  }
}

export function azureCliFailure(code, diagnostic = '') {
  if (/without authenticating through MFA|AADSTS5007[69]\b/i.test(diagnostic)) {
    return new ProvisioningCommandError('AZURE_CLI_MFA_REQUIRED',
      'Azure requires an MFA-authenticated user session. Review mcp-account-plan / mcp-account-switch, complete MFA in the isolated context, then review a fresh phase approval. No authentication bypass or automatic retry was attempted.');
  }
  if (/\b(?:AuthorizationFailed|Authorization_RequestDenied|Forbidden|Insufficient privileges|does not have authorization)\b/i.test(diagnostic)) {
    return new ProvisioningCommandError('AZURE_PERMISSION_DENIED',
      'Permission denied for the selected signed-in user. Ask an administrator to review only the exact action and scope in the saved plan (Azure RBAC for resources, delegated Graph permission and app ownership/Entra role for application changes). No automatic role, consent or application-permission grant was attempted. After approval, reselect the account if needed and obtain a fresh plan.');
  }
  if (/\b(?:CERTIFICATE_VERIFY_FAILED|SSLCertVerificationError)|certificate verify failed|unable to get local issuer certificate|self[- ]signed certificate|certificate has expired|hostname .{0,200}(?:doesn't|does not) match/i.test(diagnostic)) {
    return new ProvisioningCommandError('AZURE_CLI_CERTIFICATE_FAILED',
      'Azure CLI certificate verification failed. No automatic retry or TLS/proxy configuration change was made; ask the network administrator to investigate trust and hostname configuration.');
  }
  if (/\b(?:AuthenticationFailed|InvalidAuthenticationToken|ExpiredAuthenticationToken|Unauthorized)\b|(?:please run|run the command).{0,80}az login|\b(?:HTTP(?:\/[\d.]+)?|status(?:_code)?|response|ERROR)\s*[:=( ]+\s*(?:401|403)\b/i.test(diagnostic)) {
    return new ProvisioningCommandError('AZURE_CLI_AUTHENTICATION_FAILED',
      'Azure CLI authentication failed. No automatic retry was made; review the selected isolated account and obtain fresh approval if sign-in changes.');
  }
  if (/api\.preAuthorizedApplications\.delegatedPermissionIds.{0,160}Permission Id.{0,80}cannot be found in the AppPermissions sets/i.test(diagnostic)) {
    return new ProvisioningCommandError('GRAPH_PREAUTH_SCOPE_UNRESOLVED',
      'Graph could not resolve a preauthorization scope ID. Reconcile exact app readback first; create/read back the scope before a separately approved preauthorize phase. This diagnostic alone does not establish a safe retry.');
  }
  if (/\bActivationFailed\b/.test(diagnostic)) {
    return new ProvisioningCommandError('AZURE_APIM_ACTIVATION_FAILED',
      'Azure reported APIM activation failure. Preserve the failed deployment and inspect the exact service provisioning state and deployment operations with its owner or Azure support. Do not retry creation or delete/recreate the service automatically. Reuse of a separately verified compatible service requires a new reviewed target.');
  }
  if (/(?:^|\n)\s*(?:ERROR:\s*)?\((?:ResourceNotFound|SecretNotFound)\)|"code"\s*:\s*"(?:ResourceNotFound|SecretNotFound)"/.test(diagnostic)) {
    return new ProvisioningCommandError('AZURE_RESOURCE_NOT_FOUND',
      'Azure reported that the exact requested resource was not found. This does not authorize creation or replay; review the selected target and retained history.');
  }
  if (/\[SSL: UNEXPECTED_EOF_WHILE_READING\]|\bSSLEOFError\(\s*8\b|\bConnectionResetError(?:\(\s*(?:10054|104)\b|:\s*\[(?:WinError 10054|Errno 104)\])|\bConnectionAbortedError\(\s*10053\s*,/i.test(diagnostic)
    || /\bRemoteDisconnected\((['"])Remote end closed connection without response\1\)/.test(diagnostic)) {
    return new ProvisioningCommandError('AZURE_CLI_TRANSIENT_TRANSPORT',
      'Azure CLI encountered a recognized TLS EOF, connection reset, Windows connection abort or no-response disconnect. No successful inspection or mutation outcome is established.');
  }
  return new ProvisioningCommandError('AZURE_CLI_EXIT', `Azure CLI failed (exit ${code}); inspect the operation in the Azure portal.`);
}

export function sanitizeProvisioningErrorCode(value) {
  return provisioningErrorCodes.has(value) ? value : undefined;
}

async function rejectLinks(filename) {
  const resolved = await assertProjectPath(filename);
  await assertSafeLocation(path.dirname(resolved), resolved);
}

async function effectiveConfig(config, projectDir) {
  const result = structuredClone(config);
  let receipt;
  await rejectLinks(path.join(projectDir, 'infra', 'provisioning-receipt.json'));
  try { receipt = JSON.parse(await readFile(path.join(projectDir, 'infra', 'provisioning-receipt.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (receipt?.target && fingerprint(receipt.target) !== fingerprint(deploymentTarget(config))) {
    throw new ApimSafetyError('PROVISIONING_TARGET_CHANGED', 'The provisioning receipt belongs to another project, APIM mode, tenant, or Azure target. Use a separate generated project.');
  }
  return result;
}

async function put(projectDir, relative, value) {
  const filename = path.join(projectDir, relative);
  await rejectLinks(filename);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, typeof value === 'string' ? value : json(value), 'utf8');
  return filename;
}

const manual = (id, title, instructions) => ({ id, title, kind: 'manual', instructions });

const command = (id, title, args) => ({ id, title, kind: 'command', command: 'az', args: [...args, '--only-show-errors', '--output', 'json'] });

const appUrl = clientId => `https://graph.microsoft.com/v1.0/applications(appId='${clientId}')`;

const selectApp = 'id,appId,identifierUris,web,api';

function operationDiagnostic(phase, stepId) {
  let resource = 'deployment';
  let operation = 'execute';
  if (stepId === 'check-account') [resource, operation] = ['azure-account', 'inspect'];
  else if (stepId === 'check-new-resources') [resource, operation] = ['azure-resources', 'inspect'];
  else if (stepId === 'check-group') [resource, operation] = ['resource-group', 'inspect'];
  else if (stepId === 'create-group') [resource, operation] = ['resource-group', 'create'];
  else if (/^(?:create|read|merge|verify|check)-app-/.test(stepId)) {
    resource = 'entra-application';
    operation = stepId.startsWith('create-') ? 'create' : stepId.startsWith('merge-') ? 'update'
      : stepId.startsWith('verify-') || stepId.startsWith('check-') ? 'verify' : 'inspect';
  } else if (/^(?:read|create)-principal-/.test(stepId)) {
    resource = 'entra-service-principal';
    operation = stepId.startsWith('create-') ? 'create' : 'inspect';
  } else if (stepId === 'check-service') [resource, operation] = ['apim-service', 'inspect'];
  else if (stepId === 'check-vault') [resource, operation] = ['key-vault', 'inspect'];
  else if (stepId === 'check-diagnostics') [resource, operation] = ['apim-diagnostics', 'inspect'];
  else if (['check-shared-policy', 'check-default-deny'].includes(stepId)) [resource, operation] = ['apim-policy', 'inspect'];
  else if (stepId === 'recheck-shared-policy') [resource, operation] = ['apim-policy', 'verify'];
  else if (stepId === 'check-api-collisions') [resource, operation] = ['apim-api', 'inspect'];
  else if (stepId === 'check-named-value-collisions') [resource, operation] = ['apim-named-value', 'inspect'];
  else if (stepId === 'check-proxy-backends') [resource, operation] = ['apim-backend', 'inspect'];
  else if (stepId === 'check-proxy-grant') [resource, operation] = ['role-assignment', 'verify'];
  else if (stepId === 'snapshot-unrelated-policies') [resource, operation] = ['preservation', 'inspect'];
  else if (stepId === 'verify-preservation') [resource, operation] = ['preservation', 'verify'];
  else if (stepId === 'verify-owned-apis' || stepId.startsWith('check-staged-')) [resource, operation] = ['apim-api', 'verify'];
  else if (stepId.startsWith('lock-api-')) [resource, operation] = ['apim-api', 'stage'];
  else if (/^(?:validate|deploy)-secret-access$/.test(stepId)) {
    resource = 'role-assignment';
    operation = stepId.startsWith('validate-') ? 'validate' : 'deploy';
  } else if (stepId.startsWith('validate-')) [resource, operation] = ['deployment', 'validate'];
  else if (stepId.startsWith('deploy-')) [resource, operation] = ['deployment', 'deploy'];
  return normalizeDeploymentOperationDiagnostic({ kind: 'deployment-operation', phase, resource, operation });
}

const boundedOperationDiagnostic = (phase, resource, operation) =>
  normalizeDeploymentOperationDiagnostic({ kind: 'deployment-operation', phase, resource, operation });

function apimPreflight(config, steps, { foundation = false } = {}) {
  const a = config.azure;
  if (foundation && (apimMode(config) === 'new' || createsVault(config))) {
    steps.push(command('check-new-resources', 'Refuse existing APIM/vault names unless this project owns an interrupted deployment',
      ['resource', 'list', '--subscription', a.subscriptionId, '--query',
        "[?type == 'Microsoft.ApiManagement/service' || type == 'Microsoft.KeyVault/vaults'].{id:id,name:name,type:type,tags:tags}"]));
    steps.push(command('check-group', 'Check whether the resource group already exists without modifying it',
      ['group', 'exists', '--subscription', a.subscriptionId, '--name', a.resourceGroup]));
    if (apimMode(config) === 'new') {
      if (config.connectors.some(c => c.auth === 'api-key') && keyVaultMode(config) === 'existing') {
        steps.push(command('check-vault', 'Verify the exact reused vault without changing its configuration',
          ['keyvault', 'show', '--subscription', a.subscriptionId, '--resource-group', a.resourceGroup,
            '--name', a.keyVaultName, '--query', '{id:id,tenantId:properties.tenantId,rbac:properties.enableRbacAuthorization}']));
      }
      return;
    }
  }
  const base = `https://management.azure.com${serviceResourceId(config)}`;
  steps.push(command('check-service', 'Inspect the existing APIM target, tier, gateway, identity, and ownership',
    ['apim', 'show', '--subscription', a.subscriptionId, '--resource-group', a.resourceGroup, '--name', a.apimName,
      '--query', '{id:id,sku:sku.name,provisioningState:provisioningState,gatewayUrl:gatewayUrl,identity:identity,tags:tags}']));
  steps.push(command(apimMode(config) === 'existing' ? 'check-shared-policy' : 'check-default-deny',
    'Inspect global policy without modifying it',
    ['rest', '--method', 'GET', '--url', `${base}/policies?api-version=${APIM_VERSION}`]));
  steps.push(command('check-diagnostics', 'Refuse inherited header or payload logging before exposing MCP',
    ['rest', '--method', 'GET', '--url', `${base}/diagnostics?api-version=${APIM_VERSION}`]));
  if (config.connectors.some(c => c.auth === 'api-key') && !(foundation && createsVault(config))) {
    steps.push(command('check-vault', 'Check existing Key Vault identity and RBAC mode without reading secret values',
      ['keyvault', 'show', '--subscription', a.subscriptionId, '--resource-group', a.resourceGroup,
        '--name', a.keyVaultName, '--query', a.keyVaultMode === 'new'
          ? '{id:id,tenantId:properties.tenantId,rbac:properties.enableRbacAuthorization,tags:tags}'
          : '{id:id,tenantId:properties.tenantId,rbac:properties.enableRbacAuthorization}']));
  }
  steps.push(command('check-api-collisions', 'Inventory APIs and reject identifier/path collisions or unowned routes',
    ['rest', '--method', 'GET', '--url', `${base}/apis?api-version=${MCP_API_VERSION}`]));
  steps.push(command('check-named-value-collisions', 'Check named-value references only; never retrieve secret values',
    ['rest', '--method', 'GET', '--url', `${base}/namedValues?api-version=${APIM_VERSION}`,
      '--query', '{value:value[].{name:name,properties:{displayName:properties.displayName,secret:properties.secret,keyVault:properties.keyVault}},nextLink:nextLink}']));
}

function backendIdentitySteps(config) {
  return config.connectors.flatMap(c => managedIdentityRequests(c).map(request =>
    command(`check-${request.kind}-${c.id}`, `Verify exact ${request.kind} metadata; never grant backend access`,
      ['rest', '--method', 'GET', '--url', request.url, '--query', request.query])));
}

function experimentalProxySteps(config) {
  if (!experimentalProxy(config)) return [];
  return [
    command('check-proxy-backends', 'Inspect exact backend ownership/mapping and preserve unrelated backends; no adoption',
      ['rest', '--method', 'GET', '--url', `https://management.azure.com${serviceResourceId(config)}/backends?api-version=${MCP_API_VERSION}`]),
    command('check-proxy-grant', 'Verify existing exact secret-scoped grant to the APIM system identity; no role writes',
      ['rest', '--method', 'GET', '--url', `https://management.azure.com${proxySecretScope(config)}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=atScope()`]),
  ];
}

export async function planProvisioning(config, projectDir, { phase = 'foundation', identityProjectDir = projectDir, inspectOnly = false, experimentalConfiguration = false } = {}) {
  projectDir = await assertProjectPath(projectDir);
  config = await effectiveConfig(config, projectDir);
  if (experimentalConfiguration && (!experimentalProxy(config) || !inspectOnly || phase !== 'gateway')) {
    throw new Error('Experimental configuration inspection requires the explicit v3 read-only gateway profile.');
  }
  checkConfig(config);
  if (!['foundation', 'finalize', 'gateway'].includes(phase)) throw new Error('Phase must be foundation, finalize, or gateway.');
  const sso = publicAnonymous(config) ? [] : (config.connectors ?? []).filter(needsSso);
  if (!sso.length && config.connectors.some(c => c.auth === 'oauth')) {
    throw new Error('Direct third-party OAuth needs no Azure provisioning. Record the reviewed portal reference and import external tools/list metadata.');
  }
  const gateway = (config.connectors ?? []).filter(needsGateway);
  const managementIdentityRequired = sso.length > 0 || gateway.length > 0;
  const a = config.azure;
  const steps = [];
  const warnings = ['Azure CLI login is a separate user action. No secrets are requested, logged, or written by this workflow.',
    'Approval authorizes only this phase. Portal registrations, consent, backend authorization, and live endpoint validation remain manual.'];
  if (publicAnonymous(config)) warnings.push(...publicExposureWarnings);
  if (phase === 'foundation') {
    const incomplete = sso.filter(c => !tenant(config, c) || (c.auth === 'entra' && !c.entra?.clientId));
    if (incomplete.length) {
      for (const c of incomplete) steps.push(manual(`configure-existing-${c.id}`, `Configure the existing identity for ${c.displayName}`,
        `Set ${!tenant(config, c) ? 'entra.tenantId to the backend tenant, and ' : ''}${c.auth === 'entra' ? 'entra.clientId to the existing backend resource application' : 'the gateway tenant configuration'} in toolkit.json. The application must expose the configured enabled delegated scope. For an Entra backend, obtain these identifiers from its owner; do not register a replacement frontend app. Then review foundation again. Direct Entra MCP requires no gateway. No OBO token exchange is implemented.`));
      warnings.push('BLOCKED: Complete the identity checkpoint before provisioning. No cloud commands are planned for this phase.');
      return { phase, steps, warnings, azureIdentity: null, approvalToken: null };
    }
  }
  if (sso.length) {
    const tenants = new Set(sso.map(c => requireUuid(tenant(config, c), `${c.id} tenantId`)));
    if (tenants.size !== 1 || (gateway.length && !tenants.has(a.tenantId))) throw new Error('All SSO connectors must use the signed-in Azure tenant for this deployment.');
  }
  if (managementIdentityRequired) {
    steps.push(command('check-account', 'Verify the active Azure identity, subscription, and tenant',
      ['account', 'show', ...(a?.subscriptionId ? ['--subscription', requireUuid(a.subscriptionId, 'subscriptionId')] : []),
        '--query', '{tenantId:tenantId,id:id}']));
  }
  const deploy = (name, title) => {
    const args = ['deployment', 'group', '--subscription', a.subscriptionId, '--resource-group', a.resourceGroup,
      '--name', `cowork-${ownerId(config).slice(0, 12)}-${name}`, '--template-file', path.join(projectDir, 'infra', `${name}.json`)];
    steps.push(command(`validate-${name}`, `Validate ${title}`, [...args.slice(0, 2), 'validate', ...args.slice(2)]));
    steps.push(command(`deploy-${name}`, `Deploy ${title}`, [...args.slice(0, 2), 'create', ...args.slice(2)]));
  };
  if (phase === 'foundation') {
    if (gateway.length) apimPreflight(config, steps, { foundation: true });
    for (const c of sso) {
      steps.push(command(`check-app-${c.id}`, `Verify the explicitly selected inbound application for ${c.displayName}`,
        ['rest', '--method', 'GET', '--url', `${appUrl(c.entra.clientId)}?$select=${selectApp}`]));
      steps.push(manual(`authorization-${c.id}`, 'Review inbound and backend authorization',
        'The existing resource application must expose the selected delegated scope and explicitly preauthorize the selected clients. Application creation, consumer registration, consent and backend permissions are separate owner-approved actions. No consumer is implicitly authorized.'));
    }
    if (gateway.length) {
      if (apimMode(config) === 'new') {
        warnings.push(publicAnonymous(config)
          ? 'BILLABLE: APIM and public traffic incur Azure charges. Developer is non-production. Provisioning can take an hour. New mode creates a dedicated service and refuses unrelated existing resources; this anonymous backend needs no Key Vault.'
          : 'BILLABLE: APIM and Key Vault incur Azure charges. Developer is non-production. Provisioning can take an hour. New mode creates a dedicated service and refuses unrelated existing APIM/vault resources.');
        steps.push(command('create-group', 'Create the resource group only if missing', ['group', 'create', '--subscription', a.subscriptionId,
          '--name', a.resourceGroup, '--location', a.location]));
      } else {
        warnings.push(createsVault(config)
          ? 'Existing APIM/service/global policy/group are preserved. Only the explicitly selected new vault, owned API resources and approved secret grants may change.'
          : 'Existing mode never deploys the APIM service, global policy, resource group, or vault. It requires a compatible pass-through global policy and existing identity/vault configuration. Only project-owned API resources and explicitly approved secret grants may change.');
      }
      if (apimMode(config) === 'new' || createsVault(config)) deploy('foundation', 'selected new resources only; reused service/vault configuration is never deployed');
      if (!experimentalProxy(config) && gateway.some(c => c.auth === 'api-key')) steps.push(manual('set-vault-secrets', 'Securely populate Key Vault in the Azure portal',
        'Use Azure portal > Key Vault > Secrets > Generate/Import. Set each configured versionless secret; never paste key values into this toolkit or CLI arguments. The operator needs secret-write privileges separately. Run gateway only after secrets exist.'));
    }
  } else if (phase === 'finalize') {
    for (const c of sso) {
      requireUuid(c.entra?.clientId, `${c.id} clientId`);
      steps.push(command(`check-app-${c.id}`, `Verify selected inbound authorization for ${c.displayName}`,
        ['rest', '--method', 'GET', '--url', `${appUrl(c.entra.clientId)}?$select=${selectApp}`]));
    }
  } else {
    if (!gateway.length) steps.push(manual('direct-connectors', 'No gateway is required', 'Anonymous and Entra MCP connect directly. Complete Entra registration/finalize, backend token validation, consent, and live testing where applicable.'));
    for (const c of gateway.filter(() => !publicAnonymous(config))) {
      requireUuid(c.entra?.clientId, `${c.id} clientId`);
      if (!c.entra.applicationIdUri) throw new Error(`${c.id}: complete registration and finalize before gateway deployment.`);
      steps.push(command(`check-app-${c.id}`, `Verify finalized resource application for ${c.displayName}`,
        ['rest', '--method', 'GET', '--url', `${appUrl(c.entra.clientId)}?$select=${selectApp}`]));
    }
    if (gateway.length) {
      apimPreflight(config, steps);
      warnings.push(publicAnonymous(config)
        ? 'Gateway approval confirms intentional public exposure, public-data/read-only declarations, aggregate rate limits and the generated owned API/policy changes. No secret, Entra application or delegated consent is required.'
        : 'Gateway approval confirms portal secrets exist, backend audience/consent are ready, and the generated API/policy changes were reviewed. This toolkit does not read secret values.');
      const base = `https://management.azure.com${serviceResourceId(config)}`;
      steps.push(command('snapshot-unrelated-policies', 'Hash unrelated API-level policies for a preservation check (read-only)',
        ['rest', '--method', 'GET', '--url', `${base}/apis?api-version=${MCP_API_VERSION}`]));
      if (apimMode(config) === 'existing') {
        for (const api of managedApis(config)) {
          steps.push(command(`lock-api-${api.id}`, `Apply deny-only staging to an existing project-owned API ${api.id}, if present`,
            ['rest', '--method', 'PUT', '--url', `${base}/apis/${api.id}/policies/policy?api-version=${APIM_VERSION}`,
              '--body', `@${path.join(projectDir, 'infra', 'deny-policy.json')}`]));
        }
        deploy('staging', 'empty, subscription-gated API shells and API-local deny policies; no upstreams or tools');
        for (const api of managedApis(config)) {
          steps.push(command(`check-staged-${api.id}`, `Verify API-local deny policy before attaching any upstream to ${api.id}`,
            ['rest', '--method', 'GET', '--url', `${base}/apis/${api.id}/policies?api-version=${APIM_VERSION}`]));
        }
        steps.push(command('recheck-shared-policy', 'Require unchanged shared global policy before activating project APIs',
          ['rest', '--method', 'GET', '--url', `${base}/policies?api-version=${APIM_VERSION}`]));
      }
      if (!experimentalProxy(config) && gateway.some(c => c.auth === 'api-key')) {
        deploy('secret-access', 'secret-scoped Key Vault Secrets User grants to the APIM system identity');
        warnings.push('RBAC may need several minutes to propagate. If named-value creation fails, preserve the durable attempt and inspect/reconcile exact resource state first. Only settled history permits a fresh reviewed gateway approval; never blindly rerun or broaden the scope.');
      }
      deploy('gateway', 'native APIM APIs, MCP tools, policies, and Key Vault references');
      steps.push(command('verify-owned-apis', 'Verify every deployed project API and its authentication policy',
        ['rest', '--method', 'GET', '--url', `${base}/apis?api-version=${MCP_API_VERSION}`]));
      steps.push(command('verify-preservation', 'Check global policy and unrelated APIs/policies remain unchanged',
        ['rest', '--method', 'GET', '--url', `${base}/apis?api-version=${MCP_API_VERSION}`]));
      steps.push(manual('test-endpoints', 'Validate live endpoints before packaging or distribution',
        publicAnonymous(config)
          ? 'Separately verify anonymous MCP discovery and the selected fixed GET tools, rate-limit behavior, backing REST method/query restrictions and credential stripping. No bearer-rejection gate applies. No live test or backend request is authorized by this deployment.'
          : experimentalProxy(config)
          ? 'Experimental configuration readback is not forwarding proof. Review metadata discovery separately; this gateway approval does not authorize tools/call. No live test or backend request has been performed by this toolkit phase.'
          : 'Verify unauthenticated, wrong tenant/audience/client, and missing-scope tokens fail on BOTH /<id>/mcp and backing /<id>-rest routes. Exercise every selected tool with delegated SSO. Confirm no incoming bearer reaches anonymous/API-key backends, key rotation works, and response-body diagnostics are disabled (0 bytes). No live testing has been performed by this tool.'));
    }
  }
  const backendChecks = backendIdentitySteps(config);
  if (backendChecks.length) {
    // Finalize normally inspects only the caller application; application access also pins the APIM identity.
    if (!steps.some(step => step.id === 'check-service')) {
      steps.push(command('check-service', 'Verify the reviewed APIM system identity without changing service settings',
        ['apim', 'show', '--subscription', a.subscriptionId, '--resource-group', a.resourceGroup, '--name', a.apimName,
          '--query', '{id:id,sku:sku.name,provisioningState:provisioningState,gatewayUrl:gatewayUrl,identity:identity,tags:tags}']));
    }
    // Permission reads must precede any validation/deployment or protected-policy write.
    const firstWrite = steps.findIndex(step => /^(validate-|deploy-|lock-api-)/.test(step.id));
    steps.splice(firstWrite < 0 ? steps.length : firstWrite, 0, ...backendChecks);
    for (const c of config.connectors.filter(c => c.auth === 'managed-identity')) {
      steps.push(manual(`backend-authorization-${c.id}`, 'Separate owner authorization for backend application access',
        managedIdentityGuidance(c).instructions.join(' ')));
    }
    warnings.push('Backend application access requires exact directory role/assignment metadata. The same service/principal/role reads repeat before every API-policy or deployment write and after gateway readback. No role assignment, consent or shared-service change is authorized. Metadata is not effective access or token-claim proof.');
  }
  if (experimentalProxy(config)) {
    if (!steps.some(step => step.id === 'check-service')) apimPreflight(config, steps);
    const firstWrite = steps.findIndex(step => /^(validate-|deploy-|lock-api-)/.test(step.id));
    steps.splice(firstWrite < 0 ? steps.length : firstWrite, 0, ...experimentalProxySteps(config));
    warnings.push('EXPERIMENTAL owned-backend-routing-v1: one new owned backend/API, fixed /mcp/ policy, header key reference only. Existing grant is read-only; no role/secret/Entra writes. Exact ARM readback is not forwarding or runtime qualification; discovery and tools/call remain separately reviewed.');
  }
  // az account show --subscription does not change the default tenant for az rest.
  if (a?.subscriptionId) for (const step of steps) {
    if (step.kind === 'command' && step.args[0] === 'rest') step.args.push('--subscription', a.subscriptionId);
  }
  const azureIdentity = managementIdentityRequired ? await readAzureIdentity(config, identityProjectDir) : null;
  const inspectedSteps = inspectOnly ? steps.filter(s => s.kind === 'command'
    && (['check-account', 'check-new-resources', 'check-group', 'check-service', 'check-vault', 'check-diagnostics',
      'check-shared-policy', 'check-default-deny', 'check-api-collisions', 'check-named-value-collisions',
      'snapshot-unrelated-policies', 'check-proxy-backends', 'check-proxy-grant'].includes(s.id)
      || experimentalConfiguration && ['verify-owned-apis', 'verify-preservation'].includes(s.id)
      || s.id.startsWith('check-app-') || s.id.startsWith('check-backend-'))) : steps;
  const plan = { phase, apimMode: gateway.length ? apimMode(config) : null, steps: inspectedSteps, warnings, azureIdentity,
    ...(experimentalConfiguration ? { evidenceContract: 'experimental-configuration-v1', maximumAgeMs: 900000 } : {}),
    ...(experimentalProxy(config) ? { experimental: {
      profile: config.experimentalProfile, status: 'experimental-not-forwarding-verified',
      backendId: managedBackends(config)[0].id, backendOrigin: upstreamMcpMapping(config.connectors[0]).backendUrl,
      upstreamPath: '/mcp/', publicPath: `/${gatewayApiId(config, config.connectors[0])}/mcp`,
      secretAccess: 'existing-exact-secret-scoped-grant-read-only',
    } } : {}),
    ...(backendChecks.length ? { backendApplicationAccess: {
      targets: config.connectors.filter(c => c.auth === 'managed-identity').map(managedIdentityGuidance),
      recheck: ['before-api-policy-write', 'before-deployment-write', 'after-gateway-readback'],
      requests: steps.filter(step => step.id === 'check-service' || step.id.startsWith('check-backend-')),
    } } : {}),
    ...(inspectOnly ? { inspectOnly: true, inspectionBudget } : {}) };
  if (managementIdentityRequired && !azureIdentity) warnings.push('BLOCKED: Select an explicit Azure account, tenant and subscription with mcp-account-plan / mcp-account-switch. Ambient login is never used.');
  const sources = await Promise.all(config.connectors.filter(c => c.rest).map(async c => ({
    id: c.id, digest: createHash('sha256').update(c.rest.document ? JSON.stringify(c.rest.document) : await readFile(c.rest.openApiPath)).digest('hex'),
  })));
  return { ...plan, approvalToken: managementIdentityRequired && !azureIdentity ? null
    : `${approvalToken(config, phase)}/${fingerprint({ config, projectDir, sources, plan })}` };
}

async function exists(filename) {
  try { await access(filename); return true; } catch { return false; }
}

/** Invoke the Azure CLI without cmd.exe, even when Windows installs only az.cmd. */
export async function resolveAzureCliInvocation(args, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return { command: 'az', args };
  const directories = [...(env.PATH ?? env.Path ?? '').split(';').filter(Boolean),
    ...[env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).map(base => path.join(base, 'Microsoft SDKs', 'Azure', 'CLI2', 'wbin'))];
  for (const directory of directories) {
    const base = directory.replace(/^"|"$/g, '');
    const executable = path.join(base, 'az.exe');
    if (await exists(executable)) return { command: executable, args };
    if (await exists(path.join(base, 'az.cmd'))) {
      // Official MSI layout: wbin\az.cmd delegates to ..\python.exe -m azure.cli.
      const python = path.resolve(base, '..', 'python.exe');
      if (await exists(python)) return { command: python, args: ['-I', '-X', 'utf8', '-m', 'azure.cli', ...args] };
      throw new ProvisioningCommandError('AZURE_CLI_LAYOUT_UNSUPPORTED', 'Found az.cmd without the official bundled python.exe. Install the official Azure CLI MSI; shell execution is deliberately disabled.');
    }
  }
  throw new ProvisioningCommandError('AZURE_CLI_NOT_FOUND', 'Azure CLI is not installed or not on PATH. Install it, then sign in separately.');
}

function retryableInspection(args) {
  const rest = args[0] === 'rest';
  const account = args[0] === 'account' && args[1] === 'show';
  const apim = args[0] === 'apim' && args[1] === 'show';
  if (!rest && !account && !apim) return false;
  const allowed = new Set(['--subscription', '--query', '--output', '--only-show-errors',
    ...(rest ? ['--method', '--url', '--headers'] : apim ? ['--resource-group', '--name'] : [])]);
  const values = new Map();
  for (let i = rest ? 1 : 2; i < args.length; i++) {
    const flag = args[i];
    if (!allowed.has(flag) || values.has(flag)) return false;
    if (flag === '--only-show-errors') { values.set(flag, true); continue; }
    const value = args[++i];
    if (typeof value !== 'string' || !value || value.startsWith('-') || /[\r\n\0]/.test(value)) return false;
    values.set(flag, value);
  }
  if (values.has('--output') && values.get('--output') !== 'json') return false;
  if (rest) {
    if (values.get('--method') !== 'GET' || !values.has('--url')
      || values.has('--headers') && values.get('--headers') !== 'Accept=application/json') return false;
    return /^https:\/\/(?:management\.azure\.com|graph\.microsoft\.com)(?::443)?\/[^\s\\#]*$/.test(values.get('--url'));
  }
  return account || ['--subscription', '--resource-group', '--name'].every(flag => values.has(flag));
}

const azureAbort = () => new ProvisioningCommandError('AZURE_CLI_ABORTED',
  'Azure CLI operation was cancelled. No retry or successful outcome is implied; retain any existing uncertain history.');

export async function runAzureCommand(commandName, args, { cwd, azureConfigDir, signal, boundedInspection = false, onInspectionProcess, onAzureDeviceCode } = {}) {
  if (commandName !== 'az') throw new Error('Only Azure CLI execution is supported.');
  if (signal?.aborted) throw azureAbort();
  const capturedArgs = [...args];
  const deviceCodeLogin = onAzureDeviceCode !== undefined || capturedArgs.includes('--use-device-code');
  if (deviceCodeLogin && !(typeof onAzureDeviceCode === 'function' && azureConfigDir
    && capturedArgs.length === 6 && capturedArgs[0] === 'login' && capturedArgs[1] === '--tenant'
    && uuid.test(capturedArgs[2]) && capturedArgs[3] === '--use-device-code' && capturedArgs[4] === '--output'
    && capturedArgs[5] === 'none')) {
    throw new ProvisioningCommandError('AZURE_DEVICE_CODE_INVALID', 'Device-code display is supported only for exact explicit private-context tenant login.');
  }
  const maximumAttempts = retryableInspection(capturedArgs) ? 3 : 1;
  const invocation = await resolveAzureCliInvocation(capturedArgs);
  const env = { ...process.env, ...(azureConfigDir ? { AZURE_CONFIG_DIR: azureConfigDir,
    AZURE_CORE_ENABLE_BROKER_ON_WINDOWS: 'false', AZURE_CORE_LOGIN_EXPERIENCE_V2: 'off',
    AZURE_CORE_COLLECT_TELEMETRY: 'no' } : {}), ...(deviceCodeLogin ? { AZURE_CORE_NO_COLOR: 'true' } : {}) };
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw azureAbort();
    try { return await runAzureAttempt(invocation, { cwd, env, signal, boundedInspection, onInspectionProcess, onAzureDeviceCode }); }
    catch (error) {
      if (signal?.aborted) throw azureAbort();
      if (error.code !== 'AZURE_CLI_TRANSIENT_TRANSPORT') throw error;
      if (attempt === maximumAttempts) throw new ProvisioningCommandError(error.code,
        `Recognized Azure transport failure after ${attempt} attempt(s); inspection retry budget exhausted or command not retry-eligible. No successful outcome is assumed. Retain existing uncertain history and use reviewed reconciliation; mutations were not retried.`);
      cliStage('azure-retry');
      try { await delay(attempt * 150, undefined, { signal }); }
      catch (error) { if (signal?.aborted) throw azureAbort(); throw error; }
    }
  }
}

function runAzureAttempt(invocation, { cwd, env, signal, boundedInspection, onInspectionProcess, onAzureDeviceCode }) {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.args], { cwd, env: { ...env }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (boundedInspection) onInspectionProcess?.(child.pid);
    let stdout = '';
    let diagnosticTail = '';
    let knownFailure;
    let retryBlocked = false;
    let forcedFailure;
    let bytes = 0;
    const deviceCode = onAzureDeviceCode ? azureDeviceCodeReader(onAzureDeviceCode) : undefined;
    const deviceFailure = error => new ProvisioningCommandError(
      ['AZURE_DEVICE_CODE_INVALID', 'AZURE_DEVICE_CODE_NOT_DELIVERED'].includes(error?.code) ? error.code : 'AZURE_DEVICE_CODE_DISPLAY_FAILED',
      'Azure device-code prompt was missing, unrecognized or could not be displayed safely. No raw output is exposed; review a fresh account login plan.');
    let escalation, finished = false;
    const abort = () => {
      forcedFailure = azureAbort(); child.kill();
      if (boundedInspection && !finished && !escalation) escalation = setTimeout(() => {
        if (!finished) child.kill('SIGKILL');
      }, inspectionBudget.terminationGraceMs / 2);
    };
    const finish = (error, result) => {
      if (finished) return;
      finished = true; clearTimeout(escalation);
      signal?.removeEventListener('abort', abort);
      if (boundedInspection) onInspectionProcess?.(undefined);
      if (error) reject(error); else resolve(result);
    };
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) {
        forcedFailure = new ProvisioningCommandError('AZURE_CLI_OUTPUT_LIMIT', 'Azure CLI output limit exceeded.');
        child.kill();
      }
      else if (!deviceCode) stdout += chunk.toString();
    });
    // Classify only known failures in a bounded window; never relay raw diagnostics.
    child.stderr.on('data', chunk => {
      if (deviceCode && !forcedFailure && !signal?.aborted) {
        try { deviceCode.push(chunk); }
        catch (error) { forcedFailure = deviceFailure(error); child.kill(); }
      }
      diagnosticTail = (diagnosticTail + chunk.toString()).slice(-16384);
      retryBlocked ||= /\b(?:AADSTS\d+|ValidationFailed|BadRequest|InvalidValue|ResourceNotFound|HttpResponseError|HTTPError)\b|"code"\s*:\s*"[^"]+"/i.test(diagnosticTail);
      const failure = azureCliFailure(1, diagnosticTail);
      if (failure.code !== 'AZURE_CLI_EXIT' && (!knownFailure || knownFailure.code === 'AZURE_CLI_TRANSIENT_TRANSPORT'
        || failure.code === 'AZURE_CLI_MFA_REQUIRED')) knownFailure = failure;
    });
    child.on('error', () => {
      const error = forcedFailure ?? new ProvisioningCommandError('AZURE_CLI_START_FAILED', 'Unable to start Azure CLI; install it and sign in separately.');
      if (boundedInspection && child.pid) { forcedFailure = error; return; }
      finish(error);
    });
    child.on('close', (code, terminationSignal) => {
      if (terminationSignal || code === null || [130, 143, 3221225786, -1073741510].includes(code)) forcedFailure ??= azureAbort();
      const failure = retryBlocked && knownFailure?.code === 'AZURE_CLI_TRANSIENT_TRANSPORT'
        ? azureCliFailure(code) : knownFailure ?? azureCliFailure(code);
      if (deviceCode && code === 0 && !forcedFailure) {
        try { deviceCode.finish(); }
        catch (error) { forcedFailure = deviceFailure(error); }
      }
      finish(forcedFailure ?? (code === 0 ? null : failure), { stdout, code });
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function parsedOutput(result) {
  if (typeof result === 'string') return result.trim() ? JSON.parse(result.replace(/^\uFEFF/, '')) : null;
  if (result?.code && result.code !== 0) throw new Error('Command failed.');
  if (result?.stdout !== undefined) return result.stdout.trim() ? JSON.parse(result.stdout.replace(/^\uFEFF/, '')) : null;
  return result;
}

function verifyApplication(application, c, config) {
  if (application?.appId?.toLowerCase() !== c.entra.clientId.toLowerCase()) {
    throw new ProvisioningCommandError('ENTRA_INBOUND_PREREQUISITES',
      'The selected existing inbound application was not returned. Verify the exact client ID and tenant with the application owner; no replacement application is created.');
  }
  const inbound = config.inbound;
  const scope = application.api?.oauth2PermissionScopes?.find(value => value.value === inbound.scope && value.isEnabled === true);
  if (!scope?.id || !application.identifierUris?.includes(inbound.applicationIdUri)
    || !inbound.allowedClientIds.every(id => application.api?.preAuthorizedApplications?.some(client =>
      client.appId?.toLowerCase() === id.toLowerCase() && client.delegatedPermissionIds?.includes(scope.id)))) {
    throw new ProvisioningCommandError('ENTRA_INBOUND_PREREQUISITES',
      'Selected inbound application URI, enabled scope or explicit client preauthorization is missing. Ask its owner to configure it; no implicit consumer or application mutation is allowed.');
  }
}

export async function provisionProject(config, projectDir, options = {}) {
  checkConfig(config);
  projectDir = await assertProjectPath(projectDir);
  const lockPath = path.join(projectDir, '.provisioning.lock');
  await rejectLinks(lockPath);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new ApimSafetyError('PROVISIONING_LOCKED', 'This project has an active or interrupted provisioning lock. Confirm no provisioning process is running before removing .provisioning.lock.');
    throw error;
  }
  const budget = options.inspectOnly ? createInspectionBudget(options.run ?? runAzureCommand, options.signal) : undefined;
  let retainLock = false;
  const retain = async error => {
    retainLock = true;
    await lock.writeFile(json({ status: 'termination-unconfirmed', code: error.code, pid: process.pid,
      ...(error.ownedProcessPid ? { ownedProcessPid: error.ownedProcessPid } : {}),
      at: new Date().toISOString(), recovery: 'Confirm the owned process has stopped before operator lock recovery and a freshly approved read-only inspection. Never automatically remove this lock or replay a gateway.' }));
    await lock.sync();
  };
  try {
    budget?.check();
    const result = await provisionProjectUnlocked(config, projectDir, budget ? { ...options, run: budget.run,
      beforeCommand: async () => { budget.check(); await options.beforeCommand?.(); budget.check(); } } : options);
    if (result.errorCode === 'AZURE_CLI_TERMINATION_UNCONFIRMED') await retain({ code: result.errorCode, ...result.processCleanup });
    if (result.status === 'inspected-not-deployed') budget?.check();
    if (options.inspectOnly && result.status === 'inspected-not-deployed' && options.afterInspection) {
      cliStage('publication');
      budget.check();
      await options.afterInspection(result, budget.check);
      budget.check();
    }
    return result;
  } catch (error) {
    if (error.code === 'AZURE_CLI_TERMINATION_UNCONFIRMED' && !retainLock) await retain(error);
    if (budget) await options.onInspectionFailure?.(error);
    throw error;
  }
  finally { budget?.dispose(); await lock.close(); if (!retainLock) await unlink(lockPath); }
}

async function provisionProjectUnlocked(config, projectDir, { phase = 'foundation', approve, run: execute = runAzureCommand,
  identityProjectDir = projectDir, beforeCommand, inspectOnly = false, experimentalConfiguration = false } = {}) {
  projectDir = await assertProjectPath(projectDir);
  config = await effectiveConfig(config, projectDir);
  const plan = await planProvisioning(config, projectDir, { phase, identityProjectDir, inspectOnly, experimentalConfiguration });
  if (typeof approve !== 'function') throw new Error('An explicit approve(plan) callback is required before any cloud command.');
  if (await approve(structuredClone(plan)) !== true) return { phase, status: 'declined', approved: false, executedSteps: [], manualActions: [], outputs: [] };
  const hasCommands = plan.steps.some(step => step.kind === 'command');
  if (hasCommands && !plan.azureIdentity) throw new Error('Explicit Azure identity selection required before provisioning. Run mcp-account-plan / mcp-account-switch.');
  if (hasCommands && (await planProvisioning(config, projectDir, { phase, identityProjectDir, inspectOnly, experimentalConfiguration })).approvalToken !== plan.approvalToken) {
    throw new Error('Deployment target or reviewed inputs changed after approval. Run plan again.');
  }
  const run = async (name, args) => {
    if (beforeCommand) await beforeCommand();
    if (inspectOnly && !(args[0] === 'account' || args[0] === 'resource' && args[1] === 'list'
      || args[0] === 'group' && args[1] === 'exists' || ['apim', 'keyvault'].includes(args[0]) && args[1] === 'show'
      || args[0] === 'rest' && args[args.indexOf('--method') + 1] === 'GET')) {
      throw new Error('Inspection refuses all mutation and unexpected commands.');
    }
    // Every command (including immediately before each mutation) revalidates the selected profile.
    const execution = await azureIdentityGuard(config, identityProjectDir, plan.azureIdentity, execute);
    if (beforeCommand) await beforeCommand();
    return execute(name, args, { ...execution, cwd: projectDir });
  };
  let receipt;
  const receiptFile = path.join(projectDir, 'infra', 'provisioning-receipt.json');
  try { receipt = JSON.parse(await readFile(receiptFile, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    receipt = { schemaVersion: 1, applications: [], completedSteps: [] };
  }
  if (experimentalConfiguration && (!receipt.preservation?.globalPolicyHash
    || !Array.isArray(receipt.preservation.unrelatedApis) || !Array.isArray(receipt.preservation.unrelatedBackends))) {
    throw new ApimSafetyError('APIM_PRESERVATION_FAILED', 'Original retained API/backend/global preservation snapshots are required; a fresh baseline cannot replace them.');
  }
  const result = { phase, status: plan.steps.some(s => s.id.startsWith('configure-existing-')) ? 'blocked-manual-actions' : 'completed-with-manual-actions', approved: true, executedSteps: [], skippedSteps: [], manualActions: plan.steps.filter(s => s.kind === 'manual'), outputs: [], receiptPath: receiptFile };
  if (plan.experimental) result.experimental = plan.experimental;
  if (plan.steps.some(step => step.kind === 'command')) receipt.target ??= deploymentTarget(config);
  let groupExists;
  let apiInventory;
  let globalFingerprint;
  let unrelatedSnapshot;
  let unrelatedBackends;
  let inspectedService;
  const managedIds = new Set(config.connectors?.some(needsGateway) ? managedApis(config).map(api => api.id) : []);
  const completeCollection = async (first, args) => {
    if (!first?.nextLink) return first;
    const original = new URL(args[args.indexOf('--url') + 1]);
    const seen = new Set();
    const values = [];
    let page = first;
    while (true) {
      if (!Array.isArray(page?.value) || values.length + page.value.length > 5000) {
        throw new ApimSafetyError('APIM_INVENTORY_LIMIT', 'APIM inventory exceeded its safe limit or returned an invalid page.');
      }
      values.push(...page.value);
      if (!page.nextLink) return { value: values };
      const next = new URL(page.nextLink);
      if (next.origin !== original.origin || next.pathname !== original.pathname
        || next.username || next.password || next.hash || seen.has(next.href) || seen.size >= 50) {
        throw new ApimSafetyError('APIM_PAGINATION_INVALID', 'APIM pagination left the selected collection, repeated a page, or exceeded its safe limit.');
      }
      seen.add(next.href);
      const nextArgs = [...args];
      nextArgs[nextArgs.indexOf('--url') + 1] = next.href;
      page = parsedOutput(await run('az', nextArgs, { cwd: projectDir }));
    }
  };
  const fetchCollection = async suffix => {
    const version = suffix === 'apis' || suffix === 'backends' || suffix.endsWith('/tools') ? MCP_API_VERSION : APIM_VERSION;
    const args = ['rest', '--method', 'GET', '--url', `https://management.azure.com${serviceResourceId(config)}/${suffix}?api-version=${version}`,
      '--headers', 'Accept=application/json', '--subscription', config.azure.subscriptionId,
      '--only-show-errors', '--output', 'json'];
    if (suffix === 'namedValues') args.push('--query',
      '{value:value[].{name:name,properties:{displayName:properties.displayName,secret:properties.secret,keyVault:properties.keyVault}},nextLink:nextLink}');
    return completeCollection(parsedOutput(await run('az', args, { cwd: projectDir })), args);
  };
  const fetchExactApi = async apiId => {
    const id = `${serviceResourceId(config)}/apis/${apiId}`;
    const actual = parsedOutput(await run('az', ['rest', '--method', 'GET', '--url',
      `https://management.azure.com${id}?api-version=${MCP_API_VERSION}`, '--headers', 'Accept=application/json',
      '--subscription', config.azure.subscriptionId, '--only-show-errors', '--output', 'json'], { cwd: projectDir }));
    if (actual?.id?.toLowerCase() !== id.toLowerCase() || actual.name !== apiId || !actual.properties) {
      throw new ApimSafetyError('APIM_PROXY_MAPPING_MISMATCH', 'Exact proxy-related API readback returned a different or unreadable resource.');
    }
    return actual;
  };
  const inspectProxyBackends = async (output, { required = false } = {}) => {
    const inventory = collectionItems(output, 'Backend'), backends = [], names = new Set();
    if (inventory.length > 5000) throw new ApimSafetyError('APIM_INVENTORY_LIMIT', 'Backend inventory exceeds the bounded limit.');
    for (const item of inventory) {
      if (typeof item.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(item.name) || names.has(item.name.toLowerCase())) {
        throw new ApimSafetyError('APIM_PROXY_BACKEND_MISMATCH', 'Backend inventory has an invalid or duplicate identifier.');
      }
      names.add(item.name.toLowerCase());
      const id = `${serviceResourceId(config)}/backends/${item.name}`;
      const actual = parsedOutput(await run('az', ['rest', '--method', 'GET', '--url',
        `https://management.azure.com${id}?api-version=${MCP_API_VERSION}`, '--headers', 'Accept=application/json',
        '--subscription', config.azure.subscriptionId, '--only-show-errors', '--output', 'json'], { cwd: projectDir }));
      if (actual?.id?.toLowerCase() !== id.toLowerCase() || actual.name !== item.name || !actual.properties) {
        throw new ApimSafetyError('APIM_PROXY_BACKEND_MISMATCH', 'Exact backend GET differs from the selected resource or is unreadable.');
      }
      backends.push(actual);
    }
    assertNoBackendCollisions(backends, config, receipt);
    for (const backend of managedBackends(config)) {
      if (required || apiInventory?.some(api => api.properties.backendId === backend.id)) {
        assertProxyBackend(backends.find(item => item.name === backend.id), config, backend.connector);
      }
    }
    const owned = new Set(managedBackends(config).map(item => item.id));
    const snapshot = backends.filter(item => !owned.has(item.name)).map(item => ({
      name: item.name, properties: fingerprint(item.properties),
    })).sort((a, b) => a.name.localeCompare(b.name));
    const retained = receipt.preservation?.unrelatedBackends;
    if (unrelatedBackends && fingerprint(snapshot) !== fingerprint(unrelatedBackends)
      || retained && fingerprint(snapshot) !== fingerprint(retained)) {
      throw new ApimSafetyError('APIM_PRESERVATION_FAILED', 'Unrelated backend inventory/settings changed. Preserve state; no rollback or deletion was attempted.');
    }
    unrelatedBackends = snapshot;
  };
  const recheckExperimental = async ({ active = false } = {}) => {
    if (!experimentalProxy(config)) return;
    apiInventory = await inspectedApis(await fetchCollection('apis'));
    for (const api of managedApis(config)) {
      const actual = apiInventory.find(item => item.name === api.id);
      if (active) result.controlPlaneTransport = assertProxyApiMapping(actual?.properties, api.connector, { config, allowStaged: false });
      if (actual) await inspectOwnedApi(api, actual, { active });
    }
    const serviceStep = plan.steps.find(step => step.id === 'check-service');
    inspectedService = parsedOutput(await run(serviceStep.command, serviceStep.args, { cwd: projectDir }));
    assertCompatibleService(inspectedService, config);
    const grant = plan.steps.find(step => step.id === 'check-proxy-grant');
    assertExistingProxyGrant(await completeCollection(parsedOutput(await run(grant.command, grant.args, { cwd: projectDir })), grant.args), config, inspectedService);
    await inspectProxyBackends(await fetchCollection('backends'), { required: active });
  };
  const inspectedApis = async output => {
    const apis = collectionItems(output, 'API');
    assertNoApiCollisions(apis, config, receipt, { verifyMapping: false });
    for (const api of managedApis(config).filter(api => api.connector.mcpProxyVersion >= 2)) {
      const index = apis.findIndex(item => item.name?.toLowerCase() === api.id.toLowerCase());
      if (index < 0) continue;
      apis[index] = await fetchExactApi(api.id);
    }
    assertNoApiCollisions(apis, config, receipt);
    return apis;
  };
  const verifyBackendStep = (step, output) => {
    for (const c of config.connectors) for (const request of managedIdentityRequests(c)) {
      if (step.id === `check-${request.kind}-${c.id}`) {
        assertManagedIdentityMetadata(request.kind, output, c);
        return;
      }
    }
    throw new ApimSafetyError('APIM_BACKEND_IDENTITY_CONFIG', 'Unexpected backend identity check.');
  };
  const recheckBackendIdentity = async () => {
    if (!plan.backendApplicationAccess) return;
    for (const step of plan.backendApplicationAccess.requests) {
      const output = await completeCollection(parsedOutput(await run(step.command, step.args)), step.args);
      if (step.id === 'check-service') assertCompatibleService(output, config);
      else verifyBackendStep(step, output);
    }
  };
  const fetchRawApiPolicy = async apiId => {
    const output = parsedOutput(await run('az', ['rest', '--method', 'GET', '--url',
      `https://management.azure.com${serviceResourceId(config)}/apis/${apiId}/policies/policy?api-version=${APIM_VERSION}&format=rawxml`,
      '--headers', 'Accept=application/json', '--subscription', config.azure.subscriptionId,
      '--only-show-errors', '--output', 'json'], { cwd: projectDir }));
    if (output?.properties?.format !== 'rawxml' || typeof output.properties.value !== 'string') {
      throw new ApimSafetyError('APIM_POLICY_UNREADABLE', 'Expected raw XML policy readback for the project API.');
    }
    return output.properties.value;
  };
  const inspectChildren = async api => {
    assertSafeDiagnostics(await fetchCollection(`apis/${api.id}/diagnostics`), config);
    const kind = api.type === 'http' ? 'operations' : 'tools';
    const children = collectionItems(await fetchCollection(`apis/${api.id}/${kind}`), kind);
    if (api.connector.mcpProxyVersion >= 2 && children.length) {
      throw new ApimSafetyError('APIM_PROXY_MAPPING_MISMATCH', 'An upstream proxy must not contain local native tool resources. Preserve them; no automatic removal or overwrite is allowed.');
    }
    if (api.type === 'mcp' && api.connector.kind === 'rest' && children.some(child => /^op-[a-f0-9]{24}$/.test(child.name))) {
      throw new ApimSafetyError('APIM_LEGACY_TOOL_IDS_REQUIRE_REVIEW',
        'This API has legacy service-wide MCP tool IDs. Preserve the deployed tools and use a separately reviewed migration or a new isolated project; automatic renaming would leave duplicate tools.');
    }
    if (api.type === 'http') for (const operation of children) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(operation.name)) {
        throw new ApimSafetyError('APIM_OPERATION_ID_UNSUPPORTED', 'An operation identifier cannot be safely inspected. Review this API before provisioning.');
      }
      assertInheritedOperationPolicies(await fetchCollection(`apis/${api.id}/operations/${operation.name}/policies`));
    }
    return children;
  };
  const snapshotUnrelated = async output => {
    const apis = collectionItems(output, 'API');
    const entries = [];
    for (const api of apis.filter(api => !managedIds.has(api.name)).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!/^[A-Za-z0-9_.;=-]+$/.test(api.name)) throw new ApimSafetyError('APIM_API_ID_UNSUPPORTED', 'An existing API identifier cannot be safely inspected. Review the service before provisioning.');
      const policies = collectionItems(await fetchCollection(`apis/${encodeURIComponent(api.name)}/policies`), 'API policy');
      const properties = config.connectors.some(c => c.mcpProxyVersion >= 2)
        && (api.properties?.type ?? api.properties?.apiType) === 'mcp'
        ? (await fetchExactApi(api.name)).properties : api.properties;
      entries.push({ name: api.name, api: fingerprint(properties), policies: fingerprint(policies) });
    }
    return entries;
  };
  const inspectOwnedApi = async (api, actual, { active = false } = {}) => {
    const children = await inspectChildren(api);
    const policies = await fetchCollection(`apis/${api.id}/policies`);
    const emptyShell = apimMode(config) === 'existing' && actual.properties.subscriptionRequired === true
      && !actual.properties.serviceUrl && !actual.properties.sourceApiId
      && (api.connector.mcpProxyVersion !== 3 || !actual.properties.backendId)
      && !actual.properties.mcpProperties?.endpoints?.length && children.length === 0;
    if (collectionItems(policies, 'API policy').length === 0 && emptyShell && !active) return;
    policyValue(policies);
    const value = await fetchRawApiPolicy(api.id);
    const intended = await intendedApiPolicy(config, api);
    if (!(active ? [intended] : [DENY_POLICY, intended]).some(policy => policy.replace(/\s+/g, '') === value.replace(/\s+/g, ''))) {
      throw new ApimSafetyError('APIM_OWNED_POLICY_CHANGED', 'A project API policy changed outside the toolkit. Reconcile it before provisioning; it will not be overwritten.');
    }
  };
  for (const step of plan.steps.filter(s => s.kind === 'command')) {
    if (inspectOnly) cliInspectionStep(step.id);
    let currentOperationDiagnostic = operationDiagnostic(phase, step.id);
    try {
      const args = [...step.args];
      if (step.id === 'create-group' && groupExists === true) {
        result.skippedSteps.push({ id: step.id, reason: 'Existing resource group is preserved.' });
        continue;
      }
      if (step.id.startsWith('lock-api-') && !apiInventory?.some(api => `lock-api-${api.name}` === step.id)) {
        result.skippedSteps.push({ id: step.id, reason: 'API does not exist yet; an empty protected shell will be staged.' });
        continue;
      }
      if (step.id.startsWith('lock-api-') || step.id.startsWith('deploy-')) await recheckBackendIdentity();
      if (step.id.startsWith('lock-api-') || step.id.startsWith('deploy-')) await recheckExperimental();
      if (['deploy-staging', 'deploy-gateway'].includes(step.id)) {
        currentOperationDiagnostic = boundedOperationDiagnostic(phase, 'apim-api', 'inspect');
        const current = await inspectedApis(await fetchCollection('apis'));
        assertNoApiCollisions(current, config, receipt);
        for (const api of managedApis(config).filter(api => api.connector.mcpProxyVersion >= 2
          && current.some(item => item.name === api.id))) await inspectChildren(api);
        currentOperationDiagnostic = boundedOperationDiagnostic(phase, 'apim-named-value', 'inspect');
        const named = collectionItems(await fetchCollection('namedValues'), 'Named value');
        assertNoNamedValueCollisions(named, config, receipt);
        currentOperationDiagnostic = boundedOperationDiagnostic(phase, 'apim-policy', 'verify');
        const livePolicy = policyValue(await fetchCollection('policies'));
        if (fingerprint(livePolicy) !== globalFingerprint) throw new ApimSafetyError('APIM_GLOBAL_POLICY_CHANGED', 'Global policy changed after preflight. No further deployment is allowed.');
        receipt.apiIntents = [...new Set([...(receipt.apiIntents ?? []), ...managedIds])];
        receipt.namedValueIntents = [...new Set([...(receipt.namedValueIntents ?? []),
          ...config.connectors.filter(c => c.auth === 'api-key').map(c => `${gatewayApiId(config, c)}-backend-key`)])];
        if (experimentalProxy(config) && step.id === 'deploy-gateway') {
          receipt.backendIntents = [...new Set([...(receipt.backendIntents ?? []), ...managedBackends(config).map(item => item.id)])];
        }
        await put(projectDir, path.join('infra', 'provisioning-receipt.json'), receipt);
      }
      if (step.id === 'deploy-foundation') {
        const a = config.azure;
        receipt.newResourceIntents = [...(apimMode(config) === 'new' ? [serviceResourceId(config)] : []),
          ...(createsVault(config)
            ? [`/subscriptions/${a.subscriptionId}/resourceGroups/${a.resourceGroup}/providers/Microsoft.KeyVault/vaults/${a.keyVaultName}`] : [])];
        await put(projectDir, path.join('infra', 'provisioning-receipt.json'), receipt);
      }
      currentOperationDiagnostic = operationDiagnostic(phase, step.id);
      const response = await run(step.command, args, { cwd: projectDir });
      let output;
      if (step.id.startsWith('lock-api-')) {
        if (response?.code && response.code !== 0) throw new Error('Policy write failed.');
        // APIM policy PUT can return raw XML. Verify through the JSON collection instead.
        currentOperationDiagnostic = boundedOperationDiagnostic(phase, 'apim-policy', 'verify');
        output = await fetchCollection(`apis/${step.id.slice('lock-api-'.length)}/policies`);
        if (policyValue(output).replace(/\s+/g, '') !== DENY_POLICY.replace(/\s+/g, '')) {
          throw new ApimSafetyError('APIM_STAGING_NOT_PROTECTED', 'The API deny policy was not persisted. No further deployment is allowed.');
        }
      } else output = parsedOutput(response);
      if (args[0] === 'rest' && args.includes('GET') && output?.nextLink) {
        output = await completeCollection(output, args);
      }
      if (step.id === 'check-account') {
        const expectedTenant = tenant(config, config.connectors.find(needsSso));
        if (output?.tenantId?.toLowerCase() !== expectedTenant.toLowerCase()
          || (config.azure?.subscriptionId && output.id?.toLowerCase() !== config.azure.subscriptionId.toLowerCase())) throw new Error('Azure account/tenant mismatch.');
      } else if (step.id === 'check-new-resources') {
        if (!Array.isArray(output)) throw new ApimSafetyError('AZURE_INVENTORY_INCOMPLETE', 'Expected a complete Azure resource inventory before creating a new APIM.');
        const a = config.azure;
        const wanted = [...(apimMode(config) === 'new' ? [serviceResourceId(config)] : []),
          ...(createsVault(config)
            ? [`/subscriptions/${a.subscriptionId}/resourceGroups/${a.resourceGroup}/providers/Microsoft.KeyVault/vaults/${a.keyVaultName}`] : [])];
        for (const resource of output) {
          if (!wanted.some(id => id.split('/').at(-1).toLowerCase() === resource.name?.toLowerCase())) continue;
          if (!wanted.some(id => id.toLowerCase() === resource.id?.toLowerCase())
            || resource.tags?.[OWNER_TAG] !== ownerId(config)
            || !(receipt.newResourceIntents ?? []).some(id => id.toLowerCase() === resource.id.toLowerCase())) {
            throw new ApimSafetyError('AZURE_RESOURCE_ALREADY_EXISTS', 'New mode refuses an existing APIM or vault without this project receipt and ownership tag. Choose existing mode or an unused name.');
          }
        }
      } else if (step.id === 'check-group') {
        if (typeof output !== 'boolean') throw new ApimSafetyError('AZURE_GROUP_CHECK_FAILED', 'Could not determine whether the resource group exists.');
        groupExists = output;
        if ((config.azure.resourceGroupMode === 'existing' && !output)
          || (config.azure.resourceGroupMode === 'new' && output && !receipt.completedSteps?.some(s => s.id === 'create-group'))) {
          throw new ApimSafetyError('AZURE_RESOURCE_GROUP_SELECTION', 'The explicitly selected resource-group create/reuse mode does not match readback. Choose the intended existing group or a new unused group and review again; no existing group is adopted by name.');
        }
      } else if (step.id === 'check-service') {
        assertCompatibleService(output, config);
        inspectedService = output;
        if (apimMode(config) === 'new' && (output.tags?.[OWNER_TAG] !== ownerId(config)
          || !receipt.newResourceIntents?.includes(serviceResourceId(config)))) {
          throw new ApimSafetyError('APIM_SERVICE_NOT_OWNED', 'New-mode gateway deployment requires a service created by this project, with matching ownership tag and foundation receipt.');
        }
      } else if (step.id.startsWith('check-backend-')) {
        verifyBackendStep(step, output);
      } else if (step.id === 'check-proxy-backends') {
        await inspectProxyBackends(output);
      } else if (step.id === 'check-proxy-grant') {
        assertExistingProxyGrant(output, config, inspectedService);
      } else if (step.id === 'check-vault') {
        const a = config.azure;
        const expected = `/subscriptions/${a.subscriptionId}/resourceGroups/${a.resourceGroup}/providers/Microsoft.KeyVault/vaults/${a.keyVaultName}`;
        if (output?.id?.toLowerCase() !== expected.toLowerCase() || output.tenantId?.toLowerCase() !== a.tenantId.toLowerCase() || output.rbac !== true) {
          throw new ApimSafetyError('KEY_VAULT_INCOMPATIBLE', 'The configured existing Key Vault must be in the selected resource group/tenant and use Azure RBAC. Vault settings will not be changed.');
        }
        if (a.keyVaultMode === 'new' && (output.tags?.[OWNER_TAG] !== ownerId(config)
          || !receipt.newResourceIntents?.some(id => id.toLowerCase() === expected.toLowerCase()))) {
          throw new ApimSafetyError('KEY_VAULT_INCOMPATIBLE', 'The selected newly created vault lacks the exact saved intent and ownership tag. Inspect the resource; do not adopt or overwrite it.');
        }
      } else if (step.id === 'check-diagnostics') {
        assertSafeDiagnostics(output, config);
      } else if (step.id === 'check-shared-policy' || step.id === 'check-default-deny') {
        const value = policyValue(output);
        if (step.id === 'check-shared-policy') assertCompatibleGlobalPolicy(value);
        else if (value.replace(/\s+/g, '') !== DENY_POLICY.replace(/\s+/g, '')) {
          throw new ApimSafetyError('APIM_BASELINE_CHANGED', 'Default-deny foundation policy is missing or modified. It will not be overwritten.');
        }
        globalFingerprint = fingerprint(value);
      } else if (step.id === 'check-api-collisions') {
        apiInventory = await inspectedApis(output);
        assertNoApiCollisions(apiInventory, config, receipt);
        for (const api of managedApis(config).filter(api => apiInventory.some(item => item.name === api.id))) {
          await inspectOwnedApi(api, apiInventory.find(item => item.name === api.id));
        }
      } else if (step.id === 'check-named-value-collisions') {
        assertNoNamedValueCollisions(collectionItems(output, 'Named value'), config, receipt);
      } else if (step.id === 'snapshot-unrelated-policies') {
        unrelatedSnapshot = await snapshotUnrelated(output);
        if (inspectOnly && receipt.preservation && (receipt.preservation.globalPolicyHash !== globalFingerprint
          || fingerprint(receipt.preservation.unrelatedApis) !== fingerprint(unrelatedSnapshot))) {
          throw new ApimSafetyError('APIM_PRESERVATION_FAILED', 'Readback differs from the retained pre-mutation preservation snapshot. Manual owner investigation is required; no replay is authorized.');
        }
        if (experimentalProxy(config)) await inspectProxyBackends(await fetchCollection('backends'));
        receipt.preservation = { globalPolicyHash: globalFingerprint, unrelatedApis: unrelatedSnapshot,
          ...(experimentalProxy(config) ? { unrelatedBackends } : {}), verified: false };
      } else if (step.id.startsWith('check-staged-')) {
        if (policyValue(output).replace(/\s+/g, '') !== DENY_POLICY.replace(/\s+/g, '')) {
          throw new ApimSafetyError('APIM_STAGING_NOT_PROTECTED', 'Staged API does not have its deny-only policy. No live upstream will be attached.');
        }
        const api = managedApis(config).find(api => step.id === `check-staged-${api.id}`);
        if (api.connector.mcpProxyVersion >= 2) {
          const current = (await inspectedApis(await fetchCollection('apis'))).find(item => item.name === api.id);
          if (!current || current.properties.subscriptionRequired !== true) {
            throw new ApimSafetyError('APIM_PROXY_MAPPING_MISMATCH', 'Expected an inert owned proxy shell before activation.');
          }
        }
        await inspectChildren(api);
      } else if (step.id === 'recheck-shared-policy') {
        if (fingerprint(policyValue(output)) !== globalFingerprint) {
          throw new ApimSafetyError('APIM_GLOBAL_POLICY_CHANGED', 'Shared global policy changed during staging. Activation has been stopped.');
        }
      } else if (step.id === 'verify-owned-apis') {
        const deployed = await inspectedApis(output);
        assertNoApiCollisions(deployed, config, receipt);
        for (const api of managedApis(config)) {
          const actual = deployed.find(item => item.name === api.id);
          if (!actual || actual.properties.subscriptionRequired !== false) {
            throw new ApimSafetyError('APIM_DEPLOYMENT_INCOMPLETE', 'A deployed project API is missing or remains staged. Do not publish its connector.');
          }
          const transport = assertProxyApiMapping(actual.properties, api.connector, { allowStaged: false, config });
          if (experimentalProxy(config)) result.controlPlaneTransport = transport;
          const policy = await fetchRawApiPolicy(api.id);
          const intended = await intendedApiPolicy(config, api);
          if (policy.replace(/\s+/g, '') !== intended.replace(/\s+/g, '')) {
            throw new ApimSafetyError('APIM_AUTH_POLICY_MISMATCH', 'A deployed project API does not have the reviewed authentication policy. Do not publish its connector.');
          }
          await inspectChildren(api);
        }
        if (experimentalProxy(config)) {
          await recheckExperimental({ active: true });
          await inspectProxyBackends(await fetchCollection('backends'), { required: true });
          const named = collectionItems(await fetchCollection('namedValues'), 'Named value');
          assertNoNamedValueCollisions(named, config, receipt);
          if (!named.some(value => value.name === `${gatewayApiId(config, config.connectors[0])}-backend-key`)) {
            throw new ApimSafetyError('APIM_DEPLOYMENT_INCOMPLETE', 'Experimental activation requires the owned Key Vault-reference named value.');
          }
        }
      } else if (step.id === 'verify-preservation') {
        if (experimentalProxy(config)) await inspectProxyBackends(await fetchCollection('backends'), { required: true });
        const after = await snapshotUnrelated(output);
        if (fingerprint(after) !== fingerprint(unrelatedSnapshot)
          || fingerprint(policyValue(await fetchCollection('policies'))) !== globalFingerprint) {
          throw new ApimSafetyError('APIM_PRESERVATION_FAILED', 'Unrelated API metadata/policies or the global policy changed during deployment. No automatic rollback or deletion was attempted; inspect concurrent activity.');
        }
        receipt.preservation.verified = true;
      } else if (step.id.startsWith('check-app-')) {
        const c = config.connectors.find(c => `check-app-${c.id}` === step.id);
        verifyApplication(output, c, config);
      }
      if (step.id === 'verify-owned-apis') await recheckBackendIdentity();
      result.executedSteps.push(step.id);
      receipt.completedSteps.push({ phase, id: step.id, at: new Date().toISOString() });
      if (!inspectOnly) await put(projectDir, path.join('infra', 'provisioning-receipt.json'), receipt);
    } catch (error) {
      result.status = 'failed';
      result.failedStep = step.id;
      result.operationDiagnostic = currentOperationDiagnostic;
      result.error = `Step ${step.id} failed. No further commands were run. Check the nonsecret receipt, configured tenant/app prerequisites, and Azure portal; CLI response bodies are intentionally not logged.`;
      if (error instanceof ProvisioningCommandError || error instanceof ApimSafetyError || error instanceof AzureIdentityError || error instanceof InspectionError) {
        result.error = error.message;
        result.errorCode = error.code;
      }
      if (error.code === 'AZURE_CLI_TERMINATION_UNCONFIRMED') result.processCleanup = {
        status: 'termination-unconfirmed', ...(error.ownedProcessPid ? { ownedProcessPid: error.ownedProcessPid } : {}),
      };
      receipt.lastAttempt = { phase, status: 'failed', failedStep: step.id,
        operationDiagnostic: result.operationDiagnostic,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}), at: new Date().toISOString() };
      if (!inspectOnly) await put(projectDir, path.join('infra', 'provisioning-receipt.json'), receipt);
      return result;
    }
  }
  receipt.lastPhase = { phase, status: result.status, at: new Date().toISOString() };
  receipt.lastAttempt = { ...receipt.lastPhase };
  if (!inspectOnly) await put(projectDir, path.join('infra', 'provisioning-receipt.json'), receipt);
  if (inspectOnly) {
    result.status = 'inspected-not-deployed';
    result.observationDigest = fingerprint({ target: receipt.target, globalFingerprint, unrelatedSnapshot,
      ...(experimentalProxy(config) ? { unrelatedBackends } : {}),
      ...(experimentalConfiguration ? { controlPlaneTransport: result.controlPlaneTransport } : {}),
      executedSteps: result.executedSteps });
  }
  result.configUpdates = result.outputs.map(app => ({ connectorId: app.connectorId, entra: { clientId: app.clientId } }));
  return result;
}
