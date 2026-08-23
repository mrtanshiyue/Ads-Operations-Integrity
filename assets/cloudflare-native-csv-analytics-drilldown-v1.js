(function initCloudflareCsvAnalyticsDrilldown(global) {
  'use strict';

  const VERSION = '1.0.0';
  const LEVELS = Object.freeze(['campaign', 'ad-group', 'targeting', 'search-term']);
  const MATCH_TYPES = Object.freeze(['', 'EXACT', 'PHRASE', 'BROAD', 'TARGETING_EXPRESSION', 'TARGETING_EXPRESSION_PREDEFINED']);
  const SORTS = Object.freeze(['spendMicros', 'salesMicros', 'clicks', 'impressions', 'purchases', 'acos', 'roas']);
  const PAGE_LIMIT = 50;
  const state = { mounted: false, loading: false, requestSeq: 0, baseScopeKey: '', page: 1, level: 'campaign', matchType: '', sort: 'spendMicros', direction: 'desc', q: '', path: [], root: null };

  const publicApi = Object.freeze({
    version: VERSION,
    refresh,
    reset,
    buildRequestParams,
    activeFilters: () => Object.freeze({ ...hierarchyFilters(), matchType: state.matchType || null }),
  });

  Object.defineProperty(global, 'CloudflareCsvAnalyticsDrilldown', { value: publicApi, writable: false, configurable: false, enumerable: true });
  if (!global.document) return;
  if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();

  global.addEventListener?.('cloudflare-operator-store-change', () => { reset(false); void refresh(); });

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
    if (dashboard.querySelector('[data-cf-csv-analytics-drilldown]')) return void (state.mounted = true);

    installStyles();
    const root = global.document.createElement('section');
    root.className = 'cfCsvDrilldownCard';
    root.dataset.cfCsvAnalyticsDrilldown = VERSION;
    root.innerHTML = `
      <div class="cfCsvDrilldownHead"><div><strong>Hierarchy drill-down</strong><span>Campaign → Ad Group → Targeting → Search Term</span></div><span class="cfCsvDrilldownAuthority">observed CSV identity · read only</span></div>
      <div class="cfCsvDrilldownControls">
        <label>Match type <select data-cfdd-match>${matchTypeOptions()}</select></label>
        <label>Sort <select data-cfdd-sort>${sortOptions()}</select></label>
        <label>Order <select data-cfdd-direction><option value="desc">Desc</option><option value="asc">Asc</option></select></label>
        <label class="cfCsvDrilldownSearch">Search <input data-cfdd-search type="search" maxlength="200" placeholder="Search within current scope"></label>
        <button type="button" class="btn" data-cfdd-refresh>Refresh scope</button>
        <button type="button" class="btn" data-cfdd-clear>Clear drill-down</button>
      </div>
      <div class="cfCsvDrilldownPath" data-cfdd-path></div>
      <div class="cfCsvDrilldownStatus" data-cfdd-status role="status" aria-live="polite">Loading governed hierarchy…</div>
      <div class="cfCsvDrilldownScope" data-cfdd-scope></div>
      <div class="cfCsvDrilldownTableWrap"><table><thead data-cfdd-head></thead><tbody data-cfdd-body></tbody></table></div>
      <div class="cfCsvDrilldownPager"><button type="button" class="btn" data-cfdd-prev>Previous</button><span data-cfdd-page>Page —</span><button type="button" class="btn" data-cfdd-next>Next</button></div>
      <div class="cfCsvDrilldownDiscipline">Rows drill only when the required observed ID is present. Observed IDs remain non-canonical and never authorize Amazon mutation.</div>`;
    const qualityCard = dashboard.querySelector('.cfCsvAnalyticsQualityCard');
    if (qualityCard) qualityCard.insertAdjacentElement('beforebegin', root); else dashboard.appendChild(root);
    state.root = root;
    state.mounted = true;
    state.baseScopeKey = baseScopeKey(dashboardScope());
    global.addEventListener?.('cloudflare-csv-analytics-scope-change', handleSharedScopeChange);

    root.addEventListener('change', (event) => {
      if (event.target.matches('[data-cfdd-match]')) state.matchType = MATCH_TYPES.includes(event.target.value) ? event.target.value : '';
      else if (event.target.matches('[data-cfdd-sort]')) state.sort = SORTS.includes(event.target.value) ? event.target.value : 'spendMicros';
      else if (event.target.matches('[data-cfdd-direction]')) state.direction = event.target.value === 'asc' ? 'asc' : 'desc';
      else return;
      state.page = 1;
      publishSharedScope();
      void refresh();
    });
    root.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || !event.target.matches('[data-cfdd-search]')) return;
      event.preventDefault();
      state.q = String(event.target.value || '').trim().slice(0, 200);
      syncDashboardQuery();
      state.page = 1;
      publishSharedScope();
      void refresh();
    });
    root.addEventListener('click', (event) => {
      if (event.target.closest('[data-cfdd-refresh]')) {
        state.q = String(root.querySelector('[data-cfdd-search]')?.value || '').trim().slice(0, 200);
        syncDashboardQuery();
        state.page = 1;
        publishSharedScope();
        return void refresh();
      }
      if (event.target.closest('[data-cfdd-clear]')) return reset(true);
      if (event.target.closest('[data-cfdd-prev]')) { if (state.page <= 1) return; state.page -= 1; return void refresh(); }
      if (event.target.closest('[data-cfdd-next]')) { state.page += 1; return void refresh(); }
      const breadcrumb = event.target.closest('[data-cfdd-depth]');
      if (breadcrumb) {
        const depth = Number(breadcrumb.dataset.cfddDepth);
        if (!Number.isInteger(depth) || depth < 0 || depth > state.path.length) return;
        state.path = state.path.slice(0, depth);
        state.level = LEVELS[Math.min(depth, LEVELS.length - 1)];
        state.page = 1;
        publishSharedScope();
        return void refresh();
      }
      const row = event.target.closest('[data-cfdd-drill]');
      if (!row || row.getAttribute('aria-disabled') === 'true') return;
      const next = nextSelectionFromRow(row);
      if (!next) return;
      state.path.push(next);
      state.level = LEVELS[Math.min(state.path.length, LEVELS.length - 1)];
      state.page = 1;
      publishSharedScope();
      void refresh();
    });
    publishSharedScope();
    void refresh();
  }

  function handleSharedScopeChange(event) {
    const detail = event?.detail || {};
    const nextKey = baseScopeKey(detail);
    const nextQuery = String(detail.q || '').trim().slice(0, 200);
    const baseChanged = Boolean(nextKey && nextKey !== state.baseScopeKey);
    const queryChanged = nextQuery !== state.q;
    if (!nextKey || (!baseChanged && !queryChanged)) return;
    state.baseScopeKey = nextKey;
    if (queryChanged) {
      state.q = nextQuery;
      const search = state.root?.querySelector('[data-cfdd-search]');
      if (search) search.value = state.q;
    }
    state.requestSeq += 1;
    state.loading = false;
    state.page = 1;
    renderBusy(false);
    renderScope(null, null);
    renderTable({ items: [], pagination: { page: 1, totalItems: 0, totalPages: 0 } });
    renderStatus('Analytics scope changed. Refresh scope to load hierarchy.', 'warn');
  }

  async function refresh() {
    if (!state.root) return;
    const scope = dashboardScope();
    const scopeKey = baseScopeKey(scope);
    if (!scopeKey) { renderStatus('Store and date range are required before drill-down.', 'warn'); return; }
    state.baseScopeKey = scopeKey;
    const seq = ++state.requestSeq;
    state.loading = true;
    renderBusy(true);
    renderStatus(`Loading ${levelLabel(state.level)} within governed business facts…`, 'loading');
    try {
      const params = buildRequestParams({ startDate: scope.startDate, endDate: scope.endDate, page: state.page, limit: PAGE_LIMIT, sort: state.sort, direction: state.direction, q: state.q, matchType: state.matchType, ...hierarchyFilters() });
      const scopeParams = buildRequestParams({ startDate: scope.startDate, endDate: scope.endDate, matchType: state.matchType, ...hierarchyFilters() });
      const [table, overview, quality] = await Promise.all([
        api().csvAnalytics(scope.storeId, state.level, params),
        api().csvAnalytics(scope.storeId, 'overview', scopeParams),
        api().csvAnalytics(scope.storeId, 'quality', scopeParams),
      ]);
      if (seq !== state.requestSeq) return;
      renderPath(); renderScope(overview, quality); renderTable(table);
      renderStatus(`${formatInt(table?.pagination?.totalItems)} ${levelLabel(state.level).toLowerCase()} rows in current scope.`, 'ok');
    } catch (error) {
      if (seq !== state.requestSeq) return;
      renderPath(); renderScope(null, null); renderTable({ items: [], pagination: { page: 1, totalItems: 0, totalPages: 0 } });
      renderStatus(`Hierarchy unavailable: ${error?.code || error?.message || 'request_failed'}`, 'bad');
    } finally {
      if (seq === state.requestSeq) { state.loading = false; renderBusy(false); }
    }
  }

  function reset(refreshNow = true) {
    state.path = []; state.level = 'campaign'; state.page = 1; state.matchType = ''; state.sort = 'spendMicros'; state.direction = 'desc'; state.q = '';
    if (state.root) {
      const match = state.root.querySelector('[data-cfdd-match]'); const sort = state.root.querySelector('[data-cfdd-sort]'); const direction = state.root.querySelector('[data-cfdd-direction]'); const search = state.root.querySelector('[data-cfdd-search]');
      if (match) match.value = ''; if (sort) sort.value = 'spendMicros'; if (direction) direction.value = 'desc'; if (search) search.value = ''; renderPath();
    }
    syncDashboardQuery();
    publishSharedScope();
    if (refreshNow) void refresh();
  }

  function api() { if (!global.CloudflareNativeAPI?.csvAnalytics) throw new Error('csv_analytics_native_api_not_ready'); return global.CloudflareNativeAPI; }
  function dashboardScope() {
    const shared = global.CloudflareCsvAnalyticsDashboard?.getState?.() || {};
    const dashboard = global.document.querySelector('#cfCsvAnalyticsDashboard');
    return {
      storeId: String(shared.storeId || global.CloudflareOperatorWorkspace?.currentStoreId?.() || dashboard?.querySelector('#cfCsvAnalyticsStore')?.textContent || '').trim().replace(/^—$/, ''),
      startDate: String(shared.startDate || dashboard?.querySelector('#cfCsvAnalyticsStart')?.value || '').trim(),
      endDate: String(shared.endDate || dashboard?.querySelector('#cfCsvAnalyticsEnd')?.value || '').trim(),
    };
  }
  function baseScopeKey(scope = {}) {
    const storeId = String(scope.storeId || scope.store || '').trim();
    const startDate = String(scope.startDate || '').trim();
    const endDate = String(scope.endDate || '').trim();
    if (!storeId || !startDate || !endDate) return '';
    return JSON.stringify([storeId, startDate, endDate]);
  }
  function hierarchyFilters() {
    const filters = {};
    for (const item of state.path) {
      if (item.level === 'campaign' && item.id) filters.campaignId = item.id;
      if (item.level === 'ad-group' && item.id) filters.adGroupId = item.id;
      if (item.level === 'targeting' && item.id) filters.targetingId = item.id;
    }
    return filters;
  }
  function syncDashboardQuery() {
    const input = global.document.querySelector('#cfCsvAnalyticsQuery');
    if (input) input.value = state.q;
  }
  function publishSharedScope() {
    if (global.CloudflareCsvAnalyticsDashboard?.refresh && state.mounted) void global.CloudflareCsvAnalyticsDashboard.refresh();
    if (!global.dispatchEvent || !global.CustomEvent) return;
    const base = global.CloudflareCsvAnalyticsDashboard?.getScope?.() || {};
    global.dispatchEvent(new global.CustomEvent('cloudflare-csv-analytics-scope-change', { detail: Object.freeze({ ...base, campaign: hierarchyFilters().campaignId || null, adGroup: hierarchyFilters().adGroupId || null, targeting: hierarchyFilters().targetingId || null, matchType: state.matchType || null, q: state.q }) }));
  }
  function buildRequestParams(input = {}) {
    const out = {};
    for (const key of ['startDate', 'endDate', 'campaignId', 'adGroupId', 'targetingId', 'matchType', 'marketplace', 'profileId', 'advertiserAccountId', 'q', 'sort', 'direction']) { const value = String(input[key] ?? '').trim(); if (value) out[key] = value; }
    for (const key of ['page', 'limit']) { const value = Number(input[key]); if (Number.isInteger(value) && value > 0) out[key] = value; }
    return Object.freeze(out);
  }
  function nextSelectionFromRow(row) { const level = String(row.dataset.cfddLevel || ''); const id = String(row.dataset.cfddId || '').trim(); const label = String(row.dataset.cfddLabel || '').trim(); if (!id || !LEVELS.includes(level) || level === 'search-term') return null; return Object.freeze({ level, id, label: label || id }); }

  function renderPath() {
    const node = state.root?.querySelector('[data-cfdd-path]'); if (!node) return;
    const chips = [`<button type="button" data-cfdd-depth="0" class="cfCsvDrilldownChip${state.path.length === 0 ? ' active' : ''}">All campaigns</button>`];
    state.path.forEach((item, index) => { chips.push('<span>→</span>'); chips.push(`<button type="button" data-cfdd-depth="${index + 1}" class="cfCsvDrilldownChip${index === state.path.length - 1 ? ' active' : ''}">${escapeHtml(levelLabel(item.level))}: ${escapeHtml(item.label)}</button>`); });
    if (state.matchType) { chips.push('<span>·</span>'); chips.push(`<span class="cfCsvDrilldownFilterChip">Match type: ${escapeHtml(state.matchType)}</span>`); }
    node.innerHTML = chips.join('');
  }
  function renderScope(overview, quality) {
    const node = state.root?.querySelector('[data-cfdd-scope]'); if (!node) return; if (!overview?.metrics) { node.innerHTML = ''; return; }
    const metrics = overview.metrics; const q = quality?.quality || {};
    node.innerHTML = `${scopeCard('Spend', moneyMicros(metrics.spendMicros), 'Scoped total, page-independent')}${scopeCard('Sales', moneyMicros(metrics.salesMicros), 'Scoped total, page-independent')}${scopeCard('Orders', formatInt(metrics.orders), 'Scoped total, page-independent')}${scopeCard('ACoS', percent(metrics.acos), 'Scoped ratio after aggregation')}${scopeCard('ROAS', ratio(metrics.roas), 'Scoped ratio after aggregation')}${scopeCard('Quality', q.qualityScore == null ? '—' : Number(q.qualityScore).toFixed(1), `${formatInt(q.issueCount)} issue types · reliability only`)}`;
  }
  function renderTable(payload) {
    const head = state.root?.querySelector('[data-cfdd-head]'); const body = state.root?.querySelector('[data-cfdd-body]'); if (!head || !body) return;
    const items = Array.isArray(payload?.items) ? payload.items : []; const columns = columnsFor(state.level);
    head.innerHTML = `<tr>${columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join('')}</tr>`;
    body.innerHTML = items.length ? items.map((item) => rowMarkup(item, columns)).join('') : `<tr><td colspan="${columns.length}" class="cfCsvDrilldownEmpty">No matching governed business facts.</td></tr>`;
    const paging = payload?.pagination || {}; const page = Number(paging.page || 1); const totalPages = Number(paging.totalPages || 0); state.page = page;
    const pageNode = state.root.querySelector('[data-cfdd-page]'); if (pageNode) pageNode.textContent = totalPages ? `Page ${page} / ${totalPages} · ${formatInt(paging.totalItems)} rows` : 'Page —';
    const prev = state.root.querySelector('[data-cfdd-prev]'); const next = state.root.querySelector('[data-cfdd-next]'); if (prev) prev.disabled = totalPages === 0 || page <= 1; if (next) next.disabled = totalPages === 0 || page >= totalPages;
  }
  function rowMarkup(item, columns) { const identity = drillIdentity(item, state.level); const drillable = Boolean(identity.id && state.level !== 'search-term'); return `<tr data-cfdd-drill data-cfdd-level="${escapeHtml(state.level)}" data-cfdd-id="${escapeHtml(identity.id || '')}" data-cfdd-label="${escapeHtml(identity.label || '')}" aria-disabled="${drillable ? 'false' : 'true'}" class="${drillable ? 'drillable' : ''}">${columns.map((column) => `<td>${cell(item, column)}</td>`).join('')}</tr>`; }
  function drillIdentity(item, level) { if (level === 'campaign') return { id: item?.campaignId || null, label: item?.campaignName || null }; if (level === 'ad-group') return { id: item?.adGroupId || null, label: item?.adGroupName || null }; if (level === 'targeting') return { id: item?.targetingId || null, label: item?.targeting || null }; return { id: null, label: item?.searchTerm || null }; }
  function columnsFor(level) {
    const metrics = [{ key: 'spendMicros', label: 'Spend', kind: 'money' }, { key: 'salesMicros', label: 'Sales', kind: 'money' }, { key: 'orders', label: 'Orders', kind: 'int' }, { key: 'acos', label: 'ACoS', kind: 'percent' }, { key: 'roas', label: 'ROAS', kind: 'ratio' }];
    if (level === 'campaign') return [{ key: 'campaignName', label: 'Campaign' }, { key: 'campaignId', label: 'Observed ID', kind: 'identity' }, ...metrics];
    if (level === 'ad-group') return [{ key: 'adGroupName', label: 'Ad Group' }, { key: 'adGroupId', label: 'Observed ID', kind: 'identity' }, { key: 'campaignName', label: 'Campaign' }, ...metrics];
    if (level === 'targeting') return [{ key: 'targeting', label: 'Targeting' }, { key: 'targetingId', label: 'Observed ID', kind: 'identity' }, { key: 'targetingType', label: 'Targeting type' }, ...metrics];
    return [{ key: 'searchTerm', label: 'Search Term' }, { key: 'matchType', label: 'Match type' }, { key: 'targeting', label: 'Targeting' }, ...metrics];
  }
  function cell(item, column) { const value = item?.[column.key]; if (column.kind === 'money') return escapeHtml(moneyMicros(value)); if (column.kind === 'int') return escapeHtml(formatInt(value)); if (column.kind === 'percent') return escapeHtml(percent(value)); if (column.kind === 'ratio') return escapeHtml(ratio(value)); if (column.kind === 'identity') return value ? `<span class="cfCsvDrilldownObservedId">${escapeHtml(value)}</span><small>observed · non-canonical</small>` : '<span class="cfCsvDrilldownBlocked">Unavailable · drill blocked</span>'; return escapeHtml(value == null || value === '' ? '—' : value); }
  function renderStatus(text, tone) { const node = state.root?.querySelector('[data-cfdd-status]'); if (!node) return; node.textContent = String(text || ''); node.dataset.tone = tone || ''; }
  function renderBusy(busy) { if (!state.root) return; state.root.setAttribute('aria-busy', busy ? 'true' : 'false'); const refreshButton = state.root.querySelector('[data-cfdd-refresh]'); if (refreshButton) refreshButton.setAttribute('aria-busy', busy ? 'true' : 'false'); }
  function scopeCard(label, value, note) { return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></div>`; }
  function matchTypeOptions() { return MATCH_TYPES.map((value) => `<option value="${value}">${value || 'All match types'}</option>`).join(''); }
  function sortOptions() { const labels = { spendMicros: 'Spend', salesMicros: 'Sales', clicks: 'Clicks', impressions: 'Impressions', purchases: 'Orders', acos: 'ACoS', roas: 'ROAS' }; return SORTS.map((value) => `<option value="${value}">${labels[value]}</option>`).join(''); }
  function levelLabel(level) { return ({ campaign: 'Campaign', 'ad-group': 'Ad Group', targeting: 'Targeting', 'search-term': 'Search Term' })[level] || 'Campaign'; }
  function formatInt(value) { return Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value)) : '—'; }
  function moneyMicros(value) { return Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value) / 1e6) : '—'; }
  function percent(value) { return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(2)}%` : '—'; }
  function ratio(value) { return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—'; }
  function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }

  function installStyles() {
    if (global.document.querySelector('#cfCsvAnalyticsDrilldownStyles')) return;
    const style = global.document.createElement('style'); style.id = 'cfCsvAnalyticsDrilldownStyles';
    style.textContent = `.cfCsvDrilldownCard{border:1px solid var(--line);border-radius:10px;background:var(--card);overflow:hidden}.cfCsvDrilldownHead{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:10px 11px;border-bottom:1px solid var(--line)}.cfCsvDrilldownHead>div{display:flex;flex-direction:column;gap:2px}.cfCsvDrilldownHead strong{font-size:12.5px}.cfCsvDrilldownHead span{font-size:10px;color:var(--muted)}.cfCsvDrilldownAuthority{padding:5px 8px;border-radius:7px;background:var(--softWarn);color:var(--warn)!important;font-weight:800}.cfCsvDrilldownControls{display:grid;grid-template-columns:repeat(6,minmax(110px,1fr));gap:7px;padding:9px 10px;background:var(--hover-bg);border-bottom:1px solid var(--line)}.cfCsvDrilldownControls label{display:flex;flex-direction:column;gap:3px;font-size:9.8px;font-weight:800;color:var(--muted)}.cfCsvDrilldownControls select,.cfCsvDrilldownControls input{min-height:34px;width:100%}.cfCsvDrilldownControls button{align-self:end;min-height:34px}.cfCsvDrilldownSearch{grid-column:span 2}.cfCsvDrilldownPath{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid var(--line)}.cfCsvDrilldownChip,.cfCsvDrilldownFilterChip{border:1px solid var(--line);border-radius:999px;background:var(--card);padding:5px 8px;font-size:9.8px;color:var(--muted)}button.cfCsvDrilldownChip{cursor:pointer}.cfCsvDrilldownChip.active{color:var(--accent);border-color:var(--accent)}.cfCsvDrilldownFilterChip{background:var(--softGood);color:var(--good);border-color:transparent}.cfCsvDrilldownStatus{margin:8px 10px 0;padding:7px 9px;border-radius:8px;background:var(--hover-bg);font-size:10.5px;color:var(--muted)}.cfCsvDrilldownStatus[data-tone="ok"]{background:var(--softGood);color:var(--good)}.cfCsvDrilldownStatus[data-tone="warn"]{background:var(--softWarn);color:var(--warn)}.cfCsvDrilldownStatus[data-tone="bad"]{background:var(--softBad);color:var(--bad)}.cfCsvDrilldownScope{display:grid;grid-template-columns:repeat(6,minmax(110px,1fr));gap:7px;padding:8px 10px}.cfCsvDrilldownScope>div{padding:8px;border:1px solid var(--line);border-radius:8px}.cfCsvDrilldownScope span,.cfCsvDrilldownScope small{display:block;color:var(--muted);font-size:9.2px}.cfCsvDrilldownScope strong{display:block;margin:3px 0;font-size:14px}.cfCsvDrilldownTableWrap{max-width:100%;overflow:auto;border-top:1px solid var(--line)}.cfCsvDrilldownTableWrap table{width:100%;min-width:900px;border-collapse:collapse}.cfCsvDrilldownTableWrap th,.cfCsvDrilldownTableWrap td{padding:8px 9px;border-bottom:1px solid var(--line);text-align:left;font-size:10.5px;white-space:nowrap}.cfCsvDrilldownTableWrap th{position:sticky;top:0;background:var(--th-bg);color:var(--muted);font-size:9.8px}.cfCsvDrilldownTableWrap tr.drillable{cursor:pointer}.cfCsvDrilldownTableWrap tr.drillable:hover{background:var(--hover-bg)}.cfCsvDrilldownObservedId{display:block}.cfCsvDrilldownTableWrap td small{display:block;color:var(--muted);font-size:8.8px}.cfCsvDrilldownBlocked{color:var(--warn);font-size:9.5px}.cfCsvDrilldownPager{display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:8px 10px;border-top:1px solid var(--line)}.cfCsvDrilldownPager span{font-size:10px;color:var(--muted)}.cfCsvDrilldownDiscipline{padding:8px 10px;background:var(--softWarn);color:var(--warn);font-size:9.6px;font-weight:700}.cfCsvDrilldownEmpty{text-align:center!important;color:var(--muted);height:90px}@media(max-width:1000px){.cfCsvDrilldownControls{grid-template-columns:repeat(3,minmax(0,1fr))}.cfCsvDrilldownScope{grid-template-columns:repeat(3,minmax(0,1fr))}}`;
    global.document.head.appendChild(style);
  }
})(typeof window !== 'undefined' ? window : globalThis);
