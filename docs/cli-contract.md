# Standalone CLI contract

Run `copilot-mcp --help`, `schema --json`, and `capabilities --json` for the installed
build. `node <package>/bin/copilot-mcp.js` is equivalent. All paths in examples below
are operator-selected; use `--workspace-root ABSOLUTE_EXISTING_DIR` for projects
outside installed code. The root must not contain installed code or be its asset/
dependency directory. Never use a filesystem root.

## Command families

No command / `init` opens the terminal-only New / Resume / Advanced menu.
New can author a definition from source/authentication answers and generate a
new local bundle after explicit digest/destination review and confirmation.
It then returns a local Resume report, not a live execution. Resume and Advanced
remain review-only. See [guided setup](copilot-cli.md#interactive-new--resume-setup).
`init --json` and nonterminal invocation remain rejected; automation uses the
explicit commands below.

Anonymous REST supports an additional explicit public caller-access choice.
The native input's `inbound` carries `type: "anonymous"`, `publicData: true`,
`readOnly: true` and `rateLimit` (`calls`: 1-10000; `renewalPeriod`: 1-300 seconds).
This is not the bare anonymous existing-MCP reference shape. Only public fixed
GETs qualify; Entra remains the default for other APIM journeys. See
[public APIM](scenarios.md#public-anonymous-apim). Deployment still requires
private Azure identity; MCP discovery takes `{}` without sign-in; FCC uses No Auth.

| Family | Plan/local view | Explicit continuation |
| --- | --- | --- |
| Hosting prerequisites | `mcp-bootstrap-schema`; `mcp-bootstrap-plan --workspace-root ABS --config input.json --output NEW.json` | `mcp-bootstrap-bundle` with exact approval; separate direct Container Apps templates, existing/new choices, directory handoff, no cloud actions |
| Operator journal | `mcp-operator-schema`; `mcp-operator-plan --workspace-root ABS --project DIR --config event.json`; `mcp-operator-status` | `mcp-operator-record` with exact approval; append-only declaration, never dispatches an external operation |
| Recipe reviews | `mcp-recipe-review-schema`; `mcp-recipe-review-plan --workspace-root ABS --project SOURCE --config review.json --output NEW.json` | `mcp-recipe-review-bundle` with exact approval; image, preserving-update, readiness, auth impact, secret metadata and cost/closeout reviews |
| Real-terminal handoff | `mcp-terminal-handoff --workspace-root ABS --project REF --config selection.json --phase discovery\|proof\|session` | Copy the generated PowerShell command into a real terminal only after separate exact operation review; no cross-process token sharing or terminal launch |
| Host diagnostics / private pull | `mcp-host-schema`; `mcp-host-plan --workspace-root ABS --project DIR --config operation.json --output NEW.json` | `mcp-host-run` with exact approval and applicable local/network/cloud flags. Explicit registry ping/package-metadata diagnostics or digest-only ACR pull; immutable intent and no implicit retry |
| Hosting Azure identity | `mcp-host-account-plan --workspace-root ABS --project SOURCE --tenant-id UUID --subscription-id UUID --account-name NAME` | Separate `mcp-host-account-switch --approve TOKEN`; private source-project context, never shared account/cache changes |
| Single-process MCP session | `mcp-session-plan --workspace-root ABS --project REF --config session.json` | `mcp-session --approve DIGEST --allow-network --interactive`; bounded in-memory sign-in reuse, separate new proof approval after discovery, unchanged no-replay journal |
| Container Apps recipe | `mcp-container-apps-schema`; `mcp-container-apps-plan --workspace-root ABS --config recipe.json --output NEW_DIR` | `mcp-container-apps-create` with the same paths and exact `--approve approvalToken`; local SDK source and ARM files only |
| All SDK hosting recipes | `mcp-hosting-schema`; `mcp-hosting-plan --workspace-root ABS --config recipe.json --output NEW_DIR` | `mcp-hosting-create` with identical paths and exact approval; four closed host profiles |
| Recipe release | `mcp-recipe-source-plan --workspace-root ABS --project DIR`; `mcp-recipe-release-plan` with project/config/new output | `mcp-recipe-release-bundle` with exact approval; source archive and template parameters, never deployment |
| Recipe endpoint reference | `mcp-recipe-reference-plan --workspace-root ABS --project DIR --config endpoint.json --output NEW_DIR` | `mcp-recipe-reference-create` with exact approval; new unverified existing-MCP reference, not captured tools |
| Deployment handover | `mcp-handover-schema`; `mcp-handover-plan --workspace-root ABS --project SOURCE --config handover.json --output NEW_DIR` | `mcp-handover-bundle` with exact local export approval; two-tab offline HTML, SVG/Excalidraw, source and optional matched release; no live operation or evidence renewal |
| Generate | `mcp-server-plan --config definition.json` | `mcp-server-create --config definition.json --output NEW --approve reviewDigest` |
| GET/query authoring | `rest-tools-plan --config tools.json --output NEW.json` | `rest-tools-write` with same paths and top-level approval |
| Resource selection | `mcp-resources-choose --config definition.json` (TTY) or `mcp-resources-plan --config choices.json` | `mcp-resources-write --config choices.json --output NEW.json --approve approvalToken` |
| Account | `mcp-account-plan --project DIR --tenant-id UUID --subscription-id UUID --account-name NAME` | `mcp-account-switch` with the same selection and exact approval |
| Entra setup | `mcp-app-init --project NEW --config request.json`; `mcp-app-account-plan`; `mcp-app-plan --phase PHASE` | Separate `mcp-app-account-switch`, then `mcp-app-apply --phase PHASE --approve TOKEN --allow-cloud` |
| Azure lifecycle | `mcp-provision-plan --project DIR --phase foundation\|finalize\|gateway` | `mcp-provision` with that exact top-level phase approval; no implicit login |
| Inventory/prerequisites | `mcp-inventory-plan`, `mcp-prerequisites-plan`, `mcp-identity-plan` | `mcp-inventory` / `mcp-prerequisites` require exact approval and `--allow-cloud`; identity enablement remains manual |
| Reconcile | `mcp-reconcile-plan --project DIR` | `mcp-reconcile --approve TOKEN --allow-cloud`; V3 configuration refresh needs explicit `--experimental-configuration` on both commands |
| Metadata preparation | `mcp-capture-plan --project DIR` | Preparation only, not a fabricated capture |
| Observe | `mcp-discovery-plan --project DIR --config selection.json` | `mcp-discover --approve approvalDigest --allow-network` with same selection |
| Prove | `mcp-proof-plan --project DIR --config selection.json` | `mcp-proof --approve approvalDigest --allow-network`; native mapping additionally needs `--allow-cloud` |
| Mapping preflight | `mcp-proof-preflight-plan` with project/selection | `mcp-proof-preflight --approve TOKEN --allow-cloud`; no MCP login or reusable readiness receipt |
| Closed checks | `mcp-auth-rejection-plan`, `mcp-backend-rejection-plan`, `mcp-qualification-plan` | Corresponding executor with exact approval and `--allow-network`; qualification also needs selection |
| Local journey | `mcp-status`, `mcp-resume`, `mcp-diagnose` with `--project DIR` | Resume may delegate ONE phase only after exact current `next.approval` and `next.requiredFlags` |
| Controlled fixture | `mcp-fixture-plan --config definition.json` | `mcp-fixture-bundle --config definition.json --output NEW --approve reviewDigest`; no apply command |
| Federated onboarding | `mcp-fcc-schema`; `mcp-fcc-plan --workspace-root ABS --config fcc.json --output NEW.json` | `mcp-fcc-bundle` with identical inputs and exact `--approve approvalToken`; local draft, no registration |
| Auth registration preparation | `mcp-auth-registration-schema`; `mcp-auth-registration-plan --workspace-root ABS --config registration.json --output NEW.json` | `mcp-auth-registration-bundle` with identical inputs and exact `--approve approvalToken`; local metadata only, no login/registration/secret resolution |
| Auth registration execution | `mcp-auth-execution-schema`; `mcp-auth-execution-plan --workspace-root ABS --project SESSION --config execution.json --phase PHASE`; local `mcp-auth-execution-status` | `mcp-auth-execute` with exact phase approval/effect flags; Linux-isolated mode or explicit `windows-user-managed` mode with `sharedProfileReviewed: true` for secretless SSO. Live Windows registration remains unqualified. `allowAnyAppValidationPlaceholder` remains limited to Entra SSO / HomeTenant / AnyApp without a supplied app ID |

Inputs outside the documented closed profiles fail; examples are synthetic and
need review. Commands do not accept raw provider credentials or generic URLs for
probes. Unsupported flags are not substitutes for a reviewed plan.

Container Apps has a separate versioned recipe contract, not an extension to the
historical APIM input/descriptor. It requires Entra v2 delegated callers and
explicitly reviewed fixed GETs against one anonymous or Key Vault API-key JSON backend. Plan supports
`--summary`; create binds inputs, build, all generated bytes and new destination.
Neither command installs packages, builds/pushes images or contacts Azure.
Existing APIM lifecycle commands do not consume this project format. The explicit
endpoint-reference flow creates a separate existing-MCP project for observed
discovery, proof and FCC; it fabricates no captures or runtime evidence.
Release preparation validates sealed source and a pinned image (containers) or
exact source archive digest (Functions). It does not attest the remote build.
All writes require a new destination and current approval; all live-effect flags
are rejected. See [all four recipes and boundaries](hosting-recipes.md).
Across all four, `backend.auth: "api-key"` requires `backend.apiKey` with
`tenantId`, `keyVaultResourceId`, a distinct `identityResourceId`,
`secretIdentifier`, `sharedAccessReviewed: true`, and exactly one `headerName`
or `queryParameterName`. Query placement also requires
`queryExposureReviewed: true`. Names, OpenAPI security and target bindings are
validated; raw credentials are not accepted. Generation and release summaries
include these nonsecret choices. Native platform references inject the value
only at runtime; missing/unresolved keys prevent startup. The original
`backend: { origin, auth: "anonymous" }` and native APIM contracts are unchanged.

FCC plan/bundle requires an explicit workspace separate from installed code.
Source descriptor/capture paths resolve relative to the config file. It preserves
all observed tool schemas and requires explicit metadata-export and read-only
reviews. Missing/stale metadata is reported as blocked, not fabricated or renewed.
Exit 0 means local plan/write completion; inspect the separate readiness object.
`bundle.manualSetup` supplies labeled human copy/paste fields and manual auth
registration steps. Missing values remain null. OAuth accepts a registration
reference only and remains blocked without supported discovery; no credentials,
browser automation or tenant writes are admitted.
`--summary` is supported on `mcp-fcc-plan`. See
[FCC onboarding](federated-connectors.md) for the complete boundary.

Auth-registration preparation uses the same explicit workspace, JSON stdout,
`--summary` on plans and new-destination-only policy. It rejects effect flags.
See [shared auth preparation](auth-registration.md). FCC may select its output
via `source.authenticationBundleFile`; this is an integrity/descriptor-bound
reference import, not a consumer-readiness assertion or execution receipt.

Auth execution phases are `initialize`, `login`, `register`, `close`, each with
its own plan/token. All executions require `--allow-provider`; login also needs
`--allow-network --interactive`, registration needs
`--allow-network --confirm-identity`, and confidential registration additionally
needs `--allow-cloud` with an explicit private Key Vault identity. Close needs
no config and preserves consumed attempts. No other phase accepts those effect
flags. Plans support `--summary`; status is local-only. Registration results can
be imported into preparation with `source.registrationResultFile`; a supplied
reference/result cannot trigger another registration. See the auth runbook for
mode-specific prerequisites, terminal-only login and unknown-attempt reconciliation.
Native Windows SSO uses the normal ATK profile with explicit shared-profile
review, not a copied/redirected credential cache. Plans disclose login replacement,
provider-owned persistent caches/logs, and a per-user toolkit operation lock.
Close removes only owned Windows job files, never shared credentials or logouts.
Custom OAuth execution still requires Linux. Historical Linux sessions stay
Linux-isolated; changing configuration cannot adopt them into Windows mode.
Login/register summaries also disclose ATK's ancillary experimentation-service
request and machine-derived client metadata; the provider's telemetry flag does
not disable that request. Browser callbacks may use separately verified
Windows-to-WSL localhost forwarding for Linux mode; no automatic host switch is performed.
ATK may launch the Windows default browser under WSL. The login summary discloses
that browser cookies/history are outside the toolkit's private-cache boundary.

## Output and approvals

`mcp-auth-wiqd-schema`, `mcp-auth-wiqd-plan` and `mcp-auth-wiqd-bundle` implement
a local-only, user-managed WIQD handoff. Config selects a registration input,
existing private WIQD project directory and explicit environment. Plan/bundle
requires `--workspace-root --config --output`; plan accepts `--summary`, and
bundle requires exact `--approve`. Effect flags are rejected. Output includes
operator commands/action review data, never provider execution or project edits.
Only the local JSON write is approved. WIQD's entire provisioning lifecycle,
identity, consent and any publication remain separately operator-reviewed.

JSON stdout is the complete machine contract; `--json` never embeds progress.
Exit 0 means the command completed in its documented sense, not universal readiness.
Exit 1 is an error; exit 2 is a blocked/declined/non-passing supported outcome where
the command distinguishes it. Inspect the structured status, not exit code alone.

`--summary` writes a human summary and exact approval to stderr for server/account/
discovery/proof/qualification/reconcile/export/restore plans and resume.
`--progress` is supported on account-switch, reconcile, discover, proof,
qualification and resume. It reports known stages, bounded wait updates and
recorded budgets only. A transport boundary is not confirmed provider execution.

Use **top-level** `reviewDigest`, `approvalToken` or `approvalDigest` from the
selected plan; resume uses `next.approval`, not `next.phaseApproval`. The summary
identifies the right value. Review nested plans too, but never substitute their
digests for the outer authorization. No command silently renews an approval.

## Identity and application setup

All account fields must be explicit; missing or changed identity blocks
noninteractive execution. Switching creates a fresh project-private Azure CLI
context and invalidates approvals, without globally changing accounts/logging out.
For headless **server account** login, add `--use-device-code` to both plan and
switch (or resume). App-setup account login retains its separate browser path;
do not assume the headless flag applies there.

App requests use `{target, application}`. Target has `tenantId`, `subscriptionId`
and `accountName`. Resource application examples:

```json
{
  "target": {
    "tenantId": "22222222-2222-4222-8222-222222222222",
    "subscriptionId": "33333333-3333-4333-8333-333333333333",
    "accountName": "operator@example.com"
  },
  "application": {
    "mode": "new",
    "displayName": "Synthetic MCP resource",
    "scope": "access_as_user",
    "allowedClientIds": ["55555555-5555-4555-8555-555555555555"]
  }
}
```

Existing resource apps instead use `mode`, `clientId`, `applicationIdUri`, `scope`,
`allowedClientIds`. They are inspected, not silently mutated. A discovery-client
request uses `{kind:"discovery-client",mode:"new",displayName:"..."}` or existing
`clientId`. Separate resource-binding input is
`{clientId,applicationIdUri,scope,scopeId}`. Resource creation, scope configuration,
preauthorization and public discovery-client setup are separate reviewed phases.
Consent/home-tenant service-principal work remains an owner checkpoint. No
token-store registration or consumer-specific app creation is performed.

MCP authentication uses an explicit approved public discovery client and expected
user object ID, **not** Azure account credentials. Protected discovery/proof needs
`--interactive` and terminal stdin/stderr. Validated device URI/code is transient
terminal output only; never redirect it into logs or evidence. No credential cache
is copied during recovery.

## Discovery and first-call result assertions

An anonymous selection is `{}`. An Entra selection is
`{discoveryClientId:"UUID",expectedUserId:"UUID"}`. Proof selection includes:

```json
{
  "capture": ".mcp-observations/ATTEMPT_ID/capture.json",
  "toolName": "read_record",
  "arguments": {},
  "safetyReview": {
    "readOnly": true,
    "reason": "I reviewed this documented retrieval operation and its side effects."
  }
}
```

Replace the path with the actual immutable observed capture, never a constructed
example receipt. A bounded full capture object is also accepted. Captures have a
24-hour selection window; V3 configuration evidence has a 15-minute window.
Resume checks relevant remaining lifetime against known authentication/execution
budgets before sign-in. Unknown budgets are not guessed.

For a **new unused V3 Tavily ordinary proof**, select
`acceptanceProfile: "tavily-search-result-v1"` and `toolName: "tavily_search"` with
the exact arguments:

```json
{
  "query": "Microsoft Learn Azure API Management MCP",
  "include_domains": ["learn.microsoft.com"],
  "search_depth": "basic",
  "max_results": 1,
  "include_images": false,
  "include_image_descriptions": false,
  "include_favicon": false,
  "include_raw_content": false
}
```

The same ordinary call produces protocol and closed result predicates; no raw
result text is retained. Basic search normally costs one credit, not a billing
guarantee. Profile/argument/source/capture changes cannot reopen a consumed
operation. Default ordinary proof version 2, dedicated qualification version 3,
and first-call version 4 remain distinct. Validated not-dispatched failures may
permit fresh review; unknown/post-dispatch outcomes and locks prohibit replay.

## Evidence, recovery and diagnosis

1. `mcp-export-plan --project DIR --output NEW.zip [--persistence MODE]`.
2. `mcp-export` with identical inputs and exact `approvalToken`. Retain its
   `archiveSha256` independently from the archive.
3. `mcp-archive-inspect --archive FILE.zip --sha256 EXTERNAL_HASH` (read-only).
4. `mcp-restore-plan --archive FILE.zip --sha256 EXTERNAL_HASH --output NEW_DIR`;
   then `mcp-restore` with exact approval and identical inputs.

Only canonical stored schema-1 toolkit ZIPs are accepted; general ZIPs and custom
handoffs are unsupported. Paths, aliases, entry types, duplicates, size/hash/schema
and credential indicators are checked before restore. Bounds: 512 entries,
8 MiB/file, 32 MiB payload, 1 MiB manifest, 34 MiB ZIP, 4096 encountered names.
Allowed evidence bytes, including expired/failed/consumed history, remain unchanged.
Unknown surfaces and auth caches are excluded, not traversed for secrets.

Restore publishes through a pending admission barrier, not a directory rename.
Interrupted partial destinations remain blocked and cannot be reused. Lock
presence is non-authorizing metadata retained as a barrier. Imported identity is
not current login. Root/epoch/time/receipt/capture rewriting is unsupported.
The narrow historical schema-2 rejection-reader exception does not authorize
current execution or generic relocation.

`--persistence unknown|ephemeral|persistent` is a declaration, not verification.
Cloud Shell runtime signals do not establish that HOME persists. Export early;
use the environment's separately reviewed download mechanism and keep the
independent hash elsewhere. A same-filesystem checkpoint is not a backup.

`mcp-diagnose --project DIR [--config selection.json] --json` reads allowlisted
retained evidence only: no login, cache/log/env scan, process, HTTP/DNS/TLS probe
or retry. It reports closed failure classes, genuinely recorded timing/deadlines,
equivalent-failure groups, locks and next-action needs. Two equivalent stalled
reads trigger advisory stop/review/export/alternate-environment guidance, not a
new retry policy or a claimed network root cause. Timeout is not permission denial.
Host approval-delivery diagnosis is outside this toolkit.
