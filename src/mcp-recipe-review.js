import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { assertProjectPath, withCliWorkspace } from './config.js';
import { boundedSnapshot, metadataDigest, savedJson } from './anonymous-metadata.js';
import { readControl } from './mcp-control.js';
import { readRecipeProject } from './mcp-recipe-artifacts.js';
import { getLibraryInfo } from './machine-contract.js';
import { secretIssues } from './validation.js';
import { writeNewJsonBundle } from './mcp-bundle-write.js';
import { imageReviewSchema, reviewImage } from './mcp-image-review.js';

export const recipeReviewSchema = { oneOf: [imageReviewSchema] };
const digest = value => metadataDigest(boundedSnapshot(value));
function requireReview(ok, code, message) {
  if (!ok) throw Object.assign(new Error(message), { code: `MCP_RECIPE_REVIEW_${code}` });
}
function review(project, input) {
  requireReview(!secretIssues(savedJson(input)), 'INPUT', 'Only nonsecret bounded review metadata is supported.');
  requireReview(input?.kind === 'image-qualification', 'INPUT', 'Use mcp-recipe-review-schema for supported review kinds.');
  return reviewImage(project, input);
}
async function prepare(options) {
  requireReview(typeof options.config === 'string' && typeof options.output === 'string', 'INPUT',
    'Review plan/bundle requires --config and a new --output JSON file.');
  const project = await readRecipeProject(options.project);
  const input = await readControl(path.resolve(options.config));
  const result = review(project, input);
  const outputPath = await assertProjectPath(path.resolve(options.output));
  requireReview(path.extname(outputPath).toLowerCase() === '.json' && (await lstat(path.dirname(outputPath))).isDirectory(),
    'OUTPUT', 'Select a new .json file in an existing private directory.');
  try { await lstat(outputPath); requireReview(false, 'OUTPUT', 'Output already exists; use a new review file.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const info = await getLibraryInfo();
  const body = { schemaVersion: 1, kind: 'mcp-recipe-operator-review',
    sourceManifestDigest: project.manifest.contentDigest, input, result,
    producerBuild: info.contentDigest, executionReadiness: false, proofReplayAuthorized: false };
  const bundle = { ...body, contentDigest: digest(body) };
  return { action: 'mcp-recipe-review-bundle', status: 'planned-local-review-only', outputPath, bundle,
    approvalToken: `mcp-recipe-review/${digest({ project: project.projectDir, outputPath, bundle })}` };
}
function inWorkspace(options, action) {
  requireReview(typeof options.workspaceRoot === 'string' && typeof options.project === 'string',
    'WORKSPACE', 'Review requires explicit --workspace-root and sealed --project.');
  return withCliWorkspace(options.workspaceRoot, action);
}
export const planRecipeReview = options => inWorkspace(options, () => prepare(options));
export const writeRecipeReview = options => inWorkspace(options, () => writeNewJsonBundle(options, prepare, requireReview));
export async function readImageReview(filename, project, expectedImage) {
  const bundle = await readControl(filename);
  const { contentDigest, ...body } = bundle;
  requireReview(bundle.schemaVersion === 1 && bundle.kind === 'mcp-recipe-operator-review'
    && contentDigest === digest(body) && bundle.sourceManifestDigest === project.manifest.contentDigest
    && bundle.input?.kind === 'image-qualification' && bundle.input.image === expectedImage,
  'INTEGRITY', 'Image review must match the exact source and release image; preserve stale or altered evidence.');
  requireReview(digest(review(project, bundle.input)) === digest(bundle.result), 'INTEGRITY',
    'Image review differs or is no longer eligible; review new scan evidence without rewriting old artifacts.');
  return { contentDigest, ...bundle.result };
}
