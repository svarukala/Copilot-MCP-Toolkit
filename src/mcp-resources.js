import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareMcpServer, mcpRuntimeConfig } from './mcp-server.js';
import { boundedSnapshot, metadataDigest } from './anonymous-metadata.js';
import { apimMode, keyVaultMode, experimentalProxy, proxyBackendId } from './contract.js';
import { readAzureIdentity, azureIdentityGuard } from './azure-identity.js';
import { runAzureCommand } from './azure.js';
import { requireControl as ensure, writeControl, controlOutput, controlFailure, withControlLock } from './mcp-control.js';
import { azureSchema } from './config.js';

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
function resourceModes(definition, key) {
  if (key === 'keyVault' && definition.backend.auth !== 'api-key') return ['none'];
  return definition.backend.auth === 'managed-identity' || definition.schemaVersion === 3 ? ['existing'] : ['existing', 'new'];
}
export async function promptMcpResourceModes(definition, prompt) {
  ensure(definition.kind !== 'existing-mcp', 'Direct MCP references need no Azure resource selection.');
  prompt.output.write('First choose which Azure resources to use. Nothing is created or checked in Azure yet.\n');
  const modes = {};
  for (const [key, label] of [['apim', 'APIM service'], ['keyVault', 'Key Vault'], ['resourceGroup', 'resource group']]) {
    const allowed = resourceModes(definition, key);
    if (allowed[0] === 'none') {
      modes[key] = 'none';
      prompt.output.write('This setup does not need Key Vault because the backend has no API key.\n');
      continue;
    }
    const mode = await prompt.choose(allowed.includes('new')
      ? `Use an existing ${label} or create a new one?`
      : `This setup requires an existing ${label}. Continue?`, [
      { value: 'cancel', label: 'Cancel setup' },
      { value: 'existing', label: 'Use existing' },
      ...(allowed.includes('new') ? [{ value: 'new', label: 'Create new (Azure charges may apply)' }] : []),
    ]);
    if (mode === 'cancel') return { status: 'cancelled' };
    ensure(allowed.includes(mode), 'Choose one of the supported resource options.');
    modes[key] = mode;
  }
  return modes;
}
export async function promptMcpResourceSelection(definition, prompt, { modes } = {}) {
  modes ??= await promptMcpResourceModes(definition, prompt);
  if (modes.status === 'cancelled') return modes;
  ensure(definition.kind !== 'existing-mcp' && Object.keys(modes).sort().join(',') === 'apim,keyVault,resourceGroup'
    && Object.keys(modes).every(key => resourceModes(definition, key).includes(modes[key])), 'Unsupported resource choices.');
  prompt.output.write('For existing resources, copy the full Resource ID from Azure portal > resource > JSON View. Names alone are not enough to identify existing resources.\n');
  const selection = {};
  for (const [key, label, property, provider] of [
    ['resourceGroup', 'resource group', 'resourceGroup', ''],
    ['apim', 'APIM service', 'apimName', 'Microsoft.ApiManagement/service'],
    ['keyVault', 'Key Vault', 'keyVaultName', 'Microsoft.KeyVault/vaults'],
  ]) {
    const mode = modes[key];
    if (mode === 'none') { selection[key] = { mode }; continue; }
    let resourceId;
    if (mode === 'new') {
      const pattern = new RegExp(azureSchema.properties[property].pattern);
      const name = await prompt.ask(`Name for the new ${label}`, {
        check: value => ensure(pattern.test(value), 'Invalid resource name.'),
        hint: `Enter a valid Azure ${label} name, not a URL or Resource ID.`,
      });
      resourceId = key === 'resourceGroup' ? `/subscriptions/${definition.azure.subscriptionId}/resourceGroups/${name}`
        : `${selection.resourceGroup.resourceId}/providers/${provider}/${name}`;
    } else resourceId = await prompt.ask(`Resource ID of the existing ${label}`);
    selection[key] = { mode, resourceId };
  }
  return selection;
}
export async function chooseMcpResources(definition, prompt) {
  const selection = await promptMcpResourceSelection(definition, prompt);
  return selection.status === 'cancelled' ? selection : prepareResourceSelection({ definition, selection });
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
