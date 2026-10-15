import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { TOOLKIT_ROOT } from '../src/config.js';

test('fresh offline packed consumer runs its own CLI skill and evidence journey with all runtime networking and subprocesses denied', { timeout: 180000 }, async t => {
  await mkdir(path.join(TOOLKIT_ROOT, '.test-output'), { recursive: true });
  const root = await mkdtemp(path.join(TOOLKIT_ROOT, '.test-output', 'fresh-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npm = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const pack = JSON.parse(execFileSync(process.execPath,
    [npm, 'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', root],
    { cwd: TOOLKIT_ROOT, encoding: 'utf8', timeout: 60000 }))[0];
  const paths = pack.files.map(f => f.path);
  assert.ok(paths.includes('skills/copilot-mcp/SKILL.md'));
  assert.ok(paths.includes('src/core.d.ts'));
  assert.ok(paths.includes('LICENSE'));
  assert.ok(paths.includes('THIRD-PARTY-NOTICES.md'));
  assert.ok(!paths.some(p => /(?:^|\/)(?:node_modules|test|recovery|artifacts|generated|\.test-output|\.source-import|\.azure-auth)(?:\/|$)|^\.local-|bin\/cowork-|src\/(?:plugin|cowork-metadata|wizard|skill-frontmatter)\.js/.test(p)));
  const consumer = path.join(root, 'consumer'), workspace = path.join(root, 'workspace');
  await mkdir(consumer); await mkdir(workspace);
  await writeFile(path.join(consumer, 'package.json'), '{"name":"synthetic-packed-consumer","private":true,"type":"module"}\n');
  execFileSync(process.execPath, [npm, 'install', '--offline', '--ignore-scripts', '--no-audit', '--fund=false', '--omit=dev',
    path.join(root, pack.filename)], { cwd: consumer, encoding: 'utf8', timeout: 60000 });
  const installed = path.join(consumer, 'node_modules', 'copilot-mcp-toolkit');
  const require = createRequire(path.join(installed, 'package.json'));
  const pkg = JSON.parse(await readFile(path.join(installed, 'package.json')));
  for (const name of Object.keys(pkg.dependencies)) {
    assert.ok(require.resolve(name).startsWith(path.join(consumer, 'node_modules') + path.sep), name);
  }
  assert.equal(pkg.bin['copilot-mcp'], 'bin/copilot-mcp.js');
  const skill = await readFile(path.join(installed, 'skills', 'copilot-mcp', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\nname: copilot-mcp\r?\n/);
  assert.match(skill, /same engine|same `copilot-mcp`|same.*engine/is);
  const inventory = JSON.parse(await readFile(path.join(installed, 'library-assets.json')));
  for (const file of [...inventory.files, 'library-assets.json']) {
    assert.deepEqual(await readFile(path.join(installed, file)), await readFile(path.join(TOOLKIT_ROOT, file)), file);
  }
  await copyFile(path.join(TOOLKIT_ROOT, 'test', 'types.mts'), path.join(consumer, 'types.mts'));
  execFileSync(process.execPath, [path.join(TOOLKIT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--noEmit', '--strict', '--module', 'nodenext', '--target', 'es2022', 'types.mts'],
    { cwd: consumer, encoding: 'utf8', timeout: 30000 });
  const preload = path.join(root, 'deny.cjs');
  await writeFile(preload, `
const {syncBuiltinESMExports}=require('node:module');
const denied=()=>{throw Error('TEST_FORBIDDEN_NETWORK_OR_PROCESS')};
globalThis.fetch=denied;
for(const [module,names] of [
 ['node:net',['connect','createConnection']],['node:tls',['connect']],
 ['node:http',['request','get']],['node:https',['request','get']],
 ['node:dns',['lookup','resolve']],['node:child_process',['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']]
])for(const name of names)require(module)[name]=denied;
syncBuiltinESMExports();
`);
  const cli = path.join(installed, 'bin', 'copilot-mcp.js');
  const invoke = (args, codes = [0]) => {
    const p = spawnSync(process.execPath, ['--require', preload, cli, ...args, '--json'],
      { cwd: consumer, encoding: 'utf8', timeout: 30000 });
    assert.ok(codes.includes(p.status), `${args[0]}: ${p.stdout}\n${p.stderr}`);
    assert.doesNotMatch(p.stdout + p.stderr, /TEST_FORBIDDEN_NETWORK_OR_PROCESS/);
    return { result: JSON.parse(p.stdout), stderr: p.stderr };
  };
  const cap = invoke(['capabilities']).result;
  assert.equal(cap.toolkit.name, 'copilot-mcp-toolkit');
  assert.ok(cap.commands.includes('mcp-diagnose'));
  assert.ok(cap.commands.includes('mcp-fcc-plan'));
  assert.equal(cap.federatedConnectors.registration, false);
  assert.equal(cap.federatedConnectors.manualSetup, 'human-copy-paste-form-and-auth-registration-fields');
  assert.equal(cap.federatedConnectors.oauthDiscovery, false);
  assert.equal(invoke(['mcp-fcc-schema']).result.properties.schemaVersion.const, 1);
  const config = path.join(workspace, 'definition.json'), project = path.join(workspace, 'server');
  await copyFile(path.join(installed, 'examples', 'mcp', 'existing-anonymous.json'), config);
  const base = ['--workspace-root', workspace];
  const plan = invoke(['mcp-server-plan', ...base, '--config', config, '--summary']);
  assert.match(plan.stderr, new RegExp(plan.result.reviewDigest));
  assert.equal(plan.result.descriptor.status, 'referenced-not-verified');
  const apiScript = path.join(consumer, 'verify.mjs');
  await writeFile(apiScript, `
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as api from 'copilot-mcp-toolkit';
const input=JSON.parse(await readFile(process.argv[2]));
const review=await api.prepareMcpServer(input);
assert.equal(api.provisionProject,undefined);
assert.equal(api.prepareCoworkMcpConnector,undefined);
await assert.rejects(import('copilot-mcp-toolkit/src/azure.js'),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
process.stdout.write(JSON.stringify({reviewDigest:review.reviewDigest,info:await api.getLibraryInfo()}));
`);
  const publicResult = JSON.parse(execFileSync(process.execPath, ['--require', preload, apiScript, config],
    { cwd: consumer, encoding: 'utf8', timeout: 30000 }));
  assert.equal(publicResult.reviewDigest, plan.result.reviewDigest);
  assert.equal(publicResult.info.contentDigest, cap.toolkit.buildId);
  assert.equal(invoke(['mcp-server-create', ...base, '--config', config, '--output', project, '--approve', 'wrong'], [1]).result.success, false);
  assert.ok(!(await readdir(workspace)).includes('server'));
  invoke(['mcp-server-create', ...base, '--config', config, '--output', project, '--approve', plan.result.reviewDigest]);
  const fccWorkspace = path.join(workspace, 'fcc-demo');
  await mkdir(fccWorkspace);
  const fccBase = ['--workspace-root', fccWorkspace];
  const fccDefinition = path.join(fccWorkspace, 'definition.json');
  const fccConfig = path.join(fccWorkspace, 'onboarding.json');
  const fccProject = path.join(fccWorkspace, 'server');
  const fccOutput = path.join(fccWorkspace, 'prepared.json');
  await copyFile(path.join(installed, 'examples', 'fcc', 'existing-literature-entra.json'), fccDefinition);
  await copyFile(path.join(installed, 'examples', 'fcc', 'onboarding.json'), fccConfig);
  const fccServer = invoke(['mcp-server-plan', ...fccBase, '--config', fccDefinition]).result;
  invoke(['mcp-server-create', ...fccBase, '--config', fccDefinition, '--output', fccProject, '--approve', fccServer.reviewDigest]);
  const fccArgs = [...fccBase, '--config', fccConfig, '--output', fccOutput];
  const fccPlan = invoke(['mcp-fcc-plan', ...fccArgs, '--summary']);
  assert.ok(fccPlan.stderr.includes(fccPlan.result.approvalToken));
  assert.equal(fccPlan.result.bundle.readiness.status, 'blocked');
  assert.deepEqual(fccPlan.result.bundle.tools, []);
  assert.equal(fccPlan.result.bundle.manualSetup.submission, 'manual-only');
  assert.deepEqual(fccPlan.result.bundle.manualSetup.formFields.at(-1),
    { label: 'SSO registration ID', value: null, status: 'missing' });
  assert.deepEqual(fccPlan.result.bundle.readiness.gaps.map(gap => gap.code),
    ['CAPTURE_MISSING', 'SSO_REGISTRATION_MISSING', 'SSO_AUDIENCE_MISSING']);
  invoke(['mcp-fcc-bundle', ...fccArgs, '--approve', 'wrong'], [1]);
  assert.ok(!(await readdir(fccWorkspace)).includes('prepared.json'));
  const fccWritten = invoke(['mcp-fcc-bundle', ...fccArgs, '--approve', fccPlan.result.approvalToken]).result;
  assert.equal(fccWritten.executionReadiness, false);
  assert.deepEqual(JSON.parse(await readFile(fccOutput)), fccPlan.result.bundle);
  invoke(['mcp-fcc-bundle', ...fccArgs, '--approve', fccPlan.result.approvalToken], [1]);
  const restDefinition = path.join(fccWorkspace, 'rest.json');
  await copyFile(path.join(installed, 'examples', 'fcc', 'literature-rest.json'), restDefinition);
  const restPlan = invoke(['mcp-server-plan', ...fccBase, '--config', restDefinition]).result;
  assert.equal(restPlan.descriptor.kind, 'native-apim-mcp');
  assert.deepEqual(restPlan.descriptor.operationIds, ['search', 'fetch']);
  const restProject = path.join(fccWorkspace, 'rest-server');
  invoke(['mcp-server-create', ...fccBase, '--config', restDefinition, '--output', restProject, '--approve', restPlan.reviewDigest]);
  const restFccInput = JSON.parse(await readFile(fccConfig));
  restFccInput.source.descriptorFile = 'rest-server/mcp-server.json';
  await writeFile(fccConfig, JSON.stringify(restFccInput));
  const restFccPlan = invoke(['mcp-fcc-plan', ...fccBase, '--config', fccConfig,
    '--output', path.join(fccWorkspace, 'rest-prepared.json')]).result;
  assert.equal(restFccPlan.bundle.endpoint.sourceKind, 'native-apim-mcp');
  assert.equal(restFccPlan.bundle.endpoint.sourceStatus, 'generated-not-deployed');
  const selection = path.join(workspace, 'selection.json');
  await writeFile(selection, '{}');
  const resume = invoke(['mcp-resume', ...base, '--project', project, '--config', selection, '--summary'], [0, 2]).result;
  assert.equal(resume.next.command, 'mcp-discover');
  assert.ok(resume.next.approval);
  invoke(['mcp-resume', ...base, '--project', project, '--config', selection, '--approve', 'wrong'], [1]);
  invoke(['mcp-diagnose', ...base, '--project', project], [0, 2]);
  const archive = path.join(workspace, 'checkpoint.zip');
  const exportPlan = invoke(['mcp-export-plan', ...base, '--project', project, '--output', archive]).result;
  const exported = invoke(['mcp-export', ...base, '--project', project, '--output', archive, '--approve', exportPlan.approvalToken]).result;
  assert.equal(exported.executionReadiness, false);
  assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), exported.archiveSha256);
  invoke(['mcp-archive-inspect', ...base, '--archive', archive, '--sha256', '0'.repeat(64)], [1]);
  invoke(['mcp-archive-inspect', ...base, '--archive', archive, '--sha256', exported.archiveSha256]);
  const restored = path.join(workspace, 'restored');
  const restoreArgs = [...base, '--archive', archive, '--sha256', exported.archiveSha256, '--output', restored];
  const restorePlan = invoke(['mcp-restore-plan', ...restoreArgs]).result;
  invoke(['mcp-restore', ...restoreArgs, '--approve', restorePlan.approvalToken]);
  assert.equal(await readFile(path.join(restored, 'mcp-definition.json'), 'utf8'), await readFile(path.join(project, 'mcp-definition.json'), 'utf8'));
  invoke(['mcp-resume', ...base, '--project', restored], [0, 2]);
  assert.ok(!(await readdir(restored)).includes('.azure-auth'));
  invoke(['cowork-create'], [1]);
  invoke(['init'], [1]);
  await writeFile(path.join(installed, 'library-assets.json'), '{"schemaVersion":1,"files":["../escape"]}');
  assert.equal(invoke(['capabilities'], [1]).result.success, false);
  await writeFile(path.join(installed, 'library-assets.json'), ' '.repeat(65537));
  assert.equal(invoke(['capabilities'], [1]).result.success, false);
});
