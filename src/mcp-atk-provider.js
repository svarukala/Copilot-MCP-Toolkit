import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, realpath, readFile, mkdir, writeFile, rm, statfs } from 'node:fs/promises';
import { registrationIdSchema, validApplicationIdUri } from './mcp-auth-registration.js';

const maximum = 1048576;
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function requireProvider(ok, code, message) {
  if (!ok) throw Object.assign(new Error(message), { code: `ATK_${code}` });
}
async function boundedFile(filename, limit = maximum) {
  const stat = await lstat(filename);
  requireProvider(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit, 'INPUT', 'Provider input must be a bounded regular file.');
  const bytes = await readFile(filename);
  requireProvider(bytes.length <= limit, 'INPUT', 'Provider input exceeded its size bound.');
  return bytes;
}
export async function inspectAtkProvider(root) {
  requireProvider(typeof root === 'string' && path.isAbsolute(root), 'INSTALLATION', 'Select an absolute existing ATK package directory.');
  const resolved = path.resolve(root);
  requireProvider(await realpath(resolved) === resolved, 'INSTALLATION', 'The selected provider directory must not be a symbolic link.');
  const files = {};
  for (const [name, limit] of [['package.json', maximum], ['cli.js', maximum], ['lib/index.js', 64 * maximum]]) {
    const filename = path.join(resolved, ...name.split('/'));
    requireProvider(await realpath(filename) === filename, 'INSTALLATION', 'Provider entry files must not traverse symbolic links.');
    files[name] = await boundedFile(filename, limit);
  }
  let pkg;
  try { pkg = JSON.parse(files['package.json'].toString('utf8')); }
  catch { requireProvider(false, 'INSTALLATION', 'Provider package metadata is invalid.'); }
  requireProvider(pkg.name === '@microsoft/m365agentstoolkit-cli' && pkg.version === '1.1.17',
    'INSTALLATION', 'Only the reviewed ATK 1.1.17 public CLI contract is admitted; no installation or upgrade is automatic.');
  return { root: resolved, entry: path.join(resolved, 'cli.js'), name: pkg.name, version: pkg.version,
    node: process.execPath, nodeVersion: process.version,
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, digest(bytes)])) };
}
export function atkEnvironment(home, secret) {
  return {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, 'config'), LOCALAPPDATA: path.join(home, 'local'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_DATA_HOME: path.join(home, 'data'), XDG_RUNTIME_DIR: path.join(home, 'run'),
    TMPDIR: path.join(home, 'tmp'), TEMP: path.join(home, 'tmp'), TMP: path.join(home, 'tmp'),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(home, 'no-session-bus')}`,
    DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${path.join(home, 'no-system-bus')}`,
    BROWSER: '/bin/true', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1',
    ...(secret === undefined ? {} : { MCP_AUTH_CLIENT_SECRET: secret }),
  };
}
const runtimePath = epoch => {
  requireProvider(/^[a-f0-9-]{36}$/.test(epoch), 'RUNTIME', 'Invalid private runtime epoch.');
  return `/dev/shm/copilot-mcp-auth-${epoch}`;
};
async function validateRuntime(runtime, owner, { complete = true } = {}) {
  requireProvider(process.platform === 'linux' && typeof process.getuid === 'function', 'PLATFORM',
    'ATK execution requires Linux with an owner-only tmpfs runtime. Windows/macOS shared brokers are not admitted.');
  requireProvider(runtime === runtimePath(owner.epoch) && await realpath(runtime) === runtime, 'RUNTIME', 'Private runtime location differs.');
  requireProvider((await statfs(runtime)).type === 0x01021994, 'RUNTIME', 'Provider authentication and job files must remain on tmpfs.');
  const stat = await lstat(runtime);
  requireProvider(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700,
    'RUNTIME', 'Private runtime owner or permissions differ.');
  requireProvider((await boundedFile(path.join(runtime, 'owner.json'))).toString('utf8') === JSON.stringify(owner),
    'RUNTIME', 'Private runtime ownership differs; restored/copied sessions cannot adopt authentication.');
  if (!complete) return;
  for (const name of ['home', 'job', 'home/tmp', 'home/run', 'home/config', 'home/cache', 'home/data', 'home/local']) {
    const target = path.join(runtime, ...name.split('/'));
    const item = await lstat(target);
    requireProvider(item.isDirectory() && !item.isSymbolicLink() && item.uid === process.getuid() && (item.mode & 0o777) === 0o700,
      'RUNTIME', 'Provider private directories must retain owner-only permissions.');
  }
  for (const name of ['no-session-bus', 'no-system-bus']) {
    try { await lstat(path.join(runtime, 'home', name)); requireProvider(false, 'RUNTIME', 'A forbidden keyring socket path exists.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function createRuntime(owner) {
  requireProvider(process.platform === 'linux' && (await statfs('/dev/shm')).type === 0x01021994, 'PLATFORM',
    'Linux /dev/shm tmpfs is required; no disk-backed or shared-profile fallback is allowed.');
  const runtime = runtimePath(owner.epoch);
  await mkdir(runtime, { mode: 0o700 });
  await writeFile(path.join(runtime, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  for (const name of ['home', 'job', 'home/tmp', 'home/run', 'home/config', 'home/cache', 'home/data', 'home/local']) {
    await mkdir(path.join(runtime, ...name.split('/')), { mode: 0o700 });
  }
  await validateRuntime(runtime, owner);
  return runtime;
}
function stripAnsi(value) { return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''); }
export function parseAtkAccount(output, expected) {
  const matches = stripAnsi(output).split(/\r?\n/).map(line => line.trim())
    .filter(line => line.startsWith('Your Microsoft 365 account is: '));
  requireProvider(matches.length === 1, 'IDENTITY', 'ATK did not return one unambiguous Microsoft 365 account.');
  const match = /^Your Microsoft 365 account is: ([A-Za-z0-9_.+@-]+)(?:\(([^\r\n\u0000-\u001f]{1,200})\))?\.$/.exec(matches[0]);
  requireProvider(match && match[1].toLowerCase() === expected.accountName.toLowerCase(), 'IDENTITY',
    'The signed-in ATK account does not match the selected operator. Registration is blocked.');
  return { accountName: match[1], tenantDisplayName: match[2] ?? null,
    tenantId: expected.tenantId, evidence: 'provider-account-and-selected-tenant-not-token-attestation' };
}
export function parseAtkRegistrationEnv(text, type) {
  requireProvider(typeof text === 'string' && Buffer.byteLength(text) <= 16384, 'OUTPUT', 'ATK registration output exceeds its bound.');
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    requireProvider(match && ['TEAMSFX_ENV', 'APP_NAME_SUFFIX', 'MCP_AUTH_REGISTRATION_ID',
      ...(type === 'entra-sso' ? ['MCP_AUTH_APPLICATION_ID_URI'] : [])].includes(match[1])
      && !Object.hasOwn(values, match[1]), 'OUTPUT', 'Unexpected or duplicate ATK output field; contents are not logged.');
    let value = match[2];
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  requireProvider(['TEAMSFX_ENV', 'APP_NAME_SUFFIX'].every(key => values[key] === undefined || values[key] === 'reg'),
    'OUTPUT', 'ATK returned a different environment.');
  const id = values.MCP_AUTH_REGISTRATION_ID;
  requireProvider(typeof id === 'string' && id.length <= 200 && new RegExp(registrationIdSchema.pattern).test(id),
    'OUTPUT', 'ATK did not return a valid opaque registration ID.');
  requireProvider(type !== 'entra-sso' || validApplicationIdUri(values.MCP_AUTH_APPLICATION_ID_URI),
    'OUTPUT', 'ATK did not return the SSO Application ID URI.');
  return { registrationId: id, ...(type === 'entra-sso' ? { applicationIdUri: values.MCP_AUTH_APPLICATION_ID_URI } : {}) };
}
export async function runAtkProcess(provider, args, { runtime, interactive = false, secret, signal }, {
  spawnProcess = spawn, killGroup = (pid, value) => process.kill(-pid, value),
  terminal = () => process.stdin.isTTY && process.stderr.isTTY, timeoutMs = 120000, killAfterMs = 2000, graceMs = 5000,
} = {}) {
  requireProvider(!signal?.aborted, 'ABORTED', 'Provider operation was cancelled before dispatch.');
  requireProvider(!interactive || terminal(), 'TERMINAL',
    'ATK browser login requires an interactive terminal; authentication URLs are not retained in JSON.');
  return new Promise((resolve, reject) => {
    let output = '', total = 0, failure, killTimer, termination, closed = false;
    const child = spawnProcess(provider.node, [provider.entry, ...args, '--telemetry', 'false'], {
      cwd: path.join(runtime, 'job'), env: atkEnvironment(path.join(runtime, 'home'), secret),
      shell: false, detached: true, stdio: interactive ? ['inherit', process.stderr, process.stderr] : ['ignore', 'pipe', 'pipe'],
    });
    const kill = signalName => {
      if (!child.pid) return;
      try { killGroup(child.pid, signalName); }
      catch (error) { if (error.code !== 'ESRCH') failure = 'TERMINATION_UNCONFIRMED'; }
    };
    const stop = code => {
      failure ??= code; kill('SIGTERM');
      killTimer ??= setTimeout(() => { kill('SIGKILL'); }, killAfterMs);
      termination ??= setTimeout(() => {
        if (!closed) {
          cleanup();
          reject(Object.assign(new Error('Provider termination could not be confirmed. Preserve the session lock and runtime.'),
            { code: 'ATK_TERMINATION_UNCONFIRMED', pid: child.pid }));
        }
      }, graceMs);
    };
    const abort = () => stop('ABORTED');
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = interactive ? undefined : setTimeout(() => stop('TIMEOUT'), timeoutMs);
    if (signal?.aborted) abort();
    function cleanup() {
      clearTimeout(timeout); clearTimeout(killTimer); clearTimeout(termination); signal?.removeEventListener('abort', abort);
    }
    if (!interactive) {
      child.stdout.on('data', bytes => { total += bytes.length; if (total <= maximum) output += bytes.toString('utf8'); else stop('OUTPUT_LIMIT'); });
      child.stderr.on('data', bytes => { total += bytes.length; if (total > maximum) stop('OUTPUT_LIMIT'); });
    }
    child.once('error', () => { failure ??= 'PROCESS'; });
    child.once('close', code => {
      closed = true; kill('SIGKILL'); cleanup();
      if (failure || code !== 0) reject(Object.assign(new Error('ATK operation failed or was interrupted. Raw provider output is not retained; do not replay registration.'), { code: `ATK_${failure ?? 'PROCESS'}`, pid: child.pid }));
      else resolve(output);
    });
  });
}
export const atkProvider = {
  platform: () => process.platform,
  path: owner => runtimePath(owner.epoch),
  inspect: inspectAtkProvider,
  open: createRuntime,
  validate: validateRuntime,
  run: runAtkProcess,
  async login(provider, runtime, owner, operator, options) {
    await this.validate(runtime, owner);
    // ATK's guided mode discards --tenant; argument mode still performs browser authentication.
    await this.run(provider, ['auth', 'login', 'm365', '--tenant', operator.tenantId, '--interactive', 'false'],
      { runtime, interactive: true, signal: options.signal });
    return this.account(provider, runtime, owner, operator, options);
  },
  async account(provider, runtime, owner, operator, options) {
    await this.validate(runtime, owner);
    const output = await this.run(provider, ['auth', 'list', 'm365', '--interactive', 'false'], { runtime, signal: options.signal });
    const selected = (await boundedFile(path.join(runtime, 'home', '.fx', 'account', 'tenantId.cache.appStudio'), 128)).toString('utf8').trim();
    requireProvider(selected.toLowerCase() === operator.tenantId.toLowerCase(), 'IDENTITY', 'ATK selected tenant changed. No registration is permitted.');
    return parseAtkAccount(output, operator);
  },
  async register(provider, runtime, owner, action, type, options) {
    await this.validate(runtime, owner);
    const job = path.join(runtime, 'job');
    await mkdir(path.join(job, 'env'), { mode: 0o700 });
    await writeFile(path.join(job, 'm365agents.yml'), JSON.stringify({
      version: 'v1.13', environmentFolderPath: './env', provision: [action],
    }), { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(job, 'env', '.env.reg'), 'TEAMSFX_ENV=reg\nAPP_NAME_SUFFIX=reg\n', { flag: 'wx', mode: 0o600 });
    await this.run(provider, ['provision', '--folder', job, '--env', 'reg', '--interactive', 'false'],
      { runtime, secret: options.secret, signal: options.signal });
    await this.validate(runtime, owner);
    return parseAtkRegistrationEnv((await boundedFile(path.join(job, 'env', '.env.reg'), 16384)).toString('utf8'), type);
  },
  async close(runtime, owner) {
    requireProvider(process.platform === 'linux' && runtime === runtimePath(owner.epoch), 'RUNTIME', 'Unexpected private runtime location.');
    try { await lstat(runtime); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await validateRuntime(runtime, owner, { complete: false });
    await rm(runtime, { recursive: true, force: false });
  },
};
