import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { open, readFile, link, unlink } from 'node:fs/promises';
import { assertProjectPath } from './config.js';
import { savedJson } from './anonymous-metadata.js';

export async function writeNewJsonBundle(options, prepare, requireBundle) {
  const plan = await prepare(options);
  requireBundle(options.approval === plan.approvalToken, 'APPROVAL_REQUIRED',
    'Write requires the exact current plan approvalToken for these inputs, build, freshness and destination.');
  const staging = await assertProjectPath(path.join(path.dirname(plan.outputPath), `.bundle-${randomUUID()}.pending`));
  const file = await open(staging, 'wx', 0o600);
  try {
    try { await file.writeFile(savedJson(plan.bundle)); await file.sync(); }
    finally { await file.close(); }
    const fresh = await prepare(options);
    requireBundle(fresh.approvalToken === plan.approvalToken, 'INPUT_CHANGED',
      'Inputs, build or freshness changed during writing. Review a new plan; no publication was authorized.');
    await link(staging, plan.outputPath);
    requireBundle((await readFile(plan.outputPath, 'utf8')) === savedJson(plan.bundle),
      'READBACK', 'Output readback differs. Preserve the destination and investigate; do not overwrite it.');
    return { status: 'written', outputPath: plan.outputPath, contentDigest: plan.bundle.contentDigest,
      readiness: plan.bundle.readiness, executionReadiness: false, consumerExecution: 'not-verified' };
  } finally { await unlink(staging); }
}
