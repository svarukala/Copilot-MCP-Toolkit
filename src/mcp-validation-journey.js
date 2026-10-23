import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import path from 'node:path';
import { mkdir, lstat, readdir } from 'node:fs/promises';
import { assertProjectPath, isWithin } from './config.js';
import { readControl, writeControl, withControlLock } from './mcp-control.js';
import { digest, keys, requireRun, checked, scoped, absent } from './mcp-validation.js';
import { getLibraryInfo } from './machine-contract.js';
import { compileHostingRecipe, planHostingRecipe, writeHostingRecipe } from './mcp-container-apps.js';
import { prepareMcpServer, createMcpServerProject, mcpRuntimeConfig } from './mcp-server.js';
import { readAzureIdentity } from './azure-identity.js';
import { runAzureCommand } from './azure.js';
import { readRecipeProject, planRecipeRelease, writeRecipeRelease,
  planRecipeReference, writeRecipeReference } from './mcp-recipe-artifacts.js';
import { readMcpServerProject, switchMcpServerAccount, provisionMcpServer, reconcileMcpServer } from './mcp-lifecycle.js';
import { readMcpStatus } from './mcp-status.js';
import { planMcpResume, resumeFreshness } from './mcp-resume.js';
import { readOperatorHandover } from './mcp-operator.js';
import { planMcpProjectDiscovery, planMcpProjectProof, runMcpProjectValidationOperation } from './mcp-discovery-project.js';
import { assertMcpProofHistory } from './mcp-proof-history.js';
import { planInteractiveSession, runInteractiveSession } from './mcp-interactive-session.js';
import { readHandoverRelease, planHandover, writeHandover } from './mcp-handover.js';
import { planMcpEvidenceExport, exportMcpEvidence } from './mcp-evidence.js';
import { checkedResultAssertion } from './mcp-result-assertion.js';

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const filename = { type: 'string', minLength: 1, maxLength: 2048 };
const hash = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' };
const uuid = { type: 'string', format: 'uuid' };
const text = { type: 'string', minLength: 1, maxLength: 300, pattern: '^[A-Za-z0-9][A-Za-z0-9 ._:/@(),-]*$' };
const scenarios = ['container-apps-create-v2', 'container-apps-apim-create-v2', 'native-apim-create-v2',
  'existing-mcp-create-v2', 'mcp-proxy-create-v2'];
const milestones = ['prerequisites', 'image-build', 'host-deployment', 'runtime-deployment', 'secret-resolution',
  'caller-rejection', 'gateway-bypass-rejection', 'auth-registration', 'fcc-save', 'admin-ready',
  'audience', 'consumer-call', 'read-only-ui', 'rotation', 'cost-closeout'];
const proofSchema = object({
  toolName: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$' },
  arguments: { type: 'object' },
  safetyReview: object({ readOnly: { const: true }, reason: text }),
  resultAssertion: object({ kind: { const: 'json-array-string-field-v1' }, field: { type: 'string' },
    maxItems: { type: 'integer' }, maxStringLength: { type: 'integer' } }),
  responseAssertion: { enum: ['legiscan-bill-v1', 'controlled-delegated-v1', 'graph-organization-v1'] },
  delegatedFixture: object({ path: filename, approval: hash }),
}, ['toolName', 'arguments', 'safetyReview']);
export const creationScenarioSchema = object({
  schemaVersion: { const: 2 }, scenario: { enum: scenarios }, definitionFile: filename,
  discovery: { oneOf: [object({}), object({ discoveryClientId: uuid, expectedUserId: uuid })] },
  proof: proofSchema, probeMode: { enum: ['separate', 'session'] }, consumer: { enum: ['none', 'fcc'] },
  relatedProjects: { type: 'array', maxItems: 20, uniqueItems: true, items: filename },
  historyReviewed: { const: true }, privateExportReviewed: { const: true },
  azureAccount: object({ tenantId: uuid, subscriptionId: uuid,
    accountName: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.+@-]{0,253}$' } }),
}, ['schemaVersion', 'scenario', 'definitionFile', 'discovery', 'proof', 'probeMode', 'consumer',
  'relatedProjects', 'historyReviewed', 'privateExportReviewed']);
export const creationCheckpointSchema = { oneOf: [
  object({ schemaVersion: { const: 2 }, kind: { const: 'checkpoint' },
    milestones: { type: 'array', minItems: 1, maxItems: milestones.length, items: object({
      name: { enum: milestones }, outcome: { enum: ['passed', 'failed', 'deferred'] },
      evidenceDigest: hash, note: text,
    }, ['name', 'outcome', 'note']) } }),
  object({ schemaVersion: { const: 2 }, kind: { enum: ['release', 'reference'] }, file: filename }),
] };
export const creationCoverage = {
  hosting: { caller: ['entra'], backend: ['anonymous', 'api-key-header', 'api-key-query'],
    entraBackend: 'unsupported-no-token-exchange', buildAndDeployment: 'separate-owner-operations' },
  native: { caller: ['entra', 'explicit-public-anonymous'], backend: ['anonymous', 'api-key-header',
    'api-key-query', 'entra-same-token', 'entra-managed-identity'],
    proof: 'existing-planner-gated-fixed-GET-mapped-query-key-controlled-delegated-or-Graph-profile' },
  existing: { caller: ['anonymous', 'entra'], backend: 'provider-owned-not-inspected',
    apiKeyCaller: 'unsupported-use-reviewed-proxy', oauth: 'reference-only-not-live-validation' },
  proxy: { versions: [2, 3], caller: ['entra'], backend: ['api-key-header', 'api-key-query-v2-only'],
    version3: 'experimental-owned-backend-routing', proof: 'observed-schema-and-annotation-gated' },
  nextPriority: ['third-party-oauth-rest', 'obo-token-exchange', 'username-password-profiles'],
  liveQualified: false,
};
const ajv = new Ajv(); addFormats(ajv);
const valid = ajv.compile(creationScenarioSchema), validCheckpoint = ajv.compile(creationCheckpointSchema);
const phases = ['generate', 'release', 'reference', 'account', 'provision', 'reconcile', 'discovery', 'session', 'proof', 'handover', 'archive'];
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value && Date.parse(value) <= Date.now();
const fileAt = (run, name) => path.join(run.dir, name);
const childOptions = (run, workspaceRoot, config, output) => ({
  workspaceRoot, project: fileAt(run, 'source'), config, output,
});
async function exists(file) {
  await assertProjectPath(file);
  try { await lstat(file); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
}
async function profile(input, definition) {
  const hosting = input.scenario.startsWith('container-apps-'), gateway = input.scenario === 'container-apps-apim-create-v2';
  const existing = input.scenario === 'existing-mcp-create-v2', native = input.scenario === 'native-apim-create-v2';
  requireRun(!hosting || ['anonymous', 'api-key'].includes(definition.backend?.auth), 'UNSUPPORTED',
    'SDK hosting does not support Entra/OAuth/password REST backends. Entra caller sign-in is not backend token exchange.');
  let inbound, endpoint, backend, review;
  if (hosting) {
    requireRun(definition.recipe === (gateway ? 'container-apps-apim-v1' : 'container-apps-direct-v1'), 'INPUT', 'Recipe does not match the selected runner.');
    const compiled = compileHostingRecipe(definition);
    inbound = { type: 'entra', ...compiled.runtime.authentication };
    endpoint = compiled.runtime.gateway?.publicUrl ?? null;
    backend = definition.backend.auth === 'api-key' ? definition.backend.apiKey.headerName ? 'api-key-header' : 'api-key-query' : 'anonymous';
    requireRun(definition.operationIds.includes(input.proof.toolName)
      && keys(input.proof.arguments, []) && !input.proof.responseAssertion && !input.proof.delegatedFixture, 'INPUT',
    'SDK validation selects one generated fixed GET with empty arguments, not a native APIM proof fixture.');
  } else {
    requireRun(existing ? definition.kind === 'existing-mcp' : native ? definition.kind === undefined
      : definition.kind === 'apim-mcp-proxy' && [2, 3].includes(definition.schemaVersion), 'INPUT', 'Definition does not match the selected runner.');
    requireRun(definition.inbound?.type !== 'oauth', 'UNSUPPORTED',
      'Existing OAuth MCP is reference-only. OAuth discovery, OBO and password endpoints need a separate implementation.');
    review = await prepareMcpServer(definition);
    inbound = review.descriptor.inbound; endpoint = review.descriptor.endpoint;
    backend = existing ? 'provider-owned' : definition.backend.auth === 'api-key'
      ? definition.backend.apiKey.headerName ? 'api-key-header' : 'api-key-query'
      : definition.backend.auth === 'entra' ? 'entra-same-token'
        : definition.backend.auth === 'managed-identity' ? 'entra-managed-identity' : definition.backend.auth;
    requireRun(!native || input.probeMode === 'separate', 'INPUT', 'Native APIM uses separate discovery/proof with guarded mapping readback.');
    requireRun(existing || input.probeMode === 'separate', 'INPUT', 'MCP proxy validation uses its existing separately guarded discovery/proof phases.');
    requireRun(native || !input.proof.responseAssertion && !input.proof.delegatedFixture, 'INPUT', 'Native response assertions are not supported for this runner.');
  }
  if (input.proof.resultAssertion) {
    requireRun(hosting || existing, 'UNSUPPORTED', 'Generic result assertions are only supported on existing MCP endpoint references.');
    checkedResultAssertion(input.proof.resultAssertion);
  }
  if (inbound.type === 'entra') {
    requireRun(input.discovery.expectedUserId && input.discovery.expectedUserId !== '00000000-0000-0000-0000-000000000000'
      && inbound.allowedClientIds.some(id => id.toLowerCase() === input.discovery.discoveryClientId?.toLowerCase()),
    'INPUT', 'Select an explicitly allowed discovery client and expected user, separate from Azure identity.');
  } else requireRun(keys(input.discovery, []) && input.probeMode === 'separate', 'INPUT', 'Anonymous discovery takes no identity or interactive session.');
  if (!hosting && !existing) {
    requireRun(input.azureAccount && input.azureAccount.tenantId.toLowerCase() === definition.azure.tenantId.toLowerCase()
      && input.azureAccount.subscriptionId.toLowerCase() === definition.azure.subscriptionId.toLowerCase(), 'INPUT',
    'Managed APIM validation requires an explicit matching tenant, subscription and account.');
  } else requireRun(!input.azureAccount, 'INPUT', 'This runner does not select an Azure account for owner-managed hosting or an existing endpoint.');
  return { hosting, gateway, existing, native, backend, caller: inbound.type, endpoint,
    generation: existing ? 'reference-only-no-server-creation' : 'fresh-source-or-managed-APIM',
    cloudDeployment: !hosting && !existing ? 'existing-guarded-APIM-lifecycle' : 'not-automated',
    proofSupport: native ? 'narrow-existing-native-planner' : 'observed-read-only-schema-required' };
}
function checkCheckpoint(input) {
  const value = checked(input, validCheckpoint);
  if (value.kind === 'checkpoint') requireRun(new Set(value.milestones.map(m => m.name)).size === value.milestones.length
    && value.milestones.every(m => m.outcome === 'deferred' || m.evidenceDigest), 'INPUT',
  'Use unique milestone names and evidence digests for passed/failed owner declarations.');
  return value;
}
async function related(input) {
  const histories = [];
  for (const project of input.relatedProjects) {
    const status = await readMcpStatus(project, { journey: true });
    const locks = [];
    for (const name of ['.mcp-network.lock', '.provisioning.lock']) if (await exists(path.join(project, name))) locks.push(name);
    histories.push({ project, historyDigest: status.historyDigest, locks,
      consumed: [...status.proofs, ...(status.qualifications ?? [])].some(p => ['completed', 'unresolved'].includes(p.status)),
      incomplete: status.observations.some(o => ['invalid', 'no-capture'].includes(o.status)) });
  }
  return histories;
}
async function startPlan(options) {
  requireRun(typeof options.config === 'string' && typeof options.output === 'string', 'INPUT', 'Plan/start needs --config and a NEW --output.');
  const config = await assertProjectPath(path.resolve(options.config)), base = path.dirname(config);
  const input = checked(await readControl(config), valid);
  input.definitionFile = await assertProjectPath(path.resolve(base, input.definitionFile));
  input.relatedProjects = await Promise.all(input.relatedProjects.map(p => assertProjectPath(path.resolve(base, p))));
  requireRun(new Set(input.relatedProjects).size === input.relatedProjects.length, 'INPUT', 'Related projects must be distinct.');
  if (input.proof.delegatedFixture) input.proof.delegatedFixture.path =
    await assertProjectPath(path.resolve(base, input.proof.delegatedFixture.path));
  const definition = await readControl(input.definitionFile), coverage = await profile(input, definition);
  const outputPath = await assertProjectPath(path.resolve(options.output));
  requireRun((await lstat(path.dirname(outputPath))).isDirectory()
    && !isWithin(outputPath, config) && !isWithin(outputPath, input.definitionFile)
    && input.relatedProjects.every(p => !isWithin(p, outputPath) && !isWithin(outputPath, p)), 'OUTPUT',
  'Use a new run directory separate from inputs and all related project histories.');
  await absent(outputPath);
  const body = { action: 'mcp-validation-start', schemaVersion: 2, outputPath, input, definition, coverage,
    relatedHistory: await related(input), buildId: (await getLibraryInfo()).contentDigest,
    effects: ['Write a private immutable creation-run definition and copied nonsecret inputs only.',
      'Generation, identity, cloud deployment, discovery, proof and export each require their own exact next approval.',
      'Builds, SDK deployment, negative tests and consumer actions remain explicit owner gates. No implicit install or network.',
      'Related consumed histories block new proof execution even when the reference or source changes.'] };
  return { ...body, approvalToken: `mcp-validation/${digest(body)}` };
}
export const planValidation = options => scoped(options, () => startPlan(options));
async function readRun(project) {
  requireRun(typeof project === 'string', 'INPUT', 'Select the retained validation run with --project.');
  const dir = await assertProjectPath(path.resolve(project));
  const { contentDigest, ...body } = await readControl(path.join(dir, 'validation-run.json'));
  requireRun(keys(body, ['schemaVersion', 'kind', 'runDirectory', 'createdAt', 'buildId', 'input', 'definitionDigest'])
    && body.schemaVersion === 2 && body.kind === 'mcp-validation-creation-run' && body.runDirectory === dir
    && date(body.createdAt) && digest(body) === contentDigest, 'STATE', 'Invalid creation-run definition; preserve it without resealing.');
  checked(body.input, valid);
  const definition = await readControl(path.join(dir, 'definition.json'));
  requireRun(digest(definition) === body.definitionDigest, 'CHANGED', 'Pinned creation definition changed.');
  requireRun((await getLibraryInfo()).contentDigest === body.buildId, 'BUILD', 'Use the pinned toolkit build; do not reuse approvals across builds.');
  const coverage = await profile(body.input, definition);
  const names = (await readdir(await assertProjectPath(path.join(dir, 'events')))).sort();
  requireRun(names.length <= 200 && names.every((n, i) => n === `${String(i + 1).padStart(4, '0')}.json`), 'STATE', 'Invalid or oversized creation journal.');
  const events = [];
  let head = contentDigest, pending = null;
  for (const name of names) {
    const record = await readControl(path.join(dir, 'events', name), 65536);
    const { contentDigest: recordDigest, ...entry } = record;
    requireRun(keys(entry, ['schemaVersion', 'previous', 'recordedAt', 'kind', 'data'])
      && entry.schemaVersion === 2 && entry.previous === head && digest(entry) === recordDigest && date(entry.recordedAt)
      && entry.recordedAt >= (events.at(-1)?.recordedAt ?? body.createdAt), 'STATE', 'Creation journal chain or chronology changed.');
    if (entry.kind === 'intent') {
      requireRun(!pending && keys(entry.data, ['phase', 'approvalDigest']) && phases.includes(entry.data.phase)
        && /^sha256:[a-f0-9]{64}$/.test(entry.data.approvalDigest), 'STATE', 'Invalid or overlapping creation intent.');
      pending = recordDigest;
    } else if (entry.kind === 'result') {
      requireRun(pending && keys(entry.data, ['intentDigest', 'phase', 'status', 'binding'])
        && entry.data.intentDigest === pending && entry.data.phase === events.at(-1)?.data.phase
        && ['passed', 'failed', 'unknown', 'declined'].includes(entry.data.status)
        && (entry.data.binding === null || /^sha256:[a-f0-9]{64}$/.test(entry.data.binding)), 'STATE', 'Invalid creation result.');
      pending = null;
    } else if (entry.kind === 'checkpoint') {
      requireRun(!pending && checkCheckpoint(entry.data).kind === 'checkpoint', 'STATE', 'Invalid checkpoint during unresolved execution.');
    } else requireRun(false, 'STATE', 'Unknown creation event.');
    events.push(record); head = recordDigest;
  }
  return { dir, ...body, contentDigest, definition, coverage, events, head, pending };
}
async function append(run, kind, data) {
  requireRun(run.events.length < 200, 'LIMIT', 'Creation journal limit reached.');
  const body = { schemaVersion: 2, previous: run.head, recordedAt: new Date().toISOString(), kind, data };
  const record = { ...body, contentDigest: digest(body) };
  await writeControl(fileAt(run, `events/${String(run.events.length + 1).padStart(4, '0')}.json`), record, { create: true });
  run.head = record.contentDigest; run.events.push(record); return record;
}
const completed = (run, phase) => run.events.find(e => e.kind === 'result' && e.data.phase === phase && e.data.status === 'passed');
function requiredMilestones(run) {
  const p = run.coverage;
  return [...(!p.existing ? ['prerequisites'] : []),
    ...(p.hosting ? ['image-build', ...(p.gateway ? ['host-deployment'] : []), 'runtime-deployment'] : []),
    ...(p.backend.startsWith('api-key') ? ['secret-resolution', 'rotation'] : []),
    ...(p.caller === 'entra' ? ['caller-rejection'] : []),
    ...(p.gateway ? ['gateway-bypass-rejection'] : []),
    ...(run.input.consumer === 'fcc' ? [...(p.caller === 'entra' ? ['auth-registration'] : []),
      'fcc-save', 'admin-ready', 'audience', 'consumer-call', 'read-only-ui'] : []),
    ...(!p.existing ? ['cost-closeout'] : [])];
}
async function artifactBinding(run, phase) {
  if (phase === 'generate') return run.coverage.hosting
    ? (await readRecipeProject(fileAt(run, 'source'))).manifest.contentDigest
    : (await readMcpServerProject(fileAt(run, 'source'))).review.reviewDigest;
  if (phase === 'release') {
    const release = await readHandoverRelease(fileAt(run, 'release'), await readRecipeProject(fileAt(run, 'source')));
    return digest({ summary: release.summary, review: release.review });
  }
  if (phase === 'reference') {
    const source = await readRecipeProject(fileAt(run, 'source'));
    const ref = await readMcpServerProject(fileAt(run, 'reference'));
    const origin = await readControl(fileAt(run, 'reference/recipe-origin.json')), a = source.input.authentication;
    requireRun(origin.sourceManifestDigest === source.manifest.contentDigest && origin.recipe === source.input.recipe
      && origin.endpoint === ref.review.descriptor.endpoint
      && (!source.runtime.gateway || origin.endpoint === source.runtime.gateway.publicUrl)
      && digest(ref.review.input.inbound) === digest({ type: 'entra', tenantId: a.tenantId, clientId: a.audience,
        applicationIdUri: a.applicationIdUri, scope: a.scope, allowedClientIds: a.allowedClientIds }),
    'REFERENCE', 'Endpoint reference differs from the exact generated source.');
    return digest({ origin, reviewDigest: ref.review.reviewDigest });
  }
  return null;
}
async function inspect(run) {
  const required = requiredMilestones(run);
  const owner = Object.fromEntries(required.map(name => [name, { name, outcome: 'pending', provenance: 'not-recorded' }]));
  for (const event of run.events.filter(e => e.kind === 'checkpoint')) for (const row of event.data.milestones) {
    requireRun(required.includes(row.name), 'STATE', 'Checkpoint does not apply to this scenario.');
    owner[row.name] = { ...row, observedAt: event.recordedAt, provenance: 'owner-reported-not-independently-verified' };
  }
  for (const phase of ['generate', 'release', 'reference']) {
    const result = completed(run, phase);
    if (result) requireRun(await artifactBinding(run, phase) === result.data.binding, 'CHANGED', `Retained ${phase} artifact changed.`);
  }
  const endpointProject = completed(run, run.coverage.hosting ? 'reference' : 'generate')
    ? fileAt(run, run.coverage.hosting ? 'reference' : 'source') : null;
  const status = endpointProject ? await readMcpStatus(endpointProject, { journey: true }) : null;
  const history = await related(run.input), locks = [];
  for (const project of [completed(run, 'generate') && fileAt(run, 'source'), endpointProject].filter(Boolean)) {
    for (const name of ['.mcp-network.lock', '.provisioning.lock']) if (await exists(path.join(project, name))) locks.push({ project, name });
  }
  const operator = completed(run, 'generate')
    ? await readOperatorHandover({ workspaceRoot: path.dirname(run.dir), project: fileAt(run, 'source') }) : null;
  for (const name of required) {
    const row = operator?.milestones[name], observedAt = operator?.milestoneDates[name];
    if (row && row.status !== 'not-confirmed' && (!owner[name].observedAt || observedAt > owner[name].observedAt)) {
      owner[name] = { name, outcome: row.status, evidenceDigest: row.evidenceDigest,
        provenance: row.provenance, observedAt, note: 'Retained source operator declaration.' };
    }
  }
  const attempts = (status?.proofs ?? []).filter(p => !['not-proof', 'not-dispatched'].includes(p.status));
  const proofResults = run.events.filter(e => e.kind === 'result' && ['session', 'proof'].includes(e.data.phase));
  const captures = [];
  for (const observation of (status?.observations ?? []).filter(o => ['valid', 'stale'].includes(o.status))) {
    const capture = await readControl(path.join(endpointProject, '.mcp-observations', observation.attemptId, 'capture.json'));
    const auth = capture.discoveryPlan.auth;
    if (run.coverage.caller === 'anonymous' || auth?.discoveryClientId === run.input.discovery.discoveryClientId.toLowerCase()
      && auth?.expectedUserId === run.input.discovery.expectedUserId.toLowerCase()) captures.push(capture.receiptDigest);
  }
  const matching = [];
  for (const attempt of attempts.filter(a => a.status === 'completed')) {
    const receipt = await readControl(path.join(endpointProject, '.mcp-observations', attempt.attemptId, 'proof.json'));
    if (receipt.toolName === run.input.proof.toolName && receipt.argumentsDigest === digest(run.input.proof.arguments)
      && digest(receipt.resultAssertion ?? null) === digest(run.input.proof.resultAssertion ?? null)
      && (!run.input.proof.responseAssertion || receipt.backendAssertion?.kind === run.input.proof.responseAssertion)
      && captures.includes(receipt.captureDigest)
      && proofResults.some(e => e.data.binding === receipt.receiptDigest)) matching.push(attempt);
  }
  const relatedBarrier = history.some(h => h.consumed || h.incomplete || h.locks.length);
  const failedExecution = run.events.some(e => e.kind === 'result' && ['failed', 'unknown'].includes(e.data.status));
  const protocol = attempts.some(a => a.status === 'unresolved') ? 'unknown'
    : attempts.length ? attempts.length === 1 && matching.length === 1
      ? matching[0].protocolStatus === 'protocol-success'
        && (!matching[0].backendAssertion || matching[0].backendAssertion.status === 'passed') ? 'passed-historical' : 'failed-historical'
      : 'consumed-outside-run' : 'pending';
  const blocked = Boolean(run.pending || failedExecution || locks.length || relatedBarrier
    || Object.values(owner).some(m => m.outcome === 'failed')
    || Object.values(operator?.operations ?? {}).some(o => o.dispatchRecorded && !['succeeded', 'endpoint-checked'].includes(o.status))
    || ['unknown', 'failed-historical', 'consumed-outside-run'].includes(protocol)
    || status?.observations.some(o => ['invalid', 'no-capture'].includes(o.status)));
  const sourceBinding = completed(run, 'generate')?.data.binding ?? null;
  const report = { schemaVersion: 2, scenario: run.input.scenario, runDirectory: run.dir, buildId: run.buildId,
    coverage: run.coverage, sourceBinding, endpointProject, protocol,
    historyDigest: digest({ head: run.head, status: status?.historyDigest ?? null, related: history, locks, operator }),
    relatedHistory: history, locks, waiting: operator?.waiting ?? null,
    steps: run.events.filter(e => e.kind === 'result').map(e => ({ phase: e.data.phase, status: e.data.status })),
    milestones: Object.values(owner),
    status: blocked ? 'blocked' : 'in-progress',
    outcome: protocol === 'failed-historical' || Object.values(owner).some(m => m.outcome === 'failed') ? 'failed'
      : blocked ? 'blocked' : protocol === 'passed-historical' && Object.values(owner).every(m => m.outcome === 'passed')
        ? 'passed-with-owner-and-historical-evidence' : 'incomplete',
    executionReadiness: false, consumerExecutionAttested: false, proofReplayAuthorized: false,
    integrity: 'unkeyed-local-chain-not-service-attestation',
    limitations: ['SDK image build and deployment are separately reviewed owner operations, not hidden shell commands.',
      'Owner milestone digests reference evidence but do not independently verify it.',
      'Declare every related endpoint/project history. No new reference, credential or source resets a consumed call.',
      'Unsupported proof/authentication profiles remain blocked, never counted as passed.'] };
  return { run, report, owner, required, endpointProject, status, blocked };
}
async function saveReport(run) {
  const { report } = await inspect(run);
  const snapshotAt = new Date().toISOString();
  await writeControl(fileAt(run, `reports/${String(run.events.length).padStart(4, '0')}.json`),
    { ...report, snapshotAt }, { create: true });
  if (run.coverage.hosting && completed(run, 'generate')) {
    await writeControl(fileAt(run, `reports/${String(run.events.length).padStart(4, '0')}-handover.json`),
      handoverInput(run, report, snapshotAt), { create: true });
  }
  return report;
}
function handoverInput(run, report, snapshotAt) {
  const names = ['auth-registration', 'runtime-deployment', 'fcc-save', 'admin-ready', 'audience', 'consumer-call', 'read-only-ui'];
  return { schemaVersion: 1, snapshotAt, privateExportReviewed: true,
    ...(report.endpointProject ? { referenceProject: report.endpointProject } : {}),
    ...(completed(run, 'release') ? { releaseDirectory: fileAt(run, 'release') } : {}),
    milestones: report.milestones.filter(m => names.includes(m.name) && m.outcome !== 'pending')
      .map(m => ({ name: m.name, outcome: m.outcome, observedAt: m.observedAt, note: m.note })),
    operationsNote: `Creation validation outcome: ${report.outcome}. Protocol: ${report.protocol}. Consumer scope: ${run.input.consumer}. Report digest: ${digest(report)}. Owner reports are not independent attestations. Preserve the separate run report and all related consumed histories.`,
  };
}
export const startValidation = options => scoped(options, async () => {
  const plan = await startPlan(options);
  requireRun(options.approval === plan.approvalToken, 'APPROVAL', 'Approve the exact creation-run start plan.');
  await mkdir(plan.outputPath, { mode: 0o700 });
  for (const name of ['events', 'reports']) await mkdir(path.join(plan.outputPath, name), { mode: 0o700 });
  await writeControl(path.join(plan.outputPath, 'definition.json'), plan.definition, { create: true });
  await writeControl(path.join(plan.outputPath, 'discovery.json'), plan.input.discovery, { create: true });
  await writeControl(path.join(plan.outputPath, 'session.json'),
    { schemaVersion: 1, discovery: plan.input.discovery, proof: plan.input.proof }, { create: true });
  const body = { schemaVersion: 2, kind: 'mcp-validation-creation-run', runDirectory: plan.outputPath,
    createdAt: new Date().toISOString(), buildId: plan.buildId, input: plan.input, definitionDigest: digest(plan.definition) };
  const contentDigest = digest(body);
  const run = { ...body, dir: plan.outputPath, definition: plan.definition, coverage: plan.coverage,
    contentDigest, head: contentDigest, events: [], pending: null };
  const report = await saveReport(run);
  await writeControl(path.join(plan.outputPath, 'validation-run.json'), { ...body, contentDigest }, { create: true });
  return report;
});
export const validationStatus = options => scoped(options, async () => (await inspect(await readRun(options.project))).report);
async function next(options) {
  requireRun(options.phase === undefined || ['handover', 'archive'].includes(options.phase), 'INPUT', 'Creation runs support --phase handover or archive for closeout.');
  const s = await inspect(await readRun(options.project)), { run, report, owner } = s, p = run.coverage;
  const stop = (status, reason, extra = {}) => ({ action: 'mcp-validation-next', schemaVersion: 2, status,
    report, reason, repeatPrompt: false, approvalToken: null, ...extra });
  let request = null, requestFile;
  if (options.config) {
    const config = await assertProjectPath(path.resolve(options.config));
    request = checkCheckpoint(await readControl(config, 65536));
    if (request.file) {
      requestFile = await assertProjectPath(path.resolve(path.dirname(config), request.file));
      request = { ...request, file: requestFile, inputDigest: digest(await readControl(requestFile)) };
    }
  }
  if (run.pending) return stop('blocked', 'Interrupted intent: retain evidence and locks. No execution or checkpoint may erase it.');
  let phase, childPlan, selected = null, selection = null, requiredFlags = [];
  const need = names => names.find(name => owner[name]?.outcome !== 'passed');
  if (request?.kind === 'checkpoint') {
    requireRun(options.phase === undefined && completed(run, 'generate')
      && request.milestones.every(m => s.required.includes(m.name)), 'INPUT', 'Record only applicable owner milestones after generation.');
    phase = 'checkpoint';
  } else if (options.phase === 'handover') {
    requireRun(p.hosting && completed(run, 'generate') && !request, 'INPUT', 'SDK handover uses this run immutable report, not a replacement config.');
    const prefix = `reports/${String(run.events.length).padStart(4, '0')}`;
    const snapshot = await readControl(fileAt(run, `${prefix}.json`)), { snapshotAt, ...savedReport } = snapshot;
    requireRun(digest(savedReport) === digest(report), 'CHANGED', 'Report is stale; record a checkpoint to create a new snapshot before handover.');
    const config = fileAt(run, `${prefix}-handover.json`);
    requireRun(digest(await readControl(config)) === digest(handoverInput(run, report, snapshotAt)), 'CHANGED', 'Retained handover input changed.');
    selected = childOptions(run, options.workspaceRoot, config, fileAt(run, `handover-${run.events.length}`));
    phase = 'handover'; childPlan = await planHandover(selected);
  } else if (options.phase === 'archive') {
    requireRun(!request && s.endpointProject, 'INPUT', 'Archive needs the generated endpoint project and no config.');
    selected = { project: s.endpointProject, output: fileAt(run, `evidence-${run.events.length}.zip`) };
    phase = 'archive'; childPlan = await planMcpEvidenceExport(selected.project, { output: selected.output });
  } else {
    if (s.blocked) return stop('blocked', 'Consumed/failed/unknown history or a lock blocks further execution. Preserve related projects, not just this run.');
    if (report.waiting) return stop('waiting-for-owner', 'Honor the source operator wait; a runner checkpoint does not resume it.');
    if (!completed(run, 'generate')) {
      requireRun(!request, 'INPUT', 'Generate the reviewed source/reference first.');
      phase = 'generate';
      selected = childOptions(run, options.workspaceRoot, fileAt(run, 'definition.json'), fileAt(run, 'source'));
      childPlan = p.hosting ? await planHostingRecipe(selected) : await prepareMcpServer(run.definition);
    } else if (need(!p.existing ? ['prerequisites'] : [])) {
      return stop('waiting-for-owner', 'Complete separately reviewed directory/resource/entitlement prerequisites; record their evidence digest.', { gate: 'prerequisites' });
    } else if (p.hosting && !completed(run, 'release')) {
      const gate = need(['image-build', ...(p.gateway ? ['host-deployment'] : [])]);
      if (gate) return stop('waiting-for-owner', 'Review actual build/scan/SBOM/smoke or host deployment separately; do not build or deploy to satisfy a declaration.', { gate });
      if (!request) return stop('input-required', 'Supply a kind:release request pointing to the exact image/account release config. No image digest is invented.');
      requireRun(request.kind === 'release', 'INPUT', 'The next creation phase is release.');
      phase = 'release'; selected = childOptions(run, options.workspaceRoot, requestFile, fileAt(run, 'release'));
      childPlan = await planRecipeRelease(selected);
    } else if (p.hosting && need(['runtime-deployment', ...(owner['secret-resolution'] ? ['secret-resolution'] : [])])) {
      return stop('waiting-for-owner', 'Perform the reviewed SDK deployment/readiness and secret-reference checks separately, then record owner evidence.',
        { gate: need(['runtime-deployment', ...(owner['secret-resolution'] ? ['secret-resolution'] : [])]) });
    } else if (p.hosting && !completed(run, 'reference')) {
      if (!request) return stop('input-required', 'Supply a kind:reference request with the actual deployed endpoint and new server ID.');
      requireRun(request.kind === 'reference', 'INPUT', 'The next creation phase is endpoint reference.');
      phase = 'reference'; selected = childOptions(run, options.workspaceRoot, requestFile, fileAt(run, 'reference'));
      childPlan = await planRecipeReference(selected);
    } else {
      requireRun(!request, 'INPUT', 'This phase accepts no release/reference config; use the pinned proof and discovery selections.');
      requireRun(digest(await readControl(fileAt(run, 'discovery.json'))) === digest(run.input.discovery),
        'CHANGED', 'Pinned discovery selection changed.');
      if (!p.hosting && !p.existing) await checkIdentity(run);
      if (!p.hosting && !p.existing && (s.status.deployment !== 'recorded-completed'
        || s.status.experimental && s.status.experimental.configuration.status !== 'valid')) {
        const resume = await planMcpResume(s.endpointProject, { phase: 'discovery', config: fileAt(run, 'discovery.json'),
          target: run.input.azureAccount, useDeviceCode: true });
        if (!resume.next.command) return stop('blocked', resume.next.reason, { code: resume.next.code });
        const command = resume.next.command;
        requireRun(['mcp-account-switch', 'mcp-provision', 'mcp-reconcile'].includes(command), 'STATE', 'Unexpected lifecycle operation.');
        phase = command === 'mcp-account-switch' ? 'account' : command === 'mcp-provision' ? 'provision' : 'reconcile';
        childPlan = resume.next.plan;
        selected = { project: s.endpointProject, phase: phase === 'provision' ? resume.next.args[resume.next.args.indexOf('--phase') + 1] : null };
        requiredFlags = phase === 'account' ? ['--allow-network', '--interactive'] : ['--allow-cloud'];
      } else if (report.protocol === 'passed-historical') {
        return stop('checks-recorded', 'Protocol proof is retained, not repeated. Record remaining owner gates and review a separate handover/archive.',
          { remaining: report.milestones.filter(m => m.outcome !== 'passed').map(m => m.name) });
      } else {
        if (need(owner['secret-resolution'] ? ['secret-resolution'] : [])) return stop('waiting-for-owner',
          'Record owner evidence for platform secret-reference resolution before live MCP validation.', { gate: 'secret-resolution' });
        const matching = [];
        for (const observed of s.status.observations.filter(o => o.status === 'valid')) {
          const file = path.join(s.endpointProject, '.mcp-observations', observed.attemptId, 'capture.json');
          const capture = await readControl(file);
          const auth = capture.discoveryPlan.auth;
          if (p.caller === 'anonymous' || auth?.discoveryClientId === run.input.discovery.discoveryClientId.toLowerCase()
            && auth?.expectedUserId === run.input.discovery.expectedUserId.toLowerCase()) matching.push({ file, capture });
        }
        matching.sort((a, b) => a.capture.capturedAt.localeCompare(b.capture.capturedAt));
        const capture = matching.at(-1);
        selected = { workspaceRoot: options.workspaceRoot, project: s.endpointProject, config: fileAt(run, 'session.json') };
        try {
          if (capture) {
            phase = 'proof'; selection = { ...run.input.proof, capture: capture.file };
            childPlan = await planMcpProjectProof(s.endpointProject, selection);
            assertMcpProofHistory(childPlan.proofHistory, childPlan.approvalDigest, childPlan.operation.approvalDigest, childPlan.operation);
            const freshness = resumeFreshness(childPlan);
            if (freshness.status !== 'fits-known-budgets') return stop('blocked', 'The proof capture/configuration cannot cover the known execution budget; no refresh or retry is automatic.');
          } else if (run.input.probeMode === 'session') {
            phase = 'session';
            requireRun(digest(await readControl(selected.config)) === digest({ schemaVersion: 1, discovery: run.input.discovery, proof: run.input.proof }),
              'CHANGED', 'Pinned session input changed.');
            childPlan = await planInteractiveSession(selected);
          } else {
            phase = 'discovery'; selection = run.input.discovery;
            childPlan = await planMcpProjectDiscovery(s.endpointProject, selection);
          }
        } catch (error) {
          if (!['READ_ONLY_REVIEW_REQUIRED', 'PROOF_SCHEMA_UNSUPPORTED', 'PROOF_ARGUMENTS_INVALID', 'UNSAFE_PROOF',
            'AUTH_CONFIG_INVALID', 'PROOF_REPLAY_BLOCKED', 'MCP_CONFIGURATION_STALE', 'PROOF_CAPTURE_INVALID'].includes(error.code)) throw error;
          return stop('blocked', 'The existing proof/discovery planner does not admit this profile or retained selection. It is not a passed gate; no auth/call was dispatched.',
            { code: error.code, proofSupport: p.proofSupport });
        }
        requiredFlags = ['--allow-network', ...(childPlan.operation?.nativeGetMapping ? ['--allow-cloud'] : []),
          ...(p.caller === 'entra' ? ['--interactive'] : [])];
      }
    }
  }
  const freshness = childPlan && resumeFreshness(phase === 'session' ? childPlan.discovery : childPlan);
  if (freshness && ['unknown-budget', 'insufficient-lifetime'].includes(freshness.status)) {
    return stop('blocked', 'The current phase cannot fit its known authentication/execution budget. Review freshness separately; no automatic renewal.');
  }
  const body = { action: 'mcp-validation-next', schemaVersion: 2, status: 'review-required', phase,
    runDirectory: run.dir, buildId: run.buildId, historyDigest: report.historyDigest, request,
    childPlan, selected, selection, requiredFlags,
    effects: phase === 'checkpoint' ? ['Record owner declarations only; never execute or independently attest their actions.']
      : ['Approve only this exact bounded existing phase. No generic shell command, cascading phase, automatic retry or consent.',
        ...(phase === 'session' ? ['Discovery authorization does not approve proof; show its newly generated exact approval separately in the terminal.'] : []),
        ...(phase === 'account' ? ['Fresh project-private Azure sign-in for the exact tenant/subscription/account. No shared cache/account switching.'] : [])] };
  if (phase === 'checkpoint') body.childPlan = null;
  return { ...body, approvalToken: `mcp-validation/${digest(body)}`, report };
}
export const nextValidation = options => scoped(options, () => next(options));
async function checkIdentity(run) {
  let identity;
  try { identity = await readAzureIdentity(mcpRuntimeConfig(run.definition), fileAt(run, 'source')); }
  catch (error) { if (error.code !== 'AZURE_IDENTITY_REQUIRED') throw error; return; }
  if (identity) requireRun(['tenantId', 'subscriptionId', 'accountName'].every(k =>
    identity.target[k].toLowerCase() === run.input.azureAccount[k].toLowerCase()), 'IDENTITY',
  'The selected project-private Azure account differs from the pinned validation identity. Do not infer an account switch.');
}
async function execute(plan, run, options, dependencies) {
  const validationGuard = async () => {
    requireRun(digest(await related(run.input)) === digest(plan.report.relatedHistory), 'CHANGED',
      'Related endpoint history changed during execution. Stop and preserve this attempt; never retry a consumed purpose.');
    const current = await readRun(run.dir);
    requireRun(current.head === run.head && current.contentDigest === run.contentDigest, 'CHANGED', 'Creation run changed during execution.');
    if (!run.coverage.hosting && !run.coverage.existing) await checkIdentity(run);
    for (const phase of ['generate', 'release', 'reference']) {
      const record = completed(run, phase);
      if (record) requireRun(await artifactBinding(run, phase) === record.data.binding, 'CHANGED', 'Source/release/reference changed during execution.');
    }
  };
  const runAzure = async (command, args, operationOptions = {}) => {
    requireRun(!options.signal?.aborted, 'ABORTED', 'Cancelled before the next Azure command.');
    await validationGuard();
    return (dependencies.runAzure ?? runAzureCommand)(command, args, { ...operationOptions, signal: options.signal });
  };
  const approval = plan.childPlan?.approvalToken ?? plan.childPlan?.approvalDigest;
  if (plan.phase === 'generate') return run.coverage.hosting
    ? writeHostingRecipe({ ...plan.selected, approval })
    : createMcpServerProject(plan.childPlan, { workspaceRoot: options.workspaceRoot, projectDir: plan.selected.output, signal: options.signal });
  if (plan.phase === 'release') return writeRecipeRelease({ ...plan.selected, approval });
  if (plan.phase === 'reference') return writeRecipeReference({ ...plan.selected, approval });
  if (plan.phase === 'handover') return writeHandover({ ...plan.selected, approval });
  if (plan.phase === 'archive') return exportMcpEvidence(plan.selected.project, { output: plan.selected.output, approval });
  if (plan.phase === 'account') return switchMcpServerAccount(plan.selected.project, run.input.azureAccount,
    { approval, run: runAzure, useDeviceCode: true, signal: options.signal, onAzureDeviceCode: options.onDeviceCode });
  if (plan.phase === 'provision') return provisionMcpServer(plan.selected.project,
    { phase: plan.selected.phase, approval, run: runAzure });
  if (plan.phase === 'reconcile') return reconcileMcpServer(plan.selected.project,
    { approval, run: runAzure, allowCloud: true, experimentalConfiguration: run.definition.schemaVersion === 3, signal: options.signal });
  if (plan.phase === 'session') return runInteractiveSession({ ...plan.selected, approval, allowNetwork: true,
    signal: options.signal, onDeviceCode: options.onDeviceCode, approveProof: options.approveProof },
  { ...dependencies.sessionDependencies, validationGuard });
  const execution = { selection: plan.selection, approval: plan.childPlan, allowNetwork: true,
    ...(plan.requiredFlags.includes('--allow-cloud') ? { allowCloud: true } : {}),
    signal: options.signal, onDeviceCode: options.onDeviceCode };
  if (dependencies.mcpProjectOperation) return dependencies.mcpProjectOperation(plan.selected.project, execution, plan.phase === 'proof', validationGuard);
  return runMcpProjectValidationOperation(plan.selected.project, execution, plan.phase === 'proof', validationGuard, runAzure);
}
function resultStatus(phase, result) {
  if (phase === 'session' && result.status === 'discovered-proof-declined') return 'declined';
  if (['proof', 'session'].includes(phase)) {
    const value = result.result ?? result;
    return value.status === 'protocol-success' && (!value.backendAssertion || value.backendAssertion.status === 'passed')
      ? 'passed' : value.status === 'unknown' ? 'unknown' : 'failed';
  }
  if (phase === 'provision') return result.lifecycleStatus === 'completed' ? 'passed' : 'unknown';
  if (phase === 'reconcile') return ['reconciled-not-deployed', 'configuration-observed-not-runtime-tested'].includes(result.status) ? 'passed' : 'unknown';
  if (phase === 'account') return result.status === 'account-selected-not-deployed' ? 'passed' : 'unknown';
  if (phase === 'discovery') return ['observed-discovery', 'observed-authenticated-discovery'].includes(result.result?.evidence) ? 'passed' : 'unknown';
  return 'passed';
}
export const runValidation = (options, dependencies = {}) => scoped(options, async () => {
  requireRun(typeof options.project === 'string', 'INPUT', 'Run requires --project.');
  return withControlLock(await assertProjectPath(path.resolve(options.project)), async () => {
    const plan = await next(options);
    requireRun(plan.approvalToken && options.approval === plan.approvalToken, 'APPROVAL', 'Approve the exact current next phase; inputs/history/build may have changed.');
    for (const [flag, key] of [['--allow-network', 'allowNetwork'], ['--allow-cloud', 'allowCloud'], ['--interactive', 'interactive']]) {
      requireRun(plan.requiredFlags.includes(flag) ? options[key] === true : options[key] === undefined, 'FLAGS', 'Supply only this plan required effect flags.');
    }
    requireRun(!options.signal?.aborted, 'ABORTED', 'Cancelled before dispatch.');
    requireRun(!plan.requiredFlags.includes('--interactive') || typeof options.onDeviceCode === 'function', 'FLAGS', 'Interactive sign-in needs a terminal-only challenge callback.');
    requireRun(plan.phase !== 'session' || typeof options.approveProof === 'function', 'FLAGS', 'Session proof requires separate exact terminal approval.');
    const run = await readRun(options.project);
    if (plan.phase === 'checkpoint') { await append(run, 'checkpoint', plan.request); return saveReport(run); }
    requireRun(run.events.length <= 198, 'LIMIT', 'Insufficient journal capacity for intent and result.');
    const intent = await append(run, 'intent', { phase: plan.phase, approvalDigest: digest(plan.approvalToken) });
    let status, binding;
    try {
      const result = await execute(plan, run, options, dependencies);
      status = resultStatus(plan.phase, result);
      binding = ['session', 'proof'].includes(plan.phase) && status !== 'declined'
        ? (result.result?.receiptDigest ?? (result.proofFile ? (await readControl(result.proofFile)).receiptDigest : null))
        : status === 'passed' ? await artifactBinding(run, plan.phase) : null;
    } catch {
      await append(run, 'result', { intentDigest: intent.contentDigest, phase: plan.phase, status: 'unknown', binding: null });
      throw Object.assign(new Error('Creation validation step did not complete. Preserve its intent and child evidence; no automatic retry or raw provider-error retention.'),
        { code: 'MCP_VALIDATION_STEP_UNKNOWN' });
    }
    await append(run, 'result', { intentDigest: intent.contentDigest, phase: plan.phase, status, binding });
    return saveReport(run);
  });
});
