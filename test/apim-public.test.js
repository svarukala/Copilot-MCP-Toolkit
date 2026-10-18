import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { prepareMcpServer, validateMcpServerDescriptor, mcpRuntimeConfig } from '../src/mcp-server.js';
import { assertPublicAnonymousConfig } from '../src/apim-public.js';
import { DENY_POLICY } from '../src/apim-renderer.js';
import { deploymentTarget, assertCompatibleGlobalPolicy } from '../src/apim-safety.js';

const baseline = JSON.parse(await readFile(new URL('../examples/mcp/public-rates.json', import.meta.url)));
const privateInput = JSON.parse(await readFile(new URL('../examples/mcp/catalog.json', import.meta.url)));
const operation = input => input.document.paths['/v2/rate/eur/usd'].get;

test('public generation explicitly opens only owned APIs with separate aggregate throttles and inherited protections', async () => {
  for (const mode of ['existing', 'new']) {
    const input = structuredClone(baseline);
    if (mode === 'new') Object.assign(input.azure, { apimMode: mode, location: 'eastus',
      sku: 'Developer', publisherName: 'Synthetic', publisherEmail: 'synthetic@example.com' });
    const review = await prepareMcpServer(input);
    assert.deepEqual(validateMcpServerDescriptor(review.descriptor), review.descriptor);
    assert.equal(mcpRuntimeConfig(input).connectors[0].entra, undefined);
    assert.match(review.limitations.join(' '), /PUBLIC EXPOSURE/);
    assert.doesNotMatch(review.limitations.join(' '), /Entra inbound authorization is explicit/);
    const template = JSON.parse(review.files['infra/gateway.json']);
    const policies = template.resources.filter(r => r.type.endsWith('/apis/policies'));
    assert.equal(policies.length, 2);
    for (const p of policies) {
      const xml = p.properties.value;
      assert.match(xml, /<rate-limit-by-key calls="60" renewal-period="60" counter-key="mcp-[a-f0-9]{12}-public-(rest|mcp)" \/>/);
      assert.doesNotMatch(xml, /validate-azure-ad-token|authentication-managed-identity|context.Response.Body/);
      assert.match(xml, /name="Authorization" exists-action="delete"/);
      assert.match(xml, /name="Cookie" exists-action="delete"/);
      assert.equal(xml.includes('<inbound><base />'), mode === 'existing');
      if (p.name.includes('-rest/')) {
        assert.match(xml, /context.Request.Method != &quot;GET&quot;/);
        assert.match(xml, /context.Request.Url.Query.Count != 0/);
        assert.match(xml, /context.Request.Body != null/);
        assert.doesNotMatch(xml, /set-body|\.Body\.As/);
      } else assert.doesNotMatch(xml, /context.Request.Method|set-body|set-backend-service/);
    }
    for (const api of template.resources.filter(r => r.type.endsWith('/apis'))) assert.equal(api.properties.subscriptionRequired, false);
    if (mode === 'existing') {
      const staged = JSON.parse(review.files['infra/staging.json']);
      for (const p of staged.resources.filter(r => r.type.endsWith('/policies'))) assert.equal(p.properties.value, DENY_POLICY);
      for (const api of staged.resources.filter(r => r.type.endsWith('/apis'))) assert.equal(api.properties.subscriptionRequired, true);
    } else assert.ok(JSON.stringify(JSON.parse(review.files['infra/foundation.json'])).includes(JSON.stringify(DENY_POLICY).slice(1, -1)));
  }
});

for (const [name, change] of [
  ['bare anonymous inbound', i => { i.inbound = { type: 'anonymous' }; }],
  ['private data', i => { i.inbound.publicData = false; }],
  ['side effects', i => { i.inbound.readOnly = false; }],
  ['missing throttle', i => { delete i.inbound.rateLimit; }],
  ['unbounded calls', i => { i.inbound.rateLimit.calls = 10001; }],
  ['zero calls', i => { i.inbound.rateLimit.calls = 0; }],
  ['fractional calls', i => { i.inbound.rateLimit.calls = 1.5; }],
  ['invalid window', i => { i.inbound.rateLimit.renewalPeriod = 301; }],
  ['delegated backend', i => { i.backend.auth = 'entra'; }],
  ['key backend', i => { i.backend = { auth: 'api-key', endpoint: i.backend.endpoint,
    apiKey: { secretIdentifier: 'https://synthetic-vault.vault.azure.net/secrets/key', headerName: 'X-API-Key' } }; }],
  ['proxy', i => { i.kind = 'apim-mcp-proxy'; i.schemaVersion = 2; delete i.document; delete i.operationIds; }],
  ['POST', i => { i.document.paths['/v2/rate/eur/usd'].post = operation(i); delete i.document.paths['/v2/rate/eur/usd'].get; }],
  ['query parameter', i => { operation(i).parameters = [{ name: 'query', in: 'query', schema: { type: 'string' } }]; }],
  ['header parameter', i => { operation(i).parameters = [{ name: 'X-User', in: 'header', schema: { type: 'string' } }]; }],
  ['body', i => { operation(i).requestBody = { content: { 'application/json': { schema: { type: 'object' } } } }; }],
  ['callbacks', i => { operation(i).callbacks = {}; }],
  ['mapping', i => { operation(i)['x-cowork-backend'] = {}; }],
  ['operation server', i => { operation(i).servers = [{ url: 'https://other.example.com' }]; }],
  ['backend path', i => { i.backend.endpoint += '/prefix'; }],
  ['alternate APIM paths', i => { i.document['x-ms-paths'] = {}; }],
  ['security', i => { i.document.security = [{ bearer: [] }]; }],
  ['dynamic route', i => { i.document.paths['/rates/{pair}'] = i.document.paths['/v2/rate/eur/usd']; delete i.document.paths['/v2/rate/eur/usd']; }],
  ['encoded route', i => { i.document.paths['/rates/%2f'] = i.document.paths['/v2/rate/eur/usd']; delete i.document.paths['/v2/rate/eur/usd']; }],
]) test(`public generation rejects ${name}`, async () => {
  const input = structuredClone(baseline); change(input);
  await assert.rejects(prepareMcpServer(input));
});

test('public internal config rejects smuggled caller metadata and cannot share a protected deployment target', () => {
  const config = mcpRuntimeConfig(baseline);
  assertPublicAnonymousConfig(config);
  assert.throws(() => assertPublicAnonymousConfig({ ...config, connectors: [{ ...config.connectors[0], entra: privateInput.inbound }] }));
  const protectedConfig = { ...config, inbound: privateInput.inbound };
  assert.notDeepEqual(deploymentTarget(config), deploymentTarget(protectedConfig));
  assert.equal(deploymentTarget(protectedConfig).publicExposure, undefined);
  assert.throws(() => assertCompatibleGlobalPolicy('<policies><inbound><validate-jwt header-name="Authorization" /></inbound></policies>'),
    { code: 'APIM_POLICY_REVIEW_REQUIRED' });
});
