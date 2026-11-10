import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { assertProjectPath, isWithin, TOOLKIT_ROOT, withCliWorkspace, resolveWorkspaceRoot,
  safeHttpsUrl, validateOpenApiDocument, azureSchema, apiKeySchema } from './config.js';
import { readControl } from './mcp-control.js';
import { mcpServerInputSchema, prepareMcpServer, createMcpServerProject } from './mcp-server.js';
import { promptMcpResourceModes, promptMcpResourceSelection, prepareResourceSelection } from './mcp-resources.js';
import { managedIdentitySchema } from './apim-managed-identity.js';
import { secretIssues } from './validation.js';
import { publicInboundSchema } from './apim-public.js';
import { compileHostingRecipe, planHostingRecipe, writeHostingRecipe } from './mcp-container-apps.js';

const ajv = new Ajv();
addFormats(ajv);
const restSchema = mcpServerInputSchema.oneOf[0].properties;
const inboundSchema = restSchema.inbound.oneOf[0].properties;
const text = { type: 'string', minLength: 1, maxLength: 100 };
const cancelled = { value: 'cancel', label: 'Cancel without writing' };
const json = value => JSON.stringify(value, null, 2)
  .replace(/[\u007f-\u009f\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const hostingChoices = [
  { value: 'container-apps-direct-v1', label: 'REST API -> MCP on Azure Container Apps (recipe file)', example: 'container-apps-direct.json' },
  { value: 'container-apps-apim-v1', label: 'REST API -> MCP on Container Apps behind APIM (recipe file)', example: 'container-apps-apim.json' },
  { value: 'app-service-container-v1', label: 'REST API -> MCP on Azure App Service (recipe file)', example: 'app-service-container.json' },
  { value: 'functions-sdk-v1', label: 'REST API -> MCP on Azure Functions (preview; recipe file)', example: 'functions-sdk.json' },
];

const restSecurityGuidance = [
  'REST API security means how this setup accesses YOUR REST API:',
  '  - Native APIM (option 1): no authentication, API key from Key Vault, or supported Microsoft Entra access.',
  '    Entra user access only passes the same resource/audience token through; it does not exchange tokens (no OBO).',
  '    Entra app access uses an existing APIM system-managed identity with the exact backend application role.',
  '  - Container Apps, App Service and Functions (options 3-6): no authentication or API key from Key Vault only.',
  '    These hosting recipes do NOT support Entra-protected or other OAuth-protected REST backends, even behind APIM.',
  '  - Third-party OAuth and username/password (Basic) REST backends are not supported by these setup paths.',
  'This is separate from caller sign-in (the client accessing your MCP endpoint). Hosting recipes require Entra caller sign-in.',
  'Existing MCP servers (option 2) have their own choices; third-party OAuth there saves a reference only, without sign-in or testing.',
].join('\n');

async function newProjectDirectory(p) {
  return p.ask('NEW project directory inside the workspace (absolute path)', { check: async value => {
    if (!path.isAbsolute(value)) throw new Error('Use an absolute path.');
    const target = await assertProjectPath(value);
    try { await lstat(target); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw new Error('Destination already exists.');
  }, hint: 'Choose a new absolute directory inside the private workspace. Existing files, directories and symlinks will not be overwritten.' });
}

function hostingInstructions(p, workspace, choice) {
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const hostFields = {
    'container-apps-direct-v1': [
      'azure.environmentResourceId: Resource ID of your existing Container Apps environment.',
      'azure.registry.server: your Azure Container Registry login server (not a username or password).',
      'azure.registry.pullIdentityResourceId: Resource ID of the existing managed identity allowed to pull images.',
    ],
    'container-apps-apim-v1': [
      'azure.environmentResourceId and azure.registry: existing Container Apps environment, registry login server and image-pull identity Resource ID.',
      'azure.gateway: existing APIM service name/group and managed-identity principal ID; choose a new API name and URL path.',
      'azure.gateway.audience/applicationIdUri: the separate gateway resource app, not the user sign-in app. Keep role as Mcp.Gateway; its assignment needs separate review.',
    ],
    'app-service-container-v1': [
      'azure.planResourceId: Resource ID of an existing Linux Basic-or-higher App Service plan. Keep planKind unchanged.',
      'azure.registry: registry login server plus the image-pull managed identity Resource ID and client ID (these are different values).',
    ],
    'functions-sdk-v1': [
      'azure.planResourceId: Resource ID of an existing Linux Flex Consumption plan. Keep planKind unchanged.',
      'azure.storage: existing storage account Resource ID, deployment container name, and storage managed identity Resource ID/client ID.',
      'azure.previewAccepted: true is your acceptance of the Functions preview, not a value to copy without review. No container registry or imageBuild settings apply.',
    ],
  }[choice.value];
  p.output.write("\nPrepare your recipe file before answering the next question.\nThe wizard does NOT copy this file, fill in Azure IDs, or look up resources for you.\n\n1. Copy ONE matching template into your private workspace. Do not edit the toolkit's example.\n   Use the no-auth template OR the API-key template, depending on your REST API.\n   You can use your file manager or run the matching command in another PowerShell window.\n   Each copy command refuses to overwrite an existing file:\n");
  for (const [label, filename] of [
    ['No authentication', choice.example], ['API key', choice.example.replace('.json', '-api-key.json')],
  ]) {
    const source = path.join(TOOLKIT_ROOT, 'examples', 'mcp', filename);
    const destination = path.join(workspace, filename);
    p.output.write(`\n   ${label}:\n   Template: ${json(source)}\n   Your editable copy: ${json(destination)}\n   [System.IO.File]::Copy(${quote(source)}, ${quote(destination)})\n`);
  }
  p.output.write('\n2. Open YOUR COPY in a text editor and replace the example values manually.\n   The sample IDs, names and URLs are fictional. Valid JSON alone does not mean the Azure resources exist or that you have access.\n   Keep schemaVersion and recipe unchanged. Review these settings:\n');
  for (const item of [
    'name: a friendly name for your MCP server.',
    'azure.tenantId: Microsoft Entra ID > Overview > Tenant ID. azure.subscriptionId: Azure > Subscriptions > Subscription ID.',
    'azure.resourceGroup/location: the selected existing resource group and Azure region code (for example eastus). azure.appName: choose a new app name; do not target an existing app.',
    ...hostFields,
    'For Resource IDs, open the Azure resource > Properties > Resource ID. Use the full /subscriptions/... path, not just the resource name.',
    'authentication.tenantId: the same tenant as azure.tenantId. authentication.audience: the MCP resource app Application (client) ID, not its object ID.',
    'authentication.applicationIdUri and scope: the resource app > Expose an API. allowedClientIds: the Application (client) IDs of the apps allowed to call this MCP server, not user IDs.',
    'backend.origin: the real REST API HTTPS origin. document.paths: its fixed GET paths, tool names and descriptions; responses must be JSON.',
    'Optional query arguments: declare operation-level string/integer/boolean query parameters. Dates use format: date; x-mcp-date-range enforces ordering and an elapsed-day limit. See docs/hosting-recipes.md.',
    'operationIds: select the tool operationId values from document. review.readOnlyOperationIds: include only those same operations after reviewing that they do not change data.',
    'requestsPerMinute: choose a suitable request limit. This is not an Azure cost cap.',
  ]) p.output.write(`   - ${item}\n`);
  p.output.write('\n   For the API-key template, configure Key Vault/identity references and the header\n   or query parameter name; never put the key value in JSON. Review shared key\n   access and any query-log exposure. The no-auth template needs no backend key.\n   These hosting recipes do not support other backend sign-in methods.\n');
  if (choice.value !== 'functions-sdk-v1') {
    p.output.write('   Optional imageBuild settings need reviewed digest-pinned builder/runtime images before a container build; the example alone is not build-ready.\n');
  }
  p.output.write(`\n   If you do not know the required IDs or do not have the prerequisite resources,\n   press Ctrl+C and arrange the separate infrastructure/app-registration setup.\n   Do not invent IDs or leave fictional examples as your real configuration.\n   Field guide: ${json(path.join(TOOLKIT_ROOT, 'docs', 'hosting-recipes.md'))}\n\n3. Save your edited JSON file, then paste its FULL FILE PATH below without quotes.\n   Enter the JSON file path, not the workspace folder. No file has been copied or saved by this wizard yet.\n   Next you will choose a different, NEW folder for generated server code, review the exact files and confirm whether to save them.\n\n`);
}

async function createHostingSetup(p, options, choice) {
  p.output.write(`\nWhich JSON file should you copy? Choose ONE for your REST API's security:\n\n  No authentication: ${choice.example}\n  Full template path: ${json(path.join(TOOLKIT_ROOT, 'examples', 'mcp', choice.example))}\n\n  API key: ${choice.example.replace('.json', '-api-key.json')}\n  Full template path: ${json(path.join(TOOLKIT_ROOT, 'examples', 'mcp', choice.example.replace('.json', '-api-key.json')))}\n\nCopy the matching file into your private workspace and edit that copy, not the toolkit example.\nIf the REST API requires Entra or another OAuth provider, neither template supports it.\n`);
  p.output.write('This creates local server code and deployment files, not a running endpoint.\nThis is a file-based setup: you must copy an example recipe, edit its settings yourself, and supply the edited file.\nA recipe is a JSON file describing your API, authentication and Azure resources. The next instructions show exactly what to copy and change.\nREST API access (backend.auth): anonymous means no authentication; api-key uses a Key Vault reference. Entra and other OAuth REST backends are NOT supported here.\nMCP caller access (authentication): Microsoft Entra sign-in is required. This does not grant access to an Entra-protected REST backend.\nOnly fixed read-only GET operations are supported. Never enter credentials.\nChoose an existing private workspace folder outside the toolkit checkout. Create it in another terminal or your file manager first if needed.\nExisting host resources and permissions are required later; this setup does not create them. Container Apps infrastructure planning is available under configuration review.\n');
  p.output.write('Fixed paths may accept declared query arguments, including validated date ranges. No dynamic paths, bodies or automatic pagination. See examples/mcp/container-apps-query-dates.json for a synthetic parameter example.\nThe next question asks for the WORKSPACE FOLDER only, not the JSON file.\nAfter you enter that folder, you will see copy/edit instructions with destination paths, then a separate question for your edited JSON file.\n');
  const workspace = await resolveWorkspaceRoot(options['workspace-root']
    ?? await p.ask('Existing absolute private workspace directory (outside the toolkit checkout)'));
  if (isWithin(TOOLKIT_ROOT, workspace)) throw new Error('New setup output must be outside the toolkit checkout.');
  return withCliWorkspace(workspace, async () => {
    hostingInstructions(p, workspace, choice);
    const config = await p.ask('Full path to your edited hosting recipe JSON file', { check: async value => {
      if (!path.isAbsolute(value)) throw new Error('Use a full file path.');
      const { input } = compileHostingRecipe(await readControl(path.resolve(value)));
      if (input.recipe !== choice.value) throw new Error('Recipe does not match the selected host.');
    }, hint: `Enter the full path, without quotes, to an existing edited ${choice.value} JSON file inside your workspace, not a folder. Check the field guide above; use nonsecret resource references, never credentials.` });
    const output = await newProjectDirectory(p);
    const selected = { workspaceRoot: workspace, config, output };
    const plan = await planHostingRecipe(selected);
    if (plan.review.recipe !== choice.value) throw new Error('The recipe changed to a different host. Start a new review; nothing was generated.');
    p.output.write(`\nReady to save the hosting source files in ${json(plan.outputPath)}.\nThis only creates local files. It does not install packages, build an image, sign in, deploy to Azure or call a tool.\nFull configuration and approval reference:\n${json({
      projectDir: plan.outputPath, definition: JSON.parse(plan.files['recipe-definition.json']),
      review: plan.review, files: Object.keys(plan.files), approvalToken: plan.approvalToken,
    })}\n`);
    const approval = await p.choose('Save these hosting source files to the folder shown above?', [
      cancelled, { value: 'create', label: 'Yes, save the files only' },
    ]);
    if (approval !== 'create') return;
    if (p.signal?.aborted) throw Object.assign(new Error('Guided setup aborted before writing.'), { code: 'ABORTED' });
    const result = await writeHostingRecipe({ ...selected, approval: plan.approvalToken, signal: p.signal });
    p.output.write(`Hosting source files saved: ${json(result.outputPath)}\nNext: review the source report and generated README.md. Build, deployment, sign-in, validation and HTML handover export are separate operations. This is not an APIM connection project; review it as a hosting source project.\n`);
    return ['mcp-recipe-source-plan', '--workspace-root', workspace, '--project', result.outputPath, '--json'];
  });
}

async function field(p, label, schema, parse = value => value) {
  const validate = ajv.compile(schema);
  return parse(await p.ask(label, { check: value => {
    if (!validate(parse(value))) throw new Error('Invalid field.');
  }, hint: schema.format === 'uuid' ? 'Copy the complete ID, including its hyphens, from Azure.'
    : schema.type === 'integer' ? `Enter a whole number from ${schema.minimum} to ${schema.maximum}.`
      : 'Check the value and use the format shown in the question.' }));
}

async function endpoint(p, label) {
  return p.ask(label, { check: safeHttpsUrl, hint: 'Use HTTPS without credentials, query parameters or fragments.' });
}

async function inbound(p, tenantId) {
  p.output.write('Caller authentication is separate from backend authentication. Use reviewed Entra resource-app and client IDs; no app or consent will be created. If these are not known, cancel and complete the separate app-setup review first.\n');
  return {
    type: 'entra',
    tenantId: tenantId ?? await field(p, 'Entra tenant ID (UUID)', inboundSchema.tenantId),
    clientId: await field(p, 'Resource application client ID (UUID)', inboundSchema.clientId),
    applicationIdUri: await field(p, 'Resource Application ID URI (api://... or https://...)', inboundSchema.applicationIdUri),
    scope: await field(p, 'Delegated scope name (for example access_as_user)', inboundSchema.scope),
    allowedClientIds: await field(p, 'Allowed caller application IDs (comma-separated UUIDs, no automatic additions)',
      inboundSchema.allowedClientIds, value => value.split(',').map(id => id.trim())),
  };
}

async function keyReference(p) {
  p.output.write('Never paste an API key. APIM will use a versionless Key Vault secret reference; secret population and permissions are separate owner actions.\n');
  const secretIdentifier = await field(p, 'Versionless Key Vault secret URL (https://VAULT.vault.azure.net/secrets/NAME)',
    apiKeySchema.properties.secretIdentifier);
  const location = await p.choose('Where does the source expect its API key?', [
    { value: 'headerName', label: 'HTTP header' },
    { value: 'queryParameterName', label: 'Query parameter' }, cancelled,
  ]);
  if (location === 'cancel') return;
  return { secretIdentifier, [location]: await field(p, 'API-key header or query parameter NAME (not its value)',
    apiKeySchema.properties[location]) };
}

async function restDefinition(p, input) {
  const authoring = await p.choose('How would you like to define the REST tools?', [
    { value: 'get', label: 'One fixed GET endpoint (no query, body or arguments; no OpenAPI file needed)' },
    { value: 'openapi', label: 'Import local OpenAPI 3.0.x JSON and select operations' }, cancelled,
  ]);
  if (authoring === 'cancel') return false;
  if (authoring === 'get') {
    const url = new URL(await p.ask('Full HTTPS GET endpoint', { check: value => {
      safeHttpsUrl(value);
      const parsed = new URL(value);
      if (!/^\/[A-Za-z0-9._~/-]*$/.test(parsed.pathname) || parsed.pathname.includes('//')
        || (value !== parsed.origin && value !== `${parsed.origin}${parsed.pathname}`)) {
        throw new Error('Use a canonical literal path.');
      }
    }, hint: 'Use a canonical HTTPS URL with a literal path; no query, encoded/dynamic path, body or credentials. Use OpenAPI import for other operations.' }));
    const operationId = await field(p, 'Tool operation ID (letters, digits, dots, underscores or hyphens)',
      { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$' });
    const description = await field(p, 'Describe what this GET returns (nonsecret)', { ...text, maxLength: 1000 });
    input.backend.endpoint = url.origin;
    input.document = { openapi: '3.0.3', info: { title: input.server.name, version: '1.0.0' },
      paths: { [url.pathname]: { get: { operationId, description, responses: { 200: { description: 'Backend response; schema not inferred.' } } } } } };
    input.operationIds = [operationId];
  } else {
    input.backend.endpoint = await endpoint(p, 'REST backend base HTTPS URL (paths in OpenAPI are appended to it)');
    const filename = await p.ask('Local OpenAPI JSON path inside the selected workspace', { check: async value => {
      validateOpenApiDocument(await readControl(path.resolve(value)));
    }, hint: 'Use a nonsecret OpenAPI 3.0.x JSON file inside the workspace, at most 1 MiB, with unique operation IDs and bundled local references.' });
    const { document, operations } = validateOpenApiDocument(await readControl(path.resolve(filename)));
    if (secretIssues(JSON.stringify(document))) throw new Error('Possible credential in OpenAPI input; use nonsecret references only.');
    p.output.write(`Available operations (selection is not read-only approval):\n${json(operations.map(({ id, method, path }) => ({ id, method, path })))}\n`);
    const ids = await p.ask('Operation IDs to expose (comma-separated; only these will be selected)', { check: value => {
      const selected = value.split(',').map(id => id.trim());
      if (!selected.length || selected.length > 100 || new Set(selected).size !== selected.length
        || selected.some(id => !operations.some(operation => operation.id === id))) throw new Error('Select listed IDs.');
    }, hint: 'Enter 1-100 distinct operation IDs from the displayed list.' });
    input.document = document;
    input.operationIds = ids.split(',').map(id => id.trim());
  }
  return true;
}

async function azureTarget(p, input) {
  const modes = await promptMcpResourceModes(input, p);
  if (modes.status === 'cancelled') return;
  const access = input.backend.auth === 'anonymous' ? await p.choose('How should callers access the APIM MCP endpoint?', [
    { value: 'entra', label: 'Entra authentication (recommended default; separate from backend authentication)' },
    { value: 'public', label: 'Public anonymous - anyone can call; fixed public read-only GETs only' }, cancelled,
  ]) : 'entra';
  if (access === 'cancel') return;
  if (access === 'public') {
    p.output.write('Anyone who can reach this endpoint can call its MCP tools and backing REST routes without signing in. Use public, read-only data only.\nThe request budget is shared by all callers, separately for each API at each gateway/region. Limits are approximate, not a cost ceiling.\n');
    const declaration = await p.choose('Is this data safe for anyone to access, and do these GET requests only read data?', [
      cancelled, { value: 'declare', label: 'Yes, I reviewed this: public data, read-only requests' },
    ]);
    if (declaration !== 'declare') return;
    const rate = publicInboundSchema.properties.rateLimit.properties;
    input.inbound = { type: 'anonymous', publicData: true, readOnly: true, rateLimit: {
      calls: await field(p, 'Maximum requests in each time window (1-10000, shared by all callers)', rate.calls, Number),
      renewalPeriod: await field(p, 'Time window in seconds (1-300; for example 60)', rate.renewalPeriod, Number),
    } };
  }
  p.output.write('Now identify where these resources belong. Find the tenant ID in Microsoft Entra ID > Overview and the subscription ID in Azure > Subscriptions. No sign-in or Azure changes happen here.\n');
  input.azure = {
    tenantId: await field(p, 'Azure tenant ID', azureSchema.properties.tenantId),
    subscriptionId: await field(p, 'Azure subscription ID', azureSchema.properties.subscriptionId),
  };
  if (access === 'entra') input.inbound = await inbound(p, input.azure.tenantId);
  const selection = await promptMcpResourceSelection(input, p, { modes });
  if (selection.status === 'cancelled') return;
  if (Object.values(selection).some(choice => choice.mode === 'new')) {
    input.azure.location = await field(p, 'Azure location code for new resources (for example eastus)', azureSchema.properties.location);
  }
  if (selection.apim.mode === 'new') {
    input.azure.publisherName = await field(p, 'APIM publisher name', azureSchema.properties.publisherName);
    input.azure.publisherEmail = await field(p, 'APIM publisher email', azureSchema.properties.publisherEmail);
    input.azure.sku = await p.choose('APIM SKU (billable; obtain a separate cost review before deployment)', [
      ...azureSchema.properties.sku.enum.map(value => ({ value, label: value })), cancelled,
    ]);
    if (input.azure.sku === 'cancel') return;
  }
  if (input.backend.auth === 'api-key') {
    input.backend.apiKey = await keyReference(p);
    if (!input.backend.apiKey) return;
  }
  if (input.backend.auth === 'managed-identity') {
    p.output.write('Use the existing APIM system identity and an existing exact backend application-role assignment. No identity enablement or role grant is performed.\n');
    const identity = { type: 'system-assigned' };
    for (const [key, label] of [
      ['principalId', 'APIM system-assigned identity principal ID (UUID)'],
      ['resource', 'Separate backend application client ID (UUID)'],
      ['servicePrincipalId', 'Backend service principal object ID (UUID)'],
      ['appRoleId', 'Backend application role ID (UUID)'],
      ['appRole', 'Backend application role value'],
    ]) identity[key] = await field(p, label, managedIdentitySchema.properties[key]);
    input.backend.managedIdentity = identity;
  }
  return prepareResourceSelection({ definition: input, selection });
}

export async function createGuidedSetup(p, options = {}) {
  p.output.write(`${restSecurityGuidance}\n\n`);
  const source = await p.choose('What would you like to set up?', [
    { value: 'rest', label: 'REST API -> MCP with Azure API Management (no server code)' },
    { value: 'mcp', label: 'Connect to an existing MCP server (directly or through APIM)' },
    ...hostingChoices, cancelled,
  ]);
  if (source === 'cancel') return;
  const hosting = hostingChoices.find(choice => choice.value === source);
  if (hosting) return createHostingSetup(p, options, hosting);
  const auth = await p.choose(source === 'rest' ? 'How does the REST API check access?' : 'How does the existing MCP server check access?', [
    { value: 'anonymous', label: 'No sign-in or API key required' },
    { value: 'api-key', label: 'API key stored in Azure Key Vault (never paste the key)' },
    { value: 'entra', label: source === 'rest' ? 'Microsoft Entra user sign-in (API must accept the same token)' : 'Microsoft Entra sign-in (use existing app IDs)' },
    ...(source === 'rest' ? [{ value: 'managed-identity', label: 'Microsoft Entra app access (use an existing APIM managed identity)' }] : []),
    { value: 'oauth', label: source === 'rest' ? 'Other OAuth provider (not supported for REST APIs)' : 'Other OAuth provider (save a reference only; no sign-in or testing)' },
    cancelled,
  ]);
  if (auth === 'cancel') return;
  if (source === 'rest' && auth === 'oauth') {
    p.output.write('Third-party OAuth REST backends are not supported. No token exchange, credential collection, files or live operations were performed. Choose a supported source/authentication mode instead.\n');
    return;
  }
  const workspace = await resolveWorkspaceRoot(options['workspace-root']
    ?? await p.ask('Existing absolute private workspace directory (outside the toolkit checkout)'));
  if (isWithin(TOOLKIT_ROOT, workspace)) throw new Error('New setup output must be outside the toolkit checkout.');
  return withCliWorkspace(workspace, async () => {
    const name = await field(p, 'MCP setup name', restSchema.server.properties.name);
    const input = { schemaVersion: 1, server: { id: randomUUID(), name } };
    if (source === 'mcp' && auth !== 'api-key') {
      input.kind = 'existing-mcp';
      input.endpoint = await endpoint(p, 'Existing MCP HTTPS message endpoint');
      input.inbound = auth === 'entra' ? await inbound(p) : { type: auth };
      if (auth === 'oauth') p.output.write('REFERENCE ONLY: provider OAuth login, discovery and runtime proof are unsupported. A saved reference is not an operational connector.\n');
    } else {
      input.backend = { auth };
      if (auth === 'entra') p.output.write('Delegated passthrough requires the backend to accept the same resource/audience and authorize the user. Generic OAuth and OBO are not supported.\n');
      if (source === 'mcp') {
        input.schemaVersion = 2;
        input.kind = 'apim-mcp-proxy';
        input.backend.endpoint = await endpoint(p, 'Upstream MCP HTTPS message endpoint');
        p.output.write('API-key MCP proxy v2: provider transport compatibility is not guaranteed. Experimental v3 is not selected automatically; use advanced definition review for that explicit opt-in.\n');
      } else if (!await restDefinition(p, input)) return;
    }
    const resources = input.kind === 'existing-mcp' ? undefined : await azureTarget(p, input);
    if (input.kind !== 'existing-mcp' && !resources) return;
    const review = await prepareMcpServer(resources?.definition ?? input);
    const output = await newProjectDirectory(p);
    const projectDir = await assertProjectPath(output);
    p.output.write(`\nReady to save the setup files in ${json(projectDir)}.\nThis only creates local files. It does not sign in, deploy to Azure, call the endpoint or register an FCC.\nFull configuration and approval reference:\n${json({ projectDir, definition: review.input,
      ...(resources ? { resources: resources.resources } : {}), files: Object.keys(review.files),
      reviewDigest: review.reviewDigest, limitations: review.limitations })}\n`);
    const approval = await p.choose('Save these setup files to the folder shown above?', [
      cancelled, { value: 'create', label: 'Yes, save the files only' },
    ]);
    if (approval !== 'create') return;
    const result = await createMcpServerProject(review, { workspaceRoot: workspace, projectDir, signal: p.signal });
    p.output.write(`Setup files saved: ${json(result.projectDir)}\nDefinition: mcp-definition.json; descriptor: mcp-server.json.\nNext: the Resume report identifies what is needed to continue. Nothing has been deployed or tested. Review its next step before approving sign-in, an Azure change or an endpoint call. FCC onboarding is optional and separate; see docs/federated-connectors.md.\n`);
    return ['mcp-resume', '--workspace-root', workspace, '--project', result.projectDir, '--json', '--summary'];
  });
}
