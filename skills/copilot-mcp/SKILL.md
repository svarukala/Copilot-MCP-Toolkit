---
name: copilot-mcp
description: Review and generate standalone REST-to-MCP APIM bundles, explicit existing MCP references, and safely resume, inspect or preserve their evidence with the local copilot-mcp CLI. Use for MCP toolkit scenarios, not plugin authoring or arbitrary OAuth/server generation.
---

# Copilot MCP Toolkit

Use the user's installed `copilot-mcp` bin or explicit
`node <package-path>/bin/copilot-mcp.js`. Ask for its location if unknown; do not
install globally, download a runtime or search private directories. Use the same
engine for all operations. First read `--help` and `capabilities --json` from that
installation, then its `docs/cli-contract.md` and `docs/scenarios.md` as needed.

## Review before effects

1. Confirm the scenario, explicit trusted workspace and intended local output.
   Use `schema --json` and the package's synthetic examples to prepare a nonsecret
   definition. REST supports OpenAPI 3.0.x JSON with explicit operations; mappings
   and runtime proof are narrower. Existing OAuth is reference-only.
2. Run `mcp-server-plan --config FILE --workspace-root ABS --json --summary`.
   Present the bounded operation/target, limitations and exact top-level digest.
   Only a user-approved local generation request authorizes `mcp-server-create`
   into a NEW output with that exact digest. Do not invent capture/tool metadata.
3. For existing projects, run `mcp-resume --project DIR --workspace-root ABS --json
   --summary`. Explain completed, stale, blocked and unknown layers. Execute at
   most the one proposed phase after explicit user approval of current
   `next.approval` and effect flags. Never use a nested token as outer approval.
4. Before any cloud action, obtain the user's exact tenant/subscription/account.
   Separate account-plan/switch approval from resource, app, consent and runtime
   approvals. Never use an old ambient login or clear shared caches. A distinct
   MCP public client/user is not the Azure CLI account or APIM service identity.
5. Use `--progress` only where capabilities/help support it. Keep stdout JSON and
   stderr feedback separate. Sign-in requires the user's terminal; never save,
   relay into persistent chat artifacts, log or JSON any device code/token.

Never collect keys or client secrets. Backend keys are versionless Key Vault
references; APIM managed identity reads them. Never downgrade inbound Entra.
No default grant, provider OAuth exchange, consumer registration or federation
is supported. Generated infrastructure and an observed protocol result are not
business correctness or host acceptance.

First-call Tavily result acceptance is the fixed profile on a FUTURE unused
ordinary call only. Show the same-call credit caveat and exact approved arguments.
Do not change profiles/captures or run dedicated qualification to replay consumed
proofs. Failed/inconclusive/unknown dispatched outcomes remain consumed.

## Diagnose and preserve, do not repeat

Use `mcp-diagnose` for local retained evidence; no probes, subprocess diagnosis,
cache scanning, automatic full-inspection retry or guessed network root cause.
Unresolved dispatch and locks require owner reconciliation, not deletion.
Expired evidence preserves historical outcomes but does not authorize execution.

Offer exact local `mcp-export-plan`/`mcp-export` approval before Cloud Shell loss.
Retain the returned hash independently; a same-device checkpoint is not a backup.
Inspect with `mcp-archive-inspect --archive FILE --sha256 EXTERNAL_HASH`.
Restore only after an exact restore plan to a NEW destination. Never modify
timestamps, root/identity bindings, histories or pending/lock barriers to make
restored evidence appear ready. Persistence is unknown unless declared, and
declared persistence is not verified.

Host permission denials are not toolkit permissions. Stop and report an access
block rather than changing tools or paths to bypass it. No automatic host server
registration or UI diagnosis is part of this skill.
