(function initCloudflareCsvLocalDiagnostics(global) {
  'use strict';

  const VERSION = '1.0.0';
  const PAGE_LIMIT = 200;
  const MAX_SEARCH_TERM_ROWS = 5000;
  const MAX_OBSERVATIONS = 80;
  const state = { mounted: false, loading: false, root: null, requestSeq: 0 };

  const publicApi = Object.freeze({ version: VERSION, refresh, generateDiagnostics });
  Object.defineProperty(global, 'CloudflareCsvLocalDiagnostics', {
    value: publicApi,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  if (!global.document) return;
  if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
  global.addEventListener?.('cloudflare-operator-store-change', () => void refresh());

  function mount() {
    if (state.mounted) return;
    const dashboard = global.document.querySelector('#cfCsvAnalyticsDashboard');
    if (!dashboard) {
      new MutationObserver((_, observer) => {
        if (!global.document.querySelector('#cfCsvAnalyticsDashboard')) return;
        observer.disconnect();
        mount();
      }).observe(global.document.documentElement, { childList: true, subtree: true });
      return;
    }
    if (dashboard.querySelector('[data-cf-csv-local-diagnostics]')) return void (state.mounted = true);
    installStyles();
    const root = global.document.createElement('section');
    root.className = 'cfCsvDiagnosticsCard';
    root.dataset.cfCsvLocalDiagnostics = VERSION;
    root.innerHTML = `
      <div class="cfCsvDiagnosticsHead">
        <div><strong>Local business diagnostics</strong><span>Relative observations from governed business CSV facts</span></div>
        <div><span class="cfCsvDiagnosticsBadge">diagnostic · non-authoritative</span><button class="btn" type="button" data-cfdiag-refresh>Refresh diagnostics</button></div>
      </div>
      <div class="cfCsvDiagnosticsDiscipline">These observations explain local performance patterns only. They are not approved optimization recommendations and cannot authorize Amazon mutation.</div>
      <div class="cfCsvDiagnosticsStatus" data-cfdiag-status role="status" aria-live="polite">Waiting for analytics scope.</div>
      <div class="cfCsvDiagnosticsSummary" data-cfdiag-summary></div>
      <div class="cfCsvDiagnosticsTableWrap"><table><thead><tr><th>Category</th><th>Diagnostic</th><th>Subject</th><th>Evidence</th><th>Severity</th></tr></thead><tbody data-cfdiag-body></tbody></table></div>`;
    const quality = dashboard.querySelector('.cfCsvAnalyticsQualityCard');
    if (quality) quality.insertAdjacentElement('beforebegin', root);
    else dashboard.appendChild(root);
    state.root = root;
    state.mounted = true;
    root.querySelector('[data-cfdiag-refresh]')?.addEventListener('click', () => void refresh());
    void refresh();
  }

  async function refresh() {
    if (!state.root || state.loading) return;
    const scope = dashboardScope();
    if (!scope.storeId || !scope.startDate || !scope.endDate) {
      renderStatus('Store and date range are required before diagnostics.', 'warn');
      return;
    }
    const seq = ++state.requestSeq;
    state.loading = true;
    setBusy(true);
    renderStatus('Reading governed analytics and computing local diagnostics…', 'loading');
    try {
      const filters = activeFilters();
      const common = compact({ startDate: scope.startDate, endDate: scope.endDate, ...filters });
      const [searchTerms, campaignsPayload, dailyPayload, matchPayload] = await Promise.all([
        readAllSearchTerms(scope.storeId, common),
        api().csvAnalytics(scope.storeId, 'campaign', { ...common, page: 1, limit: 200, sort: 'spendMicros', direction: 'desc' }),
        api().csvAnalytics(scope.storeId, 'daily', { ...common, page: 1, limit: 366, sort: 'reportDate', direction: 'asc' }),
        api().csvAnalytics(scope.storeId, 'match-type', { ...common, page: 1, limit: 200, sort: 'spendMicros', direction: 'desc' }),
      ]);
      if (seq !== state.requestSeq) return;
      const result = generateDiagnostics({
        searchTerms: searchTerms.items,
        campaigns: campaignsPayload?.items || [],
        daily: dailyPayload?.items || [],
        matchTypes: matchPayload?.items || [],
        searchTermTotal: searchTerms.totalItems,
        searchTermComplete: searchTerms.complete,
        scope: { ...scope, filters },
      });
      renderResult(result);
      renderStatus(`${result.observations.length} local observations generated. No execution authority granted.`, 'ok');
    } catch (error) {
      if (seq !== state.requestSeq) return;
      renderResult(null);
      renderStatus(`Diagnostics unavailable: ${error?.code || error?.message || 'request_failed'}`, 'bad');
    } finally {
      if (seq === state.requestSeq) {
        state.loading = false;
        setBusy(false);
      }
    }
  }

  async function readAllSearchTerms(storeId, common) {
    const first = await api().csvAnalytics(storeId, 'search-term', {
      ...common, page: 1, limit: PAGE_LIMIT, sort: 'spendMicros', direction: 'desc',
    });
    const totalItems = Number(first?.pagination?.totalItems || 0);
    const totalPages = Number(first?.pagination?.totalPages || 0);
    const allowedPages = Math.min(totalPages, Math.ceil(MAX_SEARCH_TERM_ROWS / PAGE_LIMIT));
    const items = [...(first?.items || [])];
    for (let start = 2; start <= allowedPages; start += 4) {
      const pages = [];
      for (let page = start; page < start + 4 && page <= allowedPages; page += 1) pages.push(page);
      const responses = await Promise.all(pages.map((page) => api().csvAnalytics(storeId, 'search-term', {
        ...common, page, limit: PAGE_LIMIT, sort: 'spendMicros', direction: 'desc',
      })));
      for (const response of responses) items.push(...(response?.items || []));
    }
    return {
      items: items.slice(0, MAX_SEARCH_TERM_ROWS),
      totalItems,
      complete: totalItems <= MAX_SEARCH_TERM_ROWS,
    };
  }

  function generateDiagnostics(input = {}) {
    const searchTerms = (input.searchTerms || []).map(metricRow);
    const campaigns = (input.campaigns || []).map(metricRow);
    const daily = (input.daily || []).map(metricRow);
    const matchTypes = (input.matchTypes || []).map(metricRow);
    const observations = [];

    const searchThresholds = {
      spendP90: quantile(searchTerms, 'spendMicros', 0.90),
      clicksP50: quantile(searchTerms, 'clicks', 0.50),
      clicksP75: quantile(searchTerms, 'clicks', 0.75),
      clicksP90: quantile(searchTerms, 'clicks', 0.90),
      acosP90: quantile(searchTerms, 'acos', 0.90),
      roasP90: quantile(searchTerms, 'roas', 0.90),
      cvrP25: quantile(searchTerms, 'cvr', 0.25),
      cvrP90: quantile(searchTerms, 'cvr', 0.90),
    };

    addRanked(observations, searchTerms.filter((row) => row.orders === 0 && finiteAtLeast(row.spendMicros, searchThresholds.spendP90)), 'spendMicros', 'desc', 10, (row) => observation('search-term', 'high_spend_zero_orders', 'high', row.searchTerm, `Spend ${money(row.spendMicros)} is in the top decile while attributed orders are zero.`, row, { benchmark: `P90 spend ${money(searchThresholds.spendP90)}` }));
    addRanked(observations, searchTerms.filter((row) => Number.isFinite(row.acos) && finiteAtLeast(row.acos, searchThresholds.acosP90)), 'acos', 'desc', 10, (row) => observation('search-term', 'high_acos', 'medium', row.searchTerm, `ACoS ${pct(row.acos)} is in the highest decile of this scope.`, row, { benchmark: `P90 ACoS ${pct(searchThresholds.acosP90)}` }));
    addRanked(observations, searchTerms.filter((row) => Number.isFinite(row.roas) && finiteAtLeast(row.roas, searchThresholds.roasP90)), 'roas', 'desc', 8, (row) => observation('search-term', 'high_roas', 'info', row.searchTerm, `ROAS ${ratio(row.roas)} is in the highest decile of this scope.`, row, { benchmark: `P90 ROAS ${ratio(searchThresholds.roasP90)}` }));
    addRanked(observations, searchTerms.filter((row) => Number.isFinite(row.cvr) && row.clicks >= numberOr(searchThresholds.clicksP50, 0) && finiteAtLeast(row.cvr, searchThresholds.cvrP90)), 'cvr', 'desc', 8, (row) => observation('search-term', 'high_conversion', 'info', row.searchTerm, `CVR ${pct(row.cvr)} is in the highest decile with at least median click volume.`, row, { benchmark: `P90 CVR ${pct(searchThresholds.cvrP90)}` }));
    addRanked(observations, searchTerms.filter((row) => finiteAtLeast(row.clicks, searchThresholds.clicksP90)), 'clicks', 'desc', 8, (row) => observation('search-term', 'large_click_volume', 'info', row.searchTerm, `${formatInt(row.clicks)} clicks place this search term in the highest click-volume decile.`, row, { benchmark: `P90 clicks ${formatInt(searchThresholds.clicksP90)}` }));
    addRanked(observations, searchTerms.filter((row) => row.clicks >= numberOr(searchThresholds.clicksP75, 0) && Number.isFinite(row.cvr) && finiteAtMost(row.cvr, searchThresholds.cvrP25)), 'clicks', 'desc', 10, (row) => observation('search-term', 'low_conversion', 'medium', row.searchTerm, `${formatInt(row.clicks)} clicks with CVR ${pct(row.cvr)} are weak relative to this scope.`, row, { benchmark: `P25 CVR ${pct(searchThresholds.cvrP25)}` }));

    const campaignThresholds = {
      acosP90: quantile(campaigns, 'acos', 0.90),
      cvrP10: quantile(campaigns, 'cvr', 0.10),
      cvrP90: quantile(campaigns, 'cvr', 0.90),
      clicksP50: quantile(campaigns, 'clicks', 0.50),
      clicksP75: quantile(campaigns, 'clicks', 0.75),
    };
    addConcentration(observations, campaigns, 'spendMicros', 'campaign_spend_concentration', 'Spend');
    addConcentration(observations, campaigns, 'salesMicros', 'campaign_sales_concentration', 'Sales');
    addRanked(observations, campaigns.filter((row) => Number.isFinite(row.acos) && finiteAtLeast(row.acos, campaignThresholds.acosP90)), 'acos', 'desc', 5, (row) => observation('campaign', 'acos_outlier', 'medium', row.campaignName, `Campaign ACoS ${pct(row.acos)} is in the highest decile.`, row, { observedId: row.campaignId, identityResolved: false }));
    addRanked(observations, campaigns.filter((row) => row.clicks >= numberOr(campaignThresholds.clicksP50, 0) && Number.isFinite(row.cvr) && finiteAtLeast(row.cvr, campaignThresholds.cvrP90)), 'cvr', 'desc', 5, (row) => observation('campaign', 'high_conversion_outlier', 'info', row.campaignName, `Campaign CVR ${pct(row.cvr)} is in the highest decile with meaningful traffic.`, row, { observedId: row.campaignId, identityResolved: false }));
    addRanked(observations, campaigns.filter((row) => row.clicks >= numberOr(campaignThresholds.clicksP50, 0) && Number.isFinite(row.cvr) && finiteAtMost(row.cvr, campaignThresholds.cvrP10)), 'cvr', 'asc', 5, (row) => observation('campaign', 'low_conversion_outlier', 'medium', row.campaignName, `Campaign CVR ${pct(row.cvr)} is in the lowest decile with meaningful traffic.`, row, { observedId: row.campaignId, identityResolved: false }));
    addRanked(observations, campaigns.filter((row) => row.orders === 0 && row.clicks >= numberOr(campaignThresholds.clicksP75, 0)), 'clicks', 'desc', 5, (row) => observation('campaign', 'traffic_without_conversion', 'high', row.campaignName, `${formatInt(row.clicks)} clicks produced zero attributed orders.`, row, { observedId: row.campaignId, identityResolved: false }));

    addMatchTypeObservations(observations, matchTypes);
    addTrendObservations(observations, daily);

    const capped = observations.slice(0, MAX_OBSERVATIONS);
    return Object.freeze({
      kind: 'diagnostic_bundle',
      authoritative: false,
      recommendationAuthorized: false,
      reviewAuthorized: false,
      amazonExecutionAuthorized: false,
      sourceKind: 'csv_business_analytics',
      scope: input.scope || null,
      coverage: Object.freeze({
        searchTermRowsAnalyzed: searchTerms.length,
        searchTermRowsTotal: Number(input.searchTermTotal ?? searchTerms.length),
        searchTermComplete: input.searchTermComplete !== false,
        campaignRowsAnalyzed: campaigns.length,
        dailyRowsAnalyzed: daily.length,
        matchTypeRowsAnalyzed: matchTypes.length,
      }),
      thresholds: Object.freeze({ searchTerm: searchThresholds, campaign: campaignThresholds }),
      observations: Object.freeze(capped),
    });
  }

  function addConcentration(out, rows, field, rule, label) {
    if (!rows.length) return;
    const total = rows.reduce((sum, row) => sum + numberOr(row[field], 0), 0);
    if (total <= 0) return;
    const top = [...rows].sort((a, b) => numberOr(b[field], 0) - numberOr(a[field], 0))[0];
    const share = numberOr(top[field], 0) / total;
    if (share < 0.25) return;
    out.push(observation('campaign', rule, share >= 0.40 ? 'high' : 'medium', top.campaignName, `${label} concentration is ${pct(share)} in the leading campaign.`, top, { share, observedId: top.campaignId, identityResolved: false }));
  }

  function addMatchTypeObservations(out, rows) {
    const valid = rows.filter((row) => row.spendMicros > 0);
    if (!valid.length) return;
    const spendLeader = [...valid].sort((a, b) => b.spendMicros - a.spendMicros)[0];
    const acosBest = [...valid].filter((row) => Number.isFinite(row.acos)).sort((a, b) => a.acos - b.acos)[0];
    const acosWorst = [...valid].filter((row) => Number.isFinite(row.acos)).sort((a, b) => b.acos - a.acos)[0];
    if (spendLeader) out.push(observation('match-type', 'spend_leader', 'info', spendLeader.matchType, `${spendLeader.matchType || 'Unknown'} carries the largest spend in the selected scope.`, spendLeader));
    if (acosBest) out.push(observation('match-type', 'efficiency_leader', 'info', acosBest.matchType, `${acosBest.matchType || 'Unknown'} has the lowest observed ACoS among match types with spend.`, acosBest));
    if (acosWorst && acosWorst !== acosBest) out.push(observation('match-type', 'efficiency_laggard', 'medium', acosWorst.matchType, `${acosWorst.matchType || 'Unknown'} has the highest observed ACoS among match types with spend.`, acosWorst));
  }

  function addTrendObservations(out, rows) {
    const ordered = [...rows].sort((a, b) => String(a.reportDate || '').localeCompare(String(b.reportDate || '')));
    for (let index = 7; index < ordered.length; index += 1) {
      const current = ordered[index];
      const prior = ordered.slice(index - 7, index);
      const avgSpend = average(prior, 'spendMicros');
      const avgSales = average(prior, 'salesMicros');
      const avgAcos = averageFinite(prior, 'acos');
      const avgRoas = averageFinite(prior, 'roas');
      const avgCvr = averageFinite(prior, 'cvr');
      if (avgSpend > 0 && current.spendMicros > avgSpend * 1.5) out.push(observation('trend', 'spend_spike', 'medium', current.reportDate, `Spend is ${pct(current.spendMicros / avgSpend - 1)} above the trailing 7-day average.`, current, { trailing7AverageMicros: avgSpend }));
      if (avgSales > 0 && current.salesMicros < avgSales * 0.6) out.push(observation('trend', 'sales_drop', 'high', current.reportDate, `Sales are ${pct(1 - current.salesMicros / avgSales)} below the trailing 7-day average.`, current, { trailing7AverageMicros: avgSales }));
      if (Number.isFinite(current.acos) && Number.isFinite(avgAcos) && avgAcos > 0 && current.acos > avgAcos * 1.5) out.push(observation('trend', 'acos_deterioration', 'medium', current.reportDate, `ACoS is ${pct(current.acos / avgAcos - 1)} above the trailing 7-day average.`, current, { trailing7Average: avgAcos }));
      if (Number.isFinite(current.roas) && Number.isFinite(avgRoas) && avgRoas > 0 && current.roas > avgRoas * 1.5) out.push(observation('trend', 'roas_improvement', 'info', current.reportDate, `ROAS is ${pct(current.roas / avgRoas - 1)} above the trailing 7-day average.`, current, { trailing7Average: avgRoas }));
      if (Number.isFinite(current.cvr) && Number.isFinite(avgCvr) && avgCvr > 0 && Math.abs(current.cvr / avgCvr - 1) > 0.5) out.push(observation('trend', 'conversion_shift', 'medium', current.reportDate, `CVR shifted ${pct(current.cvr / avgCvr - 1)} versus the trailing 7-day average.`, current, { trailing7Average: avgCvr }));
    }
  }

  function observation(category, rule, severity, subject, explanation, row, extra = {}) {
    return Object.freeze({
      kind: 'diagnostic',
      category,
      rule,
      severity,
      subject: subject || '—',
      explanation,
      evidence: Object.freeze({
        impressions: numberOr(row.impressions, 0),
        clicks: numberOr(row.clicks, 0),
        spendMicros: numberOr(row.spendMicros, 0),
        orders: numberOr(row.orders ?? row.purchases, 0),
        salesMicros: numberOr(row.salesMicros, 0),
        acos: finiteOrNull(row.acos),
        roas: finiteOrNull(row.roas),
        cvr: finiteOrNull(row.cvr),
        ...extra,
      }),
      authoritative: false,
      recommendationAuthorized: false,
      amazonExecutionAuthorized: false,
    });
  }

  function addRanked(out, rows, field, direction, limit, mapper) {
    const sign = direction === 'asc' ? 1 : -1;
    const ranked = [...rows].sort((a, b) => sign * (numberOr(a[field], 0) - numberOr(b[field], 0))).slice(0, limit);
    for (const row of ranked) out.push(mapper(row));
  }

  function metricRow(row = {}) {
    const impressions = numberOr(row.impressions, 0);
    const clicks = numberOr(row.clicks, 0);
    const spendMicros = numberOr(row.spendMicros, 0);
    const orders = numberOr(row.orders ?? row.purchases, 0);
    const salesMicros = numberOr(row.salesMicros, 0);
    return {
      ...row,
      impressions,
      clicks,
      spendMicros,
      orders,
      salesMicros,
      cvr: Number.isFinite(Number(row.cvr)) ? Number(row.cvr) : (clicks === 0 ? null : orders / clicks),
      acos: Number.isFinite(Number(row.acos)) ? Number(row.acos) : (salesMicros === 0 ? null : spendMicros / salesMicros),
      roas: Number.isFinite(Number(row.roas)) ? Number(row.roas) : (spendMicros === 0 ? null : salesMicros / spendMicros),
    };
  }

  function quantile(rows, field, p) {
    const values = rows.map((row) => Number(row[field])).filter(Number.isFinite).sort((a, b) => a - b);
    if (!values.length) return null;
    return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1))];
  }

  function average(rows, field) { return rows.length ? rows.reduce((sum, row) => sum + numberOr(row[field], 0), 0) / rows.length : null; }
  function averageFinite(rows, field) {
    const values = rows.map((row) => Number(row[field])).filter(Number.isFinite);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  }
  function finiteAtLeast(value, threshold) { return Number.isFinite(Number(value)) && Number.isFinite(Number(threshold)) && Number(value) >= Number(threshold); }
  function finiteAtMost(value, threshold) { return Number.isFinite(Number(value)) && Number.isFinite(Number(threshold)) && Number(value) <= Number(threshold); }
  function finiteOrNull(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }
  function numberOr(value, fallback) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }

  function activeFilters() {
    const filters = global.CloudflareCsvAnalyticsDrilldown?.activeFilters?.() || {};
    return compact(filters);
  }

  function dashboardScope() {
    const dashboard = global.document.querySelector('#cfCsvAnalyticsDashboard');
    return {
      storeId: String(global.CloudflareOperatorWorkspace?.currentStoreId?.() || dashboard?.querySelector('#cfCsvAnalyticsStore')?.textContent || '').trim().replace(/^—$/, ''),
      startDate: String(dashboard?.querySelector('#cfCsvAnalyticsStart')?.value || '').trim(),
      endDate: String(dashboard?.querySelector('#cfCsvAnalyticsEnd')?.value || '').trim(),
    };
  }

  function api() {
    if (!global.CloudflareNativeAPI?.csvAnalytics) throw new Error('csv_analytics_native_api_not_ready');
    return global.CloudflareNativeAPI;
  }

  function compact(value) { return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== null && item !== undefined && item !== '')); }

  function renderResult(result) {
    const summary = state.root?.querySelector('[data-cfdiag-summary]');
    const body = state.root?.querySelector('[data-cfdiag-body]');
    if (!summary || !body) return;
    if (!result) {
      summary.innerHTML = '';
      body.innerHTML = '<tr><td colspan="5" class="cfCsvDiagnosticsEmpty">No diagnostics available.</td></tr>';
      return;
    }
    const counts = countByCategory(result.observations);
    summary.innerHTML = `
      ${summaryCard('Observations', formatInt(result.observations.length), 'diagnostic only')}
      ${summaryCard('Search terms', formatInt(result.coverage.searchTermRowsAnalyzed), result.coverage.searchTermComplete ? 'complete scope' : `capped from ${formatInt(result.coverage.searchTermRowsTotal)}`)}
      ${summaryCard('Campaign', formatInt(counts.campaign || 0), 'relative observations')}
      ${summaryCard('Search term', formatInt(counts['search-term'] || 0), 'relative observations')}
      ${summaryCard('Trend', formatInt(counts.trend || 0), '7-day relative shifts')}
      ${summaryCard('Match type', formatInt(counts['match-type'] || 0), 'comparative observations')}`;
    body.innerHTML = result.observations.length
      ? result.observations.map((item) => `<tr><td>${escapeHtml(item.category)}</td><td><strong>${escapeHtml(item.rule.replaceAll('_', ' '))}</strong><small>${escapeHtml(item.explanation)}</small></td><td>${escapeHtml(item.subject)}</td><td>${evidenceText(item.evidence)}</td><td><span class="cfCsvDiagnosticsSeverity" data-severity="${escapeHtml(item.severity)}">${escapeHtml(item.severity)}</span></td></tr>`).join('')
      : '<tr><td colspan="5" class="cfCsvDiagnosticsEmpty">No relative anomalies or leaders detected in this scope.</td></tr>';
  }

  function countByCategory(items) {
    const out = {};
    for (const item of items || []) out[item.category] = (out[item.category] || 0) + 1;
    return out;
  }

  function evidenceText(evidence) {
    const parts = [
      `Spend ${money(evidence.spendMicros)}`,
      `Sales ${money(evidence.salesMicros)}`,
      `Orders ${formatInt(evidence.orders)}`,
      `Clicks ${formatInt(evidence.clicks)}`,
    ];
    if (Number.isFinite(evidence.acos)) parts.push(`ACoS ${pct(evidence.acos)}`);
    if (Number.isFinite(evidence.roas)) parts.push(`ROAS ${ratio(evidence.roas)}`);
    return escapeHtml(parts.join(' · '));
  }

  function renderStatus(text, tone) {
    const node = state.root?.querySelector('[data-cfdiag-status]');
    if (!node) return;
    node.textContent = String(text || '');
    node.dataset.tone = tone || '';
  }
  function setBusy(busy) {
    state.root?.setAttribute('aria-busy', busy ? 'true' : 'false');
    const button = state.root?.querySelector('[data-cfdiag-refresh]');
    if (button) button.disabled = Boolean(busy);
  }
  function summaryCard(label, value, note) { return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></div>`; }
  function formatInt(value) { return Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value)) : '—'; }
  function money(value) { return Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value) / 1e6) : '—'; }
  function pct(value) { return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(2)}%` : '—'; }
  function ratio(value) { return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—'; }
  function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }

  function installStyles() {
    if (global.document.querySelector('#cfCsvLocalDiagnosticsStyles')) return;
    const style = global.document.createElement('style');
    style.id = 'cfCsvLocalDiagnosticsStyles';
    style.textContent = `
      .cfCsvDiagnosticsCard{border:1px solid var(--line);border-radius:10px;background:var(--card);overflow:hidden}.cfCsvDiagnosticsHead{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 11px;border-bottom:1px solid var(--line)}.cfCsvDiagnosticsHead>div{display:flex;align-items:center;gap:8px}.cfCsvDiagnosticsHead>div:first-child{flex-direction:column;align-items:flex-start;gap:2px}.cfCsvDiagnosticsHead strong{font-size:12.5px}.cfCsvDiagnosticsHead span{font-size:9.8px;color:var(--muted)}.cfCsvDiagnosticsBadge{padding:5px 8px;border-radius:7px;background:var(--softWarn);color:var(--warn)!important;font-weight:800}.cfCsvDiagnosticsDiscipline{padding:8px 10px;background:var(--softWarn);color:var(--warn);font-size:9.8px;font-weight:700}.cfCsvDiagnosticsStatus{margin:8px 10px 0;padding:7px 9px;border-radius:8px;background:var(--hover-bg);font-size:10.4px;color:var(--muted)}.cfCsvDiagnosticsStatus[data-tone="ok"]{background:var(--softGood);color:var(--good)}.cfCsvDiagnosticsStatus[data-tone="warn"]{background:var(--softWarn);color:var(--warn)}.cfCsvDiagnosticsStatus[data-tone="bad"]{background:var(--softBad);color:var(--bad)}.cfCsvDiagnosticsSummary{display:grid;grid-template-columns:repeat(6,minmax(105px,1fr));gap:7px;padding:8px 10px}.cfCsvDiagnosticsSummary>div{padding:8px;border:1px solid var(--line);border-radius:8px}.cfCsvDiagnosticsSummary span,.cfCsvDiagnosticsSummary small{display:block;color:var(--muted);font-size:9px}.cfCsvDiagnosticsSummary strong{display:block;margin:3px 0;font-size:14px}.cfCsvDiagnosticsTableWrap{max-height:440px;overflow:auto;border-top:1px solid var(--line)}.cfCsvDiagnosticsTableWrap table{width:100%;min-width:980px;border-collapse:collapse}.cfCsvDiagnosticsTableWrap th,.cfCsvDiagnosticsTableWrap td{padding:8px 9px;border-bottom:1px solid var(--line);text-align:left;font-size:10px;vertical-align:top}.cfCsvDiagnosticsTableWrap th{position:sticky;top:0;background:var(--th-bg);color:var(--muted);z-index:1}.cfCsvDiagnosticsTableWrap td strong,.cfCsvDiagnosticsTableWrap td small{display:block}.cfCsvDiagnosticsTableWrap td small{margin-top:2px;color:var(--muted);max-width:360px}.cfCsvDiagnosticsSeverity{display:inline-flex;padding:4px 6px;border-radius:6px;background:var(--hover-bg);font-weight:800}.cfCsvDiagnosticsSeverity[data-severity="high"]{color:var(--bad);background:var(--softBad)}.cfCsvDiagnosticsSeverity[data-severity="medium"]{color:var(--warn);background:var(--softWarn)}.cfCsvDiagnosticsSeverity[data-severity="info"]{color:var(--good);background:var(--softGood)}.cfCsvDiagnosticsEmpty{text-align:center!important;color:var(--muted);height:90px}@media(max-width:900px){.cfCsvDiagnosticsHead{flex-direction:column;align-items:flex-start}.cfCsvDiagnosticsSummary{grid-template-columns:repeat(3,minmax(0,1fr))}}
    `;
    global.document.head.appendChild(style);
  }
})(typeof window !== 'undefined' ? window : globalThis);
