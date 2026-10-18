import Ajv from 'ajv';
import { validateMcpServerDescriptor } from './mcp-server.js';
import { probeMcp, safeMcpDiagnostics } from './mcp-protocol.js';
import { publicHttpsTransport } from './anonymous-network.js';
import { entraDiscoveryBinding, entraDiscoveryLimits } from './entra-metadata.js';
import { discoverEntraEndpoint, discoverEntraEndpointForTest, safeEntraDiagnostics } from './entra-discovery.js';
import { validateToolDescription } from './mcp-tools.js';
import { secretIssues } from './validation.js';
import { graphOrganizationResponse } from './mcp-graph-organization.js';
import { assessTavilyResult, requireTavilyArguments, qualificationKind, tavilyFirstCallProfile,
  firstCallProfileBinding } from './mcp-tavily-qualification.js';
import { anonymousLimits, boundedSnapshot, metadataDigest, normalizeAnonymousEndpoint, requireMetadata, savedJson } from './anonymous-metadata.js';

export const mcpDiscoveryContractVersion = 1;
const versions = ['2024-11-05', '2025-03-26', '2025-06-18'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const equal = (a, b) => JSON.stringify(boundedSnapshot(a)) === JSON.stringify(boundedSnapshot(b));
const digestRecord = value => boundedSnapshot({ ...value, receiptDigest: metadataDigest(boundedSnapshot(value)) });
function clean(value, maximum) {
  const snapshot = boundedSnapshot(value, maximum);
  requireMetadata(!secretIssues(savedJson(snapshot)), 'SENSITIVE_INPUT');
  return snapshot;
}
function keys(value, allowed) {
  requireMetadata(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key)), 'INVALID_CONFIG');
}
function sourceFor(value) {
  const source = validateMcpServerDescriptor(clean(value));
  requireMetadata(normalizeAnonymousEndpoint(source.endpoint) === source.endpoint, 'ENDPOINT_BLOCKED');
  return source;
}

export function planMcpDiscovery(value, options = {}) {
  const source = sourceFor(value);
  const selection = clean(options);
  keys(selection, ['discoveryClientId', 'expectedUserId']);
  requireMetadata(source.inbound.type !== 'oauth', 'OAUTH_REVIEWED_IMPORT_REQUIRED');
  let auth;
  if (source.inbound.type === 'entra') {
    auth = entraDiscoveryBinding(source.inbound, selection.discoveryClientId);
    requireMetadata(source.inbound.allowedClientIds.some(id => id.toLowerCase() === auth.discoveryClientId),
      'AUTH_CONFIG_INVALID');
    requireMetadata(typeof selection.expectedUserId === 'string' && uuid.test(selection.expectedUserId)
      && selection.expectedUserId !== '00000000-0000-0000-0000-000000000000', 'AUTH_CONFIG_INVALID');
    auth.expectedUserId = selection.expectedUserId.toLowerCase();
  } else requireMetadata(Object.keys(selection).length === 0, 'AUTH_CONFIG_INVALID');
  const plan = { schemaVersion: 1, action: 'standalone-mcp-tools-list', source,
    target: { endpoint: source.endpoint }, ...(auth === undefined ? {} : { auth }),
    authTimeoutMs: auth ? entraDiscoveryLimits.authTimeoutMs : 0,
    metadataTimeoutMs: anonymousLimits.timeoutMs,
    limits: anonymousLimits,
    methods: ['initialize', 'notifications/initialized', 'tools/list'],
    limitations: [
      'Network/login requires separate exact approval; tools/call is not authorized.',
      source.kind === 'native-apim-mcp' && source.inbound.type === 'anonymous'
        ? 'This public endpoint has no MCP discovery-user identity. Azure management identity remains a separate requirement.'
        : 'Runtime discovery user is explicit and independent from the Azure deployment account.',
      ...(source.kind === 'native-apim-mcp' && source.inbound.type === 'anonymous'
        ? ['No MCP caller identity or consent is required. Azure management authorization for deployment and native proof readback remains separate.']
        : ['Existing public discovery-client registration, delegated consent and endpoint authorization are prerequisites, not inferred from app metadata.']),
      'No authentication downgrade, resource mutation, token persistence or automatic retry is performed.',
      'Descriptor status is generation/reference evidence; tools/list is not Cowork runtime acceptance.',
    ] };
  return boundedSnapshot({ ...plan, approvalDigest: metadataDigest(boundedSnapshot(plan)) });
}

function identityOptions(plan) {
  return plan.auth ? { discoveryClientId: plan.auth.discoveryClientId, expectedUserId: plan.auth.expectedUserId } : {};
}

function observedCapture(plan, result) {
  const tools = clean(result.tools, anonymousLimits.captureBytes);
  requireMetadata(Object.keys(tools).length === 1 && Array.isArray(tools.tools)
    && tools.tools.length <= anonymousLimits.tools, 'METADATA_INVALID');
  try { validateToolDescription(tools); } catch { requireMetadata(false, 'METADATA_INVALID'); }
  const timestamp = Date.parse(result.capturedAt);
  requireMetadata(typeof result.capturedAt === 'string' && Number.isFinite(timestamp)
    && new Date(timestamp).toISOString() === result.capturedAt && timestamp <= Date.now(), 'METADATA_STALE');
  requireMetadata(versions.includes(result.protocolVersion), 'METADATA_INVALID');
  return clean(digestRecord({ schemaVersion: 1, kind: 'standalone-mcp-tools-capture', source: plan.source,
    discoveryPlan: plan, capturedAt: result.capturedAt, tools, toolsDigest: metadataDigest(tools),
    evidence: plan.auth ? 'observed-authenticated-discovery' : 'observed-discovery',
    protocolVersion: result.protocolVersion }), anonymousLimits.captureBytes);
}

function checkedCapture(value) {
  const capture = clean(value, anonymousLimits.captureBytes);
  const plan = planMcpDiscovery(capture.source, identityOptions(capture.discoveryPlan ?? {}));
  requireMetadata(equal(capture.discoveryPlan, plan), 'METADATA_MISMATCH');
  const expected = observedCapture(plan, capture);
  requireMetadata(equal(capture, expected), 'METADATA_MISMATCH');
  return expected;
}
export function validateMcpObservedCapture(value, { maxAgeHours = 24 } = {}) {
  requireMetadata(Number.isFinite(maxAgeHours) && maxAgeHours > 0 && maxAgeHours <= 168, 'INVALID_CONFIG');
  const capture = checkedCapture(value);
  requireMetadata(Date.now() - Date.parse(capture.capturedAt) <= maxAgeHours * 3600000, 'METADATA_STALE');
  return capture;
}
// Historical status only. Execution still uses the strict capture validator above.
export function mcpCaptureFreshness(value) {
  const capture = checkedCapture(value);
  const expiresAt = new Date(Date.parse(capture.capturedAt) + 86400000).toISOString();
  return { status: Date.now() <= Date.parse(expiresAt) ? 'valid' : 'stale',
    capturedAt: capture.capturedAt, expiresAt, replayAuthorized: false };
}

async function endpoint(plan, options, dependencies, toolCall) {
  if (plan.auth) {
    const endpointOptions = { ...options, toolCall, beforeRequest: dependencies?.beforeRequest,
      beforeToolCall: dependencies?.beforeToolCall, beforeToolDispatch: dependencies?.beforeToolDispatch,
      assessToolResult: dependencies?.assessToolResult };
    return dependencies ? discoverEntraEndpointForTest(plan, endpointOptions, dependencies)
      : discoverEntraEndpoint(plan, endpointOptions);
  }
  const transport = dependencies?.mcpTransport ?? publicHttpsTransport();
  const result = await probeMcp(plan.source.endpoint, {
    fetchImpl: async (url, requestOptions) => {
      await dependencies?.beforeRequest?.();
      return transport(url, requestOptions);
    }, signal: options.signal,
    returnMetadata: true, timeoutMs: anonymousLimits.timeoutMs,
    maxBytes: anonymousLimits.responseBytes, maxTotalBytes: anonymousLimits.totalResponseBytes,
    maxPages: anonymousLimits.pages, ...(toolCall === undefined ? {} : { toolCall,
      beforeToolCall: dependencies?.beforeToolCall, beforeToolDispatch: dependencies?.beforeToolDispatch,
      assessToolResult: dependencies?.assessToolResult }),
  });
  if (options.signal?.aborted && toolCall !== undefined) {
    throw Object.assign(new Error('ABORTED'), { code: 'ABORTED', invocationStatus: 'unknown' });
  }
  requireMetadata(!options.signal?.aborted, 'ABORTED');
  return { tools: { tools: result.tools }, capturedAt: new Date().toISOString(),
    protocolVersion: result.protocolVersion, ...(result.toolCall === undefined ? {} : { toolCall: result.toolCall }) };
}

function checkedOptions(options, allowed) {
  keys(options, [...allowed, 'approval', 'allowNetwork', 'signal', 'onDeviceCode']);
  requireMetadata(options.allowNetwork === true, 'NETWORK_APPROVAL_REQUIRED');
  requireMetadata(!options.signal?.aborted, 'ABORTED');
}
function safeFailure(error, signal) {
  const diagnostics = safeEntraDiagnostics(error.diagnostics) ?? safeMcpDiagnostics(error.rpcDiagnostics);
  const code = signal?.aborted ? 'ABORTED'
    : ['AUTH_CONFIG_INVALID', 'AUTHENTICATION_FAILED', 'AUTHENTICATION_REJECTED', 'AUTHENTICATION_TIMEOUT',
      'TOKEN_EXPIRED', 'LIMIT', 'SENSITIVE_INPUT', 'NETWORK_BLOCKED', 'METADATA_INVALID',
      'METADATA_STALE', 'DISCOVERY_TIMEOUT'].includes(error.code) ? error.code
      : error.message === 'Probe timeout.' ? 'DISCOVERY_TIMEOUT' : 'DISCOVERY_FAILED';
  return Object.assign(new Error(code), { name: 'AnonymousMetadataError', code,
    ...(diagnostics ? { diagnostics } : {}),
    ...(error.invocationStatus === 'unknown' ? { invocationStatus: 'unknown' } : {}) });
}
async function discover(value, options = {}, dependencies) {
  checkedOptions(options, ['discoveryClientId', 'expectedUserId']);
  const plan = planMcpDiscovery(value, {
    ...(options.discoveryClientId === undefined ? {} : { discoveryClientId: options.discoveryClientId }),
    ...(options.expectedUserId === undefined ? {} : { expectedUserId: options.expectedUserId }),
  });
  requireMetadata(options.approval && equal(options.approval, plan), 'APPROVAL_REQUIRED');
  try { return observedCapture(plan, await endpoint(plan, options, dependencies)); }
  catch (error) { throw safeFailure(error, options.signal); }
}
export const discoverMcpTools = (value, options) => discover(value, options);
export const discoverMcpToolsForTest = (value, options, dependencies) => discover(value, options, dependencies);
export const discoverMcpToolsWithGuard = (value, options, beforeRequest) => discover(value, options, { beforeRequest });

// Deliberately bounded subset: unknown/unsupported JSON Schema keywords fail, never silently disappear.
const schemaKeys = new Set(['type', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems',
  'description', 'title', 'default']);
const nullableScalarKeys = new Set(['type', 'enum', 'const', 'minimum', 'maximum',
  'minLength', 'maxLength', 'description', 'title', 'default']);
function validateProofSchema(schema, depth = 0) {
  requireMetadata(schema && typeof schema === 'object' && !Array.isArray(schema) && depth < 12, 'PROOF_SCHEMA_UNSUPPORTED');
  if (Object.hasOwn(schema, 'anyOf')) {
    requireMetadata(Object.keys(schema).every(key => ['anyOf', 'description', 'title', 'default'].includes(key))
      && Array.isArray(schema.anyOf) && schema.anyOf.length === 2, 'PROOF_SCHEMA_UNSUPPORTED');
    const nullBranch = schema.anyOf.find(branch => branch?.type === 'null');
    const scalarBranch = schema.anyOf.find(branch => ['string', 'number', 'integer', 'boolean'].includes(branch?.type));
    requireMetadata(nullBranch && Object.keys(nullBranch).length === 1 && scalarBranch
      && Object.keys(scalarBranch).every(key => nullableScalarKeys.has(key)), 'PROOF_SCHEMA_UNSUPPORTED');
    for (const branch of schema.anyOf) validateProofSchema(branch, depth + 1);
    return;
  }
  requireMetadata(Object.keys(schema).every(key => schemaKeys.has(key))
    && ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type), 'PROOF_SCHEMA_UNSUPPORTED');
  if (schema.properties) for (const item of Object.values(schema.properties)) validateProofSchema(item, depth + 1);
  if (schema.items) validateProofSchema(schema.items, depth + 1);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateProofSchema(schema.additionalProperties, depth + 1);
}
function rejectCredentialArguments(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    requireMetadata(!/^(?:authorization|cookies?|api[-_]?key|client[-_]?secret|access[-_]?token|refresh[-_]?token|password)$/i.test(key),
      'SENSITIVE_INPUT');
    rejectCredentialArguments(item);
  }
}

function planProof(value, options, nativeGetMapping) {
  const source = sourceFor(value), input = clean(options, anonymousLimits.buildBytes);
  const mappedKey = nativeGetMapping?.kind === 'native-apim-mapped-key-get';
  const delegated = nativeGetMapping?.kind === 'native-apim-controlled-delegated-get';
  const graph = nativeGetMapping?.kind === 'native-apim-graph-organization-get';
  keys(input, ['capture', 'toolName', 'arguments', 'safetyReview', ...(mappedKey || delegated || graph ? ['responseAssertion'] : []),
    ...(delegated ? ['delegatedFixture'] : [])]);
  const capture = validateMcpObservedCapture(input.capture);
  requireMetadata(equal(source, capture.source), 'METADATA_MISMATCH');
  const tool = capture.tools.tools.find(tool => tool.name === input.toolName);
  if (nativeGetMapping) {
    requireMetadata(source.kind === 'native-apim-mcp' && tool && tool.annotations === undefined
      && (nativeGetMapping.kind === 'native-apim-fixed-get' || mappedKey || delegated || graph)
      && nativeGetMapping.sourceDigest === source.descriptorDigest
      && nativeGetMapping.captureDigest === capture.receiptDigest
      && nativeGetMapping.toolName === tool.name && nativeGetMapping.method === 'GET'
      && nativeGetMapping.schemaDigest === metadataDigest(tool.inputSchema)
      && (mappedKey ? nativeGetMapping.argumentsDigest === metadataDigest(input.arguments) : equal(input.arguments, {})),
    'READ_ONLY_REVIEW_REQUIRED');
    requireMetadata(!mappedKey || (input.responseAssertion === undefined ? nativeGetMapping.responseAssertion === undefined
      : input.responseAssertion === 'legiscan-bill-v1' && nativeGetMapping.responseAssertion?.kind === input.responseAssertion
        && nativeGetMapping.responseAssertion.billId === input.arguments.bill_id), 'READ_ONLY_REVIEW_REQUIRED');
    requireMetadata(!delegated || input.responseAssertion === 'controlled-delegated-v1'
      && nativeGetMapping.responseAssertion.kind === input.responseAssertion
      && equal(input.delegatedFixture, nativeGetMapping.fixtureSelection), 'READ_ONLY_REVIEW_REQUIRED');
    requireMetadata(!graph || input.responseAssertion === 'graph-organization-v1'
      && nativeGetMapping.responseAssertion?.kind === input.responseAssertion, 'READ_ONLY_REVIEW_REQUIRED');
  } else requireMetadata(tool && tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false,
    'READ_ONLY_REVIEW_REQUIRED');
  keys(input.safetyReview, ['readOnly', 'reason']);
  requireMetadata(input.safetyReview.readOnly === true && typeof input.safetyReview.reason === 'string'
    && input.safetyReview.reason.trim().length >= 12 && input.safetyReview.reason.length <= 1024, 'READ_ONLY_REVIEW_REQUIRED');
  requireMetadata(!/\b(delete|remove|update|create|write|send|execute|purchase|transfer|payment|upload|install|shell|script|command|grant|revoke|reset|drop|truncate|ignore|bypass|mutate|patch|post|put)\b/i
    .test(`${nativeGetMapping ? `${nativeGetMapping.path}${mappedKey
      ? ` ${savedJson(nativeGetMapping.backendMapping).replace(/([a-z])([A-Z])/g, '$1 $2')}` : ''}`
      : `${tool.name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ')} ${tool.description ?? ''}`} ${input.safetyReview.reason} ${savedJson(input.arguments)}`),
  'UNSAFE_PROOF');
  requireMetadata(input.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments), 'INVALID_CONFIG');
  clean(input.arguments, 16384);
  rejectCredentialArguments(input.arguments);
  validateProofSchema(tool.inputSchema);
  try {
    const ajv = new Ajv({ strict: true, allErrors: false, validateFormats: false });
    requireMetadata(ajv.compile(tool.inputSchema)(input.arguments), 'PROOF_ARGUMENTS_INVALID');
  } catch (error) {
    if (error.code === 'PROOF_ARGUMENTS_INVALID') throw error;
    requireMetadata(false, 'PROOF_SCHEMA_UNSUPPORTED');
  }
  const plan = { schemaVersion: 1, action: 'standalone-mcp-read-only-proof',
    source, capture, tool, arguments: input.arguments,
    safetyReview: { ...input.safetyReview, verified: false },
    discoveryPlan: capture.discoveryPlan,
    ...(nativeGetMapping ? { nativeGetMapping } : {}),
    limitations: ['Read-only intent is a human assertion, not a verified side-effect guarantee. Tool hints do not authorize execution.',
      ...(nativeGetMapping ? [
        mappedKey
          ? 'Server safety annotations are absent. Only this immutable scalar-query mapped GET, exact arguments and Key Vault reference are eligible; names/descriptions are not safety evidence.'
          : 'Server safety annotations are absent. Only this immutable native APIM fixed GET mapping is eligible; names/descriptions are not safety evidence.',
        'Explicit cloud-read approval is required. Current ARM ownership, policies and exact tool/operation mapping are checked after re-list, before the call.',
        'GET is not a side-effect guarantee. Human review remains mandatory; ARM reads are a non-atomic snapshot, not a cloud lock.',
      ] : []),
      'One tools/call only, after full schema re-list comparison. No automatic retry or redirect.',
      'Protocol success is not business correctness or Cowork runtime acceptance. No raw response data is retained.',
      ...(graph ? ['Only the reviewed tenant organization GET with fixed $select=id through this exact MI policy is qualified. Expected organization ID and minimal OData metadata are checked in memory.',
        'Graph supports delegated access too. Its response does not attest backend token claims, absence of scp or exclusive use of this application role; evidence combines fresh policy/identity/assignment readback with the expected response. No app-only claim attestation or effective-permission isolation is inferred.'] : []),
      ...(delegated ? ['Controlled fixture only: same-resource original delegated bearer, exact tenant/audience/client/scp/expected-user validation policy and response marker. No OBO, app-only tokens or qualification of unrelated business backends.',
        'Fixture cloud apply is unsupported. Absent, partial, unowned or drifted owner setup fails fresh ARM verification; a bundle or HTTP 200 alone is never acceptance.'] : []),
      ...(mappedKey ? ['Managed identity is the current system-assigned identity of this exact APIM service and tenant. Metadata does not prove secret availability or permissions.',
        ...(nativeGetMapping.responseAssertion
          ? ['The approved LegiScan assertion checks status OK and the requested bill ID in memory only. Failed or unrecognized envelopes fail qualification; the sent call remains non-replayable.']
          : ['No backend response assertion was selected; protocol success cannot establish API-key validity or backend business success.'])] : []),
      'Loss of response, timeout or cancellation after send leaves outcome unknown; do not replay without owner reconciliation.'] };
  return boundedSnapshot({ ...plan, approvalDigest: metadataDigest(boundedSnapshot(plan)) });
}
export const planMcpReadOnlyProof = (value, options) => planProof(value, options);
// Internal project seam, deliberately absent from the root public contract and JSON options.
export const planMcpProjectMappedProof = (value, options, mapping) => planProof(value, options, mapping);
export function planMcpQualifiedProof(value, options, qualification) {
  const { approvalDigest, ...plan } = planProof(value, options);
  const body = { ...plan, qualification, additionalToolCalls: 1,
    limitations: [...plan.limitations,
      'NEW qualification purpose: one additional provider call, potentially one basic-search credit. The prior proof approval is consumed and does not authorize this call.',
      'Only result structure, exact domain and nonempty bounded title/content are asserted; not factual accuracy, ranking or full backend authentication. No prose fallback or retry.'] };
  return boundedSnapshot({ ...body, approvalDigest: metadataDigest(boundedSnapshot(body)) });
}

export function planMcpAcceptedProof(value, options) {
  const { acceptanceProfile, ...selection } = options;
  requireMetadata(acceptanceProfile === qualificationKind, 'ACCEPTANCE_PROFILE_UNSUPPORTED');
  requireTavilyArguments(selection, 'ACCEPTANCE_ARGUMENTS_INVALID');
  const { approvalDigest, ...base } = planProof(value, selection);
  const body = { ...base, acceptanceProfile: tavilyFirstCallProfile(),
    limitations: [...base.limitations, 'FIRST ordinary call: evaluate the selected closed result profile in this same tools/call, never an additional call or retry. Basic search normally costs 1 credit, not a billing guarantee.'] };
  return boundedSnapshot({ ...body, approvalDigest: metadataDigest(boundedSnapshot(body)) });
}

function assessBackendResponse(reply, assertion) {
  const verdict = passed => ({ kind: assertion.kind, status: passed ? 'passed' : 'failed' });
  if (reply.isError === true || reply.content.length > 1) return verdict(false);
  if (assertion.kind === 'graph-organization-v1' && reply.content.some(item => typeof item.text !== 'string' || item.text.length > 4096)) return verdict(false);
  let text;
  if (reply.content.length === 1) {
    try { text = JSON.parse(reply.content[0].text); }
    catch (error) { if (error instanceof SyntaxError) return verdict(false); throw error; }
  }
  const response = reply.structuredContent ?? text;
  if (reply.structuredContent !== undefined && text !== undefined && !equal(reply.structuredContent, text)) return verdict(false);
  if (assertion.kind === 'controlled-delegated-v1') return verdict(response !== undefined && equal(response, assertion.marker));
  if (assertion.kind === 'graph-organization-v1') return verdict(graphOrganizationResponse(response, assertion.organizationId));
  return verdict(response !== null && typeof response === 'object' && !Array.isArray(response)
    && response.status === 'OK' && response.bill !== null && typeof response.bill === 'object'
    && !Array.isArray(response.bill) && response.bill.bill_id === assertion.billId);
}

async function proof(value, options = {}, dependencies, nativeGetMapping, qualification, accepted = false) {
  checkedOptions(options, ['capture', 'toolName', 'arguments', 'safetyReview',
    ...(accepted ? ['acceptanceProfile'] : []),
    ...(['native-apim-mapped-key-get', 'native-apim-graph-organization-get'].includes(nativeGetMapping?.kind) ? ['responseAssertion'] : []),
    ...(nativeGetMapping?.kind === 'native-apim-controlled-delegated-get' ? ['responseAssertion', 'delegatedFixture'] : [])]);
  const selection = { capture: options.capture, toolName: options.toolName,
    arguments: options.arguments, safetyReview: options.safetyReview,
    ...(options.delegatedFixture === undefined ? {} : { delegatedFixture: options.delegatedFixture }),
    ...(options.responseAssertion === undefined ? {} : { responseAssertion: options.responseAssertion }),
    ...(accepted ? { acceptanceProfile: options.acceptanceProfile } : {}) };
  const plan = accepted ? planMcpAcceptedProof(value, selection)
    : qualification ? planMcpQualifiedProof(value, selection, qualification) : planProof(value, selection, nativeGetMapping);
  requireMetadata(!nativeGetMapping || typeof dependencies?.beforeToolCall === 'function', 'READ_ONLY_REVIEW_REQUIRED');
  requireMetadata(options.approval && equal(options.approval, plan), 'APPROVAL_REQUIRED');
  let status, errorCode;
  const assertion = accepted ? firstCallProfileBinding() : qualification ?? nativeGetMapping?.responseAssertion;
  let backendAssertion = assertion ? { kind: assertion.kind, status: 'not-evaluated' } : undefined;
  try {
    const guarded = { ...dependencies, beforeRequest: async () => {
      validateMcpObservedCapture(plan.capture);
      await dependencies?.beforeRequest?.();
    }, ...(assertion ? { assessToolResult: reply => qualification || accepted
      ? assessTavilyResult(reply, plan.arguments.query) : assessBackendResponse(reply, assertion) } : {}) };
    const result = await endpoint(plan.discoveryPlan, options, guarded,
      { name: plan.tool.name, arguments: plan.arguments, toolsDigest: plan.capture.toolsDigest });
    status = result.toolCall.status;
    if (assertion) backendAssertion = result.toolCall.backendAssertion;
  } catch (error) {
    const failure = safeFailure(error, options.signal);
    if (failure.invocationStatus !== 'unknown') throw failure;
    status = 'unknown';
    errorCode = failure.code;
  }
  return digestRecord({ schemaVersion: 1, kind: qualification ? 'standalone-mcp-search-qualification' : 'standalone-mcp-read-only-proof',
    approvalDigest: plan.approvalDigest, sourceDigest: plan.source.descriptorDigest,
    captureDigest: plan.capture.receiptDigest, toolName: plan.tool.name,
    argumentsDigest: metadataDigest(plan.arguments), status,
    ...(accepted ? { acceptanceProfile: firstCallProfileBinding() } : {}),
    ...(backendAssertion === undefined ? {} : { backendAssertion }),
    ...(errorCode === undefined ? {} : { errorCode }),
    completedAt: new Date().toISOString(), businessCorrectnessVerified: false, coworkRuntimeVerified: false });
}
export const runMcpReadOnlyProof = (value, options) => proof(value, options);
export const runMcpReadOnlyProofForTest = (value, options, dependencies) => proof(value, options, dependencies);
export const runMcpReadOnlyProofWithGuard = (value, options, beforeRequest, hooks = {}) => proof(value, options, { ...hooks, beforeRequest });
export const runMcpProjectMappedProof = (value, options, mapping, dependencies) => proof(value, options, dependencies, mapping);
export const runMcpQualifiedProof = (value, options, qualification, dependencies) => proof(value, options, dependencies, undefined, qualification);
export const runMcpAcceptedProof = (value, options, dependencies) => proof(value, options, dependencies, undefined, undefined, true);
