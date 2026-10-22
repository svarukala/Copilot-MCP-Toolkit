import path from 'node:path';
import { assertProjectPath, withCliWorkspace } from './config.js';
import { boundedSnapshot, metadataDigest, requireMetadata } from './anonymous-metadata.js';
import { readControl } from './mcp-control.js';
import { getLibraryInfo } from './machine-contract.js';
import { createEntraDiscoverySession } from './entra-discovery.js';
import { planMcpProjectDiscovery, planMcpProjectProof, runMcpProjectSessionOperation } from './mcp-discovery-project.js';
import { assertMcpProofHistory } from './mcp-proof-history.js';

async function prepare(options) {
  const project = await assertProjectPath(path.resolve(options.project));
  const input = await readControl(path.resolve(options.config));
  requireMetadata(input && Object.keys(input).sort().join(',') === 'discovery,proof,schemaVersion'
    && input.schemaVersion === 1 && input.proof && !Array.isArray(input.proof)
    && Object.keys(input.proof).every(key => ['toolName', 'arguments', 'safetyReview', 'resultAssertion'].includes(key))
    && typeof input.proof.toolName === 'string' && input.proof.arguments && input.proof.safetyReview,
  'INVALID_CONFIG');
  const discovery = await planMcpProjectDiscovery(project, input.discovery);
  requireMetadata(discovery.operation.source.kind === 'existing-mcp' && discovery.operation.auth?.expectedUserId,
    'AUTH_CONFIG_INVALID');
  const info = await getLibraryInfo();
  const body = { action: 'mcp-session', projectDir: project, discovery, proofSelection: input.proof,
    producerBuild: info.contentDigest, maximumSessionMs: 900000,
    proofAuthorized: false, tokenPersistence: 'none',
    effects: ['Authenticate for the exact expected user and perform metadata-only discovery.',
      'Show a new exact proof plan using the returned capture; require a separate terminal approval.',
      'Reuse only the unexpired in-memory token, re-list tools, then dispatch at most one approved call.',
      'No token refresh, automatic sign-in restart, consumed-proof replay or consumer verification.'] };
  return boundedSnapshot({ ...body, approvalDigest: metadataDigest(boundedSnapshot(body)) });
}
function scoped(options, action) {
  requireMetadata(typeof options.workspaceRoot === 'string' && typeof options.project === 'string'
    && typeof options.config === 'string', 'INVALID_CONFIG');
  return withCliWorkspace(options.workspaceRoot, action);
}
export const planInteractiveSession = options => scoped(options, () => prepare(options));
export const runInteractiveSession = (options, dependencies = {}) => scoped(options, async () => {
  const reviewed = await prepare(options);
  requireMetadata(options.approval === reviewed.approvalDigest && options.allowNetwork === true
    && typeof options.approveProof === 'function' && typeof options.onDeviceCode === 'function', 'APPROVAL_REQUIRED');
  requireMetadata(!options.signal?.aborted, 'ABORTED');
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const session = createEntraDiscoverySession(dependencies);
  const timer = setTimeout(() => controller.abort(), reviewed.maximumSessionMs);
  const clear = () => session.close();
  signal.addEventListener('abort', clear, { once: true });
  try {
    const discovery = await runMcpProjectSessionOperation(reviewed.projectDir, {
      selection: reviewed.discovery.operation.auth
        ? { discoveryClientId: reviewed.discovery.operation.auth.discoveryClientId,
          expectedUserId: reviewed.discovery.operation.auth.expectedUserId } : {},
      approval: reviewed.discovery, allowNetwork: true, onDeviceCode: options.onDeviceCode, signal,
    }, session);
    const selection = { ...reviewed.proofSelection, capture: discovery.resultFile };
    const proof = await planMcpProjectProof(reviewed.projectDir, selection);
    assertMcpProofHistory(proof.proofHistory, proof.approvalDigest, proof.operation.approvalDigest, proof.operation);
    requireMetadata(!signal.aborted, 'AUTH_SESSION_EXPIRED');
    const approval = await options.approveProof(proof, signal);
    requireMetadata(!signal.aborted, 'AUTH_SESSION_EXPIRED');
    if (approval !== proof.approvalDigest) return { status: 'discovered-proof-declined',
      captureFile: discovery.resultFile, proofInvoked: false };
    const result = await runMcpProjectSessionOperation(reviewed.projectDir, {
      selection, approval: proof, allowNetwork: true, onDeviceCode: options.onDeviceCode, signal,
    }, session, true);
    return { status: result.result.status, captureFile: discovery.resultFile, proofFile: result.resultFile,
      ...(result.result.backendAssertion ? { backendAssertion: result.result.backendAssertion } : {}),
      tokenPersistence: 'none', coworkRuntimeVerified: false };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', clear);
    session.close();
    controller.abort();
  }
});
