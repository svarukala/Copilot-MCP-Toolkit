# Recipe 4: Azure Functions SDK hosting (preview)

This recipe runs the same SDK server as a Functions **custom handler**, not the
Functions MCP trigger extension. Microsoft currently supports this SDK hosting
profile in public preview, on **Linux Flex Consumption (FC1)**, with stateless
Streamable HTTP. This recipe uses JSON responses, not sessions or SSE.

## Configure and generate

Start with the direct Container Apps input, keeping the same backend,
authentication and reviewed GET operations:

1. Set `recipe` to `functions-sdk-v1`.
2. Remove `azure.environmentResourceId` and `azure.registry`.
3. Add `azure.planResourceId` for an existing Linux FC1 plan in the selected
   subscription/region, and `azure.planKind`: `linux-flex-consumption-FC1`.
4. Add `azure.previewAccepted`: `true` only after reviewing the preview limits.
5. Add `azure.storage`:

```json
{
  "accountResourceId": "/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/synthetic-rg/providers/Microsoft.Storage/storageAccounts/syntheticstorage",
  "deploymentContainer": "mcp-deployment",
  "identityResourceId": "/subscriptions/22222222-2222-4222-8222-222222222222/resourceGroups/synthetic-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/synthetic-storage",
  "identityClientId": "88888888-8888-4888-8888-888888888888"
}
```

These are fictional. Use the exact existing private deployment container and
identity. Independently inspect storage/network access, region capacity and RBAC
for the host and deployment operations. For this blob-only SDK profile, review
the Functions identity-based host-storage requirements and appropriate Blob Data
roles. Do not grant broad subscription roles or add account keys to get past an
error. Identity resource ID and client ID must describe the same identity.

Use `mcp-hosting-schema` and `mcp-hosting-plan/create`. Generated source includes
host.json with the preview profile, Node startup and the three intended routes.
The Functions MCP route is `anonymous` **at the host routing layer only**:
the SDK still requires signed delegated Entra tokens. `/admin/*` retains admin
authorization; public health/metadata do not expose tools or backend data.

The infrastructure sets `EnableMcpCustomHandlerPreview`, Node 22, managed-identity
deployment storage and identity-based host blob storage. No storage keys,
connection strings, SAS tokens, registry, image or authentication registrations
are generated. The actual platform hostname is read rather than guessed.
The maximum scale is 40 instances (Flex's supported minimum maximum), each with
2048 MiB; there are no Always Ready instances. Rate limits remain per process,
so this is not a global quota or a spending cap.

## Local checks and release

For local Functions-host validation, separately install/review Functions Core
Tools, the locked Node dependencies and a local Azurite emulator. Copy
local.settings.example.json to local.settings.json, start the emulator and run
`func start`. Do not start a deployment or log in as part of this check.
Use port 7071 for the Functions host, not the custom-handler port.
Entra validation is never disabled; unit tests use local synthetic keys, not
provider tokens. Local settings are excluded from deployment.

Use `mcp-recipe-source-plan --workspace-root ABS --project ABS --json` to review
the deterministic source ZIP hash, then create this private release input:

```json
{
  "schemaVersion": 1,
  "accountName": "operator@example.com",
  "sourceArchiveSha256": "sha256:<exact hash from source-plan>"
}
```

Run the shared [release plan/bundle flow](hosting-recipes.md). It emits
source.zip, infra/functions.json and its parameter file. The ZIP is **source
only**: no installed dependencies and no claim of remote-build attestation.
After separate Azure identity, ownership and what-if review, provision the app.
Then separately review the Flex-supported One Deploy/remote-build path before
uploading source. Infrastructure deployment alone does not deploy runnable code.
Never use legacy WEBSITE_RUN_FROM_PACKAGE, a SAS URL, or a local publish profile
as an unreviewed substitute. The toolkit does not run Core Tools or Azure CLI.

After actual deployment/readback, create an unverified endpoint reference and
perform separate discovery, proof and FCC onboarding. Preview availability,
remote dependency build, host routing, storage identity and consumer labels
remain live-unverified; local SDK tests do not establish these platform results.

## References

- [Microsoft's SDK hosting profile and restrictions](https://learn.microsoft.com/azure/azure-functions/self-hosted-mcp-servers)
- [Official Node custom-handler sample](https://github.com/Azure-Samples/mcp-sdk-functions-hosting-node)
- [Flex Consumption creation and deployment](https://learn.microsoft.com/azure/azure-functions/flex-consumption-how-to)
