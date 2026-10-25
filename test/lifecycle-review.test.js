import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileHostingRecipe } from '../src/mcp-container-apps.js';
import { reviewLifecycle } from '../src/mcp-lifecycle-review.js';
const input = JSON.parse(await readFile(new URL('../examples/mcp/container-apps-direct-api-key.json', import.meta.url)));
const project = compileHostingRecipe(input), hash = `sha256:${'a'.repeat(64)}`;
test('secret reference review is metadata-only and cannot imply platform resolution or provider acceptance', () => {
  const request = { schemaVersion: 1, kind: 'secret-reference-review', secretIdentifier: input.backend.apiKey.secretIdentifier,
    identityResourceId: input.backend.apiKey.identityResourceId, observedAt: new Date(Date.now() - 1000).toISOString(),
    metadata: { enabled: true, expiresAt: null, evidenceDigest: hash }, ownerEntered: true };
  const result = reviewLifecycle(project, request);
  assert.equal(result.referenceResolution, 'not-verified'); assert.equal(result.providerAcceptance, 'not-verified');
  assert.equal(result.versionPolicy, 'pinned-version');
  const versionless = structuredClone(project);
  versionless.input.backend.apiKey.secretIdentifier = input.backend.apiKey.secretIdentifier.replace(/\/[a-f0-9]{32}$/, '');
  assert.equal(reviewLifecycle(versionless, { ...request,
    secretIdentifier: versionless.input.backend.apiKey.secretIdentifier }).versionPolicy, 'versionless');
  for (const patch of [{ metadata: { ...request.metadata, enabled: false } },
    { metadata: { ...request.metadata, expiresAt: '2020-01-01T00:00:00.000Z' } },
    { identityResourceId: input.azure.registry.pullIdentityResourceId }, { key: 'not-allowed' }]) {
    assert.throws(() => reviewLifecycle(project, { ...request, ...patch }));
  }
});
test('cost/closeout keeps missing pricing unknown, protects existing resources and never deletes', () => {
  const request = { schemaVersion: 1, kind: 'cost-closeout', profile: 'scale-to-zero',
    inventory: [{ resourceId: input.backend.apiKey.keyVaultResourceId, ownership: 'pre-existing',
      disposition: 'retain', evidenceDigest: hash }],
    pricing: [{ component: 'compute', status: 'unavailable', monthlyAmount: null, currency: 'USD',
      observedAt: new Date(Date.now() - 1000).toISOString() }] };
  const result = reviewLifecycle(project, request);
  assert.equal(result.totalMonthlyCost, null); assert.equal(result.freeTierGuaranteed, false);
  assert.equal(result.profileChangeRequiresNewSource, true); assert.equal(result.removesAnything, false);
  assert.ok(result.unquotedComponents.includes('registry'));
  request.pricing[0].monthlyAmount = 0;
  assert.throws(() => reviewLifecycle(project, request), /Unknown pricing/);
  request.pricing[0].monthlyAmount = null; request.inventory[0].disposition = 'propose-removal';
  assert.throws(() => reviewLifecycle(project, request), /Pre-existing/);
});
