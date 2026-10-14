import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, mkdir, open, rename } from 'node:fs/promises';
import { assertProjectPath } from './config.js';
import { prepareMcpServerDefinition, mcpRuntimeConfig } from './mcp-server.js';
import { savedJson, metadataDigest } from './anonymous-metadata.js';
import { planProvisioning, provisionProject, runAzureCommand } from './azure.js';
import { planAzureAccountSwitch, switchAzureAccount } from './azure-identity.js';
import { resourceChoices } from './mcp-resources.js';
import { readControl, writeControl, controlFailure } from './mcp-control.js';
import { experimentalProxy } from './contract.js';
import { configurationObserved, experimentalConfigurationStatus } from './mcp-configuration.js';
import { recoveryBarrier, recoveryError } from './mcp-recovery.js';

function ensure(value, message) { if (!value) throw new Error(message); }
async function readBounded(filename, limit) {
  await assertProjectPath(filename);
  const stat = await lstat(filename);
  ensure(stat.isFile() && stat.size <= limit, 'Standalone lifecycle input must be a bounded regular file.');
  return readFile(filename, 'utf8');
}
export async function readMcpServerProject(projectDir) {
  const dir = await assertProjectPath(path.resolve(projectDir));
  const before = await recoveryBarrier(dir);
  if (before) throw recoveryError(before);
  const input = JSON.parse(await readBounded(path.join(dir, 'mcp-definition.json'), 1048576));
  const review = await prepareMcpServerDefinition(input);
  for (const [name, expected] of Object.entries(review.files)) {
    ensure(await readBounded(path.join(dir, ...name.split('/')), 8 * 1048576) === expected,
      `Standalone artifact differs from its definition: ${name}. Restore reviewed bytes or generate a new project.`);
  }
  const after = await recoveryBarrier(dir);
  if (after) throw recoveryError(after);
  return { projectDir: dir, review };
}
async function deployable(projectDir) {
  const project = await readMcpServerProject(projectDir);
  ensure(project.review.input.kind !== 'existing-mcp',
    'Existing MCP references require no Azure login or provisioning. Use capture preparation and the consumer adapter.');
  return { ...project, config: mcpRuntimeConfig(project.review.input) };
}
export async function readMcpLifecycleAttempts(projectDir) {
  const dir = await assertProjectPath(path.join(projectDir, '.mcp-lifecycle'));
  let names;
  try { names = await readdir(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; return []; }
  ensure(names.length <= 1000, 'Standalone lifecycle history requires operator archival before more attempts.');
  const records = [];
  for (const name of names.sort()) {
    ensure(/^[a-f0-9-]+\.json$/.test(name), 'Unexpected standalone lifecycle history file; inspect before continuing.');
    const record = JSON.parse(await readBounded(path.join(dir, name), 65536));
    ensure(record.schemaVersion === 1 && ['started', 'completed', 'failed-uncertain', 'reconciled'].includes(record.status),
      'Unreadable standalone lifecycle history; no automatic replay allowed.');
    records.push(record);
  }
  return records;
}
const attempts = readMcpLifecycleAttempts;
function requireSettled(records) {
  ensure(records.every(record => ['completed', 'reconciled'].includes(record.status)),
    'An interrupted or failed standalone attempt has an uncertain outcome. Automatic replay is blocked; inspect Azure and retained history before operator recovery.');
}
export async function planMcpServerProvision(projectDir, { phase = 'foundation' } = {}) {
  const project = await deployable(projectDir);
  const history = await attempts(project.projectDir);
  requireSettled(history);
  ensure(!(phase === 'gateway' && project.review.input.schemaVersion === 3 && configurationObserved(history)),
    'Active experimental configuration was inspected. Never replay the gateway, even after evidence expires; review mcp-reconcile-plan --experimental-configuration for a fresh 15-minute read-only observation.');
  ensure(!(phase === 'gateway' && history.some(record => record.phase === 'gateway' && record.status === 'completed')),
    'Gateway already completed. Do not replay deployment; preserve history and use a new uniquely owned project for changed infrastructure.');
  ensure(!(project.review.input.kind === 'apim-mcp-proxy' && project.review.input.schemaVersion === 1),
    'Historical v1 MCP proxy has no explicit message endpoint mapping. Preserve its artifacts/history and prepare a new uniquely owned v2 project; in-place provisioning is not supported.');
  ensure(!(phase === 'foundation' && history.some(record => record.phase === 'foundation' && record.status === 'completed'
    || record.reconciliation?.disposition === 'foundation-present')),
    'Foundation resources already completed or were reconciled as present. Do not recreate them; review finalize/gateway instead.');
  const plan = await planProvisioning(project.config, project.projectDir, { phase });
  const binding = { contractVersion: 1, action: 'standalone-mcp-provision', projectDir: project.projectDir,
    reviewDigest: project.review.reviewDigest, historyDigest: metadataDigest(history),
    prerequisites: {
      existingResourceApplication: project.review.input.inbound,
      applicationCreation: 'separate-mcp-app-workspace-create-or-reuse-before-generation',
      delegatedConsent: 'manual-administrator-review-required',
      backend: project.review.input.backend,
      consumerRegistration: 'separate-consumer-adapter-workflow',
      secretPopulation: experimentalProxy(project.config) ? 'existing-secret-reference-no-writes'
        : project.review.input.backend.auth === 'api-key' ? 'manual-secure-key-vault-import' : 'not-required',
    }, resources: resourceChoices(project.config), plan };
  return { ...binding, approvalToken: plan.approvalToken ? `mcp-provision/${metadataDigest(binding)}` : null,
    limitations: ['APIM resource lifecycle only; the resolved inbound Entra application is verified here. App setup has its own separately approved workspace.',
      'Consumer registrations, delegated consent, backend permissions and real endpoint tests remain separate.',
      'Failed/interrupted attempts block replay. Descriptor remains generation evidence, never deployment proof.'] };
}
export async function planMcpServerAccount(projectDir, requested, options = {}) {
  const project = await deployable(projectDir);
  ensure(requested.tenantId?.toLowerCase() === project.config.azure.tenantId.toLowerCase()
    && requested.subscriptionId?.toLowerCase() === project.config.azure.subscriptionId.toLowerCase(),
  'Account target must match the reviewed standalone definition; generate a new project for another target.');
  return planAzureAccountSwitch(project.projectDir, requested, options);
}
export async function switchMcpServerAccount(projectDir, requested, options = {}) {
  await planMcpServerAccount(projectDir, requested, options);
  return switchAzureAccount(projectDir, requested, options);
}
export async function provisionMcpServer(projectDir, { phase = 'foundation', approval, run = runAzureCommand } = {}) {
  const project = await deployable(projectDir);
  const reviewed = await planMcpServerProvision(project.projectDir, { phase });
  ensure(reviewed.approvalToken && approval === reviewed.approvalToken,
    'Exact current standalone provisioning approval required. Account login and local generation approvals do not authorize resources.');
  let record, recordFile;
  const persist = async () => {
    const temp = `${recordFile}.${randomUUID()}.pending`;
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(savedJson(record)); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, recordFile);
  };
  const unchanged = async () => {
    ensure((await readMcpServerProject(project.projectDir)).review.reviewDigest === reviewed.reviewDigest,
      'Standalone definition changed after approval; no further command is allowed.');
  };
  try {
    const result = await provisionProject(project.config, project.projectDir, {
      phase, run, beforeCommand: unchanged,
      approve: async plan => {
        const fresh = await planMcpServerProvision(project.projectDir, { phase });
        ensure(fresh.approvalToken === approval && plan.approvalToken === fresh.plan.approvalToken,
          'Standalone inputs, account or history changed after approval.');
        const dir = await assertProjectPath(path.join(project.projectDir, '.mcp-lifecycle'));
        await mkdir(dir, { recursive: true, mode: 0o700 });
        recordFile = path.join(dir, `${randomUUID()}.json`);
        record = { schemaVersion: 1, status: 'started', phase, approvalToken: approval,
          reviewDigest: reviewed.reviewDigest, startedAt: new Date().toISOString() };
        await persist();
        return true;
      },
    });
    record.status = result.status === 'completed-with-manual-actions' ? 'completed' : 'failed-uncertain';
    record.finishedAt = new Date().toISOString();
    record.resultStatus = result.status;
    record.failedStep = result.failedStep ?? null;
    const mutatingStep = id => /^(?:create-|deploy-|lock-api-|merge-app-)/.test(id);
    record.mutationPossible = [...result.executedSteps, ...(result.failedStep ? [result.failedStep] : [])].some(mutatingStep);
    if (result.status === 'failed') record.blocked = { ...controlFailure({ code: result.errorCode }, phase),
      failedStep: result.failedStep, ...(result.errorCode ? { code: result.errorCode } : {}) };
    await persist();
    return { ...result, lifecycleStatus: record.status, descriptorStatus: project.review.descriptor.status };
  } catch (error) {
    if (record) { record.status = 'failed-uncertain'; await persist(); }
    throw error;
  }
}
export async function planMcpServerCapture(projectDir) {
  const project = await readMcpServerProject(projectDir);
  const descriptor = project.review.descriptor;
  const history = descriptor.kind === 'existing-mcp' ? [] : await attempts(project.projectDir);
  const gatewayVerified = history.some(record => record.phase === 'gateway' && record.status === 'completed'
    && record.reviewDigest === project.review.reviewDigest) && history.every(record => ['completed', 'reconciled'].includes(record.status));
  const configuration = project.review.input.schemaVersion === 3 ? await experimentalConfigurationStatus(project.projectDir) : undefined;
  return { contractVersion: 1, action: 'standalone-mcp-capture-preparation', evidence: 'configuration-only',
    ...(project.review.input.schemaVersion === 3 ? { experimental: {
      profile: project.review.input.experimentalProfile, status: 'experimental-not-forwarding-verified',
      configuration,
    } } : {}),
    descriptor, reviewDigest: project.review.reviewDigest, cloudExecution: false, metadataCaptured: false,
    gatewayLifecycle: configuration ? configuration.status === 'valid' ? 'configuration-observed-not-runtime-tested' : 'not-verified'
      : descriptor.kind === 'existing-mcp' ? 'not-required' : gatewayVerified ? 'completed-not-runtime-tested' : 'not-verified',
    requirements: ['Obtain real bounded tools/list results from this exact endpoint using its declared authorization.',
      'Preserve the original capture timestamp; import through the reviewed consumer adapter. Never synthesize tool schemas.',
      ...(descriptor.inbound.type === 'anonymous' ? ['Anonymous discovery needs no Azure login.']
        : descriptor.inbound.type === 'oauth' ? ['Use the provider-supported OAuth flow externally; no provider login or token exchange is performed here.']
          : ['Use an explicitly authorized delegated client; resource scope, tenant and audience must match. Consumer registration and consent are separate.']),
      'Negative authorization tests and selected tool execution require separate explicit approval; this plan performs neither.'] };
}

export async function planMcpServerReconcile(projectDir, { experimentalConfiguration = false } = {}) {
  if (experimentalConfiguration) return (await import('./mcp-configuration.js')).planExperimentalConfiguration(projectDir);
  const project = await deployable(projectDir), history = await attempts(project.projectDir);
  const pending = history.filter(record => ['started', 'failed-uncertain'].includes(record.status));
  ensure(pending.length > 0, 'There is no unresolved standalone attempt to reconcile.');
  const mutatedFoundation = pending.some(record => record.phase === 'foundation' && record.mutationPossible !== false);
  const phase = mutatedFoundation || pending.some(record => record.phase === 'gateway') ? 'gateway'
    : pending.some(record => record.phase === 'foundation') ? 'foundation' : 'finalize';
  const inspection = await planProvisioning(project.config, project.projectDir, { phase, inspectOnly: true });
  let receipt = null;
  try { receipt = await readControl(path.join(project.projectDir, 'infra', 'provisioning-receipt.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const plan = { action: 'mcp-reconcile', projectDir: project.projectDir, reviewDigest: project.review.reviewDigest,
    historyDigest: metadataDigest(history), receiptDigest: metadataDigest(receipt), inspection,
    disposition: mutatedFoundation ? 'foundation-present' : 'fresh-phase-review-required',
    effects: ['Read exact selected resources/app, ownership/collisions, inherited protections and retained preservation snapshot; no cloud mutations.',
      'A missing or incompatible possibly-created resource blocks recovery. No blind create retry, foreign adoption, deletion or rollback.',
      'Successful readback settles uncertainty only. It is not discovery or gateway completion; resource mutation still requires a NEW identity-bound phase approval.'] };
  return { ...plan, approvalToken: inspection.approvalToken ? `mcp-reconcile/${metadataDigest(plan)}` : null };
}
export async function reconcileMcpServer(projectDir, { approval, allowCloud = false, run = runAzureCommand, experimentalConfiguration = false, signal } = {}) {
  if (experimentalConfiguration) return (await import('./mcp-configuration.js')).inspectExperimentalConfiguration(projectDir, { approval, allowCloud, run, signal });
  const project = await deployable(projectDir), plan = await planMcpServerReconcile(projectDir);
  ensure(allowCloud === true && approval && approval === plan.approvalToken, 'Exact current reconciliation approval and cloud read opt-in required.');
  const unchanged = async () => ensure((await planMcpServerReconcile(projectDir)).approvalToken === approval,
    'Reconciliation input/account/history/receipt changed; stop and review again.');
  let reportFile;
  const result = await provisionProject(project.config, project.projectDir, {
    phase: plan.inspection.phase, inspectOnly: true, run, signal, beforeCommand: unchanged,
    approve: async fresh => { await unchanged(); ensure(fresh.approvalToken === plan.inspection.approvalToken, 'Inspection plan changed.'); return true; },
    afterInspection: async (observed, check) => {
      check(); await unchanged(); check();
      reportFile = path.join(project.projectDir, `reconcile-${randomUUID()}.json`);
      await writeControl(reportFile, { plan, result: observed, observedAt: new Date().toISOString() }, { create: true });
      check();
      const dir = path.join(project.projectDir, '.mcp-lifecycle');
      for (const name of await readdir(dir)) {
        const filename = path.join(dir, name), record = await readControl(filename, 65536);
        check();
        if (['started', 'failed-uncertain'].includes(record.status)) {
          record.previousStatus = record.status; record.status = 'reconciled';
          record.reconciliation = { approval, reportFile, observationDigest: observed.observationDigest,
            disposition: plan.disposition, at: new Date().toISOString() };
          await writeControl(filename, record);
        }
      }
      check();
    },
  });
  if (result.status !== 'inspected-not-deployed') {
    reportFile = path.join(project.projectDir, `reconcile-${randomUUID()}.json`);
    await writeControl(reportFile, { plan, result, observedAt: new Date().toISOString() }, { create: true });
    return { ...result, reportFile, lifecycleStatus: 'blocked-unresolved' };
  }
  return { status: 'reconciled-not-deployed', reportFile, disposition: plan.disposition,
    next: plan.disposition === 'foundation-present' ? 'Review a fresh finalize/gateway plan; never redeploy the reconciled foundation.' : 'Review a fresh phase plan before any mutation.' };
}
