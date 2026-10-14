import { validateToolDescription, toolSchemaIssues } from './mcp-tools.js';
import { boundedSnapshot, metadataDigest } from './anonymous-metadata.js';
import { cliStage } from './cli-feedback.js';

const rpcMethods = new Set(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
const rpcStages = new Set(['transport', 'http-status', 'response-read', 'response-limit', 'json-parse',
  'sse-parse', 'sse-event', 'rpc-envelope', 'rpc-error', 'initialization', 'session',
  'tool-schema', 'pagination', 'tool-response', 'local-guard', 'timeout', 'cancelled']);

export function safeMcpDiagnostics(value) {
  if (!value || !rpcMethods.has(value.rpcMethod) || !rpcStages.has(value.rpcStage)
    || Object.keys(value).some(key => !['rpcMethod', 'rpcStage', 'httpStatus', 'toolSchemaIssue'].includes(key))
    || value.toolSchemaIssue !== undefined && (value.rpcMethod !== 'tools/list' || value.rpcStage !== 'tool-schema'
      || !toolSchemaIssues.includes(value.toolSchemaIssue))
    || value.httpStatus !== undefined && (!Number.isInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599)) return undefined;
  return { rpcMethod: value.rpcMethod, rpcStage: value.rpcStage,
    ...(value.httpStatus === undefined ? {} : { httpStatus: value.httpStatus }),
    ...(value.toolSchemaIssue === undefined ? {} : { toolSchemaIssue: value.toolSchemaIssue }) };
}

async function rpcResponse(response, id, maxBytes, budget, at) {
  at('response-read');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response.');
  const sse = (response.headers.get('content-type') ?? '').includes('text/event-stream');
  let text = '';
  let bytes = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      at('response-read');
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      budget.bytes += value.byteLength;
      if (bytes > maxBytes || budget.bytes > budget.maximum) { at('response-limit'); throw new Error('Response limit.'); }
      text += decoder.decode(value, { stream: true });
      if (sse) {
        text = text.replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = text.indexOf('\n\n')) !== -1) {
          const event = text.slice(0, boundary);
          text = text.slice(boundary + 2);
          const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          at('sse-parse');
          const message = JSON.parse(data);
          at('sse-event');
          if (message.id === id) return message;
        }
      }
    }
    if (sse) { at('sse-event'); throw new Error('Missing matching SSE event.'); }
    at('json-parse');
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); }
}

export async function probeMcp(endpoint, { fetchImpl = globalThis.fetch, timeoutMs = 10000, maxBytes = 262144, maxPages = 10,
  maxTotalBytes = maxBytes * maxPages + maxBytes, signal, returnMetadata = false, toolCall, beforeToolCall, beforeToolDispatch, assessToolResult } = {}) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid MCP endpoint.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
    || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576
    || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20
    || !Number.isInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > 22020096) throw new Error('Invalid probe bounds.');
  if (signal?.aborted) throw new Error('Probe aborted.');
  const controller = new AbortController();
  let timer;
  let armTimeout;
  const startedAt = performance.now();
  let abort;
  let session;
  let version = '2025-03-26';
  let requestId = 0;
  let callSent = false;
  let diagnostics;
  let timedOut = false;
  const at = rpcStage => { if (diagnostics) diagnostics = { ...diagnostics, rpcStage }; };
  const budget = { bytes: 0, maximum: maxTotalBytes };
  const work = async () => {
    const send = async (method, params, notification = false) => {
      diagnostics = { rpcMethod: method, rpcStage: 'local-guard' };
      if (controller.signal.aborted) throw new Error('Probe aborted.');
      const id = ++requestId;
      if (method === 'tools/call') {
        await beforeToolDispatch?.();
        if (controller.signal.aborted) throw new Error('Probe aborted.');
        callSent = true;
      }
      at('transport');
      cliStage({ initialize: 'mcp-initialize', 'notifications/initialized': 'mcp-notify',
        'tools/list': 'mcp-list', 'tools/call': 'mcp-call' }[method], method === 'initialize' ? timeoutMs : undefined);
      const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          ...(requestId > 1 ? { 'MCP-Protocol-Version': version } : {}), ...(session ? { 'Mcp-Session-Id': session } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id } : {}), method, params }) });
      if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) diagnostics.httpStatus = response.status;
      at('http-status');
      if (!response.ok) { await response.body?.cancel(); throw new Error('MCP request rejected.'); }
      at('response-read');
      if (notification) { await response.body?.cancel(); return; }
      const message = await rpcResponse(response, id, maxBytes, budget, at);
      at('rpc-envelope');
      if (message?.jsonrpc !== '2.0' || message.id !== id) throw new Error('Invalid MCP response.');
      if (message.error) { at('rpc-error'); throw new Error('Invalid MCP response.'); }
      if (!message.result) throw new Error('Invalid MCP response.');
      if (method === 'initialize') {
        at('session');
        session = response.headers.get('mcp-session-id');
        if (session && (session.length > 1024 || /[^\x21-\x7e]/.test(session))) throw new Error('Invalid session identifier.');
      }
      return message.result;
    };
    const initialized = await send('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'cowork-local-harness', version: '0.1.0' } });
    at('initialization');
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!['2024-11-05', '2025-03-26', '2025-06-18'].includes(initialized.protocolVersion)
      || !object(initialized.capabilities) || !object(initialized.capabilities.tools)
      || (initialized.capabilities.tools.listChanged !== undefined && typeof initialized.capabilities.tools.listChanged !== 'boolean')
      || !object(initialized.serverInfo) || typeof initialized.serverInfo.name !== 'string' || !initialized.serverInfo.name
      || typeof initialized.serverInfo.version !== 'string' || !initialized.serverInfo.version) throw new Error('Unsupported or malformed MCP initialization.');
    version = initialized.protocolVersion;
    await send('notifications/initialized', {}, true);
    const tools = [];
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < maxPages; page++) {
      const result = await send('tools/list', cursor ? { cursor } : {});
      at('tool-schema');
      validateToolDescription(result, { allowEmpty: true });
      tools.push(...result.tools);
      if (tools.length > 1000) { at('response-limit'); throw new Error('Tool count limit.'); }
      if (result.nextCursor === undefined) {
        validateToolDescription({ tools });
        let callResult;
        if (toolCall !== undefined) {
          at('local-guard');
          if (metadataDigest(boundedSnapshot({ tools })) !== toolCall.toolsDigest) throw new Error('Tool schemas changed before call.');
          if (beforeToolCall) {
            // A separately bounded control-plane inspection must not consume the MCP I/O budget.
            const remaining = timeoutMs - (performance.now() - startedAt);
            if (remaining <= 0) throw new Error('Probe timeout.');
            armTimeout(120000);
            await beforeToolCall(controller.signal);
            if (controller.signal.aborted) throw new Error('Probe aborted.');
            armTimeout(remaining);
          }
          const reply = await send('tools/call', { name: toolCall.name, arguments: toolCall.arguments });
          at('tool-response');
          if (reply.isError !== undefined && typeof reply.isError !== 'boolean') throw new Error('Invalid tool response.');
          if (!Array.isArray(reply.content) || reply.content.some(item =>
            !item || typeof item !== 'object' || item.type !== 'text' || typeof item.text !== 'string')
            || (reply.structuredContent !== undefined && (!reply.structuredContent
              || typeof reply.structuredContent !== 'object' || Array.isArray(reply.structuredContent)))) {
            throw new Error('Unsupported tool response shape.');
          }
          callResult = { status: reply.isError === true ? 'tool-error' : 'protocol-success',
            ...(assessToolResult ? { backendAssertion: assessToolResult(reply) } : {}) };
        }
        return { toolCount: tools.length, pages: page + 1, protocolVersion: version,
          ...(returnMetadata === true ? { tools } : {}), ...(callResult === undefined ? {} : { toolCall: callResult }) };
      }
      at('pagination');
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 2048 || cursors.has(result.nextCursor)) throw new Error('Invalid pagination.');
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    at('pagination');
    throw new Error('Page limit.');
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => {
      abort = () => { controller.abort(); reject(new Error('Probe aborted.')); };
      signal?.addEventListener('abort', abort, { once: true });
      armTimeout = duration => {
        clearTimeout(timer);
        timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('Probe timeout.')); }, duration);
      };
      armTimeout(timeoutMs);
    })]);
  } catch (error) {
    if (signal?.aborted) at('cancelled');
    else if (timedOut || error.message === 'Probe timeout.') at('timeout');
    else if (error.name === 'AnonymousMetadataError' && error.code === 'TOKEN_EXPIRED') at('local-guard');
    if (Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 && diagnostics?.rpcStage === 'transport') {
      diagnostics.httpStatus = error.httpStatus;
      at('http-status');
    }
    if (diagnostics?.rpcMethod === 'tools/list' && diagnostics.rpcStage === 'tool-schema'
      && toolSchemaIssues.includes(error.toolSchemaIssue)) diagnostics.toolSchemaIssue = error.toolSchemaIssue;
    const safe = safeMcpDiagnostics(diagnostics);
    if (['json-parse', 'sse-parse', 'tool-schema'].includes(safe?.rpcStage)) {
      error = new Error(`MCP ${safe.rpcStage} validation failed.`);
    }
    if (safe) error.rpcDiagnostics = safe;
    if (callSent) error.invocationStatus = 'unknown';
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
}
