# MCP hosting recipes

The recipes use the same Node.js MCP server. Hosting changes; tool logic and
caller permissions do not. Each operation below is explicit and local unless
the operator separately chooses to build, publish, deploy or test.

| Recipe | Existing prerequisites | Complete synthetic input |
| --- | --- | --- |
| [1. Direct Container Apps](container-apps-recipe.md) | Environment, ACR and image-pull identity | `examples/mcp/container-apps-direct.json` |
| [2. Container Apps with APIM](apim-gateway-recipe.md) | Recipe 1 prerequisites plus APIM, gateway resource app and identity role assignment | `examples/mcp/container-apps-apim.json` |
| [3. App Service](app-service-recipe.md) | Linux Basic-or-higher plan, ACR and image-pull identity | `examples/mcp/app-service-container.json` |
| [4. Functions (preview)](functions-recipe.md) | Linux FC1 plan, blob storage/container and storage identity | `examples/mcp/functions-sdk.json` |

All four are implemented for **local generation, release preparation and explicit
endpoint-reference creation**. Cloud deployment remains an operator workflow;
real host behavior and Copilot Read-only labels are not yet qualified.
All support Entra delegated callers and one anonymous or **Key Vault API-key**
JSON backend with explicitly reviewed, parameter-free GETs. They do not add
backend OAuth, username/password, arbitrary arguments or write tools.

## API-key backends

The same `backend` shape works with every recipe and the original direct-only
commands. Anonymous inputs remain unchanged. Complete fictional API-key inputs:

| Host | Input | Placement |
| --- | --- | --- |
| Direct Container Apps | `examples/mcp/container-apps-direct-api-key.json` | Header |
| Container Apps with APIM | `examples/mcp/container-apps-apim-api-key.json` | Query |
| App Service | `examples/mcp/app-service-container-api-key.json` | Header |
| Functions | `examples/mcp/functions-sdk-api-key.json` | Query |

Both placements work on all four hosts. Prefer a dedicated header if the
provider supports it. Replace the example values with reviewed **references**,
never actual keys:

```json
{
  "origin": "https://private-data.example.com",
  "auth": "api-key",
  "apiKey": {
    "tenantId": "11111111-1111-4111-8111-111111111111",
    "keyVaultResourceId": "/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/rg-synthetic-secrets/providers/Microsoft.KeyVault/vaults/synthetic-vault",
    "identityResourceId": "/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/rg-synthetic-secrets/providers/Microsoft.ManagedIdentity/userAssignedIdentities/synthetic-secret-reader",
    "secretIdentifier": "https://synthetic-vault.vault.azure.net/secrets/backend-access/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "headerName": "X-Backend-Key",
    "sharedAccessReviewed": true
  }
}
```

Use exactly one `headerName` or `queryParameterName`. For query placement,
replace `headerName` with `"queryParameterName": "api_key"` and explicitly set
`"queryExposureReviewed": true` **only after** reviewing and preventing key
exposure in backend, intermediary, proxy, platform and telemetry URL logs.
The toolkit cannot inspect those systems. If safe logging cannot be established,
do not deploy a query-key recipe. Header values also need logging protection.
`sharedAccessReviewed: true` declares that every permitted caller may use this
one service entitlement and access the selected data under the provider's terms.
These declarations are owner reviews, not observed enforcement or evidence.
There is no per-user credential selection or source-data filtering.

Header names use letters, digits and hyphens, starting with a letter (100
characters maximum). Query names also allow dots and underscores. Reserved
authorization, cookie, gateway-proof, MCP, transport, forwarding and routing
names (including method-override and original/rewrite-URL headers) are rejected.
Provider-specific dedicated names such as `X-API-Key`,
`Ocp-Apim-Subscription-Key` and `x-functions-key` are allowed.
`Authorization`/Bearer, cookies, custom prefixes, multiple
keys and raw credential fields are unsupported. Query values are URL-encoded by
the runtime, never part of an authored path or tool argument.

If OpenAPI declares security globally or on a selected operation, it must name
exactly one `type: apiKey` scheme whose `in` and `name` match the reviewed
placement (header names are case-insensitive; query names are case-sensitive).
Scopes must be empty. Optional/alternative/mixed profiles, references, OAuth,
cookie keys and explicit anonymous overrides are rejected. Omitted security is
allowed with the explicit reviewed backend auth; it never overrides that auth.
Do not model the key as an operation parameter: tools still take no arguments.

### Identity, deployment and secret resolution

The vault and secret-reading user-assigned identity must already exist in the
selected subscription and tenant. The reference's vault hostname must match
`keyVaultResourceId`. Public Azure `vault.azure.net` HTTPS secret URIs support
either an exact 32-hex version or no version; no ports, credentials, queries or
fragments. Prefer a version when a rollout must use exactly reviewed material.
The vault may be in another resource group in the same subscription.

`identityResourceId` must differ from the image-pull or Functions storage
identity. The generated host attaches both identities but selects the dedicated
one only for Key Vault references. No identities, vaults, secrets, RBAC roles or
access policies are created or modified. The runtime never requests a managed
identity token or calls Key Vault. Inspect the actual tenant/resource bindings,
identity principal, least-privilege pre-existing secret **Get** access (for
example Key Vault Secrets User at the narrow appropriate scope), secret
enabled/expiry metadata and network reachability separately with the selected
private tenant/subscription/account. Local validation cannot attest to these facts.
Do not grant Key Vault rights to a shared pull/storage identity to bypass a failure.

| Host | Generated reference |
| --- | --- |
| Container Apps (direct and APIM) | App secret `mcp-backend-api-key` with `keyVaultUrl` and dedicated `identity`; container `MCP_BACKEND_API_KEY` uses `secretRef` |
| App Service and Functions | `MCP_BACKEND_API_KEY` app setting uses `@Microsoft.KeyVault(SecretUri=...)`; site `keyVaultReferenceIdentity` selects the dedicated identity |

App Service's identity selection applies to **all** Key Vault references on the
site. These templates are for a new, name-absence-reviewed site, not a merge into
an existing site's settings. Container Apps image pull and Functions host and
deployment storage continue using their original explicit identities.
Recipe 2 does not put the backend key into APIM: gateway and caller tokens are
still independently verified by the SDK and neither is forwarded to the REST API.

Reference/identity/placement/declaration changes alter source hashes and exact
creation/release approvals. Use a new reviewed project and release rather than
editing a sealed project or reusing an old approval. Source/release files contain
references only; they never resolve a secret. Deployment, Key Vault/network
inspection, image/source publication and reference-resolution checks remain
separately approved operator operations.

### Startup, failures and rotation

The host injects the resolved value into `MCP_BACKEND_API_KEY`. API-key mode
refuses to start if it is missing, empty, longer than 4096 characters, contains
whitespace/non-ASCII/control characters, looks like an unresolved platform
reference/URL, or contains angle-bracket placeholders. There is no anonymous
fallback. A valid-looking but incorrect, expired or revoked value cannot be
detected without a separately approved backend call. Anonymous mode ignores the
credential environment variable.

The server snapshots the credential at startup. It has no application refresh
loop, token exchange, key fallback or automatic call retry. A call is one fixed
HTTPS GET with redirects refused, a 10-second deadline and a 1 MiB JSON bound.
Backend errors, non-JSON, redirects and obvious reflection of the key (including
JSON escapes, URL encoding and Base64) produce a generic tool error and fixed
event log, never the error body, key or authenticated URL. This is a conservative
reflection check, not general DLP: transformed/partial secrets may evade it and
short keys may cause false positives. Review backend data and diagnostics.
Timeout/failure does not establish nonexecution; never replay automatically.

With **versionless references**, Azure documents Container Apps fetching the
latest version within 30 minutes and restarting active revisions that consume
it as an environment variable. App Service/Functions cache references and
refetch within 24 hours; app configuration changes cause restart and immediate
refetch, and a separately authorized management refresh endpoint exists.
Do not assume every running worker has switched immediately. Independently
verify resolution and worker restart for the intended rollout; the SDK itself
only sees its startup snapshot. Version-pinned references do not follow new
versions: generate/review/deploy the changed reference and restart as needed.
Old credentials may persist in platform caches/process memory during rotation;
coordinate overlap/revocation with the provider. Rotation is not approval to
retry failed/unknown tool calls.

### Local execution with API keys

Local Node/Functions Core Tools do **not** resolve Azure platform reference
strings. Install the generated locked dependencies only under separate approval,
then use an organization-approved secret launcher to resolve the exact reviewed
Key Vault reference with a project-private, explicitly selected identity and
inject `MCP_BACKEND_API_KEY` into the server process. This is a separate live
secret-read approval, not part of generation or an offline test. Do not paste
keys into prompts, shell arguments/history, `.env`, local.settings.json,
runtime-config.json, source, container builds or logs. No key value belongs in a
saved file, even if gitignored. Remove the environment value when the process exits.

For operators who already use the separately installed/reviewed Az PowerShell
module, the equivalent in-memory launch pattern below assumes `$privateContext`
was authenticated privately with context autosave disabled, and its exact
tenant/subscription/account were independently verified. Do not use an ambient
shared context. Set PUBLIC_MCP_URL/host settings per the host guide first:

```powershell
# Separate approved secret read; metadata below is fictional.
try {
  $env:MCP_BACKEND_API_KEY = Get-AzKeyVaultSecret -DefaultProfile $privateContext `
    -VaultName 'synthetic-vault' -Name 'backend-access' `
    -Version 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' -AsPlainText -ErrorAction Stop
  node .\server.js
} finally {
  Remove-Item Env:\MCP_BACKEND_API_KEY -ErrorAction SilentlyContinue
}
```

For a separately reviewed local Functions host use `func start` instead of
`node .\server.js`, preserving the same process-only secret injection.
Do not enable transcripts/debug tracing or print the environment. Startup
without an injected valid-format key fails before health/MCP are available.
Local execution still requires real caller tokens (and gateway proof for recipe
2); there is no auth bypass. Repository tests instead inject synthetic values
and transports and never contact Key Vault or a provider.

Official platform contracts reviewed for this implementation:
[Container Apps secrets](https://learn.microsoft.com/azure/container-apps/manage-secrets)
and [App Service/Functions Key Vault references](https://learn.microsoft.com/azure/app-service/app-service-key-vault-references).
Documentation support is not live qualification of these templates.

## Choose, review and generate

Copy the selected fictional example into an existing private workspace. Replace
it with actual reviewed settings; never deploy the example as-is. Review the
host-specific guide above, then:

```powershell
node .\bin\copilot-mcp.js mcp-hosting-schema --json
node .\bin\copilot-mcp.js mcp-hosting-plan --workspace-root C:\McpProjects `
  --config C:\McpProjects\input.json --output C:\McpProjects\server --summary --json
node .\bin\copilot-mcp.js mcp-hosting-create --workspace-root C:\McpProjects `
  --config C:\McpProjects\input.json --output C:\McpProjects\server `
  --approve '<exact current approvalToken after review>' --json
```

Use the installed `copilot-mcp` command in place of `node .\bin\copilot-mcp.js`
if installed. The commands below use that shorter form.
The original `mcp-container-apps-*` commands intentionally remain recipe-1-only.
These source projects are not part of the terminal wizard or APIM Resume flow.
Source generation cannot log in, install dependencies or change Azure.

## Source, release and endpoint are different things

1. **Generate source.** Review the selected recipe input and save a new project.
   `recipe-manifest.json` records hashes of all generated files. It is an
   integrity record, not a signature, security audit or deployment receipt.
2. **Prepare a release.** Review the source and an immutable deployment artifact.
   The toolkit packages source and exact deployment templates without executing
   a shell, logging in, building an image or changing Azure.
3. **Deploy separately.** Use project-private authentication with the exact
   tenant, subscription and account. Inspect prerequisites, name collisions,
   ownership, inherited policies, costs, network and role assignments first.
   Review what-if and approve the exact deployment before running it.
4. **Reference the actual endpoint.** Supply the actual URL after separately
   checking deployment. The toolkit creates a new existing-MCP reference with
   the same authentication settings, not a fabricated deployment receipt.
5. **Discover, prove and onboard separately.** Existing discovery/proof/FCC
   commands can use that reference. They still require actual fresh tools/list
   evidence and separate approvals; generated annotations are never captures.

## Prepare a container release

Create a private JSON input:

```json
{
  "schemaVersion": 1,
  "accountName": "operator@example.com",
  "containerImage": "syntheticregistry.azurecr.io/mcp@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

These are fictional values. Use your exact account and separately built,
scanned and approved image digest in the registry selected by the recipe.
The toolkit binds that image reference to the release review, but cannot prove
that an externally built image contains the reviewed source.

```powershell
copilot-mcp mcp-recipe-release-plan --workspace-root C:\McpProjects `
  --project C:\McpProjects\server --config C:\McpProjects\release.json `
  --output C:\McpProjects\release-review --summary --json
```

Review all output. Save the files only after explicit local-write approval:

```powershell
copilot-mcp mcp-recipe-release-bundle --workspace-root C:\McpProjects `
  --project C:\McpProjects\server --config C:\McpProjects\release.json `
  --output C:\McpProjects\release-review --approve '<exact current token>' --json
```

The output contains source.zip (no installed node_modules), deployment templates,
per-template parameters and release-review.json. Source licenses/notices are included.
The original source manifest and every file must still match; edited source
requires a newly reviewed generated project or an independent operator workflow.
Do not rewrite an old manifest just to pass an integrity check.

These commands are **not deployment commands**. Templates can update existing
resources if manually misapplied. They provide no atomic ownership/no-overwrite
guarantee, inspection of Azure state or permission to replay failed deployments.
Private account setup, prerequisite review, what-if and actual deployment remain
operator actions. No hidden az command or subprocess is run.

## Use a deployed endpoint with discovery and FCC

Create a private endpoint input after separately confirming its actual URL:

```json
{
  "schemaVersion": 1,
  "serverId": "66666666-6666-4666-8666-666666666666",
  "endpoint": "https://actual-reviewed-endpoint.example.com/mcp"
}
```

Use a new server ID for the new reference. Do not use a new reference to bypass
consumed historical proofs or retry an unknown call.

```powershell
copilot-mcp mcp-recipe-reference-plan --workspace-root C:\McpProjects `
  --project C:\McpProjects\server --config C:\McpProjects\endpoint.json `
  --output C:\McpProjects\endpoint-reference --summary --json
copilot-mcp mcp-recipe-reference-create --workspace-root C:\McpProjects `
  --project C:\McpProjects\server --config C:\McpProjects\endpoint.json `
  --output C:\McpProjects\endpoint-reference --approve '<exact current token>' --json
```

The result is a normal `existing-mcp` project plus `recipe-origin.json`. Its
status is **referenced-not-verified**, never deployed or consumer-ready. It
contains no imported/generated tools capture. Use existing MCP discovery on
this new reference, with the actual authorized discovery client and expected
user. Do not run the APIM resource lifecycle on the source or reference.

For FCC, use only the resulting real observed capture and separately prepared
SSO registration. Nothing here registers a connector, provisions a WIQD app,
broadens a rollout audience or proves the UI labels.

## Checks still needed in the real environment

Check the selected host's prerequisites, image/source deployment, actual URL,
rejection of invalid callers and authorized tools/list. For recipe 2 also check
gateway-token issuance, inherited policies and direct-host bypass rejection.
For recipe 4 check preview availability, remote build and the actual Functions
host. For API-key mode, also inspect the selected vault/identity, reference
resolution, safe diagnostics, missing/invalid-key rejection and rotation/restart
behavior without exposing keys. Then separately approve one tool call and inspect annotations and actual
Copilot Read/Write labels. Preserve failed/unknown attempts; a new source or
reference does not authorize replay.
