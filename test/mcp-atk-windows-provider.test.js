import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { TOOLKIT_ROOT } from '../src/config.js';
import { windowsAtkProfile, windowsAtkEnvironment, runWindowsAtkProcess, terminateWindowsAtkTree,
  windowsAtkProvider } from '../src/mcp-atk-windows-provider.js';

const profile = { home: 'C:\\Users\\synthetic', userName: 'synthetic', appData: 'C:\\Users\\synthetic\\AppData\\Roaming',
  localAppData: 'C:\\Users\\synthetic\\AppData\\Local', systemRoot: 'C:\\Windows' };
const installation = { node: 'C:\\Program Files\\nodejs\\node.exe', entry: "C:\\provider owner's\\cli.js", profile };
function childProcess() {
  const child = new EventEmitter(); child.pid = 919191;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}
async function fixture(t) {
  const parent = path.join(TOOLKIT_ROOT, '.test-output'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'windows-atk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('Windows normal-profile environment is explicit, excludes arbitrary overrides and never redirects credentials to scratch', () => {
  const env = { USERPROFILE: profile.home, APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData,
    SystemRoot: profile.systemRoot, NODE_OPTIONS: '--require malicious', M365_ACCOUNT_NAME: 'wrong', MCP_AUTH_CLIENT_SECRET: 'synthetic' };
  const user = { homedir: profile.home, username: profile.userName };
  assert.deepEqual(windowsAtkProfile(env, user), profile);
  assert.throws(() => windowsAtkProfile({ ...env, USERPROFILE: 'C:\\redirected' }, user), { code: 'ATK_PROFILE' });
  const selected = windowsAtkEnvironment(installation, 'C:\\private\\job');
  assert.equal(selected.HOME, profile.home);
  assert.equal(selected.USERPROFILE, profile.home);
  assert.equal(selected.APPDATA, profile.appData);
  assert.equal(selected.LOCALAPPDATA, profile.localAppData);
  assert.equal(selected.NODE_OPTIONS, undefined);
  assert.equal(selected.M365_ACCOUNT_NAME, undefined);
  assert.equal(selected.MCP_AUTH_CLIENT_SECRET, undefined);
  assert.equal(selected.BROWSER, undefined);
  assert.ok(selected.PATH.startsWith('C:\\Program Files\\nodejs;'));
  assert.equal(selected.TEMP, path.join('C:\\private\\job', 'tmp'));
});
test('Windows runner uses the direct Node entry without cmd quoting, detachment, raw stderr or post-exit killing', async () => {
  const child = childProcess(); let spawned, kills = 0;
  const operation = runWindowsAtkProcess(installation, ['provision', '--folder', "C:\\private owner's\\job"],
    { runtime: 'C:\\private' }, {
      spawnProcess: (...args) => { spawned = args; return child; },
      terminate: () => { kills++; return true; },
    });
  child.stdout.write('bounded output'); child.stderr.write('synthetic-sensitive-provider-error'); child.emit('close', 0);
  assert.equal(await operation, 'bounded output');
  assert.equal(spawned[0], installation.node);
  assert.deepEqual(spawned[1], [installation.entry, 'provision', '--folder', "C:\\private owner's\\job", '--telemetry', 'false']);
  assert.equal(spawned[2].shell, false); assert.equal(spawned[2].detached, false);
  assert.equal(spawned[2].env.HOME, profile.home);
  assert.equal(kills, 0);
});
test('Windows runner requires a real login terminal and rejects secrets or cancelled work before spawning', async () => {
  let calls = 0;
  const dependencies = { spawnProcess: () => { calls++; }, terminal: () => false };
  await assert.rejects(runWindowsAtkProcess(installation, [], { runtime: 'C:\\private', interactive: true }, dependencies), { code: 'ATK_TERMINAL' });
  await assert.rejects(runWindowsAtkProcess(installation, [], { runtime: 'C:\\private', secret: 'synthetic' }, dependencies), { code: 'ATK_INPUT' });
  await assert.rejects(runWindowsAtkProcess(installation, [], { runtime: 'C:\\private', signal: AbortSignal.abort() }, dependencies), { code: 'ATK_ABORTED' });
  assert.equal(calls, 0);
});
test('Windows cancellation waits for both owned-tree termination and CLI close, without POSIX signals', async () => {
  const child = childProcess(), controller = new AbortController();
  let killed, confirm;
  const operation = runWindowsAtkProcess(installation, [], { runtime: 'C:\\private', signal: controller.signal }, {
    spawnProcess: () => child, terminate: pid => {
      killed = pid; return new Promise(resolve => { confirm = resolve; });
    },
  });
  let settled = false; operation.then(() => { settled = true; }, () => { settled = true; });
  controller.abort(); await new Promise(resolve => setImmediate(resolve));
  child.emit('close', 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(killed, child.pid);
  confirm(true);
  await assert.rejects(operation, { code: 'ATK_ABORTED' });
});
test('Windows timeout, output limits and unconfirmed termination never return a success-shaped result', async () => {
  for (const kind of ['timeout', 'oversize', 'kill-failed']) {
    const child = childProcess();
    const operation = runWindowsAtkProcess(installation, [], { runtime: 'C:\\private' }, {
      spawnProcess: () => child, timeoutMs: 5, graceMs: 20,
      terminate: async pid => {
        assert.equal(pid, child.pid);
        if (kind === 'kill-failed') return false;
        if (kind === 'oversize') { child.emit('close', 1); return true; }
        return true;
      },
    });
    if (kind === 'oversize') child.stderr.write('x'.repeat(1048577));
    await assert.rejects(operation, { code: kind === 'oversize' ? 'ATK_OUTPUT_LIMIT' : 'ATK_TERMINATION_UNCONFIRMED' });
    child.emit('close', 1);
  }
});
test('a cancellation race never terminates a PID whose CLI close was already observed', async () => {
  const child = childProcess(), controller = new AbortController();
  let kills = 0;
  const operation = runWindowsAtkProcess(installation, [], { runtime: 'C:\\private', signal: controller.signal }, {
    spawnProcess: () => child, terminate: () => { kills++; return true; },
  });
  controller.abort(); child.emit('close', 1);
  await assert.rejects(operation, { code: 'ATK_TERMINATION_UNCONFIRMED' });
  assert.equal(kills, 0);
});
test('Windows tree termination invokes only the reviewed system utility with one explicit PID', async () => {
  const child = childProcess(); let spawned;
  const termination = terminateWindowsAtkTree(child.pid, profile.systemRoot, {
    spawnProcess: (...args) => { spawned = args; queueMicrotask(() => child.emit('close', 0)); return child; },
  });
  assert.equal(await termination, true);
  assert.equal(spawned[0], 'C:\\Windows\\System32\\taskkill.exe');
  assert.deepEqual(spawned[1], ['/PID', String(child.pid), '/T', '/F']);
  assert.equal(spawned[2].shell, false);
  await assert.rejects(terminateWindowsAtkTree(-1, profile.systemRoot), { code: 'ATK_TERMINATION_UNCONFIRMED' });
});
test('per-user toolkit lease blocks concurrent Windows phases and preserves foreign ownership', async t => {
  const root = await fixture(t), selectedProfile = { ...profile, localAppData: root };
  const provider = { ...windowsAtkProvider, currentProfile: () => selectedProfile };
  const owner = { epoch: randomUUID(), project: root, workspaceRoot: root };
  const selected = { ...installation, profile: selectedProfile };
  const release = await provider.acquireProfileLease(selected, owner);
  await assert.rejects(provider.acquireProfileLease(selected, owner), { code: 'EEXIST' });
  await release();
  const second = await provider.acquireProfileLease(selected, owner);
  const lock = path.join(root, 'CopilotMcpToolkit', 'atk-windows-operation.lock');
  await writeFile(lock, '{"differentOwner":true}');
  await assert.rejects(second(), { code: 'ATK_PROFILE' });
  assert.equal(await readFile(lock, 'utf8'), '{"differentOwner":true}');
});
test('Windows account checks use public output and only selected-tenant metadata in the normal profile', async t => {
  const root = await fixture(t), selectedProfile = { ...profile, home: root };
  const cache = path.join(root, '.fx', 'account'); await mkdir(cache, { recursive: true });
  const tenant = '11111111-1111-4111-8111-111111111111', operator = { tenantId: tenant, accountName: 'operator@example.com' };
  const provider = { ...windowsAtkProvider, currentProfile: () => selectedProfile, validate: async () => {},
    run: async (p, args) => {
      assert.deepEqual(args, ['auth', 'list', 'm365', '--interactive', 'false']);
      return 'Your Microsoft 365 account is: operator@example.com(Synthetic tenant).';
    } };
  const selected = { ...installation, profile: selectedProfile };
  await writeFile(path.join(cache, 'tenantId.cache.appStudio'), tenant);
  assert.equal((await provider.account(selected, root, {}, operator, {})).tenantId, tenant);
  await writeFile(path.join(cache, 'tenantId.cache.appStudio'), 'wrong-tenant');
  await assert.rejects(provider.account(selected, root, {}, operator, {}), { code: 'ATK_IDENTITY' });
  assert.deepEqual(await readdir(cache), ['tenantId.cache.appStudio']);
});
test('Windows runtime cleanup is bounded to its owned job, never normal-profile caches', async t => {
  const root = await fixture(t), owner = { epoch: randomUUID(), project: root, workspaceRoot: root };
  if (process.platform !== 'win32') {
    await assert.rejects(windowsAtkProvider.open(owner), { code: 'ATK_PLATFORM' }); return;
  }
  const untouched = path.join(root, 'unrelated-cache.json'); await writeFile(untouched, '{"keep":true}');
  const runtime = await windowsAtkProvider.open(owner);
  await windowsAtkProvider.validate(runtime, owner);
  await assert.rejects(windowsAtkProvider.close(runtime, { ...owner, epoch: randomUUID() }), { code: 'ATK_RUNTIME' });
  await windowsAtkProvider.close(runtime, owner);
  assert.equal(await readFile(untouched, 'utf8'), '{"keep":true}');
  assert.deepEqual(await readdir(root), ['unrelated-cache.json']);
});

test('native Windows runner executes and terminates only a synthetic Node child without provider or network access', async t => {
  if (process.platform !== 'win32') return;
  const root = await fixture(t), runtime = path.join(root, "owner's runtime");
  await mkdir(path.join(runtime, 'job'), { recursive: true });
  await mkdir(path.join(runtime, 'tmp'));
  const entry = path.join(runtime, "synthetic entry's.js");
  const provider = { ...installation, node: process.execPath, entry,
    profile: { ...profile, systemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT } };
  await writeFile(entry, "console.log(JSON.stringify({home:process.env.HOME,override:process.env.NODE_OPTIONS??null}));");
  assert.deepEqual(JSON.parse(await runWindowsAtkProcess(provider, [], { runtime })),
    { home: profile.home, override: null });
  await writeFile(entry, 'setTimeout(()=>{},5000);');
  await assert.rejects(runWindowsAtkProcess(provider, [], { runtime }, { timeoutMs: 200 }),
    { code: 'ATK_TIMEOUT' });
});
