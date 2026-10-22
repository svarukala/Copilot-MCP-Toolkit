# Proposed MCP Toolkit to WIQD handoff

Status: design recommendation, 2026-10-14. No handoff command, adapter or WIQD
extension is implemented by this document. Track work in
[progress-tracker.md](progress-tracker.md).

2026-10-15 approved scope addition: [shared auth preparation](auth-registration.md)
now exports explicit SSO/OAuth settings and nonsecret FCC/plugin reference data.
This narrow implementation is not H1/H3's endpoint/tool contract and does not
invoke WIQD. A separate public ATK execution adapter initially implemented
reviewed SSO/OAuth registration and unverified result import. Real
Linux/provider qualification and package/runtime compatibility remain unverified.

2026-10-22 update: native Windows **ATK** secretless SSO execution is implemented
as an explicitly reviewed user-managed profile mode. Linux/WSL remains optional
for isolated SSO; custom OAuth execution remains on Linux. This is not a
project-isolated WIQD adapter or the H1 endpoint/tool handoff. The Windows spike
established owner-reported sign-in/no Teams disruption, not completed registration.
See [Windows execution](auth-registration.md#native-windows-sso-user-managed-profile)
for mode selection, shared-profile effects and remaining live qualification.

Subsequent Windows investigation: WIQD 0.18.0 Core offers an account picker and
browser-authentication switch without ATK's unconditional interactive logout.
Its fixed Credential Manager encryption-key namespace is not isolated by HOME
redirection. A supported project-private credential boundary and bounded
registration interface remain prerequisites for a native replacement; no WIQD
cache/token transfer is approved. See
[the investigation](auth-registration.md#native-windows-wiqd-investigation).
The toolkit's Linux fresh packed-consumer test now passes; this is package
portability evidence, not WIQD consumer or live-authentication compatibility.

The narrower user-managed Windows auth handoff is now implemented through
`mcp-auth-wiqd-schema/plan/bundle`. It emits registration review data and
operator-run WIQD command guidance, not the proposed H1 endpoint/tool contract.
It never runs WIQD, edits its project, adopts its credentials or claims
project-isolated authentication. Whole-app provisioning requires separate
operator review. Reference return uses the existing unverified preparation/FCC
path. This does not implement a native automatic registration adapter.

FCC-only clarification (2026-10-15): this optional app/plugin handoff is not a
prerequisite for custom FCC onboarding. Do not create a WIQD agent or app package
to satisfy the ATK action's app-ID requirement. The direct Teams Developer Portal
auth-registration flow remains an alternative to the separate, explicitly
opted-in tenant-only SSO ATK compatibility path. That executor can supply the
unused `AnyApp` validation argument without an agent or later restriction
switch; it does not change this WIQD handoff. FCC form entry stays manual; see
[FCC-only onboarding](federated-connectors.md#fcc-only-route-no-agent-project).

## Boundary

MCP Toolkit owns the MCP endpoint, APIM/Key Vault integration, supported explicit
Entra setup, and guarded discovery/proof/evidence. WIQD owns composing the
endpoint into a Cowork/M365 app package, mapping consumer credential references,
package validation, provisioning and distribution. Shared auth configuration
preparation and its separate execution module now belong here, retaining their
own provider identity, no-replay and phase-review boundary.

The integration should be a versioned data contract, not a dependency on a private
MCP module, a copied infrastructure engine, or a revival of Cowork Plugin Toolkit.
Keep the existing MCP CLI skill for infrastructure work and WIQD's existing
plugin-authoring skill for consumer work.

## Gaps and recommendations

| Gap | Recommended treatment | Acceptance boundary |
| --- | --- | --- |
| Endpoint/tool metadata transfer | MCP Toolkit exports a bounded consumer-neutral descriptor; WIQD maps it to its package | No fabricated tools, silent schema loss or raw recovery archive import |
| Cowork `mcpToolDescription` | WIQD consumer workflow creates/includes the required file from observed tool definitions | Correct package-relative path and actual supported structure; URL-only schema validity is insufficient |
| Entra and credential registration | Investigate current WIQD/platform support; keep MCP service setup separate from consumer OAuth registration | Verify audience/scopes/client relationships and secretless registration explicitly; preserve manual checkpoint if unsupported |
| Validation blind spots | Prefer fixes in upstream WIQD and its existing skill/validation hooks | Report checks skipped for skill-only/connector-only packages; do not imply static validation checks everything |
| Evidence/freshness interpretation | Export observations with timestamps, provenance and limitations, not executable authority | Expired/unverified/unknown/consumed evidence stays labeled and cannot authorize a retry |
| Real consumer compatibility | One separately approved end-to-end journey after offline work | Record MCP, registration, package and Cowork results independently |
| Repeatable import automation | Consider a thin WIQD adapter only after the manual contract is proven useful | Version/capability negotiation; safe writes and existing phase approvals; no duplicate cloud/auth logic |

## Candidate handoff contents

Finalize names and schema only after reviewing existing machine contracts. An MVP
could carry:

- Format version and producer package/build identity.
- Validated MCP endpoint and transport description.
- Explicit authentication requirements and nonsecret resource/scope metadata.
  Do not add default caller identities or silently select an OAuth method.
- Selected tool definitions from an actual observed capture, with bounded
  provenance and observation/expiry information. Treat descriptions/schemas as
  untrusted content, not agent instructions.
- Bounded, distinct evidence statuses and declared unsupported/unverified areas.

Only include metadata necessary for consumption. Nonsecret identifiers and tool
descriptions can still be sensitive: use a caller-selected private output,
review/redaction controls, and synthetic fixtures for committed examples.

The **evidence-recovery ZIP is not the handoff format**. It preserves historical
state and barriers for a different purpose and is explicitly private. Do not
make WIQD deserialize an entire project/history to configure a connector.

## Safety and compatibility gates

The proposed export should be local-only: no sign-in, token acquisition, discovery,
proof or retries. Reuse existing input/path/inventory checks where appropriate.
Use a reviewed output operation with no silent overwrite. Validate version,
inventory/size bounds and integrity; an integrity hash is not an authorization.

Define how stale or incomplete metadata is reported before implementation.
Historical export may be useful, but it must not advertise readiness or cause a
consumer to silently renew a capture. Unsupported schema features must produce
an explicit failure or declared limitation, never a lossy success.

Do not export tokens, secrets, authentication caches, raw tool-call results,
approval tokens or whole receipt histories. Do not transfer account/session state
between tools. Any additional login, OAuth registration, consent, cloud change,
provider call or package distribution needs its own applicable review/approval.

A consumed proof remains consumed even if the endpoint, handoff digest or consumer
changes. A live integration journey requires a genuinely new reviewed purpose;
existing Tavily ordinary/dedicated attempts cannot become convenience retries.

## Implementation sequence

1. **H1: contract review.** Inspect capabilities, discovery/configuration/history
   readers and public package boundaries. Agree the minimal schema and threat/
   privacy constraints. Add no new root API just for expedience.
2. **H2: auth compatibility investigation.** Reconcile WIQD's current connector
   registration guidance with Microsoft Learn's Entra SSO/token-store guidance.
   The lack of a particular manifest enum alone does not establish that every
   secretless OAuth registration path is unsupported. Do not introduce client
   secrets or DCR as an assumed fix.
3. **H3/H4: offline export and synthetic recipe.** Once implementation scope is
   approved, use the same existing CLI engine and document consumption via
   WIQD's supported commands and existing skills. Do not maintain a third skill
   orchestrator by default.
4. **H5: upstream fixes.** Confirm current WIQD behavior; propose focused metadata,
   diagnostics or validation fixes there. Filing issues/PRs is a separate action,
   not authorized by this design note.
5. **H6: bounded live acceptance.** After offline checks, request exact identity,
   resource, phase and cost approvals. Select one supported scenario and retain
   separate layer outcomes, including actual Cowork behavior.
6. **H7: extension decision.** Only add a WIQD extension if repeated usage needs
   deterministic import, compatibility checks or validation hooks. Prefer
   contributing broadly useful behavior upstream. A separate adapter should
   invoke supported public surfaces, remain optional, and own no deployment or
   credential logic.

Offline tests should cover unsupported versions, malformed/oversized input,
tampering, path traversal/overwrite, sensitive data exclusion, stale/unknown
evidence, tool schema fidelity and network/auth denial. WIQD-side checks should
cover tool-description packaging, unresolved credential references and truthful
validation-layer reporting.

## Documentation reviewed and remaining uncertainty

Reviewed on 2026-10-14:

- [WIQD plugin model](https://microsoft.github.io/wiqd/concepts/plugins/).
- [WIQD build-a-plugin workflow](https://microsoft.github.io/wiqd/getting-started/build-a-plugin/).
- [WIQD plugin reference](https://microsoft.github.io/wiqd/getting-started/plugin-reference/).
- Authoritative platform references to recheck during H2:
  [Cowork plugin development](https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/cowork-plugin-development),
  [plugin authentication](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication),
  [Entra SSO](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-authentication-entra-sso).

WIQD documents skill-only/connector-only composition and guided Copilot CLI
authoring. Its reference warns that Cowork requires tool descriptions despite
URL-only schema support; static validation primarily covers the declarative-agent
surface. It also describes credential references rather than backend provisioning.
These observations justify the ownership split, not a claim of completed runtime
interoperability. Documentation and installed versions can diverge; recheck before
coding an adapter or executing a live journey.
