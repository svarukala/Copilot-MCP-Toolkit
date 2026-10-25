# MCP Deployment Handover

At completion **or a pause**, use `mcp-handover-schema/plan/bundle` to produce a
private offline handover for any of the four sealed SDK hosting recipes.
This is a separate local-write review, not a deployment, sign-in or provider
operation. The shipped skill makes it a closeout step; the CLI never silently
exports private environment data or infers that installation succeeded.
Native APIM/other standalone project kinds are not accepted as source recipes.

## What the user receives

Open `index.html` locally. No web server, package installation, CDN, telemetry
or online diagram renderer is needed. The two tabs are:

- **Deployment summary:** configured endpoint, authentication, tools, resource
  inventory, operator-reported milestones, pending/deferred work, retained
  scoped protocol observations, ownership/cost notes and artifact links.
- **Recreate in another environment:** original-to-destination field mapping,
  recipe-specific ordered steps, PowerShell commands with explicit destination
  placeholders, expected results, manual-only work and separate approval gates.

The summary embeds an SVG architecture diagram derived from the recipe, including
APIM, Key Vault and storage/registry dependencies only where applicable. It is
**configured architecture, not proof of deployment**. `architecture.excalidraw`
preserves editable source alongside `architecture.svg`. The toolkit never opens
an editor or uploads the diagram. Use an approved editor, such as the
[Microsoft Excalidraw entry point](https://aka.ms/excalidraw), separately.
Edit a separate diagram copy: changing it does not change configuration or
regenerate the HTML/SVG, and overwriting a snapshot file invalidates its hash.

The folder also contains:

| Path | Meaning |
| --- | --- |
| `handover-manifest.json` | Structured report, provenance, source/journal/evidence bindings and hashes of every other output file. Unkeyed integrity, not a signature |
| `source/` | Unchanged manifest-listed generated source, configuration, host guide and ARM templates; no cache or unlisted workspace files |
| `release/` | Optional explicitly selected source-matched ZIP, templates, exact per-template parameters and a reduced release summary |
| `scripts/review-source.ps1` | Parameterized **local source-plan only** script; never installs, authenticates, builds or deploys |

Keep the folder together. Links are relative. Copy buttons copy plain command
text only; when clipboard access is unavailable, the command is selected and
the page explains how to copy manually. Tabs support keyboard navigation.
Without JavaScript both sections remain visible; printing includes both tabs.
Checklist boxes are temporary reading aids, not persisted evidence or approvals.

## Generate a snapshot

Select an existing private workspace and its sealed hosting source project.
Review which environment IDs and nonsecret notes will be exported. A minimal
input is:

```json
{
  "schemaVersion": 1,
  "snapshotAt": "2026-01-01T00:00:00.000Z",
  "privateExportReviewed": true
}
```

Replace the fictional timestamp with the current UTC time **after** the latest
records to include, formatted to millisecond precision with
`(Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")`.
The timestamp is an explicit snapshot cut-off, not a claim that a service was
observed then. Future timestamps or later records are rejected.

```powershell
copilot-mcp mcp-handover-schema --json
copilot-mcp mcp-handover-plan --workspace-root C:\McpProjects `
  --project C:\McpProjects\server --config C:\McpProjects\handover.json `
  --output C:\McpProjects\handover-01 --summary --json

# After reviewing the exact local export and its TOP-LEVEL token:
copilot-mcp mcp-handover-bundle --workspace-root C:\McpProjects `
  --project C:\McpProjects\server --config C:\McpProjects\handover.json `
  --output C:\McpProjects\handover-01 --approve '<exact current approvalToken>' --json
```

`snapshotAt`, `privateExportReviewed` and `schemaVersion` are required.
Optional input fields:

| Field | Contract |
| --- | --- |
| `referenceProject` | Existing recipe endpoint-reference directory; must match this exact source and caller/gateway configuration. Reads retained metadata, never refreshes discovery |
| `releaseDirectory` | Existing reviewed release directory; archive, templates and parameters must match the source and immutable artifact |
| `milestones` | Bounded named owner declarations: `passed`, `failed`, `pending`, `deferred`, with `observedAt` and optional nonsecret `note`. No caller-supplied `verified` status |
| `resourceOutcomes` | Exact configured resource IDs with owner-reported `created`, `reused` or `changed` and `observedAt`; foreign IDs are refused |
| `operationsNote`, `costNote` | Bounded nonsecret text. If absent, ownership/pricing stay explicitly unrecorded |

Optional paths resolve relative to the handover config and must remain within
the workspace. The source project's existing operator journal is read
automatically if present; no journal is created or changed. Explicit newer
milestone declarations can supersede journal reports, retaining the previous
outcome in the manifest. They cannot upgrade a report into independent proof.
See [the synthetic example](../examples/mcp/deployment-handover.json).

## Evidence and sharing boundaries

- Configuration uses `planned-create` / `configured-reuse`, not installed.
  Actual resource dispositions supplied by the operator remain user reports.
- Operator activity and portal/consumer milestones are not service-attested.
  The report preserves waiting, pending, failed, unknown and deferred outcomes.
- Discovery receipts are scoped historical metadata; expired captures remain
  stale at the snapshot cut-off. A successful protocol proof does not establish
  business correctness or consumer acceptance. Backend assertions retain their
  narrower pass/fail meaning. No existing proof is replayable because of export.
- Only bounded derived evidence metadata is exported: not credentials, normal
  profile caches, raw captures, authentication logs or operation approval tokens.
  Source and resource IDs are private; this is **not a public-sharing sanitizer**
  or a general secret/DLP scanner. The operator must review source and notes.
- Inputs, source/release bytes, evidence/journal state, toolkit build and output
  location bind approval. Changed inputs require a new review. Output is
  exclusive and read back; the manifest is written last. An interrupted or
  changed-input write may leave an incomplete folder. Preserve it for diagnosis
  and select a new destination; never treat a folder without its manifest as a
  completed handover. Old snapshots are never updated in place.

## Reproduction is not replay

Edit a **copy** of `source/recipe-definition.json` outside the sealed project.
Choose destination IDs, names, Entra configuration, Key Vault references and
image settings explicitly, then regenerate. Many ARM values are embedded by the
generator; do not imply every value is a deployment parameter or patch manifests.

For APIM hosting, deploy/read back the Container Apps host under its own review
before preparing the gateway release's actual backend origin. Apply the gateway
template to its own selected resource group; do not redeploy the host afterward.
Functions requires a separately reviewed Flex remote-build/source deployment
after ARM provisioning. Container recipes need reviewed image-build inputs or a
separate operator build workflow. Explicitly select `npmRegistryUrl` for a
credential-free approved HTTPS feed before regeneration; omission preserves
historical public npm, not ambient npm configuration. The new source binds
`.npmrc`, pinned tarball URLs and Docker build inputs to that choice. Functions
remote-build behavior still needs separate review. See the
[approved registry contract](hosting-recipes.md#approved-npm-registry-for-generated-builds).
Never rewrite sealed assets or treat an old Dockerfile as upgraded by handover.
New container handovers preserve `build-runtime.mjs` and its locked build-only
tool so the [bundled runtime](hosting-recipes.md#bundled-container-runtime) is
reproducible. Historical source exports remain unchanged; importing a handover
does not rebuild, scan or qualify an image.

The guide supplies supported toolkit CLI steps and labels the rest as manual or
approval-required. It is not a universal installation/deployment script. Private
Azure identity, what-if, cloud deployment, image build/push, role grants, sign-in,
registration and consumer portal actions remain independent reviewed operations.
Use preserving-update workflows for existing deployments, not create-template
replay. Nothing in the HTML can launch a command.
