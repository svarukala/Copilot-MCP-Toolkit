import { normalizeAnonymousEndpoint } from './anonymous-metadata.js';

export const defaultNpmRegistryUrl = 'https://registry.npmjs.org/';
export const npmRegistryUrlSchema = { type: 'string', format: 'uri', maxLength: 2048 };
const runtimeMirror = 'https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/';

function requireRegistry(ok, message) {
  if (!ok) throw Object.assign(new Error(message), { code: 'MCP_NPM_REGISTRY_INVALID' });
}

export function resolveNpmRegistryUrl(value = defaultNpmRegistryUrl) {
  const normalized = normalizeAnonymousEndpoint(value), url = new URL(normalized);
  requireRegistry(normalized === value && url.hostname.length <= 253
    && url.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    && /^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(url.pathname),
  'Use a canonical credential-free HTTPS npm registry URL with a trailing slash and plain feed-path segments; encoded paths and npm interpolation are unsupported.');
  return normalized;
}

export function mapRuntimeLock(lock, registryUrl) {
  const target = resolveNpmRegistryUrl(registryUrl);
  requireRegistry(lock?.lockfileVersion === 3 && lock.packages && !Array.isArray(lock.packages)
    && typeof lock.packages === 'object' && Object.hasOwn(lock.packages, ''),
  'Runtime dependency lock is incomplete.');
  for (const [name, pkg] of Object.entries(lock.packages)) {
    if (!name) continue;
    requireRegistry(pkg && typeof pkg.resolved === 'string' && typeof pkg.version === 'string'
      && typeof pkg.integrity === 'string' && /^(?:sha512-[A-Za-z0-9+/]{86}==|sha1-[A-Za-z0-9+/]{27}=)$/.test(pkg.integrity),
    'Runtime dependency lock must retain pinned versions and its original integrity.');
    const packageName = name.split('node_modules/').at(-1);
    requireRegistry(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName)
      && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(pkg.version),
    'Runtime dependency lock contains an unsupported package name or version.');
    const suffix = `${packageName}/-/${packageName.split('/').at(-1)}-${pkg.version}.tgz`;
    requireRegistry([defaultNpmRegistryUrl, runtimeMirror].some(base => pkg.resolved === `${base}${suffix}`),
      'Unknown runtime package registry or tarball path; do not infer or fall back to a download source.');
    pkg.resolved = `${target}${suffix}`;
  }
  return lock;
}
