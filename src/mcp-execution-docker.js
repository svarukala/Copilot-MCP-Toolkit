import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { dockerSocketSchema, dockerError } from './docker-engine.js';

const maximum = 512 * 1024 * 1024;
const check = (ok, code = 'DOCKER_RESPONSE_INVALID') => { if (!ok) throw dockerError(code); };
const failureCategories = new Set(['certificate-validation', 'name-resolution', 'registry-authorization',
  'registry-rate-limit', 'image-unavailable', 'resource-exhausted', 'network-timeout',
  'builder-unsupported', 'build-command-failed', 'unclassified', 'http-error', 'invalid-progress', 'missing-progress']);
const instructions = new Set(['FROM', 'RUN', 'COPY', 'ADD', 'WORKDIR', 'ENV', 'USER', 'EXPOSE',
  'CMD', 'LABEL', 'ENTRYPOINT', 'ARG', 'VOLUME', 'SHELL', 'STOPSIGNAL', 'HEALTHCHECK', 'ONBUILD']);
const boundedInteger = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

// Retain only closed categories/numeric context. Never copy a Docker message,
// URL, command, image name, layer ID or arbitrary error property into evidence.
export function dockerFailureDiagnostic(value) {
  if (!value || value.schemaVersion !== 1 || !failureCategories.has(value.category)) return undefined;
  return { schemaVersion: 1, category: value.category,
    ...(boundedInteger(value.httpStatus, 100, 599) ? { httpStatus: value.httpStatus } : {}),
    ...(boundedInteger(value.recordIndex, 1, 1000000) ? { recordIndex: value.recordIndex } : {}),
    ...(boundedInteger(value.step, 1, 10000) && boundedInteger(value.totalSteps, value.step, 10000)
      && instructions.has(value.instruction)
      ? { step: value.step, totalSteps: value.totalSteps, instruction: value.instruction } : {}),
    ...(boundedInteger(value.exitCode, 1, 255) ? { exitCode: value.exitCode } : {}),
  };
}

function reportedCategory(message) {
  if (typeof message !== 'string') return undefined;
  const text = message.slice(0, 16384);
  if (/\b(?:SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|CERT_HAS_EXPIRED)\b|x509:|certificate signed by unknown authority/i.test(text)) return 'certificate-validation';
  if (/\b(?:ENOTFOUND|EAI_AGAIN)\b|no such host/i.test(text)) return 'name-resolution';
  if (/\b(?:ENOSPC|ENOMEM)\b|no space left on device|cannot allocate memory/i.test(text)) return 'resource-exhausted';
  if (/\b(?:ETIMEDOUT|ESOCKETTIMEDOUT)\b|TLS handshake timeout|i\/o timeout/i.test(text)) return 'network-timeout';
  if (/\b(?:toomanyrequests|E429)\b|too many requests/i.test(text)) return 'registry-rate-limit';
  if (/\b(?:E401|E403)\b|unauthorized: authentication required|pull access denied|requested access to the resource is denied/i.test(text)) return 'registry-authorization';
  if (/manifest unknown|no matching manifest|manifest for .{1,512} not found/i.test(text)) return 'image-unavailable';
  if (/(?:legacy builder|buildkit|builder version).{0,100}(?:not supported|unsupported|disabled|not available)/i.test(text)) return 'builder-unsupported';
  return undefined;
}

function progressFailure(code, response, category, context = {}) {
  return Object.assign(dockerError(code), {
    dockerFailure: dockerFailureDiagnostic({ ...context, schemaVersion: 1, category, httpStatus: response.status }),
  });
}

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
  let auxiliary;
  for (const value of executionMessages(response)) if (value.aux) auxiliary = value.aux;
  return auxiliary;
}

function* executionMessages(response) {
  if (response.status !== 200) {
    let category;
    try { category = reportedCategory(JSON.parse(response.body.toString('utf8')).message); }
    catch { /* Unparseable HTTP bodies are not diagnostic evidence. */ }
    throw progressFailure('DOCKER_DISPATCH_UNKNOWN', response, category ?? 'http-error');
  }
  const text = response.body.toString('utf8');
  if (!text.trim()) throw progressFailure('DOCKER_DISPATCH_UNKNOWN', response, 'missing-progress');
  let recordIndex = 0, buildStep = {}, hint;
  for (const line of text.trim().split(/\r?\n/)) {
    recordIndex++;
    const context = () => ({ recordIndex, ...buildStep });
    let value;
    try { value = JSON.parse(line); }
    catch { throw progressFailure('DOCKER_DISPATCH_UNKNOWN', response, 'invalid-progress', context()); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw progressFailure('DOCKER_DISPATCH_FAILED', response, 'invalid-progress', context());
    }
    if (value.error || value.errorDetail) {
      const message = [value.errorDetail?.message, value.error]
        .filter(item => typeof item === 'string').map(item => item.slice(0, 16384)).join('\n');
      const exit = /returned a non-zero code: ([1-9][0-9]{0,2})(?:\s|$)/.exec(message);
      throw progressFailure('DOCKER_DISPATCH_FAILED', response,
        reportedCategory(message) ?? hint ?? (exit ? 'build-command-failed' : 'unclassified'),
        { ...context(), ...(exit ? { exitCode: Number(exit[1]) } : {}) });
    }
    if (typeof value.stream === 'string') {
      const stream = value.stream.slice(0, 16384);
      const step = /^Step ([1-9][0-9]{0,3})\/([1-9][0-9]{0,3}) : ([A-Z]+)(?:\s|$)/.exec(stream);
      if (step) {
        buildStep = { step: Number(step[1]), totalSteps: Number(step[2]), instruction: step[3] };
        hint = undefined;
      }
      // npm emits its actionable code before Docker's generic RUN exit error.
      if (/^npm (?:ERR!|error) code /m.test(stream)) hint = reportedCategory(stream) ?? hint;
    }
    yield value;
  }
}

export function executionPushResult(response, tag) {
  const code = 'DOCKER_PUSH_RESULT_INVALID';
  check(typeof tag === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag), code);
  let digest, auxiliary = false, summary = false;
  const accept = value => {
    check(typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
      && (digest === undefined || digest === value), code);
    digest = value;
  };
  for (const value of executionMessages(response)) {
    if (value.aux !== undefined) {
      check(value.aux && typeof value.aux === 'object' && !Array.isArray(value.aux)
        && !value.aux.ManifestPushedInsteadOfIndex && !value.aux.ContentMissing
        && (value.aux.Tag === undefined || value.aux.Tag === tag), code);
      accept(value.aux.Digest);
      auxiliary = true;
    }
    if (typeof value.status === 'string' && value.status.includes(': digest:')) {
      const match = /^([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}): digest: (sha256:[a-f0-9]{64}) size: ([0-9]+)$/.exec(value.status);
      check(match && match[1] === tag && Number.isSafeInteger(Number(match[3])) && Number(match[3]) > 0, code);
      accept(match[2]);
      summary = true;
    }
  }
  check(digest !== undefined, code);
  return { digest, completion: auxiliary && summary ? 'aux-and-status' : auxiliary ? 'aux' : 'status' };
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
