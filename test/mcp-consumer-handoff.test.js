import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { boundedSnapshot, metadataDigest } from '../src/anonymous-metadata.js';
import { validateConsumerHandoff } from '../src/mcp-consumer-handoff.js';

const example = JSON.parse(await readFile(new URL('../examples/mcp/consumer-handoff.json', import.meta.url)));
const now = Date.parse('2026-01-01T12:00:00.000Z');
function seal(value) {
  const { integrity, ...body } = structuredClone(value);
  body.observation.toolsDigest = metadataDigest(boundedSnapshot({ tools: body.tools }));
  return { ...body, integrity: { ...integrity, contentDigest: metadataDigest(boundedSnapshot(body)) } };
}

test('synthetic handoff has valid integrity, lossless metadata and no execution authority', t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Contract validation cannot use the network'));
  const original = structuredClone(example);
  const result = validateConsumerHandoff(example, { now });
  assert.equal(result.metadataFreshness, 'valid');
  assert.equal(result.provenance, 'unverified-reference');
  assert.equal(result.executionReadiness, false);
  assert.equal(result.proofReplayAuthorized, false);
  assert.deepEqual(result.handoff.tools, example.tools);
  assert.deepEqual(example, original);
  assert.equal(validateConsumerHandoff(example, { now: now + 86400000 }).metadataFreshness, 'stale');
  const anonymous = structuredClone(example);
  anonymous.authentication = { type: 'anonymous' };
  delete anonymous.tools[0].annotations;
  anonymous.tools[0].outputSchema = { type: 'object', properties: { value: { type: 'string' } } };
  const checked = validateConsumerHandoff(seal(anonymous), { now });
  assert.equal(checked.handoff.tools[0].annotations, undefined);
  assert.deepEqual(checked.handoff.tools[0].outputSchema, anonymous.tools[0].outputSchema);
  anonymous.tools[0].annotations = { title: 'Untrusted synthetic hint', readOnlyHint: false,
    destructiveHint: true, idempotentHint: false, openWorldHint: false };
  assert.deepEqual(validateConsumerHandoff(seal(anonymous), { now }).handoff.tools[0].annotations,
    anonymous.tools[0].annotations);
});

test('handoff rejects malformed authority, privacy, time and schema claims rather than silently dropping data', () => {
  const mutations = [
    v => { v.schemaVersion = 2; },
    v => { v.authentication = { type: 'oauth' }; },
    v => { v.authentication.allowedClientIds.push(v.authentication.allowedClientIds[0].toUpperCase()); },
    v => { v.authentication.resourceIdentifier = 'https://owner:password@example.com'; },
    v => { v.authentication.resourceIdentifier = 'https://%'; },
    v => { v.authentication.resourceIdentifier = 'api:///missing-host'; },
    v => { v.authentication.resourceIdentifier += '\u0000'; },
    v => { v.endpoint.url += '?token=private'; },
    v => { v.endpoint.url = 'https://localhost/mcp'; },
    v => { v.readiness.executionReadiness = true; },
    v => { v.readiness.proofReplayAuthorized = true; },
    v => { v.readiness.limitations.pop(); },
    v => { v.session = { token: 'private' }; },
    v => { v.approvalToken = 'private'; },
    v => { v.observation.rawOutput = 'private'; },
    v => { v.observation.capturedAt = '2026-01-02T00:00:00.000Z'; },
    v => { v.observation.expiresAt = '2026-01-03T00:00:00.000Z'; },
    v => { v.tools[0].description = 'Bearer syntheticcredential123456789'; },
    v => { v.tools[0].inputSchema.properties.id.default = 'Bearer syntheticcredential123456789'; },
    v => { v.tools[0].result = { content: [] }; },
    v => { v.tools[0].inputSchema.$schema = 'https://example.com/unknown-schema'; },
    v => { v.tools[0].inputSchema.required = ['id', 'id']; },
    v => { v.tools.push(structuredClone(v.tools[0])); },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const changed = structuredClone(example); mutate(changed);
    assert.throws(() => validateConsumerHandoff(seal(changed), { now }), `mutation ${index}`);
  }
});

test('handoff detects tampering, byte bounds and deeply nested metadata', () => {
  const changed = structuredClone(example);
  changed.tools[0].annotations.destructiveHint = true;
  assert.throws(() => validateConsumerHandoff(changed, { now }), { code: 'MCP_CONSUMER_HANDOFF_TOOLS' });
  changed.observation.toolsDigest = metadataDigest(boundedSnapshot({ tools: changed.tools }));
  assert.throws(() => validateConsumerHandoff(changed, { now }), { code: 'MCP_CONSUMER_HANDOFF_INTEGRITY' });
  const oversized = structuredClone(example);
  oversized.tools[0].inputSchema.description = 'x'.repeat(524288);
  assert.throws(() => validateConsumerHandoff(oversized, { now }), { code: 'LIMIT' });
  const deep = structuredClone(example);
  let node = deep.tools[0].inputSchema;
  for (let i = 0; i < 65; i++) node = node.items = {};
  assert.throws(() => validateConsumerHandoff(deep, { now }), { code: 'LIMIT' });
});
