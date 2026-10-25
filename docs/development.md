# Development and offline checks

Use Node.js 22+ and the committed lock. Runtime dependencies are exact:
`@azure/msal-node 7.0.0`, `@modelcontextprotocol/sdk 1.32.1`, `ajv 8.20.0`,
`ajv-formats 3.0.1`, `fflate 0.8.3`, `jose 6.2.12`.
Development tooling: `typescript 5.9.3`, `esbuild 0.25.10`.
No YAML runtime, Cowork package or plugin authoring dependency is required.

`.npmrc` uses `https://packagefeedproxy.microsoft.io/npm/`. The inherited lock
retains exact tarball URLs/integrities for the approved mirror, with the new root
package/bin identity and YAML removed. This is not evidence of public npm registry
reproducibility. Do not bypass proxy/TLS/feed policy, silently fall back to public
npm, publish to npm, or perform a global install to make validation pass.
For an explicit, organization-permitted public npm setup in a separate checkout,
follow [the public npm installation guide](public-npm-setup.md). It changes only
registry/download locations and retains pinned versions and integrity hashes;
the repository's default feed and lockfile remain unchanged.

```powershell
npm ci --offline --ignore-scripts --no-audit --fund=false
node .\scripts\update-assets.mjs
npm run validate
npm pack --offline --ignore-scripts
```

Only update the asset inventory after intentional source/docs/skill/example
changes. Packaged runtime and fresh-consumer tests must resolve entirely from
the target package and its declared dependencies, never the originating source.
Tests use synthetic identities, temporary ignored projects and injected transports/
Azure runners. No environment credentials, live provider calls or cloud resource
creation are part of tests. Some packed checks spawn the local Node/npm executables;
diagnosis tests independently deny network/process creation within the diagnosed
runtime. Do not interpret offline simulation as service compatibility proof.

`npm run validate` first checks inventory freshness without modifying it, then
parses all source/CLI/maintenance JavaScript, checks public types and runs the
full offline suite. It installs nothing. Do not edit shipped assets while the
suite is running: tests bind their exact content digest. The CI workflow runs
this gate on Windows/Linux with Node 22/24, after a separate locked restore from
the repository-approved feed; no cloud credentials or live provider tests are
configured. Do not replace feed failures with a public-registry fallback.
Use [validation readiness](validation-readiness.md) to pin the checkout/package/
skill baseline and record separate platform and consumer acceptance.

## Container Apps recipe development

`src/mcp-container-apps.js` is the internal CLI generator; it is not a new root
library export. `src/recipes/container-apps/` contains the standalone runtime
source and its narrower dependency manifest/lock. Keep the four shared runtime
dependency versions aligned with the root manifest. Do not install a nested
`node_modules` under the shipped recipe assets. When changing its manifest,
update only its lock with `npm install --package-lock-only --ignore-scripts
--no-audit --fund=false --prefix src\recipes\container-apps` using the approved
registry. Runtime installation/build remains a separate operator step.

Hosting inputs may explicitly select `npmRegistryUrl` before generation.
Omission retains the historical public-npm default. Generated runtime locks,
npm configuration and container builds must use that reviewed feed while
preserving versions and integrities; existing sealed projects are not rewritten.
Generation fetches no packages. The repository's own registry remains unchanged.

Targeted coverage is `node --test test\container-apps.test.js test\package.test.js
test\cli-feedback.test.js test\independence.test.js`. It uses the actual MCP SDK,
in-memory MCP transport, synthetic local signing keys, and loopback HTTP with
injected backend/JWKS behavior. No real Entra, Azure or provider calls occur.
The package test installs the generated server independently from the local
cache and loads its own runtime with external networking denied. A separate
timeout check waits for the real ten-second backend deadline.

Keep temporary output under `.test-output` and remove only the exact test-owned
subdirectory. Never commit that directory, recovery archives, project evidence or
auth state. Preserve all upstream license notices when bundling dependency code;
normal npm tarballs do not embed node_modules.
