import * as identity from 'oci-identity';
import * as limits from 'oci-limits';

export function createIdentityClient(provider, regionId) {
  const client = new identity.IdentityClient({ authenticationDetailsProvider: provider });
  if (regionId) client.regionId = regionId;
  return client;
}

export function createLimitsClient(provider, regionName) {
  const client = new limits.LimitsClient({ authenticationDetailsProvider: provider });
  client.regionId = regionName;
  return client;
}

export async function listSubscribedRegions(identityClient, tenancyId) {
  const response = await identityClient.listRegionSubscriptions({ tenancyId });
  return extractItems(response)
    .map(normalizeRegion)
    .filter((region) => region.regionName);
}

export async function listServices(limitsClient, compartmentId, pageSize, subscriptionId = '') {
  const services = [];
  let page;

  do {
    const response = await limitsClient.listServices({
      compartmentId,
      subscriptionId: subscriptionId || undefined,
      limit: pageSize,
      page
    });
    services.push(...extractItems(response).map(normalizeService).filter((service) => service.name));
    page = response.opcNextPage;
  } while (page);

  return services;
}

export async function listLimitValues(limitsClient, compartmentId, serviceName, pageSize, subscriptionId = '') {
  const limitValues = [];
  let page;

  do {
    const response = await limitsClient.listLimitValues({
      compartmentId,
      serviceName,
      subscriptionId: subscriptionId || undefined,
      limit: pageSize,
      page
    });
    limitValues.push(...extractItems(response).map(normalizeLimitValue).filter((limitValue) => limitValue.name));
    page = response.opcNextPage;
  } while (page);

  return limitValues;
}

export async function listLimitDefinitions(limitsClient, compartmentId, serviceName, pageSize, subscriptionId = '') {
  const definitions = [];
  let page;

  do {
    const response = await limitsClient.listLimitDefinitions({
      compartmentId,
      serviceName,
      subscriptionId: subscriptionId || undefined,
      limit: pageSize,
      page
    });
    definitions.push(...extractItems(response).map(normalizeLimitDefinition).filter((definition) => definition.name));
    page = response.opcNextPage;
  } while (page);

  return definitions;
}

export async function getResourceAvailability(limitsClient, row, subscriptionId = '') {
  const response = await limitsClient.getResourceAvailability({
    compartmentId: row.compartmentId,
    serviceName: row.serviceName,
    limitName: row.limitName,
    availabilityDomain: row.scopeType === 'AD' ? row.availabilityDomain || undefined : undefined,
    subscriptionId: subscriptionId || undefined
  });

  return normalizeResourceAvailability(response.resourceAvailability || {});
}

function extractItems(response) {
  if (!response || typeof response !== 'object') return [];
  if (Array.isArray(response.items)) return response.items;

  for (const value of Object.values(response)) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object' && Array.isArray(value.items)) return value.items;
  }

  return [];
}

function normalizeRegion(region) {
  return {
    regionName: region.regionName || region.name || '',
    regionKey: region.regionKey || region.key || '',
    status: region.status || region.lifecycleState || '',
    isHomeRegion: Boolean(region.isHomeRegion)
  };
}

function normalizeService(service) {
  return {
    name: service.name || service.serviceName || '',
    description: service.description || service.displayName || ''
  };
}

function normalizeLimitValue(limitValue) {
  return {
    name: limitValue.name || limitValue.limitName || '',
    value: limitValue.value,
    scopeType: limitValue.scopeType || '',
    availabilityDomain: limitValue.availabilityDomain || '',
    subscriptionId: limitValue.subscriptionId || ''
  };
}

function normalizeLimitDefinition(definition) {
  return {
    name: definition.name || '',
    description: definition.description || '',
    scopeType: definition.scopeType || '',
    isResourceAvailabilitySupported: Boolean(definition.isResourceAvailabilitySupported)
  };
}

function normalizeResourceAvailability(availability) {
  return {
    used: availability.used,
    available: availability.available,
    fractionalUsage: availability.fractionalUsage,
    fractionalAvailability: availability.fractionalAvailability,
    effectiveQuotaValue: availability.effectiveQuotaValue
  };
}
