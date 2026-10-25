import Ajv from 'ajv';
import addFormats from 'ajv-formats';
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const text = { type: 'string', minLength: 1, maxLength: 512 };
const stamp = { type: 'string', format: 'date-time' };
const hash = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' };
export const lifecycleSchemas = [
  object({ schemaVersion: { const: 1 }, kind: { const: 'secret-reference-review' },
    secretIdentifier: text, identityResourceId: text, observedAt: stamp,
    metadata: object({ enabled: { type: 'boolean' }, expiresAt: { anyOf: [stamp, { type: 'null' }] },
      evidenceDigest: hash }), ownerEntered: { const: true } }),
  object({ schemaVersion: { const: 1 }, kind: { const: 'cost-closeout' },
    profile: { enum: ['always-warm', 'scale-to-zero'] },
    inventory: { type: 'array', minItems: 1, maxItems: 100, items: object({
      resourceId: text, ownership: { enum: ['created-for-project', 'pre-existing', 'unknown'] },
      disposition: { enum: ['retain', 'propose-removal'] }, evidenceDigest: hash,
    }) },
    pricing: { type: 'array', minItems: 1, maxItems: 30, items: object({
      component: { enum: ['compute', 'requests', 'registry', 'vault', 'builds', 'storage', 'network', 'logging', 'other'] },
      status: { enum: ['estimate', 'unavailable', 'not-quoted'] },
      monthlyAmount: { anyOf: [{ type: 'number', minimum: 0, maximum: 1000000 }, { type: 'null' }] },
      currency: { type: 'string', pattern: '^[A-Z]{3}$' }, observedAt: stamp,
    }) } }),
];
const ajv = new Ajv(); addFormats(ajv); const valid = ajv.compile({ oneOf: lifecycleSchemas });
function requireLifecycle(ok, message) {
  if (!ok) throw Object.assign(new Error(message), { code: 'MCP_LIFECYCLE_REVIEW' });
}
export function reviewLifecycle(project, input) {
  requireLifecycle(valid(input), 'Use the bounded secret-reference or cost-closeout schema; never supply credentials.');
  if (input.kind === 'secret-reference-review') {
    const key = project.input.backend.apiKey;
    requireLifecycle(key && input.secretIdentifier === key.secretIdentifier && input.identityResourceId === key.identityResourceId,
      'Secret metadata must match the exact sealed Key Vault reference and dedicated reader identity.');
    const observed = Date.parse(input.observedAt);
    requireLifecycle(observed <= Date.now() && Date.now() - observed <= 86400000,
      'Secret metadata observation must be recent and not future-dated; never read the secret to refresh metadata.');
    requireLifecycle(input.metadata.enabled && (input.metadata.expiresAt === null
      || Date.parse(input.metadata.expiresAt) > Date.now()), 'Secret metadata reports disabled or expired.');
    return { status: 'metadata-reviewed-operator-declaration', ownerEntered: true,
      secretIdentifier: input.secretIdentifier, identityResourceId: input.identityResourceId,
      referenceResolution: 'not-verified', providerAcceptance: 'not-verified',
      versionPolicy: new URL(input.secretIdentifier).pathname.split('/').length === 4 ? 'pinned-version' : 'versionless',
      instructions: ['Inspect least-privilege Get access and network reachability separately without secret resolution.',
        'Credentials are process startup snapshots; platform cache, rotation and restart behavior need host-specific review.',
        'Review removal of temporary owner-entry permission separately. Never revoke access or change the reference automatically.'] };
  }
  requireLifecycle(new Set(input.inventory.map(i => i.resourceId.toLowerCase())).size === input.inventory.length,
    'Closeout inventory must contain unique exact resources/grants.');
  const prefix = `/subscriptions/${project.input.azure.subscriptionId}/`;
  for (const item of input.inventory) {
    requireLifecycle(item.resourceId.startsWith(prefix) && item.resourceId.length > prefix.length
      || /^\/(?:applications|servicePrincipals)\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(item.resourceId),
    'Inventory must identify exact selected-subscription resources or explicitly reviewed directory object IDs.');
    requireLifecycle(item.disposition !== 'propose-removal' || item.ownership === 'created-for-project',
      'Pre-existing or unknown ownership cannot be proposed for automatic removal; retain and resolve ownership separately.');
  }
  requireLifecycle(new Set(input.pricing.map(p => p.component)).size === input.pricing.length,
    'Price components must be unique.');
  for (const price of input.pricing) requireLifecycle((price.status === 'estimate') === (price.monthlyAmount !== null)
    && Date.parse(price.observedAt) <= Date.now(), 'Unknown pricing is null, not zero; estimates need an explicit amount and observation time.');
  const required = ['compute', 'requests', 'registry', 'vault', 'builds', 'storage', 'network', 'logging'];
  const missing = required.filter(component => !input.pricing.some(p => p.component === component));
  return { status: 'review-only-no-teardown', proposedProfile: input.profile,
    sourceProfile: project.input.scaleProfile ?? 'always-warm',
    profileChangeRequiresNewSource: input.profile !== (project.input.scaleProfile ?? 'always-warm'),
    inventory: input.inventory, pricing: input.pricing, unquotedComponents: missing,
    totalMonthlyCost: null, spendingCap: false, freeTierGuaranteed: false, removesAnything: false,
    requirements: ['Scale-to-zero is only available for a separately reviewed direct/gateway Container Apps source; cold-start latency may affect consumer deadlines.',
      'Estimates are region/time/usage assumptions, not a bill or spending cap. Missing/rate-limited pricing stays unknown.',
      'Successful testing leaves resources billing. Each proposed removal requires exact fresh ownership/scope/effect approval and private identity.',
      'Never cascade-delete a group with unrelated resources. Retain immutable receipts, soft-delete/purge protections and consumed proofs.',
      'Include temporary owner-entry grants, directory objects and role assignments in the inventory; no role cleanup is inferred.'] };
}
