# Copilot MCP Toolkit

**Turn supported REST API operations into tools that AI assistants can use.**
Copilot MCP Toolkit helps you prepare those tools, deploy them through Azure API
Management (APIM), and check them in separately approved steps. You can also
connect to an existing Model Context Protocol (MCP) server, or generate an
[MCP servers on Container Apps, App Service or Functions](docs/hosting-recipes.md),
with APIM optional as a gateway.

Finish a hosting journey with a private [deployment handover](docs/deployment-handover.md):
two-tab offline HTML showing recorded outcomes and repeat-environment steps,
an embedded architecture diagram with editable Excalidraw source, and the
source/templates kept alongside it. Pending work and owner reports stay explicit.

MCP is a standard way for AI assistants to discover and call tools. For a financial
services demo, those tools might retrieve public exchange rates or access an
approved research service. The toolkit does not provide financial data licenses
or investment advice.

Use the guided terminal setup or work conversationally with **GitHub Copilot
CLI**. This is an experimental developer toolkit, not a turnkey production
product. The guided setup creates APIM deployment files. The separate Container
Apps recipe generates a Node.js MCP server and deployment review files, with a
narrower initial feature set. **Saving files does not deploy an endpoint or make it available in
Microsoft 365 Copilot.**

[Quick start](#quick-start) |
[FSI demo idea](#fsi-demo-idea-public-exchange-rates) |
[What is supported](#what-is-supported) |
[Disclaimer](#disclaimer-ai-generated-code-and-user-responsibility)

## Disclaimer, AI-generated code and user responsibility

**This project was developed primarily using AI-generated code.** It may contain
bugs, security vulnerabilities, incorrect assumptions or incomplete functionality.
AI assistance, included safeguards and passing tests do not guarantee accuracy,
security, reliability or suitability for production use.

**The software is provided "AS IS", without warranty of any kind**, as set out in
the [MIT License](LICENSE), including no warranty of merchantability, fitness for
a particular purpose or noninfringement. To the extent permitted by applicable
law, the authors and copyright holders disclaim liability for claims, damages
or other liability arising from the software or its use, as provided in that
license. This is not a supported product or a commitment to provide maintenance,
updates, bug fixes or service levels.

**Customers and other users must take operational ownership of their adoption.**
You are responsible for independently reviewing and testing the code, deciding
whether it meets your security and compliance requirements, and maintaining,
enhancing and fixing the version you use. You are also responsible for your
deployments, credentials, data handling, third-party permissions and cloud costs.
Do not rely on the maintainers to identify or resolve defects before using it.
"Ownership" here means responsibility for your implementation and operation,
not a transfer of copyright or a change to the MIT license.

**Contributions are encouraged.** When you identify and fix a bug or make a
useful improvement, please consider submitting a pull request with a clear
description and relevant tests so others can benefit. Do not include credentials,
private customer data or sensitive security-exploit details in public issues or
pull requests. Contributions are subject to review; acceptance or a response
within any particular timeframe is not guaranteed.

## Quick start

### 1. Check what you need

For local setup, install **Git**, **Node.js 22 or later** (with npm), and optionally
**GitHub Copilot CLI** if you want conversational guidance. The commands below
use PowerShell. Windows users do not need Linux or Docker for local setup.

For Azure deployment later, you also need an Azure subscription, permission to
use or create the selected resources, and the tools required by the
[deployment workflow](docs/cli-contract.md). Azure resources and API usage can
incur charges. Microsoft 365 onboarding additionally requires the appropriate
tenant access, licensing and administrator approvals.

### 2. Download the toolkit and install dependencies

**Using public npm instead of the Microsoft package feed?** Follow the separate
[public npm installation guide](docs/public-npm-setup.md) instead of this step,
then return to Step 3 below. It covers both the project registry and the pinned
download URLs without changing dependency versions.

Run this from a folder where you keep source code:

```powershell
git clone https://github.com/svarukala/Copilot-MCP-Toolkit.git
Set-Location .\Copilot-MCP-Toolkit
npm ci --ignore-scripts --no-audit --fund=false
node .\bin\copilot-mcp.js --help
```

**Installation prerequisite:** this checkout currently uses the package feed
`https://packagefeedproxy.microsoft.io/npm/`, including URLs in its lockfile.
Your environment must be permitted and able to access that feed. Installation
from public npm alone has not been verified. If access fails, stop and arrange
an approved dependency source with your IT team, or use the linked public npm
guide if your organization permits it. Do not disable TLS checks or bypass
network policy. If all dependencies are already cached, add `--offline`
to `npm ci`. See [dependency setup](docs/development.md).

You do not need to publish this package to npm or install it globally.

### 3. Create a separate folder for your generated projects

Keep credentials, generated files and deployment evidence out of this repository:

```powershell
$workspace = Join-Path $HOME 'mcp-work'
New-Item -ItemType Directory -Path $workspace -Force | Out-Null
$workspace
```

Save the printed path. Setup will ask for this existing workspace and a **new
project folder inside it**, such as `mcp-work\fx-demo`. Existing project folders
will not be overwritten.

### 4. Choose how you want to work

**Option A: Guided terminal setup**

From the toolkit folder, run:

```powershell
node .\bin\copilot-mcp.js
```

| Menu option | Use it to |
| --- | --- |
| Start a new MCP setup | Choose a REST API or existing MCP server and its authentication method. |
| Resume an existing setup | Review saved progress and the next required step; nothing runs automatically. |
| Advanced | Review an existing toolkit definition or change proposed Azure resource choices. |
| Exit | Leave without making changes. |

For APIM setups, choose existing or new APIM, Key Vault (only for API-key
backends), and resource group before entering their details. Existing resources
need full Resource IDs; new resources need names. Then review the files and
choose whether to save them. **This step does not sign in or deploy to Azure.**

**Option B: GitHub Copilot CLI**

From the same toolkit folder, start `copilot` and use a prompt like:

> Read `skills\copilot-mcp\SKILL.md` from this checkout and use
> `bin\copilot-mcp.js`. Help me create a new MCP setup for a REST API.
> Ask one simple question at a time. Keep generated projects in a separate
> workspace outside this repository. Prepare local files only; do not sign in,
> deploy or call the endpoint yet.

You can also [install the included skill](docs/copilot-cli.md) for use from
other folders. The skill guides the same CLI; it does not give Copilot extra
permissions. Never paste passwords, API keys or tokens into prompts.

### 5. Review the next step

After files are saved, the toolkit shows a Resume report. For an APIM setup,
the overall journey is:

| Stage | What happens |
| --- | --- |
| Prepare | Save the reviewed configuration and deployment files locally. |
| Sign in and inspect | Select your Azure account and check the intended resources, with separate approval. |
| Deploy | Review and approve the exact Azure changes, including any new resources and costs. |
| Discover and test | Separately approve listing MCP tools and any eligible test call. |
| Connect to a consumer | Follow the separate Microsoft 365 or plugin onboarding process. |

Not every source or authentication method supports every stage. Follow the
report rather than skipping prerequisites. If an operation fails or its outcome
is unclear, inspect the retained state instead of repeating it blindly.
**A successful deployment or tool listing is not proof that Cowork or another
consumer can use the endpoint.**

## FSI demo idea: public exchange rates

A simple starting point is a fixed, read-only EUR/USD reference-rate endpoint:

```text
https://api.frankfurter.dev/v2/rate/eur/usd
```

In New setup, choose **REST API > Anonymous / no authentication > One fixed GET
endpoint** and enter the URL. The toolkit generates the minimal OpenAPI
definition for that one operation; it does not fetch the endpoint during setup.
For more complex APIs, supply a local OpenAPI 3.0.x JSON file and select operations.

Backend authentication and caller access are separate choices. Keep Entra
authentication for restricted callers, or explicitly choose public anonymous
access only after confirming the data is public and the operation is read-only.
Public mode requires request limits and exposes both the MCP and backing REST
routes; it is not suitable for licensed research or private customer data.
Azure management still requires sign-in, and APIM hosting is not free.

After separate deployment, testing and consumer onboarding, a demo prompt could be:

> Retrieve the latest available EUR/USD reference rate and its date. Calculate
> the indicative USD value of EUR 100,000 and explain why a bank's settlement
> amount may differ.

This is reference data, not a real-time trading quote. This recipe is not a
claim of completed end-to-end qualification. See the
[demo runbook](docs/fcc-demo.md) and [public-access limits](docs/scenarios.md#public-anonymous-apim).
Repository examples use fictional identifiers; replace them only with explicitly
selected values for your environment.

## What is supported

| Scenario | Current boundary |
| --- | --- |
| REST API through APIM | Selected operations with supported anonymous, Key Vault API-key or limited Entra authentication patterns. Not every API can be converted. |
| Container Apps, without APIM | SDK server, Entra sign-in, reviewed fixed GETs, Docker/ARM files and reviewed release preparation. [Recipe 1](docs/container-apps-recipe.md). |
| Container Apps behind APIM | Same SDK server; APIM proxies requests rather than generating tools. Signed gateway identity prevents direct-host bypass. [Recipe 2](docs/apim-gateway-recipe.md). |
| App Service | Same container on an existing Linux Basic-or-higher plan, with managed-identity image pull. [Recipe 3](docs/app-service-recipe.md). |
| Azure Functions | SDK custom handler on Linux Flex Consumption, with managed-identity storage. **Public preview.** [Recipe 4](docs/functions-recipe.md). |
| Existing MCP server | Anonymous and Entra references with separate discovery and eligible testing. API-key proxy compatibility depends on the provider. |
| Third-party OAuth MCP | Reference and authentication-registration preparation; integrated provider login, tool discovery and runtime proof are not supported on this path. |
| Username/password MCP | Backlog only; not implemented. |
| Microsoft 365 custom federated connector (FCC) | Prepare onboarding fields and observed tool metadata. Administrator registration and consumer verification are separate. |
| Cowork plugin packaging | Separate consumer workflow; an automatic end-to-end toolkit-to-WIQD handoff is not implemented. |

For a new direct Container Apps setup, the [operator workflow](docs/hosting-recipes.md)
now includes prerequisite templates, immutable operation records, preserving-update
reviews, real-terminal handoffs and separate cost/cleanup planning. Container
Dockerfiles require reviewed builder/runtime image digests; no mutable base image
is selected automatically. These tools prepare and record work, not deploy it.
Separate [host operations](docs/hosting-recipes.md#environment-diagnostics-and-private-image-pulls)
can diagnose Docker/npm connectivity or pull an exact private image without
shared Docker login. An opt-in terminal session can reuse one in-memory sign-in
across discovery and a separately approved proof; it never skips that approval.

The four SDK hosting recipes currently generate source, deployment review files
and local release bundles. **They do not automatically deploy to Azure.** Real
hosting behavior and Copilot Read-only labels still need live validation.
All four accept anonymous or [Key Vault API-key REST backends](docs/hosting-recipes.md#api-key-backends)
with a dedicated header or reviewed query parameter and a separate secret-reading
identity. Callers still require Entra; tools remain fixed, argument-free GETs.
Use the [shared workflow](docs/hosting-recipes.md) to connect a separately
deployed endpoint to the existing discovery and FCC steps.

API keys belong in Azure Key Vault, referenced by configuration, never stored
as values in toolkit JSON. [Native Windows SSO registration](docs/auth-registration.md#native-windows-sso-user-managed-profile)
uses an explicitly reviewed normal ATK profile; Linux/WSL is optional for SSO
and remains the isolated execution option. Custom OAuth execution still uses
the Linux adapter. Neither Docker nor Linux is required for the local quick start.
Testing support is narrower than generation support. Read the
[scenario matrix](docs/scenarios.md) before choosing a production use case.

## Learn more and contribute

| Goal | Guide |
| --- | --- |
| Follow the guided setup or use Copilot CLI | [Copilot CLI guide](docs/copilot-cli.md) |
| Choose an SDK server host or APIM gateway | [Four hosting recipes](docs/hosting-recipes.md) |
| Connect through a custom federated connector | [FCC onboarding](docs/federated-connectors.md) |
| Understand sign-in and registration options | [Authentication guide](docs/auth-registration.md) |
| Use explicit commands and approvals | [CLI reference](docs/cli-contract.md) |
| See completed work, limitations and backlog | [Progress tracker](docs/progress-tracker.md) |
| Develop, test or contribute fixes | [Development guide](docs/development.md) |
| Use the library from code | [Library API](docs/api.md) |
| Continue toolkit integration development | [Handoff](docs/handoff.md) and [WIQD proposal](docs/wiqd-handoff.md) |

Contributions should include relevant tests and contain only synthetic examples,
not real customer data or credentials. Tests are offline and do not contact
Azure, Microsoft 365 or data providers. Passing them does not establish live
service compatibility.

MIT; original attribution is retained in [LICENSE](LICENSE). Dependency notices
are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
