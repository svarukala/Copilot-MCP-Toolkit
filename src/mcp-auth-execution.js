import Ajv from 'ajv';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { assertProjectPath, withCliWorkspace } from './config.js';
import { readControl, writeControl } from './mcp-control.js';
import { boundedSnapshot, metadataDigest, savedJson } from './anonymous-metadata.js';
import { secretIssues } from './validation.js';
import { getLibraryInfo } from './machine-contract.js';
import { loadAuthRegistration, authRegistrationAction, registrationIdSchema, validApplicationIdUri } from './mcp-auth-registration.js';
import { atkProvider } from './mcp-atk-provider.js';
import { readAzureIdentity, azureIdentityGuard } from './azure-identity.js';
import { runAzureCommand } from './azure.js';

const text = { type: 'string', minLength: 1, maxLength: 2048 };
export const authExecutionSchema = {
  type: 'object', additionalProperties: false, required: ['schemaVersion', 'registrationConfig', 'providerRoot'],
  properties: { schemaVersion: { const: 1 }, registrationConfig: text, providerRoot: text, secretIdentityProject: text,
    allowAnyAppValidationPlaceholder: { type: 'boolean' } },
};
const validConfig = new Ajv().compile(authExecutionSchema);
const hash = value => metadataDigest(boundedSnapshot(value));
const anyAppValidationId = '00000000-0000-4000-8000-000000000000';
const providerStartupNotice = 'ATK startup also requests https://default.exp-tas.com/vscode/ab with a machine-derived client identifier and CLI metadata. --telemetry false does not disable this experimentation request.';
function requireExecution(ok, code, message) {
  if (!ok) throw Object.assign(new Error(message), { code: `MCP_AUTH_EXECUTION_${code}` });
}
function anyAppCompatibility(request) {
  const r = request.registration;
  requireExecution(r.type === 'entra-sso' && r.targetAudience === 'HomeTenant'
    && r.applicableToApps === 'AnyApp' && r.appId === undefined, 'COMPATIBILITY',
  'The validation-placeholder opt-in requires Entra SSO, explicit HomeTenant/AnyApp and no supplied app ID. SpecificApp requires a real intended app ID.');
  return { mode: 'atk-anyapp-validation-placeholder', reviewedVersion: '1.1.17',
    validationAppId: anyAppValidationId, expectedM365AppId: '',
    mappingEvidence: 'source-reviewed-not-live-verified', createsApp: false };
}
async function readJson(filename) {
  let result;
  try { result = await readControl(filename); }
  catch (error) {
    if (error.code === 'ENOENT') throw error;
    requireExecution(false, 'INPUT', 'Invalid or unsafe authentication control file. Contents are not logged.');
  }
  requireExecution(!secretIssues(savedJson(result)), 'INPUT', 'Control files must contain nonsecret metadata only.');
  return result;
}
async function optional(filename) {
  try { return await readJson(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const isDigest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const isTimestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
function recordShape(record, keys) {
  return record && typeof record === 'object' && !Array.isArray(record)
    && Object.keys(record).sort().join(',') === keys.sort().join(',');
}
async function stateAt(project) {
  const session = await optional(path.join(project, 'session.json'));
  if (!session) return null;
  requireExecution(session.schemaVersion === 1 && session.kind === 'mcp-auth-private-session'
    && session.owner?.project === project && typeof session.owner.epoch === 'string'
    && typeof session.owner.workspaceRoot === 'string' && typeof session.runtime === 'string'
    && isDigest(session.inputDigest) && isDigest(session.targetDigest) && session.provider
    && typeof session.operator?.tenantId === 'string' && typeof session.operator?.accountName === 'string',
  'STATE', 'Invalid or copied authentication session; no provider operation is allowed.');
  const records = {};
  for (const name of ['initialized', 'login-attempt', 'login', 'register-attempt', 'result', 'closed']) {
    records[name] = await optional(path.join(project, `${name}.json`));
  }
  for (const name of ['initialized', 'closed']) {
    if (records[name] !== null) requireExecution(recordShape(records[name], ['completedAt'])
      && isTimestamp(records[name].completedAt), 'STATE', 'Malformed authentication phase record.');
  }
  const loginAttempt = records['login-attempt'], login = records.login, attempt = records['register-attempt'];
  if (loginAttempt !== null) requireExecution(records.initialized
    && recordShape(loginAttempt, ['startedAt', 'approvalDigest'])
    && isTimestamp(loginAttempt.startedAt) && isDigest(loginAttempt.approvalDigest), 'STATE', 'Malformed login attempt.');
  if (login !== null) requireExecution(loginAttempt && recordShape(login, ['completedAt', 'identity'])
    && isTimestamp(login.completedAt)
    && login.identity?.accountName?.toLowerCase() === session.operator.accountName.toLowerCase()
    && login.identity?.tenantId?.toLowerCase() === session.operator.tenantId.toLowerCase(),
  'STATE', 'Malformed or mismatched login record.');
  if (attempt !== null) requireExecution(login && attempt.schemaVersion === 1 && attempt.project === project
    && attempt.status === 'dispatch-reserved-consumed' && isTimestamp(attempt.startedAt)
    && isDigest(attempt.approvalDigest) && attempt.targetDigest === session.targetDigest
    && hash(attempt.target) === session.targetDigest, 'STATE', 'Malformed or mismatched registration attempt.');
  if (records.result !== null) {
    const result = checkedResult(records.result);
    requireExecution(attempt && result.attemptDigest === hash(attempt)
      && hash(result.identity) === hash(login.identity) && hash(result.provider) === hash(session.provider)
      && hash(result.providerCompatibility ?? null) === hash(attempt.providerCompatibility ?? null),
    'STATE', 'Registration result does not match the retained attempt/identity/provider.');
  }
  return { session, records };
}
function statusOf(state) {
  if (!state) return 'not-initialized';
  const r = state.records;
  return r.closed ? 'closed' : r.result ? 'created-unverified' : r['register-attempt'] ? 'registration-unknown-consumed'
    : r.login ? 'signed-in-requires-identity-confirmation' : r['login-attempt'] ? 'login-unknown'
      : r.initialized ? 'initialized-not-signed-in' : 'initialization-unknown';
}
function checkedResult(value) {
  requireExecution(value && typeof value === 'object', 'RESULT', 'Missing registration result.');
  const { contentDigest, ...content } = value;
  requireExecution(value.schemaVersion === 1 && value.kind === 'mcp-auth-registration-result'
    && value.status === 'created-unverified' && value.executionReadiness === false && value.settings === 'not-verified'
    && ['entra-sso', 'oauth'].includes(value.request?.registration?.type)
    && contentDigest === hash(content), 'RESULT', 'Retained registration result is invalid or modified.');
  checkReference(value.registration, value.request?.registration?.type);
  if (value.providerCompatibility !== undefined || !value.request.registration.appId) {
    const expected = anyAppCompatibility(value.request);
    requireExecution(value.provider?.version === expected.reviewedVersion
      && hash(value.providerCompatibility ?? null) === hash(expected), 'RESULT',
    'The registration result must retain the exact reviewed AnyApp compatibility disclosure.');
  }
  return value;
}
async function context(options, provider) {
  requireExecution(typeof options.config === 'string' && typeof options.project === 'string', 'INPUT',
    'Authentication execution requires --config and an explicit --project session directory.');
  const configFile = await assertProjectPath(path.resolve(options.config));
  const config = await readJson(configFile);
  requireExecution(validConfig(config), 'INPUT', 'Use mcp-auth-execution-schema; no credentials or arbitrary commands are admitted.');
  const registrationConfig = await assertProjectPath(path.resolve(path.dirname(configFile), config.registrationConfig));
  const selected = await loadAuthRegistration(registrationConfig);
  requireExecution(!selected.input.source.registrationResultFile && !selected.input.registration.reference, 'EXISTING_REFERENCE',
    'An existing registration reference/result cannot trigger a new registration.');
  const installation = await provider.inspect(config.providerRoot);
  const project = await assertProjectPath(path.resolve(options.project));
  const state = await stateAt(project);
  if (state) requireExecution(state.session.owner.workspaceRoot === path.resolve(options.workspaceRoot), 'STATE',
    'Authentication session workspace changed; copied/restored sessions cannot adopt provider identity.');
  const request = { tenantId: selected.input.operator.tenantId, registration: selected.input.registration };
  requireExecution(request.registration.appId !== anyAppValidationId, 'COMPATIBILITY',
    'The reserved validation placeholder must not be supplied as a real app ID.');
  const compatibility = config.allowAnyAppValidationPlaceholder === true ? anyAppCompatibility(request) : null;
  if (compatibility) requireExecution(installation.version === compatibility.reviewedVersion, 'COMPATIBILITY',
    'The AnyApp validation workaround is qualified only against the pinned ATK 1.1.17 source contract.');
  const target = { type: request.registration.type, tenantId: request.tenantId.toLowerCase(),
    endpoint: selected.descriptor.endpoint, clientId: request.registration.type === 'entra-sso'
      ? selected.descriptor.inbound.clientId.toLowerCase() : request.registration.clientId,
    applicableToApps: request.registration.applicableToApps,
    appId: request.registration.applicableToApps === 'SpecificApp' ? request.registration.appId?.toLowerCase() ?? null : null };
  const targetDigest = hash(target);
  const reservations = await assertProjectPath(path.join(options.workspaceRoot, '.auth-registration-attempts'));
  const reservation = path.join(reservations, `${targetDigest.slice(7)}.json`);
  const consumed = await optional(reservation);
  let azureIdentity = null, secretProject = null;
  const confidential = request.registration.type === 'oauth' && request.registration.credential.type === 'key-vault-reference';
  if (config.secretIdentityProject !== undefined) {
    requireExecution(confidential, 'INPUT', 'A secret identity project is accepted only for an explicit confidential OAuth client.');
    secretProject = await assertProjectPath(path.resolve(path.dirname(configFile), config.secretIdentityProject));
    azureIdentity = await readAzureIdentity({}, secretProject, { required: true });
    requireExecution(azureIdentity.target.tenantId === request.tenantId.toLowerCase()
      && azureIdentity.target.accountName === selected.input.operator.accountName.toLowerCase(), 'IDENTITY',
    'The explicit private Key Vault Azure identity must match the selected registration tenant/operator.');
  }
  const inputDigest = hash({ configFile, config, registrationConfig, input: selected.input, descriptor: selected.descriptor });
  return { project, state, selected, installation, inputDigest, request, target, targetDigest,
    reservation, reservations, consumed, confidential, azureIdentity, secretProject, compatibility };
}
async function prepare(options, provider) {
  const phase = options.phase;
  requireExecution(['initialize', 'login', 'register', 'close'].includes(phase), 'PHASE',
    'Select initialize, login, register or close. Each phase has a separate approval.');
  if (phase === 'close') {
    const project = await assertProjectPath(path.resolve(options.project));
    const state = await stateAt(project);
    requireExecution(state && state.session.owner.workspaceRoot === path.resolve(options.workspaceRoot)
      && !state.records.closed, 'STATE', 'Select an existing owned, unclosed authentication session.');
    const plan = { action: 'mcp-auth-execution', phase, project, status: 'planned', gaps: [],
      stateDigest: hash(state), session: state.session, effects: ['Remove only this session owned tmpfs runtime, including credentials and transient provider files. Retain all immutable local evidence and consumed reservations.'] };
    return { ...plan, approvalToken: `mcp-auth-execution/${hash(plan)}` };
  }
  const c = await context(options, provider), gaps = [];
  if (provider.platform() !== 'linux') gaps.push('LINUX_TMPFS_REQUIRED');
  if (!c.request.registration.appId && !c.compatibility) gaps.push('REAL_M365_APP_ID_REQUIRED');
  if (phase === 'initialize') {
    requireExecution(!c.state, 'STATE', 'Initialize requires a new session directory.');
    try { await lstat(c.project); requireExecution(false, 'STATE', 'Session directory already exists; never overwrite or adopt it.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    requireExecution((await lstat(path.dirname(c.project))).isDirectory(), 'INPUT', 'Session parent directory must already exist.');
  } else {
    requireExecution(c.state?.records.initialized && !c.state.records.closed, 'STATE', 'Initialize a private provider session first.');
    requireExecution(c.state.session.inputDigest === c.inputDigest
      && hash(c.state.session.provider) === hash(c.installation), 'CHANGED', 'Registration inputs or selected provider installation changed. No existing session can execute them.');
    if (phase === 'login') requireExecution(!c.state.records['login-attempt'] && !c.state.records['register-attempt'],
      'CONSUMED', 'This session login was already attempted; preserve it and review a new private session.');
    if (phase === 'register') {
      requireExecution(c.state.records.login && !c.state.records['register-attempt'] && !c.consumed, 'CONSUMED',
        'Registration requires a signed-in session and a never-attempted target. Failed/unknown attempts cannot be replayed.');
      const age = Date.now() - Date.parse(c.state.records.login.completedAt);
      if (!(age >= 0 && age <= 900000)) gaps.push('LOGIN_REVIEW_EXPIRED');
      if (c.confidential && !c.azureIdentity) gaps.push('PRIVATE_KEY_VAULT_IDENTITY_REQUIRED');
    }
  }
  const plan = { action: 'mcp-auth-execution', phase, project: c.project,
    status: gaps.length ? 'blocked' : 'planned', gaps, inputDigest: c.inputDigest,
    producerBuild: (await getLibraryInfo()).contentDigest, provider: c.installation,
    operator: c.selected.input.operator, endpoint: c.selected.descriptor.endpoint,
    request: c.request, targetDigest: c.targetDigest, stateDigest: c.state ? hash(c.state) : null,
    ...(c.compatibility ? { providerCompatibility: c.compatibility } : {}),
    consumedDigest: c.consumed ? hash(c.consumed) : null,
    azureIdentity: phase === 'register' ? c.azureIdentity : null,
    identityEvidence: c.state?.records.login?.identity ?? null,
    effects: phase === 'initialize'
      ? ['Create one owner-only Linux tmpfs runtime and private session metadata. No provider login or cloud mutation.']
      : phase === 'login'
        ? [providerStartupNotice,
          'Sign in through the public ATK CLI with the explicit tenant in a fresh private cache. ATK may open the Windows default browser under WSL; browser cookies/history are not isolated by the toolkit.',
          'The toolkit does not retain authentication URLs. If opening the displayed URL manually, use a browser with access to the Linux loopback callback, including separately verified Windows-to-WSL forwarding.',
          'Check the public ATK account output and selected-tenant metadata. This is not token-issuer attestation or consent to registration.']
        : [providerStartupNotice,
          'Recheck the exact signed-in account and selected tenant; --confirm-identity confirms your manual review of the displayed organization and expected tenant.',
          ...(c.confidential ? ['Read only the exact versioned Key Vault secret with the separately selected private Azure identity; pass it in a child-only environment. Provider files/logs stay on owner-only tmpfs.'] : []),
          'Reserve this target durably BEFORE one public ATK oauth/register dispatch. Any failed, cancelled or unknown dispatch stays consumed.',
          'Write a nonsecret created-unverified receipt only after strict output parsing. No app mutation, consent, endpoint deployment, FCC submission or plugin publication.'] };
  if (c.compatibility) plan.effects.push(
    `Explicit compatibility opt-in: HomeTenant / AnyApp. ATK receives ${anyAppValidationId} only to satisfy local validation; its reviewed AnyApp mapping sends an empty m365AppId. This is not a real app identity, creates no app and needs no later app-restriction switch. Live mapping remains unverified.`);
  return { ...plan, approvalToken: `mcp-auth-execution/${hash(plan)}` };
}
async function inWorkspace(options, action) {
  requireExecution(typeof options.workspaceRoot === 'string', 'WORKSPACE', 'An explicit private --workspace-root is required.');
  return withCliWorkspace(options.workspaceRoot, action);
}
export async function planAuthExecution(options, { provider = atkProvider } = {}) {
  return inWorkspace(options, () => prepare(options, provider));
}
async function journal(project, name, value) {
  await writeControl(path.join(project, `${name}.json`), value, { create: true });
}
function checkReference(reference, type) {
  requireExecution(reference && typeof reference.registrationId === 'string'
    && reference.registrationId.length <= 200 && new RegExp(registrationIdSchema.pattern).test(reference.registrationId)
    && Object.keys(reference).sort().join(',') === (type === 'entra-sso' ? 'applicationIdUri,registrationId' : 'registrationId')
    && (type !== 'entra-sso' || validApplicationIdUri(reference.applicationIdUri)), 'OUTPUT',
  'Provider did not return the expected nonsecret registration reference.');
}
export async function readAuthExecutionResult(filename, input, descriptor) {
  const value = checkedResult(await readJson(filename));
  requireExecution(value.descriptorDigest === descriptor.descriptorDigest
    && value.endpoint === descriptor.endpoint
    && hash(value.request) === hash({ tenantId: input.operator.tenantId, registration: input.registration }),
  'RESULT', 'Registration result is invalid, modified or belongs to a different exact request/descriptor.');
  checkReference(value.registration, input.registration.type);
  return { reference: value.registration, contentDigest: value.contentDigest };
}
export async function readAuthExecutionStatus(options) {
  return inWorkspace(options, async () => {
    const project = await assertProjectPath(path.resolve(options.project));
    const state = await stateAt(project);
    requireExecution(!state || state.session.owner.workspaceRoot === path.resolve(options.workspaceRoot), 'STATE', 'Session belongs to another workspace.');
    const reservation = state ? await optional(path.join(options.workspaceRoot, '.auth-registration-attempts',
      `${state.session.targetDigest.slice(7)}.json`)) : null;
    return { status: reservation && !state.records.closed && !state.records.result
      ? 'registration-unknown-consumed' : statusOf(state), project, evidence: 'local-retained-only',
      targetReservation: reservation ? 'consumed' : 'not-observed',
      registration: state?.records.result?.registration ?? null, executionReadiness: false,
      replayAuthorized: false, runtimeAvailability: 'not-assessed' };
  });
}
export async function fetchRegistrationSecret(secretIdentifier, token, { signal, fetch: transport = globalThis.fetch } = {}) {
  requireExecution(/^https:\/\/[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]\.vault\.azure\.net\/secrets\/[a-zA-Z0-9-]{1,127}\/[a-fA-F0-9]{32}$/.test(secretIdentifier)
    && typeof token === 'string' && /^[\x21-\x7e]{1,32768}$/.test(token),
  'SECRET', 'An exact versioned Key Vault reference and private access token are required.');
  const response = await transport(`${secretIdentifier}?api-version=7.4`, {
    method: 'GET', headers: { Authorization: `Bearer ${token}` }, redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
  });
  if (response.status !== 200) await response.body?.cancel();
  requireExecution(response.status === 200 && response.body, 'SECRET',
    'The exact Key Vault read failed. No retry, alternate endpoint or permission workaround is permitted.');
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      requireExecution(length <= 32768, 'SECRET', 'Key Vault response exceeded its bound; contents are not logged.');
      chunks.push(Buffer.from(part.value));
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requireExecution(data.id === secretIdentifier && typeof data.value === 'string'
    && data.value.length > 0 && data.value.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(data.value),
  'SECRET', 'The exact versioned Key Vault secret was not obtained; values are never logged.');
  return data.value;
}
export async function executeAuthPhase(options, { provider = atkProvider, runAzure = runAzureCommand, keyVaultFetch } = {}) {
  return inWorkspace(options, async () => {
    const plan = await prepare(options, provider);
    requireExecution(plan.status === 'planned' && options.approval === plan.approvalToken, 'APPROVAL',
      'Exact current phase approval and no blocking gaps are required.');
    const network = ['login', 'register'].includes(options.phase);
    requireExecution(options.allowProvider === true && (network ? options.allowNetwork === true : options.allowNetwork === undefined),
      'APPROVAL', 'Provider effects require --allow-provider; only login/register additionally require --allow-network.');
    requireExecution(options.phase === 'login' ? options.interactive === true : options.interactive === undefined,
      'APPROVAL', 'Only login requires --interactive.');
    requireExecution(options.phase === 'register' ? options.confirmIdentity === true : options.confirmIdentity === undefined,
      'APPROVAL', 'Registration requires --confirm-identity after reviewing the actual ATK account/organization.');
    requireExecution(plan.azureIdentity ? options.allowCloud === true : options.allowCloud === undefined, 'APPROVAL',
      'Only confidential registration with a private Key Vault identity requires --allow-cloud.');
    requireExecution(!options.signal?.aborted, 'ABORTED', 'Operation cancelled before starting.');
    const project = plan.project;
    if (options.phase === 'initialize') await mkdir(project, { mode: 0o700 });
    const lockPath = path.join(project, '.auth-operation.lock');
    const lock = await open(lockPath, 'wx', 0o600);
    let retainLock = false;
    try {
      await lock.writeFile(JSON.stringify({ toolkitPid: process.pid, phase: options.phase, startedAt: new Date().toISOString() }));
      await lock.sync();
      if (options.phase !== 'initialize') {
        requireExecution((await prepare(options, provider)).approvalToken === plan.approvalToken, 'CHANGED',
          'Session state, inputs or identity changed after review.');
      }
      if (options.phase === 'initialize') {
        const c = await context(options, provider);
        requireExecution(c.inputDigest === plan.inputDigest && hash(c.installation) === hash(plan.provider), 'CHANGED', 'Inputs/provider changed before initialization.');
        const owner = { epoch: randomUUID(), project, workspaceRoot: path.resolve(options.workspaceRoot) };
        const session = { schemaVersion: 1, kind: 'mcp-auth-private-session', owner,
          runtime: provider.path(owner), provider: plan.provider, inputDigest: plan.inputDigest,
          targetDigest: plan.targetDigest, operator: plan.operator };
        await journal(project, 'session', session);
        requireExecution(await provider.open(owner) === session.runtime, 'RUNTIME', 'Provider returned an unexpected runtime location.');
        await journal(project, 'initialized', { completedAt: new Date().toISOString() });
      } else {
        const state = await stateAt(project), session = state.session;
        if (options.phase === 'close') {
          await provider.close(session.runtime, session.owner);
          await journal(project, 'closed', { completedAt: new Date().toISOString() });
        } else if (options.phase === 'login') {
          await provider.validate(session.runtime, session.owner);
          await journal(project, 'login-attempt', { startedAt: new Date().toISOString(), approvalDigest: hash(plan) });
          const identity = await provider.login(plan.provider, session.runtime, session.owner, plan.operator, options);
          requireExecution(identity.accountName?.toLowerCase() === plan.operator.accountName.toLowerCase()
            && identity.tenantId?.toLowerCase() === plan.operator.tenantId.toLowerCase(), 'IDENTITY', 'Provider identity differs from the selected operator/tenant.');
          await journal(project, 'login', { completedAt: new Date().toISOString(), identity });
        } else {
          await provider.validate(session.runtime, session.owner);
          const c = await context(options, provider);
          const identity = await provider.account(plan.provider, session.runtime, session.owner, plan.operator, options);
          requireExecution(hash(identity) === hash(state.records.login.identity), 'IDENTITY', 'Provider account or tenant selection changed after login review.');
          let secret;
          try {
            if (c.confidential) {
              const azureOptions = await azureIdentityGuard({}, c.secretProject, plan.azureIdentity, runAzure);
              const result = await runAzure('az', ['account', 'get-access-token', '--resource', 'https://vault.azure.net',
                '--query', '{accessToken:accessToken,tenant:tenant}', '--output', 'json', '--only-show-errors'],
              { ...azureOptions, signal: options.signal, boundedInspection: true });
              const data = JSON.parse(typeof result.stdout === 'string' ? result.stdout : '');
              requireExecution(!result.code && data.tenant?.toLowerCase() === plan.operator.tenantId.toLowerCase(),
                'IDENTITY', 'The private Key Vault token belongs to a different selected tenant.');
              secret = await fetchRegistrationSecret(c.request.registration.credential.secretIdentifier, data.accessToken,
                { signal: options.signal, ...(keyVaultFetch ? { fetch: keyVaultFetch } : {}) });
            }
            requireExecution(!options.signal?.aborted && (await prepare(options, provider)).approvalToken === plan.approvalToken,
              'CHANGED', 'Inputs, session, identity or freshness changed before registration dispatch.');
            const actionRequest = c.compatibility
              ? { ...c.request, registration: { ...c.request.registration, appId: c.compatibility.validationAppId } }
              : c.request;
            const action = authRegistrationAction(actionRequest, c.selected.descriptor, { secretVariable: true });
            requireExecution(action, 'INPUT', 'No complete reviewed registration action is available.');
            await mkdir(c.reservations, { recursive: true, mode: 0o700 });
            const attempt = { schemaVersion: 1, target: c.target, targetDigest: c.targetDigest, project,
              ...(c.compatibility ? { providerCompatibility: c.compatibility } : {}),
              startedAt: new Date().toISOString(), approvalDigest: hash(plan), status: 'dispatch-reserved-consumed' };
            await writeControl(c.reservation, attempt, { create: true });
            await journal(project, 'register-attempt', attempt);
            const registration = await provider.register(plan.provider, session.runtime, session.owner,
              action, c.request.registration.type,
              { signal: options.signal, secret });
            checkReference(registration, c.request.registration.type);
            const content = { schemaVersion: 1, kind: 'mcp-auth-registration-result', status: 'created-unverified',
              request: c.request, descriptorDigest: c.selected.descriptor.descriptorDigest, endpoint: c.selected.descriptor.endpoint,
              ...(c.compatibility ? { providerCompatibility: c.compatibility } : {}),
              registration, identity, provider: plan.provider, attemptDigest: hash(attempt),
              createdAt: new Date().toISOString(), settings: 'not-verified', executionReadiness: false };
            await journal(project, 'result', { ...content, contentDigest: hash(content) });
          } finally { secret = undefined; }
        }
      }
      const completed = await stateAt(project);
      if (completed.records.result) checkedResult(completed.records.result);
      return { status: statusOf(completed), project, phase: options.phase,
        resultFile: options.phase === 'register' ? path.join(project, 'result.json') : null,
        executionReadiness: false, replayAuthorized: false };
    } catch (error) {
      retainLock = error.code === 'ATK_TERMINATION_UNCONFIRMED';
      if (retainLock && Number.isSafeInteger(error.pid) && error.pid > 0) {
        const text = JSON.stringify({ toolkitPid: process.pid, providerProcessGroup: error.pid, phase: options.phase,
          status: 'termination-unconfirmed', instruction: 'Confirm this owned process group has exited before reviewed lock recovery or runtime removal.' });
        await lock.truncate(0); await lock.write(text, 0, 'utf8'); await lock.sync();
      }
      throw Object.assign(new Error(retainLock
        ? 'Provider termination is unconfirmed. Preserve the lock/runtime and reconcile the owned process; no retry or cleanup is authorized.'
        : ['ATK_IDENTITY', 'MCP_AUTH_EXECUTION_IDENTITY'].includes(error.code)
          ? 'Account or selected-tenant verification failed. Browser sign-in success alone is not verified identity. Preserve this attempt; registration dispatches remain consumed.'
          : 'Authentication phase failed. Read local status and preserve attempts; provider output and secrets are not logged. Registration dispatches remain consumed.'),
      { code: retainLock ? error.code : 'MCP_AUTH_EXECUTION_FAILED' });
    } finally { await lock.close(); if (!retainLock) await unlink(lockPath); }
  });
}
