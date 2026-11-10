import {
  prepareMcpServer, createMcpServerProject, getMcpServerInputSchema, getLibraryInfo,
  prepareRestToolDocument, compareRestCapture, planMcpDiscovery, planMcpReadOnlyProof,
  validateMcpObservedCapture, discoverMcpTools, runMcpReadOnlyProof, McpToolkitError,
  type McpServerSourceInput, type McpExistingInput, type McpExperimentalProxyInput,
  type McpEndpointDescriptor, type McpDiscoveryPlan, type McpReadOnlyProofSelection,
} from 'copilot-mcp-toolkit';

const reference: McpExistingInput = {
  schemaVersion: 1, kind: 'existing-mcp', server: { id: 'synthetic', name: 'Synthetic' },
  endpoint: 'https://example.com/mcp', inbound: { type: 'anonymous' },
};
async function consumer(input: McpServerSourceInput, selection: McpReadOnlyProofSelection) {
  const review = await prepareMcpServer(input);
  const descriptor: McpEndpointDescriptor = review.descriptor;
  const plan: McpDiscoveryPlan = planMcpDiscovery(descriptor);
  const capture = await discoverMcpTools(descriptor, { approval: plan, allowNetwork: true });
  validateMcpObservedCapture(capture);
  const proof = planMcpReadOnlyProof(descriptor, selection);
  await runMcpReadOnlyProof(descriptor, { ...selection, approval: proof, allowNetwork: true });
  await createMcpServerProject(review, { workspaceRoot: '/workspace', projectDir: '/workspace/new' });
  const info = await getLibraryInfo({ signal: new AbortController().signal });
  const name: 'copilot-mcp-toolkit' = info.name;
  return { name, schema: getMcpServerInputSchema() };
}
void consumer;
void reference;
void prepareRestToolDocument;

async function buildRecoveryConsumer(options: import('copilot-mcp-toolkit').BuildRecoveryOptions) {
  const api = await import('copilot-mcp-toolkit');
  const plan = await api.planBuildRecovery(options);
  const kind: 'mcp-build-recovery-plan' = plan.scope.kind;
  const scanRejection: string | undefined = plan.scope.config.scanRejectedContinuationOutput;
  const result = await api.runBuildRecovery({ ...options, approval: plan.approvalToken,
    allowLocal: true, allowNetwork: true });
  const calls: 0 = result.providerCalls;
  // @ts-expect-error transport injection is internal test infrastructure
  await api.runBuildRecovery({ ...options, approval: plan.approvalToken, allowLocal: true, allowNetwork: true }, {});
  // @ts-expect-error recovery grants no cloud authority
  await api.runBuildRecovery({ ...options, approval: plan.approvalToken, allowLocal: true, allowNetwork: true, allowCloud: true });
  return { kind, calls, scanRejection, schema: await api.getBuildRecoverySchema() };
}
void buildRecoveryConsumer;
async function recoveredImageConsumer(options: import('copilot-mcp-toolkit').RecoveredImageOptions) {
  const api = await import('copilot-mcp-toolkit');
  const plan = await api.planRecoveredImage(options);
  const kind: 'mcp-recovered-image-plan' = plan.scope.kind;
  const result = await api.runRecoveredImage({ ...options, approval: plan.approvalToken,
    allowLocal: true, allowNetwork: true, allowCloud: true });
  const status: 'passed' | 'unknown-no-replay' = result.status;
  // @ts-expect-error All deployment effect gates are required.
  await api.runRecoveredImage({ ...options, approval: plan.approvalToken, allowLocal: true, allowNetwork: true });
  // @ts-expect-error Runner/transport injection is not public.
  await api.runRecoveredImage({ ...options, approval: plan.approvalToken, allowLocal: true, allowNetwork: true, allowCloud: true }, {});
  return { kind, status, schema: await api.getRecoveredImageSchema() };
}
void recoveredImageConsumer;
prepareRestToolDocument({ title: 'Synthetic bounded selectors', tools: [{
  name: 'read_record', description: 'Read a synthetic record.', backendPath: '/v1/record.json', fixedQuery: {},
  arguments: [
    { name: 'q', description: 'Explicit selector.', type: 'string', required: true, minLength: 1, maxLength: 256 },
    { name: 'days', description: 'Bounded days.', type: 'integer', required: true, minimum: 1, maximum: 3 },
    // @ts-expect-error Integer bounds cannot be supplied for a string argument.
    { name: 'invalid', description: 'Wrong scalar bound.', type: 'string', required: true, minimum: 1 },
  ],
}] });
void compareRestCapture;
void McpToolkitError;

async function verifiedImageConsumer(options: import('copilot-mcp-toolkit').VerifiedImageDeploymentOptions) {
  const api = await import('copilot-mcp-toolkit');
  const schema: Record<string, unknown> = await api.getVerifiedImageDeploymentSchema();
  const plan = await api.planVerifiedImageDeployment(options);
  const kind: 'mcp-verified-image-deployment-plan' = plan.scope.kind;
  await api.runVerifiedImageDeployment({ ...options, approval: plan.approvalToken,
    allowLocal: true, allowNetwork: true, allowCloud: true });
  await api.runVerifiedImageDeployment({ ...options, approval: plan.approvalToken,
    // @ts-expect-error No public transport or Azure runner injection.
    allowLocal: true, allowNetwork: true, allowCloud: true }, { runAzure() {} });
  // @ts-expect-error All deployment effect gates are mandatory.
  await api.runVerifiedImageDeployment({ ...options, approval: plan.approvalToken, allowCloud: true });
  return { schema, kind };
}
void verifiedImageConsumer;
type Experiment = McpExperimentalProxyInput['experimentalProfile'];
const profile: Experiment = 'owned-backend-routing-v1';
void profile;
async function publicConsumer(input: import('copilot-mcp-toolkit').McpPublicServerInput) {
  const review = await prepareMcpServer(input);
  const anonymous: 'anonymous' = review.descriptor.inbound.type;
  await createMcpServerProject(review, { workspaceRoot: '/workspace', projectDir: '/workspace/public' });
  // @ts-expect-error A public REST backend cannot be API-key authenticated.
  input.backend = { auth: 'api-key', endpoint: 'https://example.com' };
  // @ts-expect-error Public inbound does not widen Entra-only proxy descriptors.
  const proxyInbound: import('copilot-mcp-toolkit').McpProxyDescriptor['inbound'] = input.inbound;
  return { anonymous, proxyInbound };
}
void publicConsumer;
// @ts-expect-error Arbitrary OAuth REST generation is not supported.
const invalidBackend: import('copilot-mcp-toolkit').McpBackendAuthorization = { auth: 'oauth', endpoint: 'https://example.com' };
void invalidBackend;
// @ts-expect-error Internal execution is not a public root API.
import { provisionProject } from 'copilot-mcp-toolkit';
void provisionProject;
