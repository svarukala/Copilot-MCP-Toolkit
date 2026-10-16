import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

for (const approve of [false, true]) test(`terminal New setup ${approve ? 'creates and resumes' : 'cancels'} through the CLI entry point`, { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'copilot-mcp-terminal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const preload = path.join(root, 'terminal.cjs'), project = path.join(root, 'new project');
  await writeFile(preload, `
Object.defineProperty(process.stdin, 'isTTY', { value: true });
Object.defineProperty(process.stderr, 'isTTY', { value: true });
const denied = () => { throw Error('TEST_FORBIDDEN_NETWORK_OR_PROCESS'); };
globalThis.fetch = denied;
for (const [name, methods] of [
  ['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']],
  ['node:http', ['request', 'get']], ['node:https', ['request', 'get']],
  ['node:child_process', ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']]
]) for (const method of methods) require(name)[method] = denied;
require('node:module').syncBuiltinESMExports();
`);
  const steps = [
    ['Choice: ', '1'], ['Choice: ', '2'], ['Choice: ', '1'],
    ['MCP setup name: ', 'Synthetic terminal demo'],
    ['Existing MCP HTTPS message endpoint: ', 'https://mcp.example.com/mcp'],
    ['NEW project directory inside the workspace (absolute path): ', project],
    ['Choice: ', approve ? '2' : '1'],
  ];
  const child = spawn(process.execPath, ['--require', preload,
    fileURLToPath(new URL('../bin/copilot-mcp.js', import.meta.url)), 'init', '--workspace-root', root],
  { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '', stderr = '', pending = '', answered = 0;
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => {
    stderr += data;
    pending += data;
    if (answered < steps.length && stripVTControlCharacters(pending).endsWith(steps[answered][0])) {
      child.stdin.write(`${steps[answered][1]}\n`);
      pending = '';
      answered++;
    }
  });
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(answered, steps.length, stderr);
  assert.equal(status, 2, stderr);
  assert.doesNotMatch(stderr + stdout, /TEST_FORBIDDEN_NETWORK_OR_PROCESS/);
  assert.equal(stderr.split('Welcome to Copilot MCP Toolkit').length - 1, 1);
  assert.match(stderr, /Start a new MCP setup/);
  assert.match(stderr, /Resume an existing setup/);
  if (approve) {
    assert.equal(JSON.parse(stdout).action, 'standalone-mcp-resume');
    assert.equal(JSON.parse(stdout).replayAuthorized, false);
    assert.equal(JSON.parse(await readFile(path.join(project, 'mcp-definition.json'))).endpoint, 'https://mcp.example.com/mcp');
    assert.match(stderr, /Local bundle created/);
  } else {
    assert.equal(stdout, '');
    assert.deepEqual(await readdir(root), ['terminal.cjs']);
    assert.doesNotMatch(stderr, /Local bundle created/);
  }
});
