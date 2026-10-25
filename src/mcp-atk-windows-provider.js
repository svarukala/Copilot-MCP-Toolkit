import path from 'node:path';
import { userInfo } from 'node:os';
import { spawn } from 'node:child_process';
import { lstat, realpath, readFile, mkdir, writeFile, open, unlink, rm } from 'node:fs/promises';
import { atkProvider, inspectAtkProvider, parseAtkAccount } from './mcp-atk-provider.js';

function requireWindows(ok, code, message) {
  if (!ok) throw Object.assign(new Error(message), { code: `ATK_${code}` });
}
export function windowsAtkProfile(env = process.env, user = userInfo()) {
  const profile = { home: user.homedir, userName: user.username,
    appData: env.APPDATA, localAppData: env.LOCALAPPDATA, systemRoot: env.SystemRoot ?? env.SYSTEMROOT };
  requireWindows(Object.entries(profile).every(([key, value]) => typeof value === 'string'
    && value.length > 0 && !/[\u0000-\u001f]/.test(value)
    && (key === 'userName' || path.win32.isAbsolute(value)))
    && env.USERPROFILE?.toLowerCase() === profile.home.toLowerCase(), 'PROFILE',
  'Native Windows mode requires the normal Windows user profile, not redirected authentication folders.');
  return profile;
}
export function windowsAtkEnvironment(provider, runtime) {
  const p = provider.profile;
  return { SystemRoot: p.systemRoot, WINDIR: p.systemRoot, OS: 'Windows_NT',
    ComSpec: path.win32.join(p.systemRoot, 'System32', 'cmd.exe'),
    PATH: [path.win32.dirname(provider.node), p.systemRoot, path.win32.join(p.systemRoot, 'System32'),
      path.win32.join(p.systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';'),
    HOME: p.home, USERPROFILE: p.home, APPDATA: p.appData, LOCALAPPDATA: p.localAppData,
    TEMP: path.join(runtime, 'tmp'), TMP: path.join(runtime, 'tmp'), NO_COLOR: '1' };
}
function runtimePath(owner) {
  requireWindows(path.isAbsolute(owner.project) && /^[a-f0-9-]{36}$/.test(owner.epoch), 'RUNTIME', 'Invalid owned Windows job location.');
  return path.join(owner.project, `.atk-windows-${owner.epoch}`);
}
async function boundedFile(filename, limit = 16384) {
  const stat = await lstat(filename);
  requireWindows(stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit
    && await realpath(filename) === path.resolve(filename), 'INPUT', 'Expected a bounded regular file without links.');
  const bytes = await readFile(filename);
  requireWindows(bytes.length <= limit, 'INPUT', 'Provider metadata exceeded its bound.');
  return bytes;
}
async function validateRuntime(runtime, owner, { complete = true } = {}) {
  requireWindows(process.platform === 'win32' && runtime === runtimePath(owner)
    && await realpath(runtime) === runtime && (await lstat(runtime)).isDirectory(), 'RUNTIME',
  'Select the original owned Windows job directory; copied sessions and links cannot adopt it.');
  requireWindows((await boundedFile(path.join(runtime, 'owner.json'))).toString() === JSON.stringify(owner),
    'RUNTIME', 'Windows job ownership differs.');
  if (complete) for (const name of ['job', 'tmp']) {
    const directory = path.join(runtime, name);
    requireWindows((await lstat(directory)).isDirectory() && await realpath(directory) === directory,
      'RUNTIME', 'Windows job directories must not traverse links.');
  }
}

export async function terminateWindowsAtkTree(pid, systemRoot, { spawnProcess = spawn, timeoutMs = 10000 } = {}) {
  requireWindows(Number.isSafeInteger(pid) && pid > 0, 'TERMINATION_UNCONFIRMED', 'No owned Windows process ID is available.');
  return new Promise(resolve => {
    let settled = false;
    const finish = ok => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok); } };
    const child = spawnProcess(path.win32.join(systemRoot, 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); finish(false); }, timeoutMs);
    child.once('error', () => finish(false));
    child.once('close', code => finish(code === 0));
  });
}
export async function runWindowsAtkProcess(provider, args, { runtime, interactive = false, signal, secret }, {
  spawnProcess = spawn, terminal = () => process.stdin.isTTY && process.stderr.isTTY,
  terminate = pid => terminateWindowsAtkTree(pid, provider.profile.systemRoot, { spawnProcess }),
  timeoutMs = 120000, graceMs = 15000,
} = {}) {
  requireWindows(secret === undefined, 'INPUT', 'Native Windows execution is limited to secretless Entra SSO.');
  requireWindows(!signal?.aborted, 'ABORTED', 'Cancelled before provider dispatch.');
  requireWindows(!interactive || terminal(), 'TERMINAL', 'Windows sign-in requires a real terminal; challenges are never captured.');
  return new Promise((resolve, reject) => {
    let output = '', bytes = 0, failure, closed = false, exitCode, stopping = false, terminated, grace;
    const child = spawnProcess(provider.node, [provider.entry, ...args, '--telemetry', 'false'], {
      cwd: path.join(runtime, 'job'), env: windowsAtkEnvironment(provider, runtime),
      shell: false, detached: false, windowsHide: true,
      stdio: interactive ? ['inherit', process.stderr, process.stderr] : ['ignore', 'pipe', 'pipe'],
    });
    const cleanup = () => { clearTimeout(timeout); clearTimeout(grace); signal?.removeEventListener('abort', abort); };
    const failUnconfirmed = () => {
      cleanup();
      reject(Object.assign(new Error('Windows provider process-tree termination is unconfirmed; preserve both locks and job files.'),
        { code: 'ATK_TERMINATION_UNCONFIRMED', pid: child.pid }));
    };
    const finish = () => {
      if (!closed || stopping && terminated === undefined) return;
      if (stopping && !terminated) { failUnconfirmed(); return; }
      cleanup();
      if (failure || exitCode !== 0) reject(Object.assign(new Error('Windows ATK operation failed; raw output is not retained and registration must not be replayed.'),
        { code: `ATK_${failure ?? 'PROCESS'}`, pid: child.pid }));
      else resolve(output);
    };
    const stop = code => {
      if (stopping || closed) return;
      stopping = true; failure = code;
      grace = setTimeout(failUnconfirmed, graceMs);
      Promise.resolve().then(() => closed ? false : terminate(child.pid)).then(ok => {
        terminated = ok === true; if (!terminated) failUnconfirmed(); else finish();
      }, failUnconfirmed);
    };
    const abort = () => stop('ABORTED');
    const timeout = interactive ? undefined : setTimeout(() => stop('TIMEOUT'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (!interactive) {
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes <= 1048576) output += chunk.toString('utf8'); else stop('OUTPUT_LIMIT'); });
      child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 1048576) stop('OUTPUT_LIMIT'); });
    }
    child.once('error', () => { failure ??= 'PROCESS'; });
    child.once('close', code => { closed = true; exitCode = code; finish(); });
  });
}

export const windowsAtkProvider = {
  ...atkProvider,
  currentProfile: windowsAtkProfile,
  path: runtimePath,
  async inspect(root) {
    return { ...await inspectAtkProvider(root), authenticationMode: 'windows-user-managed',
      profile: process.platform === 'win32' ? this.currentProfile() : null };
  },
  async open(owner) {
    requireWindows(process.platform === 'win32', 'PLATFORM', 'Native Windows mode requires Windows.');
    const runtime = runtimePath(owner);
    await mkdir(runtime);
    await writeFile(path.join(runtime, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
    for (const name of ['job', 'tmp']) await mkdir(path.join(runtime, name));
    await validateRuntime(runtime, owner);
    return runtime;
  },
  validate: validateRuntime,
  run: runWindowsAtkProcess,
  async acquireProfileLease(provider, owner) {
    requireWindows(JSON.stringify(provider.profile) === JSON.stringify(this.currentProfile()),
      'PROFILE', 'The normal Windows profile changed after review.');
    const directory = path.join(provider.profile.localAppData, 'CopilotMcpToolkit');
    await mkdir(directory, { recursive: true });
    requireWindows(await realpath(directory) === directory, 'PROFILE', 'Profile coordination directory must not traverse links.');
    const filename = path.join(directory, 'atk-windows-operation.lock');
    const lock = await open(filename, 'wx');
    const marker = JSON.stringify({ ...owner, toolkitPid: process.pid });
    try { await lock.writeFile(marker); await lock.sync(); } finally { await lock.close(); }
    return async () => {
      requireWindows((await boundedFile(filename)).toString() === marker, 'PROFILE', 'Profile operation lock ownership changed.');
      await unlink(filename);
    };
  },
  async account(provider, runtime, owner, operator, options) {
    await this.validate(runtime, owner);
    requireWindows(JSON.stringify(provider.profile) === JSON.stringify(this.currentProfile()),
      'PROFILE', 'The normal Windows profile changed after review.');
    const output = await this.run(provider, ['auth', 'list', 'm365', '--interactive', 'false'], { runtime, signal: options.signal });
    const selected = (await boundedFile(path.join(provider.profile.home, '.fx', 'account', 'tenantId.cache.appStudio'), 128)).toString().trim();
    requireWindows(selected.toLowerCase() === operator.tenantId.toLowerCase(), 'IDENTITY',
      'The user-managed ATK selected tenant differs from the explicit tenant.');
    return parseAtkAccount(output, operator);
  },
  async register(provider, runtime, owner, action, type, options) {
    requireWindows(type === 'entra-sso' && options.secret === undefined, 'INPUT', 'Native Windows execution supports only secretless Entra SSO.');
    return atkProvider.register.call(this, provider, runtime, owner, action, type, options);
  },
  async close(runtime, owner) {
    requireWindows(process.platform === 'win32' && runtime === runtimePath(owner), 'RUNTIME', 'Unexpected Windows job directory.');
    try { await lstat(runtime); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await validateRuntime(runtime, owner, { complete: false });
    await rm(runtime, { recursive: true, force: false });
  },
};
