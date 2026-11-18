import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import * as api from 'copilot-mcp-toolkit';
import { TOOLKIT_ROOT } from '../src/config.js';
import { capabilities } from '../src/machine-contract.js';
import { gatewayApiId, inboundAuthorization, resourceOwnerIdentity } from '../src/contract.js';
import { checkConfig } from '../src/apim-renderer.js';

test('all supported synthetic generation modes preserve pinned original bytes and review semantics', async () => {
  const fixture = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'test', 'fixtures', 'generation-parity.json')));
  assert.equal(fixture.sourceCommit, 'cca98401d9433c28b4c01fec2f90bba8fb21bec4');
  assert.equal(fixture.vectors.length, 13);
  for (const vector of fixture.vectors) {
    const review = await api.prepareMcpServer(vector.input);
    assert.equal(review.reviewDigest, vector.reviewDigest, vector.name);
    assert.equal(review.descriptor.descriptorDigest, vector.descriptorDigest, vector.name);
    assert.deepEqual(Object.fromEntries(Object.entries(review.files).map(([name, value]) =>
      [name, createHash('sha256').update(value).digest('hex')])), vector.files, vector.name);
  }
});

test('consumer fallback and packaging execution are absent rather than hidden behind a renamed bin', async () => {
  for (const name of ['prepareCoworkMcpConnector', 'createCoworkProject', 'packageSkillsProject',
    'prepareSkillsConfig', 'provisionProject', 'executeMcpProjectForTest']) assert.equal(api[name], undefined);
  const legacy = { plugin: { id: '11111111-1111-4111-8111-111111111111' }, azure: {}, connectors: [] };
  for (const action of [gatewayApiId, inboundAuthorization, resourceOwnerIdentity, checkConfig]) assert.throws(() => action(legacy, {}), /standalone/);
  const files = await readdir(path.join(TOOLKIT_ROOT, 'src'));
  for (const file of ['plugin.js', 'cowork-metadata.js', 'wizard.js', 'workflow-plan.js', 'skill-frontmatter.js', 'sso-registration.js']) {
    assert.ok(!files.includes(file));
  }
  for (const file of files.filter(f => f.endsWith('.js'))) {
    const text = await readFile(path.join(TOOLKIT_ROOT, 'src', file), 'utf8');
    assert.doesNotMatch(text, /from ['"][^'"]*(?:Cowork-Plugin-Toolkit|cowork-plugin-toolkit)|\.source-import/);
  }
});

test('capabilities and public build identity describe this independent package and guidance skill only', async () => {
  const c = await capabilities(), info = await api.getLibraryInfo();
  assert.equal(c.toolkit.name, 'copilot-mcp-toolkit');
  assert.equal(c.toolkit.buildId, info.contentDigest);
  assert.equal(c.copilotCli.engine, 'copilot-mcp');
  assert.equal(c.hostingRecipes.npmRegistry.configField, 'npmRegistryUrl');
  assert.equal(c.hostingRecipes.npmRegistry.default, 'https://registry.npmjs.org/');
  assert.equal(c.hostingRecipes.npmRegistry.credentials, false);
  assert.equal(c.hostingRecipes.npmRegistry.existingSealedProjectMutation, false);
  assert.ok(c.commands.includes('mcp-resume'));
  assert.ok(c.commands.includes('mcp-diagnose'));
  assert.ok(!c.commands.some(cmd => /cowork|skills|sso-|workflow-|package/.test(cmd)));
  assert.equal(c.mcpDiscovery.firstCallAcceptance.executionVersion, 4);
  assert.equal(c.mcpDiscovery.providerOAuth, 'reference-only-no-integrated-import-or-exchange');
  assert.equal(c.mcpEvidence.importedIdentity, 'fresh-private-login-required');
  const pkg = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'package.json')));
  const lock = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'package-lock.json')));
  assert.deepEqual(pkg.dependencies, lock.packages[''].dependencies);
  assert.deepEqual(pkg.bin, lock.packages[''].bin);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(pkg.dependencies.yaml, undefined);
});

test('bounded build inspection preserves serial digest ordering and detects changed or missing assets', async t => {
  await mkdir(path.join(TOOLKIT_ROOT, '.test-output'), { recursive: true });
  const root = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'build-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  for (const file of ['machine-contract.js', 'validation.js']) {
    await copyFile(path.join(TOOLKIT_ROOT, 'src', file), path.join(root, 'src', file));
  }
  await writeFile(path.join(root, 'src', 'config.js'),
    `import { fileURLToPath } from 'node:url'; export const TOOLKIT_ROOT = fileURLToPath(new URL('..', import.meta.url));`);
  await writeFile(path.join(root, 'src', 'help.js'), 'export const commandFamilies = {};');
  await writeFile(path.join(root, 'src', 'standalone-capabilities.js'), 'export const standaloneCapabilities = () => ({});');
  await writeFile(path.join(root, 'package.json'), '{"type":"module","name":"synthetic","version":"0.0.0"}\n');
  const files = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'package.json'];
  for (const file of files.filter(file => file.endsWith('.txt'))) await writeFile(path.join(root, file), `${file}\n`);
  await writeFile(path.join(root, 'library-assets.json'), JSON.stringify({ schemaVersion: 1, files }));
  const hash = createHash('sha256');
  for (const file of [...files, 'library-assets.json'].sort()) {
    const bytes = await readFile(path.join(root, file));
    hash.update(`${file}\0${bytes.length}\0`); hash.update(bytes);
  }
  const expected = `sha256:${hash.digest('hex')}`;
  const { getLibraryInfo } = await import(pathToFileURL(path.join(root, 'src', 'machine-contract.js')).href);
  const inspections = await Promise.all([getLibraryInfo(), getLibraryInfo()]);
  assert.ok(inspections.every(info => info.contentDigest === expected));
  await writeFile(path.join(root, 'a.txt'), 'z.txt\n');
  assert.notEqual((await getLibraryInfo()).contentDigest, expected);
  await rm(path.join(root, 'b.txt'));
  await assert.rejects(getLibraryInfo(), { code: 'ENOENT' });
  await mkdir(path.join(root, 'b.txt'));
  await assert.rejects(getLibraryInfo(), { code: 'ASSETS' });
});
