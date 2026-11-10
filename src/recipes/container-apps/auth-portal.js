import { createRemoteJWKSet, jwtVerify } from 'jose';
import { authError, callerKey, createOAuthClient, pilotLimits, pkce, portalEnvironment, randomId } from './backend-auth.js';

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const theme = `:root{color-scheme:light;--cp-bg:#f7f4ef;--cp-bg-elevated:#fcfbf8;--cp-surface:#ffffff;--cp-surface-soft:#f5f5f5;--cp-border:#dedede;--cp-border-strong:#919191;--cp-text:#242424;--cp-text-muted:#5c5c5c;--cp-text-soft:#6f6f6f;--cp-accent:#b11f4b;--cp-accent-hover:#9a1a41;--cp-accent-soft:rgba(177,31,75,0.08);--cp-accent-fg:#ffffff;--cp-success:#16a34a;--cp-danger:#dc2626;--cp-warning:#f59e0b;--cp-link:#0078d4;--cp-shadow:0 18px 48px rgba(0,0,0,0.12);--cp-overlay:rgba(255,255,255,0.8);--cp-panel:rgba(255,255,255,0.86);--cp-panel-strong:rgba(255,255,255,0.96);--cp-sheen:rgba(255,255,255,0.55);--cp-highlight:rgba(177,31,75,0.12)}
html[data-theme="dark"]{color-scheme:dark;--cp-bg:#3d3b3a;--cp-bg-elevated:#343231;--cp-surface:#292929;--cp-surface-soft:#2e2e2e;--cp-border:#474747;--cp-border-strong:#5f5f5f;--cp-text:#dedede;--cp-text-muted:#919191;--cp-text-soft:#b0b0b0;--cp-accent:#fd8ea1;--cp-accent-hover:#fb7b91;--cp-accent-soft:rgba(253,142,161,0.14);--cp-accent-fg:#1a1a1a;--cp-success:#4ade80;--cp-danger:#f87171;--cp-warning:#fbbf24;--cp-link:#4da6ff;--cp-shadow:0 18px 48px rgba(0,0,0,0.32);--cp-overlay:rgba(41,41,41,0.88);--cp-panel:rgba(41,41,41,0.72);--cp-panel-strong:rgba(41,41,41,0.96);--cp-sheen:rgba(255,255,255,0.04);--cp-highlight:rgba(177,31,75,0.12)}`;
function page(nonce, content) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MCP backend connection</title><script nonce="${nonce}">(()=>{const param=new URLSearchParams(window.location.search).get("scoutTheme");const theme=param||(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.setAttribute("data-theme",theme)})();</script>
<style nonce="${nonce}">${theme}
body{background:var(--cp-bg);color:var(--cp-text);font:16px "Segoe UI",Aptos,Calibri,-apple-system,BlinkMacSystemFont,sans-serif;margin:32px auto;padding:16px;max-width:640px}main{background:var(--cp-surface);border:1px solid var(--cp-border);border-radius:16px;padding:24px}button{background:var(--cp-accent);color:var(--cp-accent-fg);border:0;border-radius:.625rem;padding:12px;margin:8px 0;cursor:pointer}a{color:var(--cp-link)}p{line-height:1.5}</style></head><body><main><h1>Backend account connection</h1>${content}</main></body></html>`;
}
const paths = new Set(['/auth', '/auth/login', '/auth/entra/callback', '/auth/provider/callback', '/auth/action']);
export function createAuthPortal(config, backend, dependencies) {
  const { now = Date.now, env = process.env, verify, log } = dependencies;
  const settings = config.backendAuthentication.settings, portal = settings.portal, a = config.authentication;
  const base = portal.publicBaseUrl, origin = new URL(base).origin;
  const issuer = `https://login.microsoftonline.com/${a.tenantId}/v2.0`;
  const tokenEndpoint = `https://login.microsoftonline.com/${a.tenantId}/oauth2/v2.0/token`;
  const scope = `${a.applicationIdUri}/${a.scope}`;
  const loginClient = createOAuthClient({ clientId: portal.clientId, credential: portal.credential,
    issuer, tokenEndpoint, scopes: [scope] }, env[portalEnvironment], { ...dependencies, entra: true, oidc: true });
  const keys = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${a.tenantId}/discovery/v2.0/keys`),
    { timeoutDuration: 5000, cooldownDuration: 30000 });
  const verifyId = dependencies.verifyPortalId ?? (async token => (await jwtVerify(token, keys, {
    issuer, audience: portal.clientId, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'nonce', 'tid', 'oid'],
  })).payload);
  const sessions = new Map(), transactions = new Map(), connecting = new Set();
  let inflightLogins = 0;
  const cookieName = `__Host-mcp-${pkce(`${base}:${portal.clientId}`).slice(0, 12)}`;
  const cookies = req => {
    const found = (req.headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${cookieName}=`));
    return found.length === 1 ? found[0].slice(cookieName.length + 1) : undefined;
  };
  const cookie = id => `${cookieName}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=900`;
  const clean = () => {
    for (const [id, s] of sessions) if (s.until <= now()) sessions.delete(id);
    for (const [id, t] of transactions) if (t.until <= now()) {
      transactions.delete(id);
      if (t.user) connecting.delete(t.user);
    }
  };
  const transaction = (kind, browser, extra = {}) => {
    if (transactions.size >= pilotLimits.transactions) throw authError('AUTH_CAPACITY');
    const state = randomId(), verifier = randomId(), nonce = randomId();
    transactions.set(state, { kind, browser, verifier, nonce, until: now() + pilotLimits.transactionMs, ...extra });
    return { state, verifier, nonce };
  };
  return async (req, res) => {
    const url = new URL(req.url, origin);
    if (!paths.has(url.pathname)) return false;
    const nonce = randomId();
    const headers = { 'cache-control': 'no-store', pragma: 'no-cache', 'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; form-action 'self' ${settings.authorizationEndpoint}; frame-ancestors 'none'; base-uri 'none'` };
    const render = (status, content) => { res.writeHead(status, { ...headers, 'content-type': 'text/html; charset=utf-8' }); res.end(page(nonce, content)); };
    const redirect = (location, id) => { res.writeHead(303, { ...headers, location, ...(id ? { 'set-cookie': cookie(id) } : {}) }); res.end(); };
    let reservedLogin = false, completingUser;
    try {
      clean();
      if (req.headers.origin !== undefined && req.headers.origin !== origin) throw authError('AUTH_BROWSER_ORIGIN');
      if (req.method !== (url.pathname === '/auth/action' ? 'POST' : 'GET')) {
        render(405, '<p>Method not supported.</p>'); return true;
      }
      const browser = cookies(req), session = sessions.get(browser);
      if (url.pathname === '/auth') {
        if (!session) render(200, `<p>Sign in with your approved Entra account. Provider passwords are never collected here.</p><a href="${escape(base)}/auth/login">Sign in</a>`);
        else {
          const connected = backend.connected(session.caller);
          const retained = backend.hasConnection(session.caller);
          const form = (action, label) => `<form method="post" action="${escape(base)}/auth/action"><input type="hidden" name="csrf" value="${session.csrf}"><button name="action" value="${action}">${label}</button></form>`;
          render(200, `<p>${connected ? 'Connected for this Entra user.' : 'Not connected.'} Memory-only: restart or session expiry requires reconnection.</p>
<p>Provider: ${escape(settings.issuer)}<br>Scopes: ${escape(settings.scopes.join(' '))}</p>
<p>The provider controls account selection and permissions. This page does not attest a provider username.</p>
${retained ? form('disconnect', 'Disconnect locally (does not revoke at provider)')
    + (settings.revocationEndpoint ? form('revoke', 'Disconnect and send one provider revocation request') : '')
    : form('connect', 'Connect my provider account')}${form('logout', 'Sign out of this connection page')}`);
        }
      } else if (url.pathname === '/auth/login') {
        const browserId = randomId();
        const t = transaction('entra', browserId);
        const target = new URL(`https://login.microsoftonline.com/${a.tenantId}/oauth2/v2.0/authorize`);
        target.search = new URLSearchParams({ client_id: portal.clientId, response_type: 'code',
          redirect_uri: `${base}/auth/entra/callback`, scope: `openid ${scope}`, state: t.state, nonce: t.nonce,
          code_challenge: pkce(t.verifier), code_challenge_method: 'S256', response_mode: 'query' }).toString();
        redirect(target.href, browserId);
      } else if (url.pathname.endsWith('/callback')) {
        const kind = url.pathname === '/auth/entra/callback' ? 'entra' : 'provider';
        const state = url.searchParams.get('state'), tx = transactions.get(state);
        if (!tx || tx.kind !== kind || tx.browser !== browser
          || [...url.searchParams.keys()].some(k => url.searchParams.getAll(k).length !== 1)) throw authError('AUTH_CALLBACK_REJECTED');
        completingUser = tx.user;
        transactions.delete(state);
        const code = url.searchParams.get('code');
        if (url.searchParams.has('error') || !code || code.length > 8192 || /[\u0000-\u0020\u007f]/.test(code)) throw authError('AUTH_CALLBACK_REJECTED');
        if (kind === 'entra') {
          if (sessions.size + inflightLogins >= pilotLimits.connections) throw authError('AUTH_CAPACITY');
          inflightLogins++; reservedLogin = true;
          if (url.searchParams.has('iss') && url.searchParams.get('iss') !== issuer) throw authError('AUTH_CALLBACK_REJECTED');
          const token = await loginClient.acquire({ grant_type: 'authorization_code', code,
            redirect_uri: `${base}/auth/entra/callback`, code_verifier: tx.verifier, scope: `openid ${scope}` });
          const caller = await verify(token.access), claims = await verifyId(token.idToken);
          if (claims.nonce !== tx.nonce || claims.tid !== caller.tid || claims.oid !== caller.oid
            || caller.azp !== portal.clientId || !Number.isFinite(caller.exp) || !Number.isFinite(claims.exp)
            || Math.min(caller.exp, claims.exp) * 1000 <= now() + pilotLimits.skewMs || tx.until <= now()) throw authError('AUTH_LOGIN_REJECTED');
          const id = randomId();
          sessions.set(id, { caller: { tid: caller.tid, oid: caller.oid }, csrf: randomId(),
            until: Math.min(now() + pilotLimits.sessionMs, caller.exp * 1000, claims.exp * 1000) });
          redirect(`${base}/auth`, id);
        } else {
          completingUser = tx.user;
          if (!session || tx.user !== callerKey(session.caller) || url.searchParams.get('iss') !== settings.issuer
            || backend.connected(session.caller)) throw authError('AUTH_CALLBACK_REJECTED');
          const token = await backend.client.acquire({ grant_type: 'authorization_code', code,
            redirect_uri: settings.redirectUri, code_verifier: tx.verifier });
          delete token.idToken;
          if (tx.until <= now() || session.until <= now() || sessions.get(browser) !== session) throw authError('AUTH_BROWSER_SESSION');
          backend.connect(session.caller, token);
          redirect(`${base}/auth`);
        }
      } else {
        if (!session || req.headers.origin !== origin
          || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type'] ?? '')
          || req.headers['content-encoding'] !== undefined) throw authError('AUTH_BROWSER_SESSION');
        let body = '', bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 1024) throw authError('AUTH_BROWSER_REQUEST');
          body += chunk.toString('utf8');
        }
        const form = new URLSearchParams(body), action = form.get('action');
        if ([...form.keys()].sort().join(',') !== 'action,csrf' || form.get('csrf') !== session.csrf) throw authError('AUTH_CSRF_REJECTED');
        session.csrf = randomId();
        if (action === 'connect') {
          if (backend.connected(session.caller)) throw authError('AUTH_ALREADY_CONNECTED');
          const user = callerKey(session.caller);
          if (connecting.has(user)) throw authError('AUTH_OPERATION_PENDING');
          const t = transaction('provider', browser, { user });
          connecting.add(user);
          const target = new URL(settings.authorizationEndpoint);
          target.search = new URLSearchParams({ client_id: settings.clientId, response_type: 'code',
            redirect_uri: settings.redirectUri, scope: settings.scopes.join(' '), state: t.state,
            code_challenge: pkce(t.verifier), code_challenge_method: 'S256',
            ...(settings.resource ? { resource: settings.resource } : {}) }).toString();
          redirect(target.href);
        } else if (['disconnect', 'revoke'].includes(action)) {
          await backend.disconnect(session.caller, action === 'revoke');
          redirect(`${base}/auth`);
        } else if (action === 'logout') {
          sessions.delete(browser);
          redirect(`${base}/auth`, randomId());
        } else throw authError('AUTH_BROWSER_REQUEST');
      }
    } catch (error) {
      const code = /^AUTH_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'AUTH_CONNECTION_FAILED';
      log({ event: 'backend-connection-failed', code });
      render(400, `<p>Connection action failed (${escape(code)}). No retry was performed. A failed revocation may have removed the local connection without revoking provider access.</p><a href="${escape(base)}/auth">Return to connection page</a>`);
    } finally {
      if (reservedLogin) inflightLogins--;
      if (completingUser) connecting.delete(completingUser);
    }
    return true;
  };
}
