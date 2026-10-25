# Recipe 3: App Service

Run the same SDK MCP container on an existing **Linux dedicated App Service
plan, Basic or higher**. APIM is not required. The server checks Entra signatures,
tenant, audience, delegated scope and allowed client itself; it does not trust
forwarded identity headers or depend on Easy Auth.

## Configure and generate

Start with the direct Container Apps input:

1. Set `recipe` to `app-service-container-v1`.
2. Remove `azure.environmentResourceId`.
3. Add `azure.planResourceId`: the exact existing
   `/subscriptions/.../resourceGroups/.../providers/Microsoft.Web/serverfarms/...`.
4. Add `azure.planKind`: `linux-dedicated-basic-or-higher`.
5. Add `azure.registry.pullIdentityClientId`: the selected pull identity's client
   ID. Keep its separate `pullIdentityResourceId`; Azure requires both forms.

Use `mcp-hosting-schema`, then `mcp-hosting-plan/create` with the same explicit
workspace/config/new output and exact local-write approval.
See [shared release and endpoint-reference commands](hosting-recipes.md).
No authentication change, login, installation or Azure call occurs.

For API-key REST backends use `examples/mcp/app-service-container-api-key.json`
and [the shared key schema and safeguards](hosting-recipes.md#api-key-backends).
The site attaches a distinct Key Vault identity, sets `keyVaultReferenceIdentity`
to it and injects `MCP_BACKEND_API_KEY` using a native Key Vault app-setting
reference. The image-pull identity and client ID are unchanged. Confirm
pre-existing secret Get permission and network reachability; no grants are made.
The identity selection applies to all Key Vault references on the new site.

For an explicitly chosen local run from the generated source directory:

First [select `npmRegistryUrl` and review a clean build environment](hosting-recipes.md#approved-npm-registry-for-generated-builds)
without ambient npm configuration or credentials. The lock, `.npmrc` and
generated Dockerfile share that choice; omission retains historical public npm.

```powershell
npm ci --ignore-scripts --no-audit --fund=false
$env:PUBLIC_MCP_URL = 'http://localhost:3000/mcp'
npm start
```

To exercise the container-equivalent distribution instead, install with
`--include=dev`, run `npm run build` in a fresh project, then use
`node dist/server.js`. See [bundled runtime packaging](hosting-recipes.md#bundled-container-runtime);
component/license inventory does not replace fresh image qualification.

API-key local runs require the shared guide's separately approved process-only
secret injection; local Node cannot resolve platform reference strings. Missing,
empty or unresolved values fail startup, never fall back to anonymous.
Installation is a separate network action. Health is public; `/mcp` still needs
a real authorized Entra token and may fetch signing keys. There is no local
authentication bypass, and a tool call can contact the backend. Stop the process
when finished; do not put tokens in scripts or logs.

## Review before deployment

Confirm the plan is Linux, in the intended region and supports Always On.
Confirm the identity's resource ID and client ID refer to the same identity,
and independently review its least-privilege registry pull assignment and
registry network/ARM-token settings. The toolkit does not create or modify the
plan, registry or role assignment. An existing paid plan can incur more charges.

The template creates one site with HTTPS, TLS 1.2, no FTP/basic publishing,
Always On and a `/health` probe. It uses managed identity for ACR pulls, port
3000 and a separately reviewed digest-pinned image. Payload/error logging is
not enabled by the template. Review inherited/platform diagnostics separately.

The runtime reads the actual platform `WEBSITE_HOSTNAME`, including any generated
suffix. It never guesses the endpoint from the app name. The template also
outputs Azure's actual default hostname after deployment. An explicit
`PUBLIC_MCP_URL` remains available for separately reviewed custom-domain/local
configuration; do not trust request headers to choose the public URL.

Deploy `infra/app-service.json` with its corresponding parameters file only
after independent private identity, ownership, target and what-if review.
No deployment executor or atomic protection against overwriting an existing
site is provided. Use the actual endpoint to create an unverified reference,
then run separate discovery/proof/FCC steps.

Live image pull, Linux plan compatibility, platform routing, authentication and
consumer Read-only classification are not yet qualified. Existing runtime
limits remain: fixed parameter-free GETs, anonymous or API-key JSON backend, no retries,
per-process (not distributed) limits, stateless JSON Streamable HTTP.
Versionless references can take up to 24 hours to refetch; configuration changes
restart/refetch. The SDK holds its startup value until worker restart. Pinned
versions require a newly reviewed reference/release. See the shared rotation
and safe-diagnostics checklist before deployment or key changes.
