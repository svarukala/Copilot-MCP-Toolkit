import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { readControl } from './mcp-control.js';
import { assertProjectPath } from './config.js';
import { boundedSnapshot, metadataDigest, requireMetadata } from './anonymous-metadata.js';
import { validMcpFailure, mcpFailureGuidance } from './mcp-failure.js';
import { qualificationAction, qualificationKind, validQualificationAssertion, firstCallProfileBinding,
  tavilySearchArguments, isTavilyProject } from './mcp-tavily-qualification.js';
import { readMcpServerProject } from './mcp-lifecycle.js';

const digest = value => metadataDigest(boundedSnapshot(value));
const hash = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const keys = (value, names) => value && Object.keys(value).sort().join(',') === names.sort().join(',');
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(Date.parse(value)).toISOString() === value;
const finished = (intent, failure) => timestamp(intent.startedAt) && timestamp(failure.finishedAt)
  && Date.parse(failure.finishedAt) >= Date.parse(intent.startedAt) && Date.parse(failure.finishedAt) <= Date.now();
async function optional(filename, limit = 1048576) {
  try {
    const value = await readControl(filename, limit);
    requireMetadata(value && typeof value === 'object' && !Array.isArray(value), 'METADATA_MISMATCH');
    return value;
  }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}
function signed(record, field) {
  if (!record || !hash(record[field])) return false;
  const { [field]: expected, ...body } = record;
  return expected === digest(body);
}
function legacyTimeout(record, plans, projectDir) {
  const { intent, failure, proof, dispatch, mapping } = record;
  if (proof || dispatch || mapping
    || !keys(intent, ['schemaVersion', 'approvalDigest', 'action', 'status', 'startedAt', 'reviewDigest', 'operationDigest'])
    || intent.schemaVersion !== 1 || intent.action !== 'standalone-mcp-project-proof' || intent.status !== 'started'
    || !keys(failure, ['schemaVersion', 'status', 'errorCode', 'finishedAt'])
    || failure.schemaVersion !== 1 || failure.status !== 'unknown-no-replay'
    || failure.errorCode !== 'AUTHENTICATION_TIMEOUT' || !finished(intent, failure)) return false;
  return plans.some(plan => {
    if (!keys(plan, ['schemaVersion', 'action', 'projectDir', 'reviewDigest', 'readiness', 'operation', 'approvalDigest'])
      || plan.projectDir !== projectDir || plan.action !== intent.action || plan.schemaVersion !== 1
      || !signed(plan, 'approvalDigest') || !signed(plan.operation, 'approvalDigest')
      || plan.approvalDigest !== intent.approvalDigest || plan.operation.approvalDigest !== intent.operationDigest
      || plan.reviewDigest !== intent.reviewDigest || plan.operation.source?.inbound?.type !== 'entra'
      || plan.operation.action !== 'standalone-mcp-read-only-proof'
      || !timestamp(plan.operation.capture?.capturedAt)
      || Date.parse(plan.operation.capture.capturedAt) > Date.parse(intent.startedAt)) return false;
    const duration = Date.parse(failure.finishedAt) - Date.parse(intent.startedAt);
    // a7ac206 clears the authentication timer before probeMcp; this code cannot describe a dispatched call.
    return plan.operation.discoveryPlan?.authTimeoutMs === 600000 && duration >= 600000 && duration <= 660000;
  });
}
function notDispatched(record) {
  const { intent, failure, proof, dispatch } = record;
  return keys(intent, ['schemaVersion', 'action', 'status', 'startedAt', 'approvalDigest', 'reviewDigest', 'operationDigest',
    'executionVersion', 'previousHistoryDigest', ...(intent.qualification ? ['qualification'] : []),
    ...(intent.acceptanceProfile ? ['acceptanceProfile'] : []), ...(intent.legacyRecoveryPlan ? ['legacyRecoveryPlan'] : [])])
    && intent.schemaVersion === 1 && intent.status === 'started'
    && hash(intent.reviewDigest) && hash(intent.operationDigest)
    && (intent.executionVersion === 2 || intent.executionVersion === 4 && intent.acceptanceProfile
      || intent.action === qualificationAction && intent.executionVersion === 3)
    && hash(intent.previousHistoryDigest) && !proof && !dispatch
    && (validMcpFailure(failure, intent) || keys(failure, ['schemaVersion', 'status', 'errorCode', 'finishedAt', 'intentDigest', 'dispatchContract', 'failureDigest'])
      && failure.schemaVersion === 2 && !intent.qualification)
    && failure.status === 'not-dispatched'
    && failure.dispatchContract === 'write-ahead-tools-call-v1' && failure.intentDigest === digest(intent)
    && /^[A-Z][A-Z_]{1,60}$/.test(failure.errorCode) && finished(intent, failure) && signed(failure, 'failureDigest');
}

export async function readMcpProofHistory(projectDir, legacyPlan, excludeAttempt) {
  const directory = await assertProjectPath(path.join(projectDir, '.mcp-observations'));
  let names;
  try { names = await readdir(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
  requireMetadata(names.length <= 1000, 'LIMIT');
  const records = [];
  for (const name of names.sort()) {
    requireMetadata(/^[0-9a-f-]{36}$/.test(name), 'METADATA_MISMATCH');
    if (name === excludeAttempt) continue;
    const dir = path.join(directory, name), intent = await readControl(path.join(dir, 'intent.json'));
    requireMetadata(intent.schemaVersion === 1 && hash(intent.approvalDigest), 'METADATA_INVALID');
    const qualification = intent.action === qualificationAction;
    if (qualification) {
      requireMetadata(keys(intent, ['schemaVersion', 'action', 'status', 'startedAt', 'approvalDigest', 'reviewDigest',
        'operationDigest', 'executionVersion', 'previousHistoryDigest', 'qualification'])
        && intent.status === 'started' && intent.executionVersion === 3 && timestamp(intent.startedAt)
        && hash(intent.reviewDigest) && hash(intent.operationDigest) && hash(intent.previousHistoryDigest)
        && keys(intent.qualification, ['kind', 'priorAttemptId', 'priorOperationDigest', 'priorEvidenceDigest',
          'sourceDigest', 'captureDigest', 'argumentsDigest']) && intent.qualification.kind === qualificationKind
        && /^[a-f0-9-]{36}$/.test(intent.qualification.priorAttemptId)
        && ['priorOperationDigest', 'priorEvidenceDigest', 'sourceDigest', 'captureDigest', 'argumentsDigest']
          .every(key => hash(intent.qualification[key])), 'METADATA_MISMATCH');
    }
    if (intent.action !== 'standalone-mcp-project-proof' && !qualification) {
      requireMetadata(intent.action === 'standalone-mcp-project-discovery' && intent.executionVersion === undefined, 'METADATA_MISMATCH');
      const failure = await optional(path.join(dir, 'failure.json'), 65536);
      if (failure && failure.schemaVersion !== 1) requireMetadata(validMcpFailure(failure, intent), 'METADATA_MISMATCH');
      records.push({ name, intent, ...(failure?.schemaVersion === 2 ? { failure } : {}) });
      continue;
    }
    const files = await readdir(dir);
    const allowed = qualification ? ['intent.json', 'failure.json', 'qualification.json', 'dispatch.json']
      : ['intent.json', 'failure.json', 'proof.json', 'dispatch.json', 'mapping-readback.json'];
    requireMetadata(files.every(file => allowed.includes(file)), 'METADATA_MISMATCH');
    records.push({ name, intent, failure: await optional(path.join(dir, 'failure.json'), 65536),
      proof: await optional(path.join(dir, qualification ? 'qualification.json' : 'proof.json'), 65536),
      dispatch: await optional(path.join(dir, 'dispatch.json'), 65536),
      mapping: await optional(path.join(dir, 'mapping-readback.json'), 65536) });
  }
  for (const record of records) {
    const { intent, proof, failure, dispatch, mapping } = record;
    if (!Object.hasOwn(intent, 'acceptanceProfile') && intent.executionVersion !== 4) {
      requireMetadata(!proof || !Object.hasOwn(proof, 'acceptanceProfile'), 'METADATA_MISMATCH');
      continue;
    }
    const project = await readMcpServerProject(projectDir);
    requireMetadata(isTavilyProject(project) && intent.reviewDigest === project.review.reviewDigest
      && keys(intent, ['schemaVersion', 'action', 'status', 'startedAt', 'approvalDigest', 'reviewDigest',
        'operationDigest', 'executionVersion', 'previousHistoryDigest', 'acceptanceProfile'])
      && intent.schemaVersion === 1 && intent.action === 'standalone-mcp-project-proof'
      && intent.status === 'started' && intent.executionVersion === 4 && timestamp(intent.startedAt)
      && hash(intent.operationDigest) && hash(intent.previousHistoryDigest)
      && digest(intent.acceptanceProfile) === digest(firstCallProfileBinding())
      && !mapping && (!failure || validMcpFailure(failure, intent)), 'METADATA_MISMATCH');
    if (dispatch) requireMetadata(keys(dispatch, ['schemaVersion', 'kind', 'intentDigest', 'operationDigest', 'preparedAt', 'receiptDigest'])
      && dispatch.schemaVersion === 1 && dispatch.kind === 'standalone-mcp-proof-dispatch'
      && dispatch.intentDigest === digest(intent) && dispatch.operationDigest === intent.operationDigest
      && timestamp(dispatch.preparedAt) && Date.parse(dispatch.preparedAt) >= Date.parse(intent.startedAt)
      && Date.parse(dispatch.preparedAt) <= Date.now() && signed(dispatch, 'receiptDigest'), 'METADATA_MISMATCH');
    if (proof) requireMetadata(keys(proof, ['schemaVersion', 'kind', 'approvalDigest', 'sourceDigest',
      'captureDigest', 'toolName', 'argumentsDigest', 'status', 'acceptanceProfile', 'backendAssertion', 'completedAt',
      'businessCorrectnessVerified', 'coworkRuntimeVerified', 'receiptDigest', ...(proof.errorCode === undefined ? [] : ['errorCode'])])
      && proof.schemaVersion === 1 && proof.kind === 'standalone-mcp-read-only-proof'
      && signed(proof, 'receiptDigest') && proof.approvalDigest === intent.operationDigest
      && digest(proof.acceptanceProfile) === digest(firstCallProfileBinding())
      && proof.sourceDigest === project.review.descriptor.descriptorDigest
      && hash(proof.captureDigest) && proof.argumentsDigest === digest(tavilySearchArguments()) && proof.toolName === 'tavily_search'
      && proof.businessCorrectnessVerified === false && proof.coworkRuntimeVerified === false
      && timestamp(proof.completedAt) && Date.parse(proof.completedAt) >= Date.parse(intent.startedAt)
      && Date.parse(proof.completedAt) <= Date.now() && ['protocol-success', 'tool-error', 'unknown'].includes(proof.status)
      && (proof.status === 'unknown'
        ? keys(proof.backendAssertion, ['kind', 'status']) && proof.backendAssertion.kind === qualificationKind
          && proof.backendAssertion.status === 'not-evaluated' && /^[A-Z_]{2,60}$/.test(proof.errorCode ?? '')
        : proof.errorCode === undefined && validQualificationAssertion(proof.backendAssertion)
          && (proof.status === 'tool-error' ? proof.backendAssertion.predicate === 'tool-error'
            : proof.backendAssertion.predicate !== 'tool-error')), 'METADATA_MISMATCH');
  }
  for (const record of records.filter(record => record.intent.action === qualificationAction)) {
    const q = record.intent.qualification, prior = records.find(item => item.name === q.priorAttemptId);
    requireMetadata(!record.failure || validMcpFailure(record.failure, record.intent), 'METADATA_MISMATCH');
    if (record.dispatch) requireMetadata(keys(record.dispatch, ['schemaVersion', 'kind', 'intentDigest',
      'operationDigest', 'preparedAt', 'receiptDigest']) && record.dispatch.schemaVersion === 1
      && record.dispatch.kind === 'standalone-mcp-proof-dispatch'
      && record.dispatch.intentDigest === digest(record.intent) && record.dispatch.operationDigest === record.intent.operationDigest
      && timestamp(record.dispatch.preparedAt) && Date.parse(record.dispatch.preparedAt) >= Date.parse(record.intent.startedAt)
      && Date.parse(record.dispatch.preparedAt) <= Date.now() && signed(record.dispatch, 'receiptDigest'), 'METADATA_MISMATCH');
    requireMetadata(prior?.intent.action === 'standalone-mcp-project-proof' && !prior.intent.acceptanceProfile
      && digest(prior) === q.priorEvidenceDigest && prior.intent.operationDigest === q.priorOperationDigest
      && !prior.failure && signed(prior.proof, 'receiptDigest') && prior.proof.status === 'protocol-success'
      && prior.proof.sourceDigest === q.sourceDigest && prior.proof.captureDigest === q.captureDigest
      && prior.proof.argumentsDigest === q.argumentsDigest && prior.proof.toolName === 'tavily_search', 'METADATA_MISMATCH');
    if (record.proof) requireMetadata(keys(record.proof, ['schemaVersion', 'kind', 'approvalDigest', 'sourceDigest',
      'captureDigest', 'toolName', 'argumentsDigest', 'status', 'backendAssertion', 'completedAt',
      'businessCorrectnessVerified', 'coworkRuntimeVerified', 'receiptDigest', ...(record.proof.errorCode === undefined ? [] : ['errorCode'])])
      && record.proof.schemaVersion === 1 && record.proof.kind === 'standalone-mcp-search-qualification'
      && signed(record.proof, 'receiptDigest') && record.proof.approvalDigest === record.intent.operationDigest
      && record.proof.sourceDigest === q.sourceDigest && record.proof.captureDigest === q.captureDigest
      && record.proof.argumentsDigest === q.argumentsDigest && record.proof.toolName === 'tavily_search'
      && record.proof.businessCorrectnessVerified === false && record.proof.coworkRuntimeVerified === false
      && timestamp(record.proof.completedAt) && Date.parse(record.proof.completedAt) >= Date.parse(record.intent.startedAt)
      && Date.parse(record.proof.completedAt) <= Date.now()
      && ['protocol-success', 'tool-error', 'unknown'].includes(record.proof.status)
      && (record.proof.status === 'unknown'
        ? keys(record.proof.backendAssertion, ['kind', 'status']) && record.proof.backendAssertion.kind === qualificationKind
          && record.proof.backendAssertion.status === 'not-evaluated' && /^[A-Z_]{2,60}$/.test(record.proof.errorCode ?? '')
        : record.proof.errorCode === undefined && validQualificationAssertion(record.proof.backendAssertion)), 'METADATA_MISMATCH');
  }
  const legacyPlans = [legacyPlan, ...records.filter(record => record.intent.executionVersion === 2)
    .map(record => record.intent.legacyRecoveryPlan).filter(Boolean)];
  const attempts = records.map(record => {
    const { name, intent, proof, failure, dispatch } = record;
    let status = 'not-proof', evidence;
    const qualification = intent.action === qualificationAction;
    if (intent.action === 'standalone-mcp-project-proof' || qualification) {
      status = 'unresolved';
      if (proof && !failure && proof.schemaVersion === 1 && proof.kind === (qualification ? 'standalone-mcp-search-qualification' : 'standalone-mcp-read-only-proof')
        && proof.approvalDigest === intent.operationDigest && signed(proof, 'receiptDigest')
        && ['protocol-success', 'tool-error'].includes(proof.status)
        && (intent.executionVersion === undefined || (intent.executionVersion === 2 || intent.executionVersion === 4
          || qualification && intent.executionVersion === 3)
          && keys(dispatch, ['schemaVersion', 'kind', 'intentDigest', 'operationDigest', 'preparedAt', 'receiptDigest'])
          && dispatch.schemaVersion === 1 && dispatch.kind === 'standalone-mcp-proof-dispatch'
          && timestamp(dispatch.preparedAt) && dispatch.intentDigest === digest(intent)
          && dispatch.operationDigest === intent.operationDigest && signed(dispatch, 'receiptDigest'))) status = 'completed';
      else if (notDispatched(record)) { status = 'not-dispatched'; evidence = 'write-ahead-dispatch-contract'; }
      else if (legacyTimeout(record, legacyPlans, projectDir)) { status = 'not-dispatched'; evidence = 'legacy-authentication-timeout'; }
    }
    return { attemptId: name, status, ...(evidence ? { evidence } : {}),
      ...(status === 'completed' && proof.resultAssertion ? { assertedProof: {
        sourceDigest: proof.sourceDigest, toolName: proof.toolName, argumentsDigest: proof.argumentsDigest,
      } } : {}),
      ...(!qualification && status === 'completed' && proof.toolName === 'tavily_search'
        ? { tavilySearchSourceDigest: proof.sourceDigest } : {}),
      ...(qualification ? { qualification: intent.qualification, ...(proof ? { backendAssertion: proof.backendAssertion } : {}) } : {}),
      ...(intent.acceptanceProfile ? { acceptanceProfile: intent.acceptanceProfile,
        ...(proof ? { backendAssertion: proof.backendAssertion } : {}) } : {}),
      approvalDigest: intent.approvalDigest, operationDigest: intent.operationDigest ?? null,
      ...(evidence ? { failureCode: failure.errorCode, startedAt: intent.startedAt, finishedAt: failure.finishedAt } : {}),
      ...(validMcpFailure(failure, intent) ? { failureCode: failure.errorCode,
        failureStatus: failure.status, ...(failure.diagnostics ? { diagnostics: failure.diagnostics,
          next: mcpFailureGuidance(failure.diagnostics, failure.status) } : {}) } : {}),
      filesDigest: digest(record) };
  });
  return boundedSnapshot({ contractVersion: 1, historyDigest: digest(records), attempts,
    limitations: ['Only a proven not-dispatched attempt permits a separately reviewed, user-directed restart. No automatic login or tool retry.',
      'Legacy authentication-timeout recovery requires the exact original Entra proof plan and closed pre-MCP timeout contract; edited, missing or conflicting evidence remains blocked.'] });
}

export function assertMcpProofHistory(history, approvalDigest, operationDigest, operation, protectTavilySearch = false) {
  requireMetadata(!history.attempts.some(item => item.status === 'unresolved'), 'PROOF_OUTCOME_UNRESOLVED');
  requireMetadata(!history.attempts.some(item => item.status === 'completed'
    && (item.approvalDigest === approvalDigest || item.operationDigest === operationDigest)), 'PROOF_REPLAY_BLOCKED');
  requireMetadata(!operation || !history.attempts.some(item => item.assertedProof
    && item.assertedProof.sourceDigest === operation.source.descriptorDigest
    && item.assertedProof.toolName === operation.tool.name
    && item.assertedProof.argumentsDigest === digest(operation.arguments)), 'PROOF_REPLAY_BLOCKED');
  requireMetadata(!history.attempts.some(item => item.qualification && item.status === 'completed'
    && (operation?.qualification || operation?.tool.name === 'tavily_search'
      && operation.source.descriptorDigest === item.qualification.sourceDigest)), 'QUALIFICATION_CONSUMED');
  requireMetadata(!protectTavilySearch || operation?.qualification || operation?.tool.name !== 'tavily_search'
    || !history.attempts.some(item => item.status === 'completed'
      && item.tavilySearchSourceDigest === operation.source.descriptorDigest), 'PROOF_REPLAY_BLOCKED');
}
