---
name: copilot-mcp
description: Review and generate REST-to-MCP APIM bundles or bounded Container Apps, App Service and Functions SDK recipes; prepare custom federated connector drafts and safely resume or preserve MCP evidence. Not plugin authoring or arbitrary OAuth/server generation.
---

# Copilot MCP Toolkit

Use the user's installed `copilot-mcp` bin or explicit
`node <package-path>/bin/copilot-mcp.js`. Ask for its location if unknown; do not
install globally, download a runtime or search private directories. Use the same
engine for all operations. First read `--help` and `capabilities --json` from that
installation, then its `docs/cli-contract.md` and `docs/scenarios.md` as needed.

## New or resume

When the user requests hosting without APIM, or needs server-owned tool
annotations, first read `docs/hosting-recipes.md`, the chosen host guide and
`mcp-hosting-schema --json`. In order: direct Container Apps, Container Apps behind
APIM, App Service, Functions. Use `mcp-hosting-plan/create` with an explicit
private workspace/new directory. `mcp-container-apps-*` remains recipe-1-only.
Generation is local and is not part of the terminal wizard or APIM Resume.

For container hosts, collect the reviewed `imageBuild` builder/runtime digests
and platform before source generation. Without them the toolkit deliberately
does not emit a Dockerfile; never substitute a mutable tag or edit sealed source
in place. Generate a new project after selecting the inputs. Use the separate
`mcp-recipe-review-*` image-qualification contract for digest-bound scan, SBOM
and offline actual-image smoke evidence, and bind it as `imageReviewFile` in a
new release review. Imported receipts are operator declarations, not signed
attestations. Never build, pull, scan or deploy merely to fill a missing field.

For an all-new direct Container Apps scenario, start with `mcp-bootstrap-*`.
It emits separate prerequisite templates and reuses `mcp-app-*` for directory
setup. Never make up app/principal IDs; obtain readback before dependent review.
Use `mcp-recipe-review-*` for image qualification, image-only Container Apps
updates, additive Entra settings, asynchronous readiness, auth migration impact,
secret metadata and cost/closeout. Existing-resource migration is not safe
create-template reuse. A successful ARM result may precede a ready revision;
observe exact metadata rather than redeploying.

Use `mcp-host-schema/plan/run` for separately approved engine, host/container npm
diagnostics. Confirm the approved registry first; do not assume public npm is
allowed. Set `registryProbe.registryUrl` explicitly for another feed, with
`kind: "ping"` or `kind: "package-metadata"` plus a reviewed `packageName` when
ping is unsupported. The plan binds the exact URL; do not import registry
credentials, install a package or change `.npmrc` to test connectivity.
Use the same command family for private ACR pulls. Read the guide's exact local socket, existing
image and local/network/cloud flags. Never start Docker, auto-pull a probe image,
disable TLS/integrity or turn a failed local diagnostic into paid build approval.
Private pull requires `mcp-host-account-plan/switch` on the sealed source project,
an exact digest and trusted nondebug local daemon. No shared Docker login or
saved registry credential. Preserve result/intent and pull reservations; unknown
dispatch is not retried under a new output name. Unconfirmed cleanup is a blocker.

Use `mcp-terminal-handoff` for exact quoted discovery/proof commands, each with
its own review, in a real terminal. No browser automation, challenge transcripts
or token-cache sharing. Cross-process sign-ins remain separate.
The optional `session` phase / `mcp-session-plan` uses the dedicated session
config for existing Entra MCP references, an explicit expected user and a
15-minute in-memory lifetime. After discovery, the user must approve the newly
displayed exact proof digest; do not preapprove, auto-answer or infer that grant
from discovery approval. Blank declines. Expiry/cancellation never refreshes,
restarts login or replays a sent/unknown call automatically.
For a future unused existing-MCP first proof, a reviewed `resultAssertion`
json-array-string-field-v1 can check a bounded array/string contract in that
same call. Never retrofit it by repeating an already consumed call.
`scaleProfile: "scale-to-zero"` is an explicit new Container Apps source choice,
not a default or free-tier promise. Closeout is separately reviewed and never
automatic.

Explain the current boundary in plain language: Entra sign-in for callers,
anonymous or Key Vault API-key JSON backend, selected fixed GETs with no arguments, and existing
host prerequisites from the guide. Ask for actual resource
choices and IDs, not fabricated placeholders. Require explicit read-only review;
do not claim annotations independently prove backend behavior. Use the plan's
exact `approvalToken` after approval to save files. Never substitute the APIM
schema or lifecycle, fabricate a compatibility descriptor, install dependencies,
build/push an image, sign in, deploy or call the endpoint as part of generation.
After generation, use the separate `mcp-recipe-source-plan` and
`mcp-recipe-release-plan/bundle` only for reviewed local preparation. Deployment
remains an operator action with separate private identity/prerequisite/what-if
review, not `mcp-resume`. Recipe 2 requires both a signed gateway token and the
original delegated caller; never bypass the gateway with a plain header.
App Service needs the pull identity's client ID as well as its resource ID.
Functions is an explicit preview opt-in, Linux FC1, stateless custom handler with
managed-identity blob storage and a source ZIP, not a container.

For API-key REST backends on any of these four recipes, read the shared guide's
API-key section and the selected `examples/mcp/*-api-key.json` format. Collect
only the explicit tenant, vault resource ID, secret URI and **separate**
pre-existing user-assigned secret-reader identity ID, plus one dedicated header
or query name. Never ask for a key value or copy it into tools, files or logs.
Confirm shared backend entitlement before `sharedAccessReviewed: true`; for
query keys also require safe backend/intermediary/platform URL logging review
before `queryExposureReviewed: true`. Prefer a header where the provider permits.
Match any selected OpenAPI API-key security declaration exactly; reject mixed
auth rather than stripping it. Never reuse the pull/storage identity or grant
roles to make this work. Missing/unresolved injected keys fail startup; do not
suggest anonymous fallback, removing caller checks or retrying a dispatched call.
Generation/release use native Key Vault references, not a live secret read.
Local launch needs separate approved, process-only secret resolution/injection;
read the guide rather than pasting key values into shell commands or settings.
Rotation/refresh, deployment and actual backend compatibility remain separate
live checks. Keep installed skill copies unchanged unless explicitly requested.

After separate deployment/readback, an explicitly supplied endpoint can use
`mcp-recipe-reference-plan/create` to create a new unverified existing-MCP project.
Use that reference for existing discovery/proof/FCC commands, not the source
project. Require fresh observed metadata and separate approvals. Never treat
generated annotations, source manifests, image digests or endpoint assertions
as consumer qualification, and never use a new reference to replay consumed calls.

Start with the user's intent: a new setup or resuming an existing private project.
For New, ask source type (REST API or existing MCP) and then source authentication.
For REST, a fixed query-free GET can be described without an existing OpenAPI
file; otherwise collect local OpenAPI 3.0.x JSON and explicit operation IDs.
Collect only scenario-relevant metadata, keeping backend authentication separate
from caller authentication. For anonymous REST, explicitly ask Entra (default)
or public anonymous APIM. Public accepts only fixed parameter-free GETs and
requires public-data/read-only declarations plus aggregate rate limits. Use
`examples/mcp/public-rates.json` and the public profile in `docs/scenarios.md`.
Do not ask for resource app IDs, scopes, caller allowlists or a discovery client
for that choice; explicit Azure tenant/subscription/account is still required
for management, and public MCP discovery selection is `{}`. API-key sources use Key Vault references;
generic third-party REST OAuth is unsupported and existing OAuth MCP is
reference-only. Do not silently choose experimental proxy v3.

The human terminal CLI now has a New / Resume / Advanced wizard with explicit
local-generation confirmation. Do not run its interactive prompts inside a
noninteractive agent tool. Collect inputs conversationally and use the same
explicit JSON plan/create/resume commands below. Read `docs/copilot-cli.md` for
the wizard's supported paths; repository development handoffs are not required
for every ordinary setup.

### Ask in plain language

Ask one short question at a time. Put the choice or requested value in the
question; use one or two supporting sentences for its purpose and where to find
it. Reuse answers already supplied. Do not put a whole plan, several unrelated
inputs or an approval hash in the question title.

For an APIM setup, ask resource choices BEFORE collecting Azure IDs or backend
credential references:

1. "Use an existing APIM service or create a new one?" Choices: "Use existing",
   "Create new", "Pause setup". Explain that creating Azure resources costs money.
2. For an API-key backend only: "Use an existing Key Vault or create a new one?"
   Skip this question for anonymous/delegated/managed-identity backends; explain
   that this setup needs no Key Vault.
3. Ask whether to use an existing resource group or create a new one. Preserve
   existing-only restrictions for managed-identity and experimental proxy setups.
4. Ask "What is your Azure tenant ID?" and then "What is your Azure subscription ID?"
   Explain where to copy each value. For existing resources request their full
   Resource IDs (Azure portal > resource > JSON View), not guessed name matches.
   For new resources request names, then show the full IDs constructed from the
   user's selected subscription/group. New resources must stay in the supported
   same-group/subscription topology. Ask region, publisher and pricing tier only
   where required. Choosing resources is not permission to inspect or create them.

Keep caller authentication separate from backend authentication. For public
access, ask "Is this data safe for anyone to access, and do these GET requests
only read data?" Then ask "How many requests should be allowed per time window?"
and "How long is that window in seconds?" Explain that the budget is shared by
all callers, applies separately to each API at each gateway/region, and is
approximate, not a cost ceiling. Preserve the existing numeric limits.

Do not ask "Intended Azure target or explicit placeholder-only draft". If real
details are missing, name the missing field and offer to pause. Only discuss a
fictional example when the user asks for one; explain that it cannot be used
for deployment. Never silently fill missing identities/resource IDs with sample
values or present fictional values as the user's selected Azure configuration.

For local generation, ask "Save these setup files to this folder?" Choices:
"Save files only", "Not now". First show the folder, selected resources, access
mode, what files will be saved and that no sign-in, Azure changes, endpoint calls
or FCC registration will occur. Present the exact current `reviewDigest` below
that summary as an **approval reference**, along with the full review. The user
does not need to type the hash; pass the unchanged value to the command only
after explicit confirmation. Do not hide or weaken exact-plan binding.

### Keep the next step visible

After a successful step, use the local `mcp-resume` report to identify what comes
next. State what finished, what has NOT happened, and ask about the next supported
step instead of ending with only "separate approval required". Do not wait for
the user to guess a phrase such as "let's deploy".

Prepare the next local plan when allowed; ask for approval of its exact effects
before executing it. Match the question to the actual plan, not just its phase
name: existing-resource foundation/finalize checks may be read-only, while new
resource creation and gateway activation change Azure. Examples:

| Actual next action | Question | Scope to explain before approval |
| --- | --- | --- |
| Private Azure sign-in | "Sign in to Azure to continue?" | Selected account/tenant/subscription; no deployment |
| Read-only resource checks | "Check your existing Azure setup?" | Exact resources read; no changes or endpoint calls |
| New resource creation | "Create these Azure resources?" | Names, location, pricing tier, costs and exact writes |
| Gateway activation | "Deploy the MCP endpoint to this APIM service?" | Owned APIs/policies changed, public access if selected; no tool calls or FCC registration |
| Metadata discovery | "Check which tools the MCP endpoint exposes?" | Initialize/tools-list only; no tool execution |

Use clear action choices and "Not now". After inspection succeeds, for example:
"Your Azure setup passed the checks. Nothing has been deployed. The next step
is [the actual next planned action]." Then present that plan's review and ask
its matching question. Do not skip a prerequisite or assume inspection approves
deployment. A vague "continue" or "let's deploy" without a current reviewed plan
is intent to prepare that plan, not authority to execute arbitrary phases.

Honor an explicit plan-only, local-only, pause or stop request. At that boundary,
offer "Review the next step" or "Stop here" once; do not sign in, inspect Azure,
deploy or call an endpoint. When blocked, request the one missing input or
approval and wait. Never repeat a consumed operation, relaunch a pending sign-in,
or treat a generic completion reminder as approval.

## Review before effects

1. Confirm the scenario, explicit trusted workspace and intended local output.
   Use `schema --json` and the package's synthetic examples to prepare a nonsecret
   definition. REST supports OpenAPI 3.0.x JSON with explicit operations; mappings
   and runtime proof are narrower. Existing OAuth is reference-only.
2. Run `mcp-server-plan --config FILE --workspace-root ABS --json --summary`.
   Present the bounded operation/target, limitations and exact top-level digest.
   Only a user-approved local generation request authorizes `mcp-server-create`
   into a NEW output with that exact digest. Do not invent capture/tool metadata.
3. For existing projects, run `mcp-resume --project DIR --workspace-root ABS --json
   --summary`. Explain completed, stale, blocked and unknown layers. Execute at
   most the one proposed phase after explicit user approval of current
   `next.approval` and effect flags. Never use a nested token as outer approval.
4. Before any cloud action, obtain the user's exact tenant/subscription/account.
   Separate account-plan/switch approval from resource, app, consent and runtime
   approvals. Never use an old ambient login or clear shared caches. A distinct
   MCP public client/user is not the Azure CLI account or APIM service identity.
5. Use `--progress` only where capabilities/help support it. Keep stdout JSON and
   stderr feedback separate. Sign-in requires the user's terminal; never save,
   relay into persistent chat artifacts, log or JSON any device code/token.

Never collect keys or client secrets. Backend keys are versionless Key Vault
references; APIM managed identity reads them. Never downgrade an existing Entra
project. Public anonymous requires a new uniquely owned native REST project,
not an edit to protected artifacts or a reused provisioning receipt. FCC uses
No Auth for that descriptor, with separate public-data/metadata review.
No default grant, provider OAuth exchange, consumer registration or runtime federation
is supported. Generated infrastructure and an observed protocol result are not
business correctness or host acceptance.

## Custom federated connector preparation

Read `docs/federated-connectors.md` and `mcp-fcc-schema --json`. Use
`mcp-fcc-plan --workspace-root ABS --config FILE --output NEW.json --json --summary`
for a local onboarding draft. Review all metadata for private export and each
observed tool for read-only behavior; never filter write tools locally and imply
the endpoint is restricted. Missing/stale captures stay blocked.

After exact local approval, use `mcp-fcc-bundle` with the same inputs and
`--approve` from the plan. The output is not a Microsoft manifest or registration.
SSO registration/app changes, consent, staged rollout and consumer execution are
separate owner checkpoints. No Auth is limited to declared public data. Never
substitute an SSO registration ID for a client credential or discovery identity.

The supported fallback when no registration API is qualified is a human
copy-and-paste handoff, not automated browser submission. Present the bundle's
`manualSetup.formFields` and `authenticationRegistration` fields/steps. Missing
values stay missing. Obtain actual registration references from the owner and
replan to a new output; never invent IDs or export secrets. OAuth preparation is
reference-only and remains blocked by unsupported discovery/import, even with a
registration ID. It is not a claim of secretless third-party OAuth.

Collect developer identity, policy URLs and intended audience early, before
starting time-limited authentication or freshness-sensitive discovery. Developer
fields may now be omitted to write an explicitly blocked draft; do not invent
them or stall independent local preparation. Record known placeholder policies
with `review.legalPolicies: "placeholder"`; this blocks submission even with all
URLs present. `reviewed` is only an owner declaration, not independent legal
verification. Do not fetch policy pages from offline commands or tests.
If the owner explicitly defers policies for a PoC, record
`review.pocPolicyDeferral: true` without marking policies reviewed/final.
Keep submission/rollout gates visible but do not repeat them as blockers for a
separately authorized scope diagnosis. Copy **Portal OAuth scope (fully
qualified)**, not the short runtime permission name, into the existing portal
registration; an AADSTS650053 wrong-resource error alone needs no server rebuild.

Before asking for a retry, check whether the original owned sign-in is still
active using nonsecret status. Do not launch a duplicate attempt or clear its
lock. Keep challenges terminal-only and tell the human which terminal to use.
At a human-only gate, ask once, record the blocker and stop until substantive
input arrives. An unavailable response or generic completion reminder is not
sign-in, identity confirmation, legal metadata, or approval of another phase.
Report the completed phase precisely instead of repeatedly announcing the same
blocker or claiming the whole journey is complete. Local handoff completion,
human FCC submission, admin Ready status and attributed consumer execution are
separate outcomes.

For recipe operator work, use the separate `mcp-operator-*` journal when an owner
has approved local recording. Reserve the exact reviewed operation, record
dispatch BEFORE running the separately approved external command, and reconcile
missing/ambiguous output through metadata instead of resubmitting. No journal
entry is itself an executor or service attestation.
Use `wait` once if the owner is unavailable. Honor `repeatPrompt: false`: stop
until substantive owner input, not a generic continuation reminder. Record a
matching `resume` with the new input digest; never mark incomplete work done to
escape a host loop. Owner reports belong to specific `owner-result` milestones.
The host integration must implement waiting; the compiler cannot enforce host
scheduling. When the request changes, finish that separate deliverable without
repeating an unrelated blocked registration question.

Use the reference-aware registration checklist: preserve an existing ID exactly
and do not create another registration. Preserve old descriptor-bound receipts
when a new registration URI requires a new reference descriptor. Supply the
existing ID/URI explicitly or create a separately reviewed matching preparation;
never edit a receipt's source digest to make it importable.

FCC-only requests do not require a WIQD project, declarative agent or app
package. Do not route an FCC request to `wiqd agent create` or provision a dummy
app to obtain an ID. For manual Entra SSO registration, use Teams Developer
Portal > Tools > Microsoft Entra SSO client ID registration with the existing
resource app's client ID, endpoint and scope. The documented `Any Teams app`
option does not require a final Teams app ID; review its broader restriction
with the owner rather than choosing it automatically. The reviewed ATK action's
app-ID requirement is not a prerequisite for this manual FCC path.

For shared SSO/OAuth settings, read `docs/auth-registration.md` and use
`mcp-auth-registration-schema`, `mcp-auth-registration-plan` and the separately
approved `mcp-auth-registration-bundle`. Require explicit tenant/operator,
endpoint descriptor, restrictions and OAuth endpoints/scopes/credential mode.
Do not invent a M365 app ID. Secretless OAuth preparation requires explicit PKCE;
confidential OAuth admits only a versioned Key Vault reference, never its value.
This is local preparation, not login or registration.

For separately requested registration execution, read the auth runbook first.
Use `mcp-auth-execution-plan` and `mcp-auth-execute` for independent
initialize/login/register/close approvals, never the preparation token.
Execution requires a trusted Linux host, owner-only tmpfs, an explicitly selected
ATK 1.1.17 installation and real app ID unless the compatibility option below is
explicitly selected. Windows/macOS are refused; never invoke
ATK against shared credentials, install a provider or start Docker as a shortcut.
Do not retain login URLs. ATK may launch the Windows default browser under WSL;
the toolkit does not isolate browser cookies/history or select the browser account.
The browser must reach the Linux loopback callback. A Windows browser may use separately verified WSL localhost forwarding;
do not assume that forwarding or browser authentication works from WSL presence.
Show the ancillary experimentation-service request in login/register approval
summaries: ATK's `--telemetry false` does not suppress it. No provider-code patch
or hidden network bypass is authorized to remove that disclosure.
Public account/selected-tenant metadata is not token attestation: obtain the
operator's actual identity review before `--confirm-identity`. Confidential
OAuth additionally needs a matching private Azure identity and `--allow-cloud`.
Real Linux/provider qualification remains outstanding.

For an owner-approved tenant-only Entra SSO registration using `AnyApp`,
execution config may set `allowAnyAppValidationPlaceholder: true` and omit the
registration app ID. The executor supplies a disclosed, unused validation UUID;
the reviewed provider mapping sends an empty M365 app binding. Do not create a
dummy app, supply that UUID as a real app ID, or first register `SpecificApp`
and ask the owner to broaden it later. The option is rejected for `SpecificApp`,
`AnyTenant`, OAuth or supplied app IDs. Review its disclosure in each phase plan;
all Linux isolation, identity and exact approval gates remain. Do not change
the historical preparation format or infer live qualification from this option.

Use local `mcp-auth-execution-status` after failures; never replay registration
or remove consumed reservations. Unconfirmed termination retains the operation
lock and owned process PID; do not clean up the runtime until reconciled.
Normal close removes only the owned runtime, retaining journals. Import a
successful `created-unverified` result through preparation's
`source.registrationResultFile`, never as readiness or publication authority.

FCC may import the saved preparation through `source.authenticationBundleFile`.
Only for a separately requested existing WIQD app/plugin workflow, use `mcp-auth-wiqd-schema`,
`mcp-auth-wiqd-plan` and `mcp-auth-wiqd-bundle` with a private registration input,
existing WIQD project directory and explicit environment. This writes only a
review handoff; it never invokes WIQD, edits that project or transfers credentials.
WIQD owns its ordinary profile authentication, not a toolkit-isolated session.
The operator applies the action through WIQD's authoring workflow and verifies
identity, validates the project and approves the ENTIRE provisioning lifecycle.
Never treat the export approval as authority for any provider command. Return
only the exact registration ID and SSO Application ID URI through the existing
preparation/reference path; no raw environment-file or token import.

References remain `provided-unverified`, conflicts are rejected, and missing
discovery or endpoint settings remain gaps. The plugin view is mapping guidance,
not a WIQD input or permission to publish. Do not repeat creation when the owner
supplies an existing registration reference.

First-call Tavily result acceptance is the fixed profile on a FUTURE unused
ordinary call only. Show the same-call credit caveat and exact approved arguments.
Do not change profiles/captures or run dedicated qualification to replay consumed
proofs. Failed/inconclusive/unknown dispatched outcomes remain consumed.

## Diagnose and preserve, do not repeat

Use `mcp-diagnose` for local retained evidence; no probes, subprocess diagnosis,
cache scanning, automatic full-inspection retry or guessed network root cause.
Unresolved dispatch and locks require owner reconciliation, not deletion.
Expired evidence preserves historical outcomes but does not authorize execution.

Offer exact local `mcp-export-plan`/`mcp-export` approval before Cloud Shell loss.
Retain the returned hash independently; a same-device checkpoint is not a backup.
Inspect with `mcp-archive-inspect --archive FILE --sha256 EXTERNAL_HASH`.
Restore only after an exact restore plan to a NEW destination. Never modify
timestamps, root/identity bindings, histories or pending/lock barriers to make
restored evidence appear ready. Persistence is unknown unless declared, and
declared persistence is not verified.

Host permission denials are not toolkit permissions. Stop and report an access
block rather than changing tools or paths to bypass it. No automatic host server
registration or UI diagnosis is part of this skill.
