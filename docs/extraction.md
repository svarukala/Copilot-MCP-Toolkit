# Independent extraction and compatibility

Origin: `svarukala/Cowork-Plugin-Toolkit`, exact revision
`cca98401d9433c28b4c01fec2f90bba8fb21bec4`.
`source-provenance.json` records original tracked-file hashes. It is attribution,
not an authorization, current build digest or migration writer. The source
repository is not changed or required by this package.

| Area | Destination implementation |
| --- | --- |
| Compiler | `mcp-server`, APIM renderer/safety/managed-identity, REST authoring/compatibility, tool-schema primitives |
| Lifecycle | Private `azure-identity`, guarded Azure runner, resources/app setup/prerequisites/reconciliation |
| Runtime observation | MCP protocol/network/authentication, discovery, native/mapped proof, fixed Graph/Tavily assertions and rejection |
| Retained evidence | Failure/history/configuration readers, status/resume, archive/recovery and local diagnosis |
| Entry points | New `copilot-mcp` dispatcher, guided review, bounded core/types, independent capabilities/asset identity |
| Copilot CLI | New installable guidance skill using the same CLI, not an embedded authoring product |

The measured unpruned standalone dependency closure contained 46 source modules.
Extraction removed the compiler's consumer re-export, plugin configuration schema,
plugin ZIP/skill validation, consumer metadata builders and standalone-workflow
product dependencies. `deployment-diagnostic.js` contains only the closed
diagnostic normalizer formerly mixed into workflow state. Entra metadata/discovery
retain only shared authentication primitives. Azure retains standalone app
**verification**, not token-store app creation/merge or consumer registration.
Separate MCP app-setup phases remain supported. The later user-approved
[auth-registration module](auth-registration.md) adds local shared SSO/OAuth
preparation and consumer references, not token-store execution or a dependency
on the original workflow.

The known first-party service-client UUID remains a **discovery denylist**
constant and is also displayed as explicit token-store setup guidance by the
FCC/auth-registration handoffs. It is never a default operator discovery client,
silently added inbound client, or automatically selected registration target.
All standalone inbound/resource identities are explicit; plugin-shaped configs
cannot select a legacy fallback. YAML/skill-authoring runtime and Teams schema
assets are absent. No original recovery archives, projects, auth caches, captures,
private notes, generated artifacts or dependency directories were copied.

## Compatibility is not cosmetic rebranding

Native definition/descriptor version 1, historical/current proxy versions,
MCP protocols, closed assertion semantics, approval/freshness/identity guards and
immutable history contracts are retained. In particular:

- `mcp-*` resource IDs, `cowork-toolkit-project` ownership tag,
  `cowork-mcp-intent:` application intent tags, `cowork-*` deployment names and
  `x-cowork-backend` mapping annotation retain exact historical meaning.
- Serialized `coworkRuntimeVerified: false` and existing limitation strings remain
  non-authorizing compatibility fields where they participate in evidence hashes.
  Their presence is not a consumer dependency or a promise of consumer integration.
- Ordinary proof version 2, dedicated qualification version 3 and opted-in
  first-call version 4 preserve their distinct no-replay purposes.
- Canonical archive inspection recognizes the original and independent package
  names under the same strict archive format. Runtime implementation hashes and
  independent archive SHA256 are still checked. Nothing rewrites old identity,
  root, session, epoch or evidence timestamps to claim current readiness.

The new package/bin names and `McpToolkitError` are intentional destination API
changes. Its asset/build inventory covers the full independent package, not the
origin's library-only inventory. Source root `core.js`, bin, capabilities and
declarations were selected/refactored, not published wholesale. Synthetic tests
for removed plugin-only behavior are excluded; standalone safety tests and new
public-package tests cover the retained surfaces.
Human account-command hints use `mcp-account-*`; new app-state guidance does not
require consumer registration. These destination-only text changes may alter
new plan/state digests; they do not rewrite or authorize original evidence.

## Build order and maintenance

Compiler/path/security primitives precede identity/lifecycle, then observation/
history, journey/recovery/diagnosis, then CLI/types/guidance and packed validation.
Changes to the originating repository will not automatically flow here. Review
future cherry-picked fixes explicitly, including contract/version compatibility.
Do not replace this independence with a source-path dependency or shared-package
migration without a separately reviewed decision.
