import { request } from 'node:http';
import { createHash } from 'node:crypto';
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

export function executionImageBinding(archive, imageId) {
  const valid = ok => check(ok, 'DOCKER_IMAGE_ARCHIVE_INVALID');
  const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const isDigest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
  valid(Buffer.isBuffer(archive) && archive.length <= maximum && isDigest(imageId));
  const entries = new Map();
  let ended = false;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      valid(archive.length - offset >= 1024 && archive.subarray(offset).every(byte => byte === 0));
      ended = true;
      break;
    }
    const field = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/s, '');
    const prefix = field(345, 155), name = `${prefix ? `${prefix}/` : ''}${field(0, 100)}`;
    const sizeText = field(124, 12).trim(), checksumText = field(148, 8).trim();
    valid(/^[0-7]+$/.test(sizeText) && /^[0-7]+$/.test(checksumText));
    const size = Number.parseInt(sizeText, 8), next = offset + 512 + Math.ceil(size / 512) * 512;
    const checksum = Buffer.from(header); checksum.fill(32, 148, 156);
    valid(checksum.reduce((sum, byte) => sum + byte, 0) === Number.parseInt(checksumText, 8)
      && Number.isSafeInteger(size) && next <= archive.length && entries.size < 4096
      && /^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith('/')
      && !name.replace(/\/$/, '').split('/').some(part => !part || part === '.' || part === '..')
      && !entries.has(name) && [0, 48, 53].includes(header[156])
      && (header[156] !== 53 || size === 0));
    entries.set(name, header[156] === 53 ? null : archive.subarray(offset + 512, offset + 512 + size));
    offset = next;
  }
  valid(ended);
  const bytes = name => {
    const value = entries.get(name);
    valid(Buffer.isBuffer(value));
    return value;
  };
  const document = name => {
    const value = bytes(name);
    valid(value.length <= 1048576);
    try { return JSON.parse(value); }
    catch { throw dockerError('DOCKER_IMAGE_ARCHIVE_INVALID'); }
  };
  const manifest = document('manifest.json');
  valid(Array.isArray(manifest) && manifest.length === 1);
  const selected = manifest[0];
  valid(selected && typeof selected.Config === 'string' && Array.isArray(selected.Layers)
    && selected.Layers.length > 0 && selected.Layers.length <= 256
    && selected.Layers.every(name => typeof name === 'string'));
  const configBytes = bytes(selected.Config), configDigest = hash(configBytes), config = document(selected.Config);
  valid([`${configDigest.slice(7)}.json`, `blobs/sha256/${configDigest.slice(7)}`].includes(selected.Config)
    && config?.os === 'linux' && config.architecture === 'amd64'
    && config.rootfs?.type === 'layers' && Array.isArray(config.rootfs.diff_ids)
    && config.rootfs.diff_ids.length === selected.Layers.length && config.rootfs.diff_ids.every(isDigest));
  if (configDigest === imageId) {
    for (const [index, name] of selected.Layers.entries()) {
      valid(hash(bytes(name)) === config.rootfs.diff_ids[index]);
    }
  } else {
    // Containerd exposes the manifest digest as ImageID; Trivy reports the config digest.
    const index = document('index.json');
    valid(index?.schemaVersion === 2 && Array.isArray(index.manifests) && index.manifests.length === 1
      && index.manifests[0]?.digest === imageId);
    const imagePath = `blobs/sha256/${imageId.slice(7)}`, imageBytes = bytes(imagePath), image = document(imagePath);
    valid(hash(imageBytes) === imageId && index.manifests[0].size === imageBytes.length
      && image?.schemaVersion === 2 && image.config?.digest === configDigest
      && image.config.size === configBytes.length && Array.isArray(image.layers)
      && image.layers.length === selected.Layers.length);
    for (const [index, layer] of image.layers.entries()) {
      valid(layer && isDigest(layer.digest) && selected.Layers[index] === `blobs/sha256/${layer.digest.slice(7)}`);
      const content = bytes(selected.Layers[index]);
      valid(layer.size === content.length && hash(content) === layer.digest);
    }
  }
  return { imageId, configDigest, archiveDigest: hash(archive), diffIds: config.rootfs.diff_ids };
}
