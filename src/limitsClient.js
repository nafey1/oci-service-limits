import * as identity from 'oci-identity';
import * as limits from 'oci-limits';

export function createIdentityClient(provider, regionId) {
  const client = new identity.IdentityClient({ authenticationDetailsProvider: provider });
  if (regionId) client.regionId = regionId;
  client.__telemetryRegionName = regionId || '';
  return client;
}

export function createLimitsClient(provider, regionName) {
  const client = new limits.LimitsClient({ authenticationDetailsProvider: provider });
  client.regionId = regionName;
  client.__telemetryRegionName = regionName || '';
  return client;
}

export async function listSubscribedRegions(identityClient, tenancyId, telemetry) {
  const request = { tenancyId };
  const response = await trackedRequest(
    telemetry,
    'listRegionSubscriptions',
    { regionName: clientRegionName(identityClient) },
    request,
    () => identityClient.listRegionSubscriptions(request)
  );
  return extractItems(response)
    .map(normalizeRegion)
    .filter((region) => region.regionName);
}

export async function listServices(limitsClient, compartmentId, pageSize, subscriptionId = '', telemetry) {
  const services = [];
  let page;

  do {
    const request = {
      compartmentId,
      subscriptionId: subscriptionId || undefined,
      limit: pageSize,
      page
    };
    const response = await trackedRequest(
      telemetry,
      'listServices',
      { regionName: clientRegionName(limitsClient) },
      request,
      () => limitsClient.listServices(request)
    );
    services.push(...extractItems(response).map(normalizeService).filter((service) => service.name));
    page = response.opcNextPage;
  } while (page);

  return services;
}

export async function listLimitValues(limitsClient, compartmentId, serviceName, pageSize, subscriptionId = '', telemetry) {
  const limitValues = [];
  let page;

  do {
    const request = {
      compartmentId,
      serviceName,
      subscriptionId: subscriptionId || undefined,
      limit: pageSize,
      page
    };
    const response = await trackedRequest(
      telemetry,
      'listLimitValues',
      { regionName: clientRegionName(limitsClient), serviceName },
      request,
      () => limitsClient.listLimitValues(request)
    );
    limitValues.push(...extractItems(response).map(normalizeLimitValue).filter((limitValue) => limitValue.name));
    page = response.opcNextPage;
  } while (page);

  return limitValues;
}

export async function listLimitDefinitions(limitsClient, compartmentId, serviceName, pageSize, subscriptionId = '', telemetry) {
  const definitions = [];
  let page;

  do {
    const request = {
      compartmentId,
      serviceName,
      subscriptionId: subscriptionId || undefined,
      limit: pageSize,
      page
    };
    const response = await trackedRequest(
      telemetry,
      'listLimitDefinitions',
      { regionName: clientRegionName(limitsClient), serviceName },
      request,
      () => limitsClient.listLimitDefinitions(request)
    );
    definitions.push(...extractItems(response).map(normalizeLimitDefinition).filter((definition) => definition.name));
    page = response.opcNextPage;
  } while (page);

  return definitions;
}

export async function getResourceAvailability(limitsClient, row, subscriptionId = '', telemetry) {
  const request = {
    compartmentId: row.compartmentId,
    serviceName: row.serviceName,
    limitName: row.limitName,
    availabilityDomain: row.scopeType === 'AD' ? row.availabilityDomain || undefined : undefined,
    subscriptionId: subscriptionId || undefined
  };
  const response = await trackedRequest(
    telemetry,
    'getResourceAvailability',
    { regionName: clientRegionName(limitsClient), serviceName: row.serviceName, limitName: row.limitName },
    request,
    () => limitsClient.getResourceAvailability(request)
  );

  return normalizeResourceAvailability(response.resourceAvailability || {});
}

async function trackedRequest(telemetry, operation, context, request, fn) {
  const startedAt = Date.now();
  try {
    const response = await fn();
    telemetry?.record?.({
      operation,
      ...context,
      ok: true,
      latencyMs: Date.now() - startedAt,
      requestBytes: byteSize(request),
      responseBytes: byteSize(responsePayload(response))
    });
    return response;
  } catch (error) {
    telemetry?.record?.({
      operation,
      ...context,
      ok: false,
      statusCode: error.statusCode || error.status || '',
      latencyMs: Date.now() - startedAt,
      requestBytes: byteSize(request),
      responseBytes: byteSize(errorPayload(error))
    });
    throw error;
  }
}

function clientRegionName(client) {
  return client?.__telemetryRegionName || client?.regionId || '';
}

function responsePayload(response) {
  if (!response || typeof response !== 'object') return response;
  const payload = {
    items: extractItems(response)
  };
  if (response.resourceAvailability) {
    payload.resourceAvailability = normalizeResourceAvailability(response.resourceAvailability);
  }
  if (response.opcNextPage) payload.opcNextPage = response.opcNextPage;
  return payload;
}

function errorPayload(error) {
  if (!error) return {};
  return {
    statusCode: error.statusCode || error.status || '',
    message: error.message || String(error)
  };
}

function byteSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value ?? {}), 'utf8');
  } catch {
    return 0;
  }
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
