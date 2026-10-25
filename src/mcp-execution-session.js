import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { boundedSnapshot, metadataDigest, requireMetadata } from './anonymous-metadata.js';
import { withCliWorkspace } from './config.js';
import { readControl } from './mcp-control.js';
import { planInteractiveSession, runInteractiveSession } from './mcp-interactive-session.js';
import { planMcpProjectProof } from './mcp-discovery-project.js';
import { assertMcpProofHistory } from './mcp-proof-history.js';
import { checkedResultAssertion } from './mcp-result-assertion.js';
import { secretIssues } from './validation.js';

export const executionSessionContractVersion = 1;
const digest = value => metadataDigest(boundedSnapshot(value));
const equal = (left, right) => digest(left) === digest(right);
const usedSessions = new Set();

function projection(options, childPlan, configDigest, minimumProofDelayMs) {
  requireMetadata(Number.isInteger(minimumProofDelayMs) && minimumProofDelayMs >= 0
    && minimumProofDelayMs <= 65000, 'INVALID_CONFIG');
  const discovery = childPlan.discovery?.operation, proof = childPlan.proofSelection;
  requireMetadata(childPlan.action === 'mcp-session' && childPlan.maximumSessionMs === 900000
    && childPlan.tokenPersistence === 'none' && childPlan.proofAuthorized === false
    && discovery?.source.kind === 'existing-mcp' && discovery.auth?.expectedUserId
    && proof && Object.keys(proof).every(key => ['toolName', 'arguments', 'safetyReview', 'resultAssertion'].includes(key))
    && typeof proof.toolName === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(proof.toolName)
    && equal(proof.arguments, {}) && proof.safetyReview?.readOnly === true
    && Object.keys(proof.safetyReview).sort().join(',') === 'readOnly,reason'
    && typeof proof.safetyReview.reason === 'string' && proof.safetyReview.reason.trim().length >= 12
    && proof.safetyReview.reason.length <= 1024, 'INVALID_CONFIG');
  const resultAssertion = proof.resultAssertion === undefined ? null : checkedResultAssertion(proof.resultAssertion);
  const body = boundedSnapshot({
    schemaVersion: executionSessionContractVersion, kind: 'bounded-mcp-execution-session',
    projectDir: childPlan.projectDir, configPath: path.resolve(options.config), configDigest,
    sessionApprovalDigest: childPlan.approvalDigest, producerBuild: childPlan.producerBuild,
    reviewDigest: childPlan.discovery.reviewDigest, sourceDigest: discovery.source.descriptorDigest,
    endpoint: discovery.target.endpoint, auth: discovery.auth,
    discoveryOperationDigest: discovery.approvalDigest,
    proof: { toolName: proof.toolName, argumentsDigest: digest(proof.arguments),
      safetyReview: proof.safetyReview, resultAssertion },
    minimumProofDelayMs, maximumSessionMs: childPlan.maximumSessionMs, tokenPersistence: 'none',
  });
  requireMetadata(!secretIssues(JSON.stringify(body)), 'SENSITIVE_INPUT');
  return boundedSnapshot({ ...body, authorizationDigest: digest(body) });
}

// This projection carries no new authority; the caller must bind it to its reviewed parent envelope.
export async function planExecutionSession(options, { minimumProofDelayMs = 65000 } = {}) {
  const before = await withCliWorkspace(options.workspaceRoot, () => readControl(path.resolve(options.config)));
  const childPlan = await planInteractiveSession(options);
  const config = await withCliWorkspace(options.workspaceRoot, () => readControl(path.resolve(options.config)));
  requireMetadata(equal(config, before), 'METADATA_MISMATCH');
  return projection(options, childPlan, digest(config), minimumProofDelayMs);
}

export function createExecutionProofApproval({ options, childPlan, authorization, signal, beforeProof }, dependencies = {}) {
  const selected = { project: options.project, workspaceRoot: options.workspaceRoot, config: options.config };
  const expected = boundedSnapshot(authorization), reviewed = boundedSnapshot(childPlan);
  requireMetadata(equal(expected, projection(selected, reviewed, expected.configDigest, expected.minimumProofDelayMs)),
    'APPROVAL_REQUIRED');
  const now = dependencies.now ?? Date.now, deadline = now() + expected.maximumSessionMs;
  const wait = dependencies.waitForProof ?? ((milliseconds, cancellation) => delay(milliseconds, undefined, { signal: cancellation }));
  let used = false;
  return async (actual, sessionSignal) => {
    requireMetadata(!used, 'PROOF_REPLAY_BLOCKED');
    used = true;
    const proof = boundedSnapshot(actual);
    const signals = [signal, sessionSignal].filter(Boolean);
    const cancellation = signals.length ? AbortSignal.any(signals) : undefined;
    const budget = remainingDelay => {
      requireMetadata(!cancellation?.aborted, 'ABORTED');
      requireMetadata(now() + remainingDelay + reviewed.discovery.operation.metadataTimeoutMs < deadline,
        'AUTH_SESSION_EXPIRED');
    };
    const guard = async remainingDelay => {
      budget(remainingDelay);
      await beforeProof?.();
      budget(remainingDelay);
      requireMetadata(equal(await planExecutionSession(selected, { minimumProofDelayMs: expected.minimumProofDelayMs }), expected),
        'METADATA_MISMATCH');
      const operation = proof.operation;
      requireMetadata(proof.action === 'standalone-mcp-project-proof' && proof.executionVersion === 2
        && proof.projectDir === expected.projectDir && proof.reviewDigest === expected.reviewDigest
        && operation?.action === 'standalone-mcp-read-only-proof'
        && operation.source.descriptorDigest === expected.sourceDigest
        && operation.source.endpoint === expected.endpoint
        && equal(operation.source, reviewed.discovery.operation.source)
        && equal(operation.discoveryPlan, reviewed.discovery.operation)
        && equal(operation.discoveryPlan.auth, expected.auth)
        && operation.tool.name === expected.proof.toolName
        && operation.tool.annotations?.readOnlyHint === true && operation.tool.annotations?.destructiveHint === false
        && digest(operation.arguments) === expected.proof.argumentsDigest && equal(operation.arguments, {})
        && equal(operation.safetyReview, { ...expected.proof.safetyReview, verified: false })
        && equal(operation.resultAssertion ?? null, expected.proof.resultAssertion)
        && !operation.nativeGetMapping && !operation.acceptanceProfile && !operation.qualification, 'METADATA_MISMATCH');
      assertMcpProofHistory(proof.proofHistory, proof.approvalDigest, operation.approvalDigest, operation, true);
      const current = await withCliWorkspace(selected.workspaceRoot, () => planMcpProjectProof(selected.project,
        { ...reviewed.proofSelection, capture: operation.capture }));
      requireMetadata(equal(current, proof), 'METADATA_MISMATCH');
      assertMcpProofHistory(current.proofHistory, current.approvalDigest, current.operation.approvalDigest, current.operation, true);
      budget(remainingDelay);
    };
    await guard(expected.minimumProofDelayMs);
    await wait(expected.minimumProofDelayMs, cancellation);
    await guard(0);
    requireMetadata(equal(actual, proof), 'METADATA_MISMATCH');
    return proof.approvalDigest;
  };
}

export async function runExecutionSession(options, authorization, dependencies = {}) {
  const expected = boundedSnapshot(authorization);
  const childPlan = await planInteractiveSession(options);
  requireMetadata(options.approval === childPlan.approvalDigest && options.allowNetwork === true
    && typeof options.onDeviceCode === 'function'
    && equal(await planExecutionSession(options, { minimumProofDelayMs: expected.minimumProofDelayMs }), expected),
  'APPROVAL_REQUIRED');
  requireMetadata(!usedSessions.has(expected.authorizationDigest), 'PROOF_REPLAY_BLOCKED');
  requireMetadata(!options.signal?.aborted, 'ABORTED');
  const approveProof = createExecutionProofApproval({ options, childPlan, authorization: expected,
    signal: options.signal, beforeProof: dependencies.validationGuard }, dependencies);
  usedSessions.add(expected.authorizationDigest);
  return runInteractiveSession({ ...options, approveProof }, dependencies);
}
