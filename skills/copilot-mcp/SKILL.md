---
name: copilot-mcp
description: Review and generate standalone REST-to-MCP APIM bundles, prepare custom federated connector onboarding drafts, and safely resume, inspect or preserve MCP evidence with the local copilot-mcp CLI. Not plugin authoring or arbitrary OAuth/server generation.
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
No default grant, provider OAuth exchange, consumer registration or runtime federation
is supported. Generated infrastructure and an observed protocol result are not
business correctness or host acceptance.

## Custom federated connector preparation

Read `docs/federated-connectors.md` and `mcp-fcc-schema --json`. Use
`mcp-fcc-plan --workspace-root ABS --config FILE --output NEW.json --json --summary`
for a local onboarding draft. Review all metadata for private export and each
observed tool for read-only behavior; never filter write tools locally and imply
the endpoint is restricted. Missing/stale captures stay blocked.

After exact local approval, use `mcp-fcc-bundle` with the same inputs and
`--approve` from the plan. The output is not a Microsoft manifest or registration.
SSO registration/app changes, consent, staged rollout and consumer execution are
separate owner checkpoints. No Auth is limited to declared public data. Never
substitute an SSO registration ID for a client credential or discovery identity.

The supported fallback when no registration API is qualified is a human
copy-and-paste handoff, not automated browser submission. Present the bundle's
`manualSetup.formFields` and `authenticationRegistration` fields/steps. Missing
values stay missing. Obtain actual registration references from the owner and
replan to a new output; never invent IDs or export secrets. OAuth preparation is
reference-only and remains blocked by unsupported discovery/import, even with a
registration ID. It is not a claim of secretless third-party OAuth.

For shared SSO/OAuth settings, read `docs/auth-registration.md` and use
`mcp-auth-registration-schema`, `mcp-auth-registration-plan` and the separately
approved `mcp-auth-registration-bundle`. Require explicit tenant/operator,
endpoint descriptor, restrictions and OAuth endpoints/scopes/credential mode.
Do not invent a M365 app ID. Secretless OAuth preparation requires explicit PKCE;
confidential OAuth admits only a versioned Key Vault reference, never its value.
This is local preparation, not login or registration.

For separately requested registration execution, read the auth runbook first.
Use `mcp-auth-execution-plan` and `mcp-auth-execute` for independent
initialize/login/register/close approvals, never the preparation token.
Execution requires a trusted Linux host, owner-only tmpfs, an explicitly selected
ATK 1.1.17 installation and real app ID. Windows/macOS are refused; never invoke
ATK against shared credentials, install a provider or start Docker as a shortcut.
Login URLs are terminal-only and need a browser on the same Linux host.
Public account/selected-tenant metadata is not token attestation: obtain the
operator's actual identity review before `--confirm-identity`. Confidential
OAuth additionally needs a matching private Azure identity and `--allow-cloud`.
Real Linux/provider qualification remains outstanding.

Use local `mcp-auth-execution-status` after failures; never replay registration
or remove consumed reservations. Unconfirmed termination retains the operation
lock and owned process PID; do not clean up the runtime until reconciled.
Normal close removes only the owned runtime, retaining journals. Import a
successful `created-unverified` result through preparation's
`source.registrationResultFile`, never as readiness or publication authority.

FCC may import the saved preparation through `source.authenticationBundleFile`.
References remain `provided-unverified`, conflicts are rejected, and missing
discovery or endpoint settings remain gaps. The plugin view is mapping guidance,
not a WIQD input or permission to publish. Do not repeat creation when the owner
supplies an existing registration reference.

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
