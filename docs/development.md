# Development and offline checks

Use Node.js 22+ and the committed lock. Runtime dependencies are exact:
`@azure/msal-node 7.0.0`, `ajv 8.20.0`, `ajv-formats 3.0.1`, `fflate 0.8.3`.
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
npm run check
npm run test:types
npm test
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

Keep temporary output under `.test-output` and remove only the exact test-owned
subdirectory. Never commit that directory, recovery archives, project evidence or
auth state. Preserve all upstream license notices when bundling dependency code;
normal npm tarballs do not embed node_modules.
