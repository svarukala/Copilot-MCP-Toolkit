import { createHash } from 'node:crypto';

import { isIP } from 'node:net';

export const anonymousLimits = Object.freeze({
  buildBytes: 1048576, captureBytes: 524288, responseBytes: 262144,
  totalResponseBytes: 1048576, tools: 1000, pages: 10, timeoutMs: 15000,
});

export const savedJson = value => `${JSON.stringify(value, null, 2)}\n`;

export const metadataDigest = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

export function requireMetadata(condition, code) {
  if (!condition) {
    const error = new Error(code);
    error.name = 'AnonymousMetadataError';
    error.code = code;
    throw error;
  }
}

function canonical(value, depth = 0, budget = { nodes: 0, bytes: 0 }) {
  requireMetadata(depth < 64, 'LIMIT');
  requireMetadata(++budget.nodes <= 50000, 'LIMIT');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    budget.bytes += typeof value === 'string' ? Buffer.byteLength(value) : 4;
    requireMetadata(budget.bytes <= anonymousLimits.buildBytes, 'LIMIT');
    return value;
  }
  if (typeof value === 'number') { requireMetadata(Number.isFinite(value), 'INVALID_CONFIG'); return value; }
  requireMetadata(value && typeof value === 'object'
    && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null), 'INVALID_CONFIG');
  if (Array.isArray(value)) {
    requireMetadata(value.length <= 50000 - budget.nodes, 'LIMIT');
    const result = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      requireMetadata(descriptor && Object.hasOwn(descriptor, 'value'), 'INVALID_CONFIG');
      result.push(canonical(descriptor.value, depth + 1, budget));
    }
    return result;
  }
  const result = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireMetadata(descriptor && Object.hasOwn(descriptor, 'value'), 'INVALID_CONFIG');
    budget.bytes += Buffer.byteLength(key);
    requireMetadata(budget.bytes <= anonymousLimits.buildBytes, 'LIMIT');
    result[key] = canonical(descriptor.value, depth + 1, budget);
  }
  return result;
}

export function boundedSnapshot(value, maximum = anonymousLimits.buildBytes) {
  const normalized = canonical(value);
  requireMetadata(Buffer.byteLength(savedJson(normalized)) <= maximum, 'LIMIT');
  return JSON.parse(JSON.stringify(normalized));
}

export function normalizeAnonymousEndpoint(value) {
  requireMetadata(typeof value === 'string' && value.length <= 2048 && value === value.trim(), 'ENDPOINT_BLOCKED');
  let url;
  try { url = new URL(value); } catch { requireMetadata(false, 'ENDPOINT_BLOCKED'); }
  requireMetadata(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
    && !value.includes('?') && !value.includes('#') && !value.includes('\\') && !/[\u0000-\u0020\u007f]/.test(value)
    && (!url.port || url.port === '443'), 'ENDPOINT_BLOCKED');
  const hostname = url.hostname;
  requireMetadata(!isIP(hostname.replace(/^\[|\]$/g, '')) && hostname.includes('.') && !hostname.endsWith('.')
    && !/(?:^|\.)(?:localhost|local|internal|test|invalid|home|lan)$/.test(hostname)
    && !/(?:^|\.)metadata(?:\.|$)/.test(hostname), 'ENDPOINT_BLOCKED');
  return url.href;
}
