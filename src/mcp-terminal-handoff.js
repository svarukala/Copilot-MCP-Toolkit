import path from 'node:path';
import { TOOLKIT_ROOT, assertProjectPath, withCliWorkspace } from './config.js';
import { readControl } from './mcp-control.js';
import { planMcpProjectDiscovery, planMcpProjectProof } from './mcp-discovery-project.js';
import { assertMcpProofHistory } from './mcp-proof-history.js';
import { planInteractiveSession } from './mcp-interactive-session.js';

const quote = value => `'${value.replaceAll("'", "''")}'`;
export async function terminalHandoff(options) {
  if (typeof options.workspaceRoot !== 'string' || typeof options.project !== 'string'
    || typeof options.config !== 'string' || !['discovery', 'proof', 'session'].includes(options.phase)) {
    throw Object.assign(new Error('Terminal handoff requires explicit workspace, project, config and discovery/proof/session phase.'),
      { code: 'MCP_TERMINAL_INPUT' });
  }
  return withCliWorkspace(options.workspaceRoot, async () => {
    const project = await assertProjectPath(path.resolve(options.project));
    const config = await assertProjectPath(path.resolve(options.config));
    if (options.phase === 'session') {
      const plan = await planInteractiveSession(options);
      const argv = [path.join(TOOLKIT_ROOT, 'bin', 'copilot-mcp.js'), 'mcp-session',
        '--workspace-root', path.resolve(options.workspaceRoot), '--project', project, '--config', config,
        '--approve', plan.approvalDigest, '--allow-network', '--interactive', '--json'];
      return { status: 'terminal-handoff-not-executed', phase: 'session', plan,
        powershell: `& ${[process.execPath, ...argv].map(quote).join(' ')}`,
        executionAuthorized: false, tokenContinuity: 'opt-in-single-process-15-minutes-no-persistent-cache',
        instructions: ['Review the discovery/session plan before running once in a real terminal; never transcript challenges.',
          'After discovery, review and approve the newly displayed exact proof digest separately. Blank declines.',
          'Expiry, identity changes and restart require separate fresh authentication; no automatic refresh or replay.'] };
    }
    const selection = await readControl(config);
    const proof = options.phase === 'proof';
    const plan = await (proof ? planMcpProjectProof : planMcpProjectDiscovery)(project, selection);
    if (proof) assertMcpProofHistory(plan.proofHistory, plan.approvalDigest, plan.operation.approvalDigest, plan.operation);
    const argv = [path.join(TOOLKIT_ROOT, 'bin', 'copilot-mcp.js'), proof ? 'mcp-proof' : 'mcp-discover',
      '--workspace-root', path.resolve(options.workspaceRoot), '--project', project, '--config', config,
      '--approve', plan.approvalDigest, '--allow-network',
      ...(plan.operation.nativeGetMapping ? ['--allow-cloud'] : []),
      ...(plan.operation.source.inbound.type === 'entra' ? ['--interactive'] : []), '--json'];
    return { status: 'terminal-handoff-not-executed', phase: options.phase, plan,
      powershell: `& ${[process.execPath, ...argv].map(quote).join(' ')}`,
      executionAuthorized: false, tokenContinuity: 'fresh-process-no-persistent-cache',
      instructions: ['Review the exact displayed plan and obtain separate operation approval before running this command once in a real terminal.',
        'Do not redirect, transcript or capture terminal device challenges. Only the bounded final JSON result/evidence paths may be retained.',
        'No console is launched here. Keep the owned terminal open; cancellation or ambiguous completion requires status/reconciliation, not another launch.',
        'Discovery never authorizes proof. Generate a separate proof handoff only after fresh tool review; execution re-lists before dispatch.',
        'This handoff does not share tokens across processes. The optional session phase uses its own config and separate proof approval.'] };
  });
}
