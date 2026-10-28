# Build recovery and recovered-image continuation

`mcp-build-recovery-schema/plan/run` supports **one separately approved local
build** after a Container Apps host runner stopped at its build stage. It also
supports Container Apps behind APIM, but never accesses that gateway.

This is not `mcp-execution-run` resume and not permission to start an unrelated
run directory. The original failure, target reservations, source and outer
execution journal remain unchanged. A separate target-scoped recovery claim
links the new attempt to that exact evidence. Even a failed reconciliation or
interrupted recovery consumes that claim; changing folders or approval cannot
repeat it.

### Reviewed source revisions after a dispatched build failure

`supersededRecoveryOutput` selects a completed, failed recovery build as evidence,
not authority to replay it. Supply all four revision fields together:

```json
{
  "supersededRecoveryOutput": "<absolute failed recovery directory>",
  "replacementProject": "<absolute newly generated source directory>",
  "replacementSourceManifestDigest": "sha256:<new source manifest digest>",
  "sourceChangesReviewed": true
}
```

These are additions to the required recovery configuration below. Do not combine
them with `rejectedRecoveryOutput` or `connectionRecoveryOutput`. `--project`
and `sourceManifestDigest` still identify the **original** sealed source. The
replacement must be generated separately, in a new directory, with its own local
generation review. Never edit, reseal or relocate any historical source or run.

The current revision contract permits only an explicit change to `npmRegistryUrl`
and/or digest-pinned `imageBuild`. The planner shows before/after values and binds
both source manifests. Everything else in the recipe stays unchanged, including
API operations, authentication, backend, identities, target names and resource
ceilings. Runtime/build-support files and infrastructure templates must match the
predecessor; locked dependency metadata, versions and integrity hashes must match
apart from resolved tarball URLs. Executable files must also match the current
trusted generator. A new manifest alone, unchanged effective build inputs, or
an arbitrary edited Dockerfile cannot qualify.

Eligibility requires the full sealed reconciliation/build-intent/terminal-failure
chain with a bounded Docker build failure and no successful build result or
later-stage artifacts. Missing, cancelled/incomplete or inconsistent records
remain blocked. The complete original host/outer evidence and reservations,
legacy pre-build predecessors, and up to 16 build-recovery records are checked.
Every failed build has one deterministic child-claim path, independent of the
chosen new source/output/approval. Concurrent requests cannot branch. Another
failed revised build can have a separately requested and reviewed **changed-source**
successor, never an unchanged-source retry or an automatic loop.

The engine reconciliation checks containers, images and exact tags for every
prior build owner in this lineage, preserving all prior images. The Docker
request ceiling grows by three reads per prior build owner and is printed in
the plan. Owner confirmation that all prior builds stopped and that the engine
is exclusively controlled is still mandatory. The lineage is checked again
before the one new build dispatch. Existing primary claims and reservations
are never replaced; the successor adds a `.build-successor-<parent-hash>.json`
claim.

### Runtime remediation after a recovered image fails scanning

When a successful recovery's **separate recovered-image continuation** ends at
`scan` with `HOST_EXECUTION_SCAN_POLICY` or `HOST_EXECUTION_SCAN_INCONCLUSIVE`,
the build-recovery config can additionally select:

```json
{
  "supersededRecoveryOutput": "<absolute successful recovery directory>",
  "scanRejectedContinuationOutput": "<absolute failed recovered-image directory>",
  "replacementProject": "<absolute separately generated replacement source>",
  "replacementSourceManifestDigest": "sha256:<new source manifest digest>",
  "sourceChangesReviewed": true
}
```

These are additions to the original-host recovery configuration, not a standalone
config. All four source-revision fields are required. The selected recovery must
be `built-unqualified`; the scan continuation must bind that exact recovery,
image, source, target and original private identity. Its sealed identity,
preflight and recovered-build stages must have passed, followed by a sealed
scan rejection. Missing/interrupted scans, container/transport failures, active
locks, or any smoke/tag/push/deployment artifacts are ineligible. Both bounded
private report files must remain present; their bytes are bound into the new
review as diagnostics, **not accepted image-qualification evidence**.

Generate a new source with a **different runtime image digest**. Merely changing
the tag while retaining the same digest, changing only the feed/builder, or
resubmitting the rejected image cannot qualify. The same source-revision limits
apply: application runtime code, dependencies and their integrity hashes,
authentication, identities, target resources and infrastructure remain fixed.
The new base-image digest is a candidate, not proof that findings are fixed.
Select it through separately reviewed inspection or an explicit owner-supplied
pin; never invent a digest, silently use a floating tag, or assume newer means
scan-passed. No default image or scanner policy is changed by this feature.

The original successful build, rejected scan, scanner volumes, all prior claims
and target reservation stay intact. One deterministic build-successor claim
prevents branching from the selected build. Reconciliation checks all prior
build owners/tags and additionally checks each rejected-scan owner's containers.
Any remaining container blocks execution; no cleanup is performed. The request
ceiling is `5 + 3 * priorBuildOwners + priorScanOwners`. The owner must confirm
that prior builds and scans have stopped and the engine is exclusively controlled.
All rejected-scan evidence is rechecked before building, including report bytes.

After a successful replacement build, separately approve `mcp-recovered-image`
again. Its permanent claim is
`.recovered-image-<hash-of-recovery-approval>.json`; the historical
`.recovered-image.json` claim is not removed or reused. The shared scan, fresh
database, zero-critical/high, unknown-severity rejection, nonroot smoke and
create-only deployment checks all run again. A scan failure can only lead to
another explicitly reviewed **different runtime digest**, within the bounded
lineage; it never grants an automatic retry. If the replacement build itself
fails at the eligible build stage, use the normal changed-source successor
without `scanRejectedContinuationOutput`; inherited scan evidence remains bound.
Other continuation failures (including smoke, push and deployment) remain
unsupported by this remediation path.

### Exception: separately approved successor after an engine-security rejection

The optional `rejectedRecoveryOutput` selects the original recovery directory
as immutable evidence, **not an execution to resume**. Exactly one linked
successor is supported when the original recovery has only `plan.json`,
`reconcile.intent.json` and a sealed `result.json` showing
`BUILD_RECOVERY_ENGINE_UNTRUSTED` after exactly two Docker reads, zero
Azure/provider calls, and no build intent. Its primary claim, original host
chain and any outer execution journal must all still verify.

This narrow path addresses a pre-build security-check rejection, including the
earlier overbroad registry check. It cannot be used after a dispatched build,
unknown/interrupted reconciliation, a missing result, a later check failure or
another engine-security successor. New current-build approval is required; the engine checks
run again and must pass. The original claim/result remain consumed and unchanged.
An additional target-scoped `.build-recovery-engine-recheck.json` claim prevents
duplicates or further engine-security successors, including after another
security rejection. A first-request connection failure has the separate narrow
route below.
Do not set this option merely to bypass a consumed build. A corrected check or
fresh approval does not by itself establish eligibility.

### Explicit connection retry before any build

When a linked engine-recheck or connection attempt terminates with
`DOCKER_RESPONSE_UNKNOWN` on its **first Docker version GET**, use
`connectionRecoveryOutput` instead of `rejectedRecoveryOutput` to request a
fresh build-only plan. This is a separate explicit retry request, never an
automatic retry or a reset of the old attempt. The closed evidence shape must
show exactly one Docker request, zero Azure/provider calls, and no build intent,
completed reconciliation, extra artifacts or missing terminal result.

The planner recursively verifies the original failed host, engine rejection,
and each linked connection failure (at most 16 predecessor records). Each parent
has one deterministic child-claim path, independent of output/config choices.
Concurrent approvals cannot create two children. Every previous claim, plan and
result remains unchanged. The lineage is checked again immediately before build.
One approved child runs all security/reconciliation checks and at most one build.
Any dispatched build, later-stage failure, ambiguous/incomplete evidence or a
security rejection does **not** qualify for this connection-only route.
Restoring Docker availability is a separate owner action, not an engine restart
performed by the runner.

## Eligibility and limits

- The retained identity and preflight receipts passed, followed by one sealed
  `unknown-no-replay` Docker build failure. No scan, smoke, push or later host
  stage may have dispatched. Missing results, unknown files, active parent locks
  and conflicting reservations are rejected.
- If the host belongs to an outer execution, its grant and complete journal must
  verify and end at the corresponding failed `sdk-host` phase, without provider
  calls. The historical build identifier is evidence, not current authority.
- Every executable build-context file must match the current trusted generator.
  Historical review/build metadata need not be regenerated or resealed. This is
  not a way to run an edited Dockerfile or inject a diagnostic command. Source
  revisions additionally obey the unchanged-runtime/dependency checks above.
- The account name must match the parent. The source pins tenant/subscription,
  targets, backend, image digests and npm lock (with explicitly reviewed build-input
  revisions only through the source-revision contract). No Azure authentication or API
  operation is performed; no credential cache is read or copied.
- **The owner must first establish that the prior build stopped and that they
  have exclusive control of the reviewed engine for this attempt.** The toolkit
  cannot establish this from a discarded error or an empty container listing.
  Legacy builder processes/intermediates are not reliably labelled. Do not
  automatically set `previousBuildStoppedReviewed` to true.
- The run checks the same explicit Docker socket, Linux/amd64 API compatibility
  and engine security settings: debug must be off, insecure CIDRs must be
  loopback-only, and the approved builder/runtime registries must not be insecure.
  Registry-index checks apply to Docker Hub (including its known aliases) and
  `gcr.io`, the only registries permitted by the trusted image-build schema.
  An insecure index for an unrelated registry is not a reason to block these
  pulls. Missing/malformed security metadata is inconclusive and blocks execution.
  It lists only parent-labelled containers/images
  and inspects exact old/new tags. Any parent-labelled container or existing new
  tag blocks the attempt. Old images are recorded by ID and preserved, not
  adopted as successful builds, removed or overwritten.
- One trusted build may download the pinned public builder/runtime images and
  exact sealed npm dependencies. Build memory is 1 GiB and CPU is one core;
  default total time is 30 minutes (maximum one hour, also bounded by expiry).
  Downloads can incur charges. The generated Dockerfile's own build-intermediate
  cleanup is unchanged; no pre-existing artifact deletion or cache pruning occurs.
- Success is **`built-unqualified`**, not deployment readiness. There is no
  automatic scan, smoke, push, deployment or tool call. The separate
  `mcp-recovered-image` contract below requires new reviewed authority.

## Conversational CLI preparation

Run Copilot from the private workspace and point it at the updated toolkit:

```text
Read docs/build-recovery.md and the copilot-mcp skill in the updated toolkit.
Prepare a build-only recovery plan from my retained failed host run.
Verify its immutable evidence and current source compatibility.
Ask me to confirm that the original build has stopped and that I control the
same engine exclusively; do not assume this from the error category.
Prepare the private config for review, then show the exact plan and approval.
Do not execute the recovery until I separately approve its specific effects.
```

Use `mcp-build-recovery-schema --json` for the closed config schema. Required
fields are `schemaVersion: 1`, absolute `oldHostOutput`, exact `oldHostApproval`,
`sourceManifestDigest`, matching `accountName`, fresh `expiresAt` (within 24
hours), and the explicit review flags `localEngineTrusted`,
`previousBuildStoppedReviewed`, `buildOnlyReviewed`, `downloadsReviewed`,
`resourceCeilingsReviewed`. Optional `maximumMs` is 60000 through 3600000.
For the narrow engine-rejection successor above, also supply absolute
`rejectedRecoveryOutput`; use new private config/output paths and review the
additional evidence binding and effects. Never overwrite the original config
or remove either claim.
For a linked first-version-GET failure, use absolute `connectionRecoveryOutput`
instead. The two predecessor options are mutually exclusive. Review and approve
the new plan for the explicit retry; the previous token is not accepted.
Never put credentials in this file.

Planning is local/read-only: no Docker or Azure access, output creation or claim.
`--project` selects the **original sealed source directory**, not the outer
execution directory. `--output` is a non-existing sibling recovery directory
outside the old run, source and private identity directories.

```powershell
node "<toolkit>\bin\copilot-mcp.js" mcp-build-recovery-plan `
  --workspace-root "<private workspace>" --project "<original sealed source>" `
  --config "<private recovery config.json>" --output "<new recovery directory>" `
  --json --summary
```

Review JSON stdout and the approval summary on stderr. Run only after approving
the exact token from that unchanged current-build plan:

```powershell
node "<toolkit>\bin\copilot-mcp.js" mcp-build-recovery-run `
  --workspace-root "<private workspace>" --project "<original sealed source>" `
  --config "<private recovery config.json>" --output "<new recovery directory>" `
  --approve "<exact mcp-build-recovery/... token>" --allow-local --allow-network --json
```

`--allow-cloud` is rejected. Run returns nonzero for `unknown-no-replay`.
Preserve `plan.json`, reconciliation/build intents and results, `result.json`,
and the `.build-recovery.json` claim beside the original target reservation.
The final receipt retains bounded `dockerFailure` diagnostics when available,
not raw Docker messages or secrets. If evidence writing itself fails, the
existing claim/intents still block replay; absence of a result is not success.
After a parsed engine-info response, new receipts also include `engineSecurity`
with `passed`, `failed` or `unknown` for `debugDisabled`,
`insecureRegistryCidrs`, `builderRegistry` and `runtimeRegistry`. `unknown`
means missing/malformed evidence, not a confirmed insecure setting.
These fields never retain daemon names, registry names, CIDR values or raw
engine configuration. `BUILD_RECOVERY_ENGINE_UNTRUSTED` remains the stop code.
Older receipts with only that code cannot identify which check failed; the
previous implementation also rejected unrelated insecure registry entries.
Do not assume that was the reason for a particular historical stop. A separately
reviewed read-only engine inspection is needed to assess current settings; it
does not reconstruct the past or unlock the consumed recovery claim. Only the
explicitly reviewed successor above can authorize a new linked attempt when all
eligibility checks pass. Never delete a claim, use an unrelated output directory,
or change Docker settings to bypass rejection.
Old diagnostics cannot be reconstructed. Neither a plan nor offline tests are
approval for a live build.

## Separate recovered-image qualification and deployment

After a sealed `built-unqualified` result, use
`mcp-recovered-image-schema/plan/run`. This is **new local/network/cloud
authority**, not an option on the build-only command. It supports direct ACA
and ACA behind APIM through the existing guarded host stages. It never rebuilds,
replays the original execution, signs in, copies credentials or selects a new
Azure identity.

The closed config requires `schemaVersion: 1`, absolute `recoveryOutput`, exact
`recoveryApproval`, the successful build's `sourceManifestDigest`, the original
`azureIdentityProject` and matching `accountName`, a digest-pinned
`aquasec/trivy@sha256:...` scanner image, fresh `expiresAt` within 24 hours, and
all six review flags: `localEngineTrusted`, `exclusiveControlReviewed`,
`downloadsReviewed`, `resourceCeilingsReviewed`, `createOnlyReviewed` and
`qualificationPushDeploymentReviewed`. Optional `maximumMs` is 60000 through
3600000. The Docker socket and registry repository are inherited from the
original plan, not selected through ambient settings or config overrides.

`--project` now selects the **successful recovery's source**, which may be the
newly generated replacement. `--output` is a new sibling continuation directory
outside all sources, prior runs and the selected private identity. Planning is
local/read-only. Review the exact recovered image ID, lineage, scanner/database
downloads, private identity, targets, templates and ceilings:

```powershell
node "<toolkit>\bin\copilot-mcp.js" mcp-recovered-image-plan `
  --workspace-root "<private workspace>" --project "<successful source>" `
  --config "<private continuation config.json>" --output "<new continuation>" `
  --json --summary
```

Only after separate approval of that exact current plan:

```powershell
node "<toolkit>\bin\copilot-mcp.js" mcp-recovered-image-run `
  --workspace-root "<private workspace>" --project "<successful source>" `
  --config "<private continuation config.json>" --output "<new continuation>" `
  --approve "<exact mcp-recovered-image/... token>" `
  --allow-local --allow-network --allow-cloud --json
```

Before any external operation, the runner takes a permanent target-scoped
`.recovered-image.json` claim while preserving the original reservation. It
revalidates the original and recovery receipt chains and reconstructs the
build-context evidence digest from the sealed source. The same selected private
Azure identity must match the original identity receipt. Current source must
match trusted build/runtime/deployment templates; the local image's ID, platform,
nonroot user and recovery owner label must match the successful build.

The existing host stages then scan the actual exported image, enforce fresh
scanner data and zero critical/high findings, write bounded private scan/SBOM
reports, and run nonroot **network-disabled** smoke. Only after these pass does
the runner add a new absent local tag, push it with a transient in-memory ACR
credential, and verify the resulting image digest. It does not overwrite or
delete the original local image. Cloud writes remain create-only with target
absence checks, conditional PUTs, registry digest verification, bounded readiness
polling and one bounded public `/health` GET. Gateway policies and unrelated
resources retain the original preservation rules.

Lineage, source, identity and continuation claim are rechecked before stages and
again before cloud creation. Any failure/interruption remains consumed, including
scan, smoke, tagging, push and deployment failures. Another output is not a retry
route. Only the separately reviewed runtime-remediation path above can follow
an eligible scan rejection; it does not resume the failed continuation.
No provider request, real secret read, tool discovery/proof, consumer integration,
publication or cleanup of pre-existing resources is implied. A completed host
result supplies the image review and endpoint for separately reviewed release,
authentication and proof operations; it does not resume the old outer journal.
