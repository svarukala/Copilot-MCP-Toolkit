import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { TOOLKIT_ROOT } from '../src/config.js';

test('fresh offline packed consumer runs its own CLI skill and evidence journey with all runtime networking and subprocesses denied', { timeout: 300000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'copilot-mcp-fresh-package-'));
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
    const entry = name === '@modelcontextprotocol/sdk' ? `${name}/server/index.js` : name;
    assert.ok(require.resolve(entry).startsWith(path.join(consumer, 'node_modules') + path.sep), name);
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
  assert.equal(cap.guidedSetup.cloudExecution, false);
  assert.equal(cap.guidedSetup.existingMcpOAuth, 'reference-only');
  assert.equal(cap.containerAppsRecipe.cloudExecution, false);
  assert.equal(cap.containerAppsRecipe.gateway, 'none');
  assert.deepEqual(cap.hostingRecipes.backendAuthentication, ['anonymous', 'api-key-key-vault-header', 'api-key-key-vault-query']);
  assert.equal(invoke(['mcp-container-apps-schema']).result.properties.recipe.const, 'container-apps-direct-v1');
  const containerInput = path.join(workspace, 'container-input.json');
  const containerOutput = path.join(workspace, 'container-server');
  await copyFile(path.join(installed, 'examples', 'mcp', 'container-apps-direct.json'), containerInput);
  const containerArgs = ['--workspace-root', workspace, '--config', containerInput, '--output', containerOutput];
  const containerPlan = invoke(['mcp-container-apps-plan', ...containerArgs, '--summary']);
  assert.ok(containerPlan.stderr.includes(containerPlan.result.approvalToken));
  assert.equal(containerPlan.result.review.toolDefinitions[0].annotations.readOnlyHint, true);
  invoke(['mcp-container-apps-create', ...containerArgs, '--approve', 'wrong'], [1]);
  const containerWritten = invoke(['mcp-container-apps-create', ...containerArgs, '--approve', containerPlan.result.approvalToken]).result;
  assert.equal(containerWritten.status, 'generated-not-deployed');
  assert.ok(!containerWritten.files.includes('mcp-server.json'));
  for (const [name, content] of Object.entries(containerPlan.result.files)) {
    assert.equal(await readFile(path.join(containerOutput, name), 'utf8'), content);
  }
  execFileSync(process.execPath, [npm, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--fund=false', '--omit=dev'],
    { cwd: containerOutput, encoding: 'utf8', timeout: 60000 });
  const runtimeSmoke = path.join(consumer, 'container-runtime-smoke.mjs');
  await writeFile(runtimeSmoke, `
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateRuntimeConfig, toolDefinitions, createProtocolServer } from ${JSON.stringify(pathToFileURL(path.join(containerOutput, 'runtime.js')).href)};
const config = validateRuntimeConfig(JSON.parse(await readFile(${JSON.stringify(path.join(containerOutput, 'runtime-config.json'))})));
assert.equal(toolDefinitions(config)[0].annotations.readOnlyHint, true);
const server = createProtocolServer(config);
await server.close();
`);
  const smoke = spawnSync(process.execPath, ['--require', preload, runtimeSmoke],
    { cwd: consumer, encoding: 'utf8', timeout: 30000 });
  assert.equal(smoke.status, 0, smoke.stderr);
  assert.doesNotMatch(smoke.stdout + smoke.stderr, /TEST_FORBIDDEN_NETWORK_OR_PROCESS/);
  assert.equal(invoke(['mcp-hosting-schema']).result.oneOf.length, 4);
  for (const name of ['container-apps-apim', 'app-service-container', 'functions-sdk']) {
    const config = path.join(workspace, `${name}.json`), output = path.join(workspace, name);
    await copyFile(path.join(installed, 'examples', 'mcp', `${name}.json`), config);
    const args = ['--workspace-root', workspace, '--config', config, '--output', output];
    const plan = invoke(['mcp-hosting-plan', ...args, '--summary']);
    assert.ok(plan.stderr.includes(plan.result.approvalToken));
    if (name === 'container-apps-apim') {
      assert.match(plan.stderr, /independent signed gateway token/);
      assert.doesNotMatch(plan.stderr, /no APIM/);
    }
    if (name === 'functions-sdk') assert.match(plan.stderr, /PUBLIC PREVIEW/);
    invoke(['mcp-hosting-create', ...args, '--approve', plan.result.approvalToken]);
    assert.equal(await readFile(path.join(output, 'runtime.js'), 'utf8'), await readFile(path.join(containerOutput, 'runtime.js'), 'utf8'));
    const source = invoke(['mcp-recipe-source-plan', '--workspace-root', workspace, '--project', output]).result;
    assert.equal(source.deployed, false);
    if (name === 'functions-sdk') {
      const releaseConfig = path.join(workspace, 'functions-release.json');
      await writeFile(releaseConfig, JSON.stringify({ schemaVersion: 1, accountName: 'operator@example.com',
        sourceArchiveSha256: source.sourceArchiveSha256 }));
      const releaseArgs = ['--workspace-root', workspace, '--project', output, '--config', releaseConfig,
        '--output', path.join(workspace, 'functions-release')];
      const release = invoke(['mcp-recipe-release-plan', ...releaseArgs, '--summary']).result;
      const written = invoke(['mcp-recipe-release-bundle', ...releaseArgs, '--approve', release.approvalToken]).result;
      assert.equal(written.status, 'release-prepared-not-deployed');
    }
  }
  const securedProjects = [];
  for (const name of ['container-apps-direct', 'container-apps-apim', 'app-service-container', 'functions-sdk']) {
    const config = path.join(workspace, `${name}-api-key.json`), output = path.join(workspace, `${name}-api-key`);
    await copyFile(path.join(installed, 'examples', 'mcp', `${name}-api-key.json`), config);
    const args = ['--workspace-root', workspace, '--config', config, '--output', output];
    const plan = invoke(['mcp-hosting-plan', ...args, '--summary']);
    assert.match(plan.stderr, /Backend: API key in (header|query)/);
    assert.ok(plan.stderr.includes(plan.result.review.backend.apiKey.identityResourceId));
    invoke(['mcp-hosting-create', ...args, '--approve', 'wrong'], [1]);
    invoke(['mcp-hosting-create', ...args, '--approve', plan.result.approvalToken]);
    invoke(['mcp-hosting-create', ...args, '--approve', plan.result.approvalToken], [1]);
    assert.equal(await readFile(path.join(output, 'runtime.js'), 'utf8'), await readFile(path.join(containerOutput, 'runtime.js'), 'utf8'));
    securedProjects.push(output);
  }
  execFileSync(process.execPath, [npm, 'ci', '--offline', '--ignore-scripts', '--no-audit', '--fund=false', '--omit=dev'],
    { cwd: securedProjects[0], encoding: 'utf8', timeout: 60000 });
  const keySmoke = path.join(consumer, 'generated-key-runtime.mjs');
  await writeFile(keySmoke, `
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import path from 'node:path';
import { createProtocolServer, createRequestHandler } from ${JSON.stringify(pathToFileURL(path.join(securedProjects[0], 'runtime.js')).href)};
// All four emitted runtimes above are byte-identical; use their independent cached dependency installation.
for (const project of ${JSON.stringify(securedProjects)}) {
  const config = JSON.parse(await readFile(path.join(project, 'runtime-config.json')));
  assert.throws(() => createRequestHandler(config, 'http://localhost:3000/mcp', { env: {} }), /configuration is unavailable/);
  const key = 'synthetic-packed-only+credential/42';
  const calls = [], logs = [];
  let reflect = false;
  const server = createProtocolServer(config, { env: { MCP_BACKEND_API_KEY: key }, log: e => logs.push(e),
    request: async (url, options) => { calls.push({ url, options }); return Response.json(reflect ? { value: key } : { value: 42 }); } });
  const client = new Client({ name: 'packed-offline', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st); await client.connect(ct);
    assert.equal((await client.listTools()).tools[0].annotations.readOnlyHint, true);
    assert.equal(calls.length, 0);
    const result = await client.callTool({ name: 'get_information', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1);
    const auth = config.backendAuthentication;
    if (auth.headerName) assert.deepEqual(calls[0].options.headers, { accept: 'application/json', [auth.headerName]: key });
    else {
      assert.equal(new URL(calls[0].url).searchParams.get(auth.queryParameterName), key);
      assert.deepEqual(calls[0].options.headers, { accept: 'application/json' });
    }
    assert.equal(calls[0].options.redirect, 'error');
    reflect = true;
    const rejected = await client.callTool({ name: 'get_information', arguments: {} });
    assert.equal(rejected.isError, true);
    assert.equal(calls.length, 2);
    assert.ok(!JSON.stringify({ rejected, logs }).includes(key));
  } finally { await client.close(); await server.close(); }
}
`);
  const keyResult = spawnSync(process.execPath, ['--require', preload, keySmoke],
    { cwd: consumer, encoding: 'utf8', timeout: 30000 });
  assert.equal(keyResult.status, 0, keyResult.stderr);
  assert.doesNotMatch(keyResult.stdout + keyResult.stderr, /TEST_FORBIDDEN_NETWORK_OR_PROCESS/);
  for (const unresolved of ['', '@Microsoft.KeyVault(SecretUri=https://synthetic-vault.vault.azure.net/secrets/backend-access)']) {
    const failedStartup = spawnSync(process.execPath, ['--require', preload, path.join(securedProjects[0], 'server.js')],
      { cwd: consumer, encoding: 'utf8', timeout: 30000, env: { ...process.env, PORT: '3000',
        PUBLIC_MCP_URL: 'http://localhost:3000/mcp', MCP_BACKEND_API_KEY: unresolved } });
    assert.equal(failedStartup.status, 1);
    assert.match(failedStartup.stderr, /startup-failed/);
    assert.doesNotMatch(failedStartup.stdout + failedStartup.stderr, /vault\.azure\.net|TEST_FORBIDDEN_NETWORK_OR_PROCESS/);
  }
  const referenceConfig = path.join(workspace, 'recipe-reference.json');
  await writeFile(referenceConfig, JSON.stringify({ schemaVersion: 1,
    serverId: '66666666-6666-4666-8666-666666666666', endpoint: 'https://synthetic-mcp.example.com/mcp' }));
  const referenceArgs = ['--workspace-root', workspace, '--project', containerOutput, '--config', referenceConfig,
    '--output', path.join(workspace, 'recipe-reference')];
  const reference = invoke(['mcp-recipe-reference-plan', ...referenceArgs, '--summary']).result;
  assert.equal(invoke(['mcp-recipe-reference-create', ...referenceArgs, '--approve', reference.approvalToken]).result.endpointStatus,
    'referenced-not-verified');
  const guidedProject = path.join(workspace, 'guided-reference');
  const rehearsal = path.join(consumer, 'guided-rehearsal.mjs');
  await writeFile(rehearsal, `
import { guidedArguments } from ${JSON.stringify(pathToFileURL(path.join(installed, 'src', 'guided.js')).href)};
import { main } from ${JSON.stringify(pathToFileURL(cli).href)};
const choices = ['new', 'mcp', 'anonymous', 'create'];
const answers = ['Synthetic packed setup', 'https://mcp.example.com/mcp', ${JSON.stringify(guidedProject)}];
const prompt = {
  output: process.stderr,
  async choose(label, items) {
    const value = choices.shift();
    if (!items.some(item => item.value === value)) throw Error('Unexpected wizard choice');
    return value;
  },
  async ask(label, options) {
    const answer = answers.shift();
    if (options?.check) await options.check(answer);
    return answer;
  },
};
const args = await guidedArguments(prompt, { 'workspace-root': ${JSON.stringify(workspace)} });
if (choices.length || answers.length || args[0] !== 'mcp-resume') throw Error('Wizard did not finish');
if (await main(args) !== 2) throw Error('Expected a blocked local Resume report, not execution');
`);
  const guided = spawnSync(process.execPath, ['--require', preload, rehearsal],
    { cwd: consumer, encoding: 'utf8', timeout: 30000 });
  assert.equal(guided.status, 0, guided.stderr);
  assert.doesNotMatch(guided.stdout + guided.stderr, /TEST_FORBIDDEN_NETWORK_OR_PROCESS/);
  assert.equal(JSON.parse(guided.stdout).action, 'standalone-mcp-resume');
  assert.equal(JSON.parse(await readFile(path.join(guidedProject, 'mcp-server.json'))).status, 'referenced-not-verified');
  assert.ok(cap.commands.includes('mcp-diagnose'));
  assert.ok(cap.commands.includes('mcp-fcc-plan'));
  assert.equal(cap.federatedConnectors.registration, false);
  assert.equal(cap.federatedConnectors.manualSetup, 'human-copy-paste-form-and-auth-registration-fields');
  assert.equal(cap.federatedConnectors.oauthDiscovery, false);
  assert.equal(cap.federatedConnectors.incompleteDeveloperMetadata, 'blocked-local-draft');
  assert.equal(cap.federatedConnectors.legalPolicies, 'optional-caller-declaration-placeholder-blocks-no-fetch');
  assert.equal(invoke(['mcp-fcc-schema']).result.properties.schemaVersion.const, 1);
  assert.ok(cap.commands.includes('mcp-auth-registration-plan'));
  assert.equal(cap.authRegistration.registration, false);
  assert.equal(cap.authRegistration.subprocesses, false);
  assert.equal(cap.authWiqdHandoff.windowsWorkflow, true);
  assert.equal(cap.authWiqdHandoff.registration, false);
  assert.equal(invoke(['mcp-auth-wiqd-schema']).result.properties.schemaVersion.const, 1);
  invoke(['mcp-auth-wiqd-schema', '--allow-network'], [1]);
  assert.equal(invoke(['mcp-auth-registration-schema']).result.properties.schemaVersion.const, 1);
  assert.ok(cap.commands.includes('mcp-auth-execution-plan'));
  assert.equal(cap.authRegistrationExecution.liveQualified, false);
  assert.equal(cap.authRegistrationExecution.automaticRetry, false);
  assert.deepEqual(cap.authRegistrationExecution.phases, ['initialize', 'login', 'register', 'close']);
  assert.equal(invoke(['mcp-auth-execution-schema']).result.properties.schemaVersion.const, 1);
  assert.equal(invoke(['mcp-auth-execution-schema']).result.properties.allowAnyAppValidationPlaceholder.type, 'boolean');
  assert.equal(cap.authRegistrationExecution.anyAppCompatibility.targetAudience, 'HomeTenant');
  assert.equal(cap.authRegistrationExecution.anyAppCompatibility.createsApp, false);
  invoke(['mcp-auth-execution-schema', '--allow-provider'], [1]);
  invoke(['mcp-auth-execution-plan', '--phase', 'initialize', '--allow-network'], [1]);
  invoke(['mcp-auth-execute', '--phase', 'register', '--allow-provider'], [1]);
  const authSession = path.join(workspace, 'auth-session');
  assert.equal(invoke(['mcp-auth-execution-status', '--workspace-root', workspace, '--project', authSession]).result.status, 'not-initialized');
  invoke(['mcp-auth-execution-status', '--workspace-root', workspace, '--project', authSession, '--confirm-identity'], [1]);
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
  const incompleteFccConfig = path.join(fccWorkspace, 'incomplete-onboarding.json');
  const incompleteFccInput = JSON.parse(await readFile(fccConfig));
  delete incompleteFccInput.connector.developer;
  incompleteFccInput.review.legalPolicies = 'placeholder';
  await writeFile(incompleteFccConfig, JSON.stringify(incompleteFccInput));
  const incompleteFccArgs = [...fccBase, '--config', incompleteFccConfig,
    '--output', path.join(fccWorkspace, 'incomplete-prepared.json')];
  const incompleteFccPlan = invoke(['mcp-fcc-plan', ...incompleteFccArgs, '--summary']);
  assert.equal(incompleteFccPlan.result.bundle.readiness.status, 'blocked');
  assert.equal(incompleteFccPlan.result.bundle.readiness.gaps.filter(gap => gap.code === 'DEVELOPER_METADATA_MISSING').length, 4);
  assert.ok(incompleteFccPlan.result.bundle.readiness.gaps.some(gap => gap.code === 'LEGAL_POLICIES_PLACEHOLDER'));
  assert.match(incompleteFccPlan.stderr, /Legal policies: placeholder/);
  assert.match(incompleteFccPlan.stderr, /zero gaps is NOT execution readiness/);
  const incompleteWritten = invoke(['mcp-fcc-bundle', ...incompleteFccArgs, '--approve', incompleteFccPlan.result.approvalToken]).result;
  assert.deepEqual(JSON.parse(await readFile(incompleteWritten.outputPath)), incompleteFccPlan.result.bundle);
  const authConfig = path.join(fccWorkspace, 'registration.json'), authOutput = path.join(fccWorkspace, 'auth.json');
  await copyFile(path.join(installed, 'examples', 'auth-registration', 'sso.json'), authConfig);
  const authInput = JSON.parse(await readFile(authConfig));
  authInput.registration.applicableToApps = 'AnyApp';
  await writeFile(authConfig, JSON.stringify(authInput));
  const providerRoot = path.join(fccWorkspace, 'synthetic-atk');
  await mkdir(path.join(providerRoot, 'lib'), { recursive: true });
  await writeFile(path.join(providerRoot, 'package.json'), JSON.stringify({ name: '@microsoft/m365agentstoolkit-cli', version: '1.1.17' }));
  await writeFile(path.join(providerRoot, 'cli.js'), 'synthetic-do-not-execute');
  await writeFile(path.join(providerRoot, 'lib', 'index.js'), 'synthetic-do-not-execute');
  const executionConfig = path.join(fccWorkspace, 'execution.json');
  await writeFile(executionConfig, JSON.stringify({ schemaVersion: 1, registrationConfig: 'registration.json', providerRoot }));
  const executionArgs = [...fccBase, '--project', path.join(fccWorkspace, 'auth-session'), '--config', executionConfig, '--phase', 'initialize'];
  const executionPlan = invoke(['mcp-auth-execution-plan', ...executionArgs, '--summary']);
  assert.equal(executionPlan.result.status, 'blocked');
  assert.ok(executionPlan.result.gaps.includes('REAL_M365_APP_ID_REQUIRED'));
  assert.ok(executionPlan.stderr.includes(executionPlan.result.approvalToken));
  invoke(['mcp-auth-execute', ...executionArgs, '--approve', executionPlan.result.approvalToken, '--allow-provider'], [1]);
  assert.ok(!(await readdir(fccWorkspace)).includes('auth-session'));
  await writeFile(executionConfig, JSON.stringify({ schemaVersion: 1, registrationConfig: 'registration.json',
    providerRoot, allowAnyAppValidationPlaceholder: true }));
  const compatiblePlan = invoke(['mcp-auth-execution-plan', ...executionArgs, '--summary']);
  assert.ok(!compatiblePlan.result.gaps.includes('REAL_M365_APP_ID_REQUIRED'));
  assert.equal(compatiblePlan.result.providerCompatibility.expectedM365AppId, '');
  assert.equal(compatiblePlan.result.request.registration.appId, undefined);
  assert.ok(compatiblePlan.stderr.includes('HomeTenant / AnyApp'));
  assert.ok(compatiblePlan.stderr.includes(compatiblePlan.result.providerCompatibility.validationAppId));
  assert.notEqual(compatiblePlan.result.approvalToken, executionPlan.result.approvalToken);
  invoke(['mcp-auth-execute', ...executionArgs, '--approve', executionPlan.result.approvalToken, '--allow-provider'], [1]);
  assert.ok(!(await readdir(fccWorkspace)).includes('auth-session'));
  authInput.registration.reference = { registrationId: '+synthetic/registration==', applicationIdUri: 'api://literature.example.com' };
  await writeFile(authConfig, JSON.stringify(authInput));
  const authArgs = [...fccBase, '--config', authConfig, '--output', authOutput];
  const authPlan = invoke(['mcp-auth-registration-plan', ...authArgs, '--summary']);
  assert.ok(authPlan.stderr.includes(authPlan.result.approvalToken));
  assert.equal(authPlan.result.bundle.readiness.status, 'blocked');
  assert.equal(authPlan.result.bundle.providerPreparation.action, null);
  assert.equal(authPlan.result.bundle.registrationReference.status, 'provided-unverified');
  for (const flag of ['--allow-cloud', '--allow-network', '--interactive', '--use-device-code', '--progress']) {
    invoke(['mcp-auth-registration-plan', ...authArgs, flag], [1]);
  }
  invoke(['mcp-auth-registration-schema', '--output', authOutput], [1]);
  invoke(['mcp-auth-registration-bundle', ...authArgs, '--approve', 'wrong'], [1]);
  const authWritten = invoke(['mcp-auth-registration-bundle', ...authArgs, '--approve', authPlan.result.approvalToken]).result;
  assert.equal(authWritten.executionReadiness, false);
  invoke(['mcp-auth-registration-bundle', ...authArgs, '--approve', authPlan.result.approvalToken], [1]);
  const importedFccConfig = path.join(fccWorkspace, 'fcc-with-auth.json');
  const importedFccInput = JSON.parse(await readFile(fccConfig));
  importedFccInput.source.authenticationBundleFile = 'auth.json';
  await writeFile(importedFccConfig, JSON.stringify(importedFccInput));
  const importedFccArgs = [...fccBase, '--config', importedFccConfig, '--output', path.join(fccWorkspace, 'fcc-with-auth-output.json')];
  const importedFccPlan = invoke(['mcp-fcc-plan', ...importedFccArgs]).result;
  assert.equal(importedFccPlan.bundle.authentication.registrationId, '+synthetic/registration==');
  assert.equal(importedFccPlan.bundle.manualSetup.sharedRegistration.referenceStatus, 'provided-unverified');
  assert.match(importedFccPlan.bundle.manualSetup.authenticationRegistration.steps
    .find(step => step.id === 'sso-config').instruction, /Reuse the supplied registration reference/);
  invoke(['mcp-fcc-bundle', ...importedFccArgs, '--approve', importedFccPlan.approvalToken]);
  const oauthDefinition = path.join(fccWorkspace, 'oauth-definition.json'), oauthProject = path.join(fccWorkspace, 'oauth-server');
  const oauthInput = JSON.parse(await readFile(fccDefinition));
  oauthInput.inbound = { type: 'oauth' };
  await writeFile(oauthDefinition, JSON.stringify(oauthInput));
  const oauthReview = invoke(['mcp-server-plan', ...fccBase, '--config', oauthDefinition]).result;
  invoke(['mcp-server-create', ...fccBase, '--config', oauthDefinition, '--output', oauthProject, '--approve', oauthReview.reviewDigest]);
  const oauthConfig = path.join(fccWorkspace, 'oauth-registration.json');
  const oauthRegistration = JSON.parse(await readFile(path.join(installed, 'examples', 'auth-registration', 'oauth-pkce.json')));
  oauthRegistration.source.descriptorFile = 'oauth-server/mcp-server.json';
  oauthRegistration.registration.appId = '55555555-5555-4555-8555-555555555555';
  await writeFile(oauthConfig, JSON.stringify(oauthRegistration));
  const oauthArgs = [...fccBase, '--config', oauthConfig, '--output', path.join(fccWorkspace, 'oauth-auth.json')];
  const oauthPlan = invoke(['mcp-auth-registration-plan', ...oauthArgs]).result;
  assert.equal(oauthPlan.bundle.providerPreparation.action.with.identityProvider, 'Custom');
  assert.equal(oauthPlan.bundle.providerPreparation.action.with.scope, 'literature.read');
  assert.equal(oauthPlan.bundle.providerPreparation.action.with.clientSecret, undefined);
  invoke(['mcp-auth-registration-bundle', ...oauthArgs, '--approve', oauthPlan.approvalToken]);
  const wiqdProject = path.join(fccWorkspace, "existing WIQD user's project");
  await mkdir(wiqdProject);
  const wiqdConfig = path.join(fccWorkspace, 'wiqd-handoff.json');
  await writeFile(wiqdConfig, JSON.stringify({ schemaVersion: 1, registrationConfig: 'oauth-registration.json',
    wiqdProject, environment: 'dev' }));
  const wiqdArgs = [...fccBase, '--config', wiqdConfig, '--output', path.join(fccWorkspace, 'wiqd-output.json')];
  const wiqdPlan = invoke(['mcp-auth-wiqd-plan', ...wiqdArgs, '--summary']);
  assert.ok(wiqdPlan.stderr.includes(wiqdPlan.result.approvalToken));
  assert.match(wiqdPlan.stderr, /ENTIRE WIQD lifecycle/);
  assert.equal(wiqdPlan.result.bundle.registration.action.with.clientSecret, undefined);
  assert.equal(wiqdPlan.result.bundle.commands.provision.args.at(-1), wiqdProject);
  for (const flag of ['--allow-provider', '--allow-network', '--allow-cloud', '--interactive']) {
    invoke(['mcp-auth-wiqd-plan', ...wiqdArgs, flag], [1]);
  }
  invoke(['mcp-auth-wiqd-bundle', ...wiqdArgs, '--approve', 'wrong'], [1]);
  assert.equal(invoke(['mcp-auth-wiqd-bundle', ...wiqdArgs, '--approve', wiqdPlan.result.approvalToken]).result.executionReadiness, false);
  assert.deepEqual(await readdir(wiqdProject), []);
  invoke(['mcp-auth-wiqd-bundle', ...wiqdArgs, '--approve', wiqdPlan.result.approvalToken], [1]);
  const confidentialConfig = path.join(fccWorkspace, 'oauth-confidential.json');
  oauthRegistration.registration.isPKCEEnabled = false;
  oauthRegistration.registration.credential = { type: 'key-vault-reference',
    secretIdentifier: 'https://synthetic-vault.vault.azure.net/secrets/oauth-client/0123456789abcdef0123456789abcdef' };
  await writeFile(confidentialConfig, JSON.stringify(oauthRegistration));
  const confidential = invoke(['mcp-auth-registration-plan', ...fccBase, '--config', confidentialConfig,
    '--output', path.join(fccWorkspace, 'oauth-confidential-output.json')]).result;
  assert.equal(confidential.bundle.providerPreparation.action, null);
  assert.ok(confidential.bundle.readiness.gaps.some(g => g.code === 'SECRET_RESOLUTION_UNIMPLEMENTED'));
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
  const publicDefinition = path.join(fccWorkspace, 'public.json'), publicProject = path.join(fccWorkspace, 'public-server');
  await copyFile(path.join(installed, 'examples', 'mcp', 'public-rates.json'), publicDefinition);
  const publicPlan = invoke(['mcp-server-plan', ...fccBase, '--config', publicDefinition]).result;
  assert.equal(publicPlan.descriptor.inbound.type, 'anonymous');
  assert.equal(publicPlan.descriptor.inbound.publicData, true);
  assert.equal(cap.mcpServer.publicAnonymous.liveQualified, false);
  invoke(['mcp-server-create', ...fccBase, '--config', publicDefinition, '--output', publicProject, '--approve', publicPlan.reviewDigest]);
  const publicResume = invoke(['mcp-resume', ...fccBase, '--project', publicProject], [2]).result;
  assert.equal(publicResume.next.code, 'AZURE_IDENTITY_REQUIRED');
  assert.equal(publicResume.replayAuthorized, false);
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
