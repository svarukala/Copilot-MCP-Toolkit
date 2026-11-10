import test from 'node:test';

import assert from 'node:assert/strict';

import { randomUUID } from 'node:crypto';

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { spawnSync } from 'node:child_process';

import path from 'node:path';

import { prepareRestToolDocument, restAuthoringVersion } from 'copilot-mcp-toolkit';

import { planRestToolWrite, writeRestTools, promptRestToolAuthoring } from '../src/rest-authoring-cli.js';

import { prepareRestToolDocument as prepareInternal, backendMappingPolicy } from '../src/rest-authoring.js';

import { TOOLKIT_ROOT, readOpenApi } from '../src/config.js';

import { reviewRestOperations } from '../src/azure.js';

const definition = async () => JSON.parse(await readFile(path.join(TOOLKIT_ROOT, 'examples', 'rest-tools-legislation.json')));

async function fixture(t) {
  const root = path.join(TOOLKIT_ROOT, '.test-output', `rest-authoring-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, outputPath: path.join(root, 'authored.json') };
}

test('three documented tools compile without mutating inputs or inventing tools/list evidence', async () => {
  assert.equal(restAuthoringVersion, 1);
  const input = await definition(), before = JSON.stringify(input);
  const authored = prepareRestToolDocument(input);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(authored.operationIds, ['search_bills', 'get_bill', 'get_roll_call']);
  assert.equal(authored.evidence, 'user-authored-openapi');
  const search = authored.operations[0];
  assert.deepEqual(search.parameters.map(p => [p.name, p.schema.type, p.required, p.schema.default]),
    [['query', 'string', true, undefined], ['state', 'string', false, 'ALL'],
      ['year', 'integer', false, 2], ['page', 'integer', false, 1]]);
  assert.deepEqual(authored.operations[1].backendMapping, { path: '/', query: { op: 'getBill' }, parameterNames: { bill_id: 'id' } });
  assert.deepEqual(authored.operations[2].backendMapping, { path: '/', query: { op: 'getRollCall' }, parameterNames: { roll_call_id: 'id' } });
  assert.ok(!Object.hasOwn(authored, 'tools'));
  assert.ok(!Object.hasOwn(authored, 'capturedAt'));
  input.tools[0].name = 'changed';
  assert.equal(authored.operationIds[0], 'search_bills');
});

test('literal dotted paths and typed bounds survive authoring and produce enforced mapping guards', () => {
  const names = ['search_locations', 'get_current_weather', 'get_forecast', 'get_astronomy', 'get_timezone'];
  const paths = ['search', 'current', 'forecast', 'astronomy', 'timezone'];
  const input = { title: 'Synthetic weather tools', apiKeyQueryParameter: 'key', tools: names.map((name, index) => ({
    name, description: 'Read synthetic weather data.', backendPath: `/v1/${paths[index]}.json`, fixedQuery: {},
    arguments: [{ name: 'q', description: 'Explicit location.', type: 'string', required: true, minLength: 1, maxLength: 256 },
      ...(name === 'get_forecast' ? [{ name: 'days', description: 'Days including today.', type: 'integer',
        required: true, minimum: 1, maximum: 3 }] : [])],
  })) };
  const before = JSON.stringify(input);
  const authored = prepareRestToolDocument(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(authored.document.openapi, '3.0.3');
  assert.deepEqual(authored.operationIds, names);
  for (const [index, operation] of authored.operations.entries()) {
    assert.equal(operation.backendMapping.path, `/v1/${paths[index]}.json`);
    assert.deepEqual(operation.parameters[0].schema, { type: 'string', minLength: 1, maxLength: 256 });
    const policy = backendMappingPolicy({ apiKey: { queryParameterName: 'key' } }, 'get',
      authored.document.paths[operation.path].get, {}, operation.operationId);
    assert.match(policy, new RegExp(`template="/v1/${paths[index]}\\.json"`));
    assert.match(policy, /copy-unmatched-params="false"/);
    assert.match(policy, /Length &lt; 1/);
    assert.match(policy, /Length &gt; 256/);
    assert.match(policy, /code="400" reason="Invalid operation parameters"/);
    if (operation.operationId === 'get_forecast') {
      assert.deepEqual(operation.parameters[1].schema, { type: 'integer', minimum: 1, maximum: 3 });
      assert.match(policy, /ToInt64.+ &lt; 1/);
      assert.match(policy, /ToInt64.+ &gt; 3/);
    }
  }
});

test('dotted paths never admit traversal, alternate origins, encoded separators or dynamic routing', () => {
  for (const backendPath of ['/./current.json', '/../current.json', '/v1/../current.json',
    '/v1/./current.json', '/v1//current.json', '//example.com/current.json', '/v1/%2e%2e/current.json',
    '/v1/current.json?q=other', '/v1/current.json#fragment', '/v1\\current.json',
    '/v1/{operation}.json', '/v1/.hidden/current.json', 'https://example.com/current.json',
    '/v1/current.json\n', '/v1/current.json\r', '/v1/current.json\r\n']) {
    const input = { title: 'Synthetic path review', tools: [{ name: 'read_record', description: 'Read a record.',
      backendPath, fixedQuery: {}, arguments: [] }] };
    assert.throws(() => prepareRestToolDocument(input), { code: 'INVALID_CONFIG' }, backendPath);
    assert.throws(() => backendMappingPolicy({}, 'get',
      { 'x-cowork-backend': { path: backendPath, query: {} } }, {}, 'read_record'), /invalid x-cowork-backend/);
  }
});

test('authoring rejects wrong-type, unordered and unsafe bounds and out-of-range defaults', () => {
  for (const argument of [
    { type: 'string', minimum: 1 }, { type: 'integer', maxLength: 3 },
    { type: 'string', minLength: -1 }, { type: 'string', maxLength: 1.5 },
    { type: 'integer', maximum: Number.MAX_SAFE_INTEGER + 1 },
    { type: 'integer', minimum: 4, maximum: 3 }, { type: 'string', minLength: 3, maxLength: 2 },
    { type: 'integer', minimum: 1, maximum: 3, default: 4 },
    { type: 'integer', minimum: 1, default: 0 },
    { type: 'string', minLength: 3, default: 'ab' },
    { type: 'string', maxLength: 2, default: 'abc' },
  ]) {
    assert.throws(() => prepareRestToolDocument({ title: 'Synthetic bounds', tools: [{
      name: 'read_record', description: 'Read a record.', backendPath: '/v1/record.json', fixedQuery: {},
      arguments: [{ name: 'value', description: 'Bounded selector.', required: true, ...argument }],
    }] }), { code: 'INVALID_CONFIG' });
  }
});

test('unsupported authoring, collisions, mismatched defaults and credential-like content fail closed', async () => {
  const mutations = [
    d => { d.tools = []; },
    d => { d.tools.push(structuredClone(d.tools[0])); },
    d => { d.tools[0].method = 'POST'; },
    d => { d.tools[0].backendPath = 'https://another.invalid/'; },
    d => { d.tools[0].backendPath = '/{id}'; },
    d => { d.tools[0].fixedQuery.key = 'never-store-this'; },
    d => { d.tools[0].fixedQuery.op = '@(expression)'; },
    d => { d.tools[0].arguments[0].type = 'object'; },
    d => { d.tools[0].arguments[0].default = 1; },
    d => { d.tools[0].arguments[2].default = '2'; },
    d => { d.tools[0].arguments[2].default = Number.MAX_SAFE_INTEGER + 1; },
    d => { d.tools[0].arguments[0].backendName = 'op'; },
    d => { d.tools[0].arguments[0].backendName = 'key'; },
    d => { d.tools[0].arguments[0].name = 'key'; },
    d => { d.tools[0].arguments.push(structuredClone(d.tools[0].arguments[0])); },
    d => { d.tools[0].description = '\x1b[31m'; },
    d => { d.tools[0].fixedQuery.api_key = 'credential-value'; },
    d => { d.tools[0].requestBody = {}; },
    d => { d.title = ' '; },
    d => { d.tools[0].arguments[0].enum = ['discarded']; },
  ];
  for (const mutate of mutations) {
    const input = await definition();
    mutate(input);
    assert.throws(() => prepareRestToolDocument(input), { code: 'INVALID_CONFIG' });
  }
  const max = await definition();
  max.tools = Array.from({ length: 101 }, (_, i) => ({ ...max.tools[0], name: `tool_${i}` }));
  assert.throws(() => prepareRestToolDocument(max), { code: 'INVALID_CONFIG' });
  const large = await definition();
  large.title = 'x'.repeat(1048577);
  assert.throws(() => prepareRestToolDocument(large), { code: 'INVALID_CONFIG' });
  const zero = await definition();
  zero.tools[0].arguments[3].default = 0;
  zero.apiKeyQueryParameter = 'api-key.long';
  assert.equal(prepareRestToolDocument(zero).operations[0].parameters[3].schema.default, 0);
  zero.tools[0].arguments[0].name = 'constructor';
  assert.equal(prepareRestToolDocument(zero).operations[0].backendMapping.parameterNames.constructor, 'constructor');
});

test('authoring approvals bind source bytes and destination; writes are exclusive and preserve inputs', async t => {
  const f = await fixture(t), source = path.join(f.root, 'definition.json');
  await writeFile(source, JSON.stringify(await definition()));
  const options = { definitionFile: source, outputPath: f.outputPath };
  const reviewed = await planRestToolWrite(options);
  await assert.rejects(writeRestTools(options), /APPROVAL_REQUIRED/);
  await assert.rejects(writeRestTools({ ...options, outputPath: path.join(f.root, 'different.json'), approval: reviewed.approvalToken }), /APPROVAL_REQUIRED/);
  await writeFile(source, `${await readFile(source, 'utf8')}\n`);
  await assert.rejects(writeRestTools({ ...options, approval: reviewed.approvalToken }), /APPROVAL_REQUIRED/);
  const fresh = await planRestToolWrite(options);
  const sourceBytes = await readFile(source);
  const results = await Promise.allSettled([1, 2].map(() => writeRestTools({ ...options, approval: fresh.approvalToken })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.deepEqual(await readFile(source), sourceBytes);
  await assert.rejects(planRestToolWrite(options), /already exists/);
  assert.deepEqual((await readdir(f.root)).sort(), ['authored.json', 'definition.json']);
});

test('prepared output enforces its own 1 MiB bound even when the valid input is smaller', () => {
  const input = { title: 'Bounded tool authoring', tools: Array.from({ length: 24 }, (_, i) => ({
    name: `tool_${i}`, description: 'Read documented data.', backendPath: '/', fixedQuery: {},
    arguments: Array.from({ length: 25 }, (_, j) => ({
      name: `field_${j}`, description: 'x'.repeat(900), type: 'string', required: false,
    })),
  })) };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < 1048576);
  assert.throws(() => prepareInternal(input), /output must be no larger than 1 MiB/);
});

test('unsafe locations, malformed input and existing files are never overwritten', async t => {
  const f = await fixture(t), input = await definition();
  const original = path.join(f.root, 'definition.json');
  await writeFile(original, '{"private-incomplete":');
  await assert.rejects(planRestToolWrite({ definitionFile: original, outputPath: f.outputPath }), /JSON is invalid/);
  assert.equal(await readFile(original, 'utf8'), '{"private-incomplete":');
  await assert.rejects(planRestToolWrite({ definition: input, outputPath: original }), /already exists/);
  await assert.rejects(planRestToolWrite({ definition: input, outputPath: path.join(TOOLKIT_ROOT, '..', 'outside.json') }), /inside/);
  if (process.platform === 'win32') {
    await assert.rejects(planRestToolWrite({ definition: input, outputPath: path.join(f.root, 'output.json:stream.json') }), /ambiguous/);
  }
  const target = path.join(f.root, 'target'), alias = path.join(f.root, 'alias');
  await mkdir(target);
  try { await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.diagnostic('Symlink check unavailable on this host.'); throw error; }
  await assert.rejects(planRestToolWrite({ definition: input, outputPath: path.join(alias, 'new.json') }), /Symlinks|junction/);
});

test('declined interactive authoring saves nothing and reports exact mappings rather than fabricated captures', async t => {
  const f = await fixture(t);
  const answers = ['get_record', 'Get a record by ID.', '/', 'op', 'getRecord', 'record_id',
    'An ID from search.', undefined, 'id', f.outputPath];
  const yes = [true, false, true, true, false, false, false, false];
  const output = [];
  const result = await promptRestToolAuthoring({
    output: { write: s => output.push(s) },
    ask: async (_label, options = {}) => {
      const value = answers.shift();
      if (value !== undefined && options.check) await options.check(value);
      return value;
    },
    choose: async () => 'integer',
    yes: async () => yes.shift(),
  }, { title: 'Records', outputPath: f.outputPath });
  assert.equal(result, null);
  assert.equal(answers.length + yes.length, 0);
  assert.deepEqual(await readdir(f.root), []);
  assert.match(output.join(''), /"record_id": "id"/);
  assert.match(output.join(''), /No tools\/list capture/);
});

test('interactive authoring collects bounded string arguments for dotted paths without implicit writes', async t => {
  const f = await fixture(t);
  const answers = ['read_record', 'Read a synthetic record.', '/v1/record.json', 'q',
    'Explicit selector.', undefined, 'q', '1', '256', f.outputPath];
  const yes = [false, true, true, true, false, false, false];
  const output = [];
  const result = await promptRestToolAuthoring({
    output: { write: s => output.push(s) },
    ask: async (_label, options = {}) => {
      const value = answers.shift();
      if (value !== undefined && options.check) await options.check(value);
      return value;
    },
    choose: async () => 'string',
    yes: async () => yes.shift(),
  }, { title: 'Synthetic bounded records', outputPath: f.outputPath });
  assert.equal(result, null);
  assert.equal(answers.length + yes.length, 0);
  assert.deepEqual(await readdir(f.root), []);
  assert.match(output.join(''), /"minLength": 1/);
  assert.match(output.join(''), /"maxLength": 256/);
  assert.match(output.join(''), /"path": "\/v1\/record.json"/);
});

test('structured CLI plans and writes exact reviewed authoring without cloud operations', async t => {
  const f = await fixture(t);
  const source = path.join(TOOLKIT_ROOT, 'examples', 'rest-tools-legislation.json');
  const run = (command, args = []) => spawnSync(process.execPath, [path.join(TOOLKIT_ROOT, 'bin', 'copilot-mcp.js'), command,
    '--config', source, '--output', f.outputPath, '--json', ...args], { encoding: 'utf8', timeout: 15000 });
  const plan = run('rest-tools-plan');
  assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  const parsed = JSON.parse(plan.stdout);
  assert.equal(run('rest-tools-write').status, 1);
  const written = run('rest-tools-write', ['--approve', parsed.approvalToken]);
  assert.equal(written.status, 0, written.stdout + written.stderr);
  assert.equal(JSON.parse(written.stdout).status, 'written');
  assert.deepEqual(JSON.parse(await readFile(f.outputPath)), parsed.document);
});

test('REST CLI uses the explicit private workspace and rejects escapes and stale approvals', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'copilot-rest-private-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'definition.json'), outputPath = path.join(root, 'authored.json');
  await writeFile(source, JSON.stringify({ title: 'Synthetic private tools', tools: [{
    name: 'read_record', description: 'Read one synthetic record.', backendPath: '/v1/record.json', fixedQuery: {},
    arguments: [{ name: 'q', description: 'Bounded query.', type: 'string', required: true, minLength: 1, maxLength: 256 }],
  }] }));
  const run = (command, output = outputPath, args = [], input = source) => spawnSync(process.execPath, [
    path.join(TOOLKIT_ROOT, 'bin', 'copilot-mcp.js'), command, '--workspace-root', root,
    '--config', input, '--output', output, '--json', ...args,
  ], { encoding: 'utf8', timeout: 15000 });
  const planned = run('rest-tools-plan');
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  const review = JSON.parse(planned.stdout);
  assert.equal(run('rest-tools-write').status, 1);
  assert.equal(run('rest-tools-plan', path.join(root, '..', 'escape.json')).status, 1);
  assert.equal(run('rest-tools-plan', path.join(TOOLKIT_ROOT, 'escape.json')).status, 1);
  assert.equal(run('rest-tools-plan', outputPath, [],
    path.join(TOOLKIT_ROOT, 'examples', 'rest-tools-legislation.json')).status, 1);
  assert.equal(run('rest-tools-write', path.join(root, 'other.json'), ['--approve', review.approvalToken]).status, 1);
  const written = run('rest-tools-write', outputPath, ['--approve', review.approvalToken]);
  assert.equal(written.status, 0, written.stdout + written.stderr);
  assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), review.document);
  assert.equal(run('rest-tools-write', outputPath, ['--approve', review.approvalToken]).status, 1);
  assert.deepEqual((await readdir(root)).sort(), ['authored.json', 'definition.json']);
});

test('a destination appearing after the prompt check offers recovery rather than exiting the wizard', async t => {
  const f = await fixture(t);
  const answers = ['read_record', 'Read documented data.', '/', f.outputPath];
  const yes = [false, false, false, false];
  const output = [];
  const result = await promptRestToolAuthoring({
    output: { write: s => output.push(s) },
    ask: async (_label, options = {}) => {
      const value = answers.shift();
      if (options.check) await options.check(value);
      if (value === f.outputPath) await writeFile(f.outputPath, 'competing writer', { flag: 'wx' });
      return value;
    },
    choose: async () => assert.fail('No argument type selection needed'),
    yes: async () => yes.shift(),
  }, { title: 'Records', outputPath: f.outputPath });
  assert.equal(result, null);
  assert.equal(answers.length + yes.length, 0);
  assert.equal(await readFile(f.outputPath, 'utf8'), 'competing writer');
  assert.match(output.join(''), /not confirmed written/);
});
