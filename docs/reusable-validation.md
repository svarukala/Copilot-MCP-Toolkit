# Resumable existing-deployment validation

The `mcp-validation-*` commands let an agent drive a repeatable validation
without asking the owner to remember or rerun every command. Version 1 supports
an **existing direct Container Apps deployment** with its sealed toolkit source
and matching Entra endpoint reference. It does not create infrastructure.
Use the same pinned engine/build and private workspace across sessions.

| Step | Toolkit does | Pauses for |
| --- | --- | --- |
| Local integrity | Checks sealed source/runtime, reference origin, optional matched release, retained history and diagnosis | Exact local start approval |
| Deployment prerequisite | Reuses operator-journal findings or saves bounded checkpoints | Owner confirms actual deployment/readiness; API-key backend also needs owner-reported secret resolution |
| Discovery and proof | Runs existing MCP discovery, presents a new one-call proof plan, checks an optional same-call result assertion | Exact phase approval, sign-in and **separate** exact proof approval |
| FCC acceptance, if selected | Records registration, authorization, save, admin readiness, audience, consumer call and read-only UI findings | Human/provider actions or explicit deferrals; these are not independently verified |
| Closeout | Writes append-only reports and a separately reviewed existing offline HTML/source handover | Exact private export approval |

The runner does not automate Docker/build/feed installation, Azure readback or
deployment, role changes, Key Vault resolution/rotation, auth registration,
negative caller tests, FCC submission or UI checks. Those remain separately
reviewed operations. It does not grant an agent blanket approval for network
calls. [The acceptance checklist](validation-readiness.md) still applies.

## Prepare once

Read `mcp-validation-schema --json`. Place the following **synthetic** definition
in the private workspace, replacing paths and identities with reviewed values.
Relative project paths resolve from this definition's directory. The source,
reference, optional release and new run directory must not overlap.

```json
{
  "schemaVersion": 1,
  "scenario": "container-apps-existing-v1",
  "sourceProject": "source",
  "referenceProject": "reference",
  "consumer": "fcc",
  "privateExportReviewed": true,
  "discovery": {
    "discoveryClientId": "44444444-4444-4444-8444-444444444444",
    "expectedUserId": "55555555-5555-4555-8555-555555555555"
  },
  "proof": {
    "toolName": "get_information",
    "arguments": {},
    "safetyReview": {
      "readOnly": true,
      "reason": "Owner reviewed this fixed GET."
    },
    "resultAssertion": {
      "kind": "json-array-string-field-v1",
      "field": "name",
      "maxItems": 5,
      "maxStringLength": 40
    }
  }
}
```

Select `consumer: "none"` when FCC is outside the requested scope. Optionally
add `releaseDirectory`. The fixed recipe tools take empty arguments. Omit
`resultAssertion` unless the reviewed response actually matches that bounded
array/string shape; protocol success alone is not business correctness.
Never add an assertion by replaying a consumed proof.

```powershell
copilot-mcp mcp-validation-plan --workspace-root C:\Private\Mcp --config C:\Private\Mcp\validation.json --output C:\Private\Mcp\validation-run --summary --json
# Review the complete plan, then supply its exact approvalToken.
copilot-mcp mcp-validation-start --workspace-root C:\Private\Mcp --config C:\Private\Mcp\validation.json --output C:\Private\Mcp\validation-run --approve "<exact-start-token>" --json
```

The immutable `validation-run.json` pins build, source archive, reference origin,
release binding and selected proof/identity. It is written last at initialization.
Never overwrite a run, move it to evade its bindings or edit/reseal its records.
The input files and all outputs are private; do not commit or transcript them.

## Agent-driven continuation

Run `mcp-validation-next --workspace-root ROOT --project RUN --summary --json`.
`--project` here means the **validation run**, not the source or endpoint.
Planning and `mcp-validation-status` are read-only and do not authenticate.
The returned plan identifies exactly one phase, full child plan, required flags
and approval token. Stop on `waiting-for-owner` or `blocked`; `repeatPrompt:false`
means retain the handoff rather than repeatedly asking the same question.

After the owner approves that exact phase:

```powershell
copilot-mcp mcp-validation-run --workspace-root C:\Private\Mcp --project C:\Private\Mcp\validation-run --approve "<exact-next-token>" --allow-network --interactive --progress --json
```

Only use `--allow-network --interactive` for a planned `session` or `proof`.
Network execution requires a real terminal, not an agent's captured shell.
The agent can prepare the reviewed command; the owner runs it in a visible
terminal when the host cannot provide one. Challenges go only to stderr; never
save a transcript. During a session, discovery and separately approved proof
share one in-memory sign-in for at most 15 minutes. Never auto-answer the new
proof approval or infer it from discovery authorization.

Blank proof approval retains discovery without sending a tool call. A later
`next` reuses the valid capture and plans only proof; its new process needs its
own sign-in. Expired captures require newly reviewed discovery, not timestamp
refresh. No token/cache copying, refresh or automatic login restart occurs.
Matching completed proofs are reported as **historical** instead of called
again. Different consumed selections and unknown outcomes block execution.

## Save human checkpoints in one batch

Create a checkpoint file with one or more applicable milestones:

```json
{
  "schemaVersion": 1,
  "milestones": [{
    "name": "runtime-deployment",
    "outcome": "passed",
    "evidenceDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "note": "Owner reviewed existing revision and traffic readback."
  }, {
    "name": "admin-ready",
    "outcome": "deferred",
    "note": "Waiting for the administrator."
  }]
}
```

Use a real reviewed evidence digest, never the example value. Passed/failed
declarations require a digest; deferred findings do not. Do not include raw
logs, tokens, device codes, secrets or sensitive result data. `secret-resolution`
is applicable only to API-key recipes and records an owner statement, never
the secret. Protocol checks cannot be marked passed by a checkpoint.

```powershell
copilot-mcp mcp-validation-next --workspace-root C:\Private\Mcp --project C:\Private\Mcp\validation-run --config C:\Private\Mcp\checkpoint.json --summary --json
copilot-mcp mcp-validation-run --workspace-root C:\Private\Mcp --project C:\Private\Mcp\validation-run --config C:\Private\Mcp\checkpoint.json --approve "<exact-checkpoint-token>" --json
```

No network/interactive flags accompany a local checkpoint. Newer operator
findings supersede older validation declarations and vice versa, preserving
both histories. A waiting source operator journal still needs its existing
exact `mcp-operator-*` resume; a validation checkpoint does not clear it.

## Reports, partial handover and interruptions

`mcp-validation-status` projects local checks, selected proof, failed/pending/
deferred owner findings, consumed barriers and handover paths. JSON reports
are saved under `RUN\reports` after each recorded step. No raw provider errors,
results, authentication caches or challenges are added. Reports distinguish
control-flow `status` from acceptance `outcome`; even
`passed-with-owner-and-historical-evidence` is **not** fresh live readiness.

`next` proposes handover after checks are recorded. To export an incomplete
snapshot, use `next --phase handover`, then `run --phase handover` with its exact
approval and no network flags. It writes a new offline handover directory,
preserves pending/failed/deferred evidence, and includes the validation outcome
and report digest in its operations note. Keep the separate JSON report with
the exported handover. Successful export does not turn failed validation green.

If evidence changed externally since the saved report, review `next --phase
refresh` and approve `run --phase refresh` to append a **local-only** snapshot,
then review a new export plan. This never renews evidence or clears consumption.

Run journals are bounded to 100 append-only events under an exclusive lock.
Unresolved intents, failed/unknown dispatched steps and existing reference
network locks block further live execution. Preserve locks and journals;
never delete them, create replacement references or select new output names
to evade replay barriers. An interrupted intent cannot be cleared by a
checkpoint or refresh. Use retained `mcp-status`/`mcp-diagnose` and owner
reconciliation; independent handover commands can export a separately reviewed
source snapshot when this run is blocked. Local chains are unkeyed integrity
checks, not tamper-proof attestations.

CLI exit codes: `0` for a usable plan/completed command, `2` for a retained
waiting/blocked or failed report, and `1` for invalid input/execution error.
Read the JSON state, not the exit code alone. A new session resumes the same
run with the same build and workspace; it does not restart completed steps.
