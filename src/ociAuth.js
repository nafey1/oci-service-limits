import * as common from 'oci-common';

export async function createAuthProvider(config) {
  switch (config.authMethod) {
    case 'config':
      return new common.ConfigFileAuthenticationDetailsProvider(config.configFile, config.profile);
    case 'instance_principal':
      return new common.InstancePrincipalsAuthenticationDetailsProviderBuilder().build();
    case 'resource_principal':
      return new common.ResourcePrincipalAuthenticationDetailsProvider();
    default: {
      const error = new Error(`Unsupported OCI_AUTH_METHOD "${config.authMethod}". Use config, instance_principal, or resource_principal.`);
      error.statusCode = 500;
      throw error;
    }
  }
}

export function getAuthProviderTenancyId(provider) {
  if (!provider || typeof provider.getTenantId !== 'function') return '';
  return provider.getTenantId() || '';
}

export function getAuthProviderRegionId(provider) {
  if (!provider || typeof provider.getRegion !== 'function') return '';
  try {
    const region = provider.getRegion();
    return region?.regionId || region?._regionId || '';
  } catch {
    return '';
  }
}
