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

The last command (or `node .\bin\copilot-mcp.js init`) shows an ASCII welcome
banner and opens the terminal-only **New / Resume / Advanced** menu.
New asks for source and authentication details, supports a fixed GET endpoint
without an OpenAPI file or a local OpenAPI import, and writes a new local bundle
only after showing the definition, destination and digest for confirmation.
Resume reads retained state without executing a live phase. Advanced preserves
the existing definition/resource-review flows. The banner and prompts use stderr;
explicit commands, help, version and JSON output stay banner-free.
No login, deployment, discovery, tool call or FCC registration is automatic.
Use explicit commands with `--json` in automation. `copilot-mcp` is also the package
bin after a local package installation; npm publication and global installation
are unnecessary. Offline installation requires the locked tarballs in the local
cache. Otherwise obtain approval for the configured feed; never bypass TLS, proxy
or network policy. See [development](docs/development.md).
See [guided setup](docs/copilot-cli.md#interactive-new--resume-setup) for the
supported paths and the distinction between the terminal wizard and Copilot's
noninteractive use of the same engine.

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

For a deliberately **public anonymous APIM endpoint**, choose REST > anonymous
backend > fixed GET > public anonymous caller access in the wizard, or adapt
`examples/mcp/public-rates.json`. This skips Entra resource-app/discovery-client
setup but still requires Azure management identity. Explicit public-data/read-only
review and rate limits are mandatory; MCP and backing REST routes are public.
See [scope and safeguards](docs/scenarios.md#public-anonymous-apim). No live
public APIM/FCC end-to-end qualification is claimed.

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
- [Shared SSO/OAuth registration preparation and consumer references](docs/auth-registration.md)
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
connector is registered or ready. Its `manualSetup` section provides human
copy-and-paste form fields and OAuth/secretless SSO registration instructions
and references. OAuth is reference-only, with discovery still unsupported.
Microsoft 365 registration remains manual; no browser submission is automated.
**FCC-only onboarding requires no WIQD agent, project or app package.** Use the
direct Teams Developer Portal authentication-registration route and paste its
reference into the FCC form. Do not create an agent just to obtain an app ID.

`mcp-auth-registration-schema`, `mcp-auth-registration-plan` and
`mcp-auth-registration-bundle` prepare shared SSO/custom OAuth settings, PKCE or
versioned Key Vault credential references, and FCC/plugin reference handoffs.
FCC can import this exact descriptor-bound metadata. Separate
`mcp-auth-execution-*` / `mcp-auth-execute` commands implement **Linux-only**
private ATK sign-in and SSO/OAuth registration, with independent phase approvals,
versioned Key Vault secret retrieval and durable no-replay reservations.
Real Linux/ATK registration is **not yet qualified**; Windows/macOS execution
is refused. Results remain `created-unverified`. Consent, FCC submission and
plugin publication are not automated. See [auth registration](docs/auth-registration.md).

For explicitly selected tenant-only Entra SSO with `AnyApp`, execution config
can opt into `allowAnyAppValidationPlaceholder`. This handles ATK's unused
app-ID validation argument without creating an app or changing restrictions
later. Plans disclose the placeholder; `SpecificApp` still requires a real app
ID. The option remains Linux-only and live qualification is still outstanding.

Linux/Docker is **not a general toolkit prerequisite**. Windows users can
generate configurations and prepare FCC handoffs with manually supplied auth
registration IDs. Only the separate automated auth-registration executor
currently requires Linux; a container is not required. The Windows-first
isolation precheck did not establish a safe same-user broker/credential-store
boundary, so that guard remains in place.

For a separately requested native Windows app/plugin workflow using an existing WIQD project,
`mcp-auth-wiqd-schema`, `mcp-auth-wiqd-plan` and `mcp-auth-wiqd-bundle` export
reviewed SSO/PKCE action data, PowerShell-safe operator commands and exact
registration-ID return mappings. **You run WIQD yourself** with its normal
account picker; the toolkit never starts WIQD, edits its project or transfers
credentials. WIQD provisioning can affect the whole app and needs its own full
lifecycle review. This is a user-managed handoff, not a new isolated native auth
executor. See [the Windows handoff](docs/auth-registration.md#user-managed-wiqd-windows-handoff).

MIT; original attribution is retained in [LICENSE](LICENSE). Dependency notices
are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
