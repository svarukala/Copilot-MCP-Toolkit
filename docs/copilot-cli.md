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
