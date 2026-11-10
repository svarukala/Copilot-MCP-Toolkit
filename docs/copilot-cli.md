# GitHub Copilot CLI guidance skill

The package includes `skills/copilot-mcp/SKILL.md`. Install that directory into
either supported Copilot CLI skill location:

| Scope | Destination |
| --- | --- |
| Project-local | `<your-project>/.github/skills/copilot-mcp/SKILL.md` |
| User-local | `~/.copilot/skills/copilot-mcp/SKILL.md` |

For example, from this checkout in PowerShell (choose ONE destination):

```powershell
$destination = Join-Path $HOME '.copilot\skills\copilot-mcp'
# Or: $destination = Join-Path (Get-Location) '.github\skills\copilot-mcp'
if (Test-Path -LiteralPath $destination) { throw 'Skill destination already exists; review rather than overwrite.' }
New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
Copy-Item .\skills\copilot-mcp $destination -Recurse -ErrorAction Stop
```

When using an installed tarball, copy from
`node_modules/copilot-mcp-toolkit/skills/copilot-mcp` instead. Restart/reload
Copilot CLI as required for skill discovery. Tell the agent the explicit local
package/CLI path and intended caller-owned workspace. For example:

> Use the copilot-mcp skill and my local toolkit to review this REST definition.
> Generate a standalone MCP bundle only. Do not sign in or deploy.

The skill calls the same `copilot-mcp` engine and reads its JSON contracts.
It does not contain a duplicate implementation, install cloud tools, register
generated servers in the host, provide a stdio MCP facade, or grant permissions.
Host approval policy still applies. If access is denied, stop rather than
switching tools to bypass the denial. Do not pass API keys/tokens as prompts.

Before validating a new toolkit build, compare the explicit engine's
`capabilities --json` build ID and shipped skill hash with the approved
candidate. A copied skill is not updated when Git changes or a package is
reinstalled. Review a mismatched copy rather than silently replacing it; use
[the candidate checklist](validation-readiness.md#freeze-the-candidate).

## Conversational API discovery and setup

For conversational API discovery instead of manual recipe editing, use the
[documentation-first skill flow](../skills/copilot-mcp/references/api-discovery.md).
Start Copilot in an existing private workspace outside this repository and
identify the explicit toolkit path (or load its installed matching skill):

```text
Read skills\copilot-mcp\SKILL.md from my specified toolkit installation.
Assess the API described in my local OpenAPI file for my stated use case.
Read documentation only; do not probe the API.
Check the current toolkit's compatibility, explain gaps, and help prepare
the configuration for review rather than asking me to edit a template.
Do not sign in, access secrets, build, deploy or call the API.
```

Supply the actual toolkit path, documentation URL/file and desired outcome.
The agent asks for missing decisions one at a time, distinguishes full support
from a narrower alternative, and prepares private input files with local-write
approval. Generation still uses the exact reviewed toolkit plan. An optional
handoff prompt carries facts and open questions, never execution authority.
This is shipped guidance, not a new API-discovery CLI command or proof of live
provider compatibility. Hosting supports bounded declared query arguments, not
arbitrary operations or new backend authentication. Copy the entire skill directory, including
`references`, when installing; existing installed copies are not auto-updated.

## Interactive New / Resume setup

For a human-operated terminal, run `node .\bin\copilot-mcp.js` or append `init`.
No pre-authored toolkit configuration is required for the APIM or existing-server
choices under **New**. Hosting source choices require a prepared private recipe
JSON file.

```text
1. Start a new MCP setup
2. Review an existing setup or test run (no actions)
3. Review a configuration file (advanced)
4. Show all CLI commands
5. Exit without changes
```

The new-setup menu lists all supported hosting families:

```text
1. REST API -> MCP with Azure API Management (no server code)
2. Connect to an existing MCP server (directly or through APIM)
3. REST API -> MCP on Azure Container Apps (recipe file)
4. REST API -> MCP on Container Apps behind APIM (recipe file)
5. REST API -> MCP on Azure App Service (recipe file)
6. REST API -> MCP on Azure Functions (preview; recipe file)
7. Cancel without writing
```

Every menu starts numbering at 1. APIM and existing-server setup then ask about
authentication separately:

| Source | Guided choices |
| --- | --- |
| REST API | Anonymous, API key through Key Vault, same-resource Entra delegated passthrough, or existing APIM system-managed-identity application access |
| Existing MCP server | Direct anonymous/Entra reference, API-key APIM proxy v2, or explicitly reference-only third-party OAuth |

For hosting source, copy the matching synthetic recipe from `examples/mcp` to
your private workspace and replace its example identities, resource choices
and backend/tool settings **manually in a text editor**. The wizard does not
copy/edit the file or look up Azure IDs. It prints the full source/destination
paths, an optional non-overwriting PowerShell copy command, a host-specific field
checklist and where to find the IDs. The no-auth and API-key template names and
full source paths appear **before** the workspace-folder question; destination
instructions follow once the workspace is known. Enter the full path of the saved, edited
JSON file without surrounding quotes, not the workspace folder or a relative
filename. See the [recipe preparation guide](hosting-recipes.md#preparing-a-recipe-for-the-terminal-wizard).
The wizard points to the matching example and
validates that the file matches your selected host. All four recipes support
Entra caller sign-in and fixed-path, explicitly reviewed read-only GETs, with an
anonymous or Key Vault API-key backend. Direct/gateway ACA additionally accepts
prepared explicit [OAuth/OBO pilot](backend-oauth.md) recipes with parameter-free
GETs; the wizard does not author those auth settings field by field. Hosts do
not inherit APIM's broader authentication or operation choices. See [hosting recipes](hosting-recipes.md)
for required existing infrastructure, permissions and container build pins.
Declared inline query arguments and date-range rules can be supplied in the
recipe; see [query arguments](hosting-recipes.md#query-arguments-and-date-ranges).
The wizard still takes a prepared file rather than authoring these fields.
No key value or authentication cache is imported.

Before the setup choices, the wizard explains **REST API security separately
from MCP caller sign-in**. Native APIM supports no auth, Key Vault API keys and
limited Entra passthrough/managed-identity modes. The four generated hosting
profiles share no-auth/API-key REST support; their Entra caller settings protect
the MCP endpoint, not the backend. ACA-only OAuth/OBO pilots require their own
explicit backend configuration, whether direct or behind APIM. App Service and
Functions reject those pilots. Basic/username-password REST authentication is
not implemented. Pilot hosting is separately reviewed and manual, not supported
by the bounded execution/host-execution runners.
See the [security matrix](hosting-recipes.md#rest-api-security-versus-mcp-caller-sign-in).

After you choose a new source directory, the wizard shows the full configuration,
generated filenames, limitations and exact local-write approval token. Saving
requires explicit confirmation, with Cancel first. It reuses
`mcp-hosting-plan/create` and then shows `mcp-recipe-source-plan`; it does not
install dependencies, build images, deploy, test or export an HTML report.
A changed recipe or existing destination is rejected rather than silently
adopted or overwritten. Functions is explicitly marked preview.

The native APIM REST choice labels third-party OAuth unsupported on that route
and exits without writing, pointing to the separate ACA pilot guide.
Existing OAuth MCP references do not implement provider login, discovery or
runtime proof. Experimental proxy v3 remains an explicit advanced-definition
opt-in, not an automatic fallback.

For REST, choose one fixed HTTPS GET endpoint with no query/body/arguments, or
import a local OpenAPI 3.0.x JSON file inside the workspace (at most 1 MiB).
The simple GET path creates the minimal OpenAPI definition locally; it does not
fetch or infer a response schema. Import lists operation IDs and asks which to
expose. Query parameters, dynamic routes and other operations need an explicit
OpenAPI definition; generation does not imply eligibility for native proof.

Use an existing private workspace **outside the toolkit checkout** and a new
project directory beneath it. APIM setup asks **existing or new APIM first**, then
Key Vault only for API-key backends, then the resource group. Only after these
choices does it ask for tenant/subscription IDs and the remaining details.
Existing resources require full Resource IDs; new resources need names, from which
the toolkit constructs full IDs under your selected subscription/group for review.
Entra also requires reviewed caller/resource-app metadata. No resource inventory or identity
lookup runs. New APIM also asks for region, publisher and SKU; cost is not quoted.
For Entra, if app IDs or permissions are unknown, cancel and complete the separately
reviewed app-setup/owner steps rather than inventing values.

An anonymous REST backend gets a separate **caller access** question: Entra
(the default) or public anonymous. Public requires explicit public-data/read-only
declarations and a request budget/window, skips all Entra app/client questions,
and accepts only fixed parameter-free GETs. Both MCP and backing REST routes
are public; Azure identity remains required for management. See
[public APIM limits](scenarios.md#public-anonymous-apim).
API-key prompts accept a versionless Key
Vault reference and header/query name, never a key value. Managed identity
requires an existing APIM system principal and exact backend role metadata;
the wizard does not grant that role.

For APIM/reference setup, the final question is
**"Save these setup files to the folder shown above?"**
The review displays the full definition, files, destination, limitations and
generation digest (the exact approval reference, not something to type into the
answer). Cancel is the first choice. Explicit confirmation writes
the same engine's new bundle (`mcp-definition.json`, `mcp-server.json`, and
`infra` for APIM). It never overwrites existing destinations. Ctrl+C before
creation writes nothing; an interruption during creation may leave a partial
bundle, which must be preserved and inspected, not overwritten or auto-retried.
The CLI then shows the local Resume report; a blocked next step does not undo
the local bundle or mean deployment succeeded.

**Review an existing setup or test run** asks which type of folder to inspect:

| Saved work | Identifying file | Local command |
| --- | --- | --- |
| APIM setup or existing-server connection | `mcp-server.json` | `mcp-resume` |
| Hosting source project | `recipe-manifest.json` | `mcp-recipe-source-plan` |
| End-to-end execution run | `execution.json` | `mcp-execution-status` |
| Step-by-step validation run | `validation-run.json` | `mcp-validation-status` |

Select the actual project/run folder, not its release archive. Reviewing does
not resume execution or renew an expired/consumed approval.

**Review a configuration file** offers APIM/reference definitions (including
explicit experimental proxy profiles), hosting recipes, end-to-end execution
plans, Container Apps infrastructure plans and APIM resource selection.
Plans do not start runs or write their proposed output. **Show all CLI commands**
opens help for operations not run by the menu, including sign-in, deployment,
FCC/WIQD handoffs and HTML handover export.

These review menus remain local-only. All sign-in, app changes,
deployment, discovery, proof and optional FCC onboarding remain separately
reviewed operations. The wizard does not submit an FCC or refresh consumed proof.

When working **through GitHub Copilot CLI**, use the skill and explicit JSON
commands instead of starting a nested interactive prompt. The agent can collect
the same inputs conversationally and call plan/create/resume with approvals.
The skill provides operational instructions; repository `AGENTS.md` and historical
handoffs apply to continued toolkit development, not every ordinary demo setup.

The skill asks one plain-language question at a time, with a short explanation
of where to find the requested value. It does not mix real Azure configuration
with a "placeholder-only draft" choice; fictional examples are a separate,
explicit user request, not a fallback for missing IDs.

After each successful APIM/reference phase, the agent uses the local Resume
report to explain the actual next action and offer it for review. SDK source
uses `mcp-recipe-source-plan` and its operator journal instead; after deployment,
its separately created endpoint reference can use discovery/proof Resume.
See [project routing](validation-readiness.md#choose-the-correct-project-at-each-step).
For example, a read-only check
finishing should lead to a clear next-step question, not a dead end that requires
the user to type "let's deploy". Sign-in, inspection, resource creation, gateway
deployment and endpoint calls still require separate exact approvals. A plan-only
or local-only instruction remains a stopping boundary; the agent can offer to
review the next step but must not execute it automatically. This is conversational
skill guidance, not an unattended deployment loop added to the terminal wizard.
