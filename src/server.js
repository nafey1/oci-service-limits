import express from 'express';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTtlCache } from './cache.js';
import { getAppConfig, normalizeLimitsQuery } from './config.js';
import { createAuthProvider, getAuthProviderRegionId, getAuthProviderTenancyId } from './ociAuth.js';
import { getLimitOptions, getRegionOptions, getServiceOptions, reportToCsv, reportToXlsx, scanTenancyLimits } from './limitsScan.js';

const config = getAppConfig();
const packageInfo = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const app = express();
const reportCache = createTtlCache(config.cacheTtlSeconds);
const serviceScanCache = createTtlCache(config.cacheTtlSeconds);
const scanProgress = new Map();
const scanJobs = new Map();
const backgroundWarmups = new Map();
const scanJobTtlMs = 60 * 60 * 1000;
const fileScanStoreEnabled = config.scanStore === 'file';

let latestScanId = '';

let ociContextPromise;

app.disable('x-powered-by');
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(new URL('../public', import.meta.url).pathname));

app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/defaults', async (req, res) => {
  const context = await getOciContext();
  const tenancyId = config.tenancyId || context.tenancyId;
  res.json({
    authMethod: config.authMethod,
    appVersion: packageInfo.version,
    profile: config.profile,
    identityRegion: config.identityRegion || context.providerRegionId || 'us-ashburn-1',
    defaults: config.defaults,
    includeNonReadyRegions: config.includeNonReadyRegions,
    backgroundFullScanOnFast: config.backgroundFullScanOnFast,
    hasTenancyId: Boolean(tenancyId),
    tenancySource: config.tenancyId ? 'OCI_TENANCY_OCID' : 'auth_provider'
  });
});

app.get('/api/limits', async (req, res, next) => {
  try {
    res.json(await getLimitsReport(req.query, { scanId: scanIdFrom(req.query.scanId) }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/scans', async (req, res, next) => {
  try {
    const job = await createScanJob({ ...req.query, ...req.body });
    res.status(job.status === 'complete' ? 200 : 202).json(scanJobSummary(job));
  } catch (error) {
    next(error);
  }
});

app.get('/api/scans/latest', async (req, res, next) => {
  try {
    cleanupScanJobs();
    const job = await latestScanJob();
    if (!job) {
      res.status(404).json({ error: 'No scan jobs found' });
      return;
    }

    res.json(scanJobSummary(job));
  } catch (error) {
    next(error);
  }
});

app.get('/api/scans/:scanId', async (req, res, next) => {
  try {
    cleanupScanJobs();
    const job = await scanJobFrom(req.params.scanId);
    if (!job) {
      res.status(404).json({ error: 'Scan job not found' });
      return;
    }

    res.json(scanJobSummary(job));
  } catch (error) {
    next(error);
  }
});

app.get('/api/scans/:scanId/result', async (req, res, next) => {
  try {
    cleanupScanJobs();
    const job = await scanJobFrom(req.params.scanId);
    if (!job) {
      res.status(404).json({ error: 'Scan job not found' });
      return;
    }

    if (job.status === 'failed') {
      res.status(500).json({ error: job.error?.message || 'Scan failed' });
      return;
    }

    if (job.status !== 'complete' || !job.result) {
      if (job.partialResult) {
        res.status(206).json(scanReportForResponse(job.partialResult, job, { partial: true }));
        return;
      }

      res.status(202).json(scanJobSummary(job));
      return;
    }

    res.json(scanReportForResponse(job.result, job));
  } catch (error) {
    next(error);
  }
});

app.get('/api/progress/:scanId', async (req, res, next) => {
  try {
    cleanupScanJobs();
    const job = await scanJobFrom(req.params.scanId);
    const progress = job?.progress || scanProgress.get(scanIdFrom(req.params.scanId));
    if (!progress) {
      res.status(404).json({ error: 'Scan progress not found' });
      return;
    }

    res.json(progress);
  } catch (error) {
    next(error);
  }
});

app.get('/api/limits.csv', async (req, res, next) => {
  try {
    const report = await getLimitsReport(req.query);
    res.type('text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="oci-service-limits.csv"');
    res.send(reportToCsv(report));
  } catch (error) {
    next(error);
  }
});

app.get('/api/scans/:scanId/limits.csv', async (req, res, next) => {
  try {
    const report = await completedScanReport(req.params.scanId, res);
    if (!report) return;
    res.type('text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="oci-service-limits.csv"');
    res.send(reportToCsv(report));
  } catch (error) {
    next(error);
  }
});

app.get('/api/limits.xlsx', async (req, res, next) => {
  try {
    const report = await getLimitsReport(req.query);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="oci-service-limits.xlsx"');
    res.send(reportToXlsx(report));
  } catch (error) {
    next(error);
  }
});

app.get('/api/scans/:scanId/limits.xlsx', async (req, res, next) => {
  try {
    const report = await completedScanReport(req.params.scanId, res);
    if (!report) return;
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="oci-service-limits.xlsx"');
    res.send(reportToXlsx(report));
  } catch (error) {
    next(error);
  }
});

app.get('/api/options/regions', async (req, res, next) => {
  try {
    const context = await getOciContext();
    const query = normalizeLimitsQuery(req.query, config, context.tenancyId);
    const options = await getRegionOptions(context.provider, config, query, context.providerRegionId);
    res.json({
      identityRegion: options.identityRegion,
      regions: options.regions
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/options/services', async (req, res, next) => {
  try {
    const context = await getOciContext();
    const query = normalizeLimitsQuery(req.query, config, context.tenancyId);
    const options = await getServiceOptions(context.provider, config, query, context.providerRegionId);
    res.json(options);
  } catch (error) {
    next(error);
  }
});

app.get('/api/options/limits', async (req, res, next) => {
  try {
    const context = await getOciContext();
    const query = normalizeLimitsQuery(req.query, config, context.tenancyId);
    const options = await getLimitOptions(context.provider, config, query, context.providerRegionId);
    res.json(options);
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  const statusCode = error.statusCode || error.status || 500;
  res.status(statusCode).json({
    error: statusCode >= 500 ? 'Internal server error' : error.message,
    detail: process.env.NODE_ENV === 'production' && statusCode >= 500 ? undefined : error.message
  });
});

async function createScanJob(rawQuery) {
  cleanupScanJobs();
  const context = await getOciContext();
  const query = normalizeLimitsQuery(rawQuery, config, context.tenancyId);
  const scanId = scanIdFrom(rawQuery.scanId) || randomUUID();
  const createdAt = new Date().toISOString();
  const job = {
    scanId,
    status: 'queued',
    createdAt,
    updatedAt: createdAt,
    completedAt: '',
    query: scanQuerySummary(query),
    progress: {
      scanId,
      phase: 'queued',
      message: 'Scan queued',
      percent: 0,
      done: false,
      failed: false,
      createdAt,
      updatedAt: createdAt
    },
    result: null,
    partialResult: null,
    error: null,
    cached: false,
    storage: fileScanStoreEnabled ? 'file' : 'memory',
    loadedFromPersistence: false,
    persistedAt: ''
  };

  scanJobs.set(scanId, job);
  latestScanId = scanId;
  updateScanProgress(scanId, job.progress);
  job.promise = runScanJob(job, context, query);
  job.promise.catch(() => {});
  return job;
}

async function runScanJob(job, context, query) {
  job.status = 'running';
  touchScanJob(job);

  try {
    const report = await getLimitsReportForQuery(context, query, job.scanId, {
      onPartialReport: (partialReport) => {
        job.partialResult = partialReport;
        touchScanJob(job);
      }
    });
    job.status = 'complete';
    job.result = report;
    job.partialResult = null;
    job.cached = Boolean(scanProgress.get(job.scanId)?.cached);
    job.completedAt = new Date().toISOString();
    updateScanProgress(job.scanId, {
      phase: 'complete',
      message: job.cached ? 'Loaded cached scan result' : 'Scan complete',
      percent: 100,
      done: true,
      failed: false,
      rows: report.rows?.length || 0,
      errors: report.errors?.length || 0
    });
    await persistCompletedScanJob(job);
    scheduleBackgroundFullScan(context, query);
  } catch (error) {
    job.status = 'failed';
    job.error = {
      message: error.message || 'Scan failed',
      statusCode: error.statusCode || error.status || 500
    };
    job.completedAt = new Date().toISOString();
    updateScanProgress(job.scanId, {
      phase: 'failed',
      message: job.error.message,
      percent: 100,
      done: true,
      failed: true
    });
  } finally {
    touchScanJob(job);
  }
}

async function getLimitsReport(rawQuery, options = {}) {
  const context = await getOciContext();
  const query = normalizeLimitsQuery(rawQuery, config, context.tenancyId);
  return getLimitsReportForQuery(context, query, options.scanId || '');
}

async function getLimitsReportForQuery(context, query, scanId = '', options = {}) {
  const { refresh, ...cacheableQuery } = query;
  const cacheKey = JSON.stringify(cacheableQuery);
  if (!query.refresh) {
    const cached = reportCache.get(cacheKey);
    if (cached) {
      updateScanProgress(scanId, {
        phase: 'complete',
        message: 'Loaded cached scan result',
        percent: 100,
        done: true,
        cached: true,
        rows: cached.rows?.length || 0,
        errors: cached.errors?.length || 0
      });
      return cached;
    }
  }

  updateScanProgress(scanId, {
    phase: 'starting',
    message: 'Starting scan',
    percent: 1,
    done: false,
    failed: false,
    cached: false
  });

  try {
    const report = await scanTenancyLimits(context.provider, config, query, context.providerRegionId, {
      includeUsage: query.scanMode !== 'fast',
      serviceCache: serviceScanCache,
      onProgress: (progress) => updateScanProgress(scanId, progress),
      onPartialReport: options.onPartialReport
    });
    updateScanProgress(scanId, {
      phase: 'complete',
      message: 'Scan complete',
      percent: 100,
      done: true,
      failed: false,
      rows: report.rows?.length || 0,
      errors: report.errors?.length || 0
    });
    reportCache.set(cacheKey, report);
    return report;
  } catch (error) {
    updateScanProgress(scanId, {
      phase: 'failed',
      message: error.message || 'Scan failed',
      percent: 100,
      done: true,
      failed: true
    });
    throw error;
  }
}

function scanIdFrom(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const scanId = String(raw || '').trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(scanId) ? scanId : '';
}

function updateScanProgress(scanId, update) {
  if (!scanId) return;
  const previous = scanProgress.get(scanId) || {
    scanId,
    createdAt: new Date().toISOString()
  };
  const nextProgress = {
    ...previous,
    ...update,
    scanId,
    updatedAt: new Date().toISOString()
  };
  scanProgress.set(scanId, nextProgress);

  const job = scanJobs.get(scanId);
  if (job) {
    job.progress = nextProgress;
    job.cached = Boolean(nextProgress.cached);
    touchScanJob(job);
  }
}

async function scanJobFrom(value) {
  const scanId = scanIdFrom(value);
  if (!scanId) return undefined;
  return scanJobs.get(scanId) || await loadPersistedScanJob(scanId);
}

async function latestScanJob() {
  if (latestScanId && scanJobs.has(latestScanId)) return scanJobs.get(latestScanId);
  const memoryJob = Array.from(scanJobs.values())
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt))[0];
  return memoryJob || await loadLatestPersistedScanJob();
}

async function completedScanReport(value, res) {
  cleanupScanJobs();
  const job = await scanJobFrom(value);
  if (!job) {
    res.status(404).json({ error: 'Scan job not found' });
    return null;
  }

  if (job.status !== 'complete' || !job.result) {
    res.status(409).json({ error: 'Scan result is not ready', scan: scanJobSummary(job) });
    return null;
  }

  return job.result;
}

function scanJobSummary(job) {
  return {
    scanId: job.scanId,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    done: job.status === 'complete' || job.status === 'failed',
    failed: job.status === 'failed',
    cached: Boolean(job.cached),
    storage: job.storage || 'memory',
    loadedFromPersistence: Boolean(job.loadedFromPersistence),
    persistedAt: job.persistedAt || '',
    hasResult: Boolean(job.result),
    hasPartialResult: Boolean(job.partialResult),
    partialRows: job.partialResult?.rows?.length || 0,
    query: job.query,
    progress: job.progress,
    error: job.error
  };
}

function scanReportForResponse(report, job, { partial = false } = {}) {
  return {
    ...report,
    partial: Boolean(partial || report.partial),
    storage: job.storage || 'memory',
    loadedFromPersistence: Boolean(job.loadedFromPersistence),
    persistedAt: job.persistedAt || '',
    scan: scanJobSummary(job)
  };
}

async function persistCompletedScanJob(job) {
  if (!fileScanStoreEnabled || job.status !== 'complete' || !job.result) return;

  const persistedAt = new Date().toISOString();
  const payload = {
    scanId: job.scanId,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    query: job.query,
    progress: job.progress,
    result: job.result,
    partialResult: null,
    error: job.error,
    cached: Boolean(job.cached),
    storage: 'file',
    persistedAt
  };

  await mkdir(config.scanDataDir, { recursive: true });
  await writeFile(persistedScanPath(job.scanId), JSON.stringify(payload), 'utf8');
  job.storage = 'file';
  job.persistedAt = persistedAt;
}

async function loadPersistedScanJob(scanId) {
  if (!fileScanStoreEnabled) return undefined;

  try {
    const payload = JSON.parse(await readFile(persistedScanPath(scanId), 'utf8'));
    if (payload?.scanId !== scanId || payload.status !== 'complete' || !payload.result) return undefined;

    const job = {
      scanId: payload.scanId,
      status: 'complete',
      createdAt: payload.createdAt || payload.completedAt || new Date().toISOString(),
      updatedAt: payload.updatedAt || payload.persistedAt || payload.completedAt || new Date().toISOString(),
      completedAt: payload.completedAt || payload.persistedAt || '',
      query: payload.query || {},
      progress: payload.progress || {
        scanId,
        phase: 'complete',
        message: 'Loaded scan result from persistence',
        percent: 100,
        done: true,
        failed: false,
        createdAt: payload.createdAt || new Date().toISOString(),
        updatedAt: payload.persistedAt || new Date().toISOString()
      },
      result: payload.result,
      partialResult: null,
      error: payload.error || null,
      cached: Boolean(payload.cached),
      storage: 'file',
      loadedFromPersistence: true,
      persistedAt: payload.persistedAt || ''
    };
    job.progress = {
      ...job.progress,
      scanId,
      message: 'Loaded scan result from persistence',
      done: true,
      failed: false,
      cached: Boolean(job.cached)
    };

    scanJobs.set(scanId, job);
    latestScanId = scanId;
    scanProgress.set(scanId, job.progress);
    return job;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function loadLatestPersistedScanJob() {
  if (!fileScanStoreEnabled) return undefined;

  try {
    const entries = await readdir(config.scanDataDir, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -5))
      .filter((scanId) => scanIdFrom(scanId));

    const jobs = (await Promise.all(candidates.map((scanId) => loadPersistedScanJob(scanId)))).filter(Boolean);
    const latest = jobs.sort((a, b) => Date.parse(b.persistedAt || b.completedAt || 0) - Date.parse(a.persistedAt || a.completedAt || 0))[0];
    if (latest) latestScanId = latest.scanId;
    return latest;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function persistedScanPath(scanId) {
  return path.join(config.scanDataDir, `${scanId}.json`);
}

function touchScanJob(job) {
  job.updatedAt = new Date().toISOString();
}

function scanQuerySummary(query) {
  return {
    regions: query.regionNames,
    services: query.serviceNames,
    limitNames: query.limitNames,
    limitFilter: query.limitFilter,
    scanMode: query.scanMode,
    includeNonReadyRegions: query.includeNonReadyRegions,
    hasSubscriptionId: Boolean(query.subscriptionId)
  };
}

function scheduleBackgroundFullScan(context, query) {
  if (!config.backgroundFullScanOnFast || query.scanMode !== 'fast') return;

  const fullQuery = {
    ...query,
    refresh: false,
    scanMode: 'full'
  };
  const { refresh, ...cacheableQuery } = fullQuery;
  const cacheKey = JSON.stringify(cacheableQuery);

  if (reportCache.get(cacheKey) || backgroundWarmups.has(cacheKey)) return;

  const warmup = scanTenancyLimits(context.provider, config, fullQuery, context.providerRegionId, {
    includeUsage: true,
    serviceCache: serviceScanCache
  })
    .then((report) => {
      reportCache.set(cacheKey, report);
      return report;
    })
    .catch((error) => {
      console.warn(`Background full scan warmup failed: ${error.message || error}`);
    })
    .finally(() => {
      backgroundWarmups.delete(cacheKey);
    });

  backgroundWarmups.set(cacheKey, warmup);
}

function cleanupScanJobs() {
  const cutoff = Date.now() - scanJobTtlMs;
  for (const [scanId, job] of scanJobs.entries()) {
    const updatedAt = Date.parse(job.updatedAt || job.createdAt || 0);
    if (job.status !== 'running' && job.status !== 'queued' && (!Number.isFinite(updatedAt) || updatedAt < cutoff)) {
      scanJobs.delete(scanId);
    }
  }

  for (const [scanId, progress] of scanProgress.entries()) {
    const updatedAt = Date.parse(progress.updatedAt || progress.createdAt || 0);
    if (!scanJobs.has(scanId) && (!Number.isFinite(updatedAt) || updatedAt < cutoff)) {
      scanProgress.delete(scanId);
    }
  }
}

async function getOciContext() {
  if (!ociContextPromise) {
    ociContextPromise = Promise.resolve().then(async () => {
      const provider = await createAuthProvider(config);
      return {
        provider,
        tenancyId: getAuthProviderTenancyId(provider),
        providerRegionId: getAuthProviderRegionId(provider)
      };
    });
  }
  return ociContextPromise;
}

app.listen(config.port, config.host, () => {
  console.log(`OCI service limits app listening on http://${config.host}:${config.port}`);
});
