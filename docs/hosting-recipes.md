# MCP hosting recipes

The recipes use the same Node.js MCP server. Hosting changes; tool logic and
caller permissions do not. Each operation below is explicit and local unless
the operator separately chooses to build, publish, deploy or test.

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
parameters and release-review.json. Source licenses/notices are included.
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
