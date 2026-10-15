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
| AUTH1 | Shared SSO and OAuth registration support | ID fix complete; provider isolation decision required | `2ffcda8`: 35 FCC tests plus packed test. ATK 1.1.17 uses OS credential storage/native broker; select isolated execution environment before adapting live creation. No auth registration was executed |

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
| H2 | P0 | Verify secretless Entra to WIQD/Cowork credential-registration compatibility | Joint investigation; WIQD owns consumer registration | Unverified | Current official docs + installed-version inspection; no automatic registration |
| H3 | P1 | Implement reviewed local handoff export and offline contract tests | MCP Toolkit | Not started | H1; no login, discovery, proof replay or evidence renewal during export |
| H4 | P1 | Document synthetic WIQD consumption with existing skills | WIQD workflow guidance + MCP docs | Not started | H1, H2; observed tools mapped to required package artifact, not invented |
| H5 | P1 | Address Cowork-specific metadata/validation gaps upstream | WIQD | Proposed | Confirm each gap against current behavior before proposing fixes |
| H6 | P1 | Verify one MCP Toolkit -> WIQD -> Cowork journey | Explicitly authorized operator | Not started | H2, H3, H4 and applicable H5; fresh purpose/approvals, bounded cost, separate layer results |
| H7 | P2 | Decide whether a thin deterministic WIQD adapter/extension is justified | Joint | Deferred | H4/H6 experience; no duplicated infrastructure/auth engine |
| Q1 | P2 | Linux/offline packed portability run | MCP Toolkit | Not run | Authorized Linux environment; do not start shared Docker implicitly |
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
