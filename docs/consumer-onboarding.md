# Secured MCP consumer onboarding

After a successful reusable execution, choose **FCC**, **Microsoft 365 / Cowork
plugin**, or **None**. These are next steps, not part of the consumed execution
grant. JSON/noninteractive execution returns `consumerOnboarding` with the choices
and an app continuation contract; only a real, non-JSON
`mcp-execution-run --interactive` displays the terminal menu. Selecting a
consumer at that menu enters the existing onboarding journey: prepared-input
collection, exact reviews, registration/reuse and export. It does not merely
return a command. None leaves the endpoint and all evidence untouched.
Declined/blocked onboarding is reported separately from the completed MCP
execution; incomplete selected onboarding returns exit code 2.

The assistant should prepare the small private input below from the selected
endpoint descriptor and already observed tools, then offer the choice. Source
generation alone is not a deployed MCP. Never manufacture a capture or reuse
an old proof approval to finish onboarding.

## GitHub Copilot app continuation

The app agent drives the existing explicit commands, not the terminal wizard.
The JSON `consumerOnboarding.appContinuation` identifies preparation,
registration and export commands and their approval boundaries. Choosing
Plugin or FCC requests that next task, **not blanket cloud consent**. The agent
must ask for a genuinely missing input or show the next exact approval rather
than end with "selected; creation is separately reviewed". An earlier request
to stop after creating the MCP and ask has been fulfilled once the agent asks;
the subsequent selection requests onboarding preparation.

Reuse the saved descriptor, capture and any compatible registration receipt.
Prepare private inputs, review each existing auth-executor phase, import the
real reference, then review and write the consumer bundle. Sign-in still needs
a real-terminal handoff and actual account/tenant confirmation; a noninteractive
app tool must not impersonate a terminal. Do not copy caches or redirect challenges.
The agent stops on a concrete blocker, an explicit user stop, or actual outputs,
not merely on acknowledging the consumer choice.

Before export, show the post-registration `settingsReview`: fully qualified
portal scope using the actual registered URI, endpoint, resource, tenant and
consumer app restrictions. Either import an explicitly owner-reported
`source.settingsAttestationFile` through a new shared registration preparation,
or obtain acknowledgment that the output is an **unverified local draft**.
Never infer attestation from creation success or generated expected settings.
See [settings completion](auth-registration.md#post-registration-settings-completion).

To continue a previously stopped app conversation:

> Continue with Cowork plugin onboarding for the MCP we just created. Reuse its
> saved descriptor, observed tools and handover; do not redeploy or repeat its
> proof. Collect any missing nonsecret inputs and show the next exact secretless
> SSO registration/reuse review now. After the separately approved operations,
> export the placeholder plugin manifest, observed tool-description file and
> HTML with the actual registration reference and Application ID URI. Do not
> publish or make a consumer call. If blocked, identify the concrete missing
> prerequisite rather than ending at "Plugin selected."

This is agent-directed continuation, not a native app event hook or automatic
registration. Source updates do not resume an already stopped conversation.

## One shared authentication journey

```powershell
copilot-mcp mcp-onboard-schema --json
copilot-mcp mcp-onboard --workspace-root C:\private\demo --config C:\private\demo\onboarding.json --output C:\private\demo\consumer-session
```

The command requires a real terminal. Choose `--consumer fcc`, `plugin`, or `none`
to carry forward a choice already made. All prompts/reviews use stderr; the
terminal command emits one JSON result on stdout. Do not redirect terminal
authentication challenges, record login codes, or supply effect flags from an
earlier grant.

```json
{
  "schemaVersion": 1,
  "fccConfig": "fcc.json",
  "registrationConfig": "registration.json",
  "authExecutionConfig": "execution.json",
  "authProject": "new-auth-session"
}
```

Paths are relative to this file, inside the explicitly selected private
workspace. `fccConfig` is the existing `mcp-fcc-schema` input: reviewed display
metadata, exact descriptor, optional observed capture, Entra SSO authentication,
data-access justification and review of **every** observed retrieval tool.
Missing legal/branding metadata can remain absent for a blocked local draft.
`registrationConfig` is the existing `mcp-auth-registration-schema` input.
Both must select the identical Entra MCP descriptor. A conflicting explicit
reference is rejected, never replaced.

If the registration already exists, provide its actual
`registration.reference.registrationId` and `applicationIdUri`, or use its
bound `source.registrationResultFile`. The executor is not contacted.
`authExecutionConfig` and `authProject` can be omitted in this case.
The opaque reference is preserved, including leading punctuation and padding.
It is not the Entra app client ID or the Teams app ID.

For a new registration, prepare the existing `mcp-auth-execution-schema` config
and a new auth-project path. The command drives **initialize, login (or explicit
Windows verification), register, close**, each through the existing exact plan and explicit approval. It displays
the actual account/tenant evidence before register, uses the existing one-shot
target reservation and imports the bound result automatically. No custom
provider, browser automation, duplicate registration or cache copying is added.
An installed supported provider and required owner permissions remain prerequisites.

On Windows select `authenticationMode: "windows-user-managed"` with
`sharedProfileReviewed: true` only after the owner reviews the existing ATK
normal-profile/Credential Manager/broker effects. This is **not credential
isolation**; sign-in may replace the current ATK account, caches persist, and
close does not log out or delete them. Linux isolation uses the existing
tmpfs provider mode. These modes are not interchangeable within a session.
Windows live qualification remains separate from offline tests.

For an initialized Windows session, the terminal journey explicitly offers
**verify existing sign-in**, **sign in**, or **pause** before the phase review.
Verification does not explicitly log in/out, but may refresh credentials or
require reauthentication and needs its own network approval. Failed/unknown
verification never falls back to login. Registration checks the shared identity
again after dispatch; uncertainty remains consumed and cannot be retried.

FCC creates no dummy Teams app. For HomeTenant/AnyApp with no app ID, the existing
ATK validation compatibility opt-in must be explicitly reviewed in the executor
config. Never infer AnyApp, AnyTenant or a compatibility opt-in from choosing FCC.
For a SpecificApp plugin, supply `pluginAppId` matching that registration's
actual app ID; no silent widening is allowed. A registration whose audience or
restrictions are unsuitable needs separate review, not automatic recreation.

```powershell
copilot-mcp mcp-onboard --workspace-root C:\private\demo --project C:\private\demo\consumer-session
```

Resume uses saved inputs and retained auth state. Failed/unknown dispatches stay
consumed. Declining close preserves the created reference and runtime for the next
review. Changed input files stop continuation; they do not reset the auth target.
Completed exports are hash-checked locally without contacting the provider.
Before a new export with pending settings, the wizard explicitly offers
**stop for settings review** or **export an unverified local draft only**.
Stopping retains the same registration; resuming never creates another one.
Later attestations require new reviewed preparations and export destinations,
not edits to the saved session or historical results.
Crashes that leave an incomplete output require review of that folder and a new
export destination, not an overwrite. Do not edit toolkit source during a
prepared/active provider operation.

## Outputs and what they prove

`handover/index.html` has copyable FCC/SSO fields, the actual registration ID and
generated Application ID URI, observed tools, missing gates and finishing steps.
It uses the existing offline Clawpilot theme, keyboard-accessible tabs and
clipboard fallback. No external assets/scripts/network requests are needed.
`fcc-onboarding.json` preserves the existing FCC contract.
`consumer-manifest.json` binds the files with hashes, not an authenticity claim.

The visible states are deliberately separate: **registration reference**,
**portal settings**, **endpoint configuration**, **consent**, **package
validation**, **draft generation**, and **consumer test**.
A receipt is `created-unverified`; directory/endpoint compatibility and consumer
acceptance remain unverified. Review the existing app's generated identifier URI,
Web redirect and Microsoft token-store preauthorization separately, preserving
unrelated audiences and clients. No app update, consent, redeployment, provider
call, FCC submission or rollout is performed by the exporter.
An `operator-attested` portal-settings state records a matching owner report,
not provider readback or current consumer readiness. HTML prominently displays
pending settings and the expected values even when a plugin starter is emitted.
Export integrity checks are not WIQD/static package validation.

Plugin output additionally contains `plugin/manifest.template.json` with a
v1.28 `agentConnectors[].toolSource.remoteMcpServer`, actual `mcpServerUrl`,
`authorization: {type: "OAuthPluginVault", referenceId: ...}`, and
`mcpToolDescription.file` pointing to `plugin/tools/mcp-tools.json`.
This is **not** an API plugin runtime manifest: `referenceId`, not `reference_id`,
is correct for this standalone connector format. Tool schemas are preserved.
Missing auth references, Application ID URI or observed tools suppress manifest
generation rather than inventing them. Stale captures remain labeled historical.

Only unfinished app/branding/legal metadata receives explicit placeholders.
Icons are not generated; the required 192x192 color and 32x32 outline PNGs must
be supplied. Name/description caps and the complete package require platform
validation. Overlong short-name/description fields have explicit blockers and
are not silently rewritten. A registration ID exceeding the v1.28 128-character
limit suppresses the manifest, never truncates the reference.
Merge the starter into a WIQD-created project without replacing
its real app ID or unrelated capabilities. WIQD owns project scaffolding,
validation, provisioning, packaging and distribution, with separately reviewed
effects. A connector-only static validation pass is not a consumer auth test.
The template deliberately pins v1.28 with its tool-description file; current
WIQD may generate v1.29. Review the installed version's schema before merging.

Reference: [Microsoft's Cowork plugin package format](https://learn.microsoft.com/en-us/copilot/cowork/cowork-plugin-development).
Do not adopt broader organization restrictions from a sample without review.

## Noninteractive, local-only exports

```json
{
  "schemaVersion": 1,
  "consumer": "fcc",
  "fccConfig": "fcc.json"
}
```

Use `consumer: "plugin"` and optional real `pluginAppId` for the plugin route.

```powershell
copilot-mcp mcp-consumer-plan --workspace-root C:\private\demo --config C:\private\demo\consumer.json --output C:\private\demo\new-handover --json --summary
copilot-mcp mcp-consumer-bundle --workspace-root C:\private\demo --config C:\private\demo\consumer.json --output C:\private\demo\new-handover --approve EXACT_PLAN_TOKEN --json
```

These commands never register anything. Automated callers use the existing
explicit auth phase commands and local export plans instead of bypassing the
interactive approvals. Reports contain nonsecret but private tenant/resource
identifiers and references; review/redact them before a public demo recording.
