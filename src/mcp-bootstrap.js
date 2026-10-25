import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { assertProjectPath, withCliWorkspace } from './config.js';
import { boundedSnapshot, metadataDigest, savedJson } from './anonymous-metadata.js';
import { readControl } from './mcp-control.js';
import { writeNewJsonBundle } from './mcp-bundle-write.js';
import { getLibraryInfo } from './machine-contract.js';
import { secretIssues } from './validation.js';
import { RESTRICTED_DISCOVERY_CLIENT_ID } from './contract.js';

const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const uuid = { type: 'string', format: 'uuid' };
const name = { type: 'string', minLength: 3, maxLength: 50, pattern: '^[a-z][a-z0-9-]*[a-z0-9]$' };
const choice = { oneOf: [object({ mode: { const: 'new' }, name }),
  object({ mode: { const: 'existing' }, resourceId: { type: 'string', maxLength: 512, pattern: '^/subscriptions/[A-Za-z0-9/_.()-]+$' } })] };
export const bootstrapSchema = object({
  schemaVersion: { const: 1 }, recipe: { const: 'container-apps-direct-v1' },
  target: object({ tenantId: uuid, subscriptionId: uuid, accountName: { type: 'string', format: 'email', maxLength: 254 },
    location: { type: 'string', pattern: '^[a-z][a-z0-9]{1,39}$' } }),
  resources: object({ resourceGroup: choice, environment: choice, registry: choice,
    vault: choice, pullIdentity: choice, secretIdentity: choice }),
  discoveryClient: { oneOf: [
    object({ mode: { const: 'new' }, displayName: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,79}$' } }),
    object({ mode: { const: 'existing' }, clientId: uuid }),
  ] },
  resourceApplication: object({ displayName: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,79}$' },
    scope: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_.-]{0,119}$' } }),
  review: object({ privateIdentityRequired: { const: true }, newResourceAbsenceMustBeChecked: { const: true } }),
});
const ajv = new Ajv(); addFormats(ajv); const valid = ajv.compile(bootstrapSchema);
const digest = value => metadataDigest(boundedSnapshot(value));
function requireBootstrap(ok, code, message) {
  if (!ok) throw Object.assign(new Error(message), { code: `MCP_BOOTSTRAP_${code}` });
}
export function compileBootstrap(input) {
  input = boundedSnapshot(input);
  requireBootstrap(valid(input) && !secretIssues(savedJson(input)), 'INPUT',
    'Use the closed direct Container Apps bootstrap schema with explicit existing/new choices and no secrets.');
  const { tenantId, subscriptionId, accountName, location } = input.target;
  requireBootstrap(input.discoveryClient.mode !== 'existing'
    || input.discoveryClient.clientId.toLowerCase() !== RESTRICTED_DISCOVERY_CLIENT_ID.toLowerCase(),
  'IDENTITY', 'The enterprise token-store client is not the dedicated public discovery client.');
  const choices = input.resources;
  const prefix = `/subscriptions/${subscriptionId}/resourceGroups/`;
  const group = choices.resourceGroup.mode === 'new' ? choices.resourceGroup.name : choices.resourceGroup.resourceId.slice(prefix.length);
  requireBootstrap(choices.resourceGroup.mode === 'new' || choices.resourceGroup.resourceId.startsWith(prefix)
    && /^[A-Za-z0-9_.()-]+$/.test(group), 'TARGET', 'Existing resource group must be an exact ID in the selected subscription.');
  const types = { environment: 'Microsoft.App/managedEnvironments', registry: 'Microsoft.ContainerRegistry/registries',
    vault: 'Microsoft.KeyVault/vaults', pullIdentity: 'Microsoft.ManagedIdentity/userAssignedIdentities',
    secretIdentity: 'Microsoft.ManagedIdentity/userAssignedIdentities' };
  const ids = { resourceGroup: `${prefix}${group}` }, names = {};
  for (const [key, type] of Object.entries(types)) {
    const c = choices[key];
    ids[key] = c.mode === 'new' ? `${ids.resourceGroup}/providers/${type}/${c.name}` : c.resourceId;
    requireBootstrap(ids[key].startsWith(prefix)
      && new RegExp(`^/subscriptions/[^/]+/resourceGroups/[A-Za-z0-9_.()-]+/providers/${type.replaceAll('.', '\\.')}/[A-Za-z0-9_-]+$`).test(ids[key]),
    'TARGET', 'Every existing resource must have the expected type and selected subscription.');
    names[key] = ids[key].split('/').at(-1);
  }
  requireBootstrap(ids.pullIdentity.toLowerCase() !== ids.secretIdentity.toLowerCase(), 'IDENTITY',
    'Image-pull and secret-reader identities must be distinct.');
  requireBootstrap(/^[a-z0-9]{5,50}$/.test(names.registry)
    && /^[a-z][a-z0-9-]{1,22}[a-z0-9]$/.test(names.vault) && !names.vault.includes('--'),
  'NAME', 'Use valid ACR and Key Vault names; availability is a separate live inspection.');
  const template = { $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
    contentVersion: '1.0.0.0', resources: [] };
  const versions = { environment: '2025-01-01', registry: '2023-07-01', vault: '2023-07-01',
    pullIdentity: '2023-01-31', secretIdentity: '2023-01-31' };
  for (const [key, type] of Object.entries(types)) {
    if (choices[key].mode !== 'new') continue;
    template.resources.push({ type, apiVersion: versions[key], name: names[key], location,
      ...(key === 'registry' ? { sku: { name: 'Basic' }, properties: { adminUserEnabled: false } }
        : key === 'vault' ? { properties: { tenantId, sku: { family: 'A', name: 'standard' },
          enableRbacAuthorization: true, enablePurgeProtection: true, softDeleteRetentionInDays: 90,
          publicNetworkAccess: 'Enabled', accessPolicies: [] } } : { properties: {} }) });
  }
  const target = { tenantId, subscriptionId, accountName };
  const discoveryClientSetup = { target, application: { kind: 'discovery-client', ...input.discoveryClient } };
  const resourceSetup = input.discoveryClient.mode === 'existing' ? { status: 'review-existing-app-setup-command',
    input: { target, application: { mode: 'new', ...input.resourceApplication,
      allowedClientIds: [input.discoveryClient.clientId] } } }
    : { status: 'awaiting-actual-discovery-client-id',
      instruction: 'Create/inspect the dedicated discovery client through existing mcp-app-* phases first. Return its actual clientId as existing in a new bootstrap review; never invent an app ID.' };
  return {
    status: 'operator-bootstrap-not-executed', target: input.target, resourceIds: ids,
    resourceGroupTemplate: choices.resourceGroup.mode === 'new' ? {
      $schema: 'https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json#',
      contentVersion: '1.0.0.0', resources: [{ type: 'Microsoft.Resources/resourceGroups', apiVersion: '2022-09-01', name: group, location }],
    } : null,
    resourceTemplate: template, discoveryClientSetup, resourceSetup,
    permissionIntents: [
      { role: 'AcrPull', scope: ids.registry, identityResourceId: ids.pullIdentity, principalId: null, status: 'requires-actual-principal-readback' },
      { role: 'Key Vault Secrets User', scope: null, vaultResourceId: ids.vault, identityResourceId: ids.secretIdentity,
        principalId: null, status: 'requires-owner-entered-secret-name-and-actual-principal-readback' },
    ],
    stages: [
      'Inspect exact identity, policy, names/absence, region and costs using the selected project-private Azure profile.',
      'Separately review resource-group creation, then the resource template. Existing resources are omitted, never overwritten or adopted by name.',
      'Use mcp-app-init and its separate account/inspect/create/configure phases for the dedicated discovery and resource applications. Do not use replacing setup helpers to migrate an existing app.',
      'Read back actual client/object/scope/principal IDs. Review separate narrow RBAC assignments; vault secret scope is selected only after owner entry.',
      'The owner enters the API key in Key Vault. Review metadata and the exact reference, never read the secret. No role is granted by this bundle.',
      'Generate a new hosting source from real readback values and reviewed imageBuild inputs; review/build/qualify/release separately.',
      'Record dispatch before each external build/deployment. Validate and what-if, deploy once, then observe readiness and authorization rejection before separate discovery/proof.',
    ],
    diagnostics: [
      { check: 'Docker engine via explicit local socket, not ambient CLI context', command: 'mcp-host-plan/run', effects: 'local-only-if-separately-run' },
      { check: 'npm DNS/TLS from host and container', command: 'mcp-host-plan/run', effects: 'network-probe-requires-separate-review', never: 'disable TLS or integrity' },
      { check: 'ACR cloud build alternative', effects: 'paid-cloud-operation-not-authorized-by-local-failure' },
      { check: 'private registry pull', command: 'mcp-host-plan/run', effects: 'separate-private-identity-and-digest-pull-review', never: 'shared docker login or copied credential cache' },
      { check: 'Azure/Graph on Windows', effects: 'reuse toolkit native Azure launcher; do not interpolate Graph URLs through az.cmd' },
    ],
    closeout: ['Inventory exact created resources and grants; preserve evidence, unrelated resources and soft-delete protections.',
      'Propose removal of temporary owner secret-entry permission separately; successful testing does not revoke it or stop billing.'],
    limitations: ['Public Azure direct Container Apps infrastructure only; generated templates are not live API compatibility evidence.',
      'Key Vault network policy is explicitly public-network-enabled with RBAC; review organization policy/private networking before creation.',
      'Directory operations reuse existing guarded commands; actual IDs are pending until readback. No placeholder app IDs, automatic consent or broad rollout.',
      'Diagnostics and private-image pulls use separately reviewed mcp-host-* execution; this bundle does not start Docker, install tools, copy credentials or execute probes.'],
  };
}
async function prepare(options) {
  requireBootstrap(typeof options.config === 'string' && typeof options.output === 'string', 'INPUT',
    'Bootstrap plan/bundle requires config and new output JSON.');
  const input = await readControl(path.resolve(options.config)), result = compileBootstrap(input);
  const outputPath = await assertProjectPath(path.resolve(options.output));
  requireBootstrap(path.extname(outputPath).toLowerCase() === '.json' && (await lstat(path.dirname(outputPath))).isDirectory(),
    'OUTPUT', 'Output must be a new JSON file in an existing directory.');
  try { await lstat(outputPath); requireBootstrap(false, 'OUTPUT', 'Output exists; choose a new path.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const info = await getLibraryInfo();
  const body = { schemaVersion: 1, kind: 'mcp-bootstrap-review', input, result,
    producerBuild: info.contentDigest, executionReadiness: false };
  const bundle = { ...body, contentDigest: digest(body) };
  return { action: 'mcp-bootstrap-bundle', outputPath, bundle,
    approvalToken: `mcp-bootstrap/${digest({ outputPath, bundle })}` };
}
function inWorkspace(options, action) {
  requireBootstrap(typeof options.workspaceRoot === 'string', 'WORKSPACE', 'Explicit private workspace required.');
  return withCliWorkspace(options.workspaceRoot, action);
}
export const planBootstrap = options => inWorkspace(options, () => prepare(options));
export const writeBootstrap = options => inWorkspace(options, () => writeNewJsonBundle(options, prepare, requireBootstrap));
