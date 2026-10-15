import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { assertProjectPath, withCliWorkspace } from './config.js';
import { boundedSnapshot, metadataDigest, normalizeAnonymousEndpoint, savedJson } from './anonymous-metadata.js';
import { validateMcpServerDescriptor } from './mcp-server.js';
import { getLibraryInfo } from './machine-contract.js';
import { secretIssues } from './validation.js';
import { RESTRICTED_DISCOVERY_CLIENT_ID } from './contract.js';
import { writeNewJsonBundle } from './mcp-bundle-write.js';

const maximumBytes = 1048576;
const object = (properties, required = Object.keys(properties)) => ({
  type: 'object', additionalProperties: false, properties, required,
});
const text = maxLength => ({ type: 'string', minLength: 1, maxLength,
  pattern: '^[^\\s\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069](?:[^\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]*[^\\s\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069])?$' });
const uuid = { type: 'string', format: 'uuid' };
const https = { ...text(2048), pattern: '^https://[^\\s]+$' };
export const registrationIdSchema = { type: 'string', minLength: 1, maxLength: 200,
  pattern: '^[A-Za-z0-9._:+/-]+={0,2}(?![\\s\\S])' };
const restrictions = {
  name: text(100), targetAudience: { enum: ['HomeTenant', 'AnyTenant'] },
  applicableToApps: { enum: ['SpecificApp', 'AnyApp'] }, appId: uuid,
};
const registrationSchema = { oneOf: [
  object({ type: { const: 'entra-sso' }, ...restrictions,
    reference: object({ registrationId: registrationIdSchema, applicationIdUri: text(2048) }),
  }, ['type', 'name', 'targetAudience', 'applicableToApps']),
  object({ type: { const: 'oauth' }, ...restrictions,
    clientId: text(200), authorizationUrl: https, tokenUrl: https, refreshUrl: https,
    scopes: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true,
      items: { ...text(256), pattern: '^[\\x21\\x23-\\x2b\\x2d-\\x5b\\x5d-\\x7e]+$' } },
    isPKCEEnabled: { type: 'boolean' },
    tokenExchangeMethodType: { enum: ['BasicAuthorizationHeader', 'PostRequestBody'] },
    credential: { oneOf: [
      object({ type: { const: 'none' } }),
      object({ type: { const: 'key-vault-reference' }, secretIdentifier: {
        type: 'string', maxLength: 2048,
        pattern: '^https://[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]\\.vault\\.azure\\.net/secrets/[a-zA-Z0-9-]{1,127}/[a-fA-F0-9]{32}$',
      } }),
    ] },
    reference: object({ registrationId: registrationIdSchema }),
  }, ['type', 'name', 'targetAudience', 'applicableToApps', 'clientId', 'authorizationUrl',
    'tokenUrl', 'scopes', 'isPKCEEnabled', 'tokenExchangeMethodType', 'credential']),
] };
export const authRegistrationInputSchema = object({
  schemaVersion: { const: 1 }, source: object({ descriptorFile: text(2048) }),
  operator: object({ tenantId: uuid, accountName: { ...text(254), format: 'email' } }),
  registration: registrationSchema,
  review: object({ metadataApprovedForExport: { const: true } }),
});
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validInput = ajv.compile(authRegistrationInputSchema);
const validRequest = ajv.compile(object({ tenantId: uuid, registration: registrationSchema }));
const validProducer = ajv.compile(object({
  name: { const: 'copilot-mcp-toolkit' }, version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
  buildId: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
}));
const digest = value => metadataDigest(boundedSnapshot(value));
function requireAuth(condition, code, message) {
  if (!condition) throw Object.assign(new Error(message), { code: `MCP_AUTH_REGISTRATION_${code}` });
}
function clean(value) {
  const result = boundedSnapshot(value, maximumBytes);
  requireAuth(!secretIssues(savedJson(result)), 'SENSITIVE_INPUT',
    'Registration input must contain nonsecret metadata/references only. Input contents are not logged.');
  return result;
}
async function readJson(filename) {
  await assertProjectPath(filename);
  const stat = await lstat(filename);
  requireAuth(stat.isFile() && stat.size <= maximumBytes, 'INPUT', 'Registration input must be a regular JSON file no larger than 1 MiB.');
  const bytes = await readFile(filename);
  requireAuth(bytes.length <= maximumBytes, 'INPUT', 'Registration input exceeds 1 MiB.');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { requireAuth(false, 'INPUT', 'Invalid registration JSON; input contents are not logged.'); }
  return clean(value);
}
export function validApplicationIdUri(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\%]/.test(value)) return false;
  try {
    const uri = new URL(value);
    return ['api:', 'https:'].includes(uri.protocol) && Boolean(uri.hostname)
      && !uri.username && !uri.password && !uri.search && !uri.hash;
  } catch { return false; }
}
function checkedRequest(request, descriptor) {
  requireAuth(validRequest(request), 'INPUT', 'Registration request does not match mcp-auth-registration-schema.');
  normalizeAnonymousEndpoint(descriptor.endpoint);
  const r = request.registration;
  requireAuth(!savedJson(r).includes('${{'), 'INPUT',
    'Registration values must be literal metadata, not ATK environment-variable expressions.');
  requireAuth({ entra: 'entra-sso', oauth: 'oauth' }[descriptor.inbound.type] === r.type,
    'AUTH_MISMATCH', 'Registration must match the exact authenticated descriptor; no anonymous downgrade or guessed provider is supported.');
  if (r.type === 'entra-sso') {
    requireAuth(request.tenantId.toLowerCase() === descriptor.inbound.tenantId.toLowerCase(), 'TENANT_MISMATCH',
      'SSO registration tenant must match the resource descriptor tenant.');
    requireAuth(!r.reference || validApplicationIdUri(r.reference.applicationIdUri), 'INPUT',
      'SSO reference requires its actual api:// or https:// Application ID URI, without credentials, query or fragment.');
  } else {
    for (const url of [r.authorizationUrl, r.tokenUrl, ...(r.refreshUrl ? [r.refreshUrl] : [])]) normalizeAnonymousEndpoint(url);
    requireAuth(r.credential.type !== 'none' || r.isPKCEEnabled, 'INPUT',
      'Secretless custom OAuth preparation requires explicit PKCE. Confidential clients require a versioned Key Vault reference.');
  }
  return request;
}
const field = (label, value) => ({ label, value: value ?? null, status: value === undefined ? 'missing' : 'provided' });
function createBundle(request, descriptor, producer) {
  checkedRequest(request, descriptor);
  requireAuth(validProducer(producer), 'BUNDLE_INVALID', 'Unsupported authentication preparation producer identity.');
  const r = request.registration, sso = r.type === 'entra-sso';
  const clientId = sso ? descriptor.inbound.clientId : r.clientId;
  const redirectUri = `https://teams.microsoft.com/api/platform/v1.0/${sso ? 'oAuthConsentRedirect' : 'oAuthRedirect'}`;
  const gaps = [
    { code: 'PROVIDER_ISOLATION_UNQUALIFIED', message: 'ATK uses OS credential storage and may use a native broker. An isolated provider environment has not been selected/qualified.' },
    { code: 'OPERATOR_IDENTITY_UNVERIFIED', message: 'The selected tenant/account has not authenticated or been independently verified. No shared auth cache is admitted.' },
    { code: 'REGISTRATION_EXECUTION_UNIMPLEMENTED', message: 'This command prepares data only. No provider login, register/update, consent or replay is implemented.' },
  ];
  if (!r.appId) gaps.push({ code: 'APP_ID_MISSING',
    message: 'ATK oauth/register requires a real M365 app ID even for AnyApp. Supply the intended app ID; never invent a dummy FCC app.' });
  if (!sso && r.credential.type !== 'none') gaps.push({ code: 'SECRET_RESOLUTION_UNIMPLEMENTED',
    message: 'The versioned Key Vault reference is retained but never fetched or converted to a provider secret. No runnable action is emitted.' });
  const action = r.reference || !r.appId || !sso && r.credential.type !== 'none' ? null : {
    uses: 'oauth/register',
    with: { name: r.name, flow: 'authorizationCode', identityProvider: sso ? 'MicrosoftEntra' : 'Custom',
      clientId, appId: r.appId, baseUrl: descriptor.endpoint,
      targetAudience: r.targetAudience, applicableToApps: r.applicableToApps,
      ...(!sso ? { authorizationUrl: r.authorizationUrl, tokenUrl: r.tokenUrl,
        ...(r.refreshUrl ? { refreshUrl: r.refreshUrl } : {}),
        scope: r.scopes.join(','), isPKCEEnabled: r.isPKCEEnabled, tokenExchangeMethodType: r.tokenExchangeMethodType } : {}),
    },
    writeToEnvironmentFile: { configurationId: 'MCP_AUTH_REGISTRATION_ID',
      ...(sso ? { applicationIdUri: 'MCP_AUTH_APPLICATION_ID_URI' } : {}) },
  };
  const authentication = { type: r.type, ...(r.reference ?? {}) };
  const fields = [
    field('Registration name', r.name), field('Registration tenant ID', request.tenantId),
    field('MCP endpoint URL', descriptor.endpoint), field('Identity provider', sso ? 'MicrosoftEntra' : 'Custom'),
    field(sso ? 'Resource application client ID' : 'Provider client ID', clientId),
    field('Target audience', r.targetAudience), field('Applicable to apps', r.applicableToApps),
    field('M365 app ID', r.appId), field('Redirect URI', redirectUri),
    field(sso ? 'SSO registration ID' : 'OAuth client registration ID', r.reference?.registrationId),
    ...(sso ? [
      field('Delegated scope', descriptor.inbound.scope),
      field('Endpoint Application ID URI', descriptor.inbound.applicationIdUri),
      field('Registration Application ID URI', r.reference?.applicationIdUri),
      field('Microsoft Enterprise token-store client ID', RESTRICTED_DISCOVERY_CLIENT_ID),
    ] : [
      field('Authorization URL', r.authorizationUrl), field('Token URL', r.tokenUrl),
      field('Refresh URL', r.refreshUrl), field('Scopes', r.scopes),
      field('PKCE enabled', r.isPKCEEnabled), field('Token exchange method', r.tokenExchangeMethodType),
      field('Credential mode', r.credential.type),
      ...(r.credential.type === 'none' ? [] : [field('Key Vault secret reference (not a secret value)', r.credential.secretIdentifier)]),
    ]),
  ];
  const content = clean({
    schemaVersion: 1, kind: 'mcp-auth-registration-preparation', producer,
    request, endpoint: { url: descriptor.endpoint, descriptorDigest: descriptor.descriptorDigest },
    readiness: { status: 'blocked', gaps },
    registrationReference: { status: r.reference ? 'provided-unverified' : 'missing',
      ...(r.reference ?? {}) },
    providerPreparation: { provider: '@microsoft/m365agentstoolkit-cli', reviewedVersion: '1.1.17',
      actionStatus: action ? 'review-only-not-execution-authority' : 'not-emitted', action,
      authentication: 'not-performed', secretResolution: 'not-performed' },
    manualSetup: { portalUrl: 'https://dev.teams.microsoft.com/', fields,
      instructions: [
        'Review the exact tenant, endpoint, app/organization restrictions and provider values before manual registration. The toolkit does not submit this data.',
        'Do not paste a Key Vault reference as a client secret. An authorized owner must enter any actual secret only in an approved provider/portal UI.',
        'Copy the saved registration ID unchanged into registration.reference, and for SSO include its generated Application ID URI. Create a fresh output; do not overwrite historical preparation.',
        'A supplied reference is not proof that settings, consent, scopes, endpoint audiences or client allowances are correct. Review those independently.',
      ] },
    consumers: {
      fcc: { authentication, submission: 'manual-only', configurationVerified: false },
      plugin: { authentication, status: 'mapping-required', packagingOwner: 'WIQD-or-consumer-tooling',
        instruction: 'Map the reference through the consumer tool supported authentication contract. This is not a WIQD input or an app manifest; it neither packages nor provisions a plugin.' },
    },
    evidence: { metadata: 'caller-declared', registration: 'not-verified', settings: 'not-verified',
      consumerExecution: 'not-verified', executionReadiness: false, proofReplayAuthorized: false },
    limitations: [
      'Local shared authentication preparation only; not an executed registration, a provider result receipt, or the universal H1 endpoint/tool handoff.',
      'Operator account is excluded from this export. No login cache, credential value, raw logs, tokens, approvals or tools are exported.',
      'Content digests provide integrity, not authenticity, current validity, consent or permission to execute.',
      'SSO action intentionally omits scopes: the reviewed provider does not map them into MicrosoftEntra registration. Resource scope/preauthorization remains separate.',
      'SpecificApp MCP compatibility needs consumer verification. Never silently change it to AnyApp or HomeTenant to AnyTenant.',
      'An existing reference must not trigger a new creation. Failed, inconclusive and unknown dispatched registrations remain consumed; this local draft authorizes no retry.',
    ],
  });
  return clean({ ...content, contentDigest: digest(content) });
}
export async function readAuthRegistrationBundle(filename, descriptor) {
  const bundle = await readJson(filename);
  requireAuth(bundle?.schemaVersion === 1 && bundle.kind === 'mcp-auth-registration-preparation'
    && validProducer(bundle.producer), 'BUNDLE_INVALID', 'Unsupported authentication preparation or producer identity.');
  const expected = createBundle(bundle.request, descriptor, bundle.producer);
  requireAuth(digest(bundle) === digest(expected), 'BUNDLE_INVALID',
    'Authentication preparation content, source descriptor or integrity differs. Preserve historical files and prepare a new reviewed bundle.');
  return bundle;
}
async function prepare(options) {
  requireAuth(typeof options.config === 'string' && typeof options.output === 'string', 'INPUT',
    'Registration plan/bundle requires --config and a new --output JSON file.');
  const configFile = await assertProjectPath(path.resolve(options.config));
  const input = await readJson(configFile);
  requireAuth(validInput(input), 'INPUT', 'Invalid registration input; use mcp-auth-registration-schema and explicit metadata review.');
  const descriptorFile = await assertProjectPath(path.resolve(path.dirname(configFile), input.source.descriptorFile));
  const descriptor = validateMcpServerDescriptor(await readJson(descriptorFile));
  const info = await getLibraryInfo();
  const bundle = createBundle({ tenantId: input.operator.tenantId, registration: input.registration }, descriptor,
    { name: info.name, version: info.version, buildId: info.contentDigest });
  const outputPath = await assertProjectPath(path.resolve(options.output));
  requireAuth(path.extname(outputPath).toLowerCase() === '.json', 'OUTPUT', 'Registration output must be a new .json file.');
  requireAuth((await lstat(path.dirname(outputPath))).isDirectory(), 'OUTPUT', 'Output parent must already exist.');
  try { await lstat(outputPath); requireAuth(false, 'OUTPUT_EXISTS', 'Output exists. Choose a new file; overwriting is not supported.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const binding = { configFile, descriptorFile, outputPath, inputDigest: digest(input),
    descriptorDigest: digest(descriptor), contentDigest: bundle.contentDigest };
  return { action: 'mcp-auth-registration-preparation-write', status: 'planned', outputPath,
    operator: input.operator, approvalToken: `mcp-auth-registration/${digest(binding)}`, bundle };
}
async function inWorkspace(options, action) {
  requireAuth(typeof options.workspaceRoot === 'string', 'WORKSPACE',
    'Registration commands require an explicit --workspace-root separate from installed code.');
  return withCliWorkspace(options.workspaceRoot, action);
}
export async function planAuthRegistrationBundle(options) {
  return inWorkspace(options, () => prepare(options));
}
export async function writeAuthRegistrationBundle(options) {
  return inWorkspace(options, () => writeNewJsonBundle(options, prepare, requireAuth));
}
