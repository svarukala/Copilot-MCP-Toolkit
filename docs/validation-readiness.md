# Validation candidate and acceptance checklist

Use this runbook after engineering changes are integrated, before claiming live
readiness. It is a checklist, not permission to install, authenticate, deploy,
call a provider, publish or replay a consumed proof. Keep actual identities,
approvals, outputs and evidence in the selected private workspace.

For an existing direct Container Apps endpoint, use the
[resumable validation runner](reusable-validation.md) to drive local checks,
separately approved discovery/proof, owner checkpoints and private handover.
It reduces repeated manual command work; it does not replace the acceptance
gates below or authorize live execution.

## Freeze the candidate

Do not assume a normal clone of `main`, an old installed package or a previously
copied skill includes the latest feature-branch work. Select an approved commit
explicitly in a separate checkout or use its reviewed local package. No merge
or npm publication is required to validate a pinned candidate.

From that checkout, record:

```powershell
git rev-parse HEAD
git status --porcelain
node --version
npm --version
node .\bin\copilot-mcp.js capabilities --json
Get-FileHash .\skills\copilot-mcp\SKILL.md -Algorithm SHA256
```

Require a clean tracked candidate before acceptance and record the exact commit,
`toolkit.buildId`, runtime/OS, test result and skill hash. The package version
alone is insufficient; multiple builds can share it. For a local installed
package, run capabilities through that package's explicit CLI path and compare
its build ID and shipped skill hash with the selected checkout. Review a
different build rather than assuming compatibility. Each environment records
its own exact bytes/build identity; do not normalize or reseal old evidence.

Do not search authentication caches or silently replace installed skills.
If the selected skill copy differs, review its update using
[the installation guide](copilot-cli.md). Start/reload the host only after
that separately chosen update. Use the explicit engine path consistently.

After dependencies are available from the approved feed:

```powershell
npm run validate
git diff --exit-code
```

`validate` checks the asset inventory without rewriting it, parses source/CLI/
maintenance JavaScript, checks public types and runs the complete offline suite,
including the fresh packed consumer. It never installs dependencies. If restore
is needed, follow [development setup](development.md) separately. Do not change
source, docs, examples or skills during the run: exact plans bind their bytes.
Record the final totals and any platform skips, not only selected green tests.

The GitHub workflow runs the same gate on Windows/Linux and Node 22/24 for pull
requests, pushes to `main` and manual dispatch. Dependency restore is its
separate network-enabled bootstrap step; tests use synthetic transports/runners.
It requires no Azure/M365 secrets. A denied feed is a failed prerequisite, not a
reason to switch registries or disable TLS. A configured matrix is not evidence
that its jobs have run. Local success on one OS/runtime does not qualify others.

Freeze the resulting candidate before live work. If code changes, rerun affected
checks and the full offline gate before recording a replacement candidate.
Do not reuse an old exact approval after changing the installed build.

## Choose the correct project at each step

| Retained item | Local review/continuation | Boundary |
| --- | --- | --- |
| Native APIM bundle | `mcp-status`, then `mcp-resume` | Uses `mcp-server.json`; each proposed effect needs its own approval |
| SDK hosting source | `mcp-recipe-source-plan`; `mcp-operator-status` for recorded owner activity | Sealed `recipe-manifest.json`; not an APIM lifecycle project |
| SDK release folder | Review `release-review.json`, template parameters and source hash against its source | Local preparation only; do not pass it to APIM Resume or redeploy it to check progress |
| SDK endpoint reference | `mcp-status`, `mcp-resume`, discovery/proof/FCC plans | Contains `mcp-server.json`; no cloud ownership or deployment evidence is inferred from the reference |
| Authentication preparation/session | `mcp-auth-registration-*` and `mcp-auth-execution-status` for the selected session | Separate from source/release; preserve consumed registration and shared-profile boundaries |
| Paused owner action | `mcp-operator-status`, then an explicitly reviewed matching resume event | Wait remains wait; do not repeat sign-in, deployment or proof to fill the pause |
| Deployment handover | Open `index.html`; review manifest and original retained projects | A snapshot, not restorable execution authority, a live dashboard or an executable deployment script |

Keep the source, release, reference, authentication preparation/session and
handover paths in the private validation record. Never guess their relationships
from similar names. Source manifest and endpoint bindings must match. Resume a
retained project, not a newly created reference intended to bypass a consumed call.
The terminal wizard covers APIM/reference generation and review; SDK hosting
uses the explicit hosting commands or the shipped Copilot CLI skill.

## Shared acceptance gates

Begin with direct Container Apps. Use a new, explicitly reviewed purpose and
supported endpoint; the prior API Ninjas pilot is owner-reported historical
acceptance, not permission to replay its calls. Read each selected command's
schema and exact plan rather than copying fabricated identities.

| Gate | Expected evidence | Stop condition |
| --- | --- | --- |
| Inputs and entitlement | Explicit host, backend, caller auth, resource choices, approved feed and API-key shared-access review where applicable | Missing review, incompatible OAuth/REST shape, secret supplied as configuration, or ambiguous identity |
| Generation | Exact approved source; immutable manifest; correct annotations and auth; selected `npmRegistryUrl`, locked package versions/integrities and build inputs | Wrong feed/target, changed sealed files, missing image digests or unsupported host prerequisites |
| Build and release | Separately approved actual dependency restore/build, exact image digest or Functions source hash, scan/SBOM/smoke review and matching release | Connectivity probe substituted for build success; mutable image; unknown source provenance; unsafe registry workaround |
| Deployment and readiness | Separately reviewed private identity/what-if, actual resource/revision/endpoint readback; owner journal distinguishes submitted, ready and unknown | ARM submission treated as runtime readiness, shared-resource overwrite, unexpected drift or unresolved dispatch |
| Credentials and caller rejection | Real host Key Vault reference resolution where used; distinct identity scopes; unauthorized caller rejected without backend invocation | Missing key starts successfully, key/token leakage, caller checks bypassed, or unreviewed role/consent change |
| Discovery | New approved metadata-only observation with correct endpoint, audience, selected identity and observed tool schemas/annotations | Wrong account/audience/tool set, stale capture, unsupported transport or fabricated metadata |
| One-call proof | Separate exact approval; at most one dispatch; protocol and optional bounded result assertion recorded independently | Failure/unknown outcome remains consumed; no retry to improve the report |
| Evidence and pause/resume | Status, Resume and diagnosis read the same outcomes; export/restore preserves barriers; owner wait/defer state survives restart | Contradictory statuses, dropped failure, lost consumption barrier or changed project binding |
| Consumer onboarding | Correct FCC auth reference, policy/audience review, human submission, Ready state and attributed consumer result recorded separately | Ready substituted for consumer execution, policy deferral treated as rollout permission, or incorrect tool classification |
| Handover | Actual source/release/reference relationships, pending/deferred labels, working two-tab HTML/diagram and destination guidance | Owner reports promoted to service evidence, sensitive export content, broken links or commands presented as preapproved |
| Update/rotation/closeout | Separate preserving-update review, revision readiness, host-specific secret refresh and recorded cost/ownership decision | Replaying create templates over unrelated resources, assumed immediate secret rotation, automatic teardown or unconfirmed cleanup |

For the negative caller checks, secret resolution/rotation and consumer calls,
review exact targets, expected effects and cost first. These are live acceptance
steps, not additions to `npm test`. Keep raw private evidence out of Git.

## Host-specific coverage

Each row is a distinct qualification result. Anonymous backend, header key and
query key are distinct cases; query keys require their own URL/logging review.
Prioritize the user's selected route rather than running all paid environments.

| Host | Additional acceptance | Current qualification boundary |
| --- | --- | --- |
| Direct Container Apps | Linux/amd64 image actually starts nonroot, correct ACR pull/secret identities, revision/traffic readiness, scale behavior | API Ninjas end-to-end success is owner-reported; current candidate and added lifecycle behavior need separate acceptance |
| Container Apps + APIM | Inherited policies preserved; signed gateway and caller tokens required; direct-host MCP bypass rejected; host readback before gateway release | Offline implementation is not live gateway/consumer qualification |
| App Service container | Existing plan preserved, pull resource/client IDs match, actual hostname and Key Vault refresh behavior | Live platform/consumer qualification outstanding |
| Functions SDK preview | Actual Functions host starts and routes custom handler correctly; managed-identity storage; separately approved One Deploy/remote build; preview availability and cost | SDK tests do not execute the Functions host; local host and live Flex qualification remain outstanding |

Native APIM scenarios remain separate: anonymous fixed GET, API-key mapping,
controlled delegated and Graph managed-identity profiles have different proof
eligibility. Use [the scenario matrix](scenarios.md); do not use SDK successes
to qualify native APIM or vice versa.

Full native Windows registration remains **deferred by the owner**. The spike
sign-in and synthetic Windows executor coverage are not an end-to-end registration
claim. Existing reviewed registration reuse/manual preparation can be recorded
without reopening that deferred execution. Linux remains optional for isolated
SSO and is required by the current custom OAuth execution adapter.

WIQD endpoint/tool export (H1/H2 onward), generic OAuth/OBO, broader REST support,
automatic deployment and production rollout are not prerequisites for validating
the supported routes above.

## Private outcome record

For every selected gate retain: candidate commit/build ID, scenario/profile,
explicit project paths and artifact digests, exact approval reference, timestamp,
expected outcome, actual outcome, provenance and remaining gate. Use
`pending`, `passed`, `failed`, `blocked`, `deferred` or `unknown` in the checklist;
map to the chosen command's supported status enums rather than inventing new
machine statuses. Distinguish synthetic checks, owner declarations and actual
service observations. Unknown dispatched operations stay consumed.

Preserve interrupted output and immutable receipts. Reconciliation, restoration
and a newer handover never grant execution authority. At completion or pause,
offer the separately reviewed private handover; a declined export remains pending.
