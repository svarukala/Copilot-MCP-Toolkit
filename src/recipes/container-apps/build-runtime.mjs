import { build, version } from 'esbuild';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const requireBundle = (ok, message) => {
  if (!ok) throw Object.assign(new Error(message), { code: 'RUNTIME_BUNDLE_INVALID' });
};

export async function buildRuntime(directory = fileURLToPath(new URL('.', import.meta.url))) {
  const root = await realpath(directory), output = path.join(root, 'dist');
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  requireBundle(lock.lockfileVersion === 3 && lock.packages?.[''].devDependencies?.esbuild === version
    && lock.packages['node_modules/esbuild']?.version === version, 'Bundler does not match the sealed build lock.');
  const result = await build({ absWorkingDir: root, entryPoints: ['runtime.js'], outfile: 'dist/runtime.js',
    bundle: true, platform: 'node', target: 'node22', format: 'esm', write: false, metafile: true,
    sourcemap: false, legalComments: 'none', charset: 'ascii', logLevel: 'silent' });
  const outputs = Object.values(result.metafile.outputs);
  const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
  requireBundle(result.outputFiles.length === 1 && outputs.length === 1
    && outputs[0].imports.every(item => item.external && builtins.has(item.path)),
  'Bundle must be self-contained except for Node builtins.');
  const packages = new Map();
  for (const [name, contribution] of Object.entries(outputs[0].inputs)) {
    if (!contribution.bytesInOutput) continue;
    const resolved = await realpath(path.resolve(root, name)), relative = path.relative(root, resolved).split(path.sep).join('/');
    requireBundle(relative && !relative.startsWith('../') && !path.isAbsolute(relative),
      'Bundle input is outside the installed source project.');
    if (relative === 'runtime.js') continue;
    const segments = relative.split('/'), index = segments.lastIndexOf('node_modules');
    requireBundle(index >= 0 && segments[index + 1], 'Unrecognized runtime bundle input.');
    const packageName = segments.slice(index + 1, index + (segments[index + 1].startsWith('@') ? 3 : 2)).join('/');
    const location = segments.slice(0, index + 1).concat(packageName).join('/');
    requireBundle(lock.packages[location] && !lock.packages[location].dev, 'Runtime component is not production-locked.');
    if (!packages.has(location)) packages.set(location, { name: packageName, files: [] });
    packages.get(location).files.push({ path: relative, digest: hash(await readFile(resolved)),
      bytesInBundle: contribution.bytesInOutput });
  }
  requireBundle(packages.size > 0, 'Runtime dependency inventory is empty.');
  await mkdir(output);
  await writeFile(path.join(output, 'runtime.js'), result.outputFiles[0].contents, { flag: 'wx' });
  const components = [];
  for (const [location, component] of [...packages].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const source = path.join(root, location), destination = path.join(output, location);
    const metadata = await readFile(path.join(source, 'package.json'));
    const pkg = JSON.parse(metadata), pinned = lock.packages[location];
    requireBundle(pkg.name === component.name && pkg.version === pinned.version && pinned.integrity,
      'Installed component identity differs from the sealed lock.');
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, 'package.json'), metadata, { flag: 'wx' });
    const notices = [];
    for (const entry of (await readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (!/^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(entry.name)) continue;
      requireBundle(entry.isFile() && (await lstat(path.join(source, entry.name))).size <= 1048576,
        'Component notice must be a bounded regular file.');
      const bytes = await readFile(path.join(source, entry.name));
      await writeFile(path.join(destination, entry.name), bytes, { flag: 'wx' });
      notices.push({ path: `${location}/${entry.name}`, digest: hash(bytes) });
    }
    requireBundle(notices.length > 0, 'A contributing package is missing its distribution license or notice.');
    components.push({ name: pkg.name, version: pkg.version, location, integrity: pinned.integrity,
      metadataDigest: hash(metadata), license: pkg.license ?? null,
      files: component.files.sort((a, b) => a.path.localeCompare(b.path, 'en')), notices });
  }
  for (const name of ['server.js', 'runtime-config.json', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) {
    requireBundle((await lstat(path.join(root, name))).isFile(), 'Missing runtime distribution input.');
    await copyFile(path.join(root, name), path.join(output, name));
  }
  await writeFile(path.join(output, 'package.json'), json({ name: 'generated-container-apps-mcp-runtime',
    version: '0.1.0', private: true, type: 'module', engines: { node: '>=22' } }), { flag: 'wx' });
  const manifest = { schemaVersion: 1, format: 'copilot-mcp-runtime-bundle-v1', bundler: { name: 'esbuild', version },
    bundleDigest: hash(result.outputFiles[0].contents), sourceLockDigest: hash(await readFile(path.join(root, 'package-lock.json'))),
    externalImports: outputs[0].imports.map(item => item.path).sort(), components,
    inventoryPurpose: 'Package metadata and original notices describe code included in runtime.js. No dependency module code is installed here.',
    securityStatus: 'Build inventory only. Requires a fresh image vulnerability scan, SBOM and runtime qualification.' };
  await writeFile(path.join(output, 'runtime-bundle.json'), json(manifest), { flag: 'wx' });
  return manifest;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const manifest = await buildRuntime();
    process.stderr.write(`${JSON.stringify({ event: 'runtime-bundle-built', components: manifest.components.length,
      bundleDigest: manifest.bundleDigest })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ event: 'runtime-bundle-failed',
      reason: error.code === 'RUNTIME_BUNDLE_INVALID' ? error.message : 'Bundle build or file operation failed.' })}\n`);
    process.exitCode = 1;
  }
}
