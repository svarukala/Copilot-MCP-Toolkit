import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { TOOLKIT_ROOT } from './config.js';
import { assertSafeLocation } from './validation.js';
import { commandFamilies } from './help.js';
import { standaloneCapabilities } from './standalone-capabilities.js';

export async function getLibraryInfo({ signal } = {}) {
  if (signal?.aborted) throw Object.assign(new Error('Build inspection aborted.'), { code: 'ABORTED' });
  async function readAsset(file, maximum = 8 * 1024 * 1024) {
    const location = path.join(TOOLKIT_ROOT, ...file.split('/'));
    await assertSafeLocation(TOOLKIT_ROOT, location);
    const stat = await lstat(location);
    if (!stat.isFile() || stat.size > maximum) throw Object.assign(new Error('Runtime asset is not a bounded regular file.'), { code: 'ASSETS' });
    const bytes = await readFile(location, { signal });
    if (bytes.length > maximum) throw Object.assign(new Error('Runtime asset exceeded its size bound.'), { code: 'ASSETS' });
    return bytes;
  }
  const inventoryBytes = await readAsset('library-assets.json', 65536);
  const inventory = JSON.parse(inventoryBytes);
  if (inventory.schemaVersion !== 1 || !Array.isArray(inventory.files) || inventory.files.length > 256
    || !inventory.files.includes('package.json') || inventory.files.includes('library-assets.json')
    || inventory.files.some(p => typeof p !== 'string' || !/^[a-zA-Z0-9_.\/-]+$/.test(p)
      || p.split('/').some(part => !part || part === '.' || part === '..'))
    || JSON.stringify([...new Set(inventory.files)].sort()) !== JSON.stringify(inventory.files)) {
    throw Object.assign(new Error('Invalid bounded runtime asset inventory.'), { code: 'ASSETS' });
  }
  const hash = createHash('sha256');
  let pkg;
  for (const file of [...inventory.files, 'library-assets.json'].sort()) {
    if (signal?.aborted) throw Object.assign(new Error('Build inspection aborted.'), { code: 'ABORTED' });
    const bytes = file === 'library-assets.json' ? inventoryBytes : await readAsset(file);
    if (file === 'package.json') pkg = JSON.parse(bytes);
    hash.update(`${file}\0${bytes.length}\0`); hash.update(bytes);
  }
  return { name: pkg.name, version: pkg.version, libraryContractVersion: 1, mcpServerContractVersion: 1,
    experimental: true, contentDigest: `sha256:${hash.digest('hex')}`, files: inventory.files };
}

export async function capabilities() {
  const info = await getLibraryInfo();
  return {
    contractVersion: 1,
    toolkit: { name: info.name, version: info.version, buildId: info.contentDigest, node: '>=22' },
    commands: ['init', 'schema', 'capabilities', ...Object.values(commandFamilies).flat()],
    workspaceRoot: { flag: '--workspace-root', absolute: true, mustExist: true,
      scope: 'per-invocation-trusted-root', installedCodeMutable: false, symlinkTraversal: false },
    ...standaloneCapabilities(),
    resume: { command: 'mcp-resume', authority: 'one-current-exact-plan', implicitRefresh: false, replay: false },
    feedback: { summary: 'stderr-opt-in', progress: 'stderr-opt-in', jsonStdout: true, rawAuthenticationOutput: false },
    copilotCli: { integration: 'installable-guidance-skill', skill: 'skills/copilot-mcp/SKILL.md',
      engine: 'copilot-mcp', nativeMcpFacade: false, hostRegistration: false },
    unsupported: ['plugin-authoring', 'plugin-ZIP', 'consumer-registration', 'provider-OAuth-exchange',
      'federated-connectors', 'arbitrary-REST-to-code-generation', 'automatic-retry-or-history-migration'],
  };
}
