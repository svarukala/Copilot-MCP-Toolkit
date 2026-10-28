import test from 'node:test';
import assert from 'node:assert/strict';
import { dockerFailureDiagnostic, executionProgress, executionPushResult } from '../src/mcp-execution-docker.js';

const secret = 'synthetic-secret-never-retain';
const response = (...records) => ({ status: 200,
  body: Buffer.from(records.map(record => JSON.stringify(record)).join('\n')) });
function failure(input, parser = executionProgress) {
  let caught;
  assert.throws(() => parser(input), error => {
    caught = error;
    assert.doesNotMatch(JSON.stringify(error) + error.message, new RegExp(secret));
    return true;
  });
  return caught;
}

test('Docker diagnostics retain only category, build position and exit code from a failed npm step', () => {
  const error = failure(response(
    { stream: `Step 4/9 : RUN npm ci --registry=https://${secret}.example.com\n` },
    { stream: `npm error code SELF_SIGNED_CERT_IN_CHAIN\nnpm error ${secret}\n` },
    { errorDetail: { message: `The command '/bin/sh -c npm ci ${secret}' returned a non-zero code: 1`,
      token: secret, code: 1 }, error: secret },
  ));
  assert.equal(error.code, 'DOCKER_DISPATCH_FAILED');
  assert.deepEqual(error.dockerFailure, { schemaVersion: 1, category: 'certificate-validation',
    httpStatus: 200, recordIndex: 3, step: 4, totalSteps: 9, instruction: 'RUN', exitCode: 1 });
});

test('Docker diagnostics use closed reported-error categories without retaining messages', () => {
  for (const [message, category] of [
    ['x509: certificate signed by unknown authority', 'certificate-validation'],
    ['getaddrinfo ENOTFOUND', 'name-resolution'],
    ['write failed ENOSPC', 'resource-exhausted'],
    ['TLS handshake timeout', 'network-timeout'],
    ['toomanyrequests: limit exceeded', 'registry-rate-limit'],
    ['unauthorized: authentication required', 'registry-authorization'],
    ['manifest unknown', 'image-unavailable'],
    ['legacy builder is not supported', 'builder-unsupported'],
    ["The command '/bin/sh -c compile' returned a non-zero code: 2", 'build-command-failed'],
    ['unrecognized engine condition', 'unclassified'],
  ]) {
    const error = failure(response({ error: `${message}\n${secret}` }));
    assert.equal(error.dockerFailure.category, category);
    assert.equal(error.code, 'DOCKER_DISPATCH_FAILED');
  }
});

test('Docker diagnostics distinguish malformed, missing and HTTP failure streams without changing stop codes', () => {
  for (const [input, code, category] of [
    [{ status: 200, body: Buffer.from('') }, 'DOCKER_DISPATCH_UNKNOWN', 'missing-progress'],
    [{ status: 200, body: Buffer.from(secret) }, 'DOCKER_DISPATCH_UNKNOWN', 'invalid-progress'],
    [response([]), 'DOCKER_DISPATCH_FAILED', 'invalid-progress'],
    [{ status: 503, body: Buffer.from(secret) }, 'DOCKER_DISPATCH_UNKNOWN', 'http-error'],
    [{ status: 403, body: Buffer.from(JSON.stringify({ message: `unauthorized: authentication required ${secret}` })) },
      'DOCKER_DISPATCH_UNKNOWN', 'registry-authorization'],
  ]) {
    const error = failure(input);
    assert.equal(error.code, code);
    assert.equal(error.dockerFailure.category, category);
  }
});

test('Docker diagnostics bound text interpretation and reset npm hints at each build step', () => {
  const error = failure(response(
    { stream: 'Step 1/2 : RUN npm ci\n' },
    { stream: 'npm ERR! code E401\n' },
    { stream: 'Step 2/2 : COPY local-file /app\n' },
    { error: secret },
  ));
  assert.equal(error.dockerFailure.category, 'unclassified');
  assert.equal(error.dockerFailure.instruction, 'COPY');
  const large = failure(response({ error: `${'x'.repeat(16384)}ENOSPC ${secret}` }));
  assert.equal(large.dockerFailure.category, 'unclassified');
  assert.equal(failure(response({ error: "The command 'exit' returned a non-zero code: 999" })).dockerFailure.exitCode, undefined);
});

test('Docker diagnostic projection discards arbitrary fields and invalid numeric context', () => {
  assert.deepEqual(dockerFailureDiagnostic({ schemaVersion: 1, category: 'unclassified',
    message: secret, command: secret, token: secret, httpStatus: 999, recordIndex: Infinity,
    step: 2, totalSteps: 1, instruction: 'RUN', exitCode: -1 }),
  { schemaVersion: 1, category: 'unclassified' });
  assert.equal(dockerFailureDiagnostic({ schemaVersion: 1, category: secret }), undefined);
  assert.equal(dockerFailureDiagnostic({ category: 'unclassified' }), undefined);
  assert.equal(dockerFailureDiagnostic(null), undefined);
  assert.deepEqual(dockerFailureDiagnostic({ schemaVersion: 1, category: 'build-command-failed',
    httpStatus: 599, recordIndex: 1000000, step: 10000, totalSteps: 10000, instruction: 'RUN', exitCode: 255 }),
  { schemaVersion: 1, category: 'build-command-failed', httpStatus: 599,
    recordIndex: 1000000, step: 10000, totalSteps: 10000, instruction: 'RUN', exitCode: 255 });
});

test('Docker push diagnostics do not turn an earlier digest into success or expose credentials', () => {
  const tag = 'synthetic-tag', digest = `sha256:${'a'.repeat(64)}`;
  const error = failure(response({ aux: { Digest: digest } }, { error: `unauthorized: authentication required ${secret}` }),
    input => executionPushResult(input, tag));
  assert.equal(error.code, 'DOCKER_DISPATCH_FAILED');
  assert.equal(error.dockerFailure.category, 'registry-authorization');
  assert.equal(error.dockerFailure.recordIndex, 2);
  assert.equal(executionProgress(response({ aux: { ID: digest } })).ID, digest);
});
