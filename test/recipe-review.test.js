import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { TOOLKIT_ROOT } from '../src/config.js';
import { compileHostingRecipe, planHostingRecipe, writeHostingRecipe } from '../src/mcp-container-apps.js';
import { planRecipeRelease } from '../src/mcp-recipe-artifacts.js';
import { planRecipeReview, writeRecipeReview } from '../src/mcp-recipe-review.js';
import { reviewImage } from '../src/mcp-image-review.js';
const hash = `sha256:${'a'.repeat(64)}`;
const build = { builderImage: `node:22-bookworm-slim@${hash}`,
  runtimeImage: `gcr.io/distroless/nodejs22-debian12:nonroot@${hash}`, platform: 'linux/amd64' };
test('container recipes require linux/amd64 images and Functions remains source-only', async () => {
  for (const recipe of ['container-apps-direct', 'container-apps-apim', 'app-service-container', 'functions-sdk']) {
    const input = JSON.parse(await readFile(new URL(`../examples/mcp/${recipe}.json`, import.meta.url)));
    input.imageBuild = structuredClone(build);
    if (recipe === 'functions-sdk') {
      assert.throws(() => compileHostingRecipe(input), /source-only remote build/);
      continue;
    }
    const compiled = compileHostingRecipe(input);
    assert.equal(compiled.input.imageBuild.platform, 'linux/amd64');
    for (const platform of ['linux/arm64', 'windows/amd64']) {
      input.imageBuild.platform = platform;
      assert.throws(() => compileHostingRecipe(input), { code: 'MCP_CONTAINER_APPS_INPUT' });
    }
  }
});
async function fixture(t, recipe = 'container-apps-direct-api-key', imageBuild = build) {
  await mkdir(path.join(TOOLKIT_ROOT, '.test-output'), { recursive: true });
  const root = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'recipe-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = JSON.parse(await readFile(new URL(`../examples/mcp/${recipe}.json`, import.meta.url)));
  input.imageBuild = imageBuild;
  const config = path.join(root, 'hosting.json'); await writeFile(config, JSON.stringify(input));
  const generation = { workspaceRoot: root, config, output: path.join(root, 'server') };
  const generated = await planHostingRecipe(generation);
  await writeHostingRecipe({ ...generation, approval: generated.approvalToken });
  const manifest = JSON.parse(await readFile(path.join(generation.output, 'recipe-manifest.json')));
  const image = `${input.azure.registry.server}/mcp@${hash}`, now = new Date(Date.now() - 1000).toISOString();
  const qualification = { schemaVersion: 1, kind: 'image-qualification', image,
    sourceManifestDigest: manifest.contentDigest, build: imageBuild, builder: { run: 'synthetic-build-1', evidenceDigest: hash },
    scan: { image, scanner: 'synthetic-1', databaseUpdatedAt: now, scannedAt: now,
      critical: 0, high: 0, medium: 23, low: 8, reportDigest: hash },
    smoke: { image, networkDisabled: true, nonroot: true, status: 'passed', evidenceDigest: hash },
    sbom: { image, reportDigest: hash } };
  const options = { workspaceRoot: root, project: generation.output,
    config: path.join(root, 'review-input.json'), output: path.join(root, 'review.json') };
  const save = () => writeFile(options.config, JSON.stringify(qualification));
  await save();
  return { root, options, qualification, generated, input, manifest, save };
}
test('minimal image inputs and all qualification receipts bind to a newly sealed source and exact digest', async t => {
  const f = await fixture(t);
  assert.equal(f.generated.files.Dockerfile.match(/FROM --platform=linux\/amd64 /g).length, 2);
  assert.match(f.generated.files.Dockerfile, /AS dependencies/);
  assert.match(f.generated.files.Dockerfile, /USER 65532:65532/);
  assert.match(f.generated.files.Dockerfile, /ENTRYPOINT \["\/nodejs\/bin\/node"\]/);
  assert.doesNotMatch(f.generated.files.Dockerfile.split('FROM --platform=')[2], /npm ci|COPY --from=dependencies.*\/usr/);
  const plan = await planRecipeReview(f.options);
  assert.equal(plan.bundle.result.status, 'passed-operator-evidence-review-not-attestation');
  assert.equal(plan.bundle.result.sourceHashes['package-lock.json'], f.manifest.files['package-lock.json']);
  await assert.rejects(writeRecipeReview({ ...f.options, approval: 'wrong' }));
  await writeRecipeReview({ ...f.options, approval: plan.approvalToken });
  const config = path.join(f.root, 'release.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, accountName: 'owner@example.com',
    containerImage: f.qualification.image, imageReviewFile: 'review.json' }));
  const release = await planRecipeRelease({ ...f.options, config, output: path.join(f.root, 'release') });
  assert.equal(release.review.imageQualification.contentDigest, plan.bundle.contentDigest);
  assert.equal(release.review.artifact.imageSourceCorrespondence, 'operator-asserted-not-verified');
  f.qualification.scan.high = 1; await f.save();
  await assert.rejects(planRecipeReview({ ...f.options, output: path.join(f.root, 'failed.json') }), /zero critical\/high/);
});
for (const recipe of ['container-apps-direct-api-key', 'container-apps-apim-api-key', 'app-service-container-api-key']) {
  test(`${recipe}: Debian 13 binds generation and qualification without changing the Debian 12 profile`, async t => {
    const imageBuild = { ...build, runtimeImage: build.runtimeImage.replace('debian12', 'debian13') };
    const f = await fixture(t, recipe, imageBuild);
    assert.ok(f.generated.files.Dockerfile.includes(`FROM --platform=linux/amd64 ${imageBuild.runtimeImage}`));
    assert.match(f.generated.files.Dockerfile, /USER 65532:65532/);
    const plan = await planRecipeReview(f.options);
    assert.deepEqual(plan.bundle.result.build, imageBuild);
    assert.deepEqual(plan.bundle.result.policy, { maximumCritical: 0, maximumHigh: 0, maximumAgeHours: 24 });
    f.qualification.build = build;
    await f.save();
    await assert.rejects(planRecipeReview(f.options), /explicit digest-pinned imageBuild/);
    f.qualification.build = imageBuild;
    f.qualification.scan.high = 1;
    await f.save();
    await assert.rejects(planRecipeReview(f.options), /zero critical\/high/);
    assert.equal(compileHostingRecipe({ ...f.input, imageBuild: build }).input.imageBuild.runtimeImage, build.runtimeImage);
  });
}
test('runtime profiles reject mutable, root, debug, other-version and foreign-registry images', async () => {
  const input = JSON.parse(await readFile(new URL('../examples/mcp/container-apps-direct.json', import.meta.url)));
  for (const runtimeImage of [
    'gcr.io/distroless/nodejs22-debian13:nonroot',
    `gcr.io/distroless/nodejs22-debian13@${hash}`,
    `gcr.io/distroless/nodejs22-debian13:debug-nonroot@${hash}`,
    `gcr.io/distroless/nodejs24-debian13:nonroot@${hash}`,
    `gcr.io/distroless/nodejs22-debian14:nonroot@${hash}`,
    `other.example.com/distroless/nodejs22-debian13:nonroot@${hash}`,
  ]) {
    assert.throws(() => compileHostingRecipe({ ...input, imageBuild: { ...build, runtimeImage } }),
      { code: 'MCP_CONTAINER_APPS_INPUT' });
  }
  const functions = JSON.parse(await readFile(new URL('../examples/mcp/functions-sdk.json', import.meta.url)));
  assert.throws(() => compileHostingRecipe({ ...functions, imageBuild: {
    ...build, runtimeImage: build.runtimeImage.replace('debian12', 'debian13'),
  } }), /source-only remote build/);
});
test('image review rejects mismatched images, source/build, stale database and fabricated future evidence', async t => {
  const f = await fixture(t);
  const project = { input: f.input, manifest: f.manifest, files: f.generated.files };
  for (const mutate of [
    q => { q.image = `other.azurecr.io/server@${hash}`; },
    q => { q.smoke.image = `other.azurecr.io/server@${hash}`; },
    q => { q.sourceManifestDigest = `sha256:${'b'.repeat(64)}`; },
    q => { q.build.platform = 'linux/arm64'; },
    q => { q.build.runtimeImage = q.build.runtimeImage.replace(hash, `sha256:${'b'.repeat(64)}`); },
    q => { q.scan.databaseUpdatedAt = '2020-01-01T00:00:00.000Z'; },
    q => { q.scan.scannedAt = '2099-01-01T00:00:00.000Z'; },
    q => { q.scan.critical = 1; }, q => { q.smoke.networkDisabled = false; },
    q => { q.build.builderImage = 'node:22-bookworm-slim'; },
  ]) {
    const q = structuredClone(f.qualification); mutate(q);
    assert.throws(() => reviewImage(project, q), { code: 'MCP_IMAGE_QUALIFICATION' });
  }
});
