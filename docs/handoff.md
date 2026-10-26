# Session handoff

Last updated: 2026-10-26. This is the starting point for a new MCP Toolkit session.
It contains public engineering context only, not credentials or execution authority.

## Decisions and current baseline

- **Runner stabilization and cost closeout:** the
  [two-stage workflow](reusable-validation.md#choose-the-entry-point) now clearly
  separates unattended hosting from owner-present runtime sign-in, with the
  existing-endpoint session as a separately reviewed alternative. Offline SDK
  regressions verify that a clean pause does not authenticate, consume a provider
  call, rebuild or redeploy, and that the same grant can subsequently finish.
  Asset inventory, syntax and strict public types passed. The default-concurrency
  full suite passed 1091/1092; its direct-ACA header-key creation journey passed
  1/1 in isolation, then the entire suite passed **1092/1092** with
  `--test-concurrency=4`. No production timeout was relaxed; the initial failure's
  exact cause is unconfirmed, not silently relabeled as a pass.
  Separately, the owner approved deletion of three superseded pilot apps.
  Complete read-only ARM inventory verified their absence and retention of the
  latest validated app and two pre-existing scenario apps. A first deletion's
  absence-check error was reconciled through collection readback without
  repeating that DELETE. Shared infrastructure and all local evidence remain
  untouched; remaining apps and shared resources can still incur charges.

- **Existing-app validation completed successfully.** After the user requested
  another sign-in attempt, the single-process session completed expected-user
  authentication, fresh discovery and exactly one `get_validation_fixture({})`
  dispatch with `protocol-success` at `2026-10-26T13:17:34.665Z`. Capture,
  dispatch and proof receipt bindings were checked; dispatch followed discovery
  by more than 65 seconds. The process ended with no persisted token. There was
  no rebuild, new Azure resource or automatic retry. The app now has successful
  hosting evidence and a subsequent successful authentication/discovery/proof
  session. These are separate executions, not one uninterrupted combined run;
  the original timed-out execution remains unchanged. Business correctness,
  negative-authorization and consumer acceptance are not established. The app
  remains deployed and billable.

- **Next-day proof session stopped during authentication.** The user requested
  proceeding with one fresh sign-in-and-proof session against the existing app,
  with no rebuild or new resources. It ended at `2026-10-26T13:11:37.962Z`
  with `AUTHENTICATION_TIMEOUT` at token acquisition, before a new capture or
  tool dispatch. The process ended and its failure receipt was retained; no
  automatic retry occurred. Timeout evidence alone does not establish whether
  user interaction, connectivity or another authentication issue caused it.
  The prior successful discovery below remains historical, not a reusable token.

- **Subsequent user-requested sign-in and discovery passed.** A fresh
  discovery-only operation against the existing app retained an authenticated
  `tools/list` capture at `2026-10-26T01:56:46.926Z`, exposing
  `get_validation_fixture`. Its process ended with no dispatch or proof receipts.
  No rebuild, new app or provider call occurred. This separate capture does not
  repair the timed-out combined run below or establish full build-through-proof
  success. Authentication is not persisted for a later unattended proof.

- **Latest combined live run: hosting passed; sign-in timed out.** Following
  explicit recovery approval, only the stale shared identity mutex was archived;
  previous run locks, reservations and consumed receipts were preserved. A fresh
  create-only run passed identity, preflight, build, scan, smoke, push, image
  qualification, app readback, revision readiness and health, then generated its
  release and reference. Its interactive session stopped at
  `2026-10-26T01:53:17.913Z` with `AUTHENTICATION_TIMEOUT` at the token stage.
  No discovery capture, tool dispatch or proof receipt was produced. The outer
  session budget was reserved before authentication and remains consumed; zero
  dispatch receipts must not be treated as permission to replay it. The process
  ended, and its current host/identity mutexes were released normally. No retry
  was started. The app remains deployed and can incur charges. This establishes
  a successful uninterrupted hosting chain, not a full build-through-proof pass.
  The earlier standalone successful proof remains valid historical evidence.

- The next explicitly approved attempt stopped after one private identity check,
  before host preflight, build, deployment or provider dispatch. The earlier
  cancelled process had left a shared private-identity host lock. Its PID was
  confirmed absent, but the lock and all old execution barriers were preserved.
  Fresh execution planning now rejects a locked explicit identity; a lock found
  after grant creation pauses before host authorization is consumed. It never
  deletes a lock automatically or treats a missing PID as permission to replay.
  The consumed attempt is not repaired by this change.

- A later full run, under the user's clarified approval, passed through app
  creation/readback but kept polling revision readiness. Separate bounded ARM
  inspection found an active, healthy, provisioned revision in
  `RunningAtMaxScale`, the documented healthy state for an app at its replica
  ceiling. The runner had accepted only `Running`. Polling was cancelled;
  incomplete execution evidence is retained and no provider call was made.
  Both initial readiness and pre/post-health checks now accept `Running` or
  `RunningAtMaxScale`, still requiring active/healthy status, exact revision and
  template checks. See [Azure revision lifecycle](https://learn.microsoft.com/azure/container-apps/revisions#lifecycle).
  This correction does not retroactively complete that run or authorize a replay.
  Focused state/health regressions passed 12/12. The subsequent full offline SDK
  journeys and one-sign-in proof-pacing check passed 5/5, using synthetic services.

- **First successful live fixture proof:** the corrected endpoint completed
  expected-user Entra authentication, observed discovery and exactly one
  `get_validation_fixture({})` call with `protocol-success`. The independent
  interactive-session runner retained a capture, one dispatch and one proof
  receipt, waited more than 65 seconds after discovery, and ended without token
  persistence. This establishes a working live authentication/discovery/proof
  path, not business correctness, consumer acceptance or an uninterrupted
  create/deploy/prove run. No additional fixture call is implied.

- The separately approved corrected JSON-blob run passed private identity,
  preflight, build, vulnerability scan, nonroot smoke, push and image qualification.
  App readback stopped unknown/no-replay before discovery or provider dispatch.
  An independent exact ARM read confirmed the new app was created and its latest
  revision was ready. Azure lowercased `resourceGroups` in the assigned-identity
  dictionary key; the runner's literal key-set comparison rejected that spelling.
  Readback now compares only known ARM identity/environment reference fields
  case-insensitively, while requiring the exact identity set and rejecting missing,
  extra, different or case-duplicate identities. URLs and other strings remain
  exact. This does not repair the consumed run. The separate endpoint validation
  above preserved that history and did not redeploy or retry a provider call.

- Earlier raw-fixture outcome: the user-directed interactive `mcp-session` on the same
  endpoint project completed expected-user Entra sign-in and authenticated tool
  discovery. After a separate exact proof review and a 65-second rate-limit
  delay, it dispatched exactly one fixed fixture call, which returned
  `tool-error`. Bounded app-log inspection confirmed backend HTTP 200 with
  `failureKind: content-type`. The raw repository-file fixture does not satisfy
  the runtime's JSON content-type contract; do not weaken that contract or call
  this a successful provider proof. The next fixture must actually serve JSON
  with a supported content type, with any changed deployment/provider call
  separately reviewed. No further call, image update or deployment is approved
  by this outcome. The prior aborted discovery remains in the same project's
  proof history as `not-proof`; the old outer execution was not resumed.
  Authentication/discovery now have live evidence, but no passing full
  create/deploy/prove runner or consumer acceptance is established.
  The subsequently approved corrected fixture uses the documented GitHub
  Get-a-blob JSON envelope and a locally resolved immutable blob ID. Its image
  and additional create-only app were separately approved, including ongoing
  costs. The later run above reached deployment but not a provider call.
  Existing apps and consumed evidence were not replaced.

- Push-result compatibility now accepts both classic Docker `aux.Digest` and
  containerd's exact tagged digest status message, rejecting errors, incomplete
  streams and conflicting digests. Local image/registry-digest checks remain.
  This fixes a reproduced compatibility gap; the lost historical response was
  not recovered, so it is not a conclusive reconstruction of the pilot failure.
  A separate [verified-image deployment-only contract](verified-image-deployment.md)
  can create the original absent direct-ACA target from an eligible retained
  build/scan/smoke chain and independently checked ACR digest. It never rebuilds,
  repushes, resumes the consumed parent or rewrites its receipts/reservation.
  New expiring approval, private identity, fresh scan, trusted deployment inputs,
  conditional create and one-shot continuation claims are required.
  Focused review found no significant issues. The targeted host, deployment,
  push-parser and CLI-feedback checks passed **68/68**. Additional orchestration
  and packed-consumer checks passed **41/42** in parallel; the anonymous execution
  case failed with an unknown phase outcome, then passed **1/1** in an isolated
  fresh synthetic run. The parallel failure is not explained conclusively and
  is not reported as an all-green suite. Live deployment and MCP proof remain
  pending at that review; engineering does not establish reusable end-to-end
  live success. The subsequent separately reviewed deployment-only attempt
  reused private identity, reverified the image in ACR and created the app.
  Its app stage nevertheless stopped unknown/no-replay during readback. A
  separate exact read confirmed provisioning succeeded and the latest revision
  was also the ready revision. Azure returned ingress transport `Http`, while
  the runner expected literal `http`; region display-name normalization was
  already supported. Readback now normalizes only this documented transport
  enum, not URLs or other arbitrary strings, and reports explicit readback
  mismatch reasons. Synthetic Azure responses now use `Http`; negative cases
  retain rejection for a different transport or changed URL path casing.
  The correction passed **4/4** focused full-host, deployment-only and negative
  readback checks; follow-up review found no significant issues. No deployment
  was replayed and no old receipt was rewritten. A subsequent separate bounded
  HTTPS health GET returned 200 and the exact expected body. Authentication and
  provider proof remain unverified; the original runner is still not a passing
  end-to-end run. A separate existing-endpoint execution was then started for
  the same single fixture proof, with zero Azure-command authority and
  memory-only Entra authentication. Its session/discovery operation ended with
  `ABORTED` after approximately the configured ten-minute run limit, retaining
  `failed-no-capture` evidence. No successful discovery or proof was recorded.
  The write-ahead provider-call budget is consumed, not evidence that a provider
  call actually occurred. Sign-in completion cannot be inferred from these
  receipts. Preserve this new protocol history too; no automatic retry or new
  reference to bypass its consumed grant.
  Follow-up diagnosis found that parent cancellation discarded already-sanitized
  Entra stage diagnostics. Future aborted operations now retain the allowlisted
  stage (authority/device-code/token/metadata), with generic SDK cancellation
  context and no stale HTTP result, device challenge, token or raw exception.
  This does not reconstruct the earlier lost stage or alter its failed receipt.
  Complete discovery and delegated-session regressions passed **120/120**,
  including persisted cancellation-stage evidence, redaction and no-replay.

- PR #4 merged as `3fb492b` after focused review and all four Ubuntu/Windows,
  Node 22/24 CI jobs passed. Its separately approved fresh bundled-runtime
  pilot reused private Azure identity and passed infrastructure preflight,
  image build, verified Docker/Trivy binding, zero-critical/high scan and
  network-disabled nonroot smoke. The live scan retained OS and 13 npm package
  records, excluded Express/body-parser/esbuild, and reported 25 medium / 10 low
  findings. This qualifies the packaging workaround for that image, not an
  upstream dependency upgrade or complete deployment qualification.
  Push then stopped with `HOST_EXECUTION_UNCLASSIFIED_FAILURE` and an
  `unknown-no-replay` receipt. Retained local Docker metadata includes a push
  event and repository digest. A separately approved read-only registry check
  subsequently confirmed that the exact tag resolves to the scanned image
  digest, with a registry creation time matching the push. The image reached
  ACR; the precise reason the runner rejected/stopped the push stage remains
  unconfirmed because the original response detail was not retained.
  No app creation or provider proof followed;
  consumption was 11 logical Azure commands and zero provider calls.
  Both old and new consumed runs remain unchanged. Reconciliation used two
  private-identity read commands plus local CLI help, without retries or writes.
  Do not retry push, replay either grant, or claim deployment success.

- PR #3 merged as `214df63` after the Ubuntu/Windows, Node 22/24 matrix passed.
  A separately approved bounded pilot completed private Azure identity,
  infrastructure preflight and image build, then stopped in scan before any
  push, deployment or provider call. Its immutable failed/unknown history is
  preserved, not replayable. Read-only diagnosis found that Docker's containerd
  image ID was an OCI manifest digest while Trivy reported its config digest.
  The subsequent correction verifies the single-image export's config and
  layer bytes, including the OCI manifest chain, before comparing Trivy's
  config digest and ordered diff IDs. Classic Docker-save IDs remain supported.
  Rejected bounded scanner reports stay private; allowlisted reason codes
  distinguish binding, policy and container failures without raw errors.
  All four execution regression files passed **74/74**, plus inventory, syntax
  and public types. This correction is not live-qualified or a replay grant.
  The retained diagnostic report also listed HIGH `CVE-2026-111181` in
  `body-parser` 2.3.0. Its suggested 2.4.0 fix was unavailable in the configured
  feed; direct npm registry lookup failed TLS. Upstream subsequently confirmed
  [2.4.0 is released](https://github.com/expressjs/body-parser/releases/tag/v2.4.0)
  and fixes the finding. Both configured feed tarball URLs returned HTTP 404.
  No dependency pin, TLS setting or zero-critical/high policy was weakened.
  Upgrading the dependency remains blocked on access to the fixed distribution.
  The separately approved engineering alternative bundles newly generated
  container runtimes, excluding unused Express/body-parser code rather than
  downgrading or hiding used components. It preserves original contributing
  package metadata/notices, deterministic build inventory and all image scan
  requirements. Functions and historical projects remain source-only/unchanged.
  See [runtime packaging](hosting-recipes.md#bundled-container-runtime).
  This alternative still needs a fresh reviewed image scan; no new live run,
  security exception or replay of the consumed pilot is implied.
  The combined local correction passed **90/90** packaging, hosting, handover
  and fresh offline packed-consumer checks, plus **74/74** execution regressions,
  asset inventory, syntax and strict public types. Actual bundle checks cover
  reproducibility, standalone execution, licenses, rejected inputs and all six
  container-family/backend-auth combinations. These are offline results, not
  a passing image scan or cross-platform CI result for this revision.
  The advisory's `inflate: false` workaround is not
  a zero-HIGH dependency scan pass and has not been substituted for an upgrade.
  No identities, raw reports or generated pilot projects belong in this repo.

- Opt-in `mcp-execution-schema/plan/start/run/status/record` now layers one
  explicit, expiring execution grant over unchanged validation v1/v2. It covers
  all five existing creation families: direct ACA, ACA behind APIM, native APIM
  REST, existing MCP and proxies. The SDK adapter performs bounded build, strict
  scan, isolated smoke, push and create-only hosting; initial review includes
  downloads, exact infrastructure, identities, resource limits and one proof.
  Private Azure authentication is reused; eligible MCP discovery/proof shares
  memory-only authentication without a second proof-approval question.
  Parent/child journal binding, write-ahead budgets, input/build checks and
  consumed/unknown barriers prevent silent adoption or retry.
  See [bounded execution](reusable-validation.md#bounded-execution-separate-contract-version-1).
  This is offline engineering, not live qualification or authority for a run.
  Genuine prerequisites, MFA/consent, failed security checks and unsupported
  profiles remain human boundaries. Health-backed key injection is not provider
  validity or rotation; consumer/negative/bypass acceptance remains distinct.
  Resource limits are not an invoice cap and local locks are not distributed
  Azure exclusion. Historical ReqRes proofs remain consumed and provider-blocked.
  The v2-only scope and older validation counts below are historical baselines,
  not limitations or new verification claims for the opt-in execution layer.
  Baseline `1379297` passed `npm run validate`: **1022/1022** tests,
  zero failures/skips/cancellations, asset inventory, recursive syntax and
  strict public types. Coverage includes all four complete synthetic SDK
  combinations (direct/gateway, anonymous/key backend), caller reuse, journal
  drift, consumed budgets and the fresh offline packed consumer. These
  closeout notes followed that run. Subsequent PR review corrected optional
  APIM policy-format readback, parameterized existing-MCP session selection and
  case-insensitive GUID identity matching (without folding scopes or URI strings).
  Those corrections have their own regressions; the 1022-test count is the
  pre-review baseline, not evidence for the corrected revision.
  The directly affected regression suite passed 79/79. Review follow-up aligned
  creation-journey and handover reference checks with canonical runtime identities;
  its mixed-case full SDK journey, handover and foreign-reference checks passed
  3/3. Source input spelling, scope/URI case and immutable artifacts are preserved.
  PR CI must qualify the final revision across the configured four-job matrix.
  Clean CI exposed test portability assumptions: unawaited nested tests on
  Node 22, colliding clock-derived diagnostic fixtures, a Windows-only symlink
  path and reliance on ambient npm metadata. Fixtures now await subtests, use
  fixed distinct timestamps and native paths. Packed installation uses a
  deterministic consumer lock and a private, integrity-verified tarball cache
  without registry metadata. Root `fast-uri` is aligned to the recipe's already
  pinned 3.1.8 so ordinary CI dependency restoration supplies the required bytes.
  None of these changes permits network access from `npm test`.

- Newly generated SDK runtimes emit bounded backend failure categories and
  optional numeric HTTP status in operator logs while preserving the generic
  MCP error, no-retry behavior, response bounds and credential redaction.
  Existing deployed images and consumed proof receipts remain unchanged.
  The diagnostics cannot retroactively explain historical generic failures;
  any subsequent provider attempt remains a separate reviewed operation.

- Container runtime inputs now support explicit digest-pinned distroless Node 22
  Debian 13 nonroot images alongside the unchanged Debian 12 profile. Generate
  a new source project when switching; never retrofit sealed source or treat a
  historical passing scan as current qualification. The zero-critical/high,
  24-hour scan/database, nonroot smoke and source-binding requirements remain.
  This does not change Functions, automatically select a digest, authorize
  deployment or declare the ongoing live validation complete.

- Current priority is reusable **fresh creation** validation for direct ACA,
  ACA behind APIM, native APIM REST and existing MCP/proxies. V2 is implemented
  alongside the unchanged v1 existing-deployment contract. Focused integration
  passed **164/164**, including the fresh packed consumer; a follow-up **8/8**
  check covered terminal feedback, private identity, actual finalize delegation
  and uncertain gateway barriers. The full suite was not rerun for v2.
  It reuses exact existing phase planners/executors, preserves
  separate approvals, explicit private identity, related consumed histories and
  unsupported authentication/proof gates. SDK builds/deployment and real consumer
  actions remain separate owner operations. See the
  [v2 support matrix and sequence](reusable-validation.md#fresh-creation-runners-version-2).
  Third-party OAuth REST, OBO and username/password profiles are next, not part
  of this runner implementation; no ROPC assumption or live authorization.
  The older frozen `d9d091d` full offline gate passed **925/925**. A subsequent
  separately approved real Entra metadata discovery passed with **no tools/call**;
  historical provider proof remained consumed. Neither result qualifies v2
  fresh creation or consumer execution. Keep real identities/captures private.

- Resumable validation now has `mcp-validation-schema/plan/start/next/run/status`
  for an existing direct Container Apps source/reference and optional matched
  release. A private build-pinned run reuses existing local readers, MCP session/
  proof execution and separately approved handover. Owner checkpoints can be
  batched and deferred; they remain declarations. Successful proof is retained
  as historical evidence, while failed/unknown outcomes and locks block replay.
  Sign-in and the session's new exact proof approval stay terminal-only. The
  runner does not deploy, register authentication/FCC, resolve secrets or certify
  consumer acceptance. See [reusable validation](reusable-validation.md).
  The focused offline integration run passed **154/154** tests, including 14
  runner regressions and the fresh packed CLI with network/process execution
  denied. Adjacent session, handover, feedback and public-boundary tests passed.
  Inventory, syntax and public types passed. Closeout documentation followed
  that run; the full repository suite was not rerun for this increment. No live
  run, deployment, registration, installed-skill update or merge is authorized.

- Validation-readiness fixes are integrated following the owner's review:
  generic result-assertion receipts now pass shared strict evidence validation
  across Status/Resume/diagnosis/handover, with consumed barriers retained through
  export/restore. All four SDK recipes accept explicit `npmRegistryUrl` before
  generation; source locks, npm configuration, Docker, release review and
  destination guidance retain that feed without changing versions/integrities.
  Omission preserves historical public npm. No authenticated feeds, implicit
  installation, fallback or old-source resealing is added.
  [The acceptance checklist](validation-readiness.md) pins commit,
  build and skill identity, distinguishes source/release/reference/auth paths,
  and records per-host gates. `npm run validate` is the repeatable full offline
  gate; CI is configured for Windows/Linux and Node 22/24 but configuration alone
  is not a successful matrix run. Native Windows registration remains deferred.
  Do not infer that the feature branch has been merged into `main` or that
  installed skill copies have been updated. No live approval is implied.
  The integrated `npm run validate` gate passed **911/911** tests at `eaba3dd`,
  with zero failures, skips or cancellations on Windows, including the fresh
  packed consumer. Inventory, recursive syntax and public types passed; 140
  local documentation links were checked. The earlier run passed 910 tests
  but cancelled the packed journey at its five-minute outer test deadline.
  Its test-only budget is now ten minutes; individual subprocess and runtime
  deadlines are unchanged. The packed journey passed alone and in the full
  rerun. Subsequent closeout edits record evidence only. Real builds/downloads,
  cloud/consumer acceptance and other CI matrix environments remain separate.

- Deployment handover implementation (2026-10-22): the four sealed SDK hosting
  recipes now have `mcp-handover-schema/plan/bundle`. A separately reviewed local
  export produces two-tab offline HTML, a configured SVG architecture diagram
  and editable Excalidraw source, unchanged generated source, optional
  source-matched release assets, and a hash-bound machine-readable manifest.
  Repeat instructions distinguish destination field edits, local CLI commands,
  manual host deployment and per-operation approvals. Owner reports, pending/
  deferred milestones and historical protocol evidence are not promoted to live
  readiness. There are no browser uploads, external HTML assets, credentials,
  raw capture exports, implicit installs, cloud operations or proof replay.
  The shipped skill and generated project guides include the closeout step.
  See [deployment handover](deployment-handover.md).
  Final focused offline validation passed **57/57** tests with no failures,
  skips or cancellations, including all four recipes with anonymous/API-key
  backends, evidence and interrupted-write checks, adjacent hosting/operator
  contracts and a fresh packed consumer. Syntax and strict public types passed.
  An isolated local browser check exercised tabs, keyboard navigation, clipboard
  success/fallback, light/dark themes, print and mobile with zero external page
  requests; its generated PowerShell review script also parsed successfully.
  The preview is synthetic, not a report of the deployed pilot. The full
  repository suite was not rerun and no live qualification was performed.

- Native Windows SSO implementation (2026-10-22): `mcp-auth-execution-*` now
  supports explicit `authenticationMode: "windows-user-managed"` with
  `sharedProfileReviewed: true` for secretless Entra SSO. It uses the normal
  ATK 1.1.17 profile/broker, not isolated or copied credentials. Linux/WSL
  remains optional for isolated SSO and required for custom OAuth execution;
  omitted mode retains the historical Linux default. The Windows spike was
  sign-in evidence only, not a completed registration executor to merge.
  New code adds direct Windows Node invocation, owned-tree cancellation,
  per-user toolkit operation locking, normal-profile account/tenant review,
  and cleanup limited to owned disk-backed job files. Shared caches/logs and
  existing authentication are never cleared on close. Exact phase approvals,
  identity confirmation and cross-mode consumed-target barriers remain.
  See [Windows SSO](auth-registration.md#native-windows-sso-user-managed-profile).
  The platform restrictions described in older investigation sections below
  are historical: native Windows is now explicitly supported without claiming
  project isolation. No live login, registration or tenant mutation was run for
  this implementation; complete Windows registration remains live-unqualified.
  Final focused offline validation passed **111/111** tests with no failures,
  skips or cancellations: both authentication modes, historical preparation and
  result contracts, CLI feedback and a fresh packed consumer. The 11 Windows
  provider checks include actual native execution/termination of a synthetic
  Node child and owned-runtime cleanup, without ATK or network access. CLI syntax,
  strict public types and 86 local documentation links also passed. The full
  repository suite was not rerun for this change.

- Docker qualification update on 2026-10-22: after the owner approved starting
  Docker if needed, both supported Windows pipes were available. No start or
  restart was needed. The toolkit's separately planned engine diagnostic passed
  against the explicit Docker Desktop Linux pipe: Linux/amd64 and compatible
  with API 1.44. The immutable intent/result remain private. A separate read-only
  lookup found the required `node:22-bookworm-slim` builder image absent; no image
  was downloaded or executed. Engine availability is no longer a blocker.
  Container connectivity still needs an explicitly reviewed available image and
  execution approval. ACR/private identity and interactive MCP session gates
  remain separate; no Azure, M365 or provider call was performed.

- Live qualification began on 2026-10-22 against implementation `47722e8`.
  Correction after owner clarification: public npm is intentionally blocked;
  the repository already configures an approved alternative registry. A bounded
  HTTPS check to that feed's `/-/ping` path received HTTP 404 with certificate
  verification enabled. This establishes an HTTPS response, not npm ping or
  package-install success, and supersedes the general host-connectivity blocker.
  Both built-in npm diagnostics initially hardcoded public npm. They now accept
  an explicit approval-bound `registryProbe` for ping or a package-metadata URL,
  preserving the old default without importing npm settings or credentials.
  Host and container probes retain TLS/public-DNS checks and never install
  packages. See the [operator guide](hosting-recipes.md#environment-diagnostics-and-private-image-pulls).
  The updated toolkit's separately planned host package-metadata probe against
  the approved feed returned HTTP 200. This qualifies that host connectivity
  check only, not package installation, container connectivity or provider use.
  All 18 focused registry/host checks and the fresh offline packed-consumer test
  passed, as did CLI syntax and public types. No full-suite rerun was performed.
  Do not switch the repository to public npm or bypass the network policy.
  One host npm connectivity diagnostic returned `failed` at the `transport`
  stage, without an HTTP status; root cause is not established. The original
  intent/result remain private and no automatic retry was attempted. Docker
  checks await explicit trusted-engine selection. Private ACR pull and
  interactive discovery/proof await explicit targets/identities and separate
  approvals. No packages were installed and no cloud, provider, consumer or
  deployed-pilot operation was performed. See the
  [qualification record](progress-tracker.md#hosting-pilot-feedback-implementation).
  A user-directed follow-up narrowed the Node HTTPS error to `EPROTO`; a direct
  Windows HTTPS comparison also failed. An explicit TLS 1.2 comparison returned
  `alert handshake failure`; underlying cause remains unknown, with certificate
  verification preserved. Neither supported Windows Docker pipe was present
  during local directory inspection, so engine/container qualification is also
  blocked on engine availability. Follow-up observations are separate from the
  immutable original result; no Docker API or cloud target was contacted.

- 2026-10-22: a first implementation pass across all seven consolidated
  hosting/FCC feedback packages is committed on
  `svarukala-custom-federated-connectors`; see the
  [implementation tracker](progress-tracker.md#hosting-pilot-feedback-implementation)
  and [operator guide](hosting-recipes.md). The API-key implementation has been
  fast-forwarded into this branch. New capabilities cover qualified FCC portal
  scopes, immutable operator/waiting records, digest-pinned minimal images and
  image reviews, preserving update/readiness reviews, direct-host bootstrap,
  real-terminal auth handoff, phase-aware policy status, same-call result
  assertions and cost/closeout reviews. Historical auth bundles remain readable.
  The full offline suite at `89406f4` passed all 831 tests. The final architecture
  correction at `4b531e6` restricts container builds to `linux/amd64`; all 22
  focused hosting/artifact checks passed afterward, as did CLI syntax and strict
  public types. The full suite was not rerun after that narrow correction.
  Those first-pass capabilities are local preparation/review, not new cloud executors.
  A follow-up now implements separately approved `mcp-host-*` diagnostics and
  private ACR pulls, plus optional `mcp-session-plan/session` sign-in continuity.
  Implementation `91d5fbd` passed 139 focused checks and the full 854-test
  offline suite, including the fresh packed consumer. Final Docker header
  compatibility correction `577201a` passed 12 focused host-operation tests;
  syntax/types and 112 local documentation links also passed. The full suite
  was not rerun after that narrow correction and removal of repeated test
  registrations. These are implementation checks, not live qualification.
  See the shared guide for flags, private source-project account
  selection, local socket/Docker API requirements, synthetic examples, cleanup
  bounds and immutable pull reservations. The session is terminal-only,
  15-minute, exact-user and memory-only; proof still needs its own new approval.
  Host scheduler enforcement of waiting remains outside this repository.
  Actual image builds/scans, Azure updates/Key Vault resolution and new consumer
  scenarios still need separate qualification. New container source without
  explicit digest-pinned `imageBuild` inputs intentionally has no Dockerfile;
  old sealed projects are never rewritten.
  The owner reports the direct Container Apps API Ninjas end-to-end pilot
  completed; no new live verification or consumer/read-only-label claim is
  inferred here. Keep private testing files, deployments and proofs untouched.

- API-key REST backends were implemented across all four SDK hosting recipes
  on the isolated API-key branch and are now integrated here, without changing
  the user's testing checkout.
  Use `backend.auth: "api-key"` and explicit `backend.apiKey` reference/identity/
  header-or-query metadata in the [shared guide](hosting-recipes.md#api-key-backends).
  Shared entitlement and query exposure have explicit review declarations.
  Native host Key Vault references inject a process-only value using a dedicated
  existing user-assigned identity, distinct from image-pull/Functions storage.
  No credentials are resolved by generation/release and no roles are granted.
  Missing/unresolved/malformed values fail startup; caller/gateway checks,
  fixed parameter-free GETs, request limits, redirect rejection and no retries
  remain. Obvious credential reflection is rejected with generic errors.
  Source/release reviews bind all nonsecret auth choices. Anonymous and historical
  native APIM profiles remain separate and unchanged. Implementation milestones
  `d864ed2` and `b6711f7` were pushed to `svarukala-api-key-hosting-recipes`.
  Final `npm test` passed all **807 offline tests**, including the extended fresh
  packed CLI/generated-runtime checks; CLI syntax and strict public types passed.
  See the progress tracker for scope and remaining qualification boundaries.
  No live Azure/provider/M365 operation, image/package publication, installed
  skill update or consumer qualification is implied. Key Vault resolution,
  identity access, safe diagnostics and rotation/restart still need separate
  approved live qualification, especially for the Functions preview.
- Alternative hosting is now an explicit [ordered backlog B2-B5](progress-tracker.md#b2-b5-alternative-mcp-hosting-recipes):
  (1) direct Container Apps, (2) Container Apps behind an APIM gateway,
  (3) App Service, (4) Functions. All four local source/release/reference flows
  are implemented and pushed in sequential milestones. Use `mcp-hosting-*` and
  [the shared recipe guide](hosting-recipes.md). The original
  `mcp-container-apps-*` remains direct-only. All share the SDK runtime with
  Entra delegated checks and reviewed fixed GETs; the initial anonymous JSON
  backend profile is now joined by the API-key profile above. APIM uses an HTTP proxy and independently signed gateway identity;
  App Service uses an existing Linux plan; Functions is an explicit Linux FC1
  preview custom-handler profile with identity-based blob storage.
  Sealed source and release reviews are not attestations. An explicit
  unverified endpoint reference can use existing discovery/proof/FCC without
  synthesizing observations. These flows remain separate from the wizard,
  historical APIM lifecycle and proposed WIQD endpoint contract.
  The user delegated sequential implementation and periodic commits/pushes,
  with live scenarios deferred. Automated cloud deployment is not implemented;
  operator prerequisite/what-if/build/deploy reviews are documented. No image
  publication, cloud operation, sign-in or live provider call was performed.
  Actual Functions host/remote build, Azure routing/identities, APIM inherited
  policies and consumer Read/Write labels remain unverified. No historical
  descriptor, evidence, credential boundary or consumed proof was changed.
  Final offline regression passed all 792 repository tests, CLI syntax and
  strict public types. Final consistency work also corrected host-specific
  approval summaries and rejects a direct-container reference for the gateway
  recipe. The tracker and per-host guides retain the remaining live checks.
- An opt-in [public npm installation guide](public-npm-setup.md) is linked from
  the README download step. It changes a fresh local checkout's project registry
  and locked download URLs while preserving all versions and integrity hashes.
  Offline checks covered all 52 URLs, repeat conversion and fail-before-write
  cases. The repository's default feed/lockfile were not changed, and no fresh
  public-registry download/install was performed or qualified.
- FSI audience preparation: the README has numbered setup steps, a public FX
  demo, simple capability limits and the retained as-is/AI-generated disclaimer.
  It discloses the dependency-feed access prerequisite. The accumulated branch
  received a read-only code review; a full offline run found one fractional-clock
  test failure, corrected with exact integer mock times and passing targeted
  regressions. See [review evidence](progress-tracker.md#fsi-audience-documentation-and-merge-review);
  runtime timeout behavior and live-operation approval boundaries are unchanged.
- Requested backlog item [B1: username/password-authenticated MCP](progress-tracker.md#b1-usernamepassword-authenticated-mcp)
  covers separate direct-Basic and password-to-token profiles, Key Vault-only
  credential references, protected caller access, entitlement isolation and
  token lifecycle without tool-call replay. Not implemented or approved for
  execution; prefer compatible provider OAuth where available.
- Setup wording now separates simple questions from technical approval details.
  New and Advanced resource intake choose existing/new APIM, applicable Key Vault,
  and resource group before identifiers; new resources use names, existing ones
  still require exact IDs. The save question refers to setup files, while the full
  definition and exact digest remain visible and unchanged. The shipped Copilot
  skill asks one question at a time and offers the next reviewed action after a
  phase instead of waiting for "let's deploy". Local-only instructions, human
  gates and separate live approvals remain enforced; no live operations were
  performed and installed skill copies were not changed. Focused offline coverage
  passed 57 checks including a fresh packed consumer; syntax/types pass. This
  does not qualify a new live Copilot conversation or Azure deployment.
- Public anonymous native APIM support is implemented for explicitly reviewed
  public, fixed read-only GETs against an anonymous backend. The wizard keeps
  Entra first and offers public access separately, requiring declarations/rate
  limits while skipping resource-app and discovery-client fields. Both API
  layers are throttled; inherited policies and Azure management identity remain
  required. Public target bindings refuse protected receipt reuse. Discovery,
  fixed-GET proof and FCC No Auth retain their separate approvals/evidence gates.
  See [scope and limits](scenarios.md#public-anonymous-apim). Coverage is synthetic/
  offline only: no Azure deployment, Frankfurter call, FCC rollout, recording or
  consumer qualification was performed for this change. Existing installed skill
  copies are not automatically updated; this repository's shipped skill is updated.
- The terminal CLI now starts with New / Resume / Advanced. New collects source
  and authentication details, authors a fixed GET or imports selected OpenAPI
  operations, and uses the existing engine to create a new local bundle only
  after definition/destination/digest confirmation. It then shows local Resume
  status. Resource choices reuse the existing selector; no cloud calls, new
  OAuth support, automatic deployment or proof replay were added. The skill
  guides the same intake through explicit JSON commands for Copilot CLI.
  See [guided setup](copilot-cli.md#interactive-new--resume-setup).
- Latest owner-reported FCC outcome: the secured connector was added, and the
  supplied tools screenshot shows the expected single fixture tool. Its UI
  type is **Write**, despite the read-only description. The retained original
  capture has no tool annotations; MCP defaults an omitted `readOnlyHint` to
  false, which is consistent with this classification but does not establish
  the client's exact classification logic. Do not edit the capture or invent
  annotations in a handoff to change the UI. A subsequent read-only comparison
  confirmed the retained Learn tools declare readOnlyHint true. Native APIM's
  published tool contract for the pinned API version has no annotation field;
  the renderer matches that contract and discovery preserves received hints.
  No supported native setter was qualified. See the
  [annotation review](federated-connectors.md#native-apim-annotations-and-consumer-classification)
  before considering a product-support inquiry or separately scoped MCP backend.
  No live correction was attempted. No attributed tool execution,
  rollout audience or finalized legal-policy status is established.
- Before that success, the owner encountered `AADSTS650057`. The retained app
  snapshot had an empty `requiredResourceAccess`, and the error named the same
  app as client and resource with no valid resources. The owner manually added
  its own delegated scope under API permissions; a supplied screenshot matched
  that configuration. This is distinct from Expose an API preauthorization.
  No automated cloud mutation or fresh Graph/consent-grant readback was performed.
- Latest offline retrospective improvements: FCC planning now allows omitted
  developer fields only as a blocked draft, records optional caller-declared
  legal-policy status and blocks known placeholders, and reuses supplied SSO/
  OAuth registration references in both checklists. Complete legacy inputs
  remain supported; omitted legal status means not reviewed, not approved.
  Summaries now expose policy status and capture expiry. The shipped skill
  collects metadata earlier and stops at human gates without duplicate sign-ins
  or repeated blocker messages. These changes apply to newly reviewed outputs;
  existing private handoffs, receipts, captures and live resources were untouched.
- Latest endpoint observation: fresh private Entra public-client sign-in and
  metadata-only discovery succeeded using the registration-URI-qualified scope.
  The original capture contains one controlled read-only fixture tool with an
  empty object input schema and no annotations. Its timestamp is retained;
  FCC capture admission expires after 24 hours. No tool was executed, and this
  does not qualify token-store SSO, downstream runtime behavior or FCC consumer
  acceptance. The new reference preserves the old descriptor/registration
  receipt binding; do not import that old preparation into the new descriptor.
  The owner subsequently supplied developer fields, and a new private FCC
  onboarding draft was written and read back with the original SSO reference
  and actual tool metadata intact. Its status is `manual-checkpoints-required`,
  not execution-ready. The supplied privacy/terms pages are explicitly
  placeholders, not finalized policies; supplied URLs do not resolve legal
  review. Human FCC submission, consent and secured-pilot audience review remain.
- Latest owner-approved settings outcome: the registration URI and Web consent
  redirect were added to the existing Entra app, and the new audience was added
  to the MCP gateway, REST wrapper and controlled backend. Fresh readback
  verified the additive changes and preservation of other inspected settings.
  One Graph PATCH was reconciled after URI reordering; it was not repeated.
  Three APIM writes used concrete ETags. This was a private operator-reviewed
  merge, not new toolkit support for automatic reused-resource mutation.
  The backend user restriction and historical consumed proofs are preserved.
  Endpoint calls, consent, FCC submission, rollout and consumer verification
  remain separate. Do not upgrade or overwrite historical result/preparation
  artifacts; private journals retain the exact changes and completion.
- Pre-change read-only settings review: private Azure sign-in and existing-app/APIM
  inspection completed. The registration URI and Web consent redirect are
  missing from the existing Entra app. The MCP gateway, REST wrapper and
  controlled backend each need the new audience reviewed; existing token-store
  preauthorization/allowlists are present. Preserve all three authorization
  layers and the backend's matching user restriction. No cloud settings,
  endpoint calls or consumed proofs were changed at that checkpoint. The
  subsequent explicit approval and additive updates are recorded above.
- Latest SSO outcome: after corrected sign-in and operator identity confirmation,
  one explicitly approved public ATK HomeTenant / AnyApp registration returned a
  strictly parsed private `created-unverified` receipt. The target reservation
  remains consumed; do not recreate it. No dummy app or agent was created.
  Service-side restriction readback, FCC submission and consumer execution
  remain unverified/separate; the subsequent settings work above does not
  upgrade this original receipt. Private runtime cleanup also
  requires its own reviewed phase; preserve the receipt and reservation.
- Latest authentication correction: ATK's guided `--interactive true` mode
  discarded the explicit tenant, despite successful browser sign-in. The
  adapter now passes ATK `--interactive false` with interactive process I/O.
  This preserves the supplied tenant without disabling human browser sign-in.
  An explicitly requested fresh private retry subsequently passed the public
  account/selected-tenant checks. This is not token-issuer attestation or
  registration qualification. Operator identity confirmation and registration
  were handled separately as recorded above; do not promote historical failures.
- Latest approved ATK direction (2026-10-15): the user confirmed no existing
  SSO registration and agreed to tenant-only / Any Teams app from the start.
  The separate executor now has a narrowly scoped
  `allowAnyAppValidationPlaceholder` compatibility opt-in, not a fake app
  binding or provider patch. Plans disclose the unused validation UUID; real
  app IDs remain mandatory for `SpecificApp`. No live phase is implied by the
  implementation or by these notes. Read the auth runbook before preparing
  the separately reviewed Linux initialization, sign-in and registration.
- Latest scope correction (2026-10-15): the current journey is FCC-only, not
  WIQD agent authoring. Do not create or provision an agent to obtain an app ID.
  The direct Teams Developer Portal route remains an alternative to the
  explicitly approved ATK compatibility path; FCC form entry remains manual.
  The reviewed ATK action's app-ID requirement is not an FCC prerequisite.
  A mistaken private local agent scaffold was stopped without cloud
  provisioning; it is not an FCC dependency or evidence. See
  [the FCC-only route](federated-connectors.md#fcc-only-route-no-agent-project).
- The supplied endpoint's original nonsecret input was recovered privately and
  reproduced its exact URL through the independent toolkit's offline planner.
  Resource tenant/client/scope/audience/allowlist values are therefore available
  as historical configuration, not fresh live observations. A private worksheet
  and reference-only input retain that distinction. No source captures,
  authentication caches or approvals were transferred. Actual auth registration,
  current settings, legal metadata and rollout remain separate owner gates.
- Work continues in [Copilot MCP Toolkit](https://github.com/svarukala/Copilot-MCP-Toolkit),
  an independent Node.js 22+ ESM CLI/library with an installable Copilot CLI skill.
- Initial implementation is commit
  [`6463fea8e6b6449b8631644cccdae6d8a9a8dea8`](https://github.com/svarukala/Copilot-MCP-Toolkit/commit/6463fea8e6b6449b8631644cccdae6d8a9a8dea8),
  published on `main`. Later documentation commits do not requalify that runtime.
- Cowork Plugin Toolkit feature development is frozen. Notices were published on
  its [main branch](https://github.com/svarukala/Cowork-Plugin-Toolkit/commit/b51d6a8645539591bd87f39354883e1bc6a2a7a8)
  and [MCP-foundation branch](https://github.com/svarukala/Cowork-Plugin-Toolkit/commit/a2ca2a33a3c98fe6d1229296b33b796b3e39b8ba).
  It remains unarchived as historical reference. Do not resume parallel feature
  development there or automatically synchronize implementations.
- WIQD should own Cowork/M365 plugin authoring, packaging and distribution.
  Keep this toolkit's MCP infrastructure CLI and skill; do not recreate a
  Cowork-authoring CLI or skill.
- The MCP-to-WIQD handoff is a recommendation, not an implemented integration.
  The immediate request was to preserve these notes and the tracker for a fresh
  session. No new adapter, live journey, or WIQD extension has been authorized
  by these documents.

## Read in this order

1. `AGENTS.md` and [progress tracker](progress-tracker.md).
2. [WIQD handoff proposal](wiqd-handoff.md): ownership, gaps, gates and sequence.
3. [Scenario matrix](scenarios.md): exact supported and unsupported boundaries.
4. [CLI contract](cli-contract.md), [public API](api.md) and
   [extraction decisions](extraction.md).
5. [Development](development.md) and [Copilot CLI skill setup](copilot-cli.md).

The scenario matrix previously existed; the new progress tracker adds explicit
implementation, validation and outstanding-work status. Neither is live evidence.

## What already exists

The `copilot-mcp` bin supports guided local review, bounded REST-to-APIM MCP
generation, existing MCP references/proxies, private Azure identity and explicit
phase approvals. It also retains progress/summary output, one-phase resume,
freshness admission, fixed first-call assertions, rejection checks, safe evidence
export/restore, and local retained-evidence diagnosis.

The root API is deliberately bounded. Internal transport injections/executors are
not public APIs. The Copilot CLI skill drives the same CLI; it is not an MCP
tool-server facade. No automatic host registration or global installation exists.

This toolkit generates APIM deployment bundles and a separate bounded Node.js
Container Apps recipe, not arbitrary Node/Python servers.
Do not describe all REST/OAuth/provider scenarios as supported. Read the narrower
native-proof and experimental-proxy limits before proposing a live journey.

## Validation baseline and unresolved live claims

At the implementation baseline the implementation owner reported 579 passing
offline tests across all 19 test files. Independent acceptance ran eight
guided/independence/fresh-packed-consumer tests, CLI syntax and strict TypeScript
declarations. Thirteen synthetic generation vectors preserve pinned source bytes.
The packed journey resolves its own dependencies and denies runtime network and
subprocess access. Original license bytes and 85 provenance hashes were verified.

These checks ran on Windows with Node 24.19.0. Linux was not run because the Docker
daemon was unavailable; no daemon start or image pull was attempted. Do not carry
this baseline forward as a test result for future changes.

There was a scoped Tavily runtime success in the originating project on
2026-10-14, before extraction: protocol success and one fixed result-structure/domain
assertion passed. Caller missing/malformed bearer checks returned 401; provider
missing-key rejection returned 401, but invalid-key initialization returned 200
and remained inconclusive. Factual correctness and Cowork execution were not
established. The original ordinary proof and dedicated qualification are consumed.
Do not repeat either, retrofit a first-call profile, or copy old records into this
repository to claim new runtime readiness.

No original projects, captures, caches or recovery archives were imported into this
public repository. Older installed/live runtimes were not upgraded by extraction,
documentation changes, or the Cowork freeze. This handoff does not require access
to those private artifacts; obtain separately reviewed inputs if future work does.

## Recommended next session

The user subsequently prioritized custom federated connector demo preparation.
Start with [FCC onboarding](federated-connectors.md) and FCC1-FCC5 in the tracker.
Local schema/plan/bundle support, synthetic demo documentation and packed
rehearsal are implemented. A separately authorized anonymous-MCP pilot has now
completed toolkit discovery, private bundle writing and admin registration.
The admin reports Ready, enabled, visible to everyone, and three read-only tools.
Attributed live consumer acceptance remains unverified. The original H1/H2 recommendation below
still applies to the broader WIQD integration, not automatic completion by FCC.

FCC milestones are committed in `1ec9bc0` and `13263f5`. The Windows/Node 24.19.0
run passed all 607 offline tests, syntax checking and strict TypeScript checks.
The demo runbook is `docs/fcc-demo.md`; start with the offline rehearsal. A live
demo still needs the actual endpoint, explicit tenant/resource identity, SSO
registration, small test audience and a new bounded consumer purpose. No
registration, deployment, consent, provider call or historical proof replay was
performed during FCC implementation.

The subsequent anonymous pilot did not require Azure deployment or SSO. Its
tenant-wide audience was explicitly requested by the user, not inferred from
implementation approval. The user subsequently directed the product to stop at a human copy-and-paste
handoff when no supported registration API is available, rather than automate
browser submission. The bundle now exposes `manualSetup` form/auth fields and
steps, including supplied OAuth or secretless SSO registration references.
OAuth is preparation-only with discovery/import unsupported. Live browser work
was stopped at this direction; attributed Copilot execution remains unverified.
Do not resume it merely from these notes or change the existing built-in connector. Registry
availability, admin Ready status and tools-list success are distinct from that
consumer result. See the dated layer table in [the tracker](progress-tracker.md).
All real pilot files remain private; these notes transfer no execution authority.

## Shared authentication registration continuation

The user approved bringing shared SSO registration support into this independent
toolkit, followed by generic OAuth registration and both consumer handoffs.
The opaque FCC registration-ID fix is committed in `2ffcda8`; complete IDs,
including Base64 punctuation and padding, survive export unchanged.

The frozen Cowork implementation at `b51d6a8`, `src/sso-registration.js`, is the
reference for guarded SSO creation. Its public ATK lifecycle uses
`oauth/register` with `identityProvider: MicrosoftEntra`, captures the returned
ID/Application ID URI, and retains unknown-attempt barriers. It is not a generic
OAuth creation implementation and must not be copied with its plugin dependencies.

Read-only inspection of installed ATK CLI 1.1.17 on 2026-10-15 found a provider
isolation gate: `m365Login.ts` configures a Windows native broker;
`cacheAccess.ts` uses a fixed OS credential-store service/account for its cache
encryption key; the login command signs out the previous ATK account. Home-path
redirection alone has not established private authentication. No auth caches
were read or copied, and no ATK login or provisioning was invoked.

This led to a Linux-only owner-private tmpfs adapter rather than a shared Windows
profile or a Docker dependency. Actual Linux/provider qualification and explicit
real app identity/restrictions are still required before live registration.
Do not use shared credentials, monkey-patch Microsoft tooling, start Docker or
create cloud resources implicitly. Manual registration remains valid.

The ID milestone passed 35 FCC tests and the offline packed-consumer test.
The shared local module is now implemented:
`mcp-auth-registration-schema`, `mcp-auth-registration-plan` and
`mcp-auth-registration-bundle` prepare SSO/custom OAuth settings, including
explicit restrictions, PKCE or versioned Key Vault references. They invoke no
provider. FCC can import the resulting exact descriptor-bound data through
`source.authenticationBundleFile`; a plugin reference view is mapping guidance
only. Supplied IDs remain `provided-unverified`. See
[auth-registration](auth-registration.md) for synthetic examples and the exact
execution gaps. The targeted milestone passed 85 tests: 38 auth, 35 FCC,
11 shared CLI/guidance/independence and one expanded fresh packed journey with
runtime networking/processes denied. Syntax/types also passed. This is offline
evidence only, not a new full-suite or live result.

The user then directed continued autonomous implementation. The separate
`mcp-auth-execution-schema`, `mcp-auth-execution-plan`, `mcp-auth-execute` and
`mcp-auth-execution-status` now implement AUTH3/AUTH4:

- Independent initialize/login/register/close approvals using public ATK 1.1.17.
  At this historical milestone only Linux owner-only `/dev/shm` tmpfs was
  admitted. The explicit native Windows SSO mode described at the top of this
  handoff now complements that isolated path; macOS remains unsupported.
- Terminal-only browser sign-in URL with a same-host loopback callback.
  Public account output plus selected-tenant metadata is not issuer attestation;
  registration requires separate human identity confirmation.
- SSO, generic OAuth PKCE and confidential OAuth. The latter uses an explicitly
  selected matching private Azure identity for a Key Vault access token, then
  one bounded HTTPS read of the exact secret version. Secret values do not go
  through Azure CLI output/logging or toolkit durable artifacts.
- Durable target reservations before one registration dispatch, including
  unknown/failure barriers across renamed sessions. Unconfirmed subprocess
  termination retains the lock/PID/runtime; no automatic retry or recovery.
- Nonsecret `created-unverified` results imported through preparation's
  `source.registrationResultFile`, then FCC's `source.authenticationBundleFile`.
  Exact request/descriptor integrity is checked; existing references suppress
  creation. Close removes only transient runtime files, retaining barriers.

Read [auth registration](auth-registration.md) for the execution example,
phase/flag table, cleanup and version-1 preparation compatibility. Old
preparation gap identifiers remain unchanged to preserve historical hashes;
consult the separate execution capability, not those gaps, for executor support.
ATK entry-file fingerprints are not a full dependency attestation, and tmpfs
does not protect against an untrusted host, same user, swap or crash dumps.

No ATK sign-in/provisioning, Azure token/secret read or live registration was run
for this implementation. The next live work needs a qualified Linux host/browser,
the real intended app ID and exact phase reviews. Settings, consent, attributed
FCC consumer execution and WIQD package compatibility are still unverified.
Do not treat the code milestone as H1/H2/H6 completion or resume historical proofs.

Execution milestone validation: 110 targeted offline tests passed on Windows /
Node 24.19.0 (25 execution, 38 preparation, 35 FCC, 11 shared CLI/guidance/
independence and one fresh packed-consumer journey), plus syntax and strict
types. Synthetic providers cover the effect phases; packed runtime networking
and subprocesses are denied. The actual Linux filesystem branch and live
provider were not exercised. See the tracker for earlier separate baselines.

### Subsequent Windows-first request

The user requested trying safe Windows isolation first, with Linux as fallback.
The read-only probe redirected profile folders but retained the same Windows
security principal. Installed ATK 1.1.17 still had resolvable broker/keytar
modules and fixed credential-store bindings; no supported complete isolation
switch was found. Native same-user redirection therefore failed the precheck.
No ATK sign-in, broker call, credential-store access or cache copy was attempted.
Windows Sandbox was unavailable; no OS account/feature/VM was created.

An existing WSL 2 Ubuntu environment was then used for seven focused offline
checks with private, checksum-verified official Node 22.23.3. All passed,
including actual tmpfs owner/permission checks and runtime cleanup. This adds
real Linux filesystem evidence to the prior synthetic/Windows milestone, not
live authentication or full packed portability. Temporary tooling was removed;
system Node and user shell profiles were unchanged.

Public npm metadata retrieval for ATK 1.1.17 failed TLS negotiation through both
PowerShell and Node; certificate verification was not bypassed. The fallback
still needs a reviewed Linux ATK installation and browser/callback setup before
separately approved live work. Do not claim Windows isolation is impossible in
a separate OS boundary, or that WSL presence alone qualifies authentication.
Read [the assessment](auth-registration.md#windows-first-isolation-check).
The later Windows mode requires explicit shared-profile review; no automatic
cross-platform login/retry exists.

### Resolved WSL setup and callback precheck

Further work resolved the registry problem: the same public npm endpoint was
accessible from WSL with TLS verification intact. Private official Node 22.23.3
and pinned ATK 1.1.17 are now installed in this session's private tooling area,
outside repository assets, using fresh npm configuration/cache and disabled
installation scripts. No global tooling, account or provider code was changed.

The real ATK help entry point completed in the private tmpfs runtime with all
network dispatch denied and only its inspected read-only machine-ID command
allowed. No account cache was created; runtime removal was verified. ATK did
attempt its experimentation-service GET even with telemetry disabled, and the
probe blocked it. Execution plans now disclose this ancillary request and
machine-derived client metadata; the probe is not a production egress firewall.

Windows successfully fetched a unique response from a synthetic WSL loopback
server, which then exited. A Windows browser can therefore be considered for
this host's callback without installing a Linux browser; actual Microsoft
browser sign-in and host-specific browser policies remain untested. The docs
and login plan now require verified callback reachability rather than assuming
a Linux browser is mandatory. Source inspection also found that ATK's browser
helper may automatically launch the Windows default browser under WSL, despite
`BROWSER=/bin/true`. The login plan now discloses this: private ATK cache isolation
does not isolate browser cookies/history. No real browser/sign-in was exercised.

This completes the local Windows-first/fallback precheck, not live authentication.
The Windows guard remained at that milestone; the later user-managed SSO mode
is a separate implementation, not isolation evidence. Retain independent phase
approvals and real app/identity review before live operations.
Do not transfer this private tooling or any future account cache as repository
evidence. See the auth runbook for exact validation scope.

Final continuation checks passed: 33 targeted Windows tests including packed
CLI, syntax/types, and twelve focused Linux checks on Node 22.23.3. The Linux
scope includes actual tmpfs checks, synthetic SSO-to-FCC phases and CLI feedback.
A timer-sensitive late-feedback test was made deterministic with an explicitly
released promise. This is not the full Linux packed-consumer suite or live auth.
Private Node/ATK tooling is retained; download/cache scratch files and all probe
runtime/server processes are cleaned up.

### Native WIQD alternative and completed package portability check

The user requested a WIQD-style native Windows experience rather than making
WSL the intended workflow. Inspection of installed WIQD 0.18.0 Core confirmed
account selection, a supported browser-authentication switch and no unconditional
sign-out at the start of interactive login. This differs from the pinned ATK
adapter; it does not qualify reuse of WIQD's authentication cache.

Core still uses a fixed `wiqd` / `appStudio` Credential Manager encryption-key
entry, independent of its home-relative token files. The inspected code can
fall back to unencrypted content when no encryption key is available. No
private key-namespace override was found. No WIQD authentication/status command,
credential-store access, settings change or token transfer was performed.
A project-isolated native WIQD executor remains unimplemented. The separate
native Windows ATK SSO mode now uses an explicitly reviewed normal profile,
not a new private credential boundary.
See [the investigation](auth-registration.md#native-windows-wiqd-investigation).

Further source inspection found WIQD's separate cache-free CI refresh-token
backend. It requires an explicit tenant and a caller-provided fresh delegated
credential, and refuses interactive overrides. The public bootstrap command
requires terminal-only human confirmation/disclosure. This is a possible
integration direction, not authorization to capture/export existing tokens or
an implemented native interactive adapter.

Q1 is now complete for the fresh packed-consumer test. A missing private npm
cache was populated separately with public dependencies, without installation
scripts. A subsequent timeout on the Windows-mounted fixture was resolved by
placing the disposable consumer in the OS temporary directory, without raising
the 180-second timeout or weakening assertions. The full packed test passed on
Linux Node 22.23.3 (about 103 seconds) and Windows (about 67 seconds), including
offline installation and denied runtime networking/subprocesses. This does not
claim a full Linux test-suite run or live authentication.

At that historical checkpoint, live ATK SSO work was paused pending selection
of a secured MCP endpoint and intended M365 app ID, followed by phase reviews.
The user subsequently supplied an endpoint privately and clarified FCC-only
scope. The direct portal route needs its actual resource authentication
metadata, not a newly created agent or consumer app ID. The
anonymous Microsoft Learn pilot cannot validate SSO, and its historical
consumed evidence must not be replayed.

## Broader WIQD integration

### Implemented user-managed Windows registration handoff

`mcp-auth-wiqd-schema`, `mcp-auth-wiqd-plan` and `mcp-auth-wiqd-bundle` now provide
the simpler native Windows option without claiming to replace the isolated
executor. An existing private WIQD project/environment and registration input
produce one reviewed, no-overwrite JSON handoff: SSO/PKCE action data, quoted
operator commands and exact reference-return mappings. The toolkit does not
run WIQD or alter its project, credentials, account selection or settings.

WIQD owns ordinary user-profile authentication. Its provisioning command can
affect the whole app, so its full lifecycle and identity must be independently
reviewed; an export approval never authorizes provisioning. Missing app IDs,
confidential secrets or existing references suppress provider commands. The
existing descriptor-bound reference import path remains unchanged, including
version-1 hashes and unverified status. See the auth runbook's
[Windows handoff](auth-registration.md#user-managed-wiqd-windows-handoff).

Validation passed: 53 targeted Windows tests plus syntax/types, and eight Linux
Node 22.23.3 checks including the complete packed-consumer test. The command
rejects handoff outputs inside the selected WIQD project; neither creation nor
editing of that project is part of the write. Runtime networking/subprocesses
remain denied during the packed test. No live WIQD operation was exercised.

Live use remains separate. The user has identified an existing secured endpoint;
keep real endpoint/identity/project details only in private operator inputs,
never in these public notes. The intended app ID and existing WIQD project
still need explicit selection. No live operation is implied by this code.

Start with H1 in [the tracker](progress-tracker.md): inspect current machine
contracts and propose a small consumer-neutral handoff schema, without changing
public APIs or invoking cloud services. Confirm the intended implementation scope
with the user. Prioritize the authentication compatibility investigation H2
alongside it; do not assume that a working Entra endpoint implies a working
Cowork OAuth registration.

Then use a synthetic example to document the WIQD consumption path. Implement an
export/import only through reviewed scope; do not invent command names in usage
examples before commands actually exist. One separately approved live end-to-end
journey comes after offline contract and adapter checks, not before them.

Useful local entry points:

```powershell
node .\bin\copilot-mcp.js --help
node .\bin\copilot-mcp.js capabilities --json
node .\bin\copilot-mcp.js schema --json
```

Use existing dependencies. Restore only for a missing-dependency failure or a
manifest change, using the approved locked feed/offline cache. No public-registry
fallback, TLS bypass, global install or npm publication is implied.

For code changes, run targeted tests first. For package/docs changes that affect
the inventory, use `node .\scripts\update-assets.mjs` and the packed-consumer test.
The asset digest includes documentation: changed docs change build identity, not
historical approvals or installed runtime bytes.

## Continuity and safety

- No session, sign-in, approval token or authentication cache is transferable.
  An approval is bound to its exact operation/input/identity/freshness context.
- Existing locks, unknown dispatches and consumed purposes remain barriers.
  Diagnosis, export and restore do not reopen them.
- Keep real identities, endpoints, receipts, captures and raw output outside Git
  in explicitly selected private workspaces. Do not scan old home/session folders.
- A failed host permission interaction does not mean the user is absent. Report
  the actual blocker, stop at denied access, and never switch tools to bypass it.
- The earlier destination session encountered host read/edit approval failures;
  that is historical, not a diagnosis of a new session. Use the new workspace's
  actual permissions and do not depend on an older session remaining open.
- A new session should work only in this repository. Do not resume background
  work in the frozen Cowork project or use its checkout as a runtime dependency.
