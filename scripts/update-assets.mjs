import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
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
await writeFile(path.join(root, 'library-assets.json'), `${JSON.stringify({ schemaVersion: 1, files: files.sort() }, null, 2)}\n`);
