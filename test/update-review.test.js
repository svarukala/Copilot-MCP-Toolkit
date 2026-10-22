import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileHostingRecipe } from '../src/mcp-container-apps.js';
import { reviewUpdate } from '../src/mcp-update-review.js';
import { boundedSnapshot, metadataDigest } from '../src/anonymous-metadata.js';
const input = JSON.parse(await readFile(new URL('../examples/mcp/container-apps-direct-api-key.json', import.meta.url)));
const project = compileHostingRecipe(input);
const hash = value => metadataDigest(boundedSnapshot(value));
const now = () => new Date(Date.now() - 1000).toISOString();
const image = `${input.azure.registry.server}/server@sha256:${'b'.repeat(64)}`;
const oldImage = `${input.azure.registry.server}/server@sha256:${'a'.repeat(64)}`;
const resourceId = `/subscriptions/${input.azure.subscriptionId}/resourceGroups/${input.azure.resourceGroup}/providers/Microsoft.App/containerApps/${input.azure.appName}`;
function baseline() {
  const resource = { type: 'Microsoft.App/containerApps', apiVersion: '2025-01-01',
    name: input.azure.appName, location: input.azure.location, tags: { unrelated: 'preserved' },
    identity: { type: 'UserAssigned', userAssignedIdentities: { [input.azure.registry.pullIdentityResourceId]: {} } },
    properties: { managedEnvironmentId: input.azure.environmentResourceId,
      workloadProfileName: 'Consumption',
      configuration: { maxInactiveRevisions: 10, activeRevisionsMode: 'Single',
        ingress: { external: true, allowInsecure: false, targetPort: 3000, traffic: [{ latestRevision: true, weight: 100 }] },
        secrets: [{ name: 'backend', keyVaultUrl: input.backend.apiKey.secretIdentifier, identity: input.backend.apiKey.identityResourceId }] },
      template: { containers: [{ name: 'mcp', image: oldImage, probes: [{ type: 'Liveness' }],
        env: [{ name: 'MCP_BACKEND_API_KEY', secretRef: 'backend' }] }],
      scale: { minReplicas: 1, maxReplicas: 1, cooldownPeriod: 300, pollingInterval: 30 } } } };
  return { schemaVersion: 1, kind: 'container-app-image-update', baseline: { resourceId,
    etag: '"synthetic-1"', observedAt: now(), resource }, baselineDigest: hash(resource), image };
}
test('image-only derivation preserves the entire writable baseline, rejects filtered/deleting previews and drift', () => {
  const request = baseline(), original = structuredClone(request);
  const result = reviewUpdate(project, request);
  assert.equal(result.status, 'awaiting-exact-preview');
  const expected = structuredClone(request.baseline.resource);
  expected.properties.template.containers[0].image = image;
  assert.deepEqual(result.operatorTemplate.resources, [expected]);
  assert.deepEqual(request, original);
  request.preview = { resourceId, changes: result.changes };
  assert.equal(reviewUpdate(project, request).status, 'preview-reviewed-not-deployed');
  for (const mutate of [
    r => { r.preview.changes = []; },
    r => { r.preview.changes.push({ path: 'properties.configuration.maxInactiveRevisions', before: '10', after: '0', changeType: 'Modify' }); },
    r => { r.baseline.resource.properties.workloadProfileName = 'Changed'; },
    r => { r.baseline.etag = '*'; }, r => { r.baseline.resourceId += '-other'; },
    r => { r.baseline.resource.properties.configuration.secrets[0].value = 'redacted'; r.baselineDigest = hash(r.baseline.resource); },
  ]) { const changed = structuredClone(request); mutate(changed); assert.throws(() => reviewUpdate(project, changed)); }
});
test('readiness requires exact new revision/image/traffic and never prescribes a deployment retry', () => {
  const request = { schemaVersion: 1, kind: 'container-app-readiness', resourceId,
    expectedImage: image, expectedRevision: 'mcp-new', deadline: new Date(Date.now() + 60000).toISOString(),
    observation: { observedAt: now(), provisioningState: 'Succeeded', latestReadyRevision: 'mcp-old',
      revisionImage: oldImage, healthy: true, trafficPercent: 100 } };
  assert.equal(reviewUpdate(project, request).status, 'waiting-for-readiness');
  request.deadline = new Date(Date.now() - 2000).toISOString();
  assert.equal(reviewUpdate(project, request).status, 'readiness-timeout-unknown');
  request.observation.latestReadyRevision = request.expectedRevision;
  request.observation.revisionImage = image;
  assert.equal(reviewUpdate(project, request).status, 'traffic-ready-operator-observed');
  request.observation.healthy = false;
  assert.notEqual(reviewUpdate(project, request).status, 'traffic-ready-operator-observed');
});
test('Entra additions preserve complete settings and reconcile only known collection ordering', () => {
  const scopeId = '55555555-5555-4555-8555-555555555555';
  const base = { appId: input.authentication.audience, identifierUris: [input.authentication.applicationIdUri],
    api: { requestedAccessTokenVersion: 2, oauth2PermissionScopes: [{ id: scopeId, value: input.authentication.scope,
      isEnabled: true, type: 'User' }], preAuthorizedApplications: [] },
    web: { redirectUris: ['https://example.com/existing'], implicitGrantSettings: { enableIdTokenIssuance: false } } };
  const request = { schemaVersion: 1, kind: 'entra-sso-update', tenantId: input.azure.tenantId,
    applicationObjectId: '66666666-6666-4666-8666-666666666666', observedAt: now(), baseline: base,
    baselineDigest: hash(base), registrationApplicationIdUri: 'api://example.com/sso', scopeId };
  const result = reviewUpdate(project, request);
  assert.deepEqual(result.expected.api.oauth2PermissionScopes, base.api.oauth2PermissionScopes);
  assert.deepEqual(Object.keys(result.patch).sort(), ['api', 'identifierUris', 'web']);
  request.readback = structuredClone(result.expected);
  request.readback.identifierUris.reverse(); request.readback.web.redirectUris.reverse();
  assert.equal(reviewUpdate(project, request).status, 'reconciled-operator-readback');
  request.readback.web.implicitGrantSettings.enableIdTokenIssuance = true;
  assert.throws(() => reviewUpdate(project, request), /Readback differs/);
});
test('authentication impact distinguishes portal correction from runtime migration and never resets proof', () => {
  const request = { schemaVersion: 1, kind: 'authentication-impact',
    priorAuthentication: structuredClone(project.runtime.authentication), portalScopeCorrectionOnly: true };
  const result = reviewUpdate(project, request);
  assert.equal(result.runtimeChanged, false); assert.equal(result.proofReplayAuthorized, false);
  assert.ok(!result.stages.includes('qualified-image'));
  request.priorAuthentication.allowedClientIds.push('99999999-9999-4999-8999-999999999999');
  assert.throws(() => reviewUpdate(project, request), /preserves/);
});
