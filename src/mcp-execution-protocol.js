import { boundedSnapshot, metadataDigest, requireMetadata } from './anonymous-metadata.js';
import { createEntraDiscoverySession } from './entra-discovery.js';
import { runMcpProjectExecutionOperation } from './mcp-discovery-project.js';

const digest = value => metadataDigest(boundedSnapshot(value));

// One run, one endpoint, and at most discovery followed by proof. Never exported by the public core.
export function createExecutionProtocolAdapter({ runAzure, signal, ...dependencies } = {}) {
  const now = dependencies.now ?? Date.now;
  let state = 'new', session, binding, deadline, timer;
  const operationSignals = new Set();
  const controller = new AbortController();
  const cancellation = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const close = () => {
    state = 'closed';
    session?.close();
    session = undefined;
    clearTimeout(timer);
    for (const operationSignal of operationSignals) operationSignal.removeEventListener('abort', close);
    operationSignals.clear();
    controller.abort();
  };
  cancellation.addEventListener('abort', close, { once: true });
  return {
    close,
    async mcpProjectOperation(projectDir, options, proof, validationGuard) {
      try {
        requireMetadata(typeof proof === 'boolean' && (state === 'new' || state === 'discovered' && proof),
          'PROOF_REPLAY_BLOCKED');
        requireMetadata(!cancellation.aborted && !options.signal?.aborted, 'ABORTED');
        if (options.signal && !operationSignals.has(options.signal)) {
          operationSignals.add(options.signal);
          options.signal.addEventListener('abort', close, { once: true });
        }
        const operation = options.approval?.operation;
        const discovery = proof ? operation?.discoveryPlan : operation;
        requireMetadata(discovery?.action === 'standalone-mcp-tools-list'
          && ['existing-mcp', 'native-apim-mcp', 'apim-mcp-proxy'].includes(discovery.source?.kind),
        'AUTH_CONFIG_INVALID');
        const selected = digest({ projectDir, reviewDigest: options.approval.reviewDigest,
          sourceDigest: discovery.source.descriptorDigest, endpoint: discovery.target.endpoint,
          auth: discovery.auth ?? null });
        requireMetadata(binding === undefined || binding === selected, 'AUTH_CONFIG_INVALID');
        binding = selected;
        if (deadline === undefined) {
          deadline = now() + 900000;
          timer = setTimeout(close, 900000);
          timer.unref();
        }
        requireMetadata(now() + discovery.metadataTimeoutMs < deadline, 'AUTH_SESSION_EXPIRED');
        // A resumed proof needs its own fresh acquisition, not an invented first session operation.
        if (state === 'new' && !proof && discovery.auth) session = createEntraDiscoverySession(dependencies);
        state = proof ? 'proof-running' : 'discovery-running';
        const combinedSignal = options.signal ? AbortSignal.any([cancellation, options.signal]) : cancellation;
        const guard = async () => {
          requireMetadata(!combinedSignal.aborted, 'ABORTED');
          requireMetadata(now() < deadline, 'AUTH_SESSION_EXPIRED');
          await validationGuard?.();
          requireMetadata(!combinedSignal.aborted, 'ABORTED');
          requireMetadata(now() < deadline, 'AUTH_SESSION_EXPIRED');
        };
        const result = await runMcpProjectExecutionOperation(projectDir, { ...options, signal: combinedSignal }, proof,
          { session, runAzure, validationGuard: guard, dependencies });
        if (proof) close();
        else state = 'discovered';
        return result;
      } catch (error) {
        close();
        throw error;
      }
    },
  };
}
