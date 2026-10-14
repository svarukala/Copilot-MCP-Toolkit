import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareMcpServer, mcpRuntimeConfig } from './mcp-server.js';
import { boundedSnapshot, metadataDigest } from './anonymous-metadata.js';
import { apimMode, keyVaultMode, experimentalProxy, proxyBackendId } from './contract.js';
import { readAzureIdentity, azureIdentityGuard } from './azure-identity.js';
import { runAzureCommand } from './azure.js';
import { requireControl as ensure, writeControl, controlOutput, controlFailure, withControlLock } from './mcp-control.js';

export function resourceChoices(config) {
  const a = config.azure, keyed = config.connectors.some(c => c.auth === 'api-key');
  const applicationAccess = config.connectors.some(c => c.auth === 'managed-identity');
  const experiment = experimentalProxy(config);
  const existingOnly = applicationAccess || experiment;
  const base = `/subscriptions/${a.subscriptionId}/resourceGroups/${a.resourceGroup}`;
  return {
    resourceGroup: { selected: a.resourceGroupMode ?? 'create-if-missing-preserve-existing', id: base, choices: existingOnly ? ['existing'] : ['new', 'existing'] },
    apim: { selected: apimMode(config), id: `${base}/providers/Microsoft.ApiManagement/service/${a.apimName}`, choices: existingOnly ? ['existing'] : ['new', 'existing'] },
    keyVault: keyed ? { selected: keyVaultMode(config), id: `${base}/providers/Microsoft.KeyVault/vaults/${a.keyVaultName}`, choices: experiment ? ['existing'] : ['new', 'existing'] }
      : { selected: 'none', choices: ['none'], reason: 'No backend secret requires Key Vault.' },
    ...(experiment ? { experimentalBackend: {
      profile: config.experimentalProfile, id: `${base}/providers/Microsoft.ApiManagement/service/${a.apimName}/backends/${proxyBackendId(config, config.connectors[0])}`,
      selected: 'new-project-owned', deletion: 'unsupported', forwarding: 'unverified',
    } } : {}),
    permissions: { status: 'unknown-until-requested-action', authority: 'selected-signed-in-user',
      requirements: ['Resource read permissions for exact selected scopes; a denied list never means no resources exist.',
        'Selected new resources require their provider write permissions and deployment permission; reused resources require no service/vault configuration writes.',
        ...(experiment ? ['Exact secret-scoped roleAssignments/read; an existing unconditional Secrets User grant is required. No role or secret mutation is planned.']
          : keyed ? ['Secret-scoped roleAssignments/write for APIM MI; secret population is a separate Key Vault data-plane permission.'] : []),
        ...(applicationAccess ? ['Backend application-role assignment is a separate owner action. Toolkit reads exact service principal/application role metadata; it never grants application access.'] : []),
        'Entra app access is separately controlled by delegated Graph permission and user ownership/role, never inferred application permissions.'] },
    cost: { currencyEstimate: null, status: 'not-quoted', sku: a.sku ?? 'existing-service',
      location: a.location ?? 'existing-resource-location',
      implications: ['New APIM capacity is billable according to selected SKU, region and agreement.',
        ...(keyed ? ['Key Vault operations/storage and any network charges depend on usage.'] : []),
        'Reuse may still add traffic/operations cost. Obtain an Azure Pricing Calculator or tenant quote before approval; no numeric price is fabricated.'] },
    ownership: 'Only newly created intent-bound resources and owned API children are recorded; reused resources never become delete-owned.',
  };
}
export async function prepareResourceSelection(value) {
  const input = boundedSnapshot(value);
  ensure(Object.keys(input).sort().join(',') === 'definition,selection', 'Resource selection requires definition and selection.');
  const definition = input.definition, selection = input.selection;
  ensure(definition.kind !== 'existing-mcp', 'Direct MCP references need no Azure resource selection.');
  ensure(Object.keys(selection).sort().join(',') === 'apim,keyVault,resourceGroup', 'Choose RG, APIM and applicable Key Vault explicitly.');
  const a = definition.azure;
  const group = /^\/subscriptions\/([a-f0-9-]{36})\/resourceGroups\/([^/]+)$/i.exec(selection.resourceGroup.resourceId ?? '');
  ensure(group && group[1].toLowerCase() === a.subscriptionId.toLowerCase(), 'Use an exact resource-group ID in the explicitly selected subscription.');
  const parse = (choice, provider) => {
    ensure(['new', 'existing'].includes(choice.mode) && Object.keys(choice).sort().join(',') === 'mode,resourceId',
      'Each resource choice requires mode new/existing and exact resourceId, not a name guess.');
    const prefix = `${selection.resourceGroup.resourceId}/providers/${provider}/`;
    ensure(choice.resourceId?.toLowerCase().startsWith(prefix.toLowerCase())
      && choice.resourceId.slice(prefix.length) && !choice.resourceId.slice(prefix.length).includes('/'),
    'Cross-resource-group or cross-subscription topology is unsupported here. Choose a compatible vault/APIM in the selected group, or use a separately reviewed external deployment; no resource has been changed.');
    return choice.resourceId.slice(prefix.length);
  };
  ensure(['new', 'existing'].includes(selection.resourceGroup.mode)
    && Object.keys(selection.resourceGroup).sort().join(',') === 'mode,resourceId', 'Choose an explicit resource-group mode.');
  a.resourceGroup = group[2]; a.resourceGroupMode = selection.resourceGroup.mode;
  a.apimName = parse(selection.apim, 'Microsoft.ApiManagement/service'); a.apimMode = selection.apim.mode;
  if (definition.backend.auth === 'api-key') {
    a.keyVaultName = parse(selection.keyVault, 'Microsoft.KeyVault/vaults'); a.keyVaultMode = selection.keyVault.mode;
  } else ensure(Object.keys(selection.keyVault).join(',') === 'mode' && selection.keyVault.mode === 'none', 'Backends without a secret require no Key Vault.');
  const review = await prepareMcpServer(definition);
  const plan = { action: 'mcp-resource-selection', definition: review.input, selection,
    resources: resourceChoices(mcpRuntimeConfig(review.input)), compatibility: 'not-cloud-verified', reviewDigest: review.reviewDigest };
  return { ...plan, approvalToken: `mcp-resources/${metadataDigest(plan)}` };
}
export async function chooseMcpResources(definition, prompt) {
  ensure(definition.kind !== 'existing-mcp', 'Direct MCP references need no Azure resource selection.');
  prompt.output.write('Local resource choice only: no Azure inventory or compatibility is claimed. Reuse can be entered by exact resource ID even if inventory is denied. Account login, inventory and provisioning each need separate review.\n');
  const selection = {};
  for (const [key, label] of [['resourceGroup', 'Resource group'], ['apim', 'API Management'], ['keyVault', 'Key Vault']]) {
    if (key === 'keyVault' && definition.backend.auth !== 'api-key') { selection[key] = { mode: 'none' }; continue; }
    const mode = await prompt.choose(`${label}: reuse existing or create new?`, [
      { value: 'cancel', label: 'Cancel without writing or provisioning' },
      { value: 'existing', label: 'Reuse an exact existing resource ID (manual entry; not yet verified)' },
      ...(definition.backend.auth === 'managed-identity' || definition.schemaVersion === 3 ? [] : [{ value: 'new', label: 'Create new after separate target/resource/cost approval' }]),
    ]);
    if (mode === 'cancel') return { status: 'cancelled' };
    const resourceId = await prompt.ask(`${label} full resource ID in tenant ${definition.azure.tenantId}, subscription ${definition.azure.subscriptionId}`);
    selection[key] = { mode, resourceId };
  }
  return prepareResourceSelection({ definition, selection });
}
export async function planResourceInventory(projectDir) {
  const { readMcpServerProject } = await import('./mcp-lifecycle.js');
  const project = await readMcpServerProject(projectDir);
  ensure(project.review.input.kind !== 'existing-mcp', 'Direct references require no Azure inventory.');
  const config = mcpRuntimeConfig(project.review.input);
  const identity = await readAzureIdentity(config, project.projectDir);
  const plan = { action: 'mcp-resource-inventory', projectDir: project.projectDir, reviewDigest: project.review.reviewDigest, identity,
    subscriptionId: config.azure.subscriptionId, resourceGroup: config.azure.resourceGroup,
    types: ['Microsoft.ApiManagement/service', ...(config.connectors.some(c => c.auth === 'api-key') ? ['Microsoft.KeyVault/vaults'] : [])],
    effects: ['Read resource IDs/names/types/location in this selected group only; no credentials, secret values or name-based adoption.',
      'On denied/unavailable inventory, enter exact existing resource IDs manually; compatibility remains unverified until preflight.'] };
  return { ...plan, approvalToken: identity ? `mcp-inventory/${metadataDigest(plan)}` : null };
}
export async function inspectResourceInventory(projectDir, { approval, allowCloud = false, run = runAzureCommand } = {}) {
  const plan = await planResourceInventory(projectDir);
  ensure(allowCloud === true && approval && approval === plan.approvalToken, 'Explicit selected-account inventory opt-in and exact approval required.');
  return withControlLock(plan.projectDir, async () => {
    ensure((await planResourceInventory(projectDir)).approvalToken === approval, 'Inventory identity/input changed; review again.');
    let result;
    try {
      const config = { azure: { tenantId: plan.identity.target.tenantId, subscriptionId: plan.subscriptionId }, connectors: [] };
      const execution = await azureIdentityGuard(config, plan.projectDir, plan.identity, run);
      const query = `[?${plan.types.map(type => `type == '${type}'`).join(' || ')}].{id:id,name:name,type:type,location:location}`;
      const resources = controlOutput(await run('az', ['resource', 'list', '--subscription', plan.subscriptionId,
        '--resource-group', plan.resourceGroup, '--query', query, '--output', 'json', '--only-show-errors'], execution));
      ensure(Array.isArray(resources) && resources.length <= 1000 && resources.every(r => typeof r.id === 'string'
        && r.id.toLowerCase().startsWith(`/subscriptions/${plan.subscriptionId}/resourcegroups/${plan.resourceGroup}/`.toLowerCase())
        && plan.types.some(type => type.toLowerCase() === r.type?.toLowerCase())), 'Inventory is incomplete or escaped its exact selected scope.');
      result = { status: 'observed-read-only', resources, approval, compatibility: 'not-yet-verified' };
    } catch (error) { result = { ...controlFailure(error, 'resource-inventory'), resources: null, approval }; }
    const reportFile = path.join(plan.projectDir, `resource-inventory-${randomUUID()}.json`);
    await writeControl(reportFile, result, { create: true });
    return { ...result, reportFile };
  });
}
