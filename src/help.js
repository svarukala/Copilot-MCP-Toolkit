export const commandFamilies = {
  containerApps: ['mcp-container-apps-schema', 'mcp-container-apps-plan', 'mcp-container-apps-create'],
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
Container Apps recipe 1: local SDK server source and ARM review files only.
mcp-container-apps-plan/create requires --workspace-root, --config and a NEW
--output directory; create requires the plan's exact --approve. Plan supports
--summary. Entra v2 delegated callers, anonymous JSON backend and reviewed fixed
GETs only. No APIM, cloud deployment, image build/push, automatic sign-in or
new-contract discovery/proof/FCC integration. See docs/container-apps-recipe.md.
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
(config not needed for close). Requires reviewed ATK 1.1.17, Linux owner-only tmpfs,
--allow-provider and exact phase approval. Login requires --interactive and
--allow-network; register requires --confirm-identity and --allow-network, plus
--allow-cloud only for a selected private Key Vault identity. No shared login,
automatic install, Docker startup, registration retry, consent or publication.
Execution config may opt into allowAnyAppValidationPlaceholder for Entra SSO
with explicit HomeTenant / AnyApp and no supplied app ID. The unused ATK validation
placeholder is disclosed in initialize/login/register plans; it creates no app. SpecificApp still
requires a real intended app ID. This option does not enable Windows execution.
Use mcp-auth-execution-status for local retained state. A created-unverified result
can feed preparation through source.registrationResultFile; settings still need review.
See docs/cli-contract.md and docs/scenarios.md for input shapes and limits.
`;
