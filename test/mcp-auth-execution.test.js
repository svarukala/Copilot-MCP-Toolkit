import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { TOOLKIT_ROOT, withCliWorkspace } from '../src/config.js';
import { prepareMcpServer } from '../src/mcp-server.js';
import { planAuthExecution, executeAuthPhase, readAuthExecutionStatus, readAuthExecutionResult, fetchRegistrationSecret } from '../src/mcp-auth-execution.js';
import { planAuthRegistrationBundle, writeAuthRegistrationBundle } from '../src/mcp-auth-registration.js';
import { planFccBundle } from '../src/mcp-fcc.js';
import { atkEnvironment, parseAtkAccount, parseAtkRegistrationEnv, runAtkProcess, inspectAtkProvider, atkProvider } from '../src/mcp-atk-provider.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const client = '22222222-2222-4222-8222-222222222222';
const appId = '33333333-3333-4333-8333-333333333333';
const registrationId = '+opaque/synthetic==';
const opaqueUri = 'api://synthetic.example.com/token-store';
const secretUri = 'https://synthetic-vault.vault.azure.net/secrets/oauth-client/0123456789abcdef0123456789abcdef';
async function fixture(t, type = 'entra-sso') {
  await mkdir(path.join(TOOLKIT_ROOT, '.test-output'), { recursive: true });
  const root = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'auth-execution-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const descriptor = (await prepareMcpServer({
    schemaVersion: 1, kind: 'existing-mcp', server: { id: tenant, name: 'Synthetic' },
    endpoint: 'https://synthetic.example.com/mcp', inbound: type === 'entra-sso'
      ? { type: 'entra', tenantId: tenant, clientId: client, applicationIdUri: opaqueUri,
        scope: 'access_as_user', allowedClientIds: ['ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b'] }
      : { type: 'oauth' },
  })).descriptor;
  const input = { schemaVersion: 1, source: { descriptorFile: 'descriptor.json' },
    operator: { tenantId: tenant, accountName: 'operator@example.com' },
    registration: { type, name: 'Synthetic', targetAudience: 'HomeTenant', applicableToApps: 'SpecificApp', appId,
      ...(type === 'oauth' ? { clientId: 'provider-client', authorizationUrl: 'https://identity.example.com/authorize',
        tokenUrl: 'https://identity.example.com/token', scopes: ['read'], isPKCEEnabled: true,
        tokenExchangeMethodType: 'PostRequestBody', credential: { type: 'none' } } : {}) },
    review: { metadataApprovedForExport: true },
  };
  const execution = { schemaVersion: 1, registrationConfig: 'registration.json', providerRoot: path.join(root, 'synthetic-provider') };
  const options = { workspaceRoot: root, project: path.join(root, 'session'), config: path.join(root, 'execution.json') };
  const calls = [];
  const provider = {
    platform: () => 'linux',
    inspect: async () => ({ root: execution.providerRoot, name: '@microsoft/m365agentstoolkit-cli', version: '1.1.17', files: { code: 'synthetic' } }),
    path: owner => path.join(owner.project, 'synthetic-runtime'),
    async open(owner) { calls.push('initialize'); await mkdir(this.path(owner)); return this.path(owner); },
    async validate(runtime) { assert.ok((await readdir(path.dirname(runtime))).includes(path.basename(runtime))); },
    async login(p, runtime, owner, operator) {
      calls.push('login');
      return { accountName: operator.accountName, tenantId: operator.tenantId,
        tenantDisplayName: 'Synthetic organization', evidence: 'provider-account-and-selected-tenant-not-token-attestation' };
    },
    async account(p, runtime, owner, operator) {
      calls.push('account');
      return { accountName: operator.accountName, tenantId: operator.tenantId,
        tenantDisplayName: 'Synthetic organization', evidence: 'provider-account-and-selected-tenant-not-token-attestation' };
    },
    async register(p, runtime, owner, action, authType, selected) {
      calls.push({ action, secret: selected.secret });
      return { registrationId, ...(authType === 'entra-sso' ? { applicationIdUri: opaqueUri } : {}) };
    },
    async close(runtime) { calls.push('close'); await rm(runtime, { recursive: true }); },
  };
  const save = async () => {
    await writeFile(options.config, JSON.stringify(execution));
    await writeFile(path.join(root, 'registration.json'), JSON.stringify(input));
  };
  await writeFile(path.join(root, 'descriptor.json'), JSON.stringify(descriptor));
  await save();
  const deps = { provider };
  async function run(phase, extra = {}) {
    const selected = { ...options, phase, ...extra };
    const plan = await planAuthExecution(selected, deps);
    return executeAuthPhase({ ...selected, approval: plan.approvalToken, allowProvider: true,
      ...(['login', 'register'].includes(phase) ? { allowNetwork: true } : {}),
      ...(phase === 'login' ? { interactive: true } : {}),
      ...(phase === 'register' ? { confirmIdentity: true } : {}),
    }, deps);
  }
  const signedIn = async () => { await run('initialize'); await run('login'); };
  return { root, descriptor, input, execution, options, provider, calls, deps, save, run, signedIn };
}

test('isolated phases create one SSO registration and feed its real reference into FCC without readiness claims', async t => {
  const f = await fixture(t);
  const init = await planAuthExecution({ ...f.options, phase: 'initialize' }, f.deps);
  assert.equal(init.status, 'planned'); assert.deepEqual(f.calls, []);
  await f.signedIn();
  const result = await f.run('register');
  assert.equal(result.status, 'created-unverified');
  assert.equal(result.executionReadiness, false);
  const receipt = JSON.parse(await readFile(result.resultFile));
  assert.equal(receipt.registration.registrationId, registrationId);
  assert.equal(receipt.settings, 'not-verified');
  assert.equal(f.calls.filter(c => typeof c === 'object').length, 1);
  const reference = await withCliWorkspace(f.root, () => readAuthExecutionResult(result.resultFile, f.input, f.descriptor));
  assert.equal(reference.reference.applicationIdUri, opaqueUri);
  await assert.rejects(f.run('register'), { code: 'MCP_AUTH_EXECUTION_CONSUMED' });
  await f.run('close');
  assert.equal((await readAuthExecutionStatus(f.options)).status, 'closed');
  assert.equal((await readdir(path.join(f.root, '.auth-registration-attempts'))).length, 1);
  f.input.source.registrationResultFile = 'session/result.json'; await f.save();
  const authOptions = { workspaceRoot: f.root, config: path.join(f.root, 'registration.json'), output: path.join(f.root, 'auth.json') };
  const auth = await planAuthRegistrationBundle(authOptions);
  assert.equal(auth.bundle.consumers.fcc.authentication.registrationId, registrationId);
  await writeAuthRegistrationBundle({ ...authOptions, approval: auth.approvalToken });
  const fcc = { schemaVersion: 1,
    connector: { displayName: 'Synthetic', description: 'Synthetic demo',
      developer: { name: 'Example', websiteUrl: 'https://example.com', privacyPolicyUrl: 'https://example.com/privacy',
        termsOfUseUrl: 'https://example.com/terms' } },
    source: { descriptorFile: 'descriptor.json', authenticationBundleFile: 'auth.json' },
    authentication: { type: 'entra-sso' },
    review: { metadataApprovedForExport: true, dataAccess: 'user-scoped', dataAccessReason: 'Synthetic review', tools: [] } };
  await writeFile(path.join(f.root, 'fcc.json'), JSON.stringify(fcc));
  const plan = await planFccBundle({ workspaceRoot: f.root, config: path.join(f.root, 'fcc.json'), output: path.join(f.root, 'fcc-output.json') });
  assert.equal(plan.bundle.authentication.registrationId, registrationId);
  assert.equal(plan.bundle.evidence.consumerExecution, 'not-verified');
});

test('generic OAuth PKCE invokes only the public register action and retains its opaque ID', async t => {
  const f = await fixture(t, 'oauth'); await f.signedIn();
  await f.run('register');
  const call = f.calls.find(c => typeof c === 'object');
  assert.equal(call.action.uses, 'oauth/register');
  assert.equal(call.action.with.identityProvider, 'Custom');
  assert.equal(call.action.with.clientSecret, undefined);
  assert.equal(call.action.with.isPKCEEnabled, true);
  assert.equal(call.secret, undefined);
});

test('confidential OAuth resolves only the selected versioned secret using explicit private Azure identity', async t => {
  const f = await fixture(t, 'oauth');
  f.input.registration.credential = { type: 'key-vault-reference', secretIdentifier: secretUri };
  f.input.registration.isPKCEEnabled = false;
  f.execution.secretIdentityProject = 'azure';
  const azureProject = path.join(f.root, 'azure'), azureHome = path.join(azureProject, '.azure-auth', appId);
  await mkdir(azureHome, { recursive: true });
  await writeFile(path.join(azureProject, '.azure-identity.json'), JSON.stringify({
    schemaVersion: 1, status: 'selected', epoch: appId,
    target: { tenantId: tenant, subscriptionId: client, accountName: 'operator@example.com' },
  }));
  const azureCalls = [];
  f.deps.runAzure = async (name, args, selected) => {
    assert.equal(name, 'az'); assert.equal(selected.azureConfigDir, azureHome);
    azureCalls.push(args);
    if (args[1] === 'show') return { code: 0, stdout: JSON.stringify({ tenantId: tenant, id: client,
      user: { name: 'operator@example.com', type: 'user' } }) };
    assert.deepEqual(args.slice(0, 4), ['account', 'get-access-token', '--resource', 'https://vault.azure.net']);
    return { code: 0, stdout: JSON.stringify({ tenant, accessToken: 'synthetic-vault-token' }) };
  };
  let secretReads = 0;
  f.deps.keyVaultFetch = async (url, options) => {
    secretReads++;
    assert.equal(url, `${secretUri}?api-version=7.4`);
    assert.equal(options.headers.Authorization, 'Bearer synthetic-vault-token');
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ id: secretUri, value: 'synthetic-private-credential' }));
  };
  await f.save(); await f.signedIn();
  const plan = await planAuthExecution({ ...f.options, phase: 'register' }, f.deps);
  await assert.rejects(executeAuthPhase({ ...f.options, phase: 'register', approval: plan.approvalToken,
    allowProvider: true, allowNetwork: true, confirmIdentity: true }, f.deps), { code: 'MCP_AUTH_EXECUTION_APPROVAL' });
  await f.run('register', { allowCloud: true });
  assert.equal(azureCalls.filter(args => args[1] === 'get-access-token').length, 1);
  assert.equal(secretReads, 1);
  const call = f.calls.find(c => typeof c === 'object');
  assert.equal(call.secret, 'synthetic-private-credential');
  assert.equal(call.action.with.clientSecret, '${{MCP_AUTH_CLIENT_SECRET}}');
  for (const filename of await readdir(f.options.project)) {
    if (filename.endsWith('.json')) assert.ok(!(await readFile(path.join(f.options.project, filename), 'utf8')).includes('synthetic-private-credential'));
  }
});

test('no implicit provider start, login, registration or cloud opt-in', async t => {
  const f = await fixture(t);
  const plan = await planAuthExecution({ ...f.options, phase: 'initialize' }, f.deps);
  for (const extra of [{}, { approval: plan.approvalToken }, { approval: 'wrong', allowProvider: true },
    { approval: plan.approvalToken, allowProvider: true, allowNetwork: true }]) {
    await assert.rejects(executeAuthPhase({ ...f.options, phase: 'initialize', ...extra }, f.deps));
  }
  assert.deepEqual(f.calls, []);
  await f.run('initialize');
  const login = await planAuthExecution({ ...f.options, phase: 'login' }, f.deps);
  await assert.rejects(executeAuthPhase({ ...f.options, phase: 'login', approval: login.approvalToken,
    allowProvider: true, allowNetwork: true }, f.deps));
  await f.run('login');
  const reg = await planAuthExecution({ ...f.options, phase: 'register' }, f.deps);
  await assert.rejects(executeAuthPhase({ ...f.options, phase: 'register', approval: reg.approvalToken,
    allowProvider: true, allowNetwork: true }, f.deps));
  assert.equal(f.calls.filter(c => typeof c === 'object').length, 0);
});

test('Windows or missing real app ID remains blocked before any effect', async t => {
  const f = await fixture(t);
  f.provider.platform = () => 'win32';
  delete f.input.registration.appId; await f.save();
  const plan = await planAuthExecution({ ...f.options, phase: 'initialize' }, f.deps);
  assert.deepEqual(plan.gaps, ['LINUX_TMPFS_REQUIRED', 'REAL_M365_APP_ID_REQUIRED']);
  await assert.rejects(f.run('initialize'), { code: 'MCP_AUTH_EXECUTION_APPROVAL' });
  assert.deepEqual(f.calls, []);
});

for (const failure of ['failure', 'timeout', 'malformed-output']) {
  test(`a ${failure} after dispatch remains consumed even through renamed/copied session configuration`, async t => {
    const f = await fixture(t); await f.signedIn();
    let dispatched = 0;
    f.provider.register = async () => {
      dispatched++;
      if (failure === 'malformed-output') return { registrationId: 'bad=value', applicationIdUri: opaqueUri };
      throw Object.assign(new Error('raw-provider-message-must-not-escape'), { code: failure === 'timeout' ? 'ATK_TIMEOUT' : 'ATK_PROCESS' });
    };
    await assert.rejects(f.run('register'), error => error.code === 'MCP_AUTH_EXECUTION_FAILED'
      && !error.message.includes('raw-provider-message'));
    assert.equal((await readAuthExecutionStatus(f.options)).status, 'registration-unknown-consumed');
    await assert.rejects(f.run('register'), { code: 'MCP_AUTH_EXECUTION_CONSUMED' });
    f.options.project = path.join(f.root, 'another-session');
    f.input.registration.name = 'Renamed registration'; await f.save();
    await f.signedIn();
    await assert.rejects(f.run('register'), { code: 'MCP_AUTH_EXECUTION_CONSUMED' });
    assert.equal(dispatched, 1);
  });
}

test('identity changes are rejected before target reservation or registration', async t => {
  const f = await fixture(t); await f.signedIn();
  f.provider.account = async () => ({ accountName: 'different@example.com', tenantId: tenant });
  await assert.rejects(f.run('register'), { code: 'MCP_AUTH_EXECUTION_FAILED' });
  assert.equal(f.calls.filter(c => typeof c === 'object').length, 0);
  assert.ok(!(await readdir(f.root)).includes('.auth-registration-attempts'));
});

test('incorrect login identity creates no usable session or registration', async t => {
  const f = await fixture(t); await f.run('initialize');
  f.provider.login = async () => ({ accountName: 'operator@example.com', tenantId: client });
  await assert.rejects(f.run('login'));
  assert.equal((await readAuthExecutionStatus(f.options)).status, 'login-unknown');
  await assert.rejects(f.run('register'));
  await assert.rejects(f.run('login'), { code: 'MCP_AUTH_EXECUTION_CONSUMED' });
});

test('input/provider changes and expired login review invalidate execution', async t => {
  const f = await fixture(t); await f.signedIn();
  f.input.registration.name = 'Changed'; await f.save();
  await assert.rejects(f.run('register'), { code: 'MCP_AUTH_EXECUTION_CHANGED' });
  f.input.registration.name = 'Synthetic'; await f.save();
  const previous = f.provider.inspect;
  f.provider.inspect = async () => ({ ...await previous(), version: 'changed' });
  await assert.rejects(f.run('register'), { code: 'MCP_AUTH_EXECUTION_CHANGED' });
  f.provider.inspect = previous;
  t.mock.method(Date, 'now', () => Date.parse('2100-01-01T00:00:00Z'));
  const plan = await planAuthExecution({ ...f.options, phase: 'register' }, f.deps);
  assert.ok(plan.gaps.includes('LOGIN_REVIEW_EXPIRED'));
});

test('unconfirmed provider termination retains the lock and does not authorize cleanup', async t => {
  const f = await fixture(t); await f.signedIn();
  f.provider.register = async () => { throw Object.assign(new Error('unconfirmed'), { code: 'ATK_TERMINATION_UNCONFIRMED', pid: 12345 }); };
  await assert.rejects(f.run('register'), { code: 'ATK_TERMINATION_UNCONFIRMED' });
  assert.ok((await readdir(f.options.project)).includes('.auth-operation.lock'));
  assert.equal(JSON.parse(await readFile(path.join(f.options.project, '.auth-operation.lock'))).providerProcessGroup, 12345);
  await assert.rejects(f.run('close'));
  assert.ok(!f.calls.includes('close'));
});

test('concurrent registration attempts cannot dispatch the same target twice', async t => {
  const f = await fixture(t); await f.signedIn();
  const plan = await planAuthExecution({ ...f.options, phase: 'register' }, f.deps);
  const selected = { ...f.options, phase: 'register', approval: plan.approvalToken, allowProvider: true,
    allowNetwork: true, confirmIdentity: true };
  const results = await Promise.allSettled([1, 2].map(() => executeAuthPhase(selected, f.deps)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.calls.filter(c => typeof c === 'object').length, 1);
});

test('result imports reject altered requests, missing digest, mismatched descriptor and reference/result ambiguity', async t => {
  const f = await fixture(t); await f.signedIn();
  const result = await f.run('register');
  f.input.registration.name = 'different';
  await assert.rejects(withCliWorkspace(f.root, () => readAuthExecutionResult(result.resultFile, f.input, f.descriptor)));
  f.input.registration.name = 'Synthetic';
  const body = JSON.parse(await readFile(result.resultFile)); delete body.contentDigest;
  await writeFile(result.resultFile, JSON.stringify(body));
  await assert.rejects(withCliWorkspace(f.root, () => readAuthExecutionResult(result.resultFile, f.input, f.descriptor)));
  f.input.source.registrationResultFile = 'session/result.json';
  f.input.registration.reference = { registrationId, applicationIdUri: opaqueUri }; await f.save();
  await assert.rejects(planAuthRegistrationBundle({ workspaceRoot: f.root, config: path.join(f.root, 'registration.json'),
    output: path.join(f.root, 'output.json') }));
});

test('a supplied reference cannot be used to recreate a registration', async t => {
  const f = await fixture(t);
  f.input.registration.reference = { registrationId, applicationIdUri: opaqueUri }; await f.save();
  await assert.rejects(f.run('initialize'), { code: 'MCP_AUTH_EXECUTION_EXISTING_REFERENCE' });
});

test('status rejects malformed completion records and retains a reservation even without a session dispatch record', async t => {
  const f = await fixture(t);
  await f.run('initialize');
  const initialized = path.join(f.options.project, 'initialized.json');
  const original = await readFile(initialized);
  await writeFile(initialized, JSON.stringify({ completedAt: 'not-a-time' }));
  await assert.rejects(readAuthExecutionStatus(f.options), { code: 'MCP_AUTH_EXECUTION_STATE' });
  await writeFile(initialized, original);
  await f.run('login');
  f.provider.register = async () => { throw new Error('synthetic failure'); };
  await assert.rejects(f.run('register'));
  await rm(path.join(f.options.project, 'register-attempt.json'));
  assert.equal((await readAuthExecutionStatus(f.options)).status, 'registration-unknown-consumed');
  await assert.rejects(f.run('register'), { code: 'MCP_AUTH_EXECUTION_CONSUMED' });
});

test('ATK environment excludes shared identity and arbitrary ambient override variables', () => {
  const env = atkEnvironment('/private/home', 'synthetic-credential');
  assert.equal(env.M365_ACCOUNT_NAME, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.HOME, '/private/home');
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, `unix:path=${path.join('/private/home', 'no-session-bus')}`);
  assert.equal(env.MCP_AUTH_CLIENT_SECRET, 'synthetic-credential');
  assert.equal(env.BROWSER, '/bin/true');
});

function fakeProcess() {
  const child = new EventEmitter();
  child.pid = 99999; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  return child;
}
test('provider runner uses a child-only credential environment, no shell and no raw stderr errors', async () => {
  const child = fakeProcess();
  const provider = { node: process.execPath, entry: '/provider/cli.js' };
  let spawned;
  const result = runAtkProcess(provider, ['provision', '--interactive', 'false'],
    { runtime: '/private/runtime', secret: 'synthetic-private-value' }, {
      spawnProcess: (...args) => { spawned = args; return child; },
      killGroup: pid => assert.equal(pid, child.pid),
    });
  child.stdout.write('bounded output'); child.stderr.write('private error text');
  child.emit('close', 0);
  assert.equal(await result, 'bounded output');
  assert.deepEqual(spawned[1], ['/provider/cli.js', 'provision', '--interactive', 'false', '--telemetry', 'false']);
  assert.equal(spawned[2].env.MCP_AUTH_CLIENT_SECRET, 'synthetic-private-value');
  assert.equal(spawned[2].shell, false);
  assert.ok(!JSON.stringify(spawned[1]).includes('synthetic-private-value'));
});

test('provider runner escalates only its owned group and retains an unconfirmed PID on timeout', async () => {
  const child = fakeProcess(), signals = [];
  await assert.rejects(runAtkProcess({ node: process.execPath, entry: '/provider/cli.js' }, [], { runtime: '/private/runtime' },
    { spawnProcess: () => child, killGroup: (pid, signal) => { assert.equal(pid, child.pid); signals.push(signal); },
      timeoutMs: 5, killAfterMs: 5, graceMs: 15 }),
  error => error.code === 'ATK_TERMINATION_UNCONFIRMED' && error.pid === child.pid);
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  child.emit('close', 1);
});

test('provider runner refuses nonterminal login and already-cancelled work before spawning', async () => {
  const options = { runtime: '/private/runtime', interactive: true };
  let called = false;
  const dependencies = { spawnProcess: () => { called = true; }, terminal: () => false };
  await assert.rejects(runAtkProcess({}, [], options, dependencies), { code: 'ATK_TERMINAL' });
  await assert.rejects(runAtkProcess({}, [], { ...options, signal: AbortSignal.abort() }, dependencies), { code: 'ATK_ABORTED' });
  assert.equal(called, false);
});

test('strict ATK output parsing preserves opaque padding and rejects unexpected/duplicate/secret output', () => {
  const text = `TEAMSFX_ENV=reg\nAPP_NAME_SUFFIX=reg\nMCP_AUTH_REGISTRATION_ID="${registrationId}"\nMCP_AUTH_APPLICATION_ID_URI='${opaqueUri}'\n`;
  assert.deepEqual(parseAtkRegistrationEnv(text, 'entra-sso'), { registrationId, applicationIdUri: opaqueUri });
  assert.deepEqual(parseAtkRegistrationEnv(`MCP_AUTH_REGISTRATION_ID=${registrationId}\n`, 'oauth'), { registrationId });
  for (const bad of [text + 'UNEXPECTED=anything\n', text + 'MCP_AUTH_REGISTRATION_ID=second\n',
    text.replace('=reg', '=different'), text.replace(registrationId, 'abc=def'), text.replace(opaqueUri, 'https://a.example/?secret=value'),
    'MCP_AUTH_REGISTRATION_ID=x\n', ' '.repeat(16385)]) assert.throws(() => parseAtkRegistrationEnv(bad, 'entra-sso'));
});

test('ATK account output must unambiguously match the selected account; tenant remains explicitly non-attested', () => {
  const expected = { accountName: 'operator@example.com', tenantId: tenant };
  assert.equal(parseAtkAccount('Your Microsoft 365 account is: operator@example.com(Synthetic organization).\n', expected).tenantId, tenant);
  assert.equal(parseAtkAccount('\x1b[32mYour Microsoft 365 account is: operator@example.com.\x1b[0m\n', expected).tenantDisplayName, null);
  assert.throws(() => parseAtkAccount('Your Microsoft 365 account is: someone@example.com.', expected));
  assert.throws(() => parseAtkAccount('No account is signed in.', expected));
  assert.throws(() => parseAtkAccount('Your Microsoft 365 account is: operator@example.com.\nYour Microsoft 365 account is: operator@example.com.', expected));
});

test('provider inspection is read-only, fingerprints reviewed entry files and rejects a different package version', async t => {
  const f = await fixture(t), root = f.execution.providerRoot;
  await mkdir(path.join(root, 'lib'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@microsoft/m365agentstoolkit-cli', version: '1.1.17' }));
  await writeFile(path.join(root, 'cli.js'), 'synthetic-entry-do-not-execute');
  await writeFile(path.join(root, 'lib', 'index.js'), 'synthetic-bundle-do-not-execute');
  const before = await inspectAtkProvider(root);
  await writeFile(path.join(root, 'lib', 'index.js'), 'changed-synthetic-bundle');
  assert.notDeepEqual((await inspectAtkProvider(root)).files, before.files);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@microsoft/m365agentstoolkit-cli', version: '9.9.9' }));
  await assert.rejects(inspectAtkProvider(root), { code: 'ATK_INSTALLATION' });
});

test('real runtime refuses non-Linux execution; Linux runtime checks actual tmpfs and owner permissions without provider calls', async () => {
  const owner = { epoch: randomUUID(), project: 'synthetic-project', workspaceRoot: 'synthetic-workspace' };
  if (process.platform !== 'linux') {
    await assert.rejects(atkProvider.open(owner), { code: 'ATK_PLATFORM' });
    return;
  }
  const runtime = await atkProvider.open(owner);
  try {
    await atkProvider.validate(runtime, owner);
    await chmod(path.join(runtime, 'home'), 0o755);
    await assert.rejects(atkProvider.validate(runtime, owner), { code: 'ATK_RUNTIME' });
    await chmod(path.join(runtime, 'home'), 0o700);
  } finally { await atkProvider.close(runtime, owner); }
});

test('secret transport rejects wrong versions, permission failures and oversized bodies without retry', async () => {
  for (const response of [
    new Response('denied', { status: 403 }),
    new Response(JSON.stringify({ id: `${secretUri}0`, value: 'synthetic' })),
    new Response('x'.repeat(32769)),
  ]) {
    let calls = 0;
    await assert.rejects(fetchRegistrationSecret(secretUri, 'synthetic-token', { fetch: async () => { calls++; return response; } }));
    assert.equal(calls, 1);
  }
  let called = false;
  await assert.rejects(fetchRegistrationSecret('https://unrelated.example.com/secret', 'synthetic-token',
    { fetch: async () => { called = true; } }));
  assert.equal(called, false);
});
