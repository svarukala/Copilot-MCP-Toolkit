import { safeEntraDiagnostics } from './entra-discovery.js';
import { sanitizeNativeProofDiagnostics } from './mcp-native-proof.js';
import { boundedSnapshot, metadataDigest } from './anonymous-metadata.js';
import { safeMcpDiagnostics } from './mcp-protocol.js';
import { qualificationAction } from './mcp-tavily-qualification.js';

export function mcpFailureDiagnostics(value) {
  return safeEntraDiagnostics(value) ?? sanitizeNativeProofDiagnostics(value) ?? safeMcpDiagnostics(value);
}

export function validMcpFailure(value, intent) {
  if (!value || !intent) return false;
  const proof = intent.action === 'standalone-mcp-project-proof' || intent.action === qualificationAction;
  const fields = ['schemaVersion', 'status', 'errorCode', 'finishedAt', 'intentDigest', 'failureDigest',
    ...(proof ? ['dispatchContract'] : []), ...(value.diagnostics === undefined ? [] : ['diagnostics'])];
  if (Object.keys(value).sort().join(',') !== fields.sort().join(',')
    || value.schemaVersion !== (proof ? 3 : 2)
    || !(proof ? ['not-dispatched', 'unknown-no-replay'] : ['failed-no-capture']).includes(value.status)
    || proof && value.dispatchContract !== 'write-ahead-tools-call-v1'
    || !/^[A-Z][A-Z_]{1,60}$/.test(value.errorCode ?? '')
    || !Number.isFinite(Date.parse(value.finishedAt))
    || !Number.isFinite(Date.parse(intent.startedAt))
    || new Date(value.finishedAt).toISOString() !== value.finishedAt
    || Date.parse(value.finishedAt) < Date.parse(intent.startedAt) || Date.parse(value.finishedAt) > Date.now()
    || value.intentDigest !== metadataDigest(boundedSnapshot(intent))) return false;
  const diagnostics = mcpFailureDiagnostics(value.diagnostics);
  if (value.diagnostics !== undefined && (!diagnostics
    || metadataDigest(boundedSnapshot(value.diagnostics)) !== metadataDigest(boundedSnapshot(diagnostics)))) return false;
  const { failureDigest, ...body } = value;
  return failureDigest === metadataDigest(boundedSnapshot(body));
}

export function mcpFailureGuidance(diagnostics, status) {
  const dispatch = status === 'unknown-no-replay'
    ? ' A request may have been sent. Preserve history; do not replay.'
    : ' Keep history. Only validated not-dispatched proof evidence permits a separately reviewed restart; never automatically retry.';
  if (diagnostics?.proofStage) return `Native inspection failed at ${diagnostics.proofStage}/${diagnostics.resource}${diagnostics.predicate ? `/${diagnostics.predicate}` : ''} (${diagnostics.causeCode ?? diagnostics.failureKind}). Use the exact approved read-only inspection or preflight to diagnose this stage before another device sign-in; a read failure is not proof of resource drift.${dispatch}`;
  if (diagnostics?.authStage === 'metadata' || diagnostics?.rpcMethod) {
    const stage = diagnostics.rpcMethod
      ? `${diagnostics.rpcMethod}/${diagnostics.rpcStage}${diagnostics.toolSchemaIssue ? `/${diagnostics.toolSchemaIssue}` : ''}` : 'metadata/unspecified';
    return `MCP metadata/protocol processing failed at ${stage}${diagnostics.httpStatus ? ` (HTTP ${diagnostics.httpStatus})` : ''}. ${diagnostics.authStage === 'metadata'
      ? 'Runtime token validation had completed before this stage; this does not establish that the endpoint accepted the token or that consent failed. '
      : ''}HTTP 200 alone does not establish valid MCP JSON-RPC, initialization or tool schemas. Ask the endpoint owner to inspect the indicated protocol stage using existing server-side evidence; do not relax validation, grant permissions or initiate another sign-in merely to diagnose it.${dispatch}`;
  }
  if (diagnostics?.authStage) {
    const cause = ['transport', 'timeout'].includes(diagnostics.failureKind)
      ? 'Check connectivity and TLS trust for the reviewed authentication endpoint. Transport/timeout evidence does not establish consent or permission denial.'
      : 'Inspect the recorded authentication stage with the identity owner. HTTP/SDK/response failure alone does not identify a consent or permission denial; do not grant permissions based on it.';
    return `Runtime authentication failed at ${diagnostics.authStage}/${diagnostics.failureKind}${diagnostics.httpStatus ? ` (HTTP ${diagnostics.httpStatus})` : ''}. ${cause} Azure CLI account selection is separate from MCP runtime sign-in.${dispatch}`;
  }
  return undefined;
}
