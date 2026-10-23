import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { assertProjectPath, withCliWorkspace } from './config.js';
import { readControl } from './mcp-control.js';
import { boundedSnapshot, metadataDigest, savedJson } from './anonymous-metadata.js';
import { prepareMcpServer, createMcpServerProject } from './mcp-server.js';
import { secretIssues } from './validation.js';

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function requireArtifact(ok, message) {
  if (!ok) throw Object.assign(new Error(message), { code: 'MCP_RECIPE_ARTIFACT_INVALID' });
}
function inWorkspace(options, action) {
  requireArtifact(typeof options.workspaceRoot === 'string' && typeof options.project === 'string',
    'An explicit --workspace-root and --project are required.');
  return withCliWorkspace(options.workspaceRoot, action);
}
export function sealRecipeFiles(files, recipe) {
  const manifest = { schemaVersion: 1, kind: 'mcp-recipe-source-manifest', recipe,
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, content]) => [name, digest(content)])),
    authority: 'unkeyed-source-integrity-not-deployment-or-runtime-evidence' };
  files['recipe-manifest.json'] = savedJson({ ...manifest, contentDigest: metadataDigest(boundedSnapshot(manifest)) });
}
export async function readRecipeProject(project) {
  const dir = await assertProjectPath(path.resolve(project));
  const manifest = await readControl(path.join(dir, 'recipe-manifest.json'));
  const { contentDigest, ...body } = manifest;
  requireArtifact(manifest.schemaVersion === 1 && manifest.kind === 'mcp-recipe-source-manifest'
    && manifest.authority === 'unkeyed-source-integrity-not-deployment-or-runtime-evidence'
    && contentDigest === metadataDigest(boundedSnapshot(body))
    && manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files)
    && Object.keys(manifest.files).length <= 40, 'Invalid recipe source manifest; preserve old or edited source and generate a new reviewed project.');
  const files = {};
  let total = 0;
  for (const [name, hash] of Object.entries(manifest.files)) {
    requireArtifact(/^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith('/')
      && !name.split('/').some(p => ['', '.', '..'].includes(p)), 'Invalid manifest file path.');
    const file = await assertProjectPath(path.join(dir, ...name.split('/')));
    const stat = await lstat(file);
    requireArtifact(stat.isFile() && stat.size <= 1048576, 'Recipe file is not a bounded regular file.');
    files[name] = await readFile(file);
    total += files[name].length;
    requireArtifact(total <= 4 * 1048576 && digest(files[name]) === hash, 'Recipe source changed. Generate a new reviewed project; do not silently reseal it.');
  }
  for (const name of ['recipe-definition.json', 'recipe-review.json', 'runtime-config.json', 'package.json', 'package-lock.json', 'server.js', 'runtime.js']) {
    requireArtifact(Object.hasOwn(files, name), 'Recipe source manifest is incomplete.');
  }
  const input = JSON.parse(files['recipe-definition.json']), review = JSON.parse(files['recipe-review.json']);
  requireArtifact(input.recipe === manifest.recipe && review.recipe === manifest.recipe,
    'Recipe identity differs from its source manifest.');
  return { projectDir: dir, manifest, input, review, files, runtime: JSON.parse(files['runtime-config.json']) };
}
async function newOutput(output) {
  const dir = await assertProjectPath(path.resolve(output));
  requireArtifact((await lstat(path.dirname(dir))).isDirectory(), 'Output parent must already exist.');
  try { await lstat(dir); requireArtifact(false, 'Output already exists; choose a new directory.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return dir;
}
const onlyKeys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(name => names.includes(name)) && names.every(name => Object.hasOwn(value, name));
export function sourceArchive(files) {
  const source = Object.fromEntries(Object.entries(files)
    .filter(([name]) => !name.startsWith('infra/') && !name.startsWith('recipe-') && !name.startsWith('local.settings'))
    .map(([name, value]) => [name, [value, { mtime: new Date(2000, 0, 1), level: 0 }]]));
  return Buffer.from(zipSync(source, { level: 0 }));
}

async function prepareRelease(options) {
  const project = await readRecipeProject(options.project);
  const config = await readControl(path.resolve(options.config));
  const functions = project.input.recipe === 'functions-sdk-v1';
  const gateway = project.input.recipe === 'container-apps-apim-v1';
  requireArtifact(onlyKeys(config, functions ? ['schemaVersion', 'accountName', 'sourceArchiveSha256']
    : ['schemaVersion', 'accountName', 'containerImage', ...(gateway ? ['backendOrigin'] : []),
      ...(Object.hasOwn(config, 'imageReviewFile') ? ['imageReviewFile'] : [])])
    && config.schemaVersion === 1 && typeof config.accountName === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_.+@-]{0,253}$/.test(config.accountName)
    && !secretIssues(savedJson(config)), 'Release input requires an explicit nonsecret account and immutable artifact reference.');
  if (!functions) {
    const registry = project.input.azure.registry.server;
    requireArtifact(typeof config.containerImage === 'string' && config.containerImage.startsWith(`${registry}/`)
      && /^[a-z0-9.-]+\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(config.containerImage),
    'Use a digest-pinned image from the selected registry, not a tag, secret or another registry.');
  }
  let imageQualification;
  if (config.imageReviewFile !== undefined) {
    requireArtifact(typeof config.imageReviewFile === 'string', 'imageReviewFile must be an explicit private JSON path.');
    const { readImageReview } = await import('./mcp-recipe-review.js');
    imageQualification = await readImageReview(
      path.resolve(path.dirname(path.resolve(options.config)), config.imageReviewFile), project, config.containerImage);
  }
  if (gateway) {
    const origin = new URL(config.backendOrigin);
    requireArtifact(origin.protocol === 'https:' && origin.origin === config.backendOrigin && !origin.port
      && origin.hostname.startsWith(`${project.input.azure.appName}.`) && origin.hostname.endsWith('.azurecontainerapps.io'),
    'Gateway release requires the actual selected Container Apps HTTPS backend origin, not the gateway URL.');
  }
  const outputPath = await newOutput(options.output);
  const archive = sourceArchive(project.files);
  if (functions) requireArtifact(config.sourceArchiveSha256 === digest(archive),
    'Review the exact source archive hash before preparing a Functions release.');
  const templates = Object.entries(project.files).filter(([name]) => name.startsWith('infra/') && name.endsWith('.json'));
  requireArtifact(templates.length > 0, 'No reviewed deployment templates found.');
  const parameters = { $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#',
    contentVersion: '1.0.0.0', parameters: functions ? {} : { containerImage: { value: config.containerImage } } };
  const release = {
    schemaVersion: 1, kind: 'mcp-recipe-release-review', recipe: project.input.recipe,
    sourceManifestDigest: project.manifest.contentDigest, sourceArchiveSha256: digest(archive),
    target: project.input.azure, accountName: config.accountName, backend: project.input.backend,
    ...(gateway ? { gatewayBackendOrigin: config.backendOrigin } : {}),
    artifact: functions ? { sourceArchiveSha256: config.sourceArchiveSha256 }
      : { image: config.containerImage, imageSourceCorrespondence: 'operator-asserted-not-verified' },
    ...(imageQualification ? { imageQualification } : {}),
    templateHashes: Object.fromEntries(templates.map(([name, bytes]) => [name, digest(bytes)])),
    parameters, execution: 'operator-reviewed-not-executed', readiness: 'requires-live-prerequisite-review',
    checkpoints: [
      'Select the exact tenant/subscription/account with a fresh project-private Azure CLI profile; do not copy caches or change the shared profile.',
      'Inspect all existing resources, region, plan/preview requirements, role assignments, DNS, network reachability and safe diagnostics.',
      ...(project.input.backend.apiKey ? [
        'Inspect the exact Key Vault resource/secret reference and dedicated identity in the selected tenant/subscription. Confirm pre-existing least-privilege secret Get access without resolving/exporting the secret.',
        'Review shared backend entitlement and safe header/query logging; verify platform reference resolution and restart/rotation behavior separately. Never weaken caller/gateway authentication or grant roles implicitly.',
      ] : []),
      'Confirm every newly created resource name is absent. ARM can overwrite resources; these files are not a concurrency/no-overwrite guard.',
      'Review the source, dependencies, base image and final artifact. An image digest does not prove it was built from this source.',
      'Review Azure what-if and pricing, then separately approve the exact target, templates and parameters before deployment.',
      'Preserve failed/unknown deployment attempts and reconcile resource state before any retry. Never erase evidence to obtain another attempt.',
      'Check actual deployed URLs and authentication before separate discovery, tool execution, consumer registration and rollout.',
    ],
  };
  const files = { 'release-review.json': savedJson(release), 'parameters.json': savedJson(parameters),
    ...Object.fromEntries(templates.map(([name, value]) => [name, value.toString('utf8')])) };
  for (const [name, bytes] of templates) {
    const supplied = { containerImage: config.containerImage, backendOrigin: config.backendOrigin };
    const specific = Object.fromEntries(Object.keys(JSON.parse(bytes).parameters ?? {}).map(key => {
      requireArtifact(supplied[key] !== undefined, `Missing explicit template parameter: ${key}.`);
      return [key, { value: supplied[key] }];
    }));
    files[name.replace(/\.json$/, '.parameters.json')] = savedJson({ ...parameters, parameters: specific });
  }
  return { action: 'mcp-recipe-release-bundle', outputPath, review: release, files,
    sourceArchiveSha256: digest(archive), sourceArchiveBytes: archive.length,
    approvalToken: `mcp-recipe-release/${metadataDigest(boundedSnapshot({ config, outputPath, release, files }))}`, archive };
}

export async function recipeSourcePlan(options) {
  return inWorkspace(options, async () => {
    const project = await readRecipeProject(options.project);
    const archive = sourceArchive(project.files);
    return { recipe: project.input.recipe, sourceManifestDigest: project.manifest.contentDigest,
      sourceArchiveSha256: digest(archive), sourceArchiveBytes: archive.length,
      built: false, deployed: false, limitations: ['Source-only archive; Functions remote dependency build still requires separate review.'] };
  });
}
export async function planRecipeRelease(options) {
  return inWorkspace(options, async () => {
    const { archive, ...plan } = await prepareRelease(options); return plan;
  });
}
export async function writeRecipeRelease(options) {
  return inWorkspace(options, async () => {
    const plan = await prepareRelease(options);
    requireArtifact(options.approval === plan.approvalToken, 'Exact release preparation approval is required.');
    await mkdir(plan.outputPath, { mode: 0o700 });
    await mkdir(path.join(plan.outputPath, 'infra'), { mode: 0o700 });
    for (const [name, bytes] of Object.entries({ ...plan.files, 'source.zip': plan.archive })) {
      const file = await assertProjectPath(path.join(plan.outputPath, ...name.split('/')));
      await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      requireArtifact(digest(await readFile(file)) === digest(bytes), 'Release readback differs; preserve output.');
    }
    return { status: 'release-prepared-not-deployed', outputPath: plan.outputPath,
      sourceArchiveSha256: plan.sourceArchiveSha256, approvalToken: plan.approvalToken };
  });
}
async function prepareReference(options) {
  const project = await readRecipeProject(options.project), config = await readControl(path.resolve(options.config));
  requireArtifact(onlyKeys(config, ['schemaVersion', 'serverId', 'endpoint']) && config.schemaVersion === 1,
    'Reference input requires schemaVersion, a new serverId and the explicitly supplied actual HTTPS endpoint.');
  requireArtifact(typeof config.endpoint === 'string'
    && (project.runtime.gateway ? config.endpoint === project.runtime.gateway.publicUrl : new URL(config.endpoint).pathname === '/mcp'),
  'Use the recipe gateway URL, or the actual direct host /mcp endpoint; custom route mappings are not supported.');
  const a = project.runtime.authentication;
  const definition = { schemaVersion: 1, kind: 'existing-mcp', server: { id: config.serverId, name: project.input.name },
    endpoint: config.endpoint, inbound: { type: 'entra', tenantId: a.tenantId, clientId: a.audience,
      applicationIdUri: a.applicationIdUri, scope: a.scope, allowedClientIds: a.allowedClientIds } };
  const review = await prepareMcpServer(definition);
  const outputPath = await newOutput(options.output);
  const origin = { schemaVersion: 1, kind: 'recipe-endpoint-reference', recipe: project.input.recipe,
    sourceManifestDigest: project.manifest.contentDigest, endpoint: config.endpoint,
    assertion: 'operator-supplied-endpoint-not-deployment-readback', authentication: 'configuration-not-verified',
    tools: 'not-imported-use-fresh-observed-discovery', proofReplayAuthorized: false };
  const plan = { action: 'mcp-recipe-reference-create', outputPath, review, origin };
  return { ...plan, approvalToken: `mcp-recipe-reference/${metadataDigest(boundedSnapshot(plan))}` };
}
export async function planRecipeReference(options) {
  return inWorkspace(options, () => prepareReference(options));
}
export async function writeRecipeReference(options) {
  return inWorkspace(options, async () => {
    const plan = await prepareReference(options);
    requireArtifact(options.approval === plan.approvalToken, 'Exact endpoint-reference approval is required.');
    const result = await createMcpServerProject(plan.review, { workspaceRoot: options.workspaceRoot, projectDir: plan.outputPath });
    await writeFile(path.join(plan.outputPath, 'recipe-origin.json'), savedJson(plan.origin), { flag: 'wx', mode: 0o600 });
    requireArtifact(await readFile(path.join(plan.outputPath, 'recipe-origin.json'), 'utf8') === savedJson(plan.origin), 'Reference readback differs.');
    return { ...result, endpointStatus: 'referenced-not-verified',
      next: 'Use existing MCP discovery/proof/FCC flows with separate approvals and newly observed metadata.' };
  });
}
