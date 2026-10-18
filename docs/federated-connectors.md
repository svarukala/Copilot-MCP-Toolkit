# Custom federated connectors

The FCC module prepares a private, local onboarding JSON draft for Microsoft 365
custom federated connectors. It does not register a connector, deploy a server,
change authentication, or claim Microsoft 365 compatibility.

Without a qualified supported registration API, the product stops at a human
copy-and-paste handoff. Browser automation is not a substitute API or a toolkit
feature. A human performs FCC form entry, consent and rollout in the respective
portals. Authentication registration may be manual or use the separate guarded
auth-config executor; that does not register the FCC itself.

The [shared authentication preparation module](auth-registration.md) now supplies
explicit SSO/custom OAuth registration settings and consumer references. Its
public ATK action data is not execution. Separate Linux-only phase commands now
implement isolated ATK login and registration, with live qualification still
outstanding. They return unverified references for a newly reviewed preparation
bundle. This distinguishes programmable auth configuration from the
still-unqualified direct FCC creation API.

## FCC-only route: no agent project

A custom FCC does not require a WIQD project, declarative agent, plugin package,
or agent provisioning. An existing Entra-secured MCP endpoint already has a
resource app; obtain its actual nonsecret client ID, tenant, scope, Application
ID URI and allowed-client settings from its owner instead of creating another app.

For manual secretless SSO registration, use Teams Developer Portal > Tools >
Microsoft Entra SSO client ID registration. Enter the endpoint, existing resource
client ID and scope, and explicitly review organization/app restrictions. The
documented `Any Teams app` option permits registration without a final Teams app
ID. Its broader app scope needs owner approval; this toolkit does not select it
or claim that a particular restriction has been qualified for FCC.

By default, the reviewed ATK `oauth/register` action requires a real app ID even
for `AnyApp`.
That is a limitation of that execution path, not an FCC requirement. Do not
create a dummy app to satisfy it. The optional WIQD handoff serves a separately
requested app/plugin workflow; it is not the default FCC authentication route.

The separate Linux ATK executor now supports an explicitly selected
tenant-only SSO compatibility option, `allowAnyAppValidationPlaceholder`.
It supplies a disclosed validation-only UUID with `AnyApp` from the start;
the reviewed provider mapping sends no M365 app binding. It creates no app
and does not change restrictions later. This is not supported for `SpecificApp`
or arbitrary caller-supplied placeholder IDs. See the [auth runbook](auth-registration.md)
for the retained identity, review and live-qualification gates.

Copy the portal's actual SSO registration ID and generated Application ID URI,
review the separately approved Entra/APIM audience and allowed-client changes,
then supply the reference to the FCC form. Auth registration, endpoint
configuration, connector creation and consumer verification remain distinct.
Never infer the resource client ID or scope from an MCP URL.

This distinction was rechecked against the official custom FCC setup and Entra
SSO guides on 2026-10-15. No portal mutation or endpoint request was performed.

Start the presentation rehearsal with [the demo runbook](fcc-demo.md), using
`examples/fcc/` for either an existing Entra MCP reference or synthetic REST/APIM
generation. Both routes are covered by the offline packed-consumer test.

## Implementation plan and boundary

1. Local contract, plan, reviewed no-overwrite bundle and offline tests.
2. Synthetic demo inputs and a repeatable offline rehearsal, including fresh
   packed-consumer validation with network and subprocess access denied.
3. Separate live follow-up: select the exact endpoint/tenant and test audience,
   complete SSO registration with the owner, and validate an explicitly approved
   new Microsoft 365 consumer journey.

The first two milestones are implementation work in this repository. The third
requires specific live inputs and separate approvals; general implementation
approval cannot select a tenant, grant consent, deploy to users or reopen proofs.

This is a consumer-specific module, not the final consumer-neutral H1 contract.
It reuses existing descriptors and observed captures and does not add a root
library API. WIQD remains responsible for its app/plugin packaging path.

## Commands and output

- `mcp-fcc-schema --json`: closed schema-1 input contract.
- `mcp-fcc-plan --workspace-root ABS --config FILE --output NEW.json --json
  --summary`: read local inputs, report gaps and the exact approval token.
- `mcp-fcc-bundle` with the same inputs plus `--approve TOKEN`: write the reviewed
  JSON with exclusive publication and readback. The parent directory must exist.

Both plan and bundle require a separate explicit workspace. Source file paths
resolve relative to the configuration file, within that workspace; output paths
resolve relative to the CLI working directory. Symlinks/junctions and existing
destinations are rejected. Inputs and the output are bounded to 1 MiB.

The plan contains the complete output under `bundle`. Exit 0 means a local plan
or write succeeded, **not** connector readiness. Inspect `bundle.readiness` in
the plan and `readiness` in the write result. A blocked draft can be written for
review; its blocking gaps remain intact. There is deliberately no `ready` state:
even with complete inputs the status is `manual-checkpoints-required`.

### Incomplete metadata and legal review

`connector.developer` and its individual fields may be omitted while preparing
a draft. Each absent name/website/privacy/terms field produces a blocking
`DEVELOPER_METADATA_MISSING` gap and a `null`/`missing` copy-and-paste field.
Omission is deliberate; supplied empty, null, malformed or unknown fields still
fail validation. Obtain actual owner-supplied values instead of inventing them
to satisfy the schema. Complete existing inputs remain supported.

Optional `review.legalPolicies` is one of `not-reviewed`, `placeholder`, or
`reviewed`. Omission means `not-reviewed`. These are caller declarations,
exported under `evidence.legalPolicies`, not independent legal verification.
Known placeholders must be declared `placeholder`; they produce the blocking
`LEGAL_POLICIES_PLACEHOLDER` gap even when every URL is supplied. All states,
including `reviewed`, retain the human legal checkpoint and never authorize
submission or make execution ready. The planner stays offline: it neither
fetches URLs nor detects placeholder page contents on its own.

For example, add `"legalPolicies": "placeholder"` inside the existing `review`
object when the owner supplies unfinished policy pages. The blocked draft can
still be written for review. Finalized policies or changed metadata require
a new plan and output; old bundles and approvals are not updated in place.
The stderr summary shows the declaration, discovery expiry when available,
and the remaining human handoff. Zero structural gaps is not legal/runtime approval.

Approval binds the current inputs, descriptor, full capture, installed build,
freshness classification and destination. Changing any invalidates the approval.
Only discovery metadata is exported: no raw results, account/user identity,
discovery plan, approval token, proof history or authentication cache. A hash is
integrity metadata, not a signature or execution authority. Review the full
output privately; nonsecret metadata may still be sensitive.

### Human copy-and-paste handoff

`bundle.manualSetup` in a plan (or `manualSetup` in the saved bundle) contains:

| Section | Contents |
| --- | --- |
| `formFields` | Display name, description, MCP endpoint URL, developer name, website/privacy/terms URLs, authentication method, and the matching registration ID when authentication is required |
| `authenticationRegistration.fields` | For SSO: endpoint, tenant, resource app, delegated scope, endpoint/registration Application ID URIs, consent redirect, token-store client and SSO reference. For OAuth: redirect URI and supplied OAuth reference |
| `authenticationRegistration.steps` | Manual portal/app setup instructions, including prerequisites that cannot be inferred from the descriptor |
| `instructions` | Field use, missing-value handling, legal/audience review, reference-ID distinctions and replan requirements |
| `sharedRegistration` (optional) | Imported auth preparation fields and `provided-unverified`/missing reference status, bound to the exact descriptor and artifact digest |

Each field has `label`, `value` and `status`. `provided` means supplied or derived
from reviewed configuration, **not live verified**. Missing values are `null`
with status `missing`; never paste null or a made-up placeholder into a form.
No Auth requires no registration. UI labels may vary; the observed form used
`None`, `Entra SSO` and `OAuth 2.0`. Review reserved display-name restrictions
and legal notices manually. No audience or consent selection is generated.

When an SSO or OAuth registration reference is already supplied (directly or
through an auth preparation import), both checklists instruct reuse and review
of that reference, not duplicate registration. A reference does not prove
settings/restrictions are correct. Review retained resource-change receipts and
current settings before separately approving missing changes; never repeat
completed mutations or reopen consumed attempts because of generic instructions.

For readable local display after writing a reviewed bundle:

```powershell
$bundle = Get-Content -Raw $output | ConvertFrom-Json
$bundle.manualSetup.formFields | Format-List label, value, status
$bundle.manualSetup.authenticationRegistration.fields | Format-List label, value, status
$bundle.manualSetup.authenticationRegistration.steps | Format-List id, instruction
```

`$output` is the selected private bundle path. Copy the complete field value,
not JSON quoting or formatting. Do not publish this output or treat it as a
Microsoft-uploadable manifest. Existing commands and exact write approvals
apply; no browser, network or portal call is made.

To reuse reviewed auth metadata, set `source.authenticationBundleFile` to a saved
`mcp-auth-registration-bundle` output relative to the FCC config. Existing
explicit references must agree exactly. The toolkit validates the full imported
content and source descriptor, includes the reference in the form fields and
retains the additional registration settings in `manualSetup.sharedRegistration`.
It does not convert an unverified reference into verified settings or readiness.
Selecting another file or changing its metadata requires a new FCC approval.

## Tools and evidence

`source.descriptorFile` points to the existing toolkit `mcp-server.json`.
`source.captureFile`, when available, points to an original toolkit observed
capture. Every captured tool must have exactly one explicit read-only review;
subset export is not remote tool access control. Tools and schemas are retained
without transformation. Missing captures produce no fabricated tools.

Discovery expires after 24 hours. Stale captures remain historical and blocked;
export cannot refresh them. Invalid, future-dated or mismatched captures fail.
Read-only annotations and reviews are declarations, not proof of backend safety.
Explicit destructive or non-read-only annotations produce a blocking gap.

### Native APIM annotations and consumer classification

Read-only review on 2026-10-15 compared retained captures: the public Learn
server supplied `readOnlyHint: true`, `destructiveHint: false` and
`idempotentHint: true` on all three tools, while the controlled native APIM tool
supplied no annotations. The owner's consumer views showed Read only and Write,
respectively. This supports the missing-annotation explanation; it is not an
independent verification of the consumer's exact classification implementation.
MCP defaults an omitted `readOnlyHint` to false. A GET mapping or a description
saying read-only does not itself emit that protocol hint.

`src/apim-renderer.js` generates native `service/apis/tools` resources with
`displayName`, `description` and `operationId`. These match the published
`ToolContractProperties` for the pinned `2025-09-01-preview` API. The current
[ARM tool reference](https://learn.microsoft.com/en-us/azure/templates/microsoft.apimanagement/service/apis/tools)
and [public REST specification](https://github.com/Azure/azure-rest-api-specs/blob/main/specification/apimanagement/resource-manager/Microsoft.ApiManagement/ApiManagement/preview/2025-09-01-preview/openapi.json)
expose no annotation property. No supported native-tool annotation-setting path
was qualified by this review; this is not proof that every APIM mode or an
undocumented/private feature lacks support. Discovery and FCC export preserve
received annotations and do not manufacture them from HTTP methods.

Do not add guessed ARM properties, modify saved captures or rewrite native MCP
response bodies as a shortcut. Microsoft's
[native MCP guidance](https://learn.microsoft.com/en-us/azure/api-management/export-rest-mcp-server)
warns that accessing `context.Response.Body` buffers responses and can disrupt
streaming. Changing SSO permissions cannot supply tool annotations.

Recommended next decision: seek a supported native annotation mechanism from
the APIM product team. If unavailable, an explicitly implemented MCP backend
that emits reviewed annotations, governed by APIM's
[existing-server proxy mode](https://learn.microsoft.com/en-us/azure/api-management/expose-existing-mcp-server),
is an architectural alternative, not a small template patch or an already
qualified toolkit Entra-backend proxy journey. It requires separate protocol,
authorization and deployment review. Preserve the user restriction and old
proofs; verify any approved change through a new discovery and consumer metadata
refresh. No such change, tool execution or fresh endpoint request occurred here.

2026-10-18 follow-up: [Container Apps recipe 1](container-apps-recipe.md) now
generates a bounded SDK-based server with reviewed read-only annotations and
direct Entra-protected hosting files. This is local source/runtime coverage,
not a deployed correction or consumer-label qualification. Container Apps behind
an APIM gateway is explicitly recipe 2 in the [hosting backlog](progress-tracker.md#b2-b5-alternative-mcp-hosting-recipes).
The new recipe does not yet feed this module's descriptor/capture workflow.

Proof and consumer outcomes are not imported or inferred. This module never
reads or modifies the project's locks or proof journal. Consumed/unknown calls
remain consumed even when the bundle or destination changes.

## Authentication and authorization

The module supports `none` only for explicitly reviewed public data, `entra-sso`
only for Entra descriptors, and `oauth` only for OAuth reference descriptors.
It refuses every cross-method mismatch instead of downgrading authentication.
OAuth support is local form/reference preparation only, not discovery or login.

The [public native APIM profile](scenarios.md#public-anonymous-apim) also maps to
`none` / No Auth. It needs no Entra resource app, discovery-client registration
or SSO registration ID. Azure deployment identity is a separate management
requirement. The FCC public-data/tool review, actual capture, legal metadata
and human tenant onboarding still apply. Anonymous access does not add missing
native APIM tool annotations or prove consumer execution.

An SSO registration ID and Application ID URI may be omitted during preparation;
they produce blocking gaps. The module checks the declared registration URI
against the descriptor URI and checks the Enterprise token-store client allowlist.
It cannot establish live token compatibility from metadata.

Complete the current official SSO steps separately: register the exact endpoint
and resource app, preserve existing application URIs, add the registration URI
and Teams consent redirect, preauthorize the token-store client, and review
endpoint audience/scope/client enforcement. Existing apps are not silently
mutated. A differing audience is a review gap, not permission to replace one.

For third-party OAuth, use `authentication: { "type": "oauth" }` initially, then
add `registrationId` with the actual **OAuth client registration ID** returned by
Teams Developer Portal. The owner must obtain the provider client ID,
authorization/token/refresh endpoints and scopes, configure the documented OAuth
redirect URI, and create the portal registration with the appropriate
restrictions and PKCE setting. These provider values cannot be inferred from an
MCP URL. Any required secret is entered directly into the approved portal, never
stored in toolkit JSON, arguments, output or examples. Third-party OAuth is not
claimed to be secretless; Entra SSO is the separate secretless registration path.

Missing OAuth references produce `OAUTH_REGISTRATION_MISSING`. Even with a
reference, OAuth drafts remain blocked by `CAPTURE_MISSING` and
`OAUTH_DISCOVERY_UNSUPPORTED`: the toolkit cannot discover or import OAuth tool
captures. Do not substitute an anonymous capture, fabricate tools or interpret
form preparation as OAuth runtime support. An OAuth reference, SSO reference,
resource app ID and provider client ID are different values.
Registration IDs are opaque: preserve `+`, `/` and trailing `=` padding exactly.
The input bounds them to 200 characters and rejects whitespace, control
characters and embedded padding; do not trim or decode an ID.

After a human obtains or changes a registration reference, update the private
input, review a new plan and write to a new output. IDs are caller-supplied;
their existence, ownership and endpoint compatibility are not verified locally.

Caller Entra authentication does not make shared API-key or managed-identity
backend access user-scoped. Review whether data is public, intentionally shared
with all authorized callers, or subject to actual per-user backend permissions.
User-scoped access remains a manual verification checkpoint.

## Reference assessment

Reviewed the public
[madsd/m365-custom-connector reference](https://github.com/madsd/m365-custom-connector/tree/bdb48ed478b293108f93f6aa2c2c82b7ccb30171)
for the PubMed search/fetch flow, Entra SSO and tenant onboarding. It supplies its
own Python MCP server and Container Apps deployment, rather than APIM generation.
No source code or deployment templates were copied into this toolkit.

Its retrieval-oriented design is useful for a presentation. Do not treat its
tool names or response shape as a universal Microsoft-required schema. Do not
copy its temporary unauthenticated deployment, optional direct API-key settings,
or broad host/origin settings into the toolkit's guarded flow. Deployment and
provider behavior in that repository were not verified here.

Official references:

- [Custom connector setup](https://learn.microsoft.com/en-us/microsoft-365/copilot/connectors/set-up-custom-federated-connectors)
- [Entra SSO](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-entra-sso)
- [Federated overview](https://learn.microsoft.com/en-us/microsoft-365/copilot/connectors/federated-connectors-overview)

The custom setup guide requires read-only tools. Broader federated-connector
write-action rollout does not expand this module's scope. The documented admin
UI flow is a manual checkpoint; no supported registration API has been qualified.
