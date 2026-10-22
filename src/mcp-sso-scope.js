export function portalSsoScope(applicationIdUri, permissionName) {
  const missing = applicationIdUri === undefined || permissionName === undefined;
  let valid = !missing && typeof applicationIdUri === 'string' && applicationIdUri.length <= 2048
    && !/[\s\\%?#]/.test(applicationIdUri) && !applicationIdUri.endsWith('/')
    && typeof permissionName === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(permissionName)
    && !applicationIdUri.endsWith(`/${permissionName}`);
  if (valid) {
    try {
      const uri = new URL(applicationIdUri);
      valid = ['api:', 'https:'].includes(uri.protocol) && Boolean(uri.hostname)
        && !uri.username && !uri.password && !uri.pathname.includes('//');
    } catch { valid = false; }
  }
  return {
    label: 'Portal OAuth scope (fully qualified)',
    value: valid ? `${applicationIdUri}/${permissionName}` : null,
    status: missing ? 'missing' : valid ? 'provided' : 'invalid',
  };
}

export const ssoScopeInstructions = [
  'The API permission name is the short scp claim value, not the portal OAuth Scope field. Copy the fully qualified Portal OAuth scope only after checking that its Application ID URI is registered on this resource app.',
  'The portal value uses the caller-supplied registration URI when available, otherwise the descriptor URI. Neither is independently verified here. The OAuth resource URI is not the v2 token audience GUID.',
  'If AADSTS650053 names Microsoft Graph for this custom permission, compare the requested resource and the fully qualified Portal OAuth scope first. Do not add Graph permissions, rebuild the server or create another app solely to correct that field. Other invalid_client errors remain undiagnosed.',
];
