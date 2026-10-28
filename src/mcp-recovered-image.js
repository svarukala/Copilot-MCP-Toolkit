import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { assertProjectPath, withCliWorkspace } from './config.js';
import { readControl, writeControl } from './mcp-control.js';
import { digest, keys } from './mcp-validation.js';
import { readRecipeProject } from './mcp-recipe-artifacts.js';
import { planHostingRecipe } from './mcp-container-apps.js';
import { readAzureIdentity } from './azure-identity.js';
import { getLibraryInfo } from './machine-contract.js';
import { buildFiles, describeHostExecution, runRecoveredImageHost } from './mcp-execution-host.js';
import { inspectBuildRecovery } from './mcp-build-recovery.js';

const location = { type: 'string', minLength: 1, maxLength: 1024 };
export const recoveredImageSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    recoveryOutput: location,
    recoveryApproval: { type: 'string', pattern: '^mcp-build-recovery/sha256:[a-f0-9]{64}$' },
    sourceManifestDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
    azureIdentityProject: location,
    accountName: { type: 'string', format: 'email', maxLength: 254 },
    scannerImage: { type: 'string', pattern: '^aquasec/trivy@sha256:[a-f0-9]{64}$' },
    expiresAt: { type: 'string', format: 'date-time' },
    maximumMs: { type: 'integer', minimum: 60000, maximum: 3600000 },
    localEngineTrusted: { const: true },
    exclusiveControlReviewed: { const: true },
    downloadsReviewed: { const: true },
    resourceCeilingsReviewed: { const: true },
    createOnlyReviewed: { const: true },
    qualificationPushDeploymentReviewed: { const: true },
  },
  required: ['schemaVersion', 'recoveryOutput', 'recoveryApproval', 'sourceManifestDigest', 'azureIdentityProject',
    'accountName', 'scannerImage', 'expiresAt', 'localEngineTrusted', 'exclusiveControlReviewed',
    'downloadsReviewed', 'resourceCeilingsReviewed', 'createOnlyReviewed', 'qualificationPushDeploymentReviewed'],
};
const ajv = new Ajv(); addFormats(ajv);
const valid = ajv.compile(recoveredImageSchema);
const requireRecovered = (ok, code = 'RECOVERED_IMAGE_EVIDENCE_INVALID') => {
  if (!ok) throw Object.assign(new Error(`Recovered-image continuation stopped (${code}); preserve every attempt and claim.`), { code });
};
async function exists(filename) {
  await assertProjectPath(filename);
  try { await lstat(filename); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
}
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
};
const scoped = (options, action) => {
  requireRecovered(['workspaceRoot', 'project', 'config', 'output'].every(key => typeof options?.[key] === 'string'));
  return withCliWorkspace(options.workspaceRoot, action);
};
function continuationClaimPath(recovery, workspaceRoot) {
  const prefix = path.join(workspaceRoot, '.mcp-execution-host-targets',
    digest(recovery.plan.scope.targets.app.toLowerCase()).slice(7));
  return recovery.scanRejections.length
    ? `${prefix}.recovered-image-${digest(recovery.plan.approvalToken).slice(7)}.json`
    : `${prefix}.recovered-image.json`;
}
function continuationDescription(source, oldConfig, input) {
  const original = describeHostExecution(source, { ...oldConfig, ...Object.fromEntries(
    ['scannerImage', 'expiresAt', 'maximumMs', 'azureIdentityProject'].filter(key => input[key] !== undefined)
      .map(key => [key, input[key]])) });
  const { scannerImage, database, javaDatabase } = original.downloads;
  return { ...original, downloads: { scannerImage, database, javaDatabase } };
}

// Historical scan rejection is evidence for a new runtime build, never qualification.
// The caller supplies an already-verified successful recovery to bound recursion.
export async function inspectRejectedImageScan(directory, recovery, workspaceRoot) {
  const check = ok => requireRecovered(ok, 'RECOVERED_IMAGE_SCAN_REJECTION_INVALID');
  check(path.isAbsolute(directory) && recovery.result.status === 'built-unqualified');
  await assertProjectPath(directory);
  const plan = await readControl(path.join(directory, 'plan.json')), scope = plan.scope;
  check(keys(plan, ['approvalToken', 'scope', 'requiresSignIn']) && scope?.kind === 'mcp-recovered-image-plan'
    && scope.schemaVersion === 1 && scope.output === directory && scope.workspaceRoot === workspaceRoot
    && scope.project === recovery.source.projectDir && plan.requiresSignIn === false
    && plan.approvalToken === `mcp-recovered-image/${digest(scope)}`
    && /^sha256:[a-f0-9]{64}$/.test(scope.producerBuild));
  const { dockerSocket, imageRepository, ...input } = scope.config ?? {};
  const old = recovery.parent.old;
  check(valid(input) && input.recoveryOutput === recovery.plan.scope.output
    && input.recoveryApproval === recovery.plan.approvalToken
    && input.sourceManifestDigest === recovery.source.manifest.contentDigest
    && scope.sourceManifestDigest === input.sourceManifestDigest
    && input.azureIdentityProject === old.scope.effective.identityProject
    && input.accountName.toLowerCase() === old.scope.config.accountName.toLowerCase()
    && dockerSocket === old.scope.config.dockerSocket && imageRepository === old.scope.config.imageRepository
    && scope.login === null && digest(scope.evidence) === digest(recovery.binding)
    && digest(scope.targets) === digest(recovery.plan.scope.targets)
    && digest(scope.image) === digest({ localImage: recovery.plan.localImage, ...recovery.built }));
  const originalIdentity = (await readControl(path.join(old.scope.output, 'identity.result.json'))).value.identity;
  const description = continuationDescription(recovery.source, old.scope.config, input);
  check(digest(scope.identity) === digest(originalIdentity) && digest(scope.description) === digest(description)
    && Object.entries(description).every(([key, value]) => key === 'effective'
      ? digest(scope.effective) === digest({ ...value, maximumCommandMs: 60000, identityProject: input.azureIdentityProject })
      : digest(scope[key]) === digest(value)));
  const claimPath = continuationClaimPath(recovery, workspaceRoot);
  check(scope.claim === claimPath);
  const claim = await readControl(claimPath);
  check(digest(claim) === digest(claimRecord(plan)));
  const stages = ['identity', 'preflight', 'recovered-build', 'scan'];
  const privateNames = ['scanner.private.json', 'scanner-database.private.json'];
  const expected = ['plan.json', ...privateNames,
    ...stages.flatMap(stage => [`${stage}.intent.json`, `${stage}.result.json`])].sort();
  check(digest((await readdir(directory)).sort()) === digest(expected));
  const verified = record => {
    const { contentDigest, ...body } = record;
    check(contentDigest === digest(body));
    return record;
  };
  const receipts = {};
  let previous = plan.approvalToken, lastTime = Date.parse(recovery.result.finishedAt);
  for (const stage of stages) {
    const intent = verified(await readControl(path.join(directory, `${stage}.intent.json`)));
    const result = verified(await readControl(path.join(directory, `${stage}.result.json`)));
    const failed = stage === 'scan';
    check(keys(intent, ['schemaVersion', 'plan', 'previous', 'stage', 'status', 'startedAt', 'contentDigest'])
      && intent.schemaVersion === 1 && intent.plan === plan.approvalToken && intent.previous === previous
      && intent.stage === stage && intent.status === 'started-no-replay'
      && Date.parse(intent.startedAt) >= lastTime && Date.parse(intent.startedAt) < Date.parse(input.expiresAt)
      && keys(result, ['schemaVersion', 'plan', 'stage', 'intentDigest', 'status', 'finishedAt', 'contentDigest',
        ...(failed ? ['code', 'reasonCode'] : ['value'])])
      && result.schemaVersion === 1 && result.plan === plan.approvalToken && result.stage === stage
      && result.intentDigest === intent.contentDigest && result.status === (failed ? 'unknown-no-replay' : 'passed')
      && Date.parse(result.finishedAt) >= Date.parse(intent.startedAt) && Date.parse(result.finishedAt) <= Date.now());
    if (failed) check(result.code === 'HOST_EXECUTION_STAGE_STOPPED'
      && ['HOST_EXECUTION_SCAN_POLICY', 'HOST_EXECUTION_SCAN_INCONCLUSIVE'].includes(result.reasonCode));
    if (stage === 'identity') check(digest(result.value?.identity) === digest(originalIdentity));
    if (stage === 'recovered-build') check(digest(result.value) === digest(recovery.built));
    receipts[stage] = { intent: intent.contentDigest, result: result.contentDigest };
    previous = result.contentDigest; lastTime = Date.parse(result.finishedAt);
  }
  const privateDigests = {};
  for (const name of privateNames) {
    const filename = await assertProjectPath(path.join(directory, name)), stat = await lstat(filename);
    check(stat.isFile() && stat.size > 0 && stat.size <= description.effective.maximumReportBytes);
    const bytes = await readFile(filename);
    check(bytes.length === stat.size);
    const document = JSON.parse(bytes);
    check(document !== null && typeof document === 'object' && !Array.isArray(document));
    privateDigests[name] = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  }
  return { output: directory, plan: plan.approvalToken, planDigest: digest(plan),
    claimDigest: claim.contentDigest, receipts, privateDigests };
}

async function inspect(source, config, workspaceRoot, context) {
  const recovery = await inspectBuildRecovery(config.recoveryOutput, workspaceRoot, context);
  requireRecovered(recovery.result.status === 'built-unqualified'
    && recovery.plan.approvalToken === config.recoveryApproval
    && source.projectDir === recovery.source.projectDir
    && source.manifest.contentDigest === config.sourceManifestDigest
    && source.manifest.contentDigest === recovery.source.manifest.contentDigest);
  const old = recovery.parent.old;
  const identity = await readAzureIdentity({ azure: source.input.azure }, config.azureIdentityProject, { required: true });
  const originalIdentity = (await readControl(path.join(old.scope.output, 'identity.result.json'))).value.identity;
  requireRecovered(config.azureIdentityProject === old.scope.effective.identityProject
    && config.accountName.toLowerCase() === old.scope.config.accountName.toLowerCase()
    && identity.target.accountName === config.accountName.toLowerCase()
    && digest(identity) === digest(originalIdentity), 'RECOVERED_IMAGE_IDENTITY_MISMATCH');
  return { ...recovery, identity };
}
async function prepare(options) {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const configPath = await assertProjectPath(path.resolve(options.config)), input = await readControl(configPath);
  requireRecovered(valid(input) && path.isAbsolute(input.recoveryOutput) && path.isAbsolute(input.azureIdentityProject),
    'RECOVERED_IMAGE_CONFIG_INVALID');
  requireRecovered(Date.parse(input.expiresAt) > Date.now() && Date.parse(input.expiresAt) <= Date.now() + 86400000,
    'RECOVERED_IMAGE_EXPIRED');
  const source = await readRecipeProject(options.project);
  const recovery = await inspect(source, input, workspaceRoot);
  const output = await assertProjectPath(path.resolve(options.output));
  requireRecovered((await lstat(path.dirname(output))).isDirectory());
  for (const dir of [...recovery.protectedPaths, recovery.parent.old.scope.output, recovery.parent.outer,
    input.azureIdentityProject].filter(Boolean)) {
    requireRecovered(!within(dir, output) && !within(output, dir), 'RECOVERED_IMAGE_OUTPUT_OVERLAP');
  }
  requireRecovered(!within(output, configPath), 'RECOVERED_IMAGE_OUTPUT_OVERLAP');
  const prefix = path.join(workspaceRoot, '.mcp-execution-host-targets',
    digest(recovery.plan.scope.targets.app.toLowerCase()).slice(7));
  const claim = continuationClaimPath(recovery, workspaceRoot);
  requireRecovered(!await exists(claim) && !await exists(`${prefix}.verified-image.json`), 'RECOVERED_IMAGE_CONSUMED');
  const generated = await planHostingRecipe({ workspaceRoot, config: path.join(source.projectDir, 'recipe-definition.json'),
    output: `${output}.source-verification` });
  requireRecovered([...buildFiles, ...Object.keys(source.files).filter(name => name.startsWith('infra/'))]
    .every(name => source.files[name]?.toString('utf8') === generated.files[name]), 'RECOVERED_IMAGE_SOURCE_MISMATCH');
  const oldConfig = recovery.parent.old.scope.config;
  const config = { ...input, dockerSocket: oldConfig.dockerSocket, imageRepository: oldConfig.imageRepository };
  const description = continuationDescription(source, oldConfig, input);
  const scope = {
    schemaVersion: 1, kind: 'mcp-recovered-image-plan', workspaceRoot, project: source.projectDir,
    output, configPath, config, claim, producerBuild: (await getLibraryInfo()).contentDigest,
    sourceManifestDigest: source.manifest.contentDigest, evidence: recovery.binding,
    image: { localImage: recovery.plan.localImage, ...recovery.built },
    identity: recovery.identity, login: null, targets: recovery.plan.scope.targets,
    description, ...description, effective: { ...description.effective, maximumCommandMs: 60000,
      identityProject: input.azureIdentityProject },
    effects: [
      'Separate one-shot qualification, upload and create-only deployment of the exact successful recovered local image. No rebuild or adoption of failed/unknown images.',
      'Preserve every original source, failure, reservation and recovery claim. Take one durable target-scoped continuation claim before any external operation; failure or interruption remains consumed.',
      'Recheck the sealed lineage, source, same private Azure identity, exact engine and recovered image ID/owner. No sign-in, shared cache use or account switching.',
      'Download the exact pinned Trivy image and named scanner databases. Scan the actual exported image with fresh zero-critical/high results and retain bounded reports privately.',
      'Run nonroot network-disabled smoke with a synthetic backend key if needed. No provider request or real secret resolution during smoke.',
      'Add only an absent unique local tag to the qualified image, obtain a transient ACR token in memory and push once. Never overwrite an existing local tag, delete the original image or perform Docker login.',
      'Use existing create-only app/gateway stages, absence and registry-digest rechecks, conditional writes, readiness polling and one bounded public health GET. Preserve unrelated resources and inherited policies.',
      'No role grants, secret reads, discovery, proof, consumer publication or automatic retry. Exclusive engine/target control and prerequisites are owner-reviewed; resource ceilings are not a billing cap.',
      ...(recovery.scanRejections.length ? [
        'This runtime-remediation lineage preserves every rejected scan and its claim. The replacement recovered build gets one deterministic continuation claim; all qualification gates run afresh with unchanged policy. No old scan approval or report is reused.',
      ] : []),
    ],
  };
  const plan = { approvalToken: `mcp-recovered-image/${digest(scope)}`, scope, requiresSignIn: false };
  if (await exists(output)) requireRecovered((await readdir(output))
    .every(name => name === '.mcp-execution-host.lock'), 'RECOVERED_IMAGE_OUTPUT_EXISTS');
  return plan;
}
async function evidence(plan, context) {
  const scope = plan.scope;
  const source = await readRecipeProject(scope.project);
  const current = await inspect(source, scope.config, scope.workspaceRoot, context);
  requireRecovered(digest(current.binding) === digest(scope.evidence)
    && digest(current.identity) === digest(scope.identity)
    && (await getLibraryInfo()).contentDigest === scope.producerBuild, 'RECOVERED_IMAGE_EVIDENCE_CHANGED');
  if (context?.claimed) requireRecovered(digest(await readControl(scope.claim)) === digest(claimRecord(plan)),
    'RECOVERED_IMAGE_EVIDENCE_CHANGED');
  return current;
}
function claimRecord(plan) {
  const scope = plan.scope;
  const claim = { schemaVersion: 1, plan: plan.approvalToken, parent: scope.config.recoveryApproval,
    resourceId: scope.targets.app, evidence: scope.evidence };
  return { ...claim, contentDigest: digest(claim) };
}
async function reserve(plan) {
  await evidence(plan);
  try { await writeControl(plan.scope.claim, claimRecord(plan), { create: true }); }
  catch (error) { if (error.code === 'EEXIST') requireRecovered(false, 'RECOVERED_IMAGE_CONSUMED'); throw error; }
}
export const planRecoveredImage = options => scoped(options, () => prepare(options));
export const runRecoveredImage = (options, dependencies = {}) =>
  runRecoveredImageHost(options, dependencies, { prepare, evidence, reserve });
