# FCC presentation rehearsal

Two separate demonstrations are possible:

| Track | What you can show | What it does not establish |
| --- | --- | --- |
| Offline preparation | Create an MCP reference or APIM bundle, review FCC metadata/gaps, write a private onboarding draft | No running endpoint, PubMed call, SSO sign-in or Microsoft 365 registration |
| Live consumer demonstration | A separately deployed read-only server, approved SSO registration and staged Copilot usage | Requires real inputs, exact approvals and fresh consumer evidence; not completed by this repository |

Use the offline track as a presentation fallback. Do not relabel it as a live
PubMed/Microsoft 365 result. Read [FCC module](federated-connectors.md) first.

## Offline track: existing MCP server

Run from this repository or an unpacked/installed package directory. Dependencies
must already be available. No installation, network, tenant sign-in, provider call
or cloud action is performed by these commands.

All shipped values are synthetic. Use a new, caller-selected private directory.
The example below uses `.test-output` for a disposable local rehearsal in the
checkout; real connector files should be in a private workspace outside Git.

```powershell
$ErrorActionPreference = 'Stop'
$package = (Get-Location).Path
$cli = Join-Path $package 'bin\copilot-mcp.js'
$workspace = Join-Path $package ('.test-output\fcc-demo-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workspace -ErrorAction Stop | Out-Null
Copy-Item (Join-Path $package 'examples\fcc\existing-literature-entra.json') (Join-Path $workspace 'definition.json')
Copy-Item (Join-Path $package 'examples\fcc\onboarding.json') (Join-Path $workspace 'onboarding.json')

$definition = Join-Path $workspace 'definition.json'
$config = Join-Path $workspace 'onboarding.json'
$server = Join-Path $workspace 'server'
$output = Join-Path $workspace 'prepared.json'

$raw = node $cli mcp-server-plan --workspace-root $workspace --config $definition --json --summary
if ($LASTEXITCODE -ne 0) { throw 'MCP plan failed; inspect JSON output.' }
$serverPlan = $raw | ConvertFrom-Json
$serverPlan.descriptor | Format-List
```

After reviewing the local generation operation, create the reference:

```powershell
node $cli mcp-server-create --workspace-root $workspace --config $definition --output $server --approve $serverPlan.reviewDigest --json
if ($LASTEXITCODE -ne 0) { throw 'MCP reference creation failed.' }

$raw = node $cli mcp-fcc-plan --workspace-root $workspace --config $config --output $output --json --summary
if ($LASTEXITCODE -ne 0) { throw 'FCC plan failed.' }
$fcc = $raw | ConvertFrom-Json
$fcc.bundle.readiness.gaps | Format-Table code, message -Wrap
$fcc.bundle | ConvertTo-Json -Depth 64
```

Expected gaps are `CAPTURE_MISSING`, `SSO_REGISTRATION_MISSING`, and
`SSO_AUDIENCE_MISSING`. `tools` is empty, because proposed search/fetch reviews
are not an observed capture. No tool definitions are invented.

After reviewing all exported metadata and the exact new destination:

```powershell
node $cli mcp-fcc-bundle --workspace-root $workspace --config $config --output $output --approve $fcc.approvalToken --json
if ($LASTEXITCODE -ne 0) { throw 'FCC bundle was not confirmed written.' }
Get-Content -Raw $output | ConvertFrom-Json | Select-Object kind, status, readiness, evidence
```

The file is a review aid, not an uploadable Microsoft manifest. An existing
output is never overwritten; choose a new file and review another plan.

## Optional offline track: REST-to-APIM generation

In a **new rehearsal workspace**, use `examples\fcc\literature-rest.json` instead
of `existing-literature-entra.json` as `definition.json`. The remaining commands
are unchanged. The result includes APIM templates and a
`generated-not-deployed` descriptor before FCC planning.

This OpenAPI describes a synthetic public-literature backend, **not** the NCBI
E-utilities contract. It does not implement PubMed search aggregation or abstract
parsing. The reference's Python server can instead be treated as an existing MCP
endpoint after independent deployment review. Do not deploy synthetic resources.

The two-argument search/fetch demo also does not broaden the toolkit's narrow
native GET proof profiles. Successful generation is not proof eligibility.

## Transition to a live PubMed-style demonstration

Use the [reference project](https://github.com/madsd/m365-custom-connector) as an
architectural example, not an automatically approved deployment. No reference
code was copied. Before planning live effects, select and review:

| Input / gate | Required decision |
| --- | --- |
| Server | Exact deployed HTTPS MCP endpoint and owner; review read-only tools, ingress restrictions, provider limits and logging |
| Identity | Explicit tenant, resource app, scope and allowed clients; Azure subscription/account only if Azure changes are needed |
| SSO registration | Owner-created Developer Portal auth config, Application ID URI and registration ID; scope/org/app restrictions |
| Data access | Public PubMed literature versus protected data; confirm backend permissions, not only caller authentication |
| Tool discovery | Dedicated operator-owned public discovery client and expected user ID, distinct from the token-store service client |
| Consumer rollout | Authorized admin and a small explicit test-user/group audience; no tenant-wide default |
| Live purpose | New bounded discovery/consumer purpose and budget; do not recycle Tavily or other consumed proofs |

After separately approved discovery produces an original capture:

1. Set `source.captureFile` in the private FCC config to that capture's path,
   relative to the config file, within the selected workspace.
2. Review all actual observed tools. Replace the proposed reviews with exactly
   one read-only review for each tool. Do not alter or subset the capture.
3. Supply the actual SSO registration ID and generated Application ID URI, and
   review any reported mismatch against the endpoint configuration.
4. Review a new FCC plan and write a new output. Do not copy old approvals.
5. Complete manual registration using the official guide and stage the audience.
   The supplied checklist includes SSO redirect, audience and allowed-client gates.
6. Record actual consumer behavior separately: tool selection, returned records
   and citations, authorized/denied user behavior, and errors. Never infer factual
   correctness from the MCP handshake or an HTTP success response.

The reference's tool annotations must be observed rather than assumed. A
read-only safety review accepted for FCC metadata does not automatically qualify
an unannotated external tool for the toolkit's stricter proof executor.

## Presentation sequence

### Anonymous existing-MCP pilot

For a reviewed public endpoint, use the anonymous descriptor and
`authentication: { "type": "none" }` with public-data justification. No resource
app, operator discovery client or SSO registration is needed on this path.
Endpoint selection, live discovery, registration and audience still require
their separate reviews. Tenant-wide rollout is never an implicit default.

The 2026-10-15 pilot reached admin registration and enabled rollout after actual
tool discovery and private bundle writing; consumer execution is tracked
separately in [the progress tracker](progress-tracker.md). During registration:

- The admin form rejected a reserved brand word in the display name. Use an
  organization/data-source-specific name and replan the bundle to a new output
  if reviewed metadata changes; preserve the previous output.
- The connection list was initially empty after successful creation. Reconcile
  by refreshing/reopening the list and inspecting the exact custom entry before
  considering another creation attempt. The tools registry can provide a
  separate registration observation, not rollout or invocation proof.
- Verify Ready status, enabled state, audience and discovered tools in the
  connector details. A tools-registry discovery warning can differ from that
  view; record the actual observations rather than inferring endpoint failure.
- Keep any pre-enabled connector unchanged. A consumer response must identify
  the custom entry rather than relying on the same endpoint's built-in connector.

### On-stage order

1. Explain MCP endpoint preparation versus Microsoft 365 connector registration.
2. Show the nonsecret definition and local generation review.
3. Show the FCC readiness gaps and why they prevent an unsupported success claim.
4. Show the reviewed onboarding JSON and the manual SSO/rollout checkpoints.
5. Only when independently qualified, switch to the staged live consumer demo.

Keep real endpoint identities, raw results, sign-in/device prompts and approvals
off slides, source control and recordings. Use synthetic values for screenshots.

## Automated rehearsal

From the development checkout:

```powershell
node --test .\test\mcp-fcc.test.js .\test\package.test.js
```

The packed-consumer test runs both synthetic descriptor routes through the
installed CLI with runtime network and subprocess access denied. It checks the
exact expected gaps, approval handling and written output. This is offline
engineering evidence, not proof of the reference server or Microsoft 365.
