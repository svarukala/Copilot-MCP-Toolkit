import { request } from 'node:http';
import { dockerSocketSchema, dockerError } from './docker-engine.js';

const maximum = 512 * 1024 * 1024;
const check = (ok, code = 'DOCKER_RESPONSE_INVALID') => { if (!ok) throw dockerError(code); };

// Internal binary companion to the JSON engine transport. Never invokes a CLI,
// reads Docker contexts, mounts its socket in a container, or imports credentials.
export async function executionDockerRequest(socketPath, route, {
  method = 'GET', body, headers = {}, signal, timeoutMs = 60000, maxBytes = 1048576,
} = {}, { requestImpl = request } = {}) {
  check(new RegExp(dockerSocketSchema.pattern).test(socketPath)
    && /^\/(?:version|v1\.44\/[^\r\n]*)$/.test(route), 'DOCKER_ENDPOINT_INVALID');
  check(Number.isInteger(maxBytes) && maxBytes > 0 && maxBytes <= maximum + 2048);
  check(!signal?.aborted, 'DOCKER_ABORTED');
  const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  check(!payload || payload.length <= maximum + 2048, 'DOCKER_INPUT_LIMIT');
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await new Promise((resolve, reject) => {
      const req = requestImpl({ socketPath, path: route, method, agent: false, signal: combined,
        headers: { ...headers, ...(payload ? { 'Content-Length': payload.length,
          'Content-Type': Buffer.isBuffer(body) ? 'application/x-tar' : 'application/json' } : {}) } }, response => {
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > maxBytes) req.destroy(dockerError('DOCKER_OUTPUT_LIMIT'));
          else chunks.push(Buffer.from(chunk));
        });
        response.on('error', () => reject(dockerError('DOCKER_RESPONSE_UNKNOWN')));
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }));
      });
      req.on('error', error => reject(dockerError(combined.aborted ? 'DOCKER_ABORTED'
        : error.code === 'DOCKER_OUTPUT_LIMIT' ? error.code : 'DOCKER_RESPONSE_UNKNOWN')));
      req.end(payload);
    });
  } finally { clearTimeout(timer); }
}

export function executionJson(response, expected = 200) {
  check(response.status === expected, response.status === 404 ? 'DOCKER_TARGET_MISSING' : 'DOCKER_HTTP_FAILED');
  try { return JSON.parse(response.body.toString('utf8')); }
  catch { throw dockerError('DOCKER_RESPONSE_INVALID'); }
}

export function executionProgress(response) {
  check(response.status === 200, 'DOCKER_DISPATCH_UNKNOWN');
  const text = response.body.toString('utf8');
  check(text.trim().length > 0, 'DOCKER_DISPATCH_UNKNOWN');
  let auxiliary;
  for (const line of text.trim().split(/\r?\n/)) {
    let value;
    try { value = JSON.parse(line); } catch { throw dockerError('DOCKER_DISPATCH_UNKNOWN'); }
    check(value && typeof value === 'object' && !value.error && !value.errorDetail, 'DOCKER_DISPATCH_FAILED');
    if (value.aux) auxiliary = value.aux;
  }
  return auxiliary;
}

export function executionTar(files) {
  const chunks = [];
  let total = 1024;
  for (const [name, value] of Object.entries(files)) {
    check(/^[A-Za-z0-9._-]+$/.test(name) && Buffer.byteLength(name) <= 99, 'DOCKER_CONTEXT_INVALID');
    const bytes = Buffer.from(value);
    total += 512 + Math.ceil(bytes.length / 512) * 512;
    check(total <= maximum + 2048, 'DOCKER_INPUT_LIMIT');
    const header = Buffer.alloc(512);
    header.write(name);
    const octal = (offset, length, number) => header.write(number.toString(8).padStart(length - 1, '0') + '\0', offset, length);
    octal(100, 8, 0o600); octal(108, 8, 0); octal(116, 8, 0);
    octal(124, 12, bytes.length); octal(136, 12, 946684800);
    header.fill(32, 148, 156); header[156] = 48;
    header.write('ustar\0', 257); header.write('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

export function executionTarFile(archive, expectedName, limit = 16 * 1024 * 1024) {
  check(Buffer.isBuffer(archive) && archive.length <= limit + 4096);
  let found;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
    const sizeText = header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim();
    check(/^[0-7]+$/.test(sizeText));
    const size = Number.parseInt(sizeText, 8);
    check(size <= limit && offset + 512 + size <= archive.length
      && [0, 48].includes(header[156]) && name === expectedName && !found);
    const copy = Buffer.from(header);
    const checksum = Number.parseInt(header.subarray(148, 156).toString().trim(), 8);
    copy.fill(32, 148, 156);
    check(copy.reduce((sum, byte) => sum + byte, 0) === checksum);
    found = archive.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  check(found !== undefined);
  return found;
}

export const executionImageLimit = maximum;
