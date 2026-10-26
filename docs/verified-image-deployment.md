# Verified-image deployment only

`mcp-verified-image-schema/plan/run` is a **separate explicit approval**, not a
resume, repaired push receipt, adoption of an old execution grant, or generic
skip-stages switch. It reuses the guarded hosting engine's create-only ACA,
private Azure identity, bounded readback, revision readiness and health stages.
Implementation and synthetic tests do not qualify live Azure conditional-create
behavior or authorize cloud execution.

## Narrow eligibility

- Direct Container Apps only; gateway/APIM and other hosting families are rejected.
- The old host run must have passed identity, preflight, build, scan and
  network-disabled nonroot smoke, followed by a retained **unknown-no-replay push**
  result. All six sealed intent/result pairs must form the exact parent chain.
  A passed push, missing result, active parent lock or later stage intent is not
  eligible. No parent file or original target reservation is changed.
- Only OCI manifest-ID images are supported: the exact digest supplied for ACR
  must equal the image ID in the prior verified export binding and build receipt.
  Classic config-ID-only images cannot establish this correspondence and fail
  closed. No Docker inspection, build, pull, push, login or credential export occurs.
- Source manifest, old host approval, explicit existing private identity, target,
  resource limits, build/scan/smoke receipts and private scanner/SBOM/database
  files are checked locally and bound into the new approval. The scan and database
  must remain at most 24 hours old with zero HIGH/CRITICAL findings, including at
  mutation dispatch. Missing, modified, incomplete or stale evidence blocks.
- Historical source is read without regeneration or resealing. Its deployment
  template and runtime configuration must match the **current trusted compiler**.
  Historical producer IDs or generated documentation alone need not match the
  current toolkit. New approval binds the current toolkit build and exact inputs.
- The original target reservation must belong to the explicitly referenced old
  host plan. A separate atomic one-shot target claim prevents another output or
  parent from issuing a duplicate continuation. Reservations are workspace-local,
  not distributed locks or protection against unrelated cloud writers.

An immutable digest is rechecked with `az acr manifest show-metadata` using the
same private identity, bounded and without inspection retries, before creation.
The runner rechecks target absence and uses `If-None-Match=*` for PUT. Unknown
reads/writes stay consumed. The owner must retain exclusive control of target
names; there is no automatic retry, deletion, role grant or reservation takeover.

## Review and commands

Use absolute paths under the explicitly selected workspace. Config example
(synthetic placeholders; replace digests/approval with exact retained values):

```json
{
  "schemaVersion": 1,
  "oldHostOutput": "C:\\reviewed-workspace\\old-host",
  "oldHostApproval": "mcp-host-execution/sha256:<64-hex>",
  "sourceManifestDigest": "sha256:<64-hex>",
  "containerImage": "synthetic.azurecr.io/reviewed/mcp@sha256:<64-hex>",
  "azureIdentityProject": "C:\\reviewed-workspace\\identity",
  "accountName": "operator@example.com",
  "expiresAt": "<future ISO timestamp, within scan/database freshness and 24 hours>",
  "maximumMs": 900000,
  "deploymentOnlyReviewed": true,
  "resourceCeilingsReviewed": true,
  "createOnlyReviewed": true
}
```

```powershell
copilot-mcp mcp-verified-image-schema --json
copilot-mcp mcp-verified-image-plan --workspace-root C:\reviewed-workspace --project C:\reviewed-workspace\source --config C:\reviewed-workspace\deploy.json --output C:\reviewed-workspace\deployment --json
# Separately review the complete scope, effects, identity, resources and expiry.
copilot-mcp mcp-verified-image-run --workspace-root C:\reviewed-workspace --project C:\reviewed-workspace\source --config C:\reviewed-workspace\deploy.json --output C:\reviewed-workspace\deployment --approve "<exact new plan token>" --allow-local --allow-network --allow-cloud --json
```

`--allow-local` authorizes retained-evidence reads and new journals/claims only,
not Docker. Planning is offline and returns the full review scope. Run prints
parseable JSON; unknown/no-replay results have nonzero CLI exit status. No
interactive login, session choice or old authority inference is supported.

Core exposes `getVerifiedImageDeploymentSchema`, `planVerifiedImageDeployment`
and `runVerifiedImageDeployment`, with types and no public transport injection.
The dependencies used by tests exist only in the internal module.

## Result and remaining gates

Passed results provide `containerImage`, `backendOrigin`, `endpoint` and a fresh
`imageReviewFile` usable by existing recipe release/reference operations. The
new journal identifies historical registry push as unknown with the immutable
image reverified in ACR; it does not rewrite history to say that push passed.
Re-reading a passed result returns retained observations, not a fresh readiness
check. Hashes establish local consistency, not signed provenance or attestation.

No discovery, provider proof or consumer acceptance is performed or authorized.
Use the existing separately reviewed reference, discovery, proof and release
tools. Readback and health are not authentication enforcement, independent Key
Vault access, provider-key validity or rotation evidence. Resource ceilings are
not a monetary invoice cap. Failed or expired work remains consumed and requires
operator reconciliation, never another output as a retry mechanism.
