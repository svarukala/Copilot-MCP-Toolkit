import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { TOOLKIT_ROOT } from '../src/config.js';
import { savedJson } from '../src/anonymous-metadata.js';
import { defaultNpmRegistryUrl, resolveNpmRegistryUrl, mapRuntimeLock } from '../src/npm-registry.js';
import { compileContainerApps, compileHostingRecipe, planHostingRecipe, writeHostingRecipe } from '../src/mcp-container-apps.js';
import { recipeSourcePlan, planRecipeRelease, writeRecipeRelease, sealRecipeFiles } from '../src/mcp-recipe-artifacts.js';
import { planHandover, writeHandover } from '../src/mcp-handover.js';
import { main } from '../bin/copilot-mcp.js';

const registry = 'https://packages.example.com/team/_packaging/approved/npm/registry/';
const recipes = ['container-apps-direct', 'container-apps-apim', 'app-service-container', 'functions-sdk'];
const fixture = async name => JSON.parse(await readFile(new URL(`../examples/mcp/${name}.json`, import.meta.url)));
const runtimeLock = JSON.parse(await readFile(new URL('../src/recipes/container-apps/package-lock.json', import.meta.url)));
const build = { builderImage: `node:22-bookworm-slim@sha256:${'a'.repeat(64)}`,
  runtimeImage: `gcr.io/distroless/nodejs22-debian12:nonroot@sha256:${'b'.repeat(64)}`, platform: 'linux/amd64' };
async function setup(t, name) {
  const parent = path.join(TOOLKIT_ROOT, '.test-output');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'registry-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await fixture(name);
  if (name !== 'functions-sdk') input.imageBuild = build;
  const options = { workspaceRoot: root, config: path.join(root, 'recipe.json'), output: path.join(root, 'source') };
  const save = () => writeFile(options.config, savedJson(input));
  await save();
  return { root, input, options, save };
}

test('all hosting compilers accept only canonical credential-free registry bases and reject unknown configuration', async () => {
  assert.equal(resolveNpmRegistryUrl(), defaultNpmRegistryUrl);
  assert.equal(resolveNpmRegistryUrl(registry), registry);
  assert.equal(resolveNpmRegistryUrl('https://packages.example.com/'), 'https://packages.example.com/');
  for (const name of recipes) {
    const input = await fixture(name);
    assert.equal(compileHostingRecipe(input).input.npmRegistryUrl, undefined);
    assert.equal(compileHostingRecipe({ ...input, npmRegistryUrl: registry }).input.npmRegistryUrl, registry);
    for (const value of [
      null, false, {}, [], '', 'http://packages.example.com/', 'https://packages.example.com',
      'https://packages.example.com/feed', 'https://packages.example.com:8443/', 'https://packages.example.com:443/',
      'https://user:password@packages.example.com/', 'https://packages.example.com/?token=value',
      'https://packages.example.com/#fragment', 'https://packages.example.com/?', 'https://packages.example.com/#',
      'https://127.0.0.1/', 'https://[::1]/', 'https://feed.internal/', 'https://feed.local/',
      'https://metadata.example.com/', 'https://Packages.example.com/', 'https://packages.example.com./',
      'https://bad..example.com/', 'https://-bad.example.com/', 'https://packages.example.com/../feed/',
      'https://packages.example.com/a/./b/', 'https://packages.example.com//feed/',
      'https://packages.example.com/%2e%2e/', 'https://packages.example.com/%2f/', 'https://packages.example.com/%20/',
      'https://packages.example.com/${TOKEN}/', 'https://packages.example.com/$TOKEN/',
      "https://packages.example.com/quote'/", 'https://packages.example.com/feed;command/',
      'https://packages.example.com/feed&command/', 'https://packages.example.com/\\other/',
      'https://packages.example.com/\nregistry=other', ' https://packages.example.com/',
    ]) assert.throws(() => compileHostingRecipe({ ...input, npmRegistryUrl: value }), undefined, `${name}: ${String(value)}`);
    assert.throws(() => compileHostingRecipe({ ...input, npmRegistry: { url: registry } }));
    assert.throws(() => compileHostingRecipe({ ...input, npmRegistryUrl: registry, npmToken: 'not-supported' }));
  }
  assert.equal(compileContainerApps({ ...await fixture(recipes[0]), npmRegistryUrl: registry }).input.npmRegistryUrl, registry);
});

test('runtime lock mapping preserves every pinned field and scoped/nested tarball, refusing unknown sources', () => {
  const mapped = mapRuntimeLock(structuredClone(runtimeLock), registry);
  let scoped = 0, nested = 0;
  for (const [name, pkg] of Object.entries(mapped.packages)) {
    if (!name) { assert.deepEqual(pkg, runtimeLock.packages[name]); continue; }
    const { resolved, ...rest } = pkg, { resolved: original, ...expected } = runtimeLock.packages[name];
    assert.deepEqual(rest, expected);
    const suffix = original.split('/npm/registry/')[1];
    assert.equal(resolved, `${registry}${suffix}`);
    if (name.includes('@')) scoped++;
    if (name.split('node_modules/').length > 2) nested++;
  }
  assert.ok(scoped > 0 && nested > 0);
  const publicLock = mapRuntimeLock(structuredClone(runtimeLock), defaultNpmRegistryUrl);
  assert.deepEqual(mapRuntimeLock(publicLock, registry), mapped);
  for (const mutate of [
    x => { x.lockfileVersion = 2; }, x => { delete x.packages; },
    x => { x.packages['node_modules/ajv'].resolved = 'https://unreviewed.example.com/ajv/-/ajv-8.20.0.tgz'; },
    x => { x.packages['node_modules/ajv'].resolved += '?credential=value'; },
    x => { x.packages['node_modules/ajv'].resolved = 'https://registry.npmjs.org/../ajv/-/ajv-8.20.0.tgz'; },
    x => { x.packages['node_modules/ajv'].version = 'latest'; },
    x => { x.packages['node_modules/ajv'].integrity = ''; },
    x => { delete x.packages['node_modules/ajv'].resolved; },
  ]) {
    const lock = structuredClone(runtimeLock); mutate(lock);
    assert.throws(() => mapRuntimeLock(lock, registry), { code: 'MCP_NPM_REGISTRY_INVALID' });
  }
});

for (const name of recipes) test(`${name}: registry binds generation, build, release and handover without touching sealed projects`, async t => {
  const f = await setup(t, name), baseline = await planHostingRecipe(f.options);
  assert.equal(baseline.review.npmRegistryUrl, defaultNpmRegistryUrl);
  f.input.npmRegistryUrl = registry; await f.save();
  const plan = await planHostingRecipe(f.options);
  assert.notEqual(plan.approvalToken, baseline.approvalToken);
  await assert.rejects(writeHostingRecipe({ ...f.options, approval: baseline.approvalToken }), /approval/);
  assert.ok(!(await readdir(f.root)).includes('source'));
  assert.equal(plan.review.npmRegistryUrl, registry);
  assert.equal(JSON.parse(plan.files['recipe-review.json']).npmRegistryUrl, registry);
  assert.equal(JSON.parse(plan.files['recipe-definition.json']).npmRegistryUrl, registry);
  assert.equal(plan.files['.npmrc'], `registry=${registry}\nreplace-registry-host=never\nstrict-ssl=true\nfetch-retries=0\n`);
  assert.deepEqual(JSON.parse(plan.files['package-lock.json']), mapRuntimeLock(structuredClone(runtimeLock), registry));
  if (name !== 'functions-sdk') {
    assert.ok(plan.files['.dockerignore'].split('\n').includes('!.npmrc'));
    const [dependencies, runtime] = plan.files.Dockerfile.split(`FROM --platform=linux/amd64 ${build.runtimeImage}`);
    assert.match(dependencies, /COPY package\.json package-lock\.json \.npmrc \.\//);
    assert.match(dependencies, /RUN mkdir \/tmp\/mcp-npm && touch \/tmp\/mcp-npm\/user\.npmrc \/tmp\/mcp-npm\/global\.npmrc && env -i PATH="\$PATH" HOME=\/tmp\/mcp-npm npm ci/);
    for (const flag of ['--userconfig=/tmp/mcp-npm/user.npmrc', '--globalconfig=/tmp/mcp-npm/global.npmrc', '--cache=/tmp/mcp-npm/cache',
      `--registry=${registry}`, '--replace-registry-host=never', '--strict-ssl=true', '--fetch-retries=0',
      '--omit=dev', '--ignore-scripts', '--no-audit', '--fund=false']) assert.ok(dependencies.includes(flag));
    assert.doesNotMatch(runtime, /\.npmrc|npm ci|npm-cache/);
    assert.doesNotMatch(dependencies, /registry\.npmjs\.org|NPM_TOKEN|_auth|--mount/);
  } else {
    assert.equal(plan.files.Dockerfile, undefined);
    assert.ok(!plan.files['.funcignore'].split('\n').includes('.npmrc'));
  }
  await writeHostingRecipe({ ...f.options, approval: plan.approvalToken });
  const base = { workspaceRoot: f.root, project: f.options.output };
  const source = await recipeSourcePlan(base);
  assert.equal(source.npmRegistryUrl, registry);
  const config = path.join(f.root, 'release.json');
  await writeFile(config, savedJson({ schemaVersion: 1, accountName: 'operator@example.com',
    ...(name === 'functions-sdk' ? { sourceArchiveSha256: source.sourceArchiveSha256 }
      : { containerImage: `${f.input.azure.registry.server}/mcp@sha256:${'c'.repeat(64)}` }),
    ...(f.input.azure.gateway ? { backendOrigin: `https://${f.input.azure.appName}.synthetic.eastus.azurecontainerapps.io` } : {}),
  }));
  const releaseOptions = { ...base, config, output: path.join(f.root, 'release') };
  const release = await planRecipeRelease(releaseOptions);
  assert.equal(release.review.npmRegistryUrl, registry);
  await writeRecipeRelease({ ...releaseOptions, approval: release.approvalToken });
  const zip = unzipSync(await readFile(path.join(releaseOptions.output, 'source.zip')));
  for (const file of ['.npmrc', 'package-lock.json']) assert.equal(Buffer.from(zip[file]).toString(), plan.files[file]);
  const handoverOptions = { ...base, config: path.join(f.root, 'handover.json'), output: path.join(f.root, 'handover') };
  await writeFile(handoverOptions.config, savedJson({ schemaVersion: 1, snapshotAt: new Date().toISOString(),
    privateExportReviewed: true, releaseDirectory: 'release' }));
  const handover = await planHandover(handoverOptions);
  const edit = handover.manifest.destinationEdits.find(row => row.field === 'npmRegistryUrl');
  assert.equal(edit.original, registry);
  assert.equal(edit.file, 'destination/recipe-definition.json');
  assert.ok(handover.manifest.steps.find(step => step.id === 'build').instruction.includes(registry));
  await writeHandover({ ...handoverOptions, approval: handover.approvalToken });
  for (const file of ['.npmrc', 'package-lock.json']) {
    assert.equal(await readFile(path.join(handoverOptions.output, 'source', file), 'utf8'), plan.files[file]);
  }
  for (const file of ['.npmrc', 'package-lock.json', ...(name === 'functions-sdk' ? [] : ['Dockerfile', '.dockerignore'])]) {
    await writeFile(path.join(f.options.output, file), `${plan.files[file]}\n`);
    await assert.rejects(recipeSourcePlan(base), /source changed/);
    await assert.rejects(planRecipeRelease({ ...releaseOptions, output: path.join(f.root, 'other-release') }), /source changed/);
    await assert.rejects(planHandover({ ...handoverOptions, output: path.join(f.root, 'other-handover') }), /source changed/);
    await writeFile(path.join(f.options.output, file), plan.files[file]);
  }
  f.input.npmRegistryUrl = 'https://packages.example.com/other/';
  await f.save();
  await assert.rejects(writeHostingRecipe({ ...f.options, approval: plan.approvalToken }), /already exists/);
  assert.equal(await readFile(path.join(f.options.output, '.npmrc'), 'utf8'), plan.files['.npmrc']);
});

test('omitted registry ignores ambient npm settings and remains readable as a historical sealed source', async t => {
  const f = await setup(t, recipes[0]);
  const baseline = await planHostingRecipe(f.options);
  const ambient = { NPM_CONFIG_REGISTRY: registry, NPM_CONFIG_USERCONFIG: path.join(f.root, 'ambient.npmrc'),
    NPM_CONFIG_GLOBALCONFIG: path.join(f.root, 'ambient.npmrc'), NPM_TOKEN: 'synthetic-not-a-credential' };
  await writeFile(ambient.NPM_CONFIG_USERCONFIG, `registry=${registry}\n//packages.example.com/:_authToken=synthetic-not-a-credential\n`);
  for (const [key, value] of Object.entries(ambient)) {
    const original = process.env[key]; process.env[key] = value;
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
  }
  const same = await planHostingRecipe(f.options);
  assert.equal(same.approvalToken, baseline.approvalToken);
  assert.doesNotMatch(JSON.stringify(same), /synthetic-not-a-credential/);
  assert.equal(same.review.npmRegistryUrl, defaultNpmRegistryUrl);
  // Model the historical source format without the new optional configuration/review field.
  const files = { ...baseline.files };
  delete files['recipe-manifest.json'];
  const review = JSON.parse(files['recipe-review.json']); delete review.npmRegistryUrl;
  files['recipe-review.json'] = savedJson(review);
  files['.npmrc'] = `registry=${defaultNpmRegistryUrl}\n`;
  files.Dockerfile = files.Dockerfile.replace('package-lock.json .npmrc', 'package-lock.json')
    .replace(/^RUN .*$/m, 'RUN npm ci --omit=dev --ignore-scripts --no-audit --fund=false');
  files['.dockerignore'] = files['.dockerignore'].replace('!.npmrc\n', '');
  sealRecipeFiles(files, f.input.recipe);
  await mkdir(f.options.output);
  await mkdir(path.join(f.options.output, 'infra'));
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(f.options.output, name), content);
  const base = { workspaceRoot: f.root, project: f.options.output };
  assert.equal((await recipeSourcePlan(base)).npmRegistryUrl, defaultNpmRegistryUrl);
  const config = path.join(f.root, 'handover.json');
  await writeFile(config, savedJson({ schemaVersion: 1, snapshotAt: new Date().toISOString(), privateExportReviewed: true }));
  const handover = await planHandover({ ...base, config, output: path.join(f.root, 'handover') });
  assert.equal(handover.manifest.destinationEdits.find(row => row.field === 'npmRegistryUrl').original, defaultNpmRegistryUrl);
  assert.match(handover.manifest.steps.find(step => step.id === 'build').instruction, /Historical Dockerfiles/);
  assert.equal(await readFile(path.join(f.options.output, '.npmrc'), 'utf8'), files['.npmrc']);
});

test('CLI approval summary exposes selected registry while stdout remains JSON', async t => {
  const f = await setup(t, recipes[0]); f.input.npmRegistryUrl = registry; await f.save();
  const stdout = [], stderr = [];
  t.mock.method(process.stdout, 'write', value => { stdout.push(String(value)); return true; });
  t.mock.method(process.stderr, 'write', value => { stderr.push(String(value)); return true; });
  assert.equal(await main(['mcp-hosting-plan', '--workspace-root', f.root, '--config', f.options.config,
    '--output', f.options.output, '--summary', '--json']), 0);
  assert.equal(JSON.parse(stdout.join('')).review.npmRegistryUrl, registry);
  assert.ok(stderr.join('').includes(`Npm registry: ${registry}`));
});
