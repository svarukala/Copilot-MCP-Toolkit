import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const directory = process.argv[2];
process.env.PATH = directory;
let chunks = [], exitCode = 1, spawns = 0;
childProcess.spawn = (command, args, options) => {
  assert.equal(command, process.platform === 'win32' ? path.join(directory, 'az.exe') : 'az');
  assert.deepEqual(args, ['rest', '--method', 'GET']);
  assert.equal(options.shell, false);
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = () => assert.fail('Unexpected output limit');
  spawns++;
  queueMicrotask(() => {
    for (const chunk of chunks) child.stderr.emit('data', Buffer.from(chunk));
    child.emit('close', exitCode);
  });
  return child;
};
syncBuiltinESMExports();
const { runAzureCommand } = await import('../../src/azure.js');
const cases = [
  [['InvalidValue: Property api.preAuthorizedApplications.', 'delegatedPermissionIds has a Permission Id that cannot be found in the AppPermissions sets.'],
    'GRAPH_PREAUTH_SCOPE_UNRESOLVED'],
  [['Authorization_', 'RequestDenied: Insufficient privileges'], 'AZURE_PERMISSION_DENIED'],
  [['AADSTS500', '76: authenticating through MFA'], 'AZURE_CLI_MFA_REQUIRED'],
  [['DeploymentFailed: Activa', 'tionFailed: PRIVATE-DIAGNOSTIC-TOKEN'], 'AZURE_APIM_ACTIVATION_FAILED'],
  [['ERROR: (Resource', 'NotFound) PRIVATE-DIAGNOSTIC-TOKEN'], 'AZURE_RESOURCE_NOT_FOUND'],
  [['{"code":"SecretNotFound","message":"PRIVATE-DIAGNOSTIC-TOKEN"}'], 'AZURE_RESOURCE_NOT_FOUND'],
  [['Generic error mentions ResourceNotFound without a structured error code'], 'AZURE_CLI_EXIT'],
  [['InvalidValue: an unrelated rejected property'], 'AZURE_CLI_EXIT'],
];
for (const [input, expected] of cases) {
  chunks = [...input, 'PRIVATE-DIAGNOSTIC-TOKEN', 'x'.repeat(20000)];
  await assert.rejects(runAzureCommand('az', ['rest', '--method', 'GET']), error => {
    assert.equal(error.code, expected);
    assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE-DIAGNOSTIC-TOKEN|AppPermissions sets/);
    return true;
  });
}
exitCode = 0;
assert.equal((await runAzureCommand('az', ['rest', '--method', 'GET'])).code, 0);
assert.equal(spawns, cases.length + 1);
console.log('Bounded diagnostics retained; no process or cloud command executed.');
