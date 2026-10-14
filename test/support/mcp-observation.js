export function observationTransport(descriptor, identity, tools) {
  const { tenantId, clientId, applicationIdUri, scope } = descriptor.inbound;
  const calls = [];
  return {
    calls,
    authTransport: async (url, options) => {
      const endpoint = new URL(url);
      calls.push(endpoint.pathname);
      let body;
      if (endpoint.pathname.endsWith('/openid-configuration')) body = {
        authorization_endpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
        token_endpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        end_session_endpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/logout`,
        issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
        jwks_uri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
      };
      else if (endpoint.pathname.endsWith('/devicecode')) {
        if (new URLSearchParams(options.body).get('client_id') !== identity.discoveryClientId) throw Error('Unexpected public client');
        body = { user_code: 'MOCK-ONLY', device_code: 'inert-private-device', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 1 };
      } else if (endpoint.pathname.endsWith('/token')) {
        const claims = { tid: tenantId, oid: identity.expectedUserId, aud: identity.discoveryClientId, sub: 'mock-user',
          preferred_username: 'mock@invalid', iss: `https://login.microsoftonline.com/${tenantId}/v2.0`, exp: Math.floor(Date.now() / 1000) + 3600 };
        const token = [Buffer.from('{"alg":"RS256"}').toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), 'mock'].join('.');
        body = { token_type: 'Bearer', access_token: 'opaque-mocked-access-value', expires_in: 3600,
          scope: `${applicationIdUri}/${scope}`, id_token: token,
          client_info: Buffer.from(JSON.stringify({ uid: identity.expectedUserId, utid: tenantId })).toString('base64url') };
      } else throw Error(`Unexpected auth fixture route for ${clientId}`);
      return new Response(JSON.stringify(body));
    },
    mcpTransport: async (url, options) => {
      if (url !== descriptor.endpoint) throw Error('Unexpected MCP fixture endpoint');
      const message = JSON.parse(options.body); calls.push(message.method);
      if (message.method === 'notifications/initialized') return new Response(null, { status: 204 });
      const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'Offline fixture', version: '1' } }
        : message.method === 'tools/list' ? tools
          : message.method === 'tools/call' ? { content: [{ type: 'text', text: 'inert private fixture response' }] } : null;
      if (!result) throw Error('Unexpected fixture RPC');
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    },
  };
}
