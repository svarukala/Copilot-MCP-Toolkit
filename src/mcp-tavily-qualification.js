import { boundedSnapshot, metadataDigest, requireMetadata } from './anonymous-metadata.js';

export const qualificationKind = 'tavily-search-result-v1';
const digest = value => metadataDigest(boundedSnapshot(value));
const equal = (a, b) => digest(a) === digest(b);
export const qualificationAction = 'standalone-mcp-project-qualification';
export function isTavilyProject(project) {
  const input = project.review.input;
  return input.schemaVersion === 3 && input.kind === 'apim-mcp-proxy'
    && input.experimentalProfile === 'owned-backend-routing-v1' && input.inbound.type === 'entra'
    && input.backend.endpoint === 'https://mcp.tavily.com/mcp/' && input.backend.auth === 'api-key'
    && input.backend.apiKey.headerName?.toLowerCase() === 'authorization';
}
export function assertTavilyProject(project) {
  requireMetadata(isTavilyProject(project), 'QUALIFICATION_UNSUPPORTED');
}
export function tavilySearchArguments() {
  return { query: 'Microsoft Learn Azure API Management MCP', include_domains: ['learn.microsoft.com'],
    search_depth: 'basic', max_results: 1, include_images: false, include_image_descriptions: false,
    include_favicon: false, include_raw_content: false };
}
export function requireTavilyArguments(selection, code = 'QUALIFICATION_ARGUMENTS_INVALID') {
  requireMetadata(selection.toolName === 'tavily_search' && equal(selection.arguments, tavilySearchArguments()), code);
}
export function qualificationBinding(project, selection, history, ordinary) {
  assertTavilyProject(project);
  requireTavilyArguments(selection);
  const args = selection.arguments;
  requireMetadata(!history.attempts.some(item => item.status === 'unresolved'), 'PROOF_OUTCOME_UNRESOLVED');
  requireMetadata(!history.attempts.some(item => item.qualification && item.status !== 'not-dispatched'), 'QUALIFICATION_CONSUMED');
  requireMetadata(!history.attempts.some(item => item.acceptanceProfile && item.status !== 'not-dispatched'), 'QUALIFICATION_CONSUMED');
  const prior = history.attempts.filter(item => item.status === 'completed' && !item.qualification
    && item.operationDigest === ordinary.approvalDigest);
  requireMetadata(prior.length === 1, 'QUALIFICATION_PRIOR_PROOF_REQUIRED');
  return { kind: qualificationKind, priorAttemptId: prior[0].attemptId, priorOperationDigest: prior[0].operationDigest,
    priorEvidenceDigest: prior[0].filesDigest, sourceDigest: ordinary.source.descriptorDigest,
    captureDigest: selection.capture.receiptDigest, argumentsDigest: digest(args) };
}
const predicates = ['all', 'tool-error', 'response-shape', 'representation-conflict', 'results-count',
  'domain', 'title', 'content', 'unexpected-content', 'query-echo'];
export function tavilyFirstCallProfile() {
  return { kind: qualificationKind, semanticsVersion: 1, resultCount: 1, expectedDomain: 'learn.microsoft.com',
    maximumUrlLength: 4096, maximumTitleLength: 2048, maximumContentLength: 65536,
    predicates: [...predicates],
    semantics: ['One structured result or matching JSON text/structured representations; no prose fallback.',
      'HTTPS exact learn.microsoft.com domain, no userinfo/nondefault port; nonempty bounded title and content.',
      'No nonempty raw content, favicon or images; if present, query must echo the exact approved query.',
      'Unknown response shapes are inconclusive; tool errors and failed predicates consume this ordinary call.',
      'Not factual accuracy, ranking, provider credential enforcement, business correctness or Cowork acceptance.'] };
}
export function firstCallProfileBinding() {
  return { kind: qualificationKind, profileDigest: digest(tavilyFirstCallProfile()) };
}
export function validQualificationAssertion(value) {
  return value && equal(Object.keys(value).sort(), ['kind', 'status', 'predicate', ...(value.resultCount === undefined ? [] : ['resultCount'])].sort())
    && value.kind === qualificationKind && ['passed', 'failed', 'inconclusive'].includes(value.status)
    && predicates.includes(value.predicate)
    && (value.status === 'passed' ? value.predicate === 'all' && value.resultCount === 1
      : value.predicate !== 'all' && value.resultCount === undefined)
    && (value.predicate === 'response-shape' ? value.status === 'inconclusive' : value.status !== 'inconclusive');
}
export function assessTavilyResult(reply, query) {
  const profile = tavilyFirstCallProfile();
  const verdict = (status, predicate) => ({ kind: qualificationKind, status, predicate,
    ...(status === 'passed' ? { resultCount: 1 } : {}) });
  if (reply.isError === true) return verdict('failed', 'tool-error');
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  let text;
  if (!Array.isArray(reply.content) || reply.content.length > 1) return verdict('inconclusive', 'response-shape');
  if (reply.content.length === 1) {
    if (reply.content[0].type !== 'text' || typeof reply.content[0].text !== 'string') return verdict('inconclusive', 'response-shape');
    try { text = JSON.parse(reply.content[0].text); }
    catch (error) { if (error instanceof SyntaxError) return verdict('inconclusive', 'response-shape'); throw error; }
    if (!object(text)) return verdict('inconclusive', 'response-shape');
  }
  if (reply.structuredContent !== undefined && !object(reply.structuredContent)) return verdict('inconclusive', 'response-shape');
  if (text !== undefined && reply.structuredContent !== undefined && !equal(text, reply.structuredContent)) {
    return verdict('failed', 'representation-conflict');
  }
  const value = reply.structuredContent ?? text;
  if (!object(value) || !Array.isArray(value.results)) return verdict('inconclusive', 'response-shape');
  if (value.results.length !== profile.resultCount || !object(value.results[0])) return verdict('failed', 'results-count');
  const result = value.results[0];
  if (typeof result.url !== 'string' || result.url.length > profile.maximumUrlLength || result.url.trim() !== result.url) return verdict('failed', 'domain');
  try {
    const url = new URL(result.url);
    if (url.protocol !== 'https:' || url.hostname !== profile.expectedDomain || url.username || url.password || url.port) return verdict('failed', 'domain');
  } catch { return verdict('failed', 'domain'); }
  if (typeof result.title !== 'string' || !result.title.trim() || result.title.length > profile.maximumTitleLength) return verdict('failed', 'title');
  if (typeof result.content !== 'string' || !result.content.trim() || result.content.length > profile.maximumContentLength) return verdict('failed', 'content');
  const empty = value => value === undefined || value === null || value === '';
  if (![value, result].every(item => empty(item.raw_content) && empty(item.favicon)
    && (item.images === undefined || item.images === null || Array.isArray(item.images) && item.images.length === 0))) {
    return verdict('failed', 'unexpected-content');
  }
  if (value.query !== undefined && value.query !== query) return verdict('failed', 'query-echo');
  return verdict('passed', 'all');
}
