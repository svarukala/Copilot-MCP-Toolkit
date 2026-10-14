import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { metadataDigest, boundedSnapshot } from './anonymous-metadata.js';
import { readControl, writeControl } from './mcp-control.js';
import { mcpRuntimeConfig } from './mcp-server.js';
import { readAzureIdentity } from './azure-identity.js';
import { deploymentTarget, fingerprint, managedApis, managedBackends } from './apim-safety.js';
import { planProvisioning, provisionProject, runAzureCommand } from './azure.js';

export const CONFIGURATION_CONTRACT = 'experimental-configuration-v1';
export const CONFIGURATION_AGE_MS = 15 * 60 * 1000;
export const CONFIGURATION_DISPOSITION = 'experimental-active-configuration-observed';
const evidenceName = '.mcp-configuration.json';
const digest = value => metadataDigest(boundedSnapshot(value));
const next = 'Review mcp-reconcile-plan --experimental-configuration, then approved mcp-reconcile --experimental-configuration --allow-cloud. Evidence lasts 15 minutes; never replay the gateway.';
function ensure(value, code = 'MCP_CONFIGURATION_INVALID') {
  if (!value) throw Object.assign(new Error(`Experimental configuration evidence is missing, changed, incomplete or expired. ${next}`), { code });
}
function keys(value, expected) {
  ensure(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...expected].sort().join(','));
}
function transport(value) {
  ensure(value?.requested === 'streamable' && ['reported', 'unreported'].includes(value.status));
  keys(value, ['requested', 'status', ...(value.status === 'reported' ? ['reported'] : [])]);
  ensure(value.status !== 'reported' || value.reported === 'streamable');
}
async function context(projectDir) {
  const { readMcpServerProject, readMcpLifecycleAttempts } = await import('./mcp-lifecycle.js');
  const project = await readMcpServerProject(projectDir);
  ensure(project.review.input.schemaVersion === 3 && project.review.input.experimentalProfile === 'owned-backend-routing-v1');
  const config = mcpRuntimeConfig(project.review.input);
  const history = await readMcpLifecycleAttempts(project.projectDir);
  const receipt = await readControl(path.join(project.projectDir, 'infra', 'provisioning-receipt.json'));
  ensure(receipt && typeof receipt === 'object' && !Array.isArray(receipt));
  return { ...project, config, history, receipt };
}
function eligible(c) {
  const { history, receipt, config, review } = c;
  const allowed = ['schemaVersion', 'status', 'phase', 'approvalToken', 'reviewDigest', 'startedAt', 'finishedAt',
    'resultStatus', 'failedStep', 'mutationPossible', 'blocked', 'previousStatus', 'reconciliation'];
  ensure(history.every(record => Object.keys(record).every(key => allowed.includes(key))
    && typeof record.startedAt === 'string' && Number.isFinite(Date.parse(record.startedAt))));
  const gateways = history.filter(record => record.phase === 'gateway').sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const latest = gateways.at(-1);
  ensure(latest?.reviewDigest === review.reviewDigest);
  const completed = latest.status === 'completed';
  const failed = latest.status === 'failed-uncertain'
    || latest.status === 'reconciled' && latest.previousStatus === 'failed-uncertain'
      && latest.reconciliation?.disposition === CONFIGURATION_DISPOSITION;
  ensure(completed || failed && latest.failedStep === 'verify-owned-apis'
    && latest.blocked?.code === 'APIM_PROXY_MAPPING_MISMATCH' && latest.mutationPossible === true);
  ensure(history.every(record => ['completed', 'reconciled'].includes(record.status) || record === latest && failed));
  ensure(receipt.target && fingerprint(receipt.target) === fingerprint(deploymentTarget(config)));
  ensure(receipt.lastAttempt?.phase === 'gateway'
    && (completed ? receipt.lastAttempt.status === 'completed-with-manual-actions'
      : receipt.lastAttempt.status === 'failed' && receipt.lastAttempt.failedStep === 'verify-owned-apis'
        && receipt.lastAttempt.errorCode === 'APIM_PROXY_MAPPING_MISMATCH'));
  ensure(Array.isArray(receipt.completedSteps)
    && receipt.completedSteps.some(step => step.phase === 'gateway' && step.id === 'deploy-gateway'
      && Date.parse(step.at) >= Date.parse(latest.startedAt)));
  ensure(!completed || receipt.completedSteps.some(step => step.phase === 'gateway' && step.id === 'verify-owned-apis'));
  ensure(managedApis(config).every(api => receipt.apiIntents?.includes(api.id))
    && managedBackends(config).every(backend => receipt.backendIntents?.includes(backend.id))
    && receipt.namedValueIntents?.includes(`${review.descriptor.ownership.apiId}-backend-key`));
  ensure(typeof receipt.preservation?.globalPolicyHash === 'string'
    && Array.isArray(receipt.preservation.unrelatedApis) && Array.isArray(receipt.preservation.unrelatedBackends));
}
export function configurationObserved(history) {
  return history.some(record => record.reconciliation?.disposition === CONFIGURATION_DISPOSITION);
}
export async function planExperimentalConfiguration(projectDir) {
  const c = await context(projectDir);
  eligible(c);
  const inspection = await planProvisioning(c.config, c.projectDir, {
    phase: 'gateway', inspectOnly: true, experimentalConfiguration: true,
  });
  let previousEvidence = null;
  try { previousEvidence = await readControl(path.join(c.projectDir, evidenceName), 65536); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const plan = { action: 'mcp-reconcile', experimentalConfiguration: true, evidenceContract: CONFIGURATION_CONTRACT,
    maximumAgeMs: CONFIGURATION_AGE_MS, projectDir: c.projectDir, reviewDigest: c.review.reviewDigest,
    historyDigest: digest(c.history), receiptDigest: digest(c.receipt), previousEvidenceDigest: digest(previousEvidence), inspection,
    disposition: CONFIGURATION_DISPOSITION,
    effects: ['Read-only exact active API/backend/auth-routing policy, original preservation snapshots and existing grant verification. No deployment or receipt mutation.',
      'Starting this approved inspection invalidates earlier configuration evidence, including on cancellation, failed readback or interrupted publication.',
      'Record reported/unreported control-plane transport, never infer effective transport from absence.',
      'Preserve failed attempt details as reconciled, never completed. Configuration evidence lasts 15 minutes and authorizes no replay, capture or tool call.',
      'Expired or interrupted publication requires a fresh approved read-only inspection; diagnostic summaries are ineligible.'] };
  return { ...plan, approvalToken: inspection.approvalToken ? `mcp-reconcile/${digest(plan)}` : null };
}
function settled(history, plan, reportFile, observationDigest, at) {
  return history.map(record => ['started', 'failed-uncertain'].includes(record.status) ? {
    ...record, previousStatus: record.status, status: 'reconciled',
    reconciliation: { approval: plan.approvalToken, reportFile, observationDigest, disposition: CONFIGURATION_DISPOSITION, at },
  } : record);
}
export async function inspectExperimentalConfiguration(projectDir, { approval, allowCloud = false, run = runAzureCommand, signal } = {}) {
  const c = await context(projectDir), plan = await planExperimentalConfiguration(projectDir);
  ensure(allowCloud === true && approval && approval === plan.approvalToken, 'APPROVAL_REQUIRED');
  let currentEvidenceDigest = plan.previousEvidenceDigest;
  let checkpoint = () => {}, pendingEvidence;
  const unchanged = async () => {
    checkpoint();
    const fresh = await planExperimentalConfiguration(projectDir);
    checkpoint();
    ensure(fresh.previousEvidenceDigest === currentEvidenceDigest);
    const { approvalToken, ...body } = fresh;
    ensure(`mcp-reconcile/${digest({ ...body, previousEvidenceDigest: plan.previousEvidenceDigest })}` === approval);
  };
  let evidence, reportFile;
  const result = await provisionProject(c.config, c.projectDir, {
    phase: 'gateway', inspectOnly: true, experimentalConfiguration: true, run, signal, beforeCommand: unchanged,
    onInspectionFailure: async () => {
      if (pendingEvidence) await writeControl(path.join(c.projectDir, evidenceName), pendingEvidence);
    },
    approve: async fresh => {
      await unchanged(); ensure(fresh.approvalToken === plan.inspection.approvalToken);
      const pending = { schemaVersion: 1, kind: CONFIGURATION_CONTRACT, status: 'inspection-started',
        inspectionId: randomUUID(), approvalToken: approval, startedAt: new Date().toISOString() };
      pendingEvidence = pending;
      await writeControl(path.join(c.projectDir, evidenceName), pending);
      currentEvidenceDigest = digest(pending);
      return true;
    },
    afterInspection: async (result, check) => {
      checkpoint = check;
      await unchanged();
      transport(result.controlPlaneTransport);
      ensure(['verify-owned-apis', 'verify-preservation'].every(step => result.executedSteps.includes(step)));
      const observedAt = new Date().toISOString();
      reportFile = path.join(c.projectDir, `reconcile-${randomUUID()}.json`);
      const body = { schemaVersion: 1, kind: CONFIGURATION_CONTRACT, plan, originalHistory: c.history,
        result: { status: 'configuration-observed-not-runtime-tested', observationDigest: result.observationDigest,
          controlPlaneTransport: result.controlPlaneTransport }, observedAt };
      const report = { ...body, reportDigest: digest(body) };
      await writeControl(reportFile, report, { create: true });
      await unchanged();
      const history = settled(c.history, plan, reportFile, result.observationDigest, observedAt);
      const directory = path.join(c.projectDir, '.mcp-lifecycle');
      for (const filename of await readdir(directory)) {
        const file = path.join(directory, filename), original = await readControl(file, 65536);
        checkpoint();
        if (!['started', 'failed-uncertain'].includes(original.status)) continue;
        const index = c.history.findIndex(record => digest(record) === digest(original));
        ensure(index >= 0);
        await writeControl(file, history[index]);
      }
      const fresh = await context(projectDir);
      ensure(digest(fresh.history) === digest(history) && digest(fresh.receipt) === plan.receiptDigest
        && fresh.review.reviewDigest === plan.reviewDigest);
      const identity = await readAzureIdentity(c.config, c.projectDir, { required: true });
      checkpoint();
      ensure(digest(identity) === digest(plan.inspection.azureIdentity));
      const record = { schemaVersion: 1, kind: CONFIGURATION_CONTRACT, projectDir: c.projectDir,
        reviewDigest: c.review.reviewDigest, definitionDigest: c.review.descriptor.definitionDigest,
        descriptorDigest: c.review.descriptor.descriptorDigest, identity,
        historyDigest: digest(history), receiptDigest: plan.receiptDigest, preservationDigest: digest(c.receipt.preservation),
        reportFile: path.basename(reportFile), reportDigest: report.reportDigest, observedAt,
        expiresAt: new Date(Date.parse(observedAt) + CONFIGURATION_AGE_MS).toISOString(),
        controlPlaneTransport: result.controlPlaneTransport };
      evidence = { ...record, evidenceDigest: digest(record) };
      checkpoint();
      await writeControl(path.join(c.projectDir, evidenceName), evidence);
      await readExperimentalConfiguration(c.projectDir);
      checkpoint();
    },
  });
  if (!evidence) {
    reportFile = path.join(c.projectDir, `reconcile-${randomUUID()}.json`);
    await writeControl(reportFile, { plan, result, observedAt: new Date().toISOString() }, { create: true });
    return { ...result, reportFile, lifecycleStatus: 'blocked-unresolved', next };
  }
  return { status: 'configuration-observed-not-runtime-tested', disposition: CONFIGURATION_DISPOSITION,
    reportFile, evidenceFile: path.join(c.projectDir, evidenceName), evidenceDigest: evidence.evidenceDigest,
    controlPlaneTransport: evidence.controlPlaneTransport, observedAt: evidence.observedAt,
    expiresAt: evidence.expiresAt, maximumAgeMs: CONFIGURATION_AGE_MS,
    forwardingVerified: false, replayAuthorized: false,
    next: 'Review fresh normal discovery within 15 minutes. Tool calls require separate capture/selection/approval. Expiration requires read-only reinspection, never gateway replay.' };
}
async function configurationEvidence(projectDir) {
  const c = await context(projectDir);
  eligible(c);
  let evidence;
  try { evidence = await readControl(path.join(c.projectDir, evidenceName), 65536); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    ensure(false, 'MCP_CONFIGURATION_REQUIRED');
  }
  keys(evidence, ['schemaVersion', 'kind', 'projectDir', 'reviewDigest', 'definitionDigest', 'descriptorDigest',
    'identity', 'historyDigest', 'receiptDigest', 'preservationDigest', 'reportFile', 'reportDigest',
    'observedAt', 'expiresAt', 'controlPlaneTransport', 'evidenceDigest']);
  const { evidenceDigest, ...body } = evidence;
  ensure(evidenceDigest === digest(body) && evidence.schemaVersion === 1 && evidence.kind === CONFIGURATION_CONTRACT
    && evidence.projectDir === c.projectDir && evidence.reviewDigest === c.review.reviewDigest
    && evidence.definitionDigest === c.review.descriptor.definitionDigest && evidence.descriptorDigest === c.review.descriptor.descriptorDigest
    && evidence.historyDigest === digest(c.history) && evidence.receiptDigest === digest(c.receipt)
    && evidence.preservationDigest === digest(c.receipt.preservation));
  transport(evidence.controlPlaneTransport);
  ensure(digest(evidence.identity) === digest(await readAzureIdentity(c.config, c.projectDir, { required: true })));
  ensure(/^reconcile-[a-f0-9-]{36}\.json$/.test(evidence.reportFile));
  const reportFile = path.join(c.projectDir, evidence.reportFile), report = await readControl(reportFile);
  keys(report, ['schemaVersion', 'kind', 'plan', 'originalHistory', 'result', 'observedAt', 'reportDigest']);
  const { reportDigest, ...reportBody } = report;
  ensure(reportDigest === digest(reportBody) && reportDigest === evidence.reportDigest
    && report.schemaVersion === 1 && report.kind === CONFIGURATION_CONTRACT);
  keys(report.result, ['status', 'observationDigest', 'controlPlaneTransport']);
  keys(report.plan, ['action', 'experimentalConfiguration', 'evidenceContract', 'maximumAgeMs', 'projectDir',
    'reviewDigest', 'historyDigest', 'receiptDigest', 'previousEvidenceDigest', 'inspection', 'disposition', 'effects', 'approvalToken']);
  eligible({ ...c, history: report.originalHistory });
  const inspection = await planProvisioning(c.config, c.projectDir, { phase: 'gateway', inspectOnly: true, experimentalConfiguration: true });
  const { approvalToken, ...planBody } = report.plan;
  ensure(approvalToken === `mcp-reconcile/${digest(planBody)}` && report.plan.action === 'mcp-reconcile' && report.plan.experimentalConfiguration === true
    && report.plan.evidenceContract === CONFIGURATION_CONTRACT && report.plan.maximumAgeMs === CONFIGURATION_AGE_MS
    && report.plan.disposition === CONFIGURATION_DISPOSITION && report.plan.projectDir === c.projectDir
    && report.plan.reviewDigest === evidence.reviewDigest && report.plan.receiptDigest === evidence.receiptDigest
    && report.plan.historyDigest === digest(report.originalHistory)
    && digest(report.plan.inspection) === digest(inspection)
    && digest(report.plan.inspection.azureIdentity) === digest(evidence.identity)
    && /^[a-f0-9]{64}$/.test(report.result.observationDigest)
    && report.result.status === 'configuration-observed-not-runtime-tested'
    && digest(report.result.controlPlaneTransport) === digest(evidence.controlPlaneTransport)
    && report.observedAt === evidence.observedAt);
  ensure(digest(settled(report.originalHistory, report.plan, reportFile, report.result.observationDigest, report.observedAt)) === evidence.historyDigest);
  const observed = Date.parse(evidence.observedAt), expires = Date.parse(evidence.expiresAt);
  ensure(Number.isFinite(observed) && Number.isFinite(expires) && expires - observed === CONFIGURATION_AGE_MS
    && new Date(observed).toISOString() === evidence.observedAt && new Date(expires).toISOString() === evidence.expiresAt);
  return evidence;
}
export async function readExperimentalConfiguration(projectDir) {
  const evidence = await configurationEvidence(projectDir);
  ensure(Date.parse(evidence.observedAt) <= Date.now() && Date.parse(evidence.expiresAt) > Date.now(), 'MCP_CONFIGURATION_STALE');
  return evidence;
}
export async function experimentalConfigurationStatus(projectDir, { includeExpired = false } = {}) {
  try {
    const evidence = await (includeExpired ? configurationEvidence(projectDir) : readExperimentalConfiguration(projectDir));
    const stale = Date.parse(evidence.observedAt) > Date.now() || Date.parse(evidence.expiresAt) <= Date.now();
    return { status: stale ? 'stale' : 'valid', evidenceDigest: evidence.evidenceDigest, maximumAgeMs: CONFIGURATION_AGE_MS,
      observedAt: evidence.observedAt, expiresAt: evidence.expiresAt, controlPlaneTransport: evidence.controlPlaneTransport,
      ...(stale ? { errorCode: 'MCP_CONFIGURATION_STALE', next } : {}),
      forwardingVerified: false, replayAuthorized: false };
  } catch (error) {
    if (!['ENOENT', 'MCP_CONFIGURATION_REQUIRED', 'MCP_CONFIGURATION_INVALID', 'MCP_CONFIGURATION_STALE', 'AZURE_IDENTITY_REQUIRED', 'CONTROL_VALIDATION'].includes(error.code)
      && !(error instanceof SyntaxError)) throw error;
    return { status: error.code === 'MCP_CONFIGURATION_STALE' ? 'stale'
      : ['ENOENT', 'MCP_CONFIGURATION_REQUIRED'].includes(error.code) ? 'missing' : 'invalid',
    maximumAgeMs: CONFIGURATION_AGE_MS, errorCode: error.code ?? 'MCP_CONFIGURATION_INVALID', next,
    forwardingVerified: false, replayAuthorized: false };
  }
}
