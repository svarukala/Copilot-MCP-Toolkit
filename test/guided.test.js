import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { guidedArguments, createPrompter } from '../src/guided.js';

test('guided review welcomes the user once before its safety notice and menu', async () => {
  let output = '';
  const prompt = {
    output: { write: value => { output += value; } },
    choose: async () => {
      assert.equal(output.split('Welcome to Copilot MCP Toolkit').length - 1, 1);
      assert.match(output, /REST APIs -> MCP tools -> Copilot/);
      assert.match(output, /Local guided setup only\. Never enter credentials/);
      assert.match(output, /This wizard covers native APIM and existing-MCP references/);
      assert.match(output, /mcp-hosting-plan\/create/);
      const banner = output.slice(0, output.indexOf('Local guided setup only.'));
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
    if (args.includes('--json')) {
      assert.equal(typeof JSON.parse(result.stdout), 'object');
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
        const value = label === 'How would you like to start?' && action !== 'resume' ? 'advanced' : action;
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
      assert.match(output, /not a sealed hosting source\/release folder/);
      assert.match(output, /mcp-recipe-source-plan/);
    }
  }
  const prompt = { output: { write() {} }, choose: async () => 'exit', ask: () => assert.fail('Exit must not ask for a path') };
  assert.equal(await guidedArguments(prompt), undefined);
  await assert.rejects(guidedArguments(prompt, { approve: 'never-forward' }), /never accepts execution approvals/);
});

test('guided prompting rejects credentials and explains invalid field input without echoing it', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const p = createPrompter(input, output);
  const answer = p.ask('Identifier', { check: value => {
    if (value !== 'valid') throw new Error('PRIVATE_VALIDATION_DETAIL');
  }, hint: 'Enter a valid identifier.' });
  input.write('api_key=PRIVATE_VALUE\n');
  await new Promise(resolve => setImmediate(resolve));
  const rejected = output.read().toString();
  assert.match(rejected, /Possible credential rejected/);
  assert.doesNotMatch(rejected, /PRIVATE_VALUE/);
  input.write('invalid\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(output.read().toString(), 'Enter a valid identifier.\nIdentifier: ');
  input.write('valid\n');
  assert.equal(await answer, 'valid');
  p.close();
  assert.equal(p.signal.aborted, true);
});

test('guided prompting refuses control characters and closed prompts cancel rather than fabricate a choice', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const p = createPrompter(input, output);
  const answer = p.ask('Choice');
  input.write('\tunsafe\x1b[31m\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(output.read().toString(), /Control characters are not accepted/);
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
