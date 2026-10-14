import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { assertProjectPath } from './config.js';
import { readMcpStatus } from './mcp-status.js';
import { readMcpServerProject, readMcpLifecycleAttempts, planMcpServerAccount,
  planMcpServerProvision, planMcpServerReconcile } from './mcp-lifecycle.js';
import { readAzureIdentity } from './azure-identity.js';
import { mcpRuntimeConfig } from './mcp-server.js';
import { readControl } from './mcp-control.js';
import { planMcpProjectDiscovery, planMcpProjectProof, planMcpProjectQualification } from './mcp-discovery-project.js';
import { assertMcpProofHistory } from './mcp-proof-history.js';
import { planMcpAuthRejection, planMcpBackendRejection } from './mcp-auth-rejection.js';
import { isTavilyProject } from './mcp-tavily-qualification.js';
import { requireMetadata, metadataDigest, boundedSnapshot } from './anonymous-metadata.js';
import { recoveryBarrier, persistenceGuidance } from './mcp-recovery.js';

export const resumePhases = ['discovery', 'proof', 'qualification', 'caller-rejection', 'backend-rejection', 'configuration'];
const guidance = {
  locks: 'An active or interrupted lock exists. Confirm the owned process has stopped; preserve locks and journals for supported operator recovery. No automatic unlock or replay.',
  unknown: 'An unresolved dispatch or interrupted observation remains. Preserve its journal and reconcile the outcome with the operator. Resource inspection cannot authorize a tool retry.',
  consumed: 'This purpose is consumed, irrespective of success, failure or inconclusive assertions. Preserve its historical outcome; no replay or replacement capture is proposed.',
  identity: 'Supply --tenant-id, --subscription-id and --account-name for a separately approved private account switch. No ambient login is used.',
  malformed: 'Evidence is invalid, changed or incomplete, not merely old. Preserve it and inspect the reported layer; no successful default, timestamp repair or automatic renewal.',
  capture: 'The selected capture is expired or invalid. Preserve it. A new separately approved discovery is not a replacement for a consumed proof or qualification selection.',
};
const terminal = attempts => attempts.some(a => ['completed', 'unresolved'].includes(a.status));
function gateLayer(history) {
  const attempts = history?.attempts ?? [];
  return { status: !attempts.length ? 'pending' : attempts.some(a => a.status === 'inconclusive') ? 'inconclusive'
    : attempts.some(a => a.status === 'failed') ? 'failed' : 'passed',
  historicalOnly: true, consumed: attempts.length > 0, attempts };
}
export function resumeLayers(status) {
  const proofs = status.proofs.filter(a => a.status !== 'not-proof'), qualifications = status.qualifications ?? [];
  const calls = [...proofs, ...qualifications];
  return {
    configuration: status.experimental?.configuration ?? { status: status.deployment, freshness: 'unknown',
      reason: 'Retained deployment completion has no live configuration deadline or health guarantee.' },
    discovery: { status: status.observations.some(a => a.status === 'invalid') ? 'blocked'
      : status.observations.some(a => a.status === 'no-capture' && !a.failureCode) ? 'unknown'
        : status.observations.some(a => a.status === 'valid') ? 'completed'
          : status.observations.some(a => a.status === 'stale') ? 'stale' : 'pending',
    observations: status.observations },
    proof: { status: proofs.some(a => a.status === 'unresolved') ? 'unknown'
      : proofs.some(a => a.status === 'completed') ? 'consumed'
        : proofs.some(a => a.status === 'not-dispatched') ? 'not-dispatched' : 'pending', attempts: proofs },
    resultAssertions: { historicalOnly: true,
      findings: calls.filter(a => a.backendAssertion).map(a => ({ attemptId: a.attemptId, assertion: a.backendAssertion })),
      status: calls.some(a => a.backendAssertion) ? 'recorded-scoped-findings' : 'not-recorded',
      businessCorrectnessVerified: false },
    qualification: { status: qualifications.some(a => a.status === 'unresolved') ? 'unknown'
      : terminal(qualifications) ? 'consumed'
        : proofs.some(a => a.status === 'completed' && a.acceptanceProfile) ? 'consumed-by-first-call'
        : qualifications.length ? 'not-dispatched' : 'not-recorded', attempts: qualifications },
    callerRejection: gateLayer(status.authRejections),
    backendEnforcement: { ...gateLayer(status.backendRejections), endToEndCredentialPropagationVerified: false,
      scope: 'Recorded provider-front-door rejection only; not broken-Key-Vault or end-to-end backend credential enforcement.' },
    cowork: { status: 'not-verified', reason: 'Separate consumer registration, packaging and real Cowork runtime acceptance.' },
  };
}

// Admission against known external-stage budgets, not a new deadline or readiness proof.
export function resumeFreshness(plan, now = Date.now()) {
  const operation = plan.operation;
  if (!operation && !plan.requests) return { status: 'not-applicable', deadlines: [], requiredKnownMs: null,
    unknown: ['Login, mutation or local work has no new overall deadline in this journey.'] };
  const discovery = operation?.discoveryPlan ?? operation;
  const budgets = operation ? [discovery.authTimeoutMs, discovery.metadataTimeoutMs,
    ...(operation.nativeGetMapping ? [operation.nativeGetMapping.maximumReadbackMs] : [])]
    : [plan.timeoutMs * plan.requests.length];
  const known = budgets.every(n => Number.isFinite(n) && n >= 0);
  const requiredKnownMs = known ? budgets.reduce((a, b) => a + b, 0) : null;
  const configuration = plan.readiness?.experimental?.configuration;
  const deadlines = [];
  if (configuration?.expiresAt) deadlines.push({ kind: 'configuration', expiresAt: configuration.expiresAt });
  if (operation?.capture?.capturedAt) deadlines.push({ kind: 'capture',
    expiresAt: new Date(Date.parse(operation.capture.capturedAt) + 86400000).toISOString() });
  for (const deadline of deadlines) deadline.remainingMs = Math.max(0, Date.parse(deadline.expiresAt) - now);
  return { status: !known ? 'unknown-budget' : deadlines.some(d => d.remainingMs <= requiredKnownMs)
    ? 'insufficient-lifetime' : 'fits-known-budgets', requiredKnownMs, deadlines,
  unknown: ['Local guards/publication overhead is not bounded here. Fitting known budgets is not a guarantee; execution revalidates freshness.'] };
}

async function lockNames(projectDir) {
  const found = [];
  for (const name of ['.provisioning.lock', '.mcp-network.lock']) {
    const filename = await assertProjectPath(path.join(projectDir, name));
    try { await lstat(filename); found.push(name); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return found;
}
const planErrors = new Set(['AUTH_CONFIG_INVALID', 'OAUTH_REVIEWED_IMPORT_REQUIRED', 'PROOF_CAPTURE_INVALID',
  'PROOF_SCHEMA_UNSUPPORTED', 'PROOF_ARGUMENTS_INVALID', 'READ_ONLY_REVIEW_REQUIRED', 'UNSAFE_PROOF',
  'QUALIFICATION_UNSUPPORTED', 'QUALIFICATION_ARGUMENTS_INVALID', 'QUALIFICATION_PRIOR_PROOF_REQUIRED',
  'QUALIFICATION_CONSUMED', 'PROOF_OUTCOME_UNRESOLVED', 'PROOF_REPLAY_BLOCKED', 'AUTH_REJECTION_UNSUPPORTED',
  'ACCEPTANCE_PROFILE_UNSUPPORTED', 'ACCEPTANCE_ARGUMENTS_INVALID',
  'DEPLOYMENT_CHECKPOINT_REQUIRED', 'MCP_CONFIGURATION_REQUIRED', 'MCP_CONFIGURATION_STALE',
  'MCP_CONFIGURATION_INVALID', 'AZURE_IDENTITY_REQUIRED']);

export async function planMcpResume(projectDir, { phase, config, target, useDeviceCode = false } = {}) {
  requireMetadata(phase === undefined || resumePhases.includes(phase), 'INVALID_CONFIG');
  const recovery = await recoveryBarrier(projectDir);
  if (recovery) return { schemaVersion: 1, action: 'standalone-mcp-resume', projectDir: path.resolve(projectDir),
    status: 'blocked', replayAuthorized: false, layers: { configuration: { status: 'not-read' }, recovery: { status: 'blocked' } },
    persistence: persistenceGuidance(), next: { status: 'blocked', code: recovery, command: null, approval: null,
      diagnosticCommand: 'mcp-diagnose',
      reason: 'Recovery is incomplete or retained lock/unsupported-history evidence requires operator review. Preserve archive and destination; no automatic unlock, timestamp repair, migration or replay.' } };
  const project = await readMcpServerProject(projectDir), dir = project.projectDir;
  const status = await readMcpStatus(dir, { journey: true });
  const layers = resumeLayers(status), lifecycle = await readMcpLifecycleAttempts(dir);
  const locks = await lockNames(dir), managed = project.review.descriptor.kind !== 'existing-mcp';
  const experimental = project.review.input.schemaVersion === 3;
  if (!layers.callerRejection.consumed && project.review.descriptor.inbound.type === 'anonymous') {
    layers.callerRejection.status = 'not-applicable';
  } else if (!layers.callerRejection.consumed && !managed) layers.callerRejection.status = 'not-supported';
  if (!layers.backendEnforcement.consumed && !isTavilyProject(project)) layers.backendEnforcement.status = 'not-supported';
  if (experimental && !lifecycle.some(a => a.phase === 'gateway')) {
    try { await lstat(await assertProjectPath(path.join(dir, '.mcp-configuration.json'))); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      layers.configuration = { status: 'pending', reason: 'Gateway prerequisites have not completed; no configuration observation exists.' };
    }
  }
  const report = { schemaVersion: 1, action: 'standalone-mcp-resume', projectDir: dir,
    reviewDigest: status.reviewDigest, historyDigest: status.historyDigest, evaluatedAt: new Date().toISOString(),
    status: 'blocked', layers, locks, replayAuthorized: false,
    limitations: ['Local history is not live health. Each layer is independent; scoped success cannot erase failed or inconclusive findings.',
      'No discovery selection, evidence timestamp, account or approval is inferred from ambient state.',
      'Resume executes at most one existing phase with its exact freshly recomputed approval and explicit effect opt-ins.'] };
  const stop = (code, reason, command = null) => ({ ...report,
    next: { status: 'blocked', code, reason, planCommand: command, command: null, approval: null,
      diagnosticCommand: 'mcp-diagnose' } });
  if (locks.length) return stop('WORKSPACE_LOCKED', guidance.locks);
  if (layers.proof.status === 'unknown' || layers.qualification.status === 'unknown' || layers.discovery.status === 'unknown') {
    return stop('OUTCOME_UNRESOLVED', guidance.unknown);
  }
  for (const [folder, layer] of [['.mcp-auth-rejections', layers.callerRejection],
    ['.mcp-backend-rejections', layers.backendEnforcement]]) {
    for (const attempt of layer.attempts) {
      try { await readControl(path.join(dir, folder, attempt.attemptId, 'result.json'), 65536); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return stop('OUTCOME_UNRESOLVED', guidance.unknown);
      }
    }
  }
  if (layers.discovery.status === 'blocked') return stop('INVALID_CAPTURE_HISTORY', guidance.malformed);
  if (phase === 'proof' && terminal(layers.proof.attempts)
    || phase === 'qualification' && (terminal(layers.qualification.attempts) || layers.qualification.status === 'consumed-by-first-call')
    || phase === 'caller-rejection' && layers.callerRejection.consumed
    || phase === 'backend-rejection' && layers.backendEnforcement.consumed) return stop('PURPOSE_CONSUMED', guidance.consumed);

  let selectedPhase = phase;
  if (phase === 'configuration' && !experimental) return stop('CONFIGURATION_UNSUPPORTED',
    'Fresh configuration observations are supported only by the existing experimental v3 contract.');
  if (!selectedPhase) {
    selectedPhase = terminal(layers.proof.attempts)
      ? layers.callerRejection.status === 'pending' ? 'caller-rejection'
        : layers.backendEnforcement.status === 'pending' ? 'backend-rejection' : null
      : layers.discovery.status === 'completed' || layers.proof.status === 'not-dispatched' ? 'proof' : 'discovery';
    if (!selectedPhase) return { ...report, status: 'handoff',
      next: { status: 'historical-review', command: null, approval: null,
        reason: 'Review the independent retained findings. No ordinary proof, qualification or negative matrix is automatically repeated. Cowork and end-to-end backend enforcement remain separate.' } };
  }

  let identity;
  if (managed) {
    try { identity = await readAzureIdentity(mcpRuntimeConfig(project.review.input), dir); }
    catch (error) {
      if (error.code !== 'AZURE_IDENTITY_REQUIRED') throw error;
      layers.identity = { status: 'blocked', errorCode: error.code };
    }
    layers.identity ??= { status: identity ? 'selected-locally-not-live-verified' : 'missing' };
  } else layers.identity = { status: 'not-required', role: 'MCP caller is separate from Azure CLI login.' };
  let plan, command, planCommand, phaseArgs = [], requiredFlags = [];
  try {
    if (managed && !identity) {
      if (!target) return stop('AZURE_IDENTITY_REQUIRED', guidance.identity, 'mcp-account-plan');
      plan = await planMcpServerAccount(dir, target, { useDeviceCode });
      command = 'mcp-account-switch'; planCommand = 'mcp-account-plan';
      phaseArgs = ['--tenant-id', plan.target.tenantId, '--subscription-id', plan.target.subscriptionId,
        '--account-name', plan.target.accountName, ...(useDeviceCode ? ['--use-device-code'] : [])];
    } else if (selectedPhase === 'configuration' || lifecycle.some(a => !['completed', 'reconciled'].includes(a.status))
      || experimental && ['stale', 'missing'].includes(layers.configuration.status)
        && lifecycle.some(a => a.phase === 'gateway')) {
      plan = await planMcpServerReconcile(dir, { experimentalConfiguration: experimental });
      command = 'mcp-reconcile'; planCommand = 'mcp-reconcile-plan';
      phaseArgs = experimental ? ['--experimental-configuration'] : [];
      requiredFlags = ['--allow-cloud'];
    } else if (experimental && layers.configuration.status === 'invalid') {
      return stop('INVALID_CONFIGURATION_HISTORY', guidance.malformed, 'mcp-reconcile-plan');
    } else if (managed && status.deployment !== 'recorded-completed' && layers.configuration.status !== 'valid') {
      if (project.review.input.schemaVersion === 1 && project.review.input.kind === 'apim-mcp-proxy') {
        return stop('LEGACY_PROXY_UNSUPPORTED', 'Historical v1 proxy deployment is unsupported. Preserve it; review a new uniquely owned definition.');
      }
      const complete = p => lifecycle.some(a => a.phase === p && a.status === 'completed'
        || p === 'foundation' && a.reconciliation?.disposition === 'foundation-present');
      const provisionPhase = !complete('foundation') ? 'foundation' : !complete('finalize') ? 'finalize' : 'gateway';
      plan = await planMcpServerProvision(dir, { phase: provisionPhase });
      command = 'mcp-provision'; planCommand = 'mcp-provision-plan'; phaseArgs = ['--phase', provisionPhase];
    } else if (['caller-rejection', 'backend-rejection'].includes(selectedPhase)) {
      plan = await (selectedPhase === 'caller-rejection' ? planMcpAuthRejection : planMcpBackendRejection)(dir);
      command = selectedPhase === 'caller-rejection' ? 'mcp-auth-rejection' : 'mcp-backend-rejection';
      planCommand = `${command}-plan`; requiredFlags = ['--allow-network'];
      if (plan.status !== 'review-required') return stop('REJECTION_NOT_EXECUTABLE', 'No new applicable rejection matrix is authorized.');
    } else {
      if (!config) return { ...stop('SELECTION_REQUIRED',
        `Supply --config with the exact ${selectedPhase === 'discovery' ? 'discovery identity' : 'unchanged capture, tool, arguments and safety review'} selection; no credentials.`,
        selectedPhase === 'discovery' ? 'mcp-discovery-plan' : `mcp-${selectedPhase}-plan`), status: 'input-required' };
      const selection = await readControl(config);
      planCommand = selectedPhase === 'discovery' ? 'mcp-discovery-plan' : `mcp-${selectedPhase}-plan`;
      plan = await (selectedPhase === 'discovery' ? planMcpProjectDiscovery
        : selectedPhase === 'qualification' ? planMcpProjectQualification : planMcpProjectProof)(dir, selection);
      if (selectedPhase !== 'discovery') assertMcpProofHistory(plan.proofHistory, plan.approvalDigest,
        plan.operation.approvalDigest, plan.operation, isTavilyProject(project));
      command = selectedPhase === 'discovery' ? 'mcp-discover' : `mcp-${selectedPhase}`;
      phaseArgs = ['--config', config];
      requiredFlags = ['--allow-network', ...(plan.operation.nativeGetMapping ? ['--allow-cloud'] : []),
        ...(plan.operation.source.inbound.type === 'entra' ? ['--interactive'] : [])];
    }
  } catch (error) {
    if (!planErrors.has(error.code)) throw error;
    return stop(error.code, error.code === 'PROOF_CAPTURE_INVALID' ? guidance.capture
      : 'The existing phase planner blocked this selection. Resolve its exact prerequisite and review a new plan; no execution or renewal occurred.',
    planCommand);
  }
  const phaseApproval = plan.approvalToken ?? plan.approvalDigest ?? null;
  const freshness = resumeFreshness(plan);
  // Rejection plans bind a configuration digest rather than embedding its timestamps.
  if (plan.requests && layers.configuration.expiresAt) {
    freshness.deadlines.push({ kind: 'configuration', expiresAt: layers.configuration.expiresAt,
      remainingMs: Math.max(0, Date.parse(layers.configuration.expiresAt) - Date.now()) });
    if (freshness.deadlines.some(d => d.remainingMs <= freshness.requiredKnownMs)) freshness.status = 'insufficient-lifetime';
  }
  const blocked = !phaseApproval || ['unknown-budget', 'insufficient-lifetime'].includes(freshness.status);
  const args = ['--project', dir, ...phaseArgs];
  const binding = { action: 'standalone-mcp-resume-phase', projectDir: dir, reviewDigest: report.reviewDigest,
    historyDigest: report.historyDigest, identity: identity ?? null, phase: selectedPhase, command, args, requiredFlags, plan };
  const approval = blocked ? null : `mcp-resume/${metadataDigest(boundedSnapshot(binding))}`;
  return { ...report, status: blocked ? 'blocked' : 'review-required', freshness,
    next: { status: blocked ? 'blocked' : 'review-required', planCommand, command: blocked ? null : command,
      approval, phaseApproval, args, requiredFlags,
      reason: !phaseApproval ? 'Resolve the existing plan prerequisites before approving execution.'
        : freshness.status === 'insufficient-lifetime'
          ? 'Insufficient lifetime for known authentication/execution budgets. If configuration is limiting, use mcp-resume --phase configuration for a separately reviewed read-only inspection. An old capture is never renewed or substituted.'
          : freshness.status === 'unknown-budget' ? 'Execution budget is unknown; resume will not guess readiness.'
            : 'Review this complete existing phase plan. next.approval binds it AND current history for one resume step; phaseApproval remains its unchanged native token. Run resume again afterward.',
      plan } };
}
