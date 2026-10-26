import { PublicClientApplication } from '@azure/msal-node';

import { publicHttpsTransport } from './anonymous-network.js';

import { probeMcp, safeMcpDiagnostics } from './mcp-protocol.js';

import { cliStage } from './cli-feedback.js';

import { anonymousLimits, boundedSnapshot, requireMetadata } from './anonymous-metadata.js';

export function safeEntraDiagnostics(value) {
  const rpc = value && (value.rpcMethod !== undefined || value.rpcStage !== undefined || value.toolSchemaIssue !== undefined)
    ? safeMcpDiagnostics({ rpcMethod: value.rpcMethod, rpcStage: value.rpcStage,
      ...(value.toolSchemaIssue === undefined ? {} : { toolSchemaIssue: value.toolSchemaIssue }),
      ...(value.httpStatus === undefined ? {} : { httpStatus: value.httpStatus }) }) : undefined;
  if (!value || !['authority', 'device-code', 'token', 'metadata'].includes(value.authStage)
    || !['transport', 'timeout', 'http-status', 'oauth-error-response', 'response-shape', 'sdk'].includes(value.failureKind)
    || Object.keys(value).some(key => !['authStage', 'failureKind', 'httpStatus', 'rpcMethod', 'rpcStage', 'toolSchemaIssue'].includes(key))
    || (value.rpcMethod !== undefined || value.rpcStage !== undefined || value.toolSchemaIssue !== undefined) && (!rpc || value.authStage !== 'metadata')
    || (value.httpStatus !== undefined && (!Number.isInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599))) return undefined;
  return Object.freeze({ authStage: value.authStage, failureKind: value.failureKind,
    ...(value.httpStatus === undefined ? {} : { httpStatus: value.httpStatus }),
    ...(rpc ? { rpcMethod: rpc.rpcMethod, rpcStage: rpc.rpcStage,
      ...(rpc.toolSchemaIssue === undefined ? {} : { toolSchemaIssue: rpc.toolSchemaIssue }) } : {}) });
}

function authorityPolicy(plan) {
  return (endpoint, options) => {
    const url = new URL(endpoint);
    requireMetadata(endpoint === url.href && url.origin === 'https://login.microsoftonline.com'
      && !url.username && !url.password && !url.hash, 'NETWORK_BLOCKED');
    const base = `/${plan.auth.tenantId}`;
    const pathAllowed = options.method === 'GET'
      ? url.pathname === `${base}/v2.0/.well-known/openid-configuration`
      : [`${base}/oauth2/v2.0/devicecode`, `${base}/oauth2/v2.0/token`].includes(url.pathname);
    const query = [...url.searchParams];
    requireMetadata(pathAllowed && (query.length === 0 || (url.pathname === `${base}/oauth2/v2.0/token`
      && query.length === 1 && query[0][0] === 'client-request-id'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query[0][1]))), 'NETWORK_BLOCKED');
    return url;
  };
}

async function boundedResponse(response, budget) {
  const reader = response.body?.getReader();
  requireMetadata(reader, 'AUTHENTICATION_FAILED');
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      budget.bytes += item.value.byteLength;
      requireMetadata(bytes <= 262144 && budget.bytes <= 4194304, 'LIMIT');
      chunks.push(Buffer.from(item.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel(); }
}

// Internal seam for offline transport fixtures. No public export accepts transport or authentication providers.
export function msalNetwork(plan, signal, transport = publicHttpsTransport({
  requestPolicy: authorityPolicy(plan), allowErrorStatus: true,
}), state = { sensitive: new Set() }) {
  const budget = { bytes: 0, requests: 0 };
  const send = async (method, endpoint, options = {}) => {
    delete state.failure;
    const authStage = method === 'GET' ? 'authority' : new URL(endpoint).pathname.endsWith('/devicecode') ? 'device-code' : 'token';
    state.diagnostics = { authStage, failureKind: 'transport' };
    authorityPolicy(plan)(endpoint, { method });
    requireMetadata(!signal.aborted && ++budget.requests <= 650, 'AUTHENTICATION_FAILED');
    if (method === 'POST') {
      requireMetadata(typeof options.body === 'string' && Buffer.byteLength(options.body) <= 32768, 'LIMIT');
      const form = new URLSearchParams(options.body);
      const scopes = form.get('scope')?.split(' ');
      requireMetadata(form.getAll('client_id').length === 1 && form.get('client_id') === plan.auth.discoveryClientId
        && form.getAll('scope').length === 1 && scopes?.length === plan.auth.scopes.length
        && new Set(scopes).size === scopes.length && scopes.every(scope => plan.auth.scopes.includes(scope))
        && !['client_secret', 'client_assertion', 'refresh_token', 'password', 'assertion'].some(key => form.has(key)),
      'AUTH_CONFIG_INVALID');
    }
    const deadline = AbortSignal.timeout(15000);
    const requestSignal = AbortSignal.any([signal, deadline]);
    let response;
    let body;
    try {
      response = await transport(endpoint, {
        method, redirect: 'error', signal: requestSignal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        ...(method === 'POST' ? { body: options.body } : {}),
      });
      state.diagnostics = { authStage, failureKind: 'http-status', httpStatus: response.status };
      if (![200, 400].includes(response.status)) {
        await response.body?.cancel();
        requireMetadata(false, 'AUTHENTICATION_FAILED');
      }
      state.diagnostics.failureKind = 'response-shape';
      body = await boundedResponse(response, budget);
    } catch (error) {
      if (deadline.aborted && !signal.aborted) state.diagnostics = { authStage, failureKind: 'timeout' };
      else if (Number.isInteger(error.httpStatus)) state.diagnostics = { authStage, failureKind: 'http-status', httpStatus: error.httpStatus };
      throw error;
    }
    requireMetadata(body && typeof body === 'object' && !Array.isArray(body), 'AUTHENTICATION_FAILED');
    requireMetadata(response.status === 200 || (response.status === 400 && typeof body.error === 'string'), 'AUTHENTICATION_FAILED');
    if (Object.hasOwn(body, 'error')) {
      state.diagnostics.failureKind = typeof body.error === 'string' && body.error.length > 0 ? 'oauth-error-response' : 'response-shape';
      requireMetadata(authStage === 'token' && response.status === 400 && body.error === 'authorization_pending', 'AUTHENTICATION_FAILED');
    }
    // RFC 8628 section 3.2: omitted interval defaults to five seconds. MSAL 7 does not supply this default.
    if (authStage === 'device-code' && response.status === 200 && !Object.hasOwn(body, 'interval')) body.interval = 5;
    for (const key of ['access_token', 'id_token', 'refresh_token', 'device_code', 'user_code', 'client_info']) {
      if (typeof body[key] === 'string' && body[key]) state.sensitive.add(body[key]);
    }
    state.diagnostics.failureKind = 'sdk';
    return { status: response.status, headers: {}, body };
  };
  const guardedSend = async (...args) => {
    try { return await send(...args); }
    catch (error) {
      state.failure = ['NETWORK_BLOCKED', 'LIMIT', 'AUTH_CONFIG_INVALID'].includes(error.code) ? error.code : 'AUTHENTICATION_FAILED';
      throw error;
    }
  };
  return {
    sendGetRequestAsync: (url, options) => guardedSend('GET', url, options),
    sendPostRequestAsync: (url, options) => guardedSend('POST', url, options),
  };
}

function deviceChallenge(response, deadline, now) {
  requireMetadata(['https://microsoft.com/devicelogin', 'https://www.microsoft.com/devicelogin',
    'https://login.microsoftonline.com/common/oauth2/deviceauth', 'https://login.microsoft.com/device'].includes(response.verificationUri)
    && typeof response.userCode === 'string' && /^[A-Z0-9-]{6,32}$/.test(response.userCode)
    && typeof response.deviceCode === 'string' && response.deviceCode.length > 0 && response.deviceCode.length <= 8192
    && Number.isInteger(response.expiresIn) && response.expiresIn > 0 && response.expiresIn <= 1800
    && Number.isInteger(response.interval) && response.interval >= 1 && response.interval <= 15, 'AUTHENTICATION_FAILED');
  return { verificationUri: response.verificationUri, userCode: response.userCode,
    expiresAt: new Date(Math.min(deadline, now + response.expiresIn * 1000)).toISOString() };
}

function validToken(result, plan, now) {
  requireMetadata(result && result.tenantId?.toLowerCase() === plan.auth.tenantId
    && result.account?.tenantId?.toLowerCase() === plan.auth.tenantId
    && result.tokenType?.toLowerCase() === 'bearer'
    && typeof result.accessToken === 'string' && result.accessToken.length > 0 && result.accessToken.length <= 65536
    && /^[A-Za-z0-9._~+/-]+=*$/.test(result.accessToken), 'AUTHENTICATION_REJECTED');
  if (plan.auth.expectedUserId !== undefined) {
    requireMetadata(result.account?.localAccountId?.toLowerCase() === plan.auth.expectedUserId,
      'AUTHENTICATION_REJECTED');
    if (result.accessToken.split('.').length === 3) {
      let claims;
      try { claims = JSON.parse(Buffer.from(result.accessToken.split('.')[1], 'base64url')); }
      catch { requireMetadata(false, 'AUTHENTICATION_REJECTED'); }
      // Disclosure guard only: cryptographic validation belongs to the endpoint.
      requireMetadata(claims.tid?.toLowerCase() === plan.auth.tenantId
        && (claims.azp ?? claims.appid)?.toLowerCase() === plan.auth.discoveryClientId
        && claims.oid?.toLowerCase() === plan.auth.expectedUserId
        && [plan.source.inbound.clientId, plan.source.inbound.applicationIdUri].includes(claims.aud)
        && typeof claims.scp === 'string' && claims.scp.split(' ').includes(plan.source.inbound.scope)
        && Number.isFinite(claims.exp) && claims.exp * 1000 > now + plan.metadataTimeoutMs,
      'AUTHENTICATION_REJECTED');
    }
  }
  const expires = result.expiresOn?.getTime();
  requireMetadata(Number.isFinite(expires) && expires > now + plan.metadataTimeoutMs, 'TOKEN_EXPIRED');
  const requested = plan.auth.scopes[0];
  const leaf = requested.slice(requested.lastIndexOf('/') + 1);
  requireMetadata(Array.isArray(result.scopes) && result.scopes.some(scope => scope === requested || scope === leaf)
    && result.scopes.every(scope => [requested, leaf, 'openid', 'profile', 'offline_access'].includes(scope)), 'AUTHENTICATION_REJECTED');
  return expires;
}

async function discoverEndpoint(plan, { signal, onDeviceCode, toolCall, beforeRequest, beforeToolCall, beforeToolDispatch, assessToolResult }, dependencies = {}) {
  requireMetadata(typeof onDeviceCode === 'function', 'AUTH_CONFIG_INVALID');
  requireMetadata(!signal?.aborted, 'ABORTED');
  const now = dependencies.now ?? Date.now;
  const controller = new AbortController();
  const deadline = now() + plan.authTimeoutMs;
  let expired = false;
  const state = { sensitive: new Set(), diagnostics: { authStage: 'authority', failureKind: 'sdk' } };
  const request = { scopes: [...plan.auth.scopes], timeout: plan.authTimeoutMs / 1000, cancel: false,
    deviceCodeCallback: response => {
      requireMetadata(!controller.signal.aborted, 'ABORTED');
      state.diagnostics.failureKind = 'response-shape';
      const challenge = deviceChallenge(response, deadline, now());
      state.diagnostics = { authStage: 'device-code', failureKind: 'sdk' };
      try { onDeviceCode(challenge); cliStage('mcp-user'); }
      catch { requireMetadata(false, 'AUTHENTICATION_FAILED'); }
    } };
  const abort = () => { request.cancel = true; controller.abort(); };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { expired = true; abort(); }, dependencies.authTimeoutMs ?? plan.authTimeoutMs);
  let app;
  let result;
  let token;
  let authenticated = false;
  let callReturned = false;
  try {
    if (dependencies.session?.cached) {
      result = dependencies.session.cached;
      for (const value of dependencies.session.sensitive) state.sensitive.add(value);
    } else {
      app = new PublicClientApplication({
        auth: { clientId: plan.auth.discoveryClientId, authority: plan.auth.authority },
        system: {
          networkClient: msalNetwork(plan, controller.signal, beforeRequest
            ? async (url, requestOptions) => {
              await beforeRequest();
              return (dependencies.authTransport ?? publicHttpsTransport({
                requestPolicy: authorityPolicy(plan), allowErrorStatus: true,
              }))(url, requestOptions);
            } : dependencies.authTransport, state),
          loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} },
        },
      });
      // Await SDK cancellation (including its bounded polling delay); never abandon a still-polling Promise.
      cliStage('mcp-auth', dependencies.authTimeoutMs ?? plan.authTimeoutMs);
      result = await app.acquireTokenByDeviceCode(request);
    }
    requireMetadata(!controller.signal.aborted, expired ? 'AUTHENTICATION_TIMEOUT' : 'ABORTED');
    clearTimeout(timer);
    state.diagnostics.failureKind = 'response-shape';
    const expires = validToken(result, plan, now());
    authenticated = true;
    token = result.accessToken;
    for (const value of [result.account?.username, result.account?.localAccountId, result.account?.homeAccountId]) {
      if (value) state.sensitive.add(value);
    }
    if (dependencies.session && !dependencies.session.cached) {
      dependencies.session.cached = {
        tenantId: result.tenantId, account: { tenantId: result.account.tenantId, localAccountId: result.account.localAccountId },
        tokenType: result.tokenType, accessToken: token, expiresOn: result.expiresOn, scopes: [...result.scopes],
      };
      dependencies.session.sensitive = new Set(state.sensitive);
    }
    result = undefined;
    await app?.clearCache();
    state.diagnostics = { authStage: 'metadata', failureKind: 'sdk' };
    const transport = dependencies.mcpTransport ?? publicHttpsTransport({ allowErrorStatus: true });
    const observed = await probeMcp(plan.target.endpoint, {
      signal, timeoutMs: dependencies.metadataTimeoutMs ?? plan.metadataTimeoutMs, maxBytes: anonymousLimits.responseBytes,
      maxTotalBytes: anonymousLimits.totalResponseBytes, maxPages: anonymousLimits.pages, returnMetadata: true,
      ...(toolCall === undefined ? {} : { toolCall, beforeToolCall, beforeToolDispatch, assessToolResult }),
      fetchImpl: async (endpoint, requestOptions) => {
        state.diagnostics = { authStage: 'metadata', failureKind: 'sdk' };
        requireMetadata(endpoint === plan.target.endpoint && !controller.signal.aborted, 'NETWORK_BLOCKED');
        requireMetadata(now() < expires, 'TOKEN_EXPIRED');
        await beforeRequest?.();
        state.diagnostics.failureKind = 'transport';
        const response = await transport(endpoint, { ...requestOptions,
          headers: { ...requestOptions.headers, Authorization: `Bearer ${token}` } });
        state.diagnostics = { authStage: 'metadata', failureKind: 'response-shape', httpStatus: response.status };
        if (!response.ok) state.diagnostics.failureKind = 'http-status';
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          requireMetadata(false, 'AUTHENTICATION_REJECTED');
        }
        return response;
      },
    });
    callReturned = observed.toolCall !== undefined;
    requireMetadata(!signal?.aborted, 'ABORTED');
    const text = JSON.stringify(observed.tools);
    requireMetadata(![...state.sensitive].some(value =>
      [value, encodeURIComponent(value), Buffer.from(value).toString('base64')].some(secret => text.includes(secret))), 'SENSITIVE_INPUT');
    return { tools: { tools: observed.tools },
      capturedAt: new Date(now()).toISOString(), protocolVersion: observed.protocolVersion, auth: plan.auth,
      ...(observed.toolCall === undefined ? {} : { toolCall: observed.toolCall }) };
  } catch (error) {
    const timeout = expired || error.message === 'Probe timeout.';
    const code = signal?.aborted ? 'ABORTED' : expired ? 'AUTHENTICATION_TIMEOUT'
      : error.name === 'AnonymousMetadataError' ? error.code
        : state.failure ?? (error.code === 'NETWORK_BLOCKED' ? 'NETWORK_BLOCKED'
          : timeout ? 'DISCOVERY_TIMEOUT' : authenticated ? 'DISCOVERY_FAILED' : 'AUTHENTICATION_FAILED');
    if (timeout) state.diagnostics = { authStage: state.diagnostics.authStage, failureKind: 'timeout' };
    else if (Number.isInteger(error.httpStatus)) state.diagnostics = {
      authStage: state.diagnostics.authStage, failureKind: 'http-status', httpStatus: error.httpStatus };
    const rpc = authenticated && state.diagnostics.authStage === 'metadata' ? safeMcpDiagnostics(error.rpcDiagnostics) : undefined;
    if (rpc) state.diagnostics = { ...state.diagnostics, ...rpc,
      ...(rpc.rpcStage === 'transport' && state.diagnostics.failureKind === 'http-status' ? { rpcStage: 'http-status' } : {}) };
    const failure = new Error(code);
    failure.name = 'AnonymousMetadataError';
    failure.code = code;
    failure.diagnostics = safeEntraDiagnostics(signal?.aborted
      ? { authStage: state.diagnostics.authStage, failureKind: 'sdk' } : state.diagnostics);
    if (error.invocationStatus === 'unknown' || callReturned) failure.invocationStatus = 'unknown';
    throw failure;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    abort();
    await app?.clearCache();
    result = undefined;
    token = undefined;
    app = undefined;
    state.sensitive.clear();
  }
}

// Internal shared transport runner; callers must validate and approve their endpoint plan first.
export const discoverEntraEndpoint = (plan, options) => discoverEndpoint(plan, options);

export const discoverEntraEndpointForTest = (plan, options, dependencies) => discoverEndpoint(plan, options, dependencies);

// Internal, one discovery followed by one independently approved proof; never a persistent MSAL cache.
export function createEntraDiscoverySession(dependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const state = { cached: undefined, sensitive: new Set() };
  const deadline = now() + 15 * 60 * 1000;
  const controller = new AbortController();
  let timer;
  let binding, calls = 0, busy = false, closed = false;
  const close = () => {
    closed = true;
    clearTimeout(timer);
    controller.abort();
    state.cached = undefined;
    state.sensitive.clear();
  };
  timer = setTimeout(close, 15 * 60 * 1000);
  timer.unref();
  return {
    close,
    async run(plan, options) {
      try {
        requireMetadata(!closed && !busy && calls < 2 && now() + plan.metadataTimeoutMs < deadline,
          'AUTH_SESSION_EXPIRED');
        requireMetadata(plan.auth.expectedUserId && (calls === 0 ? options.toolCall === undefined : options.toolCall !== undefined),
          'AUTH_CONFIG_INVALID');
        const next = JSON.stringify(boundedSnapshot({ auth: plan.auth, endpoint: plan.target.endpoint,
          sourceDigest: plan.source.descriptorDigest }));
        requireMetadata(binding === undefined || binding === next, 'AUTH_CONFIG_INVALID');
        binding = next;
        busy = true;
        calls++;
        return await discoverEndpoint(plan, { ...options, signal: options.signal
          ? AbortSignal.any([options.signal, controller.signal]) : controller.signal }, { ...dependencies, session: state });
      }
      catch (error) { close(); throw error; }
      finally { busy = false; if (calls === 2) close(); }
    },
  };
}
