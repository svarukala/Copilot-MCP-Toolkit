import Ajv from 'ajv';
import { secretIssues } from './validation.js';
import { graphOrganizationOperation } from './mcp-graph-organization.js';

export const restAuthoringVersion = 1;
const xml = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const own = (value, key) => Object.hasOwn(value, key);
export function isPolicyLiteralRepresentable(value) {
  if (typeof value !== 'string') return false;
  for (let index = 0; index < value.length; index++) {
    const first = value.charCodeAt(index);
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(++index);
      if (!(second >= 0xdc00 && second <= 0xdfff)) return false;
      codePoint = 0x10000 + ((first - 0xd800) << 10) + second - 0xdc00;
    } else if (first >= 0xdc00 && first <= 0xdfff) return false;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
      || codePoint === 0x2028 || codePoint === 0x2029
      || (codePoint >= 0xfdd0 && codePoint <= 0xfdef)
      || (codePoint & 0xffff) >= 0xfffe) return false;
  }
  return true;
}
const csharp = value => {
  const text = String(value);
  if (!isPolicyLiteralRepresentable(text)) throw new Error('Unsafe APIM policy literal.');
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
};

// Deliberately bounded ASCII language, not a general ECMA-262 to .NET translation.
export function policyAsciiPattern(pattern) {
  if (typeof pattern !== 'string') return null;
  const match = /^\^\(\?:\[A-Z\]\{([1-9]|[12][0-9]|3[0-2])\}\|([A-Z]{1,32})\)\$$/.exec(pattern);
  return match ? `\\A(?:[A-Z]{${match[1]}}|${match[2]})\\z` : null;
}

export function integerEnumRangeUnion(schema) {
  if (schema?.type !== 'integer' || own(schema, 'enum')
    || !Array.isArray(schema.oneOf) || schema.oneOf.length !== 2) return null;
  const branches = schema.oneOf.map(branch => {
    if (!branch || typeof branch !== 'object' || Array.isArray(branch)) return null;
    return Object.fromEntries(Object.entries(branch).filter(([key]) =>
      !['title', 'description', 'examples', '$comment'].includes(key)));
  });
  if (branches.some(branch => !branch || branch.type !== 'integer')) return null;
  const enumeration = branches.find(branch => Array.isArray(branch.enum));
  const range = branches.find(branch => own(branch, 'minimum'));
  if (!enumeration || !range || Object.keys(enumeration).some(key => !['type', 'enum'].includes(key))
    || Object.keys(range).some(key => !['type', 'minimum'].includes(key))
    || !Number.isSafeInteger(range.minimum) || !enumeration.enum.length || enumeration.enum.length > 100
    || enumeration.enum.some(value => !Number.isSafeInteger(value) || value >= range.minimum)
    || new Set(enumeration.enum).size !== enumeration.enum.length) return null;
  return [{ type: 'integer', enum: [...enumeration.enum].sort((a, b) => a - b) },
    { type: 'integer', minimum: range.minimum }];
}

function enforcedScalarSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)
    || !['string', 'integer'].includes(schema.type)) return null;
  const allowed = new Set(['type', 'default', 'enum', 'minimum', 'maximum', 'multipleOf',
    'minLength', 'maxLength', 'pattern', 'oneOf', 'title', 'description', 'examples', '$comment']);
  if (Object.keys(schema).some(key => !allowed.has(key))) return null;
  let values = schema.enum;
  const union = integerEnumRangeUnion(schema);
  if (schema.oneOf !== undefined && !union) {
    if (values !== undefined || !Array.isArray(schema.oneOf) || !schema.oneOf.length) return null;
    values = schema.oneOf.map(choice => {
      if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return undefined;
      const keys = Object.keys(choice).filter(key => !['title', 'description', '$comment'].includes(key));
      if (keys.includes('type') && choice.type === schema.type) keys.splice(keys.indexOf('type'), 1);
      if (keys.length === 1 && keys[0] === 'const') return choice.const;
      if (keys.length === 1 && keys[0] === 'enum' && Array.isArray(choice.enum) && choice.enum.length === 1) return choice.enum[0];
      return undefined;
    });
    if (values.some(value => value === undefined)
      || new Set(values.map(value => JSON.stringify(value))).size !== values.length) return null;
  }
  const scalar = value => schema.type === 'string'
    ? isPolicyLiteralRepresentable(value)
    : Number.isSafeInteger(value);
  if (own(schema, 'default') && !scalar(schema.default)) return null;
  if (values !== undefined && (!Array.isArray(values) || !values.length || values.length > 100
    || values.some(value => !scalar(value)))) return null;
  if (['minimum', 'maximum', 'multipleOf'].some(key => own(schema, key))
    && (schema.type !== 'integer' || ['minimum', 'maximum', 'multipleOf'].some(key => own(schema, key) && !Number.isSafeInteger(schema[key])))) return null;
  if (['minLength', 'maxLength'].some(key => own(schema, key)
    && (schema.type !== 'string' || !Number.isSafeInteger(schema[key]) || schema[key] < 0))) return null;
  if (own(schema, 'pattern') && (schema.type !== 'string' || !policyAsciiPattern(schema.pattern))) return null;
  if ((own(schema, 'minimum') && own(schema, 'maximum') && schema.minimum > schema.maximum)
    || (own(schema, 'minLength') && own(schema, 'maxLength') && schema.minLength > schema.maxLength)
    || (own(schema, 'multipleOf') && schema.multipleOf <= 0)) return null;
  return {
    type: schema.type,
    ...(own(schema, 'default') ? { default: schema.default } : {}),
    ...(values !== undefined ? { enum: [...values] } : {}),
    ...(union ? { oneOf: union } : {}),
    ...Object.fromEntries(['minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'pattern']
      .filter(key => own(schema, key)).map(key => [key, schema[key]])),
  };
}

function scalarGuards(value, schema) {
  const conditions = [];
  if (schema.type === 'integer') {
    const numeric = `System.Convert.ToInt64(${value})`;
    const lexical = `System.Text.RegularExpressions.Regex.IsMatch(${value}, "\\\\A-?(?:0|[1-9][0-9]*)\\\\z")`;
    const comparisons = [];
    if (own(schema, 'minimum')) comparisons.push(`${numeric} < ${schema.minimum}`);
    if (own(schema, 'maximum')) comparisons.push(`${numeric} > ${schema.maximum}`);
    if (own(schema, 'multipleOf')) comparisons.push(`${numeric} % ${schema.multipleOf} != 0`);
    if (schema.oneOf) comparisons.push(`(${schema.oneOf[0].enum.map(item => `${numeric} != ${item}`).join(' && ')} && ${numeric} < ${schema.oneOf[1].minimum})`);
    if (comparisons.length) conditions.push(`(!${lexical} || ${value}.Length > 17 || ${comparisons.join(' || ')})`);
  }
  if (own(schema, 'minLength') || own(schema, 'maxLength')) {
    // Collapse each surrogate pair using documented Regex.Replace/String members only.
    const length = `System.Text.RegularExpressions.Regex.Replace(${value}, "[\\\\uD800-\\\\uDBFF][\\\\uDC00-\\\\uDFFF]", "x").Length`;
    if (own(schema, 'minLength')) conditions.push(`${length} < ${schema.minLength}`);
    if (own(schema, 'maxLength')) conditions.push(`${length} > ${schema.maxLength}`);
  }
  if (own(schema, 'pattern')) conditions.push(`!System.Text.RegularExpressions.Regex.IsMatch(${value}, ${csharp(policyAsciiPattern(schema.pattern))})`);
  if (schema.enum) conditions.push(`(${schema.enum.map(item => `${value} != ${csharp(item)}`).join(' && ')})`);
  return conditions;
}

export function backendMappingPolicy(c, method, op, pathItem, id) {
  const mapping = op['x-cowork-backend'];
  if (mapping === undefined) return '';
  const graph = graphOrganizationOperation(c, method, op, pathItem);
  if (graph) return `<when condition="${xml(`@(context.Operation.Id == "${id}")`)}"><rewrite-uri template="${xml(`${graph.backendPath}?$select=id`)}" copy-unmatched-params="false" /></when>`;
  const invalid = () => { throw new Error(`${c.id}: invalid x-cowork-backend mapping; use GET, a literal path, fixed query values and inline scalar query parameters.`); };
  const plain = value => value && typeof value === 'object' && !Array.isArray(value);
  const name = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value);
  const scalar = value => (typeof value === 'string' || Number.isSafeInteger(value))
    && /^[A-Za-z0-9_.-]{1,100}$/.test(String(value));
  if (!plain(mapping) || method !== 'get' || op.requestBody || pathItem.parameters
    || Object.keys(mapping).some(key => !['path', 'query', 'parameterNames'].includes(key))
    || typeof mapping.path !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(mapping.path)
    || !plain(mapping.query) || !plain(mapping.parameterNames ?? {})) invalid();
  const parameters = op.parameters ?? [];
  if (!Array.isArray(parameters)) invalid();
  const targets = new Set();
  const setQuery = (key, value) => `<set-query-parameter name="${xml(key)}" exists-action="override"><value>${xml(value)}</value></set-query-parameter>`;
  const reserve = key => {
    if (!name(key) || key === c.apiKey?.queryParameterName || targets.has(key)) invalid();
    targets.add(key);
  };
  let policy = `<rewrite-uri template="${xml(mapping.path)}" copy-unmatched-params="false" />`;
  for (const [key, value] of Object.entries(mapping.query)) {
    reserve(key);
    if (!scalar(value)) invalid();
    policy += setQuery(key, value);
  }
  const sources = new Set();
  const conditions = [];
  for (const p of parameters) {
    if (!plain(p) || p.$ref || p.in !== 'query' || !name(p.name) || sources.has(p.name)
      || p.name === c.apiKey?.queryParameterName
      || !plain(p.schema) || p.schema.$ref || (p.style !== undefined && p.style !== 'form')
      || (p.allowReserved !== undefined && p.allowReserved !== false)) invalid();
    const enforced = enforcedScalarSchema(p.schema);
    if (!enforced || (enforced.default !== undefined && !scalar(enforced.default))) invalid();
    sources.add(p.name);
    const target = mapping.parameterNames?.[p.name] ?? p.name;
    reserve(target);
    const query = 'context.Request.OriginalUrl.Query';
    const present = `${query}.ContainsKey("${p.name}")`;
    const value = `${query}.GetValueOrDefault("${p.name}", "${enforced.default ?? ''}")`;
    conditions.push(`(${present} && ${query}["${p.name}"].Length != 1)`);
    if (p.required) conditions.push(`String.IsNullOrWhiteSpace(${value})`);
    const constrained = p.required || enforced.default !== undefined
      ? scalarGuards(value, enforced)
      : scalarGuards(`${query}["${p.name}"][0]`, enforced).map(condition => `(${present} && ${condition})`);
    conditions.push(...constrained);
    const action = setQuery(target, `@(${value})`);
    policy += p.required || enforced.default !== undefined ? action
      : `<choose><when condition="${xml(`@(${present})`)}">${action}</when></choose>`;
  }
  if (Object.keys(mapping.parameterNames ?? {}).some(key => !sources.has(key))) invalid();
  const guard = conditions.length
    ? `<choose><when condition="${xml(`@(${conditions.join(' || ')})`)}"><return-response><set-status code="400" reason="Invalid operation parameters" /></return-response></when></choose>` : '';
  return `<when condition="${xml(`@(context.Operation.Id == "${id}")`)}">${guard}${policy}</when>`;
}

const name = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,79}$' };
const scalar = { anyOf: [
  { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,100}$' },
  { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
] };
const text = maxLength => ({ type: 'string', minLength: 1, maxLength, pattern: '^[^\\u0000-\\u001f\\u007f]+$' });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const schema = object({
  title: text(100),
  apiKeyQueryParameter: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_.-]{0,99}$' },
  tools: { type: 'array', minItems: 1, maxItems: 100, items: object({
    name, description: text(1000),
    backendPath: { type: 'string', maxLength: 1024, pattern: '^/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]*$' },
    fixedQuery: { type: 'object', maxProperties: 20, propertyNames: name, additionalProperties: scalar },
    arguments: { type: 'array', maxItems: 30, items: object({
      name, description: text(1000), type: { enum: ['string', 'integer'] },
      required: { type: 'boolean' }, default: scalar, backendName: name,
    }, ['name', 'description', 'type', 'required']) },
  }) },
}, ['title', 'tools']);
const validate = new Ajv({ allErrors: true }).compile(schema);

export function prepareRestToolDocument(input) {
  const definition = structuredClone(input);
  const serialized = JSON.stringify(definition) ?? '';
  if (Buffer.byteLength(serialized) > 1048576) throw new Error('REST authoring input must be no larger than 1 MiB.');
  if (secretIssues(serialized)) throw new Error('REST authoring accepts nonsecret definitions only. Remove credential-like values; use Key Vault for API keys.');
  if (!validate(definition)) throw new Error(`Invalid REST authoring input: ${validate.errors.map(e => `${e.instancePath || '/'} ${e.message}`).join('; ')}`);
  if (!definition.title.trim()) throw new Error('REST authoring requires a nonblank title.');
  const paths = {}, operations = [], names = new Set();
  const connector = { id: 'authored-tools', apiKey: { queryParameterName: definition.apiKeyQueryParameter } };
  for (const tool of definition.tools) {
    if (!tool.description.trim() || names.has(tool.name)) throw new Error('REST tool names must be unique and descriptions nonblank.');
    names.add(tool.name);
    const parameters = tool.arguments.map(argument => {
      if (!argument.description.trim()) throw new Error('Each tool argument needs a nonblank description.');
      if (argument.default !== undefined && (argument.type === 'integer' ? !Number.isSafeInteger(argument.default) : typeof argument.default !== 'string')) {
        throw new Error('Argument defaults must match the declared string or integer type.');
      }
      return { name: argument.name, in: 'query', description: argument.description, required: argument.required,
        schema: { type: argument.type, ...(argument.default !== undefined ? { default: argument.default } : {}) } };
    });
    const mapping = { path: tool.backendPath, query: tool.fixedQuery,
      parameterNames: Object.fromEntries(tool.arguments.map(a => [a.name, a.backendName ?? a.name])) };
    const operation = { operationId: tool.name, description: tool.description, parameters,
      responses: { '200': { description: 'Backend response; verify status and response shape with the API owner.' } },
      'x-cowork-backend': mapping };
    backendMappingPolicy(connector, 'get', operation, {}, tool.name);
    const route = `/tools/${tool.name}`;
    paths[route] = { get: operation };
    operations.push({ operationId: tool.name, toolName: tool.name, method: 'GET', path: route,
      parameters, backendMapping: mapping });
  }
  const result = { contractVersion: restAuthoringVersion, evidence: 'user-authored-openapi',
    document: { openapi: '3.0.3', info: { title: definition.title, version: '1.0.0' }, paths },
    operationIds: definition.tools.map(t => t.name), operations,
    limitations: [
      'Only documented GET operations, literal backend paths and inline string/integer query arguments are authored.',
      'Fixed values/defaults are nonsecret scalars. Do not supply API keys, bearer tokens or credentials.',
      'Required/default metadata is authored intent, not proof of APIM runtime schema enforcement or backend behavior.',
      'Backend mappings and response status/shape require API-owner review. No response schema is inferred.',
      'No tools/list capture, deployment, consent or runtime acceptance is claimed. Generated tool-description files remain empty until real discovery.',
    ] };
  if (Buffer.byteLength(JSON.stringify(result)) > 1048576) throw new Error('Prepared REST authoring output must be no larger than 1 MiB.');
  return result;
}
