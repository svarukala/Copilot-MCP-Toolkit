# Progress and scenario tracker

Last updated: 2026-10-14.

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
