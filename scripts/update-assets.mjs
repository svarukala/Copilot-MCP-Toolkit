import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || args.length === 1 && args[0] !== '--check') {
  throw new Error('Use update-assets.mjs with no arguments to update, or --check for a read-only check.');
}
const files = ['package.json', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'source-provenance.json'];
async function collect(directory) {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await collect(relative);
    else if (entry.isFile()) files.push(relative);
    else throw new Error('Runtime inventory refuses nonregular entries.');
  }
}
for (const directory of ['src', 'bin', 'skills', 'examples', 'docs']) await collect(directory);
const expected = `${JSON.stringify({ schemaVersion: 1, files: files.sort() }, null, 2)}\n`;
const inventory = path.join(root, 'library-assets.json');
if (args[0] === '--check') {
  if ((await readFile(inventory, 'utf8')).replaceAll('\r\n', '\n') !== expected) {
    throw new Error('Runtime inventory is stale. Review the changed assets, then run node scripts/update-assets.mjs.');
  }
} else await writeFile(inventory, expected);
