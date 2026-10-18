# Install dependencies from public npm

Use this guide if you want to install the toolkit's dependencies from
**`https://registry.npmjs.org/`** instead of the repository's configured Microsoft
package feed.

**Use public npm only when your organization's policy permits it.** This is an
explicit choice for your local checkout, not an automatic workaround for a denied
corporate feed. Do not disable TLS verification, remove required proxy settings
or copy credentials between registries. No npm account or `npm login` is needed
for these public packages.

The steps below use **PowerShell**, Git, and Node.js 22+ with npm. They do not
publish the toolkit, change your global npm settings or deploy anything to Azure.

## Why changing the registry alone is not enough

Two files control dependency installation:

| File | What needs to change |
| --- | --- |
| `.npmrc` | The default registry currently points to `https://packagefeedproxy.microsoft.io/npm/`. |
| `package-lock.json` | Pinned package download URLs currently point to a Microsoft-hosted tarball mirror. These must also point to public npm. |

Using only `npm ci --registry=https://registry.npmjs.org/` can leave the lockfile's
explicit mirror URLs in use. **Do not delete the lockfile or regenerate it with
`npm install` just to change registries:** that can select different transitive
dependency versions. This guide changes download locations only and preserves
the pinned versions and integrity hashes.

## 1. Use a fresh local checkout

Run this from a folder where you keep source code. The new directory must not
already exist. This keeps any existing setup and its registry settings intact.

```powershell
git clone https://github.com/svarukala/Copilot-MCP-Toolkit.git Copilot-MCP-Toolkit-public-npm
Set-Location .\Copilot-MCP-Toolkit-public-npm
node --version
npm --version
```

Use Node.js 22 or later. Do not run the remaining commands in a generated MCP
project or in an unrelated repository.

## 2. Set public npm for this checkout only

```powershell
npm config set registry https://registry.npmjs.org/ --location=project
if ($LASTEXITCODE -ne 0) { throw 'Could not update the project registry. Stop here.' }
npm config get registry
```

The last command should print `https://registry.npmjs.org/`. If it does not,
stop and check with your administrator: environment variables or managed npm
configuration may override project settings. Do not use `--global` or change
your user-level `.npmrc` for this procedure.

## 3. Change only the locked download URLs

Copy this entire block into PowerShell while still in the new toolkit folder:

```powershell
@'
const fs = require('node:fs');
const filename = 'package-lock.json';
const lock = JSON.parse(fs.readFileSync(filename, 'utf8'));
const mirror = 'https://ms-feed-25.pkgs.visualstudio.com/1es-public/_packaging/npm-public/npm/registry/';
const publicRegistry = 'https://registry.npmjs.org/';

if (lock.lockfileVersion !== 3 || !lock.packages) {
  throw new Error('Unexpected lockfile format. Stop and review; no file was changed.');
}

let changed = 0;
for (const [location, entry] of Object.entries(lock.packages)) {
  if (location === '') continue;
  if (typeof entry.resolved !== 'string' || !entry.integrity || !entry.version) {
    throw new Error(`Missing locked package details at ${location}; no file was changed.`);
  }
  if (entry.resolved.startsWith(mirror)) {
    entry.resolved = publicRegistry + entry.resolved.slice(mirror.length);
    changed++;
  } else if (!entry.resolved.startsWith(publicRegistry)) {
    throw new Error(`Unexpected package source at ${location}; no file was changed.`);
  }
}

fs.writeFileSync(filename, JSON.stringify(lock, null, 2) + '\n');
console.log(`Updated ${changed} package download URLs; versions and integrity hashes are unchanged.`);
'@ | node --input-type=commonjs
if ($LASTEXITCODE -ne 0) { throw 'Lockfile conversion failed. Stop before installing.' }
```

This handles both scoped packages (such as `@azure/msal-node`) and unscoped
packages. It validates all entries before writing and stops if it finds an
unrecognized source. Running it again on an already-converted lockfile reports
zero updated URLs.

The code is specific to the repository's current lockfile. If a future version
uses a different source or format, review the new lockfile rather than removing
the checks.

## 4. Review your local changes

```powershell
git --no-pager diff -- .npmrc package-lock.json
```

Only the project registry and the packages' `resolved` download URLs should
change. Package versions, dependency relationships and `integrity` fields must
remain the same. Keep these as intentional local changes; do not include them
in an unrelated contribution. Review upstream changes to these files before
updating this checkout later.

## 5. Install and check the CLI

This step downloads packages from public npm and installs them locally.
Lifecycle scripts remain disabled:

```powershell
npm ci --registry=https://registry.npmjs.org/ --ignore-scripts --no-audit --fund=false
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Stop and review the npm error.' }
node .\bin\copilot-mcp.js --help
if ($LASTEXITCODE -ne 0) { throw 'The CLI did not start successfully.' }
```

`npm ci` checks the downloaded packages against the retained integrity hashes.
If a pinned version is unavailable or its integrity does not match, **stop**.
Do not remove the hash, select a newer version or disable verification to make
the installation pass. That requires a separate dependency review.

After the help text appears, continue at
[Create a separate folder for your generated projects](../README.md#3-create-a-separate-folder-for-your-generated-projects).

## Troubleshooting and verification limits

- **A request still goes to the old feed:** check that you are in the correct
  folder, Step 3 succeeded, and no old `resolved` URLs remain in your lockfile.
  A registry flag alone does not rewrite those URLs.
- **Proxy, certificate, 401 or 403 errors:** follow your organization's approved
  network and package-access process. Do not use `strict-ssl=false`.
- **Missing package or integrity error:** the mirrored artifact may not be
  available with identical bytes on public npm. Preserve the error locally and
  arrange a reviewed dependency update or approved source; do not share tokens
  or full configuration dumps.
- **Want to return to the default feed:** use your original untouched checkout
  or make another fresh clone. Do not overwrite unrelated local changes.

The URL conversion was checked offline against the current lockfile, including
version/integrity preservation and rejection of unexpected sources. A fresh
public-npm download/install has **not** been qualified by this guide. Installing
dependencies also does not verify Azure deployment or consumer compatibility.

See npm's [lockfile documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json)
and [npm configuration documentation](https://docs.npmjs.com/cli/v11/commands/npm-config).
