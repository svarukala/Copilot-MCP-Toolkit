import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { TOOLKIT_ROOT } from '../src/config.js';
import { prepareMcpServer, createMcpServerProject } from '../src/mcp-server.js';
import { terminalHandoff } from '../src/mcp-terminal-handoff.js';
test('terminal handoff keeps explicit workspace and quotes Windows paths without launching or copying auth', async t => {
  await mkdir(path.join(TOOLKIT_ROOT, '.test-output'), { recursive: true });
  const workspaceRoot = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', "terminal owner's "));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const project = path.join(workspaceRoot, 'reference'), config = path.join(workspaceRoot, 'selection.json');
  const review = await prepareMcpServer({ schemaVersion: 1, kind: 'existing-mcp',
    server: { id: '11111111-1111-4111-8111-111111111111', name: 'Synthetic endpoint' },
    endpoint: 'https://example.com/mcp', inbound: { type: 'anonymous' } });
  await createMcpServerProject(review, { workspaceRoot, projectDir: project });
  await writeFile(config, '{}');
  const result = await terminalHandoff({ workspaceRoot, project, config, phase: 'discovery' });
  assert.equal(result.executionAuthorized, false);
  assert.match(result.powershell, /owner''s/);
  assert.ok(result.powershell.includes("'--workspace-root'"));
  assert.ok(result.powershell.includes(result.plan.approvalDigest));
  assert.equal(result.tokenContinuity, 'fresh-process-no-persistent-cache');
  await assert.rejects(terminalHandoff({ workspaceRoot, project, config, phase: 'register' }), { code: 'MCP_TERMINAL_INPUT' });
});
