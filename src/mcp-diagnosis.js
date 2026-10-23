import path from 'node:path';
import { createHash } from 'node:crypto';
import { readMcpEvidenceInventory, screenMcpEvidenceBytes } from './mcp-evidence.js';
import { prepareMcpServerDefinition } from './mcp-server.js';
import { readMcpProofHistory } from './mcp-proof-history.js';
import { readMcpAuthRejections, readMcpBackendRejections } from './mcp-auth-rejection.js';
import { mcpCaptureFreshness } from './mcp-discovery.js';
import { validMcpFailure, mcpFailureDiagnostics } from './mcp-failure.js';
import { validateAzureAccountTarget } from './azure-identity.js';
import { recoveryBarrier } from './mcp-recovery.js';
import { readControl } from './mcp-control.js';
import { boundedSnapshot, metadataDigest, requireMetadata } from './anonymous-metadata.js';
import { inspectionBudget } from './inspection-budget.js';
import { sanitizeProvisioningErrorCode } from './azure.js';
import { isTavilyProject, requireTavilyArguments } from './mcp-tavily-qualification.js';
import { normalizeDeploymentOperationDiagnostic } from './deployment-diagnostic.js';

const digest = value => metadataDigest(boundedSnapshot(value));
const hash = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value && Date.parse(value) <= Date.now();
const phases = ['foundation', 'finalize', 'gateway'];
const steps = ['check-account', 'check-new-resources', 'check-group', 'check-service', 'check-vault',
  'check-diagnostics', 'check-shared-policy', 'check-default-deny', 'check-api-collisions',
  'check-named-value-collisions', 'snapshot-unrelated-policies', 'check-proxy-backends', 'check-proxy-grant',
  'verify-owned-apis', 'verify-preservation', 'deploy-foundation', 'deploy-gateway', 'create-group'];
const stageFor = value => steps.includes(value) ? value
  : typeof value === 'string' && /^check-app-[a-z0-9-]{1,80}$/.test(value) ? 'check-app'
    : typeof value === 'string' && /^check-backend-[a-z0-9-]{1,80}$/.test(value) ? 'check-backend' : 'unknown';
const codes = new Set(['AUTHENTICATION_TIMEOUT', 'AUTHENTICATION_FAILED', 'AUTHENTICATION_REJECTED',
  'ABORTED', 'AUTH_CONFIG_INVALID', 'APIM_PROOF_MAPPING_MISMATCH', 'ACCEPTANCE_PROFILE_UNSUPPORTED',
  'ACCEPTANCE_ARGUMENTS_INVALID', 'QUALIFICATION_UNSUPPORTED', 'PROOF_CAPTURE_INVALID',
  'METADATA_INVALID', 'METADATA_MISMATCH', 'METADATA_STALE', 'MCP_CONFIGURATION_INVALID',
  'MCP_CONFIGURATION_STALE', 'MCP_CONFIGURATION_REQUIRED', 'AZURE_IDENTITY_REQUIRED',
  'AZURE_INSPECTION_COMMAND_TIMEOUT', 'AZURE_INSPECTION_TIMEOUT', 'AZURE_CLI_ABORTED',
  'AZURE_CLI_TERMINATION_UNCONFIRMED', 'PROOF_REPLAY_BLOCKED', 'QUALIFICATION_CONSUMED',
  'PROOF_OUTCOME_UNRESOLVED', 'MCP_NETWORK_LOCKED', 'PROVISIONING_LOCKED']);
const safeCode = code => codes.has(code) || sanitizeProvisioningErrorCode(code) ? code : 'UNCLASSIFIED_FAILURE';
const invalidCodes = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'LIMIT', 'INVALID_CONFIG',
  'CONTROL_VALIDATION', 'METADATA_INVALID', 'METADATA_MISMATCH', 'METADATA_STALE',
  'SENSITIVE_INPUT', 'MCP_DEFINITION_INVALID', 'AZURE_IDENTITY_REQUIRED', 'QUALIFICATION_UNSUPPORTED',
  'ACCEPTANCE_PROFILE_UNSUPPORTED', 'ACCEPTANCE_ARGUMENTS_INVALID', 'MCP_ARCHIVE_SENSITIVE_OR_BINARY',
  'MCP_ARCHIVE_FILE_BOUNDARY', 'MCP_ARCHIVE_PATH_ALIAS', 'MCP_ARCHIVE_LIMIT', 'MCP_ARCHIVE_PROJECT_REQUIRED',
  'MCP_ARCHIVE_CHANGED', 'MCP_RECOVERY_INCOMPLETE', 'MCP_RECOVERY_INVALID',
  'MCP_RECOVERY_REVIEW_REQUIRED', 'MCP_RECOVERY_IDENTITY_REQUIRED']);
const advice = {
  preserve: 'Preserve evidence and locks. No automatic retry, unlock, timestamp repair, capture replacement or replay.',
  transport: 'A recorded timeout/transport failure does not establish network root cause, permission denial or resource drift. Inspect retained stages before another sign-in.',
  repeated: 'Stop repeating equivalent full reads. Export with mcp-export-plan, retain the archive hash separately, and review an alternate execution environment with the operator. Recovery and fresh identity/inspection each require their own exact approval.',
  inspection: 'If still appropriate, review a NEW mcp-reconcile-plan (with --experimental-configuration for v3), then its exact approved read-only execution. Never replay the gateway. A diagnostic read is not readiness.',
  authentication: 'Azure account selection and MCP runtime authentication are separate. Review the indicated identity with its owner; generic auth, HTTP or timeout failures do not prove consent/RBAC denial. Do not grant permissions or repeat a sent call to diagnose sign-in.',
  consumed: 'This retained call purpose is consumed, including failed or inconclusive results. Read its evidence; do not substitute captures or rerun calls or negative matrices.',
  unknown: 'Dispatch/outcome is unresolved. Preserve journals and locks for operator reconciliation. Fresh configuration inspection cannot authorize tool replay.',
  invalid: 'Retained evidence is missing, invalid, changed or unsupported. Preserve it; obtain operator review. No successful default or migration is inferred.',
};

export function classifyMcpDiagnostic(code, diagnostics, domain = 'mcp') {
  code = safeCode(code);
  const detail = mcpFailureDiagnostics(diagnostics);
  const cause = safeCode(detail?.causeCode ?? code);
  const management = domain === 'azure-management' || !!detail?.proofStage;
  const errorClass = ['AZURE_INSPECTION_COMMAND_TIMEOUT', 'AZURE_INSPECTION_TIMEOUT'].includes(cause)
    ? 'azure-management-timeout'
    : cause === 'AZURE_CLI_TRANSIENT_TRANSPORT' ? 'azure-management-transport'
    : cause === 'AZURE_CLI_CERTIFICATE_FAILED' ? 'certificate-validation'
    : cause === 'AZURE_PERMISSION_DENIED' ? 'recorded-authorization-denial'
    : ['ACCEPTANCE_PROFILE_UNSUPPORTED', 'QUALIFICATION_UNSUPPORTED'].includes(code) ? 'unsupported-profile'
    : ['AUTHENTICATION_TIMEOUT', 'AUTHENTICATION_FAILED'].includes(code) && detail?.authStage !== 'metadata'
      ? ['transport', 'timeout'].includes(detail?.failureKind) || code === 'AUTHENTICATION_TIMEOUT'
        ? 'mcp-auth-transient' : 'mcp-auth-unclassified'
    : code === 'AUTHENTICATION_REJECTED' ? 'mcp-identity-rejected'
    : ['AZURE_IDENTITY_REQUIRED', 'AZURE_CLI_AUTHENTICATION_FAILED', 'AZURE_CLI_MFA_REQUIRED'].includes(cause) ? 'azure-identity'
    : ['PROOF_REPLAY_BLOCKED', 'QUALIFICATION_CONSUMED'].includes(code) ? 'consumed'
    : code === 'PROOF_OUTCOME_UNRESOLVED' ? 'unresolved-dispatch'
    : ['AZURE_CLI_ABORTED', 'ABORTED'].includes(cause) || detail?.rpcStage === 'cancelled' ? 'cancelled'
    : cause === 'AZURE_CLI_TERMINATION_UNCONFIRMED' ? 'unresolved-process'
    : ['METADATA_INVALID', 'METADATA_MISMATCH', 'METADATA_STALE', 'PROOF_CAPTURE_INVALID',
      'AUTH_CONFIG_INVALID', 'MCP_CONFIGURATION_INVALID', 'ACCEPTANCE_ARGUMENTS_INVALID'].includes(code) ? 'invalid-evidence'
    : detail?.rpcMethod || detail?.authStage === 'metadata' ? 'mcp-protocol'
    : management ? 'azure-management-unclassified' : 'unclassified';
  return { code, errorClass, stage: detail?.proofStage ?? detail?.authStage ?? detail?.rpcStage ?? 'unknown',
    detail: detail ?? null };
}
function snapshotDigest(snapshot) {
  return digest({ directories: snapshot.directories, locks: snapshot.locks, excluded: snapshot.excluded,
    files: Object.entries(snapshot.files).map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]) });
}
function parsed(bytes) {
  requireMetadata(bytes, 'ENOENT');
  const value = JSON.parse(bytes.toString('utf8'));
  boundedSnapshot(value);
  return value;
}
function signed(value, field, canonical = true) {
  if (!value || typeof value !== 'object') return false;
  const { [field]: expected, ...body } = value;
  return expected === (canonical ? digest(body) : metadataDigest(body));
}

export async function readMcpDiagnosis(projectDir, { config } = {}) {
  const report = { schemaVersion: 1, action: 'standalone-mcp-diagnosis', status: 'local-evidence-only',
    executionReadiness: false, replayAuthorized: false, networkCalls: 0, subprocesses: 0, authenticationCacheRead: false,
    layers: {}, failures: [], barriers: [], deadlines: [],
    next: { command: null, approval: null, userReviewRequired: true, network: 'none',
      authentication: 'not-requested', execution: 'blocked-until-project-evidence-is-available' },
    budget: { automaticRetries: 0, fullInspectionRetries: 0, repeatedFailureAdvisoryThreshold: 2,
      maximumEntries: 512, maximumPayloadBytes: 33554432, maximumFailureGroups: 64,
      currentInspectionContract: inspectionBudget, actualHistoricalRetryCount: null,
      nextExecutionBudget: 'unknown-until-fresh-phase-plan' },
    guidance: [advice.preserve],
    limitations: ['Retained evidence only, not live health or execution authority. No auth cache, log, environment or process scan.',
      'Failure counts are distinct retained records, not consecutive attempts or internal transport retries; unrecorded failures are unknowable.',
      'Recorded configuration freshness does not validate current session or full readiness. Use existing strict status/resume and freshly approved phases.',
      'No host approval-delivery diagnosis. Cowork, business correctness and independent rejection findings remain separate.'] };
  const groups = new Map(), seen = new Set();
  const add = (phase, key, code, diagnostics, extra = {}) => {
    const classification = classifyMcpDiagnostic(code, diagnostics, phase.startsWith('azure-') ? 'azure-management' : 'mcp');
    const { recordKey, ...fields } = extra;
    if (recordKey && seen.has(recordKey)) return;
    if (recordKey) seen.add(recordKey);
    const groupKey = digest({ phase, key, classification, stage: fields.stage ?? classification.stage,
      operation: fields.operation ?? null,
      unknownCodeDigest: classification.code === 'UNCLASSIFIED_FAILURE' ? digest(code ?? null) : null });
    const found = groups.get(groupKey);
    if (found) {
      found.equivalentFailures++;
      const recorded = fields.recordedAt ?? fields.finishedAt, previous = found.recordedAt ?? found.finishedAt;
      if (recorded && (!previous || recorded > previous)) Object.assign(found, fields);
    } else {
      requireMetadata(groups.size < 64, 'LIMIT');
      groups.set(groupKey, { phase, ...classification, elapsedMs: null, finishedAt: null,
        recordedAt: null, elapsedScope: null, recordedBudget: null, ...fields, equivalentFailures: 1 });
    }
  };
  const blocked = (layer, error) => {
    const code = error instanceof SyntaxError ? 'INVALID_JSON'
      : invalidCodes.has(error.code) ? error.code : null;
    if (!code) throw Object.assign(new Error('Local diagnosis could not complete; raw error content is suppressed. Preserve evidence for operator review.'),
      { code: 'MCP_DIAGNOSIS_UNAVAILABLE', cause: error });
    report.layers[layer] = { status: 'blocked', code };
    report.barriers.push('invalid-or-missing-evidence');
    report.guidance.push(advice.invalid);
  };
  let snapshot;
  const notCachePath = filename => requireMetadata(!path.resolve(filename).split(/[\\/]/)
    .some(part => ['.azure-auth', '.azure'].includes(part.toLowerCase())), 'INVALID_CONFIG');
  try { notCachePath(projectDir); snapshot = await readMcpEvidenceInventory(projectDir); }
  catch (error) { blocked('inventory', error); report.status = 'attention-required'; return report; }
  const originalDigest = snapshotDigest(snapshot), files = snapshot.files, dir = snapshot.dir;
  report.barriers.push(...snapshot.locks);
  if (snapshot.excluded.unsupportedHistory) report.barriers.push('unsupported-history');
  if (snapshot.excluded.incompleteRecovery) report.barriers.push('incomplete-recovery');
  const read = name => parsed(files[name]);
  let review, lifecycle;
  try {
    review = await prepareMcpServerDefinition(read('mcp-definition.json'));
    requireMetadata(Object.entries(review.files).every(([name, text]) => files[name]?.equals(Buffer.from(text))), 'METADATA_MISMATCH');
    report.layers.project = { status: 'generated-bytes-verified' };
    lifecycle = Object.keys(files).filter(name => name.startsWith('.mcp-lifecycle/')).map(read);
    requireMetadata(lifecycle.every(r => r.schemaVersion === 1 && r.reviewDigest === review.reviewDigest
      && phases.includes(r.phase) && ['started', 'completed', 'failed-uncertain', 'reconciled'].includes(r.status)
      && timestamp(r.startedAt) && (r.finishedAt === undefined || timestamp(r.finishedAt)
        && Date.parse(r.finishedAt) >= Date.parse(r.startedAt))), 'METADATA_MISMATCH');
    report.layers.lifecycle = { completed: lifecycle.filter(r => r.status === 'completed').length,
      reconciled: lifecycle.filter(r => r.status === 'reconciled').length,
      unresolved: lifecycle.filter(r => ['started', 'failed-uncertain'].includes(r.status)).length };
    if (report.layers.lifecycle.unresolved) report.barriers.push('unresolved-lifecycle');
    for (const r of lifecycle.filter(r => r.blocked || r.status === 'failed-uncertain')) {
      add(`azure-${r.phase}`, review.reviewDigest, r.blocked?.code, undefined, {
        stage: stageFor(r.failedStep), finishedAt: r.finishedAt ?? null,
        elapsedMs: r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.startedAt) : null,
        elapsedScope: r.finishedAt ? 'whole-attempt-wall-clock' : null,
        recordKey: digest(r), dispatch: 'not-established' });
    }
  } catch (error) { blocked('project', error); }
  if (review && lifecycle) {
    try {
      const identity = files['.azure-identity.json'] ? read('.azure-identity.json') : null;
      if (identity) {
        requireMetadata(identity.schemaVersion === 1 && ['selected', 'pending'].includes(identity.status)
          && /^[a-f0-9-]{36}$/i.test(identity.epoch), 'AZURE_IDENTITY_REQUIRED');
        const target = validateAzureAccountTarget(identity.target);
        requireMetadata(!review.input.azure || target.tenantId === review.input.azure.tenantId.toLowerCase()
          && target.subscriptionId === review.input.azure.subscriptionId.toLowerCase(), 'AZURE_IDENTITY_REQUIRED');
      }
      const barrier = await recoveryBarrier(dir, { identityEpoch: identity?.epoch });
      if (barrier) report.barriers.push(barrier);
      const managed = review.descriptor.kind !== 'existing-mcp';
      report.layers.identity = { status: !managed ? 'not-required-for-reference' : !identity ? 'missing'
        : barrier ? 'recovery-blocked' : identity.status === 'pending' ? 'pending-not-authenticated'
          : 'selection-retained-session-not-checked', currentAuthenticationVerified: false };
      if (managed && (!identity || identity.status !== 'selected')) report.barriers.push('identity-required');
    } catch (error) { blocked('identity', error); }
    try {
      const records = Object.keys(files).filter(name => /^reconcile-[a-f0-9-]{36}\.json$/.test(name)).map(read);
      let failed = 0, completed = 0;
      for (const r of records) {
        const p = r.plan, result = r.result;
        requireMetadata(p?.action === 'mcp-reconcile' && p.reviewDigest === review.reviewDigest
          && p.projectDir === dir && p.inspection?.inspectOnly === true && phases.includes(p.inspection.phase)
          && hash(p.historyDigest) && hash(p.receiptDigest) && timestamp(r.observedAt) && result, 'METADATA_MISMATCH');
        const { approvalToken, ...body } = p;
        requireMetadata(approvalToken === `mcp-reconcile/${p.experimentalConfiguration ? digest(body) : metadataDigest(body)}`
          && Array.isArray(p.inspection.steps), 'METADATA_MISMATCH');
        const target = validateAzureAccountTarget(p.inspection.azureIdentity?.target);
        requireMetadata(review.input.azure && target.tenantId === review.input.azure.tenantId.toLowerCase()
          && target.subscriptionId === review.input.azure.subscriptionId.toLowerCase(), 'METADATA_MISMATCH');
        if (r.reportDigest) requireMetadata(signed(r, 'reportDigest'), 'METADATA_MISMATCH');
        if (result.status !== 'failed') {
          requireMetadata(['inspected-not-deployed', 'configuration-observed-not-runtime-tested'].includes(result.status), 'METADATA_MISMATCH');
          completed++; continue;
        }
        requireMetadata(result.phase === p.inspection.phase && result.approved === true
          && p.inspection.steps.some(s => s.kind === 'command' && s.id === result.failedStep), 'METADATA_MISMATCH');
        const budget = p.inspection.inspectionBudget;
        if (budget) requireMetadata(digest(budget) === digest(inspectionBudget), 'METADATA_MISMATCH');
        const operation = normalizeDeploymentOperationDiagnostic(result.operationDiagnostic);
        requireMetadata(result.operationDiagnostic === undefined || operation?.phase === p.inspection.phase, 'METADATA_MISMATCH');
        failed++;
        add(`azure-inspection-${p.inspection.phase}`, digest({ review: p.reviewDigest,
          identity: p.inspection.azureIdentity?.target ?? null, step: result.failedStep,
          experimental: p.experimentalConfiguration === true }), result.errorCode, undefined, {
          stage: stageFor(result.failedStep), operation: operation ?? null,
          recordedAt: r.observedAt, recordedBudget: budget ?? null,
          recordKey: digest(r), dispatch: 'not-applicable-to-tool-dispatch' });
      }
      report.layers.inspection = { failed, completed, authority: 'historical-plan-bound-not-readiness' };
    } catch (error) { blocked('inspection', error); }
    try {
      const c = files['.mcp-configuration.json'] ? read('.mcp-configuration.json') : null;
      if (!c) report.layers.configuration = { status: 'not-recorded' };
      else if (c.status === 'inspection-started') {
        requireMetadata(c.schemaVersion === 1 && c.kind === 'experimental-configuration-v1' && timestamp(c.startedAt), 'METADATA_MISMATCH');
        report.layers.configuration = { status: 'inspection-started-outcome-not-established' };
        report.barriers.push('configuration-not-current');
      } else {
        requireMetadata(signed(c, 'evidenceDigest') && c.schemaVersion === 1 && c.kind === 'experimental-configuration-v1'
          && c.projectDir === dir && c.reviewDigest === review.reviewDigest
          && c.definitionDigest === review.descriptor.definitionDigest && c.descriptorDigest === review.descriptor.descriptorDigest
          && c.historyDigest === digest(lifecycle) && c.receiptDigest === digest(read('infra/provisioning-receipt.json'))
          && timestamp(c.observedAt) && typeof c.expiresAt === 'string'
          && new Date(Date.parse(c.observedAt) + 900000).toISOString() === c.expiresAt
          && /^reconcile-[a-f0-9-]{36}\.json$/.test(c.reportFile), 'METADATA_MISMATCH');
        const r = read(c.reportFile);
        requireMetadata(signed(r, 'reportDigest') && r.reportDigest === c.reportDigest
          && r.observedAt === c.observedAt, 'METADATA_MISMATCH');
        report.layers.configuration = { status: Date.parse(c.expiresAt) <= Date.now() ? 'expired' : 'recorded-unexpired',
          currentSessionBindingChecked: false };
        report.deadlines.push({ kind: 'configuration', expiresAt: c.expiresAt, remainingMs: Math.max(0, Date.parse(c.expiresAt) - Date.now()) });
      }
    } catch (error) { blocked('configuration', error); }
    try {
      const history = await readMcpProofHistory(dir);
      const calls = { completed: 0, unresolved: 0, notDispatched: 0, protocolSuccess: 0, toolError: 0,
        assertions: [], businessCorrectnessVerified: false }, captures = { unexpired: 0, expired: 0 };
      for (const a of history.attempts) {
        const folder = `.mcp-observations/${a.attemptId}`, intent = read(`${folder}/intent.json`);
        requireMetadata(intent.reviewDigest === review.reviewDigest && hash(intent.operationDigest), 'METADATA_MISMATCH');
        const phase = a.qualification ? 'qualification' : a.status === 'not-proof' ? 'discovery' : 'proof';
        if (phase !== 'discovery') {
          if (a.status === 'completed') {
            calls.completed++;
            const proof = read(`${folder}/${a.qualification ? 'qualification' : 'proof'}.json`);
            requireMetadata(signed(proof, 'receiptDigest') && ['protocol-success', 'tool-error'].includes(proof.status), 'METADATA_MISMATCH');
            calls[proof.status === 'tool-error' ? 'toolError' : 'protocolSuccess']++;
          }
          else if (a.status === 'unresolved') calls.unresolved++;
          else calls.notDispatched++;
          if (a.backendAssertion) {
            const assertion = a.backendAssertion;
            calls.assertions.push({ kind: assertion.kind, status: assertion.status, historicalOnly: true });
          }
        }
        const failure = files[`${folder}/failure.json`] ? read(`${folder}/failure.json`) : null;
        if (failure && validMcpFailure(failure, intent)) {
          add(phase, intent.operationDigest, failure.errorCode, failure.diagnostics, {
            elapsedMs: Date.parse(failure.finishedAt) - Date.parse(intent.startedAt), finishedAt: failure.finishedAt,
            elapsedScope: 'whole-attempt-wall-clock',
            recordKey: digest({ intent, failure }),
            dispatch: phase === 'discovery' ? 'no-tool-call' : a.status === 'not-dispatched' ? 'not-dispatched' : 'unknown-no-replay' });
        } else if (failure) report.barriers.push('legacy-or-invalid-failure');
        if (files[`${folder}/capture.json`]) {
          const c = read(`${folder}/capture.json`), freshness = mcpCaptureFreshness(c);
          requireMetadata(c.source.descriptorDigest === review.descriptor.descriptorDigest, 'METADATA_MISMATCH');
          captures[freshness.status === 'stale' ? 'expired' : 'unexpired']++;
          report.deadlines.push({ kind: 'capture', expiresAt: freshness.expiresAt, remainingMs: Math.max(0, Date.parse(freshness.expiresAt) - Date.now()) });
        } else if (phase === 'discovery' && !failure) report.barriers.push('unresolved-discovery');
      }
      report.layers.calls = calls; report.layers.captures = captures;
      if (calls.completed) report.guidance.push(advice.consumed);
      if (calls.unresolved) report.barriers.push('unresolved-dispatch');
    } catch (error) { blocked('observations', error); }
    for (const [name, reader] of [['callerRejection', readMcpAuthRejections], ['backendRejection', readMcpBackendRejections]]) {
      try {
        const history = await reader(dir);
        report.layers[name] = { historicalOnly: true, consumed: history.attempts.length,
          outcomes: history.attempts.map(a => a.status) };
        const folder = name === 'callerRejection' ? '.mcp-auth-rejections' : '.mcp-backend-rejections';
        if (history.attempts.some(a => !files[`${folder}/${a.attemptId}/result.json`])) report.barriers.push('unresolved-rejection');
        if (history.attempts.length) report.guidance.push(advice.consumed);
      } catch (error) { blocked(name, error); }
    }
    if (config !== undefined) {
      try {
        notCachePath(config);
        const selection = await readControl(path.resolve(config), 65536);
        requireMetadata(selection && typeof selection === 'object' && !Array.isArray(selection), 'INVALID_CONFIG');
        screenMcpEvidenceBytes(Buffer.from(JSON.stringify(selection)));
        if (Object.hasOwn(selection, 'acceptanceProfile')) {
          requireMetadata(selection.acceptanceProfile === 'tavily-search-result-v1'
            && isTavilyProject({ review }), 'ACCEPTANCE_PROFILE_UNSUPPORTED');
          requireTavilyArguments(selection, 'ACCEPTANCE_ARGUMENTS_INVALID');
        }
        report.layers.selection = { status: 'profile-subset-checked-not-a-plan' };
      } catch (error) { blocked('selection', error); }
    }
  }
  report.failures = [...groups.values()];
  if (report.failures.some(f => ['azure-management-timeout', 'azure-management-transport', 'certificate-validation'].includes(f.errorClass))) {
    report.guidance.push(advice.transport, advice.inspection);
  }
  if (report.failures.some(f => f.equivalentFailures >= 2
    && (['azure-management-timeout', 'azure-management-transport', 'mcp-auth-transient'].includes(f.errorClass)
      || f.errorClass === 'mcp-protocol' && ['transport', 'timeout'].includes(f.detail?.rpcStage ?? f.detail?.failureKind)))) report.guidance.push(advice.repeated);
  if (report.failures.some(f => /auth|identity/.test(f.errorClass))) report.guidance.push(advice.authentication);
  if (report.failures.some(f => f.errorClass === 'mcp-protocol')) report.guidance.push(
    'Ask the endpoint owner to inspect the recorded MCP stage using existing server-side evidence. A response or token alone is not valid MCP initialization or tools metadata; do not repeat sign-in merely to diagnose protocol processing.');
  if (report.failures.some(f => f.errorClass === 'recorded-authorization-denial')) report.guidance.push(
    'A retained allowlisted authorization-denial class exists. Ask the resource owner to review the exact approved action/scope. Do not infer broad roles, application permissions or consent.');
  if (report.barriers.some(b => /unresolved|lock|RECOVERY/.test(b))) report.guidance.push(advice.unknown);
  report.next = { command: 'mcp-resume', approval: null, userReviewRequired: true,
    authentication: report.barriers.includes('identity-required') ? 'fresh-private-account-selection-required'
      : report.layers.identity?.status === 'blocked' ? 'identity-review-required-no-ambient-fallback'
      : review?.descriptor.inbound.type === 'anonymous' && review.descriptor.kind === 'existing-mcp'
        ? 'not-required-for-anonymous-mcp' : 'unknown-until-reviewed-phase',
    network: 'none-for-diagnosis-or-local-plan',
    freshInspection: { planCommand: review?.descriptor.kind !== 'existing-mcp'
        && (review?.input.schemaVersion === 3 || report.layers.lifecycle?.unresolved > 0) ? 'mcp-reconcile-plan' : null,
      flags: review?.input.schemaVersion === 3 ? ['--experimental-configuration'] : [],
      applicability: 'existing-phase-planner-must-confirm', requiresNetworkForExecution: true,
      requiresNewExactApproval: true, currentIdentityRevalidationRequired: true },
    execution: 'blocked-until-existing-guards-and-new-exact-approval',
    exportPlanCommand: 'mcp-export-plan' };
  report.barriers = [...new Set(report.barriers)]; report.guidance = [...new Set(report.guidance)];
  try { requireMetadata(originalDigest === snapshotDigest(await readMcpEvidenceInventory(dir)), 'METADATA_MISMATCH'); }
  catch (error) { blocked('concurrentState', error); }
  if (report.barriers.length || report.failures.length || report.deadlines.some(d => d.remainingMs === 0)) report.status = 'attention-required';
  return boundedSnapshot(report);
}
