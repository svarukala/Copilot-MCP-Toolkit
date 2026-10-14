# Copilot MCP Toolkit

An independent **Node.js 22+ CLI and library** for bounded REST-to-MCP scenarios,
existing MCP references, and guarded Azure API Management lifecycle operations.
GitHub Copilot CLI can use the same engine through the included guidance skill.
No Cowork toolkit installation, plugin package, token-store registration or D4NA
runtime is required.

This is an experimental engineering toolkit, not an arbitrary REST/OAuth-to-server
generator. It generates APIM deployment bundles, not a new Node/Python MCP server.
Generation, deployment, discovery, protocol proof, result assertions and caller/
backend rejection are distinct evidence. A generated endpoint is not live readiness.

## Run locally

```powershell
npm ci --offline --ignore-scripts --no-audit --fund=false
node .\bin\copilot-mcp.js --help
node .\bin\copilot-mcp.js capabilities --json
node .\bin\copilot-mcp.js
```

The last command opens a terminal-only guided **review**: generation, explicit
resource choices, or resume. It never automatically approves login or execution.
Use explicit commands with `--json` in automation. `copilot-mcp` is also the package
bin after a local package installation; npm publication and global installation
are unnecessary. Offline installation requires the locked tarballs in the local
cache. Otherwise obtain approval for the configured feed; never bypass TLS, proxy
or network policy. See [development](docs/development.md).

### First local bundle (no network)

All examples contain synthetic IDs and endpoints, not deployable account selections.
Use an explicit workspace separate from installed code:

```powershell
$cli = (Resolve-Path .\bin\copilot-mcp.js).Path
$workspace = Join-Path $HOME 'mcp-work'
New-Item -ItemType Directory -Path $workspace -ErrorAction Stop
Copy-Item .\examples\mcp\existing-anonymous.json (Join-Path $workspace 'definition.json')
$definition = Join-Path $workspace 'definition.json'
$project = Join-Path $workspace 'server'
$review = node $cli mcp-server-plan --workspace-root $workspace --config $definition --json --summary | ConvertFrom-Json
node $cli mcp-server-create --workspace-root $workspace --config $definition --output $project --approve $review.reviewDigest --json
node $cli mcp-resume --workspace-root $workspace --project $project --json --summary
```

The reference is **not verified**. For REST generation, review and adapt
`examples/mcp/catalog.json` instead: explicit Entra inbound plus an anonymous
backend. Other examples cover Key Vault upstream MCP, delegated fixtures and
system-managed-identity application access. Never put API keys or tokens in JSON.

### Continue safely

`mcp-resume` presents completed/stale/pending/blocked layers and one supported next
plan. Explicit new tenant, subscription and account selection precedes any Azure
creation. Account-switch approval is separate from deployment approval; MCP user
authentication is separate again. Copy the exact current top-level approval and
required effect flags. Changed input, identity, freshness or history invalidates
the previous approval. No implicit login, capture renewal, negative-matrix replay
or retry of a dispatched call is provided.

`mcp-diagnose` is local evidence-only. `mcp-export-plan` / `mcp-export`, archive
inspection, and new-destination restore preserve evidence without porting auth
caches or rewriting history. In Cloud Shell, a checkpoint on the same filesystem
is **not** a cross-device backup; storage persistence is unknown unless explicitly
declared, and declaration is not verification.

## Integrations and boundaries

- [Custom federated connector onboarding and demo preparation](docs/federated-connectors.md)
- [FCC presentation rehearsal: synthetic offline and gated live tracks](docs/fcc-demo.md)
- [Session handoff and next starting point](docs/handoff.md)
- [Implementation and scenario tracking](docs/progress-tracker.md)
- [Proposed MCP Toolkit to WIQD handoff](docs/wiqd-handoff.md)
- [CLI contract and exact approval flows](docs/cli-contract.md)
- [Scenario/auth coverage and unsupported limits](docs/scenarios.md)
- [Install the GitHub Copilot CLI skill](docs/copilot-cli.md)
- [Library API](docs/api.md)
- [Extraction and compatibility decisions](docs/extraction.md)

The skill provides instructions, not a second execution engine or an MCP tool-server
facade. It cannot grant host/tool permissions or register the generated server.
No live/cloud/provider validation is implied by the offline tests.

The FCC module (`mcp-fcc-schema`, `mcp-fcc-plan`, `mcp-fcc-bundle`) creates a
reviewed local onboarding draft for existing MCP descriptors. It checks
metadata/SSO gaps and retains observed tool definitions without claiming that a
connector is registered or ready. Microsoft 365 registration remains manual.

MIT; original attribution is retained in [LICENSE](LICENSE). Dependency notices
are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
