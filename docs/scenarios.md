# Supported scenario matrix

| Scenario | Inbound | Backend | Supported boundary |
| --- | --- | --- | --- |
| Native APIM from REST | Explicit Entra tenant, resource, scope and client allowlist | Anonymous | OpenAPI 3.0.x JSON and explicit operation IDs |
| Native APIM from REST | Same | API key | Versionless Key Vault reference; APIM system identity; dedicated header OR query parameter |
| Native APIM from REST | Same | Entra delegated | Same-token passthrough; backend must accept that resource/audience and authorize the user |
| Native APIM from REST | Same | Managed identity | Existing APIM system principal, separate backend application and exact existing application-role assignment |
| Upstream MCP key proxy v2 | Same | API key | Explicit HTTPS base/message endpoint mapping; provider compatibility is not guaranteed |
| Experimental proxy v3 | Same | Header key only | `owned-backend-routing-v1`; existing APIM/group/vault and secret-scoped grant, new owned backend, canonical `/mcp/` |
| Existing MCP reference | Anonymous or explicit Entra | Provider-owned | Descriptor/reference only; separately approved observed tools/list and eligible single-call proof |
| Existing MCP OAuth reference | OAuth marker | Provider-owned | Descriptor only; no integrated provider login, exchange, discovery, import packaging or runtime proof |

Anonymous **backend** does not make generated inbound anonymous. Keys are never
manifest/config values: APIM reads Key Vault through managed identity. Operator
secret-write rights and service secret-read rights are separate. No shared-service
identity PATCH, user-assigned identity, default-role fallback, app-role assignment
mutation, OBO, client-secret flow or automatic consent is implemented.

## REST is not a universal schema compiler

Import accepts OpenAPI **3.0.x JSON** only. Convert YAML, Swagger 2 and OpenAPI 3.1
outside the toolkit first. Bundle external references locally; only `#/...`
references are admitted. Every recognized operation needs a unique safe operation
ID. Only explicitly selected operations are exposed. Recognized HTTP methods do
not imply those operations qualify for read-only runtime proof.

`rest-tools-*` authors a narrower GET/query subset: literal backend paths, fixed
query values, inline string/integer scalar arguments and documented constraints.
It supports bounded defaults/enums/ranges and a deliberately small anchored ASCII
pattern/literal-choice language. It is not general JSON Schema or regex translation.
`x-cowork-backend` remains the historical mapping annotation; its spelling has
contract significance and does not require Cowork.

Executable native proof is narrower still: fixed anonymous GET with empty
arguments; constrained mapped query-key GET with required scalar arguments; a
controlled same-resource delegated fixture; or the fixed Graph organization
system-MI profile. Arbitrary writes, request bodies, dynamic routes, header-key
native proof, optional/defaulted mapped arguments and generic permission attestation
are unsupported. The fixture command produces a reviewed local bundle; owner setup
is manual and separately authorized.

## Evidence is layered

Protocol success is not business correctness. Graph organization checks one expected
organization ID, not token claims. Tavily's closed result profile checks a single
HTTPS `learn.microsoft.com` result with bounded nonempty title/content and exact
approved arguments, not factual accuracy or ranking.

Tavily first-call acceptance is opt-in on a **future unused ordinary proof** only.
Dedicated additional qualification remains a separate singleton with exact prior
proof constraints. It cannot follow a consumed first-call profile to obtain an
extra replay. Failed/inconclusive/unknown post-dispatch outcomes consume purpose.
Independent invalid-key initialization findings may remain inconclusive even when
the scoped result profile passes. Caller/backend rejection and consumer acceptance
must never be inferred from another layer.

V2 proxy mapping uses an APIM preview endpoint shape with known provider
compatibility limits. V3 is explicitly experimental, not an automatic fallback.
No federation, arbitrary provider credential testing, custom evaluator language,
archive migration, network diagnosis probes or Copilot host UI troubleshooting is
included.
