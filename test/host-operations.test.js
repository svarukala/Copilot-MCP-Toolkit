import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { TOOLKIT_ROOT } from '../src/config.js';
import { planHostingRecipe, writeHostingRecipe } from '../src/mcp-container-apps.js';
import { planHostOperation, runHostOperation, hostingAccount } from '../src/mcp-host-operations.js';
import { dockerEngineRequest, registryAuthHeader } from '../src/docker-engine.js';
import { main } from '../bin/copilot-mcp.js';
import { azureCommandEnvironment, runAzureCommand } from '../src/azure.js';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const hash = `sha256:${'a'.repeat(64)}`;
const socket = String.raw`\\.\pipe\docker_engine`;
const engine = { dockerSocket: socket, localEngineTrusted: true };
const jsonResponse = (value, status = 200) => ({ status, text: JSON.stringify(value) });
async function fixture(t, input) {
  await mkdir(path.join(TOOLKIT_ROOT, '.test-output'), { recursive: true });
  const root = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'host-operations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "private project 'one'");
  const options = { workspaceRoot: root, project, config: path.join(root, 'selection.json'), output: path.join(root, 'result.json') };
  const target = { tenantId: '11111111-1111-4111-8111-111111111111',
    subscriptionId: '22222222-2222-4222-8222-222222222222', accountName: 'operator@example.com' };
  let source;
  if (input.kind === 'private-image-pull') {
    source = JSON.parse(await readFile(new URL('../examples/mcp/container-apps-direct.json', import.meta.url)));
    target.tenantId = source.azure.tenantId; target.subscriptionId = source.azure.subscriptionId;
    input = { ...input, image: `${source.azure.registry.server}/mcp@${hash}`, accountName: target.accountName };
    const config = path.join(root, 'source.json'); await writeFile(config, JSON.stringify(source));
    const generation = { workspaceRoot: root, config, output: project };
    const planned = await planHostingRecipe(generation);
    await writeHostingRecipe({ ...generation, approval: planned.approvalToken });
  } else await mkdir(project);
  const calls = [], azureCalls = [], account = {
    tenantId: target.tenantId, id: target.subscriptionId, user: { name: target.accountName, type: 'user' },
  };
  const secret = 'synthetic-registry-token-never-persist';
  const runAzure = async (command, args, opts) => {
    azureCalls.push({ command, args, opts });
    assert.ok(opts.azureConfigDir.startsWith(path.join(project, '.azure-auth') + path.sep));
    if (args[0] === 'acr') {
      assert.equal(opts.sensitiveOutput, true);
      assert.ok(args.includes('--expose-token'));
      return { loginServer: source.azure.registry.server, accessToken: secret };
    }
    return account;
  };
  if (source) {
    const login = await hostingAccount(project, target);
    await hostingAccount(project, target, { approval: login.approvalToken, run: runAzure }, true);
    azureCalls.length = 0;
  }
  await writeFile(options.config, JSON.stringify(input));
  const dockerRequest = async (selected, route, opts) => {
    assert.equal(selected, socket); calls.push({ route, opts });
    if (route === '/version') return jsonResponse({ Os: 'linux', Arch: 'amd64', ApiVersion: '1.47', MinAPIVersion: '1.44' });
    if (route.endsWith('/info')) return jsonResponse({ Debug: false,
      RegistryConfig: { InsecureRegistryCIDRs: ['127.0.0.0/8'], IndexConfigs: {} } });
    if (route.includes('/images/create?')) {
      assert.equal(opts.headers['X-Registry-Auth'].length % 4, 0);
      const auth = JSON.parse(Buffer.from(opts.headers['X-Registry-Auth'], 'base64url'));
      assert.equal(auth.password, secret);
      assert.equal(auth.username, '00000000-0000-0000-0000-000000000000');
      assert.equal(auth.serveraddress, source.azure.registry.server);
      return jsonResponse({ status: 'complete' });
    }
    if (route.includes('/images/')) return jsonResponse({ Os: 'linux', Architecture: 'amd64',
      RepoDigests: [input.image.replace('node:22-bookworm-slim@', 'node@')] });
    throw new Error('Unexpected synthetic Docker request');
  };
  return { input, options, source, target, calls, azureCalls, dockerRequest, runAzure, secret,
    save: () => writeFile(options.config, JSON.stringify(input)) };
}
const flags = { allowLocal: true, allowNetwork: true, allowCloud: true };
test('registry authentication uses Docker-compatible padded URL-safe base64 for every padding length', () => {
  const padding = new Set();
  for (const token of ['~~~+++///', '~~~+++///x', '~~~+++///xy']) {
    const encoded = registryAuthHeader('fixture.azurecr.io', token);
    assert.match(encoded, /^[A-Za-z0-9_-]+={0,2}$/);
    assert.equal(encoded.length % 4, 0);
    padding.add(encoded.match(/=*$/)[0].length);
    const decoded = Buffer.from(encoded.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
    assert.equal(decoded.toString('base64').replaceAll('+', '-').replaceAll('/', '_'), encoded);
    assert.deepEqual(JSON.parse(decoded), { username: '00000000-0000-0000-0000-000000000000',
      password: token, serveraddress: 'fixture.azurecr.io' });
  }
  assert.deepEqual([...padding].sort(), [0, 1, 2]);
});
test('Docker transport keeps registry auth on a local socket and bounds errors, bytes and cancellation', async () => {
  const calls = [];
  const fake = (text, stall = false) => ({ requestImpl: (options, receive) => {
    calls.push(options);
    const req = new EventEmitter();
    req.destroy = error => req.emit('error', error);
    req.end = () => {
      if (stall) {
        options.signal.addEventListener('abort', () => req.emit('error', { code: 'ABORT_ERR' }), { once: true });
      } else {
        const response = Readable.from([Buffer.from(text)]); response.statusCode = 200; receive(response);
      }
    };
    return req;
  } });
  const response = await dockerEngineRequest(socket, '/v1.44/images/create', {
    method: 'POST', headers: { 'X-Registry-Auth': 'synthetic-memory-only' },
  }, fake('{}'));
  assert.equal(response.status, 200);
  assert.equal(calls[0].socketPath, socket);
  assert.equal(calls[0].host, undefined);
  assert.equal(calls[0].agent, false);
  assert.equal(calls[0].headers['X-Registry-Auth'], 'synthetic-memory-only');
  await assert.rejects(dockerEngineRequest(socket, '/version', { maxBytes: 4 }, fake('12345')), { code: 'DOCKER_OUTPUT_LIMIT' });
  await assert.rejects(dockerEngineRequest(socket, '/version', { timeoutMs: 5 }, fake('', true)), { code: 'DOCKER_TIMEOUT' });
  const count = calls.length;
  await assert.rejects(dockerEngineRequest(socket, '/version', { signal: AbortSignal.abort() }, fake('{}')), { code: 'DOCKER_ABORTED' });
  assert.equal(calls.length, count);
});
test('transient Azure output disables file logs and dynamic install without changing the shared environment', async () => {
  const inherited = { AZURE_CONFIG_DIR: 'shared', AZURE_LOGGING_ENABLE_LOG_FILE: 'true', AZURE_CORE_LOG_LEVEL: 'debug' };
  const env = azureCommandEnvironment({ azureConfigDir: "C:\\private owner's\\auth", sensitiveOutput: true }, inherited);
  assert.equal(env.AZURE_CONFIG_DIR, "C:\\private owner's\\auth");
  assert.equal(env.AZURE_LOGGING_ENABLE_LOG_FILE, 'false');
  assert.equal(env.AZURE_CORE_LOG_LEVEL, 'error');
  assert.equal(env.AZURE_CORE_COLLECT_TELEMETRY, 'no');
  assert.equal(env.AZURE_EXTENSION_USE_DYNAMIC_INSTALL, 'no');
  assert.equal(inherited.AZURE_CONFIG_DIR, 'shared');
  assert.throws(() => azureCommandEnvironment({ sensitiveOutput: true },
    { AZURE_CLI_DISABLE_CONNECTION_VERIFICATION: '1' }));
  await assert.rejects(runAzureCommand('az', ['acr', 'login', '--expose-token'], { sensitiveOutput: true }),
    { code: 'AZURE_CLI_SENSITIVE_OUTPUT_INVALID' });
});
test('engine diagnostics require exact reviewed local endpoint and preserve bounded immutable results', async t => {
  const f = await fixture(t, { schemaVersion: 1, kind: 'engine-diagnostic', ...engine });
  const plan = await planHostOperation(f.options);
  await assert.rejects(runHostOperation({ ...f.options, approval: plan.approvalDigest }, { dockerRequest: f.dockerRequest }));
  assert.equal(f.calls.length, 0);
  const report = await runHostOperation({ ...f.options, approval: plan.approvalDigest, allowLocal: true }, { dockerRequest: f.dockerRequest });
  assert.equal(report.result.status, 'passed');
  assert.deepEqual(f.calls.map(c => c.route), ['/version']);
  assert.equal((JSON.parse(await readFile(f.options.output))).contentDigest, report.contentDigest);
  await assert.rejects(planHostOperation(f.options), { code: 'HOST_OPERATION_CONSUMED' });
  await assert.rejects(dockerEngineRequest('tcp://remote:2375', '/version'), { code: 'DOCKER_ENDPOINT_INVALID' });
});
test('host npm diagnostics do not touch Docker or Azure and failures are not build approval', async t => {
  const f = await fixture(t, { schemaVersion: 1, kind: 'host-npm-diagnostic' });
  const plan = await planHostOperation(f.options);
  assert.equal(plan.cloudRequired, false);
  const report = await runHostOperation({ ...f.options, approval: plan.approvalDigest, allowNetwork: true }, {
    npmProbe: async () => ({ status: 'failed', stage: 'tls' }),
    dockerRequest: () => assert.fail('no Docker'), runAzure: () => assert.fail('no Azure'),
  });
  assert.deepEqual(report.result, { stage: 'tls', status: 'failed' });
  assert.equal(report.providerVerified, false);
});
test('container diagnostics use an existing pinned image and remove only the owned restricted probe', async t => {
  const f = await fixture(t, { schemaVersion: 1, kind: 'container-npm-diagnostic', ...engine,
    image: `node:22-bookworm-slim@${hash}` });
  const plan = await planHostOperation(f.options);
  const id = 'b'.repeat(64);
  let creates = 0, removes = 0;
  const dockerRequest = async (socket, route, opts) => {
    if (route.includes('/containers/create')) {
      creates++;
      assert.equal(opts.body.User, '65532:65532');
      assert.equal(opts.body.HostConfig.ReadonlyRootfs, true);
      assert.equal(opts.body.HostConfig.LogConfig.Type, 'none');
      assert.equal(opts.body.HostConfig.Privileged, undefined);
      assert.deepEqual(opts.body.Env, []);
      assert.match(opts.body.Cmd[1], /rejectUnauthorized:true/);
      return jsonResponse({ Id: id }, 201);
    }
    if (route.endsWith('/start')) return { status: 204, text: '' };
    if (route.includes('/wait?')) return jsonResponse({ StatusCode: 3 });
    if (route.includes('/containers/') && route.endsWith('/json')) return jsonResponse({
      Id: id, Config: { Labels: { 'copilot-mcp-probe': plan.approvalDigest } },
    });
    if (opts.method === 'DELETE') { removes++; assert.ok(route.includes(id)); return { status: 204, text: '' }; }
    return f.dockerRequest(socket, route, opts);
  };
  const report = await runHostOperation({ ...f.options, approval: plan.approvalDigest, allowLocal: true, allowNetwork: true }, { dockerRequest });
  assert.equal(report.result.stage, 'tls');
  assert.equal(report.result.cleanup, 'owned-container-removed-or-absent');
  assert.equal(creates, 1); assert.equal(removes, 1);
});
test('private pull binds private identity, exact digest and daemon without persisting the credential', async t => {
  const f = await fixture(t, { schemaVersion: 1, kind: 'private-image-pull', ...engine });
  const plan = await planHostOperation(f.options);
  const report = await runHostOperation({ ...f.options, ...flags, approval: plan.approvalDigest },
    { dockerRequest: f.dockerRequest, runAzure: f.runAzure });
  assert.equal(report.result.status, 'pulled-digest-verified-not-executed');
  assert.equal(f.calls.filter(c => c.route.includes('/images/create?')).length, 1);
  assert.equal(f.azureCalls.filter(c => c.args[0] === 'acr').length, 1);
  for (const file of [f.options.output, `${f.options.output}.intent.json`, plan.reservation]) {
    assert.ok(!(await readFile(file, 'utf8')).includes(f.secret));
  }
  await assert.rejects(planHostOperation({ ...f.options, output: path.join(f.options.workspaceRoot, 'retry.json') }),
    { code: 'HOST_OPERATION_CONSUMED' });
});
test('ambiguous pull output is consumed and raw registry/daemon errors never reach evidence', async t => {
  for (const text of ['', '{broken', JSON.stringify({ error: 'synthetic-registry-token-never-persist' }), null]) {
    const f = await fixture(t, { schemaVersion: 1, kind: 'private-image-pull', ...engine });
    const plan = await planHostOperation(f.options);
    let dispatched = 0;
    const report = await runHostOperation({ ...f.options, ...flags, approval: plan.approvalDigest }, {
      runAzure: f.runAzure, dockerRequest: (s, route, opts) => {
        if (route.includes('/images/create?')) {
          dispatched++;
          if (text === null) throw Object.assign(new Error(f.secret), { code: 'DOCKER_TIMEOUT' });
          return { status: 200, text };
        }
        return f.dockerRequest(s, route, opts);
      },
    });
    assert.equal(report.result.status, 'unknown-no-replay'); assert.equal(dispatched, 1);
    assert.ok(!JSON.stringify(report).includes(f.secret));
    await assert.rejects(planHostOperation({ ...f.options, output: path.join(f.options.workspaceRoot, 'retry.json') }));
  }
});
test('insecure or debug-enabled daemons are blocked before token acquisition and pull reservation', async t => {
  const f = await fixture(t, { schemaVersion: 1, kind: 'private-image-pull', ...engine });
  const plan = await planHostOperation(f.options);
  const report = await runHostOperation({ ...f.options, ...flags, approval: plan.approvalDigest }, {
    runAzure: f.runAzure, dockerRequest: (s, route, opts) => route.endsWith('/info')
      ? jsonResponse({ Debug: true, RegistryConfig: { InsecureRegistryCIDRs: ['0.0.0.0/0'] } })
      : f.dockerRequest(s, route, opts),
  });
  assert.equal(report.result.status, 'blocked-before-pull');
  assert.equal(f.azureCalls.filter(c => c.args[0] === 'acr').length, 0);
  const next = await planHostOperation({ ...f.options, output: path.join(f.options.workspaceRoot, 'new-reviewed-check.json') });
  assert.notEqual(next.approvalDigest, plan.approvalDigest);
});
test('container cleanup refuses a mismatched owner rather than deleting a different container', async t => {
  const f = await fixture(t, { schemaVersion: 1, kind: 'container-npm-diagnostic', ...engine,
    image: `node:22-bookworm-slim@${hash}` });
  const plan = await planHostOperation(f.options);
  let creates = 0;
  const report = await runHostOperation({ ...f.options, approval: plan.approvalDigest, allowLocal: true, allowNetwork: true }, {
    dockerRequest: (s, route, opts) => {
      assert.notEqual(opts.method, 'DELETE');
      if (route.includes('/containers/create')) {
        creates++; throw Object.assign(new Error('lost response'), { code: 'DOCKER_TIMEOUT' });
      }
      if (route.includes('/containers/')) return jsonResponse({ Id: 'c'.repeat(64), Config: { Labels: {} } });
      return f.dockerRequest(s, route, opts);
    },
  });
  assert.equal(creates, 1);
  assert.equal(report.result.code, 'DOCKER_CLEANUP_UNKNOWN');
  assert.equal(report.result.cleanup, 'unknown');
  assert.match(report.result.containerName, /^copilot-mcp-probe-/);
});
test('stale approvals and missing network/cloud gates cannot acquire a registry token', async t => {
  const f = await fixture(t, { schemaVersion: 1, kind: 'private-image-pull', ...engine });
  const plan = await planHostOperation(f.options);
  for (const missing of ['allowLocal', 'allowNetwork', 'allowCloud']) {
    const selected = { ...flags }; delete selected[missing];
    await assert.rejects(runHostOperation({ ...f.options, ...selected, approval: plan.approvalDigest },
      { dockerRequest: f.dockerRequest, runAzure: f.runAzure }));
  }
  assert.equal(f.calls.length, 0); assert.equal(f.azureCalls.length, 0);
  f.input.image = f.input.image.replace(hash, `sha256:${'c'.repeat(64)}`); await f.save();
  await assert.rejects(runHostOperation({ ...f.options, ...flags, approval: plan.approvalDigest },
    { dockerRequest: f.dockerRequest, runAzure: f.runAzure }));
  assert.equal(f.azureCalls.length, 0);
  assert.ok(!(await readdir(f.options.workspaceRoot)).includes('result.json.intent.json'));
});
test('host CLI plans are JSON-only and execution flags are rejected on unrelated commands', async t => {
  const f = await fixture(t, { schemaVersion: 1, kind: 'engine-diagnostic', ...engine });
  let stdout = '', stderr = '';
  t.mock.method(process.stdout, 'write', value => { stdout += value; return true; });
  t.mock.method(process.stderr, 'write', value => { stderr += value; return true; });
  assert.equal(await main(['mcp-host-plan', '--workspace-root', f.options.workspaceRoot, '--project', f.options.project,
    '--config', f.options.config, '--output', f.options.output, '--json', '--summary']), 0);
  const plan = JSON.parse(stdout);
  assert.ok(stderr.includes(plan.approvalDigest));
  stdout = ''; stderr = '';
  assert.notEqual(await main(['mcp-bootstrap-schema', '--allow-local', '--json']), 0);
  assert.ok(JSON.parse(stdout).error);
});
