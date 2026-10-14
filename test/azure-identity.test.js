import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TOOLKIT_ROOT } from '../src/config.js';
import { prepareMcpServer, createMcpServerProject, mcpRuntimeConfig } from '../src/mcp-server.js';
import { planAzureAccountSwitch, switchAzureAccount, readAzureIdentity, azureIdentityGuard } from '../src/azure-identity.js';
import { planMcpServerProvision, provisionMcpServer } from '../src/mcp-lifecycle.js';

async function fixture(t) {
  await mkdir(path.join(TOOLKIT_ROOT, '.test-output'), { recursive: true });
  const root = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples', 'mcp', 'catalog.json')));
  const dir = path.join(root, 'project');
  await createMcpServerProject(await prepareMcpServer(input), { workspaceRoot: root, projectDir: dir });
  const config = mcpRuntimeConfig(input);
  const target = { tenantId: input.azure.tenantId, subscriptionId: input.azure.subscriptionId, accountName: 'operator@example.com' };
  const account = { tenantId: target.tenantId, id: target.subscriptionId, user: { name: target.accountName, type: 'user' } };
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    assert.ok(options.azureConfigDir.startsWith(path.join(dir, '.azure-auth') + path.sep));
    assert.equal(args.includes('logout'), false);
    return account;
  };
  const login = async () => {
    const plan = await planAzureAccountSwitch(dir, target);
    return switchAzureAccount(dir, target, { approval: plan.approvalToken, run });
  };
  return { dir, config, target, account, run, calls, login };
}

test('missing account, cancellation and wrong login identity never select ambient credentials', async t => {
  const f = await fixture(t);
  assert.equal(await readAzureIdentity(f.config, f.dir), null);
  await assert.rejects(planAzureAccountSwitch(f.dir, {}), /Explicit tenant/);
  const before = await readdir(f.dir);
  assert.equal((await switchAzureAccount(f.dir, f.target, { approve: () => false, run: f.run })).status, 'declined');
  assert.deepEqual(await readdir(f.dir), before);
  assert.equal(f.calls.length, 0);
  const plan = await planAzureAccountSwitch(f.dir, f.target);
  await assert.rejects(switchAzureAccount(f.dir, f.target, { approval: plan.approvalToken, signal: AbortSignal.abort(), run: f.run }), /cancelled/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(switchAzureAccount(f.dir, f.target, { approval: plan.approvalToken,
    run: async (cmd, args, opts) => ({ ...await f.run(cmd, args, opts), tenantId: '99999999-9999-4999-8999-999999999999' }) }), /mismatch/);
  assert.equal(await readAzureIdentity(f.config, f.dir), null);
});

test('each current identity guard rejects wrong tenant subscription account and session rewrites', async t => {
  const f = await fixture(t);
  await f.login();
  const binding = await readAzureIdentity(f.config, f.dir, { required: true });
  for (const patch of [
    { tenantId: '99999999-9999-4999-8999-999999999999' },
    { id: '99999999-9999-4999-8999-999999999999' },
    { user: { name: 'other@example.com', type: 'user' } },
    { user: { name: f.target.accountName, type: 'servicePrincipal' } },
  ]) {
    await assert.rejects(azureIdentityGuard(f.config, f.dir, binding,
      async () => ({ ...f.account, ...patch })), /mismatch/);
  }
  await writeFile(path.join(f.dir, '.azure-auth', binding.epoch, 'azureProfile.json'), '{}');
  let calls = 0;
  await assert.rejects(azureIdentityGuard(f.config, f.dir, binding, () => { calls++; }), /changed/);
  assert.equal(calls, 0);
});

test('a separately approved relogin invalidates provisioning approval before any cloud read or mutation', async t => {
  const f = await fixture(t);
  await f.login();
  const plan = await planMcpServerProvision(f.dir, { phase: 'finalize' });
  await f.login();
  let calls = 0;
  await assert.rejects(provisionMcpServer(f.dir, { phase: 'finalize', approval: plan.approvalToken,
    run: () => { calls++; } }), /Exact current/);
  assert.equal(calls, 0);
  assert.notEqual((await planMcpServerProvision(f.dir, { phase: 'finalize' })).approvalToken, plan.approvalToken);
});
