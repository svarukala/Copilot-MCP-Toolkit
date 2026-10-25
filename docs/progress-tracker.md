# Progress and scenario tracker

Last updated: 2026-10-25.

This is the single progress index for the independent toolkit. Update statuses
with concrete commits/checks as work lands. "Implemented/offline verified" does
not mean deployed, authenticated, provider-compatible or verified in Cowork.
Historical observations are not fresh approvals or independent-runtime evidence.

## Completed engineering work

### Debian 13 runtime profile

Container recipes now also accept explicitly digest-pinned
`gcr.io/distroless/nodejs22-debian13:nonroot` runtime inputs. Debian 12 remains
supported; existing sealed source, image bindings and historical evidence are
not rewritten. Both profiles retain Linux/amd64, nonroot, exact source/build
correspondence, fresh scan/SBOM/smoke evidence and the zero-critical/high policy.
Functions remains source-only. This is an additive input capability, not a
claim of a qualified image or a completed live validation.
The focused offline hosting, registry and qualification run passed **30/30**
checks, including Debian 13 generation/review for all three container recipes,
unchanged Debian 12 admission, source/build mismatch and high-finding rejection.
Asset inventory and strict public types passed. No full-suite or live result is
claimed for this increment.

### Priority: reusable fresh-creation runners

V2 creation runners are implemented through the same `mcp-validation-*` family,
preserving the v1 existing-deployment contract. The focused integration gate
passed **164/164** tests with zero failures/skips/cancellations, including fresh
packed CLI coverage. After an Azure/MCP terminal-label refinement, a subsequent
**8/8** focused check covered private identity, real finalize delegation, uncertain
gateway barriers and CLI feedback; its mocked executor preserves the existing
per-command identity readbacks. Start pins a private definition/build and explicitly declared related
endpoint histories; each next/run approves one existing generator, artifact,
private APIM lifecycle or MCP protocol operation. Failed/unknown/dispatched
purposes stay consumed, including across explicitly related replacement references.

| Priority family | Implemented runner scope | Not yet qualified / unsupported |
| --- | --- | --- |
| Direct Container Apps | Fresh SDK source, release, reference, Entra caller discovery/proof; header/query Key Vault backend keys | Actual builds/feed/image/deployment and negative/rotation/consumer gates remain separate; SDK Entra backend unsupported |
| Container Apps behind APIM | Same plus actual host/backend origin, gateway release and bypass checkpoint | Actual gateway deployment and two-token enforcement still need live qualification |
| Native APIM from REST | Private account, existing foundation/finalize/gateway/reconciliation and protocol planners; key and existing Entra backend profiles | Header-key unannotated proof unsupported; query-key, delegated fixture and managed-identity Graph proof remain narrow, not universal |
| Existing MCP / proxies | New local existing reference; Entra/anonymous discovery and annotated proof; guarded proxy v2/v3 lifecycle | Existing API-key caller/OAuth login unsupported; v3 header only and experimental; provider compatibility needs controlled live evidence |
| Next: third-party OAuth REST / OBO / username-password | Recorded as subsequent implementation priorities | No new executor; distinguish grants/token exchange/Basic/password exchange, do not assume ROPC |

Build/deployment/negative/consumer checkpoints are explicitly owner-reported;
they are not replaced with synthetic passes. SDK handover and MCP recovery
archive use their existing separately approved exporters. No live operation,
installed-skill update, package publication or merge is part of this increment.
See [the v2 contract and support matrix](reusable-validation.md#fresh-creation-runners-version-2).

Prior frozen candidate `d9d091d` passed the complete offline gate **925/925** with
zero failures/skips/cancellations. Subsequently, separately approved real Entra
metadata discovery passed without a provider tools/call; the older provider proof
remained consumed. This is authentication/discovery evidence only, not fresh
creation, full consumer acceptance or qualification of these new v2 runners.
The full repository suite was not rerun for v2. Syntax/public types and asset
inventory passed; final closeout documentation records these scoped results,
not a new full-suite or live qualification.

### Reusable existing-deployment validation

The first `mcp-validation-*` scenario targets a sealed direct Container Apps
source and its existing Entra reference, not fresh deployment. It adds private
immutable run definitions, append-only checkpoint/intent/result events and
local JSON reports. Existing discovery/proof/session and handover executors
retain exact phase approvals and consumed barriers. Valid capture reuse,
separate terminal proof approval, historical result reuse, owner declarations/
deferrals, fresh-process continuation and incomplete handover are wired.
Build/input changes fail closed; unknown dispatch and locks do not auto-retry.

Focused offline integration passed **154/154**, with zero failures, skips or
cancellations (about four minutes on Windows). This includes 14 runner
regressions plus adjacent session, handover, feedback, public-boundary and
fresh packed-consumer coverage. Inventory, syntax and public types passed.
Closeout documentation followed the run; no full-suite or live result is claimed
for this increment. The older 911-test full gate below remains historical.

| Validation scenario | Implemented / offline result | Remaining live gate |
| --- | --- | --- |
| Local run and fresh-session continuation | Passed; pinned build/source/reference/release, exact approvals, private immutable inputs and append-only reports | Select the actual frozen candidate and existing deployment |
| Discovery and one-call proof | Passed with synthetic transport; one in-memory sign-in, separate proof approval, declined-proof capture reuse | Owner sign-in and separately approved real discovery/proof |
| Failed, unknown or historical proof | Passed; no replay through new runs, changed user/assertion, checkpoints, refresh or export | Owner reconciliation of actual unresolved outcomes; no retry inferred |
| API-key and FCC checkpoints | Passed; resolution gate, batched owner findings/deferrals, source-operator waits, no verification inflation | Actual platform reference/readiness, registration, FCC/admin/audience and consumer UI actions |
| Private handover and packaged CLI | Passed; incomplete snapshots, report digest, exact release binding and no network/process effects in packed local journey | Review private export; deployment/consumer acceptance remain separate |

Cloud readback/deployment, Key Vault resolution/rotation, registration/FCC,
negative caller checks and consumer UI acceptance remain separately reviewed
operations. See [the operator/agent guide](reusable-validation.md).

### Validation readiness hardening

The owner requested fixes for the readiness review before live validation.
The confirmed generic-assertion Status/Resume incompatibility and generated
public-npm-only build path are fixed and integrated. Shared strict receipt
validation projects bounded assertion findings through status, resume,
diagnosis and handover; export/restore preserves bytes and consumed barriers.
All four SDK recipes accept optional `npmRegistryUrl`, with historical public
npm as default. Generated lock URLs, npm configuration, Docker install and
release/handover reviews bind the selected credential-free HTTPS feed while
preserving versions/integrities. Old sealed projects remain unchanged.
Eight focused evidence regressions and 69 child registry/hosting checks passed.
The evidence child additionally passed 550 adjacent offline checks covering
historical native/Tavily contracts and retained evidence compatibility.

The parent work adds `npm run validate` (read-only inventory check, recursive
JavaScript syntax, public types and full offline tests), a Windows/Linux
Node 22/24 CI matrix, explicit wizard/skill project routing and
[a pinned-candidate acceptance checklist](validation-readiness.md). Thirteen
focused parent checks pass, including fresh-process pause/resume through all
four source/release/reference/auth-preparation/handover journeys. These perform
no provider calls and do not qualify real hosting or registration. The CI
matrix has not been executed as part of this local work.

Do not validate an unspecified `main` checkout or old installed skill as though
it were the feature candidate. Merge, installed-skill replacement, live tests
and deferred full Windows registration remain separate decisions.

Final integrated validation at **`eaba3dd`**: `npm run validate` passed **911/911**
tests with zero failures, skips or cancellations (about 21 minutes on Windows).
This includes the fresh offline packed consumer, four hosting pause/resume
journeys, registry propagation, evidence readers and historical contracts.
Read-only inventory, recursive source/CLI/maintenance syntax and public types
passed. All 140 local README/guide file links passed a separate read-only check.
The candidate build digest was
`sha256:b76a13fbf6a63ff4df9b3ba5ea2926aba42c8a9dc32655908b849706e745e854`.
Subsequent closeout documentation changes record this result; they are not a
claim of another full run or live readiness.

The first consolidated run at `99aaaa4` passed 910 tests with zero assertion
failures but cancelled the packed journey after its five-minute outer deadline.
The expanded journey now has a ten-minute test-only budget; all individual
30/60-second subprocess limits and production deadlines remain unchanged.
It passed alone in about three minutes and in the complete rerun in about
four and a half minutes. No test was skipped or removed to obtain the final pass.

| Readiness gap | Engineering outcome | Remaining qualification |
| --- | --- | --- |
| Generic assertion Status/Resume | Fixed; strict shared validation and bounded projection across readers, recovery and handover | New live proof remains separately approved and consumed once |
| Approved-registry builds | Explicit sealed feed selection for all four hosts; pinned lock data and isolated Docker npm configuration preserved | Actual feed downloads/container build and Functions remote-build behavior |
| Candidate/version drift | Commit/build/skill pinning instructions and explicit project routing | Use the selected checkout/package; merge and installed-skill update are not automatic |
| Consolidated regression | Full 911-test offline gate passed; Windows/Linux Node 22/24 CI configured | CI matrix has not been run here; local success is not cross-platform qualification |
| Pause/resume guidance | All four source/release/reference/auth-preparation/handover journeys exercised through fresh CLI processes | Real owner actions, provider authentication and deployment remain separate |
| Acceptance coverage | Per-host gates, evidence/stop conditions and private outcome-record guidance documented | Controlled live validation; full native Windows registration remains owner-deferred |

### Deployment handover implementation

The four sealed SDK hosting recipes support separately reviewed
`mcp-handover-schema/plan/bundle` exports. Each output includes two-tab offline
HTML, configured SVG/editable Excalidraw architecture, original source/templates,
optional source-matched release files and a structured integrity manifest.
The repeat guide maps destination edits to files/fields, distinguishes supported
CLI steps from manual/approval-required actions, preserves host-specific ordering
and highlights registry policy. The skill and generated projects surface this
at completion or a pause, without silently exporting private data.

Configuration, owner declarations and scoped historical observations stay
distinct. Missing evidence stays pending; deferrals, failures, waiting and
consumed calls remain intact. No new provider/consumer qualification, live
deployment, package installation or registration is implied.

Final focused offline validation passed **57/57** tests with zero failures,
skips or cancellations, including 20 handover tests, adjacent hosting/API-key,
release, image-review, operator and CLI contracts, and a fresh packed consumer
with runtime networking/provider subprocesses denied. Syntax and strict public
types passed. The synthetic local-browser preview passed tab/keyboard, copy and
copy-failure, light/dark, print and mobile checks with zero external page
requests; the generated PowerShell review script parsed successfully.
The full repository suite was not rerun. No live operations or new consumer
qualification were performed.

### Native Windows SSO implementation

2026-10-22: the owner prioritized native Windows SSO with Linux/WSL optional.
The separate spike demonstrated owner-reported Windows sign-in/no Teams
disruption; it did not implement or complete a registration executor.

The existing `mcp-auth-execution-*` phases now accept explicit
`authenticationMode: "windows-user-managed"` plus `sharedProfileReviewed: true`.
This admits secretless Entra SSO through pinned ATK 1.1.17 using its normal
profile, Credential Manager and possible broker. It is **not project-isolated**.
Linux remains the isolated SSO/custom-OAuth path; omission of the mode preserves
the historical Linux default. No automatic fallback, credential copying,
shared Azure account change, provider installation or Docker requirement exists.

Windows execution uses the public Node CLI entry directly, with bounded
noninteractive output, exact-PID/tree cancellation, per-user toolkit phase
locking and explicit account/selected-tenant review. Unconfirmed termination
retains both locks and job files. Close deletes only the owned job directory,
never shared caches/logs, Credential Manager contents or the user's sign-in.
Preparations and historical Linux sessions/receipts remain readable. Changing
mode or session does not reopen a consumed registration target.
The complete native Windows registration journey remains live-unqualified.

Final focused offline validation passed **111/111** tests with zero failures,
skips or cancellations. Coverage includes both modes' SSO/AnyApp-to-FCC flows,
Linux OAuth compatibility, cross-mode consumption, identity and termination
failures, historical preparation/result contracts, CLI feedback and a fresh
packed consumer. The 11 Windows provider tests include actual native execution
and exact-PID termination of a synthetic Node child, plus owned filesystem
cleanup; no real ATK, credential store or provider endpoint is used. The packed
CLI initializes, inspects and closes a synthetic Windows session while runtime
networking/provider subprocesses are denied. CLI syntax, strict public types
and 86 local documentation links passed. No full-suite rerun, live sign-in,
registration, dependency installation or installed-skill update was performed.

### Hosting pilot feedback implementation

The owner reported completing the API Ninjas / direct Container Apps end-to-end
pilot on 2026-10-22. This is owner-reported acceptance, not an independent audit
of consumer execution, UI labels, legal readiness or rollout. Private artifacts
and identities are not copied here; consumed proofs remain consumed.

| Package | Feedback IDs | Implementation status |
| --- | --- | --- |
| Correct FCC onboarding | R14, R15, R20 | Implemented: shared qualified portal scope, route guidance and bounded wrong-resource troubleshooting. 137 focused offline tests passed, including historical bundle compatibility |
| Operations and waiting states | R04, R07, R10, R22 | Implemented local operator journal: exact-purpose reservation, pre-dispatch unknown state, metadata outcome records, immutable chained history, waiting/resume and derived milestones. Five offline tests passed. No cloud executor or host scheduler change; host must honor waiting |
| Image hardening and provenance | R02, R05 | Implemented: explicit digest-pinned multistage/distroless nonroot generation, no mutable default, source/image-bound scan/SBOM/smoke review and optional release import. 35 targeted offline checks passed. Actual image build/run and signed attestation verification remain separately qualified |
| Preserving updates and migration | R16, R17, R18, R19 | Implemented local review profiles: additive Entra patch/semantic readback, separate Container Apps image-only template, exact-preview checks, asynchronous readiness and auth-impact stages. Six focused checks passed. No automatic mutation or live baseline attestation |
| Supported operator path | R01, R03, R08, R11 | Implemented: direct bootstrap, guarded directory handoff, metadata-only secret review, separate engine/host/container diagnostics and exact-digest private ACR pull with private identity and memory-only registry credentials. Cloud build/deployment remain separate operator actions; live qualification pending |
| Authentication and milestone UX | R06, R13, R21, R23 | Implemented: real-terminal handoff, phase-aware policy deferral, owner-reported milestones and optional 15-minute single-process discovery/proof auth reuse with a separate exact proof approval. Default separate commands remain unchanged; no persistent/shared token cache |
| First-call assertions and closeout | R09, R12 | Implemented: bounded same-call array/string profile for an unused existing-MCP proof, anti-retrofit/replay checks, explicit new-source scale-to-zero, cost/ownership/closeout review. No actual teardown or new provider call |

These R01-R23 identifiers refer to the pilot retrospective, not the older `R1`
archive backlog. Implementation authorizes no live mutation, sign-in, call,
registration, publication or cleanup of the deployed pilot.

Implementation milestones on `svarukala-custom-federated-connectors`:

| Commit | Scope |
| --- | --- |
| `8f233e0` | Qualified FCC scope and versioned, backward-compatible auth handoffs |
| `6b7fb1c` | Immutable operation journal and explicit waiting/resume handoffs |
| `8f799b3` | Reviewed digest-pinned image inputs and image-bound qualification metadata |
| `632b511` | Preserving update previews, semantic readback, readiness and migration review |
| `89406f4` | Bootstrap, terminal/policy/milestone UX, same-call assertions and closeout |
| `4b531e6` | Restrict container image inputs to the supported `linux/amd64` profile |
| `91d5fbd` | Approved host diagnostics, private ACR pull and bounded single-process MCP sessions |
| `577201a` | Docker-compatible padded registry authentication and focused test organization |

First-pass validation: the full offline `npm test` run at `89406f4` passed **831/831**
tests with zero failures, skips or cancellations (about 19 minutes), including
the fresh packed consumer with runtime networking/subprocesses denied. After
the architecture correction, **22/22** focused hosting, image-review and artifact
checks passed; `npm run check`, `npm run test:types` and `git diff --check` also
passed. The full suite was not rerun after that narrow correction. No actual
container was built/scanned and no Azure, M365 or provider operation was run.

Follow-up implementation adds `mcp-host-schema/plan/run`,
`mcp-host-account-plan/switch` and `mcp-session-plan/session`, with a `session`
terminal-handoff phase. Expanded offline coverage passed 139 checks for
host operations, discovery/proof, private identity, device code and bootstrap.
The full offline run at `91d5fbd` passed **854/854** tests with zero failures,
skips or cancellations (about 24 minutes), including the fresh packed consumer.
The final Docker header correction at `577201a` passed all **12 focused host
operation tests**, including every base64 padding length and the integrated
private pull. Two accidentally repeated tests were also moved out of a loop;
the historical full-run count includes those repeats. CLI syntax, strict public
types, whitespace checks and 112 local documentation links passed. The full
suite was not rerun after that narrow correction and test-only reorganization.
All new examples are synthetic; no real Docker/Azure/provider operation or
sign-in was executed. The private pull
uses the local Docker API, rejects insecure/debug daemon profiles, writes a
reservation before dispatch, checks the returned digest/platform and retains
unknown results without retry. Container diagnostics cannot auto-pull images
and clean up only their labeled temporary container. In-memory auth continuity
requires the exact expected user and cannot bypass re-listing or proof history.

These packages do not automate every retrospective request. The calling host
must enforce waiting; the toolkit does not
control its scheduler. Imported scans, baselines and owner results remain
declared metadata, not authenticated service attestations. Live qualification
of image execution, preserving deployment, secret resolution/rotation and
consumer behavior remains separate from these offline results.

Live qualification attempt on 2026-10-22, using implementation `47722e8`:
the standalone `host-npm-diagnostic` ran once against its fixed public npm ping
endpoint and returned `failed` at the `transport` stage, without an HTTP status.
The bounded intent/result are retained privately; no raw logs or private paths
are included here. The result does not establish a root cause or provider
readiness. No automatic retry, package installation or TLS bypass was performed.
Docker engine/container checks remain pending explicit trusted-engine selection;
private ACR pull and interactive discovery/proof remain pending explicit project,
identity, image/endpoint selection and their separate operation approvals.
No Azure, M365, provider call or deployed-pilot change was performed.

After the owner requested continued investigation, separate bounded diagnostic
requests narrowed the Node HTTPS failure to `EPROTO`; the selected DNS address
was IPv4. A direct Windows HTTP client comparison also failed with
`HttpRequestException`. An explicit TLS 1.2 comparison also failed with
`EPROTO` / `alert handshake failure`. These observations do not establish the
underlying network/TLS cause. Certificate verification remained enabled, redirects were
disabled, and no proxy settings were changed. Local pipe-directory inspection
found neither supported Windows Docker pipe; no Docker API was contacted or
engine started. At that point, qualification was treated as blocked on host
connectivity and Docker availability, in addition to the explicit cloud/auth
target selections above; the registry clarification below supersedes the
general host-connectivity conclusion.
The original failed toolkit result remains unchanged; follow-up observations
are retained separately and privately.

Registry clarification later on 2026-10-22: the owner confirmed public npm is
blocked by policy and an approved alternative registry is used. The repository's
existing `.npmrc` already selects that alternative. One bounded, credential-free
HTTPS comparison against the configured feed's `/-/ping` path received HTTP 404
with certificate verification enabled and redirects disabled. HTTPS reached the
feed, but that is not a successful npm ping, package restore or toolkit diagnostic
qualification. Both built-in host/container npm probes initially hardcoded
public npm. The follow-up implements optional approval-bound `registryProbe`
selection for an explicit HTTPS feed and either ping or a package-metadata URL.
Omission retains the original target; no npm configuration/authentication is
imported, and no fallback, redirect or install is performed. Both execution
paths check public DNS and pin the selected address. The exact URL/mode/package
are shown in the plan and bound to its approval.
Do not replace the approved feed or bypass policy. Docker availability and
explicit cloud/auth selections remain outstanding; original results are intact.

The updated `mcp-host-plan/run` subsequently completed a new, explicit
package-metadata connectivity probe against the approved feed with **HTTP 200**.
Its intent/result are retained privately, separately from the previous failures.
This is live host connectivity evidence only: no package was installed, response
content retained, Docker engine contacted or Azure/provider operation executed.
Container execution and private-pull/session qualification remain outstanding.
Validation of the registry change passed **18 focused offline tests** plus the
fresh offline packed-consumer test with runtime networking/subprocesses denied.
Coverage includes default-target compatibility, exact registry/package approval
binding, scoped-path encoding, credential/query rejection, DNS pinning, mixed
private/public DNS denial, redirects, TLS protocol errors, and the actual
container probe script under synthetic transports. CLI syntax and strict public
types passed. The full repository suite was not rerun for this change.

Docker follow-up on 2026-10-22: the owner approved starting Docker if necessary.
The supported Windows pipes were already available, so no start/restart or
context change was performed. A new `mcp-host-plan/run` engine diagnostic on
the explicit Docker Desktop Linux pipe **passed**, establishing Linux/amd64
and the required API 1.44 compatibility checks. Its intent/result remain private.
A separate read-only image inspection found `node:22-bookworm-slim` absent;
no pull or container execution was attempted. The earlier engine-availability
blocker is resolved, but container connectivity still needs a reviewed available
image and execution approval. Private ACR pulls and interactive authentication/
proof remain unqualified and require their own targets and approvals.

All toolkit rows below refer to the initial independent implementation
[`6463fea`](https://github.com/svarukala/Copilot-MCP-Toolkit/commit/6463fea8e6b6449b8631644cccdae6d8a9a8dea8).
See [handoff](handoff.md) for the recorded validation baseline, not a promise that
later edits have been tested.

| ID | Workstream | Status | Evidence / boundary |
| --- | --- | --- | --- |
| F1 | Independent package, CLI and bounded library | Implemented/offline verified | Fresh packed consumer; no originating checkout dependency |
| F2 | Copilot CLI guidance skill | Implemented/offline verified | Ships with package; user/project installation remains explicit |
| F3 | Bounded REST compiler and APIM generation | Implemented/offline verified | 13 pinned synthetic generation vectors; not universal REST-to-server generation |
| F4 | Private Azure identity, resource/app setup and guarded lifecycle | Implemented/offline verified | Separate exact phase approvals; no live requalification after extraction |
| F5 | Summary/progress feedback | Implemented/offline verified | JSON stdout; summaries/progress stderr; no inferred execution success |
| F6 | Resume, evidence layers and freshness admission | Implemented/offline verified | One separately approved phase; expiry never resets consumed purposes |
| F7 | Tavily first-call result assertions | Implemented/offline verified | Closed profile on a future unused proof only; no arbitrary evaluator |
| F8 | Safe evidence export, inspect and restore | Implemented/offline verified | Canonical ZIP + independent hash; imported identity/lock barriers retained |
| F9 | Local retained-evidence diagnosis | Implemented/offline verified | No network, login or auth-cache reads; unknown root cause stays unknown |
| F10 | Public extraction hygiene/provenance | Completed at baseline | 108 tracked paths screened; original license and 85 source hashes checked |
| F11 | Cowork project feature freeze | Published | Separate README/AGENTS notices on both Cowork branches; repo not archived |
| F12 | Interactive CLI welcome banner | Implemented/offline verified | ASCII-only welcome before the guided review notice/menu; terminal stderr only. Regression coverage preserves banner-free explicit commands, help, version, JSON and noninteractive errors; no execution or approval changes |
| F13 | User-oriented New / Resume setup | Implemented/offline verified | 49 focused tests including terminal CLI and fresh packed-consumer rehearsals; syntax/types pass. Source/auth questionnaire, fixed GET or selected OpenAPI import, shared resource selection and confirmed local generation. Resume/Advanced remain review-only; OAuth limits, Key Vault-only keys, no-overwrite/cancellation and JSON guards retained. No live operations or runtime qualification |
| F14 | Explicit public anonymous APIM | Implemented/offline verified | Native anonymous-backend fixed GET only; public/read-only declarations and bounded aggregate throttles on MCP + REST. Entra default, management identity, staging/inheritance/ownership and proof consumption preserved. No Entra resource-app or discovery-client requirement; FCC No Auth. Full offline suite: 770 passed; final public-mode rerun: 36 passed; syntax/types pass. Live qualification pending |
| F15 | Plain-language setup and visible next steps | Implemented/offline verified | Existing/new APIM and applicable Key Vault choices before IDs; names for new resources, exact IDs for existing resources. Short save question with full approval reference retained. Skill directs one-question intake and next-action offers without automatic deployment or bypassing local-only limits. 57 focused offline checks, including fresh packed consumer, passed; syntax/types pass. Installed skill copies unchanged; conversational/live behavior not yet requalified |

## FSI audience documentation and merge review

2026-10-18: the README now explains MCP in plain language, gives numbered
PowerShell setup steps and terminal/Copilot CLI choices, and includes a public
exchange-rate demo and a concise support table. AI-generated/as-is terms and
customer operational responsibility remain prominent. The configured dependency
feed is an explicit installation prerequisite, not a claim of public npm
reproducibility. Requested obsolete naming was removed from tracked files.

Read-only review of the accumulated branch against main found no significant
issues. Syntax, strict types, README file-link checks and CLI help passed.
The full offline run executed 774 tests: 773 passed and one expiry test failed
because its fractional mock clock could round the elapsed time below the exact
deadline. Both affected expiry mocks now use integer times; runtime code and
timeout limits are unchanged. All six targeted inspection-budget/expiry tests,
three independence tests and both expiry tests under the formerly failing
fractional clock origin passed afterward. The full suite was not rerun after
this test-only correction. No live provider or consumer qualification is implied.

Public npm follow-up: [a separate installation guide](public-npm-setup.md) now
covers explicit project-local registry selection and conversion of pinned
tarball URLs without deleting/regenerating the lockfile. Offline checks confirm
all 52 URL mappings, preservation of every other lockfile field, repeatability
and rejection of unexpected sources/missing integrity/unsupported lock format
before writing. PowerShell examples parse. Default feed configuration is
unchanged; fresh public-npm installation remains unqualified.

## Scenario and runtime qualification

Implementation details and all unsupported cases remain in
[the scenario matrix](scenarios.md). This table tracks qualification separately.

| Scenario | Independent toolkit implementation | Runtime / consumer status |
| --- | --- | --- |
| Native APIM REST, anonymous backend | Generation and narrow fixed-GET proof supported | Offline verified; no independent live requalification recorded here |
| Public anonymous native APIM REST | Explicit public fixed-GET profile, rate controls, guarded lifecycle/discovery/proof and FCC No Auth | Offline verified only; no new live Azure/APIM deployment, Copilot execution or recording |
| Native APIM REST, Key Vault API key | Header/query generation; narrower mapped query-key proof | Offline verified; generic/header-key native proof is not supported |
| Native APIM REST, Entra delegated | Same-resource token passthrough; controlled fixture proof | Offline verified; not generic OBO or arbitrary delegated APIs |
| Native APIM REST, system managed identity | Existing APIM principal and exact role prerequisites; fixed Graph profile | Offline verified; no independent live requalification recorded here |
| Existing anonymous / Entra MCP | References plus separately guarded discovery/eligible proof | Provider-specific acceptance remains separate |
| Existing provider OAuth MCP | Reference descriptor | Login/exchange/discovery/proof unsupported on this path |
| Upstream API-key MCP proxy v2 | Generation and guarded provider-dependent flow | Compatibility caveats remain; not the automatic fallback for v3 |
| Owned-backend routing v3 | Explicit experimental flow | Offline packed coverage; not generally qualified for arbitrary providers |
| Tavily scoped v3 result | Closed first-call/dedicated profiles retained | Historical source success only; invalid-key initialization inconclusive; original calls consumed |
| WIQD package integration | Proposed, not implemented | No end-to-end acceptance yet |
| Actual Cowork execution | Outside standalone protocol proof | Unverified; package/protocol success must not be substituted |
| Custom federated connector onboarding | Local schema, plan, approval-bound JSON and observed metadata checks | Anonymous public-MCP pilot discovered, bundled and registered; admin reports Ready/enabled/everyone; consumer execution unverified |

## Prioritized demo work: custom federated connectors

User-directed priority on 2026-10-14: deliver FCC demo preparation in this repo
before the general WIQD handoff. See [FCC design and workflow](federated-connectors.md).
Local implementation approval is not approval for live identities or tenant rollout.

| ID | Work | Status | Evidence / remaining gate |
| --- | --- | --- | --- |
| FCC1 | Local FCC contract, readiness plan and no-overwrite onboarding bundle | Implemented/offline verified | `1ec9bc0`, extended in `13263f5`: 28 FCC tests; no root API expansion, network or registration |
| FCC2 | Synthetic demo recipe and packed CLI rehearsal | Implemented/offline verified | `13263f5`: existing-Entra and REST/APIM inputs exercised through fresh installed CLI with runtime networking/processes denied; [runbook](fcc-demo.md) |
| FCC3 | Entra SSO consumer compatibility | Owner reports secured FCC added; supplied screenshot shows one expected tool | Prior public-client discovery and resource readbacks retained. UI labels the unannotated tool Write; attributed consumer execution, actual rollout and consent-grant details remain unverified |
| FCC4 | Staged Microsoft 365 demo acceptance | In progress: anonymous MCP registration and rollout verified | 2026-10-15: toolkit discovered three read-only tools, wrote reviewed private bundle; admin confirmed custom connector Ready/enabled/visible to everyone under explicit user direction. Attributed Copilot execution remains unverified |
| FCC5 | Human copy/paste handoff instead of browser automation | Implemented | User-directed boundary: labeled FCC form fields, secretless SSO setup fields/steps and actual supplied registration references; OAuth reference preparation remains blocked with discovery/import unsupported |
| FCC6 | Fresh secured FCC onboarding handoff | One private local draft written and readback verified | Supplied developer fields, original SSO reference and one actual captured tool; manual-checkpoints-required, not execution-ready. Privacy/terms URLs resolve to placeholder pages; legal review, explicit audience, human submission and consumer verification remain |
| FCC7 | Retrospective: draft gaps, legal declarations and reference reuse | Implemented/offline verified | Missing developer fields produce blocked drafts instead of preventing preparation; declared placeholder policies block submission; existing SSO/OAuth references produce reuse instructions. Summaries expose policy status/expiry; human-wait guidance avoids duplicate sign-ins and repeated blocker messages. No live artifacts or resources changed |
| FCC8 | Read-only tool classification in the consumer | Read-only support review complete; remediation not implemented | Retained Learn tools declare readOnlyHint true; native APIM tool has no annotations. Pinned/latest documented native tool contract has only displayName, description and operationId; no supported annotation setter qualified. Renderer matches that contract; export preserves received hints. See [review and alternatives](federated-connectors.md#native-apim-annotations-and-consumer-classification); no live changes or calls |
| AUTH1 | Opaque authentication registration IDs | Implemented/offline verified | `2ffcda8`: leading punctuation, Base64 characters and trailing padding preserved; 35 FCC tests plus packed test |
| AUTH2 | Shared local SSO/custom OAuth preparation | Implemented/offline verified | Closed schema/plan/bundle, explicit restrictions, PKCE or versioned Key Vault reference; 38 auth tests plus 35 FCC tests, syntax/types; no provider execution |
| AUTH3 | SSO registration execution adapter | Implemented; one private Linux/ATK SSO registration created | Public ATK 1.1.17 returned a strictly parsed created-unverified receipt after identity review; consumed reservation retained. Broader provider qualification, resource settings and FCC execution remain separate |
| AUTH4 | Generic OAuth registration execution | Implemented; live qualification outstanding | PKCE or exact versioned Key Vault secret using a matching private Azure identity and bounded HTTPS read; child-only secret environment, no secret in toolkit durable artifacts |
| AUTH5 | Shared auth references for FCC/plugins | Local metadata/result import implemented; consumer execution unverified | Exact request/descriptor-bound created-unverified result import into preparation, then FCC; conflicts/stale approvals rejected. Plugin view remains mapping-required, not WIQD packaging |
| AUTH6 | Windows-first isolation assessment | Native precheck rejected; WSL offline fallback checked | Same-user redirection retained the Windows principal and resolvable broker/keytar modules; credential-store access was not exercised. Twelve focused Linux checks passed; private pinned ATK help ran with network blocked and no account cache. Windows-to-WSL synthetic callback passed. Real sign-in/registration remains unverified |
| AUTH7 | WIQD-style native Windows authentication | Source investigation complete; replacement adapter not implemented | WIQD 0.18.0 Core has account selection, no unconditional interactive logout and a browser switch. Its fixed Credential Manager encryption-key namespace is not scoped by redirected HOME. Private credential isolation and registration-only integration remain unqualified |
| AUTH8 | User-managed WIQD Windows handoff | Implemented; live operator journey unverified | Local schema/plan/bundle exports SSO/PKCE review actions, quoted operator commands and exact return mappings. No provider invocation, project edits, credential transfer or Linux requirement. WIQD owns its normal profile; whole-lifecycle review remains mandatory |
| AUTH9 | Explicit tenant-only SSO AnyApp validation compatibility | Implemented/offline verified; one live registration dispatch succeeded | Requested HomeTenant / AnyApp with the disclosed validation-only UUID; no app creation or later restriction switch. Service-side restriction readback and consumer compatibility remain unverified |
| AUTH10 | Preserve explicit tenant during ATK browser sign-in | Implemented/offline verified; one corrected private sign-in passed | Argument-driven ATK mode with human terminal I/O; matching public account/selected-tenant record observed, not token-issuer attestation; registration remains separate |
| AUTH11 | Existing Entra/APIM FCC settings review | One private read-only review completed | Fresh private Azure sign-in; existing-app inspection and selected ARM/Graph GETs identified the gaps. Subsequent owner-approved changes are tracked in AUTH12; no endpoint execution |
| AUTH12 | Approved additive Entra/APIM settings | One private change set applied and readback verified | One Graph PATCH and three ETag-guarded APIM policy updates; previous settings and all existing authorization checks preserved. Operator-reviewed merge, not a new general toolkit mutation capability |
| AUTH13 | Fresh Entra metadata discovery after approved settings | One private authenticated discovery completed | Existing secretless public client, fresh in-memory sign-in and initialize/tools-list only. One controlled fixture tool captured; no tool execution, cache transfer or proof replay |
| AUTH14 | FCC consent requested-resource permission | Owner manually corrected configuration; then reported successful FCC addition | AADSTS650057 and retained empty requiredResourceAccess identified a consent-path gap distinct from exposed-scope preauthorization. Supplied screenshot showed the resource app requesting its own delegated scope; no fresh Graph or consent-grant readback and no automated mutation |

FCC7 validation: 97 focused offline checks passed across FCC preparation,
auth-reference import, CLI feedback and fresh packed consumption, plus syntax
and strict types. Regression coverage includes partial/omitted developer data,
invalid supplied values, declared placeholder/reviewed policies, stale approval
rejection after metadata/review changes, imported reference reuse, immutable
capture metadata and JSON stdout with policy/expiry summaries on stderr.
The packed runtime denies networking and child processes. No new dependency,
provider execution, live retry, saved-evidence rewrite or rollout was performed.

AUTH9 validation: 123 targeted Windows tests passed across execution, shared
preparation/WIQD handoff, FCC, CLI feedback and fresh packed consumption, plus
syntax/types. Linux Node 22.23.3 passed all 37 execution tests and the fresh
packed consumer using the retained private npm configuration/cache. That Linux
run includes real tmpfs ownership/cleanup checks but synthetic provider calls.
Compatibility regressions cover disabled/invalid opt-in, approval/session
binding, unchanged canonical preparation, action-only placeholder injection,
receipt integrity, consumed-target preservation and reference import into FCC.
Those offline checks establish no live sign-in, service registration or consumer
execution; subsequent live observations are recorded separately below.

WSL lifetime finding: an approved local initialization succeeded, but the
distribution stopped between checkpoints and lost its tmpfs runtime before
sign-in. No authentication or registration was dispatched. Keep a visible WSL
terminal open throughout the private-session journey; durable initialized
metadata alone does not establish runtime availability. Never restore a cache
or reopen a consumed registration to recover from a stopped distribution.

ATK tenant-selection correction: the provider reported successful browser
sign-in, but the selected-tenant metadata remained empty and toolkit verification
failed. Source inspection identified ATK 1.1.17's guided mode discarding the
explicit `--tenant` option. The adapter now uses ATK argument-driven mode while
keeping the human terminal/browser flow, and preserves the strict tenant check.
The failure message now distinguishes account/tenant verification from a
generic authentication failure. Historical failed attempts remain consumed.
After an explicitly requested fresh retry, the corrected invocation completed
and retained a matching public account/selected-tenant record. This is one
private sign-in observation, not token-issuer attestation or registration
qualification. Operator identity confirmation and registration are separate
gates, subsequently exercised as recorded below.

AUTH10 validation: 46 Windows tests passed (41 execution tests, four CLI
feedback tests and one fresh offline packed consumer), plus syntax/types.
Seven focused Linux checks passed, including the actual tmpfs runtime check.
Synthetic adapter regressions cover the exact login arguments, retained human
terminal mode, correct/empty/wrong tenant selection and no cache repair.
Failure regressions preserve consumed login attempts and suppress raw errors.
No provider or cloud service was contacted by these checks.

Subsequent SSO registration observation: after the operator confirmed proceeding
with the displayed identity, a fresh register plan was reviewed and dispatched
once through the public ATK CLI. Strict output parsing produced a private
`created-unverified` receipt containing the registration ID and Application ID
URI; a subsequent local status read confirmed the consumed target reservation.
This qualifies that one requested HomeTenant / AnyApp creation path, not a
service-side restriction readback, general provider support or FCC readiness.
No Entra/APIM mutation, endpoint call, FCC submission or consumer execution was
performed. Private identifiers stay outside this repository; runtime cleanup
and downstream resource settings remain separately reviewed operations.

The subsequent private resource review found that the token-store client is
already preauthorized and allowed, while the generated registration URI and
consent redirect are absent from the existing Entra app. The selected MCP API,
its REST wrapper and controlled backend each have an audience validator; the
new URI is absent from all three. The backend's extra user restriction matches
the selected account and must remain intact. Resource/token-store principals
exist and are enabled. This is management-plane observation only, not consent,
runtime compatibility or permission to modify existing resources. The original
controlled fixture and consumed proofs remain unchanged.

The owner subsequently approved that exact additive change set. Fresh readback
matched the reviewed baseline. One Graph PATCH added the registration URI and
Web consent redirect; Graph's URI reordering triggered a conservative stop and
read-only reconciliation, not a second PATCH. Three previously undispatched
APIM updates then added only the new audience under concrete ETag checks.
Readback preserved the other inspected app settings and every original policy
element, including the controlled backend's user restriction and fixed response.
The fixture now has that explicitly approved audience addition; its prior proof
remains historical and consumed. Private dispatch journals and results are
retained; public automatic reused-app configuration support is unchanged.
No endpoint calls, consent, FCC submission, rollout or consumer verification
were performed, and existing receipts/preparation artifacts were not upgraded.

Subsequent metadata discovery completed on 2026-10-15 using the existing
secretless public client and a fresh reference declaring the registration URI.
The original capture retains one controlled fixture tool, its empty object
input schema and the absence of annotations. Management-plane review supports
the read-only classification; discovery alone does not prove backend safety.
The attempt completed without retry and released its owned network lock.
No tools/call, token-store consumer flow or FCC submission was performed.
Capture freshness is limited to 24 hours; no historical timestamp, descriptor,
registration receipt or consumed proof was rewritten. Developer/legal metadata
was missing at that checkpoint. After the owner supplied the fields, a reviewed
private onboarding draft was written and read back, retaining the exact original
SSO reference, tools, schemas and capture timestamp. All nine form fields are
supplied, but this is structural completeness, not legal or runtime approval:
the linked privacy/terms pages explicitly describe themselves as placeholders.
The bundle remains `manual-checkpoints-required`, with execution readiness and
proof replay false. Final legal review, consent, human submission and
secured-pilot audience selection remain separate.

FCC-only scope correction (2026-10-15): AUTH8 is optional for a separately
requested existing WIQD app/plugin workflow, not an FCC prerequisite. The
official portal supports direct SSO registration without creating an agent.
FCC copy/paste output and shipped skill guidance now distinguish the existing
resource app from a consumer app and forbid dummy-agent creation. Broader portal
app restrictions still need explicit owner review. The mistaken private local
agent scaffold was stopped; no cloud agent was provisioned and no new secured
FCC registration or consumer result is claimed. The endpoint's nonsecret
resource metadata was subsequently recovered from its original private input;
the independent toolkit reproduced the selected endpoint offline. This is
historical configuration, not current live verification. The remaining gates
are current settings review, the actual registration reference and explicit
restrictions/legal/rollout review, not a new WIQD project. The selected endpoint
is a controlled delegated-auth fixture, not a business-data source; both its
MCP and backing REST authorization need review without reopening consumed proofs.

FCC-only correction validation: 82 targeted Windows tests passed (36 FCC,
45 shared auth/WIQD handoff and one fresh offline packed consumer), plus
syntax/types. The new regression verifies direct SSO preparation without a
WIQD project or consumer app ID, explicit restriction review, retained missing
references/captures and no project creation. This is not live registration.

Subsequent ATK-only registration request: the owner confirmed no existing SSO
reference. Source inspection found the app-ID gate in the actual 1.1.17 bundle,
not just toolkit validation. The public 1.1.18 archive was integrity-checked
and inspected without installation/execution; it retains the same unconditional
runtime requirement despite its optional-schema/AnyApp semantics. No sign-in or
registration attempt was dispatched at that checkpoint. The user subsequently
approved a bounded compatibility path: tenant-only / Any Teams app from the
start, with an explicitly disclosed unused ATK validation UUID. AUTH9 implements
that opt-in; no dummy agent/app or provider patch was introduced. The direct
portal remains the alternative. See [provider review](auth-registration.md#confirmed-anyapp-schemaruntime-mismatch).

AUTH8 validation: 53 targeted Windows tests passed (45 shared registration/
handoff, four CLI feedback, three independence and one fresh packed consumer),
plus syntax/types. Eight Linux Node 22.23.3 checks passed (seven handoff cases
and the complete fresh packed consumer). Coverage includes legacy preparation
preservation, exact reference return to FCC, no provider commands for blocked or
existing-reference inputs, identity/environment/destination-bound approvals,
safe PowerShell quoting, and refusal to write inside the WIQD project.

The FCC schema is a consumer-specific first implementation, not completion of H1
or H3's general WIQD handoff. It preserves the ownership split and does not
transfer account identities, credentials, approvals or consumed proofs.

On 2026-10-15 the user clarified that, absent a supported registration API, the
toolkit should supply enough information for a human to enter the FCC form,
including authentication registration and reference IDs. Live browser work was
stopped. `manualSetup` now makes that handoff explicit; missing values stay null,
credentials are rejected, and neither registration nor rollout is automated.
The earlier live pilot remains historical evidence, not the product workflow.
The subsequent user direction approved implementing shared auth registration
for plugin and FCC consumers, while retaining manual FCC submission and separate
live approvals. Opaque registration IDs now preserve Base64 characters and
padding rather than rejecting valid provider references.
The local shared module produces complete registration settings and its
preparation-only gaps. Supplied IDs remain `provided-unverified`; no provider
result or settings review is fabricated. Separate execution commands now
implement the AUTH3/AUTH4 phases with `created-unverified` receipts.
Version-1 preparation gap identifiers are retained for hash compatibility,
not used as the separate executor's capability matrix. See
[auth registration](auth-registration.md).
The selected operator is approval-bound but excluded from consumer exports.
Execution milestone validation on Windows / Node 24.19.0: **110 targeted offline
tests passed** (25 execution, 38 preparation, 35 FCC, 11 CLI/guidance/independence
and one fresh packed-consumer journey), plus CLI syntax and strict types.
Coverage includes synthetic SSO/PKCE/confidential registration, private identity
and no-replay failures, result import, bounded secret reads, subprocess
termination, malformed records and packed command/flag checks with networking
and subprocesses denied. The Linux-specific filesystem branch was not run on
Windows; live Linux/browser/ATK and consumer qualification remain outstanding.
This is not a rerun of the historical full suite.

Subsequent Windows-first investigation: the safe native Windows precheck did
not establish broker/credential-store isolation, so no ATK sign-in was attempted.
An existing WSL 2 Ubuntu environment passed seven focused checks using private
official Node 22.23.3 tooling, including the real Linux filesystem branch.
No system tooling, Windows account, Sandbox feature or Docker environment was
installed/changed. Temporary Node tooling was removed. Pinned ATK registry
metadata retrieval encountered TLS handshake failures; no verification bypass
or alternative provider installation was attempted. Linux browser/ATK sign-in,
registration and full packed portability remain outstanding. See
[the Windows-first assessment](auth-registration.md#windows-first-isolation-check).

Follow-up resolved public registry access from WSL without disabling TLS checks.
Private Node 22.23.3 and ATK 1.1.17 were installed with isolated npm configuration
and installation scripts disabled. Real ATK help completed in the private
runtime with network dispatch denied; no account cache was created, and runtime
cleanup was verified. Its known experimentation request was blocked in the probe
and is now disclosed in login/register plans rather than hidden by a claim that
`--telemetry false` disables all ancillary networking. Windows-to-WSL loopback
forwarding passed a synthetic unique-marker check. Browser authentication and
real registration remain separate; no credentials were used in these checks.

Final continuation validation: 33 targeted Windows tests passed (25 auth
execution, four CLI feedback, three independence and one fresh packed consumer),
plus syntax/types. Twelve focused Linux checks passed on Node 22.23.3: eight
execution/provider checks, including real tmpfs isolation and the synthetic
SSO-to-FCC journey, plus four CLI-feedback checks. Late-feedback testing now uses
an explicitly released promise instead of a wall-clock timer, avoiding warning/
event-loop timing interference observed on Linux Node 22. These checks are
separate from the real ATK help and synthetic Windows-to-WSL callback probes.

Subsequent Q1 check: the complete fresh packed-consumer test passed on Linux
Node 22.23.3 and Windows. The first Linux attempt lacked cached npm packages;
public runtime dependencies were fetched separately into a private cache with
installation scripts disabled. The next attempt exceeded the unchanged
180-second test timeout on the Windows-mounted fixture filesystem. Moving the
disposable consumer fixture to the OS temporary directory resolved that
bottleneck: Linux completed in about 103 seconds and Windows in about 67 seconds.
The passing test still packs/installs offline and denies runtime networking and
subprocesses. This is one complete packed-consumer test, not the full Linux test
suite or live provider qualification.

Final targeted auth milestone: 85 tests passed (38 auth, 35 FCC, 11 shared
CLI/guidance/independence and one expanded fresh packed-consumer journey).
The packed journey covers SSO reference import, OAuth PKCE, confidential-client
reference blocking and effect-flag rejection with runtime networking/subprocesses
denied. Syntax and strict types passed. This is not a full-suite or live result.
The manual-handoff change passed 33 FCC tests plus the offline packed-consumer
test, CLI syntax checking and strict TypeScript checking on Windows. This is a
targeted result, not a rerun of the historical 607-test full-suite milestone.

FCC milestone validation on Windows / Node 24.19.0: `npm run check`,
`npm run test:types`, and `npm test` passed. The full suite passed 607 tests,
including the 28 FCC tests and the expanded packed-consumer rehearsal. This
validates local engineering behavior only. No Azure, provider, token-store or
Microsoft 365 live journey was run during that offline milestone; Linux remains Q1.

### Separately authorized anonymous-MCP pilot

Screened observations from 2026-10-15; the underlying configuration, capture,
bundle and registration details remain in the selected private session workspace.
This is an existing public MCP endpoint, not a generated REST adapter or SSO test.

| Layer | Observed result | Remaining boundary |
| --- | --- | --- |
| Toolkit discovery | Initialize and tools-list succeeded; three tools declared read-only, non-destructive and idempotent | No tools/call proof or result-quality assertion |
| Local FCC export | Reviewed bundle written with no gaps and manual checkpoints required | Bundle is not a deployable manifest or consumer-readiness assertion |
| Admin registration | One custom connector created; later visible in Your Connections and the tools registry | Initial empty list was transient; reconcile before retrying creation |
| Admin rollout | Ready, enabled, visible to everyone; three read-only and zero write/delete tools | Tenant-wide audience was explicitly user-selected, not a toolkit default |
| Consumer execution | Not yet verified | Must attribute invocation to the custom entry; built-in connector and web results do not qualify |

The existing built-in connector was left unchanged. The admin form rejected a
reserved brand word in the proposed display name; a neutral name and newly
reviewed bundle resolved the form validation. The tools registry initially
reported unsupported discovery while the connector details later showed all
three tools; neither registry availability nor a discovery count proves consumer
execution. No authentication cache, real identity, raw capture or approval is
published here. Historical consumed proofs remain consumed.

## Requested capability backlog

Backlog inclusion alone is not approval to implement, collect credentials,
deploy or call a provider. The hosting-recipe order below and starting local
work on B2 were explicitly requested on 2026-10-18. Live execution remains
separately approved. B1's priority and first provider profile remain unset.

| ID | Work | Status | Completion gate |
| --- | --- | --- | --- |
| B1 | Support upstream MCP servers requiring username/password authentication | Requested 2026-10-18; not implemented | Review direct HTTP Basic and password-to-token exchange as distinct profiles; agree secure credential storage, caller isolation, token lifecycle and consumer compatibility before implementation |
| B2 | Recipe 1: MCP server hosted directly on Azure Container Apps, without APIM | Local generation/runtime/release/reference implemented; offline checked | Entra delegated callers, reviewed fixed GETs, anonymous or Key Vault API-key JSON backend and server-owned annotations. Operator deployment; live qualification and future guarded cloud automation remain |
| B3 | Recipe 2: APIM gateway in front of the Container Apps MCP server | Local proxy/server/release/reference implemented; offline checked | Independent signed gateway identity plus caller token; inherited HTTP proxy policies, no native tool generation. Live token issuance, policy behavior and consumer labels remain; SSE is not supported by this JSON-only profile |
| B4 | Recipe 3: MCP server hosted on Azure App Service | Local generation/runtime/release implemented; offline checked | Existing Linux Basic-or-higher plan; managed-identity image pull and actual platform hostname. Live image pull, routing, authentication and consumer checks remain |
| B5 | Recipe 4: MCP server hosted on Azure Functions | Local SDK custom-handler generation and source release implemented | Public preview, Linux Flex Consumption, stateless JSON, identity-based blob/deployment storage; actual Functions host, remote build and live consumer validation remain |

### B2-B5: Alternative MCP hosting recipes

User-directed order: **Container Apps direct -> Container Apps with APIM gateway
-> App Service -> Functions**. APIM is explicitly the second recipe, not a
requirement for the first. AKS remains an option to evaluate for customers with
existing clusters, not part of the initial implementation sequence.

- Build a shared SDK-based MCP server with host-specific deployment recipes.
  Hosting alone does not supply annotations: the server must publish accurate,
  reviewed tool hints, including `readOnlyHint` where applicable. Do not infer
  safety from HTTP GET alone or manufacture observed consumer metadata.
- Start B2 with a bounded REST-to-MCP profile, not arbitrary code generation or
  automatic exposure of every OpenAPI operation. Reuse existing validation and
  mapping logic where compatible. The existing APIM definition, descriptor,
  ownership and evidence contracts must remain unchanged.
- The initial B2 implementation uses Entra v2 delegated caller sign-in and an
  anonymous backend returning JSON. This is the conservative implementation
  default, not a user approval to expose an endpoint or access private source
  data. Broader authentication profiles need a separate scope review. Direct
  hosting retains access checks, request limits and safe logging.
- Each recipe must include editable server source, local startup instructions,
  reviewable infrastructure files, configuration guidance and troubleshooting.
  Generation must not install dependencies, build/push images, create resources,
  register authentication, discover tools or execute a backend call implicitly.
- Treat the new generated project as a new contract. Do not feed it into the
  existing APIM lifecycle or treat generated tool definitions as a tools/list
  capture. Deployment, discovery, proof, FCC/plugin onboarding and actual
  consumer verification retain their separate boundaries.
- B3 must reuse the MCP server's definitions through an existing-server proxy.
  Do not fall back to native REST-to-MCP generation or rewrite response bodies
  to patch annotations. Review which identity reaches the backend and ensure
  callers cannot bypass gateway restrictions through the direct app endpoint.
- Acceptance must distinguish offline generation/runtime checks from live
  hosting, authentication, discovery and consumer results. Verify the actual
  Read/Write labels in the target Copilot experience before claiming the
  annotation issue is resolved end to end.
- Keep native APIM generation available with its documented annotation
  limitation. These recipes are additions, not a migration of existing projects,
  renewal of historical evidence or permission to replay consumed proofs.

Design references (documentation review, not deployed qualification):
[Azure hosting comparison](https://learn.microsoft.com/azure/container-apps/mcp-choosing-azure-service),
[existing MCP server behind APIM](https://learn.microsoft.com/azure/api-management/expose-existing-mcp-server),
and [SDK-based Functions hosting](https://learn.microsoft.com/azure/azure-functions/self-hosted-mcp-servers).
The reviewed Functions SDK-hosting route is public preview, stateless Streamable
HTTP and Flex Consumption only; do not generalize it to every Functions plan.

#### B2 initial local implementation

Follow-up milestone: sealed source manifests, exact image/template release
preparation, source-only ZIPs and an explicit unverified existing-MCP endpoint
reference now connect generated source to the existing discovery/proof/FCC flows.
No tools capture or deployment evidence is synthesized. Sixteen focused offline
tests passed across source/runtime generation, artifact preparation, real local
signatures, bounded HTTP and original APIM parity. Azure execution remains manual.

`mcp-container-apps-schema/plan/create` generates editable Node.js source using
the official MCP SDK, a separate pinned runtime package/lock, Docker build files,
an ARM template, source/license notices and [recipe instructions](container-apps-recipe.md).
The existing APIM input, descriptor, lifecycle and root library API are unchanged.
The conversational skill documents the separate route; the terminal wizard does
not yet offer it.

Source generation requires exact input/build/file/destination approval and never
overwrites a directory. The runtime checks token signatures, issuer, tenant,
v2 audience, delegated scope, calling-client allowlist and lifetime; it does not
trust forwarded identity headers. Backend requests have fixed URLs, no forwarded
caller credentials, redirect rejection, 10-second deadlines, 1 MiB JSON response
limits and no automatic retry. Request limits are 64 KiB and 20 concurrent
requests, with a per-process minute budget.

Offline checks cover the actual SDK annotations/calls through synthetic
transports, signed local token rejection cases, HTTP rejection and limits,
approval/target/input changes, independent generated-server installation from
cache and fresh packed CLI execution with networking/processes denied.
The initial packed check exposed a test assumption that every dependency has a
root CommonJS entry; it now resolves the SDK's actual server entry point.
The exact-size test uses valid JSON-RPC metadata rather than an unsupported
top-level field. These corrections do not weaken runtime validation.
Final focused run: 19 tests passed across the recipe, fresh packed consumer,
CLI feedback and original generation parity; CLI syntax and strict public types
passed. Exact 64 KiB request and 1 MiB response boundaries and real ten-second
backend cancellation were exercised. The full repository suite was not rerun.

Remaining B2 work: future guarded Azure prerequisite inspection/deployment
automation and verified endpoint readback, plus an explicitly approved live
deployment and consumer Read/Write classification check. Local endpoint
references now bridge to discovery/proof/FCC but are not deployment receipts.
The current template references an existing environment,
registry and pull identity and requires a separately selected image. It can
update an existing app if manually misapplied: no cloud ownership/no-overwrite
guarantee is claimed. No image was built/pushed, no Azure/M365/provider operation
was executed, and no historical evidence or consumed proof was changed.

#### B3-B5 sequential local milestones

Recipe 2 generates an SDK-owned server plus a separate APIM HTTP proxy template.
Both signed gateway identity and delegated caller are required; inherited
policies remain. Release parameters bind separate resource groups and the
explicit backend origin. Recipe 3 adds Linux App Service container hosting with
the identity client ID required for image pull and actual platform hostname.
Recipe 4 adds a Linux FC1 preview custom handler, managed-identity storage,
explicit admin-route protection and source-hash-bound release preparation.
It does not replace the SDK with the Functions MCP trigger extension.

The latest combined focused run passed 18 checks, including all four recipes,
actual SDK/JWT/HTTP behavior and a fresh packed CLI with runtime network/process
creation denied. The independent generated runtime also installed from cache
and loaded successfully. CLI syntax and strict public types passed. This is
offline evidence, not a Functions Core Tools or Azure runtime qualification.
Complete synthetic examples, per-host guides, shared release/reference flow,
CLI help/capabilities and the shipped Copilot skill are included.

Final repository-wide regression: `npm test` passed all **792 tests**, with no
failures, skips or cancellations. CLI syntax and strict public types also passed.
This includes fresh packed-consumer execution of all four hosting profiles,
release/reference commands, correct gateway/preview approval summaries, and
unchanged historical lifecycle/evidence boundaries. The suite remained offline;
no Functions Core Tools host, Azure deployment or live consumer was exercised.

Commits were pushed periodically in the approved recipe order. No live
deployment or scenario validation was attempted. The real-environment checklist
is in [the shared guide](hosting-recipes.md#checks-still-needed-in-the-real-environment).

#### B2-B5 API-key backend extension

User-directed on 2026-10-21 while the parent checkout was being tested.
Implemented locally across `container-apps-direct-v1`,
`container-apps-apim-v1`, `app-service-container-v1` and `functions-sdk-v1`.
The original direct-only commands also accept this profile. New synthetic
`examples/mcp/*-api-key.json` inputs cover both dedicated header and query
placement. The shared guide documents schema, operator/local launch, separate
identity/access reviews and platform cache/rotation behavior.

The closed API-key shape binds the tenant, vault ARM resource, secret URI,
dedicated user-assigned identity and exactly one placement name. Shared
entitlement review is required; query mode additionally requires URL-exposure
review. Same-subscription/tenant declarations and matching vault hostnames are
enforced locally; actual Azure metadata/access is not inspected or attested.
Pull/storage identity reuse is rejected. Existing identities, grants and
resources are untouched. Container Apps uses `keyVaultUrl`/identity/secretRef;
App Service and Functions use Key Vault app settings and
`keyVaultReferenceIdentity`. No credential SDK/dependency was added.

The SDK rejects missing/unresolved/empty/malformed credentials before startup.
It snapshots the injected value, sends only the configured key plus JSON Accept,
does not forward caller/gateway tokens, rejects redirects and obvious secret
reflection, and retains generic errors, request/body/time/concurrency bounds
and no dispatched-call retry. OpenAPI security must match the reviewed API key;
mixed/optional/unsupported declarations are not silently discarded. Source
and release reviews include nonsecret backend choices and exact hash binding.
Anonymous behavior and historical native APIM contracts are preserved.

The final focused run passed 38 offline tests covering all templates/placements,
real SDK protocol calls, local JWT/HTTP authorization, rejection, sealed release
and approval changes. The extended fresh packed consumer passed after correcting
a test-loop placement that intentionally hit the existing no-overwrite guard.
It generates all four API-key examples, independently installs the shared
generated runtime from cache, exercises real SDK calls/reflection and fails
actual startup on missing/unresolved references, with runtime networking and
subprocesses denied. CLI syntax and strict public types passed. Final repository
regression passed **807 tests**, with zero failures, skips or cancellations
(about 18 minutes on Windows). This includes the final reserved method/routing/
platform-identity header rejection and the unchanged native APIM regressions.
All 86 local links in the affected guides resolve; the PowerShell examples parse
without execution. Missing local dependencies were
restored with offline `npm ci`; no dependency versions or lockfiles changed.
No cloud/provider operation, publication, installed skill modification or
parent-checkout change occurred. Actual secret resolution, least-privilege
access, safe diagnostics, refresh/restart and provider/consumer compatibility
remain separate live qualification. Historical source/release evidence and
consumed proof reservations are not upgraded or replayed.

Implementation was committed/pushed as `d864ed2` (all four profiles, documentation,
examples and regressions) and `b6711f7` (reserved-header hardening) on
`svarukala-api-key-hosting-recipes`. No pull request, merge or parent-branch
modification was performed.

### B1: Username/password-authenticated MCP

See the separately implemented API-key profile immediately above; API keys do
not implement username/password or password-to-token authentication.

- Distinguish direct HTTP Basic on the MCP endpoint from a provider token
  endpoint accepting username/password and returning a bearer token. Neither
  implies OAuth authorization-code support or a generic OAuth password grant.
  Prefer provider-supported authorization code with PKCE when available.
- Design a bounded adapter/proxy contract, not password fields in a Cowork
  manifest or skill. Use explicit Key Vault credential references; never put
  credential values or tokens in CLI arguments, project JSON, logs, examples,
  exports or consumer handoffs.
- Keep downstream caller authentication separate and protected. Review
  per-user credentials versus an explicitly licensed service account; never
  share a personal account implicitly or expose protected provider data through
  an anonymous endpoint. Confirm provider terms and entitlements.
- Specify token acquisition, expiry/renewal, credential rotation and failure
  handling. Never silently replay failed, unknown or consumed MCP tool calls
  when renewing a token; preserve existing approvals, evidence and locks.
- Acceptance requires synthetic offline coverage of credential isolation,
  redaction, expiry, rejection and no-replay behavior, plus updated intake,
  schemas, documentation and consumer handoff limitations. Live provider and
  Cowork qualification remain separate, explicitly approved operations.
- Morningstar's [programmatic authentication documentation](https://developer.morningstar.com/content/documentation/api-utilities/authentication-api/api-reference/3.1.0/authentication-api-oas.json)
  is a reference example, not a selected implementation target. Its
  [MCP overview](https://developer.morningstar.com/direct-web-services/documentation/morningstar-ai-integrations/morningstar-mcp-server/overview)
  also documents OAuth integrations; do not assume username/password exchange
  is the only route or that custom-client authorization-code compatibility is
  already verified.

## Next work: MCP Toolkit to WIQD

These are recommendations, not an already approved implementation backlog.
Dependencies are explicit; list order alone does not authorize or require work.
See [the proposal](wiqd-handoff.md) for acceptance criteria and ownership.

| ID | Priority | Work | Owner | Status | Depends on / completion gate |
| --- | --- | --- | --- | --- | --- |
| H1 | P0 | Define versioned consumer-neutral handoff and privacy/freshness rules | MCP Toolkit | Proposed | Review current contracts; agree bounded schema before implementation |
| H2 | P0 | Verify secretless Entra to WIQD/Cowork credential-registration compatibility | Shared auth preparation/execution here; WIQD owns consumer mapping | Provider contract inspected; consumer compatibility unverified | AUTH3/AUTH4 implementation does not qualify the Linux provider or establish live auth/package compatibility; AUTH5 remains narrow reference metadata |
| H3 | P1 | Implement reviewed local handoff export and offline contract tests | MCP Toolkit | Not started | H1; no login, discovery, proof replay or evidence renewal during export |
| H4 | P1 | Document synthetic WIQD consumption with existing skills | WIQD workflow guidance + MCP docs | Not started | H1, H2; observed tools mapped to required package artifact, not invented |
| H5 | P1 | Address Cowork-specific metadata/validation gaps upstream | WIQD | Proposed | Confirm each gap against current behavior before proposing fixes |
| H6 | P1 | Verify one MCP Toolkit -> WIQD -> Cowork journey | Explicitly authorized operator | Not started | H2, H3, H4 and applicable H5; fresh purpose/approvals, bounded cost, separate layer results |
| H7 | P2 | Decide whether a thin deterministic WIQD adapter/extension is justified | Joint | Deferred | H4/H6 experience; no duplicated infrastructure/auth engine |
| Q1 | P2 | Linux/offline packed portability run | MCP Toolkit | Complete for the packed-consumer test | Full fresh packed-consumer test passed on Linux Node 22.23.3 with offline installation and denied runtime networking/subprocesses; Windows counterpart also passed. Twelve focused Linux checks are separate prior evidence. Full Linux suite and live authentication are not claimed |
| Q2 | P2 | Resolve provider invalid-key rejection uncertainty | Separate provider-specific investigation | Inconclusive | New justified purpose, exact approvals and cost bounds; never replay consumed checks |
| R1 | Later | Archive the frozen Cowork repository | Repository owner | Deferred | Account for remaining consumer handoff needs and obtain explicit archive decision |

## Status discipline

Record the exact scope of every result: generated / configuration-checked /
discovered / protocol-success / result-asserted / caller-rejection /
backend-rejection / package-validated / consumer-executed. Never replace these
with a single undifferentiated "passed" label.

Live result updates need separately retained private evidence references; only a
screened nonsecret summary belongs here. Do not publish receipt bodies or real
resource names to make the table look complete. Missing evidence means unknown
or not recorded, not success.
