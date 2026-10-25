import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { boundedSnapshot, metadataDigest } from './anonymous-metadata.js';
import { RESTRICTED_DISCOVERY_CLIENT_ID } from './contract.js';
import { validApplicationIdUri } from './mcp-auth-registration.js';
import { runtimeSchema } from './recipes/container-apps/runtime.js';

const object = (properties, required = Object.keys(properties)) =>
  ({ type: 'object', additionalProperties: false, properties, required });
const hash = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' };
const stamp = { type: 'string', format: 'date-time' };
const text = { type: 'string', minLength: 1, maxLength: 512 };
const uuid = { type: 'string', format: 'uuid' };
const image = { type: 'string', pattern: '^[a-z0-9.-]+/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$', maxLength: 512 };
const values = { type: 'array', maxItems: 100, uniqueItems: true, items: text };
const loose = { type: 'object' };
const arm = object({ type: { const: 'Microsoft.App/containerApps' }, apiVersion: { const: '2025-01-01' },
  name: text, location: text, tags: loose, identity: loose, properties: loose });
export const updateSchemas = [
  object({ schemaVersion: { const: 1 }, kind: { const: 'container-app-image-update' },
    baseline: object({ resourceId: text, etag: text, observedAt: stamp, resource: arm }),
    baselineDigest: hash, image,
    preview: object({ resourceId: text, changes: { type: 'array', maxItems: 100, items:
      object({ path: text, before: text, after: text, changeType: { const: 'Modify' } }) } }),
  }, ['schemaVersion', 'kind', 'baseline', 'baselineDigest', 'image']),
  object({ schemaVersion: { const: 1 }, kind: { const: 'container-app-readiness' },
    resourceId: text, expectedImage: image, expectedRevision: text, deadline: stamp,
    observation: object({ observedAt: stamp, provisioningState: { enum: ['Succeeded', 'Failed', 'InProgress'] },
      latestReadyRevision: text, revisionImage: image, healthy: { type: 'boolean' },
      trafficPercent: { type: 'integer', minimum: 0, maximum: 100 } }) }),
  object({ schemaVersion: { const: 1 }, kind: { const: 'entra-sso-update' },
    tenantId: uuid, applicationObjectId: uuid, observedAt: stamp,
    baseline: object({ appId: uuid, identifierUris: values, api: loose, web: loose }),
    baselineDigest: hash, registrationApplicationIdUri: text, scopeId: uuid,
    readback: object({ appId: uuid, identifierUris: values, api: loose, web: loose }),
  }, ['schemaVersion', 'kind', 'tenantId', 'applicationObjectId', 'observedAt', 'baseline',
    'baselineDigest', 'registrationApplicationIdUri', 'scopeId']),
  object({ schemaVersion: { const: 1 }, kind: { const: 'authentication-impact' },
    priorAuthentication: runtimeSchema.properties.authentication, portalScopeCorrectionOnly: { type: 'boolean' } }),
];
const ajv = new Ajv(); addFormats(ajv);
const valid = ajv.compile({ oneOf: updateSchemas });
const hashValue = value => metadataDigest(boundedSnapshot(value));
const equal = (a, b) => hashValue(a) === hashValue(b);
function requireUpdate(ok, message) {
  if (!ok) throw Object.assign(new Error(message), { code: 'MCP_UPDATE_REVIEW' });
}
function fresh(stamp) {
  const time = Date.parse(stamp);
  requireUpdate(time <= Date.now() && Date.now() - time <= 86400000,
    'Use a separately obtained baseline/observation no older than 24 hours, never future-dated or edited evidence.');
}
function target(project, value) {
  requireUpdate(['container-apps-direct-v1', 'container-apps-apim-v1'].includes(project.input.recipe),
    'This preserving-update profile is only for Container Apps, not other hosting platforms.');
  const a = project.input.azure;
  const expected = `/subscriptions/${a.subscriptionId}/resourceGroups/${a.resourceGroup}/providers/Microsoft.App/containerApps/${a.appName}`;
  requireUpdate(value.toLowerCase() === expected.toLowerCase(), 'The baseline target differs from this sealed source target.');
}
function semanticApp(value) {
  const app = structuredClone(value);
  app.identifierUris.sort();
  if (Array.isArray(app.web.redirectUris)) app.web.redirectUris.sort();
  if (Array.isArray(app.api.preAuthorizedApplications)) {
    app.api.preAuthorizedApplications.sort((a, b) => a.appId.localeCompare(b.appId));
    for (const item of app.api.preAuthorizedApplications) item.delegatedPermissionIds.sort();
  }
  return boundedSnapshot(app);
}
function validateApp(app) {
  const scopes = app.api.oauth2PermissionScopes, clients = app.api.preAuthorizedApplications;
  requireUpdate(Array.isArray(scopes) && scopes.length <= 100
    && scopes.every(s => typeof s.id === 'string' && typeof s.value === 'string' && typeof s.isEnabled === 'boolean')
    && new Set(scopes.map(s => s.id)).size === scopes.length,
  'Review the actual unique enabled scope IDs; scope declarations cannot be guessed.');
  requireUpdate(clients === undefined || Array.isArray(clients) && clients.length <= 100
    && clients.every(c => typeof c.appId === 'string' && Array.isArray(c.delegatedPermissionIds)
      && c.delegatedPermissionIds.length <= 100 && c.delegatedPermissionIds.every(id => typeof id === 'string'))
    && new Set(clients.map(c => c.appId.toLowerCase())).size === clients.length,
  'Preauthorized application metadata must be bounded and unambiguous.');
  requireUpdate(app.web.redirectUris === undefined || Array.isArray(app.web.redirectUris)
    && app.web.redirectUris.length <= 100 && app.web.redirectUris.every(uri => typeof uri === 'string'),
  'Review the current redirect collection.');
}
export function reviewUpdate(project, input) {
  requireUpdate(valid(input), 'Use the closed preserving-update/readiness/impact review schema.');
  if (input.kind === 'container-app-image-update') {
    target(project, input.baseline.resourceId); fresh(input.baseline.observedAt);
    const base = input.baseline.resource;
    requireUpdate(hashValue(base) === input.baselineDigest, 'Baseline digest differs; do not substitute a create template.');
    requireUpdate(base.name === project.input.azure.appName && base.location === project.input.azure.location,
      'Baseline name/location differs from the selected source.');
    requireUpdate(!input.baseline.etag.includes('*'), 'Use a concrete baseline ETag, not a wildcard.');
    requireUpdate(input.image.startsWith(`${project.input.azure.registry.server}/`), 'Select the intended registry image digest.');
    requireUpdate(!base.properties.configuration?.secrets?.some(s => Object.hasOwn(s, 'value')),
      'Do not import secret values, even redacted placeholders, into an update template. Use Key Vault references.');
    const containers = base.properties.template?.containers;
    requireUpdate(Array.isArray(containers) && containers.length <= 10
      && containers.filter(c => c.name === 'mcp').length === 1, 'A single named mcp container baseline is required.');
    const index = containers.findIndex(c => c.name === 'mcp');
    requireUpdate(typeof containers[index].image === 'string' && containers[index].image !== input.image,
      'This profile requires exactly one image change; unchanged deployments are not dispatched again.');
    const resource = structuredClone(base); resource.properties.template.containers[index].image = input.image;
    const changes = [{ path: `properties.template.containers[${index}].image`,
      before: containers[index].image, after: input.image, changeType: 'Modify' }];
    if (input.preview) requireUpdate(input.preview.resourceId.toLowerCase() === input.baseline.resourceId.toLowerCase()
      && equal(input.preview.changes, changes), 'Preview must contain exactly the intended image change and no default removal or other resource change.');
    return { status: input.preview ? 'preview-reviewed-not-deployed' : 'awaiting-exact-preview',
      baselineDigest: input.baselineDigest, baselineEtag: input.baseline.etag,
      resourceId: input.baseline.resourceId, changes,
      operatorTemplate: { $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
        contentVersion: '1.0.0.0', resources: [resource] },
      requirements: ['Reinspect the exact baseline and ETag immediately before separately approved mutation. Drift invalidates this review.',
        'Review actual what-if across ALL resources, not a filtered summary. This imported preview is not an authenticated service attestation.',
        'Use supported conditional mutation where available. An ARM deployment/what-if is not an atomic no-drift lock.',
        'Qualify the new image separately. Preserve the sealed source and this derived operator template as distinct artifacts.'],
      executionReadiness: false };
  }
  if (input.kind === 'container-app-readiness') {
    target(project, input.resourceId); fresh(input.observation.observedAt);
    const o = input.observation;
    const matched = o.latestReadyRevision === input.expectedRevision && o.revisionImage === input.expectedImage;
    const ready = o.provisioningState === 'Succeeded' && matched && o.healthy && o.trafficPercent === 100;
    return { status: o.provisioningState === 'Failed' ? 'failed-observed'
      : ready ? 'traffic-ready-operator-observed'
        : Date.parse(o.observedAt) >= Date.parse(input.deadline) ? 'readiness-timeout-unknown' : 'waiting-for-readiness',
    expectedRevision: input.expectedRevision, expectedImage: input.expectedImage,
    observation: o, endpointChecked: false, providerCalled: false,
    next: 'Observe exact revision/image/traffic metadata within the reviewed time budget. Never redeploy, change traffic, rollback or call the provider because readiness is delayed.' };
  }
  if (input.kind === 'entra-sso-update') {
    fresh(input.observedAt); validateApp(input.baseline);
    requireUpdate(input.tenantId === project.input.azure.tenantId
      && input.baseline.appId === project.runtime.authentication.audience
      && input.baselineDigest === hashValue(input.baseline),
    'Existing application tenant/client/baseline must match the sealed runtime.');
    requireUpdate(validApplicationIdUri(input.registrationApplicationIdUri),
      'Use the actual owner-supplied registration Application ID URI.');
    const scope = input.baseline.api.oauth2PermissionScopes.find(s => s.id === input.scopeId);
    requireUpdate(scope?.isEnabled && scope.value === project.runtime.authentication.scope,
      'The exact enabled delegated scope ID/name must already exist; no scope replacement is inferred.');
    const expected = structuredClone(input.baseline);
    expected.identifierUris = [...new Set([...expected.identifierUris, input.registrationApplicationIdUri])];
    expected.web.redirectUris = [...new Set([...(expected.web.redirectUris ?? []),
      'https://teams.microsoft.com/api/platform/v1.0/oAuthConsentRedirect'])];
    expected.api.preAuthorizedApplications ??= [];
    let client = expected.api.preAuthorizedApplications.find(c => c.appId.toLowerCase() === RESTRICTED_DISCOVERY_CLIENT_ID);
    if (!client) { client = { appId: RESTRICTED_DISCOVERY_CLIENT_ID, delegatedPermissionIds: [] }; expected.api.preAuthorizedApplications.push(client); }
    client.delegatedPermissionIds = [...new Set([...client.delegatedPermissionIds, input.scopeId])];
    const patch = Object.fromEntries(['identifierUris', 'api', 'web']
      .filter(key => !equal(expected[key], input.baseline[key])).map(key => [key, expected[key]]));
    if (input.readback) {
      validateApp(input.readback);
      requireUpdate(equal(semanticApp(input.readback), semanticApp(expected)),
        'Readback differs beyond known unordered URI/client collections. Preserve mismatch; reconcile metadata, never repeat PATCH.');
    }
    return { status: input.readback ? 'reconciled-operator-readback' : Object.keys(patch).length ? 'reviewed-additive-patch-not-applied' : 'already-configured-no-mutation',
      target: `/applications/${input.applicationObjectId}`, patch, expected,
      baselineDigest: input.baselineDigest, provenance: 'operator-supplied-not-directory-attestation',
      requirements: ['Reinspect baseline before dispatch. Graph PATCH is not an atomic merge against concurrent edits.',
        'Only identifierUris, api and web are included. Credentials and service-principal assignment restrictions are never changed.',
        'Preserve unexpected normalization as a mismatch for metadata-only reconciliation; never broadly ignore drift or retry PATCH.'] };
  }
  const changed = !equal(input.priorAuthentication, project.runtime.authentication);
  requireUpdate(['tenantId', 'audience', 'scope'].every(key =>
    input.priorAuthentication[key] === project.runtime.authentication[key])
    && input.priorAuthentication.allowedClientIds.every(id => project.runtime.authentication.allowedClientIds.includes(id)),
  'This migration profile preserves tenant/audience/scope checks and existing allowed clients; removals need a separate design/review.');
  requireUpdate(!input.portalScopeCorrectionOnly || !changed,
    'Portal-only correction cannot conceal a changed runtime authentication configuration.');
  return { status: 'impact-review-only', runtimeChanged: changed,
    stages: changed ? ['review-directory-additions', 'new-sealed-source', 'qualified-image', 'new-release',
      'preserving-update', 'revision-readiness', 'new-endpoint-reference', 'fresh-authenticated-discovery']
      : input.portalScopeCorrectionOnly ? ['review-existing-portal-scope', 'owner-authorizes-corrected-configuration']
        : ['review-unchanged-configuration'],
    retained: ['old-source-release-reference-capture', 'consumed-provider-proof'],
    requirements: ['Preserve existing permitted clients unless an explicit separate removal is reviewed.',
      'Dedicated-client metadata discovery does not verify enterprise token-store behavior or consumer execution.'],
    proofReplayAuthorized: false, automaticBuild: false };
}
