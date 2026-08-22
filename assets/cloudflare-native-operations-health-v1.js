(function initCloudflareNativeOperationsHealth(global) {
  'use strict';

  const VERSION = '1.2.0';
  const DECISION_SCHEMA_VERSION = 'four-store-decision-queue-summary-v1';
  const AUDIT_LIMIT = 20;
  const ATTENTION = Object.freeze({ FAILURE: 1, FRESHNESS: 2, MAPPING: 3, HEALTHY: 4 });
  const DECISION_ATTENTION = Object.freeze({ FAILURE: 1, REVIEW: 2, HIGH: 3, OTHER: 4, CLEAR: 5 });

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

  function decisionDataHealth(startDate, endDate) {
    const range = normalizeDecisionRange(startDate, endDate);
    if (!range) return reject('decision_queue_date_range_required');
    return api().analyticsDataHealth({
      includeDecisionQueue: true,
      startDate: range.startDate,
      endDate: range.endDate,
    });
  }

  function auditEvents(storeId, params = {}) {
    const id = String(storeId || '').trim();
    if (!id) return reject('store_id_required');
    return api().auditEvents({ limit: AUDIT_LIMIT, storeId: id, ...params });
  }

  function listStores() { return api().stores(); }
  function capabilities() { return api().capabilities(); }

  function classifyStoreHealth(store, failures = [], loadError = null) {
    const sync = store?.sync || {};
    const rollups = Array.isArray(store?.rollups) ? store.rollups : [];
    const relevantFailures = Array.isArray(failures) ? failures : [];
    const mapping = rollups.reduce((totals, row) => {
      totals.unmapped += safeCount(row?.unmappedRows);
      totals.ambiguous += safeCount(row?.ambiguousRows);
      return totals;
    }, { unmapped: 0, ambiguous: 0 });

    if (loadError) return attention(ATTENTION.FAILURE, 'evidence_gap', 'P1 Evidence gap', `Health read failed: ${errorText(loadError)}`, mapping);
    if (relevantFailures.length) {
      const first = relevantFailures[0] || {};
      const detail = [first.rollupType, first.partitionKey, first.errorCode].filter(Boolean).join(' · ');
      return attention(ATTENTION.FAILURE, 'health_failure', 'P1 Health failure', detail ? `Recent rollup failure: ${detail}` : 'Recent rollup failure reported', mapping);
    }

    const syncStatus = String(sync.status || '').trim().toLowerCase();
    if (['failed', 'error', 'blocked'].includes(syncStatus)) {
      return attention(ATTENTION.FAILURE, 'health_failure', 'P1 Health failure', `Sync status: ${syncStatus}${sync.lastErrorCode ? ` · ${sync.lastErrorCode}` : ''}`, mapping);
    }

    const lastSuccessMs = timestampMs(sync.lastSuccessAt);
    const lastErrorMs = timestampMs(sync.lastErrorAt);
    if (lastErrorMs && (!lastSuccessMs || lastErrorMs > lastSuccessMs)) {
      return attention(ATTENTION.FAILURE, 'health_failure', 'P1 Health failure', `Latest sync evidence is an error${sync.lastErrorCode ? ` · ${sync.lastErrorCode}` : ''}`, mapping);
    }
    if (!hasFreshnessEvidence(sync, rollups)) return attention(ATTENTION.FAILURE, 'evidence_gap', 'P1 Evidence gap', 'No sync or rollup freshness evidence is available', mapping);

    const lag = nullableFinite(sync.lagMinutes);
    if (lag !== null && lag > 0) return attention(ATTENTION.FRESHNESS, 'freshness_attention', 'P2 Freshness', `Reported data lag: ${formatNumber(lag)} min`, mapping);
    if (mapping.unmapped > 0 || mapping.ambiguous > 0) return attention(ATTENTION.MAPPING, 'mapping_anomaly', 'P3 Mapping', `Unresolved mapping: ${mapping.unmapped} unmapped · ${mapping.ambiguous} ambiguous`, mapping);
    return attention(ATTENTION.HEALTHY, 'healthy', 'P4 Healthy', 'No failure, reported lag, or mapping anomaly in the authoritative health read model', mapping);
  }

  function rankStoreHealthRows(rows) { return stableRank(rows, 'priority'); }

  function buildCommandRow(storeMeta, payload, loadError = null, storeOrder = 0) {
    const payloadStores = Array.isArray(payload?.stores) ? payload.stores : [];
    const store = payloadStores.find((row) => String(row?.storeId || '') === String(storeMeta?.storeId || '')) || payloadStores[0] || null;
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

  function classifyDecisionAttention(store, loadError = null) {
    if (loadError || !store || store.unavailable === true || store.evidenceState !== 'available') {
      return decisionAttention(DECISION_ATTENTION.FAILURE, 'decision_evidence_gap', 'P1 Evidence gap',
        loadError ? `Decision read failed: ${errorText(loadError)}` : `Decision evidence unavailable${store?.error?.code ? ` · ${store.error.code}` : ''}`);
    }
    const needsReview = safeCount(store.needsReviewCount);
    const stale = safeCount(store.staleReviewEvidenceCount);
    if (needsReview > 0 || stale > 0) {
      return decisionAttention(DECISION_ATTENTION.REVIEW, 'review_attention', 'P2 Review attention',
        `${needsReview} needs review · ${stale} stale evidence`);
    }
    const high = safeCount(store.highUnreviewedCount);
    if (high > 0) return decisionAttention(DECISION_ATTENTION.HIGH, 'high_unreviewed', 'P3 High unreviewed', `${high} critical/high recommendations remain unreviewed`);
    const unreviewed = safeCount(store.unreviewedCount);
    if (unreviewed > 0) return decisionAttention(DECISION_ATTENTION.OTHER, 'other_unreviewed', 'P4 Unreviewed', `${unreviewed} recommendations remain unreviewed`);
    return decisionAttention(DECISION_ATTENTION.CLEAR, 'queue_clear', 'P5 Queue clear',
      safeCount(store.acknowledgedCount) > 0 ? 'Acknowledged-only; no active decision queue' : 'No active decision queue');
  }

  function buildDecisionRow(store, storeOrder = 0, loadError = null) {
    const classification = classifyDecisionAttention(store, loadError);
    const unavailable = classification.decisionPriority === DECISION_ATTENTION.FAILURE;
    const unreviewed = unavailable ? null : safeCount(store?.unreviewedCount);
    const needsReview = unavailable ? null : safeCount(store?.needsReviewCount);
    return {
      ...classification,
      storeId: String(store?.storeId || ''),
      storeCode: String(store?.storeCode || ''),
      displayName: String(store?.displayName || ''),
      storeOrder,
      activeQueueCount: unavailable ? null : unreviewed + needsReview,
      recommendationCandidateCount: nullableCount(store?.recommendationCandidateCount, unavailable),
      needsReviewCount: nullableCount(store?.needsReviewCount, unavailable),
      highUnreviewedCount: nullableCount(store?.highUnreviewedCount, unavailable),
      staleReviewEvidenceCount: nullableCount(store?.staleReviewEvidenceCount, unavailable),
      acknowledgedCount: nullableCount(store?.acknowledgedCount, unavailable),
      governanceBlockedCount: nullableCount(store?.governanceBlockedCount, unavailable),
      scopeBlockedCount: nullableCount(store?.scopeBlockedCount, unavailable),
      financiallyComparable: unavailable ? null : store?.financiallyComparable === true,
      candidateEmissionAuthorized: unavailable ? null : store?.candidateEmissionAuthorized === true,
      evidenceState: unavailable ? 'unavailable' : 'available',
      errorCode: store?.error?.code || (loadError ? errorText(loadError) : null),
    };
  }

  function rankDecisionRows(rows) { return stableRank(rows, 'decisionPriority'); }

  function decisionAttention(decisionPriority, decisionKey, decisionLabel, decisionReason) {
    return Object.freeze({ decisionPriority, decisionKey, decisionLabel, decisionReason });
  }

  function stableRank(rows, field) {
    return (Array.isArray(rows) ? rows : []).slice().sort((left, right) => {
      const priorityDelta = safeCount(left?.[field]) - safeCount(right?.[field]);
      if (priorityDelta) return priorityDelta;
      const orderDelta = safeCount(left?.storeOrder) - safeCount(right?.storeOrder);
      if (orderDelta) return orderDelta;
      return String(left?.storeCode || left?.storeId || '').localeCompare(String(right?.storeCode || right?.storeId || ''));
    });
  }

  const publicApi = Object.freeze({
    version: VERSION,
    decisionSchemaVersion: DECISION_SCHEMA_VERSION,
    dataHealth,
    decisionDataHealth,
    auditEvents,
    listStores,
    capabilities,
    classifyStoreHealth,
    rankStoreHealthRows,
    buildCommandRow,
    classifyDecisionAttention,
    buildDecisionRow,
    rankDecisionRows,
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
    decisionLoading: false,
    stores: [],
    storeId: '',
    capabilities: null,
    requestSerial: 0,
    decisionSerial: 0,
    health: null,
    healthByStore: Object.create(null),
    overview: [],
    overviewGeneratedAt: '',
    audits: [],
    decisionRows: [],
    decisionGeneratedAt: '',
    decisionRange: null,
    decisionError: null,
  };

  if (!global.document) return;
  if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();

  function mount() {
    if (state.mounted || !global.document?.body) return;
    const host = global.document.querySelector('.bidGovHeaderActions') || global.document.querySelector('.header .actions');
    if (!host) return;
    state.mounted = true;
    installStyles();

    const button = global.document.createElement('button');
    button.id = 'btnNativeOperationsHealth';
    button.type = 'button';
    button.className = 'btn';
    button.textContent = '运营总览';
    button.title = '查看 Four-Store Command Board 的 Operational Health 与 Decision Workload';
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
            <div class="cfOpsHealthEyebrow">PRODUCTIZATION · FOUR-STORE COMMAND BOARD · READ ONLY</div>
            <h2 id="nativeOperationsHealthTitle">Four-Store Command Board</h2>
            <div class="small">Operational Attention 与 Decision Attention 分开排序；不生成 Store Score，不推断隐藏时间窗口，不执行任何 Amazon mutation。</div>
          </div>
          <div class="cfOpsHealthHeaderActions">
            <span id="cfOpsHealthAccess" class="cfOpsHealthAccess">只读</span>
            <button id="btnCfOpsHealthRefresh" class="btn" type="button">刷新健康</button>
            <button id="btnCfOpsHealthClose" class="btn" type="button">关闭</button>
          </div>
        </div>
        <div class="largeModalBody cfOpsHealthBody">
          <section class="cfOpsHealthSection cfOpsHealthOverview" aria-labelledby="cfOpsHealthOverviewHeading">
            <div class="cfOpsHealthSectionHead"><div><div class="cfOpsHealthKicker">OPERATIONAL ATTENTION ORDER</div><h3 id="cfOpsHealthOverviewHeading">跨店运营处理顺序</h3></div><span class="small" id="cfOpsHealthOverviewGenerated">尚未读取</span></div>
            <div class="cfOpsHealthSummary" id="cfOpsHealthSummary"></div>
            <div class="table-container cfOpsHealthTableWrap cfOpsHealthOverviewWrap"><table class="cfOpsHealthTable"><thead><tr><th>Priority</th><th>Store</th><th>Why</th><th>Lag</th><th>Mapping</th><th>Last success</th><th>Action</th></tr></thead><tbody id="cfOpsHealthOverviewRows"></tbody></table></div>
            <div class="small cfOpsHealthRule">Operational order: health failure / evidence gap → reported lag → unresolved mapping → healthy. “Never synced” without positive freshness evidence is fail-closed, never Healthy.</div>
          </section>

          <section class="cfOpsHealthSection cfOpsDecisionSection" aria-labelledby="cfOpsDecisionHeading">
            <div class="cfOpsHealthSectionHead">
              <div><div class="cfOpsHealthKicker">DECISION ATTENTION</div><h3 id="cfOpsDecisionHeading">跨店 Decision Workload</h3></div>
              <span class="small" id="cfOpsDecisionGenerated">显式日期范围必填</span>
            </div>
            <div class="cfOpsDecisionControls">
              <label>Start Date<input id="cfOpsDecisionStart" type="date" autocomplete="off"></label>
              <label>End Date<input id="cfOpsDecisionEnd" type="date" autocomplete="off"></label>
              <button id="btnCfOpsDecisionLoad" class="btn" type="button">读取 Decision Queue</button>
              <span class="small">不默认当前月 / 7 天 / 30 天</span>
            </div>
            <div class="cfOpsHealthSummary" id="cfOpsDecisionSummary"></div>
            <div class="table-container cfOpsHealthTableWrap cfOpsHealthOverviewWrap"><table class="cfOpsHealthTable"><thead><tr><th>Decision Priority</th><th>Store</th><th>Why</th><th>Decision Queue</th><th>Needs Review</th><th>High Unreviewed</th><th>Stale Evidence</th><th>Action</th></tr></thead><tbody id="cfOpsDecisionRows"></tbody></table></div>
            <div class="small cfOpsHealthRule">Decision order: authoritative read failure/evidence gap → needs-review or stale-review evidence → unreviewed critical/high → other unreviewed → acknowledged-only / no active queue. No opaque combined score.</div>
          </section>

          <div class="cfOpsHealthControls"><label>当前检查店铺<select id="cfOpsHealthStore"></select></label><div class="small cfOpsHealthGenerated" id="cfOpsHealthGenerated">尚未读取</div></div>
          <div id="cfOpsHealthStatus" class="cfOpsHealthStatus" aria-live="polite"></div>

          <section class="cfOpsHealthSection" aria-labelledby="cfOpsHealthSyncHeading"><div class="cfOpsHealthSectionHead"><div><div class="cfOpsHealthKicker">STORE HEALTH</div><h3 id="cfOpsHealthSyncHeading">同步与数据健康</h3></div><span class="cfOpsHealthPill" id="cfOpsHealthSyncPill">unknown</span></div><div class="cfOpsHealthCards" id="cfOpsHealthCards"></div></section>

          <section class="cfOpsHealthSection" aria-labelledby="cfOpsHealthRollupHeading"><div class="cfOpsHealthSectionHead"><div><div class="cfOpsHealthKicker">ROLLUP WATERMARKS</div><h3 id="cfOpsHealthRollupHeading">汇总水位与映射异常</h3></div><span class="small">unmapped / ambiguous 保持可见，不做静默容错</span></div><div class="table-container cfOpsHealthTableWrap"><table class="cfOpsHealthTable"><thead><tr><th>Rollup</th><th>Partition</th><th>Success Date</th><th>As Of</th><th>Rows</th><th>Unmapped</th><th>Ambiguous</th><th>Run / Updated</th></tr></thead><tbody id="cfOpsHealthRollups"></tbody></table></div></section>

          <section class="cfOpsHealthSection" aria-labelledby="cfOpsHealthFailureHeading"><div class="cfOpsHealthSectionHead"><div><div class="cfOpsHealthKicker">FAIL-CLOSED EVIDENCE</div><h3 id="cfOpsHealthFailureHeading">最近 Rollup 失败</h3></div></div><div class="table-container cfOpsHealthTableWrap cfOpsHealthFailureWrap"><table class="cfOpsHealthTable"><thead><tr><th>开始</th><th>Rollup</th><th>Partition</th><th>Error</th><th>完成</th></tr></thead><tbody id="cfOpsHealthFailures"></tbody></table></div></section>

          <section class="cfOpsHealthSection" aria-labelledby="cfOpsHealthAuditHeading"><div class="cfOpsHealthSectionHead"><div><div class="cfOpsHealthKicker">AUDIT CORRELATION</div><h3 id="cfOpsHealthAuditHeading">最近治理事件</h3></div><span class="small" id="cfOpsHealthAuditScope">检查 audit.read…</span></div><div class="table-container cfOpsHealthTableWrap cfOpsHealthAuditWrap"><table class="cfOpsHealthTable"><thead><tr><th>时间</th><th>Actor</th><th>Action</th><th>Entity</th><th>Request</th></tr></thead><tbody id="cfOpsHealthAudits"></tbody></table></div></section>

          <div class="small cfOpsHealthFoot">数据来源仅为 same-origin stores、capabilities、analyticsDataHealth 与 auditEvents。Decision Workload 复用 server-authoritative recommendation / durable review truth；本面板不启动 sync、不写 D1、不执行 Amazon mutation、不执行 deployment。</div>
        </div>
      </div>`;
    global.document.body.appendChild(modal);

    modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
    global.document.querySelector('#btnCfOpsHealthClose')?.addEventListener('click', close);
    global.document.querySelector('#btnCfOpsHealthRefresh')?.addEventListener('click', () => { void refresh(); });
    global.document.querySelector('#btnCfOpsDecisionLoad')?.addEventListener('click', () => { void refreshDecisionQueue(); });
    global.document.querySelector('#cfOpsHealthStore')?.addEventListener('change', async (event) => { await selectStore(String(event.target.value || '')); });
    global.document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && state.open) close(); });
    renderDecisionQueue();
    void probeAccess();
  }

  async function probeAccess() {
    try {
      const [storesPayload, caps] = await Promise.all([listStores(), capabilities()]);
      state.capabilities = caps || {};
      const allStores = normalizeStores(storesPayload?.stores);
      state.stores = allStores.filter((store) => canReadAnalytics(store.storeId));
      if (!state.stores.some((store) => store.storeId === state.storeId)) state.storeId = state.stores[0]?.storeId || '';
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
    renderDecisionQueue();
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
    const auditTask = auditAllowed ? auditEvents(state.storeId).then((payload) => ({ payload, error: null })).catch((error) => ({ payload: null, error })) : Promise.resolve({ payload: { items: [] }, error: null });

    try {
      const [healthResults, auditResult] = await Promise.all([Promise.all(healthTasks), auditTask]);
      if (serial !== state.requestSerial) return;
      state.healthByStore = Object.create(null);
      for (const result of healthResults) if (result.payload) state.healthByStore[result.store.storeId] = result.payload;
      state.overview = rankStoreHealthRows(healthResults.map((result) => result.row));
      state.overviewGeneratedAt = latestGeneratedAt(healthResults.map((result) => result.payload));
      state.health = state.healthByStore[state.storeId] || null;
      state.audits = Array.isArray(auditResult.payload?.items) ? auditResult.payload.items : [];
      renderOverview();
      renderHealth();
      renderAudits(auditAllowed);
      const evidenceGaps = state.overview.filter((row) => row.attentionKey === 'evidence_gap').length;
      if (evidenceGaps) setStatus(`${evidenceGaps} 个店铺缺少可证明的健康证据；已 fail-closed 排到 Operational Attention 最前`, 'bad');
      else if (auditResult.error) setStatus(`跨店健康已刷新；当前店铺 audit 读取失败 · ${errorText(auditResult.error)}`, 'bad');
      else setStatus('跨店运营健康证据已刷新', 'ok');

      if (decisionRangeFromControls()) void refreshDecisionQueue({ quiet: true });
    } finally {
      if (serial === state.requestSerial) setBusy(false);
    }
  }

  async function refreshDecisionQueue(options = {}) {
    if (!state.open || state.decisionLoading) return;
    const range = decisionRangeFromControls();
    if (!range) {
      state.decisionRows = [];
      state.decisionGeneratedAt = '';
      state.decisionRange = null;
      state.decisionError = 'decision_queue_date_range_required';
      renderDecisionQueue();
      if (!options.quiet) setStatus('Decision Queue 必须显式提供 Start Date 和 End Date；未使用任何默认时间窗口', 'bad');
      return;
    }

    const serial = ++state.decisionSerial;
    state.decisionLoading = true;
    setDecisionBusy(true);
    if (!options.quiet) setStatus(`正在读取 ${range.startDate} → ${range.endDate} 的 server-authoritative Decision Workload…`);
    try {
      const payload = await decisionDataHealth(range.startDate, range.endDate);
      if (serial !== state.decisionSerial) return;
      if (payload?.decisionQueue?.schemaVersion !== DECISION_SCHEMA_VERSION) throw Object.assign(new Error('decision_queue_contract_unavailable'), { code: 'decision_queue_contract_unavailable' });
      if (payload?.decisionQueue?.authority?.readOnly !== true || payload?.decisionQueue?.authority?.executionAuthorized !== false || payload?.decisionQueue?.authority?.amazonMutationAuthorized !== false) {
        throw Object.assign(new Error('decision_queue_authority_invalid'), { code: 'decision_queue_authority_invalid' });
      }
      const rows = Array.isArray(payload.decisionQueue.stores) ? payload.decisionQueue.stores : [];
      state.decisionRows = rankDecisionRows(rows.map((store) => buildDecisionRow(store, storeOrder(store.storeId))));
      state.decisionGeneratedAt = payload.decisionQueue.generatedAt || payload.generatedAt || '';
      state.decisionRange = range;
      state.decisionError = null;
      renderDecisionQueue();
      const gaps = state.decisionRows.filter((row) => row.decisionKey === 'decision_evidence_gap').length;
      if (!options.quiet) setStatus(gaps ? `${gaps} 个店铺 Decision evidence unavailable；已 fail-closed 排到 Decision Attention 最前` : '跨店 Decision Workload 已刷新', gaps ? 'bad' : 'ok');
    } catch (error) {
      if (serial !== state.decisionSerial) return;
      state.decisionRows = [];
      state.decisionGeneratedAt = '';
      state.decisionRange = range;
      state.decisionError = errorText(error);
      renderDecisionQueue();
      if (!options.quiet) setStatus(`Decision Workload 读取失败 · ${errorText(error)}`, 'bad');
    } finally {
      if (serial === state.decisionSerial) {
        state.decisionLoading = false;
        setDecisionBusy(false);
      }
    }
  }

  function storeOrder(storeId) {
    const index = state.stores.findIndex((store) => store.storeId === storeId);
    return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
  }

  async function selectStore(storeId) {
    const id = String(storeId || '');
    if (!id || !state.stores.some((store) => store.storeId === id) || !canReadAnalytics(id)) return;
    state.storeId = id;
    state.health = state.healthByStore[id] || null;
    renderStores();
    renderAccess();
    renderHealth();
    global.CloudflareOperatorContext?.setContext?.({ storeId: id }, { source: 'operations-command-board' });
    await refreshAudit();
  }

  async function refreshAudit() {
    if (!state.open || !state.storeId) return;
    const allowed = canReadAudit(state.storeId);
    if (!allowed) { state.audits = []; renderAudits(false); return; }
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

  function openDecisionQueue(row) {
    if (!row?.storeId || !state.decisionRange) return;
    global.CloudflareOperatorContext?.setContext?.({ storeId: row.storeId }, { source: 'operations-decision-queue' });
    state.storeId = row.storeId;
    const panel = global.document.querySelector('#cfDecisionPanel');
    if (panel) {
      const start = panel.querySelector('[name="startDate"]');
      const end = panel.querySelector('[name="endDate"]');
      if (start) start.value = state.decisionRange.startDate;
      if (end) end.value = state.decisionRange.endDate;
    }
    close();
    global.document.querySelector('#cfDecisionLauncher')?.click();
  }

  function renderOverview() {
    const generated = global.document.querySelector('#cfOpsHealthOverviewGenerated');
    if (generated) generated.textContent = state.overviewGeneratedAt ? `Generated ${state.overviewGeneratedAt} · ${state.overview.length} stores` : `${state.overview.length} readable stores`;
    const summary = global.document.querySelector('#cfOpsHealthSummary');
    if (summary) {
      summary.replaceChildren();
      for (const [label, value, tone] of [
        ['P1 Health / evidence', state.overview.filter((row) => row.priority === ATTENTION.FAILURE).length, 'p1'],
        ['P2 Freshness', state.overview.filter((row) => row.priority === ATTENTION.FRESHNESS).length, 'p2'],
        ['P3 Mapping', state.overview.filter((row) => row.priority === ATTENTION.MAPPING).length, 'p3'],
        ['P4 Healthy', state.overview.filter((row) => row.priority === ATTENTION.HEALTHY).length, 'p4'],
      ]) summary.appendChild(summaryChip(label, value, tone));
    }
    const tbody = global.document.querySelector('#cfOpsHealthOverviewRows');
    if (!tbody) return;
    tbody.replaceChildren();
    if (!state.overview.length) return appendEmpty(tbody, 7, '当前身份没有可读店铺健康证据');
    for (const row of state.overview) {
      const tr = global.document.createElement('tr');
      const priority = textCell(row.label); priority.dataset.priority = String(row.priority); tr.appendChild(priority);
      tr.appendChild(textCell([row.displayName || row.storeCode || row.storeId, row.marketplaceCode].filter(Boolean).join('\n')));
      tr.appendChild(textCell(row.reason));
      tr.appendChild(textCell(row.lagMinutes === null ? '—' : `${formatNumber(row.lagMinutes)} min`));
      tr.appendChild(textCell(`${row.unmappedRows} / ${row.ambiguousRows}`));
      tr.appendChild(textCell(row.lastSuccessAt || '—'));
      const action = global.document.createElement('td');
      const inspect = buttonNode(row.storeId === state.storeId ? '当前店铺' : '查看店铺', () => { void selectStore(row.storeId); });
      inspect.disabled = row.storeId === state.storeId;
      action.appendChild(inspect); tr.appendChild(action); tbody.appendChild(tr);
    }
  }

  function renderDecisionQueue() {
    const generated = global.document.querySelector('#cfOpsDecisionGenerated');
    if (generated) {
      if (state.decisionLoading) generated.textContent = '读取中…';
      else if (state.decisionGeneratedAt && state.decisionRange) generated.textContent = `${state.decisionRange.startDate} → ${state.decisionRange.endDate} · Generated ${state.decisionGeneratedAt}`;
      else generated.textContent = state.decisionError ? `Fail closed · ${state.decisionError}` : '显式日期范围必填';
    }
    const summary = global.document.querySelector('#cfOpsDecisionSummary');
    if (summary) {
      summary.replaceChildren();
      if (state.decisionRows.length) {
        summary.appendChild(summaryChip('Evidence gap', state.decisionRows.filter((row) => row.decisionPriority === DECISION_ATTENTION.FAILURE).length, 'p1'));
        summary.appendChild(summaryChip('Needs review', sumDecision('needsReviewCount'), 'p2'));
        summary.appendChild(summaryChip('High unreviewed', sumDecision('highUnreviewedCount'), 'p3'));
        summary.appendChild(summaryChip('Stale evidence', sumDecision('staleReviewEvidenceCount'), 'p2'));
      }
    }
    const tbody = global.document.querySelector('#cfOpsDecisionRows');
    if (!tbody) return;
    tbody.replaceChildren();
    if (!state.decisionRange) return appendEmpty(tbody, 8, '输入 Start Date / End Date 后读取；系统不会默认任何业务周期');
    if (state.decisionError) return appendEmpty(tbody, 8, `Decision evidence unavailable · ${state.decisionError}`);
    if (!state.decisionRows.length) return appendEmpty(tbody, 8, '当前身份在该显式时间范围没有 server-authoritative Decision Queue rows');
    for (const row of state.decisionRows) {
      const tr = global.document.createElement('tr');
      const priority = textCell(row.decisionLabel); priority.dataset.priority = String(row.decisionPriority); tr.appendChild(priority);
      tr.appendChild(textCell(row.displayName || row.storeCode || row.storeId));
      tr.appendChild(textCell(row.decisionReason));
      tr.appendChild(textCell(displayCount(row.activeQueueCount)));
      tr.appendChild(textCell(displayCount(row.needsReviewCount)));
      tr.appendChild(textCell(displayCount(row.highUnreviewedCount)));
      tr.appendChild(textCell(displayCount(row.staleReviewEvidenceCount)));
      const action = global.document.createElement('td');
      const openButton = buttonNode('Open Decision Queue', () => openDecisionQueue(row));
      openButton.disabled = row.evidenceState !== 'available';
      action.appendChild(openButton); tr.appendChild(action); tbody.appendChild(tr);
    }
  }

  function renderHealth() {
    const payload = state.health || {};
    const store = Array.isArray(payload.stores) ? payload.stores[0] : null;
    const sync = store?.sync || {};
    const generated = global.document.querySelector('#cfOpsHealthGenerated');
    if (generated) generated.textContent = payload.generatedAt ? `Generated ${payload.generatedAt}` : '尚无健康数据';
    const pill = global.document.querySelector('#cfOpsHealthSyncPill');
    if (pill) { pill.textContent = String(sync.status || 'unknown'); pill.dataset.status = String(sync.status || 'unknown').toLowerCase(); }
    const cards = global.document.querySelector('#cfOpsHealthCards');
    if (cards) {
      cards.replaceChildren();
      for (const [label, value] of [
        ['Store', store?.displayName || store?.storeCode || state.storeId || '—'],
        ['Lag', sync.lagMinutes === null || sync.lagMinutes === undefined ? '—' : `${sync.lagMinutes} min`],
        ['Last success', sync.lastSuccessAt || '—'],
        ['Last error', sync.lastErrorAt || '—'],
        ['Error code', sync.lastErrorCode || '—'],
        ['Active run', sync.activeRunId || '—'],
      ]) cards.appendChild(metricCard(label, value));
    }
    renderRollups(Array.isArray(store?.rollups) ? store.rollups : []);
    renderFailures((Array.isArray(payload.recentRollupFailures) ? payload.recentRollupFailures : []).filter((row) => !row.storeId || row.storeId === state.storeId));
  }

  function renderRollups(rows) {
    const tbody = global.document.querySelector('#cfOpsHealthRollups'); if (!tbody) return;
    tbody.replaceChildren(); if (!rows.length) return appendEmpty(tbody, 8, '当前店铺没有 rollup watermark');
    for (const row of rows) {
      const tr = global.document.createElement('tr');
      for (const value of [row.rollupType || '—', row.partitionKey || '—', row.lastSuccessDate || '—', row.lastSuccessAsOfDate || '—', row.summaryRows ?? '—']) tr.appendChild(textCell(value));
      tr.appendChild(numberCell(row.unmappedRows)); tr.appendChild(numberCell(row.ambiguousRows)); tr.appendChild(textCell([row.lastSuccessRunId, row.updatedAt].filter(Boolean).join('\n') || '—')); tbody.appendChild(tr);
    }
  }

  function renderFailures(rows) {
    const tbody = global.document.querySelector('#cfOpsHealthFailures'); if (!tbody) return;
    tbody.replaceChildren(); if (!rows.length) return appendEmpty(tbody, 5, '当前没有最近 Rollup 失败记录');
    for (const row of rows) {
      const tr = global.document.createElement('tr');
      for (const value of [row.startedAt || '—', row.rollupType || '—', row.partitionKey || '—', row.errorCode || '—', row.completedAt || '—']) tr.appendChild(textCell(value));
      tbody.appendChild(tr);
    }
  }

  function renderAudits(allowed) {
    const scope = global.document.querySelector('#cfOpsHealthAuditScope'); if (scope) scope.textContent = allowed ? '最近 20 条 · store scope' : '当前 store 无 audit.read';
    const tbody = global.document.querySelector('#cfOpsHealthAudits'); if (!tbody) return;
    tbody.replaceChildren(); if (!allowed) return appendEmpty(tbody, 5, '无 audit.read；健康数据仍保持可读');
    if (!state.audits.length) return appendEmpty(tbody, 5, '当前店铺没有最近审计事件');
    for (const row of state.audits) {
      const tr = global.document.createElement('tr');
      for (const value of [row.occurredAt || '—', row.actor?.displayName || row.actor?.email || row.actor?.userId || 'system', row.action || '—', [row.entityType, row.entityId].filter(Boolean).join(' · ') || '—', row.requestId || row.cfRay || '—']) tr.appendChild(textCell(value));
      tbody.appendChild(tr);
    }
  }

  function renderStores() {
    const select = global.document.querySelector('#cfOpsHealthStore'); if (!select) return;
    const current = state.storeId; select.replaceChildren();
    for (const store of state.stores) {
      const option = global.document.createElement('option'); option.value = store.storeId;
      option.textContent = [store.displayName || store.storeCode || store.storeId, store.marketplaceCode].filter(Boolean).join(' · ');
      option.selected = store.storeId === current; select.appendChild(option);
    }
    select.disabled = !state.stores.length;
  }

  function renderAccess() {
    const badge = global.document.querySelector('#cfOpsHealthAccess'); if (!badge) return;
    const analytics = canReadAnalytics(state.storeId); const audit = canReadAudit(state.storeId);
    const readableStores = state.stores.filter((store) => canReadAnalytics(store.storeId)).length;
    badge.textContent = analytics ? `${readableStores} stores · ${audit ? 'analytics.read + audit.read' : 'analytics.read'}` : '无权限';
    badge.dataset.mode = analytics ? (audit ? 'full' : 'health') : 'none';
  }

  function canReadAnalytics(storeId) {
    if (!storeId && !state.capabilities) return false;
    if (globalPermissions().has('analytics.read')) return true;
    return storePermissions(storeId).has('analytics.read');
  }
  function canReadAudit(storeId) { return globalPermissions().has('audit.read') || storePermissions(storeId).has('audit.read'); }
  function globalPermissions() { return new Set(Array.isArray(state.capabilities?.globalPermissions) ? state.capabilities.globalPermissions : []); }
  function storePermissions(storeId) { const list = state.capabilities?.storePermissions?.[storeId]; return new Set(Array.isArray(list) ? list : []); }

  function normalizeStores(rows) {
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      storeId: String(row.storeId || row.store_id || ''),
      storeCode: String(row.storeCode || row.store_code || ''),
      displayName: String(row.displayName || row.display_name || ''),
      marketplaceCode: String(row.marketplaceCode || row.marketplace_code || ''),
    })).filter((row) => row.storeId);
  }

  function normalizeDecisionRange(startDate, endDate) {
    const start = String(startDate || '').trim(); const end = String(endDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(start) || !/^\d{4}-\d{2}-\d{2}$/u.test(end) || Number.isNaN(Date.parse(`${start}T00:00:00.000Z`)) || Number.isNaN(Date.parse(`${end}T00:00:00.000Z`)) || start > end) return null;
    return { startDate: start, endDate: end };
  }
  function decisionRangeFromControls() { return normalizeDecisionRange(global.document.querySelector('#cfOpsDecisionStart')?.value, global.document.querySelector('#cfOpsDecisionEnd')?.value); }
  function attention(priority, key, label, reason, mapping) { return Object.freeze({ priority, attentionKey: key, label, reason, unmappedRows: safeCount(mapping?.unmapped), ambiguousRows: safeCount(mapping?.ambiguous) }); }
  function hasFreshnessEvidence(sync, rollups) { if (sync?.lastSuccessAt || sync?.updatedAt) return true; return (Array.isArray(rollups) ? rollups : []).some((row) => row?.lastSuccessDate || row?.lastSuccessAsOfDate || row?.updatedAt); }
  function latestEvidenceAt(sync, rollups, generatedAt) { const values = [sync?.lastSuccessAt, sync?.updatedAt, ...(Array.isArray(rollups) ? rollups.flatMap((row) => [row?.lastSuccessAsOfDate, row?.lastSuccessDate, row?.updatedAt]) : [])].filter(Boolean).sort((a, b) => timestampMs(b) - timestampMs(a)); return values[0] || generatedAt || null; }
  function latestGeneratedAt(payloads) { return (Array.isArray(payloads) ? payloads : []).map((payload) => payload?.generatedAt).filter(Boolean).sort((a, b) => timestampMs(b) - timestampMs(a))[0] || ''; }
  function timestampMs(value) { if (!value) return 0; const parsed = Date.parse(String(value)); return Number.isFinite(parsed) ? parsed : 0; }
  function nullableFinite(value) { if (value === null || value === undefined || value === '') return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
  function nullableCount(value, forceNull = false) { return forceNull || value === null || value === undefined ? null : safeCount(value); }
  function safeCount(value) { const parsed = Number(value || 0); return Number.isFinite(parsed) && parsed > 0 ? parsed : 0; }
  function formatNumber(value) { const parsed = Number(value); if (!Number.isFinite(parsed)) return '—'; return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(1); }
  function displayCount(value) { return value === null || value === undefined ? '—' : formatNumber(value); }
  function sumDecision(field) { return state.decisionRows.reduce((sum, row) => sum + (row?.[field] === null ? 0 : safeCount(row?.[field])), 0); }

  function metricCard(label, value) {
    const card = global.document.createElement('div'); card.className = 'cfOpsHealthCard';
    const key = global.document.createElement('div'); key.className = 'cfOpsHealthCardKey'; key.textContent = label;
    const val = global.document.createElement('div'); val.className = 'cfOpsHealthCardValue'; val.textContent = String(value ?? '—');
    card.append(key, val); return card;
  }
  function summaryChip(label, value, tone) { const chip = global.document.createElement('span'); chip.className = 'cfOpsHealthSummaryChip'; chip.dataset.tone = tone; chip.textContent = `${label}: ${value}`; return chip; }
  function textCell(value) { const td = global.document.createElement('td'); td.textContent = String(value ?? '—'); if (String(value || '').includes('\n')) td.style.whiteSpace = 'pre-line'; return td; }
  function numberCell(value) { const td = textCell(value ?? 0); const number = Number(value || 0); if (Number.isFinite(number) && number > 0) td.dataset.alert = 'true'; return td; }
  function buttonNode(label, handler) { const button = global.document.createElement('button'); button.type = 'button'; button.className = 'btn cfOpsHealthInspect'; button.textContent = label; button.addEventListener('click', handler); return button; }
  function appendEmpty(tbody, span, message) { const tr = global.document.createElement('tr'); const td = global.document.createElement('td'); td.colSpan = span; td.className = 'cfOpsHealthEmpty'; td.textContent = message; tr.appendChild(td); tbody.appendChild(tr); }

  function setBusy(value, message) {
    state.loading = Boolean(value);
    const modal = global.document.querySelector('#nativeOperationsHealthModal'); if (modal) modal.setAttribute('aria-busy', state.loading || state.decisionLoading ? 'true' : 'false');
    const refreshButton = global.document.querySelector('#btnCfOpsHealthRefresh'); if (refreshButton) refreshButton.disabled = state.loading;
    const storeSelect = global.document.querySelector('#cfOpsHealthStore'); if (storeSelect) storeSelect.disabled = state.loading || !state.stores.length;
    if (message) setStatus(message);
  }
  function setDecisionBusy(value) {
    const button = global.document.querySelector('#btnCfOpsDecisionLoad'); if (button) button.disabled = Boolean(value);
    const start = global.document.querySelector('#cfOpsDecisionStart'); if (start) start.disabled = Boolean(value);
    const end = global.document.querySelector('#cfOpsDecisionEnd'); if (end) end.disabled = Boolean(value);
    const modal = global.document.querySelector('#nativeOperationsHealthModal'); if (modal) modal.setAttribute('aria-busy', state.loading || Boolean(value) ? 'true' : 'false');
  }
  function setStatus(message, tone = 'info') { const node = global.document.querySelector('#cfOpsHealthStatus'); if (!node) return; node.textContent = String(message || ''); node.dataset.tone = tone; }
  function errorText(error) { const code = error?.code || error?.payload?.error || error?.message || 'operations_health_failed'; const requestId = error?.requestId ? ` · request ${error.requestId}` : ''; return `${String(code)}${requestId}`; }
  function reject(code) { const error = new Error(code); error.code = code; return Promise.reject(error); }

  function installStyles() {
    if (global.document.querySelector('#cloudflareOperationsHealthStyles')) return;
    const style = global.document.createElement('style'); style.id = 'cloudflareOperationsHealthStyles';
    style.textContent = `
      .cfOpsHealthOverlay{display:none;z-index:10070}.cfOpsHealthModal{width:min(1380px,97vw);max-height:94vh}.cfOpsHealthHeader{gap:14px;align-items:flex-start}.cfOpsHealthEyebrow{font-size:10px;font-weight:800;letter-spacing:.12em;color:var(--accent);margin-bottom:4px}.cfOpsHealthHeader h2{margin:0 0 4px;font-size:20px}.cfOpsHealthHeaderActions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.cfOpsHealthAccess{padding:5px 9px;border-radius:999px;background:var(--chip);font-size:10px;font-weight:800;color:var(--muted)}.cfOpsHealthAccess[data-mode="full"]{color:var(--good)}.cfOpsHealthAccess[data-mode="health"]{color:var(--accent)}
      .cfOpsHealthBody{display:grid;gap:12px}.cfOpsHealthControls,.cfOpsDecisionControls{display:flex;gap:12px;align-items:end;justify-content:flex-start;flex-wrap:wrap}.cfOpsHealthControls{justify-content:space-between}.cfOpsHealthControls label,.cfOpsDecisionControls label{display:grid;gap:4px;min-width:180px;font-size:10px;color:var(--muted)}.cfOpsHealthControls select,.cfOpsDecisionControls input{border:1px solid var(--line);border-radius:10px;background:var(--input-bg);color:var(--text);padding:8px 9px}.cfOpsHealthGenerated{color:var(--muted)}.cfOpsHealthStatus{min-height:18px;font-size:11px;color:var(--muted)}.cfOpsHealthStatus[data-tone="ok"]{color:var(--good)}.cfOpsHealthStatus[data-tone="bad"]{color:var(--bad)}
      .cfOpsHealthSection{border:1px solid var(--line);border-radius:14px;background:var(--card);padding:12px}.cfOpsHealthOverview,.cfOpsDecisionSection{border-width:2px}.cfOpsHealthSectionHead{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.cfOpsHealthKicker{font-size:9px;font-weight:800;letter-spacing:.12em;color:var(--muted)}.cfOpsHealthSection h3{margin:2px 0 0;font-size:14px}.cfOpsHealthPill{padding:5px 9px;border-radius:999px;background:var(--chip);font-size:10px;font-weight:800}.cfOpsHealthPill[data-status="success"],.cfOpsHealthPill[data-status="healthy"],.cfOpsHealthPill[data-status="idle"]{color:var(--good)}.cfOpsHealthPill[data-status="failed"],.cfOpsHealthPill[data-status="error"]{color:var(--bad)}
      .cfOpsHealthSummary{display:flex;gap:7px;flex-wrap:wrap;margin:10px 0}.cfOpsHealthSummaryChip{padding:6px 9px;border:1px solid var(--line);border-radius:999px;background:var(--input-bg);font-size:10px;font-weight:800}.cfOpsHealthSummaryChip[data-tone="p1"]{color:var(--bad)}.cfOpsHealthSummaryChip[data-tone="p4"]{color:var(--good)}.cfOpsHealthRule{margin-top:8px;color:var(--muted)}.cfOpsHealthTable td[data-priority="1"]{color:var(--bad);font-weight:800}.cfOpsHealthTable td[data-priority="2"],.cfOpsHealthTable td[data-priority="3"]{font-weight:800}.cfOpsHealthInspect{white-space:nowrap}
      .cfOpsHealthCards{display:grid;grid-template-columns:repeat(6,minmax(120px,1fr));gap:8px}.cfOpsHealthCard{border:1px solid var(--line);border-radius:10px;padding:9px;background:var(--input-bg);min-width:0}.cfOpsHealthCardKey{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}.cfOpsHealthCardValue{margin-top:5px;font-size:11px;font-weight:700;overflow-wrap:anywhere}
      .cfOpsHealthTableWrap{max-height:280px;overflow:auto}.cfOpsHealthOverviewWrap{max-height:320px}.cfOpsHealthFailureWrap,.cfOpsHealthAuditWrap{max-height:190px}.cfOpsHealthTable{width:100%;border-collapse:collapse}.cfOpsHealthTable th,.cfOpsHealthTable td{padding:8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;font-size:10px}.cfOpsHealthTable th{position:sticky;top:0;background:var(--card);z-index:1;color:var(--muted)}.cfOpsHealthTable td[data-alert="true"]{color:var(--bad);font-weight:800}.cfOpsHealthEmpty{text-align:center!important;color:var(--muted);padding:18px!important}.cfOpsHealthFoot{color:var(--muted)}
      @media(max-width:980px){.cfOpsHealthCards{grid-template-columns:repeat(3,minmax(120px,1fr))}.cfOpsHealthHeader{display:grid}.cfOpsHealthHeaderActions{justify-content:flex-start}}@media(max-width:580px){.cfOpsHealthCards{grid-template-columns:1fr 1fr}.cfOpsHealthModal{width:98vw}.cfOpsHealthSectionHead{align-items:flex-start}}
    `;
    global.document.head.appendChild(style);
  }
})(window);
