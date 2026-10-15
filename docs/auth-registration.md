# Shared authentication registration

The toolkit prepares **secretless Entra SSO** and **custom OAuth** registration
metadata for FCC and plugin consumers. The preparation/handoff commands remain
local-only: no network, provider CLI, secret resolution or account changes.
Separate **Linux-only execution commands** implement approval-bound ATK sign-in
and registration. Their offline behavior is covered by synthetic providers;
**real Linux/ATK registration is not yet qualified**. Windows/macOS execution
is refused rather than falling back to shared credentials.

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

The version pins the selected secret metadata for separately reviewed execution.
The preparation module **does not fetch it** and emits no runnable action for that
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
  `readiness.status` remains `blocked`; preparation does not establish execution
  or consumer readiness.

Version-1 preparation artifacts retain their historical
`REGISTRATION_EXECUTION_UNIMPLEMENTED`, `PROVIDER_ISOLATION_UNQUALIFIED` and
`SECRET_RESOLUTION_UNIMPLEMENTED` gap identifiers/wording to preserve canonical
content and previously saved hashes. They describe that preparer's limits, not
the capabilities of the separate executor. Read
`capabilities.authRegistrationExecution` and an execution plan for those.

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

## Separate execution workflow

Use a trusted Linux host with Node.js 22+, an existing ATK **1.1.17** installation,
`/dev/shm` backed by tmpfs, and a browser on that same host for the loopback
callback. No installation, Docker startup, browser automation or cache transfer
is performed by the toolkit. Select a real intended M365 app ID, even for
`AnyApp`; the toolkit will not create or invent one.

Keep the session workspace private and durable, separate from installed code.
`examples/auth-registration/execution.json` shows the additional configuration:

```json
{
  "schemaVersion": 1,
  "registrationConfig": "registration.json",
  "providerRoot": "/opt/atk/node_modules/@microsoft/m365agentstoolkit-cli"
}
```

The provider path is an example, not an installation instruction. Config-relative
`registrationConfig` selects the complete local preparation input without an
existing reference/result. Confidential OAuth also needs `secretIdentityProject`
pointing to an **already selected private toolkit Azure identity** in the same
workspace, matching the explicit tenant/account and subscription selection.
This executor neither signs into Azure nor changes its selected account.

On that Linux host, use the following plan pattern, replacing the private paths
and phase. `--project` is a new private session directory, not the MCP server.

```sh
copilot-mcp mcp-auth-execution-schema --json
copilot-mcp mcp-auth-execution-plan --workspace-root /private/demo --project /private/demo/auth-session --config /private/demo/execution.json --phase initialize --json --summary
copilot-mcp mcp-auth-execute --workspace-root /private/demo --project /private/demo/auth-session --config /private/demo/execution.json --phase initialize --approve "EXACT_CURRENT_PHASE_TOKEN" --allow-provider --json
```

Plan and review **each phase independently**, then execute that phase with its
own returned `approvalToken`. Exit 0 on a plan is not permission to proceed:
its `status` must be `planned`, not `blocked`.

| Phase | Required effect flags, in addition to exact `--approve` | Effect |
| --- | --- | --- |
| `initialize` | `--allow-provider` | Create an owner-only tmpfs runtime and durable nonsecret session metadata; no login |
| `login` | `--allow-provider --allow-network --interactive` | Public ATK browser sign-in to the explicit tenant; terminal-only URL, manually opened on the same Linux host |
| `register` | `--allow-provider --allow-network --confirm-identity` | Recheck identity, durably reserve the target, invoke one public `oauth/register` action |
| Confidential `register` | All registration flags plus `--allow-cloud` | Use the selected private Azure identity to retrieve the exact versioned Key Vault secret |
| `close` | `--allow-provider` | Remove only the owned runtime; retain durable receipts, attempts and reservations; config is unnecessary |

After login, review the displayed account and organization against the selected
tenant. The public account output and ATK tenant-selection file are **not token
issuer attestation**. `--confirm-identity` is the operator's separate confirmation,
not an automatically inferred flag. Login review expires after 15 minutes; an
expired/failed login requires a newly reviewed private session, never adoption
of the old cache. An attempted registration cannot be retried in a new session.

The Linux adapter constructs a fresh environment, uses a unique owner-only
tmpfs HOME/job area, makes D-Bus keyring endpoints unreachable, and admits no
Windows broker or ambient provider overrides. It invokes the public CLI, not
private Microsoft drivers or hidden token-store HTTP endpoints. Provider entry
assets and Node version are approval-bound; this is **not a full dependency-tree
or supply-chain attestation**. The host, installed provider and same OS user must
be trusted. Tmpfs is not an OS sandbox or a guarantee against swap/crash dumps;
use appropriate host swap/dump controls for credentials.

For confidential OAuth, a bounded private Azure CLI access-token read is followed
by one bounded HTTPS read of the exact Key Vault secret version. Redirects,
alternate endpoints and automatic retries are refused. The secret response does
not pass through Azure CLI output/logging. The value is passed to ATK only through
its child environment; it is never a toolkit config, argument, result or durable
receipt. Provider job files/logs stay on tmpfs. No physical memory-erasure
guarantee is claimed.

## Results, cleanup and no replay

```sh
copilot-mcp mcp-auth-execution-status --workspace-root /private/demo --project /private/demo/auth-session --json
copilot-mcp mcp-auth-execution-plan --workspace-root /private/demo --project /private/demo/auth-session --phase close --json --summary
```

Status reads local retained metadata only; it does not contact ATK or establish
that the tmpfs runtime survived a restart. Execute the close plan with its exact
token and `--allow-provider` to remove credentials/transient files. Close does
not delete cloud registrations or authorize a retry.

Session journals and workspace `.auth-registration-attempts` reservations are
exclusive and retained. Reservation occurs **before** registration dispatch;
failed, cancelled, malformed-output and unknown attempts remain consumed, even
after renaming a session or registration. Do not discard/move to a fresh
workspace to bypass a reservation. A crash after reservation may require manual
provider reconciliation, not replay. If subprocess termination is unconfirmed,
the operation lock retains its owned process-group PID; preserve both lock and
runtime until that process has been reconciled. No automatic lock recovery or
registration retry exists.

A successful dispatch with strictly parsed output writes `result.json` with
`status: created-unverified`, the opaque registration reference and, for SSO,
the Application ID URI. It does not verify settings, consent, endpoint audience,
FCC readiness or plugin operation. To import it, create a new preparation input
with the same exact registration request/descriptor and this source fragment:

```json
{
  "source": {
    "descriptorFile": "server/mcp-server.json",
    "registrationResultFile": "auth-session/result.json"
  }
}
```

Do not also set `registration.reference`. Plan/write a new preparation output,
then import that through FCC's `source.authenticationBundleFile`. Result digest,
request and descriptor must match; import does not upgrade readiness. Keep
provider session/results private and export only reviewed consumer metadata.

## Provider review and remaining qualification

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
authentication on Windows. The separate Linux adapter addresses those cache
routes without changing Microsoft's code, but actual host/browser/provider
qualification remains outstanding. No Docker startup, VM provisioning or shared
profile sign-in was attempted.

Remaining live gates: qualify the Linux runtime, actual ATK account/output
format and callback; supply the real app and selected identity; review each
effect phase; separately verify registration settings, consent and consumer
behavior. Generic OAuth registration does not implement provider MCP discovery,
token exchange or proof. WIQD mapping, package validation and consumer acceptance
remain separate.

Do not bypass these gates with ambient credentials, hidden token-store REST
calls, monkey-patched Microsoft code or a copied cache.

References:

- [Microsoft Entra SSO](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-entra-sso)
- [OAuth authentication](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-oauth)
- [ATK oauth/register action](https://aka.ms/teamsfx-actions/oauth-register)
- [Frozen Cowork guarded SSO adapter](https://github.com/svarukala/Cowork-Plugin-Toolkit/blob/b51d6a8645539591bd87f39354883e1bc6a2a7a8/src/sso-registration.js)
