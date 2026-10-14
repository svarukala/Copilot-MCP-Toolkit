import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, unlink } from 'node:fs/promises';
import { assertProjectPath } from './config.js';
import { readMcpServerProject, readMcpLifecycleAttempts } from './mcp-lifecycle.js';
import { mcpRuntimeConfig } from './mcp-server.js';
import { graphOrganizationOperation } from './mcp-graph-organization.js';
import { readAzureIdentity, validateAzureAccountTarget } from './azure-identity.js';
import { deploymentTarget } from './apim-safety.js';
import { readControl, writeControl, withControlLock } from './mcp-control.js';
import { boundedSnapshot, metadataDigest, requireMetadata } from './anonymous-metadata.js';
import { publicHttpsTransport } from './anonymous-network.js';
import { assertSafeLocation } from './validation.js';
import { readExperimentalConfiguration } from './mcp-configuration.js';
import { readMcpProofHistory } from './mcp-proof-history.js';
import { assertTavilyProject } from './mcp-tavily-qualification.js';

const digest = value => metadataDigest(boundedSnapshot(value));
const signed = value => ({ ...value, receiptDigest: digest(value) });
const valid = value => {
  if (!value || typeof value !== 'object') return false;
  const { receiptDigest, ...body } = value;
  return receiptDigest === digest(body);
};
const same = (a, b) => digest(a) === digest(b);
const hash = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const cases = ['mcp-missing', 'mcp-malformed', 'rest-missing', 'rest-malformed'];
const callerProfile = 'experimental-caller-v1', providerProfile = 'tavily-provider-initialize-v1';
const gateCases = profile => profile === providerProfile ? ['provider-missing', 'provider-invalid']
  : profile === callerProfile ? cases.slice(0, 2) : cases;
const gateRequests = (profile, endpoint) => gateCases(profile).map((caseId, index) => ({ caseId, method: 'POST', endpoint,
  authorization: index === 0 ? 'absent' : profile === providerProfile ? 'fixed-invalid-api-key-sentinel' : 'fixed-malformed-non-JWT',
  rpcMethod: 'initialize' }));
const statuses = ['passed', 'failed', 'inconclusive'];
const causes = ['http-status', 'transport', 'timeout', 'cancelled', 'response-limit', 'local-drift'];
const fail = code => Object.assign(new Error(code), { code });
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value && Date.parse(value) <= Date.now();

function historicalRoot(value) {
  // Historical roots are syntax-only provenance, never filesystem access targets.
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (/^[A-Za-z]:\\/.test(value)) {
    const parts = value.slice(3).split('\\');
    return parts.every(part => part && !/[<>:"/|?*]/.test(part) && !/[. ]$/.test(part))
      && path.win32.normalize(value) === value;
  }
  return value.startsWith('/') && !value.includes('\\') && value.length > 1
    && !value.endsWith('/') && path.posix.normalize(value) === value;
}

export async function readMcpAuthRejections(projectDir, exclude, backend = false) {
  const directory = await assertProjectPath(path.join(projectDir, backend ? '.mcp-backend-rejections' : '.mcp-auth-rejections'));
  await assertSafeLocation(projectDir, directory);
  let names;
  try { names = await readdir(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; names = []; }
  requireMetadata(names.length <= 1000, 'LIMIT');
  const records = [], origins = [];
  for (const name of names.sort()) {
    requireMetadata(/^[a-f0-9-]{36}$/.test(name), 'METADATA_MISMATCH');
    if (name === exclude) continue;
    const dir = path.join(directory, name);
    await assertSafeLocation(projectDir, dir);
    const files = await readdir(await assertProjectPath(dir));
    requireMetadata(files.every(file => ['intent.json', 'result.json', ...cases.flatMap((_, i) => [`dispatch-${i}.json`, `case-${i}.json`])].includes(file)), 'METADATA_MISMATCH');
    if (!files.includes('intent.json')) {
      records.push({ attemptId: name, status: 'inconclusive', cases: [], evidenceDigest: digest(files) });
      continue;
    }
    const intent = await readControl(path.join(dir, 'intent.json'));
    const profile = intent.plan?.profile, selectedCases = gateCases(profile);
    requireMetadata(valid(intent) && (profile ? intent.schemaVersion === 2 && profile === (backend ? providerProfile : callerProfile)
      : intent.schemaVersion === 1 && !backend) && intent.kind === 'standalone-mcp-auth-rejection-intent'
      && same(Object.keys(intent).sort(), ['schemaVersion', 'kind', 'plan', 'startedAt', 'receiptDigest'].sort())
      && timestamp(intent.startedAt)
      && intent.plan?.action === 'standalone-mcp-auth-rejection' && (profile || intent.plan.projectDir === projectDir)
      && intent.plan.requests?.length === selectedCases.length, 'METADATA_MISMATCH');
    if (profile) {
      const project = await readMcpServerProject(projectDir);
      requireMetadata(project.review.input.schemaVersion === 3, 'METADATA_MISMATCH');
      if (backend) assertTavilyProject(project);
      requireMetadata(same(Object.keys(intent.plan).sort(), ['schemaVersion', 'action', 'profile', 'status', 'projectDir',
        'reviewDigest', 'descriptorStatus', 'binding', 'historyDigest', 'requests', 'timeoutMs',
        'maximumResponseBytes', 'expectedHttpStatus', 'limitations', 'approvalDigest'].sort())
        && intent.plan.schemaVersion === 2 && intent.plan.reviewDigest === project.review.reviewDigest
        && intent.plan.status === 'review-required' && intent.plan.timeoutMs === 10000
        && intent.plan.maximumResponseBytes === 16384 && intent.plan.expectedHttpStatus === 401
        && same(intent.plan.requests, gateRequests(profile, backend ? 'https://mcp.tavily.com/mcp/' : project.review.descriptor.endpoint))
        && same(Object.keys(intent.plan.binding).sort(), ['receiptDigest', 'lifecycleDigest', 'identity',
          'configurationEvidenceDigest', 'proofHistoryDigest', 'otherRejectionHistoryDigest'].sort()), 'METADATA_MISMATCH');
      const binding = intent.plan.binding, identity = binding.identity;
      requireMetadata(['receiptDigest', 'lifecycleDigest', 'configurationEvidenceDigest', 'proofHistoryDigest',
        'otherRejectionHistoryDigest'].every(key => hash(binding[key])) && hash(intent.plan.historyDigest)
        && intent.plan.descriptorStatus === project.review.descriptor.status
        && Array.isArray(intent.plan.limitations) && intent.plan.limitations.every(item => typeof item === 'string')
        && identity && same(Object.keys(identity).sort(), ['schemaVersion', 'projectDir', 'epoch', 'target', 'sessionStamp'].sort())
        && identity.schemaVersion === 1 && identity.projectDir === intent.plan.projectDir
        && /^[a-f0-9-]{36}$/.test(identity.epoch) && typeof identity.sessionStamp === 'string'
        && same(identity.target, validateAzureAccountTarget(identity.target)), 'METADATA_MISMATCH');
      if (intent.plan.projectDir !== projectDir) {
        const receipt = await readControl(path.join(project.projectDir, 'infra', 'provisioning-receipt.json'));
        const lifecycle = await readMcpLifecycleAttempts(project.projectDir);
        requireMetadata(historicalRoot(intent.plan.projectDir)
          && binding.receiptDigest === digest(receipt) && binding.lifecycleDigest === digest(lifecycle)
          && identity.target.tenantId === project.review.input.azure.tenantId.toLowerCase()
          && identity.target.subscriptionId === project.review.input.azure.subscriptionId.toLowerCase(),
        'METADATA_MISMATCH');
        origins.push({ attemptId: name, historicalProjectDir: intent.plan.projectDir,
          receiptDigest: binding.receiptDigest, lifecycleDigest: binding.lifecycleDigest });
      }
    }
    const { approvalDigest, ...plan } = intent.plan;
    requireMetadata(approvalDigest === digest(plan), 'METADATA_MISMATCH');
    const evidence = {};
    for (const file of files.filter(file => file !== 'intent.json')) {
      const record = await readControl(path.join(dir, file), 65536);
      requireMetadata(valid(record) && record.intentDigest === intent.receiptDigest, 'METADATA_MISMATCH');
      if (file === 'result.json') {
        requireMetadata(same(Object.keys(record).sort(), ['intentDigest', 'receiptDigest', 'status', 'finishedAt'].sort())
          && statuses.includes(record.status) && timestamp(record.finishedAt)
          && Date.parse(record.finishedAt) >= Date.parse(intent.startedAt), 'METADATA_MISMATCH');
      } else {
        const index = Number(file.match(/-(\d)\.json$/)[1]);
        requireMetadata(record.index === index && index < selectedCases.length, 'METADATA_MISMATCH');
        if (file.startsWith('case-')) requireMetadata(statuses.includes(record.status)
          && causes.includes(record.cause)
          && (record.httpStatus === undefined || Number.isInteger(record.httpStatus) && record.httpStatus >= 100 && record.httpStatus <= 599)
          && (record.status !== 'passed' || record.httpStatus === 401 && record.cause === 'http-status')
          && same(Object.keys(record).sort(), ['index', 'intentDigest', 'status', 'cause', 'receiptDigest', ...(record.httpStatus === undefined ? [] : ['httpStatus'])].sort())
          && files.includes(`dispatch-${index}.json`), 'METADATA_MISMATCH');
        else requireMetadata(same(Object.keys(record).sort(), ['index', 'intentDigest', 'preparedAt', 'receiptDigest'].sort())
          && timestamp(record.preparedAt) && Date.parse(record.preparedAt) >= Date.parse(intent.startedAt)
          && (index === 0 || files.includes(`case-${index - 1}.json`)), 'METADATA_MISMATCH');
      }
      evidence[file] = record;
    }
    const result = evidence['result.json'];
    if (result?.status === 'passed') requireMetadata(selectedCases.every((_, i) => evidence[`case-${i}.json`]?.status === 'passed'), 'METADATA_MISMATCH');
    records.push({ attemptId: name, status: result?.status ?? 'inconclusive', approvalDigest,
      ...(profile ? { profile } : {}),
      cases: selectedCases.flatMap((caseId, i) => evidence[`case-${i}.json`] ? [{ caseId, status: evidence[`case-${i}.json`].status,
        cause: evidence[`case-${i}.json`].cause, ...(evidence[`case-${i}.json`].httpStatus === undefined ? {} : { httpStatus: evidence[`case-${i}.json`].httpStatus }) }] : []),
      evidenceDigest: digest({ intent, evidence }) });
  }
  return { historyDigest: digest(records), attempts: records, ...(origins.length ? {
    historicalProvenance: { contractVersion: 1, kind: 'receipt-lifecycle-anchored-history',
      currentProjectDir: projectDir, historicalOnly: true, authorizesExecution: false, origins },
  } : {}) };
}

export async function planMcpAuthRejection(projectDir, excludeAttempt, backend = false) {
  const root = await assertProjectPath(path.resolve(projectDir));
  for (const name of ['infra', '.mcp-lifecycle', '.azure-identity.json', '.azure-auth']) {
    await assertSafeLocation(root, path.join(root, name));
  }
  const project = await readMcpServerProject(projectDir), { input, descriptor, files } = project.review;
  if (input.schemaVersion === 3) {
    if (backend) assertTavilyProject(project);
    const configuration = await readExperimentalConfiguration(project.projectDir);
    const lifecycle = await readMcpLifecycleAttempts(project.projectDir);
    const receipt = await readControl(path.join(project.projectDir, 'infra', 'provisioning-receipt.json'));
    const proofs = await readMcpProofHistory(project.projectDir);
    requireMetadata(!proofs.attempts.some(item => item.status === 'unresolved'), 'PROOF_OUTCOME_UNRESOLVED');
    const history = await readMcpAuthRejections(project.projectDir, excludeAttempt, backend);
    const otherHistory = await readMcpAuthRejections(project.projectDir, undefined, !backend);
    const profile = backend ? providerProfile : callerProfile;
    const plan = { schemaVersion: 2, action: 'standalone-mcp-auth-rejection', profile,
      status: history.attempts.length ? 'blocked-prior-attempt' : 'review-required',
      projectDir: project.projectDir, reviewDigest: project.review.reviewDigest, descriptorStatus: descriptor.status,
      binding: { receiptDigest: digest(receipt), lifecycleDigest: digest(lifecycle),
        identity: configuration.identity, configurationEvidenceDigest: configuration.evidenceDigest, proofHistoryDigest: proofs.historyDigest,
        otherRejectionHistoryDigest: otherHistory.historyDigest },
      historyDigest: history.historyDigest,
      requests: gateRequests(profile, backend ? 'https://mcp.tavily.com/mcp/' : descriptor.endpoint),
      timeoutMs: 10000, maximumResponseBytes: 16384, expectedHttpStatus: 401,
      limitations: [backend
        ? 'DIRECT PROVIDER FRONT DOOR ONLY: absent/fixed-invalid credential initialize rejection. NOT APIM broken-Key-Vault, secret availability or end-to-end backend credential qualification.'
        : 'Only two basic missing/malformed caller bearer initialize rejections on the real v3 MCP endpoint. No hidden REST route or full tenant/audience/scope qualification.',
      'Fresh 15-minute experimental configuration and unchanged identity/history are required; no deployment, vault access, roles or resource changes.',
      'No real credentials, ambient credential lookup, cookies, OAuth, keyless/default headers, redirects, retries, session reuse, tools/list or tools/call. Bodies/headers are discarded.',
      backend ? 'Only both 401 responses pass. Every other response, including 2xx/deferred authentication or 403, is inconclusive and stops. Never escalate to a search.'
        : 'Only both 401 responses pass. Wrong statuses fail; transport, timeout, bounds, cancellation, rate limits and server errors are inconclusive.',
      'One matrix attempt per immutable project/profile; interrupted attempts block rerun. A passing result is historical and narrowly scoped, never live health.'] };
    return { ...plan, approvalDigest: digest(plan) };
  }
  requireMetadata(!backend, 'AUTH_REJECTION_UNSUPPORTED');
  if (descriptor.kind === 'existing-mcp' && descriptor.inbound.type === 'anonymous') return {
    schemaVersion: 1, action: 'standalone-mcp-auth-rejection', status: 'not-applicable',
    reason: 'Anonymous MCP has no bearer rejection gate. This is not a passing authentication test.', toolDispatched: false };
  requireMetadata(descriptor.kind === 'native-apim-mcp' && descriptor.inbound.type === 'entra', 'AUTH_REJECTION_UNSUPPORTED');
  const config = mcpRuntimeConfig(input), paths = Object.entries(input.document.paths);
  requireMetadata(input.operationIds.length === 1 && paths.length === 1, 'AUTH_REJECTION_UNSUPPORTED');
  const [route, item] = paths[0], graph = graphOrganizationOperation(config.connectors[0], 'get', item.get ?? {}, item);
  requireMetadata(graph && /^\/[A-Za-z0-9_-]+$/.test(route) && Object.keys(item).join(',') === 'get'
    && item.get.operationId === input.operationIds[0], 'AUTH_REJECTION_UNSUPPORTED');
  const map = JSON.parse(files['infra/operation-map.json']).server;
  requireMetadata(map.length === 1 && map[0].originalOperationId === input.operationIds[0], 'AUTH_REJECTION_UNSUPPORTED');
  const receipt = await readControl(path.join(project.projectDir, 'infra', 'provisioning-receipt.json'));
  const lifecycle = await readMcpLifecycleAttempts(project.projectDir);
  const apiId = descriptor.ownership.apiId;
  requireMetadata(same(receipt.target, deploymentTarget(config)) && receipt.preservation?.verified === true
    && [apiId, `${apiId}-rest`].every(id => receipt.apiIntents?.includes(id))
    && receipt.completedSteps?.some(step => step.phase === 'gateway' && step.id === 'verify-owned-apis')
    && lifecycle.some(record => record.status === 'completed' && record.phase === 'gateway' && record.reviewDigest === project.review.reviewDigest)
    && lifecycle.every(record => ['completed', 'reconciled'].includes(record.status)), 'DEPLOYMENT_CHECKPOINT_REQUIRED');
  const history = await readMcpAuthRejections(project.projectDir, excludeAttempt);
  const plan = { schemaVersion: 1, action: 'standalone-mcp-auth-rejection', status: history.attempts.length ? 'blocked-prior-attempt' : 'review-required',
    projectDir: project.projectDir, reviewDigest: project.review.reviewDigest, descriptorStatus: descriptor.status,
    binding: { receiptDigest: digest(receipt), lifecycleDigest: digest(lifecycle),
      identity: await readAzureIdentity(config, project.projectDir, { required: true }) },
    historyDigest: history.historyDigest,
    requests: cases.map(caseId => ({ caseId, method: caseId.startsWith('mcp-') ? 'POST' : 'GET',
      endpoint: caseId.startsWith('mcp-') ? descriptor.endpoint : `https://${input.azure.apimName}.azure-api.net/${apiId}-rest${route}`,
      authorization: caseId.endsWith('missing') ? 'absent' : 'fixed-malformed-non-JWT',
      ...(caseId.startsWith('mcp-') ? { rpcMethod: 'initialize' } : {}) })),
    timeoutMs: 10000, maximumResponseBytes: 16384, expectedHttpStatus: 401,
    limitations: ['Only this reviewed fixed Graph organization mapping is eligible; other native routes are unsupported, never guessed.',
      'Local owned-deployment history is not fresh ARM verification or live health. No Azure/runtime sign-in, real token, redirects, retries, tools/list, tools/call or direct Graph request.',
      'Bodies and headers are discarded. Only four 401 responses within bounds pass. Stop on any failed/inconclusive case; incomplete outcomes remain inconclusive.',
      'One matrix attempt per immutable project. Prior attempts, including interrupted ones, block repeat execution; never edit history to retry. This does not replay or supersede a positive proof.'] };
  return { ...plan, approvalDigest: digest(plan) };
}

async function probe(request, bounds, signal, transport) {
  const controller = new AbortController(), cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false, status;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, bounds.timeoutMs);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(fail(timedOut ? 'timeout' : 'cancelled'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const work = async () => {
    if (signal?.aborted) controller.abort();
    if (controller.signal.aborted) throw fail('cancelled');
    const response = await transport(request.endpoint, { method: request.method, redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json, text/event-stream',
        ...(request.authorization === 'absent' ? {} : { Authorization: 'Bearer invalid-non-jwt' }),
        ...(request.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        ...(request.authorization === 'fixed-invalid-api-key-sentinel' ? { Authorization: 'Bearer tvly-toolkit-invalid-credential-probe' } : {}) },
      ...(request.method === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'standalone-auth-rejection', version: '1' } } }) } : {}) });
    status = response.status;
    requireMetadata(Number.isInteger(status) && status >= 100 && status <= 599, 'INVALID_RESPONSE');
    const reader = response.body?.getReader();
    if (reader) {
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > bounds.maximumResponseBytes) throw fail('response-limit');
        }
      } finally { await reader.cancel(); }
    }
    return { status: status === 401 ? 'passed' : bounds.profile === providerProfile || status === 429 || status >= 500 ? 'inconclusive' : 'failed',
      httpStatus: status, cause: 'http-status' };
  };
  try { return await Promise.race([work(), aborted]); }
  catch (error) {
    if (Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599) status = error.httpStatus;
    return { status: bounds.profile !== providerProfile && status >= 300 && status < 400 ? 'failed' : 'inconclusive',
      ...(status ? { httpStatus: status } : {}),
      cause: ['timeout', 'cancelled', 'response-limit'].includes(error.code) ? error.code : status ? 'http-status' : 'transport' };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort); controller.abort();
  }
}

async function executeUnlocked(projectDir, options = {}, dependencies = {}, backend = false) {
  requireMetadata(Object.keys(options).every(key => ['approval', 'allowNetwork', 'signal'].includes(key)), 'INVALID_CONFIG');
  const { approval, allowNetwork, signal } = options;
  const reviewed = await planMcpAuthRejection(projectDir, undefined, backend);
  requireMetadata(reviewed.status === 'review-required', 'AUTH_REJECTION_BLOCKED');
  requireMetadata(approval === reviewed.approvalDigest && allowNetwork === true, 'APPROVAL_REQUIRED');
  requireMetadata(!signal?.aborted, 'ABORTED');
  const lockFile = await assertProjectPath(path.join(reviewed.projectDir, '.mcp-network.lock'));
  let lock;
  try { lock = await open(lockFile, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw fail('MCP_NETWORK_LOCKED'); throw error; }
  let output, intent;
  const guard = async () => {
    requireMetadata(same(await planMcpAuthRejection(projectDir, output && path.basename(output), backend), reviewed), 'METADATA_MISMATCH');
    if (intent) requireMetadata(same(await readControl(path.join(output, 'intent.json')), intent), 'METADATA_MISMATCH');
  };
  try {
    await guard();
    output = await assertProjectPath(path.join(reviewed.projectDir, backend ? '.mcp-backend-rejections' : '.mcp-auth-rejections', randomUUID()));
    await mkdir(output, { recursive: true, mode: 0o700 });
    intent = signed({ schemaVersion: reviewed.profile ? 2 : 1, kind: 'standalone-mcp-auth-rejection-intent', plan: reviewed, startedAt: new Date().toISOString() });
    await writeControl(path.join(output, 'intent.json'), intent, { create: true });
    const transport = dependencies.transport ?? publicHttpsTransport({ allowErrorStatus: true,
      requestPolicy: (endpoint, options) => {
        requireMetadata(reviewed.requests.some(request => request.endpoint === endpoint && request.method === options.method), 'NETWORK_BLOCKED');
        return new URL(endpoint);
      } });
    let status = 'passed';
    for (const [index, request] of reviewed.requests.entries()) {
      await guard();
      if (signal?.aborted) { status = 'inconclusive'; break; }
      await writeControl(path.join(output, `dispatch-${index}.json`),
        signed({ intentDigest: intent.receiptDigest, index, preparedAt: new Date().toISOString() }), { create: true });
      await guard();
      const result = await probe(request, reviewed, signal, transport);
      await writeControl(path.join(output, `case-${index}.json`),
        signed({ intentDigest: intent.receiptDigest, index, ...result }), { create: true });
      await guard();
      if (result.status !== 'passed') { status = result.status; break; }
    }
    if (signal?.aborted) status = 'inconclusive';
    const result = signed({ intentDigest: intent.receiptDigest, status, finishedAt: new Date().toISOString() });
    await writeControl(path.join(output, 'result.json'), result, { create: true });
    return { outputDir: output, resultFile: path.join(output, 'result.json'), status,
      toolDispatched: false, replayAuthorized: false, evidence: backend ? 'historical-provider-initialize-rejection-only' : 'historical-basic-bearer-rejection-only',
      ...(reviewed.profile ? { profile: reviewed.profile, backendCredentialPropagationVerified: false } : {}) };
  } finally { await lock.close(); await unlink(lockFile); }
}
async function execute(projectDir, options, dependencies, backend) {
  const project = await readMcpServerProject(projectDir);
  const action = () => executeUnlocked(project.projectDir, options, dependencies, backend);
  return project.review.input.schemaVersion === 3 ? withControlLock(project.projectDir, action) : action();
}
export const executeMcpAuthRejection = (dir, options, dependencies) => execute(dir, options, dependencies, false);
export const planMcpBackendRejection = dir => planMcpAuthRejection(dir, undefined, true);
export const executeMcpBackendRejection = (dir, options, dependencies) => execute(dir, options, dependencies, true);
export const readMcpBackendRejections = dir => readMcpAuthRejections(dir, undefined, true);
