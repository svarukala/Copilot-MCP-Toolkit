const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const uuid = { type: 'string', format: 'uuid' };
export function hostingSchemas(base) {
  const gateway = structuredClone(base);
  gateway.properties.recipe = { const: 'container-apps-apim-v1' };
  gateway.properties.azure.properties.gateway = object({
    serviceName: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,48}[a-z0-9]$' },
    resourceGroup: base.properties.azure.properties.resourceGroup,
    apiName: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,48}[a-z0-9]$' },
    path: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,48}[a-z0-9]$' },
    audience: uuid, applicationIdUri: base.properties.authentication.properties.applicationIdUri,
    principalId: uuid,
    role: { const: 'Mcp.Gateway' },
  });
  gateway.properties.azure.required.push('gateway');
  return [base, gateway];
}

export function gatewaySettings(input) {
  const gateway = input.azure.gateway;
  return gateway ? {
    tenantId: input.azure.tenantId, audience: gateway.audience,
    principalId: gateway.principalId, role: gateway.role,
    publicUrl: `https://${gateway.serviceName}.azure-api.net/${gateway.path}/mcp`,
  } : undefined;
}

const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

export function gatewayInfrastructure(input, appTemplate) {
  const gateway = input.azure.gateway, a = input.authentication;
  const claim = (name, values, extra = '') => `<claim name="${name}" match="any"${extra}>${values.map(v => `<value>${xml(v)}</value>`).join('')}</claim>`;
  const policy = `<policies>
  <inbound>
    <base />
    <choose>
      <when condition="@(context.Request.Method == &quot;POST&quot;)">
        <validate-jwt header-name="Authorization" require-scheme="Bearer" failed-validation-httpcode="401">
          <openid-config url="https://login.microsoftonline.com/${a.tenantId}/v2.0/.well-known/openid-configuration" />
          <audiences><audience>${a.audience}</audience></audiences>
          <issuers><issuer>https://login.microsoftonline.com/${a.tenantId}/v2.0</issuer></issuers>
          <required-claims>${claim('tid', [a.tenantId])}${claim('ver', ['2.0'])}${claim('scp', [a.scope], ' separator=" "')}${claim('azp', a.allowedClientIds)}</required-claims>
        </validate-jwt>
        <authentication-managed-identity resource="${xml(gateway.applicationIdUri)}" output-token-variable-name="copilotGatewayToken" ignore-error="false" />
        <set-header name="X-Copilot-MCP-Gateway-Authorization" exists-action="override"><value>@("Bearer " + (string)context.Variables["copilotGatewayToken"])</value></set-header>
      </when>
    </choose>
  </inbound>
  <backend><base /></backend>
  <outbound><base /></outbound>
  <on-error><base /></on-error>
</policies>
`;
  return {
    $schema: appTemplate.$schema, contentVersion: '1.0.0.0',
    metadata: { ...appTemplate.metadata, expectedResourceGroup: gateway.resourceGroup,
      warning: 'Apply separately to the existing APIM resource group only after reviewing inherited policies, gateway identity/role and new API/path absence. No native REST-to-MCP conversion.' },
    parameters: { containerImage: appTemplate.parameters.containerImage,
      backendOrigin: { type: 'string', metadata: { description: 'Exact actual HTTPS Container Apps origin from the separately reviewed app deployment readback.' } } },
    resources: [{
      type: 'Microsoft.ApiManagement/service/apis', apiVersion: '2024-05-01',
      name: `${gateway.serviceName}/${gateway.apiName}`,
      properties: { displayName: input.name, path: gateway.path, protocols: ['https'],
        subscriptionRequired: false, type: 'http', serviceUrl: "[parameters('backendOrigin')]" },
      resources: [
        ...[{ name: 'mcp-post', method: 'POST', urlTemplate: '/mcp' },
          { name: 'resource-metadata', method: 'GET', urlTemplate: '/.well-known/oauth-protected-resource' }].map(op => ({
          type: 'operations', apiVersion: '2024-05-01', name: op.name,
          dependsOn: [`[resourceId('Microsoft.ApiManagement/service/apis', '${gateway.serviceName}', '${gateway.apiName}')]`],
          properties: { displayName: op.name, method: op.method, urlTemplate: op.urlTemplate, responses: [] },
        })),
        { type: 'policies', apiVersion: '2024-05-01', name: 'policy',
          dependsOn: [`[resourceId('Microsoft.ApiManagement/service/apis', '${gateway.serviceName}', '${gateway.apiName}')]`],
          properties: { format: 'rawxml', value: policy } },
      ],
    }],
    outputs: { mcpEndpoint: { type: 'string', value: gatewaySettings(input).publicUrl } },
  };
}
