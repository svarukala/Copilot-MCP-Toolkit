import test from 'node:test';

import assert from 'node:assert/strict';

import { azureDeviceCodeReader, validateAzureDeviceCode } from '../src/azure-device-code.js';

const message = 'To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD12345 to authenticate.';

test('Azure device-code reader exposes only exact bounded sign-in fields across chunks', () => {
  const delivered = [], reader = azureDeviceCodeReader(value => delivered.push(value));
  for (const character of `PRIVATE_DIAGNOSTIC\n${message}\r\n`) reader.push(Buffer.from(character));
  reader.push(Buffer.from(`${message}\n`)); reader.finish();
  assert.deepEqual(delivered, [{ verificationUri: 'https://microsoft.com/devicelogin', userCode: 'ABCD12345' }]);
});

test('Azure device-code reader rejects malicious prompts and never exposes diagnostics or tokens', () => {
  for (const text of [message.replace('microsoft.com', 'microsoft.com.evil.invalid'),
    message.replace('https:', 'http:'), message.replace('ABCD12345', 'ACCESS_TOKEN_PRIVATE'),
    message.replace('ABCD12345', '1234\u001b5678')]) {
    const reader = azureDeviceCodeReader(() => assert.fail('Invalid prompt disclosed'));
    assert.throws(() => reader.push(Buffer.from(`${text}\n`)), { code: 'AZURE_DEVICE_CODE_INVALID' });
  }
  for (const text of ['{"accessToken":"PRIVATE"}', 'PRIVATE'.repeat(1000), message.replace('To sign in', 'Unknown format')]) {
    const reader = azureDeviceCodeReader(() => assert.fail('No valid prompt'));
    reader.push(Buffer.from(text));
    assert.throws(reader.finish, { code: 'AZURE_DEVICE_CODE_NOT_DELIVERED' });
  }
  const reader = azureDeviceCodeReader(() => {});
  reader.push(Buffer.from(`${message}\n`));
  assert.throws(() => reader.push(Buffer.from(`${message.replace('ABCD12345', 'EFGH67890')}\n`)), { code: 'AZURE_DEVICE_CODE_INVALID' });
  assert.throws(() => validateAzureDeviceCode({ verificationUri: 'https://microsoft.com/devicelogin',
    userCode: 'ABCD12345', accessToken: 'PRIVATE' }), { code: 'AZURE_DEVICE_CODE_INVALID' });
});

test('Cloud Shell warning and exact Microsoft login URI deliver unchanged before completion', () => {
  const delivered = [], reader = azureDeviceCodeReader(value => delivered.push(value));
  const cloudMessage = message.replace('https://microsoft.com/devicelogin', 'https://login.microsoft.com/device');
  const warning = "WARNING: Cloud Shell is automatically authenticated under the initial account signed-in with. Run 'az login' only if you need to use a different account\n";
  for (const character of warning + cloudMessage + '\r\n') reader.push(Buffer.from(character));
  assert.deepEqual(delivered, [{ verificationUri: 'https://login.microsoft.com/device', userCode: 'ABCD12345' }]);
  reader.push(Buffer.from(`${cloudMessage}\n`)); reader.finish();
  assert.equal(delivered.length, 1);
  assert.throws(() => reader.push(Buffer.from(`${message}\n`)), { code: 'AZURE_DEVICE_CODE_INVALID' });
});

test('device-code URI allowlist rejects lookalikes, alternate paths and URL decorations', () => {
  for (const uri of ['http://login.microsoft.com/device', 'https://login.microsoft.com.evil.invalid/device',
    'https://login.microsoft.com@evil.invalid/device', 'https://login.microsoft.com/device/',
    'https://login.microsoft.com/device?code=PRIVATE', 'https://login.microsoft.com/device#fragment',
    'https://login.microsoft.com:443/device', 'https://login.microsoft.com/Device',
    'https://login.microsoft.com/%64evice', 'https://login.microsoftonline.com/common/oauth2/deviceauth']) {
    const value = { verificationUri: uri, userCode: 'ABCD12345' };
    assert.throws(() => validateAzureDeviceCode(value), { code: 'AZURE_DEVICE_CODE_INVALID' });
    const reader = azureDeviceCodeReader(() => assert.fail('Unapproved URL disclosed'));
    assert.throws(() => reader.push(Buffer.from(`${message.replace('https://microsoft.com/devicelogin', uri)}\n`)),
      { code: 'AZURE_DEVICE_CODE_INVALID' });
  }
});
