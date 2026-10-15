import Ajv from 'ajv';
import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { assertProjectPath, withCliWorkspace } from './config.js';
import { boundedSnapshot, metadataDigest, normalizeAnonymousEndpoint, savedJson } from './anonymous-metadata.js';
import { validateMcpServerDescriptor } from './mcp-server.js';
import { mcpCaptureFreshness } from './mcp-discovery.js';
import { getLibraryInfo } from './machine-contract.js';
import { secretIssues } from './validation.js';
import { RESTRICTED_DISCOVERY_CLIENT_ID } from './contract.js';
import { readAuthRegistrationBundle, registrationIdSchema, validApplicationIdUri } from './mcp-auth-registration.js';
import { writeNewJsonBundle } from './mcp-bundle-write.js';

export const fccTokenStoreClientId = RESTRICTED_DISCOVERY_CLIENT_ID;
const maximumBytes = 1048576;
const text = maxLength => ({ type: 'string', minLength: 1, maxLength,
  pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]+$' });
const object = (properties, required = Object.keys(properties)) => ({
  type: 'object', additionalProperties: false, properties, required,
});
const https = { ...text(2048), pattern: '^https://[^\\s]+$' };
const registrationId = registrationIdSchema;
export const fccInputSchema = object({
  schemaVersion: { const: 1 },
  connector: object({
    displayName: text(100), description: text(1000),
    developer: object({ name: text(100), websiteUrl: https, privacyPolicyUrl: https, termsOfUseUrl: https }),
  }),
  source: object({ descriptorFile: text(2048), captureFile: text(2048),
    authenticationBundleFile: text(2048) }, ['descriptorFile']),
  authentication: { oneOf: [
    object({ type: { const: 'none' } }),
    object({ type: { const: 'entra-sso' }, registrationId, applicationIdUri: text(2048) }, ['type']),
    object({ type: { const: 'oauth' }, registrationId }, ['type']),
  ] },
  review: object({
    metadataApprovedForExport: { const: true },
    dataAccess: { enum: ['public-data', 'shared-authorized-data', 'user-scoped'] },
    dataAccessReason: text(1000),
    tools: { type: 'array', maxItems: 1000, items: object({
      name: text(128), readOnly: { const: true }, reason: text(1000),
    }) },
  }),
});
const validateInput = new Ajv({ allErrors: true }).compile(fccInputSchema);
function requireFcc(condition, code, message) {
  if (!condition) throw Object.assign(new Error(message), { code: `MCP_FCC_${code}` });
}
const digest = value => metadataDigest(boundedSnapshot(value));
function clean(value) {
  const snapshot = boundedSnapshot(value, maximumBytes);
  requireFcc(!secretIssues(savedJson(snapshot)), 'SENSITIVE_INPUT',
    'FCC inputs must not contain credentials or secret values. Input contents are not logged.');
  return snapshot;
}
async function readJson(filename) {
  await assertProjectPath(filename);
  const info = await lstat(filename);
  requireFcc(info.isFile() && info.size <= maximumBytes, 'INPUT',
    'FCC input must be a regular JSON file no larger than 1 MiB.');
  const bytes = await readFile(filename);
  requireFcc(bytes.length <= maximumBytes, 'INPUT', 'FCC input exceeds 1 MiB.');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { requireFcc(false, 'INPUT', 'FCC input JSON is invalid; input contents are not logged.'); }
  return clean(value);
}
function checkedInput(value) {
  requireFcc(validateInput(value), 'INPUT',
    'FCC input does not match mcp-fcc-schema. Use schemaVersion 1, explicit metadata export review, and none, entra-sso or oauth authentication.');
  for (const item of [value.connector.displayName, value.connector.description, value.connector.developer.name,
    value.review.dataAccessReason, ...value.review.tools.flatMap(tool => [tool.name, tool.reason])]) {
    requireFcc(item.trim() === item && item.length > 0, 'INPUT', 'FCC text must be nonblank without surrounding whitespace.');
  }
  for (const key of ['websiteUrl', 'privacyPolicyUrl', 'termsOfUseUrl']) {
    normalizeAnonymousEndpoint(value.connector.developer[key]);
  }
  if (value.authentication.applicationIdUri !== undefined) {
    requireFcc(validApplicationIdUri(value.authentication.applicationIdUri),
    'INPUT', 'SSO Application ID URI must be an explicit nonsecret identifier without query or fragment.');
  }
  requireFcc(new Set(value.review.tools.map(tool => tool.name)).size === value.review.tools.length,
    'INPUT', 'FCC tool reviews must have unique names.');
  return value;
}
const checklist = [
  { id: 'endpoint', status: 'manual-checkpoint',
    instruction: 'Verify the deployed HTTPS Streamable HTTP endpoint. Generation/reference metadata is not deployment evidence.' },
  { id: 'read-only', status: 'manual-checkpoint',
    instruction: 'Review every exposed tool and backend side effect. Reviews and readOnlyHint annotations are declarations, not enforcement. Do not hide write tools by filtering this bundle.' },
  { id: 'data-access', status: 'manual-checkpoint',
    instruction: 'Verify authorized data access for test users. Caller Entra authentication does not make a shared backend key or managed identity user-scoped.' },
  { id: 'registration', status: 'manual-checkpoint',
    instruction: 'An authorized admin creates the custom connector in Microsoft 365 admin center, using this endpoint and the separately reviewed auth registration ID. This file is not an uploadable Microsoft manifest.' },
  { id: 'rollout', status: 'manual-checkpoint',
    instruction: 'Select a limited test-user/group audience explicitly. Do not deploy to all users as part of a demo by default.' },
  { id: 'consumer', status: 'manual-checkpoint',
    instruction: 'Separately authorize a new bounded consumer journey and record actual Microsoft 365 results, denied-user behavior and result quality. Do not replay consumed toolkit proofs.' },
];
const ssoChecklist = [
  { id: 'sso-config', status: 'manual-checkpoint',
    instruction: 'In Teams Developer Portal > Tools > Microsoft Entra SSO client ID registration, register the exact endpoint and existing resource application client ID with the required scope. Confirm organization/app restrictions and retain the registration ID and generated Application ID URI privately. No WIQD agent or app package is required for this manual FCC route.' },
  { id: 'sso-restrictions', status: 'manual-checkpoint',
    instruction: 'Review organization and app restrictions separately. The documented portal option Any Teams app permits registration without a final Teams app ID, but its broader app scope requires separate owner approval; never select it automatically. The reviewed ATK oauth/register action requires an app ID; that tooling requirement is not an FCC prerequisite. Do not create a dummy app to satisfy it.' },
  { id: 'sso-app', status: 'manual-checkpoint',
    instruction: 'With separate owner approval, preserve existing identifierUris, add the registration Application ID URI and the Web redirect https://teams.microsoft.com/api/platform/v1.0/oAuthConsentRedirect, and preauthorize the Microsoft Enterprise token-store client for the required delegated scope.' },
  { id: 'sso-endpoint', status: 'manual-checkpoint',
    instruction: 'With separate approval, verify tenant, token audience, delegated scope and token-store allowed client at the endpoint. Do not replace existing audiences, broaden access or silently mutate a shared app.' },
];
const oauthChecklist = [
  { id: 'oauth-provider', status: 'manual-checkpoint',
    instruction: 'With separate owner approval, register the app with the provider. Obtain its client ID, authorization/token/refresh endpoints and exact scopes; configure https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect. Do not guess these values from the MCP URL.' },
  { id: 'oauth-portal', status: 'manual-checkpoint',
    instruction: 'In Teams Developer Portal > Tools > OAuth Client Registration, create the connection using the provider values, review restrictions and PKCE support, and save. Enter any required secret only in the approved provider/portal UI, never in toolkit inputs or output.' },
  { id: 'oauth-reference', status: 'manual-checkpoint',
    instruction: 'Copy the actual saved OAuth client registration ID into authentication.registrationId and review a new bundle at a new destination. This ID is not the provider client ID, client secret or an SSO registration ID.' },
];
function manualSetup(input, descriptor) {
  const field = (label, value) => ({ label, value: value ?? null, status: value === undefined ? 'missing' : 'provided' });
  const auth = input.authentication;
  const isSso = auth.type === 'entra-sso';
  const referenceLabel = isSso ? 'SSO registration ID' : 'OAuth client registration ID';
  return {
    mode: 'human-copy-paste', submission: 'manual-only',
    formFields: [
      field('Display name', input.connector.displayName),
      field('Description', input.connector.description),
      field('MCP endpoint URL', descriptor.endpoint),
      field('Developer name', input.connector.developer.name),
      field('Website URL', input.connector.developer.websiteUrl),
      field('Privacy policy URL', input.connector.developer.privacyPolicyUrl),
      field('Terms of use URL', input.connector.developer.termsOfUseUrl),
      field('Authentication type', { none: 'None', 'entra-sso': 'Entra SSO', oauth: 'OAuth 2.0' }[auth.type]),
      ...(auth.type === 'none' ? [] : [field(referenceLabel, auth.registrationId)]),
    ],
    authenticationRegistration: {
      status: auth.type === 'none' ? 'not-required' : 'manual-checkpoints-required',
      ...(auth.type === 'none' ? {} : { portalUrl: 'https://dev.teams.microsoft.com/' }),
      fields: isSso ? [
        field('MCP endpoint URL', descriptor.endpoint),
        field('Tenant ID', descriptor.inbound.tenantId),
        field('Resource application client ID', descriptor.inbound.clientId),
        field('Delegated scope', descriptor.inbound.scope),
        field('Endpoint Application ID URI', descriptor.inbound.applicationIdUri),
        field('Registration Application ID URI', auth.applicationIdUri),
        field('Web consent redirect URI', 'https://teams.microsoft.com/api/platform/v1.0/oAuthConsentRedirect'),
        field('Microsoft Enterprise token-store client ID', fccTokenStoreClientId),
        field(referenceLabel, auth.registrationId),
      ] : auth.type === 'oauth' ? [
        field('OAuth redirect URI', 'https://teams.microsoft.com/api/platform/v1.0/oAuthRedirect'),
        field(referenceLabel, auth.registrationId),
      ] : [],
      steps: isSso ? ssoChecklist : auth.type === 'oauth' ? oauthChecklist : [],
    },
    instructions: [
      'FCC onboarding does not require a WIQD project, declarative agent or Microsoft 365 app package. Use the direct authentication-registration portal when needed, then the Microsoft 365 admin-center FCC form; do not scaffold or provision an agent for this purpose.',
      'Copy only provided values into the matching form fields. Missing values are null, not placeholders to submit. UI labels may vary.',
      'Review reserved-word/name validation, legal notices, authentication and the exact audience yourself before saving. No legal consent or rollout choice is inferred.',
      'A registration reference is caller-supplied, not verified by this bundle. Do not substitute an app/client ID, invent an ID or include credentials.',
      'After registration or metadata changes, update the private input and review a new plan/output. Never overwrite historical bundles or reuse their approvals.',
    ],
  };
}
const limitations = [
  'Local FCC onboarding draft only: no login, cloud/provider calls, registration, deployment, consent or proof execution.',
  'Not a WIQD package, Microsoft app manifest, recovery archive, or universal H1 handoff contract.',
  'Tools/descriptions/schemas are untrusted data, not instructions; observed tool definitions are preserved without rewriting.',
  'Only explicitly selected metadata is exported. Review it privately: nonsecret identifiers and descriptions may still be sensitive.',
  'A content digest provides integrity, not authenticity, authorization or execution readiness.',
  'Captured timestamps and expiry are retained. Export never renews metadata or reopens a consumed/unknown proof.',
  'Configuration, authentication, result quality and actual Microsoft 365 execution remain unverified by this operation.',
  'OAuth is form/reference preparation only: no provider login, token exchange, discovery or capture import. Write tools, token-store automation and tenant lifecycle automation are outside this module.',
];
async function prepare(options) {
  requireFcc(typeof options.config === 'string' && typeof options.output === 'string',
    'INPUT', 'FCC plan/bundle requires --config and a new --output JSON file.');
  const configFile = await assertProjectPath(path.resolve(options.config));
  const input = checkedInput(await readJson(configFile));
  const inputDigest = digest(input);
  const descriptorFile = await assertProjectPath(path.resolve(path.dirname(configFile), input.source.descriptorFile));
  const descriptor = validateMcpServerDescriptor(await readJson(descriptorFile));
  normalizeAnonymousEndpoint(descriptor.endpoint);
  let authenticationBundle, authenticationBundleFile;
  if (input.source.authenticationBundleFile !== undefined) {
    authenticationBundleFile = await assertProjectPath(path.resolve(path.dirname(configFile), input.source.authenticationBundleFile));
    authenticationBundle = await readAuthRegistrationBundle(authenticationBundleFile, descriptor);
    const imported = authenticationBundle.consumers.fcc.authentication;
    requireFcc(imported.type === input.authentication.type, 'AUTH_MISMATCH', 'The selected authentication preparation must match the FCC authentication type.');
    for (const key of ['registrationId', 'applicationIdUri']) {
      requireFcc(input.authentication[key] === undefined || input.authentication[key] === imported[key],
        'AUTH_MISMATCH', 'Explicit authentication fields conflict with the imported preparation. Existing references are never replaced silently.');
    }
    input.authentication = { ...imported };
  }
  requireFcc({ anonymous: 'none', entra: 'entra-sso', oauth: 'oauth' }[descriptor.inbound.type] === input.authentication.type,
    'AUTH_MISMATCH', 'FCC authentication must match the endpoint descriptor. Authentication downgrade is not allowed.');
  requireFcc(descriptor.inbound.type !== 'oauth' || input.source.captureFile === undefined, 'AUTH_UNSUPPORTED',
    'OAuth onboarding is form/reference-only. OAuth discovery and capture import are not supported; do not substitute an anonymous capture.');
  const gaps = [];
  const gap = (code, message) => gaps.push({ code, message });
  let discovery = { status: 'not-provided', replayAuthorized: false }, tools = [], captureFile, capture;
  if (input.source.captureFile !== undefined) {
    captureFile = await assertProjectPath(path.resolve(path.dirname(configFile), input.source.captureFile));
    capture = await readJson(captureFile);
    discovery = { ...mcpCaptureFreshness(capture), captureDigest: capture.receiptDigest, toolsDigest: capture.toolsDigest };
    requireFcc(digest(capture.source) === digest(descriptor), 'CAPTURE_MISMATCH',
      'Observed capture must match the exact endpoint descriptor, not only its URL.');
    tools = capture.tools.tools;
    requireFcc(tools.length > 0, 'TOOL_REVIEW', 'FCC requires at least one observed retrieval tool.');
    requireFcc(tools.length === input.review.tools.length
      && tools.every(tool => input.review.tools.some(review => review.name === tool.name)),
    'TOOL_REVIEW', 'Review every observed tool exactly once. A local tool subset does not restrict the remote endpoint.');
    if (discovery.status === 'stale') gap('CAPTURE_STALE', 'Observed tools are historical: review a separately approved discovery if needed; export does not renew them.');
    for (const tool of tools) {
      if (tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint === true) {
        gap('TOOL_NOT_READ_ONLY', `Observed tool ${tool.name} declares non-read-only or destructive behavior.`);
      }
    }
  } else gap('CAPTURE_MISSING', 'No observed tools are provided. Tool reviews are declarations only; no tool definitions will be fabricated.');
  if (input.authentication.type === 'entra-sso') {
    if (!input.authentication.registrationId) gap('SSO_REGISTRATION_MISSING', 'Obtain the separately reviewed Teams Developer Portal SSO registration ID.');
    if (!input.authentication.applicationIdUri) gap('SSO_AUDIENCE_MISSING', 'Obtain the Application ID URI generated by SSO registration.');
    else if (input.authentication.applicationIdUri !== descriptor.inbound.applicationIdUri) {
      gap('SSO_AUDIENCE_MISMATCH', 'The registration URI differs from the descriptor audience. Existing audience/client-ID validation is not proof that the registration audience is accepted.');
    }
    if (!descriptor.inbound.allowedClientIds.some(id => id.toLowerCase() === fccTokenStoreClientId)) {
      gap('SSO_CLIENT_MISSING', 'The descriptor does not allow the Microsoft Enterprise token-store client. Review an explicit endpoint/app change.');
    }
  } else if (input.authentication.type === 'oauth') {
    if (!input.authentication.registrationId) gap('OAUTH_REGISTRATION_MISSING', 'Obtain the separately reviewed Teams Developer Portal OAuth client registration ID.');
    gap('OAUTH_DISCOVERY_UNSUPPORTED', 'OAuth tool discovery/import is not implemented. This is a blocked form/reference draft, not validated tool metadata or consumer readiness.');
  } else {
    requireFcc(input.review.dataAccess === 'public-data', 'DATA_ACCESS',
      'No Auth onboarding is limited to explicitly reviewed public data. Protected or user-scoped data requires authentication.');
  }
  const info = await getLibraryInfo();
  const content = clean({
    schemaVersion: 1, kind: 'mcp-fcc-onboarding', status: 'onboarding-draft',
    producer: { name: info.name, version: info.version, buildId: info.contentDigest },
    connector: input.connector,
    endpoint: { url: descriptor.endpoint, transport: descriptor.transport, sourceKind: descriptor.kind,
      sourceStatus: descriptor.status, descriptorDigest: descriptor.descriptorDigest },
    authentication: { ...input.authentication, ...(descriptor.inbound.type === 'entra' ? {
      requirements: { tenantId: descriptor.inbound.tenantId, resourceClientId: descriptor.inbound.clientId,
        endpointApplicationIdUri: descriptor.inbound.applicationIdUri, scope: descriptor.inbound.scope,
        tokenStoreClientId: fccTokenStoreClientId },
    } : {}) },
    manualSetup: { ...manualSetup(input, descriptor), ...(authenticationBundle ? {
      sharedRegistration: { contentDigest: authenticationBundle.contentDigest,
        referenceStatus: authenticationBundle.registrationReference.status,
        fields: authenticationBundle.manualSetup.fields, evidence: authenticationBundle.evidence },
    } : {}) },
    review: input.review, tools,
    evidence: { discovery, configuration: 'not-verified', protocolProof: 'not-assessed',
      consumerExecution: 'not-verified', executionReadiness: false, proofReplayAuthorized: false },
    readiness: { status: gaps.length ? 'blocked' : 'manual-checkpoints-required', gaps },
    checklist: [...(input.authentication.type === 'entra-sso' ? ssoChecklist : input.authentication.type === 'oauth' ? oauthChecklist : []), ...checklist],
    references: {
      setup: 'https://learn.microsoft.com/en-us/microsoft-365/copilot/connectors/set-up-custom-federated-connectors',
      sso: 'https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-entra-sso',
      oauth: 'https://learn.microsoft.com/en-us/microsoft-365/copilot/connectors/set-up-custom-federated-connectors#oauth-20',
    },
    limitations,
  });
  const bundle = clean({ ...content, contentDigest: digest(content) });
  const outputPath = await assertProjectPath(path.resolve(options.output));
  requireFcc(path.extname(outputPath).toLowerCase() === '.json', 'OUTPUT', 'FCC output must be a new .json file.');
  requireFcc((await lstat(path.dirname(outputPath))).isDirectory(), 'OUTPUT', 'FCC output parent must already exist.');
  try { await lstat(outputPath); requireFcc(false, 'OUTPUT_EXISTS', 'FCC destination exists. Choose a new file; no overwrite is supported.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const binding = { configFile, descriptorFile, captureFile: captureFile ?? null, outputPath,
    authenticationBundleFile: authenticationBundleFile ?? null,
    authenticationBundleDigest: authenticationBundle?.contentDigest ?? null,
    inputDigest, descriptorDigest: digest(descriptor),
    captureDigest: capture ? digest(capture) : null, contentDigest: bundle.contentDigest };
  return { action: 'mcp-fcc-onboarding-write', status: 'planned', outputPath,
    approvalToken: `mcp-fcc/${digest(binding)}`, bundle };
}
async function inWorkspace(options, action) {
  requireFcc(typeof options.workspaceRoot === 'string', 'WORKSPACE',
    'FCC commands require an explicit --workspace-root separate from installed code.');
  return withCliWorkspace(options.workspaceRoot, action);
}
export async function planFccBundle(options) {
  return inWorkspace(options, () => prepare(options));
}
export async function writeFccBundle(options) {
  return inWorkspace(options, () => writeNewJsonBundle(options, prepare, requireFcc));
}
