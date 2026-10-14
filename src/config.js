import { readFile, realpath, lstat } from 'node:fs/promises';

import path from 'node:path';

import { AsyncLocalStorage } from 'node:async_hooks';

import { fileURLToPath } from 'node:url';

import { assertSafeLocation } from './validation.js';

export const TOOLKIT_ROOT = fileURLToPath(new URL('..', import.meta.url));

const cliWorkspace = new AsyncLocalStorage();

// Per-invocation CLI capability, never process-global state or a public library default.
export async function withCliWorkspace(root, action) {
  if (root === undefined) return cliWorkspace.run(undefined, action);
  const trusted = await resolveWorkspaceRoot(root);
  if (isWithin(trusted, path.resolve(TOOLKIT_ROOT))
    || ['bin', 'src', 'schemas', 'examples', 'docs', '.github', 'node_modules'].some(dir => isWithin(path.join(TOOLKIT_ROOT, dir), trusted))) {
    throw new Error('The mutable workspace must not contain the installed toolkit or occupy its code, assets or dependencies.');
  }
  return cliWorkspace.run(trusted, action);
}

export const WORKSPACE_CONFIG_MAX_BYTES = 1024 * 1024;

export function safeHttpsUrl(value) {
  const url = new URL(value);
  if (value.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS URL without credentials, query parameters, or fragments.');
  }
  return value;
}

export async function readOpenApi(filename, operationIds) {
  const info = await lstat(filename);
  if (!info.isFile() || info.size > 10 * 1024 * 1024) throw new Error('OpenAPI input must be a regular JSON file smaller than 10 MB.');
  const document = JSON.parse(await readFile(filename, 'utf8'));
  return validateOpenApiDocument(document, operationIds);
}

export function validateOpenApiDocument(document, operationIds) {
  if (!document || typeof document !== 'object' || !/^3\.0\.\d+$/.test(document.openapi ?? '')) throw new Error('Use OpenAPI 3.0.x JSON. Convert YAML, Swagger 2, or OpenAPI 3.1 before import.');
  if (!document.info?.title || !document.info?.version || !document.paths || typeof document.paths !== 'object') {
    throw new Error('OpenAPI requires info.title, info.version, and paths.');
  }
  const operations = [];
  for (const [route, item] of Object.entries(document.paths)) {
    if (route.startsWith('x-')) continue;
    if (!route.startsWith('/') || !item || typeof item !== 'object' || Array.isArray(item)) throw new Error('OpenAPI paths must map slash-prefixed routes to path-item objects.');
    if (item.parameters !== undefined && !Array.isArray(item.parameters)) throw new Error('OpenAPI path-item parameters must be an array.');
    for (const [method, operation] of Object.entries(item)) {
      if (!['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].includes(method)) continue;
      if (!operation || typeof operation !== 'object' || typeof operation.operationId !== 'string' || !operation.operationId) throw new Error('Every OpenAPI operation must have a stable string operationId.');
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(operation.operationId)) throw new Error('OpenAPI operationId must be a safe ARM identifier (letters, numbers, dots, underscores, hyphens; up to 80 characters).');
      if (operation.parameters !== undefined && !Array.isArray(operation.parameters)) throw new Error('OpenAPI operation parameters must be an array.');
      operations.push({
        id: operation.operationId,
        method: method.toUpperCase(),
        path: route,
        summary: operation.summary ?? '',
        parameters: [...(item.parameters ?? []), ...(operation.parameters ?? [])],
        requestBody: operation.requestBody,
      });
    }
  }
  if (!operations.length) throw new Error('OpenAPI document contains no operations.');
  if (new Set(operations.map(o => o.id)).size !== operations.length) throw new Error('OpenAPI operationId values must be unique.');
  if (operationIds?.some(id => !operations.some(o => o.id === id))) throw new Error('Selected operationIds must exist in the OpenAPI document.');
  // APIM import must not fetch unaudited remote references.
  function checkRefs(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string' && !value.$ref.startsWith('#/')) throw new Error('Bundle external OpenAPI references locally before import.');
    for (const nested of Object.values(value)) checkRefs(nested);
  }
  checkRefs(document);
  return { document, operations };
}

export function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertUnambiguousWorkspacePath(value) {
  if (process.platform !== 'win32') return;
  const segments = value.slice(path.parse(value).root.length).split(path.sep);
  if (segments.some(segment => /[. ]$|[<>:"|?*\x00-\x1f]/.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    throw new Error('Workspace paths must not contain Windows device names, alternate streams, or ambiguous path components.');
  }
}

export async function resolveWorkspaceRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error('--workspace-root must be an absolute existing directory.');
  }
  const root = path.resolve(value);
  assertUnambiguousWorkspacePath(root);
  if (root === path.parse(root).root) throw new Error('--workspace-root must not be a filesystem root.');
  await assertSafeLocation(root, root);
  if (!(await lstat(root)).isDirectory()) throw new Error('--workspace-root must be an existing directory.');
  return root;
}

export async function assertProjectPath(target, { allowRoot = false, workspaceRoot } = {}) {
  workspaceRoot ??= cliWorkspace.getStore();
  const resolved = path.resolve(target);
  if (workspaceRoot !== undefined) {
    const root = await resolveWorkspaceRoot(workspaceRoot);
    assertUnambiguousWorkspacePath(resolved);
    if (!isWithin(root, resolved) || (!allowRoot && path.relative(root, resolved) === '')) {
      throw new Error('Path must be inside --workspace-root, not the workspace root itself.');
    }
    await assertSafeLocation(root, resolved);
    return resolved;
  }
  const root = await realpath(TOOLKIT_ROOT);
  if (!isWithin(root, resolved) || (!allowRoot && path.relative(root, resolved) === '')) {
    throw new Error(`Project output must be inside ${TOOLKIT_ROOT}, not the toolkit root itself.`);
  }
  // Resolve the nearest existing ancestor to reject junction/symlink escapes.
  let ancestor = resolved;
  while (true) {
    try {
      const actual = await realpath(ancestor);
      if (!isWithin(root, actual)) throw new Error('Output path escapes the toolkit through a symbolic link or junction.');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  return resolved;
}

export const azureSchema = {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "apimMode": {
      "enum": [
        "new",
        "existing"
      ]
    },
    "subscriptionId": {
      "type": "string",
      "format": "uuid"
    },
    "tenantId": {
      "type": "string",
      "format": "uuid"
    },
    "resourceGroup": {
      "type": "string",
      "pattern": "^[A-Za-z0-9_-][A-Za-z0-9_.()-]{0,88}[A-Za-z0-9_-]$"
    },
    "location": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9]+$"
    },
    "apimName": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{0,48}[a-z0-9]$"
    },
    "publisherEmail": {
      "type": "string",
      "format": "email"
    },
    "publisherName": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100
    },
    "sku": {
      "enum": [
        "Developer",
        "Basicv2",
        "Standardv2",
        "Premium"
      ]
    },
    "keyVaultName": {
      "type": "string",
      "pattern": "^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$"
    },
    "resourceGroupMode": {
      "enum": [
        "new",
        "existing"
      ]
    },
    "keyVaultMode": {
      "enum": [
        "new",
        "existing"
      ]
    }
  },
  "required": [
    "subscriptionId",
    "tenantId",
    "resourceGroup",
    "apimName"
  ],
  "if": {
    "properties": {
      "apimMode": {
        "const": "existing"
      }
    },
    "required": [
      "apimMode"
    ]
  },
  "then": {},
  "else": {
    "required": [
      "location",
      "publisherEmail",
      "publisherName",
      "sku"
    ]
  }
};

export const apiKeySchema = {
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "secretIdentifier": {
      "type": "string",
      "pattern": "^https://[a-zA-Z0-9-]{3,24}\\.vault\\.azure\\.net/secrets/[a-zA-Z0-9-]+$"
    },
    "headerName": {
      "type": "string",
      "pattern": "^[A-Za-z][A-Za-z0-9-]{0,99}$"
    },
    "queryParameterName": {
      "type": "string",
      "pattern": "^[A-Za-z][A-Za-z0-9_.-]{0,99}$"
    }
  },
  "required": [
    "secretIdentifier"
  ],
  "oneOf": [
    {
      "required": [
        "headerName"
      ]
    },
    {
      "required": [
        "queryParameterName"
      ]
    }
  ]
};

export const operationIdsSchema = {
  "type": "array",
  "minItems": 1,
  "maxItems": 100,
  "uniqueItems": true,
  "items": {
    "type": "string",
    "minLength": 1,
    "maxLength": 80
  }
};
