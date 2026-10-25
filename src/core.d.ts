export const libraryContractVersion: 1;

export interface LibraryInfo {
  name: 'copilot-mcp-toolkit';
  version: string;
  libraryContractVersion: 1;
  mcpServerContractVersion: 1;
  experimental: true;
  contentDigest: string;
  files: string[];
}
export function getLibraryInfo(options?: { signal?: AbortSignal }): Promise<LibraryInfo>;

export const mcpServerContractVersion: 1;

export interface McpAzureTarget {
  apimMode?: 'new' | 'existing';
  resourceGroupMode?: 'new' | 'existing';
  keyVaultMode?: 'new' | 'existing';
  tenantId: string;
  subscriptionId: string;
  resourceGroup: string;
  apimName: string;
  /** Required in new mode. */
  location?: string;
  publisherName?: string;
  publisherEmail?: string;
  sku?: 'Developer' | 'Basicv2' | 'Standardv2' | 'Premium';
  keyVaultName?: string;
}

export interface McpInboundAuthorization {
  type: 'entra';
  tenantId: string;
  clientId: string;
  applicationIdUri: string;
  scope: string;
  /** Explicit allowlist. No consumer, including Cowork, is implicitly authorized. */
  allowedClientIds: string[];
}

export type McpBackendAuthorization = {
  endpoint: string;
} & ({ auth: 'anonymous'; apiKey?: never; managedIdentity?: never }
  | { auth: 'entra'; apiKey?: never; managedIdentity?: never }
  | { auth: 'managed-identity'; apiKey?: never; managedIdentity: {
    type: 'system-assigned';
    /** Existing APIM service principal object ID, in the deployment tenant. */
    principalId: string;
    /** Backend application (client) UUID, distinct from inbound.clientId; not a scope or /.default. */
    resource: string;
    servicePrincipalId: string;
    appRoleId: string;
    appRole: string;
  } }
  | { auth: 'api-key'; managedIdentity?: never; apiKey: { secretIdentifier: string } & (
    { headerName: string; queryParameterName?: never } | { queryParameterName: string; headerName?: never }) });

export interface McpServerInput {
  kind?: never;
  schemaVersion: 1;
  server: { id: string; name: string };
  azure: McpAzureTarget;
  inbound: McpInboundAuthorization;
  /** 'entra' is delegated passthrough. 'managed-identity' is separate application access, existing APIM only. */
  backend: McpBackendAuthorization;
  document: Record<string, unknown>;
  operationIds: string[];
}

export interface McpServerDescriptor {
  contractVersion: 1;
  kind: 'native-apim-mcp';
  status: 'generated-not-deployed';
  server: McpServerInput['server'];
  endpoint: string;
  transport: 'streamable-http';
  inbound: McpInboundAuthorization;
  target: McpAzureTarget;
  ownership: { ownerId: string; apiId: string };
  operationIds: string[];
  definitionDigest: string;
  descriptorDigest: string;
}

export interface McpPublicInboundAuthorization {
  type: 'anonymous';
  publicData: true;
  readOnly: true;
  /** Aggregate limit per API: calls 1-10000, renewalPeriod 1-300 seconds. Not a cost ceiling. */
  rateLimit: { calls: number; renewalPeriod: number };
}

/** Native REST only; runtime validation restricts selected operations to literal, parameter-free GETs. */
export interface McpPublicServerInput extends Omit<McpServerInput, 'inbound' | 'backend'> {
  inbound: McpPublicInboundAuthorization;
  backend: Extract<McpBackendAuthorization, { auth: 'anonymous' }>;
}

export interface McpPublicServerDescriptor extends Omit<McpServerDescriptor, 'inbound'> {
  inbound: McpPublicInboundAuthorization;
}

export interface McpProxyInput {
  /** New reviews normalize v1 proxy input to v2 with an explicit upstream message endpoint. */
  schemaVersion: 1 | 2;
  kind: 'apim-mcp-proxy';
  server: McpServerInput['server'];
  azure: McpAzureTarget;
  inbound: McpInboundAuthorization;
  backend: Extract<McpBackendAuthorization, { auth: 'api-key' }>;
}

export interface McpExistingInput {
  schemaVersion: 1;
  kind: 'existing-mcp';
  server: McpServerInput['server'];
  endpoint: string;
  inbound: McpInboundAuthorization | { type: 'anonymous' } | { type: 'oauth' };
}

/** Explicit experimental profile; never selected by v1/v2 preparation or legacy generation. */
export interface McpExperimentalProxyInput extends Omit<McpProxyInput, 'schemaVersion' | 'backend'> {
  schemaVersion: 3;
  experimentalProfile: 'owned-backend-routing-v1';
  azure: McpAzureTarget & { apimMode: 'existing'; resourceGroupMode: 'existing'; keyVaultMode: 'existing'; keyVaultName: string };
  backend: { endpoint: string; auth: 'api-key'; apiKey: { secretIdentifier: string; headerName: string } };
}

export type McpProxyDescriptor = Omit<McpServerDescriptor, 'kind' | 'operationIds'> & { kind: 'apim-mcp-proxy' };

export interface McpExistingDescriptor {
  contractVersion: 1;
  kind: 'existing-mcp';
  status: 'referenced-not-verified';
  server: McpServerInput['server'];
  endpoint: string;
  transport: 'streamable-http';
  inbound: McpExistingInput['inbound'];
  definitionDigest: string;
  descriptorDigest: string;
}

export type McpServerSourceInput = McpServerInput | McpPublicServerInput | McpProxyInput | McpExistingInput | McpExperimentalProxyInput;

export type McpEndpointDescriptor = McpServerDescriptor | McpPublicServerDescriptor | McpProxyDescriptor | McpExistingDescriptor;

export type McpSourceReview<I = McpServerSourceInput, D = McpEndpointDescriptor> =
  Omit<McpServerReview, 'input' | 'descriptor'> & { input: I; descriptor: D };

export type McpSourceProjectResult = Omit<McpServerProjectResult, 'status'> & {
  status: 'generated-not-deployed' | 'referenced-not-verified';
};

export interface McpServerReview {
  contractVersion: 1;
  evidence: 'local-generation-review';
  input: McpServerInput;
  descriptor: McpServerDescriptor;
  /** Exact UTF-8 text by relative POSIX inventory path, including descriptor and definition. */
  files: Record<string, string>;
  limitations: string[];
  /** Content binding, not authority, attestation, deployment approval or metadata evidence. */
  reviewDigest: string;
}

export interface McpServerProjectResult {
  projectDir: string;
  descriptorFile: string;
  definitionFile: string;
  reviewDigest: string;
  status: 'generated-not-deployed';
  files: string[];
}

/** Local compilation only. No login, network, deployment, consumer files or tools/list synthesis. */
export function prepareMcpServer(input: McpServerInput): Promise<McpServerReview>;

export function prepareMcpServer(input: McpPublicServerInput): Promise<McpSourceReview<McpPublicServerInput, McpPublicServerDescriptor>>;

export function prepareMcpServer(input: McpProxyInput): Promise<McpSourceReview<McpProxyInput, McpProxyDescriptor>>;

export function prepareMcpServer(input: McpExperimentalProxyInput): Promise<McpSourceReview<McpExperimentalProxyInput, McpProxyDescriptor>>;

export function prepareMcpServer(input: McpExistingInput): Promise<McpSourceReview<McpExistingInput, McpExistingDescriptor>>;

export function prepareMcpServer(input: McpServerSourceInput): Promise<McpSourceReview>;

export function validateMcpServerDescriptor(value: unknown): McpEndpointDescriptor;

export function getMcpServerInputSchema(): Record<string, unknown>;

/** Write an exact revalidated review into a new caller-owned private child directory. */
export function createMcpServerProject(review: McpServerReview, options: {
  workspaceRoot: string; projectDir: string; signal?: AbortSignal;
}): Promise<McpServerProjectResult>;

export function createMcpServerProject(review: McpSourceReview, options: {
  workspaceRoot: string; projectDir: string; signal?: AbortSignal;
}): Promise<McpSourceProjectResult>;

export const restAuthoringVersion: 1;

export type RestToolArgument = {
  name: string; description: string; required: boolean; backendName?: string;
} & ({ type: 'string'; default?: string } | { type: 'integer'; default?: number });

export interface RestToolDefinition {
  title: string;
  /** Nonsecret query NAME only; never its key value. The argument/fixed mappings may not use it. */
  apiKeyQueryParameter?: string;
  tools: Array<{
    name: string;
    description: string;
    backendPath: string;
    fixedQuery: Record<string, string | number>;
    arguments: RestToolArgument[];
  }>;
}

export interface PreparedRestToolDocument {
  contractVersion: 1;
  evidence: 'user-authored-openapi';
  document: { openapi: '3.0.3'; info: { title: string; version: '1.0.0' }; paths: Record<string, unknown> };
  operationIds: string[];
  operations: Array<{ operationId: string; toolName: string; method: 'GET'; path: string;
    parameters: Array<{ name: string; in: 'query'; description: string; required: boolean;
      schema: { type: 'string' | 'integer'; default?: string | number } }>;
    backendMapping: { path: string; query: Record<string, string | number>; parameterNames: Record<string, string> } }>;
  limitations: string[];
}

/** Pure bounded OpenAPI authoring; does not write, validate a live backend, or synthesize tools/list. */
export function prepareRestToolDocument(input: RestToolDefinition): PreparedRestToolDocument;

export const restCaptureCompatibilityVersion: 2;

export interface RestOperationContract {
  toolName: string;
  parameters: unknown[];
  requestBody?: unknown;
  backendMapping?: { path: string; query: Record<string, string | number>; parameterNames: Record<string, string> } | null;
}

export interface RestCaptureCompatibility {
  contractVersion: 2;
  evidence: 'local-contract-comparison';
  status: 'compatible' | 'compatible-with-reviewed-loss' | 'blocked';
  compatible: boolean;
  checks: Array<{ tool: string; status: 'compatible' | 'compatible-with-reviewed-loss' | 'blocked' }>;
  issues: Array<{ tool: string; argument?: string; source?: 'rest' | 'capture';
    code: 'missing-tool' | 'unexpected-tool' | 'unsupported-schema' | 'missing-argument'
      | 'unexpected-argument' | 'type-mismatch' | 'default-mismatch' | 'constraint-mismatch' | 'required-mismatch' }>;
  acceptedLosses: Array<{ tool: string; argument: string; facet: 'default' | 'constraint';
    keyword?: string; observed: 'omitted'; enforcement: 'generated-apim-policy' }>;
  limitations: string[];
}

/** Conservative supported-subset equality. Hosts supply trustworthy current reviews/captures; no I/O or authorization. */
export function compareRestCapture(operations: RestOperationContract[], metadata: { tools: AnonymousTool[] }): RestCaptureCompatibility;

export type McpToolkitErrorCode = 'INVALID_CONFIG' | 'LIMIT' | 'PATH' | 'ASSETS' | 'IO' | 'VALIDATION' | 'ABORTED'
  | 'ENDPOINT_BLOCKED' | 'NETWORK_BLOCKED' | 'APPROVAL_REQUIRED' | 'DISCOVERY_FAILED' | 'DISCOVERY_TIMEOUT'
  | 'METADATA_INVALID' | 'METADATA_MISMATCH' | 'METADATA_STALE' | 'METADATA_SELECTION'
  | 'ENTRA_SETUP_REQUIRED' | 'SENSITIVE_INPUT' | 'AUTH_CONFIG_INVALID' | 'AUTHENTICATION_FAILED'
  | 'AUTHENTICATION_TIMEOUT' | 'AUTHENTICATION_REJECTED' | 'TOKEN_EXPIRED'
  | 'NETWORK_APPROVAL_REQUIRED' | 'OAUTH_REVIEWED_IMPORT_REQUIRED' | 'DEPLOYMENT_CHECKPOINT_REQUIRED'
  | 'PROOF_SCHEMA_UNSUPPORTED' | 'PROOF_ARGUMENTS_INVALID' | 'READ_ONLY_REVIEW_REQUIRED' | 'UNSAFE_PROOF'
  | 'PROOF_REPLAY_BLOCKED' | 'PROOF_OUTCOME_UNRESOLVED';

export class McpToolkitError extends Error {
  readonly code: McpToolkitErrorCode;
  readonly diagnostics?: EntraDiscoveryDiagnostics;
  readonly invocationStatus?: 'unknown';
  constructor(code: McpToolkitErrorCode, message: string);
}

export interface EntraDiscoveryDiagnostics {
  authStage: 'authority' | 'device-code' | 'token' | 'metadata';
  failureKind: 'transport' | 'timeout' | 'http-status' | 'oauth-error-response' | 'response-shape' | 'sdk';
  httpStatus?: number;
  /** Present together only for failures during authenticated MCP processing. */
  rpcMethod?: 'initialize' | 'notifications/initialized' | 'tools/list' | 'tools/call';
  rpcStage?: 'transport' | 'http-status' | 'response-read' | 'response-limit' | 'json-parse'
    | 'sse-parse' | 'sse-event' | 'rpc-envelope' | 'rpc-error' | 'initialization' | 'session'
    | 'tool-schema' | 'pagination' | 'tool-response' | 'local-guard' | 'timeout' | 'cancelled';
  /** Present only with tools/list and tool-schema; contains no server-supplied values. */
  toolSchemaIssue?: 'tools-container' | 'tools-empty' | 'tool-object' | 'tool-name' | 'tool-name-duplicate' | 'tool-description'
    | 'input-root' | 'input-properties' | 'input-required' | 'input-dialect-type' | 'input-dialect-unsupported' | 'input-schema-invalid'
    | 'output-root' | 'output-dialect-type' | 'output-dialect-unsupported' | 'output-schema-invalid';
}

export const anonymousMcpLimits: Readonly<{
  buildBytes: 1048576; captureBytes: 524288; responseBytes: 262144;
  totalResponseBytes: 1048576; tools: 1000; pages: 10; timeoutMs: 15000;
}>;

export interface AnonymousTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown> & { type: 'object' };
  outputSchema?: Record<string, unknown> & { type: 'object' };
  [key: string]: unknown;
}

export interface EntraDiscoveryAuth {
  discoveryClientId: string;
  tenantId: string;
  authority: string;
  scopes: [string, 'openid', 'profile', 'offline_access'];
}

export const mcpDiscoveryContractVersion: 1;

export type McpDiscoverySelection = { discoveryClientId?: never; expectedUserId?: never }
  | { discoveryClientId: string; expectedUserId: string };

export interface McpDiscoveryPlan {
  schemaVersion: 1;
  action: 'standalone-mcp-tools-list';
  source: McpEndpointDescriptor;
  target: { endpoint: string };
  /** Runtime user and discovery client; unrelated to the Azure deployment account. */
  auth?: EntraDiscoveryAuth & { expectedUserId: string };
  authTimeoutMs: 0 | 600000;
  metadataTimeoutMs: 15000;
  limits: typeof anonymousMcpLimits;
  methods: ['initialize', 'notifications/initialized', 'tools/list'];
  limitations: string[];
  approvalDigest: string;
}

export interface McpObservedCapture {
  schemaVersion: 1;
  kind: 'standalone-mcp-tools-capture';
  source: McpEndpointDescriptor;
  discoveryPlan: McpDiscoveryPlan;
  capturedAt: string;
  tools: { tools: AnonymousTool[] };
  toolsDigest: string;
  evidence: 'observed-discovery' | 'observed-authenticated-discovery';
  protocolVersion: '2024-11-05' | '2025-03-26' | '2025-06-18';
  receiptDigest: string;
}

export interface McpNetworkApproval {
  allowNetwork: true;
  signal?: AbortSignal;
  /** Required for Entra. Transient UI only; never persist the challenge in logs or artifacts. */
  onDeviceCode?: (challenge: EntraDeviceCodeChallenge) => void;
}

/** Pure plan. Existing OAuth providers require reviewed external import, not implicit login or DCR. */
export function planMcpDiscovery(descriptor: McpEndpointDescriptor, selection?: McpDiscoverySelection): McpDiscoveryPlan;

/** Exact host-persisted approval plus literal opt-in required; never executes tools/call. */
export function discoverMcpTools(descriptor: McpEndpointDescriptor,
  options: McpDiscoverySelection & McpNetworkApproval & { approval: McpDiscoveryPlan }): Promise<McpObservedCapture>;

/** Local structural/source/freshness validation. Unkeyed receipt hashes are not observation authority. */
export function validateMcpObservedCapture(value: unknown, options?: { maxAgeHours?: number }): McpObservedCapture;

export interface McpResultAssertion {
  kind: 'json-array-string-field-v1';
  field: string;
  maxItems: number;
  maxStringLength: number;
}
export interface McpReadOnlyProofSelection {
  capture: McpObservedCapture;
  toolName: string;
  arguments: Record<string, unknown>;
  safetyReview: { readOnly: true; reason: string };
  resultAssertion?: McpResultAssertion;
}

export interface McpReadOnlyProofPlan {
  schemaVersion: 1;
  action: 'standalone-mcp-read-only-proof';
  source: McpEndpointDescriptor;
  capture: McpObservedCapture;
  tool: AnonymousTool;
  arguments: Record<string, unknown>;
  safetyReview: { readOnly: true; reason: string; verified: false };
  discoveryPlan: McpDiscoveryPlan;
  resultAssertion?: McpResultAssertion;
  limitations: string[];
  approvalDigest: string;
}

export interface McpReadOnlyProofResult {
  schemaVersion: 1;
  kind: 'standalone-mcp-read-only-proof';
  approvalDigest: string;
  sourceDigest: string;
  captureDigest: string;
  toolName: string;
  argumentsDigest: string;
  status: 'protocol-success' | 'tool-error' | 'unknown';
  resultAssertion?: McpResultAssertion;
  backendAssertion?: { kind: 'json-array-string-field-v1'; status: 'passed' | 'failed' | 'not-evaluated';
    assertionDigest?: string; rawResultRetained?: false };
  errorCode?: McpToolkitErrorCode;
  completedAt: string;
  businessCorrectnessVerified: false;
  coworkRuntimeVerified: false;
  receiptDigest: string;
}

/** Human read-only assertion is unverified; hints alone never authorize a call. Unsupported schemas fail closed. */
export function planMcpReadOnlyProof(descriptor: McpEndpointDescriptor, selection: McpReadOnlyProofSelection): McpReadOnlyProofPlan;

/** Separate explicit approval, one call, no retry. Unknown post-send outcomes require owner reconciliation. */
export function runMcpReadOnlyProof(descriptor: McpEndpointDescriptor,
  options: McpReadOnlyProofSelection & McpNetworkApproval & { approval: McpReadOnlyProofPlan }): Promise<McpReadOnlyProofResult>;

/** Transient authentication UX only. Never persist this challenge or raw provider response. */
export interface EntraDeviceCodeChallenge {
  verificationUri: string;
  userCode: string;
  expiresAt: string;
}
