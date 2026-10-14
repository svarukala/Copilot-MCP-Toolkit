import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, open, rename, unlink } from 'node:fs/promises';
import { assertProjectPath } from './config.js';
import { boundedSnapshot, savedJson } from './anonymous-metadata.js';

export function requireControl(value, message) {
  if (!value) { const error = new Error(message); error.code = 'CONTROL_VALIDATION'; throw error; }
}
export async function readControl(filename, limit = 1048576) {
  await assertProjectPath(filename);
  const stat = await lstat(filename);
  requireControl(stat.isFile() && stat.size <= limit, 'Control input must be a bounded regular file.');
  return boundedSnapshot(JSON.parse(await readFile(filename, 'utf8')), limit);
}
export async function writeControl(filename, value, { create = false } = {}) {
  const text = savedJson(value);
  requireControl(Buffer.byteLength(text) <= 1048576, 'Control state exceeds its bounded size; no further cloud action is allowed.');
  await assertProjectPath(filename);
  const temp = create ? filename : `${filename}.${randomUUID()}.pending`;
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
  if (!create) await rename(temp, filename);
}
export async function withControlLock(dir, action) {
  const filename = await assertProjectPath(path.join(dir, '.provisioning.lock'));
  let file;
  try { file = await open(filename, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error(
      'An active or interrupted provisioning lock exists. Confirm the owning process has stopped, preserve the lock and attempt history, then use reviewed reconciliation. Never remove an active lock or automatically replay the operation.'),
    { code: 'PROVISIONING_LOCKED' });
    throw error;
  }
  try {
    await file.writeFile(savedJson({ pid: process.pid, startedAt: new Date().toISOString() }));
    await file.sync();
    return await action();
  } finally { await file.close(); await unlink(filename); }
}
export function controlOutput(result) {
  requireControl(!result?.code, 'Selected command failed; no successful readback is established.');
  const raw = result?.stdout ?? result;
  return typeof raw === 'string' ? raw.trim() ? JSON.parse(raw.replace(/^\uFEFF/, '')) : null : raw;
}
export function controlFailure(error, stage) {
  const denied = error?.code === 'AZURE_PERMISSION_DENIED';
  const identity = ['AZURE_IDENTITY_REQUIRED', 'AZURE_CLI_MFA_REQUIRED', 'AZURE_CLI_AUTHENTICATION_FAILED'].includes(error?.code);
  const unresolvedScope = error?.code === 'GRAPH_PREAUTH_SCOPE_UNRESOLVED';
  const runnerGuidance = {
    AZURE_APIM_ACTIVATION_FAILED: 'Azure reported APIM activation failure. Inspect the exact service provisioning state and deployment operations with the owner or Azure support. Preserve failed resource and attempt history; no automatic recreation, deletion or retry. A different compatible existing APIM requires a new reviewed target.',
    PROVISIONING_LOCKED: 'An active or interrupted provisioning lock exists. Confirm the owning process has stopped before operator recovery; preserve the lock and attempt history and reconcile uncertain work. Never remove an active lock or automatically replay.',
    AZURE_CLI_TRANSIENT_TRANSPORT: 'Known TLS EOF/connection reset/Windows connection abort/no-response disconnect persisted or the command was not retry-eligible. Only allowlisted inspections receive at most three CLI attempts. Keep existing uncertain history; use reviewed reconciliation and a fresh phase approval. No mutation was retried.',
    AZURE_CLI_CERTIFICATE_FAILED: 'Certificate verification failed; no automatic retry, TLS bypass or proxy change was made. Ask the network administrator to investigate trust configuration before reviewed recovery.',
    AZURE_CLI_ABORTED: 'Execution was cancelled; no retry or successful outcome is implied. Keep any uncertain attempt and use reviewed reconciliation before a fresh phase approval.',
    AZURE_INSPECTION_COMMAND_TIMEOUT: 'A logical Azure read exceeded 60 seconds including retries. Preserve failed inspection history; review a fresh read-only inspection. Never replay a gateway.',
    AZURE_INSPECTION_TIMEOUT: 'The read-only inspection exceeded 300 seconds overall. No readiness is established. Preserve evidence and review a fresh inspection.',
    AZURE_CLI_TERMINATION_UNCONFIRMED: 'Azure process exit was not confirmed within the cleanup grace. Keep the provisioning lock and its recorded PID evidence. Confirm the owned process has stopped before operator lock recovery; never automatically remove the lock or replay.',
  };
  const knownRunnerFailure = Object.hasOwn(runnerGuidance, error?.code);
  return { status: denied ? 'blocked-permission' : identity ? 'blocked-identity' : 'blocked-uncertain', stage,
    code: denied || identity || unresolvedScope || knownRunnerFailure ? error.code : 'CONTROL_OPERATION_UNVERIFIED',
    instructions: identity ? 'The exact reviewed Azure identity/session or MFA requirement was not satisfied. Review a fresh account-switch plan for this workspace, select the exact tenant/subscription/user, complete required sign-in, then review a fresh operation plan. Never use an ambient identity or weaken tenant policy.'
      : denied
      ? 'Ask the administrator for only the exact action/scope in the reviewed plan. Azure RBAC and delegated Graph access/app ownership are separate. No application permissions or admin consent are inferred from this login. Reinspect and approve a fresh plan after remediation, or choose a compatible existing resource manually.'
      : unresolvedScope
      ? 'Graph could not resolve the preauthorization scope. Review read-only app reconcile; only exact unchanged or approved-result readback can settle the attempt. Resource configure now creates the scope only; preauthorize requires its own fresh approval after scope readback. Never retry solely because an HTTP rejection was reported.'
      : knownRunnerFailure ? runnerGuidance[error.code]
      : 'Inspect the saved intent and exact resource IDs. Do not replay creation, adopt by display name, remove protections or erase history. Use explicit readback/reconciliation before a fresh approval.' };
}
