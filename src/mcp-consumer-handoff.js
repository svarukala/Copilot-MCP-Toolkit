import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { anonymousLimits, boundedSnapshot, metadataDigest, normalizeAnonymousEndpoint, savedJson } from './anonymous-metadata.js';
import { validateToolDescription } from './mcp-tools.js';
import { secretIssues } from './validation.js';

const object = (properties, required = Object.keys(properties)) =>
  ({ type: 'object', additionalProperties: false, properties, required });
const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const hash = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' };
const timestamp = { type: 'string', format: 'date-time' };
const uuid = { type: 'string', format: 'uuid', not: { const: '00000000-0000-0000-0000-000000000000' } };
const limitations = ['consumer-acceptance-unverified', 'auth-compatibility-unverified',
  'provenance-not-attested', 'metadata-untrusted'];

// Internal H1 contract only: no exporter, credential adapter or root API.
export const consumerHandoffSchema = object({
  schemaVersion: { const: 1 },
  kind: { const: 'mcp-consumer-handoff' },
  producer: object({ name: { const: 'copilot-mcp-toolkit' }, version: text(40), buildDigest: hash }),
  endpoint: object({ url: text(2048), transport: { const: 'streamable-http' },
    protocolVersion: { enum: ['2024-11-05', '2025-03-26', '2025-06-18'] } }),
  authentication: { oneOf: [object({ type: { const: 'anonymous' } }), object({
    type: { const: 'entra' }, tenantId: uuid, resourceClientId: uuid,
    resourceIdentifier: { type: 'string', maxLength: 2048, pattern: '^(api|https)://[^\\s<>"\'{}?#]+$' },
    scope: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_.-]{0,119}$' },
    allowedClientIds: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: uuid },
  })] },
  observation: object({
    capturedAt: timestamp, expiresAt: timestamp, captureDigest: hash, sourceDescriptorDigest: hash,
    toolsDigest: hash, provenance: { const: 'producer-asserted-observation-not-attestation' },
  }),
  tools: { type: 'array', minItems: 1, maxItems: anonymousLimits.tools, items: object({
    name: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,128}$' },
    title: text(1024), description: text(16384),
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    annotations: object({ title: text(1024), readOnlyHint: { type: 'boolean' },
      destructiveHint: { type: 'boolean' }, idempotentHint: { type: 'boolean' },
      openWorldHint: { type: 'boolean' } }, []),
  }, ['name', 'inputSchema']) },
  readiness: object({
    status: { const: 'consumer-unverified' }, executionReadiness: { const: false },
    proofReplayAuthorized: { const: false },
    limitations: { type: 'array', minItems: limitations.length, maxItems: limitations.length,
      uniqueItems: true, items: { enum: limitations } },
  }),
  integrity: object({ algorithm: { const: 'sha256' }, canonicalization: { const: 'bounded-snapshot-json-v1' },
    contentDigest: hash }),
});
const ajv = new Ajv(); addFormats(ajv);
const valid = ajv.compile(consumerHandoffSchema);
function requireHandoff(ok, code, message) {
  if (!ok) throw Object.assign(new Error(message), { code: `MCP_CONSUMER_HANDOFF_${code}` });
}
export function validateConsumerHandoff(value, { now = Date.now() } = {}) {
  const handoff = boundedSnapshot(value, anonymousLimits.captureBytes);
  requireHandoff(valid(handoff), 'SCHEMA', 'Use the closed version-1 handoff contract; no credentials, sessions, approvals or execution authority.');
  requireHandoff(!secretIssues(savedJson(handoff)), 'SENSITIVE', 'Handoff metadata contains a prohibited secret pattern; review privately without exporting it.');
  requireHandoff(normalizeAnonymousEndpoint(handoff.endpoint.url) === handoff.endpoint.url,
    'ENDPOINT', 'Use a canonical public HTTPS endpoint without credentials, query or fragment.');
  const auth = handoff.authentication;
  if (auth.type === 'entra') {
    let resource;
    try { resource = new URL(auth.resourceIdentifier); }
    catch { requireHandoff(false, 'AUTH', 'Use a valid nonsecret resource identifier.'); }
    requireHandoff(resource.hostname && !resource.username && !resource.password && !resource.port
      && !/[\u0000-\u0020\u007f-\u009f]/.test(auth.resourceIdentifier)
      && !auth.resourceIdentifier.endsWith('/') && !auth.resourceIdentifier.includes('\\')
      && new Set(auth.allowedClientIds.map(id => id.toLowerCase())).size === auth.allowedClientIds.length,
    'AUTH', 'Use a nonsecret resource identifier and distinct explicitly allowed clients; consumer registration is unverified.');
  }
  validateToolDescription({ tools: handoff.tools });
  requireHandoff(metadataDigest(boundedSnapshot({ tools: handoff.tools })) === handoff.observation.toolsDigest,
    'TOOLS', 'Observed tool metadata differs from its digest; never silently drop schema or annotations.');
  const { integrity, ...body } = handoff;
  requireHandoff(metadataDigest(boundedSnapshot(body)) === integrity.contentDigest,
    'INTEGRITY', 'Handoff content differs from its digest. Integrity is not authenticity or execution authority.');
  const captured = Date.parse(handoff.observation.capturedAt), expires = Date.parse(handoff.observation.expiresAt);
  requireHandoff(Number.isFinite(now) && new Date(captured).toISOString() === handoff.observation.capturedAt
    && new Date(expires).toISOString() === handoff.observation.expiresAt
    && captured <= now && expires - captured === 86400000,
  'FRESHNESS', 'Observation must have a canonical nonfuture timestamp and the existing 24-hour metadata lifetime.');
  return { handoff, metadataFreshness: now <= expires ? 'valid' : 'stale',
    provenance: 'unverified-reference', executionReadiness: false, proofReplayAuthorized: false };
}
