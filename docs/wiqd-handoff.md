# Proposed MCP Toolkit to WIQD handoff

Status: design recommendation, 2026-10-14. No handoff command, adapter or WIQD
extension is implemented by this document. Track work in
[progress-tracker.md](progress-tracker.md).

2026-11-17: H1 now has a [version-1 local design](consumer-handoff.md), internal
validator and synthetic contract fixtures. It has no export command, WIQD
adapter or public root API. Provenance stays unattested and freshness cannot
authorize execution. The H2 public-contract review below identifies a documented
secretless SSO route, not verified interoperability. H3 export and H6 real
consumer acceptance remain incomplete; synthetic checks do not qualify them.

## H2 public-contract review (2026-11-17)

**Result: documented compatibility is feasible; runtime compatibility remains
unverified.** Microsoft Learn now explicitly describes WIQD Entra SSO authoring
and mapping an SSO auth configuration to a Cowork remote MCP connector. The
absence of a `microsoftEntra` connector enum is not evidence that a client secret
is required. This review read public documentation and local source only. It
did not invoke WIQD, inspect credentials, obtain tokens, register anything,
upload a package or call a consumer.

| Boundary | Public contract | Toolkit mapping and remaining gate |
| --- | --- | --- |
| Entra SSO registration | An existing Entra resource application's client ID selects the SSO auth configuration. Registration returns an auth config ID and Application ID URI; resource setup must still be completed. | `mcp-auth-registration` already distinguishes resource client ID, registration ID, endpoint URI and returned registration URI. `mcp-auth-wiqd` is human-only guidance, not an executing adapter. Reuse an existing reference; never recreate a consumed registration to fill settings. |
| Declarative-agent MCP action | Learn documents `wiqd agent add action` with `--mcp-auth-type entra-sso` and `--mcp-client-id`, or `agent add auth` for an existing plugin. API-plugin runtime auth uses `OAuthPluginVault` and `reference_id`. | This establishes a documented secretless authoring route, not installed CLI behavior or bounded provisioning. Review the selected WIQD version and full project effects before any separately approved invocation. |
| Cowork standalone connector | Learn's LOB walkthrough maps the SSO auth config ID to `remoteMcpServer.authorization.referenceId`; WIQD's connector reference uses `OAuthPluginVault`. | Keep root `agentConnectors` fields separate from API-plugin runtime fields. The same vault enum can refer to SSO or custom OAuth: inspect the registration's actual mode, not the enum alone. No automatic adapter or format migration is implemented. |
| Resource and caller configuration | Retain existing `identifierUris`, add the returned URI, configure the consent redirect and preauthorize the Enterprise token-store client for the exact delegated permission. | Separately review the public token-store client `ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b` in the endpoint's explicit allowed-client set. A toolkit discovery-client success does not prove this caller is allowed. No automatic expansion of caller, tenant or app restrictions. |
| Token audience and scope | Entra's claims reference says v2 `aud` is the resource API client ID; v1 can use the resource URI. The SSO page also requires reviewing the returned URI as an API audience. | Direct ACA's `createTokenVerifier` deliberately requires v2, the resource GUID audience, tenant issuer, `azp` allowlist and short `scp`. Keep those checks. Use the actual registered URI when configuring the fully qualified requested scope; do not replace the GUID audience with a URI, accept v1 automatically or broaden audiences to reconcile documentation. The resource must issue v2 tokens; actual consumer issuance remains unverified. |
| Post-registration checkpoint | Scope, organization/app restrictions, resource registration, redirect, preauthorization and endpoint validation all matter after creation. | Version-3 `settingsReview` binds reference/URI/scope/endpoint/resource/tenant/app restrictions. Its operator attestation does **not** attest redirect URIs, Entra preauthorization, token version, endpoint caller configuration, consent or successful sign-in. These remain separate gates, not inferred completed settings. |
| Backend credentials | Cowork does not currently accept API-key connector auth; Learn documents Entra callers with an adapter holding the separate backend key. | The recommended direct-ACA path fits this separation: caller SSO, backend Key Vault reference. A shared backend key does not provide per-user data filtering. Do not present the key as a consumer credential or imply the golden path implements OBO. |
| DCR | WIQD documents no Entra RFC 7591 registration endpoint. Omitting connector authorization for a DCR server is not Entra SSO configuration. | Do not use DCR, anonymous fallback or a new client secret as a workaround for an SSO settings mismatch. |
| Tool descriptions and package version | WIQD documents numbered manifest 1.29 with optional tool-description schema fields, while Cowork still requires a tool-description file for verification. The existing toolkit starter is pinned to 1.28. | Preserve observed tools and include the referenced file; do not treat URL-only schema validity as acceptance. No silent upgrade of historical starters or conflation with API-plugin dynamic tool discovery. |
| Validation and offline packaging | WIQD source validation is offline but incomplete for connector/package contents. Default/package validation uploads a ZIP. New `plugin package --offline` is documented for a bounded DevPreview connector/skill-only subset. | Do not run package validation as an offline check. Offline packaging is a candidate for a separately scoped adapter, not proof it accepts the toolkit's numbered starter or that Cowork accepts the package. Existing `ConnectionVault` references are a distinct DevPreview path, not automatic SSO registration. |

### Recommended next implementation boundary

H3 should remain a local exporter, after consumer agreement on H1: read a bound
capture and descriptor, preserve their exact provenance/freshness and write a
new private bounded artifact. Keep consumer-specific auth config IDs and
returned registration settings in separately reviewed mapping inputs rather
than inserting credentials, registration authority or provider assumptions into
the consumer-neutral v1 contract.

An eventual WIQD mapping must distinguish declared endpoint requirements from
the actual consumer registration, report unresolved URI/scope/client/app
relationships explicitly, and never repair them by silently changing deployment
configuration. Two registered identifier URIs are not inherently incompatible;
their presence and scope relationship need resource-owner verification. The
current local settings attestation cannot supply that provider verification.

Before calling H2 operationally qualified, obtain agreement on the intended
consumer surface and pinned WIQD capability, then separately review resource
settings, auth configuration restrictions and consumer app identity. H6 needs a
fresh approved end-to-end attempt with independent registration, package and
consumer outcomes. No historical proof, publication or login authorization is
renewed by this review. A new exporter, adapter, credential workflow or live
journey was not implemented here.

### Sources and confidence

Public documentation retrieved on 2026-11-17:

- [Microsoft: Configure Microsoft Entra SSO authentication](https://learn.microsoft.com/plugins/plugin-authentication-entra-sso).
- [Microsoft: Build a Copilot Cowork plugin for a line-of-business API](https://learn.microsoft.com/copilot/cowork/cowork-connect-lob-api).
- [Microsoft: Access token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference).
- [Microsoft: Set up custom federated connectors](https://learn.microsoft.com/microsoft-365/copilot/connectors/set-up-custom-federated-connectors).
- [WIQD plugin reference](https://microsoft.github.io/wiqd/getting-started/plugin-reference/).
- [WIQD plugin concepts and offline packaging](https://microsoft.github.io/wiqd/concepts/plugins/).

Local implementation comparison: `src/mcp-auth-registration.js`,
`src/mcp-sso-settings.js`, `src/mcp-auth-wiqd.js` and
`src/recipes/container-apps/runtime.js`. Documentation is contract evidence,
not observed provider behavior. The installed WIQD version and package
acceptance were not tested; the existing historical `guidanceVersion: 0.18.0`
was not rewritten from newer documentation.

## Earlier milestones

Annotation follow-up (#7/#8): observed proxy tool annotations, including explicit
false values and absence, are retained in FCC and plugin metadata under offline
regression coverage. Native APIM's reviewed public contract still has no
annotation setter. Do not infer hints from GET, rewrite historical tool files,
or advertise WIQD/consumer read-only classification as verified. Actual gateway
fidelity and consumer behavior remain separate qualification gates; this adds
no automated WIQD handoff.

Post-registration settings update (#6): the narrow shared-auth preparation now
includes a mandatory review checkpoint with exact portal scope and app-binding
expectations. Separate operator attestation can record completion, but no
provider update/readback, automatic WIQD adapter or consumer readiness is added.
The manual WIQD handoff surfaces pending/attested settings as remaining gates.
This does not close H1/H3 or qualify the historical consumer packages.

2026-11-10 consolidation: the tracker now preserves historical WeatherAPI
standalone v1.29 WIQD package/provisioning and earlier v1.28 starter reports.
They do not resolve the registration URI/resource or token-store allowed-client
gaps and do not establish consumer acceptance. The retained Windows spike's
narrow registration/cleanup report is separate from mainline qualification.
Mainline adds separately approved existing-sign-in verification and a
post-registration identity check within its existing `windows-user-managed`
contract; it does not adopt the spike's alternate session format or transfer
credentials. H1/H3 and the broader WIQD compatibility gates remain open.

2026-10-28 update: [consumer onboarding](consumer-onboarding.md) now provides
a narrow standalone v1.28 agentConnector starter, observed tool-description
file and HTML guide after shared guarded SSO registration/reuse. This is not a
WIQD project, full H1 contract, package, publication or qualified consumer.
WIQD still owns project composition and its downstream lifecycle.

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
