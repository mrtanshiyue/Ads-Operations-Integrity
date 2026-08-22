(function initCsvRecommendationOperatorTriage(global) {
  'use strict';

  const VERSION = '1.0.0';
  const ORDER_TRIAGE = 'triage';
  const ORDER_EXISTING = 'existing';
  const PRIORITY_RANK = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });
  const state = {
    mounted: false,
    panel: null,
    observer: null,
    timer: null,
    order: ORDER_TRIAGE,
  };

  Object.defineProperty(global, 'CloudflareCsvRecommendationOperatorTriage', {
    value: Object.freeze({
      version: VERSION,
      definition: 'needs_review > stale_review_evidence > unreviewed_critical_high > other_unreviewed > unavailable > acknowledged',
      refresh: scheduleSync,
    }),
    writable: false,
    configurable: false,
    enumerable: true,
  });

  if (!global.document) return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  function boot() {
    injectStyles();
    const panel = document.getElementById('cfDecisionPanel');
    if (panel) mount(panel);
    else {
      const observer = new MutationObserver(() => {
        const next = document.getElementById('cfDecisionPanel');
        if (!next) return;
        observer.disconnect();
        mount(next);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  function mount(panel) {
    if (state.mounted) return;
    state.mounted = true;
    state.panel = panel;
    panel.dataset.csvRecommendationOperatorTriageVersion = VERSION;
    panel.addEventListener('change', handleChange);
    panel.addEventListener('click', handleClick);
    global.addEventListener?.('cloudflare-operator-store-change', resetScope);
    state.observer = new MutationObserver(scheduleSync);
    observePanel();
    scheduleSync();
  }

  function observePanel() {
    state.observer?.observe(state.panel, { childList: true, subtree: true });
  }

  function scheduleSync() {
    if (state.timer) global.clearTimeout(state.timer);
    state.timer = global.setTimeout(() => {
      state.timer = null;
      sync();
    }, 45);
  }

  function sync() {
    if (currentSource() !== 'csv') return clearPresentation();
    const section = recommendationSection();
    if (!section) return;
    const body = section.querySelector('[data-cfri-rows]');
    if (!body) return;
    const rows = recommendationRows(section);
    if (!rows.length) {
      renderTriage(section, emptyMetrics());
      return;
    }

    state.observer?.disconnect();
    try {
      captureBaseOrder(rows);
      const metrics = classifyRows(rows);
      applyOrder(body, rows);
      renderTriage(section, metrics);
      decorateRows(rows);
    } finally {
      observePanel();
    }
  }

  function captureBaseOrder(rows) {
    const fresh = rows.every((row) => row.dataset.cfotBaseIndex === undefined);
    if (!fresh) return;
    rows.forEach((row, index) => { row.dataset.cfotBaseIndex = String(index); });
  }

  function classifyRows(rows) {
    const metrics = emptyMetrics();
    for (const row of rows) {
      const classification = classifyRow(row);
      row.dataset.cfotBucket = classification.bucket;
      row.dataset.cfotAttention = classification.attention ? 'true' : 'false';
      row.dataset.cfotRank = String(classification.rank);
      row.dataset.cfotPriorityRank = String(classification.priorityRank);
      row.dataset.cfotPriorityScore = String(classification.priorityScore);
      metrics.total += 1;
      if (!classification.loaded) metrics.pending += 1;
      if (classification.attention) metrics.attention += 1;
      if (classification.reviewState === 'needs_review') metrics.needsReview += 1;
      if (classification.staleCount > 0) metrics.stale += 1;
      if (classification.bucket === 'high_unreviewed') metrics.highUnreviewed += 1;
      if (classification.reviewState === 'acknowledged') metrics.acknowledged += 1;
    }
    return metrics;
  }

  function classifyRow(row) {
    const reviewCell = row.children?.[6];
    const durableState = String(reviewCell?.dataset.cfhrDurableState || '').trim();
    const loaded = Boolean(durableState && durableState !== 'unavailable');
    const reviewState = loaded ? durableState : 'unavailable';
    const staleCount = staleReviewCount(reviewCell);
    const priority = String(row.querySelector('.cfri-priority')?.textContent || '').trim().toLowerCase();
    const priorityRank = PRIORITY_RANK[priority] ?? 4;
    const priorityScore = numericMatch(String(row.children?.[0]?.textContent || ''), /score\s+([0-9]+(?:\.[0-9]+)?)/iu);

    if (reviewState === 'needs_review') return { bucket: 'needs_review', rank: 0, attention: true, loaded, reviewState, staleCount, priorityRank, priorityScore };
    if (staleCount > 0) return { bucket: 'stale_review_evidence', rank: 1, attention: true, loaded, reviewState, staleCount, priorityRank, priorityScore };
    if (reviewState === 'unreviewed' && (priority === 'critical' || priority === 'high')) {
      return { bucket: 'high_unreviewed', rank: 2, attention: true, loaded, reviewState, staleCount, priorityRank, priorityScore };
    }
    if (reviewState === 'unreviewed') return { bucket: 'other_unreviewed', rank: 3, attention: false, loaded, reviewState, staleCount, priorityRank, priorityScore };
    if (!loaded) return { bucket: 'snapshot_pending', rank: 4, attention: false, loaded, reviewState, staleCount, priorityRank, priorityScore };
    if (reviewState === 'acknowledged') return { bucket: 'acknowledged', rank: 5, attention: false, loaded, reviewState, staleCount, priorityRank, priorityScore };
    return { bucket: 'other', rank: 4, attention: false, loaded, reviewState, staleCount, priorityRank, priorityScore };
  }

  function staleReviewCount(reviewCell) {
    const text = String(reviewCell?.querySelector('[data-cfhr-review]')?.textContent || '');
    return numericMatch(text, /(\d+)\s+stale prior evidence record/iu);
  }

  function numericMatch(text, pattern) {
    const match = String(text || '').match(pattern);
    const numeric = Number(match?.[1] || 0);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
  }

  function applyOrder(body, rows) {
    const desired = [...rows].sort(state.order === ORDER_TRIAGE ? triageSorter : baseSorter);
    if (desired.every((row, index) => row === rows[index])) return;
    for (const row of desired) body.appendChild(row);
  }

  function triageSorter(a, b) {
    return number(a.dataset.cfotRank) - number(b.dataset.cfotRank)
      || number(a.dataset.cfotPriorityRank) - number(b.dataset.cfotPriorityRank)
      || number(b.dataset.cfotPriorityScore) - number(a.dataset.cfotPriorityScore)
      || number(a.dataset.cfotBaseIndex) - number(b.dataset.cfotBaseIndex);
  }

  function baseSorter(a, b) {
    return number(a.dataset.cfotBaseIndex) - number(b.dataset.cfotBaseIndex);
  }

  function decorateRows(rows) {
    for (const row of rows) {
      row.classList.toggle('cfot-attention-row', row.dataset.cfotAttention === 'true');
      row.classList.toggle('cfot-acknowledged-row', row.dataset.cfotBucket === 'acknowledged');
    }
  }

  function renderTriage(section, metrics) {
    let host = section.querySelector('[data-cfri-operator-triage]');
    if (!host) {
      host = document.createElement('section');
      host.className = 'cfot-panel';
      host.dataset.cfriOperatorTriage = '';
      const controls = section.querySelector('[data-cfri-controls]');
      if (controls) controls.insertAdjacentElement('beforebegin', host);
      else section.prepend(host);
    }
    const snapshotStatus = metrics.pending === 0 && metrics.total > 0
      ? 'Durable review snapshot ready'
      : `${metrics.pending} awaiting durable review snapshot`;
    const html = `<div class="cfot-head">
      <div><div class="cfot-eyebrow">OPERATOR TRIAGE</div><strong>Attention queue</strong><span>${escapeHtml(snapshotStatus)}. Ranking uses only durable review state, stale-review evidence, existing priority, and priority score.</span></div>
      <div class="cfot-actions">
        <label>Row order<select data-cfot-order><option value="triage"${state.order === ORDER_TRIAGE ? ' selected' : ''}>Triage priority</option><option value="existing"${state.order === ORDER_EXISTING ? ' selected' : ''}>Existing Inbox order</option></select></label>
        <button type="button" class="btn" data-cfot-first-attention${metrics.attention ? '' : ' disabled'}>First attention</button>
        <button type="button" class="btn" data-cfot-refresh-review>Refresh review state</button>
      </div>
    </div>
    <div class="cfot-metrics">
      ${metric('Attention now', metrics.attention, 'warn')}
      ${metric('Needs review', metrics.needsReview)}
      ${metric('Stale evidence', metrics.stale)}
      ${metric('High unreviewed', metrics.highUnreviewed)}
      ${metric('Acknowledged', metrics.acknowledged, 'safe')}
      ${metric('Snapshot pending', metrics.pending, metrics.pending ? 'warn' : 'safe')}
    </div>
    <div class="cfot-boundary"><strong>Advisory only.</strong> Triage changes presentation order only. It does not approve, execute, persist Optimization Actions, or authorize any Amazon mutation.</div>`;
    if (host.innerHTML !== html) host.innerHTML = html;
  }

  function metric(label, value, kind) {
    return `<div class="${escapeHtml(kind || '')}"><span>${escapeHtml(label)}</span><strong>${formatNumber(value)}</strong></div>`;
  }

  function handleChange(event) {
    const order = event.target.closest?.('[data-cfot-order]');
    if (!order) return;
    state.order = order.value === ORDER_EXISTING ? ORDER_EXISTING : ORDER_TRIAGE;
    resetInboxPage();
    scheduleSync();
  }

  function handleClick(event) {
    const first = event.target.closest?.('[data-cfot-first-attention]');
    if (first) {
      event.preventDefault();
      state.order = ORDER_TRIAGE;
      resetInboxPage();
      global.setTimeout(() => {
        sync();
        const row = recommendationSection()?.querySelector('tr[data-cfot-attention="true"]');
        row?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        row?.querySelector('[data-cfri-evidence]')?.focus?.({ preventScroll: true });
      }, 80);
      return;
    }
    const refresh = event.target.closest?.('[data-cfot-refresh-review]');
    if (refresh) {
      event.preventDefault();
      void global.CloudflareCsvRecommendationHumanReviewUi?.refresh?.();
    }
  }

  function resetInboxPage() {
    const sort = recommendationSection()?.querySelector('[data-cfri-filter="sort"]');
    if (sort) sort.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function resetScope() {
    state.order = ORDER_TRIAGE;
    scheduleSync();
  }

  function clearPresentation() {
    const section = recommendationSection();
    section?.querySelector('[data-cfri-operator-triage]')?.remove();
  }

  function recommendationSection() {
    return state.panel?.querySelector('[data-csv-recommendation-inbox-workspace]') || null;
  }

  function recommendationRows(section) {
    return [...section.querySelectorAll('[data-cfri-rows] tr[data-cfri-item]')];
  }

  function currentSource() {
    return state.panel?.querySelector('[name="dataSource"]')?.value || 'csv';
  }

  function emptyMetrics() {
    return { total: 0, attention: 0, needsReview: 0, stale: 0, highUnreviewed: 0, acknowledged: 0, pending: 0 };
  }

  function number(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat().format(number(value));
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  }

  function injectStyles() {
    if (document.getElementById('cfotStylesV1')) return;
    const style = document.createElement('style');
    style.id = 'cfotStylesV1';
    style.textContent = `
      .cfot-panel{margin:10px 0;padding:10px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
      .cfot-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.cfot-head>div:first-child{min-width:0}.cfot-eyebrow{font-size:9px;font-weight:800;letter-spacing:.12em;color:var(--accent)}.cfot-head strong{display:block;margin-top:2px;font-size:13px}.cfot-head span{display:block;margin-top:3px;color:var(--muted);font-size:10px;line-height:1.45}
      .cfot-actions{display:flex;align-items:flex-end;justify-content:flex-end;gap:7px;flex-wrap:wrap}.cfot-actions label{display:flex;flex-direction:column;gap:3px;color:var(--muted);font-size:9px}.cfot-actions select{height:30px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text);padding:0 8px;font:inherit}.cfot-actions .btn{min-height:30px}.cfot-actions .btn:disabled{opacity:.45;cursor:not-allowed}
      .cfot-metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px;margin-top:9px}.cfot-metrics>div{padding:7px 8px;border:1px solid var(--line);border-radius:9px;background:var(--hover-bg)}.cfot-metrics>div.warn{border-color:color-mix(in srgb,#d97706 35%,var(--line));background:color-mix(in srgb,#d97706 6%,var(--card))}.cfot-metrics>div.safe{border-color:color-mix(in srgb,#16a34a 30%,var(--line));background:color-mix(in srgb,#16a34a 5%,var(--card))}.cfot-metrics span,.cfot-metrics strong{display:block}.cfot-metrics span{font-size:9px;color:var(--muted)}.cfot-metrics strong{margin-top:2px;font-size:14px}
      .cfot-boundary{margin-top:8px;color:var(--muted);font-size:9px;line-height:1.45}.cfot-boundary strong{color:var(--text)}
      .cfri-table tbody tr.cfot-attention-row>td:first-child{box-shadow:inset 3px 0 0 color-mix(in srgb,#d97706 75%,transparent)}.cfri-table tbody tr.cfot-acknowledged-row{opacity:.82}
      @media(max-width:980px){.cfot-head{flex-direction:column}.cfot-actions{justify-content:flex-start}.cfot-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}}
      @media(max-width:640px){.cfot-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
    `;
    document.head.appendChild(style);
  }
})(globalThis);
