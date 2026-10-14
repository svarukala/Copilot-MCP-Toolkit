// Offline preload: exercises the real SDK and the production pinned HTTPS adapter, never a token-method mock.
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';

const tenant = '11111111-1111-4111-8111-111111111111';
const client = '33333333-3333-4333-8333-333333333333';
const token = 'opaque-fixture-access-value';
const previous = https.request;
const deny = () => { throw new Error('Unexpected live network in Entra fixture'); };
globalThis.fetch = deny;
http.request = http.get = https.get = net.Socket.prototype.connect = deny;
dns.lookup = async () => [{ address: '8.8.8.8', family: 4 }];
if (process.env.ENTRA_FIXTURE_TTY === '1') {
  Object.defineProperty(process.stdin, 'isTTY', { value: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: true });
}
https.request = (url, options, respond) => {
  if (!['login.microsoftonline.com', 'protected.coworktoolkit.dev', 'records.coworktoolkit.dev'].includes(url.hostname)) {
    if (['https://docs.coworktoolkit.dev/mcp', 'https://proof.coworktoolkit.dev/mcp'].includes(url.href)) return previous(url, options, respond);
    throw new Error('Unexpected fixture endpoint');
  }
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.agent, false);
  assert.equal(options.servername, url.hostname);
  assert.ok(options.signal instanceof AbortSignal);
  options.lookup(url.hostname, {}, (error, address) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); });
  const req = new EventEmitter();
  req.end = body => queueMicrotask(() => {
    if (options.signal.aborted) { req.emit('error', new Error('Fixture aborted')); return; }
    let result;
    let status = 200;
    if (url.hostname === 'login.microsoftonline.com') {
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.method, 'POST');
      assert.ok([`/${tenant}/oauth2/v2.0/devicecode`, `/${tenant}/oauth2/v2.0/token`].includes(url.pathname));
      const form = new URLSearchParams(body);
      assert.equal(form.get('client_id'), client);
      const scopes = form.get('scope').split(' ');
      assert.equal(scopes.length, 4);
      assert.deepEqual(scopes.slice(1), ['openid', 'profile', 'offline_access']);
      assert.match(scopes[0], /^api:\/\/(?:protected\.coworktoolkit\.dev\/app|22222222-2222-4222-8222-222222222222)\/records\.read$/);
      if (url.pathname.endsWith('/devicecode')) {
        assert.equal(url.search, '');
        result = { user_code: 'ABCD-1234', device_code: 'private-device-code-never-output',
          verification_uri: 'https://login.microsoft.com/device', expires_in: 900, interval: 1,
          message: 'UNTRUSTED PROVIDER MESSAGE NEVER OUTPUT' };
        if (process.env.ENTRA_FIXTURE_INTERVAL === 'omitted') delete result.interval;
        if (process.env.ENTRA_FIXTURE_INTERVAL === 'null') result.interval = null;
      } else {
        assert.equal(form.get('device_code'), 'private-device-code-never-output');
        assert.equal([...url.searchParams].length, 1);
        assert.match(url.searchParams.get('client-request-id'), /^[0-9a-f-]{36}$/);
        const oid = '44444444-4444-4444-8444-444444444444';
        const claims = { aud: client, iss: `https://login.microsoftonline.com/${tenant}/v2.0`,
          tid: tenant, oid, sub: 'private-fixture-subject', preferred_username: 'private-user@invalid',
          exp: Math.floor(Date.now() / 1000) + 3600 };
        result = { token_type: 'Bearer', expires_in: 3600, scope: scopes[0],
          access_token: token, refresh_token: 'private-refresh-token',
          id_token: [Buffer.from('{"alg":"RS256"}').toString('base64url'),
            Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.'),
          client_info: Buffer.from(JSON.stringify({ uid: oid, utid: tenant })).toString('base64url') };
      }
    } else {
      assert.equal(url.pathname, '/mcp');
      assert.equal(url.search, '');
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      const message = JSON.parse(body);
      assert.ok(['initialize', 'notifications/initialized', 'tools/list'].includes(message.method));
      status = message.method === 'notifications/initialized' ? 204 : 200;
      result = { jsonrpc: '2.0', id: message.id, result: message.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'Actual fixture name', version: '1' } }
        : { tools: [{ name: 'read', description: 'Read records', inputSchema: { type: 'object', properties: {} } }] } };
    }
    if (url.hostname === 'login.microsoftonline.com'
      && url.pathname.endsWith(process.env.ENTRA_FIXTURE_AUTH_ERROR === 'token' ? '/token' : '/devicecode')
      && ['device-code', 'token'].includes(process.env.ENTRA_FIXTURE_AUTH_ERROR)) {
      status = 400;
      result = { error: 'invalid_client', error_description: 'private-provider-message',
        error_codes: [700016], trace_id: 'private-trace', access_token: 'private-diagnostic-token' };
    }
    const stream = new PassThrough();
    stream.headers = { 'content-type': 'application/json' };
    stream.statusCode = status;
    respond(stream);
    if (status !== 204) stream.end(JSON.stringify(result));
  });
  return req;
};
syncBuiltinESMExports();
