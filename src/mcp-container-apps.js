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
import { imageBuildSchema } from './mcp-image-review.js';
import { hostingSchemas, gatewaySettings, gatewayInfrastructure, appServiceInfrastructure, functionsInfrastructure,
  backendIdentity, backendSecretName } from './mcp-hosting-targets.js';
import { runtimeSchema, validateRuntimeConfig, toolDefinitions, apiKeyPlacementProperties, apiKeyPlacementChoice,
  validateApiKeyPlacement, backendCredentialEnvironment } from './recipes/container-apps/runtime.js';

const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const uuid = { type: 'string', format: 'uuid' };
const resourceName = { type: 'string', minLength: 1, maxLength: 90, pattern: '^[A-Za-z0-9_-][A-Za-z0-9_.()-]*$' };
const resourceId = type => ({ type: 'string', maxLength: 512,
  pattern: `^/subscriptions/[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}/resourceGroups/[A-Za-z0-9_.()-]+/providers/${type.replaceAll('.', '\\.')}/[A-Za-z0-9_-]+$` });
const backendSchema = { oneOf: [
  object({ origin: runtimeSchema.properties.backendOrigin, auth: { const: 'anonymous' } }),
  object({ origin: runtimeSchema.properties.backendOrigin, auth: { const: 'api-key' },
    apiKey: { type: 'object', additionalProperties: false,
      required: ['tenantId', 'keyVaultResourceId', 'identityResourceId', 'secretIdentifier', 'sharedAccessReviewed'],
      properties: {
        tenantId: uuid, keyVaultResourceId: resourceId('Microsoft.KeyVault/vaults'),
        identityResourceId: resourceId('Microsoft.ManagedIdentity/userAssignedIdentities'),
        secretIdentifier: { type: 'string', maxLength: 256,
          pattern: '^https://[a-z][a-z0-9-]{1,22}[a-z0-9]\\.vault\\.azure\\.net/secrets/[A-Za-z0-9-]{1,127}(?:/[a-fA-F0-9]{32})?$' },
        ...apiKeyPlacementProperties,
        sharedAccessReviewed: { const: true }, queryExposureReviewed: { const: true },
      }, oneOf: apiKeyPlacementChoice,
      allOf: [{ if: { required: ['queryParameterName'] }, then: { required: ['queryExposureReviewed'] } }] },
  }),
] };
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
  backend: backendSchema,
  document: { type: 'object' },
  operationIds: { type: 'array', minItems: 1, maxItems: 30, uniqueItems: true,
    items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$' } },
  review: object({ readOnlyOperationIds: { type: 'array', minItems: 1, maxItems: 30, uniqueItems: true,
    items: { type: 'string', minLength: 1, maxLength: 80 } } }),
  requestsPerMinute: runtimeSchema.properties.requestsPerMinute,
});
const ajv = new Ajv();
containerAppsSchema.properties.imageBuild = imageBuildSchema;
containerAppsSchema.properties.scaleProfile = { enum: ['always-warm', 'scale-to-zero'] };
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
    `Use ${hosting ? 'mcp-hosting-schema' : 'mcp-container-apps-schema'} with explicit nonsecret target/authentication details.`);
  requireRecipe(input.recipe !== 'functions-sdk-v1' || input.imageBuild === undefined,
    'Functions uses a source-only remote build; do not supply container imageBuild inputs.');
  requireRecipe(input.scaleProfile === undefined || ['container-apps-direct-v1', 'container-apps-apim-v1'].includes(input.recipe),
    'scaleProfile applies only to Container Apps; other hosts retain their own scaling contracts.');
  requireRecipe(input.authentication.tenantId === input.azure.tenantId, 'Deployment and caller tenants must match.');
  const key = input.backend.apiKey;
  if (key) {
    validateApiKeyPlacement(key);
    requireRecipe(key.tenantId === input.azure.tenantId, 'Key Vault identity and deployment tenants must match.');
    const vault = key.keyVaultResourceId.split('/').at(-1);
    requireRecipe(/^[a-z][a-z0-9-]{1,22}[a-z0-9]$/.test(vault) && !vault.includes('--')
      && new URL(key.secretIdentifier).hostname === `${vault}.vault.azure.net`,
    'The Key Vault secret reference must match the explicit selected vault resource.');
    requireRecipe(![input.azure.registry?.pullIdentityResourceId, input.azure.storage?.identityResourceId]
      .some(id => id?.toLowerCase() === key.identityResourceId.toLowerCase()),
    'Use a separate dedicated Key Vault identity, not the image-pull or Functions storage identity.');
  }
  if (input.azure.storage) requireRecipe(/\/[a-z0-9]{3,24}$/.test(input.azure.storage.accountResourceId),
    'Use a valid lowercase 3-24 character storage account name in the resource ID.');
  if (input.azure.gateway) {
    requireRecipe(input.azure.gateway.audience !== input.authentication.audience,
      'Use a separate v2 resource application for the gateway identity, not the delegated caller audience.');
    const uri = new URL(input.azure.gateway.applicationIdUri);
    requireRecipe(!uri.username && !uri.password && !uri.search && !uri.hash
      && !/[\\<>"{}]/.test(input.azure.gateway.applicationIdUri) && !input.azure.gateway.applicationIdUri.endsWith('/'),
    'Use the exact nonsecret gateway Application ID URI.');
  }
  for (const id of [input.azure.environmentResourceId, input.azure.planResourceId, input.azure.registry?.pullIdentityResourceId,
    input.azure.storage?.accountResourceId, input.azure.storage?.identityResourceId,
    key?.keyVaultResourceId, key?.identityResourceId].filter(Boolean)) {
    requireRecipe(id.startsWith(`/subscriptions/${input.azure.subscriptionId}/`), 'Existing resources must be in the selected subscription.');
  }
  requireRecipe(JSON.stringify([...input.operationIds].sort()) === JSON.stringify([...input.review.readOnlyOperationIds].sort()),
    'Explicitly review every selected operation as read-only; GET alone is not a safety declaration.');
  const { document, operations } = validateOpenApiDocument(input.document, input.operationIds);
  const permittedDocument = new Set(['openapi', 'info', 'paths', 'servers', 'tags', 'externalDocs', 'components', 'security']);
  requireRecipe(Object.keys(document).every(key => permittedDocument.has(key))
    && (document.servers === undefined || document.servers.length === 1 && document.servers[0].url === input.backend.origin
      && Object.keys(document.servers[0]).every(key => ['url', 'description'].includes(key))),
  'Only a matching fixed backend origin is supported.');
  const validateSecurity = security => {
    if (security === undefined) return;
    if (!key) {
      requireRecipe(Array.isArray(security) && !security.length, 'Anonymous backend cannot satisfy OpenAPI security requirements.');
      return;
    }
    requireRecipe(Array.isArray(security) && security.length === 1 && security[0]
      && typeof security[0] === 'object' && !Array.isArray(security[0]) && Object.keys(security[0]).length === 1,
    'Declare exactly one matching API-key security scheme, without optional, mixed or alternative security.');
    const [name, scopes] = Object.entries(security[0])[0];
    const scheme = document.components?.securitySchemes?.[name];
    requireRecipe(Array.isArray(scopes) && scopes.length === 0 && scheme?.type === 'apiKey'
      && Object.keys(scheme).every(field => ['type', 'in', 'name', 'description'].includes(field))
      && scheme.in === (key.headerName ? 'header' : 'query')
      && typeof scheme.name === 'string'
      && (key.headerName ? scheme.name.toLowerCase() === key.headerName.toLowerCase() : scheme.name === key.queryParameterName),
    'OpenAPI API-key security must exactly match the reviewed backend placement; references and other authentication are unsupported.');
  };
  validateSecurity(document.security);
  const tools = input.operationIds.map(id => {
    const op = operations.find(operation => operation.id === id);
    const item = document.paths[op.path], operation = item.get;
    requireRecipe(op.method === 'GET' && op.parameters.length === 0 && op.requestBody === undefined
      && Object.keys(item).every(key => ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace', 'summary', 'description', 'parameters'].includes(key))
      && Object.keys(operation).every(key => ['operationId', 'summary', 'description', 'responses', 'parameters',
        'security', 'tags', 'deprecated', 'externalDocs'].includes(key)),
    'SDK hosting recipes support fixed GETs only: no parameters, bodies, callbacks, references, alternate servers or mappings.');
    validateSecurity(operation.security);
    return { name: id, description: operation.description ?? operation.summary ?? id, path: op.path, readOnlyReviewed: true };
  });
  const runtime = validateRuntimeConfig({
    schemaVersion: 1, name: input.name, authentication: input.authentication,
    backendOrigin: input.backend.origin, requestsPerMinute: input.requestsPerMinute, tools,
    ...(input.azure.gateway ? { gateway: gatewaySettings(input) } : {}),
    ...(key ? { backendAuthentication: { type: 'api-key',
      ...(key.headerName ? { headerName: key.headerName } : { queryParameterName: key.queryParameterName }) } } : {}),
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
      identity: { type: 'UserAssigned', userAssignedIdentities: { [a.registry.pullIdentityResourceId]: {}, ...backendIdentity(input) } },
      properties: {
        managedEnvironmentId: a.environmentResourceId,
        configuration: {
          activeRevisionsMode: 'Single',
          ingress: { external: true, targetPort: 3000, transport: 'http', allowInsecure: false },
          registries: [{ server: a.registry.server, identity: a.registry.pullIdentityResourceId }],
          ...(input.backend.apiKey ? { secrets: [{ name: backendSecretName,
            keyVaultUrl: input.backend.apiKey.secretIdentifier, identity: input.backend.apiKey.identityResourceId }] } : {}),
        },
        template: {
          containers: [{ name: 'mcp', image: "[parameters('containerImage')]",
            resources: { cpu: 0.25, memory: '0.5Gi' },
            env: [{ name: 'PORT', value: '3000' }, { name: 'PUBLIC_MCP_URL', value: endpoint },
              ...(input.backend.apiKey ? [{ name: backendCredentialEnvironment, secretRef: backendSecretName }] : [])],
            probes: ['Liveness', 'Readiness'].map(type => ({
              type, httpGet: { path: '/health', port: 3000, scheme: 'HTTP' },
              initialDelaySeconds: 10, periodSeconds: 10, timeoutSeconds: 2, failureThreshold: 3,
            })) }],
          scale: { minReplicas: input.scaleProfile === 'scale-to-zero' ? 0 : 1, maxReplicas: 1 },
        },
      },
    }],
    outputs: { mcpEndpoint: { type: 'string', value: endpoint } },
  };
}

function dockerfile(build) {
  return `FROM --platform=${build.platform} ${build.builderImage} AS dependencies
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --fund=false
FROM --platform=${build.platform} ${build.runtimeImage}
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies --chown=65532:65532 /app/node_modules ./node_modules
COPY --chown=65532:65532 package.json server.js runtime.js runtime-config.json LICENSE THIRD-PARTY-NOTICES.md ./
USER 65532:65532
EXPOSE 3000
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["server.js"]
`;
}

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
  if (input.imageBuild) files['Dockerfile'] = dockerfile(input.imageBuild);
  files['runtime-config.json'] = savedJson(runtime);
  files['recipe-definition.json'] = savedJson(input);
  const appService = input.recipe === 'app-service-container-v1', functions = input.recipe === 'functions-sdk-v1';
  files[functions ? 'infra/functions.json' : appService ? 'infra/app-service.json' : 'infra/container-app.json'] =
    savedJson(functions ? functionsInfrastructure(input) : appService ? appServiceInfrastructure(input) : infrastructure(input));
  if (input.azure.gateway) files['infra/apim-gateway.json'] = savedJson(gatewayInfrastructure(input, infrastructure(input)));
  files['README.md'] = await readFile(path.join(TOOLKIT_ROOT, 'docs', 'container-apps-recipe.md'), 'utf8');
  files['hosting-recipes.md'] = await readFile(path.join(TOOLKIT_ROOT, 'docs', 'hosting-recipes.md'), 'utf8');
  if (input.azure.gateway) files['README.md'] = await readFile(path.join(TOOLKIT_ROOT, 'docs', 'apim-gateway-recipe.md'), 'utf8');
  if (appService) files['README.md'] = await readFile(path.join(TOOLKIT_ROOT, 'docs', 'app-service-recipe.md'), 'utf8');
  if (functions) {
    files['README.md'] = await readFile(path.join(TOOLKIT_ROOT, 'docs', 'functions-recipe.md'), 'utf8');
    delete files.Dockerfile;
    delete files['.dockerignore'];
    files['.gitignore'] += 'local.settings.json\n.azure/\n.azure-auth/\n';
    files['.funcignore'] = 'node_modules/\nlocal.settings.json\nlocal.settings.example.json\ninfra/\nrecipe-*\n.git/\n.azure/\n.azure-auth/\n';
    files['host.json'] = savedJson({ version: '2.0', configurationProfile: 'mcp-custom-handler',
      customHandler: { description: { defaultExecutablePath: 'node', arguments: ['server.js'] },
        port: '3000', http: { defaultAuthorizationLevel: 'anonymous', routes: [
          ...['mcp', '.well-known/oauth-protected-resource', 'health'].map(route => ({ route, authorizationLevel: 'anonymous' })),
          { route: 'admin/{*route}', authorizationLevel: 'admin' },
        ] } } });
    files['local.settings.example.json'] = savedJson({ IsEncrypted: false, Values: {
      AzureWebJobsFeatureFlags: 'EnableMcpCustomHandlerPreview', MCP_HOST_PLATFORM: 'functions',
      PUBLIC_MCP_URL: 'http://localhost:7071/mcp', AzureWebJobsStorage: 'UseDevelopmentStorage=true',
    } });
  }
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
    target: input.azure, authentication: input.authentication, backend: input.backend, toolDefinitions: toolDefinitions(runtime),
    imageBuild: input.recipe === 'functions-sdk-v1' ? { status: 'source-only-remote-build' }
      : input.imageBuild ? { status: 'reviewed-inputs-not-built', ...input.imageBuild }
        : { status: 'blocked-missing-digest-pinned-inputs' },
    ...(['container-apps-direct-v1', 'container-apps-apim-v1'].includes(input.recipe)
      ? { scaling: { profile: input.scaleProfile ?? 'always-warm',
        minReplicas: input.scaleProfile === 'scale-to-zero' ? 0 : 1, maxReplicas: 1 } } : {}),
    evidence: 'generated-definitions-not-observed-tools-list',
    limitations: [
      'Local generation only; no install, image build/push, cloud operation, token acquisition or backend call.',
      'Entra v2 delegated tokens only. Exact tenant, audience, scope and allowed client application are checked in the server.',
      'Anonymous or Key Vault API-key JSON backend, fixed parameter-free GETs only. Read-only is an owner declaration, not verified backend semantics.',
      ...(input.backend.apiKey ? [
        'Dedicated pre-existing Key Vault identity/access and network reachability require separate inspection. No secret resolution or role grants during generation.',
        'All allowed callers share the backend key entitlement. No per-user source filtering; review licensing and data access.',
        'Missing/unresolved/malformed injected credentials prevent startup. Credentials are held in process memory until restart; no refresh or dispatched-call retry by this runtime.',
        'Query keys can appear in upstream/platform URL logs. Review safe diagnostics before deployment; obvious key reflection is rejected, not a general data-loss-prevention guarantee.',
      ] : []),
      'Requests: 64 KiB; backend JSON: 1 MiB and 10 seconds; 20 concurrent requests; aggregate per-process requests/minute. No tool-call retries.',
      'Existing selected host prerequisites required; no prerequisite resource/identity/role creation or inspection. Review the host-specific guide.',
      functions ? 'Flex preview only; scale-to-zero, up to 40 instances of 2048 MiB. Limits are per process, not global quotas or billing caps.'
        : 'Warm Container Apps replica or Always On App Service costs money. Limits are per process, not distributed quotas or billing caps.',
      functions ? 'Source-only ZIP; dependency installation and remote build/deployment require separate review and approval.'
        : 'Registry download/image build require separate approval. The image digest and base-image hardening must be reviewed before deployment.',
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
