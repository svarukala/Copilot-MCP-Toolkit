import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const directory = process.argv[2];
process.env.PATH = directory;
let responses = [], calls = [], expectedArgs, expectedContext;
childProcess.spawn = (command, args, options) => {
  assert.equal(command, process.platform === 'win32' ? path.join(directory, 'az.exe') : 'az');
  assert.deepEqual(args, expectedArgs);
  assert.equal(options.shell, false);
  assert.equal(options.env.AZURE_CONFIG_DIR, expectedContext);
  assert.equal(options.env.AZURE_CLI_DISABLE_CONNECTION_VERIFICATION, process.env.AZURE_CLI_DISABLE_CONNECTION_VERIFICATION);
  assert.equal(options.env.HTTPS_PROXY, process.env.HTTPS_PROXY);
  calls.push(args);
  const response = responses[calls.length - 1];
  assert.ok(response, 'No unexpected extra process attempt');
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true; };
  queueMicrotask(async () => {
    await response.before?.();
    if (response.hold) return;
    if (response.startError) { child.emit('error', new Error('PRIVATE-DIAGNOSTIC')); return; }
    if (response.stdout) child.stdout.emit('data', Buffer.from(response.stdout));
    for (const chunk of response.chunks ?? []) child.stderr.emit('data', Buffer.from(chunk));
    child.emit('close', Object.hasOwn(response, 'exit') ? response.exit : 1, response.signal);
    response.after?.();
  });
  return child;
};
syncBuiltinESMExports();
const { runAzureCommand, sanitizeProvisioningErrorCode } = await import('../../src/azure.js');
const { readAzureIdentity, azureIdentityGuard } = await import('../../src/azure-identity.js');
const { controlFailure } = await import('../../src/mcp-control.js');
const eof = ['HTTPSConnectionPool: Max retries exceeded: SSLEOF', "Error(8, '[SSL: UNEXPECTED_EOF_WHILE_READING] PRIVATE-DIAGNOSTIC')"];
const reset = ["ConnectionResetError(100", "54, 'PRIVATE-DIAGNOSTIC')"];
const connectionAborted = ["('Connection aborted.', ConnectionAbort", 'edError(100', "53, 'PRIVATE-DIAGNOSTIC'))"];
const remoteDisconnected = ["('Connection aborted.', RemoteDiscon", "nected('Remote end closed connection ", "without response'))"];
const success = { stdout: '{"value":[]}', exit: 0 };
const rest = ['rest', '--method', 'GET', '--url', 'https://management.azure.com/subscriptions/fixture/policies?api-version=2024-05-01',
  '--headers', 'Accept=application/json', '--subscription', 'fixture', '--query', '{value:value}', '--only-show-errors', '--output', 'json'];
async function scenario(args, sequence, code, options = {}) {
  expectedArgs = [...args]; expectedContext = options.azureConfigDir; responses = sequence; calls = [];
  const operation = runAzureCommand('az', args, options);
  if (code) await assert.rejects(operation, error => {
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE-DIAGNOSTIC|HTTPSConnectionPool|management\.azure\.com/);
    assert.equal(sanitizeProvisioningErrorCode(error.code), error.code);
    if (['AZURE_CLI_TRANSIENT_TRANSPORT', 'AZURE_CLI_CERTIFICATE_FAILED', 'AZURE_CLI_AUTHENTICATION_FAILED', 'AZURE_CLI_ABORTED', 'AZURE_APIM_ACTIVATION_FAILED'].includes(code)) {
      const failure = controlFailure(error, 'inspect');
      assert.equal(failure.code, code);
      assert.doesNotMatch(JSON.stringify(failure), /PRIVATE-DIAGNOSTIC|management\.azure\.com/);
    }
    return true;
  });
  else assert.deepEqual(await operation, { stdout: '{"value":[]}', code: 0 });
  assert.equal(calls.length, sequence.length);
}

await scenario(rest, [{ chunks: eof, stdout: 'discard partial output' }, success]);
await scenario(['account', 'show', '--query', '{tenantId:tenantId,id:id,user:user}', '--output', 'json', '--only-show-errors'],
  [{ chunks: reset }, success]);
await scenario(['apim', 'show', '--subscription', 'fixture', '--resource-group', 'fixture', '--name', 'fixture', '--output', 'json'],
  [{ chunks: eof }, { chunks: reset }, success]);
await scenario(['rest', '--method', 'GET', '--url', 'https://graph.microsoft.com/v1.0/applications'],
  [{ chunks: reset }, success]);
await scenario(rest, [{ chunks: eof }, { chunks: reset }, { chunks: [...eof, 'x'.repeat(20000)] }],
  'AZURE_CLI_TRANSIENT_TRANSPORT');
await scenario(rest, [{ chunks: connectionAborted }, success]);
await scenario(rest, [{ chunks: connectionAborted }, { chunks: connectionAborted },
  { chunks: [...connectionAborted, 'x'.repeat(20000)] }], 'AZURE_CLI_TRANSIENT_TRANSPORT');
await scenario(rest, [{ chunks: remoteDisconnected }, success]);
await scenario(rest, [{ chunks: ['RemoteDisconnected("Remote end closed connection without response")'] }, success]);
await scenario(rest, [{ chunks: remoteDisconnected }, { chunks: remoteDisconnected },
  { chunks: [...remoteDisconnected, 'x'.repeat(20000)] }], 'AZURE_CLI_TRANSIENT_TRANSPORT');

const nonInspections = [
  ...['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'get'].map(method => ['rest', '--method', method, '--url', rest[4]]),
  ['rest', '--url', rest[4]],
  ['rest', '--method=GET', '--url', rest[4]],
  ['rest', '-m', 'GET', '--url', rest[4]],
  [...rest, '--method', 'GET'],
  [...rest, '--method', 'PUT'],
  [...rest, '-m', 'POST'],
  [...rest, '--method=DELETE'],
  [...rest, '--url', rest[4]],
  [...rest, '--body', '{}'],
  [...rest, '--headers', 'X-HTTP-Method-Override=DELETE'],
  ['rest', '--method', 'GET', '--url', rest[4], '--headers', 'X-HTTP-Method-Override=POST'],
  [...rest, '--debug'],
  [...rest, '--only-show-errors'],
  [...rest, '--query'],
  [...rest, '--url-parameters', 'method=PUT'],
  ['rest', '--method', 'GET', '--url', 'https://business.coworktoolkit.dev/action'],
  ['rest', '--method', 'GET', '--url', 'http://management.azure.com/'],
  ['rest', '--method', 'GET', '--url', 'https://management.azure.com:8443/'],
  ['rest', '--method', 'GET', '--url', 'https://user@management.azure.com/'],
  ['rest', '--method', 'GET', '--url', 'https://management.azure.com\\@business.coworktoolkit.dev/action'],
  ['rest', '--method', 'GET', '--url', 'https://%6danagement.azure.com/action'],
  ['rest', '--method', 'GET', '--url', '@request.json'],
  ['account', 'set', '--subscription', 'fixture'],
  ['account', 'show', '--subscription', '--only-show-errors'],
  ['account', 'show', 'login'],
  ['apim', 'show', '--name', 'fixture'],
  ['apim', 'create', '--name', 'fixture'],
  ['deployment', 'group', 'validate', '--template-file', 'fixture.json'],
  ['deployment', 'group', 'create', '--template-file', 'fixture.json'],
  ['login', '--tenant', 'fixture'],
  ['group', 'exists', '--name', 'fixture'],
  ['resource', 'list'],
];
for (const args of nonInspections) for (const chunks of [eof, connectionAborted, remoteDisconnected]) {
  await scenario(args, [{ chunks }], 'AZURE_CLI_TRANSIENT_TRANSPORT');
}

const fatal = [
  ['CERTIFICATE_VERIFY_FAILED', 'AZURE_CLI_CERTIFICATE_FAILED'],
  ['SSLCertVerificationError: certificate verify failed', 'AZURE_CLI_CERTIFICATE_FAILED'],
  ['Authorization_RequestDenied: Insufficient privileges', 'AZURE_PERMISSION_DENIED'],
  ['AADSTS50076: MFA required', 'AZURE_CLI_MFA_REQUIRED'],
  ['InvalidAuthenticationToken', 'AZURE_CLI_AUTHENTICATION_FAILED'],
  ['ActivationFailed: PRIVATE-DIAGNOSTIC', 'AZURE_APIM_ACTIVATION_FAILED'],
  ['HTTP/1.1 401', 'AZURE_CLI_AUTHENTICATION_FAILED'],
  ['Please run az login to setup account.', 'AZURE_CLI_AUTHENTICATION_FAILED'],
  ['AADSTS500760: unrecognized', 'AZURE_CLI_EXIT'],
  ['ValidationFailed: validation is not transport', 'AZURE_CLI_EXIT'],
  ['HttpResponseError: HTTP response is not a reset', 'AZURE_CLI_EXIT'],
  ['{"code":"UnrecognizedResponse"}', 'AZURE_CLI_EXIT'],
];
for (const [diagnostic, code] of fatal) {
  await scenario(rest, [{ chunks: [...eof, diagnostic.slice(0, 5), diagnostic.slice(5), 'x'.repeat(20000)] }], code);
  await scenario(rest, [{ chunks: [diagnostic, 'x'.repeat(20000), ...reset] }], code);
  await scenario(rest, [{ chunks: [...connectionAborted, diagnostic.slice(0, 5), diagnostic.slice(5), 'x'.repeat(20000)] }], code);
  await scenario(rest, [{ chunks: [diagnostic, 'x'.repeat(20000), ...connectionAborted] }], code);
  await scenario(rest, [{ chunks: [...remoteDisconnected, diagnostic.slice(0, 5), diagnostic.slice(5), 'x'.repeat(20000)] }], code);
  await scenario(rest, [{ chunks: [diagnostic, 'x'.repeat(20000), ...remoteDisconnected] }], code);
}
for (const diagnostic of ['unrecognized PRIVATE-DIAGNOSTIC', 'Max retries exceeded', 'SSLError: unknown TLS failure',
  'ConnectionResetError(999, PRIVATE-DIAGNOSTIC)', 'Connection aborted.', 'Operation cancelled.',
  'KeyboardInterrupt', 'ConnectionAbortedError: user cancelled', 'ConnectionAbortedError',
  'OSError(10053, PRIVATE-DIAGNOSTIC)', 'NotConnectionAbortedError(10053, PRIVATE-DIAGNOSTIC)',
  'ConnectionAbortedError(10054, PRIVATE-DIAGNOSTIC)', 'ConnectionAbortedError(100530, PRIVATE-DIAGNOSTIC)',
  'ConnectionAbortedError(10053.5, PRIVATE-DIAGNOSTIC)']) await scenario(rest, [{ chunks: [diagnostic] }], 'AZURE_CLI_EXIT');
for (const diagnostic of [
  'Remote end closed connection without response',
  'RemoteDisconnected',
  "RemoteDisconnected('different message')",
  "RemoteDisconnected('Remote end closed connection without response: timeout')",
  "RemoteDisconnected('remote end closed connection without response')",
  "RemoteDisconnected('Remote end closed connection without response', 123)",
  "RemoteDisconnected(\"Remote end closed connection without response')",
  "NotRemoteDisconnected('Remote end closed connection without response')",
  "ConnectionError('Remote end closed connection without response')",
]) await scenario(rest, [{ chunks: [diagnostic] }], 'AZURE_CLI_EXIT');
await scenario(rest, [{ startError: true }], 'AZURE_CLI_START_FAILED');
await scenario(rest, [{ chunks: eof, exit: null, signal: 'SIGTERM' }], 'AZURE_CLI_ABORTED');
await scenario(rest, [{ chunks: eof, exit: 130 }], 'AZURE_CLI_ABORTED');
await scenario(rest, [{ chunks: connectionAborted, exit: null, signal: 'SIGTERM' }], 'AZURE_CLI_ABORTED');
await scenario(rest, [{ chunks: connectionAborted, exit: 130 }], 'AZURE_CLI_ABORTED');
await scenario(rest, [{ chunks: connectionAborted, exit: 3221225786 }], 'AZURE_CLI_ABORTED');
await scenario(rest, [{ chunks: remoteDisconnected, exit: null, signal: 'SIGTERM' }], 'AZURE_CLI_ABORTED');
await scenario(rest, [{ chunks: remoteDisconnected, exit: 130 }], 'AZURE_CLI_ABORTED');
await scenario(rest, [{ chunks: eof }, { chunks: ['Unauthorized'] }], 'AZURE_CLI_AUTHENTICATION_FAILED');

const preAborted = new AbortController(); preAborted.abort('PRIVATE-DIAGNOSTIC');
await scenario(rest, [], 'AZURE_CLI_ABORTED', { signal: preAborted.signal });
const waiting = new AbortController();
await scenario(rest, [{ chunks: eof, after: () => setTimeout(() => waiting.abort('PRIVATE-DIAGNOSTIC'), 10) }],
  'AZURE_CLI_ABORTED', { signal: waiting.signal });
const waitingAfter10053 = new AbortController();
await scenario(rest, [{ chunks: connectionAborted, after: () => setTimeout(() => waitingAfter10053.abort('PRIVATE-DIAGNOSTIC'), 10) }],
  'AZURE_CLI_ABORTED', { signal: waitingAfter10053.signal });
const waitingAfterDisconnect = new AbortController();
await scenario(rest, [{ chunks: remoteDisconnected, after: () => setTimeout(() => waitingAfterDisconnect.abort('PRIVATE-DIAGNOSTIC'), 10) }],
  'AZURE_CLI_ABORTED', { signal: waitingAfterDisconnect.signal });
const running = new AbortController();
await scenario(rest, [{ hold: true, before: () => running.abort('PRIVATE-DIAGNOSTIC') }],
  'AZURE_CLI_ABORTED', { signal: running.signal });

const mutable = [...rest];
await scenario(mutable, [{ chunks: eof, after: () => { mutable[2] = 'PUT'; } }, success]);

const config = { azure: { tenantId: '11111111-1111-4111-8111-111111111111',
  subscriptionId: '33333333-3333-4333-8333-333333333333' }, connectors: [] };
const binding = await readAzureIdentity(config, directory, { required: true });
const azureConfigDir = path.join(directory, '.azure-auth', binding.epoch);
await scenario(rest, [{ chunks: eof, before: () => writeFile(path.join(azureConfigDir, 'azureProfile.json'), '{"changed":true}') },
  success], undefined, { cwd: directory, azureConfigDir });
const count = calls.length;
await assert.rejects(azureIdentityGuard(config, directory, binding, runAzureCommand), { code: 'AZURE_IDENTITY_REQUIRED' });
assert.equal(calls.length, count, 'Profile drift blocks the next guarded command before any spawn/mutation');
console.log('Transport recovery verified at mocked spawn boundary; no Azure command or network executed.');
