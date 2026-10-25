import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { assertProjectPath, isWithin, withCliWorkspace } from './config.js';
import { boundedSnapshot, metadataDigest, savedJson } from './anonymous-metadata.js';
import { readControl } from './mcp-control.js';
import { compileHostingRecipe } from './mcp-container-apps.js';
import { readRecipeProject, sourceArchive } from './mcp-recipe-artifacts.js';
import { readOperatorHandover } from './mcp-operator.js';
import { readMcpServerProject } from './mcp-lifecycle.js';
import { readMcpProofHistory } from './mcp-proof-history.js';
import { mcpCaptureFreshness } from './mcp-discovery.js';
import { checkedResultAssertionEvidence } from './mcp-result-assertion.js';
import { getLibraryInfo } from './machine-contract.js';
import { secretIssues } from './validation.js';
import { handoverResources, destinationEdits, handoverGuide, reviewSourceScript } from './mcp-handover-guide.js';
import { handoverArchitecture, architectureExcalidraw, standaloneArchitectureSvg, renderHandover } from './mcp-handover-render.js';

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const text = { type: 'string', minLength: 1, maxLength: 500, pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]+$' };
const timestamp = { type: 'string', format: 'date-time', maxLength: 24 };
const filename = { type: 'string', minLength: 1, maxLength: 2048 };
const milestoneNames = ['auth-registration', 'directory-settings', 'runtime-deployment', 'authorization',
  'fcc-save', 'admin-ready', 'audience', 'consumer-call', 'read-only-ui'];
export const handoverSchema = object({
  schemaVersion: { const: 1 }, snapshotAt: timestamp, privateExportReviewed: { const: true },
  referenceProject: filename, releaseDirectory: filename,
  milestones: { type: 'array', maxItems: milestoneNames.length, items: object({
    name: { enum: milestoneNames }, outcome: { enum: ['passed', 'failed', 'pending', 'deferred'] },
    observedAt: timestamp, note: text,
  }, ['name', 'outcome', 'observedAt']) },
  resourceOutcomes: { type: 'array', maxItems: 30, items: object({
    resourceId: { type: 'string', minLength: 1, maxLength: 512 },
    disposition: { enum: ['created', 'reused', 'changed'] }, observedAt: timestamp,
  }) },
  operationsNote: text, costNote: text,
}, ['schemaVersion', 'snapshotAt', 'privateExportReviewed']);
const ajv = new Ajv(); addFormats(ajv);
const validate = ajv.compile(handoverSchema);
const digest = value => metadataDigest(boundedSnapshot(value));
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function requireHandover(ok, code, message) {
  if (!ok) throw Object.assign(new Error(message), { code: `MCP_HANDOVER_${code}` });
}
function dateAt(value, cutoff) {
  requireHandover(typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value && Date.parse(value) <= Date.parse(cutoff),
  'DATE', 'Use canonical UTC timestamps at or before snapshotAt; choose a fresh snapshot after the latest records.');
}
async function absent(output) {
  try { await lstat(output); requireHandover(false, 'OUTPUT_EXISTS', 'Choose a new handover directory; never replace an existing snapshot.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function bytesAt(file, maximum = 5 * 1048576) {
  await assertProjectPath(file);
  const stat = await lstat(file);
  requireHandover(stat.isFile() && stat.size <= maximum, 'FILE', 'Handover imports must be bounded regular files.');
  return readFile(file);
}
const sourceNames = new Set(['runtime.js', 'server.js', 'package.json', 'package-lock.json', '.npmrc', '.gitignore',
  '.dockerignore', 'Dockerfile', 'runtime-config.json', 'recipe-definition.json', 'recipe-review.json',
  'infra/container-app.json', 'infra/apim-gateway.json', 'infra/app-service.json', 'infra/functions.json',
  'README.md', 'hosting-recipes.md', 'deployment-handover.md', 'deployment-handover.example.json',
  'host.json', '.funcignore', 'local.settings.example.json',
  'LICENSE', 'THIRD-PARTY-NOTICES.md']);

export async function readHandoverRelease(directory, project) {
  const release = await readControl(path.join(directory, 'release-review.json'));
  const archive = sourceArchive(project.files), functions = project.input.recipe === 'functions-sdk-v1';
  requireHandover(release.schemaVersion === 1 && release.kind === 'mcp-recipe-release-review'
    && release.recipe === project.input.recipe && release.sourceManifestDigest === project.manifest.contentDigest
    && release.sourceArchiveSha256 === hash(archive)
    && digest(release.target) === digest(project.input.azure) && digest(release.backend) === digest(project.input.backend)
    && release.execution === 'operator-reviewed-not-executed' && !secretIssues(savedJson(release)),
  'RELEASE', 'Release must match the exact sealed source, target and backend; it is not deployment evidence.');
  if (functions) requireHandover(release.artifact?.sourceArchiveSha256 === hash(archive), 'RELEASE', 'Functions source hash differs.');
  else requireHandover(typeof release.artifact?.image === 'string'
    && release.artifact.image.startsWith(`${project.input.azure.registry.server}/`)
    && /^[a-z0-9.-]+\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(release.artifact.image),
  'RELEASE', 'Release must select a digest-pinned image in the source registry.');
  if (project.input.azure.gateway) {
    const url = new URL(release.gatewayBackendOrigin);
    requireHandover(url.protocol === 'https:' && url.origin === release.gatewayBackendOrigin && !url.port
      && url.hostname.startsWith(`${project.input.azure.appName}.`) && url.hostname.endsWith('.azurecontainerapps.io'),
    'RELEASE', 'Gateway release origin must be the selected Container App, not an arbitrary target.');
  }
  const actualArchive = await bytesAt(path.join(directory, 'source.zip'));
  requireHandover(hash(actualArchive) === hash(archive), 'RELEASE', 'Release source.zip differs; preserve the original.');
  const files = { 'release/source.zip': actualArchive };
  const templates = Object.entries(project.files).filter(([name]) => name.startsWith('infra/'));
  requireHandover(release.templateHashes && Object.keys(release.templateHashes).length === templates.length,
    'RELEASE', 'Release template inventory differs.');
  for (const [name, original] of templates) {
    const bytes = await bytesAt(path.join(directory, ...name.split('/')));
    requireHandover(hash(bytes) === hash(original) && release.templateHashes[name] === hash(bytes),
      'RELEASE', 'Release template differs from the sealed source.');
    files[`release/${name}`] = bytes;
    const parameterName = name.replace(/\.json$/, '.parameters.json');
    const parameters = await readControl(path.join(directory, ...parameterName.split('/')));
    const supplied = { containerImage: release.artifact.image, backendOrigin: release.gatewayBackendOrigin };
    const expected = Object.fromEntries(Object.keys(JSON.parse(original).parameters ?? {}).map(key => {
      requireHandover(supplied[key] !== undefined, 'RELEASE', 'Unsupported release template parameter.');
      return [key, { value: supplied[key] }];
    }));
    requireHandover(parameters.$schema === 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
      && parameters.contentVersion === '1.0.0.0' && Object.keys(parameters).length === 3
      && digest(parameters.parameters) === digest(expected), 'RELEASE', 'Release parameter file differs from its artifact or target.');
    files[`release/${parameterName}`] = savedJson(parameters);
  }
  const summary = { sourceManifestDigest: project.manifest.contentDigest, sourceArchiveSha256: hash(archive),
    artifact: functions ? { sourceArchiveSha256: hash(archive) } : { image: release.artifact.image },
    provenance: 'integrity-checked-release-not-deployment-or-image-source-attestation' };
  files['release/release-summary.json'] = savedJson(summary);
  return { files, summary, review: release };
}

async function referenceEvidence(directory, project, cutoff) {
  const origin = await readControl(path.join(directory, 'recipe-origin.json'));
  const reference = await readMcpServerProject(directory), a = project.runtime.authentication;
  const inbound = { type: 'entra', tenantId: a.tenantId, clientId: a.audience,
    applicationIdUri: a.applicationIdUri, scope: a.scope, allowedClientIds: a.allowedClientIds };
  requireHandover(origin.schemaVersion === 1 && origin.kind === 'recipe-endpoint-reference'
    && origin.recipe === project.input.recipe && origin.sourceManifestDigest === project.manifest.contentDigest
    && origin.endpoint === reference.review.descriptor.endpoint && reference.review.input.kind === 'existing-mcp'
    && digest(reference.review.input.inbound) === digest(inbound)
    && (!project.runtime.gateway || origin.endpoint === project.runtime.gateway.publicUrl),
  'REFERENCE', 'Reference must originate from this exact source and match its endpoint/authentication contract.');
  const history = await readMcpProofHistory(directory), evidence = [];
  for (const attempt of history.attempts) {
    const folder = path.join(directory, '.mcp-observations', attempt.attemptId);
    const intent = await readControl(path.join(folder, 'intent.json'));
    dateAt(intent.startedAt, cutoff);
    requireHandover(intent.reviewDigest === reference.review.reviewDigest, 'EVIDENCE', 'Observation belongs to another reference review.');
    if (attempt.status === 'not-proof') {
      let capture;
      try { capture = await readControl(path.join(folder, 'capture.json')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (capture) {
        const freshness = mcpCaptureFreshness(capture);
        dateAt(freshness.capturedAt, cutoff);
        requireHandover(capture.source.descriptorDigest === reference.review.descriptor.descriptorDigest,
          'EVIDENCE', 'Discovery belongs to another reference.');
        evidence.push({ kind: 'tools/list', status: Date.parse(cutoff) <= Date.parse(freshness.expiresAt)
          ? 'verified-historical' : 'stale-historical', observedAt: freshness.capturedAt,
        evidenceDigest: digest(capture), meaning: 'Recorded discovery metadata only; not deployment, business correctness or consumer acceptance.' });
      } else evidence.push({ kind: 'tools/list', status: attempt.failureStatus ?? 'unconfirmed', observedAt: intent.startedAt,
        evidenceDigest: attempt.filesDigest, meaning: 'No retained capture. No retry or current readiness is implied.' });
    } else if (attempt.status === 'completed') {
      const proof = await readControl(path.join(folder, attempt.qualification ? 'qualification.json' : 'proof.json'), 65536);
      const { receiptDigest, ...body } = proof;
      dateAt(proof.completedAt, cutoff);
      requireHandover(receiptDigest === digest(body) && proof.sourceDigest === reference.review.descriptor.descriptorDigest
        && Date.parse(proof.completedAt) >= Date.parse(intent.startedAt)
        && proof.approvalDigest === intent.operationDigest && project.runtime.tools.some(t => t.name === proof.toolName),
      'EVIDENCE', 'Proof must match this reference, tool and retained operation.');
      if (proof.resultAssertion) checkedResultAssertionEvidence(proof);
      evidence.push({ kind: `tools/call: ${proof.toolName}`, status: proof.status === 'protocol-success' ? 'verified-historical' : 'failed-historical',
        observedAt: proof.completedAt, evidenceDigest: receiptDigest,
        meaning: `Recorded MCP protocol result only; not consumer or business acceptance.${proof.backendAssertion ? ` Scoped backend assertion: ${proof.backendAssertion.status}.` : ''} This call remains consumed.` });
    } else evidence.push({ kind: 'tools/call', status: attempt.status, observedAt: intent.startedAt,
      evidenceDigest: attempt.filesDigest, meaning: 'No successful protocol result established. Preserve dispatch history; this report authorizes no retry.' });
  }
  return { endpoint: origin.endpoint, historyDigest: history.historyDigest, evidence };
}

async function prepare(options, { writing = false } = {}) {
  requireHandover(typeof options.config === 'string' && typeof options.output === 'string',
    'INPUT', 'Handover requires --config and a new --output directory.');
  const configPath = await assertProjectPath(path.resolve(options.config));
  const input = await readControl(configPath, 65536);
  requireHandover(validate(input) && !secretIssues(savedJson(input)), 'INPUT',
    'Use mcp-handover-schema with a UTC snapshotAt and privateExportReviewed: true. No secrets, raw logs or verified-status declarations.');
  dateAt(input.snapshotAt, new Date().toISOString());
  for (const key of ['milestones', 'resourceOutcomes']) {
    const rows = input[key] ?? [];
    requireHandover(new Set(rows.map(r => (r.name ?? r.resourceId).toLowerCase())).size === rows.length,
      'INPUT', 'Duplicate milestone or resource declarations are not supported.');
    for (const row of rows) dateAt(row.observedAt, input.snapshotAt);
  }
  const project = await readRecipeProject(options.project), compiled = compileHostingRecipe(project.input);
  const templates = project.input.recipe === 'functions-sdk-v1' ? ['infra/functions.json']
    : project.input.recipe === 'app-service-container-v1' ? ['infra/app-service.json']
      : ['infra/container-app.json', ...(project.input.azure.gateway ? ['infra/apim-gateway.json'] : [])];
  requireHandover(digest(compiled.runtime) === digest(project.runtime)
    && Object.keys(project.files).every(name => sourceNames.has(name))
    && ['README.md', 'hosting-recipes.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', ...templates,
      ...(project.input.imageBuild ? ['Dockerfile'] : [])].every(name => Object.hasOwn(project.files, name))
    && Object.keys(project.files).filter(name => name.startsWith('infra/')).length === templates.length,
  'SOURCE', 'Source runtime or file inventory differs from the supported hosting recipe.');
  const outputPath = await assertProjectPath(path.resolve(options.output));
  requireHandover((await lstat(path.dirname(outputPath))).isDirectory() && !isWithin(project.projectDir, outputPath),
    'OUTPUT', 'Use a new directory outside the sealed source, with an existing parent.');
  if (!writing) await absent(outputPath);
  const files = Object.fromEntries(Object.entries(project.files).map(([name, bytes]) => [`source/${name}`, bytes]));
  files['source/recipe-manifest.json'] = savedJson(project.manifest);
  const operator = await readOperatorHandover({ workspaceRoot: options.workspaceRoot, project: project.projectDir });
  if (operator.recordedAt) dateAt(operator.recordedAt, input.snapshotAt);
  const milestones = milestoneNames.map(name => {
    const supplied = input.milestones?.find(row => row.name === name), recorded = operator.milestones[name];
    if (supplied) {
      requireHandover(!operator.milestoneDates[name] || Date.parse(supplied.observedAt) >= Date.parse(operator.milestoneDates[name]),
        'DATE', 'A new milestone declaration cannot precede its existing journal result.');
      return { name, status: ['passed', 'failed'].includes(supplied.outcome) ? `user-reported-${supplied.outcome}` : supplied.outcome,
        provenance: 'handover-owner-declaration-not-independently-verified', observedAt: supplied.observedAt,
        ...(supplied.note ? { note: supplied.note } : {}),
        ...(recorded.status !== 'not-confirmed' ? { previousJournalOutcome: recorded.status } : {}) };
    }
    return recorded.status === 'not-confirmed' ? { name, status: 'pending', provenance: 'not-recorded' }
      : { name, status: `user-reported-${recorded.status}`, provenance: recorded.provenance,
        observedAt: operator.milestoneDates[name], evidenceDigest: recorded.evidenceDigest };
  });
  const resources = handoverResources(project.input);
  for (const row of input.resourceOutcomes ?? []) {
    const resource = resources.find(r => r.resourceId.toLowerCase() === row.resourceId.toLowerCase());
    requireHandover(resource, 'RESOURCE', 'Resource declarations must name an exact configured resource in this recipe.');
    Object.assign(resource, { disposition: row.disposition, observedAt: row.observedAt,
      provenance: 'owner-reported-not-service-readback' });
  }
  let release, reference;
  for (const [key, load] of [['releaseDirectory', dir => readHandoverRelease(dir, project)],
    ['referenceProject', dir => referenceEvidence(dir, project, input.snapshotAt)]]) {
    if (input[key] === undefined) continue;
    const dir = await assertProjectPath(path.resolve(path.dirname(configPath), input[key]));
    requireHandover(!isWithin(dir, outputPath), 'OUTPUT', 'Do not place the handover inside imported release or evidence directories.');
    const result = await load(dir);
    if (key === 'releaseDirectory') { release = result.summary; Object.assign(files, result.files); }
    else reference = result;
  }
  const info = await getLibraryInfo();
  const report = {
    schemaVersion: 1, kind: 'mcp-deployment-handover', snapshotAt: input.snapshotAt, producerBuild: info.contentDigest,
    sourceManifestDigest: project.manifest.contentDigest, operatorJournalHead: operator.head,
    ...(reference ? { referenceHistoryDigest: reference.historyDigest } : {}), ...(release ? { release } : {}),
    authority: 'private-local-snapshot-not-live-readiness-or-execution-authority',
    executionReadiness: false, proofReplayAuthorized: false,
    summary: { name: project.input.name, recipe: project.input.recipe, azure: project.input.azure,
      authentication: project.input.authentication, backend: project.input.backend, tools: compiled.runtime.tools,
      endpoint: reference?.endpoint ?? project.runtime.gateway?.publicUrl ?? null,
      endpointProvenance: reference ? 'operator-supplied-reference-not-deployment-readback' : 'recipe-configuration-only' },
    milestones, resources, waiting: operator.waiting,
    operatorActivity: Object.entries(operator.operations).map(([key, item]) => ({
      kind: item.operation.kind, target: item.operation.target, status: item.status,
      observedAt: operator.operationDates[key], provenance: item.provenance,
      replayAuthorized: false,
    })),
    evidence: [{ kind: 'source files', status: 'integrity-checked',
      meaning: 'Manifest hashes matched. This is not source safety, signature, deployment or runtime verification.' },
    ...(release ? [{ kind: 'release files', status: 'integrity-checked',
      meaning: 'Archive, templates and parameters match this source. No deployment or image-source attestation.' }] : []),
    ...(reference?.evidence ?? [])],
    operationsNote: input.operationsNote ?? 'Owner, support and rotation responsibilities are not recorded. Preserve unrelated resources, credentials, immutable evidence and locks.',
    costNote: input.costNote ?? 'Pricing and cost ownership are not recorded. Existing plans/APIM can incur charges; scaling limits are not spending caps. Teardown requires a separate ownership review.',
    destinationEdits: destinationEdits(project.input), steps: handoverGuide(project.input),
    architecture: handoverArchitecture(project.input),
    downloads: [
      { path: 'handover-manifest.json', label: 'Machine-readable handover and artifact hashes' },
      { path: 'source/recipe-definition.json', label: 'Original recipe (copy before editing)' },
      { path: 'source/README.md', label: 'Host installation/deployment guide' },
      { path: 'source/hosting-recipes.md', label: 'Shared hosting and API-key safeguards' },
      ...Object.keys(files).filter(name => name.startsWith('source/infra/') || name.startsWith('release/'))
        .map(name => ({ path: name, label: name })),
    ],
  };
  files['architecture.excalidraw'] = savedJson(architectureExcalidraw(report.architecture));
  files['architecture.svg'] = standaloneArchitectureSvg(report.architecture);
  files['scripts/review-source.ps1'] = reviewSourceScript;
  files['index.html'] = renderHandover(report);
  const artifacts = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, bytes]) => [name, { sha256: hash(bytes), bytes: Buffer.byteLength(bytes) }]));
  const body = { ...report, artifacts };
  const manifest = { ...body, contentDigest: digest(body) };
  const plan = { action: 'mcp-handover-bundle', status: 'planned-local-handover-only', outputPath, manifest,
    effects: ['Writes a new private folder containing the two-tab HTML, SVG/Excalidraw, source and selected release artifacts.',
      'Contains environment IDs and operator-declared metadata. Review before sharing; no credentials/caches/raw captures are copied.',
      'No installation, sign-in, deployment, provider call, proof replay, browser upload or external asset fetch.'] };
  return { ...plan, approvalToken: `mcp-handover/${digest({ configPath, project: project.projectDir, input, plan })}`, files };
}
async function inWorkspace(options, action) {
  requireHandover(typeof options.workspaceRoot === 'string' && typeof options.project === 'string',
    'WORKSPACE', 'Handover requires explicit --workspace-root and sealed hosting --project.');
  return withCliWorkspace(options.workspaceRoot, action);
}
export const planHandover = options => inWorkspace(options, async () => {
  const { files, ...plan } = await prepare(options);
  return plan;
});
export const writeHandover = options => inWorkspace(options, async () => {
  const plan = await prepare(options);
  requireHandover(options.approval === plan.approvalToken, 'APPROVAL', 'Exact current handover plan approvalToken is required.');
  await mkdir(plan.outputPath, { mode: 0o700 });
  for (const [name, bytes] of Object.entries(plan.files)) {
    const file = await assertProjectPath(path.join(plan.outputPath, ...name.split('/')));
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    requireHandover(hash(await bytesAt(file)) === hash(bytes), 'READBACK', 'Handover readback differs; preserve the incomplete directory.');
  }
  const fresh = await prepare(options, { writing: true });
  requireHandover(fresh.approvalToken === plan.approvalToken, 'INPUT_CHANGED',
    'Source, journal, evidence, release, configuration or toolkit changed while writing. Preserve incomplete output and review a new destination.');
  const manifestPath = await assertProjectPath(path.join(plan.outputPath, 'handover-manifest.json'));
  await writeFile(manifestPath, savedJson(plan.manifest), { flag: 'wx', mode: 0o600 });
  requireHandover(hash(await bytesAt(manifestPath)) === hash(savedJson(plan.manifest)), 'READBACK', 'Manifest readback differs; preserve output.');
  return { status: 'handover-written-not-executed', outputPath: plan.outputPath, entryFile: path.join(plan.outputPath, 'index.html'),
    contentDigest: plan.manifest.contentDigest, executionReadiness: false, proofReplayAuthorized: false };
});
