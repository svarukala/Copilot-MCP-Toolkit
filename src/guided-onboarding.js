import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import path from 'node:path';
import { lstat, mkdir } from 'node:fs/promises';
import { assertProjectPath, withCliWorkspace } from './config.js';
import { readControl, writeControl, withControlLock } from './mcp-control.js';
import { boundedSnapshot, metadataDigest, savedJson } from './anonymous-metadata.js';
import { secretIssues } from './validation.js';
import { loadAuthRegistration, planAuthRegistrationBundle, writeAuthRegistrationBundle, readAuthRegistrationBundle } from './mcp-auth-registration.js';
import { planAuthExecution, executeAuthPhase, readAuthExecutionStatus } from './mcp-auth-execution.js';
import { prepareFccInput } from './mcp-fcc.js';
import { consumerChoices, consumerNextSteps, planConsumerBundle, writeConsumerBundle, readConsumerBundle } from './mcp-consumer.js';

export const onboardingSchema = {
  type: 'object', additionalProperties: false, required: ['schemaVersion', 'fccConfig', 'registrationConfig'],
  properties: {
    schemaVersion: { const: 1 },
    fccConfig: { type: 'string', minLength: 1, maxLength: 2048 },
    registrationConfig: { type: 'string', minLength: 1, maxLength: 2048 },
    authExecutionConfig: { type: 'string', minLength: 1, maxLength: 2048 },
    authProject: { type: 'string', minLength: 1, maxLength: 2048 },
    pluginAppId: { type: 'string', format: 'uuid' },
  },
  dependencies: { authExecutionConfig: ['authProject'], authProject: ['authExecutionConfig'] },
};
const ajv = new Ajv(); addFormats(ajv);
const valid = ajv.compile(onboardingSchema);
const digest = value => metadataDigest(boundedSnapshot(value));
const ensure = (ok, code, message) => {
  if (!ok) throw Object.assign(new Error(message), { code: `MCP_ONBOARD_${code}` });
};
async function exists(file) {
  try { await lstat(await assertProjectPath(file)); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function writeOnce(file, value) {
  if (await exists(file)) ensure(digest(await readControl(file)) === digest(value), 'CHANGED',
    'A saved onboarding input differs. Preserve it and the registration attempt; do not overwrite or retry.');
  else await writeControl(file, value, { create: true });
}
async function approve(p, plan) {
  ensure(!p.signal?.aborted, 'CANCELLED', 'Onboarding cancelled before approval.');
  p.output.write(`\nExact next operation (not approval for later operations):\n${savedJson(plan)}\n`);
  return await p.choose('Approve only this exact operation?', [
    { value: 'approve', label: 'Approve this exact plan and its listed effects' },
    { value: 'stop', label: 'Stop and keep the saved state' },
  ]) === 'approve' && !p.signal?.aborted;
}
async function loadInput(configFile) {
  const input = await readControl(configFile);
  ensure(valid(input) && !secretIssues(savedJson(input)), 'INPUT', 'Use mcp-onboard-schema with nonsecret prepared inputs.');
  const resolve = file => assertProjectPath(path.resolve(path.dirname(configFile), file));
  const fccConfig = await resolve(input.fccConfig), registrationConfig = await resolve(input.registrationConfig);
  const fcc = await prepareFccInput(fccConfig), registration = await loadAuthRegistration(registrationConfig);
  ensure(registration.input.registration.type === 'entra-sso'
    && fcc.bundle.authentication.type === 'entra-sso'
    && fcc.bundle.endpoint.descriptorDigest === registration.descriptor.descriptorDigest, 'DESCRIPTOR',
  'Both routes require the same exact Entra MCP descriptor and secretless SSO registration.');
  const reference = registration.input.registration.reference;
  for (const key of ['registrationId', 'applicationIdUri']) {
    ensure(fcc.bundle.authentication[key] === undefined || fcc.bundle.authentication[key] === reference?.[key],
      'REFERENCE', 'FCC authentication conflicts with the shared registration. Preserve the existing reference.');
  }
  let authExecutionConfig, authProject, execution;
  if (input.authExecutionConfig) {
    authExecutionConfig = await resolve(input.authExecutionConfig);
    authProject = await resolve(input.authProject);
    execution = await readControl(authExecutionConfig);
    ensure(path.resolve(path.dirname(authExecutionConfig), execution.registrationConfig) === registrationConfig,
      'REGISTRATION_CONFIG', 'The existing executor must select this exact registration config.');
  }
  const { contentDigest: derivedFccDigest, ...sourceBinding } = fcc.binding;
  const binding = { configFile, inputDigest: digest(input), fcc: sourceBinding,
    registrationConfig, registration: digest({ input: registration.input, descriptor: registration.descriptor,
      sourceResult: registration.sourceResult }), executionDigest: execution ? digest(execution) : null };
  return { input, fccConfig, fcc, registrationConfig, registration, authExecutionConfig, authProject, binding };
}
function paused(project, reason, extra = {}) {
  return { status: 'onboarding-paused', project, reason, ...extra,
    resume: ['mcp-onboard', '--workspace-root', path.dirname(project), '--project', project],
    executionReadiness: false, proofReplayAuthorized: false };
}
async function continueOnboarding(p, options, session, dependencies) {
  const project = session.project;
  const completedFile = path.join(project, 'completed.json');
  if (await exists(completedFile)) {
    const result = await readControl(completedFile), bundle = await readConsumerBundle(path.join(project, 'handover'));
    ensure(result.contentDigest === bundle.contentDigest && result.consumer === session.consumer, 'CHANGED', 'Completed output differs from its receipt.');
    return result;
  }
  const current = await loadInput(session.configFile);
  ensure(digest(current.binding) === session.inputDigest, 'CHANGED',
    'Prepared inputs, descriptor or capture changed since this onboarding session was saved. Preserve registration receipts and resume via explicit reviewed commands; do not start registration again.');
  let registrationInput = current.registration.input;
  if (!registrationInput.registration.reference) {
    if (!current.authExecutionConfig) return paused(project, 'Supply separately reviewed authExecutionConfig and authProject before starting a new session; the registration reference is missing.');
    const auth = { workspaceRoot: options.workspaceRoot, config: current.authExecutionConfig,
      project: current.authProject, signal: p.signal };
    let status = await readAuthExecutionStatus(auth);
    const phases = { 'not-initialized': 'initialize', 'initialized-not-signed-in': 'login',
      'signed-in-requires-identity-confirmation': 'register' };
    while (!status.registration) {
      const phase = phases[status.status];
      if (!phase) return paused(project, `Authentication is ${status.status}; preserve consumed/unknown operations. No retry.`, { authentication: status });
      const plan = await planAuthExecution({ ...auth, phase }, dependencies);
      if (plan.status !== 'planned') return paused(project, 'Authentication prerequisites are blocked; no provider operation started.', { authenticationPlan: plan });
      if (!await approve(p, plan)) return paused(project, `Stopped before authentication ${phase}.`);
      await executeAuthPhase({ ...auth, phase, approval: plan.approvalToken, allowProvider: true,
        ...(['login', 'register'].includes(phase) ? { allowNetwork: true } : {}),
        ...(phase === 'login' ? { interactive: true } : {}),
        ...(phase === 'register' ? { confirmIdentity: true } : {}),
      }, dependencies);
      status = await readAuthExecutionStatus(auth);
    }
    registrationInput = structuredClone(registrationInput);
    registrationInput.source.registrationResultFile = path.join(current.authProject, 'result.json');
    registrationInput.source.descriptorFile = current.registration.descriptorFile;
    const importedFile = path.join(project, 'registration-result-input.json');
    await writeOnce(importedFile, registrationInput);
    current.registration = await loadAuthRegistration(importedFile);
    current.registrationConfig = importedFile;
    if (status.status !== 'closed') {
      const plan = await planAuthExecution({ ...auth, phase: 'close' }, dependencies);
      if (await approve(p, plan)) await executeAuthPhase({ ...auth, phase: 'close',
        approval: plan.approvalToken, allowProvider: true }, dependencies);
      else return paused(project, 'Registration was saved. Stop before closing the provider runtime and exporting; resume does not register again.',
        { registration: status.registration });
    }
  }
  const authBundleFile = path.join(project, 'authentication.json');
  if (!await exists(authBundleFile)) {
    const operation = { workspaceRoot: options.workspaceRoot, config: current.registrationConfig, output: authBundleFile };
    const plan = await planAuthRegistrationBundle(operation);
    if (!await approve(p, plan)) return paused(project, 'Stopped before exporting the shared registration reference.');
    await writeAuthRegistrationBundle({ ...operation, approval: plan.approvalToken });
  }
  const authentication = await readAuthRegistrationBundle(authBundleFile, current.registration.descriptor);
  ensure(digest(authentication.request.registration) === digest(current.registration.input.registration),
    'REFERENCE', 'The saved authentication bundle does not match the selected registration.');
  const fccInput = await readControl(current.fccConfig);
  fccInput.source = { descriptorFile: current.fcc.binding.descriptorFile,
    ...(current.fcc.binding.captureFile ? { captureFile: current.fcc.binding.captureFile } : {}),
    authenticationBundleFile: authBundleFile };
  const fccFile = path.join(project, 'fcc-input.json');
  await writeOnce(fccFile, fccInput);
  const consumerFile = path.join(project, 'consumer-input.json');
  await writeOnce(consumerFile, { schemaVersion: 1, consumer: session.consumer, fccConfig: fccFile,
    ...(session.consumer === 'plugin' && current.input.pluginAppId ? { pluginAppId: current.input.pluginAppId } : {}) });
  const operation = { workspaceRoot: options.workspaceRoot, config: consumerFile, output: path.join(project, 'handover') };
  const plan = await planConsumerBundle(operation);
  if (!await approve(p, plan)) return paused(project, 'Stopped before local consumer export.');
  const result = await writeConsumerBundle({ ...operation, approval: plan.approvalToken });
  await writeControl(completedFile, result, { create: true });
  return result;
}
export async function guidedOnboarding(p, options, dependencies = {}) {
  ensure(typeof options.workspaceRoot === 'string', 'WORKSPACE', 'Select an explicit private --workspace-root.');
  return withCliWorkspace(options.workspaceRoot, async () => {
    let session, project;
    if (options.project) {
      ensure(!options.config && !options.output && !options.consumer, 'INPUT', 'Resume uses --project only; original input paths stay unchanged.');
      project = await assertProjectPath(path.resolve(options.project));
      session = await readControl(path.join(project, 'onboarding-session.json'));
      const { contentDigest, ...body } = session;
      ensure(contentDigest === digest(body) && session.project === project
        && session.workspaceRoot === path.resolve(options.workspaceRoot) && ['fcc', 'plugin'].includes(session.consumer),
      'STATE', 'Onboarding state is modified or belongs to a different location.');
    } else {
      const consumer = options.consumer ?? await p.choose('What would you like to do with this secured MCP next?', consumerChoices);
      if (consumer === 'none') return { status: 'onboarding-deferred', consumer, writes: false,
        executionReadiness: false, proofReplayAuthorized: false };
      ensure(['fcc', 'plugin'].includes(consumer), 'INPUT', 'Select FCC, plugin or None.');
      const configFile = await assertProjectPath(path.resolve(options.config ?? await p.ask('Prepared onboarding input JSON file (mcp-onboard-schema)')));
      const current = await loadInput(configFile);
      ensure(consumer !== 'plugin' || current.registration.input.registration.applicableToApps !== 'SpecificApp'
        || current.registration.input.registration.appId === current.input.pluginAppId, 'APP_RESTRICTION',
      'Select the actual plugin app ID matching this SpecificApp registration; no silent restriction change.');
      project = await assertProjectPath(path.resolve(options.output ?? await p.ask('NEW private onboarding session directory')));
      ensure(!await exists(project) && (await lstat(path.dirname(project))).isDirectory(), 'OUTPUT',
        'Select a new directory with an existing private parent. Existing sessions must use --project.');
      const body = { schemaVersion: 1, kind: 'mcp-consumer-onboarding-session', consumer,
        workspaceRoot: path.resolve(options.workspaceRoot), project, configFile, inputDigest: digest(current.binding) };
      if (!await approve(p, { action: 'save-onboarding-session', ...body,
        endpoint: current.registration.descriptor.endpoint, registration: current.registration.bundle,
        metadata: current.fcc.bundle,
        effects: ['Save local nonsecret control state only. Registration and export each require their exact review. No deployment, provider proof or publication.'] })) {
        return { status: 'onboarding-deferred', consumer, writes: false };
      }
      await mkdir(project, { mode: 0o700 });
      session = { ...body, contentDigest: digest(body) };
      await writeControl(path.join(project, 'onboarding-session.json'), session, { create: true });
    }
    const result = await withControlLock(project, () => continueOnboarding(p, options, session, dependencies));
    if (result.status === 'onboarding-paused') result.resume[2] = options.workspaceRoot;
    return result;
  });
}
export async function continueConsumerSelection(p, options, dependencies = {}) {
  const selected = await p.choose('What would you like to do with this secured MCP next?', consumerChoices);
  const result = await guidedOnboarding(p, { ...options, consumer: selected }, dependencies);
  const bundle = result.outputPath
    ? await withCliWorkspace(options.workspaceRoot, () => readConsumerBundle(result.outputPath)) : undefined;
  const missingPlugin = selected === 'plugin' && bundle && !bundle.artifacts['plugin/manifest.template.json'];
  return { ...consumerNextSteps(options.workspaceRoot), selected, result,
    status: missingPlugin ? 'consumer-starter-blocked' : result.status, command: result.resume ?? null,
    ...(bundle ? { artifacts: Object.keys(bundle.artifacts), gaps: bundle.gaps } : {}),
    ...(missingPlugin ? { reason: 'HTML was exported, but no plugin manifest was emitted. Resolve the reported missing authentication/tool or reference-size blockers; do not register again or replay proof.' } : {}),
    incomplete: selected !== 'none' && (result.status !== 'consumer-draft-written-not-published' || Boolean(missingPlugin)) };
}
