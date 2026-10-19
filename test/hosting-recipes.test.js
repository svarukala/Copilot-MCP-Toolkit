import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPair, SignJWT } from 'jose';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { compileHostingRecipe, planHostingRecipe, writeHostingRecipe } from '../src/mcp-container-apps.js';
import { createTokenVerifier, createGatewayVerifier, createRequestHandler, resolveServerSettings } from '../src/recipes/container-apps/runtime.js';
import { planRecipeRelease, recipeSourcePlan, writeRecipeRelease, planRecipeReference } from '../src/mcp-recipe-artifacts.js';
import { unzipSync } from 'fflate';
import { TOOLKIT_ROOT } from '../src/config.js';

const direct = JSON.parse(await readFile(new URL('../examples/mcp/container-apps-direct.json', import.meta.url)));
function gatewayInput() {
  const input = structuredClone(direct);
  input.recipe = 'container-apps-apim-v1';
  input.azure.gateway = { serviceName: 'synthetic-apim', resourceGroup: 'synthetic-gateway-rg',
    apiName: 'reviewed-mcp', path: 'reviewed-mcp', audience: '88888888-8888-4888-8888-888888888888',
    applicationIdUri: 'api://88888888-8888-4888-8888-888888888888',
    principalId: '99999999-9999-4999-8999-999999999999', role: 'Mcp.Gateway' };
  return input;
}
function appServiceInput() {
  const input = structuredClone(direct);
  input.recipe = 'app-service-container-v1';
  input.azure.planResourceId = input.azure.environmentResourceId.replace('Microsoft.App/managedEnvironments', 'Microsoft.Web/serverfarms');
  delete input.azure.environmentResourceId;
  input.azure.planKind = 'linux-dedicated-basic-or-higher';
  input.azure.registry.pullIdentityClientId = '88888888-8888-4888-8888-888888888888';
  return input;
}
async function setup(t, input) {
  const parent = path.join(TOOLKIT_ROOT, '.test-output'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'hosting-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'input.json'); await writeFile(config, JSON.stringify(input));
  return { workspaceRoot: root, config, output: path.join(root, 'server') };
}
test('gateway recipe binds independent audiences, exact policy targets and both separately applied releases', async t => {
  const input = gatewayInput(), options = await setup(t, input);
  const plan = await planHostingRecipe(options);
  const runtime = JSON.parse(plan.files['runtime-config.json']);
  assert.equal(runtime.gateway.publicUrl, 'https://synthetic-apim.azure-api.net/reviewed-mcp/mcp');
  const template = JSON.parse(plan.files['infra/apim-gateway.json']), api = template.resources[0];
  assert.equal(template.metadata.expectedResourceGroup, input.azure.gateway.resourceGroup);
  assert.equal(api.properties.type, 'http');
  const policy = api.resources.find(r => r.type === 'policies').properties.value;
  assert.equal((policy.match(/<base \/>/g) ?? []).length, 4);
  assert.match(policy, /exists-action="override"/);
  assert.match(policy, /output-token-variable-name="copilotGatewayToken"/);
  assert.doesNotMatch(policy, /set-body|Response.Body|<retry|set-header name="Authorization"/);
  await writeHostingRecipe({ ...options, approval: plan.approvalToken });
  const config = path.join(options.workspaceRoot, 'release.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, accountName: 'operator@example.com',
    containerImage: `${input.azure.registry.server}/mcp@sha256:${'a'.repeat(64)}`,
    backendOrigin: `https://${input.azure.appName}.synthetic.eastus.azurecontainerapps.io` }));
  const release = await planRecipeRelease({ ...options, project: options.output, config,
    output: path.join(options.workspaceRoot, 'release') });
  assert.equal(JSON.parse(release.files['infra/container-app.parameters.json']).parameters.backendOrigin, undefined);
  assert.equal(JSON.parse(release.files['infra/apim-gateway.parameters.json']).parameters.backendOrigin.value,
    `https://${input.azure.appName}.synthetic.eastus.azurecontainerapps.io`);
  assert.equal(JSON.parse(release.files['infra/apim-gateway.parameters.json']).parameters.containerImage, undefined);
  await writeFile(config, JSON.stringify({ schemaVersion: 1, serverId: '66666666-6666-4666-8666-666666666666',
    endpoint: `https://${input.azure.appName}.synthetic.eastus.azurecontainerapps.io/mcp` }));
  await assert.rejects(planRecipeReference({ ...options, project: options.output, config,
    output: path.join(options.workspaceRoot, 'wrong-reference') }), /recipe gateway URL/);
  for (const mutate of [
    x => { x.azure.gateway.audience = x.authentication.audience; },
    x => { x.azure.gateway.path = '../other'; },
    x => { x.azure.gateway.principalId = 'header-is-not-proof'; },
    x => { x.azure.gateway.role = '*'; },
    x => { x.azure.gateway.applicationIdUri += '?secret=value'; },
  ]) {
    const bad = structuredClone(input); mutate(bad); assert.throws(() => compileHostingRecipe(bad));
  }
});
test('gateway and caller signatures are independently required, with gateway metadata and untouched annotations', async t => {
  const { runtime } = compileHostingRecipe(gatewayInput());
  const keys = await generateKeyPair('RS256'), other = await generateKeyPair('RS256');
  const sign = (claims, audience, key = keys.privateKey) => new SignJWT({
    tid: runtime.authentication.tenantId, ver: '2.0', ...claims,
  }).setProtectedHeader({ alg: 'RS256' })
    .setIssuer(`https://login.microsoftonline.com/${runtime.authentication.tenantId}/v2.0`)
    .setAudience(audience).setIssuedAt().setNotBefore('0s').setExpirationTime('5m').sign(key);
  const gatewayClaims = { oid: runtime.gateway.principalId, roles: ['Mcp.Gateway'] };
  const validGateway = await sign(gatewayClaims, runtime.gateway.audience);
  const caller = await sign({ oid: '55555555-5555-4555-8555-555555555555', scp: runtime.authentication.scope,
    azp: runtime.authentication.allowedClientIds[0] }, runtime.authentication.audience);
  const verifyGateway = createGatewayVerifier(runtime.gateway, keys.publicKey);
  for (const invalid of [
    await sign({ ...gatewayClaims, oid: runtime.authentication.audience }, runtime.gateway.audience),
    await sign({ ...gatewayClaims, scp: 'delegated' }, runtime.gateway.audience),
    await sign({ ...gatewayClaims, roles: [] }, runtime.gateway.audience),
    await sign(gatewayClaims, runtime.authentication.audience),
    await sign(gatewayClaims, runtime.gateway.audience, other.privateKey),
  ]) await assert.rejects(verifyGateway(invalid));
  let calls = 0;
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  server.on('request', createRequestHandler(runtime, `${origin}/mcp`, {
    verify: createTokenVerifier(runtime.authentication, keys.publicKey), verifyGateway, log: () => {},
    request: async () => { calls++; return Response.json({ value: 42 }); },
  }));
  const request = (gateway, user = caller, method = 'tools/list') => fetch(`${origin}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${user}`, accept: 'application/json, text/event-stream',
      'content-type': 'application/json', ...(gateway ? { 'x-copilot-mcp-gateway-authorization': `Bearer ${gateway}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(method === 'tools/call' ? { params: { name: 'get_information', arguments: {} } } : {}) }),
  });
  assert.equal((await request()).status, 401);
  assert.equal((await request('forged')).status, 403);
  assert.equal((await request(validGateway, 'forged')).status, 401);
  const result = await request(validGateway);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).result.tools[0].annotations.readOnlyHint, true);
  assert.equal(calls, 0);
  assert.equal((await request(validGateway, caller, 'tools/call')).status, 200);
  assert.equal(calls, 1);
  const metadata = await (await fetch(`${origin}/.well-known/oauth-protected-resource`)).json();
  assert.equal(metadata.resource, runtime.gateway.publicUrl);
  const challenge = await request(validGateway, '');
  assert.match(challenge.headers.get('www-authenticate'), /reviewed-mcp\/\.well-known\/oauth-protected-resource/);
});

test('App Service uses the existing Linux plan, identity client ID and actual platform hostname', async t => {
  const input = appServiceInput(), options = await setup(t, input);
  const plan = await planHostingRecipe(options);
  assert.equal(plan.files['infra/container-app.json'], undefined);
  assert.equal(plan.files['runtime-config.json'], JSON.stringify(compileHostingRecipe(direct).runtime, null, 2) + '\n');
  const template = JSON.parse(plan.files['infra/app-service.json']), app = template.resources[0];
  assert.equal(app.properties.serverFarmId, input.azure.planResourceId);
  assert.equal(app.properties.siteConfig.acrUserManagedIdentityID, input.azure.registry.pullIdentityClientId);
  assert.equal(app.properties.siteConfig.acrUseManagedIdentityCreds, true);
  assert.equal(app.properties.httpsOnly, true);
  assert.match(template.outputs.mcpEndpoint.value, /defaultHostName/);
  await writeHostingRecipe({ ...options, approval: plan.approvalToken });
  assert.deepEqual(resolveServerSettings({ MCP_HOST_PLATFORM: 'app-service', WEBSITE_HOSTNAME: 'synthetic-app-unique.eastus.azurewebsites.net' }),
    { port: 3000, publicUrl: 'https://synthetic-app-unique.eastus.azurewebsites.net/mcp' });
  assert.throws(() => resolveServerSettings({ MCP_HOST_PLATFORM: 'app-service' }));
  assert.throws(() => resolveServerSettings({ MCP_HOST_PLATFORM: 'app-service', WEBSITE_HOSTNAME: 'attacker.example.com' }));
  assert.throws(() => resolveServerSettings({ PORT: '0', PUBLIC_MCP_URL: 'http://localhost/mcp' }));
  for (const mutate of [
    x => { x.azure.planKind = 'windows'; },
    x => { x.azure.planResourceId = x.azure.planResourceId.replace(x.azure.subscriptionId, x.azure.tenantId); },
    x => { delete x.azure.registry.pullIdentityClientId; },
  ]) {
    const bad = structuredClone(input); mutate(bad); assert.throws(() => compileHostingRecipe(bad));
  }
});

test('Functions preview produces a managed-identity Flex app and separately reviewed source-only release', async t => {
  const input = JSON.parse(await readFile(new URL('../examples/mcp/functions-sdk.json', import.meta.url)));
  const options = await setup(t, input), plan = await planHostingRecipe(options);
  const host = JSON.parse(plan.files['host.json']), template = JSON.parse(plan.files['infra/functions.json']);
  assert.equal(plan.files.Dockerfile, undefined);
  assert.equal(host.configurationProfile, 'mcp-custom-handler');
  assert.deepEqual(host.customHandler.description, { defaultExecutablePath: 'node', arguments: ['server.js'] });
  assert.equal(host.customHandler.http.routes.find(r => r.route === 'admin/{*route}').authorizationLevel, 'admin');
  assert.equal(template.resources[0].properties.functionAppConfig.runtime.name, 'node');
  assert.equal(template.resources[0].properties.functionAppConfig.deployment.storage.authentication.type, 'UserAssignedIdentity');
  assert.doesNotMatch(plan.files['infra/functions.json'], /listKeys|connectionString|WEBSITE_RUN_FROM_PACKAGE|containerImage/);
  await writeHostingRecipe({ ...options, approval: plan.approvalToken });
  const base = { workspaceRoot: options.workspaceRoot, project: options.output };
  const source = await recipeSourcePlan(base);
  const config = path.join(options.workspaceRoot, 'release.json');
  const releaseInput = { schemaVersion: 1, accountName: 'operator@example.com', sourceArchiveSha256: source.sourceArchiveSha256 };
  await writeFile(config, JSON.stringify(releaseInput));
  const releaseOptions = { ...base, config, output: path.join(options.workspaceRoot, 'release') };
  const release = await planRecipeRelease(releaseOptions);
  await writeRecipeRelease({ ...releaseOptions, approval: release.approvalToken });
  const zip = unzipSync(await readFile(path.join(releaseOptions.output, 'source.zip')));
  assert.ok(zip['host.json']); assert.ok(zip['server.js']); assert.ok(zip['package-lock.json']);
  assert.ok(!Object.keys(zip).some(key => /local.settings|node_modules/.test(key)));
  assert.deepEqual(JSON.parse(release.files['infra/functions.parameters.json']).parameters, {});
  await writeFile(config, JSON.stringify({ ...releaseInput, sourceArchiveSha256: `sha256:${'0'.repeat(64)}` }));
  await assert.rejects(planRecipeRelease({ ...releaseOptions, output: path.join(options.workspaceRoot, 'different') }), /exact source/);
  assert.deepEqual(resolveServerSettings({ MCP_HOST_PLATFORM: 'functions', FUNCTIONS_CUSTOMHANDLER_PORT: '3456',
    WEBSITE_HOSTNAME: 'synthetic-functions-unique.azurewebsites.net' }),
  { port: 3456, publicUrl: 'https://synthetic-functions-unique.azurewebsites.net/mcp' });
  for (const mutate of [
    x => { x.azure.previewAccepted = false; },
    x => { x.azure.planKind = 'consumption'; },
    x => { x.azure.storage.accountResourceId = x.azure.storage.accountResourceId.replace(x.azure.subscriptionId, x.azure.tenantId); },
    x => { x.azure.storage.deploymentContainer = '../other'; },
    x => { x.azure.storage.connectionString = 'unsupported'; },
    x => { x.azure.storage.accountResourceId += '-invalid'; },
  ]) {
    const bad = structuredClone(input); mutate(bad); assert.throws(() => compileHostingRecipe(bad));
  }
});
