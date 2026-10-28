import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { assertProjectPath, withCliWorkspace } from './config.js';
import { readControl } from './mcp-control.js';
import { boundedSnapshot, metadataDigest, savedJson } from './anonymous-metadata.js';
import { secretIssues } from './validation.js';
import { prepareFccInput } from './mcp-fcc.js';
import { escapeHtml as escape, themeScript, handoverCss, handoverUiScript } from './mcp-handover-render.js';

export const consumerChoices = Object.freeze([
  { value: 'fcc', label: 'Create a federated connector (FCC)' },
  { value: 'plugin', label: 'Create a Microsoft 365 / Cowork plugin starter' },
  { value: 'none', label: 'None - keep the MCP and finish for now' },
]);
export const consumerSchema = {
  type: 'object', additionalProperties: false, required: ['schemaVersion', 'consumer', 'fccConfig'],
  properties: {
    schemaVersion: { const: 1 }, consumer: { enum: ['fcc', 'plugin'] },
    fccConfig: { type: 'string', minLength: 1, maxLength: 2048 },
    pluginAppId: { type: 'string', format: 'uuid' },
  },
};
const ajv = new Ajv(); addFormats(ajv);
const valid = ajv.compile(consumerSchema);
const digest = value => metadataDigest(boundedSnapshot(value));
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const scriptHash = value => `'sha256-${createHash('sha256').update(value).digest('base64')}'`;
const ensure = (ok, code, message) => {
  if (!ok) throw Object.assign(new Error(message), { code: `MCP_CONSUMER_${code}` });
};
export function consumerNextSteps(workspaceRoot) {
  return {
    status: 'optional-consumer-onboarding', choices: consumerChoices,
    command: ['mcp-onboard', '--workspace-root', workspaceRoot],
    commandRequiresTerminal: true,
    input: 'Prepare mcp-onboard-schema inputs against this exact endpoint descriptor and observed capture. Existing runs and proof receipts stay unchanged.',
    afterSelection: {
      fcc: 'Continue to missing-input collection and exact shared SSO registration/reuse review, then export FCC HTML. Do not stop at selection.',
      plugin: 'Continue to missing-input collection and exact shared SSO registration/reuse review, then export the plugin manifest starter, observed tools and HTML. Do not stop at selection.',
      none: 'Stop without consumer effects. The MCP and all evidence remain unchanged.',
    },
    appContinuation: {
      mode: 'agent-driven-explicit-command-reviews',
      selectionIsExecutionApproval: false,
      instruction: 'A user choosing FCC or Plugin is asking to begin onboarding. Present the next exact approval or ask for a genuinely missing input in the same conversation. A generic separate-review disclaimer is not a completed handoff.',
      preparation: ['mcp-onboard-schema', 'mcp-auth-registration-schema', 'mcp-auth-execution-schema', 'mcp-fcc-schema', 'mcp-consumer-schema'],
      registration: ['mcp-auth-execution-status', 'mcp-auth-execution-plan', 'mcp-auth-execute'],
      referenceExport: ['mcp-auth-registration-plan', 'mcp-auth-registration-bundle'],
      consumerExport: ['mcp-consumer-plan', 'mcp-consumer-bundle'],
      boundaries: 'Use existing guarded commands with their own exact approvals. Login requires a real terminal and current identity review. Do not use the terminal-only wizard in noninteractive tools, fabricate approvals, rebuild the MCP or replay discovery/proof.',
      doneWhen: 'The actual compatible registration reference and Application ID URI are imported and the requested files exist, or the user explicitly stops, or a specific blocker is reported. Publication and consumer testing are separate.',
    },
    effects: 'Separate reviewed registration and local handover; no deployment or proof replay.',
  };
}
const show = value => escape(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const table = fields => `<div class="scroll"><table><thead><tr><th>Field</th><th>Value</th><th>Status</th></tr></thead><tbody>${fields.map((f, i) => {
  const id = `value-${digest(fields).slice(7, 19)}-${i}`;
  return `<tr><td>${escape(f.label)}</td><td><code id="${id}">${f.value === null ? 'Not supplied' : show(f.value)}</code>
${f.value === null ? '' : `<button data-copy="${id}" aria-label="Copy ${escape(f.label)}">Copy</button>`}</td><td>${escape(f.status)}</td></tr>`;
}).join('')}</tbody></table></div>`;
function render(report) {
  const b = report.onboarding, plugin = report.consumer === 'plugin';
  const title = plugin ? 'Microsoft 365 plugin starter' : 'Federated connector setup';
  const steps = plugin ? [
    'Review the real registration reference and generated Application ID URI below. Preserve its tenant and app restrictions; do not register it again.',
    'Complete the separately reviewed Entra identifier URI, consent redirect and token-store preauthorization changes. Verify endpoint audience and allowed-client configuration without replacing unrelated settings.',
    'Use WIQD to create the intended plugin project. Merge the supplied connector into its manifest, preserving unrelated capabilities and its actual app ID. This starter does not create a WIQD project.',
    'Complete missing branding, privacy/terms URLs and both required PNG icons. Keep tools/mcp-tools.json with the connector. Observed metadata is historical, not a new discovery.',
    'Run the installed WIQD version capability checks and plugin deep validation. A static pass alone does not establish authentication or consumer behavior.',
    'Separately review provisioning, packaging and a limited test audience in WIQD. A new consumer call requires its own approval; never replay the consumed toolkit proof.',
  ] : b.checklist.map(step => step.instruction);
  const csp = `default-src 'none'; script-src ${scriptHash(themeScript)} ${scriptHash(handoverUiScript)}; style-src ${scriptHash(handoverCss)}; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escape(csp)}"><title>${escape(b.connector.displayName)} - ${title}</title>
<script>${themeScript}</script><style>${handoverCss}</style></head><body><main>
<div class="eyebrow">MCP consumer onboarding</div><h1>${escape(b.connector.displayName)}</h1><p>${title}</p>
<p class="notice">Private review draft. Registration references are not secrets, but environment identifiers are private. Nothing on this page runs a command, changes Azure, publishes a connector or makes a provider call.</p>
<nav role="tablist" aria-label="Consumer handover"><button role="tab" id="tab-summary" aria-controls="summary" aria-selected="true">Setup summary</button><button role="tab" id="tab-next" aria-controls="next" aria-selected="false" tabindex="-1">Finish setup</button></nav>
<section class="panel" id="summary" role="tabpanel" aria-labelledby="tab-summary">
<section class="card"><h2>Separate completion states</h2><dl>
<dt>Registration</dt><dd>${report.states.registration === 'missing' ? 'Reference not supplied' : 'Reference saved; settings unverified'}</dd>
<dt>Endpoint setup</dt><dd>Separate configuration review required</dd>
<dt>Handover</dt><dd>Draft generated; not published</dd>
<dt>Consumer test</dt><dd>Not verified</dd></dl></section>
<section class="card"><h2>${plugin ? 'Connector configuration' : 'FCC form fields'}</h2>${table(b.manualSetup.formFields)}</section>
<section class="card"><h2>Shared secretless Entra registration</h2>${table(b.manualSetup.authenticationRegistration.fields)}
<p>The auth config / SSO registration ID is not the Entra resource client ID or Teams app ID. Keep its punctuation and padding unchanged. Reuse a compatible registration; never broaden restrictions automatically.</p></section>
<section class="card"><h2>Remaining gates</h2><ul>${report.gaps.map(g=>`<li><strong>${escape(g.code)}</strong>: ${escape(g.message)}</li>`).join('')}</ul>
<p>Directory settings, endpoint compatibility, consent, legal review, audience selection and actual consumer behavior remain separately reviewed. A successful MCP proof is not Microsoft 365 consumer acceptance.</p></section>
<section class="card"><h2>Observed tools</h2><pre>${show(b.tools)}</pre><p>Discovery: ${escape(b.evidence.discovery.status)}. Export does not refresh discovery or authorize any tool call.</p></section></section>
<section class="panel" id="next" role="tabpanel" aria-labelledby="tab-next"><section class="card"><h2>Finish ${plugin ? 'the plugin in WIQD' : 'the FCC in Microsoft 365 admin center'}</h2>
<ol>${steps.map(step=>`<li>${escape(step)}</li>`).join('')}</ol></section>
<section class="card"><h2>Files for review</h2><ul>${report.downloads.map(file=>`<li><a href="${escape(file)}">${escape(file)}</a></li>`).join('')}</ul>
<p>Keep the folder together. A manifest template is not a publishable package. Never paste missing placeholders into authentication fields.</p></section></section>
<p id="copy-status" role="status"></p><p class="muted">Local export only. No tokens, raw captures, private sign-in account or replay approvals are included.</p></main><script>${handoverUiScript}</script></body></html>`;
}
async function prepare(options, { writing = false } = {}) {
  ensure(typeof options.config === 'string' && typeof options.output === 'string', 'INPUT', 'Select a consumer config and NEW output directory.');
  const configFile = await assertProjectPath(path.resolve(options.config));
  const input = await readControl(configFile);
  ensure(valid(input) && !secretIssues(savedJson(input)), 'INPUT', 'Use mcp-consumer-schema with nonsecret metadata.');
  ensure(input.consumer === 'plugin' || input.pluginAppId === undefined, 'INPUT', 'FCC does not require a plugin app ID.');
  const fccConfig = await assertProjectPath(path.resolve(path.dirname(configFile), input.fccConfig));
  const prepared = await prepareFccInput(fccConfig), b = prepared.bundle;
  ensure(b.authentication.type === 'entra-sso', 'AUTH', 'This consumer flow supports Entra-secured MCP only; no authentication downgrade.');
  const registration = prepared.authenticationBundle?.request.registration;
  ensure(input.consumer !== 'plugin' || registration?.applicableToApps !== 'SpecificApp'
    || registration.appId === input.pluginAppId, 'APP_RESTRICTION', 'The plugin app ID must match the existing SpecificApp registration. Do not broaden it.');
  const outputPath = await assertProjectPath(path.resolve(options.output));
  ensure((await lstat(path.dirname(outputPath))).isDirectory(), 'OUTPUT', 'Output parent must already exist.');
  if (!writing) {
    try { await lstat(outputPath); ensure(false, 'OUTPUT_EXISTS', 'Choose a new output; existing handovers are immutable.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const reference = b.authentication.registrationId, files = { 'fcc-onboarding.json': savedJson(b) };
  const gaps = [...b.readiness.gaps];
  if (input.consumer === 'plugin') {
    gaps.push({ code: 'PLUGIN_COMPLETION_REQUIRED', message: 'Complete branding, legal URLs, app ID and icons, then validate the intended WIQD project. No package or publication was performed.' });
    if (b.connector.displayName.length > 30 || b.connector.description.length > 80) {
      gaps.push({ code: 'PLUGIN_SHORT_METADATA_TOO_LONG', message: 'Owner must shorten the plugin short name to at most 30 characters and short description to at most 80. The template preserves supplied text rather than silently rewriting it.' });
    }
    if (reference?.length > 128) gaps.push({ code: 'PLUGIN_REFERENCE_TOO_LONG',
      message: 'The v1.28 connector schema limits referenceId to 128 characters. No manifest was emitted; preserve the actual reference and review platform compatibility rather than truncating it.' });
    if (reference && reference.length <= 128 && b.authentication.applicationIdUri && b.tools.length) {
      const developer = b.connector.developer ?? {};
      files['plugin/manifest.template.json'] = savedJson({
        $schema: 'https://developer.microsoft.com/json-schemas/teams/v1.28/MicrosoftTeams.schema.json',
        manifestVersion: '1.28', version: '1.0.0', id: input.pluginAppId ?? 'REPLACE_WITH_REAL_TEAMS_APP_ID',
        developer: { name: developer.name ?? 'REPLACE_WITH_DEVELOPER_NAME',
          websiteUrl: developer.websiteUrl ?? 'https://example.invalid/replace-website',
          privacyUrl: developer.privacyPolicyUrl ?? 'https://example.invalid/replace-privacy',
          termsOfUseUrl: developer.termsOfUseUrl ?? 'https://example.invalid/replace-terms' },
        name: { short: b.connector.displayName, full: b.connector.displayName },
        description: { short: b.connector.description, full: b.connector.description },
        icons: { color: 'color.png', outline: 'outline.png' }, accentColor: '#FFFFFF',
        agentConnectors: [{ id: 'mcp-connector', displayName: b.connector.displayName, description: b.connector.description,
          toolSource: { remoteMcpServer: { mcpServerUrl: b.endpoint.url,
            mcpToolDescription: { file: './tools/mcp-tools.json' },
            authorization: { type: 'OAuthPluginVault', referenceId: reference } } } }],
      });
      files['plugin/tools/mcp-tools.json'] = savedJson({ tools: b.tools });
    } else if (!reference || !b.authentication.applicationIdUri || !b.tools.length) {
      gaps.push({ code: 'PLUGIN_AUTH_OR_TOOLS_MISSING', message: 'No plugin manifest was emitted. Supply the real registration ID, generated Application ID URI and an observed tools capture; no fake auth reference or tool schema is generated.' });
    }
  }
  const report = boundedSnapshot({
    schemaVersion: 1, kind: 'mcp-consumer-handover', consumer: input.consumer, onboarding: b,
    states: { registration: reference ? 'reference-provided-settings-unverified' : 'missing',
      endpointConfiguration: 'requires-separate-review',
      draft: 'generated-not-published', consumerTest: 'not-verified' },
    gaps, downloads: [...Object.keys(files), 'consumer-manifest.json'],
    executionReadiness: false, proofReplayAuthorized: false,
  });
  files['index.html'] = render(report);
  const artifacts = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { sha256: hash(bytes), bytes: Buffer.byteLength(bytes) }]));
  const body = { ...report, artifacts }, manifest = { ...body, contentDigest: digest(body) };
  const binding = { configFile, input, fcc: prepared.binding, outputPath, contentDigest: manifest.contentDigest };
  return { action: 'mcp-consumer-bundle', status: 'planned-local-only', outputPath, manifest,
    effects: ['Write private HTML and reviewed metadata; plugin output is an incomplete starter, not a WIQD project.',
      'No registration, directory or endpoint changes, cloud calls, consent, publication or provider proof.'],
    approvalToken: `mcp-consumer/${digest(binding)}`, files };
}
const scoped = (options, action) => {
  ensure(typeof options.workspaceRoot === 'string', 'WORKSPACE', 'Select an explicit private workspace.');
  return withCliWorkspace(options.workspaceRoot, action);
};
export const planConsumerBundle = options => scoped(options, async () => {
  const { files, ...plan } = await prepare(options); return plan;
});
export const writeConsumerBundle = options => scoped(options, async () => {
  const plan = await prepare(options);
  ensure(options.approval === plan.approvalToken, 'APPROVAL', 'Approve the exact current consumer export plan.');
  await mkdir(plan.outputPath, { mode: 0o700 });
  for (const [name, bytes] of Object.entries(plan.files)) {
    const file = await assertProjectPath(path.join(plan.outputPath, ...name.split('/')));
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    ensure(hash(await readFile(file)) === hash(bytes), 'READBACK', 'Output changed during write; preserve the incomplete folder.');
  }
  ensure((await prepare(options, { writing: true })).approvalToken === plan.approvalToken, 'INPUT_CHANGED',
    'Inputs changed during export. Preserve the incomplete folder and review a new destination.');
  const manifest = await assertProjectPath(path.join(plan.outputPath, 'consumer-manifest.json'));
  await writeFile(manifest, savedJson(plan.manifest), { flag: 'wx', mode: 0o600 });
  ensure(hash(await readFile(manifest)) === hash(savedJson(plan.manifest)), 'READBACK', 'Manifest readback changed.');
  return { status: 'consumer-draft-written-not-published', consumer: plan.manifest.consumer,
    outputPath: plan.outputPath, entryFile: path.join(plan.outputPath, 'index.html'),
    contentDigest: plan.manifest.contentDigest, states: plan.manifest.states,
    executionReadiness: false, proofReplayAuthorized: false };
});
export async function readConsumerBundle(outputPath) {
  const manifest = await readControl(await assertProjectPath(path.join(outputPath, 'consumer-manifest.json')));
  const { contentDigest, ...body } = manifest;
  ensure(manifest.kind === 'mcp-consumer-handover' && contentDigest === digest(body), 'INTEGRITY', 'Consumer manifest is modified.');
  for (const [name, artifact] of Object.entries(manifest.artifacts)) {
    ensure(/^(?:[a-z0-9-]+\/)*[a-z0-9.-]+$/.test(name) && !name.includes('..'), 'INTEGRITY', 'Invalid artifact path.');
    const file = await assertProjectPath(path.join(outputPath, ...name.split('/')));
    const stat = await lstat(file);
    ensure(stat.isFile() && stat.size === artifact.bytes && stat.size <= 4194304,
      'INTEGRITY', 'Consumer artifact size or type differs.');
    ensure(hash(await readFile(file)) === artifact.sha256, 'INTEGRITY', 'Consumer artifact hash differs.');
  }
  return manifest;
}
