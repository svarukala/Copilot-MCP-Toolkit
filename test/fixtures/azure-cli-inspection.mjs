import assert from 'node:assert/strict';
import { mock } from 'node:test';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';

process.env.PATH = process.argv[2];
const children = [];
childProcess.spawn = (command, args, options) => {
  assert.equal(options.shell, false);
  const child = new EventEmitter();
  child.pid = 12000 + children.length;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kills = [];
  child.kill = signal => { child.kills.push(signal ?? 'SIGTERM'); return true; };
  children.push(child);
  return child;
};
syncBuiltinESMExports();
const { runAzureCommand } = await import('../../src/azure.js');
const { createInspectionBudget } = await import('../../src/inspection-budget.js');
const flush = () => new Promise(resolve => setImmediate(resolve));
const realTimeout = globalThis.setTimeout;
async function spawned(index) {
  for (let i = 0; i < 100 && !children[index]; i++) await new Promise(resolve => realTimeout(resolve, 5));
  assert.ok(children[index], 'Expected mocked process');
  return children[index];
}
const rest = ['rest', '--method', 'GET', '--url', 'https://management.azure.com/subscriptions/test'];
for (const args of [['account', 'show'], rest]) {
  mock.timers.enable({ apis: ['setTimeout'] });
  const budget = createInspectionBudget(runAzureCommand), index = children.length;
  let settled = false;
  const rejected = assert.rejects(budget.run('az', args, {}).finally(() => { settled = true; }),
    { code: 'AZURE_INSPECTION_COMMAND_TIMEOUT' });
  const child = await spawned(index);
  mock.timers.tick(60000); await flush();
  assert.equal(settled, false); assert.deepEqual(child.kills, ['SIGTERM']);
  mock.timers.tick(2500); assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
  child.emit('close', null);
  await rejected;
  assert.equal(children.length, index + 1);
  budget.dispose(); mock.timers.reset();
}

mock.timers.enable({ apis: ['setTimeout'] });
const retryBudget = createInspectionBudget(runAzureCommand), retryStart = children.length;
const retryRejected = assert.rejects(retryBudget.run('az', rest, {}), { code: 'AZURE_INSPECTION_COMMAND_TIMEOUT' });
const first = await spawned(retryStart);
mock.timers.tick(30000);
first.stderr.emit('data', Buffer.from('ConnectionResetError(10054, PRIVATE)'));
first.emit('close', 1);
await flush(); mock.timers.tick(150);
const second = await spawned(retryStart + 1);
mock.timers.tick(29850);
assert.deepEqual(second.kills, ['SIGTERM']);
second.emit('close', null);
await retryRejected;
assert.equal(children.length, retryStart + 2, 'No retry after read deadline');
retryBudget.dispose(); mock.timers.reset();

mock.timers.enable({ apis: ['setTimeout'] });
const heldBudget = createInspectionBudget(runAzureCommand), heldIndex = children.length;
const unconfirmed = assert.rejects(heldBudget.run('az', rest, {}), error => {
  assert.equal(error.code, 'AZURE_CLI_TERMINATION_UNCONFIRMED');
  assert.equal(error.ownedProcessPid, children[heldIndex].pid);
  return true;
});
const held = await spawned(heldIndex);
mock.timers.tick(60000); mock.timers.tick(5000);
await unconfirmed;
held.emit('close', null);
heldBudget.dispose(); mock.timers.reset();

for (const args of [['login'], ['rest', '--method', 'PUT', '--url', 'https://management.azure.com/fixture']]) {
  mock.timers.enable({ apis: ['setTimeout'] });
  const index = children.length, operation = runAzureCommand('az', args);
  const child = await spawned(index);
  mock.timers.tick(600000);
  assert.deepEqual(child.kills, [], 'No new login/mutation timeout');
  child.stdout.emit('data', Buffer.from('{}')); child.emit('close', 0);
  await operation;
  mock.timers.reset();
}
console.log('Inspection deadlines verified with mocked owned processes; no Azure or network execution.');
