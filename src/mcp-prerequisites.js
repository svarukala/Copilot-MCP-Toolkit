import { readMcpServerProject, readMcpLifecycleAttempts } from './mcp-lifecycle.js';
import { mcpRuntimeConfig } from './mcp-server.js';
import { readAzureIdentity, azureIdentityGuard } from './azure-identity.js';
import { runAzureCommand, sanitizeProvisioningErrorCode } from './azure.js';
import { controlOutput } from './mcp-control.js';
import { serviceResourceId } from './apim-safety.js';
import { boundedSnapshot, metadataDigest, requireMetadata } from './anonymous-metadata.js';
import { managedIdentityRequests, assertManagedIdentityMetadata, managedIdentityGuidance } from './apim-managed-identity.js';

export async function planMcpPrerequisites(projectDir) {
  const project = await readMcpServerProject(projectDir);
  requireMetadata(project.review.descriptor.kind !== 'existing-mcp', 'INVALID_CONFIG');
  const config = mcpRuntimeConfig(project.review.input), serviceId = serviceResourceId(config);
  const key = config.connectors[0].apiKey;
  const applicationAccess = config.connectors[0].auth === 'managed-identity';
  const vaultId = key ? `/subscriptions/${config.azure.subscriptionId}/resourceGroups/${config.azure.resourceGroup}/providers/Microsoft.KeyVault/vaults/${config.azure.keyVaultName}` : undefined;
  const secretScope = key ? `${vaultId}/secrets/${new URL(key.secretIdentifier).pathname.split('/')[2]}` : undefined;
  const value = { schemaVersion: 1, action: 'standalone-mcp-prerequisites', projectDir: project.projectDir,
    reviewDigest: project.review.reviewDigest, historyDigest: metadataDigest(await readMcpLifecycleAttempts(project.projectDir)),
    identity: await readAzureIdentity(config, project.projectDir, { required: true }),
    serviceId, apimMode: config.azure.apimMode ?? 'new', requests: [{ url: `https://management.azure.com${serviceId}?api-version=2024-05-01`,
      query: '{id:id,etag:etag,identity:identity,properties:{provisioningState:properties.provisioningState,customProperties:properties.customProperties}}' },
    ...(key ? [{ url: `https://management.azure.com${vaultId}?api-version=2023-07-01`,
      query: '{id:id,properties:{tenantId:properties.tenantId,enableRbacAuthorization:properties.enableRbacAuthorization}}' },
    { url: `https://management.azure.com${secretScope}?api-version=2023-07-01`,
      query: '{id:id,name:name,type:type,properties:{secretUri:properties.secretUri,attributes:{enabled:properties.attributes.enabled}}}' }] : []),
    ...managedIdentityRequests(config.connectors[0])],
    ...(applicationAccess ? { applicationAccess: managedIdentityGuidance(config.connectors[0]) } : {}),
    ...(key ? { keyVault: { vaultId, secretScope, secretIdentifier: key.secretIdentifier,
      operator: { role: 'Key Vault Secrets Officer', roleDefinitionId: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7',
        scope: vaultId, purpose: 'Separately authorized operator securely populates the secret using the portal. Vault scope permits creation of the named secret; remove temporary broad access after setup.' },
      apim: { role: 'Key Vault Secrets User', roleDefinitionId: '4633458b-17de-408a-b874-0445c86b69e6',
        scope: secretScope, purpose: 'APIM system-assigned principal resolves only this backend secret. The ordinary secret-access phase separately plans this grant.' } } } : {}),
    limitations: ['Metadata reads only; no secret value/listValue, login, consent, role grants or service changes.',
      'The exact ARM secret read inspects existence and enabled-state only. Role assignments, effective permissions, secret value validity and propagation remain unverified. Operator and APIM identities serve different purposes.',
      'Enabling reused-service system identity is a separate shared-resource operation, never an implicit gateway deployment.'] };
  return boundedSnapshot({ ...value, approvalDigest: metadataDigest(boundedSnapshot(value)) });
}

export async function planMcpIdentityPrerequisite(projectDir) {
  const plan = await planMcpPrerequisites(projectDir);
  requireMetadata(plan.apimMode === 'existing', 'INVALID_CONFIG');
  return { schemaVersion: 1, action: 'standalone-mcp-identity-prerequisite',
    status: 'blocked-manual-owner-action', target: plan.serviceId, projectDir: plan.projectDir,
    reviewDigest: plan.reviewDigest, selectedIdentity: plan.identity, mutationSupported: false,
    reason: 'APIM service PATCH conditional-write enforcement is not established. Sending If-Match alone does not prove race safety.',
    instructions: [
      'The service owner must separately authorize and coordinate enabling system-assigned identity; no toolkit command performs the shared-service PATCH.',
      'Preserve all existing user-assigned identities and shared settings. APIM PATCH resets omitted customProperties to defaults: retain the complete current map, including TLS/cipher settings.',
      'Preserve before/after metadata and verify service identity, tenant and all shared settings after the owner operation. Do not replay an uncertain write.',
      'Use mcp-prerequisites-plan then approved mcp-prerequisites metadata readback, followed by a fresh ordinary provisioning plan. Existing-mode deployment still refuses missing system identity.',
    ], concurrencyGuaranteeVerified: false };
}

export async function inspectMcpPrerequisites(projectDir, { approval, allowCloud, run = runAzureCommand } = {}) {
  const plan = await planMcpPrerequisites(projectDir);
  requireMetadata(allowCloud === true && approval === plan.approvalDigest, 'APPROVAL_REQUIRED');
  const config = mcpRuntimeConfig((await readMcpServerProject(projectDir)).review.input);
  const values = [];
  let secretMetadata;
  for (const [index, request] of plan.requests.entries()) {
    requireMetadata((await planMcpPrerequisites(projectDir)).approvalDigest === approval, 'METADATA_MISMATCH');
    const identity = await azureIdentityGuard(config, projectDir, plan.identity, run);
    try {
      values.push(boundedSnapshot(controlOutput(await run('az', ['rest', '--method', 'GET', '--url', request.url,
        '--query', request.query, '--subscription', config.azure.subscriptionId, '--output', 'json', '--only-show-errors'], identity))));
    } catch (error) {
      if (plan.keyVault && index === 2 && error.code !== 'AZURE_CLI_ABORTED') {
        secretMetadata = { id: plan.keyVault.secretScope,
          status: error.code === 'AZURE_RESOURCE_NOT_FOUND' ? 'missing' : 'unreadable' };
        values.push(secretMetadata);
        continue;
      }
      const causeCode = ['AZURE_AUTH_REQUIRED', 'AZURE_COMMAND_TIMEOUT', 'ABORTED', 'LIMIT', 'SENSITIVE_INPUT'].includes(error.code)
        ? error.code : request.kind && sanitizeProvisioningErrorCode(error.code) || 'READ_OR_PARSE_FAILED';
      throw Object.assign(new Error('MCP prerequisite metadata read failed. Inspect the exact reviewed target and current account; no resource was changed.'),
        { code: 'MCP_PREREQUISITE_READ_FAILED', diagnostics: { resource: request.kind ?? ['service', 'vault', 'secret'][index], causeCode } });
    }
    const value = values[index];
    if (index === 0) requireMetadata(value?.id?.toLowerCase() === plan.serviceId.toLowerCase(), 'METADATA_MISMATCH');
    if (request.kind) assertManagedIdentityMetadata(request.kind, value, config.connectors[0]);
    if (plan.keyVault && index === 1) requireMetadata(value?.id?.toLowerCase() === plan.keyVault.vaultId.toLowerCase()
      && value?.properties?.tenantId?.toLowerCase() === config.azure.tenantId.toLowerCase(), 'METADATA_MISMATCH');
    if (plan.keyVault && index === 2) {
      requireMetadata(value?.id?.toLowerCase() === plan.keyVault.secretScope.toLowerCase()
        && value?.name === new URL(plan.keyVault.secretIdentifier).pathname.split('/')[2]
        && value?.type?.toLowerCase() === 'microsoft.keyvault/vaults/secrets'
        && value?.properties?.secretUri === plan.keyVault.secretIdentifier, 'METADATA_MISMATCH');
      const enabled = value.properties.attributes?.enabled;
      secretMetadata = { id: plan.keyVault.secretScope,
        status: enabled === true ? 'enabled' : enabled === false ? 'disabled' : 'unreadable',
        ...(typeof enabled === 'boolean' ? { enabled } : {}) };
    }
  }
  requireMetadata((await planMcpPrerequisites(projectDir)).approvalDigest === approval, 'METADATA_MISMATCH');
  const service = values[0], vault = plan.keyVault ? values[1] : undefined;
  const systemIdentity = ['SystemAssigned', 'SystemAssigned, UserAssigned'].includes(service.identity?.type)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(service.identity?.principalId ?? '')
    && service.identity?.tenantId?.toLowerCase() === config.azure.tenantId.toLowerCase();
  const provisioningState = ['Succeeded', 'Created', 'Activating', 'Updating', 'Failed', 'ActivationFailed', 'Deleting', 'Canceled']
    .includes(service.properties?.provisioningState) ? service.properties.provisioningState : 'unknown';
  const blockers = [...(provisioningState !== 'Succeeded' ? ['service-not-succeeded'] : []),
    ...(!systemIdentity && (vault || plan.applicationAccess) ? ['system-identity-missing-or-invalid'] : []),
    ...(plan.applicationAccess && service.identity?.principalId?.toLowerCase() !== plan.applicationAccess.principalId.toLowerCase()
      ? ['backend-principal-mismatch'] : []),
    ...(vault && vault.properties?.enableRbacAuthorization !== true ? ['vault-rbac-not-enabled'] : []),
    ...(secretMetadata && secretMetadata.status !== 'enabled' ? [`secret-metadata-${secretMetadata.status}`] : [])];
  return { status: blockers.length ? 'blocked-prerequisites' : 'metadata-inspected-not-runtime-qualified', approvalDigest: approval, blockers,
    observedAt: new Date().toISOString(), observationDigest: metadataDigest(values),
    service: { id: service.id, provisioningState,
      systemIdentity, ...(systemIdentity ? { principalId: service.identity.principalId } : {}) },
    ...(vault ? { vault: { id: vault.id, rbacEnabled: vault.properties?.enableRbacAuthorization === true }, roleGuidance: plan.keyVault } : {}),
    ...(secretMetadata ? { secretMetadata } : {}),
    ...(plan.applicationAccess ? { applicationAccess: { ...plan.applicationAccess, directoryMetadataVerified: true } } : {}),
    permissionsVerified: false, secretVerified: false,
    next: !systemIdentity && (vault || plan.applicationAccess) ? 'Ask the service owner to enable system identity separately while preserving user identities and ALL shared settings, especially customProperties. Do not rerun gateway to repair identity.'
      : blockers.length ? 'Ask the resource owner to resolve the reported prerequisite metadata blockers separately. Do not broaden access or retry gateway blindly.'
        : vault ? 'Review operator secret-population access and APIM secret-scoped read access separately; complete normal gateway planning only after prerequisites are ready.'
          : 'Metadata inspection does not verify frontend consent or backend access. Continue only through a fresh normal provisioning plan.' };
}
