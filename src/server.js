import express from 'express';
import { readFileSync } from 'node:fs';
import { createTtlCache } from './cache.js';
import { getAppConfig, normalizeLimitsQuery } from './config.js';
import { createAuthProvider, getAuthProviderRegionId, getAuthProviderTenancyId } from './ociAuth.js';
import { getLimitOptions, getRegionOptions, getServiceOptions, reportToCsv, reportToXlsx, scanTenancyLimits } from './limitsScan.js';

const config = getAppConfig();
const packageInfo = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const app = express();
const cache = createTtlCache(config.cacheTtlSeconds);
const scanProgress = new Map();
const scanProgressTtlMs = 10 * 60 * 1000;

let ociContextPromise;

app.disable('x-powered-by');
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

app.get('/api/progress/:scanId', (req, res) => {
  cleanupScanProgress();
  const progress = scanProgress.get(scanIdFrom(req.params.scanId));
  if (!progress) {
    res.status(404).json({ error: 'Scan progress not found' });
    return;
  }

  res.json(progress);
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

async function getLimitsReport(rawQuery, options = {}) {
  const context = await getOciContext();
  const query = normalizeLimitsQuery(rawQuery, config, context.tenancyId);
  const scanId = options.scanId || '';
  const { refresh, ...cacheableQuery } = query;
  const cacheKey = JSON.stringify(cacheableQuery);
  if (!query.refresh) {
    const cached = cache.get(cacheKey);
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
      onProgress: (progress) => updateScanProgress(scanId, progress)
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
    cache.set(cacheKey, report);
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
  scanProgress.set(scanId, {
    ...previous,
    ...update,
    scanId,
    updatedAt: new Date().toISOString()
  });
}

function cleanupScanProgress() {
  const cutoff = Date.now() - scanProgressTtlMs;
  for (const [scanId, progress] of scanProgress.entries()) {
    const updatedAt = Date.parse(progress.updatedAt || progress.createdAt || 0);
    if (!Number.isFinite(updatedAt) || updatedAt < cutoff) {
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
