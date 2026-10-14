import Ajv from 'ajv';
import { boundedSnapshot, metadataDigest, requireMetadata } from './anonymous-metadata.js';

const equal = (a, b) => JSON.stringify(boundedSnapshot(a)) === JSON.stringify(boundedSnapshot(b));
const reserved = /^(?:op|key|api[-_]?key|authorization|cookies?|password|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|url|uri|host|endpoint|method)$/i;
const scalarKeys = new Set(['type', 'minimum', 'maximum', 'minLength', 'maxLength', 'enum', 'description', 'title']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The existing REST compiler validates the routing language; this narrows its proof-eligible subset.
export function planMappedKeyGet(config, original, tool, selection) {
  const apiKey = config.connectors[0].apiKey;
  requireMetadata(apiKey?.queryParameterName && !apiKey.headerName && original?.backendMapping
    && original.method === 'GET' && !original.requestBody, 'READ_ONLY_REVIEW_REQUIRED');
  const parameters = original.parameters;
  requireMetadata(Array.isArray(parameters) && parameters.length > 0 && parameters.length <= 8
    && parameters.every(p => p.in === 'query' && p.required === true && !reserved.test(p.name)
      && p.name.toLowerCase() !== apiKey.queryParameterName.toLowerCase()
      && !reserved.test(original.backendMapping.parameterNames?.[p.name] ?? p.name)
      && object(p.schema) && ['integer', 'string'].includes(p.schema.type)
      && Object.keys(p.schema).every(key => scalarKeys.has(key))), 'PROOF_SCHEMA_UNSUPPORTED');
  const names = parameters.map(p => p.name).sort();
  requireMetadata(new Set(names).size === names.length && object(selection.arguments)
    && equal(Object.keys(selection.arguments).sort(), names), 'PROOF_ARGUMENTS_INVALID');
  const schema = tool.inputSchema;
  requireMetadata(object(schema) && schema.type === 'object' && object(schema.properties)
    && Array.isArray(schema.required) && equal([...schema.required].sort(), names)
    && equal(Object.keys(schema.properties).sort(), names)
    && (schema.additionalProperties === undefined || typeof schema.additionalProperties === 'boolean')
    && Object.keys(schema).every(key => ['type', 'properties', 'required', 'additionalProperties', 'description', 'title'].includes(key))
    && parameters.every(p => object(schema.properties[p.name]) && schema.properties[p.name].type === p.schema.type
      && Object.keys(schema.properties[p.name]).every(key => scalarKeys.has(key))), 'PROOF_SCHEMA_UNSUPPORTED');
  const declared = { type: 'object', additionalProperties: false, required: names,
    properties: Object.fromEntries(parameters.map(p => [p.name, p.schema])) };
  let valid;
  try { valid = new Ajv({ strict: true, validateFormats: false }).compile(declared)(selection.arguments); }
  catch { requireMetadata(false, 'PROOF_SCHEMA_UNSUPPORTED'); }
  requireMetadata(valid && parameters.every(p => p.schema.type === 'integer'
    ? Number.isSafeInteger(selection.arguments[p.name]) && selection.arguments[p.name] > 0
    : typeof selection.arguments[p.name] === 'string' && /^[A-Za-z0-9][A-Za-z0-9_. -]{0,255}$/.test(selection.arguments[p.name])),
  'PROOF_ARGUMENTS_INVALID');
  const backendQuery = { ...original.backendMapping.query };
  for (const p of parameters) backendQuery[original.backendMapping.parameterNames?.[p.name] ?? p.name] = selection.arguments[p.name];
  const result = { parameters, backendMapping: original.backendMapping, backendQuery,
    argumentsDigest: metadataDigest(boundedSnapshot(selection.arguments)),
    keyReference: { secretIdentifier: apiKey.secretIdentifier,
      queryParameterName: apiKey.queryParameterName, identity: 'SystemAssigned', tenantId: config.azure.tenantId } };
  if (selection.responseAssertion !== undefined) {
    requireMetadata(selection.responseAssertion === 'legiscan-bill-v1'
      && new URL(config.connectors[0].endpoint).href === 'https://api.legiscan.com/'
      && original.backendMapping.path === '/' && equal(original.backendMapping.query, { op: 'getBill' })
      && equal(names, ['bill_id']) && original.backendMapping.parameterNames?.bill_id === 'id'
      && Number.isSafeInteger(selection.arguments.bill_id), 'READ_ONLY_REVIEW_REQUIRED');
    result.responseAssertion = { kind: 'legiscan-bill-v1', billId: selection.arguments.bill_id };
  }
  return boundedSnapshot(result);
}

// APIM can promote required query arguments into URL-template parameters. Both forms must bind exactly.
export function mappedOperationMatches(operation, mapping, verifySchema = () => false) {
  const parts = operation.urlTemplate?.split('?');
  if (!parts || parts.length > 2 || parts[0] !== mapping.path) return false;
  const parameters = new Map(mapping.parameters.map(p => [p.name, p]));
  const placeholders = new Set();
  if (parts.length === 2) for (const pair of parts[1].split('&')) {
    const match = /^([A-Za-z][A-Za-z0-9_]*)=\{([A-Za-z][A-Za-z0-9_]*)\}$/.exec(pair);
    if (!match || match[1] !== match[2] || !parameters.has(match[1]) || placeholders.has(match[1])) return false;
    placeholders.add(match[1]);
  }
  if (!Array.isArray(operation.templateParameters)
    || operation.request?.queryParameters !== undefined && !Array.isArray(operation.request.queryParameters)) return false;
  const seen = new Set();
  for (const [items, template] of [[operation.templateParameters, true], [operation.request?.queryParameters ?? [], false]]) {
    for (const actual of items) {
      const expected = parameters.get(actual?.name);
      if (!expected || seen.has(actual.name) || placeholders.has(actual.name) !== template
        || actual.type !== expected.schema.type || (template ? actual.required !== undefined && actual.required !== true : actual.required !== true)
        || (actual.schemaId != null || actual.typeName != null) && !verifySchema(actual, expected)
        || actual.defaultValue !== undefined && actual.defaultValue !== null
        || actual.values !== undefined && (!Array.isArray(actual.values) || actual.values.length > 0
          && !equal(actual.values, expected.schema.enum?.map(String) ?? []))) return false;
      seen.add(actual.name);
    }
  }
  return seen.size === parameters.size;
}

export function mappedSchemaReference(parameter) {
  return typeof parameter.schemaId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(parameter.schemaId)
    && typeof parameter.typeName === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(parameter.typeName);
}

export function mappedLinkedSchemaMatches(resource, parameter, expected, prefix) {
  if (!mappedSchemaReference(parameter) || typeof resource?.id !== 'string'
    || resource.id.toLowerCase() !== `${prefix}${parameter.schemaId}`.toLowerCase()
    || resource.name !== parameter.schemaId
    || resource.properties?.contentType !== 'application/vnd.oai.openapi.components+json') return false;
  const document = resource.properties.document;
  if (!object(document) || Object.keys(document).some(key => key !== 'components')
    || !object(document.components) || Object.keys(document.components).some(key => key !== 'schemas')) return false;
  const schemas = document.components.schemas;
  if (!object(schemas) || !Object.hasOwn(schemas, parameter.typeName)) return false;
  const schema = schemas[parameter.typeName];
  if (!object(schema) || schema['x-apim-inline'] !== true
    || Object.keys(schema).some(key => !scalarKeys.has(key) && key !== 'x-apim-inline')
    || ['description', 'title'].some(key => schema[key] !== undefined && typeof schema[key] !== 'string')) return false;
  const semantic = value => Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['description', 'title', 'x-apim-inline'].includes(key)));
  return equal(semantic(schema), semantic(expected.schema));
}
