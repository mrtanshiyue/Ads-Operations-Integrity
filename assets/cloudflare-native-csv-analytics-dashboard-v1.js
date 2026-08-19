(function initCloudflareCsvAnalyticsDashboard(global) {
  'use strict';

  const VERSION = '1.0.0';
  const DEFAULT_DIMENSION = 'campaign';
  const TABLE_DIMENSIONS = Object.freeze(['campaign', 'ad-group', 'targeting', 'search-term', 'match-type']);
  const SORT_FIELDS = Object.freeze(['spendMicros', 'salesMicros', 'clicks', 'impressions', 'purchases', 'acos', 'roas']);
  const state = {
    mounted: false,
    loading: false,
    storeId: '',
    dimension: DEFAULT_DIMENSION,
    page: 1,
    limit: 25,
    sort: 'spendMicros',
    direction: 'desc',
    root: null,
    requestSeq: 0,
  };

  const publicApi = Object.freeze({
    version: VERSION,
    mount,
    refresh,
    loadSnapshot,
    metricContract: Object.freeze(['impressions', 'clicks', 'spendMicros', 'purchases', 'orders', 'unitsSold', 'salesMicros', 'ctr', 'cpcMicros', 'cvr', 'acos', 'roas']),
  });

  Object.defineProperty(global, 'CloudflareCsvAnalyticsDashboard', {
    value: publicApi,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  if (!global.document) return;
  if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();

  global.addEventListener?.('cloudflare-operator-store-change', (event) => {
    const storeId = String(event?.detail?.storeId || '').trim();
    if (!storeId) return;
    state.storeId = storeId;
    state.page = 1;
    updateStoreLabel();
    void refresh();
  });

  function api() {
    if (!global.CloudflareNativeAPI?.csvAnalytics) throw new Error('csv_analytics_native_api_not_ready');
    return global.CloudflareNativeAPI;
  }

  async function loadSnapshot(options = {}) {
    const storeId = String(options.storeId || '').trim();
    const startDate = String(options.startDate || '').trim();
    const endDate = String(options.endDate || '').trim();
    const dimension = TABLE_DIMENSIONS.includes(options.dimension) ? options.dimension : DEFAULT_DIMENSION;
    const sort = SORT_FIELDS.includes(options.sort) ? options.sort : 'spendMicros';
    const direction = options.direction === 'asc' ? 'asc' : 'desc';
    const page = positiveInt(options.page, 1);
    const limit = clamp(positiveInt(options.limit, 25), 1, 200);
    const q = String(options.q || '').trim().slice(0, 200);
    if (!storeId || !startDate || !endDate) throw new Error('csv_analytics_scope_required');

    const common = { startDate, endDate };
    const tableParams = { ...common, page, limit, sort, direction, q };
    const [overview, daily, table] = await Promise.all([
      api().csvAnalytics(storeId, 'overview', common),
      api().csvAnalytics(storeId, 'daily', { ...common, page: 1, limit: 366, sort: 'reportDate', direction: 'asc' }),
      api().csvAnalytics(storeId, dimension, tableParams),
    ]);
    return { overview, daily, table };
  }

  function mount() {
    if (state.mounted || !global.document?.body) return;
    const content = global.document.querySelector('.content');
    if (!content) return;
    state.mounted = true;
    state.storeId = String(global.CloudflareOperatorWorkspace?.currentStoreId?.() || '').trim();
    installStyles();

    const range = defaultRange();
    const root = global.document.createElement('section');
    root.id = 'cfCsvAnalyticsDashboard';
    root.className = 'card cfCsvAnalyticsDashboard';
    root.setAttribute('aria-label', 'CSV Analytics Dashboard');
    root.innerHTML = `
      <div class="cfCsvAnalyticsHead">
        <div>
          <div class="cfCsvAnalyticsEyebrow">CSV · LOCAL DATA · READ ONLY</div>
          <h2>CSV Analytics</h2>
          <p>Business-class imports only. Observed IDs never imply canonical Amazon identity.</p>
        </div>
        <div class="cfCsvAnalyticsHeadBadges">
          <span class="cfCsvAnalyticsBadge" data-kind="safe">Read only</span>
          <span class="cfCsvAnalyticsBadge">Amazon execution disabled</span>
        </div>
      </div>
      <div class="cfCsvAnalyticsControls" role="group" aria-label="CSV analytics filters">
        <label>Store <span id="cfCsvAnalyticsStore">${escapeHtml(state.storeId || '—')}</span></label>
        <label>Start <input id="cfCsvAnalyticsStart" type="date" value="${range.startDate}"></label>
        <label>End <input id="cfCsvAnalyticsEnd" type="date" value="${range.endDate}"></label>
        <label>View <select id="cfCsvAnalyticsDimension">${dimensionOptions()}</select></label>
        <label>Sort <select id="cfCsvAnalyticsSort">${sortOptions()}</select></label>
        <label>Order <select id="cfCsvAnalyticsDirection"><option value="desc">Desc</option><option value="asc">Asc</option></select></label>
        <label class="cfCsvAnalyticsSearch">Filter <input id="cfCsvAnalyticsQuery" type="search" maxlength="200" placeholder="Campaign / ad group / targeting / search term"></label>
        <button id="cfCsvAnalyticsRun" class="btn primary" type="button">Load analytics</button>
      </div>
      <div id="cfCsvAnalyticsStatus" class="cfCsvAnalyticsStatus" role="status" aria-live="polite">Select a business-data period to load governed analytics.</div>
      <div id="cfCsvAnalyticsGovernance" class="cfCsvAnalyticsGovernance"></div>
      <div id="cfCsvAnalyticsKpis" class="cfCsvAnalyticsKpis"></div>
      <div class="cfCsvAnalyticsTrendCard">
        <div class="cfCsvAnalyticsSectionHead"><strong>Daily trend</strong><span>Spend vs sales</span></div>
        <div id="cfCsvAnalyticsTrend" class="cfCsvAnalyticsTrend"></div>
      </div>
      <div class="cfCsvAnalyticsTableCard">
        <div class="cfCsvAnalyticsSectionHead"><strong id="cfCsvAnalyticsTableTitle">Campaign</strong><span id="cfCsvAnalyticsCount">—</span></div>
        <div class="cfCsvAnalyticsTableWrap"><table><thead id="cfCsvAnalyticsThead"></thead><tbody id="cfCsvAnalyticsTbody"></tbody></table></div>
        <div class="cfCsvAnalyticsPager">
          <button class="btn" id="cfCsvAnalyticsPrev" type="button">Previous</button>
          <span id="cfCsvAnalyticsPage">Page —</span>
          <button class="btn" id="cfCsvAnalyticsNext" type="button">Next</button>
        </div>
      </div>`;
    state.root = root;

    const header = content.querySelector('.header');
    if (header?.nextSibling) content.insertBefore(root, header.nextSibling);
    else content.prepend(root);

    root.querySelector('#cfCsvAnalyticsRun')?.addEventListener('click', () => { state.page = 1; void refresh(); });
    root.querySelector('#cfCsvAnalyticsDimension')?.addEventListener('change', (event) => {
      state.dimension = TABLE_DIMENSIONS.includes(event.target.value) ? event.target.value : DEFAULT_DIMENSION;
      state.page = 1;
      void refresh();
    });
    root.querySelector('#cfCsvAnalyticsSort')?.addEventListener('change', (event) => {
      state.sort = SORT_FIELDS.includes(event.target.value) ? event.target.value : 'spendMicros';
      state.page = 1;
      void refresh();
    });
    root.querySelector('#cfCsvAnalyticsDirection')?.addEventListener('change', (event) => {
      state.direction = event.target.value === 'asc' ? 'asc' : 'desc';
      state.page = 1;
      void refresh();
    });
    root.querySelector('#cfCsvAnalyticsQuery')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); state.page = 1; void refresh(); }
    });
    root.querySelector('#cfCsvAnalyticsPrev')?.addEventListener('click', () => {
      if (state.page <= 1) return;
      state.page -= 1;
      void refresh();
    });
    root.querySelector('#cfCsvAnalyticsNext')?.addEventListener('click', () => {
      state.page += 1;
      void refresh();
    });
  }

  async function refresh() {
    if (!state.root || state.loading) return;
    const storeId = String(state.storeId || global.CloudflareOperatorWorkspace?.currentStoreId?.() || '').trim();
    const startDate = String(state.root.querySelector('#cfCsvAnalyticsStart')?.value || '').trim();
    const endDate = String(state.root.querySelector('#cfCsvAnalyticsEnd')?.value || '').trim();
    const q = String(state.root.querySelector('#cfCsvAnalyticsQuery')?.value || '').trim();
    state.dimension = String(state.root.querySelector('#cfCsvAnalyticsDimension')?.value || state.dimension);
    state.sort = String(state.root.querySelector('#cfCsvAnalyticsSort')?.value || state.sort);
    state.direction = String(state.root.querySelector('#cfCsvAnalyticsDirection')?.value || state.direction) === 'asc' ? 'asc' : 'desc';
    state.storeId = storeId;
    updateStoreLabel();
    if (!storeId) return setStatus('No store context is available.', 'warn');
    if (!startDate || !endDate) return setStatus('Start and end dates are required.', 'warn');

    const seq = ++state.requestSeq;
    state.loading = true;
    setBusy(true);
    setStatus('Loading governed business CSV analytics…', 'loading');
    try {
      const snapshot = await loadSnapshot({
        storeId,
        startDate,
        endDate,
        dimension: state.dimension,
        sort: state.sort,
        direction: state.direction,
        page: state.page,
        limit: state.limit,
        q,
      });
      if (seq !== state.requestSeq) return;
      renderGovernance(snapshot.overview?.governance);
      renderKpis(snapshot.overview?.metrics, snapshot.overview?.comparison);
      renderTrend(snapshot.daily?.items || []);
      renderTable(snapshot.table);
      const governance = snapshot.overview?.governance;
      if (!governance?.analyticsEligible) setStatus('No business-class CSV facts matched this period. Nothing was treated as zero performance.', 'warn');
      else if (!governance?.recommendationEligible) setStatus('Analytics ready. Recommendation/review remain blocked by provenance authority.', 'ok');
      else setStatus('Analytics ready. Governed provenance is present; this dashboard remains read only.', 'ok');
    } catch (error) {
      if (seq !== state.requestSeq) return;
      renderEmpty();
      setStatus(`Analytics unavailable: ${error?.code || error?.message || 'request_failed'}`, 'bad');
    } finally {
      if (seq === state.requestSeq) {
        state.loading = false;
        setBusy(false);
      }
    }
  }

  function renderGovernance(governance) {
    const node = state.root?.querySelector('#cfCsvAnalyticsGovernance');
    if (!node) return;
    if (!governance) { node.innerHTML = ''; return; }
    const provenance = Array.isArray(governance.provenanceClasses) ? governance.provenanceClasses.join(', ') : '—';
    const imports = Array.isArray(governance.includedImportIds) ? governance.includedImportIds.length : 0;
    node.innerHTML = `
      ${govBadge(`Data class · ${governance.dataClass || '—'}`, governance.analyticsEligible ? 'safe' : 'warn')}
      ${govBadge(`Provenance · ${provenance}`, governance.recommendationEligible ? 'safe' : 'warn')}
      ${govBadge(`Facts · ${formatInt(governance.factCount)}`, 'neutral')}
      ${govBadge(`Imports · ${imports}`, 'neutral')}
      ${govBadge(`Analytics · ${governance.analyticsEligible ? 'allowed' : 'blocked'}`, governance.analyticsEligible ? 'safe' : 'warn')}
      ${govBadge(`Recommendation · ${governance.recommendationEligible ? 'allowed' : 'blocked'}`, governance.recommendationEligible ? 'safe' : 'warn')}`;
  }

  function renderKpis(metrics, comparison) {
    const node = state.root?.querySelector('#cfCsvAnalyticsKpis');
    if (!node) return;
    const m = metrics || {};
    const cards = [
      ['Spend', moneyMicros(m.spendMicros), deltaFor(comparison, 'spendMicros')],
      ['Sales', moneyMicros(m.salesMicros), deltaFor(comparison, 'salesMicros')],
      ['Orders', formatInt(m.orders), deltaFor(comparison, 'orders')],
      ['ROAS', ratioNumber(m.roas), deltaFor(comparison, 'roas')],
      ['ACoS', percent(m.acos), deltaFor(comparison, 'acos')],
      ['CTR', percent(m.ctr), deltaFor(comparison, 'ctr')],
      ['Clicks', formatInt(m.clicks), deltaFor(comparison, 'clicks')],
      ['CVR', percent(m.cvr), deltaFor(comparison, 'cvr')],
    ];
    node.innerHTML = cards.map(([label, value, delta]) => `<div class="cfCsvAnalyticsKpi"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(delta)}</small></div>`).join('');
  }

  function renderTrend(items) {
    const node = state.root?.querySelector('#cfCsvAnalyticsTrend');
    if (!node) return;
    if (!Array.isArray(items) || items.length === 0) {
      node.innerHTML = '<div class="cfCsvAnalyticsEmpty">No daily business facts in selected period.</div>';
      return;
    }
    const width = 960;
    const height = 190;
    const pad = 18;
    const maxValue = Math.max(1, ...items.flatMap((row) => [Number(row.salesMicros || 0), Number(row.spendMicros || 0)]));
    const points = (field) => items.map((row, index) => {
      const x = items.length === 1 ? width / 2 : pad + (index * (width - pad * 2)) / (items.length - 1);
      const y = height - pad - (Number(row[field] || 0) / maxValue) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    node.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily spend and sales trend" preserveAspectRatio="none">
      <polyline class="cfCsvAnalyticsLine cfCsvAnalyticsSales" points="${points('salesMicros')}"></polyline>
      <polyline class="cfCsvAnalyticsLine cfCsvAnalyticsSpend" points="${points('spendMicros')}"></polyline>
    </svg><div class="cfCsvAnalyticsLegend"><span><i data-kind="sales"></i>Sales</span><span><i data-kind="spend"></i>Spend</span><span>${escapeHtml(items[0]?.reportDate || '')} → ${escapeHtml(items.at(-1)?.reportDate || '')}</span></div>`;
  }

  function renderTable(payload) {
    const thead = state.root?.querySelector('#cfCsvAnalyticsThead');
    const tbody = state.root?.querySelector('#cfCsvAnalyticsTbody');
    if (!thead || !tbody) return;
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const columns = columnsFor(state.dimension);
    state.root.querySelector('#cfCsvAnalyticsTableTitle').textContent = titleFor(state.dimension);
    thead.innerHTML = `<tr>${columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join('')}</tr>`;
    tbody.innerHTML = items.length
      ? items.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(cellValue(row, column))}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${columns.length}" class="cfCsvAnalyticsEmpty">No matching business facts.</td></tr>`;
    const paging = payload?.pagination || {};
    const totalItems = Number(paging.totalItems || 0);
    const totalPages = Number(paging.totalPages || 0);
    state.root.querySelector('#cfCsvAnalyticsCount').textContent = `${formatInt(totalItems)} rows`;
    state.root.querySelector('#cfCsvAnalyticsPage').textContent = totalPages ? `Page ${paging.page} / ${totalPages}` : 'Page —';
    const prev = state.root.querySelector('#cfCsvAnalyticsPrev');
    const next = state.root.querySelector('#cfCsvAnalyticsNext');
    if (prev) prev.disabled = !totalPages || Number(paging.page || 1) <= 1;
    if (next) next.disabled = !totalPages || Number(paging.page || 1) >= totalPages;
  }

  function renderEmpty() {
    renderGovernance(null);
    renderKpis({}, null);
    renderTrend([]);
    renderTable({ items: [], pagination: { totalItems: 0, totalPages: 0, page: 1 } });
  }

  function columnsFor(dimension) {
    const metrics = [
      { key: 'impressions', label: 'Impressions', kind: 'int' },
      { key: 'clicks', label: 'Clicks', kind: 'int' },
      { key: 'spendMicros', label: 'Spend', kind: 'money' },
      { key: 'salesMicros', label: 'Sales', kind: 'money' },
      { key: 'orders', label: 'Orders', kind: 'int' },
      { key: 'acos', label: 'ACoS', kind: 'percent' },
      { key: 'roas', label: 'ROAS', kind: 'ratio' },
    ];
    if (dimension === 'campaign') return [{ key: 'campaignName', label: 'Campaign' }, { key: 'campaignId', label: 'Observed campaign ID' }, ...metrics];
    if (dimension === 'ad-group') return [{ key: 'campaignName', label: 'Campaign' }, { key: 'adGroupName', label: 'Ad group' }, { key: 'adGroupId', label: 'Observed ad group ID' }, ...metrics];
    if (dimension === 'targeting') return [{ key: 'campaignName', label: 'Campaign' }, { key: 'adGroupName', label: 'Ad group' }, { key: 'targeting', label: 'Targeting' }, { key: 'targetingId', label: 'Observed targeting ID' }, ...metrics];
    if (dimension === 'search-term') return [{ key: 'searchTerm', label: 'Search term' }, { key: 'matchType', label: 'Match type' }, { key: 'campaignName', label: 'Campaign' }, ...metrics];
    return [{ key: 'matchType', label: 'Match type' }, ...metrics];
  }

  function cellValue(row, column) {
    const value = row?.[column.key];
    if (column.kind === 'int') return formatInt(value);
    if (column.kind === 'money') return moneyMicros(value);
    if (column.kind === 'percent') return percent(value);
    if (column.kind === 'ratio') return ratioNumber(value);
    return value === null || value === undefined || value === '' ? '—' : String(value);
  }

  function deltaFor(comparison, field) {
    if (!comparison?.available) return 'Comparable period unavailable';
    const relative = comparison?.delta?.[field]?.relative;
    if (relative === null || relative === undefined || !Number.isFinite(Number(relative))) return 'Δ unavailable';
    const numeric = Number(relative);
    return `${numeric >= 0 ? '+' : ''}${(numeric * 100).toFixed(1)}% vs prior period`;
  }

  function setStatus(message, tone) {
    const node = state.root?.querySelector('#cfCsvAnalyticsStatus');
    if (!node) return;
    node.textContent = String(message || '');
    node.dataset.tone = tone || '';
  }

  function setBusy(busy) {
    state.root?.setAttribute('aria-busy', busy ? 'true' : 'false');
    const button = state.root?.querySelector('#cfCsvAnalyticsRun');
    if (button) button.disabled = Boolean(busy);
  }

  function updateStoreLabel() {
    const node = state.root?.querySelector('#cfCsvAnalyticsStore');
    if (node) node.textContent = state.storeId || '—';
  }

  function defaultRange() {
    const end = new Date();
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
    start.setUTCDate(start.getUTCDate() - 29);
    return { startDate: isoDate(start), endDate: isoDate(end) };
  }

  function dimensionOptions() {
    return TABLE_DIMENSIONS.map((value) => `<option value="${value}"${value === DEFAULT_DIMENSION ? ' selected' : ''}>${escapeHtml(titleFor(value))}</option>`).join('');
  }

  function sortOptions() {
    const labels = { spendMicros: 'Spend', salesMicros: 'Sales', clicks: 'Clicks', impressions: 'Impressions', purchases: 'Orders', acos: 'ACoS', roas: 'ROAS' };
    return SORT_FIELDS.map((value) => `<option value="${value}"${value === 'spendMicros' ? ' selected' : ''}>${labels[value]}</option>`).join('');
  }

  function titleFor(value) {
    return ({ campaign: 'Campaign', 'ad-group': 'Ad group', targeting: 'Targeting', 'search-term': 'Search term', 'match-type': 'Match type' })[value] || 'Campaign';
  }

  function govBadge(text, kind) { return `<span class="cfCsvAnalyticsGovBadge" data-kind="${kind}">${escapeHtml(text)}</span>`; }
  function formatInt(value) { return Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value)) : '—'; }
  function moneyMicros(value) { return Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value) / 1e6) : '—'; }
  function percent(value) { return Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(2)}%` : '—'; }
  function ratioNumber(value) { return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—'; }
  function positiveInt(value, fallback) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : fallback; }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function isoDate(value) { return new Date(value).toISOString().slice(0, 10); }
  function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }

  function installStyles() {
    if (global.document?.querySelector('#cfCsvAnalyticsDashboardStyles')) return;
    const style = global.document.createElement('style');
    style.id = 'cfCsvAnalyticsDashboardStyles';
    style.textContent = `
      .cfCsvAnalyticsDashboard{display:flex;flex-direction:column;gap:12px;border-left:3px solid var(--accent)!important}
      .cfCsvAnalyticsHead{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.cfCsvAnalyticsHead h2{margin:2px 0 4px;font-size:18px}.cfCsvAnalyticsHead p{margin:0;color:var(--muted);font-size:11.5px}.cfCsvAnalyticsEyebrow{font-size:9.6px;font-weight:900;letter-spacing:.09em;color:var(--accent)}
      .cfCsvAnalyticsHeadBadges,.cfCsvAnalyticsGovernance{display:flex;gap:6px;flex-wrap:wrap}.cfCsvAnalyticsBadge,.cfCsvAnalyticsGovBadge{display:inline-flex;align-items:center;min-height:25px;padding:4px 7px;border:1px solid var(--line);border-radius:7px;background:var(--hover-bg);font-size:10px;font-weight:800;color:var(--muted)}.cfCsvAnalyticsBadge[data-kind="safe"],.cfCsvAnalyticsGovBadge[data-kind="safe"]{color:var(--good);background:var(--softGood);border-color:transparent}.cfCsvAnalyticsGovBadge[data-kind="warn"]{color:var(--warn);background:var(--softWarn);border-color:transparent}
      .cfCsvAnalyticsControls{display:grid;grid-template-columns:repeat(6,minmax(110px,1fr));gap:8px;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--hover-bg)}.cfCsvAnalyticsControls label{display:flex;flex-direction:column;gap:4px;font-size:10px;color:var(--muted);font-weight:800}.cfCsvAnalyticsControls input,.cfCsvAnalyticsControls select{width:100%;min-height:34px}.cfCsvAnalyticsControls button{align-self:end;justify-content:center;min-height:34px}.cfCsvAnalyticsSearch{grid-column:span 3}
      .cfCsvAnalyticsStatus{padding:8px 10px;border-radius:8px;background:var(--hover-bg);border:1px solid var(--line);font-size:10.8px;color:var(--muted)}.cfCsvAnalyticsStatus[data-tone="ok"]{color:var(--good);background:var(--softGood);border-color:transparent}.cfCsvAnalyticsStatus[data-tone="warn"]{color:var(--warn);background:var(--softWarn);border-color:transparent}.cfCsvAnalyticsStatus[data-tone="bad"]{color:var(--bad);background:var(--softBad);border-color:transparent}
      .cfCsvAnalyticsKpis{display:grid;grid-template-columns:repeat(8,minmax(105px,1fr));gap:8px}.cfCsvAnalyticsKpi{min-width:0;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--card)}.cfCsvAnalyticsKpi span{display:block;color:var(--muted);font-size:9.8px;font-weight:800}.cfCsvAnalyticsKpi strong{display:block;margin:5px 0 3px;font-size:16px;letter-spacing:-.2px}.cfCsvAnalyticsKpi small{display:block;min-height:14px;color:var(--muted);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .cfCsvAnalyticsTrendCard,.cfCsvAnalyticsTableCard{border:1px solid var(--line);border-radius:10px;background:var(--card);overflow:hidden}.cfCsvAnalyticsSectionHead{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 11px;border-bottom:1px solid var(--line);font-size:10.5px;color:var(--muted)}.cfCsvAnalyticsSectionHead strong{color:var(--text);font-size:12px}.cfCsvAnalyticsTrend{height:210px;padding:10px}.cfCsvAnalyticsTrend svg{display:block;width:100%;height:170px}.cfCsvAnalyticsLine{fill:none;stroke-width:3;vector-effect:non-scaling-stroke}.cfCsvAnalyticsSales{stroke:var(--good)}.cfCsvAnalyticsSpend{stroke:var(--accent)}.cfCsvAnalyticsLegend{display:flex;align-items:center;gap:14px;color:var(--muted);font-size:9.7px}.cfCsvAnalyticsLegend span{display:inline-flex;align-items:center;gap:5px}.cfCsvAnalyticsLegend i{width:9px;height:3px;border-radius:3px;background:var(--accent)}.cfCsvAnalyticsLegend i[data-kind="sales"]{background:var(--good)}
      .cfCsvAnalyticsTableWrap{max-width:100%;overflow:auto}.cfCsvAnalyticsTableWrap table{min-width:980px;width:100%;border-collapse:collapse}.cfCsvAnalyticsTableWrap th,.cfCsvAnalyticsTableWrap td{padding:8px 9px;text-align:left;border-bottom:1px solid var(--line);font-size:10.7px;white-space:nowrap}.cfCsvAnalyticsTableWrap th{position:sticky;top:0;background:var(--th-bg);color:var(--muted);font-size:9.8px}.cfCsvAnalyticsPager{display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:9px 10px}.cfCsvAnalyticsPager span{font-size:10.2px;color:var(--muted)}.cfCsvAnalyticsEmpty{display:grid;place-items:center;min-height:120px;color:var(--muted);font-size:10.8px}
      @media (max-width:1400px){.cfCsvAnalyticsKpis{grid-template-columns:repeat(4,minmax(120px,1fr))}.cfCsvAnalyticsControls{grid-template-columns:repeat(4,minmax(120px,1fr))}.cfCsvAnalyticsSearch{grid-column:span 2}}
      @media (max-width:800px){.cfCsvAnalyticsHead{flex-direction:column}.cfCsvAnalyticsKpis{grid-template-columns:repeat(2,minmax(0,1fr))}.cfCsvAnalyticsControls{grid-template-columns:repeat(2,minmax(0,1fr))}.cfCsvAnalyticsSearch{grid-column:span 2}}
    `;
    global.document.head.appendChild(style);
  }
})(typeof window !== 'undefined' ? window : globalThis);
