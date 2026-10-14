# Bounded library API

Import `copilot-mcp-toolkit` as ESM; TypeScript declarations are shipped at the
package root export. Node.js 22 or newer is required.

```js
import {
  prepareMcpServer, createMcpServerProject, getMcpServerInputSchema,
  prepareRestToolDocument, compareRestCapture, getLibraryInfo,
} from 'copilot-mcp-toolkit';

const review = await prepareMcpServer(definition);
// Host presents the complete review and obtains approval for this exact content.
const result = await createMcpServerProject(review, {
  workspaceRoot: absoluteExistingWorkspace,
  projectDir: absoluteNewChildDirectory,
});
```

Compilation is local and pure. The writer revalidates the exact prepared review
and refuses overwrite/path escapes; host approval UX is the host's responsibility.
Descriptor/schema validation, bounded GET/query authoring and conservative REST/
capture comparison are exposed without plugin packaging.

The root also exposes `planMcpDiscovery`, `discoverMcpTools`,
`validateMcpObservedCapture`, `planMcpReadOnlyProof`, `runMcpReadOnlyProof`,
their contract versions, `anonymousMcpLimits`, and `McpToolkitError`. Network
calls require exact reviewed plans and literal `allowNetwork: true`. There are no
public transport/authentication injection parameters. **Library-only hosts own
durable approval/no-replay storage**; use the project CLI journey for toolkit-
managed immutable journals, current identity guards, first-call assertions and
cross-attempt no-replay.

Cloud provisioning, app setup, resume, first-call execution, rejection, archive
recovery and diagnosis are supported through the CLI, not exported wholesale as
stable library internals. Package `exports` blocks importing internal subpaths as
public APIs. No Cowork consumer, skill-authoring or plugin API is exported.

`getLibraryInfo()` hashes the explicit installed runtime/docs/skill/example
inventory; it is a build identity, not an attestation or source-commit claim.
Source provenance hashes describe original inputs, not current runtime bytes.
The package includes CLI modules in its inventory even though the public library
does not export cloud executors.
