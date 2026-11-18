import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import path from 'node:path';

const concurrency = Number(process.argv[2]);
if (![1, 4, 11].includes(concurrency)) throw new Error('Expected concurrency 1, 4 or 11.');
// Each process uses the creation fixture's own mkdtemp workspace and synthetic transports.
const runner = run({
  files: Array(concurrency).fill(path.resolve('test', 'mcp-validation-journey.test.js')),
  concurrency,
  testNamePatterns: ['creation runner generates direct ACA header-key'],
});
runner.on('test:fail', () => { process.exitCode = 1; });
runner.compose(spec).pipe(process.stdout);
