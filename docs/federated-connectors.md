# Custom federated connectors

The FCC module prepares a private, local onboarding JSON draft for Microsoft 365
custom federated connectors. It does not register a connector, deploy a server,
change authentication, or claim Microsoft 365 compatibility.

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

Approval binds the current inputs, descriptor, full capture, installed build,
freshness classification and destination. Changing any invalidates the approval.
Only discovery metadata is exported: no raw results, account/user identity,
discovery plan, approval token, proof history or authentication cache. A hash is
integrity metadata, not a signature or execution authority. Review the full
output privately; nonsecret metadata may still be sensitive.

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

Proof and consumer outcomes are not imported or inferred. This module never
reads or modifies the project's locks or proof journal. Consumed/unknown calls
remain consumed even when the bundle or destination changes.

## Authentication and authorization

The MVP supports `none` only for explicitly reviewed public data, and `entra-sso`
only for Entra descriptors. It refuses mismatched authentication and OAuth
reference descriptors instead of downgrading them.

An SSO registration ID and Application ID URI may be omitted during preparation;
they produce blocking gaps. The module checks the declared registration URI
against the descriptor URI and checks the Enterprise token-store client allowlist.
It cannot establish live token compatibility from metadata.

Complete the current official SSO steps separately: register the exact endpoint
and resource app, preserve existing application URIs, add the registration URI
and Teams consent redirect, preauthorize the token-store client, and review
endpoint audience/scope/client enforcement. Existing apps are not silently
mutated. A differing audience is a review gap, not permission to replace one.

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
