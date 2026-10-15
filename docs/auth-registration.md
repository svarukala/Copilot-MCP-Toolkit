# Shared authentication registration preparation

The toolkit prepares **secretless Entra SSO** and **custom OAuth** registration
metadata for FCC and plugin consumers. This is an implemented, local-only
preparation/handoff module, **not automated registration**. It makes no network
calls, invokes no provider CLI, resolves no secrets and changes no accounts.
Live registration remains blocked pending an isolated provider environment.

This is not the universal H1 endpoint/tool export or a WIQD integration. WIQD
still owns plugin composition, packaging, validation and distribution. Custom
FCC submission remains a human operation in the Microsoft 365 admin center.

## Local workflow

Use an existing private workspace containing a toolkit-generated or referenced
`server/mcp-server.json` descriptor. No installed-code directory, credentials,
authentication cache or recovery archive belongs in that workspace's handoff.
All paths below are examples; use your actual private paths.

```powershell
copilot-mcp mcp-auth-registration-schema --json
copilot-mcp mcp-auth-registration-plan --workspace-root C:\private\demo --config C:\private\demo\registration.json --output C:\private\demo\auth-prepared.json --json --summary
```

Review the complete plan and exact operator, tenant, endpoint, scopes,
restrictions, client ID, credential mode and any existing reference. Then use
the returned top-level `approvalToken`:

```powershell
copilot-mcp mcp-auth-registration-bundle --workspace-root C:\private\demo --config C:\private\demo\registration.json --output C:\private\demo\auth-prepared.json --approve "EXACT_CURRENT_PLAN_TOKEN" --json
```

This approval permits only a **new local JSON file**. It binds the full input
(including the expected operator), descriptor, package build and destination.
Changes require a fresh plan. Publication is exclusive, with readback and no
overwrite. The expected operator account is excluded from the saved bundle; the
declared registration tenant is included. Neither is authenticated by preparation.

`examples/auth-registration/sso.json` pairs with
`examples/fcc/existing-literature-entra.json`. The OAuth example pairs with an
`existing-mcp` definition whose inbound type is `oauth`. Both examples omit
`appId` deliberately: only an actual intended M365 app ID should be supplied.
These are synthetic examples, never live identity choices.

Values must be literal reviewed metadata. ATK environment-variable expressions
are rejected rather than exported for later ambient interpolation.

## Explicit authentication inputs

| Input | Entra SSO | Custom OAuth |
| --- | --- | --- |
| Resource/provider client | Read from exact Entra descriptor | Required `clientId`; never inferred from endpoint |
| Tenant/operator | Explicit expected M365 registration tenant/account; SSO tenant must match descriptor | Explicit expected M365 registration tenant/account, not a guessed external issuer tenant |
| Restrictions | Required `HomeTenant`/`AnyTenant` and `SpecificApp`/`AnyApp` | Same; never silently broadened |
| M365 app ID | Optional for draft; required by reviewed ATK action, even for `AnyApp` | Same |
| Scopes | Retained from descriptor for separate resource/preauthorization review | Required unique scope array; exact order preserved, comma/whitespace inside a scope rejected |
| Provider endpoints | Not discovered or inferred | Explicit HTTPS authorization/token and optional refresh URLs without credentials, query or fragment |
| Credential | No client secret | `credential: {"type":"none"}` requires PKCE, or a versioned Key Vault reference |
| Existing reference | `reference.registrationId` plus generated `reference.applicationIdUri` | `reference.registrationId` |

For a confidential OAuth client, the only admitted credential shape is:

```json
{
  "type": "key-vault-reference",
  "secretIdentifier": "https://synthetic-vault.vault.azure.net/secrets/oauth-client/0123456789abcdef0123456789abcdef"
}
```

The version pins the selected secret metadata for future reviewed execution.
The current module **does not fetch it** and emits no runnable action for that
case. Do not paste the reference into a portal's client-secret field. An
authorized owner must supply any actual secret through an approved secure
provider/portal UI. APIM's existing versionless backend-key contract is unchanged.

## Output and consumer handoff

- `manualSetup.fields` contains labeled portal values, including redirect,
  client IDs, restrictions, scopes and opaque registration references. Missing
  values are `null`, not invented placeholders.
- `providerPreparation.action` describes the reviewed public ATK
  `oauth/register` action for SSO or secretless PKCE OAuth when an app ID is
  supplied. It is review data, not a lifecycle to execute automatically.
  It is `null` when an app ID is missing, a secret needs resolution, or an
  existing reference was supplied. Never create again merely to import a reference.
- `consumers.fcc.authentication` and `consumers.plugin.authentication` carry the
  same nonsecret method/reference. The plugin view is **mapping-required**, not
  a WIQD command input or Microsoft manifest.
- `registrationReference.status` is `missing` or `provided-unverified`.
  No `created`, settings-verified or consumer-ready result is fabricated.
  `readiness.status` remains `blocked` because execution is not implemented.

After manual registration, copy the actual ID unchanged into the private input's
`registration.reference`; include the generated Application ID URI for SSO.
Review a new output at a new destination. Opaque IDs preserve `+`, `/`, `=`
padding and other admitted punctuation; an ID is not an app ID or a secret.

FCC input can select this saved artifact:

```json
{
  "source": {
    "descriptorFile": "server/mcp-server.json",
    "authenticationBundleFile": "auth-prepared-with-reference.json"
  },
  "authentication": { "type": "entra-sso" }
}
```

This fragment belongs in a complete `mcp-fcc-schema` input. The FCC planner
validates the preparation's version, complete content, digest and **exact source
descriptor**, rejects conflicting explicit references, and binds the imported
file/digest into its approval. `manualSetup.sharedRegistration` retains the
additional form fields and unverified status. Import is not authentication,
settings verification or consent. The ordinary FCC discovery, audience and
token-store client checks still apply. OAuth discovery/capture import remains
unsupported; a registration reference cannot remove that gap.

## Provider qualification and remaining work

Reviewed the public CLI implementation installed as
`@microsoft/m365agentstoolkit-cli` **1.1.17**, including its shipped sourcemap.
This identifies a reviewed contract version, not a verified provider installation
on the eventual execution host. No private provider driver is imported.

The installed implementation requires an `appId` even with `AnyApp`.
`MicrosoftEntra` maps no scopes into registration; separate scope and token-store
preauthorization review is still necessary. `Custom` supports explicit
authorization/token/refresh URLs, comma-separated scopes, PKCE and either
`BasicAuthorizationHeader` or `PostRequestBody`. Explicit `baseUrl` preserves the
selected endpoint without discovering an OpenAPI document.

Provider login signs out the previous ATK account. Its cache implementation uses
a fixed OS credential-store key, and its Windows login may configure a native
broker. Changing HOME/USERPROFILE alone has **not** established isolated
authentication. The user was unavailable for the execution-environment choice,
so no Docker startup, VM provisioning or shared-profile sign-in was attempted.

Remaining execution gates: select/qualify an isolated OS profile or container;
verify the exact provider build and operator tenant/account; bind a real app and
restrictions; implement separate approval-bound login and registration with
immutable target reservations, no retries after uncertain dispatch, strict
output parsing and `created-unverified` receipts; separately review settings,
consent and consumer behavior. Confidential-client execution additionally needs
a reviewed private Key Vault identity/secret-delivery mechanism that cannot leak
through provider files, logs, arguments or parent environment.

Do not bypass these gates with ambient credentials, hidden token-store REST
calls, monkey-patched Microsoft code or a copied cache.

References:

- [Microsoft Entra SSO](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-entra-sso)
- [OAuth authentication](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-oauth)
- [ATK oauth/register action](https://aka.ms/teamsfx-actions/oauth-register)
- [Frozen Cowork guarded SSO adapter](https://github.com/svarukala/Cowork-Plugin-Toolkit/blob/b51d6a8645539591bd87f39354883e1bc6a2a7a8/src/sso-registration.js)
