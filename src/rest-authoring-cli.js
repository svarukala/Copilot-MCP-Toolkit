import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, mkdir, open, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { TOOLKIT_ROOT, assertProjectPath } from './config.js';
import { prepareRestToolDocument } from './rest-authoring.js';

const json = value => `${JSON.stringify(value, null, 2)}\n`;
const digest = value => createHash('sha256').update(value).digest('hex');
async function confined(value) {
  return assertProjectPath(path.resolve(value), { workspaceRoot: TOOLKIT_ROOT });
}
async function prepare(options) {
  if ((options.definition === undefined) === (options.definitionFile === undefined)) throw new Error('Supply one nonsecret definition or definition file.');
  let definition = options.definition, sourceFile, source;
  if (options.definitionFile !== undefined) {
    sourceFile = await confined(options.definitionFile);
    const info = await lstat(sourceFile);
    if (!info.isFile() || info.size > 1048576) throw new Error('REST definition must be a regular JSON file no larger than 1 MiB.');
    source = await readFile(sourceFile);
    if (source.length > 1048576) throw new Error('REST definition exceeds 1 MiB.');
    try { definition = JSON.parse(source.toString('utf8')); }
    catch { throw new Error('REST definition JSON is invalid; input contents are not logged.'); }
  }
  const prepared = prepareRestToolDocument(definition);
  if (typeof options.outputPath !== 'string' || !options.outputPath) throw new Error('Choose a new OpenAPI JSON output path.');
  const outputPath = await confined(options.outputPath);
  if (path.extname(outputPath).toLowerCase() !== '.json') throw new Error('OpenAPI output must use a .json extension.');
  try { await lstat(outputPath); throw new Error('OpenAPI destination already exists; choose a new file. Existing inputs/projects are never replaced.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const binding = { outputPath, sourceFile: sourceFile ?? null,
    definitionDigest: digest(source ?? json(definition)), documentDigest: digest(json(prepared.document)) };
  return { ...prepared, action: 'write-rest-tools', outputPath, ...(sourceFile ? { sourceFile } : {}),
    approvalToken: `rest-tools/${digest(json(binding))}` };
}

export async function planRestToolWrite(options) {
  return prepare(options);
}

export async function writeRestTools(options) {
  options = { ...options, ...(options.definition !== undefined ? { definition: structuredClone(options.definition) } : {}) };
  const reviewed = await prepare(options);
  if (options.approval !== reviewed.approvalToken) throw new Error('CURRENT_REST_AUTHORING_APPROVAL_REQUIRED');
  await mkdir(path.dirname(reviewed.outputPath), { recursive: true });
  await confined(reviewed.outputPath);
  const staging = await confined(path.join(path.dirname(reviewed.outputPath), `.rest-${randomUUID()}.pending`));
  const file = await open(staging, 'wx');
  try {
    try { await file.writeFile(json(reviewed.document)); await file.sync(); }
    finally { await file.close(); }
    const fresh = await prepare(options);
    if (fresh.approvalToken !== reviewed.approvalToken) throw new Error('REST_AUTHORING_INPUT_CHANGED');
    await link(staging, reviewed.outputPath);
    if (digest(await readFile(reviewed.outputPath)) !== digest(json(reviewed.document))) throw new Error('REST_AUTHORING_READBACK_MISMATCH');
    return { status: 'written', evidence: 'user-authored-openapi', outputPath: reviewed.outputPath,
      operationIds: reviewed.operationIds,
      nextStep: 'Use this OpenAPI for REST authoring. Existing projects were not changed. Review deployment separately and capture actual tools/list before packaging.' };
  } finally { await unlink(staging); }
}

const check = (pattern, message) => value => { if (!pattern.test(value)) throw new Error(message); };
const nameCheck = check(/^[A-Za-z][A-Za-z0-9_]{0,79}$/, 'Use a letter followed by letters, digits or underscores (maximum 80 characters).');
const scalarCheck = check(/^[A-Za-z0-9_.-]{1,100}$/, 'Use a nonsecret scalar selector/default: 1-100 letters, digits, underscores, dots or hyphens.');
const textCheck = value => { if (!value.trim() || value.length > 1000 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Use a nonblank description up to 1000 characters without control characters.'); };

async function collectTool(p, apiKeyQueryParameter) {
  const name = await p.ask('Tool name, e.g. search_bills or get_bill (not a generic dispatcher)', { check: nameCheck });
  const description = await p.ask('What does this tool do? Describe when to use it', { check: textCheck });
  const backendPath = await p.ask('Documented backend path relative to the connector base URL, e.g. / or /v1/search (GET only)', {
    check: value => {
      if (value.length > 1024 || !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(value)) throw new Error('Use a literal slash-prefixed backend path up to 1024 characters; no URL, query, placeholders or expressions.');
    },
  });
  const fixedQuery = {}, args = [];
  while (Object.keys(fixedQuery).length < 20 && await p.yes('Add a fixed nonsecret backend selector, e.g. op=getSearch? Never add credentials.')) {
    const key = await p.ask('Fixed backend query name, e.g. op', { check: value => {
      nameCheck(value);
      if (Object.hasOwn(fixedQuery, value)) throw new Error('This fixed query name is already present.');
      if (value === apiKeyQueryParameter || /^(?:api_?key|client_?secret|access_?token|refresh_?token|password|authorization)$/i.test(value)) {
        throw new Error('Credentials do not belong in fixed selectors. Use the existing Key Vault authentication settings.');
      }
    } });
    const value = await p.ask('Fixed nonsecret value, e.g. getSearch', { check: scalarCheck });
    Object.defineProperty(fixedQuery, key, { value, enumerable: true, configurable: true, writable: true });
  }
  while (args.length < 30 && await p.yes('Add a caller-supplied argument, e.g. query, state or bill_id?')) {
    const argument = {
      name: await p.ask('Tool argument name, e.g. bill_id', { check: nameCheck }),
      description: await p.ask('Argument meaning and example, e.g. numeric ID from search results', { check: textCheck }),
      type: await p.choose('Argument type (inline scalar query values only)', [
        { value: 'string', label: 'String, e.g. search text or state code' },
        { value: 'integer', label: 'Integer, e.g. bill ID or page number' },
      ]),
      required: await p.yes('Must the caller supply this argument?'),
    };
    const value = await p.ask('Optional nonsecret default, e.g. ALL, 2 or 1 (leave empty for none)', { optional: true, check: value => {
      scalarCheck(value);
      if (argument.type === 'integer' && (!/^-?(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))) throw new Error('Use a safe integer matching the argument type.');
    } });
    if (value !== undefined) argument.default = argument.type === 'integer' ? Number(value) : value;
    argument.backendName = await p.ask('Backend query name for this argument, e.g. id for bill_id', { defaultValue: argument.name, check: nameCheck });
    args.push(argument);
  }
  return { name, description, backendPath, fixedQuery, arguments: args };
}

export async function promptRestToolAuthoring(p, { title, outputPath, apiKeyQueryParameter }) {
  p.output.write('Author documented GET tools, not guessed tools/list metadata. Only literal paths and string/integer query arguments are supported. API keys remain Key Vault references. Existing files and projects are never replaced.\n');
  p.output.write('Limits: 100 tools, 20 fixed query values and 30 arguments per tool. Required/default metadata still needs runtime review.\n');
  const definition = { title, ...(apiKeyQueryParameter ? { apiKeyQueryParameter } : {}), tools: [] };
  while (definition.tools.length < 100) {
    const tool = await collectTool(p, apiKeyQueryParameter);
    try { prepareRestToolDocument({ ...definition, tools: [...definition.tools, tool] }); }
    catch (error) {
      p.output.write(`Tool was not accepted: ${error.message}\n`);
      if (await p.choose('Revise this tool or return to source selection', [
        { value: 'retry', label: 'Re-enter the rejected tool; keep prior tools' },
        { value: 'cancel', label: 'Cancel without writing a file' },
      ]) === 'cancel') return null;
      continue;
    }
    definition.tools.push(tool);
    if (definition.tools.length === 100 || !await p.yes('Add another distinct tool?')) break;
  }
  const prepared = prepareRestToolDocument(definition);
  p.output.write(`${json({ operations: prepared.operations, limitations: prepared.limitations })}`);
  while (true) {
    const destination = await p.ask('New OpenAPI JSON draft path (existing files are never overwritten)', { defaultValue: outputPath,
      check: async value => { await planRestToolWrite({ definition, outputPath: value }); } });
    try {
      const plan = await planRestToolWrite({ definition, outputPath: destination });
      if (!await p.yes(`Save these reviewed mappings locally to ${JSON.stringify(plan.outputPath)}? No cloud changes or metadata capture.`)) return null;
      const result = await writeRestTools({ definition, outputPath: destination, approval: plan.approvalToken });
      p.output.write(`${json(result)}`);
      return { openApiPath: result.outputPath, operationIds: result.operationIds };
    } catch (error) {
      p.output.write(`OpenAPI draft was not confirmed written: ${error.message}\nInspect the named destination before retrying; no existing file was removed.\n`);
      if (!await p.yes('Choose a new output path and review again?')) return null;
    }
  }
}
