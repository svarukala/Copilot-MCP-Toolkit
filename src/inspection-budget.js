import { cliStage } from './cli-feedback.js';

export const inspectionBudget = Object.freeze({
  commandTimeoutMs: 60000, overallTimeoutMs: 300000, terminationGraceMs: 5000,
});

export class InspectionError extends Error {
  constructor(code) {
    super({
      AZURE_INSPECTION_COMMAND_TIMEOUT: 'Azure read exceeded its 60-second logical-command budget, including retries. No successful inspection or automatic restart is implied.',
      AZURE_INSPECTION_TIMEOUT: 'Read-only inspection exceeded its 300-second overall budget. No readiness is published; review a fresh inspection.',
      AZURE_CLI_ABORTED: 'Read-only inspection was cancelled. Preserve history and review a fresh inspection; never replay a gateway.',
      AZURE_CLI_TERMINATION_UNCONFIRMED: 'Owned Azure process termination could not be confirmed. Keep the provisioning lock; confirm the recorded process has stopped before operator recovery.',
    }[code]);
    this.code = code;
  }
}

export function createInspectionBudget(execute, signal) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new InspectionError('AZURE_CLI_ABORTED'));
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const started = performance.now();
  cliStage('azure-inspection', inspectionBudget.overallTimeoutMs);
  const timer = setTimeout(() => controller.abort(new InspectionError('AZURE_INSPECTION_TIMEOUT')), inspectionBudget.overallTimeoutMs);
  const check = () => {
    if (performance.now() - started >= inspectionBudget.overallTimeoutMs) {
      controller.abort(new InspectionError('AZURE_INSPECTION_TIMEOUT'));
    }
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  return {
    check,
    async run(command, args, options) {
      check();
      cliStage('azure-read', inspectionBudget.commandTimeoutMs);
      const request = new AbortController();
      const requestStarted = performance.now();
      const cancelRequest = () => request.abort(controller.signal.reason);
      controller.signal.addEventListener('abort', cancelRequest, { once: true });
      const commandTimer = setTimeout(() => request.abort(new InspectionError('AZURE_INSPECTION_COMMAND_TIMEOUT')),
        inspectionBudget.commandTimeoutMs);
      const checkRequest = () => {
        if (performance.now() - requestStarted >= inspectionBudget.commandTimeoutMs) {
          request.abort(new InspectionError('AZURE_INSPECTION_COMMAND_TIMEOUT'));
        }
        if (request.signal.aborted) throw request.signal.reason;
        check();
      };
      let cleanupTimer, onAbort, ownedProcessPid;
      const unconfirmed = new Promise((_, reject) => {
        onAbort = () => {
          cleanupTimer = setTimeout(() => {
            const error = new InspectionError('AZURE_CLI_TERMINATION_UNCONFIRMED');
            if (ownedProcessPid) error.ownedProcessPid = ownedProcessPid;
            reject(error);
          }, inspectionBudget.terminationGraceMs);
        };
        request.signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => execute(command, args, { ...options, signal: request.signal, boundedInspection: true,
            onInspectionProcess: pid => { ownedProcessPid = Number.isInteger(pid) && pid > 0 ? pid : undefined; } })),
          unconfirmed,
        ]);
        checkRequest();
        return result;
      } catch (error) {
        if (error.code === 'AZURE_CLI_TERMINATION_UNCONFIRMED') throw error;
        checkRequest();
        throw error;
      } finally {
        clearTimeout(commandTimer); clearTimeout(cleanupTimer);
        controller.signal.removeEventListener('abort', cancelRequest);
        request.signal.removeEventListener('abort', onAbort);
      }
    },
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    },
  };
}
