(function initPhase9Productization(global) {
  'use strict';

  const VERSION = '1.0.0';
  const HEALTH_SELECTOR = '[data-phase9-governance-health]';
  let mounted = false;
  let loadSequence = 0;

  if (!global.document) return;
  if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();

  function mount() {
    if (mounted) return;
    mounted = true;
    installStyles();
    ensureHealthSurface();

    document.addEventListener('click', (event) => {
      const actionsTab = event.target.closest('#cfDecisionPanel [data-tab="actions"]');
      const refresh = event.target.closest('#cfDecisionPanel [data-refresh-actions]');
      if (actionsTab || refresh) queueMicrotask(() => void loadGovernanceHealth());
    });

    global.addEventListener?.('cloudflare-operator-store-change', () => {
      const surface = ensureHealthSurface();
      if (surface) surface.innerHTML = emptyState('Store changed. Governance health will reload for the active store.');
      if (isActionInboxVisible()) void loadGovernanceHealth();
    });

    const observer = new MutationObserver(() => {
      ensureHealthSurface();
      if (isActionInboxVisible()) scheduleVisibleHealthLoad();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
  }

  let visibleLoadScheduled = false;
  function scheduleVisibleHealthLoad() {
    if (visibleLoadScheduled) return;
    visibleLoadScheduled = true;
    queueMicrotask(() => {
      visibleLoadScheduled = false;
      const surface = ensureHealthSurface();
      if (!surface || surface.dataset.loadedStore === currentStoreId()) return;
      void loadGovernanceHealth();
    });
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
      surface.dataset.loadedStore = '';
      surface.innerHTML = emptyState('Select a store in Operator Workspace first.');
      return;
    }

    const sequence = ++loadSequence;
    surface.dataset.loadedStore = '';
    surface.innerHTML = loadingState();
    try {
      const payload = await requestJson(`/api/v1/stores/${encodeURIComponent(storeId)}/governance-health`);
      if (sequence !== loadSequence || storeId !== currentStoreId()) return;
      surface.dataset.loadedStore = storeId;
      renderHealth(surface, payload);
    } catch (error) {
      if (sequence !== loadSequence) return;
      surface.dataset.loadedStore = '';
      surface.innerHTML = errorState(error.message || 'Governance health unavailable.');
    }
  }

  function renderHealth(surface, payload) {
    const metrics = payload?.metrics || {};
    const aging = metrics.actionAging || {};
    const freshness = metrics.freshness || {};
    const coverage = payload?.coverage || {};
    surface.innerHTML = `
      <div class="cfp9-health-head">
        <div><strong>Governance Queue Health</strong><span>治理队列健康 · read-only / non-executable</span></div>
        <span class="cfp9-execution">Amazon execution disabled</span>
      </div>
      <div class="cfp9-health-grid">
        ${healthCard('Awaiting review', metrics.actionsAwaitingReview, '待审核')}
        ${healthCard('Approval rate', rate(metrics.approvalRate), '通过率')}
        ${healthCard('Rejection rate', rate(metrics.rejectionRate), '拒绝率')}
        ${healthCard('Stale rate', rate(metrics.staleRecommendationRate), '陈旧建议占比', Number(freshness.stale || 0) > 0 ? 'warn' : '')}
        ${healthCard('Aging >24h', aging.proposedOlder24h, '超过 24 小时', Number(aging.proposedOlder24h || 0) > 0 ? 'warn' : '')}
        ${healthCard('Aging >72h', aging.proposedOlder72h, '超过 72 小时', Number(aging.proposedOlder72h || 0) > 0 ? 'danger' : '')}
        ${healthCard('High risk', metrics.highRiskCount, '高风险动作', Number(metrics.highRiskCount || 0) > 0 ? 'warn' : '')}
        ${healthCard('Failed status', metrics.failedStatusCount, '失败状态', Number(metrics.failedStatusCount || 0) > 0 ? 'danger' : '')}
      </div>
      <div class="cfp9-health-foot">
        <span>Fresh ${number(freshness.fresh)} · Aging ${number(freshness.aging)} · Stale ${number(freshness.stale)} · Unknown ${number(freshness.unknown)}</span>
        <span>${coverageNote(coverage)}</span>
      </div>`;
  }

  function healthCard(label, value, zh, severity) {
    return `<div class="cfp9-card ${escapeHtml(severity || '')}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? 0)}</strong><small>${escapeHtml(zh)}</small></div>`;
  }

  function coverageNote(coverage) {
    const nonDurable = [];
    if (coverage.duplicateSuppressionCount?.durable === false) nonDurable.push('duplicate suppression');
    if (coverage.fingerprintConflictCount?.durable === false) nonDurable.push('fingerprint conflicts');
    if (coverage.governanceErrors?.durable === false) nonDurable.push('governance errors');
    return nonDurable.length
      ? `Request-time only: ${nonDurable.join(', ')}.`
      : 'Lifecycle metrics are durable.';
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

  function rate(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    return `${(Number(value) * 100).toFixed(1)}%`;
  }
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
      .cfp9-health-grid{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:9px}.cfp9-card{border:1px solid #eaecf0;border-radius:11px;padding:10px 11px;background:#fff}.cfp9-card>span,.cfp9-card>small{display:block;color:#667085;font-size:11px}.cfp9-card>strong{display:block;margin:2px 0;font-size:18px}.cfp9-card.warn{background:#fffaeb;border-color:#fedf89}.cfp9-card.danger{background:#fef3f2;border-color:#fecdca}.cfp9-health-foot{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:10px;color:#667085;font-size:11px}.cfp9-health-state{padding:12px;color:#667085}.cfp9-health-state.error{color:#b42318;background:#fef3f2;border-radius:10px}
      @media(max-width:900px){.cfp9-health-grid{grid-template-columns:repeat(2,minmax(120px,1fr))}.cfp9-health-head{align-items:flex-start;flex-direction:column}}
    `;
    document.head.appendChild(style);
  }

  global.CloudflarePhase9Productization = Object.freeze({
    version: VERSION,
    refreshGovernanceHealth: () => loadGovernanceHealth(),
  });
})(window);
