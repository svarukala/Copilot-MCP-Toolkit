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
  p.output.write('Local guided setup only. Never enter credentials. Local generation requires confirmation; sign-in, deployment and tool calls require separate approvals.\n');
  let action = await p.choose('How would you like to start?', [
    { value: 'new', label: 'Start a new MCP setup' },
    { value: 'resume', label: 'Resume an existing setup (review only)' },
    { value: 'advanced', label: 'Advanced: review an existing definition or resource choices' },
    { value: 'exit', label: 'Exit without changes' },
  ]);
  if (action === 'exit') return undefined;
  if (action === 'new') {
    if (options.config || options.project) throw new Error('New setup accepts only --workspace-root. Use Resume for --project or Advanced for --config.');
    const { createGuidedSetup } = await import('./guided-setup.js');
    return createGuidedSetup(p, options);
  }
  if (action === 'advanced') {
    action = await p.choose('What would you like to review?', [
      { value: 'generate', label: 'Review an existing MCP definition for a NEW bundle' },
      { value: 'resources', label: 'Review explicit new/reused Azure resource choices' },
      { value: 'exit', label: 'Exit without changes' },
    ]);
    if (action === 'exit') return undefined;
  }
  const workspace = options['workspace-root'] ?? await p.ask('Existing absolute workspace directory (not installed code)');
  const args = ['--workspace-root', workspace];
  if (action === 'resume') {
    const project = options.project ?? await p.ask('Project directory');
    return ['mcp-resume', ...args, '--project', project, '--json', '--summary'];
  }
  const config = options.config ?? await p.ask('Nonsecret MCP definition JSON file');
  return [action === 'resources' ? 'mcp-resources-choose' : 'mcp-server-plan', ...args, '--config', config,
    ...(action === 'resources' ? [] : ['--json', '--summary'])];
}
