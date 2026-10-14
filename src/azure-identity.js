import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { assertProjectPath } from './config.js';
import { fingerprint } from './apim-safety.js';
import { needsSso } from './contract.js';
import { secretIssues } from './validation.js';
import { validateAzureDeviceCode } from './azure-device-code.js';
import { cliStage } from './cli-feedback.js';
import { recoveryBarrier } from './mcp-recovery.js';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const stateName = '.azure-identity.json';
export class AzureIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AzureIdentityError';
    this.code = 'AZURE_IDENTITY_REQUIRED';
  }
}
const ensure = (condition, message) => { if (!condition) throw new AzureIdentityError(message); };
export function validateAzureAccountTarget(value) {
  ensure(value && Object.keys(value).sort().join(',') === 'accountName,subscriptionId,tenantId'
    && uuid.test(value.tenantId) && uuid.test(value.subscriptionId)
    && typeof value.accountName === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.+@-]{0,253}$/.test(value.accountName)
    && !secretIssues(value.accountName),
  'Explicit tenant ID, subscription ID and nonsecret Azure account name are required. Run mcp-account-plan; no ambient account fallback.');
  return { tenantId: value.tenantId.toLowerCase(), subscriptionId: value.subscriptionId.toLowerCase(),
    accountName: value.accountName.toLowerCase() };
}
const target = validateAzureAccountTarget;
async function location(projectDir) {
  const dir = await assertProjectPath(path.resolve(projectDir));
  return { dir, stateFile: await assertProjectPath(path.join(dir, stateName), { workspaceRoot: dir }) };
}
async function stateAt(projectDir) {
  const { dir, stateFile } = await location(projectDir);
  let state;
  try {
    const stat = await lstat(stateFile);
    ensure(stat.isFile() && stat.size < 16384, 'Azure identity selection must be a bounded regular file.');
    state = JSON.parse(await readFile(stateFile, 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; return { dir, stateFile, state: null }; }
  ensure(state.schemaVersion === 1 && ['pending', 'selected'].includes(state.status) && uuid.test(state.epoch),
    'Invalid Azure identity selection. Review a new account-switch plan.');
  state.target = target(state.target);
  return { dir, stateFile, state };
}
async function persist(filename, state) {
  const temp = `${filename}.${randomUUID()}.pending`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(state, null, 2)}\n`); await file.sync(); }
  finally { await file.close(); }
  await rename(temp, filename);
}
function parsed(result) {
  if (result?.code) throw new AzureIdentityError('Azure identity command failed. No deployment is approved.');
  const value = result?.stdout ?? result;
  return typeof value === 'string' ? JSON.parse(value.replace(/^\uFEFF/, '')) : value;
}
function verifyAccount(account, selected) {
  ensure(account?.tenantId?.toLowerCase() === selected.tenantId
    && account?.id?.toLowerCase() === selected.subscriptionId
    && account?.user?.name?.toLowerCase() === selected.accountName
    && account?.user?.type?.toLowerCase() === 'user',
  'Azure account/tenant/subscription mismatch. No mutation is allowed; switch account and review the deployment again.');
}
export async function planAzureAccountSwitch(projectDir, requested, { useDeviceCode = false } = {}) {
  ensure(typeof useDeviceCode === 'boolean', 'useDeviceCode must be an explicit boolean login choice.');
  const selected = target(requested);
  const { dir, state } = await stateAt(projectDir);
  const plan = { schemaVersion: 1, action: 'azure-account-switch', projectDir: dir, target: selected,
    previousEpoch: state?.epoch ?? null,
    ...(useDeviceCode ? { loginMode: 'device-code' } : {}),
    effects: ['Create a fresh project-private Azure CLI authentication context; never log out or change the shared Azure CLI account.',
      useDeviceCode
        ? 'Initiate Azure device-code sign-in for the explicitly selected tenant. Display only the validated Microsoft sign-in URI and transient user code; select the explicit subscription and verify the exact user account.'
        : 'Open Azure browser login for the explicitly selected tenant, select the explicit subscription, and verify the exact user account.',
      'Invalidate earlier deployment approvals before login, including a cancelled or failed login. No Azure resources are created.'] };
  return { ...plan, approvalToken: `azure-login/${fingerprint(plan)}` };
}
export async function switchAzureAccount(projectDir, requested, { approval, run, approve, useDeviceCode = false, onAzureDeviceCode, signal } = {}) {
  ensure(typeof run === 'function', 'An Azure command runner is required.');
  ensure(!useDeviceCode || typeof onAzureDeviceCode === 'function', 'Device-code login requires an explicit transient sign-in display.');
  const plan = await planAzureAccountSwitch(projectDir, requested, { useDeviceCode });
  if (approve && await approve(structuredClone(plan)) !== true) return { status: 'declined' };
  ensure(approval === plan.approvalToken || (typeof approve === 'function' && approval === undefined),
    'Exact mcp-account-plan approval is required. Login approval is not resource-provision approval.');
  ensure(!signal?.aborted, 'Account login was cancelled before authentication started.');
  const { dir, stateFile } = await location(projectDir);
  const lockPath = await assertProjectPath(path.join(dir, '.provisioning.lock'), { workspaceRoot: dir });
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    ensure((await planAzureAccountSwitch(projectDir, requested, { useDeviceCode })).approvalToken === plan.approvalToken,
      'Account selection changed after review; re-plan the switch.');
    const state = { schemaVersion: 1, status: 'pending', epoch: randomUUID(), target: plan.target };
    await persist(stateFile, state);
    const azureConfigDir = await assertProjectPath(path.join(dir, '.azure-auth', state.epoch), { workspaceRoot: dir });
    await mkdir(azureConfigDir, { recursive: true, mode: 0o700 });
    const options = { cwd: dir, azureConfigDir, ...(signal ? { signal } : {}) };
    let delivered = false;
    cliStage(useDeviceCode ? 'azure-login' : 'azure-browser');
    await run('az', ['login', '--tenant', state.target.tenantId, ...(useDeviceCode ? ['--use-device-code'] : []),
      '--output', 'none', ...(!useDeviceCode ? ['--only-show-errors'] : [])], { ...options, ...(useDeviceCode ? {
      onAzureDeviceCode: value => { onAzureDeviceCode(validateAzureDeviceCode(value)); delivered = true; cliStage('azure-user'); },
    } : {}) });
    ensure(!useDeviceCode || delivered, 'Azure login did not deliver a validated device code. No account is selected; review a fresh login plan.');
    ensure(!signal?.aborted, 'Account login was cancelled. No account is selected.');
    cliStage('azure-select');
    await run('az', ['account', 'set', '--subscription', state.target.subscriptionId, '--only-show-errors'], options);
    verifyAccount(parsed(await run('az', ['account', 'show', '--query',
      '{tenantId:tenantId,id:id,user:user}', '--output', 'json', '--only-show-errors'], options)), state.target);
    ensure(!signal?.aborted, 'Account selection was cancelled. No account is selected.');
    state.status = 'selected';
    await persist(stateFile, state);
    return { status: 'account-selected-not-deployed', target: state.target, epoch: state.epoch,
      nextStep: 'Review a fresh provisioning plan. Account login approval does not authorize resources, registration or consent.' };
  } finally { await lock.close(); await unlink(lockPath); }
}
async function sessionStamp(azureConfigDir) {
  const stamp = [];
  // Profile rewrites indicate login/account selection. Token refresh caches are not identity changes.
  for (const name of ['azureProfile.json']) {
    const filename = await assertProjectPath(path.join(azureConfigDir, name));
    try {
      const stat = await lstat(filename);
      ensure(stat.isFile() && !stat.isSymbolicLink(), 'Azure authentication cache must not contain links.');
      stamp.push({ name, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return fingerprint(stamp);
}
export async function readAzureIdentity(config, projectDir, { required = false } = {}) {
  const { dir, state } = await stateAt(projectDir);
  if (!state || state.status !== 'selected') {
    ensure(!required, 'Select an explicit Azure account, tenant and subscription with mcp-account-plan / mcp-account-switch before provisioning.');
    return null;
  }
  ensure(!await recoveryBarrier(dir, { identityEpoch: state.epoch }),
    'Restored identity selection is historical only. Review a fresh private account-switch plan; no imported epoch or authentication cache authorizes execution.');
  const tenants = (config.connectors ?? []).filter(needsSso).map(c => c.entra?.tenantId ?? config.azure?.tenantId);
  ensure(tenants.every(id => id?.toLowerCase() === state.target.tenantId)
    && (!config.azure || (config.azure.tenantId.toLowerCase() === state.target.tenantId
      && config.azure.subscriptionId.toLowerCase() === state.target.subscriptionId)),
  'Selected Azure identity differs from this project target. Review an explicit account switch; never use the ambient tenant.');
  const azureConfigDir = await assertProjectPath(path.join(dir, '.azure-auth', state.epoch), { workspaceRoot: dir });
  return { schemaVersion: 1, projectDir: dir, epoch: state.epoch, target: state.target,
    sessionStamp: await sessionStamp(azureConfigDir) };
}
export async function azureIdentityGuard(config, projectDir, binding, run) {
  ensure(binding, 'Explicit Azure identity selection is missing. Run mcp-account-plan / mcp-account-switch first.');
  const current = await readAzureIdentity(config, projectDir, { required: true });
  ensure(fingerprint(current) === fingerprint(binding), 'Azure login/session changed after approval. Review a fresh deployment plan.');
  const azureConfigDir = await assertProjectPath(path.join(current.projectDir, '.azure-auth', current.epoch), { workspaceRoot: current.projectDir });
  const options = { cwd: projectDir, azureConfigDir };
  verifyAccount(parsed(await run('az', ['account', 'show', '--query', '{tenantId:tenantId,id:id,user:user}',
    '--output', 'json', '--only-show-errors'], options)), binding.target);
  ensure(fingerprint(await readAzureIdentity(config, projectDir, { required: true })) === fingerprint(binding),
    'Azure authentication changed during identity verification; re-plan before mutation.');
  return options;
}
