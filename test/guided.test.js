import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { guidedArguments, createPrompter } from '../src/guided.js';

test('guided review produces only local plan arguments and never forwards an approval', async () => {
  for (const [action, command] of [['generate', 'mcp-server-plan'], ['resources', 'mcp-resources-choose'], ['resume', 'mcp-resume']]) {
    const questions = [];
    const prompt = {
      output: { write() {} },
      choose: async () => action,
      ask: async question => { questions.push(question); return '/synthetic/path'; },
    };
    const args = await guidedArguments(prompt);
    assert.equal(args[0], command);
    assert.ok(!args.includes('--approve'));
    assert.ok(!args.includes('--allow-cloud'));
    assert.ok(!args.includes('--allow-network'));
    assert.equal(questions.length, 2);
  }
  const prompt = { output: { write() {} }, choose: async () => 'exit', ask: () => assert.fail('Exit must not ask for a path') };
  assert.equal(await guidedArguments(prompt), undefined);
  await assert.rejects(guidedArguments(prompt, { approve: 'never-forward' }), /never accepts execution approvals/);
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
