import { resolveNpmRegistryUrl } from './npm-registry.js';

const step = (id, title, kind, instruction, expected, command) =>
  ({ id, title, kind, instruction, expected, ...(command ? { command } : {}) });

export function handoverResources(input) {
  const a = input.azure, prefix = `/subscriptions/${a.subscriptionId}/resourceGroups/`;
  const rows = [
    ['Resource group', `${prefix}${a.resourceGroup}`, 'configured-reuse'],
    [input.recipe === 'functions-sdk-v1' ? 'Function app' : input.recipe === 'app-service-container-v1' ? 'App Service' : 'Container App',
      `${prefix}${a.resourceGroup}/providers/${input.recipe.startsWith('container-apps') ? 'Microsoft.App/containerApps' : 'Microsoft.Web/sites'}/${a.appName}`, 'planned-create'],
  ];
  for (const [label, id] of [
    ['Container Apps environment', a.environmentResourceId], ['Hosting plan', a.planResourceId],
    ['Image-pull identity', a.registry?.pullIdentityResourceId],
    ['Storage account', a.storage?.accountResourceId], ['Storage identity', a.storage?.identityResourceId],
    ['Key Vault', input.backend.apiKey?.keyVaultResourceId], ['Secret-reader identity', input.backend.apiKey?.identityResourceId],
  ]) if (id) rows.push([label, id, 'configured-reuse']);
  if (a.gateway) {
    const service = `${prefix}${a.gateway.resourceGroup}/providers/Microsoft.ApiManagement/service/${a.gateway.serviceName}`;
    if (a.gateway.resourceGroup.toLowerCase() !== a.resourceGroup.toLowerCase()) {
      rows.push(['Gateway resource group', `${prefix}${a.gateway.resourceGroup}`, 'configured-reuse']);
    }
    rows.push(['APIM service', service, 'configured-reuse'], ['APIM API', `${service}/apis/${a.gateway.apiName}`, 'planned-create']);
  }
  return rows.map(([label, resourceId, disposition]) => ({ label, resourceId, disposition, provenance: 'recipe-configuration-not-service-readback' }));
}

export function destinationEdits(input) {
  const rows = [];
  const add = (field, instruction) => {
    const value = field.split('.').reduce((v, k) => v?.[k], input);
    if (value !== undefined) rows.push({ file: 'destination/recipe-definition.json', field, original: value, instruction });
  };
  for (const field of ['azure.tenantId', 'azure.subscriptionId', 'azure.resourceGroup', 'azure.location', 'azure.appName']) {
    add(field, 'Replace with the explicit destination value. Confirm ownership, region support and new resource-name absence.');
  }
  for (const field of ['azure.environmentResourceId', 'azure.planResourceId', 'azure.planKind', 'azure.registry.server',
    'azure.registry.pullIdentityResourceId', 'azure.registry.pullIdentityClientId', 'azure.storage.accountResourceId',
    'azure.storage.deploymentContainer', 'azure.storage.identityResourceId', 'azure.storage.identityClientId',
    'azure.previewAccepted']) {
    add(field, 'Select and inspect the destination prerequisite. This recipe does not create it or grant its permissions.');
  }
  for (const field of ['authentication.tenantId', 'authentication.audience', 'authentication.applicationIdUri',
    'authentication.scope', 'authentication.allowedClientIds']) {
    add(field, 'Review the destination Entra application, delegated scope, consent and client allowlist. Do not copy registrations or approvals blindly.');
  }
  for (const field of ['azure.gateway.serviceName', 'azure.gateway.resourceGroup', 'azure.gateway.apiName',
    'azure.gateway.path', 'azure.gateway.audience', 'azure.gateway.applicationIdUri', 'azure.gateway.principalId', 'azure.gateway.role']) {
    add(field, 'Review the existing destination APIM service, inherited policies and independent gateway identity/role. Its audience must differ from the caller audience.');
  }
  add('backend.origin', 'Keep only if the same backend is intended and its shared-use terms are reviewed. Update matching document.servers URLs when present.');
  for (const field of ['backend.apiKey.tenantId', 'backend.apiKey.keyVaultResourceId', 'backend.apiKey.identityResourceId',
    'backend.apiKey.secretIdentifier', 'backend.apiKey.headerName', 'backend.apiKey.queryParameterName',
    'backend.apiKey.sharedAccessReviewed', 'backend.apiKey.queryExposureReviewed']) {
    add(field, 'Review the destination Key Vault reference and distinct identity, pre-existing secret Get access, network and safe diagnostics. Never enter the key value; review entitlement/placement again.');
  }
  for (const field of ['imageBuild.builderImage', 'imageBuild.runtimeImage', 'imageBuild.platform', 'scaleProfile', 'requestsPerMinute']) {
    add(field, 'Re-review immutable image inputs, architecture, scaling, cost and per-process limits; these are not global cost ceilings.');
  }
  add('operationIds', 'Retain only intended operations. Update document and review.readOnlyOperationIds together; do not assume GET alone is safe.');
  rows.push({ file: 'destination/recipe-definition.json', field: 'npmRegistryUrl', original: resolveNpmRegistryUrl(input.npmRegistryUrl),
    instruction: 'Review the destination credential-free HTTPS npm feed, including its trailing slash/path. Omission preserves historical public npm, not ambient npm settings. Regenerate a NEW project to bind .npmrc, registry / resolved URLs and Dockerfile; never rewrite sealed source. Authenticated feeds are unsupported; install/build still requires separate approval.' });
  return rows;
}

export function handoverGuide(input) {
  const functions = input.recipe === 'functions-sdk-v1', gateway = Boolean(input.azure.gateway);
  const template = functions ? 'functions' : input.recipe === 'app-service-container-v1' ? 'app-service' : 'container-app';
  const args = '--workspace-root "<DEST_WORKSPACE>" --project "<NEW_SOURCE_PROJECT>"';
  const generate = '--workspace-root "<DEST_WORKSPACE>" --config "<DEST_RECIPE_JSON>" --output "<NEW_SOURCE_PROJECT>"';
  const steps = [
    step('destination', 'Choose a fresh destination', 'file-edit',
      'Create a private destination workspace. Copy source/recipe-definition.json to destination/recipe-definition.json OUTSIDE the sealed source. Apply every relevant field change below. Source settings are reference-only, not destination defaults.',
      'A reviewed destination input with explicit IDs and no secrets. Original source and evidence remain unchanged.'),
    step('prerequisites', 'Inspect or provision prerequisites separately', 'manual',
      `Review resource ownership, region, pricing, quota, networking and existing roles. ${functions
        ? 'Functions requires a Linux FC1 plan, storage/deployment container and storage identity; preview acceptance and a supported remote build are separate gates.'
        : input.recipe === 'app-service-container-v1'
          ? 'App Service requires a Linux dedicated Basic-or-higher plan, ACR and matching image-pull identity resource/client IDs.'
          : 'Container Apps requires an existing environment, ACR and image-pull identity. The separate mcp-bootstrap flow can prepare prerequisite templates for the direct recipe only.'}
${gateway ? 'Inspect the existing APIM service, API/path name absence, inherited policies and gateway managed identity as a separate deployment target.' : ''}
${input.backend.apiKey ? 'Inspect Key Vault references, dedicated identity access and safe header/query diagnostics. Never retrieve a key into this handover.' : ''}`,
      'Documented destination prerequisites and approvals. No toolkit handover command creates resources or grants roles.'),
    step('identity', 'Review destination identity and authentication', 'approval-required',
      'Select an explicit tenant/subscription/account with project-private Azure authentication. Never switch a shared Azure CLI profile or copy caches. Review Entra audience, scope, allowed clients and consent. Native Windows ATK SSO uses a separately reviewed normal user profile; Linux isolation is optional for SSO. Login and registration each need their own approval.',
      'Correct reviewed identities; no old registration, proof or approval is treated as transferable.'),
    step('generate-plan', 'Review new source generation', 'CLI',
      'Run this local plan, or use scripts/review-source.ps1. Read the complete JSON and exact top-level approval token.',
      'A plan bound to destination input, generated bytes, toolkit build and a new output directory.',
      `copilot-mcp mcp-hosting-plan ${generate} --summary --json`),
    step('generate', 'Generate the new project', 'approval-required',
      'Only after reviewing the preceding plan, copy its exact token. Never reuse the source environment token.',
      'New source, README and ARM templates. Nothing deployed or installed.',
      `copilot-mcp mcp-hosting-create ${generate} --approve "<FRESH_GENERATION_APPROVAL>" --json`),
    step('build', functions ? 'Prepare the source-only Functions release' : 'Build, scan and publish the container separately', 'manual',
      functions
        ? `Review Functions Core Tools/Azurite if doing optional local checks. The release ZIP has no installed dependencies; it preserves .npmrc and pinned lock URLs for ${resolveNpmRegistryUrl(input.npmRegistryUrl)}. Review the supported Flex One Deploy/remote-build path and dependency licenses; require it to honor that registry without ambient npm configuration/credentials or fallback, or stop. ARM alone does not deploy runnable code.`
        : `${input.imageBuild ? 'Use the newly generated digest-pinned Dockerfile.' : 'No Dockerfile was selected in this source: provide reviewed imageBuild digests/platform and regenerate, or use a separate reviewed build workflow.'} Review npmRegistryUrl (${resolveNpmRegistryUrl(input.npmRegistryUrl)}) before npm/build access. Historical Dockerfiles may not consume .npmrc; generate a new project rather than modifying old sealed files. Building, scanning, SBOM/smoke checks and pushing to the selected ACR are separate operations. Record the resulting immutable image digest; a digest does not attest source correspondence.`,
      functions ? 'Reviewed source archive hash and remote-build procedure.' : 'Approved registry/repository@sha256 digest, reviewed image provenance and permissions.'),
    step('source', 'Review the destination source archive', 'CLI',
      'This local command computes the source archive hash; it does not install dependencies, build or call a provider.',
      'The exact destination sourceArchiveSha256 for release review.',
      `copilot-mcp mcp-recipe-source-plan ${args} --json`),
    ...(gateway ? [step('host-stage', 'Deploy and read back the Container Apps host first', 'manual',
      'The gateway release needs the actual backend origin, so do not guess it. Separately review source infra/container-app.json and an ARM deployment-parameters JSON containing containerImage.value set to your approved image digest. With explicit private Azure identity, name-absence/ownership checks, what-if and deployment approval, deploy ONLY this host template to its selected resource group. Wait for revision/traffic readiness and read back the actual host origin. Record this operation before proceeding; the later gateway step must not redeploy the host.',
      'Actual HTTPS Container Apps origin and retained host operation outcome. Unknown host results stop this sequence; no automatic retry.')] : []),
    step('release-input', 'Prepare destination release parameters', 'file-edit',
      `Create a private release JSON with schemaVersion: 1, accountName and ${functions ? 'sourceArchiveSha256 from the preceding plan' : 'containerImage from the approved destination ACR'}.${gateway ? ' Also supply backendOrigin only after actual Container Apps endpoint readback; review the host and gateway stages separately.' : ''}
Inspect regenerated infra/${template}.json; its target IDs are generated from the recipe, not all ARM parameters. ${gateway ? 'infra/apim-gateway.json belongs to the gateway resource group, which may differ.' : ''}
Do not edit the sealed source templates or repair their manifest. Change the destination recipe and regenerate if targets are wrong.`,
      'Destination release JSON and correct template/parameter pair for each target.'),
    step('release-plan', 'Review release packaging', 'CLI', 'Review the exact source, artifact, targets and parameter files.',
      'Local release plan; not a deployment approval.',
      `copilot-mcp mcp-recipe-release-plan ${args} --config "<DEST_RELEASE_JSON>" --output "<NEW_RELEASE_DIR>" --summary --json`),
    step('release', 'Save the reviewed release', 'approval-required', 'Use only the fresh release-plan token.',
      'source.zip, templates and per-template parameters for this destination.',
      `copilot-mcp mcp-recipe-release-bundle ${args} --config "<DEST_RELEASE_JSON>" --output "<NEW_RELEASE_DIR>" --approve "<FRESH_RELEASE_APPROVAL>" --json`),
    step('deploy', gateway ? 'Review and deploy only the APIM gateway stage' : 'Review what-if, then deploy separately', 'manual',
      `Using the separately authenticated private Azure profile, review exact targets, name absence, what-if, costs and template effects. Obtain explicit deployment approval before invoking Azure CLI or your deployment system. Use infra/${gateway ? 'apim-gateway' : template}.json and infra/${gateway ? 'apim-gateway' : template}.parameters.json from the new release.${gateway ? ' Target the APIM resource group, not necessarily the host group. The host was already deployed/read back: do not replay its create template.' : ''}
${functions ? 'Then separately upload/build source through the supported Flex deployment path.' : ''}
This toolkit has no hosting deployment executor or atomic overwrite protection. Unknown/failed attempts require reconciliation, not automatic retry. For an existing deployment, use a preserving-update workflow instead of create templates.`,
      'Actual resource/revision/traffic and endpoint readback. A submitted ARM operation is not healthy runtime or consumer acceptance.'),
    step('reference', 'Reference the actual endpoint', 'CLI',
      'Create DEST_REFERENCE_JSON with schemaVersion: 1, a new serverId UUID and the actual HTTPS /mcp endpoint. For gateway recipes use the configured gateway URL. Review the plan, then use mcp-recipe-reference-create with its fresh token and the same arguments.',
      'A separate referenced-not-verified MCP project; never a fabricated capture.',
      `copilot-mcp mcp-recipe-reference-plan ${args} --config "<DEST_REFERENCE_JSON>" --output "<NEW_REFERENCE_PROJECT>" --summary --json`),
    step('reference-create', 'Save the reviewed endpoint reference', 'approval-required',
      'Use the exact token from the preceding reference plan. This does not discover tools or test authentication.',
      'A new reference project for separate discovery/proof/consumer steps.',
      `copilot-mcp mcp-recipe-reference-create ${args} --config "<DEST_REFERENCE_JSON>" --output "<NEW_REFERENCE_PROJECT>" --approve "<FRESH_REFERENCE_APPROVAL>" --json`),
    step('prove', 'Discover and perform one separately approved proof', 'approval-required',
      'Use the existing reference-project discovery/proof flows with explicit identity and a new selection JSON. For terminal guidance use mcp-terminal-handoff. Tools/list, one tool call and any backend assertion have separate meanings. Never replay a consumed call, including failures or unknown outcomes.',
      'Fresh recorded discovery and bounded proof results, not a copied source-environment success.',
      'copilot-mcp mcp-terminal-handoff --workspace-root "<DEST_WORKSPACE>" --project "<NEW_REFERENCE_PROJECT>" --config "<DEST_DISCOVERY_SELECTION_JSON>" --phase discovery --json'),
    step('consumer', 'Complete consumer onboarding manually', 'manual',
      'Prepare SSO registration/FCC handoffs separately where required. Review legal URLs, exact qualified scope, policies and audience; finish portal-only actions and consumer testing. Do not create a WIQD agent just to satisfy FCC onboarding. Deferrals remain visible.',
      'Separate owner-reported portal/consumer outcomes, or explicit pending/deferred status.'),
    step('closeout', 'Record ownership, costs and a new handover', 'manual',
      'Record created/reused/changed resources and unresolved work in the destination project. Review scale, ongoing charges, secret rotation/restart responsibilities and teardown ownership. Do not delete shared resources or grants. Generate a new handover snapshot after this review.',
      'A destination-specific handover; old evidence and consumed operations remain intact.'),
  ];
  return steps;
}

export const reviewSourceScript = `# Local generation plan only. Does not install, authenticate, build or deploy.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$WorkspaceRoot,
  [Parameter(Mandatory=$true)][string]$RecipeConfig,
  [Parameter(Mandatory=$true)][string]$NewProject
)
$ErrorActionPreference = 'Stop'
& copilot-mcp mcp-hosting-plan --workspace-root $WorkspaceRoot --config $RecipeConfig --output $NewProject --summary --json
if ($LASTEXITCODE -ne 0) { throw "Source review failed with exit code $LASTEXITCODE. Nothing is approved." }
`;
