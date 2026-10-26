import test from 'node:test';
import assert from 'node:assert/strict';
import { executionProgress, executionPushResult } from '../src/mcp-execution-docker.js';

const tag = 'copilot-0123456789abcdef0123456789abcdef';
const digest = `sha256:${'a'.repeat(64)}`;
const other = `sha256:${'b'.repeat(64)}`;
const summary = (hash = digest, selected = tag) => ({ status: `${selected}: digest: ${hash} size: 1234` });
const response = (...messages) => ({ status: 200, body: Buffer.from(messages.map(value => JSON.stringify(value)).join('\n') + '\n') });

test('push accepts both classic auxiliary and containerd status-only completion', () => {
  assert.deepEqual(executionPushResult(response({ aux: { Tag: tag, Digest: digest, Size: 1234 } }), tag),
    { digest, completion: 'aux' });
  const containerd = response({ status: 'Pushed', id: 'synthetic-layer' }, summary());
  assert.equal(executionProgress(containerd), undefined, 'The old auxiliary-only parser loses containerd completion.');
  assert.deepEqual(executionPushResult(containerd, tag), { digest, completion: 'status' });
  assert.deepEqual(executionPushResult(response(summary(), { aux: { Digest: digest } }), tag),
    { digest, completion: 'aux-and-status' });
});

test('push requires exact, consistent completion for the selected tag', () => {
  for (const messages of [
    [{ status: 'Pushed', id: digest }],
    [{ aux: { ID: digest } }],
    [{ aux: { Digest: 'not-a-digest' } }],
    [{ aux: { Tag: 'different', Digest: digest } }],
    [summary(digest, 'different')],
    [summary(), { aux: { Digest: other } }],
    [{ aux: { Digest: digest } }, summary(other)],
    [summary(), summary(other)],
    [{ status: `${tag}: digest: ${digest} size: 0` }],
    [{ status: `${tag}: digest: ${digest} size: 9007199254740992` }],
    [{ status: `${tag}: digest: ${digest} size: 1234 trailing` }],
    [{ aux: { ManifestPushedInsteadOfIndex: true, Digest: digest } }],
    [{ aux: { ContentMissing: true, Digest: digest } }],
    [summary(), { aux: null }],
  ]) assert.throws(() => executionPushResult(response(...messages), tag), { code: 'DOCKER_PUSH_RESULT_INVALID' });
  assert.throws(() => executionPushResult(response(summary()), ''), { code: 'DOCKER_PUSH_RESULT_INVALID' });
});

test('push never accepts a digest before a later error or malformed stream', () => {
  for (const error of [{ error: 'synthetic-token-do-not-retain' }, { errorDetail: { message: 'synthetic-token-do-not-retain' } }]) {
    assert.throws(() => executionPushResult(response(summary(), error), tag), value =>
      value.code === 'DOCKER_DISPATCH_FAILED' && !value.message.includes('synthetic-token'));
  }
  assert.throws(() => executionPushResult({ status: 500, body: Buffer.from('synthetic-token') }, tag),
    { code: 'DOCKER_DISPATCH_UNKNOWN' });
  assert.throws(() => executionPushResult({ status: 200, body: Buffer.from('') }, tag),
    { code: 'DOCKER_DISPATCH_UNKNOWN' });
  assert.throws(() => executionPushResult({ status: 200, body: Buffer.concat([response(summary()).body, Buffer.from('not-json')]) }, tag),
    { code: 'DOCKER_DISPATCH_UNKNOWN' });
  assert.throws(() => executionPushResult(response(summary(), []), tag), { code: 'DOCKER_DISPATCH_FAILED' });
});
