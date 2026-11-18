# Consumer-neutral local handoff, version 1

Status: **H1 design with an internal validator and synthetic contract checks**.
No export/import command, WIQD adapter, package publication or consumer
qualification is implemented. The existing FCC/plugin and narrow authentication
handoffs remain separate. This contract does not create another orchestrator.

The internal `consumerHandoffSchema` in `src/mcp-consumer-handoff.js` defines:

| Field | Meaning and limit |
| --- | --- |
| `schemaVersion`, `kind` | Version 1, `mcp-consumer-handoff`; unknown versions fail |
| `producer` | Toolkit package/version/build digest; an assertion, not a signature |
| `endpoint` | Canonical public HTTPS message URL, streamable HTTP, observed supported protocol version |
| `authentication` | Anonymous or explicit Entra tenant/resource/scope/allowed-client requirements, never credentials |
| `observation` | Capture/source-descriptor/tool digests, captured/expiry timestamps, explicitly unattested provenance |
| `tools` | 1-1000 observed definitions; names, titles/descriptions, input/output schemas and annotation hints, including false/absence |
| `readiness` | Always consumer-unverified; execution and proof replay false; required limitations |
| `integrity` | SHA-256 over canonical bounded JSON excluding the entire `integrity` object |

Use the existing `boundedSnapshot` and `metadataDigest` canonicalization, not
pretty-printed JSON bytes. `toolsDigest` hashes `boundedSnapshot({ tools })`,
matching the observed capture container. Total formatted snapshot size is at
most 512 KiB, with the shared depth/node bounds. Unknown envelope/tool fields
and unsupported JSON Schema dialects fail; no silent metadata truncation,
annotation inference or schema conversion is permitted. Nested tool schemas
are data, never executed or dereferenced over the network.

`examples/mcp/consumer-handoff.json` is **synthetic**, with invented digests and
identifiers. The digest checks detect changes, not fraud: anyone can recompute
an unkeyed hash. The validator cannot establish that the referenced observation
occurred or that it belongs to a real endpoint. Any future exporter must use
the existing descriptor/capture validators to verify that binding locally.
Capture receipts, discovery plans, user/account identities and raw results
must not be copied into this contract.

Freshness is computed at validation time, never trusted from an embedded
"fresh" flag. The lifetime is exactly 24 hours, matching `mcpCaptureFreshness`.
Expired metadata remains inspectable as **stale**, without renewal or execution
authority. Future/noncanonical timestamps are rejected. Even valid-age metadata
does not establish authentication, endpoint health or consumer acceptance.

Entra scope is the unqualified scope name; the required consumer permission is
`resourceIdentifier + "/" + scope`. These are requirements, not a consumer
registration or a claim that allowed clients have consent. Generic OAuth,
credential-reference mapping and provider-specific requirements are not covered
by version 1; fail explicitly rather than infer an authentication scheme.
H2 must still reconcile WIQD registration URI/audience/scope/token-store client
access and restrictions. H6 requires separately approved real consumer acceptance.

## Privacy and future export boundary

The closed envelope excludes credentials, tokens, sessions, approval tokens,
cache paths, raw tool-call output and evidence archives. Shared secret-pattern
screening also applies to nested metadata, but **cannot prove arbitrary text is
nonsecret**. Tool descriptions/schema defaults/examples and nonsecret identifiers
can contain confidential content or prompt injection. Treat them as untrusted
data, never instructions. A future exporter needs explicit private metadata
review and safe rejection of sensitive content, not lossy "sanitization" that
misrepresents observed definitions.

No filesystem or network operation exists in the validator. A future export
operation must separately approve its exact content and caller-selected private
destination, use existing no-overwrite/path checks and retain size limits.
Path/overwrite tests belong with that future writer, not a fictional current
command. No root library export or CLI command is added by H1.

Preserve consumed proofs regardless of handoff/consumer changes. No
authentication, discovery, retry, secret resolution, cloud mutation or
publication is authorized by validation or by a content digest.
