import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const [root, runtime] = process.argv.slice(2);
const deny = () => assert.fail('Unexpected live network or subprocess');
globalThis.fetch = http.request = http.get = https.request = https.get = net.connect = net.createConnection = tls.connect = deny;
childProcess.exec = childProcess.execSync = childProcess.execFile = childProcess.execFileSync = childProcess.spawnSync = childProcess.fork = deny;
const code = 'ABCD12345', message = `To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ${code} to authenticate.\n`;
const cloudUri = 'https://login.microsoft.com/device';
const cloudWarning = "WARNING: Cloud Shell is automatically authenticated under the initial account signed-in with. Run 'az login' only if you need to use a different account\n";
let mode, project, account, stderr, calls, challengeBeforeClose;
childProcess.spawn = (command, args, options) => {
  assert.equal(command, process.platform === 'win32' ? path.join(root, 'az.exe') : 'az');
  assert.equal(options.shell, false); assert.equal(options.stdio[0], 'ignore');
  assert.ok(options.env.AZURE_CONFIG_DIR.startsWith(path.join(project, '.azure-auth') + path.sep));
  calls.push(args);
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  let closed = false;
  child.kill = () => { closed = true; queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; };
  queueMicrotask(() => {
    if (args[0] === 'login') {
      assert.ok(args.includes('--use-device-code')); assert.equal(args.includes('--only-show-errors'), false);
      assert.equal(options.env.AZURE_CORE_NO_COLOR, 'true');
      assert.equal(JSON.parse(readFileSync(path.join(project, '.azure-identity.json'))).status, 'pending');
      child.stderr.emit('data', Buffer.from('PRIVATE_DIAGNOSTIC\n{"accessToken":"PRIVATE_ACCESS","refreshToken":"PRIVATE_REFRESH"}\n'));
      const prompt = mode === 'success' ? message : message.replace('https://microsoft.com/devicelogin', cloudUri);
      const text = cloudWarning + (mode === 'invalid' ? prompt.replace('login.microsoft.com', 'login.microsoft.com.evil.invalid')
        : mode === 'missing' ? 'Unrecognized sign-in format\n' : prompt);
      for (let i = 0; i < text.length && !closed; i += 7) child.stderr.emit('data', Buffer.from(text.slice(i, i + 7)));
      child.stdout.emit('data', Buffer.from('PRIVATE_STDOUT_TOKEN'));
      if (closed) return;
      if (!['invalid', 'missing', 'display-failure'].includes(mode)) {
        assert.ok(stderr.join('').includes(`Code: ${code}`), 'Device code must reach CLI user before login finishes');
        assert.ok(stderr.join('').includes(`Azure device-code sign-in: ${mode === 'success' ? 'https://microsoft.com/devicelogin' : cloudUri}\n`),
          'The exact accepted URI must reach the user without rewriting');
        assert.ok(!stderr.join('').includes('Cloud Shell is automatically authenticated'), 'Raw Cloud Shell warning is not forwarded');
        challengeBeforeClose = true;
      }
      child.emit('close', mode === 'login-failure' ? 1 : 0);
    } else {
      assert.equal(args[0], 'account');
      if (args[1] === 'show') {
        const observed = structuredClone(account);
        if (mode === 'wrong-user') observed.user.name = 'wrong@example.com';
        if (mode === 'wrong-tenant') observed.tenantId = '00000000-0000-4000-8000-000000000000';
        if (mode === 'wrong-subscription') observed.id = '00000000-0000-4000-8000-000000000000';
        child.stdout.emit('data', Buffer.from(JSON.stringify(observed)));
      } else assert.equal(args[1], 'set');
      child.emit('close', 0);
    }
  });
  return child;
};
syncBuiltinESMExports();
process.env.PATH = root;
await writeFile(path.join(root, 'az.exe'), 'Inert mocked Azure resolver target.');
const { main } = await import(pathToFileURL(path.join(runtime, 'bin', 'copilot-mcp.js')));
async function invoke(args, expected = 0) {
  const stdout = []; stderr = [];
  const out = process.stdout.write, err = process.stderr.write;
  process.stdout.write = value => { stdout.push(String(value)); return true; };
  process.stderr.write = value => {
    if (mode === 'display-null' && String(value).startsWith('Azure device-code')) throw null;
    if (mode === 'display-failure' && String(value).startsWith('Azure device-code')) throw Error('PRIVATE_DISPLAY_FAILURE');
    stderr.push(String(value));
    if (mode === 'cancel' && String(value).startsWith('Azure device-code')) process.emit('SIGINT');
    return true;
  };
  try {
    const feedback = args[0] === 'mcp-account-switch' ? ['--progress'] : args[0] === 'mcp-account-plan' ? ['--summary'] : [];
    assert.equal(await main([...args, ...feedback, '--workspace-root', root, '--json']), expected, stdout.join('') + stderr.join(''));
    assert.doesNotMatch(stdout.join('') + stderr.join(''), /PRIVATE_|evil\.invalid/);
    assert.ok(!stdout.join('').includes(code), 'JSON output never contains the code');
    const result = JSON.parse(stdout.join(''));
    if (args[0] === 'mcp-account-plan') assert.ok(stderr.join('').includes(`TOP-LEVEL --approve ${result.approvalToken}`));
    if (args[0] === 'mcp-account-switch') {
      assert.match(stderr.join(''), /working: Checking local inputs/);
      assert.match(stderr.join(''), /CLI (finished|stopped)/);
      const progress = stderr.join('').split('\n').filter(line => line.startsWith('[progress')).join('\n');
      assert.doesNotMatch(progress, /ABCD12345|https:|PRIVATE/);
    }
    return result;
  } finally { process.stdout.write = out; process.stderr.write = err; }
}
const input = JSON.parse(await readFile(path.join(runtime, 'examples', 'mcp', 'upstream-key.json')));
const definition = path.join(root, 'definition.json');
await writeFile(definition, JSON.stringify(input));
account = { tenantId: input.azure.tenantId, id: input.azure.subscriptionId, user: { name: 'reviewer@example.com', type: 'user' } };
const targetArgs = ['--tenant-id', account.tenantId, '--subscription-id', account.id, '--account-name', account.user.name];
for (mode of ['success', 'cloud-success', 'invalid', 'missing', 'display-failure', 'display-null', 'login-failure', 'cancel', 'wrong-user', 'wrong-tenant', 'wrong-subscription']) {
  const succeeds = mode === 'success' || mode === 'cloud-success';
  calls = []; challengeBeforeClose = false;
  project = path.join(root, mode);
  const review = await invoke(['mcp-server-plan', '--config', definition]);
  await invoke(['mcp-server-plan', '--config', definition, '--use-device-code'], 1);
  await invoke(['mcp-server-create', '--config', definition, '--output', project, '--approve', review.reviewDigest]);
  const browser = await invoke(['mcp-account-plan', '--project', project, ...targetArgs]);
  const device = await invoke(['mcp-account-plan', '--project', project, ...targetArgs, '--use-device-code']);
  assert.equal(browser.loginMode, undefined); assert.equal(device.loginMode, 'device-code');
  assert.notEqual(browser.approvalToken, device.approvalToken); assert.equal(calls.length, 0);
  await invoke(['mcp-account-switch', '--project', project, ...targetArgs, '--use-device-code', '--approve', browser.approvalToken], 1);
  await invoke(['mcp-account-switch', '--project', project, ...targetArgs, '--approve', device.approvalToken], 1);
  assert.equal(calls.length, 0);
  const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  const result = await invoke(['mcp-account-switch', '--project', project, ...targetArgs, '--use-device-code', '--approve', device.approvalToken],
    succeeds ? 0 : 1);
  const state = await readFile(path.join(project, '.azure-identity.json'), 'utf8');
  assert.doesNotMatch(state, /ABCD12345|PRIVATE_|accessToken|refreshToken/);
  assert.equal(JSON.parse(state).status, succeeds ? 'selected' : 'pending');
  assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], listeners);
  assert.equal(calls.length, succeeds || mode.startsWith('wrong-') ? 3 : 1);
  if (succeeds) { assert.equal(challengeBeforeClose, true); assert.equal(result.status, 'account-selected-not-deployed'); }
}
console.log('Headless account CLI verified through mocked Azure subprocesses; no cloud calls or tokens disclosed.');
