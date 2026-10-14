import test from 'node:test';

import assert from 'node:assert/strict';

import { assessTavilyResult, validQualificationAssertion, tavilyFirstCallProfile, firstCallProfileBinding } from '../src/mcp-tavily-qualification.js';

const query = 'Microsoft Learn Azure API Management MCP';

const response = () => ({ query, images: [], results: [{ title: 'PRIVATE_TITLE', content: 'PRIVATE_SNIPPET',
  url: 'https://learn.microsoft.com/en-us/azure/api-management/mcp' }] });

test('first-call profile binds evaluator boundaries without a mutable custom evaluator', () => {
  const profile = tavilyFirstCallProfile(), binding = firstCallProfileBinding(), value = response();
  const prefix = 'https://learn.microsoft.com/';
  value.results[0] = { title: 'x'.repeat(profile.maximumTitleLength), content: 'x'.repeat(profile.maximumContentLength),
    url: prefix + 'x'.repeat(profile.maximumUrlLength - prefix.length) };
  assert.equal(assessTavilyResult({ content: [], structuredContent: value }, query).status, 'passed');
  value.results[0].url += 'x';
  assert.equal(assessTavilyResult({ content: [], structuredContent: value }, query).predicate, 'domain');
  profile.maximumTitleLength = 1; profile.predicates.push('custom');
  assert.deepEqual(firstCallProfileBinding(), binding);
  assert.equal(tavilyFirstCallProfile().maximumTitleLength, 2048);
  assert.equal(binding.kind, 'tavily-search-result-v1');
  assert.match(binding.profileDigest, /^sha256:[a-f0-9]{64}$/);
});

test('closed Tavily evaluator accepts only bounded JSON representations without retaining result values', () => {
  for (const reply of [
    { content: [], structuredContent: response() },
    { content: [{ type: 'text', text: JSON.stringify(response()) }] },
    { content: [{ type: 'text', text: JSON.stringify(response()) }], structuredContent: response() },
  ]) {
    const result = assessTavilyResult(reply, query);
    assert.deepEqual(result, { kind: 'tavily-search-result-v1', status: 'passed', predicate: 'all', resultCount: 1 });
    assert.equal(validQualificationAssertion(result), true);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|https|Learn/);
  }
});

test('closed Tavily evaluator distinguishes failed predicates from unsupported representations', () => {
  for (const [mutate, predicate] of [
    [value => { value.results = []; }, 'results-count'],
    [value => { value.results.push(value.results[0]); }, 'results-count'],
    [value => { value.results[0].title = ' '; }, 'title'],
    [value => { value.results[0].title = 'x'.repeat(2049); }, 'title'],
    [value => { value.results[0].content = ''; }, 'content'],
    [value => { value.results[0].content = 'x'.repeat(65537); }, 'content'],
    [value => { value.results[0].raw_content = 'PRIVATE'; }, 'unexpected-content'],
    [value => { value.results[0].favicon = 'https://private.invalid'; }, 'unexpected-content'],
    [value => { value.images = ['PRIVATE']; }, 'unexpected-content'],
    [value => { value.query = 'Different'; }, 'query-echo'],
  ]) {
    const value = response(); mutate(value);
    const result = assessTavilyResult({ content: [], structuredContent: value }, query);
    assert.equal(result.status, 'failed'); assert.equal(result.predicate, predicate);
    assert.equal(validQualificationAssertion(result), true);
  }
  for (const url of ['http://learn.microsoft.com/x', 'https://learn.microsoft.com.evil.invalid/x',
    'https://evil.invalid/learn.microsoft.com', 'https://user@learn.microsoft.com/x', 'https://learn.microsoft.com:8443/x',
    'https://learn.microsoft.com./x', 'not a URL', ' https://learn.microsoft.com/x']) {
    const value = response(); value.results[0].url = url;
    assert.equal(assessTavilyResult({ content: [], structuredContent: value }, query).predicate, 'domain');
  }
  for (const reply of [{ content: [{ type: 'text', text: 'Detailed Results:\nURL: https://learn.microsoft.com\nContent: text' }] },
    { content: [], structuredContent: { result: response() } }, { content: [] },
    { content: [{ type: 'text', text: '[]' }] }, { content: [{ type: 'text', text: '{}' }, { type: 'text', text: '{}' }] }]) {
    assert.equal(assessTavilyResult(reply, query).status, 'inconclusive');
  }
  assert.equal(assessTavilyResult({ content: [], structuredContent: response(), isError: true }, query).predicate, 'tool-error');
  assert.equal(assessTavilyResult({ content: [{ type: 'text', text: '{}' }], structuredContent: response() }, query).predicate, 'representation-conflict');
  for (const value of [{ kind: 'new', status: 'passed', predicate: 'all', resultCount: 1 },
    { kind: 'tavily-search-result-v1', status: 'passed', predicate: 'all', resultCount: 2 },
    { kind: 'tavily-search-result-v1', status: 'passed', predicate: 'all', resultCount: 1, extra: true }]) {
    assert.equal(validQualificationAssertion(value), false);
  }
});
