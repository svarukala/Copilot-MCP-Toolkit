import Ajv from 'ajv';
import { validateToolDescription } from './mcp-tools.js';
import { isPolicyLiteralRepresentable, policyAsciiPattern, integerEnumRangeUnion } from './rest-authoring.js';

export const restCaptureCompatibilityVersion = 2;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const annotations = new Set(['title', 'description', 'examples', '$comment']);
const scalarKeys = new Set(['type', 'default', 'enum', 'minimum', 'maximum', 'exclusiveMinimum',
  'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern']);
const rootKeys = new Set(['type', 'properties', 'required', 'additionalProperties', '$schema', ...annotations]);
const parameterKeys = new Set(['name', 'in', 'required', 'schema', 'description', 'example', 'examples',
  'style', 'explode', 'deprecated', 'allowReserved']);
const types = new Set(['string', 'integer', 'number', 'boolean']);
const schemaValidator = new Ajv({ strict: false, logger: false });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = values => [...values].sort();
const mappedProjection = value => plain(value) && typeof value.path === 'string'
  && plain(value.query) && plain(value.parameterNames ?? {})
  && Object.keys(value).every(key => ['path', 'query', 'parameterNames'].includes(key));
const scalarValue = (type, value) => type === 'string' ? typeof value === 'string'
  : type === 'boolean' ? typeof value === 'boolean'
    : typeof value === 'number' && Number.isFinite(value) && (type !== 'integer' || Number.isSafeInteger(value));

function bounded(value) {
  const stack = [[value, 0]], seen = new Set();
  let nodes = 0;
  while (stack.length) {
    const [item, depth] = stack.pop();
    if (++nodes > 50000 || depth > 40) throw new Error('REST compatibility input limit.');
    if (item && typeof item === 'object') {
      if (seen.has(item)) throw new Error('REST compatibility inputs must be JSON trees.');
      seen.add(item);
      stack.push(...Object.values(item).map(child => [child, depth + 1]));
    }
  }
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 2 * 1024 * 1024) throw new Error('REST compatibility input limit.');
}

function scalarSchema(schema) {
  if (!plain(schema) || !types.has(schema.type)
    || Object.keys(schema).some(key => !scalarKeys.has(key) && !annotations.has(key) && key !== 'oneOf')
    || !schemaValidator.validateSchema(schema)) return null;
  let enumValues = schema.enum;
  const union = integerEnumRangeUnion(schema);
  if (own(schema, 'oneOf') && !union) {
    if (enumValues !== undefined || !Array.isArray(schema.oneOf) || !schema.oneOf.length) return null;
    enumValues = schema.oneOf.map(choice => {
      if (!plain(choice)) return undefined;
      const keys = Object.keys(choice).filter(key => !annotations.has(key));
      if (keys.includes('type') && choice.type === schema.type) keys.splice(keys.indexOf('type'), 1);
      if (keys.length === 1 && keys[0] === 'const') return choice.const;
      if (keys.length === 1 && keys[0] === 'enum' && Array.isArray(choice.enum) && choice.enum.length === 1) return choice.enum[0];
      return undefined;
    });
    if (enumValues.some(value => value === undefined)
      || new Set(enumValues.map(value => JSON.stringify(value))).size !== enumValues.length) return null;
  }
  // OpenAPI 3.0 uses boolean exclusive bounds; captured JSON Schema uses numeric bounds.
  // Both forms are deliberately outside v1 rather than being silently translated.
  if (own(schema, 'exclusiveMinimum') || own(schema, 'exclusiveMaximum')) return null;
  if (own(schema, 'default') && !scalarValue(schema.type, schema.default)) return null;
  if (enumValues !== undefined && (!enumValues.length || enumValues.length > 100
    || enumValues.some(v => !scalarValue(schema.type, v)))) return null;
  if (['minimum', 'maximum', 'multipleOf'].some(k => own(schema, k)) && !['integer', 'number'].includes(schema.type)) return null;
  if (['minLength', 'maxLength', 'pattern'].some(k => own(schema, k)) && schema.type !== 'string') return null;
  if (schema.minimum > schema.maximum || schema.minLength > schema.maxLength) return null;
  const result = Object.fromEntries([...scalarKeys].sort().filter(k => k === 'enum' ? enumValues !== undefined : own(schema, k)).map(k =>
    [k, k === 'enum' ? [...enumValues].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : schema[k]]));
  return union ? { ...result, oneOf: union } : result;
}

function projectionEnforces(schema, key) {
  if (!['string', 'integer'].includes(schema.type)) return false;
  if (key === 'default') return schema.type === 'integer'
    ? Number.isSafeInteger(schema.default)
    : typeof schema.default === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(schema.default);
  if (key === 'enum') return Array.isArray(schema.enum) && schema.enum.length <= 100
    && schema.enum.every(value => schema.type === 'integer'
      ? Number.isSafeInteger(value)
      : isPolicyLiteralRepresentable(value));
  if (key === 'oneOf') return integerEnumRangeUnion(schema) !== null;
  if (key === 'pattern') return schema.type === 'string' && policyAsciiPattern(schema.pattern) !== null;
  if (['minLength', 'maxLength'].includes(key)) return schema.type === 'string'
    && Number.isSafeInteger(schema[key]) && schema[key] >= 0;
  return schema.type === 'integer' && ['minimum', 'maximum', 'multipleOf'].includes(key)
    && Number.isSafeInteger(schema[key]) && (key !== 'multipleOf' || schema[key] > 0);
}

/** Conservative equality of a supported input-contract subset, not general schema implication. */
export function compareRestCapture(operations, metadata) {
  bounded(operations);
  bounded(metadata);
  if (!Array.isArray(operations) || !operations.length || operations.length > 100
    || operations.some(o => !plain(o) || typeof o.toolName !== 'string'
      || !/^[A-Za-z0-9_.-]{1,128}$/.test(o.toolName) || !Array.isArray(o.parameters))
    || new Set(operations.map(o => o.toolName)).size !== operations.length) throw new Error('Invalid REST operation review.');
  if (!Array.isArray(metadata?.tools) || metadata.tools.length > 100) throw new Error('REST capture tool limit.');
  validateToolDescription(metadata);
  const issues = [], checks = [], acceptedLosses = [];
  const add = (tool, code, argument, source) => issues.push({ tool, code,
    ...(typeof argument === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(argument) ? { argument } : {}),
    ...(source ? { source } : {}) });
  const observed = new Map(metadata.tools.map(t => [t.name, t]));
  const expectedNames = new Set(operations.map(o => o.toolName));
  for (const tool of metadata.tools) if (!expectedNames.has(tool.name)) add(tool.name, 'unexpected-tool');
  for (const operation of operations) {
    const start = issues.length, name = operation.toolName, tool = observed.get(name);
    if (!tool) { add(name, 'missing-tool'); checks.push({ tool: name, status: 'blocked' }); continue; }
    const expected = new Map(), declared = new Set(), required = [];
    const projected = mappedProjection(operation.backendMapping);
    if (own(operation, 'backendMapping') && operation.backendMapping !== null && !projected) {
      add(name, 'unsupported-schema', undefined, 'rest');
    }
    if (own(operation, 'requestBody')) add(name, 'unsupported-schema', undefined, 'rest');
    for (const p of operation.parameters) {
      const argument = typeof p?.name === 'string' && p.name.length <= 128 ? p.name : undefined;
      if (argument) declared.add(argument);
      const schema = scalarSchema(p?.schema);
      if (!plain(p) || argument === undefined || !argument || !['path', 'query'].includes(p.in)
        || Object.keys(p).some(k => !parameterKeys.has(k)) || expected.has(argument)
        || (p.required !== undefined && typeof p.required !== 'boolean')
        || (p.in === 'path' && p.required !== true)
        || (p.style !== undefined && p.style !== (p.in === 'query' ? 'form' : 'simple'))
        || (p.explode !== undefined && typeof p.explode !== 'boolean')
        || (p.allowReserved !== undefined && p.allowReserved !== false) || !schema) {
        add(name, 'unsupported-schema', argument, 'rest');
        continue;
      }
      expected.set(argument, schema);
      if (p.required === true) required.push(argument);
    }
    const root = tool.inputSchema, properties = root.properties ?? {};
    if (Object.keys(root).some(k => !rootKeys.has(k))
      || (own(root, 'additionalProperties') && typeof root.additionalProperties !== 'boolean')) {
      add(name, 'unsupported-schema', undefined, 'capture');
    }
    for (const [argument, value] of Object.entries(properties)) {
      if (!declared.has(argument)) add(name, 'unexpected-argument', argument);
      const schema = scalarSchema(value);
      if (!schema) { add(name, 'unsupported-schema', argument, 'capture'); continue; }
      const wanted = expected.get(argument);
      if (!wanted) continue;
      if (wanted.type !== schema.type) add(name, 'type-mismatch', argument);
      if (!same(wanted.default, schema.default) || own(wanted, 'default') !== own(schema, 'default')) {
        if (projected && own(wanted, 'default') && !own(schema, 'default')
          && projectionEnforces(wanted, 'default')) {
          acceptedLosses.push({ tool: name, argument, facet: 'default', observed: 'omitted',
            enforcement: 'generated-apim-policy' });
        } else add(name, 'default-mismatch', argument);
      }
      const constraintKeys = [...scalarKeys, 'oneOf'].filter(key => !['type', 'default'].includes(key));
      for (const key of constraintKeys) {
        const hasWanted = own(wanted, key), hasObserved = own(schema, key);
        if (hasWanted === hasObserved && (!hasWanted || same(wanted[key], schema[key]))) continue;
        if (projected && hasWanted && !hasObserved && projectionEnforces(wanted, key)) {
          acceptedLosses.push({ tool: name, argument, facet: 'constraint', keyword: key,
            observed: 'omitted', enforcement: 'generated-apim-policy' });
        } else add(name, 'constraint-mismatch', argument);
      }
    }
    for (const argument of expected.keys()) if (!own(properties, argument)) add(name, 'missing-argument', argument);
    if (expected.size === declared.size && !same(sorted(required), sorted(root.required ?? []))) add(name, 'required-mismatch');
    const losses = acceptedLosses.filter(loss => loss.tool === name).length;
    checks.push({ tool: name, status: issues.length !== start ? 'blocked'
      : losses ? 'compatible-with-reviewed-loss' : 'compatible' });
  }
  const compatible = issues.length === 0;
  const status = compatible && acceptedLosses.length ? 'compatible-with-reviewed-loss'
    : compatible ? 'compatible' : 'blocked';
  return {
    contractVersion: restCaptureCompatibilityVersion, evidence: 'local-contract-comparison',
    status, compatible, checks, issues, acceptedLosses,
    limitations: [
      'Strictly compares declared argument names, scalar types and required sets. Defaults and supported constraints must also match unless a mapped native-APIM operation has generated policy enforcement for an explicitly listed omitted projection facet.',
      'Inline query/path scalar parameters only. Bodies, references, general composition, nullable/format and unknown validation keywords require separate support and block application.',
      'Descriptions and other supported annotations may differ. Root additionalProperties may be absent, true or false; unknown-property runtime enforcement is not attested.',
      'Accepted losses list only omitted defaults or constraints enforced by the generated mapped-operation APIM policy. Conflicting observed values, unmapped operations and unsupported schemas remain blocked.',
      'No metadata is rewritten or fabricated. Review approval binds the complete comparison, including accepted projection losses.',
      'No claim about authorization, output schemas, fixed routing, deployment freshness, packaging provenance or actual tool behavior.',
    ],
  };
}
