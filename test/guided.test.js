import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { guidedArguments, createPrompter } from '../src/guided.js';

function captureOutput() {
  const output = new PassThrough();
  let text = '';
  output.setEncoding('utf8');
  output.on('data', chunk => { text += chunk; });
  return { output, read: () => { const value = text; text = ''; return value; } };
}

test('guided review welcomes the user once before its safety notice and menu', async () => {
  let output = '';
  const prompt = {
    output: { write: value => { output += value; } },
    choose: async (label, choices) => {
      assert.equal(output.split('Welcome to Copilot MCP Toolkit').length - 1, 1);
      assert.match(output, /REST APIs -> MCP tools -> Copilot/);
      assert.match(output, /Local setup and review only\. Never enter passwords, tokens or API keys/);
      assert.match(output, /Container Apps, App Service or Functions/);
      assert.match(output, /prepared recipe JSON file/);
      assert.match(output, /deployment, validation, HTML handover or FCC\/plugin onboarding/);
      assert.match(output, /separate reviewed workflows, not automatic setup steps/);
      assert.match(choices.find(choice => choice.value === 'help').label, /deploy, validate, HTML, FCC\/plugin/);
      const banner = output.slice(0, output.indexOf('Local setup and review only.'));
      assert.ok(banner.includes(' |  \\/  |/ ___|  _ \\'));
      assert.match(banner, /^[\x20-\x7e\n]+$/);
      assert.ok(banner.split('\n').every(line => line.length <= 60));
      return 'exit';
    },
    ask: () => assert.fail('Exit must not ask for a path'),
  };
  assert.equal(await guidedArguments(prompt), undefined);
  output = '';
  await assert.rejects(guidedArguments(prompt, { approve: 'never-forward' }), /never accepts execution approvals/);
  assert.equal(output, '');
});

test('CLI welcome never appears in noninteractive, help, version or JSON output', () => {
  const cli = fileURLToPath(new URL('../bin/copilot-mcp.js', import.meta.url));
  for (const [args, status] of [
    [[], 1], [['init'], 1], [['--json'], 1], [['init', '--json'], 1],
    [['--help'], 0], [['--help', '--json'], 0],
    [['--version'], 0], [['--version', '--json'], 0],
    [['capabilities', '--json'], 0],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, status, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /Welcome to Copilot MCP Toolkit|REST APIs -> MCP tools/);
    if (args[0] === '--help' && !args.includes('--json')) {
      assert.match(result.stdout, /Choose your next task/);
      for (const command of ['mcp-provision-plan/provision', 'mcp-execution-schema/plan',
        'mcp-validation-schema/plan/start/next', 'mcp-session-plan/session',
        'mcp-handover-schema/plan/bundle', 'mcp-onboard-schema', 'mcp-consumer-schema/plan/bundle']) {
        assert.ok(result.stdout.includes(command), command);
      }
      assert.match(result.stdout, /Linux tmpfs or reviewed Windows SSO/);
      assert.match(result.stdout, /anonymous public-data\/read-only profile/);
      assert.match(result.stdout, /App Service\/Functions deployment and ACA OAuth\/OBO pilot hosting remain manual/);
      assert.doesNotMatch(result.stdout, /Linux tmpfs only|inbound\nis explicit Entra;/);
    }
    if (args.includes('--json')) {
      const value = JSON.parse(result.stdout);
      assert.equal(typeof value, 'object');
      if (args[0] === 'capabilities') {
        assert.equal(value.guidedSetup.hostingInput, 'prepared-private-recipe-json-not-field-by-field-authoring');
        assert.ok(value.guidedSetup.sources.includes('container-apps-apim-v1'));
        assert.deepEqual(value.guidedSetup.reviewCommands,
          ['mcp-resume', 'mcp-recipe-source-plan', 'mcp-execution-status', 'mcp-validation-status']);
        assert.equal(value.guidedSetup.networkCalls, false);
        assert.equal(value.guidedSetup.cloudExecution, false);
      }
      assert.equal(result.stderr, '');
    }
    if (status === 1) assert.match(result.stdout + result.stderr, /Guided review requires a terminal/);
  }
});

test('guided review produces only local plan arguments and never forwards an approval', async () => {
  for (const [action, command] of [['generate', 'mcp-server-plan'], ['resources', 'mcp-resources-choose'], ['resume', 'mcp-resume']]) {
    const questions = [];
    let output = '';
    const prompt = {
      output: { write(value) { output += value; } },
      choose: async (label, choices) => {
        const value = label === 'How would you like to start?' ? action === 'resume' ? 'resume' : 'advanced'
          : action === 'resume' ? 'mcp-resume' : action;
        assert.ok(choices.some(choice => choice.value === value));
        return value;
      },
      ask: async question => { questions.push(question); return '/synthetic/path'; },
    };
    const args = await guidedArguments(prompt);
    assert.equal(args[0], command);
    assert.ok(!args.includes('--approve'));
    assert.ok(!args.includes('--allow-cloud'));
    assert.ok(!args.includes('--allow-network'));
    assert.equal(questions.length, 2);
    if (action === 'resume') {
      assert.match(output, /not a release archive/);
      assert.match(output, /does not continue a run, sign in or repeat a tool call/);
    }
  }
  const prompt = { output: { write() {} }, choose: async () => 'exit', ask: () => assert.fail('Exit must not ask for a path') };
  assert.equal(await guidedArguments(prompt), undefined);
  await assert.rejects(guidedArguments(prompt, { approve: 'never-forward' }), /never accepts execution approvals/);
});

test('guided review routes each saved project type without execution flags', async () => {
  for (const command of ['mcp-resume', 'mcp-recipe-source-plan', 'mcp-execution-status', 'mcp-validation-status']) {
    const choices = ['resume', command];
    const prompt = {
      output: { write() {} },
      choose: async (label, items) => {
        const value = choices.shift();
        assert.ok(items.some(item => item.value === value));
        return value;
      },
      ask: () => assert.fail('Explicit paths must be preserved'),
    };
    assert.deepEqual(await guidedArguments(prompt, { 'workspace-root': '/private', project: '/private/project' }),
      [command, '--workspace-root', '/private', '--project', '/private/project', '--json',
        ...(command === 'mcp-resume' ? ['--summary'] : [])]);
    assert.equal(choices.length, 0);
  }
});

test('advanced hosting, execution and infrastructure choices return plans only', async () => {
  for (const [action, command] of [
    ['hosting', 'mcp-hosting-plan'], ['execution', 'mcp-execution-plan'], ['bootstrap', 'mcp-bootstrap-plan'],
  ]) {
    const choices = ['advanced', action];
    const prompt = {
      output: { write() {} },
      choose: async (label, items) => {
        const value = choices.shift();
        assert.ok(items.some(item => item.value === value));
        return value;
      },
      ask: async label => {
        assert.match(label, /not (created|written) during this review/);
        return '/private/new-output';
      },
    };
    assert.deepEqual(await guidedArguments(prompt, { 'workspace-root': '/private', config: '/private/input.json' }),
      [command, '--workspace-root', '/private', '--config', '/private/input.json',
        '--output', '/private/new-output', '--json', '--summary']);
  }
});

test('command help and cancelled saved-work review need no paths or approvals', async () => {
  for (const [values, expected] of [[['help'], ['--help']], [['resume', 'exit'], undefined]]) {
    const prompt = { output: { write() {} }, choose: async (label, items) => {
      const value = values.shift();
      assert.ok(items.some(item => item.value === value));
      return value;
    }, ask: () => assert.fail('No path needed') };
    assert.deepEqual(await guidedArguments(prompt), expected);
    assert.equal(values.length, 0);
  }
});

test('review menus reject incompatible config and project inputs rather than ignore them', async () => {
  for (const [action, option] of [['resume', 'config'], ['advanced', 'project']]) {
    const prompt = { output: { write() {} }, choose: async () => action, ask: () => assert.fail('No path needed') };
    await assert.rejects(guidedArguments(prompt, { [option]: '/private/input' }), /accepts --.*not --/);
  }
});

test('each numbered menu starts at one and rejects a number from a previous menu', async () => {
  const input = new PassThrough(), { output, read } = captureOutput();
  const p = createPrompter(input, output);
  const first = p.choose('First menu', [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }]);
  input.write('2\n');
  assert.equal(await first, 'two');
  assert.match(read(), /1\. One\n2\. Two/);
  const second = p.choose('Second menu', [{ value: 'cancel', label: 'Cancel' }]);
  input.write('3\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(read(), /Second menu\n1\. Cancel\nChoice: The value is outside/);
  input.write('1\n');
  assert.equal(await second, 'cancel');
  p.close();
});

test('guided prompting rejects credentials and explains invalid field input without echoing it', async () => {
  const input = new PassThrough(), { output, read } = captureOutput();
  const p = createPrompter(input, output);
  const answer = p.ask('Identifier', { check: value => {
    if (value !== 'valid') throw new Error('PRIVATE_VALIDATION_DETAIL');
  }, hint: 'Enter a valid identifier.' });
  input.write('api_key=PRIVATE_VALUE\n');
  await new Promise(resolve => setImmediate(resolve));
  const rejected = read();
  assert.match(rejected, /Possible credential rejected/);
  assert.doesNotMatch(rejected, /PRIVATE_VALUE/);
  input.write('invalid\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(read(), 'Enter a valid identifier.\nIdentifier: ');
  input.write('valid\n');
  assert.equal(await answer, 'valid');
  p.close();
  assert.equal(p.signal.aborted, true);
});

test('guided prompting refuses control characters and closed prompts cancel rather than fabricate a choice', async () => {
  const input = new PassThrough(), { output, read } = captureOutput();
  const p = createPrompter(input, output);
  const answer = p.ask('Choice');
  input.write('\tunsafe\x1b[31m\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(read(), /Control characters are not accepted/);
  input.write('safe-value\n');
  assert.equal(await answer, 'safe-value');
  p.close();
  await assert.rejects(p.ask('No more'), { code: 'ABORTED' });
});

for (const mode of ['close', 'end']) test(`guided pending question settles on ${mode} without granting approval`, async () => {
  const input = new PassThrough(), output = new PassThrough();
  const p = createPrompter(input, output);
  const pending = assert.rejects(p.ask('Choice'), { code: 'ABORTED' });
  if (mode === 'close') p.close(); else input.end();
  await pending;
});
