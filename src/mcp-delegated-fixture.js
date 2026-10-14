import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { assertProjectPath } from './config.js';
import { mcpServerInputSchema } from './mcp-server.js';
import { buildPolicy, DENY_POLICY } from './apim-renderer.js';
import { serviceResourceId, assertSafeDiagnostics, assertInheritedOperationPolicies } from './apim-safety.js';
import { readControl, writeControl } from './mcp-control.js';
import { boundedSnapshot, metadataDigest, requireMetadata, savedJson } from './anonymous-metadata.js';

const properties = mcpServerInputSchema.oneOf[0].properties;
const schema = { type: 'object', additionalProperties: false, required: ['schemaVersion', 'id', 'azure', 'inbound', 'expectedUserId'],
  properties: { schemaVersion: { const: 1 }, id: { type: 'string', format: 'uuid' },
    azure: properties.azure, inbound: properties.inbound, expectedUserId: { type: 'string', format: 'uuid' } } };
const ajv = new Ajv(); addFormats(ajv);
const valid = ajv.compile(schema);
const same = (a, b) => metadataDigest(boundedSnapshot(a)) === metadataDigest(boundedSnapshot(b));
const fullId = (a, b) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const empty = value => value == null || Array.isArray(value) && value.length === 0;
const xml = value => value.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const policyEqual = (a, b) => typeof a === 'string' && a.trim().replace(/>\s+</g, '><') === b.trim().replace(/>\s+</g, '><');
function fixturePolicyEqual(value, review) {
  if (policyEqual(value, review.policy)) return true;
  const body = `<set-body>${xml(JSON.stringify({
    kind: review.marker.kind, fixtureDigest: review.marker.fixtureDigest, accepted: review.marker.accepted,
  }))}</set-body>`;
  // APIM rawxml can render JSON text quotes literally; derive only this reviewed alternative.
  return review.policy.split('<set-body>').length === 2 && review.policy.includes(body)
    && policyEqual(value, review.policy.replace(body, body.replaceAll('&quot;', '"')));
}
const arm = resources => ({ $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
  contentVersion: '1.0.0.0', resources });

export function prepareDelegatedFixture(value) {
  const input = boundedSnapshot(value);
  requireMetadata(valid(input) && input.azure.apimMode === 'existing'
    && input.inbound.tenantId === input.azure.tenantId
    && input.expectedUserId !== '00000000-0000-0000-0000-000000000000', 'INVALID_CONFIG');
  const uri = new URL(input.inbound.applicationIdUri);
  requireMetadata(['api:', 'https:'].includes(uri.protocol) && !uri.username && !uri.password && !uri.search && !uri.hash, 'INVALID_CONFIG');
  const apiId = `cpt-delegated-${metadataDigest({ id: input.id }).slice(7, 19)}`;
  const serviceId = serviceResourceId({ azure: input.azure }), resourceId = `${serviceId}/apis/${apiId}`;
  const inputDigest = metadataDigest(input), marker = { kind: 'controlled-delegated-v1', fixtureDigest: inputDigest, accepted: true };
  const base = buildPolicy({ inbound: input.inbound, azure: input.azure, server: { id: input.id } },
    { auth: 'entra' }, { backend: false });
  requireMetadata(base.split('</required-claims>').length === 2 && base.split('</inbound>').length === 2, 'METADATA_MISMATCH');
  const policy = base.replace('</required-claims>',
    `<claim name="oid" match="all"><value>${input.expectedUserId.toLowerCase()}</value></claim></required-claims>`)
    .replace('</inbound>', `<choose><when condition="@(context.Request.Method != &quot;GET&quot; || context.Request.Url.Query.Count != 0)"><return-response><set-status code="400" reason="Invalid fixture request" /></return-response></when></choose><return-response><set-status code="200" reason="OK" /><set-header name="Content-Type" exists-action="override"><value>application/json</value></set-header><set-body>${xml(JSON.stringify(marker))}</set-body></return-response></inbound>`);
  const description = `Controlled delegated fixture ${input.id} ${inputDigest}`;
  const api = { type: 'Microsoft.ApiManagement/service/apis', apiVersion: '2024-05-01', name: `${input.azure.apimName}/${apiId}`,
    properties: { displayName: apiId, description, type: 'http', path: apiId, protocols: ['https'], subscriptionRequired: false } };
  const apiDependency = `[resourceId('Microsoft.ApiManagement/service/apis', '${input.azure.apimName}', '${apiId}')]`;
  const policyResource = value => ({ type: 'Microsoft.ApiManagement/service/apis/policies', apiVersion: '2024-05-01',
    name: `${api.name}/policy`, dependsOn: [apiDependency], properties: { format: 'rawxml', value } });
  const operation = { type: 'Microsoft.ApiManagement/service/apis/operations', apiVersion: '2024-05-01',
    name: `${api.name}/read-principal`, dependsOn: [apiDependency],
    properties: { displayName: 'Read controlled delegated result', method: 'GET', urlTemplate: '/principal-check',
      templateParameters: [], request: { queryParameters: [], headers: [], representations: [] }, responses: [] } };
  const stage = arm([{ ...api, properties: { ...api.properties, subscriptionRequired: true } }, policyResource(DENY_POLICY)]);
  const activate = arm([api, operation, policyResource(policy)]);
  const files = { 'fixture-definition.json': savedJson(input), 'staging.json': savedJson(stage), 'activation.json': savedJson(activate) };
  const result = { schemaVersion: 1, kind: 'controlled-delegated-fixture', status: 'manual-owner-provisioning-required',
    input, inputDigest, apiId, resourceId, serviceId, description, operationId: 'read-principal', path: '/principal-check',
    endpoint: `https://${input.azure.apimName}.azure-api.net/${apiId}`, policy, marker, files,
    cloudApplySupported: false, deploymentVerified: false,
    requirements: [
      'Local review/bundle only: no apply authority or deployment receipt. Owner provisioning requires separate authorization and a supported owner process, not a toolkit apply command.',
      'Reject existing ID/path collisions or unowned children. Preserve shared service/global policy/diagnostics and unrelated APIs. Never modify shared service settings.',
      'Stage an empty subscription-protected API with deny policy first; verify denial before separately approved activation. Use documented child-resource ETags, durable write-ahead history and exact readback; never blindly replay an interrupted write.',
      'Do not create or replace a resource application, grant permissions or change consent. Same-resource delegated token only; no OBO or app-only fallback.',
      'Activation must equal these exact resources/policies. Proof freshly verifies ownership, sole GET operation, inherited policy and diagnostics; the bundle and response marker alone prove nothing.',
      'Controlled test only: no business data, keys, external requests or principal/token echo. This does not qualify an unrelated business backend.',
    ] };
  return boundedSnapshot({ ...result, reviewDigest: metadataDigest(result) });
}

export async function createDelegatedFixture(value, { output, approval } = {}) {
  const review = prepareDelegatedFixture(value);
  requireMetadata(approval === review.reviewDigest, 'APPROVAL_REQUIRED');
  const dir = await assertProjectPath(path.resolve(output));
  await mkdir(dir, { recursive: false, mode: 0o700 });
  for (const [name, contents] of Object.entries(review.files)) {
    await writeControl(path.join(dir, name), JSON.parse(contents), { create: true });
  }
  await writeControl(path.join(dir, 'fixture-review.json'), review, { create: true });
  return { status: review.status, projectDir: dir, reviewDigest: review.reviewDigest,
    cloudApplySupported: false, deploymentVerified: false };
}

export async function readDelegatedFixture(projectDir, selection) {
  requireMetadata(selection && Object.keys(selection).sort().join(',') === 'approval,path'
    && typeof selection.path === 'string' && selection.path.length <= 4096, 'READ_ONLY_REVIEW_REQUIRED');
  const dir = await assertProjectPath(path.resolve(projectDir, selection.path));
  const review = prepareDelegatedFixture(await readControl(path.join(dir, 'fixture-definition.json')));
  requireMetadata(selection.approval === review.reviewDigest, 'APPROVAL_REQUIRED');
  requireMetadata(same(await readControl(path.join(dir, 'fixture-review.json')), review), 'METADATA_MISMATCH');
  for (const [name, contents] of Object.entries(review.files)) {
    const filename = await assertProjectPath(path.join(dir, name));
    await readControl(filename);
    requireMetadata(await readFile(filename, 'utf8') === contents, 'METADATA_MISMATCH');
  }
  return review;
}

export function delegatedFixtureReads(review) {
  return ['', '/policies/policy', '/diagnostics', '/operations', `/operations/${review.operationId}/policies`]
    .map((suffix, index) => ({ suffix: `delegated-fixture-${index}`, method: 'GET',
      url: `https://management.azure.com${review.resourceId}${suffix}?api-version=2024-05-01${index === 1 ? '&format=rawxml' : ''}` }));
}

export function verifyDelegatedFixture(review, outputs, verify, config) {
  const [api, policy, diagnostics, operations, operationPolicies] = [0, 1, 2, 3, 4].map(index => outputs.get(`delegated-fixture-${index}`));
  verify(fullId(api?.id, review.resourceId) && api.name === review.apiId, 'id');
  const p = api.properties;
  verify(p?.description === review.description, 'owner');
  verify(p?.path === review.apiId && (p.type ?? p.apiType ?? 'http') === 'http'
    && (p.apiType === undefined || p.apiType === 'http')
    && p.subscriptionRequired === false && same(p.protocols, ['https'])
    && [p.serviceUrl, p.sourceApiId, p.apiVersionSetId].every(value => value == null || value === '')
    && p.mcpProperties == null, 'backend');
  verify(fixturePolicyEqual(policy?.properties?.value, review), 'policy');
  assertSafeDiagnostics(diagnostics, config);
  verify(Array.isArray(operations?.value) && operations.value.length === 1 && !operations.nextLink, 'operation-count');
  const op = operations.value[0], request = op.properties?.request;
  verify(fullId(op.id, `${review.resourceId}/operations/${review.operationId}`) && op.name === review.operationId, 'operation-reference');
  verify(op.properties?.method === 'GET' && op.properties.urlTemplate === review.path, 'method');
  verify(empty(op.properties.templateParameters) && empty(request?.queryParameters) && empty(request?.headers)
    && empty(request?.representations), 'query-parameters');
  assertInheritedOperationPolicies(operationPolicies);
}
