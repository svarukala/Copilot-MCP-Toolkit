import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { boundedSnapshot, metadataDigest } from './anonymous-metadata.js';

const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const digest = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' };
const image = { type: 'string', maxLength: 512, pattern: '^[a-z0-9.-]+/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$' };
const timestamp = { type: 'string', format: 'date-time' };
const count = { type: 'integer', minimum: 0, maximum: 1000000 };
const label = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,119}$' };
export const imageBuildSchema = object({
  builderImage: { type: 'string', pattern: '^node:22-bookworm-slim@sha256:[a-f0-9]{64}$' },
  runtimeImage: { type: 'string', pattern: '^gcr\\.io/distroless/nodejs22-debian12:nonroot@sha256:[a-f0-9]{64}$' },
  platform: { const: 'linux/amd64' },
});
export const imageReviewSchema = object({
  schemaVersion: { const: 1 }, kind: { const: 'image-qualification' }, image,
  sourceManifestDigest: digest, build: imageBuildSchema,
  builder: object({ run: label, evidenceDigest: digest }),
  scan: object({ image, scanner: label, databaseUpdatedAt: timestamp, scannedAt: timestamp,
    critical: count, high: count, medium: count, low: count, reportDigest: digest }),
  smoke: object({ image, networkDisabled: { const: true }, nonroot: { const: true },
    status: { const: 'passed' }, evidenceDigest: digest }),
  sbom: object({ image, reportDigest: digest }),
});
const ajv = new Ajv(); addFormats(ajv);
const valid = ajv.compile(imageReviewSchema);
export function reviewImage(project, input) {
  const requireImage = (ok, message) => {
    if (!ok) throw Object.assign(new Error(message), { code: 'MCP_IMAGE_QUALIFICATION' });
  };
  requireImage(valid(input), 'Use the closed image-qualification review schema; no raw scanner logs or credentials.');
  requireImage(project.input.recipe !== 'functions-sdk-v1' && project.files.Dockerfile,
    'Image qualification is for container recipes, not the Functions source-only profile.');
  requireImage(input.sourceManifestDigest === project.manifest.contentDigest,
    'Image evidence must bind the exact sealed generated source.');
  requireImage(input.image.startsWith(`${project.input.azure.registry.server}/`)
    && [input.scan.image, input.smoke.image, input.sbom.image].every(value => value === input.image),
  'Build, scan, SBOM and actual-image smoke must identify the same selected-registry digest.');
  requireImage(project.input.imageBuild && metadataDigest(boundedSnapshot(project.input.imageBuild))
    === metadataDigest(boundedSnapshot(input.build)),
  'Generate a new source project with these explicit digest-pinned imageBuild inputs before qualification.');
  const now = Date.now(), scanned = Date.parse(input.scan.scannedAt), database = Date.parse(input.scan.databaseUpdatedAt);
  requireImage(database <= scanned && scanned <= now && now - scanned <= 86400000 && now - database <= 86400000,
    'Scan and scanner database must be no more than 24 hours old and not future-dated. Refresh through a separately reviewed scan, never by editing receipts.');
  requireImage(input.scan.critical === 0 && input.scan.high === 0,
    'The initial image policy requires zero critical/high findings; no implicit exception or deployment is permitted.');
  return {
    status: 'passed-operator-evidence-review-not-attestation', image: input.image,
    sourceManifestDigest: project.manifest.contentDigest,
    sourceHashes: Object.fromEntries(['Dockerfile', 'package-lock.json', 'runtime-config.json', 'server.js', 'runtime.js']
      .map(name => [name, project.manifest.files[name]])),
    build: input.build, builder: input.builder, scan: input.scan, smoke: input.smoke, sbom: input.sbom,
    policy: { maximumCritical: 0, maximumHigh: 0, maximumAgeHours: 24 },
    expiresAt: new Date(Math.min(scanned, database) + 86400000).toISOString(),
    imageSourceCorrespondence: 'operator-evidence-not-cryptographically-attested',
    limitations: ['Imported metadata and digests are operator assertions, not verification of scanner execution, file copies or signed build provenance.',
      'Zero critical/high findings is a point-in-time package policy, not a guarantee of no exploitable vulnerabilities.'],
  };
}
