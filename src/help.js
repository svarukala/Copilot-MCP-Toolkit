export const commandFamilies = {
  execution: ['mcp-execution-schema', 'mcp-execution-plan', 'mcp-execution-start',
    'mcp-execution-run', 'mcp-execution-status', 'mcp-execution-record'],
  validation: ['mcp-validation-schema', 'mcp-validation-plan', 'mcp-validation-start',
    'mcp-validation-next', 'mcp-validation-run', 'mcp-validation-status'],
  hostOperations: ['mcp-host-schema', 'mcp-host-plan', 'mcp-host-run', 'mcp-host-account-plan', 'mcp-host-account-switch'],
  interactiveSession: ['mcp-session-plan', 'mcp-session'],
  terminal: ['mcp-terminal-handoff'],
  bootstrap: ['mcp-bootstrap-schema', 'mcp-bootstrap-plan', 'mcp-bootstrap-bundle'],
  recipeReviews: ['mcp-recipe-review-schema', 'mcp-recipe-review-plan', 'mcp-recipe-review-bundle'],
  operator: ['mcp-operator-schema', 'mcp-operator-plan', 'mcp-operator-record', 'mcp-operator-status'],
  containerApps: ['mcp-container-apps-schema', 'mcp-container-apps-plan', 'mcp-container-apps-create'],
  hosting: ['mcp-hosting-schema', 'mcp-hosting-plan', 'mcp-hosting-create'],
  handover: ['mcp-handover-schema', 'mcp-handover-plan', 'mcp-handover-bundle'],
  recipeArtifacts: ['mcp-recipe-source-plan', 'mcp-recipe-release-plan', 'mcp-recipe-release-bundle',
    'mcp-recipe-reference-plan', 'mcp-recipe-reference-create'],
  generation: ['mcp-server-plan', 'mcp-server-create', 'rest-tools-plan', 'rest-tools-write'],
  resources: ['mcp-resources-choose', 'mcp-resources-plan', 'mcp-resources-write', 'mcp-inventory-plan', 'mcp-inventory'],
  identity: ['mcp-account-plan', 'mcp-account-switch', 'mcp-app-init', 'mcp-app-account-plan', 'mcp-app-account-switch', 'mcp-app-plan', 'mcp-app-apply'],
  lifecycle: ['mcp-provision-plan', 'mcp-provision', 'mcp-reconcile-plan', 'mcp-reconcile', 'mcp-capture-plan',
    'mcp-prerequisites-plan', 'mcp-prerequisites', 'mcp-identity-plan', 'mcp-fixture-plan', 'mcp-fixture-bundle'],
  observation: ['mcp-discovery-plan', 'mcp-discover', 'mcp-proof-plan', 'mcp-proof', 'mcp-proof-preflight-plan', 'mcp-proof-preflight',
    'mcp-auth-rejection-plan', 'mcp-auth-rejection', 'mcp-backend-rejection-plan', 'mcp-backend-rejection',
    'mcp-qualification-plan', 'mcp-qualification'],
  journey: ['mcp-status', 'mcp-resume', 'mcp-diagnose'],
  evidence: ['mcp-export-plan', 'mcp-export', 'mcp-archive-inspect', 'mcp-restore-plan', 'mcp-restore'],
  federated: ['mcp-fcc-schema', 'mcp-fcc-plan', 'mcp-fcc-bundle'],
  registration: ['mcp-auth-registration-schema', 'mcp-auth-registration-plan', 'mcp-auth-registration-bundle'],
  wiqdHandoff: ['mcp-auth-wiqd-schema', 'mcp-auth-wiqd-plan', 'mcp-auth-wiqd-bundle'],
  registrationExecution: ['mcp-auth-execution-schema', 'mcp-auth-execution-plan', 'mcp-auth-execute', 'mcp-auth-execution-status'],
};

export const HELP = `Copilot MCP Toolkit (Node.js 22+)

copilot-mcp <command> [options]
node bin/copilot-mcp.js <command> [options]

No command / init: terminal-only New / Resume / Advanced setup.
New: source/authentication questions, reviewed local generation after confirmation.
Resume: local report only. No automatic login, deployment, discovery or tool calls.
schema: complete bounded MCP input schema. capabilities: supported contracts/build.
Container Apps uses its separate mcp-container-apps-schema, not the APIM schema.

${Object.entries(commandFamilies).map(([name, commands]) => `${name}: ${commands.join(', ')}`).join('\n')}

--workspace-root ABS_DIR  Explicit existing caller-owned workspace, separate from installed code.
--config FILE             Nonsecret definition, resource choices or discovery/proof selection.
--project DIR             Standalone project; no plugin or appPackage required.
--output PATH             NEW bundle/file/archive/destination. Never overwrite.
--approve EXACT_TOKEN     Copy the TOP-LEVEL plan token/digest, not nested approvals.
--phase PHASE             foundation | finalize | gateway (provisioning).
                          inspect | create | configure | preauthorize | reconcile (app setup).
                          configuration | discovery | proof | qualification |
                          caller-rejection | backend-rejection (resume).
--tenant-id UUID --subscription-id UUID --account-name NAME
                          Exact new Azure account choice; no ambient fallback.
--use-device-code         Account plan/switch or resume: separately approved headless Azure login.
--allow-cloud             Explicit approved inspection/app apply opt-in where required.
--allow-network           Explicit approved MCP discovery/proof/rejection opt-in.
--allow-local             Host run: explicitly reviewed local Docker access.
--allow-provider          Explicit auth-provider phase opt-in (Linux tmpfs only).
--confirm-identity        Registration only: confirm reviewed ATK account/organization.
--interactive             Protected MCP runtime sign-in; terminal required, not Azure login.
--experimental-configuration  V3-only read-only reconcile/refresh; no gateway replay.
--archive ZIP --sha256 HEX External independent archive hash; inspection never extracts.
--persistence MODE        unknown | ephemeral | persistent (declaration, not verification).
--summary                 Exact approval summary on stderr for supported plans/resume.
--progress                Opt-in stages/waits on stderr; account-switch/reconcile/discover/proof/qualification/resume.
--json                    Machine-readable stdout. --help / --version are local.

REST: OpenAPI 3.0.x JSON, explicit operation IDs, local references only. GET/query
authoring and executable proof are narrower than generation. Generated APIM inbound
is explicit Entra; backend anonymous, Key Vault API key, delegated passthrough or
constrained existing system-managed identity. Existing MCP references may declare
anonymous/Entra/OAuth; OAuth exchange/discovery is NOT implemented.
Upstream key proxy v2 has provider compatibility limits; v3 owned-backend-routing-v1
is explicit experimental opt-in, not forwarding proof.

Review plan -> exact approval -> one supported phase -> retained status/resume.
Bounded execution: mcp-execution-schema/plan/start/run/status/record is a separate
opt-in contract for all five fresh-creation families. A reviewed plan explicitly
grants its pinned phases, limits, identity and one proof; start records that one
approval. Run advances without per-phase prompts, using --interactive only when
a real sign-in is needed. Never supply a legacy phase token as an execution grant.
Owner evidence remains distinguishable from actual execution; record only genuine
pending milestones. Failed/unknown attempts stop, never retry. Cloud costs are
resource-bounded, not a billing cap; expiry does not delete running resources.
See docs/reusable-validation.md for SDK host prerequisites and remaining boundaries.
Validation: schema/plan/start/next/run/status for existing direct ACA (v1), or
fresh direct ACA, ACA behind APIM, native APIM REST, existing MCP and proxies (v2).
Use --workspace-root and a NEW run --output; continuation --project is the run.
V2 copies a reviewed definitionFile; relatedProjects/historyReviewed preserve
related consumed calls. Generation, release/reference, private APIM account and
lifecycle, discovery/proof and export each need exact separate phase approval.
Use only next.requiredFlags: --allow-cloud for APIM lifecycle/readback,
--allow-network for MCP/login, --interactive for terminal-only sign-in.
SDK builds/deployment, secret resolution, negative tests and FCC remain owner gates.
V2 request --config is a checkpoint or release/reference file selector.
V2 --phase handover exports SDK snapshots; --phase archive preserves MCP evidence.
Caller Entra is not backend Entra/OBO. Unsupported profiles stop, not pass.
See docs/reusable-validation.md; no blanket execution approval or automatic retry.
Host operations: schema/plan/run for local engine or reviewed host/container npm
diagnostics and digest-only private ACR pull. Explicit local Docker socket,
new output JSON and exact approval; separate local/network/cloud flags.
Npm probes accept registryProbe with an explicit HTTPS registryUrl and ping or
package-metadata kind (plus packageName). No npm config/auth import or install.
Private pull uses host-account-plan/switch on the sealed source project first;
no shared Docker login, saved registry token, automatic build or pull replay.
Session: optional terminal-only existing Entra MCP discovery then a separately
reviewed proof, reusing one unexpired token in memory for at most 15 minutes.
Exact expected user is required. New proof approval is requested after discovery;
no automatic refresh/relogin, persistent cache, extra call or changed default.
Bootstrap: separate direct Container Apps prerequisite review before source
generation. Explicit existing/new resources, separate group/resource templates,
existing mcp-app-* directory handoff and pending actual IDs. Plan/bundle need
workspace/config/new output JSON, and bundle exact --approve. No secret access,
role grants, installs, network probes or deployment.
Operator records: explicit private workspace/project; schema gives reserve,
dispatch, observe, wait, resume and owner-result events. Plan/record take --config;
record needs exact --approve. This append-only operator-declaration journal never
executes cloud commands or authorizes a proof. Record dispatch BEFORE external
execution; empty output is unknown, not permission to retry. Status is read-only.
Recipe reviews: schema describes bounded operator evidence. Plan/bundle require
workspace/project/config and new output JSON; bundle needs exact --approve.
Container generation emits a minimal nonroot Dockerfile only when imageBuild
provides reviewed builder/runtime digests and platform. No mutable base fallback.
Image review binds scan/SBOM/smoke metadata to source and image, not attestation.
Release may reference imageReviewFile; stale or failing qualification is refused.
Review kinds also cover preserving Container Apps/Entra updates, readiness,
authentication impact, secret metadata and cost/closeout. Nothing is executed.
mcp-terminal-handoff --workspace-root ABS --project REF --config SELECTION
--phase discovery|proof emits an exact PowerShell command for a real terminal.
It never launches or logs in. The displayed operation still needs its own review.
Existing-MCP unused first proofs may select resultAssertion:
json-array-string-field-v1, field, maxItems (1-100), maxStringLength (1-4096).
The bounded shape check runs in the same call; no raw response is retained.
It cannot be added to an already consumed proof or removed to authorize replay.
Container Apps recipe 1: local SDK server source and ARM review files only.
mcp-container-apps-plan/create requires --workspace-root, --config and a NEW
--output directory; create requires the plan's exact --approve. Plan supports
--summary. Entra v2 delegated callers, anonymous or Key Vault API-key JSON backend and reviewed fixed
GETs only. No APIM, cloud deployment, image build/push or automatic sign-in.
mcp-hosting-schema/plan/create additionally support Container Apps behind APIM,
App Service containers and Functions SDK custom handlers (preview, Linux FC1).
All four accept a dedicated header or query API key via native Key Vault references
and a separate explicit user-assigned identity. Never supply a key value in JSON
or command arguments. Missing/unresolved credentials prevent server startup.
No secret lookup, identity/role creation, caller-auth bypass or tool-call retries.
mcp-recipe-source-plan reviews the sealed source archive. Release plan/bundle
prepares exact source/template/artifact files; it never deploys. Reference
plan/create writes a separate unverified existing-MCP project for later
discovery/proof/FCC, not a fabricated capture. Both require project/config/new
output, explicit workspace and exact approval for writes.
See docs/hosting-recipes.md for all four profiles and their live limitations.
Handover: mcp-handover-schema/plan/bundle produces a private offline two-tab HTML,
inline SVG/editable Excalidraw architecture, sealed source and optional matched
release files. Requires workspace, sealed hosting project, config and NEW output
directory. Config includes snapshotAt and privateExportReviewed: true; optional
referenceProject/releaseDirectory are resolved relative to config within the
workspace. Owner reports/deferred milestones never become verified evidence.
Plan supports --summary; bundle requires exact --approve. No credentials, raw
captures, external assets, login, deployment, calls or replay authority.
Use at completion or pause; see docs/deployment-handover.md.
First-call Tavily acceptance is an explicit selection in a FUTURE unused ordinary
proof. Failed, inconclusive and unknown dispatched calls are consumed too.
Export/restore never renew evidence, credentials, roots, approvals or calls.
Diagnosis is local evidence-only; no network probes, retries or host UI diagnosis.
FCC: mcp-fcc-schema describes local onboarding input. mcp-fcc-plan requires
--workspace-root, --config and --output NEW.json; mcp-fcc-bundle also requires
the exact --approve token. Output is a private onboarding draft, not a Microsoft
manifest or registered connector. manualSetup contains human copy/paste fields and
auth registration instructions. OAuth is reference-only; no login/exchange/discovery.
Missing/stale metadata remains explicitly blocked. No browser submission is performed.
Developer fields may be omitted for a blocked draft; never invent legal URLs.
review.legalPolicies declares not-reviewed, placeholder or reviewed; placeholders
block submission, and even reviewed remains an unverified manual checkpoint.
review.pocPolicyDeferral records a deferral, never finalized policy readiness.
phaseReadiness keeps independent authorization troubleshooting separate.
WIQD Windows handoff: mcp-auth-wiqd-schema describes registrationConfig,
wiqdProject and environment. mcp-auth-wiqd-plan/bundle takes --workspace-root,
--config and --output NEW.json; bundle requires exact --approve. Plan supports
--summary. Exports operator-run WIQD commands, action review data and reference
return mapping. No WIQD invocation, project edits, credential access or Linux
requirement. WIQD owns authentication; its whole provisioning lifecycle needs
separate review. This is not project-isolated native authentication automation.
Auth registration: mcp-auth-registration-schema describes explicit SSO/custom OAuth
preparation. Plan/bundle takes --workspace-root, --config, --output NEW.json and,
for bundle, exact --approve. Plan supports --summary. Exports form values, reviewed
provider action data and FCC/plugin references, not an executed registration.
These preparation commands perform no secret resolution, ATK invocation or
provider OAuth exchange. FCC can select the
output via source.authenticationBundleFile; imported references remain unverified.
Auth execution: separate mcp-auth-execution-plan / mcp-auth-execute --phase
initialize | login | register | close, with --workspace-root, --project and --config
(config not needed for close). Requires reviewed ATK 1.1.17 and either Linux
owner-only tmpfs (default) or explicit windows-user-managed authenticationMode
with sharedProfileReviewed: true (secretless Entra SSO only). Windows uses the
normal ATK profile/broker, not isolated credentials; login may replace prior ATK
sign-in and close does not log out or erase shared caches. Both modes require
--allow-provider and exact phase approval. Login requires --interactive and
--allow-network; register requires --confirm-identity and --allow-network, plus
--allow-cloud only for a selected private Key Vault identity on Linux. No implicit shared login,
automatic install, Docker startup, registration retry, consent or publication.
Execution config may opt into allowAnyAppValidationPlaceholder for Entra SSO
with explicit HomeTenant / AnyApp and no supplied app ID. The unused ATK validation
placeholder is disclosed in initialize/login/register plans; it creates no app. SpecificApp still
requires a real intended app ID. Windows requires its separate explicit mode/review.
Use mcp-auth-execution-status for local retained state. A created-unverified result
can feed preparation through source.registrationResultFile; settings still need review.
See docs/cli-contract.md and docs/scenarios.md for input shapes and limits.
`;
