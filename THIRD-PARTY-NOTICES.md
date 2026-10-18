# License scope and third-party material

This independent extraction includes code originally copyright (c) 2026 Cowork
Plugin Toolkit contributors, under the unchanged root MIT LICENSE. Source revision
and original file hashes are recorded in source-provenance.json. Modifications and
new toolkit code are also MIT. This does not relicense service content or dependencies.

No Microsoft Teams schema, plugin assets or consumer registration runtime is
included. Therefore the originating repository's schema-specific notice and
distribution discussion do not describe this package. npm publication remains
disabled (private: true); public GitHub source is not a license grant for services.

## Installed production dependencies

The following baseline versions, license identifiers and file names were read
from the locked installed packages. This table predates the additional SDK
transitives described below; it is not the complete current dependency tree.
The toolkit npm tarball does not embed their
`node_modules` contents; npm installs dependencies separately. A downstream
bundle that includes dependency code must preserve the actual upstream license
texts/notices from the exact bundled packages, including transitive packages.
This inventory is not a substitute for those texts or a dependency-byte
attestation.

| Package | Locked version | Declared license | Package license file |
| --- | --- | --- | --- |
| @azure/msal-common | 16.14.1 | MIT | LICENSE |
| @azure/msal-node | 7.0.0 | MIT | LICENSE |
| @modelcontextprotocol/sdk | 1.32.1 | MIT | LICENSE |
| ajv | 8.20.0 | MIT | LICENSE |
| ajv-formats | 3.0.1 | MIT | LICENSE |
| buffer-equal-constant-time | 1.0.1 | BSD-3-Clause | LICENSE.txt |
| ecdsa-sig-formatter | 1.0.11 | Apache-2.0 | LICENSE |
| fast-deep-equal | 3.1.3 | MIT | LICENSE |
| fast-uri | 3.1.7 | BSD-3-Clause | LICENSE |
| fflate | 0.8.3 | MIT | LICENSE |
| json-schema-traverse | 1.0.0 | MIT | LICENSE |
| jsonwebtoken | 9.0.3 | MIT | LICENSE |
| jose | 6.2.12 | MIT | LICENSE.md |
| jwa | 2.0.1 | MIT | LICENSE |
| jws | 4.0.1 | MIT | LICENSE |
| lodash.includes | 4.3.0 | MIT | LICENSE |
| lodash.isboolean | 3.0.3 | MIT | LICENSE |
| lodash.isinteger | 4.0.4 | MIT | LICENSE |
| lodash.isnumber | 3.0.3 | MIT | LICENSE |
| lodash.isplainobject | 4.0.6 | MIT | LICENSE |
| lodash.isstring | 4.0.1 | MIT | LICENSE |
| lodash.once | 4.1.1 | MIT | LICENSE |
| ms | 2.1.3 | MIT | license.md |
| require-from-string | 2.0.2 | MIT | license |
| safe-buffer | 5.2.1 | MIT | LICENSE |
| semver | 7.8.5 | ISC | LICENSE |


Authenticated discovery adds exact `@azure/msal-node@7.0.0` and its locked
transitives. Their package metadata/license files were inspected from the
installed packages. The lock records Microsoft npm mirror URLs and supplied
integrities (some SHA-1); this is not evidence of a clean public-registry
installation. Downstream consumers must update their dependency and bundled
license inventory, not just copy the toolkit runtime asset snapshot.

The Container Apps recipe adds `@modelcontextprotocol/sdk@1.32.1` and
`jose@6.2.12`; their installed metadata and license filenames were inspected.
The SDK brings additional transitive dependencies recorded in `package-lock.json`.
The generated server has its own narrower lock in
`src/recipes/container-apps/package-lock.json`. Its emitted lock changes known
mirror URL prefixes to public npm while preserving package versions and
integrity hashes. Fresh generated-server installation was checked offline from
the local npm cache, not by downloading from public npm. Generated projects and
their Docker build include the toolkit source license and a dependency-notice
reminder. Distributors must still inventory and retain the actual licenses for
the complete installed dependency tree in their final image.

Development tooling, including TypeScript and esbuild, retains its own terms
as supplied with those packages. Audit the actual shipped artifact rather
than assuming every development dependency is embedded at runtime.

The installed `fflate/esm/index.mjs` also credits code/algorithms similar to or
from UZIP.js and links to https://github.com/photopea/UZIP.js. Preserve those
upstream source attributions along with fflate's supplied LICENSE when
bundling; this notice does not invent a separate grant for UZIP.js.

## Offline package checks

`library-assets.json` and `getLibraryInfo().files` inventory this independent
package's runtime, documentation, guidance skill, examples and companion notices.
Both root `LICENSE` and `THIRD-PARTY-NOTICES.md` are included. Preserve the entire
inventory and its relative paths when redistributing a source snapshot.

`test/package.test.js` packs and freshly installs the local tarball offline,
checks its notices/skill/types and dependency resolution, and exercises its CLI
with runtime networking and subprocesses denied. This is not a license audit of
dependencies or a release approval. A bundle that embeds dependency code still
needs the actual dependency license texts and upstream source attributions.

## Documented design references

The originating toolkit credited workflow inspiration from these public
references; the attribution is retained here:

- https://github.com/troystaylor/SharingIsCaring/tree/main/Cowork%20Plugin%20Template
- https://github.com/troystaylor/SharingIsCaring/tree/main/Cowork%20Plugins

No reference-project runtime or customer configuration is included in this
extraction. This is not an exhaustive legal provenance audit or a grant over
those projects. Service names, example endpoints and returned service content
are not relicensed by the toolkit.
