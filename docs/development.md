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
Every pull request, push to `main` and manual workflow run retains the complete
four-job matrix. Each job has a **90-minute outer timeout**, including dependency
restore, static checks, the entire offline suite and the unchanged-files check.
There is no fast-only replacement, scheduled-only full suite, retry or allowed
failure. Job time is per matrix entry, not total time including the queue.
The longer outer budget does not alter individual test/subprocess deadlines,
MCP request limits, approval checks, integrity validation or consumed attempts.
Use [validation readiness](validation-readiness.md) to pin the checkout/package/
skill baseline and record separate platform and consumer acceptance.

### Test scheduling and timing diagnostics

`npm test` runs ordinary test files with at most four concurrent processes (fewer
on small machines), waits for their cleanup, then runs the packed-consumer test
alone. Both phases run even if an ordinary assertion fails; either phase failing
makes the command fail. Test-name/reporter options passed after `npm test --` are
forwarded to both phases. For a targeted check, use native `node --test` with the
specific files instead of running the entire suite.
Each phase reports its elapsed seconds and actual exit status on stderr,
including on failure; stdout remains the selected Node test reporter's output.
`npm test` and `npm run validate` without filtering options remain full gates.

The 2026-11-19 unchanged baseline passed all 1,318 tests in 56.5 minutes on
Windows Node 26.13.0: ordinary tests took 52.6 minutes and the isolated packed
consumer 3.85 minutes. Static checks took another 15.51 seconds. The longest
ordinary file, `apim-modes.test.js`, took 46.0 minutes; native-proof coverage
took 35.1 minutes. These concurrent file durations are not additive wall time.
Two focused synthetic proof cases (16 tests including subtests) issued more than
553,000 `lstat` calls and 125,000 `realpath` calls while retaining project,
path, identity and evidence revalidation around simulated operations.
The investigation found repeated filesystem validation, not a long real-network
wait or package installation, as the main measured cost. It did not establish
why this host's filesystem work is slower than hosted CI.

Keeping those safety regressions and isolation intact is more important than
caching their checks or reusing consumed fixtures. No small safe test-only
optimization was demonstrated to bring this complete local gate below 45 minutes;
even the longest measured file exceeded that budget. The 90-minute budget
therefore retains the complete PR gate with roughly 30 minutes above the prior
60.4-minute local run for restore, checks and variability. It is not a performance
guarantee. The previous Node 22/24 Windows/Linux CI run passed in approximately
10-23 minutes per job; those historical measurements do not predict local Node 26
or qualify a revised workflow. Record fresh matrix results and actual timing
before declaring the current matrix reliable.

This boundary follows a reproduced Windows Node 26 contention failure, not a
production timeout relaxation. Eleven isolated concurrent copies of the direct
ACA header-key creation case all failed with `DISCOVERY_TIMEOUT`; the identical
four-process experiment passed 4/4. Local integrity guards took about 17-22
seconds in aggregate on the failing proofs, with individual guards around
5.6 seconds, competing with the real 15-second MCP exchange budget. Four-process
proof guards totalled about 8.7 seconds. The packed consumer also exceeded its
600-second outer timeout in the uncapped suite, while its isolated baseline
passed in 353 seconds. Its private cache/install/runtime journey now runs without
competing test files.

Scheduling alone still left one SDK session failure in a full rerun. Build
inspection now also reads at most four assets concurrently, with fresh
path/type/size/byte validation for every asset on every inspection. It waits for
the entire batch to settle before returning a failure and hashes bytes in the
original filename order. There is no cross-call cache or relaxed missing-file
handling. Eight local inspection samples improved from 378-526 ms to 123-139 ms;
this is not a whole-suite performance guarantee. Production deadlines,
per-request integrity validation, consumed-attempt handling and timeout
assertions are unchanged. The deliberate eleven-process stress case can still
exhaust deadlines; it is not the supported default scheduling policy.

Creation-journey fixtures report bounded synthetic guard timings and sanitized
failure codes/stages. No provider output, token or response body is logged.
For deliberate stress investigation, `node test\support\creation-pressure.mjs 11`
runs eleven isolated copies of the direct-ACA header-key case; use `4` or `1`
for a bounded comparison. This can deliberately fail under contention and is
not part of the normal gate or an automatic retry. Every copy uses a fresh
synthetic workspace, never an existing proof. Arbitrary host contention can still exhaust
real deadlines, so retain failure diagnostics rather than retrying silently.
Local Node 26 observations do not qualify the Node 22/24 CI matrix.

## Package documentation boundary

`package.json.files` explicitly selects shipped user guides and images.
`scripts/update-assets.mjs` uses that same documentation selection for the runtime
inventory. Operational handoff, progress history, WIQD proposal and extraction
history remain in Git but do not ship; links to them use repository URLs.
Missing inventoried files still fail closed. There is no missing-file fallback.

The inventory/build digest describes shipped assets, not repository-only history.
Changing this selection creates a new build identity; retained manifests and
approvals are never rewritten to match it. `test/package.test.js` checks
documentation inclusion/exclusion, inventory bytes and checkout/installed build
identity. The package remains private; packing is not publication.

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
