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
project directory beneath it. APIM scenarios collect explicit tenant/subscription,
reviewed caller/resource-app metadata, and full resource IDs for new/reused
resource groups, APIM and applicable Key Vault. No resource inventory or identity
lookup runs. New APIM also asks for region, publisher and SKU; cost is not quoted.
If app IDs or permissions are unknown, cancel and complete the separately
reviewed app-setup/owner steps rather than inventing values.

Anonymous backend access does not make an APIM endpoint anonymous: generated
inbound authentication stays Entra. API-key prompts accept a versionless Key
Vault reference and header/query name, never a key value. Managed identity
requires an existing APIM system principal and exact backend role metadata;
the wizard does not grant that role.

The final review displays the full definition, files, destination, limitations
and generation digest. Cancel is the first choice. Explicit confirmation writes
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
