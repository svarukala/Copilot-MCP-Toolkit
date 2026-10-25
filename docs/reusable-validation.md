# Reusable validation runners

The same six commands support the existing-deployment v1 contract below and
[fresh creation journeys in v2](#fresh-creation-runners-version-2). Starting a
run is a local record operation, not approval for its future phases.

## Bounded execution, separate contract version 1

`mcp-execution-schema/plan/start/run/status/record` is the opt-in **execution**
contract. It does not change either legacy validation version below. A new plan
explicitly grants each listed operation against the copied v2 scenario, exact
definition/build, identity choices, resources, proof selection and limits.
Approving an old `mcp-validation/*` token never grants later phases.

One execution approval can therefore authorize generation through the supported
protocol proof. The runner derives and checks the ordinary child plans internally;
there is no generic shell command or arbitrary next-plan auto-approval interface.
`start` records the grant locally, and `run` advances without further phase-token
questions. Genuine sign-in, an unsupported operation, changed inputs, failed
security checks and failed/unknown dispatches still stop execution.

| Family | Automatic execution under the new grant | Remaining boundary |
| --- | --- | --- |
| Direct Container Apps | Generate, bounded host adapter, release/reference, discovery and one proof | Existing Azure/Entra prerequisites; consumer, rotation and negative-test acceptance are not inferred |
| Container Apps behind APIM | SDK host path plus the selected gateway resources, release/reference and protocol path | Existing compatible gateway prerequisites and separate consumer/bypass acceptance |
| Native APIM REST | Generate, private account, existing guarded foundation/finalize/gateway/reconcile, discovery/proof | Existing proof-profile restrictions, actual prerequisite/secret evidence and manual consumer gates |
| Existing MCP | Generate reference, discovery/proof; no Azure authority | Anonymous/Entra only; provider-owned runtime is not inspected or certified |
| MCP proxies | Existing v2/v3 guarded lifecycle and protocol paths | Experimental v3 restrictions remain; unsupported OAuth/password/backend exchanges are not implemented |

### Prepare and approve once

Copy the synthetic [execution example](../examples/mcp/execution-existing.json),
its [v2 scenario](../examples/mcp/execution-scenario-existing.json) and referenced
definition into a private workspace. Replace the synthetic endpoint/tool and
identity data, declare **all related endpoint histories**, and set `expiresAt`
to an explicit UTC instant within the next 24 hours. The example's 2099 date is
intentionally not executable. Review actual read-only semantics, provider
entitlement, source inputs and each operation in the plan.

```powershell
copilot-mcp mcp-execution-schema --json
copilot-mcp mcp-execution-plan --workspace-root C:\McpRuns --config C:\McpRuns\execution.json --output C:\McpRuns\new-run --summary --json
copilot-mcp mcp-execution-start --workspace-root C:\McpRuns --config C:\McpRuns\execution.json --output C:\McpRuns\new-run --approve EXACT_EXECUTION_TOKEN --json
copilot-mcp mcp-execution-run --workspace-root C:\McpRuns --project C:\McpRuns\new-run --interactive --progress --json
copilot-mcp mcp-execution-status --workspace-root C:\McpRuns --project C:\McpRuns\new-run --json
```

Only `start` accepts an approval token. `run` uses the retained, unexpired grant.
Omit `--interactive` for anonymous execution or to stop before a required user
sign-in; resume the same run in a terminal without another execution approval.
Redirect JSON stdout only, not terminal authentication challenges on stderr.
There is no automatic retry or adoption of an older failed run.

Cloud scenarios require `cloud.resourcePolicy: "pinned-scenario-only"`,
`spendingPolicy: "resource-limits-not-an-invoice-cap"` and explicit
`ongoingChargesReviewed: true`. `allowSecretAccessGrants` must match the selected
profile: only the existing generated APIM secret-access operation can grant the
exact secret-scoped role to the selected APIM identity. SDK hosting and other
profiles grant no role changes. Full generated infrastructure definitions appear
in the plan, including default resource sizes. **This is not an Azure invoice
cap. Expiration or cancellation does not delete resources or stop their bills.**

SDK scenarios additionally require the closed `host` schema and an explicit new
`referenceServerId`. All image/scanner/download choices belong to that initial
review, including exact package-lock identity, scanner database references,
effective time/size bounds and CPU/memory/replica ceilings. The executor checks
that projection again against generated source before dispatch. No tool silently
chooses newer dependencies or waives vulnerability findings.
The existing recipe must admit at least four MCP POSTs per minute and
`minimumProofDelayMs` must be 65000. The wait covers the aggregate initialization,
notification, metadata and call window, not just provider calls.

The [SDK envelope example](../examples/mcp/execution-container-apps.json) is also
synthetic: replace both expiries, the scanner digest, account, identifiers and
resource choices, and add actual reviewed `imageBuild` builder/runtime digests
to the copied recipe definition. The runner does not select image versions.
`host.dockerSocket` selects an explicitly trusted local engine; it is not a Docker
context or remote daemon fallback. `privateLoginReviewed: true` permits login to
the new source project's private Azure profile if needed. Alternatively supply
an absolute `azureIdentityProject` for an already selected private identity,
without copying its cache. Download and create-only/resource-ceiling
acknowledgments are part of the same review, not independent attestations.
SDK cloud creation requires absence checks, conditional create requests and
readbacks. Local locks are not a distributed Azure lock; conditional creation
behavior is not yet live-qualified against concurrent external Azure writers.
No rollback/deletion or replacement of pre-existing resources is authorized.

### Authentication and interruption boundaries

The new plan selects session mode for eligible Entra SDK/existing references,
sharing one in-memory sign-in across discovery and proof. The exact post-discovery
proof is compared with the preauthorized selection before its one-use approval
is released. Pacing is cancellable and retains the same memory session. No token,
refresh token, device code or dashboard cookie is persisted by this mechanism.
The existing short session lifetime and tenant/client/user/audience/endpoint
bindings remain enforced; a fresh process does not inherit MCP credentials.
Native APIM and proxy separate-phase runners also reuse a lazily acquired,
memory-only caller session within the same invocation. Their ARM mapping and
proof checks remain intact. Expiry, binding drift or cancellation closes that
session without refresh; a restarted proof requires fresh caller authentication,
not a repeated provider call.
Azure uses the selected project-private identity/cache, never a shared account
switch or copied cache. MFA, consent and tenant policies still belong to the user.
These are distinct identity contexts, not a universal one-sign-in promise.

The append-only outer journal reserves the provider budget **before** a
proof-capable phase and counts Azure commands before invoking them. Its limits
are phase count, logical Azure command count, one proof-purpose reservation,
per-invocation time and absolute expiry. Logical CLI reads can retain their
existing bounded transport retries; cloud mutations and consumed proofs are
never retried. Cancellation between settled phases can resume the same grant.
Cancellation, failure or interruption within a phase preserves an uncertainty
barrier. Do not remove locks, reseal records, or start a new reference to evade it.

Pre-existing owner evidence can be supplied once in `ownerEvidence`. A genuinely
manual pending gate can be recorded later with `mcp-execution-record --config
CHECKPOINT_JSON` using the v2 checkpoint schema; this is an evidence submission,
not another execution approval. Passed declarations require evidence digests.
SDK prerequisites are not inferred from deployment: supply genuine directory,
resource and entitlement evidence once. The host adapter can record its actual
build, scan, smoke, push, deployment and gateway observations. One bounded
`/health` request, bound to the selected runtime/revision/configuration, can
confirm startup with an injected backend key. It does not independently verify
Key Vault access, provider-key validity or rotation and never reads the secret.
Failed/deferred findings and unknown execution cannot be overwritten with passes.
The runner never manufactures consumer, rotation or negative-test success.
`execution-completed` means the selected protocol path completed; the returned
milestone table still distinguishes pending/owner-reported acceptance. It never
sets `executionReadiness`, consumer attestation or renewed proof authority.

The new executor is CLI-only, like the legacy validation runners. Internal
Docker, Azure and transport seams are synthetic test infrastructure, not public
credential-provider or arbitrary-command APIs. Tests are offline; shipping this
capability is not evidence of a live deployment or permission to perform one.

## Existing deployment, version 1

The `mcp-validation-*` commands let an agent drive a repeatable validation
without asking the owner to remember or rerun every command. Version 1 supports
an **existing direct Container Apps deployment** with its sealed toolkit source
and matching Entra endpoint reference. It does not create infrastructure.
Use the same pinned engine/build and private workspace across sessions.

| Step | Toolkit does | Pauses for |
| --- | --- | --- |
| Local integrity | Checks sealed source/runtime, reference origin, optional matched release, retained history and diagnosis | Exact local start approval |
| Deployment prerequisite | Reuses operator-journal findings or saves bounded checkpoints | Owner confirms actual deployment/readiness; API-key backend also needs owner-reported secret resolution |
| Discovery and proof | Runs existing MCP discovery, presents a new one-call proof plan, checks an optional same-call result assertion | Exact phase approval, sign-in and **separate** exact proof approval |
| FCC acceptance, if selected | Records registration, authorization, save, admin readiness, audience, consumer call and read-only UI findings | Human/provider actions or explicit deferrals; these are not independently verified |
| Closeout | Writes append-only reports and a separately reviewed existing offline HTML/source handover | Exact private export approval |

The runner does not automate Docker/build/feed installation, Azure readback or
deployment, role changes, Key Vault resolution/rotation, auth registration,
negative caller tests, FCC submission or UI checks. Those remain separately
reviewed operations. It does not grant an agent blanket approval for network
calls. [The acceptance checklist](validation-readiness.md) still applies.

## Prepare once

Read `mcp-validation-schema --json`. Place the following **synthetic** definition
in the private workspace, replacing paths and identities with reviewed values.
Relative project paths resolve from this definition's directory. The source,
reference, optional release and new run directory must not overlap.

```json
{
  "schemaVersion": 1,
  "scenario": "container-apps-existing-v1",
  "sourceProject": "source",
  "referenceProject": "reference",
  "consumer": "fcc",
  "privateExportReviewed": true,
  "discovery": {
    "discoveryClientId": "44444444-4444-4444-8444-444444444444",
    "expectedUserId": "55555555-5555-4555-8555-555555555555"
  },
  "proof": {
    "toolName": "get_information",
    "arguments": {},
    "safetyReview": {
      "readOnly": true,
      "reason": "Owner reviewed this fixed GET."
    },
    "resultAssertion": {
      "kind": "json-array-string-field-v1",
      "field": "name",
      "maxItems": 5,
      "maxStringLength": 40
    }
  }
}
```

Select `consumer: "none"` when FCC is outside the requested scope. Optionally
add `releaseDirectory`. The fixed recipe tools take empty arguments. Omit
`resultAssertion` unless the reviewed response actually matches that bounded
array/string shape; protocol success alone is not business correctness.
Never add an assertion by replaying a consumed proof.

```powershell
copilot-mcp mcp-validation-plan --workspace-root C:\Private\Mcp --config C:\Private\Mcp\validation.json --output C:\Private\Mcp\validation-run --summary --json
# Review the complete plan, then supply its exact approvalToken.
copilot-mcp mcp-validation-start --workspace-root C:\Private\Mcp --config C:\Private\Mcp\validation.json --output C:\Private\Mcp\validation-run --approve "<exact-start-token>" --json
```

The immutable `validation-run.json` pins build, source archive, reference origin,
release binding and selected proof/identity. It is written last at initialization.
Never overwrite a run, move it to evade its bindings or edit/reseal its records.
The input files and all outputs are private; do not commit or transcript them.

## Agent-driven continuation

Run `mcp-validation-next --workspace-root ROOT --project RUN --summary --json`.
`--project` here means the **validation run**, not the source or endpoint.
Planning and `mcp-validation-status` are read-only and do not authenticate.
The returned plan identifies exactly one phase, full child plan, required flags
and approval token. Stop on `waiting-for-owner` or `blocked`; `repeatPrompt:false`
means retain the handoff rather than repeatedly asking the same question.

After the owner approves that exact phase:

```powershell
copilot-mcp mcp-validation-run --workspace-root C:\Private\Mcp --project C:\Private\Mcp\validation-run --approve "<exact-next-token>" --allow-network --interactive --progress --json
```

Only use `--allow-network --interactive` for a planned `session` or `proof`.
Network execution requires a real terminal, not an agent's captured shell.
The agent can prepare the reviewed command; the owner runs it in a visible
terminal when the host cannot provide one. Challenges go only to stderr; never
save a transcript. During a session, discovery and separately approved proof
share one in-memory sign-in for at most 15 minutes. Never auto-answer the new
proof approval or infer it from discovery authorization.

Blank proof approval retains discovery without sending a tool call. A later
`next` reuses the valid capture and plans only proof; its new process needs its
own sign-in. Expired captures require newly reviewed discovery, not timestamp
refresh. No token/cache copying, refresh or automatic login restart occurs.
Matching completed proofs are reported as **historical** instead of called
again. Different consumed selections and unknown outcomes block execution.

## Save human checkpoints in one batch

Create a checkpoint file with one or more applicable milestones:

```json
{
  "schemaVersion": 1,
  "milestones": [{
    "name": "runtime-deployment",
    "outcome": "passed",
    "evidenceDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "note": "Owner reviewed existing revision and traffic readback."
  }, {
    "name": "admin-ready",
    "outcome": "deferred",
    "note": "Waiting for the administrator."
  }]
}
```

Use a real reviewed evidence digest, never the example value. Passed/failed
declarations require a digest; deferred findings do not. Do not include raw
logs, tokens, device codes, secrets or sensitive result data. `secret-resolution`
is applicable only to API-key recipes and records an owner statement, never
the secret. Protocol checks cannot be marked passed by a checkpoint.

```powershell
copilot-mcp mcp-validation-next --workspace-root C:\Private\Mcp --project C:\Private\Mcp\validation-run --config C:\Private\Mcp\checkpoint.json --summary --json
copilot-mcp mcp-validation-run --workspace-root C:\Private\Mcp --project C:\Private\Mcp\validation-run --config C:\Private\Mcp\checkpoint.json --approve "<exact-checkpoint-token>" --json
```

No network/interactive flags accompany a local checkpoint. Newer operator
findings supersede older validation declarations and vice versa, preserving
both histories. A waiting source operator journal still needs its existing
exact `mcp-operator-*` resume; a validation checkpoint does not clear it.

## Reports, partial handover and interruptions

`mcp-validation-status` projects local checks, selected proof, failed/pending/
deferred owner findings, consumed barriers and handover paths. JSON reports
are saved under `RUN\reports` after each recorded step. No raw provider errors,
results, authentication caches or challenges are added. Reports distinguish
control-flow `status` from acceptance `outcome`; even
`passed-with-owner-and-historical-evidence` is **not** fresh live readiness.

`next` proposes handover after checks are recorded. To export an incomplete
snapshot, use `next --phase handover`, then `run --phase handover` with its exact
approval and no network flags. It writes a new offline handover directory,
preserves pending/failed/deferred evidence, and includes the validation outcome
and report digest in its operations note. Keep the separate JSON report with
the exported handover. Successful export does not turn failed validation green.

If evidence changed externally since the saved report, review `next --phase
refresh` and approve `run --phase refresh` to append a **local-only** snapshot,
then review a new export plan. This never renews evidence or clears consumption.

Run journals are bounded to 100 append-only events under an exclusive lock.
Unresolved intents, failed/unknown dispatched steps and existing reference
network locks block further live execution. Preserve locks and journals;
never delete them, create replacement references or select new output names
to evade replay barriers. An interrupted intent cannot be cleared by a
checkpoint or refresh. Use retained `mcp-status`/`mcp-diagnose` and owner
reconciliation; independent handover commands can export a separately reviewed
source snapshot when this run is blocked. Local chains are unkeyed integrity
checks, not tamper-proof attestations.

CLI exit codes: `0` for a usable plan/completed command, `2` for a retained
waiting/blocked or failed report, and `1` for invalid input/execution error.
Read the JSON state, not the exit code alone. A new session resumes the same
run with the same build and workspace; it does not restart completed steps.

## Fresh creation runners, version 2

The priority is **direct Container Apps, Container Apps behind APIM, native
APIM from REST, and existing MCP/proxies**, with header/query API keys and the
Entra profiles the underlying engines actually implement. This is not a
Cartesian product of every host and authentication mechanism.

| Scenario value | Caller authentication | Backend authentication | Runner boundary |
| --- | --- | --- | --- |
| `container-apps-create-v2` | Entra | Anonymous or Key Vault header/query API key | Fresh sealed SDK source, reviewed release and source-bound endpoint reference; image build/deployment remain separate operations |
| `container-apps-apim-create-v2` | Entra plus independent signed APIM gateway identity | Anonymous or Key Vault header/query API key | Same source/release/reference flow; actual ACA backend origin and gateway bypass checks required |
| `native-apim-create-v2` | Entra, or explicitly reviewed public anonymous profile | Anonymous, Key Vault header/query key, same-resource delegated Entra passthrough, constrained managed identity | Existing project-private account and APIM foundation/finalize/gateway/reconciliation; native proof remains planner-gated |
| `existing-mcp-create-v2` | Anonymous or Entra | Provider-owned; not inspected by the toolkit | Creates a local reference, **not the provider server**; discovery and bounded annotated proof |
| `mcp-proxy-create-v2` | Entra | Key Vault header/query key in proxy v2; header only in experimental proxy v3 | Existing guarded APIM lifecycle; v3 retains its owned-backend-routing and fresh configuration requirements |

Entra callers on SDK hosts do **not** imply Entra-secured REST backends or OBO.
Native delegated passthrough is not token exchange. Native mapped query-key
proof supports only its existing bounded GET profiles, not every generated API.
Unannotated native header-key proof remains unsupported; metadata discovery
does not qualify its credential path. Controlled delegated and Graph organization
assertions retain their explicit fixture/identity prerequisites. Direct existing
MCP references do not accept API-key caller credentials. Existing OAuth references,
SDK Entra/OAuth/password backends, legacy proxy v1 and unknown profiles stop before
runner execution; no anonymous fallback or invented readiness.

`mcp-validation-schema --json` exposes `creationScenario`, `creationCheckpoint`
and `creationCoverage`. For a synthetic direct-ACA run, copy
`examples\mcp\validation-create-container-apps.json` and the referenced recipe
into the same private directory. Change reviewed identifiers/paths before start.
The recipe is an ordinary existing `mcp-hosting-schema` input, not a new recipe format:

```json
{
  "schemaVersion": 2,
  "scenario": "container-apps-create-v2",
  "definitionFile": "container-apps-direct-api-key.json",
  "discovery": {
    "discoveryClientId": "44444444-4444-4444-8444-444444444444",
    "expectedUserId": "77777777-7777-4777-8777-777777777777"
  },
  "proof": {
    "toolName": "get_information",
    "arguments": {},
    "safetyReview": { "readOnly": true, "reason": "Owner reviewed the fixed GET." }
  },
  "probeMode": "separate",
  "consumer": "none",
  "relatedProjects": [],
  "historyReviewed": true,
  "privateExportReviewed": true
}
```

For managed native/proxy APIM, add `azureAccount` with explicit `tenantId`,
`subscriptionId`, and `accountName`, matching the definition. This management
identity is distinct from `discovery`'s client/user. Anonymous callers use `{}`.
Optional `probeMode:"session"` is limited to Entra existing references and SDK
endpoints; it preserves the separate newly displayed proof approval. Native/proxy
use `"separate"`. Native proof may select the existing `responseAssertion` and
`delegatedFixture:{path,approval}` fields; resultAssertion is limited to the
existing-reference/SDK path. Native tool names must match the generated mapping
and genuinely observed tools/list; mismatches stop, not silently select another tool.

`relatedProjects` is mandatory, even when explicitly empty for a genuinely new
purpose. List **all** retained MCP endpoint/native/proxy project directories
related to this endpoint/provider purpose, including superseded references.
These are not SDK source directories. Paths resolve from the input's directory
within the explicit private workspace. The runner reads strict retained histories
and blocks consumed, unresolved, invalid or locked related histories; it does
not transfer old success onto the new source. It rechecks them during MCP requests
and Azure command dispatch, including after interactive sign-in. It does not scan
unrelated directories or discover omitted histories. Empty history is a reviewed
declaration, not proof that no related provider call ever happened.

### Fixed sequence, one approval per phase

Use the same plan/start/next/run/status commands shown above. The new run copies
the exact definition and selections, pins the build, and owns `source`, optional
`release`, `reference`, `events` and `reports` subdirectories. External changes to
the original definition do not change the frozen copy. Changing the run's copy,
source/release/reference, selected identity, events or build invalidates continuation.
No arbitrary shell-command/task arrays are accepted.

| Phase | Automated operation / next action |
| --- | --- |
| Start | Private run creation only; no source generation or sign-in |
| Generate | Existing hosting writer or native/proxy/reference generator, separately approved |
| Prerequisites | Owner evidence for actual resources, entitlement, app/directory setup and safe diagnostics; existing reference skips this gate |
| SDK build and host | Owner-reviewed image build/scan/smoke evidence; gateway also needs the actual ACA host deployment first |
| SDK release | Existing release writer, binding exact source, immutable image, explicit account and actual gateway backend origin |
| SDK deployment | Separate approved platform deployment/readiness and secret-resolution evidence; no hidden Docker/Azure command |
| SDK reference | Existing writer with actual deployed endpoint and new server ID; source-matched, not independently deployment-attested |
| Managed APIM | Existing private device-code account selection, then one existing foundation/finalize/gateway or read-only reconciliation phase per exact approval |
| Protocol | Existing discovery and one separately approved proof, preserving unsupported native profile gates, exact identity, freshness and consumed history |
| Acceptance | Owner evidence for negative caller/gateway checks, secret rotation, optional FCC/admin/audience/consumer UI and cost closeout |
| Export | Separately approved SDK handover or private MCP evidence archive; retain the validation run/reports separately |

Use only the returned `requiredFlags`: local phases have none; MCP discovery/
proof require `--allow-network`; native mapping readback also needs
`--allow-cloud`; interactive Entra or Azure login needs `--interactive` and a
real terminal. APIM provisioning/reconciliation require `--allow-cloud`.
No blanket approval, background sign-in capture or automatic retry is introduced.
SDK cloud operations can be prepared/driven separately by an agent under their
own approvals, but the runner records their evidence as owner declarations,
not verified execution. Authentication registration and FCC submission are not
new runner executors.

At an SDK release/reference input pause, `--config` selects a small request file:

```json
{ "schemaVersion": 2, "kind": "release", "file": "release-input.json" }
```

Use `"kind":"reference"` for reference creation. `file` resolves relative to
the request. These referenced inputs use the existing recipe artifact schemas:
release has `schemaVersion:1`, `accountName`, `containerImage` pinned by digest,
and gateway-only `backendOrigin`; reference has `schemaVersion:1`, `serverId`,
`endpoint`. Optional image-review binding remains supported. Actual gateway
backendOrigin must be the selected app's `*.azurecontainerapps.io` origin.
Edits after planning invalidate approval; generated outputs are never overwritten.

Owner checkpoint requests use `"schemaVersion":2,"kind":"checkpoint"` and the
same `milestones` array as v1. Applicable names are reported in status. Required
common gates include `prerequisites`, `image-build`, gateway-only `host-deployment`,
`runtime-deployment`, `secret-resolution`, `caller-rejection`,
`gateway-bypass-rejection`, `rotation`, `cost-closeout` and selected FCC gates.
They are scenario-dependent, not all required for every run. Passed/failed need
evidence digests; deferred is incomplete. No checkpoint can assert a protocol
pass, clear an interrupted intent or supersede a consumed/unknown dispatch.
Source operator waits and unresolved external operations remain barriers.

Reports bind exact proof receipt/tool/arguments/assertion/discovery identity;
matching success is `passed-historical`, not live health. Unrelated or externally
consumed results do not become this run's pass. `status` is control flow;
`outcome` is failed/blocked/incomplete/passed-with-owner-and-historical-evidence.
The unkeyed journal is bounded to 200 events and uses an exclusive run lock.
Preserve interrupted/failed run and child evidence. Ordinary status/next is a
fresh local read; it does not rewrite an old report. Successful steps and checkpoints
append report snapshots. A stale SDK export snapshot needs a reviewed applicable
checkpoint before a new handover; do not repair its timestamp or digest.

V2 `--phase handover` derives a frozen SDK handover input from the saved report
and binds its digest, incomplete outcomes and selected source/release/reference.
It does not accept a replacement declaration file. Native/proxy/existing projects
can use `--phase archive` for the existing private evidence export. This archive
preserves endpoint evidence, not the runner or credentials, and is not a consumer
handoff. Neither export resets any barrier. An unresolved intent blocks even
runner export; separately reviewed independent recovery tools remain available.

### Subsequent authentication priority

After these runners, investigate and implement **third-party OAuth-backed REST**,
**OBO token exchange**, and **username/password endpoint profiles** as distinct
contracts. Define grant type, token audience/issuer, delegated versus application
identity, storage/isolation, refresh/expiry/revocation and controlled fixtures
before exposing execution. Basic authentication, a password-to-token exchange,
and Entra ROPC are not interchangeable; ROPC is not assumed. No such new
authentication executor, live exploration or credential transfer is authorized
by this priority list. App Service and Functions remain supported recipes but
are lower-priority fresh-runner work.
