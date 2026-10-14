import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';

const schemaValidators = {
  'http://json-schema.org/draft-07/schema': new Ajv({ strict: false, logger: false }),
  'https://json-schema.org/draft/2020-12/schema': new Ajv2020({ strict: false, logger: false }),
};

export const toolSchemaIssues = Object.freeze([
  'tools-container', 'tools-empty', 'tool-object', 'tool-name', 'tool-name-duplicate', 'tool-description',
  'input-root', 'input-properties', 'input-required', 'input-dialect-type', 'input-dialect-unsupported', 'input-schema-invalid',
  'output-root', 'output-dialect-type', 'output-dialect-unsupported', 'output-schema-invalid',
]);

function invalidToolSchema(message, toolSchemaIssue) {
  throw Object.assign(new Error(message), { toolSchemaIssue });
}

function validateJsonSchema(schema, label, kind) {
  if (schema.$schema !== undefined && typeof schema.$schema !== 'string') {
    invalidToolSchema(`${label}: $schema must be a supported JSON Schema URI.`, `${kind}-dialect-type`);
  }
  const dialect = schema.$schema?.replace(/#$/, '') ?? 'https://json-schema.org/draft/2020-12/schema';
  const validator = Object.hasOwn(schemaValidators, dialect) ? schemaValidators[dialect] : undefined;
  const message = `${label}: invalid JSON Schema or unsupported dialect; use draft-07 or 2020-12.`;
  if (!validator) invalidToolSchema(message, `${kind}-dialect-unsupported`);
  let valid;
  try { valid = validator.validateSchema(schema); }
  catch (error) { throw Object.assign(error, { toolSchemaIssue: `${kind}-schema-invalid` }); }
  if (!valid) {
    invalidToolSchema(message, `${kind}-schema-invalid`);
  }
}

export function validateToolDescription(value, { allowEmpty = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.tools)) {
    invalidToolSchema('Tool description must be an object containing a tools array.', 'tools-container');
  }
  if (!allowEmpty && value.tools.length === 0) {
    invalidToolSchema('Tools array is empty. Populate it from the MCP server tools/list response before packaging; at least one real tool definition is required.', 'tools-empty');
  }
  const names = new Set();
  for (const tool of value.tools) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) invalidToolSchema('Every tool definition must be an object.', 'tool-object');
    if (typeof tool.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) {
      invalidToolSchema('Every tool requires a name containing 1-128 letters, numbers, underscores, dots, or hyphens.', 'tool-name');
    }
    if (names.has(tool.name)) invalidToolSchema(`Duplicate tool name: ${tool.name}.`, 'tool-name-duplicate');
    names.add(tool.name);
    if (tool.description !== undefined && (typeof tool.description !== 'string' || !tool.description.trim())) {
      invalidToolSchema(`Tool ${tool.name}: description must be a nonempty string when provided.`, 'tool-description');
    }
    const schema = tool.inputSchema;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') {
      invalidToolSchema(`Tool ${tool.name}: inputSchema must be a JSON Schema object with type "object".`, 'input-root');
    }
    if (schema.properties !== undefined && (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties))) {
      invalidToolSchema(`Tool ${tool.name}: inputSchema.properties must be an object.`, 'input-properties');
    }
    if (schema.required !== undefined && (!Array.isArray(schema.required)
      || schema.required.some(key => typeof key !== 'string')
      || new Set(schema.required).size !== schema.required.length)) {
      invalidToolSchema(`Tool ${tool.name}: inputSchema.required must be an array of unique strings.`, 'input-required');
    }
    validateJsonSchema(schema, `Tool ${tool.name} inputSchema`, 'input');
    if (tool.outputSchema !== undefined) {
      if (!tool.outputSchema || typeof tool.outputSchema !== 'object' || Array.isArray(tool.outputSchema)
        || tool.outputSchema.type !== 'object') {
        invalidToolSchema(`Tool ${tool.name}: outputSchema must be a JSON Schema object with type "object".`, 'output-root');
      }
      validateJsonSchema(tool.outputSchema, `Tool ${tool.name} outputSchema`, 'output');
    }
  }
  return value;
}
