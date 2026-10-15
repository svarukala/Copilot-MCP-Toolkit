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

### User-managed WIQD Windows handoff

This is the simpler native Windows route: MCP Toolkit prepares nonsecret
registration data; the operator runs WIQD's normal sign-in and provisioning
workflow, then returns only the registration reference. WIQD owns its normal
user-profile credentials. The toolkit neither reads those credentials nor claims
to isolate WIQD's profile. No WSL, Linux, copied cache or new authentication
system is needed for this handoff.

Create a private configuration matching `mcp-auth-wiqd-schema`:

```json
{
  "schemaVersion": 1,
  "registrationConfig": "registration.json",
  "wiqdProject": "existing-wiqd-project",
  "environment": "dev"
}
```

The registration input is the existing `mcp-auth-registration-schema` contract.
The WIQD directory must already exist in the selected private workspace. The
toolkit does not create a dummy app, inspect the project's contents, or infer its
app ID. The handoff output must be outside that WIQD project to avoid adding or
changing its files. `examples/auth-registration/wiqd-handoff.json` is synthetic guidance.

```powershell
copilot-mcp mcp-auth-wiqd-plan --workspace-root C:\private\demo --config C:\private\demo\wiqd-handoff.json --output C:\private\demo\wiqd-review.json --json --summary
copilot-mcp mcp-auth-wiqd-bundle --workspace-root C:\private\demo --config C:\private\demo\wiqd-handoff.json --output C:\private\demo\wiqd-review.json --approve "EXACT_CURRENT_PLAN_TOKEN" --json
```

That approval writes **one new JSON handoff only**, binding the selected
registration inputs, operator, target project/environment, build and destination.
It does not approve any provider command. The handoff contains argument arrays
and quoted PowerShell commands for version, interactive login, validation and
provisioning, plus the exact `oauth/register` action and return-field mapping.
The JSON handoff is not itself a WIQD input file or a provisioning lifecycle.

The operator must merge the action through WIQD's supported authoring workflow
into both lifecycle files, preserving existing actions/references. Verify the
actual app ID and restrictions; never silently change `SpecificApp` to `AnyApp`.
Run sign-in from a real terminal and verify the actual account/tenant. Then
validate the exact project/environment and **review every effect in the whole
provisioning lifecycle** before provisioning. This may create/update/publish app
resources beyond the registration: the toolkit does not certify or authorize
those effects, bypass EULA/consent gates or orchestrate execution.

SSO and secretless OAuth PKCE receive review actions when a real app ID is
provided. Missing app IDs, confidential-client secret resolution, or an existing
reference suppress all provider commands. Existing references must not trigger
recreation. Failed/unknown attempts require provider reconciliation, not reruns.

After successful operator-run registration, copy only `MCP_AUTH_REGISTRATION_ID`
and, for SSO, `MCP_AUTH_APPLICATION_ID_URI` into `registration.reference` in a
new registration-input file. Use the existing preparation plan/bundle commands
with a fresh output, then import that preparation into FCC through
`source.authenticationBundleFile`. Opaque punctuation/padding is preserved.
Do not import the WIQD handoff directly as an authentication bundle, and do not
copy whole environment files, tokens or raw logs.

References remain `provided-unverified`; settings, consent and actual consumer
execution remain separate. Historical version-1 preparation content is unchanged.
The Linux executor below remains an independent, separately approved option.

### Windows-first isolation check

On 2026-10-15, the user requested a Windows-first attempt before Linux fallback.
A non-authenticating child-process probe redirected HOME, USERPROFILE, APPDATA
and LOCALAPPDATA. Node reported the redirected home, but the child's Windows
security principal was unchanged. No credential store, token cache, account list
or sign-in was accessed by this probe.

Inspection of installed ATK 1.1.17 confirmed:

- `m365Login.ts` configures `NativeBrokerPlugin` on Windows. Its installed module
  resolved successfully; this is not a claim that a live broker was exercised.
- `cacheAccess.ts` uses the fixed Credential Manager service
  `Microsoft 365 Agents Toolkit` with the cache name as its key account. The
  installed keytar module resolved successfully. Redirected folders do not
  establish a separate Windows credential-store boundary.
- `accountLoginM365.ts` signs out before login and exposes a tenant selector,
  not an isolation selector. No supported control to isolate both broker and
  credential-store access was found in the inspected implementation.

**The same-Windows-user folder-redirection approach did not pass the isolation
precheck.** ATK login was deliberately not attempted to discover its impact on
real credentials. This does not prove Windows isolation is impossible: a
separate Windows VM/Sandbox or OS identity is a different approach that needs
its own qualification. Windows Sandbox was not available in the inspected
environment; no Windows feature, account or VM was created.

The fallback check used an existing WSL 2 Ubuntu environment and a private,
checksum-verified official Node.js 22.23.3 binary, without changing system Node
or loading a user shell profile. Seven focused offline provider checks passed,
including actual Linux tmpfs creation, permission rejection and cleanup.
The other checks used synthetic subprocesses/account output, not real ATK login.
This is not full Linux packed-consumer or live provider qualification.

Node, ATK and a Linux browser were not found on the initial clean system paths;
that does not enumerate user-managed installations. Public npm metadata
retrieval for the pinned ATK version failed TLS negotiation in both PowerShell
and Node. Certificate validation was not disabled, and no alternate provider
version was installed. The temporary Node tooling was removed after the check.
The following continuation resolved the package-access/setup issue without
weakening TLS verification.

### WSL fallback continuation

Public registry access succeeded from the selected WSL environment. Official
Node 22.23.3 (checksum verified) and ATK 1.1.17 were installed in a separate
private session tooling directory. Installation used fresh npm configuration
paths, a private cache, the public registry and `--ignore-scripts`; no global
Node/npm configuration, shared authentication cache or provider source was
changed. These tools are local session prerequisites, not repository dependencies.

The real installed ATK `--help` entry point completed under the adapter's private
tmpfs/environment with networking denied by the probe. The probe admitted only
ATK's inspected read-only machine-ID shell command; it did not stub provider
results or allow other subprocess commands. No account cache was created, and
the owned tmpfs runtime was removed and its absence checked.

That probe also identified a nonessential startup request:
`GET https://default.exp-tas.com/vscode/ab`. ATK initializes its experimentation
service even with `--telemetry false`; the service supplies a machine-derived
client identifier and CLI metadata. The request was blocked before network
dispatch in the probe. A zero-request expectation was therefore incorrect:
successful offline startup here means the CLI operated with that known request
blocked, **not** that unmodified ATK never attempts networking. Login/register
plans and their stderr summaries now disclose this additional provider effect.
No supported opt-out was found in the inspected experimentation initializer.
The test's network guard is not a production egress firewall.

A separate synthetic Linux loopback server was reachable from Windows at
`127.0.0.1`; the unique response marker matched and the server then exited.
This checks WSL localhost forwarding, not Microsoft sign-in or browser policy.
It allows a Windows browser to be considered for the callback rather than
requiring a second browser installation inside Linux. Recheck the route on the
actual host before use; never assume all WSL/network modes support it.

The inspected ATK `open` dependency has a WSL-specific browser-launch path
through Windows PowerShell. `BROWSER=/bin/true` does **not** guarantee suppression
of that path. Login approval now explicitly discloses that ATK may open the
Windows default browser. Private ATK token/cache storage does not isolate browser
cookies, browser history or OS logging. The toolkit itself neither records the
authentication URL nor selects a browser account; the operator must review the
actual account/organization before registration. No browser was launched by the
startup or loopback probes.

Private Node/ATK tooling is retained for subsequent separately approved work;
temporary download and probe runtime files are cleaned up. Live browser sign-in,
tenant/account verification and registration remain unperformed and require
their original independent reviews.

The toolkit therefore keeps its Windows execution guard and the explicit Linux
fallback. It does not silently start WSL, install tooling, copy credentials or
retry a registration on another platform.

### Native Windows WIQD investigation

The installed WIQD 0.18.0 Core backend demonstrates a Windows alternative to
ATK's sign-in behavior: interactive sign-in requests `select_account` and does
not begin with ATK's unconditional sign-out. Its supported
`disableBrokeredAuth` setting selects browser authentication instead of the
native broker. This is evidence for a simpler native Windows user experience,
not evidence that our ATK executor can reuse a WIQD session.

Read-only inspection of the installed Core implementation also found that
tokens live under the provider's home-relative `.wiqd/account` directory, but
the encryption key is retrieved or created through the fixed Credential Manager
service `wiqd`, account `appStudio`. Redirecting HOME and disabling the broker
does not independently scope that key lookup/write. The inspected key-storage
failure path can fall back to unencrypted cache content. No configurable
credential-key namespace was found in that implementation. No credential store
was accessed to make these observations.

Consequently, neither an account picker nor the browser setting alone qualifies
a project-isolated WIQD execution adapter. Do not change the user's shared WIQD
settings, invoke its aggregate login/status/logout, extract its refresh token,
or copy its cache to ATK as a workaround. WIQD status can silently acquire and
persist tokens; it is not an offline isolation probe.

Further inspection identified a distinct, cache-free CI backend using a
caller-supplied delegated refresh token and explicit tenant. It does not use
the interactive backend's shared encryption key, but is not a replacement for
interactive login: WIQD rejects interactive overrides in that mode. Its public
credential-bootstrap command requires a real terminal and deliberate human
confirmation before revealing a new credential. Do not capture that disclosure,
reuse an existing session's token, or manufacture CI credentials to bypass
these requirements. A separately reviewed fresh-credential bootstrap and secure
delivery design would be necessary before using this backend in our executor.

The native adapter remains unimplemented pending a supported private credential
boundary and a reviewed registration-only interface covering both MicrosoftEntra
SSO and Custom OAuth. An independent browser/MSAL implementation is another
possible approach, but it still needs supported registration integration; a
successful login alone would not close that gap. Keep existing ATK platform
guards and phase approvals until a replacement is actually qualified. Do not
advertise a native Windows registration capability from this source inspection.

### Linux execution prerequisites and phases

Use a trusted Linux host with Node.js 22+, an existing ATK **1.1.17** installation,
`/dev/shm` backed by tmpfs, and a browser able to reach the Linux loopback callback.
The browser can be on Linux or on Windows through separately verified WSL
localhost forwarding. This is not support for arbitrary remote callbacks.
No installation, Docker startup, browser automation or cache transfer
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
| `login` | `--allow-provider --allow-network --interactive` | Public ATK sign-in to the explicit tenant; may launch the Windows default browser under WSL, or the operator can open its displayed URL with verified access to the Linux callback |
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
