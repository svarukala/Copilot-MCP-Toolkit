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
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [filename, ...args], { encoding: 'utf8', timeout: 30000, env });
    assert.equal(result.error, undefined);
    return result;
  };
  return { root, run };
}

test('inventory check is read-only, rejects drift and accepts explicit regeneration', async t => {
  const { root, run } = await fixture(t, 'update-assets.mjs');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ files: ['src/', 'docs/public.md'] }));
  await writeFile(path.join(root, 'docs', 'public.md'), '# Public guide\n');
  await writeFile(path.join(root, 'docs', 'history.md'), '# Repository-only history\n');
  assert.equal(run().status, 0);
  const file = path.join(root, 'library-assets.json');
  const baseline = await readFile(file, 'utf8');
  assert.ok(JSON.parse(baseline).files.includes('docs/public.md'));
  assert.ok(!JSON.parse(baseline).files.includes('docs/history.md'));
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
  for (const files of [['docs/*.md'], ['docs/../README.md'], ['docs/public.md', 'docs/']]) {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ files }));
    assert.notEqual(run().status, 0);
    assert.equal(await readFile(file, 'utf8'), refreshed);
  }
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

test('offline runner finishes ordinary cleanup before packaging and preserves failures', async t => {
  const { root, run } = await fixture(t, 'test-offline.mjs');
  await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
  const ordinary = path.join(root, 'test', 'ordinary.test.js');
  const ordinarySource = `
    import test from 'node:test';
    import { writeFile } from 'node:fs/promises';
    test('synthetic ordinary phase', t => {
      t.after(() => writeFile(new URL('../ordinary-finished', import.meta.url), 'done'));
    });
  `;
  await writeFile(ordinary, ordinarySource);
  await writeFile(path.join(root, 'test', 'package.test.js'), `
    import test from 'node:test';
    import assert from 'node:assert/strict';
    import { readFile } from 'node:fs/promises';
    test('synthetic packed phase', async () => {
      assert.equal(await readFile(new URL('../ordinary-finished', import.meta.url), 'utf8'), 'done');
    });
  `);
  const passed = run();
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /synthetic ordinary phase/);
  assert.match(passed.stdout, /synthetic packed phase/);
  assert.match(passed.stderr, /Offline ordinary tests finished in \d+\.\d{3}s \(exit 0\)/);
  assert.match(passed.stderr, /Offline packed consumer tests finished in \d+\.\d{3}s \(exit 0\)/);
  assert.doesNotMatch(passed.stdout, /Offline .*tests finished/);
  await writeFile(ordinary, `
    import test from 'node:test';
    import assert from 'node:assert/strict';
    test('synthetic failure', () => assert.fail('Expected offline runner fixture failure'));
  `);
  const failed = run();
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout, /Expected offline runner fixture failure/);
  assert.match(failed.stdout, /synthetic packed phase/);
  assert.match(failed.stderr, /Offline ordinary tests finished in \d+\.\d{3}s \(exit 1\)/);
  assert.match(failed.stderr, /Offline packed consumer tests finished in \d+\.\d{3}s \(exit 0\)/);
  await writeFile(ordinary, ordinarySource);
  await writeFile(path.join(root, 'test', 'package.test.js'), `
    import test from 'node:test';
    test('synthetic packed failure', () => { throw Error('Expected packed fixture failure'); });
  `);
  const packedFailure = run();
  assert.notEqual(packedFailure.status, 0);
  assert.match(packedFailure.stdout, /Expected packed fixture failure/);
  assert.match(packedFailure.stderr, /Offline ordinary tests finished in \d+\.\d{3}s \(exit 0\)/);
  assert.match(packedFailure.stderr, /Offline packed consumer tests finished in \d+\.\d{3}s \(exit 1\)/);
});
