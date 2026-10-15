# Progress and scenario tracker

Last updated: 2026-10-15.

This is the single progress index for the independent toolkit. Update statuses
with concrete commits/checks as work lands. "Implemented/offline verified" does
not mean deployed, authenticated, provider-compatible or verified in Cowork.
Historical observations are not fresh approvals or independent-runtime evidence.

## Completed engineering work

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

## Scenario and runtime qualification

Implementation details and all unsupported cases remain in
[the scenario matrix](scenarios.md). This table tracks qualification separately.

| Scenario | Independent toolkit implementation | Runtime / consumer status |
| --- | --- | --- |
| Native APIM REST, anonymous backend | Generation and narrow fixed-GET proof supported | Offline verified; no independent live requalification recorded here |
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
| FCC3 | Entra SSO consumer compatibility | Documentation reviewed; runtime unverified | Registration URI, redirect, token-store client and endpoint requirements checked against official guidance; actual tenant still needed |
| FCC4 | Staged Microsoft 365 demo acceptance | In progress: anonymous MCP registration and rollout verified | 2026-10-15: toolkit discovered three read-only tools, wrote reviewed private bundle; admin confirmed custom connector Ready/enabled/visible to everyone under explicit user direction. Attributed Copilot execution remains unverified |
| FCC5 | Human copy/paste handoff instead of browser automation | Implemented | User-directed boundary: labeled FCC form fields, secretless SSO setup fields/steps and actual supplied registration references; OAuth reference preparation remains blocked with discovery/import unsupported |
| AUTH1 | Opaque authentication registration IDs | Implemented/offline verified | `2ffcda8`: leading punctuation, Base64 characters and trailing padding preserved; 35 FCC tests plus packed test |
| AUTH2 | Shared local SSO/custom OAuth preparation | Implemented/offline verified | Closed schema/plan/bundle, explicit restrictions, PKCE or versioned Key Vault reference; 38 auth tests plus 35 FCC tests, syntax/types; no provider execution |
| AUTH3 | SSO registration execution adapter | Implemented; real Linux/provider qualification outstanding | Public ATK 1.1.17, owner-only Linux tmpfs, separate phase approvals, identity confirmation and durable no-replay journals; Windows/macOS refused, no Docker/shared login |
| AUTH4 | Generic OAuth registration execution | Implemented; live qualification outstanding | PKCE or exact versioned Key Vault secret using a matching private Azure identity and bounded HTTPS read; child-only secret environment, no secret in toolkit durable artifacts |
| AUTH5 | Shared auth references for FCC/plugins | Local metadata/result import implemented; consumer execution unverified | Exact request/descriptor-bound created-unverified result import into preparation, then FCC; conflicts/stale approvals rejected. Plugin view remains mapping-required, not WIQD packaging |
| AUTH6 | Windows-first isolation assessment | Native precheck rejected; WSL offline fallback checked | Same-user redirection retained the Windows principal and resolvable broker/keytar modules; credential-store access was not exercised. Twelve focused Linux checks passed; private pinned ATK help ran with network blocked and no account cache. Windows-to-WSL synthetic callback passed. Real sign-in/registration remains unverified |
| AUTH7 | WIQD-style native Windows authentication | Source investigation complete; replacement adapter not implemented | WIQD 0.18.0 Core has account selection, no unconditional interactive logout and a browser switch. Its fixed Credential Manager encryption-key namespace is not scoped by redirected HOME. Private credential isolation and registration-only integration remain unqualified |
| AUTH8 | User-managed WIQD Windows handoff | Implemented; live operator journey unverified | Local schema/plan/bundle exports SSO/PKCE review actions, quoted operator commands and exact return mappings. No provider invocation, project edits, credential transfer or Linux requirement. WIQD owns its normal profile; whole-lifecycle review remains mandatory |
| AUTH9 | Explicit tenant-only SSO AnyApp validation compatibility | Implemented/offline verified; live acceptance unverified | Config-only opt-in for pinned ATK, disclosed unused UUID and unchanged request/target semantics; no app creation, no later restriction switch, no native Windows execution or live registration claim |
| AUTH10 | Preserve explicit tenant during ATK browser sign-in | Implemented/offline verified; corrected live sign-in outstanding | Argument-driven ATK mode with human terminal I/O; unchanged strict tenant verification and no-replay gates; safe identity-check failure explanation |

AUTH9 validation: 123 targeted Windows tests passed across execution, shared
preparation/WIQD handoff, FCC, CLI feedback and fresh packed consumption, plus
syntax/types. Linux Node 22.23.3 passed all 37 execution tests and the fresh
packed consumer using the retained private npm configuration/cache. That Linux
run includes real tmpfs ownership/cleanup checks but synthetic provider calls.
Compatibility regressions cover disabled/invalid opt-in, approval/session
binding, unchanged canonical preparation, action-only placeholder injection,
receipt integrity, consumed-target preservation and reference import into FCC.
No live sign-in, service registration or consumer execution is established.

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
generic authentication failure. Historical failed attempts remain consumed;
fresh live validation and registration are still outstanding.

AUTH10 validation: 46 Windows tests passed (41 execution tests, four CLI
feedback tests and one fresh offline packed consumer), plus syntax/types.
Seven focused Linux checks passed, including the actual tmpfs runtime check.
Synthetic adapter regressions cover the exact login arguments, retained human
terminal mode, correct/empty/wrong tenant selection and no cache repair.
Failure regressions preserve consumed login attempts and suppress raw errors.
No provider or cloud service was contacted by these checks.

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
