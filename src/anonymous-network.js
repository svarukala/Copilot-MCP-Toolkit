import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { normalizeAnonymousEndpoint, requireMetadata } from './anonymous-metadata.js';

export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  // Only ordinary IPv6 global unicast; exclude transition, protocol and documentation ranges.
  const [first, second] = address.toLowerCase().split(':');
  const subnet = parseInt(second || '0', 16);
  const prefix = parseInt(first, 16);
  return prefix >= 0x2000 && prefix <= 0x3fff && prefix !== 0x2002
    && !(prefix === 0x2001 && subnet <= 0x1ff)
    && !(prefix === 0x2001 && subnet === 0xdb8)
    && !(prefix === 0x3fff && subnet <= 0xfff);
}

// Internal dependency seam, never exported from the package. Production always uses OS DNS and direct TLS.
export function publicHttpsTransport({ lookupImpl = lookup, requestImpl = request, requestPolicy, allowErrorStatus = false } = {}) {
  return async (endpoint, options) => {
    const url = requestPolicy ? requestPolicy(endpoint, options) : new URL(normalizeAnonymousEndpoint(endpoint));
    requireMetadata((options.method === 'POST' || (requestPolicy && options.method === 'GET'))
      && options.redirect === 'error' && !options.signal?.aborted, 'NETWORK_BLOCKED');
    let remove;
    const answers = await Promise.race([
      lookupImpl(url.hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        const abort = () => { const error = new Error('ABORTED'); error.code = 'ABORTED'; reject(error); };
        options.signal?.addEventListener('abort', abort, { once: true });
        remove = () => options.signal?.removeEventListener('abort', abort);
        if (options.signal?.aborted) abort();
      }),
    ]).finally(() => remove?.());
    requireMetadata(!options.signal?.aborted && Array.isArray(answers) && answers.length > 0
      && answers.every(item => isPublicAddress(item.address) && item.family === isIP(item.address)), 'NETWORK_BLOCKED');
    const pinned = answers[0];
    return new Promise((resolve, reject) => {
      // Pin the validated DNS address in the socket lookup, retaining hostname for TLS and Host.
      const req = requestImpl(url, {
        method: options.method, headers: options.headers, signal: options.signal, agent: false,
        rejectUnauthorized: true, servername: url.hostname,
        lookup: (_hostname, lookupOptions, callback) => {
          if (lookupOptions?.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
      }, response => {
        if ((response.statusCode < 200 || response.statusCode >= 300)
          && !(allowErrorStatus && response.statusCode >= 400 && response.statusCode < 500)) {
          response.destroy();
          const error = new Error('NETWORK_BLOCKED');
          error.code = 'NETWORK_BLOCKED';
          if (allowErrorStatus) error.httpStatus = response.statusCode;
          reject(error);
          return;
        }
        const headers = new Headers();
        for (const key of ['content-type', 'mcp-session-id']) {
          if (typeof response.headers[key] === 'string') headers.set(key, response.headers[key]);
        }
        if (response.statusCode === 204) {
          response.destroy();
          resolve(new Response(null, { status: 204, headers }));
        } else resolve(new Response(Readable.toWeb(response), { status: response.statusCode, headers }));
      });
      req.on('error', () => {
        const error = new Error(options.signal?.aborted ? 'ABORTED' : 'NETWORK_BLOCKED');
        error.code = error.message;
        reject(error);
      });
      req.end(options.body);
    });
  };
}
