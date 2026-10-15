# Session handoff

Last updated: 2026-10-15. This is the starting point for a new MCP Toolkit session.
It contains public engineering context only, not credentials or execution authority.

## Decisions and current baseline

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
  Only Linux owner-only `/dev/shm` tmpfs is admitted. D-Bus keyrings and ambient
  provider overrides are excluded; Windows/macOS execution is refused.
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
Keep the current Windows guard; no automatic cross-platform login/retry exists.

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
Keep Windows execution blocked, retain the Linux provider and its independent
phase approvals, and obtain real app/identity review before live operations.
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
Native Windows registration remains unimplemented: qualify a supported private
credential boundary and registration-only interface before replacing the
executor. See [the investigation](auth-registration.md#native-windows-wiqd-investigation).

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
