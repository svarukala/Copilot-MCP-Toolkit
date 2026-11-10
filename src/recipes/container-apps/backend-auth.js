import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createHash, createPrivateKey, createPublicKey, randomBytes, X509Certificate } from 'node:crypto';
import { SignJWT } from 'jose';

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const text = { type: 'string', minLength: 1, maxLength: 2048, pattern: '^[^\\s\\u0000-\\u001f\\u007f]+$' };
const uuid = { type: 'string', format: 'uuid' };
export const oauthProfiles = ['oauth-client-credentials-v1', 'oauth-authorization-code-v1', 'entra-obo-v1'];
export const credentialSchema = object({
  method: { enum: ['client_secret_basic', 'client_secret_post', 'private_key_jwt'] },
  keyId: { ...text, maxLength: 128 },
}, ['method']);
export const oauthSettingsSchema = object({
  schemaVersion: { const: 1 }, issuer: text, tokenEndpoint: text, clientId: { ...text, maxLength: 200 },
  scopes: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { ...text, maxLength: 512 } },
  resource: text, credential: credentialSchema,
  authorizationEndpoint: text, redirectUri: text, revocationEndpoint: text,
  sharedAccessReviewed: { const: true }, consentReviewed: { const: true },
  portal: object({ clientId: uuid, credential: credentialSchema, publicBaseUrl: text }),
}, ['schemaVersion', 'issuer', 'tokenEndpoint', 'clientId', 'scopes', 'credential']);
const ajv = new Ajv(); addFormats(ajv);
const validSettings = ajv.compile(oauthSettingsSchema);
export const authEnvironment = 'MCP_BACKEND_CLIENT_CREDENTIAL';
export const portalEnvironment = 'MCP_PORTAL_CLIENT_CREDENTIAL';
export const pilotLimits = Object.freeze({ connections: 100, transactions: 100, transactionMs: 300000,
  sessionMs: 900000, skewMs: 60000, exchangeMs: 10000, responseBytes: 65536 });
export const randomId = () => randomBytes(32).toString('base64url');
export const pkce = verifier => createHash('sha256').update(verifier).digest('base64url');
export function authError(code = 'BACKEND_AUTHENTICATION_FAILED') {
  return Object.assign(new Error('Backend authorization is unavailable. No retry was performed.'), { code });
}
const requireAuth = (ok, code) => { if (!ok) throw authError(code); };
export function httpsEndpoint(value) {
  let u;
  try { u = new URL(value); } catch { throw authError('AUTH_CONFIGURATION_INVALID'); }
  requireAuth(u.protocol === 'https:' && u.href === value && !u.username && !u.password && !u.search && !u.hash && !u.port
    && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(u.hostname)
    && !/(?:^|\.)(localhost|local|internal)$/.test(u.hostname), 'AUTH_CONFIGURATION_INVALID');
  return u;
}
export function validateOAuthSettings(profile, value, authentication) {
  requireAuth(oauthProfiles.includes(profile) && validSettings(value), 'AUTH_CONFIGURATION_INVALID');
  for (const key of ['issuer', 'tokenEndpoint', 'authorizationEndpoint', 'redirectUri', 'revocationEndpoint']) {
    if (value[key]) httpsEndpoint(value[key]);
  }
  requireAuth(value.scopes.every(s => !/[\u0000-\u0020\u007f]/.test(s)), 'AUTH_CONFIGURATION_INVALID');
  requireAuth(value.credential.method === 'private_key_jwt' ? Boolean(value.credential.keyId) : !value.credential.keyId,
    'AUTH_CONFIGURATION_INVALID');
  if (profile === 'oauth-client-credentials-v1') {
    requireAuth(value.sharedAccessReviewed === true && !value.portal && !value.authorizationEndpoint && !value.redirectUri
      && !value.revocationEndpoint && !value.consentReviewed && !value.scopes.includes('offline_access'), 'AUTH_CONFIGURATION_INVALID');
  } else if (profile === 'oauth-authorization-code-v1') {
    requireAuth(value.portal && value.authorizationEndpoint && value.redirectUri && value.consentReviewed === true
      && !value.sharedAccessReviewed, 'AUTH_CONFIGURATION_INVALID');
    httpsEndpoint(`${value.portal.publicBaseUrl}/`);
    requireAuth(!value.portal.publicBaseUrl.endsWith('/') && value.redirectUri === `${value.portal.publicBaseUrl}/auth/provider/callback`
      && authentication.allowedClientIds.includes(value.portal.clientId)
      && value.portal.clientId.toLowerCase() !== authentication.audience.toLowerCase()
      && (value.portal.credential.method === 'private_key_jwt' ? Boolean(value.portal.credential.keyId) : !value.portal.credential.keyId)
      && value.portal.credential.method !== 'client_secret_basic', 'AUTH_CONFIGURATION_INVALID');
  } else {
    requireAuth(value.clientId === authentication.audience && value.issuer === `https://login.microsoftonline.com/${authentication.tenantId}/v2.0`
      && value.tokenEndpoint === `https://login.microsoftonline.com/${authentication.tenantId}/oauth2/v2.0/token`
      && value.resource && value.resource !== authentication.audience && value.resource !== authentication.applicationIdUri
      && value.scopes.every(s => s.startsWith(`${value.resource}/`) && s.length > value.resource.length + 1)
      && !value.scopes.some(s => /(?:^|\/)(?:\.default|offline_access)$/.test(s))
      && value.credential.method !== 'client_secret_basic' && value.consentReviewed === true
      && !value.portal && !value.authorizationEndpoint && !value.redirectUri && !value.revocationEndpoint
      && !value.sharedAccessReviewed, 'AUTH_CONFIGURATION_INVALID');
  }
  return value;
}

export function loadCredential(settings, material, now = Date.now()) {
  requireAuth(typeof material === 'string' && material.length > 0 && material.length <= 32768
    && !/@Microsoft\.KeyVault|keyvaultref:|identityref:/i.test(material), 'AUTH_CREDENTIAL_UNAVAILABLE');
  if (settings.method !== 'private_key_jwt') {
    requireAuth(material.length <= 4096 && !/[\u0000-\u0020\u007f]/.test(material), 'AUTH_CREDENTIAL_UNAVAILABLE');
    return { secret: material };
  }
  try {
    const pair = JSON.parse(material);
    requireAuth(Object.keys(pair).sort().join(',') === 'certificatePem,privateKeyPem');
    const certificate = new X509Certificate(pair.certificatePem);
    const privateKey = createPrivateKey(pair.privateKeyPem);
    requireAuth(privateKey.asymmetricKeyType === 'rsa' && privateKey.asymmetricKeyDetails.modulusLength >= 2048
      && certificate.checkPrivateKey(privateKey) && Date.parse(certificate.validFrom) <= now
      && Date.parse(certificate.validTo) > now + pilotLimits.skewMs, 'AUTH_CREDENTIAL_UNAVAILABLE');
    return { privateKey, expiresAt: Date.parse(certificate.validTo),
      thumbprint: createHash('sha256').update(certificate.raw).digest('base64url'),
      publicKey: createPublicKey(privateKey), material, privateMaterial: pair.privateKeyPem };
  } catch { throw authError('AUTH_CREDENTIAL_UNAVAILABLE'); }
}

export async function readAuthJson(response) {
  requireAuth(response.body && !response.redirected && /^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')
    && Number(response.headers.get('content-length') ?? 0) <= pilotLimits.responseBytes, 'AUTH_RESPONSE_INVALID');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireAuth(size <= pilotLimits.responseBytes, 'AUTH_RESPONSE_INVALID');
      chunks.push(Buffer.from(value));
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requireAuth(value && typeof value === 'object' && !Array.isArray(value), 'AUTH_RESPONSE_INVALID');
    return value;
  } finally { await reader.cancel(); }
}

export function createOAuthClient(settings, material, { request = fetch, now = Date.now, entra = false, oidc = false } = {}) {
  const credential = loadCredential(settings.credential, material, now());
  const sensitive = new Set([material, credential.privateMaterial].filter(Boolean));
  const authenticate = async (endpoint, form) => {
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    form.set('client_id', settings.clientId);
    if (settings.credential.method === 'client_secret_basic') {
      const encode = s => new URLSearchParams({ v: s }).toString().slice(2);
      headers.authorization = `Basic ${Buffer.from(`${encode(settings.clientId)}:${encode(credential.secret)}`).toString('base64')}`;
      sensitive.add(headers.authorization);
    } else if (settings.credential.method === 'client_secret_post') form.set('client_secret', credential.secret);
    else {
      requireAuth(credential.expiresAt > now() + pilotLimits.skewMs, 'AUTH_CREDENTIAL_EXPIRED');
      const assertion = await new SignJWT({}).setProtectedHeader(entra
        ? { alg: 'PS256', typ: 'JWT', 'x5t#S256': credential.thumbprint }
        : { alg: 'RS256', typ: 'JWT', kid: settings.credential.keyId })
        .setIssuer(settings.clientId).setSubject(settings.clientId).setAudience(endpoint)
        .setIssuedAt(Math.floor(now() / 1000)).setExpirationTime(Math.floor(now() / 1000) + 60).setJti(randomId())
        .sign(credential.privateKey);
      form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
      form.set('client_assertion', assertion);
    }
    return headers;
  };
  const post = async (endpoint, values, signal, revoke = false) => {
    let response;
    try {
      const form = new URLSearchParams(values);
      const headers = await authenticate(endpoint, form);
      requireAuth(!signal?.aborted, 'AUTH_CANCELLED');
      const timeout = AbortSignal.timeout(pilotLimits.exchangeMs);
      response = await request(endpoint, { method: 'POST', redirect: 'error', headers, body: form.toString(),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (revoke) {
        requireAuth(response.status === 200 && !response.redirected, 'AUTH_REVOCATION_UNKNOWN');
        return;
      }
      const result = await readAuthJson(response);
      if (!response.ok || result.error) {
        const code = ['invalid_grant', 'interaction_required', 'consent_required', 'invalid_client'].includes(result.error)
          ? `AUTH_${result.error.toUpperCase()}` : 'AUTH_EXCHANGE_REJECTED';
        throw authError(code);
      }
      return result;
    } catch (error) {
      throw authError(/^AUTH_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'AUTH_EXCHANGE_UNKNOWN');
    } finally { if (response?.body && !response.body.locked) await response.body.cancel(); }
  };
  return {
    sensitive,
    async acquire(values, signal) {
      const result = await post(settings.tokenEndpoint, {
        scope: settings.scopes.join(' '), ...(settings.resource && !entra ? { resource: settings.resource } : {}), ...values,
      }, signal);
      requireAuth(typeof result.access_token === 'string' && /^[A-Za-z0-9\-._~+/]+=*$/.test(result.access_token)
        && result.access_token.length <= 16384 && /^Bearer$/i.test(result.token_type ?? '')
        && Number.isInteger(result.expires_in) && result.expires_in > 60 && result.expires_in <= 86400
        && (result.refresh_token === undefined || typeof result.refresh_token === 'string'
          && result.refresh_token.length > 0 && result.refresh_token.length <= 16384 && !/[\u0000-\u0020\u007f]/.test(result.refresh_token)),
      'AUTH_RESPONSE_INVALID');
      requireAuth(![...sensitive].some(secret => result.access_token.includes(secret)
        || result.refresh_token?.includes(secret)), 'AUTH_RESPONSE_INVALID');
      if (result.scope !== undefined) {
        requireAuth(typeof result.scope === 'string', 'AUTH_SCOPE_MISMATCH');
        const scopes = result.scope.split(' ').filter(s => !oidc || s !== 'openid');
        requireAuth(scopes.length === settings.scopes.length && new Set(scopes).size === scopes.length
          && scopes.every(s => settings.scopes.includes(s)), 'AUTH_SCOPE_MISMATCH');
      }
      return { access: result.access_token, refresh: result.refresh_token,
        idToken: result.id_token, expiresAt: now() + result.expires_in * 1000 };
    },
    async revoke(token, signal, hint = 'refresh_token') {
      requireAuth(settings.revocationEndpoint, 'AUTH_REVOCATION_UNSUPPORTED');
      requireAuth(typeof token === 'string' && token.length > 0, 'AUTH_REVOCATION_UNAVAILABLE');
      await post(settings.revocationEndpoint, { token, token_type_hint: hint }, signal, true);
    },
  };
}

export function callerKey(caller) {
  requireAuth(caller && /^[0-9a-f-]{36}$/i.test(caller.tid ?? '') && /^[0-9a-f-]{36}$/i.test(caller.oid ?? ''),
    'AUTH_CALLER_REQUIRED');
  return `${caller.tid.toLowerCase()}:${caller.oid.toLowerCase()}`;
}
export function createBackendAuthorization(config, dependencies = {}) {
  const { env = process.env, now = Date.now } = dependencies;
  const { type, settings } = config.backendAuthentication;
  validateOAuthSettings(type, settings, config.authentication);
  const client = createOAuthClient(settings, env[authEnvironment], { ...dependencies, entra: type === 'entra-obo-v1' });
  const entries = new Map(), pending = new Map();
  const clean = () => {
    for (const [key, entry] of entries) if (entry.until <= now() && !entry.blocked && !pending.has(key)) entries.delete(key);
  };
  const keyFor = caller => type === 'oauth-client-credentials-v1' ? 'application'
    : type === 'entra-obo-v1' ? `${callerKey(caller)}:${pkce(caller.assertion ?? '')}` : callerKey(caller);
  const reserve = key => {
    clean();
    requireAuth(entries.has(key) || entries.size < pilotLimits.connections, 'AUTH_CAPACITY');
  };
  return {
    client,
    connect(caller, token) {
      const key = callerKey(caller); reserve(key);
      requireAuth(!entries.has(key) && !pending.has(key), 'AUTH_ALREADY_CONNECTED');
      entries.set(key, { token, until: now() + pilotLimits.sessionMs });
    },
    connected(caller) { clean(); return entries.has(callerKey(caller)) && !entries.get(callerKey(caller)).blocked; },
    hasConnection(caller) { clean(); return entries.has(callerKey(caller)); },
    async disconnect(caller, revoke, signal) {
      const key = callerKey(caller), entry = entries.get(key);
      requireAuth(!pending.has(key), 'AUTH_OPERATION_PENDING');
      if (!entry) throw authError('AUTH_CONNECTION_REQUIRED');
      entries.delete(key);
      if (revoke) {
        const operation = client.revoke(entry.token?.refresh ?? entry.token?.access, signal,
          entry.token?.refresh ? 'refresh_token' : 'access_token');
        pending.set(key, operation);
        try { await operation; } finally { pending.delete(key); }
      }
    },
    reject(caller) {
      const entry = entries.get(keyFor(caller));
      if (entry) { entry.blocked = true; delete entry.token; }
    },
    async authorize(caller, signal) {
      const key = keyFor(caller); clean();
      let entry = entries.get(key);
      if (type === 'oauth-authorization-code-v1') requireAuth(entry, 'AUTH_CONNECTION_REQUIRED');
      if (!entry) {
        reserve(key);
        entry = { until: now() + pilotLimits.sessionMs };
        entries.set(key, entry);
      }
      requireAuth(!entry.blocked, 'AUTH_RECOVERY_REQUIRED');
      if (entry.token?.expiresAt > now() + pilotLimits.skewMs) return entry.token.access;
      if (!pending.has(key)) {
        const operation = (async () => {
          try {
            let values;
            if (type === 'oauth-authorization-code-v1') {
              requireAuth(entry.token?.refresh, 'AUTH_RECONNECT_REQUIRED');
              values = { grant_type: 'refresh_token', refresh_token: entry.token.refresh };
            } else if (type === 'entra-obo-v1') {
              requireAuth(typeof caller?.assertion === 'string' && caller.assertion.length > 0, 'AUTH_CALLER_REQUIRED');
              values = { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                requested_token_use: 'on_behalf_of', assertion: caller.assertion };
            } else values = { grant_type: 'client_credentials' };
            const token = await client.acquire(values, signal);
            requireAuth(entry.until > now(), 'AUTH_RECONNECT_REQUIRED');
            if (type === 'oauth-authorization-code-v1') token.refresh ??= entry.token.refresh;
            else delete token.refresh;
            delete token.idToken;
            entry.token = token;
            return token.access;
          } catch (error) { entry.blocked = true; delete entry.token; throw error; }
        })();
        pending.set(key, operation);
        operation.then(() => pending.delete(key), () => pending.delete(key));
      }
      return pending.get(key);
    },
  };
}
