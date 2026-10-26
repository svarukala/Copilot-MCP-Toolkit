import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import path from 'node:path';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { assertProjectPath } from './config.js';
import { readControl, writeControl, withControlLock } from './mcp-control.js';
import { digest, keys, checked, scoped, absent, requireRun } from './mcp-validation.js';
import * as journey from './mcp-validation-journey.js';
import { getLibraryInfo } from './machine-contract.js';
import { runAzureCommand } from './azure.js';
import { prepareMcpServer } from './mcp-server.js';
import { planHostingRecipe } from './mcp-container-apps.js';
import { hostExecutionSchema, describeHostExecution, planHostExecution, runHostExecution } from './mcp-execution-host.js';
import { planExecutionSession, createExecutionProofApproval } from './mcp-execution-session.js';
import { createExecutionProtocolAdapter } from './mcp-execution-protocol.js';

const object = (properties, required = Object.keys(properties)) =>
  ({ type: 'object', additionalProperties: false, properties, required });
const filename = { type: 'string', minLength: 1, maxLength: 2048 };
const ownerRow = journey.creationCheckpointSchema.oneOf[0].properties.milestones.items;
export const executionSchema = object({
  schemaVersion: { const: 1 }, scenarioFile: filename,
  expiresAt: { type: 'string', format: 'date-time' },
  limits: object({
    maximumSteps: { type: 'integer', minimum: 4, maximum: 80 },
    maximumAzureCommands: { type: 'integer', minimum: 0, maximum: 500 },
    maximumProviderCalls: { const: 1 },
    maximumRunMs: { type: 'integer', minimum: 60000, maximum: 14400000 },
  }),
  cloud: object({
    resourcePolicy: { const: 'pinned-scenario-only' },
    spendingPolicy: { const: 'resource-limits-not-an-invoice-cap' },
    ongoingChargesReviewed: { const: true },
    allowSecretAccessGrants: { type: 'boolean' },
  }),
  minimumProofDelayMs: { type: 'integer', minimum: 0, maximum: 65000 },
  ownerEvidence: { type: 'array', maxItems: 17, items: ownerRow },
  host: hostExecutionSchema,
  referenceServerId: { type: 'string', format: 'uuid' },
}, ['schemaVersion', 'scenarioFile', 'expiresAt', 'limits', 'minimumProofDelayMs', 'ownerEvidence']);
const ajv = new Ajv(); addFormats(ajv);
const valid = ajv.compile(executionSchema);
const validCheckpoint = ajv.compile(journey.creationCheckpointSchema.oneOf[0]);
const validCreation = ajv.compile(journey.creationScenarioSchema);
const check = (ok, code, message) => requireRun(ok, `EXECUTION_${code}`, message);
const file = (run, name) => path.join(run.dir, name);
const child = run => file(run, 'journey');
const childOptions = (run, workspaceRoot) => ({ workspaceRoot, project: child(run) });
const isHosting = scenario => scenario.startsWith('container-apps-');
const hasCloud = scenario => scenario !== 'existing-mcp-create-v2';
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const phaseName = plan => plan.phase === 'provision' ? `provision-${plan.selected.phase}` : plan.phase;
function grants(scenario) {
  return ['generate', 'checkpoint', ...(isHosting(scenario) ? ['sdk-host', 'release', 'reference']
    : hasCloud(scenario) ? ['account', 'provision-foundation', 'provision-finalize', 'provision-gateway', 'reconcile'] : []),
  'discovery', 'session', 'proof'];
}
function future(expiresAt) {
  const expires = Date.parse(expiresAt);
  check(Number.isFinite(expires) && new Date(expires).toISOString() === expiresAt
    && expires > Date.now() && expires <= Date.now() + 86400000,
  'EXPIRY', 'Use an explicit future UTC expiry no more than 24 hours away.');
}
function normalizedCreation(plan) {
  return { ...plan.input, ...(plan.coverage.caller === 'entra' && (plan.coverage.hosting || plan.coverage.existing)
    ? { probeMode: 'session' } : {}) };
}
async function hostIdentityLocked(host, defaultProject) {
  const project = host?.azureIdentityProject ?? defaultProject;
  if (!project) return false;
  check(path.isAbsolute(project), 'INPUT', 'The private Azure identity project must be an absolute path.');
  const filename = await assertProjectPath(path.join(project, '.mcp-execution-host.lock'));
  try { await lstat(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function prepare(options) {
  check(typeof options.config === 'string' && typeof options.output === 'string', 'INPUT',
    'Execution plan/start requires a nonsecret --config and NEW --output.');
  const config = await assertProjectPath(path.resolve(options.config));
  const input = checked(await readControl(config), valid);
  future(input.expiresAt);
  if (input.host) future(input.host.expiresAt);
  check(!await hostIdentityLocked(input.host), 'IDENTITY_LOCKED',
    'The selected private Azure identity has a host execution lock. Preserve it and resolve its owner before starting another grant.');
  input.scenarioFile = await assertProjectPath(path.resolve(path.dirname(config), input.scenarioFile));
  const candidate = await journey.planValidation({ ...options, config: input.scenarioFile });
  const creation = normalizedCreation(candidate), hosting = candidate.coverage.hosting;
  check(creation.schemaVersion === 2, 'INPUT', 'Bounded execution takes a fresh v2 creation scenario, never an old run.');
  check(!candidate.relatedHistory.some(h => h.consumed || h.incomplete || h.locks.length),
    'HISTORY', 'Related consumed, incomplete or locked history prevents a new execution grant.');
  check(hosting === Boolean(input.host) && hosting === Boolean(input.referenceServerId),
    'INPUT', 'Only SDK hosting requires host configuration and a new referenceServerId.');
  check(!hosting || candidate.definition.imageBuild, 'INPUT',
    'SDK execution requires explicit digest-pinned builder/runtime inputs before approving or generating a run.');
  check(hasCloud(creation.scenario) === Boolean(input.cloud)
    && (hasCloud(creation.scenario) ? input.limits.maximumAzureCommands > 0 : input.limits.maximumAzureCommands === 0),
  'INPUT', 'Cloud scenarios require explicit pinned-resource/ongoing-charge review and a command budget; existing endpoints grant no cloud access.');
  const secretGrant = !hosting && hasCloud(creation.scenario) && candidate.definition.backend?.auth === 'api-key'
    && candidate.definition.schemaVersion !== 3;
  check(!input.cloud || input.cloud.allowSecretAccessGrants === secretGrant, 'SCOPE',
    'Explicitly select only the secret-scoped APIM identity grant required by this profile; no other role authority is supported.');
  check(!hosting || input.minimumProofDelayMs === 65000 && candidate.definition.requestsPerMinute >= 4,
    'RATE', 'SDK execution requires at least four MCP POSTs/minute and a 65000ms discovery-to-proof interval.');
  check(new Set(input.ownerEvidence.map(row => row.name)).size === input.ownerEvidence.length
    && input.ownerEvidence.every(row => row.outcome !== 'passed' || digestPattern.test(row.evidenceDigest ?? '')),
  'EVIDENCE', 'Owner evidence names must be unique; passed declarations require an evidence digest.');
  const external = [];
  if (creation.proof.delegatedFixture) external.push({
    path: creation.proof.delegatedFixture.path,
    contentDigest: digest(await readControl(creation.proof.delegatedFixture.path)),
  });
  const generated = hosting ? await planHostingRecipe({
    workspaceRoot: options.workspaceRoot, config: creation.definitionFile, output: candidate.outputPath,
  }) : await prepareMcpServer(candidate.definition);
  const resourceDefinitions = Object.fromEntries(Object.entries(generated.files)
    .filter(([name]) => name.startsWith('infra/') && name.endsWith('.json'))
    .map(([name, text]) => [name, JSON.parse(text)]));
  const hostSource = hosting ? { input: candidate.definition, review: generated.review,
    manifest: JSON.parse(generated.files['recipe-manifest.json']) } : null;
  const body = {
    action: 'mcp-execution-start', schemaVersion: 1, outputPath: candidate.outputPath,
    buildId: candidate.buildId, input, creation, definition: candidate.definition,
    definitionDigest: digest(candidate.definition), relatedHistory: candidate.relatedHistory, external,
    grants: grants(creation.scenario), resourceDefinitions,
    hostReview: hosting ? describeHostExecution(hostSource, input.host) : null,
    hostSourceManifestDigest: hostSource?.manifest.contentDigest ?? null,
    targets: { azure: candidate.definition.azure ?? null,
      endpoint: candidate.coverage.endpoint ?? candidate.definition.endpoint ?? null,
      backend: candidate.definition.backend ?? null, authentication: candidate.definition.authentication ?? candidate.definition.inbound ?? null },
    effects: [
      'This NEW execution contract explicitly grants the listed trusted phase planners for this pinned definition, identity and build.',
      'Run advances automatically under this grant, including one exact read-only proof. Legacy validation approvals do not acquire this authority.',
      'Provider budget is reserved before the proof-capable phase; failed, unknown and interrupted work is never retried.',
      'Azure budget counts logical CLI commands, including identity reads. Existing bounded read-only transport retries are not additional mutation authority.',
      'SDK host downloads, scanner and resource ceilings are defined by the host configuration and sealed source. No arbitrary shell, secret export, app registration, consent or consumer publication.',
      ...(secretGrant ? ['The exact generated APIM secret-access template grants Key Vault Secrets User only on the selected secret to the selected APIM system identity. No broader role grant is permitted.']
        : ['No role grants are authorized by this profile.']),
      'Cloud resource sizes/targets are bounded by the reviewed definition, not a currency billing cap. Resources can continue charging after the execution expires.',
      'Owner declarations are not independent checks. Manual consumer, rotation and negative-test gates remain distinguishable from protocol success.',
      'Authentication is private or memory-only. MFA/consent may require the user. No promise of cross-account, cross-audience or cross-process MCP sign-in reuse.',
    ],
  };
  return { ...body, approvalToken: `mcp-execution/${digest(body)}` };
}
export const planExecution = options => scoped(options, () => prepare(options));

async function append(run, kind, data) {
  check(run.events.length < 1100, 'LIMIT', 'Execution journal capacity exhausted; no further dispatch.');
  const entry = { schemaVersion: 1, previous: run.head, recordedAt: new Date().toISOString(), kind, data };
  const event = { ...entry, contentDigest: digest(entry) };
  await writeControl(file(run, `events/${String(run.events.length + 1).padStart(4, '0')}.json`), event, { create: true });
  run.events.push(event); run.head = event.contentDigest;
  if (kind === 'intent') run.pending = event.contentDigest;
  if (kind === 'result') run.pending = null;
  return event;
}
async function readRun(project, { checkBuild = true } = {}) {
  check(typeof project === 'string', 'INPUT', 'Select the execution directory with --project.');
  const dir = await assertProjectPath(path.resolve(project));
  const state = await readControl(path.join(dir, 'execution.json')), { contentDigest, ...body } = state;
  check(keys(body, ['schemaVersion', 'kind', 'createdAt', 'plan']) && body.schemaVersion === 1
    && body.kind === 'mcp-bounded-execution' && contentDigest === digest(body)
    && body.plan.outputPath === dir, 'STATE', 'Invalid or relocated execution grant; preserve it without resealing.');
  const { approvalToken, ...planBody } = body.plan;
  check(approvalToken === `mcp-execution/${digest(planBody)}` && digest(body.plan.definition) === body.plan.definitionDigest,
    'STATE', 'The stored execution plan changed.');
  checked(body.plan.input, valid); checked(body.plan.creation, validCreation);
  check(digest(body.plan.grants) === digest(grants(body.plan.creation.scenario)), 'STATE', 'Execution grants changed.');
  if (checkBuild) check(body.plan.buildId === (await getLibraryInfo()).contentDigest,
    'BUILD', 'Use the exact reviewed toolkit build; never reseal or migrate an execution grant.');
  const run = { dir, ...body, contentDigest, head: contentDigest, events: [], pending: null };
  const names = (await readdir(file(run, 'events'))).sort();
  check(names.length <= 1100 && names.every((n, i) => n === `${String(i + 1).padStart(4, '0')}.json`),
    'STATE', 'Execution journal is missing, out of order or oversized.');
  for (const name of names) {
    const event = await readControl(file(run, `events/${name}`), 65536);
    const { contentDigest: eventDigest, ...entry } = event;
    check(keys(entry, ['schemaVersion', 'previous', 'recordedAt', 'kind', 'data'])
      && entry.schemaVersion === 1 && entry.previous === run.head && eventDigest === digest(entry)
      && Number.isFinite(Date.parse(entry.recordedAt)) && entry.recordedAt <= new Date().toISOString()
      && entry.recordedAt >= (run.events.at(-1)?.recordedAt ?? body.createdAt),
    'STATE', 'Execution journal integrity or chronology changed.');
    if (entry.kind === 'intent') {
      check(!run.pending && keys(entry.data, ['phase', 'planDigest', 'providerCalls', 'childApprovalDigest'])
        && ['initialize', ...run.plan.grants].includes(entry.data.phase)
        && digestPattern.test(entry.data.planDigest) && [0, 1].includes(entry.data.providerCalls)
        && entry.data.providerCalls === (['session', 'proof'].includes(entry.data.phase) ? 1 : 0)
        && (entry.data.childApprovalDigest === null || digestPattern.test(entry.data.childApprovalDigest)),
      'STATE', 'Invalid or overlapping execution intent.');
      check(entry.data.phase !== 'initialize' || run.events.length === 0,
        'STATE', 'Initialization cannot repeat inside an existing grant.');
      run.pending = eventDigest;
    } else if (entry.kind === 'result') {
      check(run.pending && keys(entry.data, ['intentDigest', 'status', 'reportDigest', 'childHead'])
        && entry.data.intentDigest === run.pending && ['passed', 'failed', 'unknown'].includes(entry.data.status)
        && (entry.data.reportDigest === null || digestPattern.test(entry.data.reportDigest))
        && (entry.data.status === 'passed' ? digestPattern.test(entry.data.childHead)
          : entry.data.childHead === null || digestPattern.test(entry.data.childHead)),
      'STATE', 'Invalid execution outcome.');
      run.pending = null;
    } else {
      check(entry.kind === 'azure-command' && run.pending
        && keys(entry.data, ['commandDigest']) && digestPattern.test(entry.data.commandDigest),
      'STATE', 'Unexpected execution event.');
    }
    run.events.push(event); run.head = eventDigest;
  }
  return run;
}
function consumption(run) {
  return {
    steps: run.events.filter(e => e.kind === 'intent' && e.data.phase !== 'initialize').length,
    providerCalls: run.events.filter(e => e.kind === 'intent').reduce((n, e) => n + e.data.providerCalls, 0),
    azureCommands: run.events.filter(e => e.kind === 'azure-command').length,
  };
}
function barrier(run) {
  return run.pending ? 'interrupted-intent'
    : run.events.some(e => e.kind === 'result' && e.data.status !== 'passed') ? 'failed-or-unknown-outcome' : null;
}
async function childJournal(run) {
  const state = await readControl(path.join(child(run), 'validation-run.json'));
  const names = (await readdir(path.join(child(run), 'events'))).sort();
  check(names.length <= 200 && names.every((name, i) => name === `${String(i + 1).padStart(4, '0')}.json`),
    'CHANGED', 'Nested journal structure changed.');
  const events = await Promise.all(names.map(name => readControl(path.join(child(run), 'events', name), 65536)));
  let head = state.contentDigest;
  for (const event of events) {
    const { contentDigest, ...body } = event;
    check(body.previous === head && contentDigest === digest(body), 'CHANGED', 'Nested journal chain changed.');
    head = contentDigest;
  }
  return { head, events, base: state.contentDigest };
}
async function checkChildHead(run) {
  const settled = run.events.findLast(event => event.kind === 'result' && event.data.status === 'passed');
  if (!settled) return;
  const journal = await childJournal(run);
  if (journal.head === settled.data.childHead) return;
  const intent = run.pending && run.events.find(event => event.contentDigest === run.pending);
  const tail = journal.events.at(-1);
  const pending = tail?.kind === 'result' ? journal.events.at(-2) : tail;
  check(intent?.data.childApprovalDigest && pending?.kind === 'intent'
    && pending.previous === settled.data.childHead
    && pending.data.approvalDigest === intent.data.childApprovalDigest
    && (tail === pending || tail.data.intentDigest === pending.contentDigest),
  'CHANGED', 'Nested execution advanced outside this grant. Do not adopt an externally executed phase or endpoint.');
}
async function guard(run, signal) {
  check(!signal?.aborted, 'ABORTED', 'Execution cancelled before the next operation.');
  check(Date.now() < Date.parse(run.plan.input.expiresAt), 'EXPIRED', 'Execution grant expired; no further operation is authorized.');
  const current = await readRun(run.dir);
  check(current.head === run.head && current.contentDigest === run.contentDigest, 'CHANGED', 'Execution state changed concurrently.');
  for (const external of run.plan.external) check(digest(await readControl(external.path)) === external.contentDigest,
    'CHANGED', 'Reviewed external fixture changed.');
  const expected = { ...run.plan.creation, definitionFile: file(run, 'definition.json') };
  check(digest(await readControl(file(run, 'scenario.json'))) === digest(expected)
    && digest(await readControl(file(run, 'definition.json'))) === run.plan.definitionDigest,
  'CHANGED', 'Pinned execution inputs changed.');
  const initialization = run.events.find(e => e.kind === 'intent' && e.data.phase === 'initialize');
  if (initialization && run.events.some(e => e.kind === 'result'
    && e.data.intentDigest === initialization.contentDigest && e.data.status === 'passed')) {
    const nested = await readControl(path.join(child(run), 'validation-run.json'));
    check(digest(nested.input) === digest(expected) && nested.buildId === run.plan.buildId
      && nested.definitionDigest === run.plan.definitionDigest
      && digest(await readControl(path.join(child(run), 'definition.json'))) === run.plan.definitionDigest,
    'CHANGED', 'Nested scenario, identity, build or definition differs from the execution grant.');
    await checkChildHead(run);
  }
}
async function perform(run, phase, plan, operation, signal) {
  await guard(run, signal);
  const used = consumption(run), limits = run.plan.input.limits;
  const providerCalls = ['session', 'proof'].includes(phase) ? 1 : 0;
  check(!barrier(run) && (phase === 'initialize' || run.plan.grants.includes(phase)),
    'SCOPE', 'The phase is outside this grant or unresolved work blocks execution.');
  check(used.steps < limits.maximumSteps && used.providerCalls + providerCalls <= limits.maximumProviderCalls,
    'LIMIT', 'Execution step or provider-call budget is exhausted; no new operation was dispatched.');
  const before = phase === 'initialize' ? null : await childJournal(run);
  const intent = await append(run, 'intent', { phase, planDigest: digest(plan), providerCalls,
    childApprovalDigest: ['initialize', 'sdk-host', 'checkpoint'].includes(phase) ? null : digest(plan.approvalToken) });
  try {
    const result = await operation();
    const after = await childJournal(run);
    if (phase !== 'initialize') {
      const added = after.events.slice(before.events.length);
      check(phase === 'sdk-host' ? after.head === before.head
        : phase === 'checkpoint' ? added.length === 1 && added[0].previous === before.head
          && added[0].kind === 'checkpoint' && digest(added[0].data) === digest(plan.request)
          : added.length === 2 && added[0].previous === before.head && added[0].kind === 'intent'
            && added[0].data.approvalDigest === intent.data.childApprovalDigest
            && added[1].kind === 'result' && added[1].data.intentDigest === added[0].contentDigest,
      'CHANGED', 'Nested journal outcome does not match the granted phase.');
    }
    const status = result?.protocol === 'unknown' || result?.steps?.at(-1)?.status === 'unknown' ? 'unknown'
      : result?.status === 'blocked' || result?.outcome === 'failed' ? 'failed' : 'passed';
    await append(run, 'result', { intentDigest: intent.contentDigest, status, reportDigest: digest(result), childHead: after.head });
    return result;
  } catch (error) {
    await append(run, 'result', { intentDigest: intent.contentDigest, status: 'unknown', reportDigest: null, childHead: null });
    check(false, 'UNKNOWN', 'A granted phase stopped without a verified success. Preserve child receipts and locks; no automatic retry. Raw errors are not retained.');
  }
}
export const startExecution = options => scoped(options, async () => {
  const plan = await prepare(options);
  check(options.approval === plan.approvalToken, 'APPROVAL', 'Approve the exact NEW execution plan once, not a legacy phase token.');
  await absent(plan.outputPath); await mkdir(plan.outputPath, { mode: 0o700 });
  await mkdir(path.join(plan.outputPath, 'events'), { mode: 0o700 });
  const body = { schemaVersion: 1, kind: 'mcp-bounded-execution', createdAt: new Date().toISOString(), plan };
  const run = { dir: plan.outputPath, ...body, contentDigest: digest(body), events: [] };
  run.head = run.contentDigest;
  await writeControl(file(run, 'definition.json'), plan.definition, { create: true });
  await writeControl(file(run, 'scenario.json'), { ...plan.creation, definitionFile: file(run, 'definition.json') }, { create: true });
  await writeControl(file(run, 'execution.json'), { ...body, contentDigest: run.contentDigest }, { create: true });
  await withControlLock(run.dir, async () => {
    const selected = { workspaceRoot: options.workspaceRoot, config: file(run, 'scenario.json'), output: child(run) };
    const initialization = await journey.planValidation(selected);
    check(initialization.definition && digest(initialization.definition) === plan.definitionDigest
      && digest(initialization.relatedHistory) === digest(plan.relatedHistory), 'CHANGED', 'Start inputs/history changed.');
    await perform(run, 'initialize', initialization, () => journey.startValidation({
      ...selected, approval: initialization.approvalToken,
    }), options.signal);
  });
  return { status: 'authorized-not-executed', runDirectory: run.dir, grantDigest: run.contentDigest,
    nextCommand: 'mcp-execution-run', approvalRequired: false, expiresAt: plan.input.expiresAt };
});
async function status(run, workspaceRoot, extra = {}) {
  const stopped = barrier(run);
  if (!stopped) await checkChildHead(run);
  let report, childInspection;
  try { report = await journey.validationStatus(childOptions(run, workspaceRoot)); }
  catch (error) {
    if (!stopped) throw error;
    report = { status: 'blocked', protocol: 'unavailable', milestones: [] };
    childInspection = 'Child evidence is incomplete or invalid. Inspect preserved artifacts; no replay or readiness is established.';
  }
  const failed = run.events.find(event => event.kind === 'result' && event.data.status !== 'passed');
  const stoppedIntent = run.events.find(event => event.contentDigest === (run.pending ?? failed?.data.intentDigest));
  const used = consumption(run);
  return {
    schemaVersion: 1, runDirectory: run.dir, scenario: run.plan.creation.scenario,
    status: stopped || report.status === 'blocked' ? 'blocked'
      : report.protocol === 'passed-historical' ? 'execution-completed' : 'in-progress',
    barrier: stopped, grantDigest: run.contentDigest, journalDigest: run.head,
    stoppedPhase: stoppedIntent?.data.phase ?? null,
    evidenceDirectory: stoppedIntent?.data.phase === 'sdk-host' ? file(run, 'host') : child(run),
    ...(childInspection ? { childInspection } : {}),
    expiresAt: run.plan.input.expiresAt, expired: Date.now() >= Date.parse(run.plan.input.expiresAt),
    consumption: used, limits: run.plan.input.limits, protocol: report.protocol,
    milestones: report.milestones, consumerExecutionAttested: false, executionReadiness: false,
    proofReplayAuthorized: false, repeatPrompt: false, ...extra,
  };
}
export const executionStatus = options => scoped(options, async () =>
  status(await readRun(options.project), options.workspaceRoot));
async function json(run, name, value) {
  const filename = file(run, name);
  try {
    const existing = await readControl(filename);
    check(digest(existing) === digest(value), 'CHANGED', 'Prepared execution metadata differs; it cannot be overwritten.');
    return filename;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeControl(filename, value, { create: true });
  return filename;
}
async function runChild(run, plan, options, dependencies) {
  const flags = Object.fromEntries(plan.requiredFlags.map(flag => [
    { '--allow-network': 'allowNetwork', '--allow-cloud': 'allowCloud', '--interactive': 'interactive' }[flag], true,
  ]));
  const phase = phaseName(plan);
  check(run.plan.grants.includes(phase), 'SCOPE', 'An ungranted lifecycle phase requires a new execution plan.');
  check(!plan.childPlan?.plan?.steps?.some(step => step.id === 'deploy-secret-access')
    || run.plan.input.cloud?.allowSecretAccessGrants === true,
  'SCOPE', 'This run did not grant the APIM secret-scoped access operation.');
  const authorization = phase === 'session' ? await planExecutionSession(plan.selected, {
    minimumProofDelayMs: run.plan.input.minimumProofDelayMs,
  }) : null;
  const approveProof = phase === 'session' ? createExecutionProofApproval({
    options: plan.selected, childPlan: plan.childPlan, authorization,
    beforeProof: () => guard(run, options.signal), signal: options.signal,
  }, dependencies.sessionDependencies) : undefined;
  return perform(run, phase, plan, () => journey.runValidation({
    ...childOptions(run, options.workspaceRoot), config: options.childConfig,
    approval: plan.approvalToken, ...flags, signal: options.signal, onDeviceCode: options.onDeviceCode, approveProof,
  }, dependencies), options.signal);
}
async function checkpoint(run, rows, options, dependencies) {
  const value = checked({ schemaVersion: 2, kind: 'checkpoint', milestones: rows }, validCheckpoint);
  const config = await json(run, `checkpoint-${run.events.length}.json`, value);
  const next = await journey.nextValidation({ ...childOptions(run, options.workspaceRoot), config });
  return runChild(run, next, { ...options, childConfig: config }, dependencies);
}
async function sdk(run, options, dependencies) {
  const config = await json(run, `host-${run.events.length}.json`, run.plan.input.host);
  const selected = { workspaceRoot: options.workspaceRoot, project: path.join(child(run), 'source'),
    config, output: file(run, 'host') };
  const plan = await planHostExecution(selected);
  check(plan.scope.sourceManifestDigest === run.plan.hostSourceManifestDigest
    && digest(plan.scope.description) === digest(run.plan.hostReview),
  'SCOPE', 'Host source, downloads, scan policy or resource limits differ from the initial reviewed grant.');
  if (plan.requiresSignIn && typeof options.onDeviceCode !== 'function') {
    return { status: 'sign-in-required' };
  }
  const result = await perform(run, 'sdk-host', plan, async () => {
    const observed = await runHostExecution({
      ...selected, approval: plan.approvalToken, allowCloud: true, allowNetwork: true, allowLocal: true,
      onDeviceCode: options.onDeviceCode, signal: options.signal,
    }, { ...dependencies.hostDependencies, runAzure: dependencies.runAzure });
    check(observed.status === 'passed' && digestPattern.test(observed.evidenceDigest ?? ''),
      'HOST', 'Host adapter did not establish a verified result; preserve its receipts.');
    await json(run, 'host-result.json', observed);
    return observed;
  }, options.signal);
  return result;
}
export const runExecution = (options, dependencies = {}) => scoped(options, async () => {
  const dir = await assertProjectPath(path.resolve(options.project));
  return withControlLock(dir, async () => {
    const run = await readRun(dir);
    if (barrier(run)) return status(run, options.workspaceRoot);
    const controller = new AbortController();
    const lifetime = Math.min(run.plan.input.limits.maximumRunMs, Date.parse(run.plan.input.expiresAt) - Date.now());
    check(lifetime > 0, 'EXPIRED', 'The retained execution grant expired; no new phase is authorized.');
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), lifetime);
    const execution = { ...options, signal };
    const runAzure = async (command, args, settings = {}) => {
      const commandSignal = settings.signal ? AbortSignal.any([signal, settings.signal]) : signal;
      await guard(run, commandSignal);
      check(command === 'az' && hasCloud(run.plan.creation.scenario)
        && consumption(run).azureCommands < run.plan.input.limits.maximumAzureCommands,
      'LIMIT', 'Azure command budget or scope exhausted before dispatch.');
      await append(run, 'azure-command', { commandDigest: digest({ command, args }) });
      return (dependencies.runAzure ?? runAzureCommand)(command, args, { ...settings, signal: commandSignal });
    };
    const protocol = createExecutionProtocolAdapter({ ...dependencies.sessionDependencies, runAzure, signal });
    const adapters = { ...dependencies, runAzure,
      mcpProjectOperation: dependencies.mcpProjectOperation ?? protocol.mcpProjectOperation };
    try {
      for (;;) {
        if (signal.aborted) return status(run, options.workspaceRoot, { status: 'paused', reason: 'cancelled-between-phases' });
        await guard(run, signal);
        let next = await journey.nextValidation(childOptions(run, options.workspaceRoot));
        if (next.status === 'blocked') return status(run, options.workspaceRoot, { status: 'blocked', reason: next.reason });
        if (next.status === 'checks-recorded') return status(run, options.workspaceRoot);
        if (next.report.waiting) return status(run, options.workspaceRoot, { status: 'waiting-for-owner', reason: next.reason });
        if (next.phase === 'generate') {
          await runChild(run, next, execution, adapters);
          continue;
        }
        const pendingOwner = run.plan.input.ownerEvidence.filter(row =>
          next.report.milestones.some(m => m.name === row.name && m.outcome === 'pending'));
        if (pendingOwner.length) {
          await checkpoint(run, pendingOwner, execution, adapters);
          continue;
        }
        if (isHosting(run.plan.creation.scenario) && !next.report.steps.some(step => step.phase === 'reference')) {
          if (next.gate === 'prerequisites') return status(run, options.workspaceRoot, {
            status: 'waiting-for-owner', gate: next.gate,
            reason: 'Existing directory, resource and entitlement prerequisites need genuine owner evidence, not an inferred pass.',
            instructions: 'Supply this evidence once in the plan or with mcp-execution-record. No new execution approval is required.',
          });
          let host;
          const completed = run.events.some(e => e.kind === 'intent' && e.data.phase === 'sdk-host');
          if (!completed) {
            if (await hostIdentityLocked(run.plan.input.host, path.join(child(run), 'source'))) {
              return status(run, options.workspaceRoot, { status: 'paused', gate: 'identity-lock',
                reason: 'The selected private Azure identity has a host execution lock. No host phase was dispatched.',
                instructions: 'Preserve the lock. Resolve its owner separately before resuming this same unused host authorization.',
              });
            }
            host = await sdk(run, execution, adapters);
          }
          else {
            host = await readControl(file(run, 'host-result.json'));
            const intent = run.events.find(e => e.kind === 'intent' && e.data.phase === 'sdk-host');
            const result = run.events.find(e => e.kind === 'result' && e.data.intentDigest === intent.contentDigest);
            check(result?.data.status === 'passed' && digest(host) === result.data.reportDigest,
              'CHANGED', 'Retained host observation changed or was not completed.');
          }
          if (host.status === 'sign-in-required') return status(run, options.workspaceRoot, {
            status: 'sign-in-required', instructions: 'Resume this same grant in a terminal for private Azure sign-in.',
          });
          const observed = host.observedMilestones;
          const deployed = observed?.appDeploymentReadback === 'passed'
            && observed.appRevisionReadiness === 'healthy-running-control-plane-readback';
          const verified = {
            'image-build': observed?.build === 'passed' && observed.zeroCriticalHighScan === 'passed'
              && observed.nonrootNetworkDisabledSmoke === 'passed' && observed.registryPush === 'passed',
            'host-deployment': deployed,
            'runtime-deployment': deployed && (run.plan.creation.scenario !== 'container-apps-apim-create-v2'
              || observed.gatewayDeploymentReadback === 'passed'),
            'secret-resolution': observed?.secretResolution === 'runtime-startup-and-health-confirmed',
          };
          const rows = next.report.milestones.filter(m => verified[m.name] && m.outcome === 'pending')
            .map(m => ({ name: m.name, outcome: 'passed', evidenceDigest: host.evidenceDigest,
              note: m.name === 'secret-resolution'
                ? 'Pinned runtime startup and health confirmed injection. Provider key validity and rotation remain unverified.'
                : 'Bounded host executor receipt. See retained adapter observations. Not independent attestation.' }));
          if (rows.length) { await checkpoint(run, rows, execution, adapters); continue; }
          if (next.gate) return status(run, options.workspaceRoot, {
            status: 'waiting-for-owner', gate: next.gate,
            reason: 'This milestone was not established by the bounded host observations. No pass was manufactured.',
          });
          const kind = next.report.steps.some(step => step.phase === 'release') ? 'reference' : 'release';
          const value = kind === 'release' ? { schemaVersion: 1, accountName: run.plan.input.host.accountName,
            containerImage: host.containerImage,
            ...(run.plan.creation.scenario === 'container-apps-apim-create-v2' ? { backendOrigin: host.backendOrigin } : {}),
            ...(host.imageReviewFile ? { imageReviewFile: host.imageReviewFile } : {}) }
            : { schemaVersion: 1, endpoint: host.endpoint, serverId: run.plan.input.referenceServerId };
          const artifact = await json(run, `${kind}.json`, value);
          const request = await json(run, `${kind}-request.json`, { schemaVersion: 2, kind, file: artifact });
          next = await journey.nextValidation({ ...childOptions(run, options.workspaceRoot), config: request });
          await runChild(run, next, { ...execution, childConfig: request }, adapters);
          continue;
        }
        if (!next.approvalToken) return status(run, options.workspaceRoot, {
          status: next.status, reason: next.reason, gate: next.gate ?? null,
          instructions: 'Supply genuine pending owner evidence with mcp-execution-record. This is not another execution approval.',
        });
        if (next.requiredFlags.includes('--interactive') && typeof options.onDeviceCode !== 'function') {
          return status(run, options.workspaceRoot, { status: 'sign-in-required',
            instructions: 'Resume this same grant in a terminal. No new phase approval is needed.' });
        }
        if (next.phase === 'proof' && run.plan.input.minimumProofDelayMs > 0) {
          const discovery = run.events.findLast(event => event.kind === 'intent' && event.data.phase === 'discovery');
          const completed = discovery && run.events.find(event => event.kind === 'result'
            && event.data.intentDigest === discovery.contentDigest && event.data.status === 'passed');
          const delay = completed ? Math.max(0, Date.parse(completed.recordedAt)
            + run.plan.input.minimumProofDelayMs - Date.now()) : 0;
          if (delay) {
            try { await pause(delay, undefined, { signal }); }
            catch (error) {
              if (!signal.aborted) throw error;
              return status(run, options.workspaceRoot, { status: 'paused', reason: 'cancelled-before-proof' });
            }
            await guard(run, signal);
            next = await journey.nextValidation(childOptions(run, options.workspaceRoot));
            if (!next.approvalToken) return status(run, options.workspaceRoot, { status: 'blocked', reason: next.reason });
          }
        }
        await runChild(run, next, execution, adapters);
        if (barrier(run)) return status(run, options.workspaceRoot);
      }
    } finally { clearTimeout(timer); protocol.close(); }
  });
});
export const recordExecutionEvidence = options => scoped(options, async () => {
  const dir = await assertProjectPath(path.resolve(options.project));
  return withControlLock(dir, async () => {
    const run = await readRun(dir);
    check(!barrier(run), 'HISTORY', 'Owner evidence cannot clear failed, unknown or interrupted execution.');
    const request = checked(await readControl(await assertProjectPath(path.resolve(options.config))), validCheckpoint);
    const report = await journey.validationStatus(childOptions(run, options.workspaceRoot));
    check(request.milestones.every(row => report.milestones.some(m => m.name === row.name && m.outcome === 'pending')
      && (row.outcome !== 'passed' || digestPattern.test(row.evidenceDigest ?? ''))),
    'EVIDENCE', 'Record only genuine pending milestones with evidence digests. Never replace a failed or deferred finding.');
    await checkpoint(run, request.milestones, options, {});
    return status(run, options.workspaceRoot);
  });
});
