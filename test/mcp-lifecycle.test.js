import test from 'node:test';

import assert from 'node:assert/strict';

import path from 'node:path';

import { randomUUID } from 'node:crypto';

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';

import { spawnSync } from 'node:child_process';

import { TOOLKIT_ROOT } from '../src/config.js';

import { prepareMcpServer, createMcpServerProject } from '../src/mcp-server.js';

import { readMcpServerProject, planMcpServerProvision, provisionMcpServer, planMcpServerAccount, switchMcpServerAccount, planMcpServerCapture } from '../src/mcp-lifecycle.js';

import { selectMockAzureIdentity, mockAzureUser } from './support/azure-identity.js';

async function fixture(t, direct = false) {
  await mkdir(path.join(TOOLKIT_ROOT, '.test-output'), { recursive: true });
  const workspaceRoot = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'mcp-lifecycle-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  let input = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples', 'mcp', 'catalog.json'), 'utf8'));
  if (direct) input = { schemaVersion: 1, kind: 'existing-mcp', server: input.server,
    endpoint: 'https://example.com/mcp', inbound: { type: 'anonymous' } };
  const projectDir = path.join(workspaceRoot, 'server');
  const review = await prepareMcpServer(input);
  await createMcpServerProject(review, { workspaceRoot, projectDir });
  const target = direct ? null : { tenantId: input.azure.tenantId, subscriptionId: input.azure.subscriptionId, accountName: mockAzureUser.name };
  const account = direct ? null : { id: target.subscriptionId, tenantId: target.tenantId, user: mockAzureUser };
  const scopeId = randomUUID();
  const application = direct ? null : { appId: input.inbound.clientId, identifierUris: [input.inbound.applicationIdUri],
    api: { oauth2PermissionScopes: [{ id: scopeId, value: input.inbound.scope, isEnabled: true }],
      preAuthorizedApplications: input.inbound.allowedClientIds.map(appId => ({ appId, delegatedPermissionIds: [scopeId] })) } };
  const run = async (_, args) => {
    if (args[0] === 'account' || args[0] === 'login') return account;
    assert.equal(args[0], 'rest');
    assert.ok(args.includes('GET'));
    return application;
  };
  return { workspaceRoot, projectDir, input, review, target, account, application, run };
}

test('standalone account login is separately approved, private and exact; local plans never use ambient account', async t => {
  const f = await fixture(t);
  assert.equal((await planMcpServerProvision(f.projectDir, { phase: 'finalize' })).approvalToken, null);
  await assert.rejects(provisionMcpServer(f.projectDir, { phase: 'finalize', approval: f.review.reviewDigest }), /Exact current/);
  await assert.rejects(planMcpServerAccount(f.projectDir, { ...f.target, tenantId: randomUUID() }), /must match/);
  const plan = await planMcpServerAccount(f.projectDir, f.target);
  let calls = 0;
  await assert.rejects(switchMcpServerAccount(f.projectDir, f.target, { approval: 'wrong', run: () => calls++ }), /approval/);
  assert.equal(calls, 0);
  const result = await switchMcpServerAccount(f.projectDir, f.target, { approval: plan.approvalToken, run: f.run });
  assert.equal(result.status, 'account-selected-not-deployed');
  assert.ok((await planMcpServerProvision(f.projectDir, { phase: 'finalize' })).approvalToken);
  assert.ok(!(await readdir(f.projectDir)).includes('toolkit.json'));
});

test('relogin invalidates standalone approval and each completed attempt consumes its reviewed history', async t => {
  const f = await fixture(t);
  await selectMockAzureIdentity(f.projectDir, f.input.azure);
  const first = await planMcpServerProvision(f.projectDir, { phase: 'finalize' });
  await selectMockAzureIdentity(f.projectDir, f.input.azure);
  let calls = 0;
  await assert.rejects(provisionMcpServer(f.projectDir, { phase: 'finalize', approval: first.approvalToken, run: () => calls++ }), /Exact current/);
  assert.equal(calls, 0);
  const next = await planMcpServerProvision(f.projectDir, { phase: 'finalize' });
  const result = await provisionMcpServer(f.projectDir, { phase: 'finalize', approval: next.approvalToken, run: f.run });
  assert.equal(result.lifecycleStatus, 'completed');
  await assert.rejects(provisionMcpServer(f.projectDir, { phase: 'finalize', approval: next.approvalToken, run: () => calls++ }), /Exact current/);
  assert.equal(calls, 0);
  assert.equal((await planMcpServerCapture(f.projectDir)).gatewayLifecycle, 'not-verified');
});

test('standalone artifact and definition drift fail closed before execution, without regenerating reviewed files', async t => {
  for (const name of ['infra/gateway.json', 'mcp-server.json', 'mcp-definition.json']) {
    const f = await fixture(t);
    await selectMockAzureIdentity(f.projectDir, f.input.azure);
    const plan = await planMcpServerProvision(f.projectDir, { phase: 'finalize' });
    await writeFile(path.join(f.projectDir, ...name.split('/')), '{}');
    let calls = 0;
    await assert.rejects(provisionMcpServer(f.projectDir, { phase: 'finalize', approval: plan.approvalToken, run: () => calls++ }));
    assert.equal(calls, 0);
    assert.equal(await readFile(path.join(f.projectDir, ...name.split('/')), 'utf8'), '{}');
  }
});

test('mid-run source drift stops further commands and failed or interrupted history blocks replay', async t => {
  const f = await fixture(t);
  await selectMockAzureIdentity(f.projectDir, f.input.azure);
  const plan = await planMcpServerProvision(f.projectDir, { phase: 'finalize' });
  const calls = [];
  const result = await provisionMcpServer(f.projectDir, { phase: 'finalize', approval: plan.approvalToken,
    run: async (_, args) => {
      calls.push(args);
      if (args[0] === 'account') {
        await writeFile(path.join(f.projectDir, 'infra', 'gateway.json'), '{}');
        return f.account;
      }
      assert.fail('Drift must block application read');
    } });
  assert.equal(result.lifecycleStatus, 'failed-uncertain');
  assert.ok(calls.every(args => args[0] === 'account'));
  await writeFile(path.join(f.projectDir, 'infra', 'gateway.json'), f.review.files['infra/gateway.json']);
  await assert.rejects(planMcpServerProvision(f.projectDir, { phase: 'finalize' }), /uncertain outcome/);
  assert.equal((await planMcpServerCapture(f.projectDir)).gatewayLifecycle, 'not-verified');
});

test('wrong authenticated tenant and unverified client declarations cannot pass standalone preflight', async t => {
  for (const mismatch of ['account', 'preauthorization']) {
    const f = await fixture(t);
    await selectMockAzureIdentity(f.projectDir, f.input.azure);
    const plan = await planMcpServerProvision(f.projectDir, { phase: 'finalize' });
    const result = await provisionMcpServer(f.projectDir, { phase: 'finalize', approval: plan.approvalToken,
      run: async (_, args) => args[0] === 'account'
        ? { ...f.account, ...(mismatch === 'account' ? { tenantId: randomUUID() } : {}) }
        : { ...f.application, api: { ...f.application.api, preAuthorizedApplications: [] } } });
    assert.equal(result.lifecycleStatus, 'failed-uncertain');
    if (mismatch === 'preauthorization') {
      assert.equal(result.errorCode, 'ENTRA_INBOUND_PREREQUISITES');
      assert.match(result.error, /Ask its owner/);
    }
    await assert.rejects(planMcpServerProvision(f.projectDir, { phase: 'finalize' }), /uncertain outcome/);
  }
});

test('direct references have capture preparation without Azure lifecycle or plugin scaffolding', async t => {
  const f = await fixture(t, true);
  assert.equal((await readMcpServerProject(f.projectDir)).review.descriptor.status, 'referenced-not-verified');
  await assert.rejects(planMcpServerProvision(f.projectDir), /require no Azure/);
  await assert.rejects(planMcpServerAccount(f.projectDir, {}), /require no Azure/);
  const capture = await planMcpServerCapture(f.projectDir);
  assert.equal(capture.gatewayLifecycle, 'not-required');
  assert.equal(capture.metadataCaptured, false);
  const cli = spawnSync(process.execPath, [path.join(TOOLKIT_ROOT, 'bin', 'copilot-mcp.js'),
    'mcp-capture-plan', '--project', f.projectDir, '--json'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).metadataCaptured, false);
});

test('standalone CLI exposes exact prerequisites and rejects noninteractive provisioning without account selection', async t => {
  const f = await fixture(t);
  const cli = args => spawnSync(process.execPath, [path.join(TOOLKIT_ROOT, 'bin', 'copilot-mcp.js'), ...args, '--json'],
    { encoding: 'utf8' });
  const plan = cli(['mcp-provision-plan', '--project', f.projectDir, '--phase', 'foundation']);
  assert.equal(plan.status, 0, plan.stderr);
  const reviewed = JSON.parse(plan.stdout);
  assert.equal(reviewed.approvalToken, null);
  assert.deepEqual(reviewed.prerequisites.existingResourceApplication, f.input.inbound);
  const accountPlan = cli(['mcp-account-plan', '--project', f.projectDir,
    '--tenant-id', f.target.tenantId, '--subscription-id', f.target.subscriptionId, '--account-name', f.target.accountName]);
  assert.equal(accountPlan.status, 0, accountPlan.stderr);
  assert.match(JSON.parse(accountPlan.stdout).approvalToken, /^azure-login\//);
  const denied = cli(['mcp-provision', '--project', f.projectDir, '--approve', f.review.reviewDigest]);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stdout + denied.stderr, /Exact current standalone provisioning approval/);
  assert.ok(!(await readdir(f.projectDir)).includes('.azure-auth'));
  assert.ok(!(await readdir(f.projectDir)).includes('.mcp-lifecycle'));
});
