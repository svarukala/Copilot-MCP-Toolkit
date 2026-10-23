import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import path from 'node:path';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { assertProjectPath, withCliWorkspace } from './config.js';
import { boundedSnapshot, metadataDigest, savedJson } from './anonymous-metadata.js';
import { readControl, writeControl, withControlLock } from './mcp-control.js';
import { getLibraryInfo } from './machine-contract.js';
import { secretIssues } from './validation.js';

const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const text = { type: 'string', minLength: 1, maxLength: 120, pattern: '^[A-Za-z0-9][A-Za-z0-9 ._:/@()-]*$' };
const hash = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' };
const uuid = { type: 'string', format: 'uuid' };
const milestoneNames = ['auth-registration', 'directory-settings', 'runtime-deployment', 'authorization',
  'fcc-save', 'admin-ready', 'audience', 'consumer-call', 'read-only-ui'];
const reasons = ['owner-unavailable', 'metadata-missing', 'portal-action', 'legal-review', 'identity-required'];
const operation = object({
  kind: { enum: ['image-build', 'deployment', 'directory-update', 'permission-change'] },
  tenantId: uuid, subscriptionId: uuid,
  accountName: { type: 'string', format: 'email', maxLength: 254 },
  target: { type: 'string', minLength: 1, maxLength: 512, pattern: '^/[A-Za-z0-9/_.()-]+$' },
  purpose: text, inputsDigest: hash,
  authorization: object({ basis: { const: 'explicit-operation-review' }, reviewDigest: hash }),
});
const event = (action, properties) => object({ schemaVersion: { const: 1 }, action: { const: action }, ...properties });
export const operatorSchema = { oneOf: [
  event('reserve', { operation }),
  event('dispatch', { operationKey: hash }),
  event('observe', { operationKey: hash,
    result: object({ status: { enum: ['unknown', 'submitted', 'provisioned', 'revision-ready',
      'traffic-ready', 'endpoint-checked', 'succeeded', 'failed'] }, evidenceDigest: hash }) }),
  event('wait', { phase: text, reason: { enum: reasons }, resumeWhen: text }),
  event('owner-result', { milestone: { enum: milestoneNames }, outcome: { enum: ['passed', 'failed'] },
    evidenceDigest: hash }),
  event('resume', { waitDigest: hash, ownerInputDigest: hash }),
] };
const ajv = new Ajv({ allErrors: false }); addFormats(ajv);
const valid = ajv.compile(operatorSchema);
const digest = value => metadataDigest(boundedSnapshot(value));
function requireOperator(ok, code, message) {
  if (!ok) throw Object.assign(new Error(message), { code: `MCP_OPERATOR_${code}` });
}
function checked(input) {
  const value = boundedSnapshot(input);
  requireOperator(valid(value) && !secretIssues(savedJson(value)), 'INPUT',
    'Use mcp-operator-schema with bounded nonsecret metadata and evidence digests, never logs or credentials.');
  if (value.action === 'reserve') {
    const o = value.operation;
    requireOperator(o.target.toLowerCase().startsWith(`/subscriptions/${o.subscriptionId.toLowerCase()}/`)
      || o.kind === 'directory-update' && /^\/applications\/[a-f0-9-]{36}$/i.test(o.target),
    'TARGET', 'Use the exact selected subscription resource or directory application object ID.');
  }
  return value;
}
const operationKey = o => digest({ kind: o.kind, tenantId: o.tenantId.toLowerCase(),
  subscriptionId: o.subscriptionId.toLowerCase(), target: o.target.toLowerCase(), purpose: o.purpose });
const stateOrder = ['submitted', 'provisioned', 'revision-ready', 'traffic-ready', 'endpoint-checked', 'succeeded'];

function reduce(records) {
  const operations = {}, milestones = Object.fromEntries(milestoneNames.map(name => [name, { status: 'not-confirmed' }]));
  let waiting = null;
  for (const record of records) {
    const e = checked(record.event);
    requireOperator(!waiting || !['reserve', 'dispatch'].includes(e.action), 'WAITING',
      'Waiting for owner input; record the exact resume input before a new reservation or dispatch.');
    if (e.action === 'reserve') {
      const key = operationKey(e.operation);
      requireOperator(!operations[key], 'CONSUMED', 'This purpose is already reserved; changed inputs do not reopen it.');
      operations[key] = { operation: e.operation, status: 'reserved', dispatchRecorded: false,
        lastKnownStage: null, replayAuthorized: false, provenance: 'operator-declared-not-service-attested' };
    } else if (e.action === 'dispatch') {
      const o = operations[e.operationKey];
      requireOperator(o && o.status === 'reserved' && !o.dispatchRecorded, 'CONSUMED',
        'Dispatch must follow one reservation and cannot be repeated. Reconcile uncertain external work.');
      o.dispatchRecorded = true;
      o.status = 'unknown';
    } else if (e.action === 'observe') {
      const o = operations[e.operationKey], next = e.result.status;
      requireOperator(o?.dispatchRecorded && !['succeeded', 'failed', 'endpoint-checked'].includes(o.status),
        'TRANSITION', 'Observation requires a dispatched nonterminal operation; it cannot launch or repeat work.');
      requireOperator(!['provisioned', 'revision-ready', 'traffic-ready', 'endpoint-checked'].includes(next)
        || o.operation.kind === 'deployment', 'TRANSITION', 'Revision/traffic stages apply only to deployment.');
      requireOperator(next === 'unknown' || next === 'failed'
        || stateOrder.indexOf(next) >= stateOrder.indexOf(o.lastKnownStage), 'TRANSITION',
      'An observation cannot move a known stage backward; preserve mismatches and investigate.');
      o.status = next;
      if (!['unknown', 'failed'].includes(next)) o.lastKnownStage = next;
      o.evidenceDigest = e.result.evidenceDigest;
    } else if (e.action === 'wait') {
      requireOperator(!waiting, 'WAITING', 'Already waiting for owner input. Reuse the current handoff; do not re-prompt.');
      waiting = { phase: e.phase, reason: e.reason, resumeWhen: e.resumeWhen, waitDigest: record.contentDigest,
        disposition: 'waiting-for-owner', repeatPrompt: false, completed: false };
    } else if (e.action === 'resume') {
      requireOperator(waiting?.waitDigest === e.waitDigest, 'TRANSITION', 'Resume must reference the exact current waiting handoff.');
      waiting = null;
    } else if (e.action === 'owner-result') {
      milestones[e.milestone] = { status: e.outcome, provenance: 'owner-reported-not-independently-verified',
        evidenceDigest: e.evidenceDigest };
    }
  }
  return { operations, milestones, waiting, executionReadiness: false, proofReplayAuthorized: false,
    providerCalls: 'not-derived-use-existing-proof-journals',
    instructions: 'External operations remain separate. Record dispatch BEFORE invoking the operator command. Empty output, timeout or lost response stays unknown. Only metadata reconciliation can settle it; never resubmit automatically.' };
}

async function location(options) {
  requireOperator(typeof options.project === 'string', 'PROJECT', 'Select an existing private --project directory.');
  const project = await assertProjectPath(path.resolve(options.project));
  requireOperator((await lstat(project)).isDirectory(), 'PROJECT', 'Project must be an existing directory.');
  return assertProjectPath(path.join(project, '.mcp-operator'));
}
async function recordsAt(dir) {
  let names;
  try { names = await readdir(dir); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  names = names.filter(name => name !== '.provisioning.lock').sort();
  requireOperator(names.length <= 1000 && names.every((name, i) => name === `${String(i + 1).padStart(4, '0')}.json`),
    'JOURNAL', 'Unexpected or missing journal entries. Preserve the directory for investigation.');
  const records = [];
  let previous = null;
  for (const name of names) {
    const record = await readControl(path.join(dir, name), 16384);
    const { contentDigest, ...body } = record;
    requireOperator(Object.keys(body).sort().join(',') === 'createdAt,event,kind,previous,schemaVersion'
      && body.schemaVersion === 1 && body.kind === 'mcp-operator-event'
      && typeof body.createdAt === 'string' && Number.isFinite(Date.parse(body.createdAt))
      && new Date(body.createdAt).toISOString() === body.createdAt
      && Date.parse(body.createdAt) <= Date.now()
      && (!records.length || Date.parse(body.createdAt) >= Date.parse(records.at(-1).createdAt))
      && body.previous === previous && digest(body) === contentDigest,
    'JOURNAL', 'Operator journal integrity differs; do not edit, delete or reseal entries.');
    records.push(record); previous = contentDigest;
  }
  reduce(records);
  return records;
}
async function prepare(options) {
  requireOperator(typeof options.config === 'string', 'INPUT', 'Operator plan/record requires --config.');
  const input = checked(await readControl(path.resolve(options.config), 16384));
  const dir = await location(options), records = await recordsAt(dir);
  requireOperator(records.length < 1000, 'LIMIT', 'Journal capacity reached; preserve it rather than deleting history.');
  const candidate = { contentDigest: 'pending', event: input };
  reduce([...records, candidate]);
  const info = await getLibraryInfo();
  const binding = { dir, input, previous: records.at(-1)?.contentDigest ?? null, buildId: info.contentDigest };
  return { action: 'mcp-operator-record', status: 'planned-local-record-only', journal: dir,
    event: input, sequence: records.length + 1, previous: binding.previous,
    ...(input.action === 'reserve' ? { operationKey: operationKey(input.operation) } : {}),
    approvalToken: `mcp-operator/${digest(binding)}`, executionReadiness: false };
}
async function inWorkspace(options, action) {
  requireOperator(typeof options.workspaceRoot === 'string', 'WORKSPACE', 'Explicit private --workspace-root is required.');
  return withCliWorkspace(options.workspaceRoot, action);
}
export const planOperatorRecord = options => inWorkspace(options, () => prepare(options));
export const operatorStatus = options => inWorkspace(options, async () => {
  const dir = await location(options), records = await recordsAt(dir);
  return { journal: dir, entries: records.length, head: records.at(-1)?.contentDigest ?? null,
    ...reduce(records), integrity: 'unkeyed-chain-not-authentication-or-service-attestation' };
});
export const readOperatorHandover = options => inWorkspace(options, async () => {
  const records = await recordsAt(await location(options));
  return { ...reduce(records), head: records.at(-1)?.contentDigest ?? null,
    recordedAt: records.at(-1)?.createdAt ?? null,
    operationDates: Object.fromEntries(records.filter(r => ['reserve', 'dispatch', 'observe'].includes(r.event.action))
      .map(r => [r.event.action === 'reserve' ? operationKey(r.event.operation) : r.event.operationKey, r.createdAt])),
    milestoneDates: Object.fromEntries(records.filter(r => r.event.action === 'owner-result')
      .map(r => [r.event.milestone, r.createdAt])) };
});
export const writeOperatorRecord = options => inWorkspace(options, async () => {
  const plan = await prepare(options);
  requireOperator(options.approval === plan.approvalToken, 'APPROVAL', 'Exact current local-record approval is required.');
  try { await mkdir(plan.journal, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await assertProjectPath(plan.journal);
  return withControlLock(plan.journal, async () => {
    const current = await prepare(options);
    requireOperator(current.approvalToken === plan.approvalToken, 'STALE', 'Journal or inputs changed; review a new plan.');
    const body = { schemaVersion: 1, kind: 'mcp-operator-event', previous: plan.previous,
      createdAt: new Date().toISOString(), event: plan.event };
    const record = { ...body, contentDigest: digest(body) };
    await writeControl(path.join(plan.journal, `${String(plan.sequence).padStart(4, '0')}.json`), record, { create: true });
    const records = await recordsAt(plan.journal);
    requireOperator(records.at(-1)?.contentDigest === record.contentDigest, 'READBACK', 'Journal readback differs; preserve history.');
    return { status: 'recorded-not-executed', contentDigest: record.contentDigest, ...reduce(records) };
  });
});
