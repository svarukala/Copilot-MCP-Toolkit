const deploymentPhases = new Set(['foundation', 'finalize', 'gateway']);

const deploymentResources = new Set(['azure-account', 'azure-resources', 'resource-group', 'entra-application',
  'entra-service-principal', 'apim-service', 'key-vault', 'apim-diagnostics', 'apim-policy',
  'apim-api', 'apim-backend', 'apim-named-value', 'role-assignment', 'deployment', 'preservation']);

const deploymentOperations = new Set(['inspect', 'create', 'update', 'validate', 'deploy', 'stage', 'verify', 'execute']);

export function normalizeDeploymentOperationDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 4
    || value.kind !== 'deployment-operation'
    || !deploymentPhases.has(value.phase)
    || !deploymentResources.has(value.resource)
    || !deploymentOperations.has(value.operation)) return undefined;
  return { kind: value.kind, phase: value.phase, resource: value.resource, operation: value.operation };
}
