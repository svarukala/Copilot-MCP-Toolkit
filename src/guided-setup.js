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

const ajv = new Ajv();
addFormats(ajv);
const restSchema = mcpServerInputSchema.oneOf[0].properties;
const inboundSchema = restSchema.inbound.oneOf[0].properties;
const text = { type: 'string', minLength: 1, maxLength: 100 };
const cancelled = { value: 'cancel', label: 'Cancel without writing' };
const json = value => JSON.stringify(value, null, 2)
  .replace(/[\u007f-\u009f\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

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
  const source = await p.choose('What are you starting with?', [
    { value: 'rest', label: 'REST API - expose selected operations through APIM as MCP tools' },
    { value: 'mcp', label: 'Existing MCP server - reference it directly or proxy an API key through APIM' }, cancelled,
  ]);
  if (source === 'cancel') return;
  const auth = await p.choose(source === 'rest' ? 'How does the REST backend authenticate?' : 'How does the existing MCP server authenticate?', [
    { value: 'anonymous', label: 'Anonymous / no authentication' },
    { value: 'api-key', label: 'API key - Key Vault reference, never the secret value' },
    { value: 'entra', label: source === 'rest' ? 'Entra delegated - same-resource token passthrough only (no OBO)' : 'Entra - existing resource and caller IDs' },
    ...(source === 'rest' ? [{ value: 'managed-identity', label: 'Entra application access - existing APIM system identity and exact role' }] : []),
    { value: 'oauth', label: source === 'rest' ? 'Third-party OAuth - unsupported for REST backends' : 'Third-party OAuth - reference only; no login, discovery or proof' },
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
    const output = await p.ask('NEW project directory inside the workspace (absolute path)', { check: async value => {
      if (!path.isAbsolute(value)) throw new Error('Use an absolute path.');
      const target = await assertProjectPath(value);
      try { await lstat(target); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      throw new Error('Destination already exists.');
    }, hint: 'Choose a new absolute directory inside the private workspace. Existing files, directories and symlinks will not be overwritten.' });
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
