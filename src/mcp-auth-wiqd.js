import Ajv from 'ajv';
import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { assertProjectPath, isWithin, withCliWorkspace } from './config.js';
import { readControl } from './mcp-control.js';
import { boundedSnapshot, metadataDigest, savedJson } from './anonymous-metadata.js';
import { secretIssues } from './validation.js';
import { loadAuthRegistration } from './mcp-auth-registration.js';
import { writeNewJsonBundle } from './mcp-bundle-write.js';

export const authWiqdSchema = {
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'registrationConfig', 'wiqdProject', 'environment'],
  properties: {
    schemaVersion: { const: 1 },
    registrationConfig: { type: 'string', minLength: 1, maxLength: 2048 },
    wiqdProject: { type: 'string', minLength: 1, maxLength: 2048 },
    environment: { type: 'string', maxLength: 64, pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]*(?![\\s\\S])' },
  },
};
const validConfig = new Ajv().compile(authWiqdSchema);
const hash = value => metadataDigest(boundedSnapshot(value));
function requireHandoff(ok, code, message) {
  if (!ok) throw Object.assign(new Error(message), { code: `MCP_AUTH_WIQD_${code}` });
}
const quote = value => `'${value.replaceAll("'", "''")}'`;
const command = args => ({ executable: 'wiqd', args, powershell: `wiqd ${args.map(quote).join(' ')}` });

async function prepare(options) {
  requireHandoff(typeof options.config === 'string' && typeof options.output === 'string',
    'INPUT', 'WIQD handoff requires --config and a new --output JSON file.');
  const configFile = await assertProjectPath(path.resolve(options.config));
  const config = await readControl(configFile);
  requireHandoff(validConfig(config) && !secretIssues(savedJson(config)), 'INPUT',
    'Use mcp-auth-wiqd-schema with nonsecret paths and an explicit environment.');
  const registrationConfig = await assertProjectPath(path.resolve(path.dirname(configFile), config.registrationConfig));
  const wiqdProject = await assertProjectPath(path.resolve(path.dirname(configFile), config.wiqdProject));
  requireHandoff((await lstat(wiqdProject)).isDirectory(), 'PROJECT',
    'Select an existing private WIQD project directory. This command never creates a dummy app or edits a WIQD project.');
  const outputPath = await assertProjectPath(path.resolve(options.output));
  requireHandoff(!isWithin(wiqdProject, outputPath), 'OUTPUT',
    'Write the handoff outside the WIQD project; this operation must not add or change project files.');
  requireHandoff(path.extname(outputPath).toLowerCase() === '.json'
    && (await lstat(path.dirname(outputPath))).isDirectory(), 'OUTPUT',
  'Output must be a new .json file in an existing private directory.');
  try { await lstat(outputPath); requireHandoff(false, 'OUTPUT_EXISTS', 'Choose a new output; historical handoffs cannot be overwritten.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const selected = await loadAuthRegistration(registrationConfig);
  const preparation = selected.bundle;
  const action = preparation.providerPreparation.action;
  const reference = selected.input.registration.reference;
  const gaps = [
    { code: 'WIQD_PROJECT_REVIEW_REQUIRED', message: 'Project contents were not inspected or changed. Review the actual app ID, both lifecycle files and all provisioning effects in WIQD.' },
    { code: 'USER_MANAGED_IDENTITY_REVIEW_REQUIRED', message: 'WIQD owns its normal user-profile authentication. Confirm its actual account and tenant; the toolkit neither authenticates nor isolates that profile.' },
    { code: 'CONSUMER_VERIFICATION_REQUIRED', message: 'A registration ID does not verify settings, consent, endpoint compatibility or FCC/plugin execution.' },
    ...preparation.readiness.gaps.filter(gap => ['APP_ID_MISSING', 'SECRET_RESOLUTION_UNIMPLEMENTED'].includes(gap.code)),
  ];
  const attribution = ['--skill', 'wiqd', '--workflow', 'wiqd-core'];
  const context = ['--env', config.environment, '--path', wiqdProject];
  const content = boundedSnapshot({
    schemaVersion: 1, kind: 'mcp-auth-wiqd-handoff', producer: preparation.producer,
    mode: 'operator-managed-wiqd-not-toolkit-auth-execution',
    preparation,
    target: { project: wiqdProject, environment: config.environment, contentsReviewed: false },
    provider: { name: '@microsoft/wiqd', guidanceVersion: '0.18.0', installationInspected: false,
      authenticationOwner: 'user-managed-wiqd-profile', projectIsolatedByToolkit: false,
      linuxRequired: false, automaticExecution: false, liveQualified: false },
    readiness: { status: 'blocked', gaps },
    registration: { status: reference ? 'provided-unverified' : action ? 'review-only' : 'not-emitted',
      action, ...(reference ? { reference } : {}) },
    commands: action ? {
      version: command(['--version', ...attribution]),
      login: command(['auth', 'login', '--interactive', ...attribution]),
      validate: command(['agent', 'validate', '--json', ...attribution, ...context]),
      provision: command(['agent', 'provision', '--json', ...attribution, ...context]),
    } : {},
    steps: [
      'This JSON is a human handoff, not a WIQD input file. None of its commands are executed or authorized by exporting it.',
      ...(action ? [
        'Check the installed WIQD version and its supported authentication/lifecycle contract before applying this reviewed action.',
        'Use the existing intended app. Confirm registration.action.with.appId is the intended M365/Teams app ID; do not generate a dummy ID or silently broaden restrictions.',
        'Through the normal WIQD authoring workflow, merge registration.action as one provision step in BOTH m365agents.yml and m365agents.local.yml. Preserve unrelated content and existing registration references. Do not replace either entire lifecycle with this object.',
        'Run login yourself in a real terminal. WIQD may authenticate multiple active providers and use broker/browser state. Verify the actual account and tenant. Never copy tokens, invoke logout as preparation, or change shared settings automatically.',
        'After edits, run validate for the exact project/environment. Stop on failure. Review and separately approve the ENTIRE provisioning lifecycle before running provision; it may create, update or publish resources beyond this registration.',
        'A failed, interrupted or unknown provisioning/registration result must be reconciled with the provider, never automatically retried or bypassed with a fresh project/handoff.',
      ] : [
        reference
          ? 'A reference already exists. Do not sign in or provision merely to recreate it; use the existing unverified reference for the return path.'
          : 'No registration action or provider command is emitted. Supply a real intended app ID and use secretless SSO/PKCE, or complete confidential-client setup separately through an approved provider workflow.',
      ]),
      'Copy only the exact returned fields into registration.reference in a NEW copy of the registration input. Preserve opaque punctuation and padding. Do not copy WIQD account caches, tokens, raw logs or the whole environment file.',
      'Use mcp-auth-registration-plan and mcp-auth-registration-bundle with that new input and a new output. Review the exact local-write approval. For FCC, select the resulting preparation using source.authenticationBundleFile.',
      'Imported references remain provided-unverified. FCC form submission is manual; settings, consent, discovery and consumer execution each require their own review. This handoff authorizes no proof replay.',
    ],
    returnMapping: [
      { providerField: 'MCP_AUTH_REGISTRATION_ID', inputField: 'registration.reference.registrationId' },
      ...(selected.input.registration.type === 'entra-sso'
        ? [{ providerField: 'MCP_AUTH_APPLICATION_ID_URI', inputField: 'registration.reference.applicationIdUri' }] : []),
    ],
    effects: { localJsonOnly: true, projectEdits: false, networkCalls: false, subprocesses: false,
      credentialAccess: false, credentialTransfer: false, registration: false, proofReplayAuthorized: false },
  });
  requireHandoff(!secretIssues(savedJson(content)), 'SENSITIVE_INPUT', 'Handoff metadata must not contain credentials.');
  const bundle = { ...content, contentDigest: hash(content) };
  const binding = { configFile, config, registrationConfig, input: selected.input,
    descriptorDigest: selected.descriptor.descriptorDigest, sourceResult: selected.sourceResult, outputPath,
    contentDigest: bundle.contentDigest };
  return { action: 'mcp-auth-wiqd-handoff-write', status: 'planned', outputPath,
    operator: selected.input.operator, bundle, approvalToken: `mcp-auth-wiqd/${hash(binding)}` };
}

async function inWorkspace(options, run) {
  requireHandoff(typeof options.workspaceRoot === 'string', 'WORKSPACE', 'Select an explicit private --workspace-root.');
  return withCliWorkspace(options.workspaceRoot, run);
}
export async function planAuthWiqdBundle(options) {
  return inWorkspace(options, () => prepare(options));
}
export async function writeAuthWiqdBundle(options) {
  return inWorkspace(options, () => writeNewJsonBundle(options, prepare, requireHandoff));
}
