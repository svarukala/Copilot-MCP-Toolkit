#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { withCliFeedback, configureCliFeedback, cliPlanSummary } from '../src/cli-feedback.js';
import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOOLKIT_ROOT, assertProjectPath, resolveWorkspaceRoot, withCliWorkspace } from '../src/config.js';
import { createPrompter, guidedArguments } from '../src/guided.js';
import { runAzureCommand } from '../src/azure.js';
import { capabilities } from '../src/machine-contract.js';
import { mcpServerInputSchema } from '../src/mcp-server.js';
import { HELP } from '../src/help.js';
export { approvalToken } from '../src/contract.js';
function print(value, json) {
  cliPlanSummary(value);
  process.stdout.write(`${json ? JSON.stringify(value, null, 2) : typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  return withCliFeedback(() => mainWithFeedback(args, dependencies));
}
async function mainWithFeedback(args, { runAzure = runAzureCommand, mcpProjectOperation, onMcpDeviceCode, mcpAuthTransport, authExecutionProvider } = {}) {
  let json = args.includes('--json');
  let prompter;
  let standaloneMcp = false;
  try {
    const { values: options, positionals } = parseArgs({
      args, allowPositionals: true, strict: true,
      options: Object.fromEntries([
        ...['project', 'output', 'config', 'workspace-root', 'phase', 'tenant-id', 'approve',
          'subscription-id', 'account-name', 'archive', 'sha256', 'persistence'].map(key => [key, { type: 'string' }]),
        ...['json', 'help', 'version', 'interactive', 'allow-cloud', 'allow-network', 'allow-provider', 'confirm-identity',
          'experimental-configuration', 'use-device-code', 'progress', 'summary'].map(key => [key, { type: 'boolean' }]),
      ]),
    });
    json = Boolean(options.json);
    if (options.help) { print(json ? { help: HELP } : HELP, json); return 0; }
    if (options.version) { print(json ? { version: '0.1.0' } : '0.1.0', json); return 0; }
    if (positionals.length > 1) throw new Error('Only one command is accepted.');
    let command = positionals[0] ?? 'init';
    if (command === 'init') {
      if (json || !process.stdin.isTTY || !process.stderr.isTTY) throw new Error('Guided review requires a terminal. Use the explicit commands with --json in automation.');
      prompter = createPrompter();
      const nextArgs = await guidedArguments(prompter, options);
      prompter.close(); prompter = undefined;
      return nextArgs ? main(nextArgs, { runAzure, mcpProjectOperation, onMcpDeviceCode, mcpAuthTransport }) : 2;
    }
    standaloneMcp = command.startsWith('mcp-');
    configureCliFeedback(command, { progress: options.progress, summary: options.summary });
    const evidenceCommands = ['mcp-export-plan', 'mcp-export', 'mcp-archive-inspect', 'mcp-restore-plan', 'mcp-restore'];
    if (['archive', 'sha256', 'persistence'].some(key => options[key] !== undefined)
      && !evidenceCommands.includes(command) && !(command === 'mcp-resume' && options.archive === undefined && options.sha256 === undefined)) {
      throw new Error('--archive/--sha256 are evidence-only; --persistence is evidence/resume-only.');
    }
    if (options['use-device-code'] !== undefined && !['mcp-account-plan', 'mcp-account-switch', 'mcp-resume'].includes(command)) {
      throw new Error('--use-device-code is supported only for explicit Azure or standalone MCP account plan/switch commands.');
    }
    if (options['experimental-configuration'] !== undefined && !['mcp-reconcile-plan', 'mcp-reconcile'].includes(command)) throw new Error('--experimental-configuration is supported only for explicit v3 reconciliation/refresh.');
    if (options['allow-cloud'] !== undefined && !['mcp-app-apply', 'mcp-inventory', 'mcp-reconcile', 'mcp-proof', 'mcp-proof-preflight', 'mcp-prerequisites', 'mcp-resume', 'mcp-auth-execute'].includes(command)) throw new Error('--allow-cloud is supported only for explicit cloud apply/read commands.');
    if (options['allow-network'] !== undefined && !['mcp-discover', 'mcp-proof', 'mcp-auth-rejection', 'mcp-backend-rejection', 'mcp-qualification', 'mcp-resume', 'mcp-auth-execute'].includes(command)) throw new Error('--allow-network is supported only for explicit MCP or auth-provider execution.');
    if ((options['allow-provider'] !== undefined || options['confirm-identity'] !== undefined) && command !== 'mcp-auth-execute') {
      throw new Error('--allow-provider/--confirm-identity are supported only for explicit mcp-auth-execute phases.');
    }
    if (options['workspace-root'] !== undefined && !['rest-tools-plan', 'rest-tools-write'].includes(command)
      && !command.startsWith('mcp-')) {
      throw new Error('--workspace-root is supported only for standalone mcp-* and rest-tools-* journeys.');
    }
    const workspaceRoot = options['workspace-root'] === undefined ? undefined : await resolveWorkspaceRoot(options['workspace-root']);
    return await withCliWorkspace(workspaceRoot, async () => {
    if (['mcp-recipe-source-plan', 'mcp-recipe-release-plan', 'mcp-recipe-release-bundle',
      'mcp-recipe-reference-plan', 'mcp-recipe-reference-create'].includes(command)) {
      const source = command === 'mcp-recipe-source-plan', planning = command.endsWith('-plan');
      const allowed = ['project', 'workspace-root', 'json', ...(source ? [] : ['config', 'output',
        ...(planning ? ['summary'] : ['approve'])])];
      if (Object.keys(options).some(key => !allowed.includes(key)) || !workspaceRoot || !options.project
        || !source && (!options.config || !options.output)) {
        throw new Error('Recipe artifacts require --workspace-root and --project; release/reference also require --config and new --output. Writes need exact --approve. No live effects.');
      }
      const artifacts = await import('../src/mcp-recipe-artifacts.js');
      const action = source ? artifacts.recipeSourcePlan : command.includes('-release-')
        ? planning ? artifacts.planRecipeRelease : artifacts.writeRecipeRelease
        : planning ? artifacts.planRecipeReference : artifacts.writeRecipeReference;
      print(await action({ workspaceRoot, project: options.project, config: options.config,
        output: options.output, approval: options.approve }), true);
      return 0;
    }
    if (['mcp-container-apps-schema', 'mcp-container-apps-plan', 'mcp-container-apps-create'].includes(command)) {
      const schema = command === 'mcp-container-apps-schema', planning = command === 'mcp-container-apps-plan';
      const allowed = schema ? ['json'] : ['config', 'output', 'workspace-root', 'json', ...(planning ? ['summary'] : ['approve'])];
      if (Object.keys(options).some(key => !allowed.includes(key))
        || !schema && (!workspaceRoot || !options.config || !options.output)) {
        throw new Error('Container Apps schema accepts --json only. Plan/create requires --workspace-root, --config and a new --output directory; create also needs exact --approve. Local source generation only.');
      }
      const recipe = await import('../src/mcp-container-apps.js');
      if (schema) print(recipe.containerAppsSchema, true);
      else print(await (planning ? recipe.planContainerApps : recipe.writeContainerApps)({
        config: options.config, output: options.output, workspaceRoot, approval: options.approve,
      }), true);
      return 0;
    }
    if (['mcp-auth-execution-schema', 'mcp-auth-execution-plan', 'mcp-auth-execute', 'mcp-auth-execution-status'].includes(command)) {
      const schema = command === 'mcp-auth-execution-schema', status = command === 'mcp-auth-execution-status';
      const allowed = schema ? ['json'] : ['workspace-root', 'project', 'json', ...(status ? [] : ['config', 'phase',
        ...(command === 'mcp-auth-execution-plan' ? ['summary'] : ['approve', 'allow-provider', 'allow-network',
          'allow-cloud', 'interactive', 'confirm-identity'])])];
      if (Object.keys(options).some(key => !allowed.includes(key)) || !schema && (!workspaceRoot || !options.project)
        || !schema && !status && (!options.phase || options.phase !== 'close' && !options.config)) {
        throw new Error('Use auth execution schema or an explicit workspace/project. Plan/execute requires a phase and config (except close). Each effect phase has separate exact approval and flags.');
      }
      const auth = await import('../src/mcp-auth-execution.js');
      const selected = { workspaceRoot, project: options.project, config: options.config, phase: options.phase,
        approval: options.approve, allowProvider: options['allow-provider'], allowNetwork: options['allow-network'],
        allowCloud: options['allow-cloud'], interactive: options.interactive, confirmIdentity: options['confirm-identity'] };
      const dependencies = { ...(authExecutionProvider ? { provider: authExecutionProvider } : {}), runAzure };
      if (schema) print(auth.authExecutionSchema, true);
      else if (status) print(await auth.readAuthExecutionStatus(selected), true);
      else if (command === 'mcp-auth-execution-plan') print(await auth.planAuthExecution(selected, dependencies), true);
      else {
        const controller = new AbortController(), cancel = () => controller.abort();
        process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
        try { print(await auth.executeAuthPhase({ ...selected, signal: controller.signal }, dependencies), true); }
        finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
      }
      return 0;
    }
    if (['mcp-auth-wiqd-schema', 'mcp-auth-wiqd-plan', 'mcp-auth-wiqd-bundle'].includes(command)) {
      const schema = command === 'mcp-auth-wiqd-schema', planning = command === 'mcp-auth-wiqd-plan';
      const allowed = schema ? ['json'] : ['config', 'output', 'workspace-root', 'json', ...(planning ? ['summary'] : ['approve'])];
      if (Object.keys(options).some(key => !allowed.includes(key))
        || !schema && (!options.config || !options.output || !workspaceRoot)) {
        throw new Error('WIQD handoff schema accepts only --json. Plan/bundle needs --workspace-root, --config and new --output; bundle needs exact --approve. No WIQD execution or credential access.');
      }
      const wiqd = await import('../src/mcp-auth-wiqd.js');
      if (schema) print(wiqd.authWiqdSchema, true);
      else print(await (planning ? wiqd.planAuthWiqdBundle : wiqd.writeAuthWiqdBundle)({
        config: options.config, output: options.output, workspaceRoot, approval: options.approve,
      }), true);
      return 0;
    }
    if (['mcp-auth-registration-schema', 'mcp-auth-registration-plan', 'mcp-auth-registration-bundle'].includes(command)) {
      const schema = command === 'mcp-auth-registration-schema';
      const allowed = schema ? ['json'] : ['config', 'output', 'workspace-root', 'json',
        ...(command === 'mcp-auth-registration-plan' ? ['summary'] : ['approve'])];
      if (Object.keys(options).some(key => !allowed.includes(key))
        || !schema && (!options.config || !options.output || !workspaceRoot)) {
        throw new Error('Registration schema accepts only --json. Plan/bundle requires --workspace-root, --config and new --output; bundle also needs exact --approve. Preparation only: no login or registration execution.');
      }
      const registration = await import('../src/mcp-auth-registration.js');
      if (schema) print(registration.authRegistrationInputSchema, true);
      else {
        const selected = { config: options.config, output: options.output, workspaceRoot, approval: options.approve };
        print(await (command === 'mcp-auth-registration-plan'
          ? registration.planAuthRegistrationBundle : registration.writeAuthRegistrationBundle)(selected), true);
      }
      return 0;
    }
    if (['mcp-fcc-schema', 'mcp-fcc-plan', 'mcp-fcc-bundle'].includes(command)) {
      const schema = command === 'mcp-fcc-schema';
      const allowed = schema ? ['json'] : ['config', 'output', 'workspace-root', 'json',
        ...(command === 'mcp-fcc-plan' ? ['summary'] : ['approve'])];
      if (Object.keys(options).some(key => !allowed.includes(key))
        || !schema && (!options.config || !options.output || !workspaceRoot)) {
        throw new Error('FCC schema accepts only --json. FCC plan/bundle requires --workspace-root, --config and new --output; bundle also needs exact --approve. No live operations are supported.');
      }
      const fcc = await import('../src/mcp-fcc.js');
      if (schema) print(fcc.fccInputSchema, true);
      else {
        const selected = { config: options.config, output: options.output, workspaceRoot, approval: options.approve };
        print(await (command === 'mcp-fcc-plan' ? fcc.planFccBundle : fcc.writeFccBundle)(selected), true);
      }
      return 0;
    }
    if (command === 'mcp-diagnose') {
      if (!options.project || Object.keys(options).some(key => !['project', 'config', 'workspace-root', 'json'].includes(key))) {
        throw new Error('Diagnosis requires --project and accepts only optional --config, --workspace-root and --json. It never executes probes or retries.');
      }
      const { readMcpDiagnosis } = await import('../src/mcp-diagnosis.js');
      const report = await readMcpDiagnosis(options.project, { config: options.config });
      print(report, true);
      return report.status === 'attention-required' ? 2 : 0;
    }
    if (evidenceCommands.includes(command)) {
      const exporting = command.startsWith('mcp-export'), inspecting = command === 'mcp-archive-inspect';
      const allowed = ['workspace-root', 'json', ...(inspecting ? ['archive', 'sha256']
        : [...(exporting ? ['project'] : ['archive', 'sha256']), 'output', 'persistence',
          ...(command.endsWith('-plan') ? ['summary'] : ['approve'])])];
      if (Object.keys(options).some(key => !allowed.includes(key))
        || (exporting ? !options.project : !options.archive || !options.sha256) || !inspecting && !options.output) {
        throw new Error('Use only the documented evidence inputs, a new --output, and exact --approve for writes. Inspection/restore require the independently retained --sha256.');
      }
      const archive = await import('../src/mcp-evidence.js');
      const selected = { output: options.output, persistence: options.persistence, sha256: options.sha256, approval: options.approve };
      const action = exporting ? command.endsWith('-plan') ? archive.planMcpEvidenceExport : archive.exportMcpEvidence
        : inspecting ? archive.inspectMcpEvidence : command.endsWith('-plan') ? archive.planMcpEvidenceRestore : archive.restoreMcpEvidence;
      print(await action(exporting ? options.project : options.archive, selected), true);
      return 0;
    }
    if (command === 'mcp-resume') {
      if (!options.project || Object.keys(options).some(key => !['project', 'config', 'workspace-root', 'phase',
        'tenant-id', 'subscription-id', 'account-name', 'use-device-code', 'approve', 'allow-cloud', 'allow-network',
        'interactive', 'json', 'summary', 'progress', 'persistence'].includes(key))) throw new Error('Resume requires --project and only supported resume/selection/approval options.');
      const { planMcpResume } = await import('../src/mcp-resume.js');
      const persistence = options.persistence === undefined ? undefined
        : (await import('../src/mcp-recovery.js')).persistenceGuidance(options.persistence);
      const target = ['tenant-id', 'subscription-id', 'account-name'].some(key => options[key] !== undefined)
        ? { tenantId: options['tenant-id'], subscriptionId: options['subscription-id'], accountName: options['account-name'] } : undefined;
      const report = await planMcpResume(path.resolve(options.project), { phase: options.phase,
        config: options.config ? path.resolve(options.config) : undefined, target, useDeviceCode: options['use-device-code'] === true });
      if (persistence) report.persistence = persistence;
      if (options.approve === undefined) {
        print(report, true);
        return ['blocked', 'input-required'].includes(report.status) ? 2 : 0;
      }
      if (!report.next.command || !report.next.approval || options.approve !== report.next.approval) {
        throw Object.assign(new Error('Resume requires the exact current next.approval. State, purpose, freshness or history may have changed; review mcp-resume again.'), { code: 'APPROVAL_REQUIRED' });
      }
      for (const flag of ['allow-cloud', 'allow-network']) {
        if (report.next.requiredFlags.includes(`--${flag}`) ? options[flag] !== true : options[flag] !== undefined) {
          throw new Error(`Resume requires only the effect opt-ins listed in next.requiredFlags; check --${flag}.`);
        }
      }
      const forwarded = { approve: report.next.phaseApproval, json: true,
        ...Object.fromEntries(['allow-cloud', 'allow-network', 'interactive'].filter(key => options[key] !== undefined)
          .map(key => [key, options[key]])) };
      for (let i = 0; i < report.next.args.length; i++) {
        const key = report.next.args[i].slice(2);
        forwarded[key] = ['use-device-code', 'experimental-configuration'].includes(key) ? true : report.next.args[++i];
      }
      for (const key of Object.keys(options)) delete options[key];
      Object.assign(options, forwarded);
      command = report.next.command;
    }
    if (options.phase && !(command.startsWith('mcp-app-') ? ['inspect', 'create', 'configure', 'preauthorize', 'reconcile'] : ['foundation', 'finalize', 'gateway']).includes(options.phase)) throw new Error('Unsupported phase for this command.');
    if (command === 'schema') { print(mcpServerInputSchema, true); return 0; }
    if (command === 'capabilities') { print(await capabilities(), true); return 0; }

    if (['mcp-prerequisites-plan', 'mcp-prerequisites', 'mcp-identity-plan'].includes(command)) {
      if (!options.project) throw new Error('Pass --project for exact target-bound prerequisites.');
      const prerequisites = await import('../src/mcp-prerequisites.js');
      const dir = await assertProjectPath(path.resolve(options.project));
      const result = command === 'mcp-identity-plan' ? await prerequisites.planMcpIdentityPrerequisite(dir)
        : command === 'mcp-prerequisites-plan' ? await prerequisites.planMcpPrerequisites(dir)
          : await prerequisites.inspectMcpPrerequisites(dir, { approval: options.approve, allowCloud: options['allow-cloud'], run: runAzure });
      print(result, true);
      return result.status?.startsWith('blocked') ? 2 : 0;
    }
    if (['mcp-fixture-plan', 'mcp-fixture-bundle'].includes(command)) {
      if (!options.config || command === 'mcp-fixture-bundle' && !options.output) throw new Error('Pass --config; fixture bundle also requires --output and the exact --approve reviewDigest. Cloud apply is unsupported.');
      const fixture = await import('../src/mcp-delegated-fixture.js');
      const input = await (await import('../src/mcp-control.js')).readControl(path.resolve(options.config));
      print(command === 'mcp-fixture-plan' ? fixture.prepareDelegatedFixture(input)
        : await fixture.createDelegatedFixture(input, { output: options.output, approval: options.approve }), true);
      return 0;
    }
    if (['mcp-auth-rejection-plan', 'mcp-auth-rejection', 'mcp-backend-rejection-plan', 'mcp-backend-rejection'].includes(command)) {
      if (!options.project || options.config || options.interactive || options.output) throw new Error('Pass only --project with workspace options; execution also requires --approve and --allow-network. No configurable URL, token, config, output or sign-in is supported.');
      const gate = await import('../src/mcp-auth-rejection.js');
      const dir = await assertProjectPath(path.resolve(options.project));
      const backend = command.startsWith('mcp-backend');
      if (command.endsWith('-plan')) { print(await (backend ? gate.planMcpBackendRejection : gate.planMcpAuthRejection)(dir), true); return 0; }
      const controller = new AbortController(), cancel = () => controller.abort();
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
      try {
        const result = await (backend ? gate.executeMcpBackendRejection : gate.executeMcpAuthRejection)(dir, { approval: options.approve, allowNetwork: options['allow-network'],
          signal: controller.signal }, mcpAuthTransport ? { transport: mcpAuthTransport } : {});
        print(result, true);
        return result.status === 'passed' ? 0 : 2;
      } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    }
    if (command === 'mcp-status') {
      if (!options.project) throw new Error('Pass --project for local evidence status.');
      print(await (await import('../src/mcp-status.js')).readMcpStatus(path.resolve(options.project)), true);
      return 0;
    }
    if (['mcp-proof-preflight-plan', 'mcp-proof-preflight'].includes(command)) {
      if (!options.project || !options.config) throw new Error('Pass --project and --config with the proof selection.');
      const operations = await import('../src/mcp-discovery-project.js');
      const selection = await (await import('../src/mcp-control.js')).readControl(path.resolve(options.config));
      const dir = await assertProjectPath(path.resolve(options.project));
      if (command.endsWith('-plan')) print(await operations.planMcpProofPreflight(dir, selection), true);
      else {
        const controller = new AbortController(), cancel = () => controller.abort();
        process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
        try { print(await operations.preflightMcpProof(dir, selection, { approval: options.approve,
          allowCloud: options['allow-cloud'], runAzure, signal: controller.signal }), true); }
        finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
      }
      return 0;
    }
    if (['mcp-discovery-plan', 'mcp-discover', 'mcp-proof-plan', 'mcp-proof', 'mcp-qualification-plan', 'mcp-qualification'].includes(command)) {
      if (!options.project || !options.config) throw new Error('Pass --project and --config with exact discovery identity or proof selection.');
      const operations = await import('../src/mcp-discovery-project.js');
      const { readControl } = await import('../src/mcp-control.js');
      const dir = await assertProjectPath(path.resolve(options.project));
      const selection = await readControl(path.resolve(options.config));
      const qualification = command.startsWith('mcp-qualification');
      const proof = qualification || command.startsWith('mcp-proof');
      const plan = await (qualification ? operations.planMcpProjectQualification : proof ? operations.planMcpProjectProof : operations.planMcpProjectDiscovery)(dir, selection);
      if (command.endsWith('-plan')) { print(plan, true); return 0; }
      if (options.approve !== plan.approvalDigest || options['allow-network'] !== true) throw new Error('Exact saved project plan approvalDigest and --allow-network are required.');
      if (plan.operation.nativeGetMapping && options['allow-cloud'] !== true) throw new Error('This unannotated native GET proof additionally requires --allow-cloud for its reviewed read-only ARM verification.');
      if (options['allow-cloud'] !== undefined && !plan.operation.nativeGetMapping) throw new Error('--allow-cloud is only applicable to the project-bound native GET proof mapping.');
      const protectedEndpoint = plan.operation.source.inbound.type === 'entra';
      if (protectedEndpoint && !onMcpDeviceCode && (!options.interactive || !process.stdin.isTTY || !process.stderr.isTTY)) {
        throw new Error('Protected discovery/proof requires --interactive and a terminal for transient device sign-in. Login/account selection is not an MCP token.');
      }
      const controller = new AbortController(), cancel = () => controller.abort();
      process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
      try {
        const execution = { selection, approval: plan, allowNetwork: true, signal: controller.signal,
          ...(plan.operation.nativeGetMapping ? { allowCloud: true } : {}),
          onDeviceCode: onMcpDeviceCode ?? (({ verificationUri, userCode, expiresAt }) => {
            process.stderr.write(`Reviewed MCP public-client sign-in: ${verificationUri}\nCode: ${userCode}\nExpires: ${expiresAt}\nDo not save this transient challenge. Ctrl+C cancels; it does not revoke consent.\n`);
          }) };
        const result = await (mcpProjectOperation
          ? mcpProjectOperation(dir, execution, qualification ? 'qualification' : proof)
          : qualification ? operations.runMcpProjectQualification(dir, execution)
            : proof ? operations.runMcpProjectProof(dir, execution, { runAzure }) : operations.discoverMcpProjectTools(dir, execution));
        print({ outputDir: result.outputDir, resultFile: result.resultFile, descriptorStatus: result.descriptorStatus,
          coworkRuntimeVerified: false, ...(proof ? { status: result.result.status,
            ...(result.result.acceptanceProfile ? { acceptanceProfile: result.result.acceptanceProfile } : {}),
            ...(result.result.backendAssertion ? { backendAssertion: result.result.backendAssertion,
              ...(result.result.backendAssertion.status !== 'passed'
                ? { recovery: 'Backend qualification did not pass. Preserve this sent-call journal; investigate the backend without replaying this proof.' } : {}) } : {}) }
            : { evidence: result.result.evidence }) }, true);
        return proof && (result.result.status !== 'protocol-success'
          || result.result.backendAssertion && result.result.backendAssertion.status !== 'passed') ? 2 : 0;
      } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    }

    if (['mcp-resources-plan', 'mcp-resources-choose', 'mcp-resources-write'].includes(command)) {
      if (!options.config) throw new Error('Pass --config with explicit resource choices or a definition for guided selection.');
      const resources = await import('../src/mcp-resources.js');
      const { readControl, writeControl } = await import('../src/mcp-control.js');
      const input = await readControl(path.resolve(options.config));
      if (command === 'mcp-resources-choose') {
        if (!process.stdin.isTTY || options.json) throw new Error('Guided selection needs a terminal; use mcp-resources-plan with explicit JSON choices in noninteractive mode.');
        prompter = createPrompter();
        const plan = await resources.chooseMcpResources(input, prompter);
        print(plan, true);
        return plan.status === 'cancelled' ? 2 : 0;
      }
      const plan = await resources.prepareResourceSelection(input);
      if (command === 'mcp-resources-plan') print(plan, true);
      else {
        if (!options.output || options.approve !== plan.approvalToken) throw new Error('Pass a new --output FILE and exact resource-selection --approve token. This writes a definition only.');
        await writeControl(path.resolve(options.output), plan.definition, { create: true });
        print({ status: 'definition-written-not-deployed', output: path.resolve(options.output), compatibility: plan.compatibility }, true);
      }
      return 0;
    }
    if (['mcp-app-init', 'mcp-app-account-plan', 'mcp-app-account-switch', 'mcp-app-plan', 'mcp-app-apply'].includes(command)) {
      if (!options.project) throw new Error('Pass --project with the independent app-setup workspace.');
      const app = await import('../src/mcp-app-setup.js');
      const dir = await assertProjectPath(path.resolve(options.project));
      const { readControl } = await import('../src/mcp-control.js');
      const resource = command !== 'mcp-app-init' && options.config ? await readControl(path.resolve(options.config)) : undefined;
      const requested = ['tenant-id', 'subscription-id', 'account-name'].some(key => options[key] !== undefined)
        ? { tenantId: options['tenant-id'], subscriptionId: options['subscription-id'], accountName: options['account-name'] } : undefined;
      let result;
      if (command === 'mcp-app-init') {
        if (!options.config) throw new Error('Pass --config with explicit target and application choices.');
        result = await app.createMcpAppWorkspace(dir, await readControl(path.resolve(options.config)));
      } else if (command === 'mcp-app-account-plan') result = await app.planMcpAppAccount(dir, requested);
      else if (command === 'mcp-app-account-switch') result = await app.switchMcpAppAccount(dir, { requested, approval: options.approve, run: runAzure });
      else if (command === 'mcp-app-plan') result = await app.planMcpAppSetup(dir, { phase: options.phase, resource });
      else result = await app.applyMcpAppSetup(dir, { phase: options.phase, resource, approval: options.approve, allowCloud: options['allow-cloud'], run: runAzure });
      print(result, true);
      return result.status?.startsWith('blocked') ? 2 : 0;
    }
    if (['mcp-inventory-plan', 'mcp-inventory', 'mcp-reconcile-plan', 'mcp-reconcile'].includes(command)) {
      if (!options.project) throw new Error('Pass --project with an independent generated MCP project.');
      const resources = await import('../src/mcp-resources.js');
      const lifecycle = await import('../src/mcp-lifecycle.js');
      const dir = await assertProjectPath(path.resolve(options.project));
      const execution = { approval: options.approve, allowCloud: options['allow-cloud'], run: runAzure,
        experimentalConfiguration: options['experimental-configuration'] === true };
      const controller = command === 'mcp-reconcile' ? new AbortController() : undefined;
      const cancel = () => controller.abort();
      if (controller) { process.once('SIGINT', cancel); process.once('SIGTERM', cancel); }
      try {
        const result = command === 'mcp-inventory-plan' ? await resources.planResourceInventory(dir)
          : command === 'mcp-inventory' ? await resources.inspectResourceInventory(dir, execution)
            : command === 'mcp-reconcile-plan' ? await lifecycle.planMcpServerReconcile(dir, execution)
              : await lifecycle.reconcileMcpServer(dir, { ...execution, signal: controller.signal });
        print(result, true);
        return result.status?.startsWith('blocked') || result.status === 'failed' ? 2 : 0;
      } finally {
        if (controller) { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
      }
    }
    if (['mcp-account-plan', 'mcp-account-switch'].includes(command)) {
      if (!options.project) throw new Error('Pass --project for the reviewed private Azure authentication context.');

      const projectDir = await assertProjectPath(path.resolve(options.project));
      const requested = { tenantId: options['tenant-id'], subscriptionId: options['subscription-id'], accountName: options['account-name'] };
      const lifecycle = await import('../src/mcp-lifecycle.js');
      const planAccount = lifecycle.planMcpServerAccount;
      const switchAccount = lifecycle.switchMcpServerAccount;
      const useDeviceCode = options['use-device-code'] === true;
      if (command.endsWith('-plan')) { print(await planAccount(projectDir, requested, { useDeviceCode }), true); return 0; }
      const controller = useDeviceCode ? new AbortController() : undefined;
      const cancel = () => controller.abort();
      if (controller) { process.once('SIGINT', cancel); process.once('SIGTERM', cancel); }
      try {
        print(await switchAccount(projectDir, requested, { approval: options.approve, run: runAzure, useDeviceCode,
          ...(controller ? { signal: controller.signal, onAzureDeviceCode: ({ verificationUri, userCode }) => {
            process.stderr.write(`Azure device-code sign-in: ${verificationUri}\nCode: ${userCode}\nComplete only this explicitly requested tenant sign-in. Do not save this transient code. Ctrl+C cancels.\n`);
          } } : {}) }), true);
        return 0;
      } finally {
        if (controller) { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
      }
    }
    if (['mcp-provision-plan', 'mcp-provision', 'mcp-capture-plan'].includes(command)) {
      if (!options.project) throw new Error('Pass --project with an independent MCP project directory.');
      const lifecycle = await import('../src/mcp-lifecycle.js');
      const projectDir = await assertProjectPath(path.resolve(options.project));
      if (command === 'mcp-provision-plan') print(await lifecycle.planMcpServerProvision(projectDir, { phase: options.phase }), true);
      else if (command === 'mcp-provision') {
        const result = await lifecycle.provisionMcpServer(projectDir, { phase: options.phase, approval: options.approve, run: runAzure });
        print(result, true);
        return result.lifecycleStatus === 'completed' ? 0 : 2;
      } else print(await lifecycle.planMcpServerCapture(projectDir), true);
      return 0;
    }
    if (['mcp-server-plan', 'mcp-server-create'].includes(command)) {
      if (!options.config) throw new Error('Standalone generation requires --config FILE with a reviewed nonsecret MCP server definition.');
      const { prepareMcpServer, createMcpServerProject } = await import('../src/core.js');
      const filename = await assertProjectPath(path.resolve(options.config));
      if ((await lstat(filename)).size > 1048576) throw new Error('MCP server definition must be no larger than 1 MiB.');
      const review = await prepareMcpServer(JSON.parse(await readFile(filename, 'utf8')));
      if (command === 'mcp-server-plan') print(review, true);
      else {
        if (!options.output || options.approve !== review.reviewDigest) throw new Error('Pass --output NEW-DIR and --approve with the exact mcp-server-plan reviewDigest. This approves local generation only.');
        print(await createMcpServerProject(review, { workspaceRoot: workspaceRoot ?? TOOLKIT_ROOT, projectDir: path.resolve(options.output) }), true);
      }
      return 0;
    }
    if (['rest-tools-plan', 'rest-tools-write'].includes(command)) {
      if (!options.config || !options.output) throw new Error('REST authoring requires --config DEFINITION.json and --output NEW-OPENAPI.json.');
      const { planRestToolWrite, writeRestTools } = await import('../src/rest-authoring-cli.js');
      const input = { definitionFile: options.config, outputPath: options.output };
      print(command === 'rest-tools-plan' ? await planRestToolWrite(input)
        : await writeRestTools({ ...input, approval: options.approve }), true);
      return 0;
    }

    throw new Error('Unsupported command. Run copilot-mcp --help for the bounded standalone command set.');
    });
  } catch (error) {
    const checkpoints = {
      AUTH_CONFIG_INVALID: 'Review the exact resource app, separate allowlisted public discovery client and expected user object ID. Never substitute a first-party service client or Azure CLI account for the MCP client/user.',
      AUTHENTICATION_FAILED: 'Inspect available authentication-stage diagnostics first. A generic authentication failure is not evidence of consent or permission denial. Azure CLI login is separate from MCP runtime sign-in; do not grant permissions or retry a sent/unknown proof to diagnose it.',
      AUTHENTICATION_REJECTED: 'The returned identity/token does not satisfy the reviewed MCP authorization. Stop; verify tenant, resource audience, public client, user and scope with the administrator. Do not downgrade to anonymous.',
      OAUTH_REVIEWED_IMPORT_REQUIRED: 'Use the provider-supported OAuth flow outside this toolkit and preserve real tools/list results and original capturedAt outside this toolkit. OAuth references do not support integrated discovery or REST OAuth exchange.',
      DEPLOYMENT_CHECKPOINT_REQUIRED: 'Complete or reconcile the exact generated gateway lifecycle before network discovery. A generated endpoint is not evidence of a deployed service.',
      PROOF_OUTCOME_UNRESOLVED: 'Inspect retained .mcp-observations intent/result/failure and server-side owner logs. A call may have been sent; no automatic replay or history rewrite is supported. Stop further calls until the owner reconciles the external outcome.',
      PROOF_REPLAY_BLOCKED: 'This exact proof approval was already consumed. Read its retained result instead of repeating the call.',
      AUTH_REJECTION_UNSUPPORTED: 'Basic auth rejection supports only the exact single no-argument Graph organization native mapping. Other mappings are unsupported, not guessed. Direct anonymous MCP is not applicable, never a passing gate.',
      AUTH_REJECTION_BLOCKED: 'A prior auth-rejection attempt or unsupported applicability blocks execution. Read mcp-status and preserve the journal; no automatic replay or historical/manual result import is supported.',
      MCP_NETWORK_LOCKED: 'An active or interrupted standalone network lock exists. Do not remove an active lock or start concurrent discovery, proof or auth checks. Preserve interrupted evidence for owner inspection.',
      AUTHENTICATION_TIMEOUT: 'Device authentication expired. For a proof, run mcp-proof-plan again with the unchanged selection and inspect proofHistory: only validated not-dispatched evidence permits a separately approved, user-directed restart. For tools-list discovery, review a fresh discovery plan. Do not edit history, change the reason to evade replay protection, or retry any sent/unknown call.',
      CLOUD_APPROVAL_REQUIRED: 'Review the native fixed-GET mapping and exact read-only ARM requests in mcp-proof-plan; both --allow-cloud and --allow-network are required for this project-only proof.',
      APIM_PROOF_MAPPING_MISMATCH: 'Native mapping inspection failed; a read/parse/local-state error is not proof of cloud drift. Inspect safe stage diagnostics and the exact reviewed resources before another device sign-in. Do not edit captures, approve guessed mappings, erase proof history or replay uncertain attempts.',
    };
    const failureTools = standaloneMcp ? await import('../src/mcp-failure.js') : undefined;
    const diagnostics = standaloneMcp ? failureTools.mcpFailureDiagnostics(error.diagnostics) : error.diagnostics;
    const checkpoint = standaloneMcp ? failureTools.mcpFailureGuidance(diagnostics,
      error.invocationStatus === 'unknown' ? 'unknown-no-replay' : undefined) ?? checkpoints[error.code] : undefined;
    if (json) print({ success: false, error: error.message,
      ...(/^MCP_(?:ARCHIVE|RECOVERY|PERSISTENCE|DIAGNOSIS|FCC)_/.test(error.code ?? '') ? { code: error.code } : {}),
      ...(error.code === 'PROOF_CAPTURE_INVALID'
      ? { code: error.code, field: 'capture', reason: error.reason } : {}),
      ...(checkpoint ? { checkpoint } : {}), ...(diagnostics ? { diagnostics } : {}) }, true);
    else process.stderr.write(`Error: ${error.message}\n${checkpoint ? `${checkpoint}\n` : ''}${standaloneMcp && diagnostics ? `Diagnostics: ${JSON.stringify(diagnostics)}\n` : ''}`);
    return 1;
  } finally { prompter?.close(); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
