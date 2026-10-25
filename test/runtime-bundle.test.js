import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateKeyPair, SignJWT } from 'jose';
import { TOOLKIT_ROOT } from '../src/config.js';
import { compileHostingRecipe, planHostingRecipe, writeHostingRecipe } from '../src/mcp-container-apps.js';
import { buildRuntime } from '../src/recipes/container-apps/build-runtime.mjs';

const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const example = async name => JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples', 'mcp', `${name}.json`)));

test('generated bundle is reproducible, attributed and independently executable without unused dependencies', { timeout: 240000 }, async t => {
  const parent = path.join(TOOLKIT_ROOT, '.test-output');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'runtime-bundle-'));
  const standalone = await mkdtemp(path.join(tmpdir(), 'copilot-mcp-bundle-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(standalone, { recursive: true, force: true }); });
  const config = path.join(root, 'recipe.json'), project = path.join(root, 'source');
  await writeFile(config, JSON.stringify(await example('container-apps-direct')));
  const options = { workspaceRoot: root, config, output: project };
  await writeHostingRecipe({ ...options, approval: (await planHostingRecipe(options)).approvalToken });
  const npm = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  execFileSync(process.execPath, [npm, 'ci', '--offline', '--include=dev', '--ignore-scripts', '--no-audit', '--fund=false'],
    { cwd: project, encoding: 'utf8', timeout: 60000 });
  const manifest = await buildRuntime(project);
  const output = path.join(project, 'dist');
  assert.equal(manifest.bundler.version, '0.25.10');
  assert.equal(manifest.bundleDigest, hash(await readFile(path.join(output, 'runtime.js'))));
  assert.ok(manifest.components.some(component => component.name === '@modelcontextprotocol/sdk'));
  assert.ok(!manifest.components.some(component => ['express', 'body-parser', 'esbuild'].includes(component.name)));
  for (const component of manifest.components) {
    const files = await readdir(path.join(output, component.location));
    assert.ok(files.includes('package.json'));
    assert.ok(!files.some(file => /\.(?:m?js|cjs|node)$/i.test(file)));
    assert.equal(hash(await readFile(path.join(output, component.location, 'package.json'))), component.metadataDigest);
    assert.ok(component.notices.length > 0);
    for (const notice of component.notices) assert.equal(hash(await readFile(path.join(output, notice.path))), notice.digest);
  }
  await assert.rejects(buildRuntime(project), { code: 'EEXIST' });
  await rename(output, path.join(project, 'first-build'));
  const second = await buildRuntime(project);
  assert.deepEqual(second, manifest);
  await cp(output, path.join(standalone, 'app'), { recursive: true });
  const entry = path.join(standalone, 'smoke.mjs');
  await writeFile(entry, `
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createProtocolServer, toolDefinitions } from './app/runtime.js';
const config = JSON.parse(await readFile(new URL('./app/runtime-config.json', import.meta.url)));
assert.ok(toolDefinitions(config).length > 0);
await createProtocolServer(config, { request() { throw new Error('UNEXPECTED_NETWORK'); } }).close();
`);
  const preload = path.join(standalone, 'deny-external.cjs');
  await writeFile(preload, `
const Module = require('node:module');
const load = Module._load;
Module._load = function(name, ...args) {
  if (!Module.isBuiltin(name)) throw new Error('UNEXPECTED_DEPENDENCY');
  return load.call(this, name, ...args);
};
global.fetch = () => { throw new Error('UNEXPECTED_NETWORK'); };
`);
  execFileSync(process.execPath, ['--require', preload, entry],
    { cwd: standalone, encoding: 'utf8', timeout: 30000, env: { ...process.env, NODE_PATH: '' } });
  await t.test('rejects unlocked build tools and outside inputs without producing a distribution', async () => {
    await rm(output, { recursive: true });
    const lockPath = path.join(project, 'package-lock.json'), originalLock = await readFile(lockPath);
    const lock = JSON.parse(originalLock); lock.packages[''].devDependencies.esbuild = '0.0.0';
    await writeFile(lockPath, JSON.stringify(lock));
    await assert.rejects(buildRuntime(project), { code: 'RUNTIME_BUNDLE_INVALID' });
    await writeFile(lockPath, originalLock);
    const runtimePath = path.join(project, 'runtime.js'), original = await readFile(runtimePath);
    await writeFile(path.join(root, 'outside.js'), 'globalThis.syntheticOutsideBundle = true;');
    await writeFile(runtimePath, `import '../outside.js';\n${original}`);
    await assert.rejects(buildRuntime(project), { code: 'RUNTIME_BUNDLE_INVALID' });
    await writeFile(runtimePath, original);
    await assert.rejects(readdir(output), { code: 'ENOENT' });
  });
  await t.test('missing contributing license fails rather than claiming a complete artifact', async () => {
    const component = manifest.components.find(item => item.notices.length === 1);
    assert.ok(component);
    const notice = path.join(project, component.notices[0].path), withheld = path.join(root, 'withheld-notice');
    await rename(notice, withheld);
    try {
      await assert.rejects(buildRuntime(project), { code: 'RUNTIME_BUNDLE_INVALID' });
      await assert.rejects(readFile(path.join(output, 'runtime-bundle.json')), { code: 'ENOENT' });
    } finally { await rename(withheld, notice); }
  });
  const bundled = await import(pathToFileURL(path.join(standalone, 'app', 'runtime.js')).href);
  const keys = await generateKeyPair('RS256');
  for (const family of ['container-apps-direct', 'container-apps-apim', 'app-service-container']) {
    for (const key of [false, true]) await t.test(`${family}, backend-key=${key}`, async t => {
      const { runtime } = compileHostingRecipe(await example(`${family}${key ? '-api-key' : ''}`));
      runtime.requestsPerMinute = 60;
      const auth = runtime.authentication, calls = [], logs = [];
      let handler;
      const server = createServer((req, res) => handler(req, res));
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
      const base = `http://127.0.0.1:${server.address().port}`;
      handler = bundled.createRequestHandler(runtime, `${base}/mcp`, {
        verify: bundled.createTokenVerifier(auth, keys.publicKey),
        ...(runtime.gateway ? { verifyGateway: bundled.createGatewayVerifier(runtime.gateway, keys.publicKey) } : {}),
        env: { MCP_BACKEND_API_KEY: 'synthetic-backend-key' },
        request: async (...args) => { calls.push(args); return Response.json({ ok: true }); },
        log: event => logs.push(event),
      });
      const sign = (claims, audience) => new SignJWT({ tid: auth.tenantId, ver: '2.0', ...claims })
        .setProtectedHeader({ alg: 'RS256' }).setIssuer(`https://login.microsoftonline.com/${auth.tenantId}/v2.0`)
        .setAudience(audience).setIssuedAt().setNotBefore('0s').setExpirationTime('5m').sign(keys.privateKey);
      const authorization = `Bearer ${await sign({ oid: '55555555-5555-4555-8555-555555555555',
        azp: auth.allowedClientIds[0], scp: auth.scope }, auth.audience)}`;
      const headers = { authorization };
      if (runtime.gateway) headers['x-copilot-mcp-gateway-authorization'] =
        `Bearer ${await sign({ oid: runtime.gateway.principalId, roles: [runtime.gateway.role] }, runtime.gateway.audience)}`;
      const post = (body, extra = headers) => fetch(`${base}/mcp`, { method: 'POST',
        headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...extra },
        body: JSON.stringify(body) });
      assert.equal((await fetch(`${base}/health`)).status, 200);
      const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
      assert.equal((await post(list, {})).status, 401);
      assert.equal((await post(list, { ...headers, authorization: 'Bearer invalid' })).status, 401);
      if (runtime.gateway) assert.equal((await post(list, { authorization })).status, 401);
      assert.equal((await post(list, { ...headers, 'content-encoding': 'gzip' })).status, 415);
      assert.equal((await post({ padding: 'x'.repeat(65536) })).status, 413);
      const listed = await post(list);
      assert.equal(listed.status, 200);
      assert.equal((await listed.json()).result.tools[0].annotations.readOnlyHint, true);
      const result = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: runtime.tools[0].name, arguments: {} } });
      assert.equal(result.status, 200);
      assert.equal((await result.json()).result.isError, undefined);
      assert.equal(calls.length, 1);
      assert.equal(calls[0][1].headers.authorization, undefined);
      if (key) {
        const backend = runtime.backendAuthentication;
        assert.equal(backend.headerName ? calls[0][1].headers[backend.headerName]
          : new URL(calls[0][0]).searchParams.get(backend.queryParameterName), 'synthetic-backend-key');
      }
      assert.ok(!JSON.stringify(logs).includes('synthetic-backend-key'));
    });
  }
});
