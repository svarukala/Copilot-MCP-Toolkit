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

## Interactive New / Resume setup

For a human-operated terminal, run `node .\bin\copilot-mcp.js` or append `init`.
No pre-authored toolkit configuration is required for **New**.

```text
1. Start a new MCP setup
2. Resume an existing setup (review only)
3. Advanced: review an existing definition or resource choices
4. Exit without changes
```

New separates **source type** from **source authentication**:

This wizard generates native APIM bundles and existing-MCP references.
Container Apps, App Service and Functions SDK source generation use the
`mcp-hosting-*` commands or the skill's [hosting journey](hosting-recipes.md),
not this wizard. SDK source/release folders cannot be passed to APIM Resume.

| Source | Guided choices |
| --- | --- |
| REST API | Anonymous, API key through Key Vault, same-resource Entra delegated passthrough, or existing APIM system-managed-identity application access |
| Existing MCP server | Direct anonymous/Entra reference, API-key APIM proxy v2, or explicitly reference-only third-party OAuth |

Third-party OAuth for REST is labeled unsupported and exits without writing.
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

The final question is **"Save these setup files to the folder shown above?"**
The review displays the full definition, files, destination, limitations and
generation digest (the exact approval reference, not something to type into the
answer). Cancel is the first choice. Explicit confirmation writes
the same engine's new bundle (`mcp-definition.json`, `mcp-server.json`, and
`infra` for APIM). It never overwrites existing destinations. Ctrl+C before
creation writes nothing; an interruption during creation may leave a partial
bundle, which must be preserved and inspected, not overwritten or auto-retried.
The CLI then shows the local Resume report; a blocked next step does not undo
the local bundle or mean deployment succeeded.

Resume and Advanced retain their review-only behavior. All sign-in, app changes,
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
