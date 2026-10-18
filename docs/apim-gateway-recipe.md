# Recipe 2: Container Apps with an APIM gateway

APIM is the front door. The same SDK server still owns tool definitions,
read-only hints and tool execution. We use an ordinary HTTPS API proxy, not
APIM's REST-to-MCP generator. It is therefore not a native MCP entry in the
APIM portal catalog. Clients use its full `/selected-path/mcp` endpoint.

## Before generating

Start from the direct Container Apps input, change `recipe` to
`container-apps-apim-v1`, and add `azure.gateway`:

```json
{
  "serviceName": "synthetic-apim",
  "resourceGroup": "synthetic-gateway-rg",
  "apiName": "reviewed-mcp",
  "path": "reviewed-mcp",
  "audience": "88888888-8888-4888-8888-888888888888",
  "applicationIdUri": "api://88888888-8888-4888-8888-888888888888",
  "principalId": "99999999-9999-4999-8999-999999999999",
  "role": "Mcp.Gateway"
}
```

These values are fictional. Use an existing APIM in the selected subscription.
Its system-assigned managed identity's **principal/object ID**, not client ID,
goes in `principalId`. Independently configure a separate Entra resource app
with v2 access tokens, an application role named `Mcp.Gateway` allowing
applications, and that exact role assignment to the APIM managed identity.
The gateway audience is that app's client ID; its Application ID URI is the
resource requested by APIM. Do not reuse the delegated caller app/audience.
The toolkit does not create these registrations, assignments or APIM instance.

Use `mcp-hosting-schema`, `mcp-hosting-plan` and `mcp-hosting-create` with the
same explicit workspace/config/new output and exact approval as recipe 1.
See [shared preparation and reference commands](hosting-recipes.md).

## How access works

APIM first checks the caller's delegated token, exact tenant, audience, scope
and allowed client. It obtains its own managed-identity token and overwrites
`X-Copilot-MCP-Gateway-Authorization`. The original caller Authorization remains
intact. The SDK server independently verifies both signatures, both audiences,
the exact gateway principal and role, and the caller's delegated access.

A missing, spoofed, expired or wrong-principal gateway token fails closed.
Simply supplying a header or reaching the public Container Apps hostname does
not bypass the gateway requirement. Neither token is sent to the public backend.
Liveness and public OAuth metadata contain no tools or data and remain public.
Network isolation can add defense in depth; this recipe does not configure it.

## Deploy and verify separately

Release input additionally requires `backendOrigin`: the exact selected app's
HTTPS origin under `azurecontainerapps.io`, obtained from separately reviewed
deployment/environment information. Inspect it before applying the proxy.
Use `infra/container-app.parameters.json` with the app template in the app
resource group, and `infra/apim-gateway.parameters.json` with the gateway
template in **the gateway resource group**. Do not apply both to one group
without checking the explicit targets. Neither template creates prerequisites.

Review inherited APIM policies before deployment. All four policy sections
inherit their parent. Do not add retry policies, replace caller Authorization,
read or rewrite the response body, drop annotations or log tokens/payloads.
If inherited policies do any of these things, resolve them explicitly with the
owner rather than silently removing them. This server uses stateless JSON
Streamable HTTP, not SSE or persistent sessions. Streaming/SSE behavior is not
qualified by these files. Gateway timeouts must allow the bounded backend call.

The SDK advertises the APIM endpoint and its gateway-routed public metadata URL.
Create the existing-MCP reference using the **APIM URL**, not the container URL.
Actual Azure identity token issuance, inherited policy behavior, consumer
authentication and Read-only UI classification still need live validation.
