import { readdir } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = (await readdir(path.join(root, 'test'), { withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
  .map(entry => path.join(root, 'test', entry.name)).sort();
const packed = path.join(root, 'test', 'package.test.js');
const ordinary = files.filter(file => file !== packed);
if (!files.includes(packed) || ordinary.length === 0) throw new Error('Offline test files are missing.');

// Integrity-heavy journeys share disk/CPU, but keep their real production deadlines.
const concurrency = Math.min(4, Math.max(1, availableParallelism() - 1));
for (const [label, selected, jobs] of [
  ['ordinary', ordinary, concurrency],
  ['packed consumer', [packed], 1],
]) {
  console.error(`Offline ${label} tests (${jobs} concurrent file${jobs === 1 ? '' : 's'}).`);
  const result = spawnSync(process.execPath, [
    '--test', `--test-concurrency=${jobs}`, ...process.argv.slice(2), ...selected,
  ], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Offline tests interrupted by ${result.signal}.`);
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}
