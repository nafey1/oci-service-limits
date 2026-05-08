const form = document.querySelector('#limitsForm');
const regionRowsEl = document.querySelector('#regionRows');
const limitRowsEl = document.querySelector('#limitRows');
const errorRowsEl = document.querySelector('#errorRows');
const errorsSection = document.querySelector('#errorsSection');
const statusText = document.querySelector('#statusText');
const csvLink = document.querySelector('#csvLink');
const xlsxLink = document.querySelector('#xlsxLink');
const themeSelect = document.querySelector('#themeSelect');
const scanBanner = document.querySelector('#scanBanner');
const scanBannerDetail = document.querySelector('#scanBannerDetail');
const scanProgressFill = document.querySelector('#scanProgressFill');
const scanProgressText = document.querySelector('#scanProgressText');
const refreshButton = document.querySelector('#refreshButton');
const footerVersion = document.querySelector('#footerVersion');
const footerScanContext = document.querySelector('#footerScanContext');
const footerScope = document.querySelector('#footerScope');
const footerRuntime = document.querySelector('#footerRuntime');
const limitRowCount = document.querySelector('#limitRowCount');
const summaryToggle = document.querySelector('#summaryToggle');
const summaryTableWrap = document.querySelector('#summaryTableWrap');
const alertPolicySelect = document.querySelector('#alertPolicy');
const warningThresholdInput = document.querySelector('#warningThreshold');
const criticalThresholdInput = document.querySelector('#criticalThreshold');
const severityFilterButtons = Array.from(document.querySelectorAll('[data-severity-filter]'));
const severityCountEls = Object.fromEntries(
  Array.from(document.querySelectorAll('[data-severity-count]')).map((element) => [element.dataset.severityCount, element])
);
const subscriptionInput = form.elements.subscriptionId;
const includeNonReadyInput = form.elements.includeNonReadyRegions;
const regionSelect = createMultiSelect({
  root: document.querySelector('[data-multi-select="regions"]'),
  allSummary: 'All ready regions',
  noneSummary: 'No regions'
});
const serviceSelect = createMultiSelect({
  root: document.querySelector('[data-multi-select="services"]'),
  allSummary: 'All services',
  noneSummary: 'No services'
});
const limitSelect = createMultiSelect({
  root: document.querySelector('[data-multi-select="limits"]'),
  allSummary: 'All Service Limits',
  noneSummary: 'No Service Limits'
});
const columnFilterControls = Array.from(document.querySelectorAll('[data-column-filter]')).map((root) => ({
  key: root.dataset.columnFilter,
  select: createMultiSelect({
    root,
    allSummary: 'All',
    noneSummary: 'None'
  })
}));

const counters = {
  subscribedRegions: document.querySelector('#subscribedRegions'),
  scannedRegions: document.querySelector('#scannedRegions'),
  serviceCount: document.querySelector('#serviceCount'),
  limitCount: document.querySelector('#limitCount'),
  errorCount: document.querySelector('#errorCount'),
  scanElapsed: document.querySelector('#scanElapsed')
};

const number = new Intl.NumberFormat('en-US');
const percentNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const thresholdStorageKey = 'oci-service-limits:usage-thresholds';
const themeStorageKey = 'oci-service-limits:theme';
const activeScanStorageKey = 'oci-service-limits:active-scan-id';
const columnWidthStoragePrefix = 'oci-service-limits:column-widths:';
const supportedThemes = new Set(['oracle', 'light', 'dark', 'ocean', 'forest', 'sunset']);
const minimumColumnWidth = 72;
const alertPolicyPresets = {
  default: { warning: 75, critical: 90 },
  conservative: { warning: 60, critical: 80 },
  aggressive: { warning: 85, critical: 95 }
};
const defaultUsageThresholds = { warning: 75, critical: 90, policy: 'custom' };
const downloadLinks = [
  { element: csvLink, path: '/api/limits.csv', label: 'CSV' },
  { element: xlsxLink, path: '/api/limits.xlsx', label: 'Excel' }
];
let usageThresholds = loadUsageThresholds();
let severityFilter = 'all';
let currentRows = [];
let currentRegions = [];
let appMetadata = { version: '0.1.0', profile: 'DEFAULT', authMethod: 'config' };
let lastScanMetadata = null;
let activeScanId = '';
let scanResultLoadingId = '';
let progressPollTimer = 0;
let serviceOptionsRequestId = 0;
let limitOptionsRequestId = 0;
let limitOptionsCriteriaKey = '';
let criteriaVersion = 0;
const sortState = {
  regions: { key: 'regionName', direction: 'asc' },
  limits: { key: 'regionName', direction: 'asc' }
};

const refreshServiceOptionsDebounced = debounce(() => {
  refreshServiceOptions().catch(showError);
}, 400);

applyTheme(loadTheme(), { persist: false });
initResizableTables();

regionSelect.onChange(() => {
  invalidateDownloads();
  resetLimitOptions();
  refreshServiceOptions().catch(showError);
});

serviceSelect.onChange(() => {
  invalidateDownloads();
  resetLimitOptions();
});

limitSelect.onChange(() => {
  invalidateDownloads();
});

limitSelect.onOpen(() => {
  loadLimitOptions().catch(showError);
});

subscriptionInput.addEventListener('input', () => {
  invalidateDownloads();
  resetLimitOptions();
  refreshServiceOptionsDebounced();
});

includeNonReadyInput.addEventListener('change', () => {
  invalidateDownloads();
  resetLimitOptions();
  refreshServiceOptions().catch(showError);
});

disableDownloads('Run a scan to enable downloads');
limitSelect.setLoading('All Service Limits');
populateColumnFilters([]);
boot().catch(showError);

form.addEventListener('submit', (event) => {
  event.preventDefault();
  loadReport(true).catch(showError);
});

themeSelect.addEventListener('change', () => {
  applyTheme(themeSelect.value);
});

for (const { select } of columnFilterControls) {
  select.onChange(() => {
    renderLimitRows(currentRows);
  });
}

syncThresholdControls();

alertPolicySelect.addEventListener('change', () => {
  applyAlertPolicy(alertPolicySelect.value);
});

warningThresholdInput.addEventListener('input', () => {
  updateUsageThreshold('warning', warningThresholdInput.value);
});

criticalThresholdInput.addEventListener('input', () => {
  updateUsageThreshold('critical', criticalThresholdInput.value);
});

for (const button of severityFilterButtons) {
  button.addEventListener('click', () => {
    severityFilter = button.dataset.severityFilter || 'all';
    renderLimitRows(currentRows);
  });
}

summaryToggle.addEventListener('click', () => {
  const shouldShow = summaryTableWrap.hidden;
  summaryTableWrap.hidden = !shouldShow;
  summaryToggle.textContent = shouldShow ? 'Hide' : 'Show';
  summaryToggle.setAttribute('aria-expanded', String(shouldShow));
});

document.addEventListener('click', (event) => {
  const button = event.target.closest('.sort-button');
  if (!button) return;
  const table = button.dataset.table;
  const key = button.dataset.sort;
  if (!sortState[table] || !key) return;
  sortState[table] = nextSort(sortState[table], key);
  if (table === 'regions') renderRegionRows(currentRegions);
  if (table === 'limits') renderLimitRows(currentRows);
});

async function boot() {
  const config = await loadDefaults();
  await loadRegionOptions(config.defaults.regions);
  await refreshServiceOptions(config.defaults.services);
  if (config.defaults.limitNames) {
    await loadLimitOptions(config.defaults.limitNames);
  }
  const restoredScan = await restoreSavedScan();
  if (restoredScan) {
    return;
  }

  if (config.defaults.regions || config.defaults.services || config.defaults.limitNames || config.defaults.limitFilter) {
    await loadReport();
  } else {
    statusText.textContent = 'Ready';
  }
}

async function loadDefaults() {
  const response = await fetch('/api/defaults');
  if (!response.ok) throw new Error('Unable to load defaults');
  const config = await response.json();
  appMetadata = {
    version: config.appVersion || appMetadata.version,
    profile: config.profile || appMetadata.profile,
    authMethod: config.authMethod || appMetadata.authMethod
  };
  subscriptionInput.value = config.defaults.subscriptionId || '';
  includeNonReadyInput.checked = Boolean(config.includeNonReadyRegions);
  renderFooter();
  return config;
}

async function loadRegionOptions(defaultRegions = '') {
  regionSelect.setLoading('Loading');
  const response = await fetch('/api/options/regions');
  const body = await response.json();
  if (!response.ok) throw new Error(body.detail || body.error || 'Region options request failed');

  regionSelect.setOptions([...(body.regions || [])].sort(compareRegionOptions).map((region) => ({
    value: region.regionName,
    label: formatRegionOptionLabel(region),
    detail: '',
    search: [region.regionName, region.regionKey, region.status, region.isHomeRegion ? 'home' : ''].join(' ')
  })));
  regionSelect.setSelected(parseList(defaultRegions), { silent: true });
}

async function refreshServiceOptions(defaultServices) {
  const requestId = ++serviceOptionsRequestId;
  serviceSelect.setLoading('Loading');
  const params = new URLSearchParams(new FormData(form));
  params.delete('services');
  const response = await fetch(`/api/options/services?${params}`);
  const body = await response.json();
  if (requestId !== serviceOptionsRequestId) return;
  if (!response.ok) throw new Error(body.detail || body.error || 'Service options request failed');

  serviceSelect.setOptions([...(body.services || [])].sort(compareServiceOptions).map((service) => ({
    value: service.name,
    label: formatServiceOptionLabel(service),
    summary: service.name,
    detail: '',
    search: [service.name, service.description, service.regionCount].join(' ')
  })));

  if (defaultServices !== undefined) {
    serviceSelect.setSelected(parseList(defaultServices), { silent: true });
  }

  if (body.errors?.length) {
    statusText.textContent = `${body.errors.length} region service catalogs failed to load`;
  }
}

async function loadLimitOptions(defaultLimitNames) {
  const criteriaKey = limitOptionsKey();
  if (limitOptionsCriteriaKey === criteriaKey && defaultLimitNames === undefined) return;

  const requestId = ++limitOptionsRequestId;
  limitSelect.setLoading('Loading limits');
  const params = new URLSearchParams(new FormData(form));
  params.delete('limitNames');
  params.delete('refresh');
  const response = await fetch(`/api/options/limits?${params}`);
  const body = await response.json();
  if (requestId !== limitOptionsRequestId) return;
  if (!response.ok) throw new Error(body.detail || body.error || 'Limit options request failed');

  const limits = body.limits || [];
  limitSelect.setOptions(limits.map((limit) => ({
    value: limit.name,
    label: limit.name,
    summary: limit.name,
    detail: formatLimitOptionDetail(limit),
    search: [limit.name, limit.description, limit.serviceNames?.join(' '), limit.regionNames?.join(' ')].join(' ')
  })));
  limitSelect.setSummaries({
    allSummary: 'All Service Limits',
    noneSummary: 'No Service Limits'
  });
  limitOptionsCriteriaKey = criteriaKey;

  if (defaultLimitNames !== undefined) {
    limitSelect.setSelected(parseList(defaultLimitNames), { silent: true });
  }

  if (body.errors?.length) {
    statusText.textContent = `${body.errors.length} service limit catalogs failed to load`;
  }
}

function resetLimitOptions() {
  limitOptionsRequestId += 1;
  limitOptionsCriteriaKey = '';
  limitSelect.setSelected([], { silent: true });
  limitSelect.setOptions([]);
  limitSelect.setSummaries({
    allSummary: 'All Service Limits',
    noneSummary: 'No Service Limits'
  });
  limitSelect.setLoading('All Service Limits');
}

function limitOptionsKey() {
  const params = new URLSearchParams(new FormData(form));
  params.delete('limitNames');
  params.delete('limitFilter');
  params.delete('refresh');
  return params.toString();
}

async function loadReport(forceRefresh = false) {
  statusText.textContent = 'Scanning';
  activeScanId = createScanId();
  saveActiveScanId(activeScanId);
  setScanInProgress(true);
  lastScanMetadata = { scanning: true };
  renderFooter();
  clearTables();
  disableDownloads('Scan in progress');
  const downloadParams = new URLSearchParams(new FormData(form));
  const requestParams = new URLSearchParams(downloadParams);
  const scanCriteriaVersion = criteriaVersion;
  requestParams.set('scanId', activeScanId);
  if (forceRefresh) requestParams.set('refresh', 'true');
  const response = await fetch(`/api/scans?${requestParams}`, { method: 'POST' });
  const body = await response.json();
  if (!response.ok) throw new Error(body.detail || body.error || 'Scan request failed');
  activeScanId = body.scanId || activeScanId;
  saveActiveScanId(activeScanId);
  await handleScanJob(body, scanCriteriaVersion);
}

async function restoreSavedScan() {
  const savedScanId = loadActiveScanId();
  if (!savedScanId) return false;

  const response = await fetch(`/api/scans/${encodeURIComponent(savedScanId)}`);
  if (response.status === 404) {
    clearActiveScanId();
    return false;
  }

  const job = await response.json();
  if (!response.ok) {
    clearActiveScanId();
    return false;
  }

  activeScanId = job.scanId;
  saveActiveScanId(activeScanId);
  await handleScanJob(job, criteriaVersion, { restored: true });
  return true;
}

async function handleScanJob(job, scanCriteriaVersion = criteriaVersion, { restored = false } = {}) {
  if (!job?.scanId) return;

  activeScanId = job.scanId;
  saveActiveScanId(activeScanId);

  if (job.status === 'complete' && job.hasResult) {
    stopProgressPolling();
    await loadScanResult(job.scanId, criteriaVersion === scanCriteriaVersion);
    return;
  }

  if (job.status === 'failed') {
    stopProgressPolling();
    const error = new Error(job.error?.message || job.progress?.message || 'Scan failed');
    showError(error);
    return;
  }

  statusText.textContent = restored ? 'Resuming scan' : 'Scanning';
  setScanInProgress(true);
  lastScanMetadata = { scanning: true };
  renderFooter();
  if (!restored) clearTables();
  disableDownloads('Scan in progress');
  updateScanProgressDisplay(job.progress || { percent: 1, message: 'Preparing scan' });
  startProgressPolling(job.scanId, scanCriteriaVersion);
}

async function loadScanResult(scanId, downloadsCurrent = true) {
  if (!scanId || scanResultLoadingId === scanId) return;
  scanResultLoadingId = scanId;

  try {
    const response = await fetch(`/api/scans/${encodeURIComponent(scanId)}/result`);
    const body = await response.json();
    if (response.status === 202) {
      updateScanProgressDisplay(body.progress || body.scan?.progress);
      return;
    }
    if (!response.ok) throw new Error(body.detail || body.error || 'Scan result request failed');
    renderReport(body, new URLSearchParams(new FormData(form)), downloadsCurrent, scanId);
  } finally {
    scanResultLoadingId = '';
  }
}

function renderReport(report, downloadParams = new URLSearchParams(new FormData(form)), downloadsCurrent = true, scanId = '') {
  currentRows = report.rows || [];
  currentRegions = report.regions || [];
  populateColumnFilters(currentRows);
  counters.subscribedRegions.textContent = number.format(report.totals.subscribedRegions || 0);
  counters.scannedRegions.textContent = number.format(report.totals.scannedRegions || 0);
  counters.serviceCount.textContent = number.format(report.totals.services || 0);
  counters.limitCount.textContent = number.format(report.totals.limits || 0);
  counters.errorCount.textContent = number.format(report.totals.errors || 0);
  counters.scanElapsed.textContent = formatDuration(report.totals.scanElapsedMs);

  renderRegionRows(currentRegions);
  renderLimitRows(currentRows);
  renderErrors(report.errors || []);
  lastScanMetadata = {
    generatedAt: report.generatedAt,
    selectedRegions: report.totals.selectedRegions || 0,
    scannedRegions: report.totals.scannedRegions || 0,
    services: report.totals.services || 0,
    limits: report.totals.limits || 0,
    includeNonReadyRegions: includeNonReadyInput.checked
  };
  renderFooter();
  setScanInProgress(false);
  stopProgressPolling();

  const generated = new Date(report.generatedAt).toLocaleString();
  statusText.textContent = `${number.format(report.totals.selectedRegions || 0)} selected, generated ${generated}`;
  if (downloadsCurrent) {
    if (scanId) {
      enableDownloadsForScan(scanId);
    } else {
      enableDownloads(downloadParams);
    }
  } else {
    disableDownloads('Criteria changed during scan. Refresh again before downloading.');
  }
}

function renderRegionRows(regions) {
  updateSortIndicators('regions');
  const sortedRegions = sortRows(regions, sortState.regions);
  regionRowsEl.replaceChildren();
  for (const region of sortedRegions) {
    const tr = document.createElement('tr');
    colorCodeRow(tr, region.regionName);
    appendCell(tr, regionLabel(region));
    appendCell(tr, region.regionKey || '');
    appendCell(tr, region.status || '');
    appendCell(tr, number.format(region.serviceCount || 0), 'numeric');
    appendCell(tr, number.format(region.limitCount || 0), 'numeric');
    appendCell(tr, number.format(region.errorCount || 0), region.errorCount ? 'numeric danger' : 'numeric');
    appendCell(tr, region.elapsedMs === undefined ? '' : `${number.format(region.elapsedMs)} ms`, 'numeric');
    if (region.message) tr.title = region.message;
    regionRowsEl.appendChild(tr);
  }
}

function renderLimitRows(rows) {
  updateSortIndicators('limits');
  const baseFiltered = filterRows(rows);
  const severityCounts = countUsageSeverities(baseFiltered);
  updateSeverityChips(severityCounts);
  const filtered = sortRows(filterRowsBySeverity(baseFiltered), sortState.limits);
  const severityText = severityFilter === 'all' ? '' : `, ${severityLabel(severityFilter)} filter on`;
  const fragment = document.createDocumentFragment();
  limitRowsEl.replaceChildren();
  limitRowCount.textContent = `${number.format(filtered.length)} of ${number.format(rows.length)} rows, ${number.format(severityCounts.critical)} critical, ${number.format(severityCounts.warning)} warning, ${number.format(severityCounts.no_data)} no data${severityText}`;

  for (const row of filtered) {
    const tr = document.createElement('tr');
    const severity = usageSeverity(row.percentUsed);
    colorCodeRow(tr, row.regionName);
    if (severity === 'warning' || severity === 'critical') {
      tr.classList.add(`limit-alert-${severity}`);
    }
    appendCell(tr, row.regionName);
    appendCell(tr, row.regionStatus || '');
    appendCell(tr, row.serviceName);
    appendCell(tr, row.serviceDescription || '', 'description-cell');
    appendCell(tr, row.limitName);
    appendCell(tr, formatValue(row.value), 'numeric');
    appendCell(tr, formatValue(row.used), 'numeric');
    appendCell(tr, formatValue(row.available), 'numeric');
    appendPercentCell(tr, row.percentUsed);
    appendCell(tr, row.scopeType || '');
    appendCell(tr, row.availabilityDomain || '');
    if (row.usageError) tr.title = row.usageError;
    appendCell(tr, usageStatusLabel(row), row.usageStatus === 'error' ? 'danger' : 'muted-cell');
    fragment.appendChild(tr);
  }

  if (!filtered.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 12;
    td.className = 'empty';
    td.textContent = rows.length ? 'No rows match the filter.' : 'No limits returned.';
    tr.appendChild(td);
    fragment.appendChild(tr);
  }

  limitRowsEl.appendChild(fragment);
}

function renderErrors(errors) {
  errorsSection.hidden = !errors.length;
  errorRowsEl.replaceChildren();

  for (const error of errors) {
    const tr = document.createElement('tr');
    appendCell(tr, error.regionName || '');
    appendCell(tr, error.serviceName || '');
    appendCell(tr, error.statusCode || '');
    appendCell(tr, error.message || '');
    errorRowsEl.appendChild(tr);
  }
}

function clearTables() {
  currentRows = [];
  currentRegions = [];
  clearSummaryPanels();
  resetColumnFilters();
  populateColumnFilters([]);
  regionRowsEl.replaceChildren();
  limitRowsEl.replaceChildren();
  errorRowsEl.replaceChildren();
  errorsSection.hidden = true;
  limitRowCount.textContent = '0 rows';
  updateSeverityChips({ all: 0, critical: 0, warning: 0, healthy: 0, no_data: 0 });
}

function renderFooter() {
  footerVersion.textContent = `v${appMetadata.version || '0.1.0'}`;
  footerRuntime.textContent = `Profile: ${appMetadata.profile || 'DEFAULT'} (${appMetadata.authMethod || 'config'})`;

  if (lastScanMetadata?.scanning) {
    footerScanContext.textContent = 'Last scan: scan in progress';
    footerScope.textContent = scopeFooterText();
    return;
  }

  if (lastScanMetadata?.error) {
    footerScanContext.textContent = 'Last scan: failed';
    footerScope.textContent = scopeFooterText();
    return;
  }

  if (!lastScanMetadata) {
    footerScanContext.textContent = 'Last scan: not run';
    footerScope.textContent = scopeFooterText();
    return;
  }

  const generated = new Date(lastScanMetadata.generatedAt).toLocaleString();
  footerScanContext.textContent = `Last scan: ${generated}`;
  footerScope.textContent = [
    `Scope: ${number.format(lastScanMetadata.scannedRegions)} of ${number.format(lastScanMetadata.selectedRegions)} selected regions`,
    `${number.format(lastScanMetadata.services)} services`,
    `${number.format(lastScanMetadata.limits)} limits`,
    lastScanMetadata.includeNonReadyRegions ? 'non-ready included' : 'ready only'
  ].join(' | ');
}

function scopeFooterText() {
  return includeNonReadyInput.checked
    ? 'Scope: subscribed regions, including non-ready'
    : 'Scope: ready subscribed regions';
}

function clearSummaryPanels() {
  for (const element of Object.values(counters)) {
    element.textContent = '';
  }
}

function resetColumnFilters() {
  for (const { select } of columnFilterControls) {
    select.setSelected([], { silent: true });
  }
}

function filterRows(rows) {
  const columnFilters = activeColumnFilters();
  return rows.filter((row) => {
    return columnFilters.every(([key, values]) => {
      return values.has(filterValueFor(row, key));
    });
  });
}

function filterRowsBySeverity(rows) {
  if (severityFilter === 'all') return rows;
  return rows.filter((row) => usageSeverity(row.percentUsed) === severityFilter);
}

function activeColumnFilters() {
  return columnFilterControls
    .map(({ key, select }) => [key, select.getFilterValues()])
    .filter(([, values]) => values !== null);
}

function filterValueFor(row, key) {
  return displayValueForFilter(row, key);
}

function displayValueForFilter(row, key) {
  if (key === 'percentUsed') return formatPercent(row.percentUsed);
  if (key === 'usageStatus') return usageStatusLabel(row);
  if (['value', 'used', 'available', 'effectiveLimit'].includes(key)) return formatValue(row[key]);
  return String(row[key] ?? '');
}

function populateColumnFilters(rows) {
  for (const { key, select } of columnFilterControls) {
    const options = new Map();

    for (const row of rows) {
      const label = displayValueForFilter(row, key);
      if (!label) continue;
      const current = options.get(label) || { label, count: 0 };
      current.count += 1;
      options.set(label, current);
    }

    select.setOptions(Array.from(options.values()).sort(compareFilterOptions).map((option) => ({
      value: option.label,
      label: option.label,
      detail: `${number.format(option.count)} ${option.count === 1 ? 'row' : 'rows'}`
    })));
    select.setSummaries({
      allSummary: columnFilterAllSummary(key, rows.length, options.size),
      noneSummary: 'None'
    });
  }
}

function columnFilterAllSummary(key, rowCount, distinctCount) {
  if (key === 'regionName') {
    return `All (${number.format(distinctCount)} ${distinctCount === 1 ? 'region' : 'regions'})`;
  }

  if (key === 'serviceName') {
    return `All (${number.format(distinctCount)} ${distinctCount === 1 ? 'service' : 'services'})`;
  }

  return `All (${number.format(rowCount)})`;
}

function compareFilterOptions(optionA, optionB) {
  return optionA.label.localeCompare(optionB.label, undefined, { numeric: true, sensitivity: 'base' });
}

function appendCell(tr, value, className = '') {
  const td = document.createElement('td');
  td.textContent = value;
  if (className) td.className = className;
  tr.appendChild(td);
}

function appendPercentCell(tr, value) {
  const td = document.createElement('td');
  const severity = usageSeverity(value);
  const parsed = Number(value);
  td.className = `usage-cell ${usageClass(value)}`;

  const meter = document.createElement('div');
  meter.className = `usage-meter usage-${severity}`;

  if (Number.isFinite(parsed)) {
    const clamped = Math.min(100, Math.max(0, parsed));
    meter.style.setProperty('--usage-pct', `${clamped}%`);

    const track = document.createElement('span');
    track.className = 'usage-meter-track';
    const fill = document.createElement('span');
    fill.className = 'usage-meter-fill';
    track.appendChild(fill);

    const label = document.createElement('span');
    label.className = 'usage-meter-value';
    label.textContent = formatPercent(value);
    meter.setAttribute('aria-label', `${label.textContent} used`);
    meter.append(track, label);
  } else {
    const label = document.createElement('span');
    label.className = 'usage-meter-value';
    label.textContent = 'No data';
    meter.setAttribute('aria-label', 'No usage data');
    meter.appendChild(label);
  }

  td.appendChild(meter);
  tr.appendChild(td);
}

function nextSort(current, key) {
  if (current.key === key) {
    return {
      key,
      direction: current.direction === 'asc' ? 'desc' : 'asc'
    };
  }
  return { key, direction: defaultSortDirection(key) };
}

function sortRows(rows, state) {
  const direction = state.direction === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const primary = compareValues(valueForSort(a, state.key), valueForSort(b, state.key));
    if (primary) return primary * direction;
    return compareValues(a.regionName, b.regionName)
      || compareValues(a.serviceName, b.serviceName)
      || compareValues(a.limitName, b.limitName);
  });
}

function valueForSort(row, key) {
  if ([
    'serviceCount',
    'limitCount',
    'errorCount',
    'elapsedMs',
    'value',
    'used',
    'available',
    'effectiveLimit',
    'percentUsed'
  ].includes(key)) {
    const value = Number(row[key]);
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
  }
  return row[key] ?? '';
}

function compareValues(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
}

function defaultSortDirection(key) {
  return [
    'serviceCount',
    'limitCount',
    'errorCount',
    'elapsedMs',
    'value',
    'used',
    'available',
    'effectiveLimit',
    'percentUsed'
  ].includes(key) ? 'desc' : 'asc';
}

function updateSortIndicators(table) {
  for (const button of document.querySelectorAll(`.sort-button[data-table="${table}"]`)) {
    const active = button.dataset.sort === sortState[table].key;
    button.dataset.direction = active ? sortState[table].direction : '';
    button.setAttribute('aria-sort', active ? (sortState[table].direction === 'asc' ? 'ascending' : 'descending') : 'none');
  }
}

function initResizableTables() {
  for (const table of document.querySelectorAll('[data-resizable-table]')) {
    initResizableTable(table);
  }
}

function initResizableTable(table) {
  const tableKey = table.dataset.resizableTable;
  const headerRow = table.tHead?.rows?.[0];
  if (!tableKey || !headerRow) return;

  const headers = Array.from(headerRow.cells);
  if (!headers.length) return;

  const storedWidths = loadColumnWidths(tableKey, headers.length);
  const initialWidths = storedWidths || measureInitialColumnWidths(table, headers);
  const colgroup = document.createElement('colgroup');

  for (const width of initialWidths) {
    const col = document.createElement('col');
    col.style.width = `${width}px`;
    colgroup.appendChild(col);
  }

  table.insertBefore(colgroup, table.firstChild);
  applyColumnWidths(table, initialWidths);

  headers.forEach((header, index) => {
    const resizer = document.createElement('span');
    resizer.className = 'column-resizer';
    resizer.tabIndex = 0;
    resizer.setAttribute('role', 'separator');
    resizer.setAttribute('aria-orientation', 'vertical');
    resizer.setAttribute('aria-label', `Resize ${header.textContent.trim() || 'column'} column`);
    resizer.addEventListener('pointerdown', (event) => startColumnResize(event, table, tableKey, index));
    resizer.addEventListener('keydown', (event) => resizeColumnWithKeyboard(event, table, tableKey, index));
    header.appendChild(resizer);
  });
}

function measureInitialColumnWidths(table, headers) {
  const tableWidth = Math.max(table.getBoundingClientRect().width, table.parentElement?.clientWidth || 0);
  const fallbackWidth = Math.max(minimumColumnWidth, Math.round(tableWidth / headers.length));
  return headers.map((header) => {
    const measured = Math.round(header.getBoundingClientRect().width);
    return Math.max(minimumColumnWidth, measured || fallbackWidth);
  });
}

function startColumnResize(event, table, tableKey, columnIndex) {
  event.preventDefault();
  event.stopPropagation();

  const widths = currentColumnWidths(table);
  const startX = event.clientX;
  const startWidth = widths[columnIndex] || minimumColumnWidth;
  const handle = event.currentTarget;

  document.body.classList.add('column-resize-active');
  handle.setPointerCapture(event.pointerId);

  const onPointerMove = (moveEvent) => {
    moveEvent.preventDefault();
    const nextWidth = Math.max(minimumColumnWidth, Math.round(startWidth + moveEvent.clientX - startX));
    widths[columnIndex] = nextWidth;
    applyColumnWidths(table, widths);
  };

  const onPointerUp = (upEvent) => {
    if (handle.hasPointerCapture(upEvent.pointerId)) {
      handle.releasePointerCapture(upEvent.pointerId);
    }
    document.body.classList.remove('column-resize-active');
    saveColumnWidths(tableKey, widths);
    handle.removeEventListener('pointermove', onPointerMove);
    handle.removeEventListener('pointerup', onPointerUp);
    handle.removeEventListener('pointercancel', onPointerUp);
  };

  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', onPointerUp);
  handle.addEventListener('pointercancel', onPointerUp);
}

function resizeColumnWithKeyboard(event, table, tableKey, columnIndex) {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;

  event.preventDefault();
  event.stopPropagation();

  const step = event.shiftKey ? 36 : 12;
  const direction = event.key === 'ArrowRight' ? 1 : -1;
  const widths = currentColumnWidths(table);
  widths[columnIndex] = Math.max(minimumColumnWidth, (widths[columnIndex] || minimumColumnWidth) + (step * direction));
  applyColumnWidths(table, widths);
  saveColumnWidths(tableKey, widths);
}

function currentColumnWidths(table) {
  return Array.from(table.querySelectorAll('col')).map((col) => {
    const width = Number.parseInt(col.style.width, 10);
    return Number.isFinite(width) ? width : minimumColumnWidth;
  });
}

function applyColumnWidths(table, widths) {
  const columns = Array.from(table.querySelectorAll('col'));
  widths.forEach((width, index) => {
    if (columns[index]) columns[index].style.width = `${Math.max(minimumColumnWidth, Math.round(width))}px`;
  });

  const totalWidth = widths.reduce((sum, width) => sum + Math.max(minimumColumnWidth, Math.round(width)), 0);
  table.style.width = `${totalWidth}px`;
  table.style.minWidth = `${totalWidth}px`;
}

function loadColumnWidths(tableKey, expectedCount) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(`${columnWidthStoragePrefix}${tableKey}`) || '[]');
    if (!Array.isArray(parsed) || parsed.length !== expectedCount) return null;
    return parsed.map((width) => Math.max(minimumColumnWidth, Math.round(Number(width) || minimumColumnWidth)));
  } catch {
    return null;
  }
}

function saveColumnWidths(tableKey, widths) {
  try {
    window.localStorage.setItem(`${columnWidthStoragePrefix}${tableKey}`, JSON.stringify(widths));
  } catch {
    // Ignore storage failures; the resized columns still apply to this page view.
  }
}

function colorCodeRow(tr, regionName) {
  tr.classList.add('region-coded');
  tr.style.setProperty('--region-color', colorForRegion(regionName));
}

function colorForRegion(regionName) {
  const text = String(regionName || 'unknown-region');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 58% 42%)`;
}

function compareRegionOptions(regionA, regionB) {
  if (Boolean(regionA.isHomeRegion) !== Boolean(regionB.isHomeRegion)) {
    return regionA.isHomeRegion ? -1 : 1;
  }

  return String(regionA.regionName || '').localeCompare(String(regionB.regionName || ''), undefined, {
    numeric: true,
    sensitivity: 'base'
  });
}

function formatRegionOptionLabel(region) {
  return [
    region.regionName,
    region.regionKey ? `(${region.regionKey})` : '',
    region.status || '',
    region.isHomeRegion ? 'home' : ''
  ].filter(Boolean).join(' ');
}

function compareServiceOptions(serviceA, serviceB) {
  return String(serviceA.name || '').localeCompare(String(serviceB.name || ''), undefined, {
    numeric: true,
    sensitivity: 'base'
  });
}

function formatServiceOptionLabel(service) {
  const regionText = `${number.format(service.regionCount || 0)} ${(service.regionCount || 0) === 1 ? 'region' : 'regions'}`;
  return [
    service.name,
    service.description ? `- ${service.description}` : '',
    `(${regionText})`
  ].filter(Boolean).join(' ');
}

function formatLimitOptionDetail(limit) {
  const serviceCount = limit.serviceCount || 0;
  const regionCount = limit.regionCount || 0;
  const rowCount = limit.count || 0;
  const totals = [
    `${number.format(serviceCount)} ${serviceCount === 1 ? 'service' : 'services'}`,
    `${number.format(regionCount)} ${regionCount === 1 ? 'region' : 'regions'}`,
    `${number.format(rowCount)} ${rowCount === 1 ? 'entry' : 'entries'}`
  ].join(', ');
  return [limit.description, totals].filter(Boolean).join(' - ');
}

function regionLabel(region) {
  return region.isHomeRegion ? `${region.regionName} (home)` : region.regionName;
}

function formatValue(value) {
  if (value === undefined || value === null || value === '') return '';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? number.format(parsed) : String(value);
}

function formatPercent(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${percentNumber.format(parsed)}%` : '';
}

function formatDuration(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return '0 ms';
  if (ms < 1000) return `${number.format(Math.round(ms))} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${percentNumber.format(seconds)} sec`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${number.format(minutes)}m ${number.format(remainingSeconds)}s`;
}

function usageStatusLabel(row) {
  switch (row.usageStatus) {
    case 'available':
      return 'Available';
    case 'not_supported':
      return 'N/A';
    case 'unavailable':
      return 'Unavailable';
    case 'error':
      return 'Error';
    case 'pending':
      return 'Pending';
    default:
      return '';
  }
}

function usageClass(percentUsed) {
  const severity = usageSeverity(percentUsed);
  if (severity === 'critical') return 'numeric usage-critical';
  if (severity === 'warning') return 'numeric usage-warn';
  if (severity === 'no_data') return 'numeric muted-cell';
  return 'numeric';
}

function usageSeverity(percentUsed) {
  const parsed = Number(percentUsed);
  if (!Number.isFinite(parsed)) return 'no_data';
  if (parsed >= usageThresholds.critical) return 'critical';
  if (parsed >= usageThresholds.warning) return 'warning';
  return 'healthy';
}

function countUsageSeverities(rows) {
  return rows.reduce((counts, row) => {
    const severity = usageSeverity(row.percentUsed);
    if (severity === 'critical') counts.critical += 1;
    if (severity === 'warning') counts.warning += 1;
    if (severity === 'healthy') counts.healthy += 1;
    if (severity === 'no_data') counts.no_data += 1;
    counts.all += 1;
    return counts;
  }, { all: 0, critical: 0, warning: 0, healthy: 0, no_data: 0 });
}

function updateSeverityChips(counts) {
  for (const button of severityFilterButtons) {
    const key = button.dataset.severityFilter || 'all';
    button.classList.toggle('active', key === severityFilter);
    button.setAttribute('aria-pressed', String(key === severityFilter));
  }

  for (const [key, element] of Object.entries(severityCountEls)) {
    element.textContent = number.format(counts[key] || 0);
  }
}

function severityLabel(value) {
  switch (value) {
    case 'critical':
      return 'critical';
    case 'warning':
      return 'warning';
    case 'healthy':
      return 'healthy';
    case 'no_data':
      return 'no data';
    default:
      return 'all';
  }
}

function applyAlertPolicy(policy) {
  const preset = alertPolicyPresets[policy];
  usageThresholds = preset
    ? { ...preset, policy }
    : { ...usageThresholds, policy: 'custom' };
  syncThresholdControls();
  saveUsageThresholds();
  renderLimitRows(currentRows);
}

function updateUsageThreshold(kind, value) {
  const parsed = normalizeThreshold(value, usageThresholds[kind]);

  if (kind === 'warning') {
    usageThresholds = {
      ...usageThresholds,
      warning: Math.min(parsed, usageThresholds.critical),
      policy: 'custom'
    };
  } else {
    usageThresholds = {
      ...usageThresholds,
      critical: Math.max(parsed, usageThresholds.warning),
      policy: 'custom'
    };
  }

  syncThresholdControls();
  saveUsageThresholds();
  renderLimitRows(currentRows);
}

function syncThresholdControls() {
  warningThresholdInput.max = String(usageThresholds.critical);
  criticalThresholdInput.min = String(usageThresholds.warning);
  warningThresholdInput.value = String(usageThresholds.warning);
  criticalThresholdInput.value = String(usageThresholds.critical);
  alertPolicySelect.value = alertPolicySelect.querySelector(`option[value="${usageThresholds.policy}"]`)
    ? usageThresholds.policy
    : 'custom';
}

function loadUsageThresholds() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(thresholdStorageKey) || '{}');
    const warning = normalizeThreshold(stored.warning, defaultUsageThresholds.warning);
    const critical = normalizeThreshold(stored.critical, defaultUsageThresholds.critical);
    const policy = stored.policy && (stored.policy === 'custom' || alertPolicyPresets[stored.policy])
      ? stored.policy
      : 'custom';
    return {
      warning,
      critical: Math.max(warning, critical),
      policy
    };
  } catch {
    return { ...defaultUsageThresholds };
  }
}

function loadTheme() {
  try {
    return window.localStorage.getItem(themeStorageKey) || 'oracle';
  } catch {
    return 'oracle';
  }
}

function applyTheme(theme, { persist = true } = {}) {
  const nextTheme = supportedThemes.has(theme) ? theme : 'oracle';
  document.body.dataset.theme = nextTheme;
  themeSelect.value = nextTheme;

  if (!persist) return;

  try {
    window.localStorage.setItem(themeStorageKey, nextTheme);
  } catch {
    // Ignore storage failures; the selected theme still applies to this page view.
  }
}

function saveUsageThresholds() {
  try {
    window.localStorage.setItem(thresholdStorageKey, JSON.stringify(usageThresholds));
  } catch {
    // Ignore storage failures; the thresholds still work for the current page view.
  }
}

function normalizeThreshold(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(100, Math.max(0, Math.round(parsed)));
}

function showError(error) {
  statusText.textContent = error.message;
  clearTables();
  setScanInProgress(false);
  stopProgressPolling();
  lastScanMetadata = { error: error.message };
  renderFooter();
  disableDownloads('Scan failed');
}

function setScanInProgress(isScanning) {
  document.body.classList.toggle('scan-active', isScanning);
  scanBanner.hidden = !isScanning;
  scanBannerDetail.textContent = isScanning
    ? 'Scanning OCI subscribed regions, service limits, and usage.'
    : '';
  updateScanProgressDisplay(isScanning ? { percent: 1, message: 'Preparing scan' } : null);
  refreshButton.disabled = isScanning;
  refreshButton.textContent = isScanning ? 'Scanning' : 'Refresh';
  statusText.classList.toggle('status-scanning', isScanning);
}

function startProgressPolling(scanId, scanCriteriaVersion = criteriaVersion) {
  stopProgressPolling();
  pollScanProgress(scanId, scanCriteriaVersion).catch(() => {});
  progressPollTimer = window.setInterval(() => {
    pollScanProgress(scanId, scanCriteriaVersion).catch(() => {});
  }, 900);
}

function stopProgressPolling() {
  if (!progressPollTimer) return;
  window.clearInterval(progressPollTimer);
  progressPollTimer = 0;
}

async function pollScanProgress(scanId, scanCriteriaVersion = criteriaVersion) {
  if (!scanId || scanId !== activeScanId) return;
  const response = await fetch(`/api/scans/${encodeURIComponent(scanId)}`);
  if (response.status === 404) {
    clearActiveScanId();
    stopProgressPolling();
    return;
  }
  const job = await response.json();
  if (!response.ok) return;
  if (job.progress) updateScanProgressDisplay(job.progress);

  if (job.status === 'complete' && job.hasResult) {
    stopProgressPolling();
    await loadScanResult(scanId, criteriaVersion === scanCriteriaVersion);
  } else if (job.status === 'failed') {
    stopProgressPolling();
    showError(new Error(job.error?.message || job.progress?.message || 'Scan failed'));
  }
}

function updateScanProgressDisplay(progress) {
  if (!progress) {
    scanProgressFill.style.width = '0%';
    scanProgressText.textContent = '';
    return;
  }

  const percent = Math.min(100, Math.max(0, Math.round(Number(progress.percent) || 0)));
  scanProgressFill.style.width = `${percent}%`;
  scanProgressText.textContent = scanProgressSummary(progress, percent);
  if (progress.message) scanBannerDetail.textContent = progress.message;
}

function scanProgressSummary(progress, percent) {
  const parts = [`${percent}%`];

  if (Number.isFinite(Number(progress.completedRegions)) && Number.isFinite(Number(progress.totalRegions))) {
    parts.push(`${number.format(progress.completedRegions)} / ${number.format(progress.totalRegions)} regions`);
  }

  if (Number.isFinite(Number(progress.completedServices)) && Number.isFinite(Number(progress.totalServices)) && Number(progress.totalServices) > 0) {
    parts.push(`${number.format(progress.completedServices)} / ${number.format(progress.totalServices)} services`);
  }

  const startedAt = Date.parse(progress.createdAt || '');
  if (!progress.done && Number.isFinite(startedAt)) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= 1000) parts.push(`${formatDuration(elapsedMs)} elapsed`);
  }

  if (progress.currentRegion) {
    parts.push(progress.currentService ? `${progress.currentRegion} / ${progress.currentService}` : progress.currentRegion);
  }

  return parts.join(' | ');
}

function createScanId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function saveActiveScanId(scanId) {
  try {
    window.localStorage.setItem(activeScanStorageKey, scanId);
  } catch {
    // Ignore storage failures; the server still owns the scan for this page view.
  }
}

function loadActiveScanId() {
  try {
    return window.localStorage.getItem(activeScanStorageKey) || '';
  } catch {
    return '';
  }
}

function clearActiveScanId() {
  try {
    window.localStorage.removeItem(activeScanStorageKey);
  } catch {
    // Ignore storage failures.
  }
}

function invalidateDownloads() {
  criteriaVersion += 1;
  disableDownloads('Criteria changed. Refresh the scan before downloading.');
}

function enableDownloads(params) {
  const query = params.toString();
  for (const { element, path, label } of downloadLinks) {
    element.href = query ? `${path}?${query}` : path;
    element.classList.remove('download-disabled');
    element.removeAttribute('aria-disabled');
    element.removeAttribute('tabindex');
    element.title = `Download completed scan as ${label}`;
  }
}

function enableDownloadsForScan(scanId) {
  const encodedScanId = encodeURIComponent(scanId);
  for (const { element, label } of downloadLinks) {
    const extension = label === 'Excel' ? 'xlsx' : 'csv';
    element.href = `/api/scans/${encodedScanId}/limits.${extension}`;
    element.classList.remove('download-disabled');
    element.removeAttribute('aria-disabled');
    element.removeAttribute('tabindex');
    element.title = `Download completed scan as ${label}`;
  }
}

function disableDownloads(reason) {
  for (const { element } of downloadLinks) {
    element.removeAttribute('href');
    element.classList.add('download-disabled');
    element.setAttribute('aria-disabled', 'true');
    element.setAttribute('tabindex', '-1');
    element.title = reason;
  }
}

function createMultiSelect({ root, allSummary, noneSummary }) {
  const trigger = root.querySelector('.multi-trigger');
  const menu = root.querySelector('.multi-menu');
  const optionsEl = root.querySelector('.multi-options');
  const hiddenInput = root.querySelector('input[type="hidden"]');
  const summaryEl = trigger.querySelector('span:first-child');
  const searchWrap = document.createElement('div');
  const searchInput = document.createElement('input');
  const callbacks = new Set();
  const openCallbacks = new Set();
  let currentAllSummary = allSummary;
  let currentNoneSummary = noneSummary;
  let options = [];
  let selected = new Set();
  let allMode = true;
  let searchText = '';

  searchWrap.className = 'multi-search-wrap';
  searchInput.className = 'multi-search';
  searchInput.type = 'search';
  searchInput.placeholder = 'Type to filter';
  searchInput.setAttribute('aria-label', 'Filter options');
  searchWrap.appendChild(searchInput);
  menu.insertBefore(searchWrap, optionsEl);

  trigger.addEventListener('click', () => {
    const willOpen = menu.hidden;
    closeAllMultiSelects(root);
    menu.hidden = !willOpen;
    trigger.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) {
      clearSearch();
      notifyOpen();
      window.setTimeout(() => searchInput.focus(), 0);
    }
  });

  root.querySelector('[data-action="all"]').addEventListener('click', () => {
    allMode = true;
    selected.clear();
    sync();
    render();
    notify();
  });

  root.querySelector('[data-action="none"]').addEventListener('click', () => {
    allMode = false;
    selected.clear();
    sync();
    render();
    notify();
  });

  document.addEventListener('click', (event) => {
    if (!root.contains(event.target)) close();
  });

  searchInput.addEventListener('input', () => {
    searchText = searchInput.value.trim().toLowerCase();
    render();
  });

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      selectVisibleOptions();
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      trigger.focus();
    }
  });

  function setLoading(text) {
    clearSearch();
    searchInput.disabled = true;
    summaryEl.textContent = text;
    optionsEl.replaceChildren(emptyOption(text));
  }

  function setOptions(nextOptions) {
    options = nextOptions;
    searchInput.disabled = !options.length;
    const available = new Set(options.map((option) => option.value));
    selected = new Set(Array.from(selected).filter((value) => available.has(value)));
    if (!allMode && selected.size === options.length && options.length) {
      allMode = true;
      selected.clear();
    }
    sync();
    render();
  }

  function setSelected(values, { silent = false } = {}) {
    const parsed = parseList(values);
    if (!parsed.length) {
      allMode = true;
      selected.clear();
    } else if (parsed.includes('__none__')) {
      allMode = false;
      selected.clear();
    } else {
      const available = new Set(options.map((option) => option.value));
      allMode = false;
      selected = new Set(parsed.filter((value) => available.has(value)));
      if (selected.size === options.length && options.length) {
        allMode = true;
        selected.clear();
      }
    }
    sync();
    render();
    if (!silent) notify();
  }

  function render() {
    renderSummary();
    optionsEl.replaceChildren();

    if (!options.length) {
      optionsEl.appendChild(emptyOption('No options returned'));
      return;
    }

    const visibleOptions = filteredOptions();
    if (!visibleOptions.length) {
      optionsEl.appendChild(emptyOption('No matches'));
      return;
    }

    for (const option of visibleOptions) {
      const row = document.createElement('label');
      row.className = 'multi-option';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(allMode || selected.has(option.value)));

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = option.value;
      checkbox.checked = allMode || selected.has(option.value);
      checkbox.addEventListener('change', () => {
        if (allMode) {
          selected = new Set(options.map((item) => item.value));
          allMode = false;
        }

        if (checkbox.checked) {
          selected.add(option.value);
        } else {
          selected.delete(option.value);
        }

        if (selected.size === options.length && options.length) {
          allMode = true;
          selected.clear();
        }

        sync();
        render();
        notify();
      });

      const text = document.createElement('span');
      text.className = 'multi-option-text';
      const label = document.createElement('strong');
      label.textContent = option.label;
      text.append(label);
      if (option.detail) {
        const detail = document.createElement('small');
        detail.textContent = option.detail;
        text.append(detail);
      }
      row.append(checkbox, text);
      optionsEl.appendChild(row);
    }
  }

  function filteredOptions() {
    const terms = searchText.split(/\s+/).filter(Boolean);
    if (!terms.length) return options;
    return options.filter((option) => {
      const haystack = [
        option.value,
        option.label,
        option.summary,
        option.detail,
        option.search
      ].filter(Boolean).join(' ').toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }

  function selectVisibleOptions() {
    const visibleOptions = filteredOptions();
    if (!visibleOptions.length) return;

    if (allMode) {
      selected = new Set(visibleOptions.map((option) => option.value));
      allMode = false;
    } else {
      for (const option of visibleOptions) {
        selected.add(option.value);
      }
    }

    if (selected.size === options.length && options.length) {
      allMode = true;
      selected.clear();
    }

    sync();
    render();
    notify();
  }

  function renderSummary() {
    if (allMode) {
      summaryEl.textContent = currentAllSummary;
      return;
    }

    if (!selected.size) {
      summaryEl.textContent = currentNoneSummary;
      return;
    }

    if (selected.size === 1) {
      const value = Array.from(selected)[0];
      const option = options.find((item) => item.value === value);
      summaryEl.textContent = option?.summary || option?.label || value;
      return;
    }

    summaryEl.textContent = `${selected.size} selected`;
  }

  function sync() {
    hiddenInput.value = allMode ? '' : (selected.size ? Array.from(selected).join(',') : '__none__');
  }

  function getFilterValues() {
    return allMode ? null : new Set(selected);
  }

  function setSummaries(nextSummaries) {
    currentAllSummary = nextSummaries.allSummary ?? currentAllSummary;
    currentNoneSummary = nextSummaries.noneSummary ?? currentNoneSummary;
    renderSummary();
  }

  function close() {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }

  function clearSearch() {
    searchText = '';
    searchInput.value = '';
    render();
  }

  function notify() {
    for (const callback of callbacks) callback();
  }

  function notifyOpen() {
    for (const callback of openCallbacks) callback();
  }

  return {
    onChange(callback) {
      callbacks.add(callback);
    },
    onOpen(callback) {
      openCallbacks.add(callback);
    },
    setLoading,
    setOptions,
    setSelected,
    setSummaries,
    getFilterValues,
    close
  };
}

function closeAllMultiSelects(exceptRoot) {
  for (const root of document.querySelectorAll('.multi-select')) {
    if (root === exceptRoot) continue;
    root.querySelector('.multi-menu').hidden = true;
    root.querySelector('.multi-trigger').setAttribute('aria-expanded', 'false');
  }
}

function emptyOption(text) {
  const div = document.createElement('div');
  div.className = 'multi-empty';
  div.textContent = text;
  return div;
}

function parseList(value) {
  if (Array.isArray(value)) return value.flatMap((item) => parseList(item));
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
}
