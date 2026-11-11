import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { portalSsoScope } from './mcp-sso-scope.js';

const object = properties => ({ type: 'object', additionalProperties: false,
  properties, required: Object.keys(properties) });
const text = { type: 'string', minLength: 1, maxLength: 2048 };
export const ssoSettingsAttestationSchema = object({
  schemaVersion: { const: 1 }, kind: { const: 'mcp-sso-settings-attestation' },
  evidence: { const: 'operator-attestation' },
  reviewedAt: { type: 'string', format: 'date-time' },
  settings: object({
    registrationId: text, applicationIdUri: text,
    portalScope: { ...text, maxLength: 2048 + 1 + 128 },
    endpoint: text, resourceClientId: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', format: 'uuid' },
    targetAudience: { enum: ['HomeTenant', 'AnyTenant'] },
    applicableToApps: { enum: ['SpecificApp', 'AnyApp'] },
    appId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
  }),
});
const ajv = new Ajv({ allErrors: true }); addFormats(ajv);
const valid = ajv.compile(ssoSettingsAttestationSchema);
const ensure = (ok, code, message) => {
  if (!ok) throw Object.assign(new Error(message), { code: `MCP_SSO_SETTINGS_${code}` });
};

export function ssoSettingsReview(descriptor, registration, attestation = null) {
  const reference = registration.reference;
  const scope = portalSsoScope(reference?.applicationIdUri, descriptor.inbound.scope);
  ensure(!reference?.applicationIdUri || scope.status === 'provided', 'SCOPE',
    'The registered Application ID URI and exact permission name must form an unambiguous fully qualified scope.');
  const expected = {
    registrationId: reference?.registrationId ?? null,
    applicationIdUri: reference?.applicationIdUri ?? null,
    portalScope: scope.value,
    endpoint: descriptor.endpoint, resourceClientId: descriptor.inbound.clientId,
    tenantId: descriptor.inbound.tenantId,
    targetAudience: registration.targetAudience ?? null,
    applicableToApps: registration.applicableToApps ?? null,
    appId: registration.appId ?? null,
  };
  if (attestation !== null) {
    ensure(valid(attestation), 'ATTESTATION',
      'Use a nonsecret mcp-sso-settings-attestation with explicit operator-attestation evidence and all reviewed settings. Provider readback is not supported.');
    ensure(Object.entries(expected).every(([key, value]) => key === 'appId'
      ? expected.applicableToApps !== 'SpecificApp' || value !== null
      : value !== null), 'INCOMPLETE',
    'Obtain the actual registration reference, URI and restrictions before attesting settings. Do not invent missing values.');
    ensure(Object.entries(expected).every(([key, value]) => attestation.settings[key] === value),
      'MISMATCH', 'Attested scope, endpoint, resource, tenant, reference or app restrictions differ from this registration. Preserve restrictions and review the mismatch; do not recreate registration.');
  }
  return {
    schemaVersion: 1, status: attestation ? 'operator-attested' : 'pending',
    expected, permissionName: descriptor.inbound.scope,
    attestation,
    providerUpdate: 'unsupported-by-toolkit', providerReadback: 'not-performed',
    consumerAuthentication: 'not-verified', executionReadiness: false,
    portalUrl: 'https://dev.teams.microsoft.com/',
    instructions: [
      'Open the existing registration in Teams Developer Portal. Do not create a replacement. Review its endpoint/base URL, resource client ID, tenant and app restrictions against expected.',
      'Set/check the portal Scope against expected.portalScope, using the actual registered Application ID URI and exact permission casing. The short runtime scp claim is not the portal Scope. Missing values block completion.',
      'Verify the intended consumer app binding separately. Never broaden SpecificApp to AnyApp or HomeTenant to AnyTenant to bypass a mismatch.',
      'The toolkit cannot update or read back these provider settings. After separately approved portal work, record an operator attestation in a new private file, then export a new preparation. No additional ATK creation scope argument fixes this gap.',
      'An operator attestation records a reported observation, not provider verification, consent or successful consumer authentication. Static package checks and MCP discovery do not establish consumer readiness.',
    ],
  };
}
