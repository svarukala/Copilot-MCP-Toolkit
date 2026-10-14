# Session handoff

Last updated: 2026-10-14. This is the starting point for a new MCP Toolkit session.
It contains public engineering context only, not credentials or execution authority.

## Decisions and current baseline

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

This toolkit generates APIM deployment bundles, not arbitrary Node/Python servers.
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
