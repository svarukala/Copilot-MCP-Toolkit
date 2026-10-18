import Ajv from 'ajv';
import { safeHttpsUrl, validateOpenApiDocument } from './config.js';

export const publicInboundSchema = {
  type: 'object', additionalProperties: false,
  required: ['type', 'publicData', 'readOnly', 'rateLimit'],
  properties: {
    type: { const: 'anonymous' },
    publicData: { const: true },
    readOnly: { const: true },
    rateLimit: {
      type: 'object', additionalProperties: false, required: ['calls', 'renewalPeriod'],
      properties: {
        calls: { type: 'integer', minimum: 1, maximum: 10000 },
        renewalPeriod: { type: 'integer', minimum: 1, maximum: 300 },
      },
    },
  },
};
const validInbound = new Ajv().compile(publicInboundSchema);
export const publicAnonymous = config => config.inbound?.type === 'anonymous';

export function assertPublicAnonymousConfig(config) {
  const invalid = () => { throw new Error('Public anonymous APIM requires explicit public-data/read-only declarations and rate limits, one anonymous REST backend origin, and only fixed GET operations without parameters, bodies, security, callbacks or mappings.'); };
  if (!validInbound(config.inbound) || config.experimentalProfile !== undefined || config.connectors?.length !== 1) invalid();
  const c = config.connectors[0];
  if (c.kind !== 'rest' || c.auth !== 'anonymous' || c.entra !== undefined || c.apiKey !== undefined
    || c.managedIdentity !== undefined || c.mcpProxyVersion !== undefined || !c.rest?.document) invalid();
  safeHttpsUrl(c.endpoint);
  const backend = new URL(c.endpoint);
  if (backend.pathname !== '/' || (c.endpoint !== backend.origin && c.endpoint !== `${backend.origin}/`)) invalid();
  const { document, operations } = validateOpenApiDocument(c.rest.document, c.rest.operationIds);
  if (!Array.isArray(c.rest.operationIds) || !c.rest.operationIds.length
    || new Set(c.rest.operationIds).size !== c.rest.operationIds.length) invalid();
  if (document['x-ms-paths'] !== undefined
    || document.security !== undefined && (!Array.isArray(document.security) || document.security.length)) invalid();
  for (const op of operations.filter(op => c.rest.operationIds.includes(op.id))) {
    const item = document.paths[op.path], operation = item.get;
    if (op.method !== 'GET' || !/^\/[A-Za-z0-9._~/-]*$/.test(op.path) || op.path.includes('//')
      || op.path.split('/').some(part => part === '.' || part === '..')
      || op.parameters.length || op.requestBody !== undefined
      || item.servers !== undefined || operation.servers !== undefined
      || operation.callbacks !== undefined || operation['x-cowork-backend'] !== undefined
      || operation.security !== undefined && (!Array.isArray(operation.security) || operation.security.length)) invalid();
  }
}

export const publicExposureWarnings = [
  'PUBLIC EXPOSURE: anyone who can reach the gateway can call the selected MCP tools and backing REST routes without a token or subscription key.',
  'Public-data and read-only declarations are caller review, not independent verification of backend behavior. No private data, API keys, delegated tokens or managed-identity backends are admitted.',
  'The configured aggregate request rate limit applies separately to the MCP API and backing REST API at each gateway/region, not across the entire service. APIM distributed counters are approximate, not a spending cap or DDoS guarantee; clients sharing the endpoint share the budget.',
  'Azure management identity and exact deployment approvals remain required. Consumer SSO registration and MCP public-client sign-in are not required for this anonymous profile.',
  'Only new project-owned APIs may be activated. Existing shared policies and protected endpoints are not weakened; custom inherited authentication blocks reuse.',
];
