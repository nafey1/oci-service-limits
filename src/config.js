import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function intEnv(name, fallback, min = 1) {
  const parsed = Number.parseInt(env(name, String(fallback)), 10);
  return Number.isInteger(parsed) && parsed >= min ? parsed : fallback;
}

function boolEnv(name, fallback = false) {
  return parseBoolean(env(name), fallback);
}

export function getAppConfig() {
  return {
    port: intEnv('PORT', 3000),
    host: env('HOST', '127.0.0.1'),
    authMethod: env('OCI_AUTH_METHOD', 'config').toLowerCase(),
    configFile: path.resolve(env('OCI_CONFIG_FILE', '~/.oci/config').replace(/^~(?=$|\/)/, process.env.HOME ?? '')),
    profile: env('OCI_PROFILE', 'DEFAULT'),
    tenancyId: env('OCI_TENANCY_OCID'),
    compartmentId: env('OCI_LIMITS_COMPARTMENT_OCID'),
    subscriptionId: env('OCI_SUBSCRIPTION_OCID'),
    identityRegion: env('OCI_IDENTITY_REGION', env('OCI_REGION')),
    includeNonReadyRegions: boolEnv('INCLUDE_NON_READY_REGIONS', false),
    pageSize: intEnv('OCI_PAGE_SIZE', 1000, 1),
    regionConcurrency: intEnv('REGION_CONCURRENCY', 3, 1),
    serviceConcurrency: intEnv('SERVICE_CONCURRENCY', 6, 1),
    resourceAvailabilityConcurrency: intEnv('RESOURCE_AVAILABILITY_CONCURRENCY', 2, 1),
    cacheTtlSeconds: intEnv('CACHE_TTL_SECONDS', 300, 0),
    backgroundFullScanOnFast: boolEnv('BACKGROUND_FULL_SCAN_ON_FAST', true),
    defaults: {
      regions: env('DEFAULT_REGION_NAMES'),
      services: env('DEFAULT_SERVICE_NAMES'),
      limitNames: env('DEFAULT_LIMIT_NAMES'),
      limitFilter: env('DEFAULT_LIMIT_FILTER'),
      subscriptionId: env('OCI_SUBSCRIPTION_OCID'),
      scanMode: normalizeScanMode(env('DEFAULT_SCAN_MODE', 'full'))
    }
  };
}

export function normalizeLimitsQuery(input, config = getAppConfig(), inferredTenancyId = '') {
  const tenancyId = firstValue(input.tenantId) || config.tenancyId || inferredTenancyId;
  const compartmentId = firstValue(input.compartmentId) || config.compartmentId || tenancyId;
  const query = {
    tenancyId,
    compartmentId,
    subscriptionId: firstValue(input.subscriptionId) || config.subscriptionId || '',
    regionNames: parseList(firstValue(input.regions ?? input.region) || config.defaults.regions),
    serviceNames: parseList(firstValue(input.services ?? input.service) || config.defaults.services),
    limitNames: parseList(firstValue(input.limitNames ?? input.limitName ?? input.limit) || config.defaults.limitNames),
    limitFilter: String(firstValue(input.limitFilter) || config.defaults.limitFilter || '').trim(),
    includeNonReadyRegions: parseBoolean(firstValue(input.includeNonReadyRegions), config.includeNonReadyRegions),
    scanMode: normalizeScanMode(firstValue(input.scanMode) || config.defaults.scanMode || 'full'),
    refresh: parseBoolean(firstValue(input.refresh), false)
  };

  const errors = [];
  if (!query.tenancyId) {
    errors.push('OCI_TENANCY_OCID is required unless the selected auth provider exposes a tenancy OCID.');
  }
  if (!query.compartmentId) {
    errors.push('OCI_LIMITS_COMPARTMENT_OCID or tenancy OCID is required.');
  }

  if (errors.length) {
    const error = new Error(errors.join(' '));
    error.statusCode = 400;
    throw error;
  }

  return query;
}

export function parseList(value) {
  if (Array.isArray(value)) return value.flatMap((item) => parseList(item));
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

export function normalizeScanMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'fast' ? 'fast' : 'full';
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}
