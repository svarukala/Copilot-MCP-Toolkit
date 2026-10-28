import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import path from 'node:path';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { assertProjectPath, withCliWorkspace } from './config.js';
import { readControl, writeControl } from './mcp-control.js';
import { digest, keys } from './mcp-validation.js';
import { readRecipeProject } from './mcp-recipe-artifacts.js';
import { planHostingRecipe } from './mcp-container-apps.js';
import { getLibraryInfo } from './machine-contract.js';
import { buildFiles, buildHostImage, buildImageEvidenceDigest, describeHostExecution, resourceTargets } from './mcp-execution-host.js';
import { failedHostExecutionEvidence } from './mcp-execution.js';
import { executionDockerRequest, executionJson, dockerFailureDiagnostic } from './mcp-execution-docker.js';

const hash = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' };
const replacementFields = ['supersededRecoveryOutput', 'replacementProject', 'replacementSourceManifestDigest', 'sourceChangesReviewed'];
export const buildRecoverySchema = {
  type: 'object', additionalProperties: false,
  not: { required: ['rejectedRecoveryOutput', 'connectionRecoveryOutput'] },
  anyOf: [
    { not: { anyOf: replacementFields.map(name => ({ required: [name] })) } },
    { required: replacementFields, not: { anyOf: [
      { required: ['rejectedRecoveryOutput'] }, { required: ['connectionRecoveryOutput'] },
    ] } },
  ],
  dependencies: { scanRejectedContinuationOutput: replacementFields },
  properties: {
    schemaVersion: { const: 1 },
    oldHostOutput: { type: 'string', minLength: 1, maxLength: 1024 },
    oldHostApproval: { type: 'string', pattern: '^mcp-host-execution/sha256:[a-f0-9]{64}$' },
    rejectedRecoveryOutput: { type: 'string', minLength: 1, maxLength: 1024,
      description: 'Optional original recovery that stopped at engine security after exactly two read-only requests, with no build intent. Authorizes only one separately approved linked successor; never resets its claim.' },
    connectionRecoveryOutput: { type: 'string', minLength: 1, maxLength: 1024,
      description: 'Optional linked recovery stopped on its first Docker version GET with DOCKER_RESPONSE_UNKNOWN and no build intent. A fresh explicit attempt consumes a unique child claim while preserving the failed parent; never retries a build.' },
    supersededRecoveryOutput: { type: 'string', minLength: 1, maxLength: 1024,
      description: 'Sealed failed recovery, or a successful recovery with scanRejectedContinuationOutput. A reviewed build-input revision creates one append-only child, never a replay or a new target reservation.' },
    scanRejectedContinuationOutput: { type: 'string', minLength: 1, maxLength: 1024,
      description: 'Sealed recovered-image continuation stopped at scan policy/inconclusive with no later stages. Requires a successful superseded recovery and a different pinned runtime image; preserves all claims and requires new build and qualification approvals.' },
    replacementProject: { type: 'string', minLength: 1, maxLength: 1024 },
    replacementSourceManifestDigest: hash,
    sourceChangesReviewed: { const: true,
      description: 'Review the new generated source. Only npm registry and pinned build images may change; runtime, dependency versions/integrities, identity and deployment targets remain unchanged.' },
    sourceManifestDigest: hash,
    accountName: { type: 'string', format: 'email', maxLength: 254 },
    expiresAt: { type: 'string', format: 'date-time' },
    maximumMs: { type: 'integer', minimum: 60000, maximum: 3600000 },
    localEngineTrusted: { const: true },
    previousBuildStoppedReviewed: { const: true,
      description: 'Owner confirmed prior builds and any rejected scan stopped, with exclusive engine access for this attempt. Label inspection alone cannot prove legacy builder quiescence.' },
    buildOnlyReviewed: { const: true },
    downloadsReviewed: { const: true },
    resourceCeilingsReviewed: { const: true },
  },
  required: ['schemaVersion', 'oldHostOutput', 'oldHostApproval', 'sourceManifestDigest', 'accountName',
    'expiresAt', 'localEngineTrusted', 'previousBuildStoppedReviewed', 'buildOnlyReviewed',
    'downloadsReviewed', 'resourceCeilingsReviewed'],
};
const ajv = new Ajv(); addFormats(ajv);
const valid = ajv.compile(buildRecoverySchema);
const requireRecovery = (ok, code = 'BUILD_RECOVERY_EVIDENCE_INVALID') => {
  if (!ok) throw Object.assign(new Error(`Build recovery stopped (${code}); preserve the parent and recovery claim. No automatic retry.`), { code });
};
const seal = body => ({ ...body, contentDigest: digest(body) });
function verify(record) {
  const { contentDigest, ...body } = record;
  requireRecovery(contentDigest === digest(body));
  return record;
}
async function exists(filename) {
  await assertProjectPath(filename);
  try { await lstat(filename); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
}
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
};
const scoped = (options, action) => {
  requireRecovery(['workspaceRoot', 'project', 'config', 'output'].every(key => typeof options?.[key] === 'string'),
    'BUILD_RECOVERY_OPTIONS_REQUIRED');
  return withCliWorkspace(options.workspaceRoot, action);
};

async function evidence(source, config, workspaceRoot, activeIdentityProject) {
  const oldOutput = await assertProjectPath(config.oldHostOutput);
  const outer = path.dirname(oldOutput);
  for (const dir of [oldOutput, outer, source.projectDir]) {
    if (dir === source.projectDir && dir !== oldOutput && dir !== outer && dir === activeIdentityProject) continue;
    requireRecovery(!await exists(path.join(dir, '.mcp-execution-host.lock')), 'BUILD_RECOVERY_PARENT_LOCKED');
  }
  const old = await readControl(path.join(oldOutput, 'plan.json'));
  requireRecovery(old.approvalToken === config.oldHostApproval
    && old.approvalToken === `mcp-host-execution/${digest(old.scope)}`
    && old.scope.kind === 'mcp-host-execution-plan' && old.scope.schemaVersion === 1
    && old.scope.output === oldOutput && old.scope.project === source.projectDir
    && old.scope.workspaceRoot === workspaceRoot
    && /^sha256:[a-f0-9]{64}$/.test(old.scope.producerBuild)
    && old.scope.sourceManifestDigest === source.manifest.contentDigest
    && config.sourceManifestDigest === source.manifest.contentDigest
    && config.accountName.toLowerCase() === old.scope.config.accountName.toLowerCase());
  const description = describeHostExecution(source, old.scope.config);
  requireRecovery(digest(old.scope.description) === digest(description)
    && Object.entries(description).every(([key, value]) => key === 'effective'
      ? Object.entries(value).every(([name, entry]) => old.scope.effective[name] === entry)
      : digest(old.scope[key]) === digest(value)));
  const targets = resourceTargets(source);
  requireRecovery(digest(targets) === digest(old.scope.targets));
  const stages = ['identity', 'preflight', 'build'];
  const names = await readdir(oldOutput);
  requireRecovery(names.every(name => name === 'plan.json' || stages.some(stage =>
    name === `${stage}.intent.json` || name === `${stage}.result.json`)), 'BUILD_RECOVERY_PARENT_DISPATCHED');
  let previous = old.approvalToken, lastTime = 0;
  const receipts = {};
  for (const stage of stages) {
    const intent = verify(await readControl(path.join(oldOutput, `${stage}.intent.json`)));
    const result = verify(await readControl(path.join(oldOutput, `${stage}.result.json`)));
    requireRecovery(intent.schemaVersion === 1 && result.schemaVersion === 1
      && intent.plan === old.approvalToken && result.plan === old.approvalToken
      && intent.stage === stage && result.stage === stage && intent.previous === previous
      && intent.status === 'started-no-replay' && result.intentDigest === intent.contentDigest
      && result.status === (stage === 'build' ? 'unknown-no-replay' : 'passed')
      && Date.parse(intent.startedAt) >= lastTime
      && Date.parse(result.finishedAt) >= Date.parse(intent.startedAt) && Date.parse(result.finishedAt) <= Date.now());
    if (stage === 'identity') {
      const selected = result.value?.identity;
      requireRecovery(selected?.target?.tenantId === source.input.azure.tenantId
        && selected.target.subscriptionId === source.input.azure.subscriptionId
        && selected.target.accountName === config.accountName.toLowerCase()
        && (!old.scope.identity || digest(selected) === digest(old.scope.identity)),
      'BUILD_RECOVERY_IDENTITY_MISMATCH');
    }
    if (stage === 'build') requireRecovery(result.code === 'HOST_EXECUTION_STAGE_STOPPED'
      && ['DOCKER_DISPATCH_FAILED', 'DOCKER_DISPATCH_UNKNOWN', 'DOCKER_ABORTED',
        'DOCKER_OUTPUT_LIMIT', 'DOCKER_RESPONSE_UNKNOWN', 'DOCKER_RESPONSE_INVALID', 'DOCKER_HTTP_FAILED']
        .includes(result.reasonCode), 'BUILD_RECOVERY_FAILURE_INELIGIBLE');
    previous = result.contentDigest; lastTime = Date.parse(result.finishedAt);
    receipts[stage] = { intent: intent.contentDigest, result: result.contentDigest };
  }
  const reservations = {};
  for (const id of [targets.app, targets.gatewayApi, ...targets.children].filter(Boolean)) {
    const filename = path.join(workspaceRoot, '.mcp-execution-host-targets', `${digest(id.toLowerCase()).slice(7)}.json`);
    const reservation = await readControl(filename);
    requireRecovery(reservation.schemaVersion === 1 && reservation.plan === old.approvalToken
      && reservation.resourceId === id, 'BUILD_RECOVERY_RESERVATION_MISMATCH');
    reservations[id] = digest(reservation);
  }
  const outerBinding = await exists(path.join(outer, 'execution.json'))
    ? await failedHostExecutionEvidence(outer, old) : null;
  // An execution-owned host must not be detached from a deleted/relocated outer journal.
  requireRecovery(old.scope.configPath !== path.join(outer, path.basename(old.scope.configPath))
    || !/^host-\d+\.json$/.test(path.basename(old.scope.configPath)) || outerBinding,
  'BUILD_RECOVERY_OUTER_REQUIRED');
  return { old, outer: outerBinding ? outer : null,
    binding: { parentPlanDigest: digest(old), receipts, reservations, outer: outerBinding } };
}

async function rejectedRecoveryEvidence(directory, parent, source, workspaceRoot, primaryClaim,
  connection = false, visited = new Set()) {
  requireRecovery(path.isAbsolute(directory), 'BUILD_RECOVERY_REJECTION_INVALID');
  requireRecovery(visited.size < 16 && !visited.has(directory), 'BUILD_RECOVERY_REJECTION_INVALID');
  visited.add(directory);
  await assertProjectPath(directory);
  const names = (await readdir(directory)).sort();
  requireRecovery(digest(names) === digest(['plan.json', 'reconcile.intent.json', 'result.json']),
    'BUILD_RECOVERY_REJECTION_INVALID');
  const plan = await readControl(path.join(directory, 'plan.json')), scope = plan.scope;
  let predecessor, claimFile = primaryClaim, predecessorField;
  if (connection) {
    requireRecovery(valid(scope?.config)
      && Boolean(scope.config.rejectedRecoveryOutput) !== Boolean(scope.config.connectionRecoveryOutput),
    'BUILD_RECOVERY_REJECTION_INVALID');
    const earlierConnection = Boolean(scope.config.connectionRecoveryOutput);
    predecessorField = earlierConnection ? 'connectionRecovery' : 'rejectedRecovery';
    predecessor = await rejectedRecoveryEvidence(
      scope.config.connectionRecoveryOutput ?? scope.config.rejectedRecoveryOutput,
      parent, source, workspaceRoot, primaryClaim, earlierConnection, visited);
    requireRecovery(digest(scope[predecessorField]) === digest(predecessor), 'BUILD_RECOVERY_REJECTION_INVALID');
    claimFile = earlierConnection ? connectionClaim(primaryClaim, predecessor.plan)
      : primaryClaim.replace(/\.build-recovery\.json$/, '.build-recovery-engine-recheck.json');
  }
  const claim = verify(await readControl(claimFile));
  requireRecovery(keys(plan, ['approvalToken', 'scope', 'localImage'])
    && scope?.kind === 'mcp-build-recovery-plan' && scope.schemaVersion === 1
    && valid(scope.config) && (connection || scope.config.rejectedRecoveryOutput === undefined
      && scope.config.connectionRecoveryOutput === undefined)
    && scope.config.supersededRecoveryOutput === undefined
    && scope.output === directory && scope.workspaceRoot === workspaceRoot
    && scope.project === source.projectDir && scope.claim === claimFile
    && scope.config.oldHostApproval === parent.old.approvalToken
    && scope.config.oldHostOutput === parent.old.scope.output
    && scope.config.sourceManifestDigest === source.manifest.contentDigest
    && scope.sourceManifestDigest === source.manifest.contentDigest
    && scope.config.accountName.toLowerCase() === parent.old.scope.config.accountName.toLowerCase()
    && scope.dockerSocket === parent.old.scope.config.dockerSocket
    && /^sha256:[a-f0-9]{64}$/.test(scope.producerBuild)
    && plan.approvalToken === `mcp-build-recovery/${digest(scope)}`
    && plan.localImage === `copilot-mcp-recovery:${plan.approvalToken.split(':').at(-1)}`
    && digest(scope.evidence) === digest(parent.binding)
    && digest(scope.targets) === digest(resourceTargets(source))
    && digest(claim) === digest(seal({ schemaVersion: 1, plan: plan.approvalToken,
      parent: parent.old.approvalToken, parentEvidence: parent.binding,
      resourceId: scope.targets.app, output: directory,
      ...(predecessor ? { [predecessorField]: predecessor } : {}) })), 'BUILD_RECOVERY_REJECTION_INVALID');
  const intent = verify(await readControl(path.join(directory, 'reconcile.intent.json')));
  const result = verify(await readControl(path.join(directory, 'result.json')));
  requireRecovery(keys(intent, ['schemaVersion', 'plan', 'previous', 'stage', 'status', 'startedAt', 'contentDigest'])
    && intent.schemaVersion === 1 && intent.plan === plan.approvalToken && intent.previous === plan.approvalToken
    && intent.stage === 'reconcile' && intent.status === 'started-no-replay'
    && keys(result, ['schemaVersion', 'plan', 'previous', 'status', 'stage', 'reasonCode', 'dockerRequests',
      'providerCalls', 'azureCommands', 'finishedAt', 'contentDigest',
      ...(result.engineSecurity !== undefined ? ['engineSecurity'] : [])])
    && result.schemaVersion === 1 && result.plan === plan.approvalToken && result.previous === plan.approvalToken
    && result.status === 'unknown-no-replay' && result.stage === 'reconcile'
    && result.reasonCode === (connection ? 'DOCKER_RESPONSE_UNKNOWN' : 'BUILD_RECOVERY_ENGINE_UNTRUSTED')
    && result.dockerRequests === (connection ? 1 : 2) && result.azureCommands === 0 && result.providerCalls === 0
    && (!connection || result.engineSecurity === undefined)
    && Date.parse(result.finishedAt) >= Date.parse(intent.startedAt)
    && Date.parse(result.finishedAt) <= Date.now(), 'BUILD_RECOVERY_REJECTION_INVALID');
  if (result.engineSecurity !== undefined) {
    requireRecovery(keys(result.engineSecurity, ['schemaVersion', 'checks']) && result.engineSecurity.schemaVersion === 1
      && keys(result.engineSecurity.checks, ['debugDisabled', 'insecureRegistryCidrs', 'builderRegistry', 'runtimeRegistry'])
      && Object.values(result.engineSecurity.checks).every(status => ['passed', 'failed', 'unknown'].includes(status))
      && Object.values(result.engineSecurity.checks).some(status => status !== 'passed'), 'BUILD_RECOVERY_REJECTION_INVALID');
  }
  return { output: directory, plan: plan.approvalToken, planDigest: digest(plan),
    claimDigest: claim.contentDigest, intentDigest: intent.contentDigest, resultDigest: result.contentDigest };
}

const connectionClaim = (primaryClaim, approval) => primaryClaim.replace(/\.build-recovery\.json$/,
  `.build-recovery-connect-${digest(approval).slice(7)}.json`);
const successorClaim = (primaryClaim, approval) => primaryClaim.replace(/\.build-recovery\.json$/,
  `.build-successor-${digest(approval).slice(7)}.json`);
const primaryClaimFor = (workspaceRoot, source) => path.join(workspaceRoot, '.mcp-execution-host-targets',
  `${digest(resourceTargets(source).app.toLowerCase()).slice(7)}.build-recovery.json`);
const recoveryClaim = plan => seal({
  schemaVersion: 1, plan: plan.approvalToken, parent: plan.scope.config.oldHostApproval,
  parentEvidence: plan.scope.evidence, resourceId: plan.scope.targets.app, output: plan.scope.output,
  ...(plan.scope.rejectedRecovery ? { rejectedRecovery: plan.scope.rejectedRecovery } : {}),
  ...(plan.scope.connectionRecovery ? { connectionRecovery: plan.scope.connectionRecovery } : {}),
  ...(plan.scope.revisedSource ? { revisedSource: plan.scope.revisedSource } : {}),
});

async function scanRejectionEvidence(config, recovery, workspaceRoot) {
  if (!config.scanRejectedContinuationOutput) return undefined;
  const { inspectRejectedImageScan } = await import('./mcp-recovered-image.js');
  return inspectRejectedImageScan(config.scanRejectedContinuationOutput, recovery, workspaceRoot);
}

async function revisedEvidence(config, recovery, source, workspaceRoot) {
  const scanRejection = await scanRejectionEvidence(config, recovery, workspaceRoot);
  requireRecovery(recovery.result.status === (scanRejection ? 'built-unqualified' : 'unknown-no-replay'),
    'BUILD_RECOVERY_FAILURE_INELIGIBLE');
  const changes = sourceRevision(recovery.source, source);
  if (scanRejection) requireRecovery(recovery.source.input.imageBuild.runtimeImage.split('@').at(-1)
    !== source.input.imageBuild.runtimeImage.split('@').at(-1),
    'BUILD_RECOVERY_RUNTIME_REVISION_REQUIRED');
  return { predecessor: recovery.binding, changes, ...(scanRejection ? { scanRejection } : {}) };
}

function sourceRevision(previous, source) {
  const omitBuild = ({ npmRegistryUrl, imageBuild, ...value }) => value;
  const changes = {};
  for (const [name, before, after] of [
    ['npmRegistryUrl', previous.review.npmRegistryUrl, source.review.npmRegistryUrl],
    ['imageBuild', previous.input.imageBuild, source.input.imageBuild],
  ]) if (digest(before) !== digest(after)) changes[name] = { before, after };
  const lockMetadata = value => {
    if (Array.isArray(value)) return value.map(lockMetadata);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([name]) => name !== 'resolved').map(([name, entry]) => [name, lockMetadata(entry)]));
    return value;
  };
  requireRecovery(previous.projectDir !== source.projectDir && Object.keys(changes).length > 0
    && digest(omitBuild(previous.input)) === digest(omitBuild(source.input))
    && digest(previous.runtime) === digest(source.runtime)
    && buildFiles.filter(name => !['Dockerfile', '.npmrc', 'package-lock.json'].includes(name))
      .every(name => previous.files[name]?.equals(source.files[name]))
    && Object.keys(previous.files).filter(name => name.startsWith('infra/'))
      .every(name => previous.files[name]?.equals(source.files[name]))
    && digest(lockMetadata(JSON.parse(previous.files['package-lock.json'])))
      === digest(lockMetadata(JSON.parse(source.files['package-lock.json']))),
  'BUILD_RECOVERY_REVISION_INVALID');
  return changes;
}

// Internal evidence reader shared by revised builds and recovered-image qualification.
// Historical records remain immutable; reading them never restores execution authority.
export async function inspectBuildRecovery(directory, workspaceRoot, { visited = new Set(), activeIdentityProject } = {}) {
  requireRecovery(path.isAbsolute(directory) && visited.size < 16 && !visited.has(directory));
  visited.add(directory);
  await assertProjectPath(directory);
  const plan = await readControl(path.join(directory, 'plan.json')), scope = plan.scope;
  requireRecovery(keys(plan, ['approvalToken', 'scope', 'localImage']) && scope?.schemaVersion === 1
    && scope.kind === 'mcp-build-recovery-plan' && valid(scope.config)
    && scope.workspaceRoot === workspaceRoot && scope.output === directory
    && plan.approvalToken === `mcp-build-recovery/${digest(scope)}`
    && plan.localImage === `copilot-mcp-recovery:${plan.approvalToken.split(':').at(-1)}`
    && /^sha256:[a-f0-9]{64}$/.test(scope.producerBuild));
  const original = await readRecipeProject(scope.originalProject ?? scope.project);
  const parent = await evidence(original, scope.config, workspaceRoot, activeIdentityProject);
  const source = await readRecipeProject(scope.project);
  requireRecovery(scope.sourceManifestDigest === source.manifest.contentDigest
    && digest(scope.evidence) === digest(parent.binding)
    && digest(scope.targets) === digest(resourceTargets(original))
    && digest(scope.targets) === digest(resourceTargets(source))
    && scope.dockerSocket === parent.old.scope.config.dockerSocket
    && digest(scope.downloads) === digest({ builderImage: source.input.imageBuild.builderImage,
      runtimeImage: source.input.imageBuild.runtimeImage, npmRegistryUrl: source.review.npmRegistryUrl,
      packageLockDigest: source.manifest.files['package-lock.json'] })
    && digest(scope.ceilings) === digest({ localBuild: parent.old.scope.ceilings.localBuild })
    && scope.oldOwner === parent.old.approvalToken.split(':').at(-1)
    && scope.oldTag === `${original.input.azure.registry.server}/${parent.old.scope.config.imageRepository}:copilot-${scope.oldOwner.slice(0, 32)}`);
  const primary = primaryClaimFor(workspaceRoot, original);
  let claimFile = primary, earlier, revisedSource;
  if (scope.config.supersededRecoveryOutput) {
    earlier = await inspectBuildRecovery(scope.config.supersededRecoveryOutput, workspaceRoot, { visited, activeIdentityProject });
    revisedSource = await revisedEvidence(scope.config, earlier, source, workspaceRoot);
    requireRecovery(scope.originalProject === original.projectDir && earlier.original.projectDir === original.projectDir
      && scope.config.replacementProject === source.projectDir
      && scope.config.replacementSourceManifestDigest === source.manifest.contentDigest
      && digest(scope.revisedSource) === digest(revisedSource)
      && digest(scope.priorArtifacts) === digest(earlier.artifacts));
    claimFile = successorClaim(primary, earlier.plan.approvalToken);
  } else {
    requireRecovery(source.projectDir === original.projectDir && scope.revisedSource === undefined
      && scope.priorArtifacts === undefined && scope.originalProject === undefined);
    for (const [field, connection] of [['rejectedRecovery', false], ['connectionRecovery', true]]) {
      const selected = scope.config[`${field}Output`];
      requireRecovery(Boolean(selected) === Boolean(scope[field]));
      if (selected) {
        const predecessor = await rejectedRecoveryEvidence(selected, parent, original, workspaceRoot, primary, connection);
        requireRecovery(digest(scope[field]) === digest(predecessor));
        claimFile = connection ? connectionClaim(primary, predecessor.plan)
          : primary.replace(/\.build-recovery\.json$/, '.build-recovery-engine-recheck.json');
      }
    }
  }
  const scanRejections = [...(earlier?.scanRejections ?? []),
    ...(revisedSource?.scanRejection ? [revisedSource.scanRejection] : [])];
  const priorScanOwners = scanRejections.map(item => item.plan.split(':').at(-1));
  requireRecovery(priorScanOwners.length === 0 ? scope.priorScanOwners === undefined
    : digest(scope.priorScanOwners) === digest(priorScanOwners));
  requireRecovery(scope.claim === claimFile);
  const claim = verify(await readControl(claimFile));
  requireRecovery(digest(claim) === digest(recoveryClaim(plan)));
  const result = verify(await readControl(path.join(directory, 'result.json')));
  const passed = result.status === 'built-unqualified';
  const names = ['plan.json', 'reconcile.intent.json', 'reconcile.result.json', 'build.intent.json', 'result.json',
    ...(passed ? ['build.result.json'] : [])].sort();
  requireRecovery(digest((await readdir(directory)).sort()) === digest(names), 'BUILD_RECOVERY_FAILURE_INELIGIBLE');
  let previous = plan.approvalToken, lastTime = 0, built;
  const receipts = {};
  for (const stage of ['reconcile', 'build']) {
    const intent = verify(await readControl(path.join(directory, `${stage}.intent.json`)));
    requireRecovery(keys(intent, ['schemaVersion', 'plan', 'previous', 'stage', 'status', 'startedAt', 'contentDigest'])
      && intent.schemaVersion === 1 && intent.plan === plan.approvalToken && intent.previous === previous
      && intent.stage === stage && intent.status === 'started-no-replay'
      && Date.parse(intent.startedAt) >= lastTime && Date.parse(intent.startedAt) <= Date.now());
    receipts[`${stage}Intent`] = intent.contentDigest;
    lastTime = Date.parse(intent.startedAt);
    if (stage === 'build' && !passed) break;
    const receipt = verify(await readControl(path.join(directory, `${stage}.result.json`)));
    requireRecovery(keys(receipt, ['schemaVersion', 'plan', 'stage', 'intentDigest', 'status', 'value', 'finishedAt', 'contentDigest'])
      && receipt.schemaVersion === 1 && receipt.plan === plan.approvalToken && receipt.stage === stage
      && receipt.intentDigest === intent.contentDigest && receipt.status === 'passed'
      && Date.parse(receipt.finishedAt) >= lastTime && Date.parse(receipt.finishedAt) <= Date.now());
    if (stage === 'reconcile') requireRecovery(receipt.value?.engineSecurity?.schemaVersion === 1
      && keys(receipt.value.engineSecurity.checks, ['debugDisabled', 'insecureRegistryCidrs', 'builderRegistry', 'runtimeRegistry'])
      && Object.values(receipt.value.engineSecurity.checks).every(value => value === 'passed')
      && digest(receipt.value.engineSecurity) === digest(result.engineSecurity));
    else built = receipt.value;
    receipts[stage] = receipt.contentDigest; previous = receipt.contentDigest; lastTime = Date.parse(receipt.finishedAt);
  }
  requireRecovery(result.schemaVersion === 1 && result.plan === plan.approvalToken && result.previous === previous
    && result.providerCalls === 0 && result.azureCommands === 0
    && Date.parse(result.finishedAt) >= lastTime && Date.parse(result.finishedAt) <= Date.now());
  if (passed) {
    requireRecovery(keys(result, ['schemaVersion', 'plan', 'previous', 'status', 'localImage', 'imageId', 'buildEvidenceDigest',
      'engineSecurity', 'dockerRequests', 'providerCalls', 'azureCommands', 'scanPassed', 'smokePassed', 'pushed', 'deployed',
      'finishedAt', 'contentDigest']) && result.localImage === plan.localImage
      && keys(built, ['imageId', 'buildEvidenceDigest'])
      && /^sha256:[a-f0-9]{64}$/.test(built.imageId) && /^sha256:[a-f0-9]{64}$/.test(built.buildEvidenceDigest)
      && result.imageId === built.imageId && result.buildEvidenceDigest === built.buildEvidenceDigest
      && built.buildEvidenceDigest === buildImageEvidenceDigest(source, built.imageId)
      && result.scanPassed === false && result.smokePassed === false && result.pushed === false && result.deployed === false
      && result.dockerRequests === scope.effective.maximumDockerRequests);
  } else {
    const diagnostic = result.dockerFailure === undefined ? undefined : dockerFailureDiagnostic(result.dockerFailure);
    requireRecovery(keys(result, ['schemaVersion', 'plan', 'previous', 'status', 'stage', 'reasonCode', 'engineSecurity',
      'dockerRequests', 'providerCalls', 'azureCommands', 'finishedAt', 'contentDigest',
      ...(result.dockerFailure !== undefined ? ['dockerFailure'] : [])])
      && result.status === 'unknown-no-replay' && result.stage === 'build'
      && ['DOCKER_DISPATCH_FAILED', 'DOCKER_DISPATCH_UNKNOWN', 'DOCKER_ABORTED', 'DOCKER_OUTPUT_LIMIT',
        'DOCKER_RESPONSE_UNKNOWN', 'DOCKER_RESPONSE_INVALID', 'DOCKER_HTTP_FAILED'].includes(result.reasonCode)
      && [scope.effective.maximumDockerRequests - 1, scope.effective.maximumDockerRequests].includes(result.dockerRequests)
      && (result.dockerFailure === undefined || diagnostic && digest(diagnostic) === digest(result.dockerFailure)),
    'BUILD_RECOVERY_FAILURE_INELIGIBLE');
  }
  const artifacts = [...(earlier?.artifacts ?? [{ owner: scope.oldOwner, tag: scope.oldTag }]),
    { owner: plan.approvalToken.split(':').at(-1), tag: plan.localImage }];
  requireRecovery(scope.effective.maximumDockerRequests === 5 + 3 * (earlier?.artifacts.length ?? 1) + priorScanOwners.length);
  return { plan, source, original, parent, result, built, artifacts, scanRejections,
    protectedPaths: [...new Set([directory, source.projectDir, original.projectDir,
      ...scanRejections.map(item => item.output), ...(earlier?.protectedPaths ?? [])])],
    binding: { output: directory, plan: plan.approvalToken, planDigest: digest(plan),
      claimDigest: claim.contentDigest, sourceManifestDigest: source.manifest.contentDigest, receipts,
      resultDigest: result.contentDigest } };
}

async function prepare(options) {
  const configPath = await assertProjectPath(path.resolve(options.config));
  const config = await readControl(configPath);
  requireRecovery(valid(config) && path.isAbsolute(config.oldHostOutput), 'BUILD_RECOVERY_CONFIG_INVALID');
  requireRecovery(Date.parse(config.expiresAt) > Date.now() && Date.parse(config.expiresAt) <= Date.now() + 86400000,
    'BUILD_RECOVERY_EXPIRED');
  const original = await readRecipeProject(options.project);
  const workspaceRoot = path.resolve(options.workspaceRoot), output = await assertProjectPath(path.resolve(options.output));
  const parent = await evidence(original, config, workspaceRoot);
  const superseded = config.supersededRecoveryOutput
    ? await inspectBuildRecovery(config.supersededRecoveryOutput, workspaceRoot) : undefined;
  const source = config.replacementProject ? await readRecipeProject(config.replacementProject) : original;
  let revisedSource;
  if (superseded) {
    requireRecovery(path.isAbsolute(config.replacementProject) && path.isAbsolute(config.supersededRecoveryOutput)
      && superseded.original.projectDir === original.projectDir
      && superseded.artifacts.length < 17
      && config.replacementSourceManifestDigest === source.manifest.contentDigest);
    revisedSource = await revisedEvidence(config, superseded, source, workspaceRoot);
    for (const dir of [...superseded.protectedPaths, config.scanRejectedContinuationOutput, parent.outer,
      parent.old.scope.effective.identityProject].filter(Boolean)) {
      requireRecovery(!within(dir, source.projectDir) && !within(source.projectDir, dir), 'BUILD_RECOVERY_OUTPUT_OVERLAP');
    }
  }
  requireRecovery((await lstat(path.dirname(output))).isDirectory());
  for (const dir of [source.projectDir, original.projectDir, config.oldHostOutput, parent.outer,
    parent.old.scope.effective.identityProject, config.rejectedRecoveryOutput, config.connectionRecoveryOutput,
    config.supersededRecoveryOutput, config.scanRejectedContinuationOutput].filter(Boolean)) {
    requireRecovery(!within(dir, output) && !within(output, dir), 'BUILD_RECOVERY_OUTPUT_OVERLAP');
  }
  for (const dir of superseded?.protectedPaths ?? []) {
    requireRecovery(!within(dir, output) && !within(output, dir), 'BUILD_RECOVERY_OUTPUT_OVERLAP');
  }
  requireRecovery(!within(output, configPath) && !await exists(output), 'BUILD_RECOVERY_OUTPUT_EXISTS');
  const targets = resourceTargets(source);
  const prefix = path.join(workspaceRoot, '.mcp-execution-host-targets', digest(targets.app.toLowerCase()).slice(7));
  const primaryClaim = `${prefix}.build-recovery.json`;
  const rejectedRecovery = config.rejectedRecoveryOutput
    ? await rejectedRecoveryEvidence(config.rejectedRecoveryOutput, parent, source, workspaceRoot, primaryClaim) : undefined;
  const connectionRecovery = config.connectionRecoveryOutput
    ? await rejectedRecoveryEvidence(config.connectionRecoveryOutput, parent, source, workspaceRoot, primaryClaim, true) : undefined;
  const claim = superseded ? successorClaim(primaryClaim, superseded.plan.approvalToken)
    : connectionRecovery ? connectionClaim(primaryClaim, connectionRecovery.plan)
    : rejectedRecovery ? `${prefix}.build-recovery-engine-recheck.json` : primaryClaim;
  const scanRejections = [...(superseded?.scanRejections ?? []),
    ...(revisedSource?.scanRejection ? [revisedSource.scanRejection] : [])];
  const priorScanOwners = scanRejections.map(item => item.plan.split(':').at(-1));
  requireRecovery(!await exists(claim) && !await exists(`${prefix}.verified-image.json`)
    && (scanRejections.length > 0 || !await exists(`${prefix}.recovered-image.json`)), 'BUILD_RECOVERY_CONSUMED');
  const generated = await planHostingRecipe({ workspaceRoot, config: path.join(source.projectDir, 'recipe-definition.json'),
    output: `${output}.source-verification` });
  // Historical review/build identifiers remain sealed; executable build inputs must match today's compiler exactly.
  requireRecovery(buildFiles.every(name => source.files[name]
    && source.files[name].toString('utf8') === generated.files[name]), 'BUILD_RECOVERY_SOURCE_MISMATCH');
  const oldOwner = parent.old.approvalToken.split(':').at(-1);
  const scope = {
    schemaVersion: 1, kind: 'mcp-build-recovery-plan', workspaceRoot, project: source.projectDir, configPath, config,
    output, claim, producerBuild: (await getLibraryInfo()).contentDigest,
    sourceManifestDigest: source.manifest.contentDigest, evidence: parent.binding, targets,
    ...(rejectedRecovery ? { rejectedRecovery } : {}),
    ...(connectionRecovery ? { connectionRecovery } : {}),
    ...(revisedSource ? { revisedSource, originalProject: original.projectDir, priorArtifacts: superseded.artifacts } : {}),
    ...(priorScanOwners.length ? { priorScanOwners } : {}),
    dockerSocket: parent.old.scope.config.dockerSocket,
    oldOwner, oldTag: `${source.input.azure.registry.server}/${parent.old.scope.config.imageRepository}:copilot-${oldOwner.slice(0, 32)}`,
    downloads: { builderImage: source.input.imageBuild.builderImage, runtimeImage: source.input.imageBuild.runtimeImage,
      npmRegistryUrl: source.review.npmRegistryUrl, packageLockDigest: source.manifest.files['package-lock.json'] },
    ceilings: { localBuild: parent.old.scope.ceilings.localBuild },
    effective: { maximumMs: config.maximumMs ?? 1800000,
      maximumDockerRequests: 5 + 3 * (superseded?.artifacts.length ?? 1) + priorScanOwners.length },
    effects: [
      'One independent build-only attempt linked to the consumed parent. Never resumes, overwrites or releases parent evidence or reservations.',
      'Owner must confirm the previous build stopped and exclusive control of this exact trusted Docker engine. Label-filtered inspection cannot prove legacy builder quiescence.',
      'Read Docker version/security metadata, parent-labelled containers/images and exact old/new image tags. Block on parent containers or a pre-existing new tag; preserve all old images.',
      'Download only the reviewed pinned public builder/runtime images and sealed npm dependencies through the trusted generated Dockerfile, without ambient registry credentials.',
      'Build once with the existing memory/CPU ceilings and a unique local recovery tag; retain safe diagnostics. No automatic retry even after reconciliation fails.',
      'No Azure sign-in or API calls, scan, smoke, push, deployment, provider calls, cache pruning, daemon changes or deletion of pre-existing artifacts.',
      'Success means an unqualified local image only. The separate recovered-image contract requires new qualification/push/deployment approval; this build grants none.',
      'Create one durable target-scoped recovery claim before Docker access. A failed, interrupted or successful attempt cannot be repeated by changing output, config or approval.',
      ...(rejectedRecovery ? [
        'Separate one-shot successor to a sealed engine-security rejection after exactly two read-only requests and no build intent. Preserve that plan, result and primary claim; create an additional engine-recheck claim, never reset or replay the rejected attempt.',
        'A further explicitly approved attempt is eligible only after a sealed first-version-GET connection failure with no build intent. Other failures remain blocked. The current engine must pass all checks again; previous approvals are not execution authority.',
      ] : []),
      ...(connectionRecovery ? [
        'Fresh explicitly requested attempt after the linked predecessor stopped on its first read-only Docker version GET with DOCKER_RESPONSE_UNKNOWN. Preserve its result and claim; take one deterministic child claim. Never resume or overwrite the predecessor.',
        'Only sealed zero-build connection failures qualify; missing results, extra stages, build intents and mutation failures remain blocked. Validate at most 16 linked predecessors. No automatic retry or branching to a second child of the same attempt.',
      ] : []),
      ...(revisedSource ? [
        revisedSource.scanRejection
          ? 'Build separately generated source with a different pinned runtime image after a successful recovery failed qualification at scan. Preserve the successful build, rejected scan and all consumed claims; a new pin is not evidence that vulnerabilities are fixed.'
          : 'Build revised generated source after a sealed dispatched-build failure. Only the exact reviewed npm registry and pinned build-image changes are permitted; dependency versions/integrities, runtime, authentication, targets and reservations remain unchanged.',
        revisedSource.scanRejection
          ? 'Take one deterministic child claim for the superseded successful build. Preserve every source, attempt and prior build owner/tag; never branch, replay the rejected image or restore consumed scan authority.'
          : 'Preserve every source and attempt in the bounded lineage. Take one deterministic child claim per failed build; inspect all prior build owners/tags without deleting or adopting their images. No branching, implicit retry or restoration of consumed authority.',
      ] : []),
      ...(priorScanOwners.length ? [
        'Check every prior rejected-scan owner for remaining containers and block if any exist. Preserve scanner volumes and images; no cleanup or adoption of rejected reports. A later continuation must rerun the unchanged scan and smoke gates under separate approval.',
      ] : []),
    ],
  };
  const approvalToken = `mcp-build-recovery/${digest(scope)}`;
  return { approvalToken, scope, localImage: `copilot-mcp-recovery:${approvalToken.split(':').at(-1)}` };
}
export const planBuildRecovery = options => scoped(options, () => prepare(options));

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// The trusted image-build schema permits only node on Docker Hub and distroless
// on gcr.io. Unrelated registry entries do not govern those public pulls.
export function assessBuildRecoveryEngine(info, runtimeImage) {
  const indexes = info?.RegistryConfig?.IndexConfigs;
  const registryStatus = aliases => {
    if (!record(indexes)) return 'unknown';
    const selected = Object.entries(indexes).filter(([key, value]) =>
      aliases.includes(key.toLowerCase())
      || typeof value?.Name === 'string' && aliases.includes(value.Name.toLowerCase()));
    if (selected.some(([, value]) => value?.Secure === false)) return 'failed';
    if (selected.some(([, value]) => !record(value) || value.Secure !== true)) return 'unknown';
    // Docker uses secure defaults for registries without explicit index entries.
    return 'passed';
  };
  const cidrs = info?.RegistryConfig?.InsecureRegistryCIDRs;
  const dockerHub = ['docker.io', 'index.docker.io', 'registry-1.docker.io', 'https://index.docker.io/v1/'];
  return {
    schemaVersion: 1,
    checks: {
      debugDisabled: info?.Debug === false ? 'passed' : info?.Debug === true ? 'failed' : 'unknown',
      insecureRegistryCidrs: !Array.isArray(cidrs) ? 'unknown'
        : cidrs.some(cidr => typeof cidr === 'string' && !['127.0.0.0/8', '::1/128'].includes(cidr))
          ? 'failed' : cidrs.some(cidr => typeof cidr !== 'string') ? 'unknown' : 'passed',
      builderRegistry: registryStatus(dockerHub),
      runtimeRegistry: registryStatus(runtimeImage?.startsWith('node:') ? dockerHub : ['gcr.io']),
    },
  };
}

async function reconcile(scope, localImage, docker, recordSecurity) {
  const version = executionJson(await docker('/version'));
  requireRecovery(version.Os === 'linux' && ['amd64', 'x86_64'].includes(version.Arch)
    && /^1\.\d+$/.test(version.ApiVersion) && Number(version.ApiVersion.split('.')[1]) >= 44
    && (version.MinAPIVersion === undefined || /^1\.\d+$/.test(version.MinAPIVersion)
      && Number(version.MinAPIVersion.split('.')[1]) <= 44), 'BUILD_RECOVERY_ENGINE_UNSUPPORTED');
  const info = executionJson(await docker('/v1.44/info'));
  const engineSecurity = assessBuildRecoveryEngine(info, scope.downloads.runtimeImage);
  recordSecurity(engineSecurity);
  requireRecovery(Object.values(engineSecurity.checks).every(status => status === 'passed'),
  'BUILD_RECOVERY_ENGINE_UNTRUSTED');
  const observations = [];
  for (const artifact of scope.priorArtifacts ?? [{ owner: scope.oldOwner, tag: scope.oldTag }]) {
    const filters = encodeURIComponent(JSON.stringify({ label: [`copilot-mcp-execution=${artifact.owner}`] }));
    const containers = executionJson(await docker(`/v1.44/containers/json?all=true&filters=${filters}`));
    requireRecovery(Array.isArray(containers) && containers.length === 0, 'BUILD_RECOVERY_PARENT_CONTAINERS');
    const images = executionJson(await docker(`/v1.44/images/json?all=true&filters=${filters}`));
    requireRecovery(Array.isArray(images) && images.length <= 256 && images.every(image =>
      /^sha256:[a-f0-9]{64}$/.test(image.Id) && image.Labels?.['copilot-mcp-execution'] === artifact.owner),
    'BUILD_RECOVERY_IMAGE_INCONCLUSIVE');
    const oldImage = await docker(`/v1.44/images/${encodeURIComponent(artifact.tag)}/json`);
    let oldImageId = null;
    if (oldImage.status !== 404) {
      const image = executionJson(oldImage);
      requireRecovery(/^sha256:[a-f0-9]{64}$/.test(image.Id)
        && image.Config?.Labels?.['copilot-mcp-execution'] === artifact.owner, 'BUILD_RECOVERY_IMAGE_INCONCLUSIVE');
      oldImageId = image.Id;
    }
    observations.push({ ...artifact, imageIds: images.map(image => image.Id).sort(), taggedImageId: oldImageId });
  }
  for (const owner of scope.priorScanOwners ?? []) {
    const filters = encodeURIComponent(JSON.stringify({ label: [`copilot-mcp-execution=${owner}`] }));
    const containers = executionJson(await docker(`/v1.44/containers/json?all=true&filters=${filters}`));
    requireRecovery(Array.isArray(containers) && containers.length === 0, 'BUILD_RECOVERY_PARENT_CONTAINERS');
  }
  requireRecovery((await docker(`/v1.44/images/${encodeURIComponent(localImage)}/json`)).status === 404,
    'BUILD_RECOVERY_LOCAL_TARGET_EXISTS');
  return { status: 'observed-not-quiescence-proof', parentImageIds: observations[0].imageIds,
    parentTaggedImageId: observations[0].taggedImageId, previousBuildStopped: 'owner-reviewed', parentArtifactsPreserved: true,
    ...(scope.priorArtifacts ? { priorArtifacts: observations } : {}),
    engineSecurity };
}
const safeCodes = new Set(['BUILD_RECOVERY_ENGINE_UNSUPPORTED', 'BUILD_RECOVERY_ENGINE_UNTRUSTED',
  'BUILD_RECOVERY_PARENT_CONTAINERS', 'BUILD_RECOVERY_IMAGE_INCONCLUSIVE', 'BUILD_RECOVERY_LOCAL_TARGET_EXISTS',
  'BUILD_RECOVERY_CANCELLED', 'BUILD_RECOVERY_EVIDENCE_CHANGED', 'BUILD_RECOVERY_LIMIT',
  'BUILD_RECOVERY_EVIDENCE_INVALID', 'BUILD_RECOVERY_REVISION_INVALID', 'BUILD_RECOVERY_PARENT_LOCKED',
  'BUILD_RECOVERY_RESERVATION_MISMATCH', 'BUILD_RECOVERY_REJECTION_INVALID',
  'BUILD_RECOVERY_RUNTIME_REVISION_REQUIRED', 'RECOVERED_IMAGE_SCAN_REJECTION_INVALID',
  'DOCKER_DISPATCH_FAILED', 'DOCKER_DISPATCH_UNKNOWN', 'DOCKER_ABORTED', 'DOCKER_OUTPUT_LIMIT',
  'DOCKER_RESPONSE_UNKNOWN', 'DOCKER_RESPONSE_INVALID', 'DOCKER_HTTP_FAILED',
  'HOST_EXECUTION_INVALID', 'HOST_EXECUTION_SOURCE_MISMATCH']);

export const runBuildRecovery = (options, dependencies = {}) => scoped(options, async () => {
  const plan = await prepare(options), scope = plan.scope;
  requireRecovery(options.approval === plan.approvalToken && options.allowLocal === true
    && options.allowNetwork === true && options.allowCloud !== true, 'BUILD_RECOVERY_APPROVAL_REQUIRED');
  requireRecovery(!options.signal?.aborted, 'BUILD_RECOVERY_CANCELLED');
  const claim = recoveryClaim(plan);
  try { await writeControl(scope.claim, claim, { create: true }); }
  catch (error) { if (error.code === 'EEXIST') requireRecovery(false, 'BUILD_RECOVERY_CONSUMED'); throw error; }
  await mkdir(scope.output, { mode: 0o700 });
  await writeControl(path.join(scope.output, 'plan.json'), plan, { create: true });
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), Math.min(scope.effective.maximumMs,
    Date.parse(scope.config.expiresAt) - Date.now()));
  let requests = 0, stage = 'reconcile', previous = plan.approvalToken, engineSecurity;
  const docker = (route, input = {}) => {
    requireRecovery(!signal.aborted && Date.now() < Date.parse(scope.config.expiresAt), 'BUILD_RECOVERY_CANCELLED');
    requireRecovery(++requests <= scope.effective.maximumDockerRequests, 'BUILD_RECOVERY_LIMIT');
    return (dependencies.dockerRequest ?? executionDockerRequest)(scope.dockerSocket, route,
      { maxBytes: 2 * 1024 * 1024, timeoutMs: 30000, ...input, signal });
  };
  const step = async (name, action) => {
    stage = name;
    const intent = seal({ schemaVersion: 1, plan: plan.approvalToken, previous, stage,
      status: 'started-no-replay', startedAt: new Date().toISOString() });
    await writeControl(path.join(scope.output, `${stage}.intent.json`), intent, { create: true });
    const value = await action();
    requireRecovery(!signal.aborted && Date.now() < Date.parse(scope.config.expiresAt), 'BUILD_RECOVERY_CANCELLED');
    const result = seal({ schemaVersion: 1, plan: plan.approvalToken, stage, intentDigest: intent.contentDigest,
      status: 'passed', value, finishedAt: new Date().toISOString() });
    await writeControl(path.join(scope.output, `${stage}.result.json`), result, { create: true });
    previous = result.contentDigest;
    return value;
  };
  try {
    await step('reconcile', () => reconcile(scope, plan.localImage, docker, value => { engineSecurity = value; }));
    const source = await readRecipeProject(scope.project);
    const original = scope.originalProject ? await readRecipeProject(scope.originalProject) : source;
    const current = await evidence(original, scope.config, scope.workspaceRoot);
    requireRecovery(digest(current.binding) === digest(scope.evidence)
      && (await getLibraryInfo()).contentDigest === scope.producerBuild, 'BUILD_RECOVERY_EVIDENCE_CHANGED');
    requireRecovery(source.manifest.contentDigest === scope.sourceManifestDigest, 'BUILD_RECOVERY_EVIDENCE_CHANGED');
    if (scope.revisedSource) {
      const superseded = await inspectBuildRecovery(scope.config.supersededRecoveryOutput, scope.workspaceRoot);
      requireRecovery(digest(await revisedEvidence(scope.config, superseded, source, scope.workspaceRoot))
        === digest(scope.revisedSource), 'BUILD_RECOVERY_EVIDENCE_CHANGED');
    }
    if (scope.rejectedRecovery) {
      const primaryClaim = scope.claim.replace(/\.build-recovery-engine-recheck\.json$/, '.build-recovery.json');
      requireRecovery(digest(await rejectedRecoveryEvidence(scope.rejectedRecovery.output, current,
        source, scope.workspaceRoot, primaryClaim)) === digest(scope.rejectedRecovery), 'BUILD_RECOVERY_EVIDENCE_CHANGED');
    }
    if (scope.connectionRecovery) {
      const primaryClaim = scope.claim.replace(/\.build-recovery-connect-[a-f0-9]{64}\.json$/, '.build-recovery.json');
      requireRecovery(digest(await rejectedRecoveryEvidence(scope.connectionRecovery.output, current,
        source, scope.workspaceRoot, primaryClaim, true)) === digest(scope.connectionRecovery), 'BUILD_RECOVERY_EVIDENCE_CHANGED');
    }
    const built = await step('build', () => buildHostImage(scope, source, plan.approvalToken.split(':').at(-1),
      plan.localImage, docker));
    const result = seal({ schemaVersion: 1, plan: plan.approvalToken, previous, status: 'built-unqualified',
      localImage: plan.localImage, ...built, engineSecurity, dockerRequests: requests, providerCalls: 0, azureCommands: 0,
      scanPassed: false, smokePassed: false, pushed: false, deployed: false, finishedAt: new Date().toISOString() });
    await writeControl(path.join(scope.output, 'result.json'), result, { create: true });
    return result;
  } catch (error) {
    const diagnostic = dockerFailureDiagnostic(error?.dockerFailure);
    const result = seal({ schemaVersion: 1, plan: plan.approvalToken, previous, status: 'unknown-no-replay', stage,
      reasonCode: safeCodes.has(error?.code) ? error.code : 'BUILD_RECOVERY_UNCLASSIFIED',
      ...(engineSecurity ? { engineSecurity } : {}),
      ...(diagnostic ? { dockerFailure: diagnostic } : {}), dockerRequests: requests,
      providerCalls: 0, azureCommands: 0, finishedAt: new Date().toISOString() });
    await writeControl(path.join(scope.output, 'result.json'), result, { create: true });
    return result;
  } finally { clearTimeout(timer); }
});
