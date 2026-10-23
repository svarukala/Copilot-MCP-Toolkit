import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
async function check(directory) {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) await check(relative);
    else if (entry.isFile() && /\.(?:c|m)?js$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', path.join(root, relative)], { stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Syntax check failed: ${relative}`);
    } else if (!entry.isFile()) throw new Error(`Refusing nonregular source entry: ${relative}`);
  }
}
for (const directory of ['src', 'bin', 'scripts']) await check(directory);
