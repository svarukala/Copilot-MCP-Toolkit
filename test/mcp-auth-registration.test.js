import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { TOOLKIT_ROOT, withCliWorkspace } from '../src/config.js';
import { prepareMcpServer } from '../src/mcp-server.js';
import { boundedSnapshot, metadataDigest, savedJson } from '../src/anonymous-metadata.js';
import { planAuthRegistrationBundle, writeAuthRegistrationBundle, readAuthRegistrationBundle } from '../src/mcp-auth-registration.js';
import { planFccBundle, writeFccBundle, fccTokenStoreClientId } from '../src/mcp-fcc.js';
import { writeNewJsonBundle } from '../src/mcp-bundle-write.js';
import { planAuthWiqdBundle, writeAuthWiqdBundle } from '../src/mcp-auth-wiqd.js';
import { portalSsoScope, ssoScopeInstructions } from '../src/mcp-sso-scope.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const resource = '22222222-2222-4222-8222-222222222222';
const appId = '33333333-3333-4333-8333-333333333333';
const registrationId = '+synthetic/reference==';
const hash = value => metadataDigest(boundedSnapshot(value));
async function fixture(t, type = 'entra-sso') {
  await mkdir(path.join(TOOLKIT_ROOT, '.test-output'), { recursive: true });
  const root = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'auth-registration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const definition = {
    schemaVersion: 1, kind: 'existing-mcp', server: { id: tenant, name: 'Synthetic authenticated endpoint' },
    endpoint: 'https://literature.example.com/mcp',
    inbound: type === 'entra-sso' ? { type: 'entra', tenantId: tenant, clientId: resource,
      applicationIdUri: `api://${resource}`, scope: 'access_as_user', allowedClientIds: [fccTokenStoreClientId] }
      : { type: 'oauth' },
  };
  const descriptor = (await prepareMcpServer(definition)).descriptor;
  const config = {
    schemaVersion: 1, source: { descriptorFile: 'descriptor.json' },
    operator: { tenantId: tenant, accountName: 'operator@example.com' },
    registration: { type, name: 'Synthetic registration', targetAudience: 'HomeTenant', applicableToApps: 'SpecificApp', appId,
      ...(type === 'oauth' ? { clientId: 'synthetic-provider-client', authorizationUrl: 'https://identity.example.com/authorize',
        tokenUrl: 'https://identity.example.com/token', refreshUrl: 'https://identity.example.com/refresh',
        scopes: ['read:literature', 'offline_access'], isPKCEEnabled: true,
        tokenExchangeMethodType: 'PostRequestBody', credential: { type: 'none' } } : {}),
    },
    review: { metadataApprovedForExport: true },
  };
  const options = { workspaceRoot: root, config: path.join(root, 'registration.json'), output: path.join(root, 'auth.json') };
  const save = () => writeFile(options.config, savedJson(config));
  await writeFile(path.join(root, 'descriptor.json'), savedJson(descriptor));
  await save();
  const importBundle = () => withCliWorkspace(root, () => readAuthRegistrationBundle(options.output, descriptor));
  const addReference = () => {
    config.registration.reference = { registrationId, ...(type === 'entra-sso' ? { applicationIdUri: `api://${resource}` } : {}) };
  };
  return { root, definition, descriptor, config, options, save, importBundle, addReference };
}
async function writePreparation(f) {
  const plan = await planAuthRegistrationBundle(f.options);
  const result = await writeAuthRegistrationBundle({ ...f.options, approval: plan.approvalToken });
  return { plan, result };
}
async function fccOptions(f) {
  const config = {
    schemaVersion: 1,
    connector: { displayName: 'Synthetic literature', description: 'Synthetic consumer',
      developer: { name: 'Example', websiteUrl: 'https://example.com', privacyPolicyUrl: 'https://example.com/privacy',
        termsOfUseUrl: 'https://example.com/terms' } },
    source: { descriptorFile: 'descriptor.json', authenticationBundleFile: 'auth.json' },
    authentication: { type: f.config.registration.type },
    review: { metadataApprovedForExport: true, dataAccess: 'user-scoped',
      dataAccessReason: 'Synthetic provider permission review.', tools: [] },
  };
  const options = { workspaceRoot: f.root, config: path.join(f.root, 'fcc.json'), output: path.join(f.root, 'fcc-output.json') };
  await writeFile(options.config, savedJson(config));
  return { options, config };
}

test('SSO preparation preserves the exact provider contract but cannot authenticate or register', async t => {
  const f = await fixture(t);
  const { plan, result } = await writePreparation(f);
  assert.equal(result.executionReadiness, false);
  assert.equal(plan.bundle.readiness.status, 'blocked');
  assert.deepEqual(plan.bundle.readiness.gaps.map(g => g.code), [
    'PROVIDER_ISOLATION_UNQUALIFIED', 'OPERATOR_IDENTITY_UNVERIFIED', 'REGISTRATION_EXECUTION_UNIMPLEMENTED',
  ]);
  assert.deepEqual(plan.bundle.providerPreparation.action, {
    uses: 'oauth/register',
    with: { name: 'Synthetic registration', flow: 'authorizationCode', identityProvider: 'MicrosoftEntra',
      clientId: resource, appId, baseUrl: f.descriptor.endpoint, targetAudience: 'HomeTenant', applicableToApps: 'SpecificApp' },
    writeToEnvironmentFile: { configurationId: 'MCP_AUTH_REGISTRATION_ID', applicationIdUri: 'MCP_AUTH_APPLICATION_ID_URI' },
  });

  test('new shared and FCC handoffs qualify the portal scope without changing runtime claims', async t => {
    const f = await fixture(t);
    f.addReference();
    const { plan } = await (async () => { await f.save(); return writePreparation(f); })();
    const expected = `api://${resource}/access_as_user`;
    assert.equal(plan.bundle.manualSetup.fields.find(field => field.label.startsWith('Portal OAuth')).value, expected);
    assert.equal(plan.bundle.manualSetup.fields.find(field => field.label.startsWith('API permission')).value, 'access_as_user');
    assert.equal(plan.bundle.routes.manualFcc.requiresAgentOrAppPackage, false);
    const fcc = await planFccBundle((await fccOptions(f)).options);
    assert.equal(fcc.bundle.manualSetup.authenticationRegistration.fields.find(field => field.label.startsWith('Portal OAuth')).value, expected);
    assert.equal(f.descriptor.inbound.scope, 'access_as_user');
  });

  test('legacy shared-auth bundles still verify with their historical rendering and digest', async t => {
    const f = await fixture(t);
    const { bundle } = await planAuthRegistrationBundle(f.options);
    delete bundle.handoffVersion;
    delete bundle.routes;
    bundle.manualSetup.fields = bundle.manualSetup.fields.filter(field => !field.label.startsWith('Portal OAuth'));
    bundle.manualSetup.fields.find(field => field.label.startsWith('API permission')).label = 'Delegated scope';
    bundle.manualSetup.instructions = bundle.manualSetup.instructions.filter(item => !ssoScopeInstructions.includes(item));
    delete bundle.contentDigest;
    bundle.contentDigest = hash(bundle);
    await writeFile(f.options.output, savedJson(bundle));
    assert.deepEqual(await f.importBundle(), bundle);
  });

  test('portal scope does not guess missing, malformed, duplicated or already-qualified values', () => {
    assert.equal(portalSsoScope(undefined, 'access_as_user').status, 'missing');
    for (const [uri, scope] of [
      [`api://${resource}/`, 'access_as_user'], [`api://${resource}/access_as_user`, 'access_as_user'],
      [`api://${resource}`, `api://${resource}/access_as_user`], ['https://example.com/a//b', 'read'],
      ['https://name:secret@example.com', 'read'], ['api://example?x=1', 'read'],
    ]) assert.equal(portalSsoScope(uri, scope).status, 'invalid');
  });
  assert.equal(plan.bundle.registrationReference.status, 'missing');
  assert.ok(!savedJson(plan.bundle).includes(f.config.operator.accountName));
  assert.deepEqual(await f.importBundle(), plan.bundle);
  const { contentDigest, ...content } = plan.bundle;
  assert.equal(contentDigest, hash(content));
  assert.deepEqual(await readFile(f.options.output, 'utf8'), savedJson(plan.bundle));
  assert.ok(!(await readdir(f.root)).some(file => file.endsWith('.pending')));
  await assert.rejects(writeAuthRegistrationBundle({ ...f.options, approval: plan.approvalToken }), { code: 'MCP_AUTH_REGISTRATION_OUTPUT_EXISTS' });
});

test('OAuth PKCE action carries explicit endpoints, scope order, restrictions and method without a secret', async t => {
  const f = await fixture(t, 'oauth');
  f.config.registration.targetAudience = 'AnyTenant';
  f.config.registration.applicableToApps = 'AnyApp';
  await f.save();
  const { plan } = await writePreparation(f);
  const action = plan.bundle.providerPreparation.action.with;
  assert.equal(action.identityProvider, 'Custom');
  assert.equal(action.authorizationUrl, f.config.registration.authorizationUrl);
  assert.equal(action.tokenUrl, f.config.registration.tokenUrl);
  assert.equal(action.refreshUrl, f.config.registration.refreshUrl);
  assert.equal(action.scope, 'read:literature,offline_access');
  assert.equal(action.targetAudience, 'AnyTenant');
  assert.equal(action.applicableToApps, 'AnyApp');
  assert.equal(action.appId, appId);
  assert.equal(action.clientSecret, undefined);
  assert.equal(action.isPKCEEnabled, true);
  assert.equal(action.tokenExchangeMethodType, 'PostRequestBody');
  assert.equal(plan.bundle.consumers.plugin.status, 'mapping-required');
  assert.equal(plan.bundle.evidence.proofReplayAuthorized, false);
  assert.deepEqual(await f.importBundle(), plan.bundle);
});

test('OAuth confidential client retains only a versioned Key Vault reference and emits no incomplete runnable action', async t => {
  const f = await fixture(t, 'oauth');
  f.config.registration.isPKCEEnabled = false;
  f.config.registration.credential = { type: 'key-vault-reference',
    secretIdentifier: 'https://synthetic-vault.vault.azure.net/secrets/oauth-client/0123456789abcdef0123456789abcdef' };
  await f.save();
  const { plan } = await writePreparation(f);
  assert.equal(plan.bundle.providerPreparation.action, null);
  assert.equal(plan.bundle.providerPreparation.secretResolution, 'not-performed');
  assert.ok(plan.bundle.readiness.gaps.some(g => g.code === 'SECRET_RESOLUTION_UNIMPLEMENTED'));
  assert.deepEqual(plan.bundle.request.registration.credential, f.config.registration.credential);
  assert.ok(plan.bundle.manualSetup.instructions.some(s => s.includes('Do not paste a Key Vault reference as a client secret')));
});

for (const restriction of ['AnyApp', 'SpecificApp']) {
  test(`missing real app ID stays explicit for ${restriction}; never synthesize an app`, async t => {
    const f = await fixture(t);
    delete f.config.registration.appId;
    f.config.registration.applicableToApps = restriction;
    await f.save();
    const { bundle } = await planAuthRegistrationBundle(f.options);
    assert.equal(bundle.providerPreparation.action, null);
    assert.ok(bundle.readiness.gaps.some(g => g.code === 'APP_ID_MISSING'));
    assert.deepEqual(bundle.manualSetup.fields.find(field => field.label === 'M365 app ID'),
      { label: 'M365 app ID', value: null, status: 'missing' });
  });
}

for (const type of ['entra-sso', 'oauth']) {
  test(`${type} existing opaque reference feeds FCC and plugin data without recreating or claiming verification`, async t => {
    const f = await fixture(t, type);
    f.addReference(); await f.save();
    const { plan } = await writePreparation(f);
    assert.deepEqual(await f.importBundle(), plan.bundle);
    assert.equal(plan.bundle.providerPreparation.action, null);
    assert.equal(plan.bundle.registrationReference.status, 'provided-unverified');
    assert.equal(plan.bundle.consumers.plugin.authentication.registrationId, registrationId);
    const fc = await fccOptions(f);
    const fcc = await planFccBundle(fc.options);
    assert.equal(fcc.bundle.authentication.registrationId, registrationId);
    assert.equal(fcc.bundle.manualSetup.formFields.at(-1).value, registrationId);
    assert.equal(fcc.bundle.manualSetup.sharedRegistration.referenceStatus, 'provided-unverified');
    assert.equal(fcc.bundle.manualSetup.sharedRegistration.evidence.registration, 'not-verified');
    assert.equal(fcc.bundle.evidence.consumerExecution, 'not-verified');
    assert.ok(fcc.bundle.readiness.gaps.some(g => g.code === 'CAPTURE_MISSING'));
    if (type === 'oauth') assert.ok(fcc.bundle.readiness.gaps.some(g => g.code === 'OAUTH_DISCOVERY_UNSUPPORTED'));
    await writeFccBundle({ ...fc.options, approval: fcc.approvalToken });
    assert.deepEqual(JSON.parse(await readFile(fc.options.output)), fcc.bundle);
  });
}

test('FCC rejects conflicting explicit references and preserves explicit-input approval binding', async t => {
  const f = await fixture(t);
  f.addReference(); await f.save(); await writePreparation(f);
  const fc = await fccOptions(f);
  const before = await planFccBundle(fc.options);
  fc.config.authentication.registrationId = registrationId;
  await writeFile(fc.options.config, savedJson(fc.config));
  const after = await planFccBundle(fc.options);
  assert.deepEqual(after.bundle, before.bundle);
  assert.notEqual(before.approvalToken, after.approvalToken);
  await assert.rejects(writeFccBundle({ ...fc.options, approval: before.approvalToken }), { code: 'MCP_FCC_APPROVAL_REQUIRED' });
  fc.config.authentication.registrationId = 'different-reference';
  await writeFile(fc.options.config, savedJson(fc.config));
  await assert.rejects(planFccBundle(fc.options), { code: 'MCP_FCC_AUTH_MISMATCH' });
});

test('FCC approval binds imported metadata; changed restrictions cannot reuse an old approval', async t => {
  const f = await fixture(t);
  f.addReference(); await f.save(); await writePreparation(f);
  const fc = await fccOptions(f);
  const before = await planFccBundle(fc.options);
  f.config.registration.applicableToApps = 'AnyApp';
  await f.save();
  const changed = await planAuthRegistrationBundle({ ...f.options, output: path.join(f.root, 'auth-new.json') });
  await writeFile(f.options.output, savedJson(changed.bundle));
  await assert.rejects(writeFccBundle({ ...fc.options, approval: before.approvalToken }), { code: 'MCP_FCC_APPROVAL_REQUIRED' });
});

for (const [name, mutate, type = 'entra-sso', code = 'INPUT'] of [
  ['unknown version', f => { f.config.schemaVersion = 2; }],
  ['unknown field', f => { f.config.registration.extra = true; }],
  ['missing operator', f => { delete f.config.operator; }],
  ['missing export review', f => { f.config.review.metadataApprovedForExport = false; }],
  ['blank name', f => { f.config.registration.name = '  '; }],
  ['newline name', f => { f.config.registration.name = 'registration\n'; }],
  ['ATK name expression', f => { f.config.registration.name = '${{UNREVIEWED_VALUE}}'; }],
  ['missing restriction', f => { delete f.config.registration.applicableToApps; }],
  ['foreign tenant', f => { f.config.operator.tenantId = appId; }, 'entra-sso', 'TENANT_MISMATCH'],
  ['SSO reference without URI', f => { f.config.registration.reference = { registrationId }; }],
  ['invalid opaque reference', f => { f.addReference(); f.config.registration.reference.registrationId = 'abc=def'; }],
  ['URI credentials', f => { f.addReference(); f.config.registration.reference.applicationIdUri = 'api://user:password@example.com'; }],
  ['secret text', f => { f.config.registration.name = 'client_secret=do-not-log-this'; }, 'entra-sso', 'SENSITIVE_INPUT'],
  ['OAuth raw credential', f => { f.config.registration.credential = { type: 'secret', value: 'do-not-log-this' }; }, 'oauth'],
  ['OAuth secretless without PKCE', f => { f.config.registration.isPKCEEnabled = false; }, 'oauth'],
  ['OAuth duplicate scopes', f => { f.config.registration.scopes = ['read', 'read']; }, 'oauth'],
  ['OAuth ambiguous scope separator', f => { f.config.registration.scopes = ['read,write']; }, 'oauth'],
  ['OAuth whitespace scope', f => { f.config.registration.scopes = ['read write']; }, 'oauth'],
  ['OAuth client expression', f => { f.config.registration.clientId = '${{UNREVIEWED_CLIENT}}'; }, 'oauth'],
  ['OAuth unversioned secret reference', f => { f.config.registration.credential = {
    type: 'key-vault-reference', secretIdentifier: 'https://synthetic-vault.vault.azure.net/secrets/oauth-client',
  }; }, 'oauth'],
]) {
  test(`registration rejects ${name}`, async t => {
    const f = await fixture(t, type); mutate(f); await f.save();
    await assert.rejects(planAuthRegistrationBundle(f.options), { code: `MCP_AUTH_REGISTRATION_${code}` });
    assert.ok(!(await readdir(f.root)).includes('auth.json'));
  });
}

test('OAuth does not discover endpoints or accept credentials/query/fragment in provider URLs', async t => {
  const f = await fixture(t, 'oauth');
  for (const url of ['http://identity.example.com/token', 'https://user:pass@identity.example.com/token',
    'https://identity.example.com/token?key=hidden', 'https://identity.example.com/token#fragment', 'https://localhost/token']) {
    f.config.registration.tokenUrl = url; await f.save();
    await assert.rejects(planAuthRegistrationBundle(f.options));
  }
});

test('registration rejects anonymous descriptors rather than inventing a resource or provider', async t => {
  const f = await fixture(t);
  f.definition.inbound = { type: 'anonymous' };
  await writeFile(path.join(f.root, 'descriptor.json'), savedJson((await prepareMcpServer(f.definition)).descriptor));
  await assert.rejects(planAuthRegistrationBundle(f.options), { code: 'MCP_AUTH_REGISTRATION_AUTH_MISMATCH' });
});

test('registration rejects changed input, operator and output approvals without output', async t => {
  const f = await fixture(t);
  const original = await planAuthRegistrationBundle(f.options);
  await assert.rejects(writeAuthRegistrationBundle({ ...f.options, approval: 'wrong' }), { code: 'MCP_AUTH_REGISTRATION_APPROVAL_REQUIRED' });
  await assert.rejects(writeAuthRegistrationBundle({ ...f.options, output: path.join(f.root, 'different.json'),
    approval: original.approvalToken }), { code: 'MCP_AUTH_REGISTRATION_APPROVAL_REQUIRED' });
  f.config.operator.accountName = 'another@example.com'; await f.save();
  const changed = await planAuthRegistrationBundle(f.options);
  assert.deepEqual(changed.bundle, original.bundle);
  assert.notEqual(changed.approvalToken, original.approvalToken);
  await assert.rejects(writeAuthRegistrationBundle({ ...f.options, approval: original.approvalToken }), { code: 'MCP_AUTH_REGISTRATION_APPROVAL_REQUIRED' });
  assert.ok(!(await readdir(f.root)).includes('auth.json'));
});

test('registration imports reject changed source descriptors and forged readiness even with a recomputed digest', async t => {
  const f = await fixture(t);
  const { plan } = await writePreparation(f);
  f.definition.endpoint = 'https://different.example.com/mcp';
  const different = (await prepareMcpServer(f.definition)).descriptor;
  await assert.rejects(withCliWorkspace(f.root, () => readAuthRegistrationBundle(f.options.output, different)),
    { code: 'MCP_AUTH_REGISTRATION_BUNDLE_INVALID' });
  const tampered = structuredClone(plan.bundle);
  tampered.evidence.executionReadiness = true;
  const { contentDigest, ...content } = tampered;
  await writeFile(f.options.output, savedJson({ ...content, contentDigest: hash(content) }));
  await assert.rejects(f.importBundle(), { code: 'MCP_AUTH_REGISTRATION_BUNDLE_INVALID' });
});

test('registration rejects unsupported imports, extra fields and missing digest', async t => {
  const f = await fixture(t);
  const { plan } = await writePreparation(f);
  for (const mutate of [
    value => { value.schemaVersion = 2; },
    value => { value.producer.name = 'untrusted'; },
    value => { value.extra = true; },
    value => { delete value.contentDigest; },
  ]) {
    const value = structuredClone(plan.bundle); mutate(value);
    await writeFile(f.options.output, savedJson(value));
    await assert.rejects(f.importBundle(), { code: 'MCP_AUTH_REGISTRATION_BUNDLE_INVALID' });
  }
});

test('registration confines input/output and rejects oversized, invalid or nonregular JSON', async t => {
  const f = await fixture(t);
  await assert.rejects(planAuthRegistrationBundle({ ...f.options, workspaceRoot: undefined }),
    { code: 'MCP_AUTH_REGISTRATION_WORKSPACE' });
  await assert.rejects(planAuthRegistrationBundle({ ...f.options, output: path.join(f.root, '..', 'escape.json') }));
  await assert.rejects(planAuthRegistrationBundle({ ...f.options, output: path.join(f.root, 'output.yaml') }),
    { code: 'MCP_AUTH_REGISTRATION_OUTPUT' });
  await assert.rejects(planAuthRegistrationBundle({ ...f.options, config: f.root }));
  f.config.source.descriptorFile = path.join('..', 'outside.json'); await f.save();
  await assert.rejects(planAuthRegistrationBundle(f.options));
  await writeFile(f.options.config, '{invalid-private-marker');
  await assert.rejects(planAuthRegistrationBundle(f.options), e => e.code === 'MCP_AUTH_REGISTRATION_INPUT' && !e.message.includes('private-marker'));
  await writeFile(f.options.config, ' '.repeat(1048577));
  await assert.rejects(planAuthRegistrationBundle(f.options), { code: 'MCP_AUTH_REGISTRATION_INPUT' });
});

test('registration rejects junction-backed output directories', async t => {
  const f = await fixture(t);
  const target = path.join(f.root, 'target'), linked = path.join(f.root, 'linked');
  await mkdir(target);
  await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(planAuthRegistrationBundle({ ...f.options, output: path.join(linked, 'auth.json') }));
});

test('concurrent registration bundle publication writes at most one output and leaves no staging files', async t => {
  const f = await fixture(t);
  const plan = await planAuthRegistrationBundle(f.options);
  const results = await Promise.allSettled([1, 2].map(() => writeAuthRegistrationBundle({ ...f.options, approval: plan.approvalToken })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.deepEqual(JSON.parse(await readFile(f.options.output)), plan.bundle);
  assert.ok(!(await readdir(f.root)).some(file => file.endsWith('.pending')));
});

test('shared bundle writer rejects changed review after staging and removes only its staging file', async t => {
  const f = await fixture(t);
  const plan = await planAuthRegistrationBundle(f.options);
  let calls = 0;
  const requireBundle = (ok, code, message) => {
    if (!ok) throw Object.assign(new Error(message), { code });
  };
  await assert.rejects(withCliWorkspace(f.root, () => writeNewJsonBundle({ ...f.options, approval: plan.approvalToken },
    async () => ++calls === 1 ? plan : { ...plan, approvalToken: 'changed-during-write' }, requireBundle)), { code: 'INPUT_CHANGED' });
  assert.equal(calls, 2);
  assert.ok(!(await readdir(f.root)).some(file => file.endsWith('.pending') || file === 'auth.json'));
});

async function wiqdOptions(f) {
  const project = path.join(f.root, "WIQD user's project");
  await mkdir(project);
  const input = { schemaVersion: 1, registrationConfig: 'registration.json',
    wiqdProject: path.basename(project), environment: 'dev' };
  const options = { workspaceRoot: f.root, config: path.join(f.root, 'wiqd.json'), output: path.join(f.root, 'handoff.json') };
  const save = () => writeFile(options.config, savedJson(input));
  await save();
  return { input, options, save, project };
}

for (const type of ['entra-sso', 'oauth']) {
  test(`WIQD ${type} handoff is local-only, quotes Windows paths and preserves the registration contract`, async t => {
    const f = await fixture(t, type), w = await wiqdOptions(f);
    const legacy = await planAuthRegistrationBundle(f.options);
    const plan = await planAuthWiqdBundle(w.options);
    const b = plan.bundle;
    assert.deepEqual(b.preparation, legacy.bundle);
    assert.deepEqual(b.registration.action, legacy.bundle.providerPreparation.action);
    assert.equal(b.provider.linuxRequired, false);
    assert.equal(b.provider.automaticExecution, false);
    assert.equal(b.provider.projectIsolatedByToolkit, false);
    assert.equal(b.readiness.status, 'blocked');
    assert.deepEqual(b.commands.login.args, ['auth', 'login', '--interactive', '--skill', 'wiqd', '--workflow', 'wiqd-core']);
    assert.equal(b.commands.provision.args.at(-1), w.project);
    assert.ok(b.commands.provision.powershell.includes("user''s project"));
    assert.ok(b.steps.some(step => step.includes('ENTIRE provisioning lifecycle')));
    assert.ok(b.steps.some(step => step.includes('BOTH m365agents.yml and m365agents.local.yml')));
    assert.ok(b.steps.some(step => step.includes('never automatically retried')));
    assert.ok(!savedJson(b).includes(f.config.operator.accountName));
    assert.equal(b.returnMapping.length, type === 'entra-sso' ? 2 : 1);
    const { contentDigest, ...content } = b;
    assert.equal(contentDigest, hash(content));
    await assert.rejects(writeAuthWiqdBundle({ ...w.options, approval: 'wrong' }), { code: 'MCP_AUTH_WIQD_APPROVAL_REQUIRED' });
    const written = await writeAuthWiqdBundle({ ...w.options, approval: plan.approvalToken });
    assert.equal(written.executionReadiness, false);
    assert.deepEqual(JSON.parse(await readFile(w.options.output)), b);
    assert.deepEqual(await readdir(w.project), []);
    assert.deepEqual((await planAuthRegistrationBundle(f.options)).bundle, legacy.bundle);
    await assert.rejects(writeAuthWiqdBundle({ ...w.options, approval: plan.approvalToken }), { code: 'MCP_AUTH_WIQD_OUTPUT_EXISTS' });
  });
}

for (const missing of ['app-id', 'confidential-secret', 'existing-reference']) {
  test(`WIQD handoff emits no provider commands for ${missing}`, async t => {
    const f = await fixture(t, missing === 'confidential-secret' ? 'oauth' : 'entra-sso');
    const w = await wiqdOptions(f);
    if (missing === 'app-id') delete f.config.registration.appId;
    if (missing === 'confidential-secret') {
      f.config.registration.isPKCEEnabled = false;
      f.config.registration.credential = { type: 'key-vault-reference',
        secretIdentifier: 'https://synthetic-vault.vault.azure.net/secrets/oauth-client/0123456789abcdef0123456789abcdef' };
    }
    if (missing === 'existing-reference') f.addReference();
    await f.save();
    const { bundle } = await planAuthWiqdBundle(w.options);
    assert.equal(bundle.registration.action, null);
    assert.deepEqual(bundle.commands, {});
    assert.equal(bundle.effects.credentialAccess, false);
    if (missing === 'existing-reference') {
      assert.equal(bundle.registration.reference.registrationId, registrationId);
      assert.equal(bundle.registration.status, 'provided-unverified');
      await writePreparation(f);
      const { options } = await fccOptions(f);
      assert.equal((await planFccBundle(options)).bundle.authentication.registrationId, registrationId);
    }
  });
}

test('WIQD handoff approval binds identity, target environment and destination', async t => {
  const f = await fixture(t), w = await wiqdOptions(f);
  const { approvalToken } = await planAuthWiqdBundle(w.options);
  w.input.environment = 'staging';
  await w.save();
  await assert.rejects(writeAuthWiqdBundle({ ...w.options, approval: approvalToken }), { code: 'MCP_AUTH_WIQD_APPROVAL_REQUIRED' });
  w.input.environment = 'dev';
  await w.save();
  f.config.operator.accountName = 'different@example.com';
  await f.save();
  await assert.rejects(writeAuthWiqdBundle({ ...w.options, approval: approvalToken }), { code: 'MCP_AUTH_WIQD_APPROVAL_REQUIRED' });
  f.config.operator.accountName = 'operator@example.com';
  await f.save();
  await assert.rejects(writeAuthWiqdBundle({ ...w.options, output: path.join(f.root, 'different.json'), approval: approvalToken }),
    { code: 'MCP_AUTH_WIQD_APPROVAL_REQUIRED' });
});

test('WIQD handoff refuses unsafe environments, extra input, missing projects and path escape', async t => {
  const f = await fixture(t), w = await wiqdOptions(f);
  await assert.rejects(planAuthWiqdBundle({ ...w.options, output: path.join(w.project, 'handoff.json') }),
    { code: 'MCP_AUTH_WIQD_OUTPUT' });
  assert.deepEqual(await readdir(w.project), []);
  for (const environment of ['../dev', 'dev;whoami', '', 'dev\n']) {
    w.input.environment = environment;
    await w.save();
    await assert.rejects(planAuthWiqdBundle(w.options), { code: 'MCP_AUTH_WIQD_INPUT' });
  }
  w.input.environment = 'dev';
  w.input.execute = true;
  await w.save();
  await assert.rejects(planAuthWiqdBundle(w.options), { code: 'MCP_AUTH_WIQD_INPUT' });
  delete w.input.execute;
  w.input.wiqdProject = 'missing';
  await w.save();
  await assert.rejects(planAuthWiqdBundle(w.options), { code: 'ENOENT' });
  w.input.wiqdProject = '..';
  await w.save();
  await assert.rejects(planAuthWiqdBundle(w.options));
});
