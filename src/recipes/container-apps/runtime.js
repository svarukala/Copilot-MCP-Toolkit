import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const uuid = { type: 'string', format: 'uuid' };
const text = maxLength => ({ type: 'string', minLength: 1, maxLength, pattern: '^[^\\u0000-\\u001f\\u007f]+$' });
export const apiKeyPlacementProperties = {
  headerName: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9-]{0,99}$' },
  queryParameterName: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_.-]{0,99}$' },
};
export const apiKeyPlacementChoice = [{ required: ['headerName'] }, { required: ['queryParameterName'] }];
export const backendCredentialEnvironment = 'MCP_BACKEND_API_KEY';

const queryName = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_.-]{0,99}$' };
const stringLimit = 2048;
const queryLimit = 8192;
const safeInteger = { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
const scalarSchema = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['type'], properties: {
    type: { const: 'string' }, format: { const: 'date' },
    minLength: { type: 'integer', minimum: 0, maximum: stringLimit },
    maxLength: { type: 'integer', minimum: 0, maximum: stringLimit },
    enum: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true,
      items: { type: 'string', maxLength: stringLimit } },
  } },
  { type: 'object', additionalProperties: false, required: ['type'], properties: {
    type: { const: 'integer' }, minimum: safeInteger, maximum: safeInteger,
    enum: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: safeInteger },
  } },
  { type: 'object', additionalProperties: false, required: ['type'], properties: {
    type: { const: 'boolean' },
    enum: { type: 'array', minItems: 1, maxItems: 2, uniqueItems: true, items: { type: 'boolean' } },
  } },
] };
const queryParameter = { type: 'object', additionalProperties: false, required: ['name', 'required', 'schema'],
  properties: { name: queryName, required: { type: 'boolean' }, description: text(1000), schema: scalarSchema } };
const dateRangeSchema = object({ startParameter: queryName, endParameter: queryName,
  maxSpanDays: { type: 'integer', minimum: 1, maximum: 366 } });

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function validScalar(schema, value) {
  if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length > stringLimit * 2 || !value.isWellFormed()
      || /[\u0000-\u001f\u007f]/.test(value)) return false;
    const length = [...value].length;
    if (length < (schema.minLength ?? 0) || length > (schema.maxLength ?? stringLimit)
      || schema.format === 'date' && !validDate(value)) return false;
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < (schema.minimum ?? Number.MIN_SAFE_INTEGER)
      || value > (schema.maximum ?? Number.MAX_SAFE_INTEGER)) return false;
  } else if (schema.type !== 'boolean' || typeof value !== 'boolean') return false;
  return !schema.enum || schema.enum.includes(value);
}

function validateQueryContract(tool, backendAuthentication) {
  const parameters = tool.queryParameters ?? [];
  const names = new Set();
  for (const parameter of parameters) {
    const name = parameter.name.toLowerCase();
    validateApiKeyPlacement({ queryParameterName: parameter.name });
    validateApiKeyPlacement({ queryParameterName: name.replaceAll(/[-_.]/g, '') });
    if (names.has(name) || name === (backendAuthentication?.queryParameterName ?? backendAuthentication?.headerName)?.toLowerCase()
      || /^(?:apikey|xapikey|key|subscriptionkey|ocpapimsubscriptionkey|credential|credentials|secret|clientsecret|signature|sig|auth|authentication|hostname|port|protocol|scheme|path|pathname|query|search|fragment|hash|baseurl|baseuri|backend|backendorigin|redirect|redirecturl|redirecturi|callback|callbackurl|returnurl|constructor|prototype|tostring|valueof|hasownproperty|isprototypeof|propertyisenumerable|tolocalestring)$/.test(name.replaceAll(/[-_.]/g, ''))) {
      throw new Error('Invalid query parameter contract.');
    }
    names.add(name);
    const schema = parameter.schema;
    if (schema.type === 'string' && (schema.minLength ?? 0) > (schema.maxLength ?? stringLimit)
      || schema.type === 'integer' && (schema.minimum ?? Number.MIN_SAFE_INTEGER) > (schema.maximum ?? Number.MAX_SAFE_INTEGER)
      || schema.enum?.some(value => !validScalar(schema, value))
      || schema.format === 'date' && ((schema.minLength ?? 0) > 10 || (schema.maxLength ?? stringLimit) < 10)) {
      throw new Error('Invalid query parameter constraints.');
    }
  }
  if (tool.dateRange) {
    const range = tool.dateRange;
    if (range.startParameter === range.endParameter || [range.startParameter, range.endParameter].some(name =>
      !parameters.some(p => p.name === name && p.required && p.schema.type === 'string' && p.schema.format === 'date'))) {
      throw new Error('Date ranges require two distinct required date parameters.');
    }
  }
}

// Only scalar form serialization is supported; OpenAPI defaults are not applied.
function boundedScalarSchema(schema) {
  return { ...schema, ...(schema.type === 'string'
    ? { minLength: schema.format === 'date' ? 10 : schema.minLength ?? 0,
      maxLength: schema.format === 'date' ? 10 : schema.maxLength ?? stringLimit }
    : schema.type === 'integer' ? { minimum: schema.minimum ?? Number.MIN_SAFE_INTEGER,
      maximum: schema.maximum ?? Number.MAX_SAFE_INTEGER } : {}) };
}

export function normalizeQueryParameters(parameters) {
  if (!validateOpenApiParameters(parameters)) throw new Error('Use inline scalar operation query parameters only.');
  validateQueryContract({ queryParameters: parameters });
  return parameters.map(({ name, required = false, description, schema }) => ({
    name, required, ...(description === undefined ? {} : { description }),
    schema: boundedScalarSchema(schema),
  }));
}

export function validateToolArguments(tool, args) {
  try { return validateArguments(tool, args); }
  catch { throw new Error('Invalid tool arguments.'); }
}

function validateArguments(tool, args) {
  const invalid = () => { throw new Error('Invalid tool arguments.'); };
  if (args === undefined) args = {};
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) invalid();
  const parameters = tool.queryParameters ?? [];
  const descriptors = Object.getOwnPropertyDescriptors(args);
  if (Reflect.ownKeys(descriptors).some(name => typeof name !== 'string'
    || !parameters.some(parameter => parameter.name === name) || !('value' in descriptors[name]))) invalid();
  const effective = {};
  const query = new URLSearchParams();
  for (const parameter of parameters) {
    const descriptor = descriptors[parameter.name];
    if (!descriptor) { if (parameter.required) invalid(); continue; }
    if (!validScalar(parameter.schema, descriptor.value)) invalid();
    effective[parameter.name] = descriptor.value;
    query.set(parameter.name, String(descriptor.value));
  }
  if (query.toString().length > queryLimit) invalid();
  if (tool.dateRange) {
    const { startParameter, endParameter, maxSpanDays } = tool.dateRange;
    const days = (Date.parse(`${effective[endParameter]}T00:00:00.000Z`)
      - Date.parse(`${effective[startParameter]}T00:00:00.000Z`)) / 86400000;
    if (!Number.isInteger(days) || days < 0 || days > maxSpanDays) invalid();
  }
  return effective;
}

export function validateApiKeyPlacement(value) {
  const name = value.headerName ?? value.queryParameterName;
  const reserved = /^(?:authorization|proxy-authorization|cookies?|set-cookie|host|connection|keep-alive|transfer-encoding|content-.*|accept(?:-.*)?|user-agent|upgrade|te|trailer|expect|forwarded|via|origin|referer|range|if-.*|traceparent|tracestate|baggage|sec-.*|proxy(?:-.*)?|x-forwarded-.*|x-copilot-.*|x-http-method(?:-override)?|x-method-override|x-original-.*|x-rewrite-.*|x-real-ip|x-ms-client-principal(?:-.*)?|x-ms-token-.*|mcp-.*|www-authenticate|proxy-authenticate|access-control-.*)$/i;
  const queryReserved = /^(?:authorization|cookies?|password|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?(?:id|secret)|token|scope|code|state|redirect[-_]?uri|url|uri|host|endpoint|method|op)$/i;
  if (reserved.test(name) || !value.headerName && queryReserved.test(name)) {
    throw new Error('Use a dedicated API-key header or query name, not a reserved authorization, transport or routing field.');
  }
}
export const runtimeSchema = object({
  schemaVersion: { const: 1 },
  name: text(100),
  authentication: object({
    tenantId: uuid, audience: uuid, scope: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_.-]{0,119}$' },
    applicationIdUri: { type: 'string', minLength: 1, maxLength: 2048, pattern: '^(api|https)://[^\\s]+$' },
    allowedClientIds: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: uuid },
  }),
  backendOrigin: text(2048),
  requestsPerMinute: { type: 'integer', minimum: 1, maximum: 1000 },
  tools: { type: 'array', minItems: 1, maxItems: 30, items: object({
    name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$' },
    description: text(1000),
    path: { type: 'string', maxLength: 1024, pattern: '^/[A-Za-z0-9._~/-]*$' },
    readOnlyReviewed: { const: true },
  }) },
});
runtimeSchema.properties.tools.items.properties.queryParameters = {
  type: 'array', minItems: 1, maxItems: 20, items: queryParameter,
};
runtimeSchema.properties.tools.items.properties.dateRange = dateRangeSchema;
runtimeSchema.properties.gateway = object({
  tenantId: uuid, audience: uuid, principalId: uuid, role: { const: 'Mcp.Gateway' },
  publicUrl: { type: 'string', pattern: '^https://[a-z][a-z0-9-]+\\.azure-api\\.net/[a-z][a-z0-9-]+/mcp$' },
});
runtimeSchema.properties.backendAuthentication = {
  type: 'object', additionalProperties: false, required: ['type'],
  properties: { type: { const: 'api-key' }, ...apiKeyPlacementProperties }, oneOf: apiKeyPlacementChoice,
};
const ajv = new Ajv();
addFormats(ajv);
const validate = ajv.compile(runtimeSchema);
const validateOpenApiParameters = ajv.compile({ type: 'array', maxItems: 20, items: {
  type: 'object', additionalProperties: false, required: ['name', 'in', 'schema'], properties: {
    ...queryParameter.properties, in: { const: 'query' }, style: { const: 'form' },
    explode: { type: 'boolean' }, allowReserved: { const: false },
  },
} });
const guid = value => typeof value === 'string' ? value.toLowerCase() : value;
const canonicalCaller = value => ({ ...value, tenantId: guid(value.tenantId), audience: guid(value.audience),
  allowedClientIds: value.allowedClientIds.map(guid) });
const canonicalGateway = value => ({ ...value, tenantId: guid(value.tenantId), audience: guid(value.audience),
  principalId: guid(value.principalId) });
export function validateRuntimeConfig(value) {
  const config = structuredClone(value);
  if (!validate(config)) throw new Error('Invalid runtime configuration.');
  config.authentication = canonicalCaller(config.authentication);
  if (config.gateway) config.gateway = canonicalGateway(config.gateway);
  if (config.backendAuthentication) validateApiKeyPlacement(config.backendAuthentication);
  if (config.gateway && (config.gateway.tenantId !== config.authentication.tenantId
    || config.gateway.audience === config.authentication.audience)) throw new Error('Invalid independent gateway authentication.');
  const application = new URL(config.authentication.applicationIdUri);
  if (application.username || application.password || application.search || application.hash
    || /[\\<>"{}]/.test(config.authentication.applicationIdUri) || config.authentication.applicationIdUri.endsWith('/')) {
    throw new Error('Use the exact nonsecret Application ID URI, without a trailing slash.');
  }
  const origin = new URL(config.backendOrigin);
  if (origin.protocol !== 'https:' || config.backendOrigin !== origin.origin || origin.port
    || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(origin.hostname)
    || /(?:^|\.)(?:localhost|local|internal)$/.test(origin.hostname)) {
    throw new Error('Backend must be an explicit HTTPS DNS origin without credentials, path, query or port.');
  }
  if (new Set(config.tools.map(tool => tool.name)).size !== config.tools.length
    || config.tools.some(tool => tool.path.includes('//') || tool.path.split('/').some(part => ['.', '..'].includes(part)))) {
    throw new Error('Tools need unique names and fixed literal paths.');
  }
  for (const tool of config.tools) {
    validateQueryContract(tool, config.backendAuthentication);
    for (const parameter of tool.queryParameters ?? []) parameter.schema = boundedScalarSchema(parameter.schema);
  }
  return config;
}

export function toolDefinitions(config) {
  return config.tools.map(tool => ({
    name: tool.name, description: tool.description,
    inputSchema: { type: 'object', properties: Object.fromEntries((tool.queryParameters ?? []).map(parameter =>
      [parameter.name, { ...parameter.schema, ...(parameter.description ? { description: parameter.description } : {}) }])),
    additionalProperties: false,
    ...(tool.queryParameters ? {
      required: tool.queryParameters.filter(parameter => parameter.required).map(parameter => parameter.name),
      description: `Scalar query values only; no defaults or type coercion. Strings must be well-formed Unicode without control characters; dates must be real YYYY-MM-DD dates in years 0001-9999. Encoded query must not exceed ${queryLimit} characters.`
        + (tool.dateRange ? ` ${tool.dateRange.startParameter} must be on or before ${tool.dateRange.endParameter}; elapsed UTC calendar days must not exceed ${tool.dateRange.maxSpanDays}.` : ''),
    } : {}) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }));
}

export function createTokenVerifier(authentication, key) {
  authentication = canonicalCaller(authentication);
  const issuer = `https://login.microsoftonline.com/${authentication.tenantId}/v2.0`;
  const keys = key ?? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${authentication.tenantId}/discovery/v2.0/keys`),
    { timeoutDuration: 5000, cooldownDuration: 30000 });
  return async token => {
    const { payload } = await jwtVerify(token, keys, {
      issuer, audience: authentication.audience, algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'nbf', 'tid', 'oid', 'azp', 'scp', 'ver'],
      clockTolerance: 5,
    });
    if (payload.ver !== '2.0' || guid(payload.tid) !== authentication.tenantId
      || typeof payload.oid !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.oid)
      || typeof payload.scp !== 'string' || !payload.scp.split(' ').includes(authentication.scope)
      || !authentication.allowedClientIds.includes(guid(payload.azp))) {
      throw Object.assign(new Error('Caller lacks the required delegated access.'), { code: 'CALLER_FORBIDDEN' });
    }

    return payload;
  };
}

export function createGatewayVerifier(gateway, key) {
  gateway = canonicalGateway(gateway);
  const keys = key ?? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${gateway.tenantId}/discovery/v2.0/keys`),
    { timeoutDuration: 5000, cooldownDuration: 30000 });
  return async token => {
    const { payload } = await jwtVerify(token, keys, {
      issuer: `https://login.microsoftonline.com/${gateway.tenantId}/v2.0`, audience: gateway.audience,
      algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'nbf', 'tid', 'oid', 'roles', 'ver'], clockTolerance: 5,
    });
    if (payload.ver !== '2.0' || guid(payload.tid) !== gateway.tenantId || guid(payload.oid) !== gateway.principalId
      || payload.scp !== undefined || !Array.isArray(payload.roles) || !payload.roles.includes(gateway.role)) {
      throw Object.assign(new Error('Gateway identity is not permitted.'), { code: 'CALLER_FORBIDDEN' });
    }
    return payload;
  };
}

async function readBounded(stream, maximum) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > maximum) throw Object.assign(new Error('Payload exceeds the limit.'), { code: 'PAYLOAD_TOO_LARGE' });
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function resolveBackendCredential(config, env) {
  if (!config.backendAuthentication) return undefined;
  const credential = env[backendCredentialEnvironment];
  if (typeof credential !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(credential)
    || /@Microsoft\.KeyVault|keyvaultref:|identityref:|https?:\/\/|[<>]/i.test(credential)) {
    throw new Error('Backend API-key configuration is unavailable. Supply a resolved, nonempty credential through the dedicated environment variable.');
  }
  return credential;
}

function reflectsCredential(content, parsed, credential) {
  const normalizeEscapes = value => value.replace(/%[0-9a-f]{2}/gi, v => v.toUpperCase());
  const encoded = [encodeURIComponent(credential), new URLSearchParams({ v: credential }).toString().slice(2)];
  const variants = [credential, Buffer.from(credential).toString('base64'), Buffer.from(credential).toString('base64url')];
  const contains = value => variants.some(secret => value.includes(secret))
    || encoded.some(secret => normalizeEscapes(value).includes(secret));
  if (contains(content)) return true;
  // Parsing exposes JSON-escaped keys and values without recursive traversal of untrusted JSON.
  const pending = [parsed];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string' && contains(value)) return true;
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (contains(key)) return true;
        pending.push(child);
      }
    }
  }
  return false;
}

export function createProtocolServer(value, { request = fetch, signal, env = process.env,
  log = event => process.stderr.write(`${JSON.stringify(event)}\n`) } = {}) {
  const config = validateRuntimeConfig(value);
  const credential = resolveBackendCredential(config, env);
  const server = new Server({ name: config.name, version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions(config) }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const tool = config.tools.find(item => item.name === params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, 'Select a listed tool and supply an empty arguments object.');
    let args;
    try { args = validateToolArguments(tool, params.arguments); }
    catch {
      throw new McpError(ErrorCode.InvalidParams, tool.queryParameters
        ? 'Invalid tool arguments.' : 'Select a listed tool and supply an empty arguments object.');
    }
    let failureKind = 'request';
    let httpStatus, timeout, requestSignal;
    try {
      const url = new URL(`${config.backendOrigin}${tool.path}`);
      for (const [name, value] of Object.entries(args)) url.searchParams.set(name, String(value));
      const headers = { accept: 'application/json' };
      if (credential !== undefined) {
        const auth = config.backendAuthentication;
        if (auth.headerName) headers[auth.headerName] = credential;
        else url.searchParams.set(auth.queryParameterName, credential);
      }
      if (url.href.length > 24576) throw new Error('Backend URL exceeds the limit.');
      timeout = AbortSignal.timeout(10000);
      requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await request(url.href, {
        method: 'GET', redirect: 'error', headers,
        signal: requestSignal,
      });
      if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) httpStatus = response.status;
      if (!response.ok || response.redirected || !/^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
        failureKind = response.redirected ? 'redirect' : !response.ok ? 'http-status' : 'content-type';
        await response.body?.cancel();
        throw new Error('Backend rejected the call or did not return JSON.');
      }
      if (Number(response.headers.get('content-length')) > 1048576) {
        failureKind = 'response-too-large';
        await response.body?.cancel();
        throw new Error('Backend response exceeds the limit.');
      }
      failureKind = 'response-empty';
      if (!response.body) throw new Error('Backend returned no response body.');
      failureKind = 'response-read';
      const content = await readBounded(response.body, 1048576);
      failureKind = 'invalid-json';
      const parsed = JSON.parse(content);
      failureKind = 'credential-reflection';
      if (credential !== undefined && reflectsCredential(content, parsed, credential)) {
        throw new Error('Backend response contains credential material.');
      }
      return { content: [{ type: 'text', text: content }] };
    } catch (error) {
      if (['request', 'response-read'].includes(failureKind) && requestSignal?.aborted) {
        failureKind = timeout.aborted && requestSignal.reason === timeout.reason ? 'timeout' : 'cancelled';
      } else if (failureKind === 'response-read' && error?.code === 'PAYLOAD_TOO_LARGE') {
        failureKind = 'response-too-large';
      }
      log({ event: 'backend-call-failed', tool: tool.name, failureKind,
        ...(httpStatus === undefined ? {} : { httpStatus }) });
      return { isError: true, content: [{ type: 'text',
        text: 'The backend call failed or returned an unsupported response. No retry was performed; execution may have occurred.' }] };
    }
  });
  return server;
}

export function resolveServerSettings(env) {
  const functions = env.MCP_HOST_PLATFORM === 'functions';
  const port = Number((functions ? env.FUNCTIONS_CUSTOMHANDLER_PORT : undefined) ?? env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
  if (env.MCP_HOST_PLATFORM !== undefined && !['app-service', 'functions'].includes(env.MCP_HOST_PLATFORM)) throw new Error('Unsupported hosting platform.');
  let publicUrl = env.PUBLIC_MCP_URL;
  if (!publicUrl && ['app-service', 'functions'].includes(env.MCP_HOST_PLATFORM)) {
    if (!/^[a-z0-9][a-z0-9.-]*\.azurewebsites\.net$/.test(env.WEBSITE_HOSTNAME ?? '')) {
      throw new Error('An actual platform-provided WEBSITE_HOSTNAME is required.');
    }
    publicUrl = `https://${env.WEBSITE_HOSTNAME}/mcp`;
  }
  if (!publicUrl) throw new Error('PUBLIC_MCP_URL is required.');
  return { port, publicUrl };
}

const tokenErrors = new Set(['ERR_JWT_EXPIRED', 'ERR_JWT_CLAIM_VALIDATION_FAILED', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWS_INVALID', 'ERR_JWT_INVALID', 'ERR_JOSE_ALG_NOT_ALLOWED', 'ERR_JWKS_NO_MATCHING_KEY']);

export function createRequestHandler(value, publicUrl, dependencies = {}) {
  const config = validateRuntimeConfig(value);
  const credential = resolveBackendCredential(config, dependencies.env ?? process.env);
  const endpoint = new URL(publicUrl);
  if (endpoint.pathname !== '/mcp' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password
    || !(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname))) {
    throw new Error('PUBLIC_MCP_URL must be the HTTPS /mcp endpoint, or HTTP loopback for local development.');
  }
  const log = dependencies.log ?? (event => process.stderr.write(`${JSON.stringify(event)}\n`));
  const verify = dependencies.verify ?? createTokenVerifier(config.authentication);
  const verifyGateway = config.gateway ? dependencies.verifyGateway ?? createGatewayVerifier(config.gateway) : undefined;
  const advertised = config.gateway ? new URL(config.gateway.publicUrl) : endpoint;
  const metadataUrl = new URL('.well-known/oauth-protected-resource', advertised.href.replace(/mcp$/, '')).href;
  let windowStart = performance.now(), count = 0, active = 0;
  return async (req, res) => {
    const send = (status, error, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
      res.end(JSON.stringify({ error }));
    };
    try {
      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":"up"}'); return;
      }
      if (req.headers.host !== endpoint.host || req.headers.origin !== undefined && req.headers.origin !== advertised.origin) {
        send(403, 'Host or Origin is not allowed.'); return;
      }
      if (req.url === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ resource: advertised.href,
          authorization_servers: [`https://login.microsoftonline.com/${config.authentication.tenantId}/v2.0`],
          scopes_supported: [`${config.authentication.applicationIdUri}/${config.authentication.scope}`], bearer_methods_supported: ['header'] }));
        return;
      }
      if (req.url !== '/mcp') { send(404, 'Not found.'); return; }
      if (req.method !== 'POST') { send(405, 'This stateless server supports POST only.', { allow: 'POST' }); return; }
      if (performance.now() - windowStart >= 60000) { windowStart = performance.now(); count = 0; }
      if (++count > config.requestsPerMinute || active >= 20) {
        send(429, 'Request limit reached.', { 'retry-after': '60' }); return;
      }
      active++;
      try {
        if (verifyGateway) {
          const proof = req.headers['x-copilot-mcp-gateway-authorization'];
          if (typeof proof !== 'string' || proof.length > 16384 || !proof.startsWith('Bearer ') || proof.length <= 7) {
            send(401, 'A signed APIM gateway token is required.'); return;
          }
          try { await verifyGateway(proof.slice(7)); }
          catch (error) {
            const rejected = error.code === 'CALLER_FORBIDDEN' || tokenErrors.has(error.code);
            log({ event: rejected ? 'gateway-authentication-rejected' : 'gateway-authentication-unavailable' });
            send(rejected ? 403 : 503, rejected ? 'Gateway identity is not permitted.' : 'Gateway validation is unavailable.'); return;
          }
        }
        const challenge = { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"` };
        const authorization = req.headers.authorization;
        if (typeof authorization !== 'string' || authorization.length > 16384 || !/^Bearer [A-Za-z0-9._-]+$/.test(authorization)) {
          send(401, 'A valid delegated Entra access token is required.', challenge); return;
        }
        try { await verify(authorization.slice(7)); }
        catch (error) {
          const forbidden = error.code === 'CALLER_FORBIDDEN';
          const invalid = tokenErrors.has(error.code);
          log({ event: forbidden || invalid ? 'authentication-rejected' : 'authentication-unavailable' });
          send(forbidden ? 403 : invalid ? 401 : 503,
            forbidden ? 'Caller is not permitted.' : invalid ? 'Invalid access token.' : 'Token validation is unavailable.',
            invalid ? challenge : {}); return;
        }
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')
          || req.headers['content-encoding'] !== undefined) { send(415, 'Use uncompressed application/json.'); return; }
        if (Number(req.headers['content-length']) > 65536) { send(413, 'Request exceeds 64 KiB.'); return; }
        let body;
        try { body = JSON.parse(await readBounded(req, 65536)); }
        catch (error) { send(error.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, 'Invalid or oversized JSON request.'); return; }
        if (!body || Array.isArray(body) || typeof body !== 'object') { send(400, 'Use one JSON-RPC object, not a batch.'); return; }
        const controller = new AbortController();
        const server = createProtocolServer(config, { ...dependencies, log, signal: controller.signal,
          env: { [backendCredentialEnvironment]: credential } });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.once('close', () => {
          controller.abort();
          void server.close().catch(() => log({ event: 'transport-close-failed' }));
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } finally { active--; }
    } catch {
      log({ event: 'request-failed' });
      if (!res.headersSent) send(500, 'Request failed. No retry was performed.');
      else res.destroy();
    }
  };
}
