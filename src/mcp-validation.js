import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import path from 'node:path';
import { mkdir, lstat, readdir } from 'node:fs/promises';
import { assertProjectPath, isWithin, withCliWorkspace } from './config.js';
import { boundedSnapshot, metadataDigest, savedJson } from './anonymous-metadata.js';
import { readControl, writeControl, withControlLock } from './mcp-control.js';
import { getLibraryInfo } from './machine-contract.js';
import { secretIssues } from './validation.js';
import { compileHostingRecipe } from './mcp-container-apps.js';
import { readRecipeProject, recipeSourcePlan } from './mcp-recipe-artifacts.js';
import { readMcpServerProject } from './mcp-lifecycle.js';
import { readMcpStatus } from './mcp-status.js';
import { readMcpDiagnosis } from './mcp-diagnosis.js';
import { readOperatorHandover } from './mcp-operator.js';
import { checkedResultAssertion } from './mcp-result-assertion.js';
import { assertMcpProofHistory } from './mcp-proof-history.js';
import { planMcpProjectDiscovery, planMcpProjectProof, runMcpProjectProof } from './mcp-discovery-project.js';
import { planInteractiveSession, runInteractiveSession } from './mcp-interactive-session.js';
import { readHandoverRelease, planHandover, writeHandover } from './mcp-handover.js';

const object = (properties, required = Object.keys(properties)) =>
  ({ type: 'object', additionalProperties: false, properties, required });
const filename = { type: 'string', minLength: 1, maxLength: 2048 };
const text = { type: 'string', minLength: 1, maxLength: 300, pattern: '^[A-Za-z0-9][A-Za-z0-9 ._:/@(),-]*$' };
const hash = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' };
const manual = ['runtime-deployment', 'secret-resolution', 'auth-registration', 'authorization',
  'fcc-save', 'admin-ready', 'audience', 'consumer-call', 'read-only-ui'];
const proofSchema = object({
  toolName: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$' },
  arguments: object({}),
  safetyReview: object({ readOnly: { const: true }, reason: text }),
  resultAssertion: object({ kind: { const: 'json-array-string-field-v1' }, field: { type: 'string' },
    maxItems: { type: 'integer' }, maxStringLength: { type: 'integer' } }),
}, ['toolName', 'arguments', 'safetyReview']);
export const validationScenarioSchema = object({
  schemaVersion: { const: 1 }, scenario: { const: 'container-apps-existing-v1' },
  sourceProject: filename, referenceProject: filename, releaseDirectory: filename,
  consumer: { enum: ['fcc', 'none'] }, privateExportReviewed: { const: true },
  discovery: object({ discoveryClientId: { type: 'string', format: 'uuid' },
    expectedUserId: { type: 'string', format: 'uuid' } }),
  proof: proofSchema,
}, ['schemaVersion', 'scenario', 'sourceProject', 'referenceProject', 'consumer',
  'privateExportReviewed', 'discovery', 'proof']);
export const validationCheckpointSchema = object({
  schemaVersion: { const: 1 },
  milestones: { type: 'array', minItems: 1, maxItems: manual.length, items: object({
    name: { enum: manual }, outcome: { enum: ['passed', 'failed', 'deferred'] },
    evidenceDigest: hash, note: text,
  }, ['name', 'outcome', 'note']) },
});
export const validationSchema = { scenario: validationScenarioSchema, checkpoint: validationCheckpointSchema };
const ajv = new Ajv(); addFormats(ajv);
const validScenario = ajv.compile(validationScenarioSchema), validCheckpoint = ajv.compile(validationCheckpointSchema);
export const digest = value => metadataDigest(boundedSnapshot(value));
export const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',');
export function requireRun(ok, code, message) {
  if (!ok) throw Object.assign(new Error(message), { code: `MCP_VALIDATION_${code}` });
}
export function checked(value, validator) {
  const input = boundedSnapshot(value);
  requireRun(validator(input) && !secretIssues(savedJson(input)), 'INPUT',
    'Use mcp-validation-schema with explicit nonsecret metadata; no credentials, raw logs or verified-status declarations.');
  return input;
}
export const scoped = async (options, action) => {
  requireRun(typeof options.workspaceRoot === 'string', 'WORKSPACE', 'Select an explicit private --workspace-root.');
  try { return await withCliWorkspace(options.workspaceRoot, action); }
  catch (error) {
    if (error instanceof SyntaxError) requireRun(false, 'INPUT', 'A validation input or retained record is not valid JSON. Preserve the file; no raw contents are displayed.');
    throw error;
  }
};
export async function absent(file) {
  try { await lstat(file); requireRun(false, 'EXISTS', 'Output already exists; preserve it and select a new directory.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function resolveInput(input, base) {
  const paths = {};
  for (const key of ['sourceProject', 'referenceProject', 'releaseDirectory']) {
    if (input[key]) paths[key] = await assertProjectPath(path.resolve(base, input[key]));
  }
  return { ...input, ...paths };
}
async function bindings(input, workspaceRoot) {
  const paths = [input.sourceProject, input.referenceProject, input.releaseDirectory].filter(Boolean);
  requireRun(paths.every((p, i) => paths.every((q, j) => i === j || !isWithin(p, q))),
    'INPUT', 'Source, reference and optional release must be separate nonoverlapping projects.');
  const source = await readRecipeProject(input.sourceProject), compiled = compileHostingRecipe(source.input);
  requireRun(source.input.recipe === 'container-apps-direct-v1'
    && digest(compiled.runtime) === digest(source.runtime)
    && source.input.operationIds.includes(input.proof.toolName), 'SOURCE',
  'This validator supports only an unchanged direct Container Apps source and one of its fixed GET tools.');
  if (input.proof.resultAssertion) checkedResultAssertion(input.proof.resultAssertion);
  const reference = await readMcpServerProject(input.referenceProject);
  const origin = await readControl(path.join(input.referenceProject, 'recipe-origin.json'));
  const a = compiled.runtime.authentication, descriptor = reference.review.descriptor;
  requireRun(origin.schemaVersion === 1 && origin.kind === 'recipe-endpoint-reference' && origin.recipe === source.input.recipe
    && origin.sourceManifestDigest === source.manifest.contentDigest
    && origin.endpoint === descriptor.endpoint && descriptor.kind === 'existing-mcp'
    && digest(reference.review.input.inbound) === digest({ type: 'entra', tenantId: a.tenantId, clientId: a.audience,
      applicationIdUri: a.applicationIdUri, scope: a.scope, allowedClientIds: a.allowedClientIds })
    && a.allowedClientIds.some(id => id.toLowerCase() === input.discovery.discoveryClientId.toLowerCase()), 'REFERENCE',
  'Use the source-matched existing endpoint reference and an explicitly allowed discovery client. Never create a replacement to replay a call.');
  await planMcpProjectDiscovery(input.referenceProject, input.discovery);
  const release = input.releaseDirectory ? await readHandoverRelease(input.releaseDirectory, source) : undefined;
  const sourcePlan = await recipeSourcePlan({ workspaceRoot, project: input.sourceProject });
  return { source, reference, binding: { sourceManifestDigest: source.manifest.contentDigest,
    referenceReviewDigest: reference.review.reviewDigest, originDigest: digest(origin),
    sourceArchiveSha256: sourcePlan.sourceArchiveSha256,
    releaseDigest: release ? digest({ summary: release.summary, review: release.review }) : null },
  };
}
async function startPlan(options) {
  requireRun(typeof options.config === 'string' && typeof options.output === 'string', 'INPUT',
    'Validation plan/start requires --config and a NEW --output directory.');
  const file = await assertProjectPath(path.resolve(options.config));
  const input = await resolveInput(checked(await readControl(file), validScenario), path.dirname(file));
  const outputPath = await assertProjectPath(path.resolve(options.output));
  requireRun((await lstat(path.dirname(outputPath))).isDirectory()
    && [input.sourceProject, input.referenceProject, input.releaseDirectory].filter(Boolean)
      .every(p => !isWithin(p, outputPath) && !isWithin(outputPath, p)), 'OUTPUT',
  'The new run directory must be separate from its source, release and endpoint reference.');
  await absent(outputPath);
  const { binding } = await bindings(input, options.workspaceRoot);
  const build = await getLibraryInfo();
  const body = { action: 'mcp-validation-start', outputPath, input, binding, buildId: build.contentDigest,
    effects: ['Create a private resumable validation record and local report; no network, login, deployment or provider call.',
      'Future phases require their own exact approval. Session proof additionally requires its newly displayed terminal approval.',
      'Unknown or failed attempts remain consumed. Owner checkpoints are declarations, not service attestations.'] };
  return { ...body, approvalToken: `mcp-validation/${digest(body)}` };
}
export const planValidation = options => scoped(options, () => startPlan(options));

async function readRun(project) {
  const dir = await assertProjectPath(path.resolve(project));
  const record = await readControl(path.join(dir, 'validation-run.json'));
  const { contentDigest, ...body } = record;
  requireRun(keys(body, ['schemaVersion', 'kind', 'runDirectory', 'createdAt', 'input', 'binding', 'buildId'])
    && body.schemaVersion === 1 && body.kind === 'mcp-validation-run' && digest(body) === contentDigest
    && body.runDirectory === dir
    && typeof body.createdAt === 'string' && Number.isFinite(Date.parse(body.createdAt))
    && new Date(body.createdAt).toISOString() === body.createdAt && Date.parse(body.createdAt) <= Date.now(),
  'STATE', 'Run definition changed or is incomplete; preserve it, never repair approval hashes.');
  checked(body.input, validScenario);
  const names = await readdir(await assertProjectPath(path.join(dir, 'events')));
  requireRun(names.length <= 100 && names.every(n => /^\d{4}\.json$/.test(n)), 'STATE', 'Invalid or oversized validation journal.');
  const events = [];
  let previous = contentDigest, pending;
  for (const [index, name] of names.sort().entries()) {
    requireRun(name === `${String(index + 1).padStart(4, '0')}.json`, 'STATE', 'Validation journal sequence is incomplete.');
    const event = await readControl(path.join(dir, 'events', name), 65536);
    const { contentDigest: eventDigest, ...entry } = event;
    requireRun(keys(entry, ['schemaVersion', 'previous', 'recordedAt', 'kind', 'data'])
      && entry.schemaVersion === 1 && entry.previous === previous && digest(entry) === eventDigest
      && typeof entry.recordedAt === 'string' && Number.isFinite(Date.parse(entry.recordedAt))
      && new Date(entry.recordedAt).toISOString() === entry.recordedAt
      && Date.parse(entry.recordedAt) <= Date.now()
      && Date.parse(entry.recordedAt) >= Date.parse(events.at(-1)?.recordedAt ?? body.createdAt),
    'STATE', 'Validation journal integrity or chronology differs; preserve it.');
    if (entry.kind === 'intent') {
      requireRun(!pending && keys(entry.data, ['phase', 'approvalDigest'])
        && ['session', 'proof', 'handover'].includes(entry.data.phase)
        && /^sha256:[a-f0-9]{64}$/.test(entry.data.approvalDigest), 'STATE', 'Invalid validation step intent.');
      pending = eventDigest;
    } else if (entry.kind === 'result') {
      requireRun(pending && keys(entry.data, ['intentDigest', 'status', 'artifact'])
        && entry.data.intentDigest === pending
        && ['passed', 'failed', 'declined', 'unknown'].includes(entry.data.status)
        && (entry.data.artifact === null || typeof entry.data.artifact === 'string'), 'STATE', 'Invalid validation step result.');
      pending = undefined;
      if (entry.data.artifact !== null) {
        requireRun(path.isAbsolute(entry.data.artifact) && entry.data.artifact.length <= 2048, 'STATE', 'Invalid artifact path.');
        await assertProjectPath(entry.data.artifact);
      }
    } else if (entry.kind === 'checkpoint') {
      requireRun(!pending, 'STATE', 'Unresolved execution cannot be overwritten by a checkpoint.');
      checkpoint(entry.data);
    } else if (entry.kind === 'refresh') {
      requireRun(!pending && keys(entry.data, []), 'STATE', 'Invalid local refresh event.');
    } else requireRun(false, 'STATE', 'Unknown validation event.');
    events.push(event); previous = eventDigest;
  }
  return { dir, ...body, contentDigest, events, head: previous, pending };
}
function checkpoint(value) {
  const input = checked(value, validCheckpoint);
  requireRun(new Set(input.milestones.map(m => m.name)).size === input.milestones.length
    && input.milestones.every(m => m.outcome === 'deferred' || m.evidenceDigest),
  'INPUT', 'Checkpoint names must be unique; passed/failed owner declarations require an evidence digest.');
  return input;
}
async function append(run, kind, data) {
  requireRun(run.events.length < 100, 'LIMIT', 'Validation run reached its bounded journal limit.');
  const body = { schemaVersion: 1, previous: run.head, recordedAt: new Date().toISOString(), kind, data };
  const event = { ...body, contentDigest: digest(body) };
  await writeControl(path.join(run.dir, 'events', `${String(run.events.length + 1).padStart(4, '0')}.json`), event, { create: true });
  run.events.push(event); run.head = event.contentDigest;
  return event;
}
async function inspect(run, workspaceRoot) {
  const current = await bindings(run.input, workspaceRoot);
  requireRun(digest(current.binding) === digest(run.binding), 'CHANGED',
    'Source/reference/release binding changed. Preserve the run; do not reseal or continue against a different target.');
  const build = await getLibraryInfo();
  requireRun(build.contentDigest === run.buildId, 'BUILD',
    'Use the pinned toolkit build for this validation run. A changed installation requires a newly reviewed run, not reused approvals.');
  const status = await readMcpStatus(run.input.referenceProject, { journey: true });
  const diagnosis = await readMcpDiagnosis(run.input.referenceProject);
  const operator = await readOperatorHandover({ workspaceRoot, project: run.input.sourceProject });
  let networkLocked = false;
  try {
    await lstat(await assertProjectPath(path.join(run.input.referenceProject, '.mcp-network.lock')));
    networkLocked = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const milestones = {};
  for (const name of manual) {
    const recorded = operator.milestones[name];
    milestones[name] = recorded && recorded.status !== 'not-confirmed'
      ? { name, outcome: recorded.status, provenance: recorded.provenance, observedAt: operator.milestoneDates[name] }
      : { name, outcome: 'pending', provenance: 'not-recorded' };
  }
  for (const event of run.events.filter(e => e.kind === 'checkpoint')) for (const m of event.data.milestones) {
    if (!milestones[m.name].observedAt || event.recordedAt >= milestones[m.name].observedAt) {
      milestones[m.name] = { ...m, provenance: 'owner-reported-not-independently-verified', observedAt: event.recordedAt };
    }
  }
  const required = ['runtime-deployment', ...(current.source.input.backend.apiKey ? ['secret-resolution'] : []),
    ...(run.input.consumer === 'fcc' ? manual.filter(n => !['runtime-deployment', 'secret-resolution'].includes(n)) : [])];
  requireRun(run.events.filter(e => e.kind === 'checkpoint').every(e =>
    e.data.milestones.every(m => required.includes(m.name))), 'STATE', 'Retained checkpoint is outside the selected scenario.');
  const proofs = status.proofs.filter(p => p.status !== 'not-proof' && p.status !== 'not-dispatched');
  const captures = [];
  for (const observation of status.observations.filter(o => ['valid', 'stale'].includes(o.status))) {
    const capture = await readControl(path.join(run.input.referenceProject, '.mcp-observations', observation.attemptId, 'capture.json'));
    const auth = capture.discoveryPlan.auth;
    if (auth?.discoveryClientId === run.input.discovery.discoveryClientId.toLowerCase()
      && auth?.expectedUserId === run.input.discovery.expectedUserId.toLowerCase()) {
      captures.push({ ...observation, receiptDigest: capture.receiptDigest });
    }
  }
  let protocol = { status: 'pending', provenance: 'not-recorded' };
  if (proofs.some(p => p.status !== 'completed')) protocol = { status: 'unknown', provenance: 'retained-proof-history' };
  else if (proofs.length) {
    const matching = [];
    for (const attempt of proofs) {
      const receipt = await readControl(path.join(run.input.referenceProject, '.mcp-observations', attempt.attemptId, 'proof.json'));
      if (receipt.sourceDigest === current.reference.review.descriptor.descriptorDigest
        && receipt.toolName === run.input.proof.toolName && receipt.argumentsDigest === digest(run.input.proof.arguments)
        && digest(receipt.resultAssertion ?? null) === digest(run.input.proof.resultAssertion ?? null)
        && captures.some(c => c.receiptDigest === receipt.captureDigest)) {
        matching.push({ attempt, receipt });
      }
    }
    protocol = matching.length === 1
      ? { status: matching[0].receipt.status === 'protocol-success'
          && (!matching[0].receipt.backendAssertion || matching[0].receipt.backendAssertion.status === 'passed') ? 'passed-historical' : 'failed-historical',
        provenance: 'retained-protocol-evidence-not-live-health', receiptDigest: matching[0].receipt.receiptDigest }
      : { status: 'consumed-other-proof', provenance: 'retained-proof-history' };
  }
  const lastIntent = run.events.findLast(e => e.kind === 'intent');
  const lastResult = run.events.findLast(e => e.kind === 'result');
  const blocked = Boolean(networkLocked || run.pending || run.events.some((e, i) => e.kind === 'result'
    && ['failed', 'unknown'].includes(e.data.status) && run.events[i - 1]?.data.phase !== 'handover')
    || ['unknown', 'consumed-other-proof', 'failed-historical'].includes(protocol.status));
  const failed = protocol.status === 'failed-historical' || required.some(n => milestones[n].outcome === 'failed');
  const report = { schemaVersion: 1, scenario: run.input.scenario, runDirectory: run.dir, buildId: run.buildId,
    inputBinding: run.binding, historyDigest: digest({ status: status.historyDigest, operator, networkLocked, head: run.head }),
    status: blocked ? 'blocked' : required.some(n => milestones[n].outcome === 'pending') ? 'waiting-for-owner'
      : protocol.status === 'pending' ? 'pending-protocol' : 'checks-recorded',
    outcome: failed ? 'failed' : blocked ? 'blocked'
      : required.some(n => ['pending', 'deferred'].includes(milestones[n].outcome)) || protocol.status === 'pending'
        ? 'incomplete' : 'passed-with-owner-and-historical-evidence',
    localChecks: { source: 'integrity-checked', reference: 'source-bound-not-deployment-attested',
      release: run.input.releaseDirectory ? 'source-matched-not-deployed' : 'not-selected',
      diagnosis: { status: diagnosis.status, barriers: diagnosis.barriers, nextCommand: diagnosis.next.command } },
    milestones: required.map(n => milestones[n]), protocol, waiting: operator.waiting, networkLocked,
    lastStep: lastIntent ? { phase: lastIntent.data.phase, status: run.pending ? 'unknown' : lastResult?.data.status } : null,
    reportDirectory: path.join(run.dir, 'reports'),
    handovers: run.events.filter((e, i) => e.kind === 'result' && e.data.status === 'passed'
      && run.events[i - 1]?.data.phase === 'handover').map(e => e.data.artifact),
    executionReadiness: false, consumerExecutionAttested: false, proofReplayAuthorized: false,
    integrity: 'unkeyed-local-chain-not-independent-attestation',
    limitations: ['This is a bounded existing direct Container Apps validation, not deployment, key resolution or registration automation.',
      'Owner declarations and historical protocol results are not fresh service or consumer attestation.',
      'Do not repeat failed/unknown calls, create replacement references or remove locks to continue.'] };
  return { run, report, milestones, required, status, operator, protocol, blocked,
    capture: captures.filter(c => c.status === 'valid').sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)).at(-1),
    current };
}
async function state(options) {
  requireRun(typeof options.project === 'string', 'INPUT', 'Select the retained validation run with --project.');
  return inspect(await readRun(options.project), options.workspaceRoot);
}
export const validationStatus = options => scoped(options, async () => (await state(options)).report);

async function snapshots(run, workspaceRoot) {
  const { report } = await inspect(run, workspaceRoot);
  const name = String(run.events.length).padStart(4, '0');
  const snapshotAt = new Date().toISOString();
  await writeControl(path.join(run.dir, 'reports', `${name}.json`), { ...report, snapshotAt }, { create: true });
  await writeControl(path.join(run.dir, 'reports', `${name}-handover.json`),
    handoverInput(run, report, snapshotAt), { create: true });
  return report;
}
function handoverInput(run, report, snapshotAt) {
  const milestones = report.milestones.filter(m => m.name !== 'secret-resolution' && m.outcome !== 'pending')
    .map(m => ({ name: m.name, outcome: m.outcome, observedAt: m.observedAt, ...(m.note ? { note: m.note } : {}) }));
  return {
    schemaVersion: 1, snapshotAt, privateExportReviewed: true, referenceProject: run.input.referenceProject,
    ...(run.input.releaseDirectory ? { releaseDirectory: run.input.releaseDirectory } : {}), milestones,
    operationsNote: `Validation outcome: ${report.outcome}. Protocol: ${report.protocol.status}. Last step: ${report.lastStep?.status ?? 'none'}. Consumer scope: ${run.input.consumer}. Secret resolution: ${report.milestones.find(m => m.name === 'secret-resolution')?.outcome ?? 'not-applicable'}. Report digest: ${digest(report)}. Owner reports and historical receipts are not live attestations. Keep the separate validation report.`,
  };
}
export const startValidation = options => scoped(options, async () => {
  const plan = await startPlan(options);
  requireRun(options.approval === plan.approvalToken, 'APPROVAL', 'Review and approve the exact current validation start plan.');
  await mkdir(plan.outputPath, { mode: 0o700 });
  await mkdir(path.join(plan.outputPath, 'events'), { mode: 0o700 });
  await mkdir(path.join(plan.outputPath, 'reports'), { mode: 0o700 });
  await writeControl(path.join(plan.outputPath, 'session.json'),
    { schemaVersion: 1, discovery: plan.input.discovery, proof: plan.input.proof }, { create: true });
  const body = { schemaVersion: 1, kind: 'mcp-validation-run', runDirectory: plan.outputPath, createdAt: new Date().toISOString(),
    input: plan.input, binding: plan.binding, buildId: plan.buildId };
  const contentDigest = digest(body);
  const report = await snapshots({ ...body, dir: plan.outputPath, contentDigest, head: contentDigest, events: [] }, options.workspaceRoot);
  await writeControl(path.join(plan.outputPath, 'validation-run.json'), { ...body, contentDigest }, { create: true });
  return report;
});
async function next(options) {
  requireRun([undefined, 'handover', 'refresh'].includes(options.phase), 'INPUT', 'Only --phase handover or refresh is supported.');
  const s = await state(options), { run, report } = s;
  const stop = (status, reason) => ({ action: 'mcp-validation-next', status, report, reason, repeatPrompt: false, approvalToken: null });
  let phase, childPlan, selection, decision, selected;
  if (options.config) {
    requireRun(options.phase === undefined, 'INPUT', 'Choose a checkpoint config or a phase, not both.');
    decision = checkpoint(await readControl(path.resolve(options.config), 65536));
    requireRun(decision.milestones.every(m => s.required.includes(m.name)), 'INPUT', 'Checkpoint is outside this selected scenario.');
    if (run.pending) return stop('blocked', 'An interrupted step is unresolved. Preserve journals and inspect existing evidence; no automatic replay.');
    phase = 'checkpoint';
  } else if (options.phase === 'refresh') {
    if (run.pending) return stop('blocked', 'An interrupted step cannot be cleared by refreshing the local report.');
    phase = 'refresh';
  } else if (options.phase === 'handover' || report.status === 'checks-recorded') {
    const completed = run.events.some((e, i) => e.kind === 'intent' && e.data.phase === 'handover'
      && run.events[i + 1]?.data.status === 'passed' && i + 1 === run.events.length - 1);
    if (completed) return stop('complete', 'The retained report and handover are written. This is not live readiness or renewed execution authority.');
    if (run.pending) return stop('blocked', 'Interrupted step: preserve its run journal; use the existing source handover commands for an independent reviewed snapshot.');
    phase = 'handover';
    const name = String(run.events.length).padStart(4, '0');
    const { snapshotAt, ...savedReport } = await readControl(path.join(run.dir, 'reports', `${name}.json`));
    requireRun(digest(savedReport) === digest(report), 'SNAPSHOT',
      'Evidence changed since the saved snapshot. Review --phase refresh to record a new local report before exporting.');
    const supplied = await readControl(path.join(run.dir, 'reports', `${name}-handover.json`));
    requireRun(digest(supplied) === digest(handoverInput(run, report, snapshotAt)), 'SNAPSHOT',
      'Handover input differs from the retained validation report. Preserve it; do not rewrite reports.');
    selected = { workspaceRoot: options.workspaceRoot, project: run.input.sourceProject,
      config: path.join(run.dir, 'reports', `${name}-handover.json`), output: path.join(run.dir, `handover-${name}`) };
    childPlan = await planHandover(selected);
  } else {
    requireRun(options.phase === undefined, 'INPUT', 'Only --phase handover or refresh is supported.');
    if (s.blocked) return stop('blocked', 'A failed, unknown or consumed step is retained. Inspect mcp-status/mcp-diagnose; never repeat it to repair this report.');
    if (s.operator.waiting) return stop('waiting-for-owner', 'The source operator journal is waiting. Honor its exact resume checkpoint before further live work.');
    const preflight = ['runtime-deployment', ...(s.required.includes('secret-resolution') ? ['secret-resolution'] : [])];
    const missing = preflight.find(n => s.milestones[n].outcome !== 'passed');
    if (missing) return stop('waiting-for-owner', `Record ${missing} after its independent review, or request --phase handover for this pause. No cloud/secret operation is automated.`);
    if (s.protocol.status === 'failed-historical') return stop('blocked', 'The retained proof failed. It remains consumed; a new run is not permission to replay.');
    if (s.protocol.status === 'pending') {
      if (s.capture) {
        phase = 'proof';
        selection = { ...run.input.proof,
          capture: path.join(run.input.referenceProject, '.mcp-observations', s.capture.attemptId, 'capture.json') };
        childPlan = await planMcpProjectProof(run.input.referenceProject, selection);
        assertMcpProofHistory(childPlan.proofHistory, childPlan.approvalDigest, childPlan.operation.approvalDigest, childPlan.operation);
      } else {
        phase = 'session';
        const sessionInput = await readControl(path.join(run.dir, 'session.json'));
        requireRun(digest(sessionInput) === digest({ schemaVersion: 1, discovery: run.input.discovery, proof: run.input.proof }),
          'STATE', 'Session selection changed; preserve the run.');
        selected = { workspaceRoot: options.workspaceRoot, project: run.input.referenceProject,
          config: path.join(run.dir, 'session.json') };
        childPlan = await planInteractiveSession(selected);
      }
    } else {
      const missingOwner = s.required.find(n => s.milestones[n].outcome === 'pending');
      return stop('waiting-for-owner', `Record the remaining consumer checkpoints (${missingOwner}). One checkpoint file may contain multiple owner results or explicit deferrals.`);
    }
  }
  const body = { action: 'mcp-validation-next', status: 'review-required', phase,
    runDirectory: run.dir, historyDigest: report.historyDigest, buildId: run.buildId,
    decision: decision ?? null, childPlan: childPlan ?? null,
    requiredFlags: ['session', 'proof'].includes(phase) ? ['--allow-network', '--interactive'] : [],
    effects: phase === 'checkpoint' ? ['Record bounded owner declarations; do not execute or attest their underlying actions.']
      : phase === 'refresh' ? ['Read retained evidence and write a new local snapshot. No sign-in, retry or evidence renewal.']
      : phase === 'handover' ? ['Write the exact private offline handover snapshot. No browser upload or deployment.']
        : ['Run only the exact existing MCP phase. Sign-in challenge is terminal-only.',
          ...(phase === 'session' ? ['Discovery is approved; the new exact proof still needs its separate terminal approval.'] : []),
          'No automatic refresh/relogin/retry or deployment. Unknown dispatch remains consumed.'] };
  return { ...body, approvalToken: `mcp-validation/${digest(body)}`, report,
    ...(selected ? { selected } : {}), ...(selection ? { selection } : {}) };
}
export const nextValidation = options => scoped(options, () => next(options));
export const runValidation = (options, dependencies = {}) => scoped(options, async () =>
  withControlLock(await assertProjectPath(path.resolve(options.project)), async () => {
    const plan = await next(options);
    requireRun(plan.approvalToken && plan.approvalToken === options.approval, 'APPROVAL',
      'Review the exact current next plan; inputs, history or the selected step may have changed.');
    const network = ['session', 'proof'].includes(plan.phase);
    requireRun(network ? options.allowNetwork === true && options.interactive === true && typeof options.onDeviceCode === 'function'
      : options.allowNetwork === undefined && options.interactive === undefined, 'FLAGS', 'Use only the effect flags named by this next plan.');
    requireRun(!options.signal?.aborted, 'ABORTED', 'Validation was cancelled before dispatch.');
    const run = await readRun(options.project);
    if (['checkpoint', 'refresh'].includes(plan.phase)) {
      await append(run, plan.phase, plan.decision ?? {});
      return snapshots(run, options.workspaceRoot);
    }
    requireRun(run.events.length <= 98, 'LIMIT', 'Insufficient journal capacity for an execution intent and result.');
    requireRun(plan.phase !== 'session' || typeof options.approveProof === 'function', 'FLAGS',
      'Session execution requires a separate exact proof approval callback.');
    const intent = await append(run, 'intent', { phase: plan.phase, approvalDigest: digest(plan.approvalToken) });
    let status, artifact = null;
    try {
      if (plan.phase === 'handover') {
        const result = await writeHandover({ ...plan.selected, approval: plan.childPlan.approvalToken });
        status = 'passed'; artifact = result.entryFile;
      } else if (plan.phase === 'session') {
        const result = await runInteractiveSession({ ...plan.selected, approval: plan.childPlan.approvalDigest,
          allowNetwork: true, signal: options.signal, onDeviceCode: options.onDeviceCode, approveProof: options.approveProof },
        dependencies.sessionDependencies);
        status = result.status === 'discovered-proof-declined' ? 'declined'
          : result.status === 'protocol-success' && (!result.backendAssertion || result.backendAssertion.status === 'passed') ? 'passed'
            : result.status === 'unknown' ? 'unknown' : 'failed';
        artifact = result.proofFile ?? result.captureFile;
      } else {
        const result = await (dependencies.mcpProjectOperation
          ? dependencies.mcpProjectOperation(run.input.referenceProject, { selection: plan.selection,
            approval: plan.childPlan, allowNetwork: true, signal: options.signal, onDeviceCode: options.onDeviceCode }, true)
          : runMcpProjectProof(run.input.referenceProject, { selection: plan.selection,
            approval: plan.childPlan, allowNetwork: true, signal: options.signal, onDeviceCode: options.onDeviceCode }));
        status = result.result.status === 'protocol-success'
          && (!result.result.backendAssertion || result.result.backendAssertion.status === 'passed') ? 'passed'
            : result.result.status === 'unknown' ? 'unknown' : 'failed';
        artifact = result.resultFile;
      }
    } catch {
      // The child owns detailed bounded failure evidence; never persist raw provider errors here.
      await append(run, 'result', { intentDigest: intent.contentDigest, status: 'unknown', artifact: null });
      await snapshots(run, options.workspaceRoot);
      throw Object.assign(new Error('Validation step did not complete. Preserve child evidence and the unknown run outcome; no automatic retry.'),
        { code: 'MCP_VALIDATION_STEP_UNKNOWN' });
    }
    await append(run, 'result', { intentDigest: intent.contentDigest, status, artifact });
    return snapshots(run, options.workspaceRoot);
  }));
