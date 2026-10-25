import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { TOOLKIT_ROOT } from '../src/config.js';

async function fixture(t, script) {
  const parent = path.join(TOOLKIT_ROOT, '.test-output');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'development-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['src', 'bin', 'scripts', 'skills', 'examples', 'docs']) await mkdir(path.join(root, name));
  const filename = path.join(root, 'scripts', script);
  await copyFile(path.join(TOOLKIT_ROOT, 'scripts', script), filename);
  const run = (...args) => {
    const result = spawnSync(process.execPath, [filename, ...args], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.error, undefined);
    return result;
  };
  return { root, run };
}

test('inventory check is read-only, rejects drift and accepts explicit regeneration', async t => {
  const { root, run } = await fixture(t, 'update-assets.mjs');
  assert.equal(run().status, 0);
  const file = path.join(root, 'library-assets.json');
  const baseline = await readFile(file, 'utf8');
  assert.equal(run('--check').status, 0);
  await writeFile(path.join(root, 'src', 'new.js'), 'export const synthetic = true;\n');
  const stale = run('--check');
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /Runtime inventory is stale/);
  assert.equal(await readFile(file, 'utf8'), baseline);
  assert.equal(run().status, 0);
  assert.equal(run('--check').status, 0);
  assert.ok(JSON.parse(await readFile(file)).files.includes('src/new.js'));
  const refreshed = await readFile(file, 'utf8');
  assert.notEqual(run('--unknown').status, 0);
  assert.equal(await readFile(file, 'utf8'), refreshed);
});

test('syntax gate includes nested source, CLI and maintenance scripts without executing them', async t => {
  const { root, run } = await fixture(t, 'check-syntax.mjs');
  await mkdir(path.join(root, 'src', 'nested'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
  for (const relative of ['src/nested/runtime.js', 'bin/cli.js', 'scripts/maintenance.mjs']) {
    const file = path.join(root, relative);
    await writeFile(file, 'throw new Error("Syntax checks must not execute code");\n');
    assert.equal(run().status, 0);
    await writeFile(file, 'export const = ;\n');
    const failure = run();
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, /Syntax check failed/);
    await writeFile(file, 'export const synthetic = true;\n');
  }
  assert.equal(run().status, 0);
});
