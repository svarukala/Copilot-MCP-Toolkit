import { lstat } from 'node:fs/promises';

import path from 'node:path';

export async function assertSafeLocation(root, candidate) {
  root = path.resolve(root);
  candidate = path.resolve(candidate);
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Path must stay inside the project directory.');
  }
  const parsed = path.parse(candidate);
  let current = parsed.root;
  for (const segment of candidate.slice(parsed.root.length).split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Symlinks/junctions are not allowed: ${current}`);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
}

export function secretIssues(text) {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)
    || /\b(?:sk-[a-zA-Z0-9]{20,}|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,})\b/.test(text)
    || /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/.test(text)
    || /["']?(?:api[-_]?key|client[-_]?secret|access[-_]?token|refresh[-_]?token|password)["']?\s*[:=]\s*["']?[^\s"',;}]{4,}/i.test(text)
    || /\bBearer\s+[a-zA-Z0-9_.~+/-]{12,}/i.test(text);
}
