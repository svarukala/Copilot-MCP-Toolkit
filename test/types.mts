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
void compareRestCapture;
void McpToolkitError;
type Experiment = McpExperimentalProxyInput['experimentalProfile'];
const profile: Experiment = 'owned-backend-routing-v1';
void profile;
// @ts-expect-error Arbitrary OAuth REST generation is not supported.
const invalidBackend: import('copilot-mcp-toolkit').McpBackendAuthorization = { auth: 'oauth', endpoint: 'https://example.com' };
void invalidBackend;
// @ts-expect-error Internal execution is not a public root API.
import { provisionProject } from 'copilot-mcp-toolkit';
void provisionProject;
