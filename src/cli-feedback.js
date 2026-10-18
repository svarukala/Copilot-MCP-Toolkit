import { AsyncLocalStorage } from 'node:async_hooks';
import { secretIssues } from './validation.js';

const context = new AsyncLocalStorage();
const commands = ['mcp-account-switch', 'mcp-reconcile', 'mcp-discover', 'mcp-proof', 'mcp-qualification', 'mcp-resume'];
const plans = ['mcp-account-plan', 'mcp-reconcile-plan', 'mcp-discovery-plan', 'mcp-proof-plan', 'mcp-qualification-plan', 'mcp-resume',
  'mcp-export-plan', 'mcp-restore-plan', 'mcp-server-plan', 'mcp-fcc-plan', 'mcp-auth-registration-plan', 'mcp-auth-execution-plan', 'mcp-auth-wiqd-plan', 'mcp-container-apps-plan'];
const stages = {
  review: ['working', 'Checking local inputs, history and approval'],
  'azure-login': ['external-wait', 'Azure login starting; waiting for a sign-in challenge'],
  'azure-browser': ['external-wait', 'Azure browser login starting; waiting for authentication (browser opening unconfirmed)'],
  'azure-user': ['waiting-for-user', 'Complete the separately displayed Azure sign-in'],
  'azure-select': ['external-wait', 'Selecting and verifying the exact Azure account'],
  'azure-inspection': ['working', 'Read-only Azure inspection'],
  'azure-read': ['external-wait', 'Waiting for a logical Azure read (including bounded retries)'],
  'azure-retry': ['external-wait', 'Recognized Azure read transport failure; bounded retry wait'],
  'mcp-auth': ['external-wait', 'Requesting MCP public-client authentication'],
  'mcp-user': ['waiting-for-user', 'Complete the separately displayed MCP sign-in'],
  'mcp-initialize': ['external-wait', 'MCP initialize request'],
  'mcp-notify': ['external-wait', 'MCP initialized notification'],
  'mcp-list': ['external-wait', 'MCP tools/list metadata request'],
  'dispatch-prepared': ['working', 'Tool-call dispatch journal prepared; not confirmed sent'],
  'mcp-call': ['external-wait', 'Tool-call transport boundary entered; server execution unconfirmed'],
  publication: ['working', 'Checking guards and publishing local evidence'],
};

// Scoped to one CLI invocation; observers never enter plans, journals or public options.
export async function withCliFeedback(work) {
  const state = { closed: false, progress: false, summary: false, started: performance.now(), last: -Infinity, seen: new Set() };
  return context.run(state, async () => {
    try {
      const code = await work();
      emit(state, `CLI ${code === 0 ? 'finished' : 'stopped'}; consult the JSON outcome. No retry is implied.`, true);
      if (state.outputFailed) {
        writeFeedback(state, 'CLI feedback could not be displayed. Consult stdout and retained history; do not retry the operation to repair display.\n');
        return code || 1;
      }
      return code;
    } catch (error) {
      emit(state, 'CLI failed; consult the JSON outcome. No retry is implied.', true);
      throw error;
    } finally {
      clearInterval(state.timer);
      state.closed = true;
    }
  });
}
function writeFeedback(state, text) {
  try { process.stderr.write(text); }
  catch {
    // Display failure must not interrupt an owned process or a write-ahead journal.
    state.outputFailed = true;
    state.progress = false;
    clearInterval(state.timer);
  }
}
function emit(state, message, force = false) {
  if (state.closed || !state.progress) return;
  const now = performance.now();
  if (!force && now - state.last < 1000) return;
  state.last = now;
  const remaining = deadline => Math.max(0, Math.ceil((deadline - now) / 1000));
  const bounds = `${state.overall ? `; inspection remaining ${remaining(state.overall)}s` : ''}`
    + `${state.deadline ? `; stage remaining ${remaining(state.deadline)}s` : ''}`;
  writeFeedback(state, `[progress ${Math.floor((now - state.started) / 1000)}s${bounds}] ${message}\n`);
}
export function configureCliFeedback(command, { progress, summary }) {
  if (progress !== undefined && !commands.includes(command)) throw new Error('--progress is supported only for standalone account-switch, reconcile, discover, proof and qualification.');
  if (summary !== undefined && !plans.includes(command)) throw new Error('--summary is supported only for standalone account, reconcile, discovery, proof and qualification plans.');
  const state = context.getStore();
  if (!state) return;
  state.progress = progress === true;
  state.summary = summary === true;
  state.command = command;
  if (state.progress) {
    cliStage('review');
    if (!state.outputFailed) {
      state.timer = setInterval(() => emit(state, state.message), 10000);
      state.timer.unref();
    }
  }
}
export function cliStage(stage, timeoutMs) {
  const state = context.getStore();
  if (!state?.progress || state.closed || !Object.hasOwn(stages, stage)) return;
  const [kind, label] = stages[stage];
  state.message = `${kind}: ${label}${stage === 'azure-read' && state.inspectionLabel ? ` - ${state.inspectionLabel}` : ''}`;
  if (['azure-login', 'azure-browser', 'azure-user'].includes(stage)) state.message += '; no login deadline configured';
  if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 900000) {
    state.deadline = performance.now() + timeoutMs;
    if (stage === 'azure-inspection') state.overall = state.deadline;
  } else if (!['azure-retry', 'mcp-user'].includes(stage)) state.deadline = undefined;
  const first = !state.seen.has(stage);
  state.seen.add(stage);
  emit(state, state.message, first);
}
export function cliInspectionStep(id) {
  const state = context.getStore();
  if (!state?.progress || state.closed) return;
  const labels = { 'check-account': 'account identity', 'check-service': 'APIM service',
    'check-vault': 'vault metadata', 'check-diagnostics': 'diagnostics safety',
    'check-api-collisions': 'API ownership and mapping', 'check-proxy-backends': 'owned backend mapping',
    'check-proxy-grant': 'existing secret-scoped grant', 'snapshot-unrelated-policies': 'original preservation baseline',
    'verify-owned-apis': 'exact owned API readback', 'verify-preservation': 'unrelated-resource preservation',
    'check-shared-policy': 'shared policy safety', 'check-named-value-collisions': 'named-value ownership' };
  state.inspectionLabel = Object.hasOwn(labels, id) ? labels[id] : 'planned safety checks';
}
const safe = value => typeof value === 'string' && value.length <= 2048
  && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(value)
  && !secretIssues(value) ? value : '[see reviewed JSON]';
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) ? value : undefined;
export function cliPlanSummary(plan) {
  const state = context.getStore();
  if (!state?.summary || state.closed || !plan || typeof plan !== 'object') return;
  if (state.command === 'mcp-server-plan' && plan.evidence === 'local-generation-review') {
    if (plan.descriptor.kind === 'native-apim-mcp' && plan.descriptor.inbound.type === 'anonymous') {
      const rate = plan.descriptor.inbound.rateLimit;
      writeFeedback(state, `[public exposure]\nMCP and backing REST routes: anyone can call without a token or subscription key.\nDeclared public data and read-only GETs; not independently verified.\nAggregate limit per API per gateway/region: ${safe(String(rate.calls))} requests / ${safe(String(rate.renewalPeriod))} seconds; approximate, not a cost ceiling.\nNo Entra resource app or discovery client; Azure management identity and separate deployment approval remain required.\n`);
    }
    writeFeedback(state, `[generation summary]\nOperation: local standalone bundle creation only\nEndpoint: ${safe(plan.descriptor.endpoint)}\nStatus: ${safe(plan.descriptor.status)}\nCalls: zero; no login, deployment or provider readiness implied.\nEXACT reviewDigest: ${safe(plan.reviewDigest)}\nUse mcp-server-create with a NEW --output and this --approve. Full review remains on stdout.\n`);
    return;
  }
  if (!plan.action) return;
  if (plan.action === 'mcp-container-apps-create') {
    writeFeedback(state, `[Container Apps recipe summary]\nOperation: save local source and deployment review files only\nNew destination: ${safe(plan.outputPath)}\nApp: ${safe(plan.review.target.appName)}\nTenant: ${safe(plan.review.target.tenantId)}\nSubscription: ${safe(plan.review.target.subscriptionId)}\nAccess: Entra sign-in required; no APIM\nTools: ${plan.review.toolDefinitions.length} owner-reviewed fixed GETs; annotations are not observed evidence.\nNo install, image build/push, cloud operation or endpoint call.\nEXACT approvalToken: ${safe(plan.approvalToken)}\nReview all generated files on stdout before creating the project.\n`);
    return;
  }
  if (plan.action === 'mcp-auth-execution') {
    writeFeedback(state, `[auth execution summary]\nPhase: ${safe(plan.phase)}\nSession: ${safe(plan.project)}\nStatus: ${safe(plan.status)}\n${plan.operator ? `Expected account: ${safe(plan.operator.accountName)}\nTenant: ${safe(plan.operator.tenantId)}\nEndpoint: ${safe(plan.endpoint)}\n` : ''}${plan.effects.map(safe).join('\n')}\nEXACT approvalToken: ${safe(plan.approvalToken)}\nReview the full plan; this approval authorizes only this phase.\n`);
    return;
  }
  if (plan.action === 'mcp-auth-wiqd-handoff-write') {
    writeFeedback(state, `[WIQD handoff summary]\nOperation: local private JSON only; no WIQD invocation or project edits\nNew destination: ${safe(plan.outputPath)}\nWIQD project: ${safe(plan.bundle.target.project)}\nEnvironment: ${safe(plan.bundle.target.environment)}\nExpected operator: ${safe(plan.operator.accountName)}\nTenant: ${safe(plan.bundle.preparation.request.tenantId)}\nAuthentication belongs to the user-managed WIQD profile, not a toolkit-isolated session.\nProvisioning requires separate review of the ENTIRE WIQD lifecycle. No credential transfer or automatic retry.\nEXACT approvalToken: ${safe(plan.approvalToken)}\nThis approval writes only the handoff; it authorizes none of its provider commands.\n`);
    return;
  }
  if (plan.action === 'mcp-auth-registration-preparation-write') {
    const request = plan.bundle.request;
    writeFeedback(state, `[auth registration summary]\nOperation: local private preparation JSON only\nNew destination: ${safe(plan.outputPath)}\nEndpoint: ${safe(plan.bundle.endpoint.url)}\nExpected operator: ${safe(plan.operator.accountName)}\nTenant: ${safe(request.tenantId)}\nRestrictions: ${safe(request.registration.targetAudience)} / ${safe(request.registration.applicableToApps)}\nReadiness: blocked; provider authentication and registration are NOT executed.\nCalls: zero; no secret resolution, ATK invocation or consent.\nEXACT approvalToken: ${safe(plan.approvalToken)}\nReview full metadata on stdout before mcp-auth-registration-bundle.\n`);
    return;
  }
  if (plan.action === 'mcp-fcc-onboarding-write') {
    const discovery = plan.bundle.evidence.discovery;
    writeFeedback(state, `[FCC summary]\nOperation: local private onboarding JSON only\nNew destination: ${safe(plan.outputPath)}\nEndpoint: ${safe(plan.bundle.endpoint.url)}\nReadiness: ${safe(plan.bundle.readiness.status)}; gaps: ${plan.bundle.readiness.gaps.length}\nLegal policies: ${safe(plan.bundle.evidence.legalPolicies.status)} (caller declaration, not verified)\nDiscovery: ${safe(discovery.status)}${discovery.expiresAt ? `; expires: ${safe(discovery.expiresAt)}` : ''}\nNext: resolve gaps and complete human legal/audience/submission checkpoints; zero gaps is NOT execution readiness.\nCalls: zero; no login, registration, deployment or proof replay.\nEXACT approvalToken: ${safe(plan.approvalToken)}\nReview all exported metadata on stdout before mcp-fcc-bundle.\n`);
    return;
  }
  if (['standalone-mcp-evidence-export', 'standalone-mcp-evidence-restore'].includes(plan.action)) {
    writeFeedback(state, `[evidence summary]\nOperation: ${safe(plan.action)}\nNew destination: ${safe(plan.destination.path)}\nArchive SHA256: ${safe(plan.archiveSha256)}\nPersistence: ${safe(plan.persistence.status)}; same-filesystem checkpoint is NOT a cross-device backup.\nCalls: zero; identity: none. Evidence expiry and historical bindings are not renewed.\nEXACT approvalToken: ${safe(plan.approvalToken)}\nFull file hashes, exclusions, lock presence and limitations remain on stdout.\n`);
    return;
  }
  if (plan.action === 'standalone-mcp-resume') {
    const lines = Object.entries(plan.layers).map(([name, layer]) => `${safe(name)}: ${safe(layer.status)}`);
    if (plan.layers.configuration.expiresAt) lines.push(`Configuration expires: ${safe(plan.layers.configuration.expiresAt)}`);
    if (plan.freshness) {
      lines.push(`Freshness admission: ${safe(plan.freshness.status)}; known budget: ${safe(String(plan.freshness.requiredKnownMs))}ms (local overhead not bounded)`);
      for (const deadline of plan.freshness.deadlines) lines.push(`${safe(deadline.kind)} expires: ${safe(deadline.expiresAt)}; remaining ${safe(String(deadline.remainingMs))}ms`);
    }
    const operation = plan.next.plan?.operation;
    if (operation) lines.push(`MCP target: ${safe(operation.source.endpoint)}`,
      operation.tool ? 'Calls: bounded metadata re-list plus at most one approved tools/call; provider charges may apply.'
        : 'Calls: bounded metadata only; no tools/call.',
      operation.source.inbound.type === 'entra' ? 'Identity: separate MCP public-client user, not Azure CLI login.' : 'Identity: declared anonymous MCP caller.');
    if (operation?.qualification) lines.push('Additional Tavily singleton: basic search normally costs 1 credit, not a billing guarantee.');
    if (operation?.acceptanceProfile) lines.push(`First-call acceptance: ${safe(operation.acceptanceProfile.kind)} in the SAME ordinary call; no additional qualification. Basic search normally costs 1 credit, not a billing guarantee.`);
    lines.push(`Next: ${safe(plan.next.command ?? plan.next.status)}`, safe(plan.next.reason),
      ...(plan.next.approval ? [`EXACT next.approval: ${safe(plan.next.approval)}`] : []),
      `Required effect flags: ${(plan.next.requiredFlags ?? []).map(safe).join(' ') || 'none'}`,
      'Full existing phase plan remains in next.plan on stdout. Resume does not approve or repeat any phase.');
    writeFeedback(state, `[resume summary]\n${lines.join('\n')}\n`);
    return;
  }
  const token = plan.approvalToken ?? plan.approvalDigest;
  const validToken = typeof token === 'string' && /^(?:azure-login\/[a-f0-9]{64}|mcp-reconcile\/sha256:[a-f0-9]{64}|sha256:[a-f0-9]{64})$/.test(token);
  const operation = plan.operation;
  const target = plan.target ?? plan.inspection?.azureIdentity?.target;
  const lines = [`Review: ${state.command}`, `Operation: ${safe(plan.action)}`];
  if (plan.projectDir) lines.push(`Project: ${safe(plan.projectDir)}`);
  if (target) {
    lines.push(`Azure target: tenant ${safe(target.tenantId)}; subscription ${safe(target.subscriptionId)}`,
      `Identity role: isolated Azure CLI user (${safe(target.accountName)}); not MCP caller credentials`);
  }
  if (operation?.source) {
    lines.push(`MCP target: ${safe(operation.source.endpoint)}`,
      `Identity role: ${operation.source.inbound?.type === 'entra' ? 'separate MCP public-client user; not Azure CLI login or backend credentials' : 'declared anonymous MCP caller'}`);
    const auth = (operation.discoveryPlan ?? operation).auth;
    if (auth) lines.push(`MCP client: ${safe(auth.discoveryClientId)}; expected user object: ${safe(auth.expectedUserId)}`);
  }
  if (state.command === 'mcp-account-plan') lines.push(`Login mode: ${plan.loginMode === 'device-code' ? 'device code' : 'browser'}; no resource or MCP calls authorized`);
  if (state.command === 'mcp-reconcile-plan') {
    lines.push('Calls: reviewed read-only Azure requests only; no redeployment or tool calls');
    const service = plan.inspection?.steps?.find(step => step.id === 'check-service');
    if (Array.isArray(service?.args)) {
      const argument = flag => {
        const index = service.args.indexOf(flag);
        return index >= 0 ? safe(service.args[index + 1]) : '[see reviewed JSON]';
      };
      lines.push(`APIM: ${argument('--name')}; resource group: ${argument('--resource-group')}`);
    }
    const budget = plan.inspection?.inspectionBudget;
    if (budget) lines.push(`Inspection limits: ${budget.commandTimeoutMs / 1000}s/logical read; ${budget.overallTimeoutMs / 1000}s overall`);
    if (plan.maximumAgeMs) lines.push(`New evidence window: ${plan.maximumAgeMs / 60000} minutes after successful inspection; not a runtime proof`);
  }
  if (operation) {
    const call = state.command !== 'mcp-discovery-plan';
    lines.push(call ? 'Calls: metadata re-list plus at most one approved tools/call; provider charges may apply'
      : 'Calls: MCP initialize and bounded tools/list; no tools/call');
    if (operation.tool?.name) lines.push(`Tool: ${safe(operation.tool.name)}`);
    if (operation.acceptanceProfile) lines.push(`First-call acceptance: ${safe(operation.acceptanceProfile.kind)} in the SAME ordinary call; failed/inconclusive/unknown outcomes remain consumed. Basic search normally costs 1 credit, not a billing guarantee.`);
    if (state.command === 'mcp-qualification-plan') lines.push('Additional singleton qualification: Tavily basic search normally costs 1 credit; not a billing guarantee. Prior call approval is consumed.');
    const expiry = date(plan.readiness?.experimental?.configuration?.expiresAt);
    if (expiry) lines.push(`Configuration expires: ${expiry}; expiration requires separately approved read-only inspection`);
    const capturedAt = date(operation.capture?.capturedAt);
    if (capturedAt && Number.isFinite(Date.parse(capturedAt))) lines.push(`Capture expires: ${new Date(Date.parse(capturedAt) + 86400000).toISOString()} (24-hour selection limit); no renewal implied`);
    if (plan.proofHistory) lines.push('History and no-replay checks still apply; a plan is not permission to repeat a consumed or unknown call');
  }
  lines.push(validToken ? `TOP-LEVEL --approve ${token}` : 'No usable top-level approval; resolve the JSON prerequisites first.',
    'Full machine-readable plan remains on stdout. Review it; this summary does not replace its constraints.');
  writeFeedback(state, `[approval summary]\n${lines.join('\n')}\n`);
}
