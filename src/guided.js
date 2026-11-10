import { createInterface } from 'node:readline/promises';
import { secretIssues } from './validation.js';

const WELCOME = String.raw`
  __  __  ____ ____
 |  \/  |/ ___|  _ \
 | |\/| | |   | |_) |
 | |  | | |___|  __/
 |_|  |_|\____|_|

 Welcome to Copilot MCP Toolkit
 REST APIs -> MCP tools -> Copilot

`;

export function createPrompter(input = process.stdin, output = process.stderr) {
  const rl = createInterface({ input, output });
  const controller = new AbortController();
  let closed = false;
  const cancelled = () => Object.assign(new Error('Guided review cancelled; no execution approval was granted.'), { code: 'ABORTED' });
  rl.on('close', () => { closed = true; controller.abort(); });
  rl.on('SIGINT', () => rl.close());
  async function ask(label, { defaultValue, optional = false, check, hint } = {}) {
    while (!closed) {
      let raw;
      try {
        raw = await rl.question(`${label}${defaultValue !== undefined ? ` [${defaultValue}]` : ''}: `, { signal: controller.signal });
      } catch (error) { if (closed) throw cancelled(); throw error; }
      if (closed) throw cancelled();
      if (/[\u0000-\u001f\u007f-\u009f]/.test(raw)) { output.write('Control characters are not accepted.\n'); continue; }
      const answer = raw.trim() || defaultValue || '';
      if (!answer && optional) return undefined;
      if (!answer) { output.write('A value is required.\n'); continue; }
      if (/[\u0000-\u001f\u007f-\u009f]/.test(answer)) { output.write('Control characters are not accepted.\n'); continue; }
      if (secretIssues(answer)) { output.write('Possible credential rejected. Enter only nonsecret metadata or a Key Vault reference.\n'); continue; }
      try { if (check) await check(answer); }
      catch {
        if (closed) throw cancelled();
        output.write(`${hint ?? 'The value is outside the supported choices. Review the prompt; no action has been approved.'}\n`);
        continue;
      }
      if (closed) throw cancelled();
      return answer;
    }
    throw cancelled();
  }
  async function choose(label, choices) {
    output.write(`${label}\n${choices.map((c, i) => `${i + 1}. ${c.label}`).join('\n')}\n`);
    const selected = await ask('Choice', { check: value => {
      if (!/^[1-9][0-9]*$/.test(value) || Number(value) > choices.length) throw new Error('Invalid choice.');
    } });
    return choices[Number(selected) - 1].value;
  }
  return { ask, choose, output, signal: controller.signal, close: () => rl.close() };
}

export async function guidedArguments(p, options = {}) {
  if (Object.keys(options).some(key => !['workspace-root', 'config', 'project'].includes(key))) {
    throw new Error('Guided review accepts only --workspace-root, --config and --project; it never accepts execution approvals.');
  }
  p.output.write(WELCOME);
  p.output.write('Local setup and review only. Never enter passwords, tokens or API keys. Saving files needs your confirmation; sign-in, deployment and tool calls need separate approvals.\n');
  p.output.write('Choose Azure API Management (APIM), an existing MCP server, Container Apps, App Service or Functions. Hosting source projects need a prepared recipe JSON file. No cloud changes run from this menu.\n');
  p.output.write('For deployment, validation, HTML handover or FCC/plugin onboarding, choose Show all CLI commands for the task-to-command guide. These are separate reviewed workflows, not automatic setup steps.\n');
  let action = await p.choose('How would you like to start?', [
    { value: 'new', label: 'Start a new MCP setup' },
    { value: 'resume', label: 'Review an existing setup or test run (no actions)' },
    { value: 'advanced', label: 'Review a configuration file (advanced)' },
    { value: 'help', label: 'Show all CLI commands (deploy, validate, HTML, FCC/plugin)' },
    { value: 'exit', label: 'Exit without changes' },
  ]);
  if (action === 'exit') return undefined;
  if (action === 'help') return ['--help'];
  if (action === 'new') {
    if (options.config || options.project) throw new Error('New setup accepts only --workspace-root. Choose saved-setup review for --project or configuration review for --config.');
    const { createGuidedSetup } = await import('./guided-setup.js');
    return createGuidedSetup(p, options);
  }
  if (action === 'advanced') {
    if (options.project) throw new Error('Configuration review accepts --config, not --project. Choose existing setup review for a project folder.');
    action = await p.choose('What would you like to review?', [
      { value: 'generate', label: 'APIM or existing-server configuration (including experimental proxy profiles)' },
      { value: 'hosting', label: 'Container Apps, App Service or Functions recipe' },
      { value: 'execution', label: 'End-to-end test configuration (plan only; do not start)' },
      { value: 'bootstrap', label: 'Container Apps infrastructure choices (plan only)' },
      { value: 'resources', label: 'Choose new or existing Azure resources for APIM' },
      { value: 'exit', label: 'Exit without changes' },
    ]);
    if (action === 'exit') return undefined;
  }
  let review;
  if (action === 'resume') {
    if (options.config) throw new Error('Existing setup review accepts --project, not --config. Choose configuration review for a JSON file.');
    review = await p.choose('What kind of saved work would you like to review?', [
      { value: 'mcp-resume', label: 'APIM setup or existing-server connection (mcp-server.json)' },
      { value: 'mcp-recipe-source-plan', label: 'Hosting source project (recipe-manifest.json)' },
      { value: 'mcp-execution-status', label: 'End-to-end execution run (execution.json)' },
      { value: 'mcp-validation-status', label: 'Step-by-step validation run (validation-run.json)' },
      { value: 'exit', label: 'Cancel without changes' },
    ]);
    if (review === 'exit') return undefined;
  }
  const workspace = options['workspace-root'] ?? await p.ask('Existing absolute workspace directory (not installed code)');
  const args = ['--workspace-root', workspace];
  if (action === 'resume') {
    p.output.write('Select the folder containing the file named in your choice, not a release archive. This reads saved progress only; it does not continue a run, sign in or repeat a tool call.\n');
    const project = options.project ?? await p.ask('Project directory');
    return [review, ...args, '--project', project, '--json', ...(review === 'mcp-resume' ? ['--summary'] : [])];
  }
  const config = options.config ?? await p.ask('Configuration JSON file (no passwords, tokens or API-key values)');
  const command = { hosting: 'mcp-hosting-plan', execution: 'mcp-execution-plan', bootstrap: 'mcp-bootstrap-plan' }[action];
  if (command) {
    const output = await p.ask(action === 'bootstrap' ? 'New review JSON file path (not written during this review)'
      : 'New output directory path (not created during this review)');
    return [command, ...args, '--config', config, '--output', output, '--json', '--summary'];
  }
  return [action === 'resources' ? 'mcp-resources-choose' : 'mcp-server-plan', ...args, '--config', config,
    ...(action === 'resources' ? [] : ['--json', '--summary'])];
}
