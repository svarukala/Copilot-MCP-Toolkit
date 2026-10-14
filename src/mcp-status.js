import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { readMcpServerProject, readMcpLifecycleAttempts } from './mcp-lifecycle.js';
import { readMcpProofHistory } from './mcp-proof-history.js';
import { validateMcpObservedCapture, mcpCaptureFreshness } from './mcp-discovery.js';
import { readControl } from './mcp-control.js';
import { assertProjectPath } from './config.js';
import { metadataDigest, boundedSnapshot, requireMetadata } from './anonymous-metadata.js';
import { readMcpAuthRejections, readMcpBackendRejections } from './mcp-auth-rejection.js';
import { experimentalConfigurationStatus } from './mcp-configuration.js';
import { validQualificationAssertion } from './mcp-tavily-qualification.js';

export async function readMcpStatus(projectDir, { journey = false } = {}) {
  const project = await readMcpServerProject(projectDir);
  const lifecycle = await readMcpLifecycleAttempts(project.projectDir);
  const proofs = await readMcpProofHistory(project.projectDir);
  const authRejections = await readMcpAuthRejections(project.projectDir);
  const proofResults = [];
  for (const attempt of proofs.attempts) {
    if (attempt.status !== 'completed') { proofResults.push(attempt); continue; }
    const proof = await readControl(path.join(project.projectDir, '.mcp-observations', attempt.attemptId,
      attempt.qualification ? 'qualification.json' : 'proof.json'), 65536);
    const { receiptDigest, ...body } = proof;
    requireMetadata(receiptDigest === metadataDigest(boundedSnapshot(body))
      && proof.approvalDigest === attempt.operationDigest
      && ['protocol-success', 'tool-error'].includes(proof.status), 'METADATA_MISMATCH');
    const assertion = proof.backendAssertion;
    if (assertion) requireMetadata(attempt.qualification || attempt.acceptanceProfile ? validQualificationAssertion(assertion)
      : ['legiscan-bill-v1', 'controlled-delegated-v1', 'graph-organization-v1'].includes(assertion.kind)
        && ['passed', 'failed', 'not-evaluated'].includes(assertion.status), 'METADATA_MISMATCH');
    proofResults.push({ ...attempt, protocolStatus: proof.status,
      ...(assertion ? { backendAssertion: attempt.qualification || attempt.acceptanceProfile ? assertion : { kind: assertion.kind, status: assertion.status } } : {}) });
  }
  const observations = [];
  const directory = await assertProjectPath(path.join(project.projectDir, '.mcp-observations'));
  let names;
  try { names = await readdir(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
  requireMetadata(names.length <= 1000, 'LIMIT');
  for (const name of names.sort()) {
    requireMetadata(/^[0-9a-f-]{36}$/.test(name), 'METADATA_MISMATCH');
    const intent = await readControl(path.join(directory, name, 'intent.json'));
    if (intent.action !== 'standalone-mcp-project-discovery') continue;
    let capture;
    try { capture = await readControl(path.join(directory, name, 'capture.json')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const failure = proofs.attempts.find(attempt => attempt.attemptId === name);
      observations.push({ attemptId: name, status: 'no-capture',
        ...(failure?.failureCode ? { failureCode: failure.failureCode } : {}),
        ...(failure?.diagnostics ? { diagnostics: failure.diagnostics, next: failure.next } : {}) });
      continue;
    }
    let status = 'valid', freshness;
    try {
      if (journey) { freshness = mcpCaptureFreshness(capture); status = freshness.status; }
      else validateMcpObservedCapture(capture);
      requireMetadata(capture.source.descriptorDigest === project.review.descriptor.descriptorDigest, 'METADATA_MISMATCH');
    } catch (error) {
      if (!['METADATA_STALE', 'METADATA_MISMATCH', 'METADATA_INVALID', 'SENSITIVE_INPUT', 'INVALID_CONFIG', 'LIMIT'].includes(error.code)) throw error;
      status = error.code === 'METADATA_STALE' ? 'stale' : 'invalid';
    }
    observations.push({ attemptId: name, status, ...(freshness && status !== 'invalid' ? { freshness } : {}),
      ...(status === 'valid' ? { evidence: capture.evidence, tools: capture.tools.tools.length, capturedAt: capture.capturedAt } : {}) });
  }
  const unsettled = lifecycle.some(record => !['completed', 'reconciled'].includes(record.status));
  const gateway = !unsettled && lifecycle.some(record => record.phase === 'gateway' && record.status === 'completed'
    && record.reviewDigest === project.review.reviewDigest);
  const configuration = project.review.input.schemaVersion === 3
    ? await experimentalConfigurationStatus(project.projectDir, { includeExpired: journey }) : undefined;
  const backendRejections = configuration ? await readMcpBackendRejections(project.projectDir) : undefined;
  return { schemaVersion: 1, status: 'local-evidence-only', reviewDigest: project.review.reviewDigest,
    ...(project.review.input.schemaVersion === 3 ? { experimental: {
      profile: project.review.input.experimentalProfile, status: 'experimental-not-forwarding-verified',
      configuration,
    } } : {}),
    descriptorStatus: project.review.descriptor.status,
    deployment: project.review.descriptor.kind === 'existing-mcp' ? 'not-managed' : unsettled ? 'unresolved' : gateway ? 'recorded-completed' : 'not-verified',
    observations, proofs: proofResults.filter(item => !item.qualification), authRejections,
    ...(configuration ? { qualifications: proofResults.filter(item => item.qualification), backendRejections,
      backendCredentialPropagationVerified: false, businessCorrectnessVerified: false } : {}),
    historyDigest: metadataDigest(boundedSnapshot({ lifecycle, proofs, observations, authRejections,
      ...(backendRejections ? { backendRejections } : {}) })),
    coworkRuntimeVerified: false, replayAuthorized: false,
    evidenceSemantics: 'The descriptor is immutable generation/reference evidence. Deployment, discovery, proof and auth-rejection records are separate historical observations, not live health or renewed authority.',
    next: configuration && proofs.attempts.some(attempt => attempt.status === 'unresolved')
      ? 'Unknown/sent proof outcome remains blocked. Refreshing 15-minute configuration evidence cannot authorize a tool retry; preserve the proof journal.'
      : configuration && configuration.status !== 'valid' ? configuration.next
      : unsettled ? 'Preserve attempts; review mcp-reconcile-plan and approved readback before any fresh phase approval.'
      : proofs.attempts.some(attempt => attempt.status === 'unresolved') ? 'Unknown/sent proof outcome blocks subsequent proof. Preserve history; do not replay or edit journals.'
        : proofs.attempts.some(attempt => attempt.status === 'completed') ? 'Completed calls must not be replayed. Review retained proof evidence; protocol success alone is not backend or Cowork acceptance.'
          : proofs.attempts.some(attempt => attempt.status === 'not-dispatched') ? proofs.attempts.findLast(attempt => attempt.status === 'not-dispatched').next
            ?? 'Only verified not-dispatched history permits a fresh reviewed proof plan; run native mapping preflight before another sign-in.'
            : observations.findLast(item => item.next)?.next
              ?? (observations.some(item => item.status === 'valid') ? 'Discovery is metadata only. Review a separate one-call proof; native mappings support mcp-proof-preflight-plan.'
              : 'Complete the separate deployment prerequisites, then review genuine discovery. Never fabricate or refresh capture timestamps.') };
}
