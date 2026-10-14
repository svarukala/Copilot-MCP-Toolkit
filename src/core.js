import * as mcpDiscovery from './mcp-discovery.js';

import { safeEntraDiagnostics } from './entra-discovery.js';

export { restAuthoringVersion } from './rest-authoring.js';

import { prepareRestToolDocument as restToolDocument } from './rest-authoring.js';

export { restCaptureCompatibilityVersion } from './rest-compatibility.js';

import { compareRestCapture as restCaptureComparison } from './rest-compatibility.js';

import * as server from './mcp-server.js';

export { mcpServerContractVersion } from './mcp-server.js';

export const getMcpServerInputSchema = () => structuredClone(server.mcpServerInputSchema);

export function validateMcpServerDescriptor(value) {
  try { return server.validateMcpServerDescriptor(value); }
  catch (error) { throw new McpToolkitError('INVALID_CONFIG', error.message); }
}

export const prepareMcpServer = value => operation('INVALID_CONFIG', undefined, () => server.prepareMcpServer(value));

export const createMcpServerProject = (review, options) =>
  operation('VALIDATION', options?.signal, () => server.createMcpServerProject(review, options));

export function compareRestCapture(operations, metadata) {
  try { return restCaptureComparison(operations, metadata); }
  catch { throw new McpToolkitError('INVALID_CONFIG', 'REST capture comparison requires bounded operation reviews and valid captured tool schemas.'); }
}

export function prepareRestToolDocument(input) {
  try { return restToolDocument(input); }
  catch { throw new McpToolkitError('INVALID_CONFIG', 'REST tool authoring requires a bounded, valid nonsecret GET/query definition.'); }
}

export const libraryContractVersion = 1;

export { anonymousLimits as anonymousMcpLimits } from './anonymous-metadata.js';

export class McpToolkitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'McpToolkitError';
    this.code = code;
  }
}

async function operation(code, signal, action) {
  if (signal?.aborted) throw new McpToolkitError('ABORTED', 'Operation was aborted before the stage started.');
  try {
    return await action();
  } catch (error) {
    if (error instanceof McpToolkitError) throw error;
    throw new McpToolkitError(error.code ? 'IO' : code, error.message);
  }
}

function anonymousOperation(action) {
  try { return action(); }
  catch (error) {
    if (error instanceof McpToolkitError) throw error;
    throw new McpToolkitError(error.name === 'AnonymousMetadataError' ? error.code : 'INVALID_CONFIG',
      error.name === 'AnonymousMetadataError' ? error.code : 'Invalid reviewed MCP input.');
  }
}

export const mcpDiscoveryContractVersion = 1;

export const planMcpDiscovery = (value, options) => anonymousOperation(() => mcpDiscovery.planMcpDiscovery(value, options));

export const validateMcpObservedCapture = (value, options) => anonymousOperation(() => mcpDiscovery.validateMcpObservedCapture(value, options));

export const planMcpReadOnlyProof = (value, options) => anonymousOperation(() => mcpDiscovery.planMcpReadOnlyProof(value, options));

async function mcpNetworkOperation(action) {
  try { return await action(); }
  catch (error) {
    const failure = new McpToolkitError(error.name === 'AnonymousMetadataError' ? error.code : 'DISCOVERY_FAILED',
      error.name === 'AnonymousMetadataError' ? error.code : 'MCP operation failed; review the approved endpoint, client and user prerequisites.');
    const diagnostics = safeEntraDiagnostics(error.diagnostics);
    if (diagnostics) failure.diagnostics = diagnostics;
    if (error.invocationStatus === 'unknown') failure.invocationStatus = 'unknown';
    throw failure;
  }
}

export const discoverMcpTools = (value, options) => mcpNetworkOperation(() => mcpDiscovery.discoverMcpTools(value, options));

export const runMcpReadOnlyProof = (value, options) => mcpNetworkOperation(() => mcpDiscovery.runMcpReadOnlyProof(value, options));

export { getLibraryInfo } from './machine-contract.js';
