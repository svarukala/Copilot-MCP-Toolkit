import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { assertProjectPath } from './config.js';
import { readControl } from './mcp-control.js';
import { metadataDigest } from './anonymous-metadata.js';

export const recoveryPending = '.mcp-recovery.pending';
export const recoveryDirectory = '.mcp-recovery';
export const recoveryLocks = ['.mcp-network.lock', '.provisioning.lock'];
export function recoveryError(code) {
  return Object.assign(new Error('Recovery is not execution authority. Preserve the archive and partial destination; inspect recovery metadata and review fresh supported phases. Never remove retained lock barriers or rewrite historical bindings.'), { code });
}
export async function recoveryBarrier(projectDir, { identityEpoch } = {}) {
  const dir = await assertProjectPath(path.resolve(projectDir));
  try { await lstat(await assertProjectPath(path.join(dir, recoveryPending))); return 'MCP_RECOVERY_INCOMPLETE'; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const folder = await assertProjectPath(path.join(dir, recoveryDirectory));
  let names;
  try { names = await readdir(folder); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  if (names.length > 512) throw recoveryError('MCP_RECOVERY_INVALID');
  for (const name of names.sort()) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw recoveryError('MCP_RECOVERY_INVALID');
    let record;
    try { record = await readControl(path.join(folder, name)); }
    catch (error) {
      if (!(error instanceof SyntaxError) && !['LIMIT', 'INVALID_CONFIG', 'CONTROL_VALIDATION'].includes(error.code)) throw error;
      throw recoveryError('MCP_RECOVERY_INVALID');
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw recoveryError('MCP_RECOVERY_INVALID');
    const { recordDigest, ...body } = record;
    if (Object.keys(body).sort().join(',') !== 'archiveSha256,barriers,identityEpoch,kind,manifestDigest,schemaVersion'
      || record.schemaVersion !== 1 || record.kind !== 'standalone-mcp-recovery'
      || !/^[a-f0-9]{64}$/.test(record.archiveSha256)
      || !/^sha256:[a-f0-9]{64}$/.test(record.manifestDigest)
      || !(record.identityEpoch === null || typeof record.identityEpoch === 'string' && /^[a-f0-9-]{36}$/i.test(record.identityEpoch))
      || !Array.isArray(record.barriers) || record.barriers.some(b => ![
        ...recoveryLocks, 'incomplete-recovery', 'unsupported-history',
      ].includes(b)) || recordDigest !== metadataDigest(body)) throw recoveryError('MCP_RECOVERY_INVALID');
    if (record.barriers.length) return 'MCP_RECOVERY_REVIEW_REQUIRED';
    if (typeof identityEpoch === 'string' && record.identityEpoch?.toLowerCase() === identityEpoch.toLowerCase()) return 'MCP_RECOVERY_IDENTITY_REQUIRED';
  }
  return null;
}

export function persistenceGuidance(value = 'unknown') {
  if (!['unknown', 'ephemeral', 'persistent'].includes(value)) throw recoveryError('MCP_PERSISTENCE_INVALID');
  return { status: value, basis: value === 'unknown' ? 'not-established' : 'operator-declared-not-verified',
    crossDeviceBackupVerified: false,
    guidance: [
      'An archive on the same execution filesystem is only a local checkpoint, not a cross-device backup.',
      'Before session loss, export to a new ZIP and separately retain its SHA256. Transfer only the screened archive to approved durable storage and verify its hash there.',
      'In Azure Cloud Shell, use the file download control for the exact exported ZIP. Do not download the signed-in workspace or .azure-auth.',
      'HOME and clouddrive presence or absence do not establish persistence. Confirm the session storage configuration with its owner; no storage or credential scan was performed.',
    ] };
}
