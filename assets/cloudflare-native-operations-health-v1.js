(function initCloudflareNativeOperationsHealth(global) {
  'use strict';

  const VERSION = '1.1.0';
  const AUDIT_LIMIT = 20;
  const ATTENTION = Object.freeze({
    FAILURE: 1,
    FRESHNESS: 2,
    MAPPING: 3,
    HEALTHY: 4,
  });

  function api() {
    if (!global.CloudflareNativeAPI) {
      const error = new Error('cloudflare_native_api_not_ready');
      error.code = 'cloudflare_native_api_not_ready';
      throw error;
    }
    return global.CloudflareNativeAPI;
  }

  function dataHealth(storeId) {
    const id = String(storeId || '').trim();
    if (!id) return reject('store_id_required');
    return api().analyticsDataHealth({ storeId: id });
  }

  function auditEvents(storeId, params = {}) {
    const id = String(storeId || '').trim();
    if (!id) return reject('store_id_required');
    return api().auditEvents({ limit: AUDIT_LIMIT, storeId: id, ...params });
  }

  function listStores() {
    return api().stores();
  }

  function capabilities() {
    return api().capabilities();
  }

  function classifyStoreHealth(store, failures = [], loadError = null) {
    const sync = store?.sync || {};
    const rollups = Array.isArray(store?.rollups) ? store.rollups : [];
    const relevantFailures = Array.isArray(failures) ? failures : [];
    const mapping = rollups.reduce((totals, row) => {
      totals.unmapped += safeCount(row?.unmappedRows);
      totals.ambiguous += safeCount(row?.ambiguousRows);
      return totals;
    }, { unmapped: 0, ambiguous: 0 });

    if (loadError) {
      return attention(ATTENTION.FAILURE, 'evidence_gap', 'P1 Evidence gap',
        `Health read failed: ${errorText(loadError)}`, mapping);
    }

    if (relevantFailures.length) {
      const first = relevantFailures[0] || {};
      const detail = [first.rollupType, first.partitionKey, first.errorCode].filter(Boolean).join(' · ');
      return attention(ATTENTION.FAILURE, 'health_failure', 'P1 Health failure',
        detail ? `Recent rollup failure: ${detail}` : 'Recent rollup failure reported', mapping);
    }

    const syncStatus = String(sync.status || '').trim().toLowerCase();
    if (['failed', 'error', 'blocked'].includes(syncStatus)) {
      return attention(ATTENTION.FAILURE, 'health_failure', 'P1 Health failure',
        `Sync status: ${syncStatus}${sync.lastErrorCode ? ` · ${sync.lastErrorCode}` : ''}`, mapping);
    }

    const lastSuccessMs = timestampMs(sync.lastSuccessAt);
    const lastErrorMs = timestampMs(sync.lastErrorAt);
    if (lastErrorMs && (!lastSuccessMs || lastErrorMs > lastSuccessMs)) {
      return attention(ATTENTION.FAILURE, 'health_failure', 'P1 Health failure',
        `Latest sync evidence is an error${sync.lastErrorCode ? ` · ${sync.lastErrorCode}` : ''}`, mapping);
    }

    if (!hasFreshnessEvidence(sync, rollups)) {
      return attention(ATTENTION.FAILURE, 'evidence_gap', 'P1 Evidence gap',
        'No sync or rollup freshness evidence is available', mapping);
    }

    const lag = nullableFinite(sync.lagMinutes);
    if (lag !== null && lag > 0) {
      return attention(ATTENTION.FRESHNESS, 'freshness_attention', 'P2 Freshness',
        `Reported data lag: ${formatNumber(lag)} min`, mapping);
    }

    if (mapping.unmapped > 0 || mapping.ambiguous > 0) {
      return attention(ATTENTION.MAPPING, 'mapping_anomaly', 'P3 Mapping',
        `Unresolved mapping: ${mapping.unmapped} unmapped · ${mapping.ambiguous} ambiguous`, mapping);
    }

    return attention(ATTENTION.HEALTHY, 'healthy', 'P4 Healthy',
      'No failure, reported lag, or mapping anomaly in the authoritative health read model', mapping);
  }

  function rankStoreHealthRows(rows) {
    return (Array.isArray(rows) ? rows : []).slice().sort((left, right) => {
      const priorityDelta = safeCount(left?.priority) - safeCount(right?.priority);
      if (priorityDelta) return priorityDelta;
      const orderDelta = safeCount(left?.storeOrder) - safeCount(right?.storeOrder);
      if (orderDelta) return orderDelta;
      return String(left?.storeCode || left?.storeId || '').localeCompare(String(right?.storeCode || right?.storeId || ''));
    });
  }

  function buildCommandRow(storeMeta, payload, loadError = null, storeOrder = 0) {
    const payloadStores = Array.isArray(payload?.stores) ? payload.stores : [];
    const store = payloadStores.find((row) => String(row?.storeId || '') === String(storeMeta?.storeId || ''))
      || payloadStores[0]
      || null;
    const failures = (Array.isArray(payload?.recentRollupFailures) ? payload.recentRollupFailures : [])
      .filter((row) => !row?.storeId || String(row.storeId) === String(storeMeta?.storeId || ''));
    const classification = classifyStoreHealth(store, failures, loadError || (!store ? new Error('health_store_missing') : null));
    const sync = store?.sync || {};
    const rollups = Array.isArray(store?.rollups) ? store.rollups : [];
    return {
      ...classification,
      storeId: String(storeMeta?.storeId || store?.storeId || ''),
      storeCode: String(storeMeta?.storeCode || store?.storeCode || ''),
      displayName: String(storeMeta?.displayName || store?.displayName || ''),
      marketplaceCode: String(storeMeta?.marketplaceCode || ''),
      storeOrder,
      syncStatus: String(sync.status || 'unknown'),
      lagMinutes: nullableFinite(sync.lagMinutes),
      lastSuccessAt: sync.lastSuccessAt || null,
      evidenceAt: latestEvidenceAt(sync, rollups, payload?.generatedAt),
      failureCount: failures.length,
      readError: loadError ? errorText(loadError) : null,
    };
  }

  function attention(priority, key, label, reason, mapping) {
    return Object.freeze({
      priority,
      attentionKey: key,
      label,
      reason,
      unmappedRows: safeCount(mapping?.unmapped),
      ambiguousRows: safeCount(mapping?.ambiguous),
    });
  }

  function hasFreshnessEvidence(sync, rollups) {
    if (sync?.lastSuccessAt || sync?.updatedAt) return true;
    return (Array.isArray(rollups) ? rollups : []).some((row) =>
      row?.lastSuccessDate || row?.lastSuccessAsOfDate || row?.updatedAt);
  }

  function latestEvidenceAt(sync, rollups, generatedAt) {
    const candidates = [
      sync?.lastSuccessAt,
      sync?.updatedAt,
      ...(Array.isArray(rollups) ? rollups.flatMap((row) => [
        row?.lastSuccessAsOfDate,
        row?.lastSuccessDate,
        row?.updatedAt,
      ]) : []),
    ].filter(Boolean);
    if (!candidates.length) return generatedAt || null;
    return candidates.slice().sort((a, b) => timestampMs(b) - timestampMs(a))[0] || generatedAt || null;
  }

  function timestampMs(value) {
    if (!value) return 0;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function nullableFinite(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function safeCount(value) {
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function formatNumber(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return '—';
    return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(1);
  }

  const publicApi = Object.freeze({
    version: VERSION,
    dataHealth,
    auditEvents,
    listStores,
    capabilities,
    classifyStoreHealth,
    rankStoreHealthRows,
    buildCommandRow,
    mount,
    open,
  });

  Object.defineProperty(global, 'CloudflareOperationsHealth', {
    value: publicApi,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  const state = {
    mounted: false,
    open: false,
    loading: false,
    stores: [],
    storeId: '',
    capabilities: null,
    requestSerial: 0,
    health: null,
    healthByStore: Object.create(null),
    overview: [],
    overviewGeneratedAt: '',
    audits: [],
  };

  if (!global.document) return;
  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }

  function mount() {
    if (state.mounted || !global.document?.body) return;
    const host = global.document.querySelector('.bidGovHeaderActions')
      || global.document.querySelector('.header .actions');
    if (!host) return;

    state.mounted = true;
    installStyles();

    const button = global.document.createElement('button');
    button.id = 'btnNativeOperationsHealth';
    button.type = 'button';
    button.className = 'btn';
    button.textContent = '运营总览';
    button.title = '查看 Four-Store Command Board、数据健康、rollup 水位和最近审计事件';
    button.style.display = 'none';
    button.addEventListener('click', open);
    host.insertBefore(button, host.firstChild);

    const modal = global.document.createElement('div');
    modal.id = 'nativeOperationsHealthModal';
    modal.className = 'modalOverlay cfOpsHealthOverlay';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'nativeOperationsHealthTitle');
    modal.innerHTML = `
      <div class="largeModal cfOpsHealthModal">
        <div class="largeModalHeader cfOpsHealthHeader">
          <div>
            <div class="cfOpsHealthEyebrow">PRODUCTIZATION · EXECUTIVE OPERATIONS · READ ONLY</div>
            <h2 id="nativeOperationsHealthTitle">Four-Store Command Board</h2>
            <div class="small">跨店只读聚合现有 server-authoritative health evidence，按明确证据排序处理优先级；不生成置信度、财务影响或执行建议。</div>
          </div>
          <div class="cfOpsHealthHeaderActions">
            <span id="cfOpsHealthAccess" class="cfOpsHealthAccess">只读</span>
            <button id="btnCfOpsHealthRefresh" class="btn" type="button">刷新全部</button>
            <button id="btnCfOpsHealthClose" class="btn" type="button">关闭</button>
          </div>
        </div>
        <div class="largeModalBody cfOpsHealthBody">
          <section class="cfOpsHealthSection cfOpsHealthOverview" aria-labelledby="cfOpsHealthOverviewHeading">
            <div class="cfOpsHealthSectionHead">
              <div><div class="cfOpsHealthKicker">ATTENTION ORDER</div><h3 id="cfOpsHealthOverviewHeading">跨店处理顺序</h3></div>
              <span class="small" id="cfOpsHealthOverviewGenerated">尚未读取</span>
            </div>
            <div class="cfOpsHealthSummary" id="cfOpsHealthSummary"></div>
            <div class="table-container cfOpsHealthTableWrap cfOpsHealthOverviewWrap">
              <table class="cfOpsHealthTable">
                <thead><tr><th>Priority</th><th>Store</th><th>Why</th><th>Lag</th><th>Mapping</th><th>Last success</th><th>Action</th></tr></thead>
                <tbody id="cfOpsHealthOverviewRows"></tbody>
              </table>
            </div>
            <div class="small cfOpsHealthRule">Deterministic order: health failure / evidence gap → reported lag → unresolved mapping → healthy. Evidence gap is fail-closed and is never presented as healthy.</div>
          </section>

          <div class="cfOpsHealthControls">
            <label>当前检查店铺<select id="cfOpsHealthStore"></select></label>
            <div class="small cfOpsHealthGenerated" id="cfOpsHealthGenerated">尚未读取</div>
          </div>

          <div id="cfOpsHealthStatus" class="cfOpsHealthStatus" aria-live="polite"></div>

          <section class="cfOpsHealthSection" aria-labelledby="cfOpsHealthSyncHeading">
            <div class="cfOpsHealthSectionHead">
              <div><div class="cfOpsHealthKicker">STORE HEALTH</div><h3 id="cfOpsHealthSyncHeading">同步与数据健康</h3></div>
              <span class="cfOpsHealthPill" id="cfOpsHealthSyncPill">unknown</span>
            </div>
            <div class="cfOpsHealthCards" id="cfOpsHealthCards"></div>
          </section>

          <section class="cfOpsHealthSection" aria-labelledby="cfOpsHealthRollupHeading">
            <div class="cfOpsHealthSectionHead">
              <div><div class="cfOpsHealthKicker">ROLLUP WATERMARKS</div><h3 id="cfOpsHealthRollupHeading">汇总水位与映射异常</h3></div>
              <span class="small">unmapped / ambiguous 保持可见，不做静默容错</span>
            </div>
            <div class="table-container cfOpsHealthTableWrap">
              <table class="cfOpsHealthTable">
                <thead><tr><th>Rollup</th><th>Partition</th><th>Success Date</th><th>As Of</th><th>Rows</th><th>Unmapped</th><th>Ambiguous</th><th>Run / Updated</th></tr></thead>
                <tbody id="cfOpsHealthRollups"></tbody>
              </table>
            </div>
          </section>

          <section class="cfOpsHealthSection" aria-labelledby="cfOpsHealthFailureHeading">
            <div class="cfOpsHealthSectionHead">
              <div><div class="cfOpsHealthKicker">FAIL-CLOSED EVIDENCE</div><h3 id="cfOpsHealthFailureHeading">最近 Rollup 失败</h3></div>
            </div>
            <div class="table-container cfOpsHealthTableWrap cfOpsHealthFailureWrap">
              <table class="cfOpsHealthTable">
                <thead><tr><th>开始</th><th>Rollup</th><th>Partition</th><th>Error</th><th>完成</th></tr></thead>
                <tbody id="cfOpsHealthFailures"></tbody>
              </table>
            </div>
          </section>

          <section class="cfOpsHealthSection" aria-labelledby="cfOpsHealthAuditHeading">
            <div class="cfOpsHealthSectionHead">
              <div><div class="cfOpsHealthKicker">AUDIT CORRELATION</div><h3 id="cfOpsHealthAuditHeading">最近治理事件</h3></div>
              <span class="small" id="cfOpsHealthAuditScope">检查 audit.read…</span>
            </div>
            <div class="table-container cfOpsHealthTableWrap cfOpsHealthAuditWrap">
              <table class="cfOpsHealthTable">
                <thead><tr><th>时间</th><th>Actor</th><th>Action</th><th>Entity</th><th>Request</th></tr></thead>
                <tbody id="cfOpsHealthAudits"></tbody>
              </table>
            </div>
          </section>

          <div class="small cfOpsHealthFoot">数据来源仅为 same-origin <code>stores</code>、<code>capabilities</code>、<code>analyticsDataHealth</code> 与 <code>auditEvents</code>。本面板不调用 <code>startSync</code>，不修改 Control/Store D1，不触发 Amazon，不执行 Cloudflare deployment。</div>
        </div>
      </div>`;
    global.document.body.appendChild(modal);

    modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
    global.document.querySelector('#btnCfOpsHealthClose')?.addEventListener('click', close);
    global.document.querySelector('#btnCfOpsHealthRefresh')?.addEventListener('click', refresh);
    global.document.querySelector('#cfOpsHealthStore')?.addEventListener('change', async (event) => {
      await selectStore(String(event.target.value || ''));
    });
    global.document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.open) close();
    });

    void probeAccess();
  }

  async function probeAccess() {
    try {
      const [storesPayload, caps] = await Promise.all([listStores(), capabilities()]);
      state.capabilities = caps || {};
      const allStores = normalizeStores(storesPayload?.stores);
      state.stores = allStores.filter((store) => canReadAnalytics(store.storeId));
      if (!state.stores.some((store) => store.storeId === state.storeId)) {
        state.storeId = state.stores[0]?.storeId || '';
      }
      renderStores();
      renderAccess();
      const button = global.document.querySelector('#btnNativeOperationsHealth');
      if (button) button.style.display = state.stores.length ? '' : 'none';
    } catch {
      state.capabilities = null;
      state.stores = [];
      state.storeId = '';
      const button = global.document.querySelector('#btnNativeOperationsHealth');
      if (button) button.style.display = 'none';
    }
  }

  async function open() {
    if (!state.mounted) mount();
    if (!state.capabilities) await probeAccess();
    if (!state.storeId || !canReadAnalytics(state.storeId)) return;
    const modal = global.document.querySelector('#nativeOperationsHealthModal');
    if (!modal) return;
    state.open = true;
    modal.style.display = 'flex';
    renderStores();
    renderAccess();
    await refresh();
  }

  function close() {
    const modal = global.document.querySelector('#nativeOperationsHealthModal');
    if (modal) modal.style.display = 'none';
    state.open = false;
  }

  async function refresh() {
    if (!state.open || !state.storeId || state.loading) return;
    const serial = ++state.requestSerial;
    setBusy(true, '正在读取跨店运营健康证据…');
    const auditAllowed = canReadAudit(state.storeId);
    const healthTasks = state.stores.map(async (store, storeOrder) => {
      try {
        const payload = await dataHealth(store.storeId);
        return { store, storeOrder, payload, row: buildCommandRow(store, payload, null, storeOrder) };
      } catch (error) {
        return { store, storeOrder, payload: null, row: buildCommandRow(store, null, error, storeOrder) };
      }
    });
    const auditTask = auditAllowed
      ? auditEvents(state.storeId).then((payload) => ({ payload, error: null })).catch((error) => ({ payload: null, error }))
      : Promise.resolve({ payload: { items: [] }, error: null });

    try {
      const [healthResults, auditResult] = await Promise.all([Promise.all(healthTasks), auditTask]);
      if (serial !== state.requestSerial) return;

      state.healthByStore = Object.create(null);
      for (const result of healthResults) {
        if (result.payload) state.healthByStore[result.store.storeId] = result.payload;
      }
      state.overview = rankStoreHealthRows(healthResults.map((result) => result.row));
      state.overviewGeneratedAt = latestGeneratedAt(healthResults.map((result) => result.payload));
      state.health = state.healthByStore[state.storeId] || null;
      state.audits = Array.isArray(auditResult.payload?.items) ? auditResult.payload.items : [];

      renderOverview();
      renderHealth();
      renderAudits(auditAllowed);

      const evidenceGaps = state.overview.filter((row) => row.attentionKey === 'evidence_gap').length;
      if (evidenceGaps) {
        setStatus(`${evidenceGaps} 个店铺缺少可证明的健康证据；已 fail-closed 排到最前`, 'bad');
      } else if (auditResult.error) {
        setStatus(`跨店健康已刷新；当前店铺 audit 读取失败 · ${errorText(auditResult.error)}`, 'bad');
      } else {
        setStatus('跨店运营健康证据已刷新', 'ok');
      }
    } finally {
      if (serial === state.requestSerial) setBusy(false);
    }
  }

  async function selectStore(storeId) {
    const id = String(storeId || '');
    if (!id || !state.stores.some((store) => store.storeId === id) || !canReadAnalytics(id)) return;
    state.storeId = id;
    state.health = state.healthByStore[id] || null;
    renderStores();
    renderAccess();
    renderHealth();
    await refreshAudit();
  }

  async function refreshAudit() {
    if (!state.open || !state.storeId) return;
    const allowed = canReadAudit(state.storeId);
    if (!allowed) {
      state.audits = [];
      renderAudits(false);
      return;
    }
    try {
      const payload = await auditEvents(state.storeId);
      state.audits = Array.isArray(payload?.items) ? payload.items : [];
      renderAudits(true);
    } catch (error) {
      state.audits = [];
      renderAudits(true);
      setStatus(`当前店铺 audit 读取失败 · ${errorText(error)}`, 'bad');
    }
  }

  function latestGeneratedAt(payloads) {
    const values = (Array.isArray(payloads) ? payloads : [])
      .map((payload) => payload?.generatedAt)
      .filter(Boolean)
      .sort((a, b) => timestampMs(b) - timestampMs(a));
    return values[0] || '';
  }

  function renderOverview() {
    const generated = global.document.querySelector('#cfOpsHealthOverviewGenerated');
    if (generated) {
      generated.textContent = state.overviewGeneratedAt
        ? `Generated ${state.overviewGeneratedAt} · ${state.overview.length} stores`
        : `${state.overview.length} readable stores`;
    }

    const summary = global.document.querySelector('#cfOpsHealthSummary');
    if (summary) {
      summary.replaceChildren();
      const counts = [
        ['P1 Health / evidence', state.overview.filter((row) => row.priority === ATTENTION.FAILURE).length, 'p1'],
        ['P2 Freshness', state.overview.filter((row) => row.priority === ATTENTION.FRESHNESS).length, 'p2'],
        ['P3 Mapping', state.overview.filter((row) => row.priority === ATTENTION.MAPPING).length, 'p3'],
        ['P4 Healthy', state.overview.filter((row) => row.priority === ATTENTION.HEALTHY).length, 'p4'],
      ];
      for (const [label, value, tone] of counts) {
        const chip = global.document.createElement('span');
        chip.className = 'cfOpsHealthSummaryChip';
        chip.dataset.tone = tone;
        chip.textContent = `${label}: ${value}`;
        summary.appendChild(chip);
      }
    }

    const tbody = global.document.querySelector('#cfOpsHealthOverviewRows');
    if (!tbody) return;
    tbody.replaceChildren();
    if (!state.overview.length) return appendEmpty(tbody, 7, '当前身份没有可读店铺健康证据');

    for (const row of state.overview) {
      const tr = global.document.createElement('tr');
      tr.dataset.priority = String(row.priority);
      const priority = textCell(row.label);
      priority.dataset.priority = String(row.priority);
      tr.appendChild(priority);
      tr.appendChild(textCell([row.displayName || row.storeCode || row.storeId, row.marketplaceCode].filter(Boolean).join('\n')));
      tr.appendChild(textCell(row.reason));
      tr.appendChild(textCell(row.lagMinutes === null ? '—' : `${formatNumber(row.lagMinutes)} min`));
      tr.appendChild(textCell(`${row.unmappedRows} / ${row.ambiguousRows}`));
      tr.appendChild(textCell(row.lastSuccessAt || '—'));

      const action = global.document.createElement('td');
      const inspect = global.document.createElement('button');
      inspect.type = 'button';
      inspect.className = 'btn cfOpsHealthInspect';
      inspect.textContent = row.storeId === state.storeId ? '当前店铺' : '查看店铺';
      inspect.disabled = row.storeId === state.storeId;
      inspect.addEventListener('click', () => { void selectStore(row.storeId); });
      action.appendChild(inspect);
      tr.appendChild(action);
      tbody.appendChild(tr);
    }
  }

  function renderHealth() {
    const payload = state.health || {};
    const store = Array.isArray(payload.stores) ? payload.stores[0] : null;
    const sync = store?.sync || {};
    const generated = global.document.querySelector('#cfOpsHealthGenerated');
    if (generated) generated.textContent = payload.generatedAt ? `Generated ${payload.generatedAt}` : '尚无健康数据';

    const pill = global.document.querySelector('#cfOpsHealthSyncPill');
    if (pill) {
      pill.textContent = String(sync.status || 'unknown');
      pill.dataset.status = String(sync.status || 'unknown').toLowerCase();
    }

    const cards = global.document.querySelector('#cfOpsHealthCards');
    if (cards) {
      cards.replaceChildren();
      const values = [
        ['Store', store?.displayName || store?.storeCode || state.storeId || '—'],
        ['Lag', sync.lagMinutes === null || sync.lagMinutes === undefined ? '—' : `${sync.lagMinutes} min`],
        ['Last success', sync.lastSuccessAt || '—'],
        ['Last error', sync.lastErrorAt || '—'],
        ['Error code', sync.lastErrorCode || '—'],
        ['Active run', sync.activeRunId || '—'],
      ];
      for (const [label, value] of values) cards.appendChild(metricCard(label, value));
    }

    renderRollups(Array.isArray(store?.rollups) ? store.rollups : []);
    const failures = (Array.isArray(payload.recentRollupFailures) ? payload.recentRollupFailures : [])
      .filter((row) => !row.storeId || row.storeId === state.storeId);
    renderFailures(failures);
  }

  function renderRollups(rows) {
    const tbody = global.document.querySelector('#cfOpsHealthRollups');
    if (!tbody) return;
    tbody.replaceChildren();
    if (!rows.length) return appendEmpty(tbody, 8, '当前店铺没有 rollup watermark');
    for (const row of rows) {
      const tr = global.document.createElement('tr');
      tr.appendChild(textCell(row.rollupType || '—'));
      tr.appendChild(textCell(row.partitionKey || '—'));
      tr.appendChild(textCell(row.lastSuccessDate || '—'));
      tr.appendChild(textCell(row.lastSuccessAsOfDate || '—'));
      tr.appendChild(textCell(row.summaryRows ?? '—'));
      tr.appendChild(numberCell(row.unmappedRows));
      tr.appendChild(numberCell(row.ambiguousRows));
      tr.appendChild(textCell([row.lastSuccessRunId, row.updatedAt].filter(Boolean).join('\n') || '—'));
      tbody.appendChild(tr);
    }
  }

  function renderFailures(rows) {
    const tbody = global.document.querySelector('#cfOpsHealthFailures');
    if (!tbody) return;
    tbody.replaceChildren();
    if (!rows.length) return appendEmpty(tbody, 5, '当前没有最近 Rollup 失败记录');
    for (const row of rows) {
      const tr = global.document.createElement('tr');
      tr.appendChild(textCell(row.startedAt || '—'));
      tr.appendChild(textCell(row.rollupType || '—'));
      tr.appendChild(textCell(row.partitionKey || '—'));
      tr.appendChild(textCell(row.errorCode || '—'));
      tr.appendChild(textCell(row.completedAt || '—'));
      tbody.appendChild(tr);
    }
  }

  function renderAudits(allowed) {
    const scope = global.document.querySelector('#cfOpsHealthAuditScope');
    if (scope) scope.textContent = allowed ? '最近 20 条 · store scope' : '当前 store 无 audit.read';
    const tbody = global.document.querySelector('#cfOpsHealthAudits');
    if (!tbody) return;
    tbody.replaceChildren();
    if (!allowed) return appendEmpty(tbody, 5, '无 audit.read；健康数据仍保持可读');
    if (!state.audits.length) return appendEmpty(tbody, 5, '当前店铺没有最近审计事件');
    for (const row of state.audits) {
      const tr = global.document.createElement('tr');
      tr.appendChild(textCell(row.occurredAt || '—'));
      tr.appendChild(textCell(row.actor?.displayName || row.actor?.email || row.actor?.userId || 'system'));
      tr.appendChild(textCell(row.action || '—'));
      tr.appendChild(textCell([row.entityType, row.entityId].filter(Boolean).join(' · ') || '—'));
      tr.appendChild(textCell(row.requestId || row.cfRay || '—'));
      tbody.appendChild(tr);
    }
  }

  function renderStores() {
    const select = global.document.querySelector('#cfOpsHealthStore');
    if (!select) return;
    const current = state.storeId;
    select.replaceChildren();
    for (const store of state.stores) {
      const option = global.document.createElement('option');
      option.value = store.storeId;
      option.textContent = [store.displayName || store.storeCode || store.storeId, store.marketplaceCode].filter(Boolean).join(' · ');
      option.selected = store.storeId === current;
      select.appendChild(option);
    }
    select.disabled = !state.stores.length;
  }

  function renderAccess() {
    const badge = global.document.querySelector('#cfOpsHealthAccess');
    if (!badge) return;
    const analytics = canReadAnalytics(state.storeId);
    const audit = canReadAudit(state.storeId);
    const readableStores = state.stores.filter((store) => canReadAnalytics(store.storeId)).length;
    badge.textContent = analytics
      ? `${readableStores} stores · ${audit ? 'analytics.read + audit.read' : 'analytics.read'}`
      : '无权限';
    badge.dataset.mode = analytics ? (audit ? 'full' : 'health') : 'none';
  }

  function canReadAnalytics(storeId) {
    if (!storeId && !state.capabilities) return false;
    if (globalPermissions().has('analytics.read')) return true;
    return storePermissions(storeId).has('analytics.read');
  }

  function canReadAudit(storeId) {
    if (globalPermissions().has('audit.read')) return true;
    return storePermissions(storeId).has('audit.read');
  }

  function globalPermissions() {
    return new Set(Array.isArray(state.capabilities?.globalPermissions) ? state.capabilities.globalPermissions : []);
  }

  function storePermissions(storeId) {
    const list = state.capabilities?.storePermissions?.[storeId];
    return new Set(Array.isArray(list) ? list : []);
  }

  function normalizeStores(rows) {
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      storeId: String(row.storeId || row.store_id || ''),
      storeCode: String(row.storeCode || row.store_code || ''),
      displayName: String(row.displayName || row.display_name || ''),
      marketplaceCode: String(row.marketplaceCode || row.marketplace_code || ''),
    })).filter((row) => row.storeId);
  }

  function metricCard(label, value) {
    const card = global.document.createElement('div');
    card.className = 'cfOpsHealthCard';
    const key = global.document.createElement('div');
    key.className = 'cfOpsHealthCardKey';
    key.textContent = label;
    const val = global.document.createElement('div');
    val.className = 'cfOpsHealthCardValue';
    val.textContent = String(value ?? '—');
    card.append(key, val);
    return card;
  }

  function textCell(value) {
    const td = global.document.createElement('td');
    td.textContent = String(value ?? '—');
    if (String(value || '').includes('\n')) td.style.whiteSpace = 'pre-line';
    return td;
  }

  function numberCell(value) {
    const td = textCell(value ?? 0);
    const number = Number(value || 0);
    if (Number.isFinite(number) && number > 0) td.dataset.alert = 'true';
    return td;
  }

  function appendEmpty(tbody, span, message) {
    const tr = global.document.createElement('tr');
    const td = global.document.createElement('td');
    td.colSpan = span;
    td.className = 'cfOpsHealthEmpty';
    td.textContent = message;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  function setBusy(value, message) {
    state.loading = Boolean(value);
    const modal = global.document.querySelector('#nativeOperationsHealthModal');
    if (modal) modal.setAttribute('aria-busy', state.loading ? 'true' : 'false');
    for (const control of global.document.querySelectorAll('#nativeOperationsHealthModal button,#nativeOperationsHealthModal select')) {
      if (control.id === 'btnCfOpsHealthClose') continue;
      control.disabled = state.loading;
    }
    if (message) setStatus(message, 'info');
  }

  function setStatus(message, tone = 'info') {
    const node = global.document.querySelector('#cfOpsHealthStatus');
    if (!node) return;
    node.textContent = String(message || '');
    node.dataset.tone = tone;
  }

  function errorText(error) {
    const code = error?.code || error?.payload?.error || error?.message || 'operations_health_failed';
    const requestId = error?.requestId ? ` · request ${error.requestId}` : '';
    return `${String(code)}${requestId}`;
  }

  function reject(code) {
    const error = new Error(code);
    error.code = code;
    return Promise.reject(error);
  }

  function installStyles() {
    if (global.document.querySelector('#cloudflareOperationsHealthStyles')) return;
    const style = global.document.createElement('style');
    style.id = 'cloudflareOperationsHealthStyles';
    style.textContent = `
      .cfOpsHealthOverlay{display:none;z-index:10070}.cfOpsHealthModal{width:min(1320px,97vw);max-height:94vh}.cfOpsHealthHeader{gap:14px;align-items:flex-start}.cfOpsHealthEyebrow{font-size:10px;font-weight:800;letter-spacing:.12em;color:var(--accent);margin-bottom:4px}.cfOpsHealthHeader h2{margin:0 0 4px;font-size:20px}.cfOpsHealthHeaderActions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.cfOpsHealthAccess{padding:5px 9px;border-radius:999px;background:var(--chip);font-size:10px;font-weight:800;color:var(--muted)}.cfOpsHealthAccess[data-mode="full"]{color:var(--good)}.cfOpsHealthAccess[data-mode="health"]{color:var(--accent)}
      .cfOpsHealthBody{display:grid;gap:12px}.cfOpsHealthControls{display:flex;gap:12px;align-items:end;justify-content:space-between;flex-wrap:wrap}.cfOpsHealthControls label{display:grid;gap:4px;min-width:240px;font-size:10px;color:var(--muted)}.cfOpsHealthControls select{border:1px solid var(--line);border-radius:10px;background:var(--input-bg);color:var(--text);padding:8px 9px}.cfOpsHealthGenerated{color:var(--muted)}.cfOpsHealthStatus{min-height:18px;font-size:11px;color:var(--muted)}.cfOpsHealthStatus[data-tone="ok"]{color:var(--good)}.cfOpsHealthStatus[data-tone="bad"]{color:var(--bad)}
      .cfOpsHealthSection{border:1px solid var(--line);border-radius:14px;background:var(--card);padding:12px}.cfOpsHealthOverview{border-width:2px}.cfOpsHealthSectionHead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.cfOpsHealthKicker{font-size:9px;font-weight:800;letter-spacing:.12em;color:var(--muted)}.cfOpsHealthSection h3{margin:2px 0 0;font-size:14px}.cfOpsHealthPill{padding:5px 9px;border-radius:999px;background:var(--chip);font-size:10px;font-weight:800}.cfOpsHealthPill[data-status="success"],.cfOpsHealthPill[data-status="healthy"],.cfOpsHealthPill[data-status="idle"]{color:var(--good)}.cfOpsHealthPill[data-status="failed"],.cfOpsHealthPill[data-status="error"]{color:var(--bad)}
      .cfOpsHealthSummary{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:10px}.cfOpsHealthSummaryChip{padding:6px 9px;border:1px solid var(--line);border-radius:999px;background:var(--input-bg);font-size:10px;font-weight:800}.cfOpsHealthSummaryChip[data-tone="p1"]{color:var(--bad)}.cfOpsHealthSummaryChip[data-tone="p4"]{color:var(--good)}.cfOpsHealthRule{margin-top:8px;color:var(--muted)}.cfOpsHealthTable td[data-priority="1"]{color:var(--bad);font-weight:800}.cfOpsHealthTable td[data-priority="2"],.cfOpsHealthTable td[data-priority="3"]{font-weight:800}.cfOpsHealthInspect{white-space:nowrap}
      .cfOpsHealthCards{display:grid;grid-template-columns:repeat(6,minmax(120px,1fr));gap:8px}.cfOpsHealthCard{border:1px solid var(--line);border-radius:10px;padding:9px;background:var(--input-bg);min-width:0}.cfOpsHealthCardKey{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}.cfOpsHealthCardValue{margin-top:5px;font-size:11px;font-weight:700;overflow-wrap:anywhere}
      .cfOpsHealthTableWrap{max-height:260px;overflow:auto}.cfOpsHealthOverviewWrap{max-height:300px}.cfOpsHealthFailureWrap,.cfOpsHealthAuditWrap{max-height:190px}.cfOpsHealthTable{width:100%;border-collapse:collapse}.cfOpsHealthTable th,.cfOpsHealthTable td{padding:8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;font-size:10px}.cfOpsHealthTable th{position:sticky;top:0;background:var(--card);z-index:1;color:var(--muted)}.cfOpsHealthTable td[data-alert="true"]{color:var(--bad);font-weight:800}.cfOpsHealthEmpty{text-align:center!important;color:var(--muted);padding:18px!important}.cfOpsHealthFoot{color:var(--muted)}
      @media(max-width:980px){.cfOpsHealthCards{grid-template-columns:repeat(3,minmax(120px,1fr))}.cfOpsHealthHeader{display:grid}.cfOpsHealthHeaderActions{justify-content:flex-start}}@media(max-width:580px){.cfOpsHealthCards{grid-template-columns:1fr 1fr}.cfOpsHealthModal{width:98vw}.cfOpsHealthSectionHead{align-items:flex-start}.cfOpsHealthTable th:nth-child(8),.cfOpsHealthTable td:nth-child(8){display:none}}
    `;
    global.document.head.appendChild(style);
  }
})(window);
