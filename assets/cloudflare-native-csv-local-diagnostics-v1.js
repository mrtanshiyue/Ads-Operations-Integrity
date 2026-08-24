(function initCloudflareCsvLocalDiagnostics(global) {
  'use strict';

  const VERSION = '1.1.0';
  // Compatibility for the pure local generator contract only. Runtime refresh never paginates search terms.
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
  global.addEventListener?.('cloudflare-csv-analytics-scope-change', () => void refresh());

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
      <div class="cfCsvDiagnosticsCoverage" data-cfdiag-coverage></div>
      <div class="cfCsvDiagnosticsFinancial" data-cfdiag-financial role="note" aria-label="Financial diagnostics comparability" hidden></div>
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
    if (!state.root) return;
    const seq = ++state.requestSeq;
    const scope = dashboardScope();
    if (!scope.storeId || !scope.startDate || !scope.endDate || scope.endDate < scope.startDate) {
      state.loading = false;
      setBusy(false);
      renderResult(null);
      renderStatus(scope.startDate && scope.endDate && scope.endDate < scope.startDate
        ? 'End date must not be earlier than start date before diagnostics.'
        : 'Store and date range are required before diagnostics.', 'warn');
      return;
    }
    state.loading = true;
    setBusy(true);
    renderStatus('Reading full governed analytics and computing diagnostics server-side…', 'loading');
    try {
      const filters = activeFilters();
      const common = compact({ startDate: scope.startDate, endDate: scope.endDate, ...filters });
      const result = await api().csvAnalytics(scope.storeId, 'diagnostics', common);
      if (seq !== state.requestSeq) return;
      renderResult(result);
      const partial = result.coverage?.partial === true;
      const financialSuppressed = result.financialObservationsSuppressed === true || result.financialObservationPolicy === 'suppressed_not_comparable';
      const coverageText = partial
        ? `${result.observations?.length || 0} observations generated from truthful partial coverage.`
        : `${result.observations?.length || 0} local observations generated from full server-side coverage.`;
      renderStatus(financialSuppressed
        ? `${coverageText} Financial diagnostics are suppressed for this scope; traffic and conversion diagnostics remain available. No execution authority granted.`
        : `${coverageText} No execution authority granted.`, financialSuppressed ? 'warn' : 'ok');
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
    addRanked(observations, searchTerms.filter((row) => row.orders === 0 && finiteAtLeast(row.spendMicros, searchThresholds.spendP90)), 'spendMicros', 'desc', 10, (row) => observation('search-term', 'high_spend_zero_orders', 'high', row.searchTerm, `Spend ${money(row.spendMicros)} is in the top decile while attributed orders are zero.`, row));
    addRanked(observations, searchTerms.filter((row) => Number.isFinite(row.acos) && finiteAtLeast(row.acos, searchThresholds.acosP90)), 'acos', 'desc', 10, (row) => observation('search-term', 'high_acos', 'medium', row.searchTerm, `ACoS ${pct(row.acos)} is in the highest decile of this scope.`, row));
    addRanked(observations, searchTerms.filter((row) => Number.isFinite(row.roas) && finiteAtLeast(row.roas, searchThresholds.roasP90)), 'roas', 'desc', 8, (row) => observation('search-term', 'high_roas', 'info', row.searchTerm, `ROAS ${ratio(row.roas)} is in the highest decile of this scope.`, row));
    addRanked(observations, searchTerms.filter((row) => Number.isFinite(row.cvr) && row.clicks >= numberOr(searchThresholds.clicksP50, 0) && finiteAtLeast(row.cvr, searchThresholds.cvrP90)), 'cvr', 'desc', 8, (row) => observation('search-term', 'high_conversion', 'info', row.searchTerm, `CVR ${pct(row.cvr)} is in the highest decile with at least median click volume.`, row));
    addRanked(observations, searchTerms.filter((row) => finiteAtLeast(row.clicks, searchThresholds.clicksP90)), 'clicks', 'desc', 8, (row) => observation('search-term', 'large_click_volume', 'info', row.searchTerm, `${formatInt(row.clicks)} clicks place this search term in the highest click-volume decile.`, row));
    addRanked(observations, searchTerms.filter((row) => row.clicks >= numberOr(searchThresholds.clicksP75, 0) && Number.isFinite(row.cvr) && finiteAtMost(row.cvr, searchThresholds.cvrP25)), 'clicks', 'desc', 10, (row) => observation('search-term', 'low_conversion', 'medium', row.searchTerm, `${formatInt(row.clicks)} clicks with CVR ${pct(row.cvr)} are weak relative to this scope.`, row));

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

    const analyzedGroups = searchTerms.length;
    const totalGroups = Math.max(analyzedGroups, Math.max(0, Number(input.searchTermTotal ?? analyzedGroups)));
    const partial = input.searchTermComplete === false || analyzedGroups < totalGroups;
    const coverageRatio = totalGroups > 0 ? analyzedGroups / totalGroups : 1;
    const truncationReason = partial
      ? String(input.searchTermTruncationReason || (analyzedGroups >= MAX_SEARCH_TERM_ROWS ? `client_row_cap_${MAX_SEARCH_TERM_ROWS}` : 'incomplete_source_coverage'))
      : null;

    return Object.freeze({
      kind: 'diagnostic_bundle',
      authoritative: false,
      recommendationAuthorized: false,
      reviewAuthorized: false,
      amazonExecutionAuthorized: false,
      sourceKind: 'csv_business_analytics',
      scope: input.scope || null,
      coverage: Object.freeze({
        totalGroups,
        analyzedGroups,
        coverageRatio,
        partial,
        truncationReason,
        pagesLoaded: Math.max(0, Number(input.searchTermPagesLoaded || 0)),
        searchTermRowsAnalyzed: analyzedGroups,
        searchTermRowsTotal: totalGroups,
        searchTermComplete: !partial,
        campaignRowsAnalyzed: campaigns.length,
        dailyRowsAnalyzed: daily.length,
        matchTypeRowsAnalyzed: matchTypes.length,
      }),
      thresholds: Object.freeze({ searchTerm: searchThresholds, campaign: campaignThresholds }),
      observations: Object.freeze(observations.slice(0, MAX_OBSERVATIONS)),
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
      if (avgSpend > 0 && current.spendMicros > avgSpend * 1.5) out.push(observation('trend', 'spend_spike', 'medium', current.reportDate, `Spend is ${pct(current.spendMicros / avgSpend - 1)} above the trailing 7-day average.`, current));
      if (avgSales > 0 && current.salesMicros < avgSales * 0.6) out.push(observation('trend', 'sales_drop', 'high', current.reportDate, `Sales are ${pct(1 - current.salesMicros / avgSales)} below the trailing 7-day average.`, current));
      if (Number.isFinite(current.acos) && Number.isFinite(avgAcos) && avgAcos > 0 && current.acos > avgAcos * 1.5) out.push(observation('trend', 'acos_deterioration', 'medium', current.reportDate, `ACoS is ${pct(current.acos / avgAcos - 1)} above the trailing 7-day average.`, current));
      if (Number.isFinite(current.roas) && Number.isFinite(avgRoas) && avgRoas > 0 && current.roas > avgRoas * 1.5) out.push(observation('trend', 'roas_improvement', 'info', current.reportDate, `ROAS is ${pct(current.roas / avgRoas - 1)} above the trailing 7-day average.`, current));
      if (Number.isFinite(current.cvr) && Number.isFinite(avgCvr) && avgCvr > 0 && Math.abs(current.cvr / avgCvr - 1) > 0.5) out.push(observation('trend', 'conversion_shift', 'medium', current.reportDate, `CVR shifted ${pct(current.cvr / avgCvr - 1)} versus the trailing 7-day average.`, current));
    }
  }

  function observation(category, rule, severity, subject, explanation, row, extra = {}) {
    return Object.freeze({
      kind: 'diagnostic', category, rule, severity, subject: subject || '—', explanation,
      evidence: Object.freeze({
        impressions: numberOr(row.impressions, 0), clicks: numberOr(row.clicks, 0), spendMicros: numberOr(row.spendMicros, 0),
        orders: numberOr(row.orders ?? row.purchases, 0), salesMicros: numberOr(row.salesMicros, 0),
        acos: finiteOrNull(row.acos), roas: finiteOrNull(row.roas), cvr: finiteOrNull(row.cvr), ...extra,
      }),
      authoritative: false, recommendationAuthorized: false, amazonExecutionAuthorized: false,
    });
  }

  function addRanked(out, rows, field, direction, limit, mapper) {
    const sign = direction === 'asc' ? 1 : -1;
    for (const row of [...rows].sort((a, b) => sign * (numberOr(a[field], 0) - numberOr(b[field], 0))).slice(0, limit)) out.push(mapper(row));
  }
  function metricRow(row = {}) {
    const impressions = numberOr(row.impressions, 0); const clicks = numberOr(row.clicks, 0); const spendMicros = numberOr(row.spendMicros, 0);
    const orders = numberOr(row.orders ?? row.purchases, 0); const salesMicros = numberOr(row.salesMicros, 0);
    return { ...row, impressions, clicks, spendMicros, orders, salesMicros,
      cvr: finiteNumber(row.cvr) ?? (clicks === 0 ? null : orders / clicks),
      acos: finiteNumber(row.acos) ?? (salesMicros === 0 ? null : spendMicros / salesMicros),
      roas: finiteNumber(row.roas) ?? (spendMicros === 0 ? null : salesMicros / spendMicros) };
  }
  function quantile(rows, field, p) { const values = rows.map((row) => finiteNumber(row[field])).filter((value) => value !== null).sort((a, b) => a - b); return values.length ? values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1))] : null; }
  function average(rows, field) { return rows.length ? rows.reduce((sum, row) => sum + numberOr(row[field], 0), 0) / rows.length : null; }
  function averageFinite(rows, field) { const values = rows.map((row) => finiteNumber(row[field])).filter((value) => value !== null); return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
  function finiteNumber(value) { if (value === null || value === undefined || value === '') return null; const numeric = Number(value); return Number.isFinite(numeric) ? numeric : null; }
  function finiteAtLeast(value, threshold) { const numeric = finiteNumber(value); const benchmark = finiteNumber(threshold); return numeric !== null && benchmark !== null && numeric >= benchmark; }
  function finiteAtMost(value, threshold) { const numeric = finiteNumber(value); const benchmark = finiteNumber(threshold); return numeric !== null && benchmark !== null && numeric <= benchmark; }
  function finiteOrNull(value) { return finiteNumber(value); }
  function numberOr(value, fallback) { return finiteNumber(value) ?? fallback; }
  function activeFilters() { return compact(global.CloudflareCsvAnalyticsDrilldown?.activeFilters?.() || {}); }
  function dashboardScope() {
    const dashboardState = global.CloudflareCsvAnalyticsDashboard?.getState?.() || {};
    const dashboard = global.document.querySelector('#cfCsvAnalyticsDashboard');
    return {
      storeId: String(dashboardState.storeId || global.CloudflareOperatorWorkspace?.currentStoreId?.() || dashboard?.querySelector('#cfCsvAnalyticsStore')?.textContent || '').trim().replace(/^—$/, ''),
      startDate: String(dashboardState.startDate || dashboard?.querySelector('#cfCsvAnalyticsStart')?.value || '').trim(),
      endDate: String(dashboardState.endDate || dashboard?.querySelector('#cfCsvAnalyticsEnd')?.value || '').trim(),
    };
  }
  function api() { if (!global.CloudflareNativeAPI?.csvAnalytics) throw new Error('csv_analytics_native_api_not_ready'); return global.CloudflareNativeAPI; }
  function compact(value) { return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== null && item !== undefined && item !== '')); }

  function renderResult(result) {
    const summary = state.root?.querySelector('[data-cfdiag-summary]');
    const body = state.root?.querySelector('[data-cfdiag-body]');
    const coverage = state.root?.querySelector('[data-cfdiag-coverage]');
    const financial = state.root?.querySelector('[data-cfdiag-financial]');
    if (!summary || !body || !coverage || !financial) return;
    if (!result) {
      summary.innerHTML = '';
      coverage.innerHTML = '';
      financial.innerHTML = '';
      financial.hidden = true;
      delete financial.dataset.state;
      body.innerHTML = '<tr><td colspan="5" class="cfCsvDiagnosticsEmpty">No diagnostics available.</td></tr>';
      return;
    }
    const c = result.coverage;
    coverage.innerHTML = c.partial
      ? `<strong>Partial coverage</strong><span>${formatInt(c.analyzedGroups)} of ${formatInt(c.totalGroups)} groups analyzed · ${pct(c.coverageRatio)} · ${escapeHtml(c.truncationReason || 'truncated')}</span>`
      : `<strong>Full coverage</strong><span>${formatInt(c.analyzedGroups)} of ${formatInt(c.totalGroups)} groups analyzed · 100%</span>`;
    coverage.dataset.partial = c.partial ? 'true' : 'false';
    renderFinancialState(result, financial);
    const counts = countByCategory(result.observations);
    summary.innerHTML = `${summaryCard('Observations', formatInt(result.observations.length), 'diagnostic only')}${summaryCard('Search terms', formatInt(c.analyzedGroups), c.partial ? 'Partial coverage' : 'Full coverage')}${summaryCard('Campaign', formatInt(counts.campaign || 0), 'relative observations')}${summaryCard('Search term', formatInt(counts['search-term'] || 0), 'relative observations')}${summaryCard('Trend', formatInt(counts.trend || 0), '7-day relative shifts')}${summaryCard('Match type', formatInt(counts['match-type'] || 0), 'comparative observations')}`;
    body.innerHTML = result.observations.length
      ? result.observations.map((item) => `<tr><td>${escapeHtml(item.category)}</td><td><strong>${escapeHtml(item.rule.replaceAll('_', ' '))}</strong><small>${escapeHtml(item.explanation)}</small></td><td>${escapeHtml(item.subject)}</td><td>${evidenceText(item.evidence)}</td><td><span class="cfCsvDiagnosticsSeverity" data-severity="${escapeHtml(item.severity)}">${escapeHtml(item.severity)}</span></td></tr>`).join('')
      : '<tr><td colspan="5" class="cfCsvDiagnosticsEmpty">No relative anomalies or leaders detected in this scope.</td></tr>';
  }
  function renderFinancialState(result, node) {
    const scope = result?.financialScope;
    const comparableKnown = scope && typeof scope.financiallyComparable === 'boolean';
    const suppressed = result?.financialObservationsSuppressed === true || result?.financialObservationPolicy === 'suppressed_not_comparable';
    node.hidden = false;
    if (!comparableKnown) {
      node.dataset.state = 'unknown';
      node.innerHTML = '<strong>Financial diagnostics status unavailable</strong><span>Comparability metadata was not returned, so this view makes no positive financial-comparability claim.</span>';
      return;
    }
    if (suppressed || scope.financiallyComparable !== true) {
      node.dataset.state = 'suppressed';
      const reasons = uniqueTexts(scope.reasons).map(financialReasonLabel);
      const reasonText = reasons.length ? reasons.join(' · ') : 'Scope is not financially comparable';
      node.innerHTML = `<strong>Financial diagnostics suppressed</strong><span>${escapeHtml(reasonText)}. Traffic and conversion diagnostics remain available; financial evidence is hidden.</span>`;
      return;
    }
    node.dataset.state = 'comparable';
    node.innerHTML = '<strong>Financial diagnostics active</strong><span>Comparable financial scope. Financial observations may be shown.</span>';
  }
  function financialReasonLabel(reason) {
    return ({
      multiple_currency_codes: 'Multiple currencies in current scope',
      multiple_marketplaces: 'Multiple marketplaces in current scope',
      currency_code_missing: 'Currency metadata missing',
      marketplace_missing: 'Marketplace metadata missing',
    })[reason] || String(reason || 'Financial comparability requirement not met').replaceAll('_', ' ');
  }
  function uniqueTexts(values) { return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))]; }
  function countByCategory(items) { const out = {}; for (const item of items || []) out[item.category] = (out[item.category] || 0) + 1; return out; }
  function evidenceText(evidence = {}) {
    const financialSuppressed = evidence.financialEvidenceSuppressed === true;
    const parts = [`Orders ${formatInt(evidence.orders)}`, `Clicks ${formatInt(evidence.clicks)}`];
    if (Number.isFinite(evidence.cvr)) parts.push(`CVR ${pct(evidence.cvr)}`);
    if (financialSuppressed) {
      parts.push('Financial evidence suppressed');
    } else {
      parts.unshift(`Spend ${money(evidence.spendMicros)}`, `Sales ${money(evidence.salesMicros)}`);
      if (Number.isFinite(evidence.acos)) parts.push(`ACoS ${pct(evidence.acos)}`);
      if (Number.isFinite(evidence.roas)) parts.push(`ROAS ${ratio(evidence.roas)}`);
    }
    return escapeHtml(parts.join(' · '));
  }
  function renderStatus(text, tone) { const node = state.root?.querySelector('[data-cfdiag-status]'); if (!node) return; node.textContent = String(text || ''); node.dataset.tone = tone || ''; }
  function setBusy(busy) { state.root?.setAttribute('aria-busy', busy ? 'true' : 'false'); const button = state.root?.querySelector('[data-cfdiag-refresh]'); if (button) button.disabled = Boolean(busy); }
  function summaryCard(label, value, note) { return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></div>`; }
  function formatInt(value) { const numeric = finiteNumber(value); return numeric === null ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(numeric); }
  function money(value) { const numeric = finiteNumber(value); return numeric === null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(numeric / 1e6); }
  function pct(value) { const numeric = finiteNumber(value); return numeric === null ? '—' : `${(numeric * 100).toFixed(2)}%`; }
  function ratio(value) { const numeric = finiteNumber(value); return numeric === null ? '—' : numeric.toFixed(2); }
  function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }

  function installStyles() {
    if (global.document.querySelector('#cfCsvLocalDiagnosticsStyles')) return;
    const style = global.document.createElement('style');
    style.id = 'cfCsvLocalDiagnosticsStyles';
    style.textContent = `.cfCsvDiagnosticsCard{border:1px solid var(--line);border-radius:10px;background:var(--card);overflow:hidden}.cfCsvDiagnosticsHead{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 11px;border-bottom:1px solid var(--line)}.cfCsvDiagnosticsHead>div{display:flex;align-items:center;gap:8px}.cfCsvDiagnosticsHead>div:first-child{flex-direction:column;align-items:flex-start;gap:2px}.cfCsvDiagnosticsHead strong{font-size:12.5px}.cfCsvDiagnosticsHead span{font-size:9.8px;color:var(--muted)}.cfCsvDiagnosticsBadge{padding:5px 8px;border-radius:7px;background:var(--softWarn);color:var(--warn)!important;font-weight:800}.cfCsvDiagnosticsDiscipline{padding:8px 10px;background:var(--softWarn);color:var(--warn);font-size:9.8px;font-weight:700}.cfCsvDiagnosticsStatus,.cfCsvDiagnosticsCoverage,.cfCsvDiagnosticsFinancial{margin:8px 10px 0;padding:7px 9px;border-radius:8px;background:var(--hover-bg);font-size:10.4px;color:var(--muted)}.cfCsvDiagnosticsCoverage,.cfCsvDiagnosticsFinancial{display:flex;align-items:center;gap:8px}.cfCsvDiagnosticsCoverage strong{color:var(--good)}.cfCsvDiagnosticsCoverage[data-partial="true"]{background:var(--softWarn);color:var(--warn)}.cfCsvDiagnosticsCoverage[data-partial="true"] strong{color:var(--warn)}.cfCsvDiagnosticsFinancial strong{flex:none}.cfCsvDiagnosticsFinancial[data-state="comparable"]{background:var(--softGood);color:var(--good)}.cfCsvDiagnosticsFinancial[data-state="suppressed"],.cfCsvDiagnosticsFinancial[data-state="unknown"]{background:var(--softWarn);color:var(--warn)}.cfCsvDiagnosticsStatus[data-tone="ok"]{background:var(--softGood);color:var(--good)}.cfCsvDiagnosticsStatus[data-tone="warn"]{background:var(--softWarn);color:var(--warn)}.cfCsvDiagnosticsStatus[data-tone="bad"]{background:var(--softBad);color:var(--bad)}.cfCsvDiagnosticsSummary{display:grid;grid-template-columns:repeat(6,minmax(105px,1fr));gap:7px;padding:8px 10px}.cfCsvDiagnosticsSummary>div{padding:8px;border:1px solid var(--line);border-radius:8px}.cfCsvDiagnosticsSummary span,.cfCsvDiagnosticsSummary small{display:block;color:var(--muted);font-size:9px}.cfCsvDiagnosticsSummary strong{display:block;margin:3px 0;font-size:14px}.cfCsvDiagnosticsTableWrap{max-height:440px;overflow:auto;border-top:1px solid var(--line)}.cfCsvDiagnosticsTableWrap table{width:100%;min-width:980px;border-collapse:collapse}.cfCsvDiagnosticsTableWrap th,.cfCsvDiagnosticsTableWrap td{padding:8px 9px;border-bottom:1px solid var(--line);text-align:left;font-size:10px;vertical-align:top}.cfCsvDiagnosticsTableWrap th{position:sticky;top:0;background:var(--th-bg);color:var(--muted);z-index:1}.cfCsvDiagnosticsTableWrap td strong,.cfCsvDiagnosticsTableWrap td small{display:block}.cfCsvDiagnosticsTableWrap td small{margin-top:2px;color:var(--muted);max-width:360px}.cfCsvDiagnosticsSeverity{display:inline-flex;padding:4px 6px;border-radius:6px;background:var(--hover-bg);font-weight:800}.cfCsvDiagnosticsSeverity[data-severity="high"]{color:var(--bad);background:var(--softBad)}.cfCsvDiagnosticsSeverity[data-severity="medium"]{color:var(--warn);background:var(--softWarn)}.cfCsvDiagnosticsSeverity[data-severity="info"]{color:var(--good);background:var(--softGood)}.cfCsvDiagnosticsEmpty{text-align:center!important;color:var(--muted);height:90px}@media(max-width:900px){.cfCsvDiagnosticsHead{flex-direction:column;align-items:flex-start}.cfCsvDiagnosticsFinancial{align-items:flex-start;flex-direction:column}.cfCsvDiagnosticsSummary{grid-template-columns:repeat(3,minmax(0,1fr))}}`;
    global.document.head.appendChild(style);
  }
})(typeof window !== 'undefined' ? window : globalThis);