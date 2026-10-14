import test from 'node:test';

import assert from 'node:assert/strict';

import { createInspectionBudget, inspectionBudget } from '../src/inspection-budget.js';

const flush = () => new Promise(resolve => setImmediate(resolve));

test('inspection budgets are fixed and per-command cancellation waits for cleanup', async t => {
  assert.deepEqual(inspectionBudget, { commandTimeoutMs: 60000, overallTimeoutMs: 300000, terminationGraceMs: 5000 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve, signal, settled = false;
  const budget = createInspectionBudget((_, __, options) => {
    signal = options.signal;
    assert.equal(options.boundedInspection, true);
    return new Promise(done => { resolve = done; });
  });
  t.after(() => budget.dispose());
  const operation = budget.run('az', ['account', 'show'], {}).finally(() => { settled = true; });
  const rejected = assert.rejects(operation, { code: 'AZURE_INSPECTION_COMMAND_TIMEOUT' });
  await flush();
  t.mock.timers.tick(60000); await flush();
  assert.equal(signal.aborted, true);
  assert.equal(settled, false);
  resolve({ code: 0 });
  await rejected;
});

test('unconfirmed inspection termination fails closed after grace and preserves only owned PID', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const budget = createInspectionBudget((_, __, options) => {
    options.onInspectionProcess(12345);
    return new Promise(() => {});
  });
  t.after(() => budget.dispose());
  const rejected = assert.rejects(budget.run('az', [], {}), error => {
    assert.equal(error.code, 'AZURE_CLI_TERMINATION_UNCONFIRMED');
    assert.equal(error.ownedProcessPid, 12345);
    return true;
  });
  await flush(); t.mock.timers.tick(60000); await flush();
  t.mock.timers.tick(5000);
  await rejected;
});

test('overall inspection budget spans multiple successful logical reads and rejects late publication', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const budget = createInspectionBudget(async () => { calls++; return { code: 0 }; });
  t.after(() => budget.dispose());
  for (let i = 0; i < 6; i++) {
    await budget.run('az', ['rest'], {});
    t.mock.timers.tick(49000);
  }
  t.mock.timers.tick(6000);
  assert.throws(budget.check, { code: 'AZURE_INSPECTION_TIMEOUT' });
  await assert.rejects(budget.run('az', [], {}), { code: 'AZURE_INSPECTION_TIMEOUT' });
  assert.equal(calls, 6);
});

test('inspection cancellation composes during execution and pre-aborted callers never execute', async t => {
  const controller = new AbortController(); controller.abort();
  const pre = createInspectionBudget(() => assert.fail('No command before approval/cancellation'), controller.signal);
  t.after(() => pre.dispose());
  await assert.rejects(pre.run('az', [], {}), { code: 'AZURE_CLI_ABORTED' });
  const current = new AbortController();
  const budget = createInspectionBudget((_, __, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Error('PRIVATE')), { once: true });
    current.abort();
  }), current.signal);
  t.after(() => budget.dispose());
  await assert.rejects(budget.run('az', [], {}), { code: 'AZURE_CLI_ABORTED' });
});

test('inspection checks monotonic deadlines even when timer delivery is delayed', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const budget = createInspectionBudget(async () => { now = 60000; return { code: 0 }; });
  t.after(() => budget.dispose());
  await assert.rejects(budget.run('az', [], {}), { code: 'AZURE_INSPECTION_COMMAND_TIMEOUT' });
  now = 300000;
  assert.throws(budget.check, { code: 'AZURE_INSPECTION_TIMEOUT' });
});
