import test from 'node:test';
import assert from 'node:assert/strict';
import { assessResultAssertion, checkedResultAssertion } from '../src/mcp-result-assertion.js';
const profile = { kind: 'json-array-string-field-v1', field: 'fact', maxItems: 2, maxStringLength: 12 };
const reply = text => ({ content: [{ type: 'text', text }] });
test('first-call predicate accepts exact bounds, rejects malformed/error/ambiguous payloads and retains no text', () => {
  assert.equal(assessResultAssertion(reply('[{"fact":"123456789012"},{"fact":"fine"}]'), profile).status, 'passed');
  for (const value of ['not JSON', '[]', '[{"fact":""}]', '[{"fact":"  "}]', '[{"fact":"1234567890123"}]',
    '[{"fact":"a"},{"fact":"b"},{"fact":"c"}]', '{"fact":"a"}', '[{"fact":"a","error":"bad"}]', '[{"fact":1}]']) {
    const result = assessResultAssertion(reply(value), profile);
    assert.equal(result.status, 'failed', value);
    assert.equal(result.rawResultRetained, false);
    assert.equal(result.text, undefined);
  }
  assert.equal(assessResultAssertion({ ...reply('[{"fact":"a"}]'), isError: true }, profile).status, 'failed');
  assert.equal(assessResultAssertion({ ...reply('[{"fact":"a"}]'), structuredContent: { fact: 'a' } }, profile).status, 'failed');
  for (const patch of [{ maxItems: 0 }, { maxItems: 101 }, { maxStringLength: 4097 }, { field: '__proto__' }, { field: 'api_key' },
    { kind: 'script' }, { evaluator: 'arbitrary code' }]) assert.throws(() => checkedResultAssertion({ ...profile, ...patch }));
});
