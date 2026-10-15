import test from 'node:test';

import assert from 'node:assert/strict';

import { withCliFeedback, configureCliFeedback, cliStage, cliInspectionStep, cliPlanSummary } from '../src/cli-feedback.js';

test('CLI progress is opt-in, throttled, scoped and cleaned up after failure', async t => {
  const output = [];
  t.mock.method(process.stderr, 'write', value => { output.push(value); return true; });
  t.mock.timers.enable({ apis: ['setInterval'] });
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  await withCliFeedback(async () => {
    configureCliFeedback('mcp-reconcile', {});
    cliStage('azure-read', 60000);
    return 0;
  });
  assert.deepEqual(output, []);
  await assert.rejects(withCliFeedback(async () => {
    configureCliFeedback('mcp-reconcile', { progress: true });
    cliStage('azure-inspection', 300000); cliInspectionStep('check-api-collisions'); cliStage('azure-read', 60000);
    for (let i = 0; i < 100; i++) cliStage('azure-read', 60000);
    assert.equal(output.length, 3);
    cliStage('PRIVATE_ACCESS_TOKEN', 5000);
    clock = 10000; t.mock.timers.tick(10000);
    assert.match(output.at(-1), /progress 10s; inspection remaining 290s; stage remaining 50s/);
    assert.match(output.at(-1), /API ownership and mapping/);
    throw Error('PRIVATE_FAILURE');
  }), /PRIVATE_FAILURE/);
  const count = output.length;
  clock = 100000; t.mock.timers.tick(90000);
  assert.equal(output.length, count);
  assert.doesNotMatch(output.join(''), /PRIVATE/);
  assert.match(output.at(-1), /CLI failed/);
  await withCliFeedback(async () => {
    configureCliFeedback('mcp-discover', {});
    cliStage('mcp-list'); return 0;
  });
  assert.equal(output.length, count);
});

test('CLI summary selects only the exact top-level approval and screens untrusted text', async t => {
  const output = [];
  t.mock.method(process.stderr, 'write', value => { output.push(value); return true; });
  const token = `sha256:${'a'.repeat(64)}`, inner = `sha256:${'b'.repeat(64)}`;
  const plan = { action: 'standalone-mcp-project-qualification', approvalDigest: token, projectDir: '/safe/project',
    readiness: { experimental: { configuration: { expiresAt: '2026-10-14T16:15:00.000Z' } } },
    operation: { approvalDigest: inner, source: { endpoint: 'https://safe.example.com/mcp', inbound: { type: 'entra' } },
      tool: { name: 'bad\u001b[31mtool' }, arguments: { secret: 'PRIVATE_ARGUMENT' },
      capture: { capturedAt: '2026-10-14T15:00:00.000Z', tools: 'PRIVATE_TOOLS' } } };
  const before = JSON.stringify(plan);
  await withCliFeedback(async () => {
    configureCliFeedback('mcp-qualification-plan', { summary: true });
    cliPlanSummary(plan); return 0;
  });
  assert.equal(JSON.stringify(plan), before);
  assert.match(output.join(''), new RegExp(`TOP-LEVEL --approve ${token}`));
  assert.doesNotMatch(output.join(''), /PRIVATE|bbbbbbbb|\u001b/);
  assert.match(output.join(''), /normally costs 1 credit/);
  assert.match(output.join(''), /2026-10-15T15:00:00.000Z/);
  assert.match(output.join(''), /Configuration expires: 2026-10-14T16:15/);
  await withCliFeedback(async () => {
    configureCliFeedback('mcp-reconcile-plan', { summary: true });
    cliPlanSummary({ action: 'mcp-reconcile', approvalToken: null, inspection: { approvalToken: inner } });
    return 0;
  });
  assert.match(output.at(-1), /No usable top-level approval/);
  assert.doesNotMatch(output.at(-1), /bbbbbbbb/);
  await withCliFeedback(async () => {
    configureCliFeedback('mcp-auth-execution-plan', { summary: true });
    cliPlanSummary({ action: 'mcp-auth-execution', phase: 'login', project: 'synthetic-session', status: 'planned',
      effects: ['ATK startup requests https://default.exp-tas.com/vscode/ab; --telemetry false does not disable it.'],
      approvalToken: token });
    return 0;
  });
  assert.match(output.at(-1), /https:\/\/default\.exp-tas\.com\/vscode\/ab/);
  assert.match(output.at(-1), /--telemetry false does not disable/);
  assert.ok(output.at(-1).includes(`EXACT approvalToken: ${token}`));
  for (const unsafe of ['api_key=SUPER_PRIVATE_VALUE', 'Bearer abcdefghijklmnop', 'unsafe\u009b31m', 'fake\u2028line']) {
    await withCliFeedback(async () => {
      configureCliFeedback('mcp-account-plan', { summary: true });
      cliPlanSummary({ action: 'azure-account-switch', approvalToken: `azure-login/${'c'.repeat(64)}`,
        target: { tenantId: unsafe, subscriptionId: unsafe, accountName: unsafe } });
      return 0;
    });
    assert.ok(!output.at(-1).includes(unsafe));
  }
});

test('feedback flags reject unrelated commands and finished contexts ignore late progress', async t => {
  const output = [];
  t.mock.method(process.stderr, 'write', value => { output.push(value); return true; });
  let late, releaseLate;
  await withCliFeedback(async () => {
    assert.throws(() => configureCliFeedback('create', { progress: true }), /--progress/);
    assert.throws(() => configureCliFeedback('mcp-proof', { summary: true }), /--summary/);
    configureCliFeedback('mcp-proof', { progress: true });
    late = new Promise(resolve => { releaseLate = resolve; }).then(() => cliStage('mcp-call'));
    return 2;
  });

  const count = output.length;
  releaseLate();
  await late;
  assert.equal(output.length, count, JSON.stringify(output));
  assert.match(output.at(-1), /CLI stopped/);
});

test('feedback display failure cannot interrupt journal/process work and returns a nonzero CLI status', async t => {
  let continued = false;
  const output = [];
  t.mock.method(process.stderr, 'write', value => {
    if (value.startsWith('[progress')) throw Error('PRIVATE_TERMINAL_FAILURE');
    output.push(value); return true;
  });
  assert.equal(await withCliFeedback(async () => {
    configureCliFeedback('mcp-proof', { progress: true });
    cliStage('dispatch-prepared'); cliStage('mcp-call');
    continued = true;
    return 0;
  }), 1);
  assert.equal(continued, true);
  assert.match(output.join(''), /feedback could not be displayed/);
  assert.doesNotMatch(output.join(''), /PRIVATE/);
});
