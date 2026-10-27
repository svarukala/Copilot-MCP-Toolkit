import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { compileHostingRecipe } from '../src/mcp-container-apps.js';
import { createProtocolServer, toolDefinitions, validateRuntimeConfig, validateToolArguments }
  from '../src/recipes/container-apps/runtime.js';

const readExample = name => readFile(new URL(`../examples/mcp/${name}.json`, import.meta.url), 'utf8').then(JSON.parse);
const plain = await readExample('container-apps-direct');
const dated = await readExample('container-apps-query-dates');
const keyed = await readExample('container-apps-direct-api-key');
const parameter = (name = 'q', schema = { type: 'string' }, extra = {}) => ({ name, in: 'query', schema, ...extra });
const operation = input => Object.values(input.document.paths)[0].get;
function compile(parameters, extra = {}) {
  const input = structuredClone(plain);
  Object.assign(operation(input), { parameters }, extra);
  return compileHostingRecipe(input).runtime;
}
async function sdk(t, runtime, dependencies) {
  const server = createProtocolServer(runtime, dependencies);
  const client = new Client({ name: 'synthetic-query-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('no-argument runtime and tool definitions preserve their original exact shape', () => {
  const runtime = compileHostingRecipe(plain).runtime;
  const tool = runtime.tools[0];
  assert.deepEqual(tool, { name: 'get_information', description: operation(plain).description,
    path: '/information', readOnlyReviewed: true });
  assert.deepEqual(toolDefinitions(runtime), [{
    name: tool.name, description: tool.description,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }]);
  assert.deepEqual(compile([]), runtime);
  assert.deepEqual(validateToolArguments(tool), {});
  assert.deepEqual(validateToolArguments(tool, {}), {});
  for (const args of [null, [], 'q', { q: 'x' }]) assert.throws(() => validateToolArguments(tool, args), /^Error: Invalid tool arguments\.$/);
});

test('compiler normalizes scalar bounds and optionality without changing the source', () => {
  const input = structuredClone(plain);
  operation(input).parameters = [
    parameter('q', { type: 'string' }, { description: 'Search text', style: 'form', explode: true, allowReserved: false }),
    parameter('limit', { type: 'integer' }, { required: true, explode: false }),
    parameter('enabled', { type: 'boolean', enum: [false] }),
  ];
  const before = structuredClone(input);
  const { runtime } = compileHostingRecipe(input);
  assert.deepEqual(input, before);
  assert.deepEqual(runtime.tools[0].queryParameters, [
    { name: 'q', required: false, description: 'Search text', schema: { type: 'string', minLength: 0, maxLength: 2048 } },
    { name: 'limit', required: true, schema: { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER } },
    { name: 'enabled', required: false, schema: { type: 'boolean', enum: [false] } },
  ]);
  const definition = toolDefinitions(runtime)[0];
  assert.deepEqual(definition.inputSchema.required, ['limit']);
  assert.equal(definition.inputSchema.properties.q.description, 'Search text');
  assert.equal(definition.inputSchema.properties.q.maxLength, 2048);
  assert.equal(definition.inputSchema.properties.limit.maximum, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(definition.inputSchema.properties.enabled.enum, [false]);
});

test('compiler rejects unsupported or ambiguous query definitions and schema keywords', () => {
  const invalid = [
    null, {}, [null], [parameter('q'), parameter('q')], [parameter('Q'), parameter('q')],
    Array.from({ length: 21 }, (_, i) => parameter(`q${i}`)),
    [parameter('bad name')], [parameter('q'.repeat(101))],
    ...['path', 'header', 'cookie'].map(location => [parameter('q', { type: 'string' }, { in: location })]),
    ...[
      { $ref: '#/components/parameters/q' }, { content: {} }, { style: 'spaceDelimited' },
      { style: 'deepObject' }, { explode: 'true' }, { allowReserved: true }, { allowEmptyValue: false },
      { example: 'x' }, { examples: {} }, { deprecated: true }, { required: 'true' }, { unexpected: true },
    ].map(extra => [parameter('q', { type: 'string' }, extra)]),
    ...[
      {}, { type: 'array' }, { type: 'object' }, { type: 'number' }, { type: ['string', 'null'] },
      { type: 'string', format: 'date-time' }, { type: 'integer', format: 'int32' },
      { type: 'string', pattern: '.*' }, { type: 'string', default: 'x' },
      { type: 'integer', default: 1 }, { type: 'boolean', default: false },
      { type: 'string', nullable: true }, { type: 'string', $ref: '#/components/schemas/q' },
      { type: 'string', oneOf: [] }, { type: 'string', anyOf: [] }, { type: 'string', allOf: [] },
      { type: 'string', not: {} }, { type: 'string', description: 'not a parameter description' },
      { type: 'integer', minimum: 1.5 }, { type: 'integer', maximum: Number.MAX_SAFE_INTEGER + 1 },
      { type: 'integer', minimum: Number.MIN_SAFE_INTEGER - 1 }, { type: 'integer', minimum: 2, maximum: 1 },
      { type: 'integer', exclusiveMinimum: 1 }, { type: 'integer', multipleOf: 2 },
      { type: 'string', minLength: -1 }, { type: 'string', maxLength: 2049 },
      { type: 'string', minLength: 2, maxLength: 1 }, { type: 'string', maximum: 2 },
      { type: 'boolean', minLength: 0 }, { type: 'boolean', enum: [0] },
      { type: 'string', enum: [] }, { type: 'string', enum: ['a', 'a'] },
      { type: 'string', enum: Array.from({ length: 51 }, (_, i) => String(i)) },
      { type: 'string', enum: [1] }, { type: 'integer', enum: [1.1] },
      { type: 'integer', minimum: 2, enum: [1] }, { type: 'string', maxLength: 1, enum: ['aa'] },
      { type: 'string', enum: ['\n'] }, { type: 'string', enum: ['\ud800'] },
      { type: 'string', format: 'date', enum: ['2023-02-29'] },
      { type: 'string', format: 'date', minLength: 11 }, { type: 'string', format: 'date', maxLength: 9 },
    ].map(schema => [parameter('q', schema)]),
  ];
  for (const parameters of invalid) assert.throws(() => compile(parameters), undefined, JSON.stringify(parameters));
  assert.doesNotThrow(() => compile(Array.from({ length: 20 }, (_, i) => parameter(`q${i}`))));
  assert.doesNotThrow(() => compile([parameter('q', { type: 'string', enum: Array.from({ length: 50 }, (_, i) => String(i)) })]));
  const input = structuredClone(plain);
  Object.values(input.document.paths)[0].parameters = [parameter()];
  assert.throws(() => compileHostingRecipe(input));
});

test('reserved credential routing and prototype names cannot become query arguments', () => {
  for (const name of ['__proto__', 'prototype', 'constructor', 'toString', 'valueOf', 'hasOwnProperty',
    'authorization', 'access_token', 'access.token', 'refreshToken', 'password', 'client_secret', 'api_key', 'api-key', 'key',
    'subscription-key', 'x-api-key', 'url', 'uri', 'host', 'endpoint', 'method', 'op', 'path', 'pathname',
    'base_url', 'backendOrigin', 'redirect_uri', 'callback', 'query', 'search', 'port', 'protocol',
    'connection', 'x-forwarded-host', 'x-http-method-override', 'mcp-session-id']) {
    assert.throws(() => compile([parameter(name)]), undefined, name);
  }
  for (const placement of ['headerName', 'queryParameterName']) {
    const input = structuredClone(keyed);
    delete input.backend.apiKey.headerName;
    input.backend.apiKey[placement] = 'Provider-Key';
    if (placement === 'queryParameterName') input.backend.apiKey.queryExposureReviewed = true;
    Object.assign(input.document.components.securitySchemes.backendKey,
      { in: placement === 'headerName' ? 'header' : 'query', name: 'Provider-Key' });
    operation(input).parameters = [parameter('provider-key')];
    assert.throws(() => compileHostingRecipe(input), /query parameter contract/);
  }
});

test('date-range definitions require two declared required dates and bounded elapsed days', () => {
  const parameters = ['start', 'end'].map(name => parameter(name, { type: 'string', format: 'date' }, { required: true }));
  const range = { startParameter: 'start', endParameter: 'end', maxSpanDays: 7 };
  for (const bad of [null, {}, { ...range, maxSpanDays: 0 }, { ...range, maxSpanDays: 367 },
    { ...range, maxSpanDays: 1.5 }, { ...range, maxSpanDays: '7' }, { ...range, extra: true },
    { ...range, startParameter: 'missing' }, { ...range, endParameter: 'start' }]) {
    assert.throws(() => compile(parameters, { 'x-mcp-date-range': bad }));
  }
  for (const change of [
    p => { p[0].required = false; }, p => { p[0].schema = { type: 'string' }; },
    p => { p[0].schema = { type: 'integer' }; },
  ]) {
    const p = structuredClone(parameters); change(p);
    assert.throws(() => compile(p, { 'x-mcp-date-range': range }));
  }
  assert.throws(() => compile([], { 'x-mcp-date-range': range }));
  for (const maxSpanDays of [1, 366]) assert.doesNotThrow(() => compile(parameters, { 'x-mcp-date-range': { ...range, maxSpanDays } }));
  const runtime = compile(parameters, { 'x-mcp-date-range': range });
  assert.deepEqual(runtime.tools[0].dateRange, range);
  assert.match(toolDefinitions(runtime)[0].inputSchema.description, /start.*on or before.*end.*UTC.*7/);
});

test('runtime configuration validates the query contract independently of compilation', () => {
  const runtime = compile([parameter()]);
  for (const mutate of [
    t => { t.queryParameters[0].schema.default = 'x'; },
    t => { t.queryParameters[0].name = 'api_key'; },
    t => { t.queryParameters.push(structuredClone(t.queryParameters[0])); },
    t => { t.queryParameters[0].schema.maxLength = 2049; },
    t => { t.queryParameters[0].schema.enum = ['a']; t.queryParameters[0].schema.minLength = 2; },
    t => { t.dateRange = { startParameter: 'q', endParameter: 'end', maxSpanDays: 7 }; },
    t => { t.queryParameters[0].in = 'path'; },
  ]) {
    const value = structuredClone(runtime); mutate(value.tools[0]);
    assert.throws(() => validateRuntimeConfig(value), undefined, mutate.toString());
  }
  const unbounded = structuredClone(runtime);
  unbounded.tools[0].queryParameters[0].schema = { type: 'string' };
  const validated = validateRuntimeConfig(unbounded);
  assert.equal(toolDefinitions(validated)[0].inputSchema.properties.q.maxLength, 2048);
  assert.deepEqual(unbounded.tools[0].queryParameters[0].schema, { type: 'string' });
});

test('scalar validation enforces exact inclusive thresholds without coercion defaults or argument mutation', () => {
  const tool = compile([
    parameter('q', { type: 'string', minLength: 1, maxLength: 2 }, { required: true }),
    parameter('count', { type: 'integer', minimum: -2, maximum: 2 }),
    parameter('enabled', { type: 'boolean' }),
    parameter('choice', { type: 'string', enum: ['a', 'b'] }),
  ]).tools[0];
  for (const args of [{ q: 'a', count: -2, enabled: false }, { q: '😀😀', count: 2, enabled: true, choice: 'b' }]) {
    const before = structuredClone(args);
    Object.freeze(args);
    const effective = validateToolArguments(tool, args);
    assert.deepEqual(effective, before); assert.deepEqual(args, before); assert.notEqual(effective, args);
  }
  assert.deepEqual(validateToolArguments(tool, { q: 'a' }), { q: 'a' });
  const invalid = [undefined, null, [], 'q', {}, { q: '' }, { q: 'abc' }, { q: '😀😀😀' },
    { q: 1 }, { q: '\n' }, { q: '\u007f' }, { q: '\ud800' }, { q: null }, { q: ['a'] },
    { q: { toString: () => 'a' } }, { q: undefined }, { q: 'a', extra: 1 },
    ...[-3, 3, 1.5, '1', NaN, Infinity, true].map(count => ({ q: 'a', count })),
    ...['true', 0, null].map(enabled => ({ q: 'a', enabled })), { q: 'a', choice: 'c' },
    Object.assign(Object.create({ inherited: 1 }), { q: 'a' }),
    Object.defineProperty({}, 'q', { get: () => { throw new Error('getter must not run'); } }),
    new Proxy({}, { getPrototypeOf() { throw new Error('private-value'); } }),
    { q: 'a', [Symbol('hidden')]: 'x' },
  ];
  for (const args of invalid) assert.throws(() => validateToolArguments(tool, args), /^Error: Invalid tool arguments\.$/);
  const integer = compile([parameter('n', { type: 'integer' })]).tools[0];
  for (const n of [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) assert.deepEqual(validateToolArguments(integer, { n }), { n });
  for (const n of [Number.MIN_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validateToolArguments(integer, { n }));
  const string = compile([parameter()]).tools[0];
  assert.equal(validateToolArguments(string, { q: 'a'.repeat(2048) }).q.length, 2048);
  assert.throws(() => validateToolArguments(string, { q: 'a'.repeat(2049) }));
  const empty = compile([parameter('q', { type: 'string', minLength: 0, maxLength: 0 })]).tools[0];
  assert.deepEqual(validateToolArguments(empty, { q: '' }), { q: '' });
  assert.throws(() => validateToolArguments(empty, { q: 'a' }));
});

test('encoded query limit is aggregate and includes names separators and UTF-8 escaping', () => {
  const tool = compile(['a', 'b', 'c', 'd'].map(name => parameter(name))).tools[0];
  const args = { a: 'x'.repeat(2048), b: 'x'.repeat(2048), c: 'x'.repeat(2048), d: 'x'.repeat(2037) };
  assert.equal(new URLSearchParams(args).toString().length, 8192);
  assert.deepEqual(validateToolArguments(tool, args), args);
  assert.throws(() => validateToolArguments(tool, { ...args, d: `${args.d}x` }));
  const single = compile([parameter()]).tools[0];
  assert.throws(() => validateToolArguments(single, { q: '😀'.repeat(1000) }));
});

test('actual SDK consumes no backend dispatch for oversized encoded queries', async t => {
  const runtime = compile(['a', 'b', 'c', 'd'].map(name => parameter(name)));
  let calls = 0;
  const client = await sdk(t, runtime, { request: async () => { calls++; return Response.json({ ok: true }); } });
  const name = runtime.tools[0].name;
  const args = { a: 'x'.repeat(2048), b: 'x'.repeat(2048), c: 'x'.repeat(2048), d: 'x'.repeat(2037) };
  await assert.rejects(client.callTool({ name, arguments: { ...args, d: `${args.d}x` } }));
  await assert.rejects(client.callTool({ name, arguments: { a: '😀'.repeat(1000) } }));
  assert.equal(calls, 0);
  await client.callTool({ name, arguments: args });
  assert.equal(calls, 1);
});

test('actual SDK rejects invalid typed and date arguments before dispatch and preserves safe scalar serialization', async t => {
  const input = structuredClone(dated);
  operation(input).parameters.push(parameter('q', { type: 'string', maxLength: 100 }));
  const { runtime } = compileHostingRecipe(input);
  const calls = [], logs = [];
  const client = await sdk(t, runtime, { request: async (...args) => {
    calls.push(args); return Response.json({ events: [] });
  }, log: event => logs.push(event) });
  assert.deepEqual((await client.listTools()).tools, toolDefinitions(runtime));
  const name = 'get_events', good = { start_date: '2024-02-28', end_date: '2024-03-06' };
  for (const args of [
    {}, { start_date: good.start_date }, { ...good, q: 'x'.repeat(101) },
    { ...good, limit: 0 }, { ...good, limit: 21 }, { ...good, limit: '1' },
    { ...good, include_archived: 'false' }, { ...good, q: [] }, { ...good, extra: 'private-value' },
    ...['2023-02-29', '1900-02-29', '2024-04-31', '0000-01-01', '10000-01-01', '2024-2-28',
      '2024-02-28T00:00:00Z', '2024-13-01', '2024-00-01', '2024-01-00', 'private-value'].map(start_date => ({ ...good, start_date })),
    { ...good, end_date: '2024-02-27' }, { ...good, end_date: '2024-03-07' },
  ]) {
    await assert.rejects(client.callTool({ name, arguments: args }), error => {
      assert.equal(error.code, -32602); assert.doesNotMatch(error.message, /private-value/); return true;
    });
  }
  assert.equal(calls.length, 0); assert.deepEqual(logs, []);
  for (const args of [
    good, { ...good, end_date: good.start_date, limit: 1, include_archived: false },
    { start_date: '2000-02-29', end_date: '2000-03-01', limit: 20, include_archived: true },
    { start_date: '0001-01-01', end_date: '0001-01-02' },
    { start_date: '9999-12-30', end_date: '9999-12-31' },
    { ...good, q: 'https://attacker.example/other?api_key=bad&x=y#frag +% /😀' },
  ]) {
    assert.equal((await client.callTool({ name, arguments: args })).isError, undefined);
    const [href, options] = calls.at(-1), url = new URL(href);
    assert.equal(url.origin, input.backend.origin); assert.equal(url.pathname, '/events'); assert.equal(url.hash, '');
    assert.deepEqual([...url.searchParams], Object.entries(args).map(([k, v]) => [k, String(v)]));
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.equal(options.body, undefined);
  }
  assert.equal(calls.length, 6);
});

test('date format alone does not impose an unrelated date-range rule and 366 elapsed days is inclusive', () => {
  const runtime = compile(['start', 'end'].map(name => parameter(name, { type: 'string', format: 'date' }, { required: true })));
  assert.doesNotThrow(() => validateToolArguments(runtime.tools[0], { start: '2025-01-01', end: '2024-01-01' }));
  runtime.tools[0].dateRange = { startParameter: 'start', endParameter: 'end', maxSpanDays: 366 };
  const tool = validateRuntimeConfig(runtime).tools[0];
  assert.doesNotThrow(() => validateToolArguments(tool, { start: '2024-01-01', end: '2025-01-01' }));
  assert.throws(() => validateToolArguments(tool, { start: '2024-01-01', end: '2025-01-02' }));
});

test('actual SDK cannot override backend key or route and retains reflection suppression and no retries', async t => {
  const input = structuredClone(keyed);
  delete input.backend.apiKey.headerName;
  Object.assign(input.backend.apiKey, { queryParameterName: 'api_key', queryExposureReviewed: true });
  Object.assign(input.document.components.securitySchemes.backendKey, { in: 'query', name: 'api_key' });
  operation(input).parameters = [parameter()];
  const { runtime } = compileHostingRecipe(input);
  const credential = 'synthetic-only-key', calls = [], logs = [];
  let reflect = false;
  const client = await sdk(t, runtime, { env: { MCP_BACKEND_API_KEY: credential },
    request: async (...args) => { calls.push(args); return Response.json(reflect ? { echoed: credential } : { ok: true }); },
    log: event => logs.push(event) });
  const name = runtime.tools[0].name;
  for (const args of [{ api_key: 'other' }, { url: 'https://attacker.example' }, { q: 'x', __proto__: null, method: 'POST' }]) {
    await assert.rejects(client.callTool({ name, arguments: args }));
  }
  assert.equal(calls.length, 0);
  const q = '&api_key=other&url=https://attacker.example/changed#frag?x=%26+😀';
  await client.callTool({ name, arguments: { q } });
  const url = new URL(calls[0][0]);
  assert.equal(url.origin, input.backend.origin); assert.equal(url.pathname, runtime.tools[0].path);
  assert.deepEqual([...url.searchParams], [['q', q], ['api_key', credential]]);
  assert.equal(url.hash, '');
  reflect = true;
  const result = await client.callTool({ name, arguments: { q: 'a' } });
  assert.equal(result.isError, true); assert.match(result.content[0].text, /No retry/);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(JSON.stringify({ result, logs }), new RegExp(credential));
  assert.equal(logs[0].failureKind, 'credential-reflection');
});

test('existing bundler packages query validation and SDK dispatch without additional runtime assets', async t => {
  const built = await build({
    entryPoints: [fileURLToPath(new URL('../src/recipes/container-apps/runtime.js', import.meta.url))],
    bundle: true, platform: 'node', target: 'node22', format: 'esm', write: false,
    sourcemap: false, legalComments: 'none', charset: 'ascii', logLevel: 'silent',
  });
  const bundled = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
  const { runtime } = compileHostingRecipe(dated);
  assert.deepEqual(bundled.toolDefinitions(runtime), toolDefinitions(runtime));
  let calls = 0;
  const server = bundled.createProtocolServer(runtime, { request: async () => { calls++; return Response.json({ ok: true }); } });
  const client = new Client({ name: 'synthetic-bundled-query', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const argumentsValue = { start_date: '2024-02-29', end_date: '2024-03-07' };
  assert.deepEqual(bundled.validateToolArguments(runtime.tools[0], argumentsValue), argumentsValue);
  await assert.rejects(client.callTool({ name: 'get_events', arguments: { ...argumentsValue, limit: 21 } }));
  assert.equal(calls, 0);
  await client.callTool({ name: 'get_events', arguments: argumentsValue });
  assert.equal(calls, 1);
});
