import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, readdir, open, mkdir, unlink, readFile, link } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { assertProjectPath } from './config.js';
import { secretIssues } from './validation.js';
import { savedJson, metadataDigest, boundedSnapshot } from './anonymous-metadata.js';
import { prepareMcpServerDefinition } from './mcp-server.js';
import { mcpCaptureFreshness } from './mcp-discovery.js';
import { recoveryDirectory, recoveryPending, recoveryLocks, persistenceGuidance } from './mcp-recovery.js';

const MB = 1048576, maxFile = 8 * MB, maxTotal = 32 * MB, maxArchive = 34 * MB, maxEntries = 512;
const id = '[a-f0-9-]{36}';
const rootFiles = new Set(['mcp-definition.json', 'mcp-server.json', '.azure-identity.json', '.mcp-configuration.json']);
const infraFiles = new Set(['foundation.json', 'secret-access.json', 'gateway.json', 'staging.json',
  'operation-map.json', 'deny-policy.json', 'provisioning-receipt.json']);
const history = ['.mcp-lifecycle', '.mcp-observations', '.mcp-auth-rejections', '.mcp-backend-rejections', recoveryDirectory];
const filePattern = new RegExp(`^(?:reconcile-${id}\\.json|\\.mcp-lifecycle/${id}\\.json|\\.mcp-recovery/${id}\\.json|\\.mcp-observations/${id}/(?:intent|capture|proof|qualification|dispatch|failure|mapping-readback)\\.json|\\.mcp-(?:auth|backend)-rejections/${id}/(?:intent|result|dispatch-[0-9]|case-[0-9])\\.json)$`);
const directoryPattern = new RegExp(`^\\.mcp-(?:observations|auth-rejections|backend-rejections)/${id}$`);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const messages = {
  APPROVAL_REQUIRED: 'Exact current export/restore approvalToken required. Review the current content, destination and persistence selection.',
  MCP_ARCHIVE_HASH_REQUIRED: 'Pass --sha256 with the independently retained 64-character lowercase archive SHA256. Do not trust a digest supplied by the archive itself.',
  MCP_ARCHIVE_HASH_MISMATCH: 'Archive bytes differ from the independently retained SHA256. Stop; do not extract or replace the trusted digest with a hash of untrusted bytes.',
  MCP_ARCHIVE_CHANGED: 'Inputs changed during the local operation. Preserve source and any partial destination; review a new plan.',
  MCP_ARCHIVE_DESTINATION_EXISTS: 'Destination already exists. No overwrite or reuse is supported; review a new, absent destination.',
  MCP_ARCHIVE_DESTINATION: 'Choose a new bounded destination outside the original project, with an existing parent directory.',
  MCP_ARCHIVE_SENSITIVE_OR_BINARY: 'An admitted file contains credential, device-code, raw-output or non-UTF8 indicators. Content is suppressed; nothing is certified safe for export.',
  MCP_ARCHIVE_FILE_BOUNDARY: 'Evidence must be bounded regular single-link files without symlinks or junctions.',
  MCP_ARCHIVE_PATH_ALIAS: 'An ambiguous case or trailing-dot/space alias of a reserved evidence path was found. No portable archive is published.',
  MCP_ARCHIVE_LIMIT: 'Evidence exceeds the bounded archive size, count or JSON complexity contract. No unbounded extraction is supported.',
};
const fail = (code = 'MCP_ARCHIVE_INVALID') => { throw Object.assign(new Error(messages[code]
  ?? 'Standalone evidence archive check failed. Preserve the source and review a fresh plan. No credentials, raw diagnostics or evidence content are displayed.'), { code }); };
const need = (value, code) => { if (!value) fail(code); };
const keys = (v, names) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === [...names].sort().join(',');
const allowedFile = name => rootFiles.has(name) || name.startsWith('infra/') && infraFiles.has(name.slice(6)) || filePattern.test(name);
const allowedDirectory = name => name === 'infra' || history.includes(name) || directoryPattern.test(name);
function safeName(name) {
  return typeof name === 'string' && name.length <= 240 && /^[a-z0-9./-]+$/.test(name)
    && name.split('/').every(p => p && p !== '.' && p !== '..' && !p.endsWith('.')
      && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/.test(p));
}
function originalRoot(value) {
  return typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value)
    && (path.posix.isAbsolute(value) && path.posix.normalize(value) === value && !value.includes('\\')
      || /^[A-Za-z]:\\/.test(value) && path.win32.normalize(value) === value && !value.includes('/'));
}
function screen(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (error) {
    if (error.code !== 'ERR_ENCODING_INVALID_ENCODED_DATA') throw error;
    fail('MCP_ARCHIVE_SENSITIVE_OR_BINARY');
  }
  const sensitive = value => {
    const decoded = value.replace(/\\u([a-fA-F0-9]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    return secretIssues(decoded)
      || /["'](?:(?:access|refresh|id)[_-]?token|client[_-]?secret|(?:user|device)[_-]?code|verification[_-]?uri(?:_complete)?|stdout|stderr)["']\s*:/i.test(decoded)
      || /\b(?:enter (?:the )?code|Code:)\s+[A-Z0-9]{6,20}\b/.test(decoded);
  };
  need(!sensitive(text), 'MCP_ARCHIVE_SENSITIVE_OR_BINARY');
  let value;
  try { value = JSON.parse(text); } catch (error) { if (!(error instanceof SyntaxError)) throw error; return { validJson: false }; }
  try { boundedSnapshot(value, maxFile); }
  catch (error) {
    if (!['LIMIT', 'INVALID_CONFIG'].includes(error.code)) throw error;
    fail('MCP_ARCHIVE_LIMIT');
  }
  need(!sensitive(JSON.stringify(value)), 'MCP_ARCHIVE_SENSITIVE_OR_BINARY');
  return { validJson: true, value };
}
async function regular(filename, limit = maxFile) {
  await assertProjectPath(filename);
  const before = await lstat(filename);
  need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= limit, 'MCP_ARCHIVE_FILE_BOUNDARY');
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    need(stat.isFile() && stat.ino === before.ino && stat.dev === before.dev && stat.size === before.size, 'MCP_ARCHIVE_CHANGED');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      need(read.bytesRead > 0, 'MCP_ARCHIVE_CHANGED'); offset += read.bytesRead;
    }
    const after = await file.stat();
    need(after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs, 'MCP_ARCHIVE_CHANGED');
    return bytes;
  } finally { await file.close(); }
}
async function inventory(projectDir) {
  const dir = await assertProjectPath(path.resolve(projectDir));
  need((await lstat(dir)).isDirectory(), 'MCP_ARCHIVE_FILE_BOUNDARY');
  const files = {}, directories = [], locks = [], excluded = { entries: 0, unsupportedHistory: false, incompleteRecovery: false };
  let total = 0, entries = 0, encountered = 0;
  async function walk(relative) {
    const location = await assertProjectPath(path.join(dir, ...relative.split('/').filter(Boolean)));
    const names = await readdir(location);
    encountered += names.length;
    need(encountered <= 4096, 'MCP_ARCHIVE_LIMIT');
    for (const name of names.sort()) {
      // Excluded surfaces are never statted, opened or recursively inspected.
      if (!relative && name.toLowerCase() === '.azure-auth') { excluded.entries++; continue; }
      const entry = relative ? `${relative}/${name}` : name;
      const alias = entry.split('/').map(part => part.replace(/[. ]+$/, '').toLowerCase()).join('/');
      need(entry === alias || !allowedFile(alias) && !allowedDirectory(alias)
        && !recoveryLocks.includes(alias) && alias !== recoveryPending, 'MCP_ARCHIVE_PATH_ALIAS');
      if (!relative && recoveryLocks.includes(name)) { locks.push(name); continue; }
      if (!relative && name === recoveryPending) { excluded.incompleteRecovery = true; continue; }
      if (!safeName(entry) || !allowedFile(entry) && !allowedDirectory(entry)) {
        excluded.entries++;
        if (relative === 'infra' || entry.endsWith('.pending')
          || history.some(folder => relative === folder || relative.startsWith(`${folder}/`))) excluded.unsupportedHistory = true;
        continue;
      }
      need(++entries <= maxEntries, 'MCP_ARCHIVE_LIMIT');
      const filename = await assertProjectPath(path.join(dir, ...entry.split('/')));
      const stat = await lstat(filename);
      if (allowedDirectory(entry)) {
        need(stat.isDirectory() && !stat.isSymbolicLink(), 'MCP_ARCHIVE_FILE_BOUNDARY');
        directories.push(entry); await walk(entry);
      } else {
        const bytes = await regular(filename);
        total += bytes.length; need(total <= maxTotal, 'MCP_ARCHIVE_LIMIT');
        screen(bytes); files[entry] = bytes;
      }
    }
  }
  await walk('');
  need(files['mcp-definition.json'] || files['mcp-server.json'], 'MCP_ARCHIVE_PROJECT_REQUIRED');
  return { dir, files, directories: directories.sort(), locks: locks.sort(), excluded };
}
// Internal read-only consumers share the export boundary, never an authentication/cache scan.
export { inventory as readMcpEvidenceInventory, screen as screenMcpEvidenceBytes };
function fileTable(files) {
  return Object.entries(files).map(([name, bytes]) => ({
    path: name, bytes: bytes.length, sha256: hash(bytes),
  })).sort((a, b) => a.path < b.path ? -1 : 1);
}
async function generation(files, directories = []) {
  const invalidJson = Object.entries(files).filter(([, bytes]) => !screen(bytes).validJson).map(([name]) => name).sort();
  const missingRecords = directories.filter(name => directoryPattern.test(name) && !files[`${name}/intent.json`])
    .map(name => `${name}/intent.json`);
  const captures = [];
  for (const [name, bytes] of Object.entries(files)) {
    if (!/^\.mcp-observations\/[^/]+\/capture\.json$/.test(name)) continue;
    const parsed = screen(bytes);
    if (!parsed.validJson) { captures.push({ path: name, status: 'invalid' }); continue; }
    try { captures.push({ path: name, ...mcpCaptureFreshness(parsed.value) }); }
    catch (error) {
      if (!['METADATA_STALE', 'METADATA_MISMATCH', 'METADATA_INVALID', 'SENSITIVE_INPUT', 'INVALID_CONFIG', 'LIMIT'].includes(error.code)) throw error;
      captures.push({ path: name, status: 'invalid', code: error.code });
    }
  }
  const result = { status: 'incomplete-or-invalid', generation: 'missing', invalidJson, missingGenerated: [], missingRecords, captures,
    history: 'cross-record-bindings-not-validated', executionReadiness: false };
  if (!files['mcp-definition.json']) { result.missingGenerated = ['mcp-definition.json']; return result; }
  const parsed = screen(files['mcp-definition.json']);
  if (!parsed.validJson) { result.generation = 'invalid'; return result; }
  let review;
  try { review = await prepareMcpServerDefinition(parsed.value); }
  catch (error) {
    if (!['MCP_DEFINITION_INVALID', 'METADATA_INVALID', 'INVALID_CONFIG', 'LIMIT', 'SENSITIVE_INPUT'].includes(error.code)) throw error;
    result.generation = 'invalid'; result.status = 'invalid-generation'; return result;
  }
  result.missingGenerated = Object.keys(review.files).filter(name => !files[name]).sort();
  result.generation = result.missingGenerated.length ? 'missing'
    : Object.entries(review.files).every(([name, text]) => files[name].equals(Buffer.from(text))) ? 'matches-current-generator' : 'invalid';
  result.status = result.generation === 'matches-current-generator' && !invalidJson.length && !missingRecords.length
    && !captures.some(c => c.status === 'invalid') ? 'history-not-validated' : 'incomplete-or-invalid';
  return result;
}
async function runtimeIdentity() {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  return { packageName: pkg.name, packageVersion: pkg.version, sourceCommit: null, archiveContract: 1,
    implementationSha256: hash(await readFile(new URL('./mcp-evidence.js', import.meta.url))) };
}
function manifestFor(snapshot, runtime, persistence) {
  need(originalRoot(snapshot.dir), 'MCP_ARCHIVE_FILE_BOUNDARY');
  const body = { schemaVersion: 1, kind: 'standalone-mcp-evidence', zipProfile: 'canonical-stored-v1',
    originalProjectRoot: snapshot.dir, runtime, persistence: persistence.status,
    files: fileTable(snapshot.files), directories: snapshot.directories,
    locks: snapshot.locks.map(name => ({ path: name, present: true, authority: false })),
    excluded: snapshot.excluded, executionReadiness: false };
  const manifest = { ...body, manifestDigest: metadataDigest(body) };
  screen(Buffer.from(savedJson(manifest)));
  return manifest;
}
function encode(entries) {
  return Buffer.from(zipSync(Object.fromEntries(Object.keys(entries).sort().map(name => [name, entries[name]])),
    { level: 0, mtime: new Date(1980, 0, 1) }));
}
function archiveBytes(snapshot, manifest) {
  return encode({ 'manifest.json': Buffer.from(savedJson(manifest)),
    ...Object.fromEntries(Object.entries(snapshot.files).map(([name, bytes]) => [`project/${name}`, bytes])) });
}
async function newDestination(value, source) {
  need(typeof value === 'string' && value.length > 0, 'MCP_ARCHIVE_DESTINATION');
  const destination = await assertProjectPath(path.resolve(value));
  const name = path.basename(destination);
  need(name.length <= 128 && !/[<>:"|?*\u0000-\u001f]/.test(name) && !/[. ]$/.test(name)
    && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name), 'MCP_ARCHIVE_DESTINATION');
  if (source) {
    const relative = path.relative(source, destination);
    need(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), 'MCP_ARCHIVE_DESTINATION');
  }
  const parent = path.dirname(destination), stat = await lstat(parent);
  need(stat.isDirectory(), 'MCP_ARCHIVE_DESTINATION');
  try { await lstat(destination); fail('MCP_ARCHIVE_DESTINATION_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { path: destination, parent: { dev: stat.dev, ino: stat.ino } };
}
export async function planMcpEvidenceExport(projectDir, { output, persistence } = {}) {
  const guidance = persistenceGuidance(persistence);
  const snapshot = await inventory(projectDir), destination = await newDestination(output, snapshot.dir);
  const manifest = manifestFor(snapshot, await runtimeIdentity(), guidance);
  const body = { schemaVersion: 1, action: 'standalone-mcp-evidence-export', projectDir: snapshot.dir, destination,
    manifest, archiveSha256: hash(archiveBytes(snapshot, manifest)), persistence: guidance,
    effects: ['Write one new local ZIP only. No project mutation, authentication, network, evidence renewal or readiness certification.'] };
  return { ...body, semanticEvidence: await generation(snapshot.files, snapshot.directories), approvalToken: `mcp-export/${metadataDigest(body)}` };
}
async function writeNew(filename, bytes) {
  await assertProjectPath(filename);
  const file = await open(filename, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}
export async function exportMcpEvidence(projectDir, options = {}) {
  const plan = await planMcpEvidenceExport(projectDir, options);
  need(options.approval === plan.approvalToken, 'APPROVAL_REQUIRED');
  const snapshot = await inventory(projectDir);
  need(metadataDigest(manifestFor(snapshot, plan.manifest.runtime, plan.persistence)) === metadataDigest(plan.manifest), 'MCP_ARCHIVE_CHANGED');
  const bytes = archiveBytes(snapshot, plan.manifest);
  need(hash(bytes) === plan.archiveSha256, 'MCP_ARCHIVE_CHANGED');
  const pending = `${plan.destination.path}.${randomUUID()}.pending`;
  await writeNew(pending, bytes);
  try {
    need((await planMcpEvidenceExport(projectDir, options)).approvalToken === plan.approvalToken, 'MCP_ARCHIVE_CHANGED');
    need(hash(await regular(pending, maxArchive)) === plan.archiveSha256, 'MCP_ARCHIVE_CHANGED');
    need(metadataDigest(await newDestination(plan.destination.path)) === metadataDigest(plan.destination), 'MCP_ARCHIVE_CHANGED');
    // Hard-link publication is atomic and fails if any destination already exists.
    await link(pending, plan.destination.path);
  } finally { await unlink(pending); }
  return { status: 'local-checkpoint-written', output: plan.destination.path, archiveSha256: plan.archiveSha256,
    manifestDigest: plan.manifest.manifestDigest, persistence: plan.persistence, executionReadiness: false };
}
function decode(bytes) {
  need(bytes.length >= 22 && bytes.length <= maxArchive, 'MCP_ARCHIVE_LIMIT');
  const end = bytes.length - 22;
  need(bytes.readUInt32LE(end) === 0x06054b50 && bytes.readUInt16LE(end + 4) === 0
    && bytes.readUInt16LE(end + 6) === 0 && bytes.readUInt16LE(end + 20) === 0);
  const count = bytes.readUInt16LE(end + 10), central = bytes.readUInt32LE(end + 16);
  need(count >= 2 && count <= maxEntries + 1 && count === bytes.readUInt16LE(end + 8)
    && central + bytes.readUInt32LE(end + 12) === end, 'MCP_ARCHIVE_LIMIT');
  const entries = Object.create(null); let offset = central, local = 0, total = 0;
  for (let i = 0; i < count; i++) {
    need(offset + 46 <= end && bytes.readUInt32LE(offset) === 0x02014b50);
    const compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
    const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    need(length > 0 && length <= 248 && offset + 46 + length + extra + comment <= end);
    const name = bytes.subarray(offset + 46, offset + 46 + length).toString('utf8');
    need(safeName(name) && !Object.hasOwn(entries, name)
      && (name === 'manifest.json' || name.startsWith('project/') && allowedFile(name.slice(8))));
    // Version 1 deliberately accepts only stored regular entries: no inflation, links, ZIP64, descriptors or extras.
    need(bytes.readUInt16LE(offset + 10) === 0 && compressed === size && size <= maxFile
      && bytes.readUInt32LE(offset + 38) === 0 && extra === 0 && comment === 0
      && bytes.readUInt32LE(offset + 42) === local);
    need(local + 30 + length + size <= central && bytes.readUInt32LE(local) === 0x04034b50
      && bytes.readUInt16LE(local + 26) === length && bytes.readUInt16LE(local + 28) === 0
      && bytes.subarray(local + 30, local + 30 + length).equals(Buffer.from(name)));
    total += size; need(total <= maxTotal + MB, 'MCP_ARCHIVE_LIMIT');
    entries[name] = bytes.subarray(local + 30 + length, local + 30 + length + size);
    local += 30 + length + size; offset += 46 + length;
  }
  need(offset === end && local === central);
  // Re-encoding verifies CRCs and every remaining header/flag/metadata byte without trusting unzip object semantics.
  need(encode(entries).equals(bytes));
  return entries;
}
async function inspect(archive, sha256) {
  need(typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256), 'MCP_ARCHIVE_HASH_REQUIRED');
  const filename = await assertProjectPath(path.resolve(archive)), bytes = await regular(filename, maxArchive);
  need(hash(bytes) === sha256, 'MCP_ARCHIVE_HASH_MISMATCH');
  const entries = decode(bytes);
  need(entries['manifest.json']?.length <= MB);
  const parsed = screen(entries['manifest.json']), manifest = parsed.value;
  need(parsed.validJson && keys(manifest, ['schemaVersion', 'kind', 'zipProfile', 'originalProjectRoot', 'runtime', 'persistence',
    'files', 'directories', 'locks', 'excluded', 'executionReadiness', 'manifestDigest']));
  const { manifestDigest, ...body } = manifest;
  need(manifest.schemaVersion === 1 && manifest.kind === 'standalone-mcp-evidence' && manifest.zipProfile === 'canonical-stored-v1'
    && manifest.executionReadiness === false && originalRoot(manifest.originalProjectRoot)
    && manifestDigest === metadataDigest(body) && entries['manifest.json'].equals(Buffer.from(savedJson(manifest))));
  need(keys(manifest.runtime, ['packageName', 'packageVersion', 'sourceCommit', 'archiveContract', 'implementationSha256'])
    && ['copilot-mcp-toolkit', 'cowork-plugin-toolkit'].includes(manifest.runtime.packageName) && typeof manifest.runtime.packageVersion === 'string'
    && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.runtime.packageVersion)
    && manifest.runtime.sourceCommit === null && manifest.runtime.archiveContract === 1
    && /^[a-f0-9]{64}$/.test(manifest.runtime.implementationSha256));
  persistenceGuidance(manifest.persistence);
  need(keys(manifest.excluded, ['entries', 'unsupportedHistory', 'incompleteRecovery'])
    && Number.isInteger(manifest.excluded.entries) && manifest.excluded.entries >= 0 && manifest.excluded.entries <= 4096
    && typeof manifest.excluded.unsupportedHistory === 'boolean' && typeof manifest.excluded.incompleteRecovery === 'boolean');
  need(Array.isArray(manifest.locks) && manifest.locks.length <= 2
    && manifest.locks.every(v => keys(v, ['path', 'present', 'authority']) && recoveryLocks.includes(v.path) && v.present === true && v.authority === false)
    && new Set(manifest.locks.map(v => v.path)).size === manifest.locks.length);
  need(Array.isArray(manifest.directories) && manifest.directories.length <= maxEntries
    && new Set(manifest.directories).size === manifest.directories.length
    && manifest.directories.every(name => safeName(name) && allowedDirectory(name)));
  need(Array.isArray(manifest.files) && manifest.files.length + manifest.directories.length <= maxEntries);
  const files = Object.create(null);
  for (const entry of manifest.files) {
    need(keys(entry, ['path', 'bytes', 'sha256']) && safeName(entry.path) && allowedFile(entry.path)
      && !Object.hasOwn(files, entry.path) && Number.isInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= maxFile);
    const content = entries[`project/${entry.path}`];
    need(content && content.length === entry.bytes && hash(content) === entry.sha256);
    screen(content); files[entry.path] = content;
  }
  need(Object.keys(entries).length === manifest.files.length + 1 && (files['mcp-definition.json'] || files['mcp-server.json']));
  need(JSON.stringify(manifest.files) === JSON.stringify(fileTable(files))
    && JSON.stringify(manifest.directories) === JSON.stringify([...manifest.directories].sort())
    && Object.values(files).reduce((total, bytes) => total + bytes.length, 0) <= maxTotal);
  for (const name of [...Object.keys(files), ...manifest.directories]) {
    const parts = name.split('/');
    if (parts.length > 1) need(manifest.directories.includes(parts.slice(0, -1).join('/')));
  }
  return { filename, manifest, files, archiveSha256: sha256 };
}
export async function inspectMcpEvidence(archive, { sha256 } = {}) {
  const checked = await inspect(archive, sha256);
  return { schemaVersion: 1, action: 'standalone-mcp-evidence-inspect', status: 'byte-verified-not-execution-ready',
    archive: checked.filename, archiveSha256: sha256, manifest: checked.manifest,
    semanticEvidence: await generation(checked.files, checked.manifest.directories), executionReadiness: false,
    authenticity: 'SHA256 is checked against the supplied external digest, not a signature or cloud attestation.' };
}
export async function planMcpEvidenceRestore(archive, { sha256, output, persistence } = {}) {
  const report = await inspectMcpEvidence(archive, { sha256 });
  need(report.manifest.files.length + report.manifest.directories.length
    + (report.manifest.directories.includes(recoveryDirectory) ? 1 : 2) <= maxEntries, 'MCP_ARCHIVE_LIMIT');
  const destination = await newDestination(output), guidance = persistenceGuidance(persistence);
  const syntax = /^[A-Za-z]:\\/.test(report.manifest.originalProjectRoot) ? path.win32 : path.posix;
  const relative = syntax.relative(report.manifest.originalProjectRoot, destination.path);
  need(relative && (relative === '..' || relative.startsWith(`..${syntax.sep}`) || syntax.isAbsolute(relative)), 'MCP_ARCHIVE_DESTINATION');
  const body = { schemaVersion: 1, action: 'standalone-mcp-evidence-restore', archive: report.archive,
    archiveSha256: sha256, manifestDigest: report.manifest.manifestDigest, destination,
    runtime: await runtimeIdentity(),
    persistence: guidance, originalProjectRoot: report.manifest.originalProjectRoot,
    effects: ['Create one new project directory. Preserve allowed original bytes; append only non-authorizing recovery provenance.',
      'A pending marker blocks all supported project readers until complete readback and atomic admission. Interrupted output is retained, never reused or cleaned automatically.',
      'No auth cache, cloud adoption, timestamp/root/epoch/receipt rewrite or proof replay. Historical root binding may still block status/resume; fresh identity and phase reviews are separate.'] };
  return { ...body, semanticEvidence: report.semanticEvidence, locks: report.manifest.locks,
    approvalToken: `mcp-restore/${metadataDigest(body)}` };
}
export async function restoreMcpEvidence(archive, options = {}) {
  const plan = await planMcpEvidenceRestore(archive, options);
  need(options.approval === plan.approvalToken, 'APPROVAL_REQUIRED');
  const checked = await inspect(archive, options.sha256), destination = plan.destination.path;
  need((await planMcpEvidenceRestore(archive, options)).approvalToken === plan.approvalToken, 'MCP_ARCHIVE_CHANGED');
  need(metadataDigest(await newDestination(destination)) === metadataDigest(plan.destination), 'MCP_ARCHIVE_CHANGED');
  await mkdir(await assertProjectPath(destination), { mode: 0o700 });
  // This marker is created before any project artifact. Its final unlink is the atomic admission point.
  const pending = path.join(destination, recoveryPending);
  await writeNew(pending, Buffer.from('Incomplete standalone recovery; never remove to bypass readback.\n'));
  for (const name of checked.manifest.directories) {
    await mkdir(await assertProjectPath(path.join(destination, ...name.split('/'))), { mode: 0o700 });
  }
  for (const [name, bytes] of Object.entries(checked.files)) await writeNew(path.join(destination, ...name.split('/')), bytes);
  const identity = checked.files['.azure-identity.json'] ? screen(checked.files['.azure-identity.json']).value : null;
  const record = { schemaVersion: 1, kind: 'standalone-mcp-recovery', archiveSha256: options.sha256,
    identityEpoch: typeof identity?.epoch === 'string' && /^[a-f0-9-]{36}$/i.test(identity.epoch) ? identity.epoch : null,
    manifestDigest: plan.manifestDigest, barriers: [
      ...checked.manifest.locks.map(lock => lock.path),
      ...(checked.manifest.excluded.incompleteRecovery ? ['incomplete-recovery'] : []),
      ...(checked.manifest.excluded.unsupportedHistory ? ['unsupported-history'] : []),
    ] };
  const recoveryDir = await assertProjectPath(path.join(destination, recoveryDirectory));
  if (!checked.manifest.directories.includes(recoveryDirectory)) await mkdir(recoveryDir, { mode: 0o700 });
  const recordPath = path.join(recoveryDir, `${randomUUID()}.json`);
  const recordBytes = Buffer.from(savedJson({ ...record, recordDigest: metadataDigest(boundedSnapshot(record)) }));
  await writeNew(recordPath, recordBytes);
  const restored = await inventory(destination);
  const expectedFiles = { ...checked.files, [path.relative(destination, recordPath).split(path.sep).join('/')]: recordBytes };
  need(metadataDigest(fileTable(restored.files)) === metadataDigest(fileTable(expectedFiles))
    && restored.excluded.entries === 0 && !restored.excluded.unsupportedHistory && !restored.locks.length
    && JSON.stringify(restored.directories) === JSON.stringify([...new Set([...checked.manifest.directories, recoveryDirectory])].sort()), 'MCP_ARCHIVE_CHANGED');
  await inspect(archive, options.sha256);
  await unlink(await assertProjectPath(pending));
  return { status: 'restored-not-execution-ready', projectDir: destination, archiveSha256: options.sha256,
    recoveryRecord: recordPath, executionReadiness: false, persistence: plan.persistence,
    next: 'Run strict mcp-status and mcp-resume. Retained locks, invalid evidence or historical original-root bindings can block them. Preserve blocked evidence; no generic migration or automatic unlock exists. Managed projects require fresh private account and phase approvals.' };
}
