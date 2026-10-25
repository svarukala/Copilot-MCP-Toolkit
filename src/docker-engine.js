import { request } from 'node:http';

export const dockerSocketSchema = { type: 'string', maxLength: 160,
  pattern: '^(?:\\\\\\\\\\.\\\\pipe\\\\docker(?:_engine|DesktopLinuxEngine)|/var/run/docker\\.sock|/run/user/[0-9]+/docker\\.sock)$' };
export function registryAuthHeader(server, token) {
  // Docker's Go URLEncoding decoder requires padding; Node's base64url encoding omits it.
  return Buffer.from(JSON.stringify({ username: '00000000-0000-0000-0000-000000000000',
    password: token, serveraddress: server })).toString('base64').replaceAll('+', '-').replaceAll('/', '_');
}
export function dockerError(code) {
  return Object.assign(new Error(`Docker operation stopped (${code}); inspect retained metadata before any new operation.`),
    { code });
}
export async function dockerEngineRequest(socketPath, route, {
  method = 'GET', body, headers = {}, signal, timeoutMs = 15000, maxBytes = 1048576,
} = {}, { requestImpl = request } = {}) {
  if (!new RegExp(dockerSocketSchema.pattern).test(socketPath)
    || !route.startsWith('/') || /[\r\n]/.test(route)) throw dockerError('DOCKER_ENDPOINT_INVALID');
  if (signal?.aborted) throw dockerError('DOCKER_ABORTED');
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  try {
    return await new Promise((resolve, reject) => {
      const req = requestImpl({ socketPath, path: route, method, agent: false, signal: combined,
        headers: { ...headers, ...(payload === undefined ? {} : {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
        }) } }, response => {
        let bytes = 0;
        const chunks = [];
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > maxBytes) req.destroy(dockerError('DOCKER_OUTPUT_LIMIT'));
          else chunks.push(chunk);
        });
        response.on('error', () => reject(dockerError('DOCKER_RESPONSE_UNKNOWN')));
        response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', error => reject(dockerError(combined.aborted ? signal?.aborted ? 'DOCKER_ABORTED' : 'DOCKER_TIMEOUT'
        : error.code === 'DOCKER_OUTPUT_LIMIT' ? error.code
          : ['ENOENT', 'ECONNREFUSED'].includes(error.code) ? 'DOCKER_UNAVAILABLE'
            : ['EACCES', 'EPERM'].includes(error.code) ? 'DOCKER_ACCESS_DENIED' : 'DOCKER_RESPONSE_UNKNOWN')));
      req.end(payload);
    });
  } finally { clearTimeout(timer); }
}
export function dockerJson(response, expected = 200) {
  if (response.status !== expected) throw dockerError(response.status === 404 ? 'DOCKER_IMAGE_OR_CONTAINER_MISSING'
    : response.status === 401 || response.status === 403 ? 'DOCKER_AUTHORIZATION_FAILED' : 'DOCKER_HTTP_FAILED');
  try { return JSON.parse(response.text); }
  catch { throw dockerError('DOCKER_RESPONSE_INVALID'); }
}
