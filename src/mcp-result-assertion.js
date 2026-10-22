import { boundedSnapshot, metadataDigest, requireMetadata } from './anonymous-metadata.js';
import { secretIssues } from './validation.js';

export function checkedResultAssertion(value) {
  const assertion = boundedSnapshot(value);
  requireMetadata(assertion && Object.keys(assertion).sort().join(',') === 'field,kind,maxItems,maxStringLength'
    && assertion.kind === 'json-array-string-field-v1'
    && typeof assertion.field === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(assertion.field)
    && !['constructor', 'prototype', 'password', 'api_key', 'access_token', 'secret'].includes(assertion.field)
    && Number.isInteger(assertion.maxItems) && assertion.maxItems >= 1 && assertion.maxItems <= 100
    && Number.isInteger(assertion.maxStringLength) && assertion.maxStringLength >= 1 && assertion.maxStringLength <= 4096,
  'PROOF_SCHEMA_UNSUPPORTED');
  return assertion;
}
export function assessResultAssertion(reply, input) {
  const assertion = checkedResultAssertion(input);
  const verdict = passed => ({ kind: assertion.kind, status: passed ? 'passed' : 'failed',
    assertionDigest: metadataDigest(assertion), rawResultRetained: false });
  if (reply.isError === true || reply.structuredContent !== undefined || reply.content?.length !== 1
    || reply.content[0]?.type !== 'text' || typeof reply.content[0].text !== 'string'
    || Buffer.byteLength(reply.content[0].text) > 1048576 || secretIssues(reply.content[0].text)) return verdict(false);
  let value;
  try { value = JSON.parse(reply.content[0].text); }
  catch (error) { if (error instanceof SyntaxError) return verdict(false); throw error; }
  return verdict(Array.isArray(value) && value.length > 0 && value.length <= assertion.maxItems
    && value.every(item => item && typeof item === 'object' && !Array.isArray(item)
      && Object.keys(item).length === 1 && Object.hasOwn(item, assertion.field)
      && typeof item[assertion.field] === 'string' && item[assertion.field].trim().length > 0
      && item[assertion.field].length <= assertion.maxStringLength));
}
