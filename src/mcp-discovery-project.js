import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, open, lstat, readFile, unlink } from 'node:fs/promises';
import { assertProjectPath } from './config.js';
import { readMcpServerProject, planMcpServerCapture } from './mcp-lifecycle.js';
import { boundedSnapshot, metadataDigest, requireMetadata, savedJson } from './anonymous-metadata.js';
import { planMcpDiscovery, planMcpReadOnlyProof, discoverMcpToolsWithGuard, runMcpReadOnlyProofWithGuard,
  planMcpProjectMappedProof, runMcpProjectMappedProof, planMcpQualifiedProof, runMcpQualifiedProof,
  planMcpAcceptedProof, runMcpAcceptedProof } from './mcp-discovery.js';
import { planNativeGetMapping, verifyNativeGetMapping, nativeProofFailure } from './mcp-native-proof.js';
import { readMcpProofHistory, assertMcpProofHistory } from './mcp-proof-history.js';
import { validateMcpObservedCapture } from './mcp-discovery.js';
import { readControl, withControlLock } from './mcp-control.js';
import { readExperimentalConfiguration } from './mcp-configuration.js';
import { mcpFailureDiagnostics } from './mcp-failure.js';
import { qualificationAction, qualificationBinding, isTavilyProject, qualificationKind,
  firstCallProfileBinding } from './mcp-tavily-qualification.js';
import { cliStage } from './cli-feedback.js';

const equal = (a, b) => JSON.stringify(boundedSnapshot(a)) === JSON.stringify(boundedSnapshot(b));
export async function resolveMcpProofSelection(projectDir, value) {
  const selection = boundedSnapshot(value);
  try {
    if (typeof selection.capture === 'string') {
      requireMetadata(selection.capture.length > 0 && selection.capture.length <= 4096, 'INVALID_CONFIG');
      selection.capture = await readControl(path.resolve(projectDir, selection.capture), 1048576);
    }
    requireMetadata(selection.capture && typeof selection.capture === 'object' && !Array.isArray(selection.capture), 'INVALID_CONFIG');
    validateMcpObservedCapture(selection.capture);
  } catch (error) {
    throw Object.assign(new Error('Proof selection.capture must be an unchanged valid capture object or a bounded JSON capture file inside the trusted workspace (relative paths resolve from --project).'),
      { code: 'PROOF_CAPTURE_INVALID', field: 'capture',
        reason: ['INVALID_CONFIG', 'METADATA_INVALID', 'METADATA_STALE', 'METADATA_MISMATCH', 'SENSITIVE_INPUT', 'ENOENT', 'LIMIT'].includes(error.code)
          ? error.code : error instanceof SyntaxError ? 'INVALID_JSON' : 'INVALID_CAPTURE' });
  }
  return selection;
}
async function readyProject(projectDir) {
  const project = await readMcpServerProject(projectDir);
  const readiness = await planMcpServerCapture(project.projectDir);
  if (project.review.input.schemaVersion === 3) {
    await readExperimentalConfiguration(project.projectDir);
    requireMetadata(readiness.gatewayLifecycle === 'configuration-observed-not-runtime-tested', 'DEPLOYMENT_CHECKPOINT_REQUIRED');
    return { ...project, readiness };
  }
  requireMetadata(project.review.descriptor.kind === 'existing-mcp'
    || readiness.gatewayLifecycle === 'completed-not-runtime-tested', 'DEPLOYMENT_CHECKPOINT_REQUIRED');
  return { ...project, readiness };
}
function legacyPlan(value) {
  const { approvalDigest, executionVersion, proofHistory, ...base } = value;
  return boundedSnapshot({ ...base, approvalDigest: metadataDigest(boundedSnapshot(base)) });
}
async function plan(projectDir, options, proof = false, excludeAttempt) {
  const qualification = proof === 'qualification';
  const project = await readyProject(projectDir);
  if (proof) options = await resolveMcpProofSelection(project.projectDir, options);
  const accepted = proof && Object.hasOwn(options, 'acceptanceProfile');
  requireMetadata(!accepted || !qualification && isTavilyProject(project) && options.acceptanceProfile === qualificationKind,
    'ACCEPTANCE_PROFILE_UNSUPPORTED');
  const mapping = proof && !qualification && !accepted ? await planNativeGetMapping(project, options) : undefined;
  let operation = accepted ? planMcpAcceptedProof(project.review.descriptor, options)
    : mapping ? planMcpProjectMappedProof(project.review.descriptor, options, mapping)
    : proof ? planMcpReadOnlyProof(project.review.descriptor, options)
    : planMcpDiscovery(project.review.descriptor, options);
  const value = { schemaVersion: 1, action: qualification ? qualificationAction : proof ? 'standalone-mcp-project-proof' : 'standalone-mcp-project-discovery',
    projectDir: project.projectDir, reviewDigest: project.review.reviewDigest,
    readiness: project.readiness, operation };
  if (proof) {
    value.proofHistory = await readMcpProofHistory(project.projectDir, legacyPlan(value), excludeAttempt);
    value.executionVersion = 2;
    if (accepted) {
      value.executionVersion = 4;
      assertMcpProofHistory(value.proofHistory, undefined, operation.approvalDigest, operation, true);
    }
    if (qualification) {
      const binding = qualificationBinding(project, options, value.proofHistory, operation);
      operation = planMcpQualifiedProof(project.review.descriptor, options, binding);
      value.operation = operation;
      value.executionVersion = 3;
      const gates = await import('./mcp-auth-rejection.js');
      value.rejectionHistory = { caller: await gates.readMcpAuthRejections(project.projectDir),
        provider: await gates.readMcpBackendRejections(project.projectDir) };
    }
  }
  return boundedSnapshot({ ...value, approvalDigest: metadataDigest(boundedSnapshot(value)) });
}
export const planMcpProjectDiscovery = (projectDir, options = {}) => plan(projectDir, options);
export const planMcpProjectProof = (projectDir, options) => plan(projectDir, options, true);
export const planMcpProjectQualification = (projectDir, options) => plan(projectDir, options, 'qualification');

export async function planMcpProofPreflight(projectDir, selection) {
  const proof = await planMcpProjectProof(projectDir, selection);
  requireMetadata(proof.operation.nativeGetMapping, 'READ_ONLY_REVIEW_REQUIRED');
  assertMcpProofHistory(proof.proofHistory, proof.approvalDigest, proof.operation.approvalDigest);
  const value = { schemaVersion: 1, action: 'standalone-mcp-proof-preflight', proof,
    effects: [proof.operation.nativeGetMapping.kind === 'native-apim-graph-organization-get'
      ? 'Only exact reviewed ARM, directory principal/role/assignment metadata and isolated Azure identity checks; no Graph organization request, MCP sign-in or tools/call.'
      : 'Only the exact reviewed native mapping ARM reads and isolated Azure identity checks; no MCP sign-in or tools/call.',
      'Diagnostic only: no observation, dispatch record or reusable mapping receipt is written. Ordinary proof must re-list and verify again.'] };
  return boundedSnapshot({ ...value, approvalDigest: metadataDigest(boundedSnapshot(value)) });
}

export async function preflightMcpProof(projectDir, selection, { approval, allowCloud, runAzure, signal } = {}) {
  const reviewed = await planMcpProofPreflight(projectDir, selection);
  requireMetadata(allowCloud === true && approval === reviewed.approvalDigest, 'APPROVAL_REQUIRED');
  const controller = new AbortController(), cancel = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, reviewed.proof.operation.nativeGetMapping.maximumReadbackMs);
  const guard = async () => {
    requireMetadata(!controller.signal.aborted, 'ABORTED');
    requireMetadata(equal(await planMcpProofPreflight(projectDir, selection), reviewed), 'METADATA_MISMATCH');
  };
  try {
    await guard();
    const readback = await verifyNativeGetMapping(await readyProject(projectDir), reviewed.proof.operation.nativeGetMapping,
      { run: runAzure, signal: controller.signal, guard });
    return { status: 'mapping-preflight-passed-not-invoked', approvalDigest: reviewed.approvalDigest,
      mappingDigest: readback.mappingDigest, verifiedAt: readback.verifiedAt,
      next: 'Review the ordinary proof plan and execute once only when ready. Fresh re-list and mapping verification remain mandatory.',
      reusableEvidence: false, toolDispatched: false };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort(); }
}

async function writeNew(filename, value) {
  const text = savedJson(value);
  const handle = await open(filename, 'wx', 0o600);
  try { await handle.writeFile(text); await handle.sync(); }
  finally { await handle.close(); }
  requireMetadata(await readFile(filename, 'utf8') === text, 'METADATA_MISMATCH');
}
async function readRecord(filename, maximum) {
  await assertProjectPath(filename);
  const stat = await lstat(filename);
  requireMetadata(stat.isFile() && stat.size <= maximum, 'LIMIT');
  const bytes = await readFile(filename);
  requireMetadata(bytes.length <= maximum, 'LIMIT');
  return boundedSnapshot(JSON.parse(bytes), maximum);
}
async function executeUnlocked(project, options = {}, proof = false, testRun, runAzure) {
  const projectDir = project.projectDir;
  const qualification = proof === 'qualification';
  requireMetadata(options.allowNetwork === true, 'NETWORK_APPROVAL_REQUIRED');
  requireMetadata(Object.keys(options).every(key => ['approval', 'allowNetwork', 'allowCloud', 'signal', 'onDeviceCode', 'selection'].includes(key)),
    'INVALID_CONFIG');
  const selection = boundedSnapshot(options.selection ?? {});
  const reviewed = await plan(projectDir, selection, proof);
  if (proof) assertMcpProofHistory(reviewed.proofHistory, reviewed.approvalDigest, reviewed.operation.approvalDigest,
    reviewed.operation, isTavilyProject(project));
  requireMetadata(options.approval && equal(options.approval, reviewed), 'APPROVAL_REQUIRED');
  const mapping = reviewed.operation.nativeGetMapping;
  requireMetadata(!mapping || options.allowCloud === true, 'CLOUD_APPROVAL_REQUIRED');
  requireMetadata(options.allowCloud === undefined || Boolean(mapping), 'INVALID_CONFIG');
  requireMetadata(!options.signal?.aborted, 'ABORTED');
  const guard = async () => {
    requireMetadata(!options.signal?.aborted, 'ABORTED');
    requireMetadata(equal(await plan(projectDir, selection, proof, output && path.basename(output)), reviewed), 'METADATA_MISMATCH');
    if (intent) requireMetadata(equal(await readRecord(path.join(output, 'intent.json'), 1048576), intent), 'METADATA_MISMATCH');
  };
  const lockFile = await assertProjectPath(path.join(reviewed.projectDir, '.mcp-network.lock'));
  const lock = await open(lockFile, 'wx', 0o600);
  let output, intent;
  let dispatchAttempted = false;
  let proofReturned = false;
  let mappingReadback, mappingFailure;
  try {
    await guard();
    const directory = await assertProjectPath(path.join(reviewed.projectDir, '.mcp-observations'));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    output = await assertProjectPath(path.join(directory, randomUUID()));
    await mkdir(output, { mode: 0o700 });
    intent = { schemaVersion: 1, approvalDigest: reviewed.approvalDigest,
      action: reviewed.action, status: 'started', startedAt: new Date().toISOString(),
      reviewDigest: reviewed.reviewDigest, operationDigest: reviewed.operation.approvalDigest,
      ...(proof ? { executionVersion: reviewed.executionVersion, previousHistoryDigest: reviewed.proofHistory.historyDigest,
        ...(reviewed.operation.acceptanceProfile ? { acceptanceProfile: firstCallProfileBinding() } : {}),
        ...(qualification ? { qualification: reviewed.operation.qualification } : {}),
        ...(!qualification && !reviewed.operation.acceptanceProfile && reviewed.proofHistory.attempts.some(item => item.evidence === 'legacy-authentication-timeout')
          ? { legacyRecoveryPlan: legacyPlan(reviewed) } : {}) } : {}) };
    await writeNew(path.join(output, 'intent.json'), intent);
    const beforeToolDispatch = proof ? async () => {
      requireMetadata(!dispatchAttempted, 'PROOF_REPLAY_BLOCKED');
      dispatchAttempted = true;
      await guard();
      const record = { schemaVersion: 1, kind: 'standalone-mcp-proof-dispatch',
        intentDigest: metadataDigest(boundedSnapshot(intent)), operationDigest: reviewed.operation.approvalDigest,
        preparedAt: new Date().toISOString() };
      await writeNew(path.join(output, 'dispatch.json'), { ...record, receiptDigest: metadataDigest(boundedSnapshot(record)) });
      await guard();
      cliStage('dispatch-prepared');
    } : undefined;
    const beforeToolCall = mapping ? async signal => {
      let proofStage = 'project-guard';
      try {
        requireMetadata(!mappingReadback, 'PROOF_REPLAY_BLOCKED');
        mappingReadback = await verifyNativeGetMapping(await readyProject(projectDir), mapping,
          { run: runAzure, signal, guard });
        proofStage = 'readback-persist';
        await writeNew(path.join(output, 'mapping-readback.json'), mappingReadback);
        proofStage = 'project-guard';
        await guard();
      } catch (error) {
        mappingFailure = nativeProofFailure(error, { proofStage, resource: 'project' });
        throw mappingFailure;
      }
    } : undefined;
    const run = testRun ?? (reviewed.operation.acceptanceProfile
      ? (source, execution) => runMcpAcceptedProof(source, execution, { beforeRequest: guard, beforeToolDispatch })
      : qualification
      ? (source, execution) => runMcpQualifiedProof(source, execution, reviewed.operation.qualification, { beforeRequest: guard, beforeToolDispatch })
      : mapping
      ? (source, execution) => runMcpProjectMappedProof(source, execution, mapping, { beforeRequest: guard, beforeToolCall, beforeToolDispatch })
      : proof ? runMcpReadOnlyProofWithGuard : discoverMcpToolsWithGuard);
    let result = await run(reviewed.operation.source, { ...(proof ? await resolveMcpProofSelection(projectDir, selection) : selection), approval: reviewed.operation,
      allowNetwork: true, signal: options.signal, onDeviceCode: options.onDeviceCode }, guard, { mapping, beforeToolCall, beforeToolDispatch });
    proofReturned = proof;
    requireMetadata(!proof || dispatchAttempted, 'METADATA_MISMATCH');
    if (mapping) {
      requireMetadata(mappingReadback, 'APIM_PROOF_MAPPING_MISMATCH');
      const { receiptDigest, ...record } = result;
      const withReadback = { ...record, nativeGetReadback: mappingReadback };
      result = boundedSnapshot({ ...withReadback, receiptDigest: metadataDigest(boundedSnapshot(withReadback)) });
    }
    await guard();
    const filename = path.join(output, qualification ? 'qualification.json' : proof ? 'proof.json' : 'capture.json');
    cliStage('publication');
    await writeNew(filename, result);
    return { outputDir: output, resultFile: filename, result,
      descriptorStatus: reviewed.operation.source.status, coworkRuntimeVerified: false };
  } catch (error) {
    error = mappingFailure ?? error;
    if (output) {
      const diagnostics = mcpFailureDiagnostics(error.diagnostics);
      const failure = { schemaVersion: proof ? 3 : 2,
        status: proof ? intent && !dispatchAttempted && !proofReturned && error.invocationStatus !== 'unknown' ? 'not-dispatched' : 'unknown-no-replay' : 'failed-no-capture',
        errorCode: /^[A-Z][A-Z_]{1,60}$/.test(error.code ?? '') ? error.code : 'OPERATION_FAILED',
        finishedAt: new Date().toISOString(),
        intentDigest: metadataDigest(boundedSnapshot(intent)),
        ...(diagnostics ? { diagnostics } : {}),
        ...(proof ? { dispatchContract: 'write-ahead-tools-call-v1' } : {}) };
      await writeNew(path.join(output, 'failure.json'), { ...failure, failureDigest: metadataDigest(boundedSnapshot(failure)) });
    }
    throw error;
  } finally { await lock.close(); await unlink(lockFile); }
}
async function execute(projectDir, options, proof, testRun, runAzure) {
  const project = await readMcpServerProject(projectDir);
  const run = () => executeUnlocked(project, options, proof, testRun, runAzure);
  return project.review.input.schemaVersion === 3 ? withControlLock(project.projectDir, run) : run();
}
export const discoverMcpProjectTools = (projectDir, options) => execute(projectDir, options);
export const runMcpProjectProof = (projectDir, options, { runAzure } = {}) => execute(projectDir, options, true, undefined, runAzure);
export const runMcpProjectQualification = (projectDir, options) => execute(projectDir, options, 'qualification');
export const executeMcpProjectForTest = (projectDir, options, proof, run, runAzure) => execute(projectDir, options, proof, run, runAzure);
