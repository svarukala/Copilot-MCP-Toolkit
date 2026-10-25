# Recipe 1: an MCP server on Azure Container Apps

**Status: local source generation; not live-qualified.** This recipe produces a
small Node.js MCP server and Azure deployment files. It does not deploy them.
APIM is not required. A separate [APIM gateway recipe](apim-gateway-recipe.md)
is also available for local generation and release review.

The server, not APIM, owns the tool definitions and read-only annotations.
Changing the hosting service alone does not prove a tool is read-only or that
Copilot will display it correctly.

## What the first version supports

| Area | Supported scope |
| --- | --- |
| Caller sign-in | Microsoft Entra v2 **delegated user** access tokens; exact tenant, resource audience, permission scope and client application allowlist |
| Source data | One explicitly reviewed HTTPS JSON backend, anonymous or using a dedicated header/query API key from Key Vault |
| Tools | Up to 30 selected OpenAPI 3.0.x fixed GETs, with no arguments, authored query strings, bodies, callbacks, alternate servers or custom mappings |
| Read-only labels | Every selected operation must be explicitly reviewed as side-effect-free; tools emit `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true` and `openWorldHint: true` |
| Hosting | A new app in an **existing** resource group and Container Apps environment; an existing Azure Container Registry and user-assigned image-pull identity |
| Deployment | ARM files for human review; no automatic build, registry push, Azure login or deployment |

Public caller access, delegated backend access, managed-identity
backend calls, username/password, dynamic query arguments and writes are not in
this first version. Caller tokens and headers are **never forwarded** to the
backend. The image-pull identity is not a backend data-access identity.
API-key mode requires an additional, distinct Key Vault reference identity.

All allowed callers share access to the selected data and, in API-key mode, the
backend service entitlement. This version does not provide per-user filtering.
See [API-key configuration, local launch and rotation](hosting-recipes.md#api-key-backends)
and `examples/mcp/container-apps-direct-api-key.json`. The host injects the
resolved secret through `MCP_BACKEND_API_KEY`; no secret value is generated.

## 1. Prepare the input

From the toolkit checkout, inspect the separate schema:

```powershell
node .\bin\copilot-mcp.js mcp-container-apps-schema --json
```

Use `examples\mcp\container-apps-direct.json` as a **fictional format example**.
Copy it into your private workspace and replace its sample values with your
reviewed settings. Never deploy or call the synthetic example.

For Entra, use an existing resource app configured to issue v2 access tokens,
with the selected delegated scope exposed. `authentication.audience` is that
resource app's client ID, not its Application ID URI or a consumer registration
ID. `applicationIdUri` is the separately configured Application ID URI; it is
used to advertise the full resource scope, not as the v2 token audience.
`allowedClientIds` identifies the actual calling applications. Review
preauthorization and consent separately; do not substitute a wildcard.

Review both the backend's behavior and its data before listing an operation in
`review.readOnlyOperationIds`. HTTP GET alone is not evidence of no side effects.
Descriptions, responses and URLs must not include credentials or private data.

## 2. Review the files, then save them

Use your own existing private workspace and a **new** project directory:

```powershell
node .\bin\copilot-mcp.js mcp-container-apps-plan `
  --workspace-root C:\McpProjects `
  --config C:\McpProjects\container-input.json `
  --output C:\McpProjects\information-server `
  --summary --json
```

Review the returned `review`, all `files`, and the exact `approvalToken`. After
approving only this local write, run:

```powershell
node .\bin\copilot-mcp.js mcp-container-apps-create `
  --workspace-root C:\McpProjects `
  --config C:\McpProjects\container-input.json `
  --output C:\McpProjects\information-server `
  --approve '<exact approvalToken from the current plan>' --json
```

The folder contains editable server code, a pinned dependency lock, a Dockerfile,
the runtime settings, the original recipe input, a local review record, this
guide, and `infra\container-app.json`. It is not an APIM project and intentionally
does not contain an APIM-compatible `mcp-server.json`.

Existing output is never overwritten. If writing is interrupted, preserve the
partial directory, inspect it, then review a new output destination.

## 3. Run locally only when you intend to

In the generated project, dependency installation is a separate, explicit action.
First follow [approved registry selection and clean build-environment review](hosting-recipes.md#approved-npm-registry-for-generated-builds);
do not use ambient npm configuration or credentials:

```powershell
npm ci --ignore-scripts --no-audit --fund=false
$env:PUBLIC_MCP_URL = 'http://localhost:3000/mcp'
npm start
```

For the container-equivalent distribution, install with `--include=dev`, run
`npm run build` once in a fresh project, and use `node dist/server.js` instead
of `npm start`. See [bundled runtime packaging](hosting-recipes.md#bundled-container-runtime)
for the component/license inventory and unchanged image-security gates.

For API-key mode, use the shared guide's separate approved in-memory
Key Vault launch pattern instead; a missing or unresolved key prevents startup.
The generated lock and `.npmrc` use the explicit `npmRegistryUrl`, or historical
public npm when omitted, with the original pinned versions and integrity hashes.
The generated Dockerfile consumes that registry in its isolated dependency stage;
changing the choice requires a new reviewed project, not edits to sealed files.
Your organization's registry/network policy still applies. Stop on package,
integrity or TLS errors; do not remove integrity hashes or disable TLS checks.

`GET /health` returns only a basic liveness result. It does **not** check Entra,
the backend, deployment readiness or the consumer.

All `/mcp` requests require a valid Entra token, including local requests.
There is no development authentication bypass. A protected-resource metadata
endpoint is available at `/.well-known/oauth-protected-resource`; this does not
register arbitrary OAuth clients automatically. Configure an approved client
and resource scope separately. Never put a bearer token into a checked-in file,
command argument, sample or log.

Starting the server does not call the backend. Authenticated MCP requests can
fetch Microsoft's signing keys; a `tools/call` can contact the configured
backend. Those are live operations, not offline checks.

## 4. Review the Azure prerequisites and deployment separately

Before any Azure operation, select an explicit tenant, subscription and account
using project-private authentication. Do not change a shared Azure CLI account
or copy credentials. This recipe has no automatic Azure executor yet.

An operator must separately review:

- The exact resource group, region and Container Apps environment, including
  internet reachability from the intended Copilot service and outbound access
  to Entra and the reviewed backend.
- A unique, absent Container App name. ARM can update an existing resource:
  **the template itself is not a no-overwrite or ownership guard**.
- The existing image registry and the least-privilege user-assigned identity
  allowed to pull this image. Confirm the registry's supported managed-identity
  configuration and role assignments; this recipe creates no roles or grants.
- For API keys, the exact existing Key Vault and separate secret-reader identity,
  tenant/subscription, pre-existing secret Get access, resolution and safe logs.
  The app secret uses `keyVaultUrl`/`identity`, not a literal `value`; the container
  uses `secretRef`. Versionless references refresh within Azure's documented
  30-minute window and restart consuming revisions; review rollout separately.
- The server and dependency sources, dependency licenses, image scanning and
  base-image hardening. Pin an approved base-image digest for production.
- The complete cost and exposure: HTTPS ingress is externally reachable, but
  the MCP route requires Entra sign-in. One warm replica is configured to avoid
  cold starts; it has a continuing cost.

Build and push only after a separate review. Supply the resulting immutable
`registry/repository@sha256:digest` as the ARM `containerImage` parameter. The
template has no default image and does not build or publish one. Confirm that
the image belongs to the selected registry before deployment.

Deploy only after reviewing the exact template, parameter, identity and target
scope. The template creates one Container App referencing existing resources.
It creates no APIM, Key Vault, Entra app, environment, registry or role assignment.
The `mcpEndpoint` output uses the environment's default domain. Custom domains,
private consumer connectivity and sovereign clouds are not qualified here.

Do not invoke the existing toolkit APIM provisioning/resume commands on this
project. They cannot inspect, deploy or recover this new hosting contract.

## 5. Check the endpoint and consumer separately

After an approved deployment, independently verify authentication rejection,
authorized `initialize` and `tools/list`, the actual annotations, and one
separately approved tool call. Generated `recipe-review.json` is a source review,
**not captured endpoint evidence**.

FCC and Cowork still need their own authentication registration and rollout.
Use the separately approved [recipe endpoint-reference flow](hosting-recipes.md)
to connect an explicitly supplied actual endpoint to the existing discovery,
proof and FCC flows. It preserves the referenced-not-verified status and does
not fabricate tools or deployment evidence. Never edit old captures to make a
new project appear qualified.

Confirm the actual Read/Write labels in the target Copilot experience. Neither
source annotations nor a successful tool call alone proves the final UI behavior.

## Limits and troubleshooting

- **401:** missing, expired or invalid token; verify the resource app issues v2
  tokens. Do not remove authentication.
- **403:** tenant/scope/client restrictions or HTTP Host/Origin mismatch; review
  the actual intended settings rather than broadening the allowlist.
- **503:** token validation is unavailable, including signing-key access failure.
- **429:** per-process request or concurrency limit. The request budget includes
  all MCP POSTs, including initialization, notifications, discovery, proof
  preflight and rejected sign-in attempts, not just backend calls. A discovery
  followed immediately by proof can exhaust a small budget before dispatch.
  Inspect the persisted dispatch receipt before considering another operation;
  a tool error or unknown dispatched outcome remains consumed.
  Counters reset on restart; revisions/replicas do
  not share a counter. This is not a billing limit or DDoS defense.
- **405:** the stateless `/mcp` endpoint accepts POST, not a persistent SSE GET.
  It returns JSON through the SDK's Streamable HTTP transport.
- **Tool error:** the backend request failed, redirected, timed out, exceeded
  1 MiB or did not return valid JSON. Requests have a 10-second backend timeout,
  and are never automatically retried. Failure does not prove nonexecution.
  Newly generated runtimes log `backend-call-failed` with `failureKind` and,
  when a valid HTTP response status was received, numeric `httpStatus`.
  Categories are `request`, `timeout`, `cancelled`, `http-status`, `redirect`,
  `content-type`, `response-too-large`, `response-empty`, `response-read`,
  `invalid-json` and `credential-reflection`. `request` includes transport
  failures and redirects rejected by fetch before a response is available;
  it does not establish the provider received the request. An HTTP status
  alone does not identify an invalid key or prove a specific entitlement issue.
- MCP requests are capped at 64 KiB and 20 concurrent requests per process.
  Logs contain fixed event names, tool identifiers, bounded failure categories
  and optional HTTP status, not tokens, URLs, headers, bodies or raw errors.
  Review platform diagnostics separately; application redaction cannot control
  every hosting or network log.
- Review DNS and egress rules for the chosen backend. A fixed configured URL is
  not a guarantee about future DNS resolution or upstream behavior.

These diagnostics do not modify existing generated source or deployments, recover
missing details from old failures, or authorize a replay. Adopting them requires
newly generated/reviewed source and the normal build/deployment boundaries.

Customer ownership, maintenance and the repository's MIT/as-is terms still
apply to generated source. Keep real configurations, generated projects and
operational evidence out of the public toolkit repository.

Release source/parameter packaging is also available through the
[shared recipe commands](hosting-recipes.md). It remains local preparation,
not an automatic Azure deployment.
