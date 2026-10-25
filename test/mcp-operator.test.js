import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { TOOLKIT_ROOT } from '../src/config.js';
import { savedJson } from '../src/anonymous-metadata.js';
import { planOperatorRecord, writeOperatorRecord, operatorStatus } from '../src/mcp-operator.js';

const hash = `sha256:${'a'.repeat(64)}`;
const tenant = '11111111-1111-4111-8111-111111111111';
const subscription = '22222222-2222-4222-8222-222222222222';
const reservation = () => ({ schemaVersion: 1, action: 'reserve', operation: {
  kind: 'deployment', tenantId: tenant, subscriptionId: subscription, accountName: 'owner@example.com',
  target: `/subscriptions/${subscription}/resourceGroups/synthetic/providers/Microsoft.App/containerApps/demo`,
  purpose: 'First reviewed deployment', inputsDigest: hash,
  authorization: { basis: 'explicit-operation-review', reviewDigest: hash },
} });
async function fixture(t) {
  await mkdir(path.join(TOOLKIT_ROOT, '.test-output'), { recursive: true });
  const root = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'operator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'); await mkdir(project);
  const options = { workspaceRoot: root, project, config: path.join(root, 'input.json') };
  const plan = async event => {
    await writeFile(options.config, savedJson(event));
    return planOperatorRecord(options);
  };
  const record = async event => {
    const review = await plan(event);
    const result = await writeOperatorRecord({ ...options, approval: review.approvalToken });
    return { ...result, operationKey: review.operationKey };
  };
  return { root: project, options, plan, record };
}
test('operator journal reserves, marks uncertainty before send and reconciles without re-dispatch', async t => {
  const f = await fixture(t);
  const { operationKey } = await f.record(reservation());
  assert.equal((await operatorStatus(f.options)).operations[operationKey].status, 'reserved');
  await f.record({ schemaVersion: 1, action: 'dispatch', operationKey });
  assert.equal((await operatorStatus(f.options)).operations[operationKey].status, 'unknown');
  await assert.rejects(f.plan({ schemaVersion: 1, action: 'dispatch', operationKey }), { code: 'MCP_OPERATOR_CONSUMED' });
  for (const status of ['unknown', 'submitted', 'provisioned', 'unknown', 'revision-ready', 'traffic-ready', 'endpoint-checked']) {
    await f.record({ schemaVersion: 1, action: 'observe', operationKey, result: { status, evidenceDigest: hash } });
  }
  const status = await operatorStatus(f.options);
  assert.equal(status.operations[operationKey].lastKnownStage, 'endpoint-checked');
  assert.equal(status.proofReplayAuthorized, false);
  assert.equal(status.providerCalls, 'not-derived-use-existing-proof-journals');
  const changed = reservation(); changed.operation.inputsDigest = `sha256:${'b'.repeat(64)}`;
  await assert.rejects(f.plan(changed), { code: 'MCP_OPERATOR_CONSUMED' });
});
test('failed external work stays consumed and observations never imply a retry', async t => {
  const f = await fixture(t);
  const { operationKey } = await f.record(reservation());
  await assert.rejects(f.plan({ schemaVersion: 1, action: 'observe', operationKey,
    result: { status: 'succeeded', evidenceDigest: hash } }), { code: 'MCP_OPERATOR_TRANSITION' });
  await f.record({ schemaVersion: 1, action: 'dispatch', operationKey });
  await f.record({ schemaVersion: 1, action: 'observe', operationKey, result: { status: 'failed', evidenceDigest: hash } });
  await assert.rejects(f.plan(reservation()), { code: 'MCP_OPERATOR_CONSUMED' });
});
test('waiting handoff suppresses duplicate events and owner reports cannot become verified consumer milestones', async t => {
  const f = await fixture(t);
  const wait = { schemaVersion: 1, action: 'wait', phase: 'FCC authorization',
    reason: 'owner-unavailable', resumeWhen: 'Owner supplies portal result' };
  const receipt = await f.record(wait);
  await assert.rejects(f.plan(wait), { code: 'MCP_OPERATOR_WAITING' });
  await assert.rejects(f.plan(reservation()), { code: 'MCP_OPERATOR_WAITING' });
  await f.record({ schemaVersion: 1, action: 'owner-result', milestone: 'authorization', outcome: 'passed', evidenceDigest: hash });
  let status = await operatorStatus(f.options);
  assert.equal(status.milestones.authorization.provenance, 'owner-reported-not-independently-verified');
  assert.equal(status.milestones['consumer-call'].status, 'not-confirmed');
  assert.equal(status.waiting.repeatPrompt, false);
  await assert.rejects(f.plan({ schemaVersion: 1, action: 'resume', waitDigest: hash, ownerInputDigest: hash }),
    { code: 'MCP_OPERATOR_TRANSITION' });
  await f.record({ schemaVersion: 1, action: 'resume', waitDigest: receipt.contentDigest, ownerInputDigest: hash });
  status = await operatorStatus(f.options);
  assert.equal(status.waiting, null);
});
test('journal binding rejects stale plans, concurrent append, malformed input and tampered history', async t => {
  const f = await fixture(t);
  const plan = await f.plan(reservation());
  const results = await Promise.allSettled([1, 2].map(() => writeOperatorRecord({ ...f.options, approval: plan.approvalToken })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(writeOperatorRecord({ ...f.options, approval: plan.approvalToken }));
  assert.equal((await readdir(path.join(f.root, '.mcp-operator'))).length, 1);
  const file = path.join(f.root, '.mcp-operator', '0001.json');
  const body = JSON.parse(await readFile(file));
  body.event.operation.purpose = 'Changed';
  await writeFile(file, savedJson(body));
  await assert.rejects(operatorStatus(f.options), { code: 'MCP_OPERATOR_JOURNAL' });
});
test('operator CLI schema is JSON and rejects execution flags', () => {
  const cli = path.join(TOOLKIT_ROOT, 'bin', 'copilot-mcp.js');
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  const schema = run(['mcp-operator-schema', '--json']);
  assert.equal(schema.status, 0, schema.stderr);
  assert.equal(JSON.parse(schema.stdout).oneOf.length, 6);
  assert.notEqual(run(['mcp-operator-schema', '--allow-cloud', '--json']).status, 0);
});
