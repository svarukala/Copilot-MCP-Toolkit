import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { azureSchema, apiKeySchema, operationIdsSchema, validateOpenApiDocument, assertProjectPath, resolveWorkspaceRoot, safeHttpsUrl } from './config.js';
import { boundedSnapshot, savedJson, metadataDigest } from './anonymous-metadata.js';
import { renderInfrastructure } from './apim-renderer.js';
import { gatewayApiId, EXPERIMENTAL_PROXY_PROFILE } from './contract.js';
import { ownerId } from './apim-safety.js';
import { secretIssues } from './validation.js';
import { managedIdentitySchema, checkManagedIdentityConfig, managedIdentityGuidance } from './apim-managed-identity.js';
import { graphOrganizationOperation } from './mcp-graph-organization.js';
import { publicInboundSchema, publicAnonymous, publicExposureWarnings } from './apim-public.js';

export const mcpServerContractVersion = 1;
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const uuid = { type: 'string', format: 'uuid' };
const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const inboundSchema = object({
  type: { const: 'entra' }, tenantId: uuid, clientId: uuid,
  applicationIdUri: { type: 'string', maxLength: 2048, pattern: '^(api|https)://[^\\s<>"\'{}]+$' },
  scope: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_.-]{0,119}$' },
  allowedClientIds: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: uuid },
});
const serverSchema = object({ id: uuid, name: text(100) });
const restInputSchema = object({
  schemaVersion: { const: 1 }, server: serverSchema, azure: azureSchema,
  inbound: { oneOf: [inboundSchema, publicInboundSchema] },
  backend: { ...object({
    endpoint: { type: 'string', maxLength: 2048 }, auth: { enum: ['anonymous', 'api-key', 'entra', 'managed-identity'] },
    apiKey: apiKeySchema,
    managedIdentity: managedIdentitySchema,
  }, ['endpoint', 'auth']),
    if: { properties: { auth: { const: 'managed-identity' } }, required: ['auth'] },
    then: { required: ['managedIdentity'], not: { required: ['apiKey'] } },
    else: { not: { required: ['managedIdentity'] } },
  },
  document: { type: 'object' },
  operationIds: operationIdsSchema,
});
const directInboundSchema = { oneOf: [object({ type: { const: 'anonymous' } }), inboundSchema,
  object({ type: { const: 'oauth' } })] };
const proxyInputSchema = object({
  schemaVersion: { enum: [1, 2] }, kind: { const: 'apim-mcp-proxy' }, server: serverSchema,
  azure: azureSchema, inbound: inboundSchema,
  backend: object({ endpoint: { type: 'string', maxLength: 2048 }, auth: { const: 'api-key' },
    apiKey: apiKeySchema }),
});
const experimentalProxySchema = structuredClone(proxyInputSchema);
experimentalProxySchema.properties.schemaVersion = { const: 3 };
experimentalProxySchema.properties.experimentalProfile = { const: EXPERIMENTAL_PROXY_PROFILE };
experimentalProxySchema.required.push('experimentalProfile');
for (const key of ['apimMode', 'resourceGroupMode', 'keyVaultMode']) {
  experimentalProxySchema.properties.azure.properties[key] = { const: 'existing' };
  if (!experimentalProxySchema.properties.azure.required.includes(key)) experimentalProxySchema.properties.azure.required.push(key);
}
experimentalProxySchema.properties.azure.required.push('keyVaultName');
experimentalProxySchema.properties.backend.properties.endpoint.pattern = '^https://[a-z0-9]+(?:[.-][a-z0-9]+)*\\.[a-z]+/mcp/$';
experimentalProxySchema.properties.backend.properties.apiKey = object({
  secretIdentifier: proxyInputSchema.properties.backend.properties.apiKey.properties.secretIdentifier,
  headerName: proxyInputSchema.properties.backend.properties.apiKey.properties.headerName,
});
const directInputSchema = object({
  schemaVersion: { const: 1 }, kind: { const: 'existing-mcp' }, server: serverSchema,
  endpoint: { type: 'string', maxLength: 2048 }, inbound: directInboundSchema,
});
export const mcpServerInputSchema = { oneOf: [restInputSchema, proxyInputSchema, directInputSchema, experimentalProxySchema] };
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validInput = ajv.compile(mcpServerInputSchema);
const descriptorSchema = object({
  contractVersion: { const: 1 }, kind: { const: 'native-apim-mcp' },
  status: { const: 'generated-not-deployed' }, server: serverSchema,
  endpoint: { type: 'string', maxLength: 2048 }, transport: { const: 'streamable-http' },
  inbound: restInputSchema.properties.inbound, target: azureSchema,
  ownership: object({ ownerId: { type: 'string', pattern: '^[a-f0-9]{24}$' },
    apiId: { type: 'string', pattern: '^mcp-[a-f0-9]{12}$' } }),
  operationIds: restInputSchema.properties.operationIds,
  definitionDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
  descriptorDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
});
const proxyDescriptorSchema = structuredClone(descriptorSchema);
proxyDescriptorSchema.properties.inbound = inboundSchema;
proxyDescriptorSchema.properties.kind = { const: 'apim-mcp-proxy' };
delete proxyDescriptorSchema.properties.operationIds;
proxyDescriptorSchema.required = proxyDescriptorSchema.required.filter(key => key !== 'operationIds');
const directDescriptorSchema = object({
  contractVersion: { const: 1 }, kind: { const: 'existing-mcp' }, status: { const: 'referenced-not-verified' },
  server: serverSchema, endpoint: { type: 'string', maxLength: 2048 }, transport: { const: 'streamable-http' },
  inbound: directInboundSchema, definitionDigest: descriptorSchema.properties.definitionDigest,
  descriptorDigest: descriptorSchema.properties.descriptorDigest,
});
const validDescriptor = ajv.compile({ oneOf: [descriptorSchema, proxyDescriptorSchema, directDescriptorSchema] });
const limits = [
  'Local generation only. This bundle is not deployed, discovered, registered, packaged or runtime-verified.',
  'Library generation performs no cloud execution. Toolkit-local APIM projects have a separately approved CLI lifecycle; direct references require no deployment.',
  'Provisioning templates are review inputs, not an approved az deployment command. Do not bypass ownership or inherited-policy checks.',
  'Entra inbound authorization is explicit. Existing resource application, consent and backend authorization must be reviewed separately.',
  'Entra backend auth means same-token delegated passthrough only; no OBO, token exchange or application permissions.',
  'Tool descriptions and input schemas for consumers require actual tools/list evidence; generated operation maps are not captures.',
];
function requireInput(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { code: 'MCP_DEFINITION_INVALID' });
}
function cleanStrings(value) {
  if (typeof value === 'string') requireInput(!secretIssues(value), 'Possible credential in MCP input; supply nonsecret references only.');
  else if (value && typeof value === 'object') for (const item of Object.values(value)) cleanStrings(item);
}
function checkedInbound(inbound, azure) {
  requireInput(inbound.tenantId.toLowerCase() === azure.tenantId.toLowerCase(), 'Inbound and deployment tenants must match.');
  const uri = new URL(inbound.applicationIdUri);
  requireInput(!uri.username && !uri.password && !uri.search && !uri.hash, 'Inbound application URI must be nonsecret.');
}
export function mcpRuntimeConfig(input) {
  requireInput(input.kind !== 'existing-mcp', 'Existing MCP references have no Azure infrastructure lifecycle.');
  return {
    server: input.server, inbound: input.inbound, azure: input.azure,
    ...(input.schemaVersion === 3 ? { experimentalProfile: input.experimentalProfile } : {}),
    connectors: [{ id: 'server', displayName: input.server.name, description: input.server.name,
      kind: input.kind === 'apim-mcp-proxy' ? 'mcp' : 'rest', ...input.backend,
      ...(input.inbound.type === 'entra' ? { entra: input.inbound } : {}),
      ...(input.kind === 'apim-mcp-proxy' && input.schemaVersion >= 2 ? { mcpProxyVersion: input.schemaVersion } : {}),
      ...(input.kind === 'apim-mcp-proxy' ? {} : { rest: { operationIds: input.operationIds, document: input.document } }) }],
  };
}

/** Pure local compilation, with no file reads, credentials, discovery or cloud calls. */
export async function prepareMcpServer(value) {
  const input = boundedSnapshot(value);
  if (input.kind === 'apim-mcp-proxy' && input.schemaVersion === 1) input.schemaVersion = 2;
  return prepareMcpServerDefinition(input);
}

// Historical readers dispatch on the saved definition version; never upgrade immutable artifacts.
export async function prepareMcpServerDefinition(value) {
  const input = boundedSnapshot(value);
  requireInput(validInput(input), 'Invalid MCP server definition; use the bounded standalone schema, not a plugin config.');
  cleanStrings(input);
  requireInput(!secretIssues(JSON.stringify(input)), 'Possible credential assignment in MCP input; supply nonsecret references only.');
  const direct = input.kind === 'existing-mcp';
  const endpoint = direct ? input.endpoint : input.backend.endpoint;
  safeHttpsUrl(endpoint);
  requireInput(!/[{}\\\r\n]/.test(endpoint), 'Endpoint cannot contain policy substitutions.');
  if (input.inbound.type === 'entra') checkedInbound(input.inbound, direct ? input.inbound : input.azure);
  let resources = {}, config, apiId;
  if (!direct) {
    requireInput((input.backend.auth === 'api-key') === Boolean(input.backend.apiKey), 'Only API-key backends accept Key Vault reference metadata.');
    if (!input.kind) validateOpenApiDocument(input.document, input.operationIds);
    config = mcpRuntimeConfig(input);
    checkManagedIdentityConfig(config, config.connectors[0]);
    resources = await renderInfrastructure(config, { server: input.document });
    apiId = gatewayApiId(config, config.connectors[0]);
  }
  const descriptor = direct ? {
    contractVersion: 1, kind: 'existing-mcp', status: 'referenced-not-verified',
    server: input.server, endpoint, transport: 'streamable-http', inbound: input.inbound,
    definitionDigest: metadataDigest(input),
  } : {
    contractVersion: 1, kind: input.kind ?? 'native-apim-mcp', status: 'generated-not-deployed',
    server: input.server, endpoint: `https://${input.azure.apimName}.azure-api.net/${apiId}/mcp`,
    transport: 'streamable-http', inbound: input.inbound, target: input.azure,
    ownership: { ownerId: ownerId(config), apiId }, ...(!input.kind ? { operationIds: input.operationIds } : {}),
    definitionDigest: metadataDigest(input),
  };
  descriptor.descriptorDigest = metadataDigest(boundedSnapshot(descriptor));
  const files = {
    'mcp-definition.json': savedJson(input), 'mcp-server.json': savedJson(descriptor),
    ...Object.fromEntries(Object.entries(resources).map(([name, contents]) => [`infra/${name}`, savedJson(contents)])),
  };
  requireInput(Object.values(files).reduce((n, bytes) => n + Buffer.byteLength(bytes), 0) <= 8 * 1024 * 1024, 'MCP bundle exceeds 8 MiB.');
  const review = { contractVersion: 1, evidence: 'local-generation-review', input, descriptor, files, limitations: [
    ...(!direct && publicAnonymous(input) ? [...limits.slice(0, 3), ...publicExposureWarnings, limits[5]] : limits),
    ...(input.schemaVersion === 3 ? [
      'EXPERIMENTAL owned-backend-routing-v1: explicit backendId, message dictionary and fixed /mcp/ policy. Preview MCP policy execution and forwarding are NOT qualified by offline generation or ARM readback.',
      'Only existing APIM/group/vault and an existing exact secret-scoped grant are supported. No role, secret or Entra mutations; one new owned backend/API with local policy and Key Vault reference. Discovery and tools/call require separate review.',
    ] : []),
    ...(input.backend?.auth === 'managed-identity' ? [
      'Managed-identity backend application access is distinct from auth: entra. Only an existing APIM system identity and a separate backend application are supported. The incoming user token is deleted before obtaining a backend token; failures stop the pipeline.',
      ...managedIdentityGuidance(config.connectors[0]).instructions,
      ...(!Object.values(input.document.paths).some(item => item.get && graphOrganizationOperation(config.connectors[0], 'get', item.get, item))
        ? ['No controlled application-access fixture or native unannotated tools/call proof is qualified by this bundle. Delegated fixture assertions cannot qualify application access.']
        : ['Only the separate project-only Graph organization fixed GET profile can qualify this mapping after deployment and discovery. Its verdict checks the expected organization ID, not backend token claims. Delegated fixture assertions are not interchangeable.']),
    ] : [])] };
  return { ...review, reviewDigest: metadataDigest(review) };
}

export async function createMcpServerProject(value, options) {
  const { workspaceRoot: root, projectDir: destination, signal } = { ...options };
  requireInput(!signal?.aborted, 'Operation aborted before writing.');
  // Snapshot before any await; the writer only accepts the exact prepared review.
  const supplied = structuredClone(value);
  const review = await prepareMcpServer(supplied.input);
  requireInput(JSON.stringify(supplied) === JSON.stringify(review), 'MCP review changed; prepare and review it again before writing.');
  requireInput(typeof destination === 'string' && path.isAbsolute(destination), 'projectDir must be an explicit absolute path.');
  const workspaceRoot = await resolveWorkspaceRoot(root);
  const projectDir = await assertProjectPath(destination, { workspaceRoot });
  requireInput(!signal?.aborted, 'Operation aborted before writing.');
  await mkdir(path.dirname(projectDir), { recursive: true });
  await mkdir(projectDir, { mode: 0o700 });
  if (review.input.kind !== 'existing-mcp') await mkdir(path.join(projectDir, 'infra'), { mode: 0o700 });
  for (const [name, contents] of Object.entries(review.files)) {
    requireInput(!signal?.aborted, 'Operation aborted; inspect the partial output before retrying in a new directory.');
    const filename = await assertProjectPath(path.join(projectDir, ...name.split('/')), { workspaceRoot });
    await writeFile(filename, contents, { flag: 'wx', mode: 0o600 });
    requireInput(await readFile(filename, 'utf8') === contents, 'MCP bundle readback differs from the reviewed bytes.');
  }
  const direct = review.input.kind === 'existing-mcp';
  requireInput((await readdir(projectDir)).sort().join(',') === (direct ? 'mcp-definition.json,mcp-server.json' : 'infra,mcp-definition.json,mcp-server.json')
    && (direct || (await readdir(path.join(projectDir, 'infra'))).sort().join(',')
      === Object.keys(review.files).filter(name => name.startsWith('infra/')).map(name => name.slice(6)).sort().join(',')),
  'MCP bundle inventory differs from the review.');
  requireInput(!signal?.aborted, 'Operation aborted; inspect the output before retrying in a new directory.');
  return { projectDir, descriptorFile: path.join(projectDir, 'mcp-server.json'),
    definitionFile: path.join(projectDir, 'mcp-definition.json'), reviewDigest: review.reviewDigest,
    status: review.descriptor.status, files: Object.keys(review.files) };
}

export function validateMcpServerDescriptor(value) {
  const descriptor = boundedSnapshot(value);
  requireInput(validDescriptor(descriptor), 'Invalid MCP server descriptor.');
  cleanStrings(descriptor);
  const { descriptorDigest, ...unsigned } = descriptor;
  requireInput(metadataDigest(boundedSnapshot(unsigned)) === descriptorDigest, 'MCP server descriptor digest mismatch.');
  safeHttpsUrl(descriptor.endpoint);
  if (descriptor.kind === 'existing-mcp') {
    if (descriptor.inbound.type === 'entra') checkedInbound(descriptor.inbound, descriptor.inbound);
    return descriptor;
  }
  if (descriptor.inbound.type === 'entra') checkedInbound(descriptor.inbound, descriptor.target);
  const config = { server: descriptor.server, azure: descriptor.target };
  const apiId = gatewayApiId(config, {});
  requireInput(descriptor.endpoint === `https://${descriptor.target.apimName}.azure-api.net/${apiId}/mcp`
    && descriptor.ownership.apiId === apiId && descriptor.ownership.ownerId === ownerId(config), 'MCP descriptor identity or endpoint mismatch.');
  return descriptor;
}
