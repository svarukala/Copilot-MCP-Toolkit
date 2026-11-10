# OAuth and password REST backend profiles

These **SDK runtime pilot profiles** implement backend authentication, not a
new inbound MCP authentication provider. Callers still need delegated Entra
tokens. Direct Azure Container Apps (ACA) and ACA behind API Management (APIM)
are the only enabled hosts. Native APIM passthrough/managed identity, existing
OAuth MCP references and API-key proxies retain their separate contracts.
App Service and Functions reject these new backend profiles.

No named third-party provider, real certificate registration, cloud deployment
or consumer compatibility is qualified by synthetic tests. Generation never
logs in, resolves credentials, registers applications, grants roles or calls a
backend. Every live phase needs its own review.

The v3 validation journey prepares these profiles with separate owner checkpoints.
The bounded `mcp-execution-*` runner and `mcp-host-execution-*` executor remain
limited to the existing anonymous/API-key contracts; they reject OAuth/OBO
before identity or Docker/cloud operations. Use separately reviewed manual
hosting for the pilot, not an earlier v2 execution grant.

Generated containers retain the minimal bundled runtime. Both authentication
modules are sealed source/build inputs and bundled into `dist/runtime.js`;
they do not restore the full dependency tree in the final image.

## Select one profile

| `backend.auth` | Principal / grant | Boundary |
| --- | --- | --- |
| `oauth-client-credentials-v1` | Shared provider application / `client_credentials` | Explicit shared entitlement review; no user filtering claim |
| `oauth-authorization-code-v1` | Provider authorization linked to verified Entra tenant/object ID / code + S256 PKCE | Hosted connection page; process-memory tokens only |
| `entra-obo-v1` | Current same-tenant Entra user / OBO JWT bearer exchange | Middle-tier client must match caller audience; distinct downstream resource and exact delegated scopes |

All use `backend.oauth.schemaVersion: 1`, an explicit issuer, token endpoint,
client ID, scopes and credential method. The runtime configuration version is
2; historical anonymous/API-key runtime configurations stay version 1.
Recipe identifiers remain unchanged. Fixed literal GET tools and existing
body/response/rate limits remain; no request bodies, tool arguments or dynamic
credential/endpoint selection are added.

Start with the complete **synthetic-only**
[application OAuth example](../examples/mcp/container-apps-direct-oauth.json).
Use the existing `mcp-hosting-schema/plan/create` operations and review exact
nonsecret target/reference data. OpenAPI must declare one matching `oauth2`
flow with the exact endpoint and scopes. Optional/alternative security and
operation-level downgrades are rejected.

Third-party `resource`, when supplied, is the standard OAuth resource
parameter. Proprietary audience parameters, arbitrary request templates,
dynamic discovery/registration, implicit/password grants and authentication
fallback are unsupported. Endpoint URLs are fixed credential-free HTTPS DNS
URLs without query, fragment or port. Issuer spelling is exact.

## Confidential clients and Key Vault

Select `credential.method` explicitly:

- `client_secret_basic`: OAuth form-encoded Basic client authentication.
- `client_secret_post`: client authentication in the form-encoded token body.
- `private_key_jwt`: certificate/private-key assertion. Include nonsecret
  `credential.keyId`; third-party assertions use that `kid` and RS256.
  Entra uses PS256 and the certificate SHA-256 thumbprint header.

Entra OBO and the Entra portal client support `client_secret_post` or
`private_key_jwt`, not Basic. No fallback is attempted. Certificate support is
not mTLS, federated workload identity or HSM remote signing.

`backend.credentialReferences.backend` contains explicit `tenantId`,
`keyVaultResourceId`, `identityResourceId` and a **versioned** `secretIdentifier`.
They must match the deployment tenant/subscription and vault, and use a
dedicated existing identity distinct from the ACR pull identity. Portal
credentials use a separate `credentialReferences.portal` reference. No raw
credential values belong in these objects.

The platform injects the referenced value into `MCP_BACKEND_CLIENT_CREDENTIAL`
or `MCP_PORTAL_CLIENT_CREDENTIAL`. A secret method expects a nonempty bounded
credential without whitespace/control characters. The certificate method
expects a private Key Vault secret containing a JSON object with exactly
`certificatePem` and `privateKeyPem`: a currently valid X.509 certificate and
matching RSA private key of at least 2048 bits. Never put that object into
recipe files, shell arguments, examples or evidence. Public-key registration
and secret provisioning remain separate owner operations.

Startup rejects unresolved references or malformed/mismatched/expired
material. Assertions have a unique ID, exact endpoint audience and 60-second
lifetime. Runtime token requests use the standard form protocol directly and
existing jose/Node cryptography, with one bounded request and no hidden
discovery or SDK retries. No new generated dependency or global cache is used.

Versioned references make rotation explicit: create a new reviewed source/
release for the new reference, register the public key where needed, deploy
under a separate approval, and reconnect users after restart. Do not edit or
reseal an old project or assume rotating a credential revokes issued tokens.

## Per-user account connections

For `oauth-authorization-code-v1`, replace the example's `sharedAccessReviewed`
with `consentReviewed: true`. Supply:

```json
{
  "authorizationEndpoint": "https://identity.example.com/authorize",
  "redirectUri": "https://mcp.example.com/auth/provider/callback",
  "revocationEndpoint": "https://identity.example.com/revoke",
  "portal": {
    "clientId": "99999999-9999-4999-8999-999999999999",
    "credential": { "method": "client_secret_post" },
    "publicBaseUrl": "https://mcp.example.com"
  }
}
```

This is a fragment of `backend.oauth`, not a complete recipe. Also add the
separate portal Key Vault reference, allow the portal client in the API's
`authentication.allowedClientIds`, and use the `authorizationCode` OpenAPI
flow with matching authorization/token URLs and exact scopes.

The Entra portal client is an explicitly selected, separately registered
confidential web application, not the API audience itself. An owner must
register `${publicBaseUrl}/auth/entra/callback`, configure its confidential
credential, and pre-consent its delegated access to the MCP API. No registration
or consent is created by the toolkit.

For a gateway, `publicBaseUrl` includes its API path, for example
`https://synthetic-apim.azure-api.net/reviewed-mcp`. Its `/mcp` suffix must match
the configured gateway URL. For direct hosting it must match the actual
advertised server origin. Review callbacks before source generation; never
guess an environment domain. Source/reference mismatches fail closed.

Open `${publicBaseUrl}/auth`. The page:

1. Uses Entra code + PKCE login with state/nonce checks and independently
   validates a delegated MCP API token before creating a browser session.
2. Displays the provider and exact requested scopes. An explicit connect
   action starts provider code + PKCE authorization bound to that browser and
   Entra tenant/object ID.
3. Requires an exact authorization-response `iss` parameter (RFC 9207) from
   the third-party provider. Providers lacking this feature are not qualified
   by this profile. Replayed, expired or cross-browser callbacks fail.
4. Holds access/refresh tokens only in server memory. Neither tokens nor a
   verified provider username are returned to the browser or MCP client.
   Provider identity and effective entitlement remain provider responsibilities.
5. Offers local disconnect and, only with a configured standard endpoint, a
   separate explicit revocation action. Local deletion is not provider
   revocation; uncertain revocation is not retried.

The browser session manages connections only; it does not authorize MCP calls.
MCP still requires fresh valid bearer authentication. Gateway mode additionally
requires the independent signed gateway token on every connection route, so
the direct host is not an account-linking bypass.

The pilot supports one process, one active revision and one replica, at most
100 user connections and 100 pending transactions. Transactions expire after
5 minutes and browser/provider sessions after at most 15 minutes. Scale-to-zero
is rejected for this profile. Crash/revision/restart loses all connections.
There is no distributed cache, durable refresh-token store or restart recovery.
Each replica/process maintains its own limits; deployment topology requires
separate readback, not a claim based only on generated templates.

Refresh is serialized per connection, on demand within its lifetime, before
dispatch and without widening scopes. Refresh-token rotation replaces the old
value in memory; omission retains the existing token. No `offline_access`
scope is appended implicitly. Invalid/unknown refresh invalidates the local
connection; disconnect it before explicitly reconnecting. A backend 401 never
triggers token renewal plus replay of the REST call.

## Same-tenant OBO

Set issuer to `https://login.microsoftonline.com/TENANT/v2.0` and token endpoint
to `https://login.microsoftonline.com/TENANT/oauth2/v2.0/token`. Set `clientId`
to the inbound API audience, `resource` to the separate downstream application
URI, `scopes` to explicit scopes under that URI and `consentReviewed: true`.
Use a matching `authorizationCode` OpenAPI declaration; OBO is the middle
tier's exchange, not an OpenAPI password flow.

The runtime validates the current delegated caller and exchanges that request's
access token only at the configured Entra endpoint. It never exchanges an ID
token or gateway identity, forwards the caller token to REST, or downgrades to
app-only access. Cache entries are bound to user and assertion as well as the
process's fixed profile. No background/offline grant, `.default` permission
expansion, cross-tenant flow or silent consent/claims-challenge retry exists.
Consent/conditional-access failures are explicit errors requiring owner action.
The downstream API must validate its own audience, subject and scopes.

## Runner, proof and evidence

Use [validation-create-oauth.json](../examples/mcp/validation-create-oauth.json)
and v3 `container-apps-create-v3` or `container-apps-apim-create-v3` scenarios.
The same plan/start/next/run/status CLI family exposes `authCreationScenario`,
`authCreationCheckpoint` and `authCreationCoverage`. V1/v2 retain their old
profile gates. V3 uses separate discovery/proof, not combined session mode.

Generation, build/deployment, secret resolution, registration, consent,
connection, discovery, proof and export remain distinct operations. New owner
checkpoints include `client-registration`, `delegated-consent`,
`user-connection`, `identity-isolation`, `token-lifecycle`, `revocation` and
`single-process-topology`, where applicable. They do not execute or attest
those actions. Connection identity must match the pinned proof caller.

Discovery never obtains a backend token. Proof plans disclose one bounded
backend grant/exchange/refresh if required followed by one fixed GET. Reports
retain nonsecret configuration and provenance only. Failed/unknown calls,
related histories and locks stay consumed across changed auth, users, sources,
references, exports and restarts. OAuth evidence is not live readiness.

Before any live use, owners must inspect platform/APIM diagnostics and disable
sensitive URL/body/header capture for auth routes. Authorization codes, state,
cookies, assertions, keys and tokens must not enter traces. The runtime emits
only bounded error categories, but cannot silently reconfigure inherited
platform diagnostics. Key Vault access, public registrations, gateway routing,
refresh/expiry/rotation/revocation and two-user isolation need separately
approved controlled live fixtures on each actual host.

## Username/password: design only

`http-basic-v1` is a proposed HTTPS Basic shared-service-account profile with
separate username/password references, explicit encoding, forbidden username
colon/control characters, no redirect/challenge-following and shared entitlement
review. It is not implemented and generation rejects it.

`provider-password-exchange-v1` requires a named backend/protocol before code:
fixed exchange endpoint and encoding, token versus cookie semantics, MFA/
challenge handling, expiration, concurrent session invalidation and logout/
revocation. No generic arbitrary-request adapter or form scraping is planned.
Entra ROPC, generic OAuth password grants, provider-password collection in the
connection page and per-user password vaulting are out of scope.
