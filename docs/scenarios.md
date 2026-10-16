# Supported scenario matrix

| Scenario | Inbound | Backend | Supported boundary |
| --- | --- | --- | --- |
| Native APIM from REST | Explicit Entra tenant, resource, scope and client allowlist | Anonymous | OpenAPI 3.0.x JSON and explicit operation IDs |
| Native APIM from REST | Same | API key | Versionless Key Vault reference; APIM system identity; dedicated header OR query parameter |
| Native APIM from REST | Same | Entra delegated | Same-token passthrough; backend must accept that resource/audience and authorize the user |
| Native APIM from REST | Same | Managed identity | Existing APIM system principal, separate backend application and exact existing application-role assignment |
| Public native APIM from REST | Explicit anonymous public-data/read-only declarations and aggregate rate limits | Anonymous only | Literal fixed GET paths, no parameters, request body, security, callbacks, alternate APIM paths or backend mappings; new owned APIs only |
| Upstream MCP key proxy v2 | Same | API key | Explicit HTTPS base/message endpoint mapping; provider compatibility is not guaranteed |
| Experimental proxy v3 | Same | Header key only | `owned-backend-routing-v1`; existing APIM/group/vault and secret-scoped grant, new owned backend, canonical `/mcp/` |
| Existing MCP reference | Anonymous or explicit Entra | Provider-owned | Descriptor/reference only; separately approved observed tools/list and eligible single-call proof |
| Existing MCP OAuth reference | OAuth marker | Provider-owned | Descriptor and local FCC form/reference draft only; no integrated provider login, exchange, discovery, import packaging or runtime proof |
| Custom federated connector onboarding | Matching Entra SSO, anonymous public-data declaration or OAuth reference | Existing toolkit descriptor | Local human copy/paste form/auth fields; OAuth reference drafts stay blocked with discovery/import unsupported; not tenant registration or consumer verification |
| Shared authentication registration preparation | Matching Entra or OAuth descriptor | Resource/provider-owned | Local explicit SSO/OAuth settings, PKCE or versioned Key Vault reference, and FCC/plugin metadata; no provider execution or secret resolution |
| Shared authentication registration execution | Explicit M365 tenant/account plus matching descriptor | Public ATK CLI 1.1.17 | Separate Linux tmpfs initialize/login/register/close approvals; SSO, PKCE or private versioned Key Vault secret; created-unverified receipts and no replay; real Linux/provider qualification outstanding, Windows/macOS refused |

Anonymous **backend** does not automatically make generated inbound anonymous.
Entra remains the guided default; public access is a separate explicit choice.
Keys are never
manifest/config values: APIM reads Key Vault through managed identity. Operator
secret-write rights and service secret-read rights are separate. No shared-service
identity PATCH, user-assigned identity, default-role fallback, app-role assignment
mutation, OBO, backend client-secret flow or automatic consent is implemented.
The separate auth-config executor registers confidential OAuth metadata; it does
not add a backend token-exchange flow or OAuth MCP discovery/proof.

## Public anonymous APIM

`examples/mcp/public-rates.json` is a synthetic native REST example. Set inbound
to `{"type":"anonymous","publicData":true,"readOnly":true,"rateLimit":{"calls":60,"renewalPeriod":60}}`
only after reviewing the selected GETs as intentionally public and side-effect-free.
The backend must be anonymous and its URL a root HTTPS origin. Existing anonymous
MCP references still use the separate, unchanged `{"type":"anonymous"}` shape.
API-key proxies, private backends and generic REST operations cannot opt in.

Both the MCP endpoint and backing REST routes become publicly callable without
a bearer token or APIM subscription key. Each API has a separate aggregate
rate-limit bucket shared by all callers at that gateway/region: 1-10000 calls per
1-300 seconds. Counters do not aggregate across gateways/regions and are approximate,
not a spending ceiling, availability promise or DDoS defense. Obtain a separate
Azure cost/traffic review. See [APIM rate limits](https://learn.microsoft.com/en-us/azure/api-management/rate-limit-by-key-policy).

The backing REST policy rejects non-GET requests, query parameters and request
bodies without reading/buffering them. Both policies remove Authorization, Cookie, Proxy-Authorization and common
API/subscription-key headers; this is not a claim to scrub every possible custom
header. Public data and read-only declarations are owner review, not verification
of upstream behavior. MCP POST transport is not restricted to GET.

Shared global policies, diagnostics checks, deny-only staging, ownership and
readback gates remain intact. Custom inherited authentication blocks shared-service
reuse; it is never removed. A new dedicated service retains its global deny
baseline and opens only the reviewed owned API policies. Public receipts have a
distinct authentication-target binding: do not convert a protected project,
overwrite its artifacts or reuse its receipt. Generate a new uniquely owned project.

Azure deployment still requires explicit tenant/subscription/account selection
and separate approvals. No Entra resource app, caller allowlist, discovery client
or SSO registration is needed for public MCP access. Discovery uses `{}`; eligible
unannotated fixed-GET proof retains private Azure mapping readback and single-call
consumption. FCC uses No Auth with its own public-data/tool review and human
registration gates. Native APIM annotations are not fabricated.

This profile is offline verified, not live qualified. No public APIM/FCC/Copilot
end-to-end outcome or recording is implied.

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
No live federation, arbitrary provider credential testing, custom evaluator language,
archive migration, network diagnosis probes or Copilot host UI troubleshooting is
included.

The separate FCC module now supports local onboarding preparation, not runtime
federation. It does not change the proof boundaries above. Read
[FCC onboarding](federated-connectors.md) before interpreting a written draft
as a usable Microsoft 365 connector.
