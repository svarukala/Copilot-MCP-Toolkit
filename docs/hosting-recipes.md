# MCP hosting recipes

## Starting with no infrastructure

Use `mcp-bootstrap-schema`, then `mcp-bootstrap-plan --workspace-root
<private-root> --config <choices.json> --output <new-review.json> --json`.
Write with `mcp-bootstrap-bundle` and the exact plan approval token.
Choose existing/new group, environment, registry, vault and separate pull/reader
identities explicitly. This direct Container Apps bootstrap works **before**
source generation and emits separate resource-group and resource templates.
See the complete synthetic input in
[`container-apps-bootstrap.json`](../examples/mcp/container-apps-bootstrap.json);
replace its identities and choices rather than treating them as real resources.
Existing resources are omitted, not recreated. Directory setup uses existing
guarded `mcp-app-*` commands; actual returned client/object/scope/principal IDs
must be collected before the dependent step. Pending IDs are null/missing, not
fabricated UUIDs or runnable placeholders.

The bundle includes ordered diagnostics, build alternatives, permission intents
and secret-entry handoff. It does not start Docker, install tools, perform network
probes, pull private images or execute deployment. Use the separate
`mcp-host-*` operations below for diagnostics and private pulls; never replace
them with shared Docker login.
Use the existing Windows-safe Azure launcher rather than raw `az.cmd` string
interpolation. Inspect policy/costs/name absence, validate and what-if each
template separately. A local TLS failure never authorizes a paid cloud build.

## Environment diagnostics and private image pulls

`mcp-host-schema` describes four deliberately separate operations. Plan with
`mcp-host-plan --workspace-root <private-root> --project <private-project>
--config <operation.json> --output <new-result.json> --json --summary`.
The plan names every target, effect, time bound and required permission flag.
Run `mcp-host-run` with the same arguments, exact `--approve <approvalDigest>`
and only the applicable flags:

| Kind | Required flags | Scope |
| --- | --- | --- |
| `engine-diagnostic` | `--allow-local` | Read the explicitly selected local Docker engine version/platform; do not start it |
| `host-npm-diagnostic` | `--allow-network` | One reviewed registry DNS/TLS/HTTP probe from Node on the host |
| `container-npm-diagnostic` | `--allow-local --allow-network` | One reviewed registry probe in an already-present reviewed Node builder image, then remove only that owned temporary container |
| `private-image-pull` | `--allow-local --allow-network --allow-cloud` | Private Azure identity verification, transient ACR credential and exact-digest pull into the selected local daemon; no image execution |

Complete synthetic inputs are
[engine](../examples/mcp/host-engine-diagnostic.json),
[host npm](../examples/mcp/host-npm-diagnostic.json),
[container npm](../examples/mcp/container-npm-diagnostic.json) and
[private pull](../examples/mcp/private-image-pull.json). Replace synthetic
digests, identity and registry values; examples are not actual available images.
Diagnostics can use an existing empty private project directory. Private pull
requires the sealed **container recipe source project**, not its endpoint
reference; Functions is source-only and has no private-image-pull profile.

Both npm diagnostics accept an optional `registryProbe`. Omission preserves the
original `https://registry.npmjs.org/-/ping` target; it does **not** select the
registry configured by npm. In a restricted environment, explicitly select the
approved feed before planning:

```json
"registryProbe": {
  "kind": "package-metadata",
  "registryUrl": "https://packages.example.com/npm/",
  "packageName": "@example/mcp-runtime"
}
```

This is a synthetic example; replace the feed and package with reviewed values.
See [the complete configuration](../examples/mcp/approved-registry-diagnostic.json).
For feeds supporting npm ping, use `kind: "ping"` and omit `packageName`.
The registry URL must be HTTPS with a trailing slash, without credentials,
query strings, fragments, IP literals or a nonstandard port. Feed paths are
preserved; scoped package names are encoded as one path segment.
The exact derived URL, mode and package are approval-bound and shown in the plan.
Changing them requires a new plan/output/approval, not a fallback or retry.

The toolkit neither reads npm configuration/authentication nor changes `.npmrc`.
No Authorization header, credential cache, package download/install or proxy
configuration is used. Both host and container probes validate all DNS answers
as public addresses and pin one address, retain certificate verification, and
reject redirects. Private-address and authenticated feeds are not supported by
this diagnostic; a 401/403 is not permission to load credentials. A 404 on
`/-/ping` does not mean HTTPS is broken or the feed cannot serve packages.
An explicitly selected package-metadata probe checks only the HTTP response
status: it does not retain or validate package metadata, resolve dependencies or
qualify `npm ci`. A failed public-npm check is not a general host-network diagnosis
when policy blocks that registry.

Docker must already be running and support Linux/amd64 and Engine API **1.44**
(including accepting that API version). Choose the exact local pipe/socket:
`\\.\pipe\docker_engine`, `\\.\pipe\dockerDesktopLinuxEngine`,
`/var/run/docker.sock`, or `/run/user/<numeric-uid>/docker.sock`.
TCP/SSH endpoints and ambient `DOCKER_HOST`/Docker CLI context are not used.
`localEngineTrusted: true` is the owner's review of this privileged local
daemon and its administration/logging boundary, not toolkit attestation.
No Docker CLI installation, context change, engine start or implicit image
download is performed. The container probe requires an already-present
`node:22-bookworm-slim@sha256:...` image; it has no credentials, mounts, writable
root filesystem or retained logs, drops capabilities, runs as nonroot and has
bounded CPU/memory/process/time limits.

Before a private pull, select the exact tenant/subscription/user through
`mcp-host-account-plan` and separately approved `mcp-host-account-switch`,
using `--workspace-root`, the same sealed `--project`, `--tenant-id`,
`--subscription-id` and `--account-name`. Optional `--use-device-code` belongs
on both account commands and needs a real terminal. These reuse the existing
project-private Azure launcher/account guard; they neither switch the shared
account nor adopt a copied cache. Authentication does not grant ACR access.

The pull helper internally uses
[`az acr login --expose-token`](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-authentication#use-az-acr-login-without-docker-daemon)
with Azure CLI file logging and dynamic extension installation disabled. It
passes the credential only in memory through `X-Registry-Auth` to the reviewed
local Docker API, never through command arguments, shell output, Docker login
or a Docker config file. The header uses padded URL-safe base64, matching
[Docker's API authentication codec](https://github.com/moby/moby/blob/v25.0.0/api/types/registry/authconfig.go).
Debug-enabled daemons and non-loopback insecure-registry
CIDRs are rejected; review daemon/registry diagnostics independently. Identity
is checked again before the pull. Success additionally requires local inspection
of the exact requested repository digest and Linux/amd64 platform; it does not
establish image safety, source provenance, deployment or provider readiness.

Every run writes a new `<output>.intent.json` and a bounded result. Private pull
also creates an exclusive project reservation immediately before pull dispatch.
Diagnostics have a 60-second work budget; a container probe additionally allows
at most 20 seconds for owned-container inspection/removal. Private pull has a
10-minute work budget and waits for owned Azure process termination on cancel.
Empty/malformed output, daemon error or timeout after that boundary remains
`unknown-no-replay`; changing output filename cannot replay the same image/engine
purpose. Preserve the reservation and reconcile local image metadata manually.
A preflight failure is `blocked-before-pull`: no pull reservation was created,
so remediation can be followed by a separately approved new plan/output.
There is never an automatic retry. A failed or unconfirmed temporary-container
cleanup reports its unique name; it does not silently claim cleanup or delete
another container.

Diagnostics distinguish engine availability/platform, DNS, TLS, HTTP and
container-execution failures without returning raw logs. Passing a connectivity
probe does not verify `npm ci`, dependency compatibility or a provider API/key.
Local image building, paid ACR building, scanning and deployment remain separate
operator-reviewed operations. Do not disable TLS/integrity or authorize a
cloud build because a diagnostic failed.

## Terminal and consumer handoff

`mcp-terminal-handoff --workspace-root <private-root> --project <endpoint-reference>
--config <selection.json> --phase discovery --json` emits the exact reviewed
plan plus a PowerShell-quoted command. Nothing is launched. Run once in a real
terminal only after the plan's separate approval. Do not transcript challenges.
Use a separate `proof` handoff after metadata review. Protected steps still
use fresh process-local sign-in by default.

For an explicit single-process alternative, use
[`interactive-session.json`](../examples/mcp/interactive-session.json) with
`mcp-session-plan --workspace-root <private-root> --project <endpoint-reference>
--config <session.json> --json`. This profile supports only an existing Entra MCP
reference and requires the exact discovery client and expected user. The `proof`
section names the intended tool, arguments, safety review and optional
`resultAssertion`, but contains no capture or preapproved proof digest.
`mcp-terminal-handoff --phase session` can emit its exact quoted command.

After separate approval, run `mcp-session` with the same arguments,
`--approve <session-plan-digest> --allow-network --interactive` in a real
terminal. It performs discovery, displays the **new exact proof plan** on stderr,
and asks for that proof's approval digest; blank or any different answer stops
without a call. It then re-lists tools and uses the normal write-ahead proof
journal before at most one call. Discovery approval is not proof approval.
The access token remains in memory for at most 15 minutes and must still be
valid for the metadata budget. Tenant, client, audience/scopes, expected user,
source descriptor and endpoint must all match. Expiration, cancellation,
identity changes, failure or session exit clear the session; there is no
automatic refresh, relogin, cross-process cache or unknown-call replay.
The final stdout is bounded JSON with evidence references, never challenges,
tokens or provider response content. Native mapped/accepted/qualification proof
profiles retain their existing separate commands.

FCC `review.pocPolicyDeferral: true` can record a nonfinal policy deferral.
It never clears a placeholder/submission gate, but `phaseReadiness` explains
that separately authorized authentication troubleshooting can continue.
Provider shared-key entitlement and rollout permission remain distinct; a PoC
label is not a bypass. Use operator milestones for owner-reported authorization,
FCC save, Ready, audience, consumer execution and UI labels independently.

## First-call result shape and closeout

For a future **unused existing-MCP first proof**, add this to the proof selection:

```json
{
  "resultAssertion": {
    "kind": "json-array-string-field-v1",
    "field": "fact",
    "maxItems": 1,
    "maxStringLength": 4096
  }
}
```

It requires one MCP text content item containing a nonempty bounded JSON array;
each object must contain only that nonempty string field. Review the provider's
actual contract first. The selection is approval-bound and evaluated in memory
on the same call, never a second call to retrofit evidence. Output retains only
the structural verdict/digest, not content. It rejects error, ambiguous,
non-JSON and extra-field envelopes. A pass establishes neither fact accuracy
nor credential identity, legal entitlement or consumer acceptance. Consumed
proofs stay consumed even if the assertion is changed or removed.

The `secret-reference-review` recipe review checks operator-supplied enabled/
expiry metadata against the exact source reference and dedicated identity.
It does not read a secret, verify host resolution or grant permissions.
The `cost-closeout` review records exact ownership/dispositions and known versus
unquoted prices. Unavailable pricing is null, never zero. It proposes no removal
of pre-existing/unknown-owned resources and executes no cleanup.

Container Apps source may explicitly set `scaleProfile: "scale-to-zero"` (default
`"always-warm"`). This changes the minimum replica count to zero in **new**
reviewed source only; max replicas stays one. Review consumer cold-start limits
and all noncompute charges. App Service/Functions do not accept this setting.
Review temporary grants, directory objects and billing resources at closeout;
no guaranteed free tier, automatic teardown or proof reset is implied.

## Minimal images and qualification

New container source generation requires an explicit `imageBuild` object to
emit a Dockerfile. Without it, source generation still works for review, but
`recipe-review.json` reports `blocked-missing-digest-pinned-inputs` and **no
Dockerfile is generated**. There is no mutable-tag fallback. Historical sealed
projects are never rewritten. Functions retains its separate source-only build.

Supply reviewed, currently available images in this form (replace digests;
these placeholders are not accepted inputs):

```json
{
  "imageBuild": {
    "builderImage": "node:22-bookworm-slim@sha256:<64 lowercase hex digits>",
    "runtimeImage": "gcr.io/distroless/nodejs22-debian12:nonroot@sha256:<64 lowercase hex digits>",
    "platform": "linux/amd64"
  }
}
```

The multistage Dockerfile installs locked dependencies with scripts disabled,
then copies only runtime dependencies, application files and notices into the
distroless nonroot runtime. The container recipes accept only `linux/amd64`;
[Container Apps requires this architecture](https://learn.microsoft.com/en-us/azure/container-apps/containers#limitations),
and the App Service recipe uses the same bounded image profile. ARM64 and
Windows images are rejected before generation. Review and refresh base digests;
no image is downloaded or declared safe by generation.

Use `mcp-recipe-review-schema` and the `image-qualification` input for a
separate `mcp-recipe-review-plan/bundle` (explicit private workspace, sealed
project, config, new output JSON and exact write approval). It binds the source,
base digests/platform, builder-run evidence, SBOM, scan and network-disabled
nonroot actual-image smoke metadata to the same final image. The initial policy
requires zero critical/high findings and scan/database age no greater than 24
hours. Other findings remain visible; no exception is silently granted.

A release config may supply `imageReviewFile`, resolved relative to that config.
The review is revalidated against source, image and freshness; invalid evidence
blocks preparation. Release without it remains explicitly unqualified and
operator-reviewed, not authorization to deploy. Imported evidence is an
operator declaration, not proof the scanner ran or a verified signed build
attestation. No scan, image build/push, registry login or provider call is
performed by these commands. Actual container execution remains a separately
reviewed qualification step.

## Operator records and resumable handoffs

### Preserving updates, not create-template reuse

`mcp-recipe-review-*` also supports these local review kinds:

| Kind | Required operator input | Result |
| --- | --- | --- |
| `container-app-image-update` | Fresh writable resource baseline, concrete ETag, baseline digest and selected-registry image | Separate template changing only the named `mcp` container image; preserves all supplied settings. Optional complete normalized preview must match exactly |
| `container-app-readiness` | Exact resource/image/revision, deadline and metadata observation | Waiting, timeout/unknown, failure or matched healthy 100%-traffic readiness; never redeploys |
| `entra-sso-update` | Exact tenant/app object, baseline projection/digest, actual registration URI and existing enabled scope ID | Additive identifier URI, redirect and token-store preauthorization PATCH; never touches credentials or assignment restrictions |
| `authentication-impact` | Prior runtime authentication and whether correction is portal-only | Ordered required stages; preserves old artifacts and consumed proof |

The baseline must be a reviewed **writable resource**, not an unfiltered Azure
GET containing read-only fields or secret values. Keep its source receipt
privately. A copied/imported baseline, preview or readback is not authenticated
Azure evidence. Reinspect the exact baseline immediately before any separately
approved mutation; use supported conditional writes where available. ARM
what-if is not an atomic concurrency guard. Missing defaults must not be
silently discarded during a create-style redeployment.

For Entra reconciliation, known unordered identifier/redirect/client collections
are compared semantically. Unexpected changes, including service-generated
settings outside the expected projection, remain a mismatch for review; do not
ignore arbitrary differences or repeat PATCH. An old ready revision after ARM
success is not a failed deployment. Readiness observation may continue only
within its reviewed metadata budget and never authorizes a new deployment,
rollback, traffic change or provider call.

`mcp-operator-schema` describes a separate, local operator journal. Use
`mcp-operator-plan --workspace-root <private-root> --project <private-project>
--config <event.json> --json`, then `mcp-operator-record` with the same arguments
and the exact `--approve` token. Read it with `mcp-operator-status`.
Each event is immutable; writes are serialized and bound to the current head.
This is an operator-declaration record, not an Azure attestation or executor.

Reserve the exact tenant/account/target, purpose, input digest and reviewed
authorization digest. **Record dispatch before running an external command.**
Missing stdout, malformed output, timeout and lost responses stay unknown.
Record separately obtained metadata digests to reconcile; never resubmit merely
because parsing failed. A reserved purpose stays consumed even if inputs change.
Deployment stages distinguish provisioned, revision-ready, traffic-ready and
endpoint-checked; no stage itself changes traffic or triggers a provider call.
Existing proof journals remain the authority for tool-call consumption.

At an unavailable-owner gate, record one `wait` event with a specific phase,
reason and resume trigger. Repeated waiting/dispatch records are refused.
The host must honor `repeatPrompt: false` and stop rather than poll or falsely
complete. An explicit `resume` references the waiting receipt and the digest
of new owner input. `owner-result` records a named milestone as owner-reported:
authorization success cannot make FCC save, admin Ready, audience, consumer
execution or UI labels verified. Read-only status always carries the selected
private workspace through the command's explicit arguments.

The recipes use the same Node.js MCP server. Hosting changes; tool logic and
caller permissions do not. Each operation below is explicit and local unless
the operator separately chooses to build, publish, deploy or test.

| Recipe | Existing prerequisites | Complete synthetic input |
| --- | --- | --- |
| [1. Direct Container Apps](container-apps-recipe.md) | Environment, ACR and image-pull identity | `examples/mcp/container-apps-direct.json` |
| [2. Container Apps with APIM](apim-gateway-recipe.md) | Recipe 1 prerequisites plus APIM, gateway resource app and identity role assignment | `examples/mcp/container-apps-apim.json` |
| [3. App Service](app-service-recipe.md) | Linux Basic-or-higher plan, ACR and image-pull identity | `examples/mcp/app-service-container.json` |
| [4. Functions (preview)](functions-recipe.md) | Linux FC1 plan, blob storage/container and storage identity | `examples/mcp/functions-sdk.json` |

All four are implemented for **local generation, release preparation and explicit
endpoint-reference creation**. Cloud deployment remains an operator workflow;
real host behavior and Copilot Read-only labels are not yet qualified.
All support Entra delegated callers and one anonymous or **Key Vault API-key**
JSON backend with explicitly reviewed, parameter-free GETs. They do not add
backend OAuth, username/password, arbitrary arguments or write tools.

## API-key backends

The same `backend` shape works with every recipe and the original direct-only
commands. Anonymous inputs remain unchanged. Complete fictional API-key inputs:

| Host | Input | Placement |
| --- | --- | --- |
| Direct Container Apps | `examples/mcp/container-apps-direct-api-key.json` | Header |
| Container Apps with APIM | `examples/mcp/container-apps-apim-api-key.json` | Query |
| App Service | `examples/mcp/app-service-container-api-key.json` | Header |
| Functions | `examples/mcp/functions-sdk-api-key.json` | Query |

Both placements work on all four hosts. Prefer a dedicated header if the
provider supports it. Replace the example values with reviewed **references**,
never actual keys:

```json
{
  "origin": "https://private-data.example.com",
  "auth": "api-key",
  "apiKey": {
    "tenantId": "11111111-1111-4111-8111-111111111111",
    "keyVaultResourceId": "/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/rg-synthetic-secrets/providers/Microsoft.KeyVault/vaults/synthetic-vault",
    "identityResourceId": "/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/rg-synthetic-secrets/providers/Microsoft.ManagedIdentity/userAssignedIdentities/synthetic-secret-reader",
    "secretIdentifier": "https://synthetic-vault.vault.azure.net/secrets/backend-access/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "headerName": "X-Backend-Key",
    "sharedAccessReviewed": true
  }
}
```

Use exactly one `headerName` or `queryParameterName`. For query placement,
replace `headerName` with `"queryParameterName": "api_key"` and explicitly set
`"queryExposureReviewed": true` **only after** reviewing and preventing key
exposure in backend, intermediary, proxy, platform and telemetry URL logs.
The toolkit cannot inspect those systems. If safe logging cannot be established,
do not deploy a query-key recipe. Header values also need logging protection.
`sharedAccessReviewed: true` declares that every permitted caller may use this
one service entitlement and access the selected data under the provider's terms.
These declarations are owner reviews, not observed enforcement or evidence.
There is no per-user credential selection or source-data filtering.

Header names use letters, digits and hyphens, starting with a letter (100
characters maximum). Query names also allow dots and underscores. Reserved
authorization, cookie, gateway-proof, MCP, transport, forwarding and routing
names (including method-override and original/rewrite-URL headers) are rejected.
Provider-specific dedicated names such as `X-API-Key`,
`Ocp-Apim-Subscription-Key` and `x-functions-key` are allowed.
`Authorization`/Bearer, cookies, custom prefixes, multiple
keys and raw credential fields are unsupported. Query values are URL-encoded by
the runtime, never part of an authored path or tool argument.

If OpenAPI declares security globally or on a selected operation, it must name
exactly one `type: apiKey` scheme whose `in` and `name` match the reviewed
placement (header names are case-insensitive; query names are case-sensitive).
Scopes must be empty. Optional/alternative/mixed profiles, references, OAuth,
cookie keys and explicit anonymous overrides are rejected. Omitted security is
allowed with the explicit reviewed backend auth; it never overrides that auth.
Do not model the key as an operation parameter: tools still take no arguments.

### Identity, deployment and secret resolution

The vault and secret-reading user-assigned identity must already exist in the
selected subscription and tenant. The reference's vault hostname must match
`keyVaultResourceId`. Public Azure `vault.azure.net` HTTPS secret URIs support
either an exact 32-hex version or no version; no ports, credentials, queries or
fragments. Prefer a version when a rollout must use exactly reviewed material.
The vault may be in another resource group in the same subscription.

`identityResourceId` must differ from the image-pull or Functions storage
identity. The generated host attaches both identities but selects the dedicated
one only for Key Vault references. No identities, vaults, secrets, RBAC roles or
access policies are created or modified. The runtime never requests a managed
identity token or calls Key Vault. Inspect the actual tenant/resource bindings,
identity principal, least-privilege pre-existing secret **Get** access (for
example Key Vault Secrets User at the narrow appropriate scope), secret
enabled/expiry metadata and network reachability separately with the selected
private tenant/subscription/account. Local validation cannot attest to these facts.
Do not grant Key Vault rights to a shared pull/storage identity to bypass a failure.

| Host | Generated reference |
| --- | --- |
| Container Apps (direct and APIM) | App secret `mcp-backend-api-key` with `keyVaultUrl` and dedicated `identity`; container `MCP_BACKEND_API_KEY` uses `secretRef` |
| App Service and Functions | `MCP_BACKEND_API_KEY` app setting uses `@Microsoft.KeyVault(SecretUri=...)`; site `keyVaultReferenceIdentity` selects the dedicated identity |

App Service's identity selection applies to **all** Key Vault references on the
site. These templates are for a new, name-absence-reviewed site, not a merge into
an existing site's settings. Container Apps image pull and Functions host and
deployment storage continue using their original explicit identities.
Recipe 2 does not put the backend key into APIM: gateway and caller tokens are
still independently verified by the SDK and neither is forwarded to the REST API.

Reference/identity/placement/declaration changes alter source hashes and exact
creation/release approvals. Use a new reviewed project and release rather than
editing a sealed project or reusing an old approval. Source/release files contain
references only; they never resolve a secret. Deployment, Key Vault/network
inspection, image/source publication and reference-resolution checks remain
separately approved operator operations.

### Startup, failures and rotation

The host injects the resolved value into `MCP_BACKEND_API_KEY`. API-key mode
refuses to start if it is missing, empty, longer than 4096 characters, contains
whitespace/non-ASCII/control characters, looks like an unresolved platform
reference/URL, or contains angle-bracket placeholders. There is no anonymous
fallback. A valid-looking but incorrect, expired or revoked value cannot be
detected without a separately approved backend call. Anonymous mode ignores the
credential environment variable.

The server snapshots the credential at startup. It has no application refresh
loop, token exchange, key fallback or automatic call retry. A call is one fixed
HTTPS GET with redirects refused, a 10-second deadline and a 1 MiB JSON bound.
Backend errors, non-JSON, redirects and obvious reflection of the key (including
JSON escapes, URL encoding and Base64) produce a generic tool error and fixed
event log, never the error body, key or authenticated URL. This is a conservative
reflection check, not general DLP: transformed/partial secrets may evade it and
short keys may cause false positives. Review backend data and diagnostics.
Timeout/failure does not establish nonexecution; never replay automatically.

With **versionless references**, Azure documents Container Apps fetching the
latest version within 30 minutes and restarting active revisions that consume
it as an environment variable. App Service/Functions cache references and
refetch within 24 hours; app configuration changes cause restart and immediate
refetch, and a separately authorized management refresh endpoint exists.
Do not assume every running worker has switched immediately. Independently
verify resolution and worker restart for the intended rollout; the SDK itself
only sees its startup snapshot. Version-pinned references do not follow new
versions: generate/review/deploy the changed reference and restart as needed.
Old credentials may persist in platform caches/process memory during rotation;
coordinate overlap/revocation with the provider. Rotation is not approval to
retry failed/unknown tool calls.

### Local execution with API keys

Local Node/Functions Core Tools do **not** resolve Azure platform reference
strings. Install the generated locked dependencies only under separate approval,
then use an organization-approved secret launcher to resolve the exact reviewed
Key Vault reference with a project-private, explicitly selected identity and
inject `MCP_BACKEND_API_KEY` into the server process. This is a separate live
secret-read approval, not part of generation or an offline test. Do not paste
keys into prompts, shell arguments/history, `.env`, local.settings.json,
runtime-config.json, source, container builds or logs. No key value belongs in a
saved file, even if gitignored. Remove the environment value when the process exits.

For operators who already use the separately installed/reviewed Az PowerShell
module, the equivalent in-memory launch pattern below assumes `$privateContext`
was authenticated privately with context autosave disabled, and its exact
tenant/subscription/account were independently verified. Do not use an ambient
shared context. Set PUBLIC_MCP_URL/host settings per the host guide first:

```powershell
# Separate approved secret read; metadata below is fictional.
try {
  $env:MCP_BACKEND_API_KEY = Get-AzKeyVaultSecret -DefaultProfile $privateContext `
    -VaultName 'synthetic-vault' -Name 'backend-access' `
    -Version 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' -AsPlainText -ErrorAction Stop
  node .\server.js
} finally {
  Remove-Item Env:\MCP_BACKEND_API_KEY -ErrorAction SilentlyContinue
}
```

For a separately reviewed local Functions host use `func start` instead of
`node .\server.js`, preserving the same process-only secret injection.
Do not enable transcripts/debug tracing or print the environment. Startup
without an injected valid-format key fails before health/MCP are available.
Local execution still requires real caller tokens (and gateway proof for recipe
2); there is no auth bypass. Repository tests instead inject synthetic values
and transports and never contact Key Vault or a provider.

Official platform contracts reviewed for this implementation:
[Container Apps secrets](https://learn.microsoft.com/azure/container-apps/manage-secrets)
and [App Service/Functions Key Vault references](https://learn.microsoft.com/azure/app-service/app-service-key-vault-references).
Documentation support is not live qualification of these templates.

## Choose, review and generate

Copy the selected fictional example into an existing private workspace. Replace
it with actual reviewed settings; never deploy the example as-is. Review the
host-specific guide above, then:

```powershell
node .\bin\copilot-mcp.js mcp-hosting-schema --json
node .\bin\copilot-mcp.js mcp-hosting-plan --workspace-root C:\McpProjects `
  --config C:\McpProjects\input.json --output C:\McpProjects\server --summary --json
node .\bin\copilot-mcp.js mcp-hosting-create --workspace-root C:\McpProjects `
  --config C:\McpProjects\input.json --output C:\McpProjects\server `
  --approve '<exact current approvalToken after review>' --json
```

Use the installed `copilot-mcp` command in place of `node .\bin\copilot-mcp.js`
if installed. The commands below use that shorter form.
The original `mcp-container-apps-*` commands intentionally remain recipe-1-only.
These source projects are not part of the terminal wizard or APIM Resume flow.
Source generation cannot log in, install dependencies or change Azure.

## Source, release and endpoint are different things

1. **Generate source.** Review the selected recipe input and save a new project.
   `recipe-manifest.json` records hashes of all generated files. It is an
   integrity record, not a signature, security audit or deployment receipt.
2. **Prepare a release.** Review the source and an immutable deployment artifact.
   The toolkit packages source and exact deployment templates without executing
   a shell, logging in, building an image or changing Azure.
3. **Deploy separately.** Use project-private authentication with the exact
   tenant, subscription and account. Inspect prerequisites, name collisions,
   ownership, inherited policies, costs, network and role assignments first.
   Review what-if and approve the exact deployment before running it.
4. **Reference the actual endpoint.** Supply the actual URL after separately
   checking deployment. The toolkit creates a new existing-MCP reference with
   the same authentication settings, not a fabricated deployment receipt.
5. **Discover, prove and onboard separately.** Existing discovery/proof/FCC
   commands can use that reference. They still require actual fresh tools/list
   evidence and separate approvals; generated annotations are never captures.

## Prepare a container release

Create a private JSON input:

```json
{
  "schemaVersion": 1,
  "accountName": "operator@example.com",
  "containerImage": "syntheticregistry.azurecr.io/mcp@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

These are fictional values. Use your exact account and separately built,
scanned and approved image digest in the registry selected by the recipe.
The toolkit binds that image reference to the release review, but cannot prove
that an externally built image contains the reviewed source.

```powershell
copilot-mcp mcp-recipe-release-plan --workspace-root C:\McpProjects `
  --project C:\McpProjects\server --config C:\McpProjects\release.json `
  --output C:\McpProjects\release-review --summary --json
```

Review all output. Save the files only after explicit local-write approval:

```powershell
copilot-mcp mcp-recipe-release-bundle --workspace-root C:\McpProjects `
  --project C:\McpProjects\server --config C:\McpProjects\release.json `
  --output C:\McpProjects\release-review --approve '<exact current token>' --json
```

The output contains source.zip (no installed node_modules), deployment templates,
per-template parameters and release-review.json. Source licenses/notices are included.
The original source manifest and every file must still match; edited source
requires a newly reviewed generated project or an independent operator workflow.
Do not rewrite an old manifest just to pass an integrity check.

These commands are **not deployment commands**. Templates can update existing
resources if manually misapplied. They provide no atomic ownership/no-overwrite
guarantee, inspection of Azure state or permission to replay failed deployments.
Private account setup, prerequisite review, what-if and actual deployment remain
operator actions. No hidden az command or subprocess is run.

## Use a deployed endpoint with discovery and FCC

Create a private endpoint input after separately confirming its actual URL:

```json
{
  "schemaVersion": 1,
  "serverId": "66666666-6666-4666-8666-666666666666",
  "endpoint": "https://actual-reviewed-endpoint.example.com/mcp"
}
```

Use a new server ID for the new reference. Do not use a new reference to bypass
consumed historical proofs or retry an unknown call.

```powershell
copilot-mcp mcp-recipe-reference-plan --workspace-root C:\McpProjects `
  --project C:\McpProjects\server --config C:\McpProjects\endpoint.json `
  --output C:\McpProjects\endpoint-reference --summary --json
copilot-mcp mcp-recipe-reference-create --workspace-root C:\McpProjects `
  --project C:\McpProjects\server --config C:\McpProjects\endpoint.json `
  --output C:\McpProjects\endpoint-reference --approve '<exact current token>' --json
```

The result is a normal `existing-mcp` project plus `recipe-origin.json`. Its
status is **referenced-not-verified**, never deployed or consumer-ready. It
contains no imported/generated tools capture. Use existing MCP discovery on
this new reference, with the actual authorized discovery client and expected
user. Do not run the APIM resource lifecycle on the source or reference.

For FCC, use only the resulting real observed capture and separately prepared
SSO registration. Nothing here registers a connector, provisions a WIQD app,
broadens a rollout audience or proves the UI labels.

## Checks still needed in the real environment

Check the selected host's prerequisites, image/source deployment, actual URL,
rejection of invalid callers and authorized tools/list. For recipe 2 also check
gateway-token issuance, inherited policies and direct-host bypass rejection.
For recipe 4 check preview availability, remote build and the actual Functions
host. For API-key mode, also inspect the selected vault/identity, reference
resolution, safe diagnostics, missing/invalid-key rejection and rotation/restart
behavior without exposing keys. Then separately approve one tool call and inspect annotations and actual
Copilot Read/Write labels. Preserve failed/unknown attempts; a new source or
reference does not authorize replay.
