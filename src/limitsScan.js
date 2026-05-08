import {
  createIdentityClient,
  createLimitsClient,
  getResourceAvailability,
  listLimitDefinitions,
  listLimitValues,
  listServices,
  listSubscribedRegions
} from './limitsClient.js';
import { workbookToXlsxBuffer } from './xlsx.js';

const READY_STATUS = 'READY';
const LIMIT_EXPORT_COLUMNS = [
  { key: 'regionName', header: 'regionName', width: 18 },
  { key: 'regionKey', header: 'regionKey', width: 12 },
  { key: 'regionStatus', header: 'regionStatus', width: 14 },
  { key: 'serviceName', header: 'serviceName', width: 24 },
  { key: 'serviceDescription', header: 'serviceDescription', width: 42 },
  { key: 'limitName', header: 'limitName', width: 32 },
  { key: 'limitDescription', header: 'limitDescription', width: 44 },
  { key: 'value', header: 'value', width: 14 },
  { key: 'used', header: 'used', width: 14 },
  { key: 'available', header: 'available', width: 14 },
  { key: 'effectiveLimit', header: 'effectiveLimit', width: 16 },
  { key: 'percentUsed', header: 'percentUsed', width: 14 },
  { key: 'resourceAvailabilitySupported', header: 'resourceAvailabilitySupported', width: 28 },
  { key: 'usageStatus', header: 'usageStatus', width: 16 },
  { key: 'usageError', header: 'usageError', width: 44 },
  { key: 'scopeType', header: 'scopeType', width: 14 },
  { key: 'availabilityDomain', header: 'availabilityDomain', width: 28 },
  { key: 'subscriptionId', header: 'subscriptionId', width: 32 },
  { key: 'compartmentId', header: 'compartmentId', width: 32 }
];

export async function scanTenancyLimits(provider, config, query, providerRegionId = '', options = {}) {
  const scanStartedAt = Date.now();
  const identityRegion = config.identityRegion || providerRegionId || 'us-ashburn-1';
  const includeUsage = options.includeUsage !== undefined ? Boolean(options.includeUsage) : query.scanMode !== 'fast';
  const progress = createScanProgressReporter(options.onProgress);

  progress.update({
    phase: 'regions',
    message: 'Loading subscribed OCI regions',
    percent: 2
  });

  const identityClient = createIdentityClient(provider, identityRegion);
  const subscribedRegions = await listSubscribedRegions(identityClient, query.tenancyId);
  const selectedRegions = filterRegions(subscribedRegions, query.regionNames);
  const scanRegions = selectedRegions.filter((region) => {
    return query.includeNonReadyRegions || normalizeStatus(region.status) === READY_STATUS;
  });

  const skippedRegions = selectedRegions
    .filter((region) => !scanRegions.includes(region))
    .map((region) => ({
      ...region,
      scanned: false,
      serviceCount: 0,
      limitCount: 0,
      errorCount: 0,
      message: `Skipped because status is ${region.status || 'unknown'}`
    }));

  progress.updateTotals({
    subscribedRegions: subscribedRegions.length,
    selectedRegions: selectedRegions.length,
    totalRegions: scanRegions.length,
    skippedRegions: skippedRegions.length
  });

  const completedRegionResults = [];
  const regionResults = await mapWithConcurrency(
    scanRegions,
    config.regionConcurrency,
    async (region) => {
      progress.regionStarted(region);
      const result = await scanRegion(provider, config, query, region, progress, {
        includeUsage,
        serviceCache: options.serviceCache
      });
      completedRegionResults.push(result);
      progress.regionCompleted(result);
      if (typeof options.onPartialReport === 'function') {
        options.onPartialReport(buildScanReport({
          scanStartedAt,
          query,
          identityRegion,
          subscribedRegions,
          selectedRegions,
          regionResults: completedRegionResults,
          skippedRegions,
          includeUsage,
          partial: true
        }));
      }
      return result;
    }
  );

  progress.complete({
    rows: regionResults.flatMap((result) => result.rows).length,
    errors: regionResults.flatMap((result) => result.errors).length,
    message: 'Scan complete'
  });

  return buildScanReport({
    scanStartedAt,
    query,
    identityRegion,
    subscribedRegions,
    selectedRegions,
    regionResults,
    skippedRegions,
    includeUsage,
    partial: false
  });
}

export async function getRegionOptions(provider, config, query, providerRegionId = '') {
  const identityRegion = config.identityRegion || providerRegionId || 'us-ashburn-1';
  const identityClient = createIdentityClient(provider, identityRegion);
  const regions = await listSubscribedRegions(identityClient, query.tenancyId);

  return {
    identityRegion,
    regions: regions.sort((a, b) => a.regionName.localeCompare(b.regionName))
  };
}

export async function getServiceOptions(provider, config, query, providerRegionId = '') {
  const { regions } = await getRegionOptions(provider, config, query, providerRegionId);
  const selectedRegions = filterRegions(regions, query.regionNames);
  const scanRegions = selectedRegions.filter((region) => {
    return query.includeNonReadyRegions || normalizeStatus(region.status) === READY_STATUS;
  });

  if (!scanRegions.length) {
    return {
      regionNames: [],
      services: [],
      errors: []
    };
  }

  const results = await mapWithConcurrency(scanRegions, config.regionConcurrency, async (region) => {
    try {
      const limitsClient = createLimitsClient(provider, region.regionName);
      return {
        region,
        services: await listServices(limitsClient, query.compartmentId, config.pageSize, query.subscriptionId),
        error: null
      };
    } catch (error) {
      return {
        region,
        services: [],
        error: {
          regionName: region.regionName,
          message: formatError(error),
          statusCode: error.statusCode || error.status || ''
        }
      };
    }
  });

  const servicesByName = new Map();
  for (const result of results) {
    for (const service of result.services) {
      const existing = servicesByName.get(service.name) || {
        name: service.name,
        description: service.description,
        regionNames: new Set()
      };
      if (!existing.description && service.description) existing.description = service.description;
      existing.regionNames.add(result.region.regionName);
      servicesByName.set(service.name, existing);
    }
  }

  return {
    regionNames: scanRegions.map((region) => region.regionName),
    services: Array.from(servicesByName.values())
      .map((service) => ({
        ...service,
        regionNames: Array.from(service.regionNames).sort(),
        regionCount: service.regionNames.size
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    errors: results.flatMap((result) => result.error ? [result.error] : [])
  };
}

export async function getLimitOptions(provider, config, query, providerRegionId = '') {
  const { regions } = await getRegionOptions(provider, config, query, providerRegionId);
  const selectedRegions = filterRegions(regions, query.regionNames);
  const scanRegions = selectedRegions.filter((region) => {
    return query.includeNonReadyRegions || normalizeStatus(region.status) === READY_STATUS;
  });

  if (!scanRegions.length) {
    return {
      regionNames: [],
      limits: [],
      errors: []
    };
  }

  const results = await mapWithConcurrency(scanRegions, config.regionConcurrency, async (region) => {
    try {
      const limitsClient = createLimitsClient(provider, region.regionName);
      const allServices = await listServices(limitsClient, query.compartmentId, config.pageSize, query.subscriptionId);
      const services = filterServices(allServices, query.serviceNames);
      const serviceResults = await mapWithConcurrency(
        services,
        config.serviceConcurrency,
        (service) => getServiceLimitOptions(limitsClient, config, query, region, service)
      );

      return {
        region,
        rows: serviceResults.flatMap((result) => result.rows),
        errors: serviceResults.flatMap((result) => result.error ? [result.error] : [])
      };
    } catch (error) {
      return {
        region,
        rows: [],
        errors: [{
          regionName: region.regionName,
          regionKey: region.regionKey,
          serviceName: '',
          message: formatError(error),
          statusCode: error.statusCode || error.status || ''
        }]
      };
    }
  });

  const limitsByName = new Map();
  for (const row of results.flatMap((result) => result.rows)) {
    const existing = limitsByName.get(row.limitName) || {
      name: row.limitName,
      description: row.limitDescription,
      serviceNames: new Set(),
      regionNames: new Set(),
      count: 0
    };
    if (!existing.description && row.limitDescription) existing.description = row.limitDescription;
    existing.serviceNames.add(row.serviceName);
    existing.regionNames.add(row.regionName);
    existing.count += 1;
    limitsByName.set(row.limitName, existing);
  }

  return {
    regionNames: scanRegions.map((region) => region.regionName),
    limits: Array.from(limitsByName.values())
      .map((limit) => ({
        name: limit.name,
        description: limit.description,
        serviceNames: Array.from(limit.serviceNames).sort(),
        serviceCount: limit.serviceNames.size,
        regionNames: Array.from(limit.regionNames).sort(),
        regionCount: limit.regionNames.size,
        count: limit.count
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    errors: results.flatMap((result) => result.errors)
  };
}

export function reportToCsv(report) {
  const headers = LIMIT_EXPORT_COLUMNS.map((column) => column.header);
  const lines = [headers.join(',')];
  for (const row of report.rows) {
    lines.push(LIMIT_EXPORT_COLUMNS.map((column) => csvCell(exportValue(report, row, column.key))).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function reportToXlsx(report) {
  return workbookToXlsxBuffer({
    sheetName: 'Limits',
    columns: LIMIT_EXPORT_COLUMNS,
    rows: report.rows.map((row) => {
      return Object.fromEntries(LIMIT_EXPORT_COLUMNS.map((column) => [column.key, exportValue(report, row, column.key)]));
    })
  });
}

function buildScanReport({
  scanStartedAt,
  query,
  identityRegion,
  subscribedRegions,
  selectedRegions,
  regionResults,
  skippedRegions,
  includeUsage,
  partial
}) {
  const rows = regionResults.flatMap((result) => result.rows);
  const errors = regionResults.flatMap((result) => result.errors);
  const regions = [...regionResults.map((result) => result.region), ...skippedRegions]
    .sort((a, b) => a.regionName.localeCompare(b.regionName));
  const cachedServices = regionResults.reduce((total, result) => total + (result.region.cachedServiceCount || 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    tenancyId: query.tenancyId,
    compartmentId: query.compartmentId,
    identityRegion,
    partial: Boolean(partial),
    filters: {
      regions: query.regionNames,
      services: query.serviceNames,
      limitNames: query.limitNames,
      limitFilter: query.limitFilter,
      subscriptionId: query.subscriptionId,
      includeNonReadyRegions: query.includeNonReadyRegions,
      scanMode: query.scanMode
    },
    totals: {
      subscribedRegions: subscribedRegions.length,
      selectedRegions: selectedRegions.length,
      scannedRegions: regionResults.length,
      services: countUnique(rows, (row) => row.serviceName),
      regionServices: countUnique(rows, (row) => `${row.regionName}:${row.serviceName}`),
      limits: rows.length,
      errors: errors.length,
      cachedServices,
      usageEnriched: Boolean(includeUsage),
      scanElapsedMs: Date.now() - scanStartedAt
    },
    regions,
    rows: rows.sort(compareLimitRows),
    errors
  };
}

async function scanRegion(provider, config, query, region, progress, scanOptions = {}) {
  const limitsClient = createLimitsClient(provider, region.regionName);
  const startedAt = Date.now();

  try {
    const allServices = await listServices(limitsClient, query.compartmentId, config.pageSize, query.subscriptionId);
    const services = filterServices(allServices, query.serviceNames);
    progress.servicesDiscovered(region, services);
    const serviceResults = await mapWithConcurrency(
      services,
      config.serviceConcurrency,
      async (service) => {
        progress.serviceStarted(region, service);
        const result = await scanService(limitsClient, config, query, region, service, scanOptions);
        progress.serviceCompleted(region, service, result);
        return result;
      }
    );
    const rows = serviceResults.flatMap((result) => result.rows);
    const errors = serviceResults.flatMap((result) => result.error ? [result.error] : []);
    const serviceCount = hasLimitRowFilter(query) ? countUnique(rows, (row) => row.serviceName) : services.length;

    return {
      region: {
        ...region,
        scanned: true,
        serviceCount,
        limitCount: rows.length,
        errorCount: errors.length,
        cachedServiceCount: serviceResults.filter((result) => result.cached).length,
        elapsedMs: Date.now() - startedAt,
        message: errors.length ? `${errors.length} service scans failed` : ''
      },
      rows,
      errors
    };
  } catch (error) {
    return {
      region: {
        ...region,
        scanned: false,
        serviceCount: 0,
        limitCount: 0,
        errorCount: 1,
        elapsedMs: Date.now() - startedAt,
        message: formatError(error)
      },
      rows: [],
      errors: [{
        regionName: region.regionName,
        regionKey: region.regionKey,
        serviceName: '',
        message: formatError(error),
        statusCode: error.statusCode || error.status || ''
      }]
    };
  }
}

async function scanService(limitsClient, config, query, region, service, scanOptions = {}) {
  const includeUsage = scanOptions.includeUsage !== undefined ? Boolean(scanOptions.includeUsage) : query.scanMode !== 'fast';
  const serviceCache = scanOptions.serviceCache;
  const cacheKey = serviceScanCacheKey(query, region, service, includeUsage);
  const cached = serviceCache?.get(cacheKey);
  if (cached) {
    return {
      rows: cloneRows(cached.rows),
      cached: true
    };
  }
  if (!includeUsage) {
    const fullCached = serviceCache?.get(serviceScanCacheKey(query, region, service, true));
    if (fullCached) {
      return {
        rows: cloneRows(fullCached.rows),
        cached: true
      };
    }
  }

  try {
    const fastCacheKey = serviceScanCacheKey(query, region, service, false);
    const fastCached = includeUsage ? serviceCache?.get(fastCacheKey) : null;
    const rows = fastCached
      ? cloneRows(fastCached.rows).map(markUsagePending)
      : await loadServiceLimitRows(limitsClient, config, query, region, service);
    const resultRows = includeUsage
      ? await mapWithConcurrency(
        rows.map(markUsagePending),
        config.resourceAvailabilityConcurrency,
        (row) => enrichLimitRowWithUsage(limitsClient, row, query.subscriptionId)
      )
      : rows.map(markUsageDeferred);

    serviceCache?.set(cacheKey, { rows: cloneRows(resultRows) });
    if (!includeUsage && !fastCached) {
      serviceCache?.set(fastCacheKey, { rows: cloneRows(resultRows) });
    }

    return {
      rows: resultRows,
      cached: false
    };
  } catch (error) {
    return {
      rows: [],
      cached: false,
      error: {
        regionName: region.regionName,
        regionKey: region.regionKey,
        serviceName: service.name,
        message: formatError(error),
        statusCode: error.statusCode || error.status || ''
      }
    };
  }
}

async function loadServiceLimitRows(limitsClient, config, query, region, service) {
  const [limitValues, limitDefinitions] = await Promise.all([
    listLimitValues(
      limitsClient,
      query.compartmentId,
      service.name,
      config.pageSize,
      query.subscriptionId
    ),
    listLimitDefinitions(
      limitsClient,
      query.compartmentId,
      service.name,
      config.pageSize,
      query.subscriptionId
    )
  ]);
  const definitionsByName = new Map(limitDefinitions.map((definition) => [definition.name, definition]));
  return filterLimitRows(
    limitValues.map((limitValue) => buildLimitRow(region, service, limitValue, definitionsByName, query)),
    query
  );
}

async function getServiceLimitOptions(limitsClient, config, query, region, service) {
  try {
    const [limitValues, limitDefinitions] = await Promise.all([
      listLimitValues(
        limitsClient,
        query.compartmentId,
        service.name,
        config.pageSize,
        query.subscriptionId
      ),
      listLimitDefinitions(
        limitsClient,
        query.compartmentId,
        service.name,
        config.pageSize,
        query.subscriptionId
      )
    ]);
    const definitionsByName = new Map(limitDefinitions.map((definition) => [definition.name, definition]));
    return {
      rows: limitValues.map((limitValue) => buildLimitRow(region, service, limitValue, definitionsByName, query))
    };
  } catch (error) {
    return {
      rows: [],
      error: {
        regionName: region.regionName,
        regionKey: region.regionKey,
        serviceName: service.name,
        message: formatError(error),
        statusCode: error.statusCode || error.status || ''
      }
    };
  }
}

function buildLimitRow(region, service, limitValue, definitionsByName, query) {
  const definition = definitionsByName.get(limitValue.name) || {};
  return {
    regionName: region.regionName,
    regionKey: region.regionKey,
    regionStatus: region.status,
    isHomeRegion: region.isHomeRegion,
    serviceName: service.name,
    serviceDescription: service.description,
    limitName: limitValue.name,
    limitDescription: definition.description || '',
    value: limitValue.value,
    used: undefined,
    available: undefined,
    effectiveLimit: undefined,
    percentUsed: undefined,
    resourceAvailabilitySupported: Boolean(definition.isResourceAvailabilitySupported),
    usageStatus: definition.isResourceAvailabilitySupported ? 'pending' : 'not_supported',
    usageError: '',
    scopeType: limitValue.scopeType,
    availabilityDomain: limitValue.availabilityDomain,
    subscriptionId: query.subscriptionId || limitValue.subscriptionId,
    compartmentId: query.compartmentId
  };
}

function markUsageDeferred(row) {
  return row.resourceAvailabilitySupported
    ? { ...row, usageStatus: 'deferred', used: undefined, available: undefined, effectiveLimit: undefined, percentUsed: undefined, usageError: '' }
    : { ...row };
}

function markUsagePending(row) {
  return row.resourceAvailabilitySupported
    ? { ...row, usageStatus: 'pending', used: undefined, available: undefined, effectiveLimit: undefined, percentUsed: undefined, usageError: '' }
    : { ...row };
}

async function enrichLimitRowWithUsage(limitsClient, row, subscriptionId) {
  if (!row.resourceAvailabilitySupported) {
    return row;
  }

  try {
    const availability = await getResourceAvailability(limitsClient, row, subscriptionId);
    const used = bestNumber(availability.fractionalUsage, availability.used);
    const available = bestNumber(availability.fractionalAvailability, availability.available);
    const effectiveLimit = bestNumber(availability.effectiveQuotaValue, sumIfNumbers(used, available), row.value);
    return {
      ...row,
      used,
      available,
      effectiveLimit,
      percentUsed: calculatePercentUsed(used, effectiveLimit),
      usageStatus: used === undefined && available === undefined ? 'unavailable' : 'available'
    };
  } catch (error) {
    return {
      ...row,
      usageStatus: 'error',
      usageError: formatError(error)
    };
  }
}

function serviceScanCacheKey(query, region, service, includeUsage) {
  return JSON.stringify({
    tenancyId: query.tenancyId,
    compartmentId: query.compartmentId,
    subscriptionId: query.subscriptionId,
    regionName: region.regionName,
    serviceName: service.name,
    limitNames: [...(query.limitNames || [])].sort(),
    limitFilter: query.limitFilter,
    includeUsage: Boolean(includeUsage)
  });
}

function cloneRows(rows) {
  return (rows || []).map((row) => ({ ...row }));
}

function filterRegions(regions, regionNames) {
  if (!regionNames.length) return regions;
  const wanted = new Set(regionNames.map((regionName) => regionName.toLowerCase()));
  return regions.filter((region) => {
    return wanted.has(region.regionName.toLowerCase()) || wanted.has(region.regionKey.toLowerCase());
  });
}

function filterServices(services, serviceNames) {
  if (!serviceNames.length) return services;
  const wanted = new Set(serviceNames.map((serviceName) => serviceName.toLowerCase()));
  return services.filter((service) => wanted.has(service.name.toLowerCase()));
}

function filterLimitRows(rows, query) {
  const wantedNames = new Set((query.limitNames || []).map((limitName) => limitName.toLowerCase()));
  const normalized = String(query.limitFilter || '').trim().toLowerCase();
  if (!wantedNames.size && !normalized) return rows;

  return rows.filter((row) => {
    if (wantedNames.size && !wantedNames.has(String(row.limitName || '').toLowerCase())) return false;
    if (!normalized) return true;
    return [row.limitName, row.limitDescription].some((value) => String(value || '').toLowerCase().includes(normalized));
  });
}

function hasLimitRowFilter(query) {
  return Boolean((query.limitNames || []).length || query.limitFilter);
}

function createScanProgressReporter(onProgress) {
  const publish = typeof onProgress === 'function' ? onProgress : () => {};
  const state = {
    phase: 'starting',
    message: 'Starting scan',
    percent: 0,
    subscribedRegions: 0,
    selectedRegions: 0,
    totalRegions: 0,
    completedRegions: 0,
    skippedRegions: 0,
    totalServices: 0,
    completedServices: 0,
    cachedServices: 0,
    rows: 0,
    errors: 0,
    currentRegion: '',
    currentService: ''
  };

  function emit(partial = {}) {
    const previousPercent = Number(state.percent) || 0;
    Object.assign(state, partial);
    const nextPercent = Math.min(100, Math.max(0, Math.round(Number(partial.percent ?? calculateProgressPercent(state)) || 0)));
    state.percent = Math.max(previousPercent, nextPercent);
    publish({
      ...state,
      updatedAt: new Date().toISOString()
    });
  }

  return {
    update: emit,
    updateTotals(totals) {
      emit({
        ...totals,
        phase: totals.totalRegions ? 'scanning' : 'complete',
        message: totals.totalRegions
          ? `Scanning ${totals.totalRegions} region${totals.totalRegions === 1 ? '' : 's'}`
          : 'No ready regions selected',
        percent: totals.totalRegions ? 5 : 100
      });
    },
    regionStarted(region) {
      emit({
        phase: 'scanning',
        currentRegion: region.regionName,
        currentService: '',
        message: `Scanning region ${region.regionName}`
      });
    },
    servicesDiscovered(region, services) {
      state.totalServices += services.length;
      emit({
        currentRegion: region.regionName,
        message: services.length
          ? `${region.regionName}: ${services.length} service${services.length === 1 ? '' : 's'} discovered`
          : `${region.regionName}: no services matched the filters`
      });
    },
    serviceStarted(region, service) {
      emit({
        currentRegion: region.regionName,
        currentService: service.name,
        message: `${region.regionName}: scanning ${service.name}`
      });
    },
    serviceCompleted(region, service, result = {}) {
      state.completedServices += 1;
      if (result.cached) state.cachedServices += 1;
      emit({
        currentRegion: region.regionName,
        currentService: service.name,
        cachedServices: state.cachedServices,
        message: result.cached
          ? `${region.regionName}: reused cached ${service.name}`
          : `${region.regionName}: completed ${service.name}`
      });
    },
    regionCompleted(result) {
      state.completedRegions += 1;
      state.rows += result.rows.length;
      state.errors += result.errors.length;
      emit({
        currentRegion: result.region.regionName,
        currentService: '',
        message: `Completed ${result.region.regionName}`
      });
    },
    complete(partial = {}) {
      emit({
        ...partial,
        phase: 'complete',
        currentRegion: '',
        currentService: '',
        percent: 100
      });
    }
  };
}

function calculateProgressPercent(state) {
  if (state.phase === 'complete') return 100;
  const regionProgress = state.totalRegions ? state.completedRegions / state.totalRegions : 0;
  const serviceProgress = state.totalServices ? state.completedServices / state.totalServices : regionProgress;
  return Math.min(99, Math.max(1, Math.round(5 + (regionProgress * 35) + (serviceProgress * 58))));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function normalizeStatus(status) {
  return String(status || '').toUpperCase();
}

function countUnique(rows, keyFn) {
  return new Set(rows.map(keyFn).filter(Boolean)).size;
}

function compareLimitRows(a, b) {
  return a.regionName.localeCompare(b.regionName)
    || a.serviceName.localeCompare(b.serviceName)
    || a.limitName.localeCompare(b.limitName)
    || String(a.availabilityDomain || '').localeCompare(String(b.availabilityDomain || ''));
}

function bestNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function sumIfNumbers(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) ? a + b : undefined;
}

function calculatePercentUsed(used, effectiveLimit) {
  if (!Number.isFinite(used) || !Number.isFinite(effectiveLimit) || effectiveLimit <= 0) return undefined;
  return (used / effectiveLimit) * 100;
}

function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportValue(report, row, key) {
  return row[key] ?? report[key] ?? '';
}

function formatError(error) {
  if (!error) return 'Unknown OCI error';
  const status = error.statusCode || error.status;
  const message = error.message || String(error);
  return status ? `${status}: ${message}` : message;
}
