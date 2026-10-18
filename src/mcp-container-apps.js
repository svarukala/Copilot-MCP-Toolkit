import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import path from 'node:path';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { TOOLKIT_ROOT, assertProjectPath, validateOpenApiDocument, withCliWorkspace } from './config.js';
import { boundedSnapshot, metadataDigest, savedJson } from './anonymous-metadata.js';
import { readControl } from './mcp-control.js';
import { secretIssues } from './validation.js';
import { getLibraryInfo } from './machine-contract.js';
import { sealRecipeFiles } from './mcp-recipe-artifacts.js';
import { hostingSchemas, gatewaySettings, gatewayInfrastructure, appServiceInfrastructure } from './mcp-hosting-targets.js';
import { runtimeSchema, validateRuntimeConfig, toolDefinitions } from './recipes/container-apps/runtime.js';

const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const uuid = { type: 'string', format: 'uuid' };
const resourceName = { type: 'string', minLength: 1, maxLength: 90, pattern: '^[A-Za-z0-9_-][A-Za-z0-9_.()-]*$' };
const resourceId = type => ({ type: 'string', maxLength: 512,
  pattern: `^/subscriptions/[0-9a-fA-F-]{36}/resourceGroups/[A-Za-z0-9_.()-]+/providers/${type}/[A-Za-z0-9_-]+$` });
export const containerAppsSchema = object({
  schemaVersion: { const: 1 }, recipe: { const: 'container-apps-direct-v1' },
  name: runtimeSchema.properties.name,
  azure: object({
    tenantId: uuid, subscriptionId: uuid, resourceGroup: resourceName,
    location: { type: 'string', pattern: '^[a-z][a-z0-9]{1,39}$' },
    appName: { type: 'string', minLength: 2, maxLength: 32, pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$' },
    environmentResourceId: resourceId('Microsoft.App/managedEnvironments'),
    registry: object({
      server: { type: 'string', pattern: '^[a-z0-9]{5,50}\\.azurecr\\.io$' },
      pullIdentityResourceId: resourceId('Microsoft.ManagedIdentity/userAssignedIdentities'),
    }),
  }),
  authentication: runtimeSchema.properties.authentication,
  backend: object({ origin: runtimeSchema.properties.backendOrigin, auth: { const: 'anonymous' } }),
  document: { type: 'object' },
  operationIds: { type: 'array', minItems: 1, maxItems: 30, uniqueItems: true,
    items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$' } },
  review: object({ readOnlyOperationIds: { type: 'array', minItems: 1, maxItems: 30, uniqueItems: true,
    items: { type: 'string', minLength: 1, maxLength: 80 } } }),
  requestsPerMinute: runtimeSchema.properties.requestsPerMinute,
});
const ajv = new Ajv();
addFormats(ajv);
const validate = ajv.compile(containerAppsSchema);
export const hostingSchema = { oneOf: hostingSchemas(containerAppsSchema) };
const validateHosting = ajv.compile(hostingSchema);
function requireRecipe(ok, message, code = 'INPUT') {
  if (!ok) throw Object.assign(new Error(message), { code: `MCP_CONTAINER_APPS_${code}` });
}

export function compileContainerApps(value) { return compile(value, false); }
export function compileHostingRecipe(value) { return compile(value, true); }
function compile(value, hosting) {
  const input = boundedSnapshot(value);
  requireRecipe((hosting ? validateHosting : validate)(input) && !secretIssues(savedJson(input)),
    'Use mcp-container-apps-schema with explicit nonsecret target/authentication details.');
  requireRecipe(input.authentication.tenantId === input.azure.tenantId, 'Deployment and caller tenants must match.');
  if (input.azure.gateway) {
    requireRecipe(input.azure.gateway.audience !== input.authentication.audience,
      'Use a separate v2 resource application for the gateway identity, not the delegated caller audience.');
    const uri = new URL(input.azure.gateway.applicationIdUri);
    requireRecipe(!uri.username && !uri.password && !uri.search && !uri.hash
      && !/[\\<>"{}]/.test(input.azure.gateway.applicationIdUri) && !input.azure.gateway.applicationIdUri.endsWith('/'),
    'Use the exact nonsecret gateway Application ID URI.');
  }
  for (const id of [input.azure.environmentResourceId, input.azure.planResourceId, input.azure.registry.pullIdentityResourceId].filter(Boolean)) {
    requireRecipe(id.startsWith(`/subscriptions/${input.azure.subscriptionId}/`), 'Existing resources must be in the selected subscription.');
  }
  requireRecipe(JSON.stringify([...input.operationIds].sort()) === JSON.stringify([...input.review.readOnlyOperationIds].sort()),
    'Explicitly review every selected operation as read-only; GET alone is not a safety declaration.');
  const { document, operations } = validateOpenApiDocument(input.document, input.operationIds);
  const permittedDocument = new Set(['openapi', 'info', 'paths', 'servers', 'tags', 'externalDocs', 'components', 'security']);
  requireRecipe(Object.keys(document).every(key => permittedDocument.has(key))
    && (document.servers === undefined || document.servers.length === 1 && document.servers[0].url === input.backend.origin
      && Object.keys(document.servers[0]).every(key => ['url', 'description'].includes(key)))
    && (document.security === undefined || Array.isArray(document.security) && !document.security.length),
  'Only a matching fixed backend origin and anonymous backend operations are supported.');
  const tools = input.operationIds.map(id => {
    const op = operations.find(operation => operation.id === id);
    const item = document.paths[op.path], operation = item.get;
    requireRecipe(op.method === 'GET' && op.parameters.length === 0 && op.requestBody === undefined
      && Object.keys(item).every(key => ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace', 'summary', 'description', 'parameters'].includes(key))
      && Object.keys(operation).every(key => ['operationId', 'summary', 'description', 'responses', 'parameters',
        'security', 'tags', 'deprecated', 'externalDocs'].includes(key))
      && (operation.security === undefined || Array.isArray(operation.security) && !operation.security.length),
    'Recipe 1 supports fixed GETs only: no parameters, bodies, callbacks, security, references, alternate servers or mappings.');
    return { name: id, description: operation.description ?? operation.summary ?? id, path: op.path, readOnlyReviewed: true };
  });
  const runtime = validateRuntimeConfig({
    schemaVersion: 1, name: input.name, authentication: input.authentication,
    backendOrigin: input.backend.origin, requestsPerMinute: input.requestsPerMinute, tools,
    ...(input.azure.gateway ? { gateway: gatewaySettings(input) } : {}),
  });
  return { input, runtime };
}

function infrastructure(input) {
  const a = input.azure;
  const endpoint = `[concat('https://', '${a.appName}', '.', reference('${a.environmentResourceId}', '2025-01-01').defaultDomain, '/mcp')]`;
  return {
    $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
    contentVersion: '1.0.0.0',
    metadata: { recipe: input.recipe, status: 'review-only-not-deployed',
      expectedTenantId: a.tenantId, expectedSubscriptionId: a.subscriptionId, expectedResourceGroup: a.resourceGroup,
      warning: 'This template can overwrite an existing app. Check name absence and review all effects with a private Azure identity before any deployment.' },
    parameters: { containerImage: { type: 'string', minLength: 1,
      metadata: { description: `Separately built, scanned and approved ${a.registry.server}/repository@sha256:DIGEST. No tag or placeholder.` } } },
    resources: [{
      type: 'Microsoft.App/containerApps', apiVersion: '2025-01-01', name: a.appName, location: a.location,
      tags: { 'copilot-mcp-recipe': input.recipe },
      identity: { type: 'UserAssigned', userAssignedIdentities: { [a.registry.pullIdentityResourceId]: {} } },
      properties: {
        managedEnvironmentId: a.environmentResourceId,
        configuration: {
          activeRevisionsMode: 'Single',
          ingress: { external: true, targetPort: 3000, transport: 'http', allowInsecure: false },
          registries: [{ server: a.registry.server, identity: a.registry.pullIdentityResourceId }],
        },
        template: {
          containers: [{ name: 'mcp', image: "[parameters('containerImage')]",
            resources: { cpu: 0.25, memory: '0.5Gi' },
            env: [{ name: 'PORT', value: '3000' }, { name: 'PUBLIC_MCP_URL', value: endpoint }],
            probes: ['Liveness', 'Readiness'].map(type => ({
              type, httpGet: { path: '/health', port: 3000, scheme: 'HTTP' },
              initialDelaySeconds: 10, periodSeconds: 10, timeoutSeconds: 2, failureThreshold: 3,
            })) }],
          scale: { minReplicas: 1, maxReplicas: 1 },
        },
      },
    }],
    outputs: { mcpEndpoint: { type: 'string', value: endpoint } },
  };
}

const dockerfile = `FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --fund=false
COPY --chown=node:node server.js runtime.js runtime-config.json LICENSE THIRD-PARTY-NOTICES.md ./
USER node
EXPOSE 3000
CMD ["node", "server.js"]
`;

async function prepare(options, hosting = false) {
  requireRecipe(typeof options.config === 'string' && typeof options.output === 'string',
    'Plan/create requires --config and a new --output directory.');
  const configPath = await assertProjectPath(path.resolve(options.config));
  const { input, runtime } = (hosting ? compileHostingRecipe : compileContainerApps)(await readControl(configPath));
  const outputPath = await assertProjectPath(path.resolve(options.output));
  requireRecipe((await lstat(path.dirname(outputPath))).isDirectory(), 'Output parent must already exist.');
  try { await lstat(outputPath); requireRecipe(false, 'Output already exists. Use a new directory.', 'OUTPUT_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const producer = await getLibraryInfo();
  const files = {};
  for (const file of ['runtime.js', 'server.js', 'package.json', 'package-lock.json']) {
    files[file] = await readFile(path.join(TOOLKIT_ROOT, 'src', 'recipes', 'container-apps', file), 'utf8');
  }
  const lock = JSON.parse(files['package-lock.json']);
  for (const [name, pkg] of Object.entries(lock.packages)) {
    if (!name) continue;
    requireRecipe(typeof pkg.resolved === 'string' && typeof pkg.integrity === 'string',
      'Runtime dependency lock is incomplete.', 'ASSETS');
    const mirror = 'https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/';
    if (pkg.resolved.startsWith(mirror)) pkg.resolved = `https://registry.npmjs.org/${pkg.resolved.slice(mirror.length)}`;
    requireRecipe(pkg.resolved.startsWith('https://registry.npmjs.org/'), 'Unknown runtime package registry.', 'ASSETS');
  }
  files['package-lock.json'] = savedJson(lock);
  files['.npmrc'] = 'registry=https://registry.npmjs.org/\n';
  files['.gitignore'] = 'node_modules/\n.env\n.env.*\n*.log\n';
  files['.dockerignore'] = '**\n!package.json\n!package-lock.json\n!server.js\n!runtime.js\n!runtime-config.json\n!LICENSE\n!THIRD-PARTY-NOTICES.md\n';
  files['Dockerfile'] = dockerfile;
  files['runtime-config.json'] = savedJson(runtime);
  files['recipe-definition.json'] = savedJson(input);
  const appService = input.recipe === 'app-service-container-v1';
  files[appService ? 'infra/app-service.json' : 'infra/container-app.json'] = savedJson(appService ? appServiceInfrastructure(input) : infrastructure(input));
  if (input.azure.gateway) files['infra/apim-gateway.json'] = savedJson(gatewayInfrastructure(input, infrastructure(input)));
  files['README.md'] = await readFile(path.join(TOOLKIT_ROOT, 'docs', 'container-apps-recipe.md'), 'utf8');
  files['hosting-recipes.md'] = await readFile(path.join(TOOLKIT_ROOT, 'docs', 'hosting-recipes.md'), 'utf8');
  if (input.azure.gateway) files['README.md'] = await readFile(path.join(TOOLKIT_ROOT, 'docs', 'apim-gateway-recipe.md'), 'utf8');
  if (appService) files['README.md'] = await readFile(path.join(TOOLKIT_ROOT, 'docs', 'app-service-recipe.md'), 'utf8');
  files['LICENSE'] = await readFile(path.join(TOOLKIT_ROOT, 'LICENSE'), 'utf8');
  files['THIRD-PARTY-NOTICES.md'] = `# Generated server notices

Server source is generated by Copilot MCP Toolkit under the included MIT LICENSE.
Dependencies are installed separately; their own licenses and notices apply.
Direct dependencies are @modelcontextprotocol/sdk 1.32.1 (MIT, LICENSE),
ajv 8.20.0 (MIT, LICENSE), ajv-formats 3.0.1 (MIT, LICENSE) and
jose 6.2.12 (MIT, LICENSE.md). See package-lock.json for the full dependency tree.
Preserve the actual license texts and notices for all packages, including
transitive dependencies, when distributing a container or bundled artifact.
This notice is not a complete dependency license audit or a service-content license.
`;
  const review = {
    contractVersion: 1, recipe: input.recipe, status: 'generated-source-review-only',
    producer: { name: producer.name, version: producer.version, buildId: producer.contentDigest },
    target: input.azure, authentication: input.authentication, toolDefinitions: toolDefinitions(runtime),
    evidence: 'generated-definitions-not-observed-tools-list',
    limitations: [
      'Local generation only; no install, image build/push, cloud operation, token acquisition or backend call.',
      'Entra v2 delegated tokens only. Exact tenant, audience, scope and allowed client application are checked in the server.',
      'Anonymous JSON backend, fixed parameter-free GETs only. Read-only is an owner declaration, not verified backend semantics.',
      'Requests: 64 KiB; backend JSON: 1 MiB and 10 seconds; 20 concurrent requests; aggregate per-process requests/minute. No tool-call retries.',
      'Existing resource group, selected host environment/plan, ACR and least-privilege pull identity required; no prerequisite resource/identity/role creation or inspection.',
      'One warm replica costs money. Rate counters reset on restart and are not a distributed quota, billing cap or DDoS protection.',
      'Registry download/image build require separate approval. The image digest and base-image hardening must be reviewed before deployment.',
      'No automated deployment/lifecycle or consumer qualification. A separately approved unverified endpoint reference can use existing discovery/proof/FCC flows.',
    ],
  };
  files['recipe-review.json'] = savedJson(review);
  sealRecipeFiles(files, input.recipe);
  const digest = metadataDigest(boundedSnapshot({ configPath, input, outputPath, files, review }));
  return { action: hosting ? 'mcp-hosting-create' : 'mcp-container-apps-create', status: 'planned', outputPath, review, files,
    approvalToken: `${hosting ? 'mcp-hosting' : 'mcp-container-apps'}/${digest}` };
}

export async function planContainerApps(options) {
  requireRecipe(typeof options.workspaceRoot === 'string', 'An explicit --workspace-root is required.');
  return withCliWorkspace(options.workspaceRoot, () => prepare(options));
}
export async function writeContainerApps(options) {
  return writeRecipe(options, false);
}
export async function planHostingRecipe(options) {
  requireRecipe(typeof options.workspaceRoot === 'string', 'An explicit --workspace-root is required.');
  return withCliWorkspace(options.workspaceRoot, () => prepare(options, true));
}
export async function writeHostingRecipe(options) { return writeRecipe(options, true); }
async function writeRecipe(options, hosting) {
  requireRecipe(typeof options.workspaceRoot === 'string', 'An explicit --workspace-root is required.');
  return withCliWorkspace(options.workspaceRoot, async () => {
    const plan = await prepare(options, hosting);
    requireRecipe(options.approval === plan.approvalToken, 'Review the exact current local-write approval token.', 'APPROVAL_REQUIRED');
    await mkdir(plan.outputPath, { mode: 0o700 });
    await mkdir(path.join(plan.outputPath, 'infra'), { mode: 0o700 });
    for (const [name, content] of Object.entries(plan.files)) {
      const file = await assertProjectPath(path.join(plan.outputPath, ...name.split('/')));
      await writeFile(file, content, { flag: 'wx', mode: 0o600 });
      requireRecipe(await readFile(file, 'utf8') === content, 'Generated file readback differs; preserve partial output.', 'READBACK');
    }
    return { status: 'generated-not-deployed', recipe: plan.review.recipe, outputPath: plan.outputPath,
      approvalToken: plan.approvalToken, files: Object.keys(plan.files), liveQualified: false };
  });
}
