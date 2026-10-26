import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { assertProjectPath, withCliWorkspace } from './config.js';
import { boundedSnapshot, metadataDigest } from './anonymous-metadata.js';
import { readControl, writeControl } from './mcp-control.js';
import { readRecipeProject } from './mcp-recipe-artifacts.js';
import { planHostingRecipe } from './mcp-container-apps.js';
import { readAzureIdentity } from './azure-identity.js';
import { getLibraryInfo } from './machine-contract.js';
import { describeHostExecution, runVerifiedImageHost } from './mcp-execution-host.js';

const digest = value => metadataDigest(boundedSnapshot(value));
const bytesDigest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const hash = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' };
const location = { type: 'string', minLength: 1, maxLength: 1024 };
export const verifiedImageDeploymentSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    oldHostOutput: location,
    oldHostApproval: { type: 'string', pattern: '^mcp-host-execution/sha256:[a-f0-9]{64}$' },
    sourceManifestDigest: hash,
    containerImage: { type: 'string', maxLength: 512,
      pattern: '^[a-z0-9.-]+/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$' },
    azureIdentityProject: location,
    accountName: { type: 'string', format: 'email', maxLength: 254 },
    expiresAt: { type: 'string', format: 'date-time' },
    maximumMs: { type: 'integer', minimum: 60000, maximum: 3600000 },
    deploymentOnlyReviewed: { const: true },
    resourceCeilingsReviewed: { const: true },
    createOnlyReviewed: { const: true },
  },
  required: ['schemaVersion', 'oldHostOutput', 'oldHostApproval', 'sourceManifestDigest', 'containerImage',
    'azureIdentityProject', 'accountName', 'expiresAt', 'deploymentOnlyReviewed', 'resourceCeilingsReviewed', 'createOnlyReviewed'],
};
const ajv = new Ajv(); addFormats(ajv);
const valid = ajv.compile(verifiedImageDeploymentSchema);
const requireEvidence = (ok, code = 'VERIFIED_IMAGE_EVIDENCE_INVALID') => {
  if (!ok) throw Object.assign(new Error(`Verified-image deployment stopped (${code}); preserve all plans, claims and evidence.`), { code });
};
async function exists(filename) {
  await assertProjectPath(filename);
  try { await lstat(filename); return true; } catch (error) { if (error.code !== 'ENOENT') throw error; return false; }
}
function sealed(record) {
  const { contentDigest, ...body } = record;
  requireEvidence(contentDigest === digest(body));
  return record;
}
function scoped(options, action) {
  requireEvidence(['workspaceRoot', 'project', 'config', 'output'].every(key => typeof options[key] === 'string'),
    'VERIFIED_IMAGE_OPTIONS_REQUIRED');
  return withCliWorkspace(options.workspaceRoot, action);
}
const fresh = value => Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now()
  && Date.now() - Date.parse(value) <= 86400000;
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
};

// Read the consumed parent only as evidence. No lock, receipt, reservation or
// source in that run is written, refreshed, repaired or adopted as authority.
async function inspectEvidence(source, config, workspaceRoot) {
  const oldOutput = await assertProjectPath(config.oldHostOutput);
  requireEvidence(!await exists(path.join(oldOutput, '.mcp-execution-host.lock')), 'VERIFIED_IMAGE_PARENT_LOCKED');
  const old = await readControl(path.join(oldOutput, 'plan.json'));
  requireEvidence(old.approvalToken === config.oldHostApproval
    && old.approvalToken === `mcp-host-execution/${digest(old.scope)}`
    && old.scope.kind === 'mcp-host-execution-plan' && old.scope.schemaVersion === 1
    && old.scope.output === oldOutput && old.scope.project === source.projectDir
    && old.scope.workspaceRoot === workspaceRoot
    && /^sha256:[a-f0-9]{64}$/.test(old.scope.producerBuild)
    && old.scope.sourceManifestDigest === source.manifest.contentDigest
    && config.sourceManifestDigest === source.manifest.contentDigest);
  const description = describeHostExecution(source, old.scope.config);
  requireEvidence(digest(old.scope.description) === digest(description)
    && Object.entries(description).every(([key, value]) => key === 'effective'
      ? Object.entries(value).every(([name, entry]) => old.scope.effective[name] === entry)
      : digest(old.scope[key]) === digest(value)));
  const app = `/subscriptions/${source.input.azure.subscriptionId}/resourceGroups/${source.input.azure.resourceGroup}/providers/Microsoft.App/containerApps/${source.input.azure.appName}`;
  requireEvidence(digest(old.scope.targets) === digest({ app, children: [] }));
  const allowedStages = ['identity', 'preflight', 'build', 'scan', 'smoke', 'push'];
  const names = await readdir(oldOutput);
  requireEvidence(names.every(name => !name.endsWith('.request.json') && (!/\.(intent|result)\.json$/.test(name)
    || allowedStages.some(stage => name === `${stage}.intent.json` || name === `${stage}.result.json`))),
  'VERIFIED_IMAGE_PARENT_DISPATCHED');
  let previous = old.approvalToken, lastTime = 0;
  const values = {}, receipts = {};
  for (const stage of allowedStages) {
    const intent = sealed(await readControl(path.join(oldOutput, `${stage}.intent.json`)));
    const result = sealed(await readControl(path.join(oldOutput, `${stage}.result.json`)));
    requireEvidence(intent.schemaVersion === 1 && result.schemaVersion === 1
      && intent.plan === old.approvalToken && result.plan === old.approvalToken
      && intent.stage === stage && result.stage === stage && intent.previous === previous
      && intent.status === 'started-no-replay' && result.intentDigest === intent.contentDigest
      && result.status === (stage === 'push' ? 'unknown-no-replay' : 'passed')
      && fresh(intent.startedAt) && fresh(result.finishedAt)
      && Date.parse(intent.startedAt) >= lastTime && Date.parse(result.finishedAt) >= Date.parse(intent.startedAt));
    previous = result.contentDigest; lastTime = Date.parse(result.finishedAt);
    values[stage] = result.value;
    receipts[stage] = { intent: intent.contentDigest, result: result.contentDigest };
  }
  const identity = await readAzureIdentity({ azure: source.input.azure }, config.azureIdentityProject, { required: true });
  requireEvidence(config.azureIdentityProject === old.scope.effective.identityProject
    && config.accountName.toLowerCase() === identity.target.accountName
    && old.scope.config.accountName.toLowerCase() === identity.target.accountName
    && digest(identity) === digest(values.identity.identity)
    && (!old.scope.identity || digest(identity) === digest(old.scope.identity)), 'VERIFIED_IMAGE_IDENTITY_MISMATCH');
  const built = values.build, scan = values.scan, smoke = values.smoke;
  const imageDigest = config.containerImage.split('@')[1];
  // Narrow to OCI manifest-ID images: a config-ID-only Docker export cannot
  // prove correspondence to a separately observed registry manifest digest.
  requireEvidence(config.containerImage === `${source.input.azure.registry.server}/${old.scope.config.imageRepository}@${built.imageId}`
    && built.imageId === imageDigest && scan.binding?.imageId === built.imageId
    && /^sha256:[a-f0-9]{64}$/.test(scan.binding.configDigest) && scan.binding.configDigest !== built.imageId
    && /^sha256:[a-f0-9]{64}$/.test(scan.binding.archiveDigest)
    && /^sha256:[a-f0-9]{64}$/.test(built.buildEvidenceDigest), 'VERIFIED_IMAGE_DIGEST_MISMATCH');
  requireEvidence(scan.critical === 0 && scan.high === 0 && fresh(scan.scannedAt) && fresh(scan.databaseUpdatedAt)
    && Date.parse(scan.databaseUpdatedAt) <= Date.parse(scan.scannedAt)
    && smoke.networkDisabled === true && smoke.nonroot === true && smoke.status === 'passed'
    && smoke.providerCalled === false && /^sha256:[a-f0-9]{64}$/.test(smoke.evidenceDigest));
  const privateDigests = {}, documents = {};
  for (const [name, expected] of [['scanner.private.json', scan.reportDigest], ['sbom.private.json', scan.sbomDigest],
    ['scanner-database.private.json', undefined]]) {
    const filename = await assertProjectPath(path.join(oldOutput, name)), stat = await lstat(filename);
    requireEvidence(stat.isFile() && stat.size <= 16 * 1024 * 1024);
    const bytes = await readFile(filename);
    requireEvidence(bytes.length <= 16 * 1024 * 1024);
    privateDigests[name] = bytesDigest(bytes);
    requireEvidence(expected === undefined || privateDigests[name] === expected);
    documents[name] = JSON.parse(bytes);
  }
  const report = documents['scanner.private.json'], bill = documents['sbom.private.json'];
  requireEvidence(report.SchemaVersion === 2 && report.ArtifactType === 'container_image'
    && report.Metadata?.ImageID === scan.binding.configDigest && report.Metadata?.OS?.Family === 'debian'
    && digest(report.Metadata?.DiffIDs) === digest(scan.binding.diffIds)
    && Array.isArray(report.Results) && report.Results.some(item => item.Class === 'os-pkgs'
      && item.Type === 'debian' && Array.isArray(item.Packages) && item.Packages.length)
    && report.Results.some(item => item.Class === 'lang-pkgs' && ['npm', 'node-pkg'].includes(item.Type)
      && Array.isArray(item.Packages) && item.Packages.length)
    && bill.bomFormat === 'CycloneDX' && Array.isArray(bill.components) && bill.components.length
    && Date.parse(documents['scanner-database.private.json'].UpdatedAt) === Date.parse(scan.databaseUpdatedAt));
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const item of report.Results) {
    requireEvidence(item.Vulnerabilities === undefined || Array.isArray(item.Vulnerabilities));
    for (const finding of item.Vulnerabilities ?? []) {
      requireEvidence(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(finding.Severity));
      counts[finding.Severity.toLowerCase()]++;
    }
  }
  requireEvidence(Object.entries(counts).every(([key, count]) => scan[key] === count));
  const reservationFile = path.join(workspaceRoot, '.mcp-execution-host-targets', `${digest(app.toLowerCase()).slice(7)}.json`);
  const reservation = await readControl(reservationFile);
  requireEvidence(reservation.schemaVersion === 1 && reservation.plan === old.approvalToken && reservation.resourceId === app,
    'VERIFIED_IMAGE_RESERVATION_MISMATCH');
  return { built, scan, smoke, identity, targets: { app, children: [] }, description,
    binding: { parentPlanDigest: digest(old), parentProducerBuild: old.scope.producerBuild,
      receipts, privateDigests, reservationDigest: digest(reservation) } };
}

async function prepare(options) {
  const source = await readRecipeProject(options.project);
  requireEvidence(source.input.recipe === 'container-apps-direct-v1' && !source.input.azure.gateway,
    'VERIFIED_IMAGE_DIRECT_ACA_ONLY');
  const configPath = await assertProjectPath(path.resolve(options.config)), config = await readControl(configPath);
  requireEvidence(valid(config), 'VERIFIED_IMAGE_CONFIG_INVALID');
  requireEvidence(path.isAbsolute(config.oldHostOutput) && path.isAbsolute(config.azureIdentityProject));
  const workspaceRoot = path.resolve(options.workspaceRoot), output = await assertProjectPath(path.resolve(options.output));
  requireEvidence((await lstat(path.dirname(output))).isDirectory());
  for (const protectedPath of [source.projectDir, config.oldHostOutput, config.azureIdentityProject]) {
    requireEvidence(!within(protectedPath, output) && !within(output, protectedPath), 'VERIFIED_IMAGE_OUTPUT_OVERLAP');
  }
  requireEvidence(Date.parse(config.expiresAt) > Date.now() && Date.parse(config.expiresAt) <= Date.now() + 86400000,
    'VERIFIED_IMAGE_APPROVAL_EXPIRED');
  const evidence = await inspectEvidence(source, config, workspaceRoot);
  requireEvidence(Date.parse(config.expiresAt) <= Math.min(Date.parse(evidence.scan.scannedAt),
    Date.parse(evidence.scan.databaseUpdatedAt)) + 86400000, 'VERIFIED_IMAGE_APPROVAL_EXCEEDS_SCAN');
  // Historical source remains sealed. Only deployment/runtime configuration must
  // match today's trusted compiler; docs, generated review/build IDs and bundles
  // need not be regenerated to deploy an already scanned immutable image.
  const generated = await planHostingRecipe({ workspaceRoot, config: path.join(source.projectDir, 'recipe-definition.json'),
    output: `${output}.source-verification` });
  for (const name of ['infra/container-app.json', 'runtime-config.json']) {
    requireEvidence(source.files[name]?.toString('utf8') === generated.files[name], 'VERIFIED_IMAGE_TEMPLATE_MISMATCH');
  }
  const description = {
    effective: { maximumMs: config.maximumMs ?? 900000, maximumCommandMs: 60000,
      maximumCloudReads: 160, maximumPolls: 90, pollIntervalMs: 5000 },
    readback: evidence.description.readback, ceilings: evidence.description.ceilings,
    scanPolicy: evidence.description.scanPolicy,
  };
  const scope = {
    schemaVersion: 1, kind: 'mcp-verified-image-deployment-plan', workspaceRoot, project: source.projectDir,
    output, configPath, config, sourceManifestDigest: source.manifest.contentDigest,
    producerBuild: (await getLibraryInfo()).contentDigest, evidence: evidence.binding,
    target: source.input.azure,
    deployment: { template: JSON.parse(source.files['infra/container-app.json']), runtime: source.runtime },
    identity: evidence.identity, login: null, targets: evidence.targets, description, ...description,
    effective: { ...description.effective, identityProject: config.azureIdentityProject },
    effects: [
      'Independent expiring direct-ACA create-only authority; the consumed parent is evidence, never resumed or reauthorized.',
      'Read retained source, build/scan/smoke chain and private reports; require fresh zero-critical/high scan and scanner database.',
      'Recheck the exact OCI manifest digest in ACR once with the same private Azure identity immediately before create.',
      'Create only the exact absent app with the unchanged trusted template, identity and resource ceilings; no roles, keys or unrelated resources.',
      'Readiness polling and one bounded public HTTPS /health GET only; no provider, discovery, proof or consumer authority.',
      'No Docker access, build, pull, push, token export, sign-in or shared account change.',
      'Preserve the parent reservation and take an independent one-shot target claim; failed/unknown calls cannot be replayed through another output.',
      'Local workspace claims are not distributed Azure locks; conditional creation requires live qualification and exclusive owner control.',
      'Historical metadata is not current readiness, signed provenance, provider validity or consumer acceptance. Limits are not an invoice cap.',
    ],
  };
  const plan = { approvalToken: `mcp-verified-image-deployment/${digest(scope)}`, scope, requiresSignIn: false };
  if (await exists(path.join(output, 'plan.json'))) {
    requireEvidence(digest(await readControl(path.join(output, 'plan.json'))) === digest(plan), 'VERIFIED_IMAGE_PLAN_CHANGED');
  } else if (await exists(output)) requireEvidence((await readdir(output))
    .every(name => name === '.mcp-execution-host.lock'), 'VERIFIED_IMAGE_OUTPUT_EXISTS');
  return plan;
}

async function evidence(plan) {
  const source = await readRecipeProject(plan.scope.project);
  const current = await inspectEvidence(source, plan.scope.config, plan.scope.workspaceRoot);
  requireEvidence(digest(current.binding) === digest(plan.scope.evidence), 'VERIFIED_IMAGE_EVIDENCE_CHANGED');
  requireEvidence(source.manifest.contentDigest === plan.scope.sourceManifestDigest);
  return current;
}
async function reserve(plan) {
  await evidence(plan);
  const scope = plan.scope;
  const claim = path.join(scope.workspaceRoot, '.mcp-execution-host-targets',
    `${digest(scope.targets.app.toLowerCase()).slice(7)}.verified-image.json`);
  const expected = { schemaVersion: 1, plan: plan.approvalToken, parent: scope.config.oldHostApproval, resourceId: scope.targets.app };
  if (await exists(claim)) requireEvidence(digest(await readControl(claim)) === digest(expected), 'VERIFIED_IMAGE_CONSUMED');
  else await writeControl(claim, expected, { create: true });
}
export const planVerifiedImageDeployment = options => scoped(options, () => prepare(options));
export const runVerifiedImageDeployment = (options, dependencies = {}) =>
  runVerifiedImageHost(options, dependencies, { prepare, evidence, reserve });
