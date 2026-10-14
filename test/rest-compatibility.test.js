import test from 'node:test';

import assert from 'node:assert/strict';

import { readFile } from 'node:fs/promises';

import path from 'node:path';

import { compareRestCapture, restCaptureCompatibilityVersion, prepareRestToolDocument } from 'copilot-mcp-toolkit';

import { TOOLKIT_ROOT } from '../src/config.js';

async function fixture() {
  const definition = JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples', 'rest-tools-legislation.json')));
  const { operations } = prepareRestToolDocument(definition);
  const metadata = { tools: operations.map(op => ({ name: op.toolName, inputSchema: {
    type: 'object', properties: Object.fromEntries(op.parameters.map(p => [p.name, structuredClone(p.schema)])),
    required: op.parameters.filter(p => p.required).map(p => p.name), additionalProperties: false,
  } })) };
  return { operations, metadata };
}

test('three-tool mapped contract accepts declared scalar arguments, defaults and reordered annotations without mutation', async () => {
  assert.equal(restCaptureCompatibilityVersion, 2);
  const { operations, metadata } = await fixture();
  metadata.tools.reverse();
  metadata.tools[2].description = 'Different server wording';
  metadata.tools[2].inputSchema.properties.query.description = 'Different argument wording';
  metadata.tools[2].inputSchema.title = 'Server label';
  metadata.tools[2].inputSchema.$schema = 'http://json-schema.org/draft-07/schema#';
  const before = JSON.stringify({ operations, metadata });
  const report = compareRestCapture(operations, metadata);
  assert.equal(report.compatible, true);
  assert.deepEqual(report.issues, []);
  assert.ok(report.checks.every(c => c.status === 'compatible'));
  assert.equal(JSON.stringify({ operations, metadata }), before);
  assert.equal(report.evidence, 'local-contract-comparison');
  assert.deepEqual(report.acceptedLosses, []);
});

test('same names do not conceal missing, renamed, additional or incompatible arguments', async () => {
  const cases = [
    [m => { delete m.tools[0].inputSchema.properties.query; }, 'missing-argument'],
    [m => { m.tools[1].inputSchema.properties.id = m.tools[1].inputSchema.properties.bill_id; delete m.tools[1].inputSchema.properties.bill_id; }, 'unexpected-argument'],
    [m => { m.tools[0].inputSchema.properties.key = { type: 'string' }; }, 'unexpected-argument'],
    [m => { m.tools[0].inputSchema.properties.year.type = 'number'; }, 'type-mismatch'],
    [m => { m.tools[1].inputSchema.properties.bill_id.type = 'string'; }, 'type-mismatch'],
    [m => { m.tools[0].inputSchema.required = []; }, 'required-mismatch'],
    [m => { m.tools[0].inputSchema.required.push('page'); }, 'required-mismatch'],
    [m => { delete m.tools[0].inputSchema.properties.state.default; }, 'default-mismatch'],
    [m => { m.tools[0].inputSchema.properties.state.default = 'PRIVATE_NEW_DEFAULT'; }, 'default-mismatch'],
    [m => { m.tools[0].inputSchema.properties.page.minimum = 0; }, 'constraint-mismatch'],
    [m => { m.tools[0].inputSchema.properties.query.pattern = 'secret-pattern'; }, 'constraint-mismatch'],
    [m => { m.tools.pop(); }, 'missing-tool'],
    [m => { m.tools.push({ name: 'extra', inputSchema: { type: 'object' } }); }, 'unexpected-tool'],
  ];
  for (const [mutate, code] of cases) {
    const { operations, metadata } = await fixture();
    for (const operation of operations) operation.backendMapping = null;
    mutate(metadata);
    const result = compareRestCapture(operations, metadata);
    assert.equal(result.status, 'blocked', code);
    assert.ok(result.issues.some(i => i.code === code), JSON.stringify(result.issues));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_NEW_DEFAULT|secret-pattern/);
  }
});

test('mapped native APIM projection lists policy-enforced omissions while strict and conflicting captures block', async () => {
  const { operations, metadata } = await fixture();
  const state = operations[0].parameters.find(parameter => parameter.name === 'state');
  state.schema.enum = ['ALL', 'CA'];
  const page = operations[0].parameters.find(parameter => parameter.name === 'page');
  page.schema.minimum = 1;
  page.schema.maximum = 50;
  const year = operations[0].parameters.find(parameter => parameter.name === 'year');
  year.schema.oneOf = [{ const: 1, title: 'Odd years' }, { enum: [2], description: 'Even years' }];
  for (const argument of ['state', 'year', 'page']) {
    const schema = metadata.tools[0].inputSchema.properties[argument];
    delete schema.default;
    delete schema.enum;
    delete schema.minimum;
    delete schema.maximum;
  }
  const projected = compareRestCapture(operations, metadata);
  assert.equal(projected.compatible, true);
  assert.equal(projected.status, 'compatible-with-reviewed-loss');
  assert.ok(projected.checks.some(check => check.status === 'compatible-with-reviewed-loss'));
  assert.ok(projected.acceptedLosses.some(loss =>
    loss.argument === 'state' && loss.facet === 'default' && loss.enforcement === 'generated-apim-policy'));
  assert.ok(projected.acceptedLosses.some(loss =>
    loss.argument === 'year' && loss.facet === 'constraint' && loss.keyword === 'enum'));
  assert.ok(projected.acceptedLosses.some(loss =>
    loss.argument === 'page' && loss.facet === 'constraint' && loss.keyword === 'minimum'));
  assert.doesNotMatch(JSON.stringify(projected), /Odd years|Even years|ALL|CA/);

  delete operations[0].backendMapping.parameterNames;
  assert.equal(compareRestCapture(operations, metadata).status, 'compatible-with-reviewed-loss');
  operations[0].backendMapping = null;
  const strict = compareRestCapture(operations, metadata);
  assert.equal(strict.compatible, false);
  assert.deepEqual(strict.acceptedLosses, []);
  assert.ok(strict.issues.some(issue => issue.code === 'default-mismatch'));
  assert.ok(strict.issues.some(issue => issue.code === 'constraint-mismatch'));

  operations[0].backendMapping = { path: '/', query: { op: 'getSearch' }, parameterNames: {} };
  metadata.tools[0].inputSchema.properties.page.minimum = 0;
  const conflicting = compareRestCapture(operations, metadata);
  assert.equal(conflicting.compatible, false);
  assert.ok(conflicting.issues.some(issue => issue.argument === 'page' && issue.code === 'constraint-mismatch'));
});

test('projection rejects overlapping oneOf, non-equivalent string constraints and unsafe policy literals', async () => {
  const { operations, metadata } = await fixture();
  const argument = operations[0].parameters.find(parameter => parameter.name === 'state');
  const captured = metadata.tools[0].inputSchema.properties.state;
  delete captured.default;

  argument.schema.oneOf = [{ const: 'ALL' }, { enum: ['ALL'] }];
  assert.ok(compareRestCapture(operations, metadata).issues.some(issue =>
    issue.argument === 'state' && issue.code === 'unsupported-schema'));

  delete argument.schema.oneOf;
  for (const [key, value] of [['minLength', -1], ['maxLength', 1.5], ['pattern', '^\\d+$']]) {
    argument.schema[key] = value;
    const report = compareRestCapture(operations, metadata);
    assert.equal(report.compatible, false, key);
    assert.ok(report.issues.some(issue => issue.argument === 'state'
      && ['constraint-mismatch', 'unsupported-schema'].includes(issue.code)));
    delete argument.schema[key];
  }

  for (const value of ['line\nbreak', '\u2028', '\u2029', '\ud800', '\udc00', '\ufffe', '\ufdd0']) {
    argument.schema.enum = ['ALL', value];
    const unsafe = compareRestCapture(operations, metadata);
    assert.equal(unsafe.compatible, false, JSON.stringify(value));
    assert.ok(unsafe.issues.some(issue => issue.argument === 'state' && issue.code === 'constraint-mismatch'));
  }
});

test('unsupported schemas block rather than being treated as equal or silently flattened', async () => {
  const schemas = [
    { $ref: '#/$defs/argument' },
    { type: ['string', 'null'] },
    { type: 'string', format: 'date-time' },
    { type: 'string', nullable: false },
    { type: 'string', allOf: [{ minLength: 1 }] },
    { type: 'array', items: { type: 'string' } },
    { type: 'object', properties: {} },
    { type: 'integer', exclusiveMinimum: 1 },
    { type: 'string', unknownValidation: true },
    { type: 'string', default: 1 },
  ];
  for (const schema of schemas) {
    const { operations, metadata } = await fixture();
    operations[0].parameters[0].schema = structuredClone(schema);
    metadata.tools[0].inputSchema.properties.query = structuredClone(schema);
    const result = compareRestCapture(operations, metadata);
    assert.equal(result.compatible, false);
    assert.ok(result.issues.some(i => i.code === 'unsupported-schema'));
  }
  for (const change of [
    op => { op.requestBody = { content: {} }; },
    op => { op.parameters[0] = { $ref: '#/components/parameters/query' }; },
    op => { op.parameters[0].in = 'header'; },
    op => { op.parameters.push(structuredClone(op.parameters[0])); },
    op => { op.parameters[0].allowEmptyValue = true; },
    op => { op.parameters[0].content = {}; },
  ]) {
    const { operations, metadata } = await fixture();
    change(operations[0]);
    assert.equal(compareRestCapture(operations, metadata).compatible, false);
  }
  {
    const { operations, metadata } = await fixture();
    operations[0].parameters[0].allowReserved = false;
    assert.equal(compareRestCapture(operations, metadata).compatible, true);
    operations[0].parameters[0].allowReserved = true;
    assert.equal(compareRestCapture(operations, metadata).compatible, false);
  }
  for (const root of [
    { allOf: [{ required: ['unseen'] }] }, { dependentRequired: { query: ['page'] } },
    { additionalProperties: { type: 'string' } }, { $defs: {} }, { minProperties: 1 },
  ]) {
    const { operations, metadata } = await fixture();
    Object.assign(metadata.tools[0].inputSchema, root);
    assert.equal(compareRestCapture(operations, metadata).compatible, false);
  }
});

test('scalar constraints compare without executing patterns; enum order is irrelevant', () => {
  for (const schema of [
    { type: 'string', enum: ['CA', 'ALL'], default: 'ALL', minLength: 2, maxLength: 3, pattern: '^[A-Z]+$' },
    { type: 'integer', minimum: 1, maximum: 50, multipleOf: 1, default: 10 },
    { type: 'number', minimum: 0.5, maximum: 5, default: 1.5 },
    { type: 'boolean', default: false },
  ]) {
    const operations = [{ toolName: 'read', parameters: [{ name: 'value', in: 'query', schema }] }];
    const observed = structuredClone(schema);
    observed.enum?.reverse();
    const metadata = { tools: [{ name: 'read', inputSchema: { type: 'object', properties: { value: observed } } }] };
    assert.equal(compareRestCapture(operations, metadata).compatible, true);
    delete observed.default;
    assert.equal(compareRestCapture(operations, metadata).compatible, false);
  }
  const operations = [{ toolName: 'read', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] }];
  const metadata = { tools: [{ name: 'read', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }] };
  assert.equal(compareRestCapture(operations, metadata).compatible, true);
});

test('unsupported input is bounded and invalid tool metadata rejects without leaking input values', async () => {
  const { operations, metadata } = await fixture();
  assert.throws(() => compareRestCapture([], metadata), { code: 'INVALID_CONFIG' });
  assert.throws(() => compareRestCapture([...operations, operations[0]], metadata), { code: 'INVALID_CONFIG' });
  assert.throws(() => compareRestCapture(operations, { tools: [{ name: 'invalid', inputSchema: {} }] }), { code: 'INVALID_CONFIG' });
  metadata.tools[0].inputSchema.description = 'private'.repeat(400000);
  assert.throws(() => compareRestCapture(operations, metadata), error => error.code === 'INVALID_CONFIG' && !error.message.includes('private'));
  const deep = {};
  let nested = deep;
  for (let i = 0; i < 45; i++) { nested.child = {}; nested = nested.child; }
  assert.throws(() => compareRestCapture(operations, deep), { code: 'INVALID_CONFIG' });
});

test('required ordering and prototype-sensitive argument names compare using own properties', () => {
  const names = ['constructor', '__proto__', 'toString'];
  const operations = [{ toolName: 'read', parameters: names.map(name => ({
    name, in: 'query', required: true, schema: { type: 'string' },
  })) }];
  const metadata = { tools: [{ name: 'read', inputSchema: {
    type: 'object', properties: Object.fromEntries(names.map(name => [name, { type: 'string' }])),
    required: [...names].reverse(),
  } }] };
  assert.equal(compareRestCapture(operations, metadata).compatible, true);
  delete metadata.tools[0].inputSchema.properties.constructor;
  assert.ok(compareRestCapture(operations, metadata).issues.some(i =>
    i.code === 'missing-argument' && i.argument === 'constructor'));
});
