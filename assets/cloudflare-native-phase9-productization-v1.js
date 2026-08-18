(function initPhase9Productization(global) {
  'use strict';

  const VERSION = '1.2.1';
  const HEALTH_SELECTOR = '[data-phase9-governance-health]';
  const SUPPRESSION_REASONS = Object.freeze({
    invalid_lineage: 'Source report lineage is incomplete or invalid, so the row cannot become a governance candidate.',
    stale_data: 'The source facts are outside the accepted freshness window.',
    insufficient_sample: 'The analysis window does not contain enough evidence to justify an operator action.',
    low_confidence: 'The deterministic confidence score is below the governance threshold.',
    trend_deterioration: 'Comparable-window trend quality conflicts with the proposed recommendation.',
    existing_negative_collision: 'An equivalent negative target already exists in the Store D1 entity mirror.',
    existing_keyword_collision: 'An equivalent harvested keyword already exists in the Store D1 entity mirror.',
    duplicate_recommendation: 'The same recommendation fingerprint already has a governance record.',
    already_governed_action: 'The entity/action pair already has an active governance lifecycle.',
    profile_store_integrity_mismatch: 'The recommendation profile does not satisfy the selected store integrity boundary.',
    semantic_recommendation_conflict: 'Another recommendation represents the same semantic mutation intent.',
    proposed_action_conflict: 'A proposed governance action already occupies this mutation intent.',
    approved_not_executed: 'An approved action is still pending execution and must not be suggested again.',
    semantic_governance_conflict: 'Existing governance history conflicts with this recommendation intent.',
    recent_rejection_cooldown: 'A recent operator rejection suppresses the same intent for the current recommendation analysis window.',
    repeated_suggestion_cooldown: 'The same suggestion is inside the current recommendation analysis-window cooldown.',
  });
  let mounted = false;
  let loadSequence = 0;
  let inFlightStore = '';

  if (!global.document) return;
  if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();

  function mount() {
    if (mounted) return;
    mounted = true;
    installStyles();
    ensureHealthSurface();
    ensureOperatorFilters();
    enhanceDecisionSurface();

    document.addEventListener('click', (event) => {
      const actionsTab = event.target.closest('#cfDecisionPanel [data-tab="actions"]');
      const refresh = event.target.closest('#cfDecisionPanel [data-refresh-actions]');
      if (actionsTab || refresh) queueMicrotask(() => void loadGovernanceHealth());
    });
    document.addEventListener('input', handleClientFilterEvent);
    document.addEventListener('change', handleClientFilterEvent);

    global.addEventListener?.('cloudflare-operator-store-change', () => {
      loadSequence += 1;
      inFlightStore = '';
      const surface = ensureHealthSurface();
      if (surface) {
        surface.dataset.loadedStore = '';
        surface.innerHTML = emptyState('Store changed. Governance health will reload for the active store.');
      }
      resetClientFilters();
      if (isActionInboxVisible()) void loadGovernanceHealth();
    });

    const observer = new MutationObserver(() => {
      ensureHealthSurface();
      ensureOperatorFilters();
      enhanceDecisionSurface();
      if (isActionInboxVisible()) scheduleVisibleHealthLoad();
      scheduleClientFilterRefresh();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  let visibleLoadScheduled = false;
  function scheduleVisibleHealthLoad() {
    if (visibleLoadScheduled) return;
    visibleLoadScheduled = true;
    queueMicrotask(() => {
      visibleLoadScheduled = false;
      const surface = ensureHealthSurface();
      const storeId = currentStoreId();
      if (!surface || !storeId || surface.dataset.loadedStore === storeId || inFlightStore === storeId) return;
      void loadGovernanceHealth();
    });
  }

  let clientFilterScheduled = false;
  function scheduleClientFilterRefresh() {
    if (clientFilterScheduled) return;
    clientFilterScheduled = true;
    queueMicrotask(() => {
      clientFilterScheduled = false;
      applyIntelligenceFilters();
      applyActionFilters();
    });
  }

  function ensureOperatorFilters() {
    const panel = document.getElementById('cfDecisionPanel');
    if (!panel) return;
    const intelligenceView = panel.querySelector('[data-view="intelligence"]');
    if (intelligenceView && !intelligenceView.querySelector('[data-phase9-intelligence-filters]')) {
      const filters = document.createElement('div');
      filters.className = 'cfp9-client-filters';
      filters.setAttribute('data-phase9-intelligence-filters', '');
      filters.innerHTML = `
        <label>Find loaded rows<input type="search" data-phase9-intelligence-q placeholder="search term, campaign, entity"></label>
        <label>Decision<select data-phase9-intelligence-decision><option value="">All</option><option value="candidate">Candidate</option><option value="suppressed">Suppressed</option><option value="observe">Observe</option></select></label>
        <label>Confidence<select data-phase9-intelligence-confidence><option value="">All</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
        <label>Freshness<select data-phase9-intelligence-freshness><option value="">All</option><option value="fresh">Fresh</option><option value="aging">Aging</option><option value="stale">Stale</option><option value="unknown">Unknown</option></select></label>
        <span class="cfp9-filter-result" data-phase9-intelligence-filter-result>Filters apply to the currently loaded scoped result set.</span>`;
      const controls = intelligenceView.querySelector('.cfdi-controls');
      if (controls?.nextSibling) intelligenceView.insertBefore(filters, controls.nextSibling);
      else intelligenceView.prepend(filters);
    }

    const actionsView = panel.querySelector('[data-view="actions"]');
    if (actionsView && !actionsView.querySelector('[data-phase9-action-search]')) {
      const search = document.createElement('div');
      search.className = 'cfp9-action-search';
      search.setAttribute('data-phase9-action-search', '');
      search.innerHTML = `
        <label>Find action<input type="search" data-phase9-action-q placeholder="action, profile, entity, status"></label>
        <span class="cfp9-filter-result" data-phase9-action-filter-result>Search the loaded recommendation queue.</span>`;
      const filters = actionsView.querySelector('.cfdi-action-filters');
      if (filters?.nextSibling) actionsView.insertBefore(search, filters.nextSibling);
      else actionsView.prepend(search);
    }
  }

  function handleClientFilterEvent(event) {
    if (event.target.closest('[data-phase9-intelligence-filters]')) applyIntelligenceFilters();
    if (event.target.closest('[data-phase9-action-search]')) applyActionFilters();
  }

  function applyIntelligenceFilters() {
    const panel = document.getElementById('cfDecisionPanel');
    const view = panel?.querySelector('[data-view="intelligence"]');
    if (!view) return;
    const rows = [...view.querySelectorAll('[data-results] tbody tr')];
    if (!rows.length) return;
    const q = fieldValue(view, '[data-phase9-intelligence-q]').toLowerCase();
    const decision = fieldValue(view, '[data-phase9-intelligence-decision]').toLowerCase();
    const confidence = fieldValue(view, '[data-phase9-intelligence-confidence]').toLowerCase();
    const freshness = fieldValue(view, '[data-phase9-intelligence-freshness]').toLowerCase();
    let visible = 0;
    for (const row of rows) {
      if (row.querySelector('td[colspan]')) {
        row.hidden = false;
        continue;
      }
      const rowText = String(row.textContent || '').toLowerCase();
      const decisionPill = row.querySelector('.cfdi-pill');
      const decisionText = String(decisionPill?.textContent || '').toLowerCase();
      const category = decisionPill?.classList.contains('candidate') ? 'candidate' : (decisionText.includes('suppressed') ? 'suppressed' : 'observe');
      const confidenceText = String(row.querySelector('.cfdi-confidence')?.textContent || '').toLowerCase();
      const confidenceCell = row.querySelector('.cfdi-confidence')?.parentElement;
      const freshnessText = String(confidenceCell?.querySelector('small')?.textContent || '').toLowerCase();
      const matches = (!q || rowText.includes(q))
        && (!decision || category === decision)
        && (!confidence || confidenceText.startsWith(confidence))
        && (!freshness || freshnessText.startsWith(freshness));
      row.hidden = !matches;
      if (matches) visible += 1;
    }
    const result = view.querySelector('[data-phase9-intelligence-filter-result]');
    if (result) {
      const nextText = `${visible} of ${rows.filter((row) => !row.querySelector('td[colspan]')).length} loaded rows visible.`;
      if (result.textContent !== nextText) result.textContent = nextText;
    }
  }

  function applyActionFilters() {
    const panel = document.getElementById('cfDecisionPanel');
    const view = panel?.querySelector('[data-view="actions"]');
    if (!view) return;
    const rows = [...view.querySelectorAll('[data-actions-results] tbody tr')];
    if (!rows.length) return;
    const q = fieldValue(view, '[data-phase9-action-q]').toLowerCase();
    let visible = 0;
    for (const row of rows) {
      if (row.querySelector('td[colspan]')) {
        row.hidden = false;
        continue;
      }
      const matches = !q || String(row.textContent || '').toLowerCase().includes(q);
      row.hidden = !matches;
      if (matches) visible += 1;
    }
    const result = view.querySelector('[data-phase9-action-filter-result]');
    if (result) {
      const nextText = `${visible} of ${rows.filter((row) => !row.querySelector('td[colspan]')).length} queue rows visible.`;
      if (result.textContent !== nextText) result.textContent = nextText;
    }
  }

  function resetClientFilters() {
    const panel = document.getElementById('cfDecisionPanel');
    if (!panel) return;
    panel.querySelectorAll('[data-phase9-intelligence-q],[data-phase9-action-q]').forEach((input) => { input.value = ''; });
    panel.querySelectorAll('[data-phase9-intelligence-decision],[data-phase9-intelligence-confidence],[data-phase9-intelligence-freshness]').forEach((select) => { select.value = ''; });
    scheduleClientFilterRefresh();
  }

  function enhanceDecisionSurface() {
    const panel = document.getElementById('cfDecisionPanel');
    if (!panel) return;
    const intelligenceTable = panel.querySelector('[data-view="intelligence"] [data-results] table');
    if (intelligenceTable) {
      const heading = [...intelligenceTable.querySelectorAll('th')].find((cell) => cell.textContent.trim() === 'Decision');
      if (heading && !heading.dataset.phase9GovernanceHeading) {
        heading.dataset.phase9GovernanceHeading = 'true';
        heading.textContent = 'Decision / Governance';
      }
    }
    enhanceSuppressionReason(panel.querySelector('[data-drawer]'));
  }

  function enhanceSuppressionReason(drawer) {
    if (!drawer || drawer.hidden || drawer.querySelector('[data-phase9-suppression-reason]')) return;
    const text = String(drawer.textContent || '');
    const code = Object.keys(SUPPRESSION_REASONS).find((item) => text.includes(item));
    if (!code) return;
    const callout = document.createElement('div');
    callout.className = 'cfp9-suppression-reason';
    callout.setAttribute('data-phase9-suppression-reason', '');
    callout.innerHTML = `<strong>Suppression reason</strong><span><code>${escapeHtml(code)}</code> — ${escapeHtml(SUPPRESSION_REASONS[code])}</span>`;
    const body = drawer.querySelector('.cfdi-drawer-body');
    const badges = body?.querySelector('.cfdi-badges');
    if (badges?.nextSibling) body.insertBefore(callout, badges.nextSibling);
    else body?.prepend(callout);
  }

  function ensureHealthSurface() {
    const panel = document.getElementById('cfDecisionPanel');
    if (!panel) return null;
    const actionsView = panel.querySelector('[data-view="actions"]');
    if (!actionsView) return null;
    let surface = actionsView.querySelector(HEALTH_SELECTOR);
    if (surface) return surface;

    surface = document.createElement('section');
    surface.className = 'cfp9-health';
    surface.setAttribute('data-phase9-governance-health', '');
    surface.setAttribute('aria-label', 'Governance queue health');
    surface.innerHTML = emptyState('Open Action Inbox to load governance health.');

    const actionsBar = actionsView.querySelector('.cfdi-actions-bar');
    if (actionsBar?.nextSibling) actionsView.insertBefore(surface, actionsBar.nextSibling);
    else actionsView.prepend(surface);
    return surface;
  }

  async function loadGovernanceHealth() {
    const surface = ensureHealthSurface();
    const storeId = currentStoreId();
    if (!surface) return;
    if (!storeId) {
      inFlightStore = '';
      surface.dataset.loadedStore = '';
      surface.innerHTML = emptyState('Select a store in Operator Workspace first.');
      return;
    }
    if (inFlightStore === storeId) return;

    const sequence = ++loadSequence;
    inFlightStore = storeId;
    surface.dataset.loadedStore = '';
    surface.innerHTML = loadingState();
    try {
      const payload = await requestJson(`/api/v1/stores/${encodeURIComponent(storeId)}/governance-health`);
      if (sequence !== loadSequence || storeId !== currentStoreId()) return;
      inFlightStore = '';
      surface.dataset.loadedStore = storeId;
      renderHealth(surface, payload);
    } catch (error) {
      if (sequence !== loadSequence) return;
      inFlightStore = '';
      surface.dataset.loadedStore = '';
      surface.innerHTML = errorState(error.message || 'Governance health unavailable.');
    } finally {
      if (sequence === loadSequence && inFlightStore === storeId) inFlightStore = '';
    }
  }

  function renderHealth(surface, payload) {
    const metrics = payload?.metrics || {};
    const aging = metrics.actionAging || {};
    const freshness = metrics.freshness || {};
    const confidence = metrics.confidence || {};
    const observability = metrics.observability7d || {};
    const coverage = payload?.coverage || {};
    const recentActions = Array.isArray(payload?.recentActions) ? payload.recentActions : [];
    surface.innerHTML = `
      <div class="cfp9-health-head">
        <div><strong>Governance Queue Health</strong><span>治理队列健康 · operator-ready / non-executable</span></div>
        <span class="cfp9-execution">Amazon execution disabled</span>
      </div>
      <div class="cfp9-health-grid">
        ${healthCard('Awaiting review', metrics.actionsAwaitingReview, '待审核')}
        ${healthCard('Approved', metrics.approvedCount, '已批准 ≠ 已执行')}
        ${healthCard('Rejected', metrics.rejectedCount, '已拒绝')}
        ${healthCard('Total actions', metrics.recommendationCount, '治理动作总数')}
        ${healthCard('Approval rate', rate(metrics.approvalRate), '通过率')}
        ${healthCard('Rejection rate', rate(metrics.rejectionRate), '拒绝率')}
        ${healthCard('Stale rate', rate(metrics.staleRecommendationRate), '陈旧建议占比', Number(freshness.stale || 0) > 0 ? 'warn' : '')}
        ${healthCard('Aging >24h', aging.proposedOlder24h, '超过 24 小时', Number(aging.proposedOlder24h || 0) > 0 ? 'warn' : '')}
        ${healthCard('Aging >72h', aging.proposedOlder72h, '超过 72 小时', Number(aging.proposedOlder72h || 0) > 0 ? 'danger' : '')}
        ${healthCard('High risk', metrics.highRiskCount, '高风险动作', Number(metrics.highRiskCount || 0) > 0 ? 'warn' : '')}
        ${healthCard('Failed status', metrics.failedStatusCount, '失败状态', Number(metrics.failedStatusCount || 0) > 0 ? 'danger' : '')}
      </div>
      <div class="cfp9-observability">
        <div class="cfp9-section-title"><strong>Confidence Distribution</strong><span>建议置信度分布</span></div>
        <div class="cfp9-confidence-grid">
          ${healthCard('High confidence', confidence.high, '高置信度')}
          ${healthCard('Medium confidence', confidence.medium, '中置信度')}
          ${healthCard('Low confidence', confidence.low, '低置信度', Number(confidence.low || 0) > 0 ? 'warn' : '')}
        </div>
      </div>
      <div class="cfp9-observability">
        <div class="cfp9-section-title"><strong>Durable Governance Signals · 7d</strong><span>持久化治理信号</span></div>
        <div class="cfp9-observability-grid">
          ${healthCard('Duplicate suppressed', observability.duplicateSuppressions, '重复建议拦截')}
          ${healthCard('Already governed', observability.alreadyGovernedSuppressions, '已有治理动作')}
          ${healthCard('Quality suppressed', observability.recommendationQualitySuppressions, '质量 / cooldown / 冲突拦截')}
          ${healthCard('Fingerprint conflicts', observability.fingerprintConflicts, '指纹冲突', Number(observability.fingerprintConflicts || 0) > 0 ? 'warn' : '')}
          ${healthCard('Governance errors', observability.governanceErrors, '治理错误', Number(observability.governanceErrors || 0) > 0 ? 'danger' : '')}
        </div>
      </div>
      ${recentActionsMarkup(recentActions)}
      <div class="cfp9-health-foot">
        <span>Fresh ${number(freshness.fresh)} · Aging ${number(freshness.aging)} · Stale ${number(freshness.stale)} · Unknown ${number(freshness.unknown)}</span>
        <span>Oldest pending ${formatTime(aging.oldestProposedAt)}</span>
        <span>${coverageNote(coverage)}</span>
      </div>`;
  }

  function recentActionsMarkup(actions) {
    if (!actions.length) return '<div class="cfp9-recent"><div class="cfp9-section-title"><strong>Recent Governance</strong><span>暂无最近治理动作</span></div></div>';
    return `
      <div class="cfp9-recent">
        <div class="cfp9-section-title"><strong>Recent Governance</strong><span>最近治理动作 · lifecycle history</span></div>
        <div class="cfp9-recent-list">
          ${actions.map(actionRow).join('')}
        </div>
      </div>`;
  }

  function actionRow(action) {
    const evidence = action?.evidenceCompleteness || {};
    const source = action?.lineage?.sourceReportIdentity || {};
    const sourceId = first(source.amazonReportIds) || first(source.sourceReportJobIds) || '—';
    const rejection = action?.rejectionReason ? `<span class="cfp9-rejection">Rejected: ${escapeHtml(action.rejectionReason)}</span>` : '';
    const risk = Number(action?.riskScore || 0);
    const riskClass = risk >= 75 ? 'danger' : risk >= 50 ? 'warn' : '';
    return `
      <article class="cfp9-action-row">
        <div class="cfp9-action-main">
          <div class="cfp9-action-title"><strong>${escapeHtml(action?.actionType || 'Unknown action')}</strong><span class="cfp9-status ${escapeHtml(action?.status || '')}">${escapeHtml(action?.status || 'unknown')}</span></div>
          <div class="cfp9-action-meta">
            <span>Entity ${escapeHtml(action?.entityId || '—')}</span>
            <span>Reviewer ${escapeHtml(action?.reviewer || '—')}</span>
            <span>Queue ${queueAge(action?.queueAgeHours)}</span>
            <span>Freshness ${escapeHtml(action?.freshness || 'unknown')}</span>
            <span>Confidence ${escapeHtml(action?.confidence || 'unknown')}</span>
          </div>
          <div class="cfp9-action-rationale">${escapeHtml(summarizeRationale(action?.rationale))}</div>
          ${rejection}
        </div>
        <div class="cfp9-action-side">
          <span class="cfp9-signal ${riskClass}">Risk <strong>${escapeHtml(risk)}</strong></span>
          <span class="cfp9-signal ${evidence.complete ? 'good' : 'warn'}">Evidence <strong>${escapeHtml(`${number(evidence.checksPassed)}/${number(evidence.checksTotal)}`)}</strong></span>
          <span class="cfp9-source" title="${escapeHtml(sourceId)}">Source ${escapeHtml(compact(sourceId, 34))}</span>
          <span>Proposed ${formatTime(action?.lifecycle?.proposedAt)}</span>
          <span>${action?.lifecycle?.approvedAt ? `Approved ${formatTime(action.lifecycle.approvedAt)}` : action?.lifecycle?.rejectedAt ? `Rejected ${formatTime(action.lifecycle.rejectedAt)}` : `Updated ${formatTime(action?.lifecycle?.updatedAt)}`}</span>
        </div>
      </article>`;
  }

  function healthCard(label, value, zh, severity) {
    return `<div class="cfp9-card ${escapeHtml(severity || '')}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? 0)}</strong><small>${escapeHtml(zh)}</small></div>`;
  }

  function coverageNote(coverage) {
    const durable = [
      coverage.duplicateSuppressionCount,
      coverage.alreadyGovernedSuppressionCount,
      coverage.recommendationQualitySuppressionCount,
      coverage.fingerprintConflictCount,
      coverage.governanceErrors,
    ].filter(Boolean);
    return durable.length && durable.every((item) => item.durable === true)
      ? 'Suppression, conflicts and governance errors are durable audit-backed metrics.'
      : 'Governance observability coverage is partial.';
  }

  function isActionInboxVisible() {
    const view = document.querySelector('#cfDecisionPanel [data-view="actions"]');
    return Boolean(view && !view.hidden && document.getElementById('cfDecisionPanel')?.classList.contains('open'));
  }

  async function requestJson(url) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  function currentStoreId() {
    return String(global.CloudflareOperatorContext?.getContext?.().storeId || global.CloudflareOperatorWorkspace?.currentStoreId?.() || '').trim();
  }

  function fieldValue(root, selector) { return String(root.querySelector(selector)?.value || '').trim(); }
  function summarizeRationale(value) {
    if (value === null || value === undefined) return 'No rationale recorded.';
    if (typeof value === 'string') return compact(value, 180);
    if (typeof value === 'object') {
      for (const key of ['reason', 'summary', 'message', 'code']) {
        if (value[key]) return compact(String(value[key]), 180);
      }
      try { return compact(JSON.stringify(value), 180); } catch { return 'Structured rationale recorded.'; }
    }
    return compact(String(value), 180);
  }
  function rate(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    return `${(Number(value) * 100).toFixed(1)}%`;
  }
  function queueAge(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    const hours = Number(value);
    return hours >= 24 ? `${(hours / 24).toFixed(1)}d` : `${hours.toFixed(1)}h`;
  }
  function formatTime(value) {
    if (!value) return '—';
    const text = String(value);
    const parsed = new Date(text.replace(' ', 'T') + (text.includes('Z') ? '' : 'Z'));
    return Number.isNaN(parsed.getTime()) ? compact(text, 24) : parsed.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function first(value) { return Array.isArray(value) && value.length ? String(value[0]) : ''; }
  function compact(value, max) { const text = String(value ?? '').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; }
  function number(value) { return new Intl.NumberFormat().format(Number(value || 0)); }
  function emptyState(message) { return `<div class="cfp9-health-state">${escapeHtml(message)}</div>`; }
  function loadingState() { return '<div class="cfp9-health-state">Loading governance health…</div>'; }
  function errorState(message) { return `<div class="cfp9-health-state error">${escapeHtml(message)}</div>`; }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }

  function installStyles() {
    if (document.getElementById('cfPhase9ProductizationStyles')) return;
    const style = document.createElement('style');
    style.id = 'cfPhase9ProductizationStyles';
    style.textContent = `
      .cfp9-health{margin:0 0 14px;border:1px solid #eaecf0;border-radius:14px;padding:14px;background:#fcfcfd;color:#101828}
      .cfp9-health-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.cfp9-health-head>div{display:grid}.cfp9-health-head span{font-size:12px;color:#667085}.cfp9-execution{display:inline-flex!important;border-radius:999px;padding:4px 9px;background:#fef3f2;color:#b42318!important;font-weight:800}
      .cfp9-health-grid,.cfp9-observability-grid{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:9px}.cfp9-confidence-grid{display:grid;grid-template-columns:repeat(3,minmax(120px,1fr));gap:9px}.cfp9-card{border:1px solid #eaecf0;border-radius:11px;padding:10px 11px;background:#fff}.cfp9-card>span,.cfp9-card>small{display:block;color:#667085;font-size:11px}.cfp9-card>strong{display:block;margin:2px 0;font-size:18px}.cfp9-card.warn,.cfp9-signal.warn{background:#fffaeb;border-color:#fedf89}.cfp9-card.danger,.cfp9-signal.danger{background:#fef3f2;border-color:#fecdca}.cfp9-signal.good{background:#ecfdf3;border-color:#abefc6}
      .cfp9-observability,.cfp9-recent{margin-top:14px;padding-top:12px;border-top:1px solid #eaecf0}.cfp9-section-title{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:9px}.cfp9-section-title span{font-size:11px;color:#667085}
      .cfp9-recent-list{display:grid;gap:8px}.cfp9-action-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;padding:11px;border:1px solid #eaecf0;border-radius:11px;background:#fff}.cfp9-action-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.cfp9-status{font-size:10px;padding:2px 6px;border-radius:999px;background:#f2f4f7;color:#475467;text-transform:uppercase;font-weight:800}.cfp9-action-meta{display:flex;gap:10px;flex-wrap:wrap;margin-top:4px;color:#667085;font-size:11px}.cfp9-action-rationale{margin-top:6px;font-size:12px;color:#344054;line-height:1.45}.cfp9-rejection{display:block;margin-top:5px;color:#b42318;font-size:11px}.cfp9-action-side{display:grid;grid-template-columns:repeat(2,minmax(92px,auto));gap:5px 7px;align-content:start;color:#667085;font-size:10px}.cfp9-signal{border:1px solid #eaecf0;border-radius:8px;padding:4px 6px;background:#f9fafb}.cfp9-source{grid-column:1/-1;max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cfp9-health-foot{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:10px;color:#667085;font-size:11px}.cfp9-health-state{padding:12px;color:#667085}.cfp9-health-state.error{color:#b42318;background:#fef3f2;border-radius:10px}
      .cfp9-client-filters,.cfp9-action-search{display:flex;align-items:end;gap:9px;flex-wrap:wrap;margin:10px 0;padding:10px;border:1px solid #eaecf0;border-radius:12px;background:#f9fafb}.cfp9-client-filters label,.cfp9-action-search label{display:grid;gap:4px;font-size:11px;color:#475467}.cfp9-client-filters input,.cfp9-client-filters select,.cfp9-action-search input{min-height:34px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;padding:6px 8px;color:#101828}.cfp9-client-filters input,.cfp9-action-search input{min-width:210px}.cfp9-filter-result{margin-left:auto;color:#667085;font-size:10px}.cfp9-suppression-reason{display:grid;gap:4px;margin:10px 0;padding:10px 12px;border:1px solid #fedf89;border-radius:10px;background:#fffaeb;color:#7a2e0e}.cfp9-suppression-reason span{font-size:12px;line-height:1.5}.cfp9-suppression-reason code{font-weight:700}
      @media(max-width:900px){.cfp9-health-grid,.cfp9-observability-grid{grid-template-columns:repeat(2,minmax(120px,1fr))}.cfp9-health-head{align-items:flex-start;flex-direction:column}.cfp9-action-row{grid-template-columns:1fr}.cfp9-action-side{grid-template-columns:repeat(2,minmax(0,1fr))}.cfp9-filter-result{width:100%;margin-left:0}}
      @media(max-width:560px){.cfp9-action-meta{display:grid;grid-template-columns:1fr 1fr}.cfp9-section-title{align-items:flex-start;flex-direction:column}.cfp9-confidence-grid{grid-template-columns:1fr}.cfp9-client-filters,.cfp9-action-search{display:grid;grid-template-columns:1fr}.cfp9-client-filters input,.cfp9-action-search input{min-width:0;width:100%}}
    `;
    document.head.appendChild(style);
  }

  global.CloudflarePhase9Productization = Object.freeze({
    version: VERSION,
    refreshGovernanceHealth: () => loadGovernanceHealth(),
    applyIntelligenceFilters: () => applyIntelligenceFilters(),
    applyActionFilters: () => applyActionFilters(),
  });
})(window);