(function initCsvRecommendationInboxUsability(global) {
  'use strict';

  const VERSION = '1.0.0';
  const STORAGE_PREFIX = 'cfri:presentation:v1:';
  const DEFAULT_PAGE_SIZE = 25;
  const PAGE_SIZES = Object.freeze([10, 25, 50, 100]);
  const PRESENTATION_FILTER_KEYS = Object.freeze([
    'priority',
    'candidateType',
    'lifecycle',
    'root',
    'reviewState',
    'search',
    'sort',
  ]);

  const state = {
    mounted: false,
    panel: null,
    observer: null,
    syncTimer: null,
    lastControls: null,
    currentPage: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    restoredStoreId: '',
    contextScopeKey: '',
    contextPayload: null,
    contextController: null,
  };

  Object.defineProperty(global, 'CloudflareCsvRecommendationInboxUsability', {
    value: Object.freeze({ version: VERSION, storagePrefix: STORAGE_PREFIX }),
    writable: false,
    configurable: false,
    enumerable: true,
  });

  if (!global.document) return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  function boot() {
    injectStyles();
    mountWhenReady();
  }

  function mountWhenReady() {
    const panel = document.getElementById('cfDecisionPanel');
    if (panel) return mount(panel);
    const observer = new MutationObserver(() => {
      const next = document.getElementById('cfDecisionPanel');
      if (!next) return;
      observer.disconnect();
      mount(next);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function mount(panel) {
    if (state.mounted) return;
    state.mounted = true;
    state.panel = panel;
    panel.addEventListener('input', handlePresentationChange);
    panel.addEventListener('change', handlePresentationChange);
    panel.addEventListener('click', handlePaginationClick);
    global.addEventListener?.('cloudflare-operator-store-change', handleScopeChange);
    state.observer = new MutationObserver(() => scheduleSync());
    state.observer.observe(panel, { childList: true, subtree: true });
    scheduleSync();
  }

  function scheduleSync() {
    if (state.syncTimer) global.clearTimeout(state.syncTimer);
    state.syncTimer = global.setTimeout(() => {
      state.syncTimer = null;
      void syncUsability();
    }, 30);
  }

  async function syncUsability() {
    const section = state.panel?.querySelector('[data-csv-recommendation-inbox-workspace]');
    if (!section || currentSource() !== 'csv') return;
    const controls = section.querySelector('[data-cfri-controls]');
    if (controls && controls !== state.lastControls) {
      state.lastControls = controls;
      restorePresentationFilters(controls);
      ensurePagination(section);
    }
    ensurePagination(section);
    await ensureContext();
    renderScopeContext(section);
    applyPagination(section);
    renderEmptyState(section);
  }

  function handlePresentationChange(event) {
    const filter = event.target.closest?.('[data-cfri-filter]');
    const pageSizeControl = event.target.closest?.('[data-cfri-page-size]');
    if (!filter && !pageSizeControl) return;
    state.currentPage = 1;
    if (pageSizeControl) state.pageSize = sanitizePageSize(pageSizeControl.value);
    global.setTimeout(() => {
      persistPresentationState();
      scheduleSync();
    }, 0);
  }

  function handlePaginationClick(event) {
    const previous = event.target.closest?.('[data-cfri-page-previous]');
    const next = event.target.closest?.('[data-cfri-page-next]');
    if (!previous && !next) return;
    event.preventDefault();
    const section = state.panel?.querySelector('[data-csv-recommendation-inbox-workspace]');
    if (!section) return;
    const total = recommendationRows(section).length;
    const pages = Math.max(1, Math.ceil(total / state.pageSize));
    if (previous) state.currentPage = Math.max(1, state.currentPage - 1);
    if (next) state.currentPage = Math.min(pages, state.currentPage + 1);
    applyPagination(section);
  }

  function handleScopeChange() {
    state.currentPage = 1;
    state.lastControls = null;
    state.restoredStoreId = '';
    state.contextScopeKey = '';
    state.contextPayload = null;
    state.contextController?.abort();
    state.contextController = null;
    scheduleSync();
  }

  function storageKey() {
    const storeId = currentStoreId();
    return storeId ? `${STORAGE_PREFIX}${storeId}:recommendation-inbox` : '';
  }

  function readStoredPresentationState() {
    const key = storageKey();
    if (!key) return {};
    try {
      const parsed = JSON.parse(global.localStorage?.getItem(key) || '{}');
      if (!parsed || typeof parsed !== 'object') return {};
      const clean = {};
      for (const filterKey of PRESENTATION_FILTER_KEYS) {
        if (typeof parsed[filterKey] === 'string') clean[filterKey] = parsed[filterKey].slice(0, 500);
      }
      clean.pageSize = sanitizePageSize(parsed.pageSize);
      return clean;
    } catch {
      return {};
    }
  }

  function restorePresentationFilters(controls) {
    const storeId = currentStoreId();
    if (!storeId) return;
    const stored = readStoredPresentationState();
    state.pageSize = sanitizePageSize(stored.pageSize);
    for (const key of PRESENTATION_FILTER_KEYS) {
      if (!(key in stored)) continue;
      const control = controls.querySelector(`[data-cfri-filter="${key}"]`);
      if (!control) continue;
      const requested = String(stored[key] || '');
      if (control.tagName === 'SELECT' && ![...control.options].some((option) => option.value === requested)) continue;
      if (control.value === requested) continue;
      control.value = requested;
      control.dispatchEvent(new Event(key === 'search' ? 'input' : 'change', { bubbles: true }));
    }
    state.restoredStoreId = storeId;
  }

  function persistPresentationState() {
    const key = storageKey();
    const section = state.panel?.querySelector('[data-csv-recommendation-inbox-workspace]');
    const controls = section?.querySelector('[data-cfri-controls]');
    if (!key || !controls) return;
    const presentation = { pageSize: sanitizePageSize(state.pageSize) };
    for (const filterKey of PRESENTATION_FILTER_KEYS) {
      const control = controls.querySelector(`[data-cfri-filter="${filterKey}"]`);
      presentation[filterKey] = String(control?.value || '').slice(0, 500);
    }
    try {
      global.localStorage?.setItem(key, JSON.stringify(presentation));
    } catch {
      // Presentation persistence is optional. Storage denial must never affect governed evidence.
    }
  }

  function ensurePagination(section) {
    let pagination = section.querySelector('[data-cfri-pagination]');
    if (pagination) return pagination;
    const tableWrap = section.querySelector('.cfri-table-wrap');
    if (!tableWrap) return null;
    pagination = document.createElement('div');
    pagination.className = 'cfri-pagination';
    pagination.dataset.cfriPagination = '';
    pagination.innerHTML = `<div class="cfri-page-size"><label>Rows per page
      <select data-cfri-page-size>${PAGE_SIZES.map((size) => `<option value="${size}"${size === state.pageSize ? ' selected' : ''}>${size}</option>`).join('')}</select>
    </label></div>
    <div class="cfri-page-range" data-cfri-page-range>0 rows</div>
    <div class="cfri-page-actions">
      <button type="button" class="btn" data-cfri-page-previous>Previous</button>
      <span data-cfri-page-number>Page 1 of 1</span>
      <button type="button" class="btn" data-cfri-page-next>Next</button>
    </div>`;
    tableWrap.insertAdjacentElement('afterend', pagination);
    return pagination;
  }

  function applyPagination(section) {
    const pagination = ensurePagination(section);
    if (!pagination) return;
    const pageSizeControl = pagination.querySelector('[data-cfri-page-size]');
    if (pageSizeControl && pageSizeControl.value !== String(state.pageSize)) pageSizeControl.value = String(state.pageSize);
    const rows = recommendationRows(section);
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / state.pageSize));
    state.currentPage = Math.min(Math.max(1, state.currentPage), pages);
    const startIndex = total ? (state.currentPage - 1) * state.pageSize : 0;
    const endIndex = total ? Math.min(startIndex + state.pageSize, total) : 0;
    rows.forEach((row, index) => { row.hidden = index < startIndex || index >= endIndex; });
    const range = pagination.querySelector('[data-cfri-page-range]');
    const number = pagination.querySelector('[data-cfri-page-number]');
    const previous = pagination.querySelector('[data-cfri-page-previous]');
    const next = pagination.querySelector('[data-cfri-page-next]');
    if (range) range.textContent = total ? `${startIndex + 1}–${endIndex} of ${total} filtered rows` : '0 filtered rows';
    if (number) number.textContent = `Page ${state.currentPage} of ${pages}`;
    if (previous) previous.disabled = state.currentPage <= 1;
    if (next) next.disabled = state.currentPage >= pages;
  }

  function recommendationRows(section) {
    return [...section.querySelectorAll('[data-cfri-rows] tr[data-cfri-item]')];
  }

  async function ensureContext() {
    const scope = currentScope();
    if (!scope.storeId || !scope.startDate || !scope.endDate) {
      state.contextScopeKey = '';
      state.contextPayload = null;
      return;
    }
    const scopeKey = [scope.storeId, scope.startDate, scope.endDate, scope.profileId, scope.limit, scope.sort].join('|');
    if (state.contextScopeKey === scopeKey) return;
    state.contextController?.abort();
    const controller = new AbortController();
    state.contextController = controller;
    state.contextScopeKey = scopeKey;
    state.contextPayload = null;
    const params = new URLSearchParams({
      source: 'csv',
      startDate: scope.startDate,
      endDate: scope.endDate,
      limit: scope.limit,
      sort: scope.sort,
    });
    if (scope.profileId) params.set('profileId', scope.profileId);
    try {
      const response = await fetch(`/api/v1/stores/${encodeURIComponent(scope.storeId)}/search-term-intelligence?${params}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      if (controller.signal.aborted) return;
      state.contextPayload = payload;
    } catch {
      if (!controller.signal.aborted) state.contextPayload = null;
    } finally {
      if (state.contextController === controller) state.contextController = null;
    }
  }

  function renderScopeContext(section) {
    const payload = state.contextPayload;
    const scope = payload?.productization?.analysisScope || {};
    const profile = payload?.profile || {};
    let context = section.querySelector('[data-cfri-scope-context]');
    if (!context) {
      context = document.createElement('div');
      context.className = 'cfri-scope-context';
      context.dataset.cfriScopeContext = '';
      const head = section.querySelector('.cfri-head');
      if (head) head.insertAdjacentElement('afterend', context);
      else section.prepend(context);
    }
    const current = currentScope();
    const marketplaces = Array.isArray(scope.marketplaces) && scope.marketplaces.length
      ? scope.marketplaces.join(', ')
      : (profile.countryCode || '—');
    const currencies = Array.isArray(scope.currencyCodes) && scope.currencyCodes.length
      ? scope.currencyCodes.join(', ')
      : (profile.currencyCode || '—');
    context.innerHTML = `${scopeCell('Store', current.storeId || '—')}
      ${scopeCell('Date range', current.startDate && current.endDate ? `${current.startDate} → ${current.endDate}` : '—')}
      ${scopeCell('Marketplace', marketplaces)}
      ${scopeCell('Currency', currencies)}
      ${scopeCell('Universe', scope.complete === true ? 'Complete' : 'Incomplete', scope.complete === true ? 'safe' : 'warn')}
      ${scopeCell('Candidate emission', scope.candidateEmissionAuthorized === true ? 'Authorized for review' : 'Blocked', scope.candidateEmissionAuthorized === true ? 'safe' : 'warn')}`;
  }

  function renderEmptyState(section) {
    const body = section.querySelector('[data-cfri-rows]');
    if (!body || recommendationRows(section).length) return;
    const target = body.querySelector('.cfri-empty');
    if (!target) return;
    const summary = state.contextPayload?.productization?.recommendationInbox?.summary || {};
    const emitted = nonNegative(summary.reviewCandidateCount);
    const potential = nonNegative(summary.candidatePotentialCount);
    const scopeBlocked = nonNegative(summary.blockedByScopeCount);
    const governanceBlocked = nonNegative(summary.blockedByGovernanceCount);
    if (emitted > 0) {
      target.innerHTML = '<strong>No rows match current filters.</strong><span>Governed recommendations exist in this scope. Clear or change the presentation filters to view them.</span>';
      target.dataset.cfriEmptyState = 'filters_zero';
      return;
    }
    if (governanceBlocked > 0) {
      target.innerHTML = `<strong>Recommendation emission is governance-blocked.</strong><span>${governanceBlocked} potential candidate${governanceBlocked === 1 ? '' : 's'} remain outside the Inbox. Governance gates are not bypassed by this UI.</span>`;
      target.dataset.cfriEmptyState = 'governance_blocked';
      return;
    }
    if (scopeBlocked > 0) {
      const reasons = state.contextPayload?.productization?.recommendationInbox?.analysisScope?.reasons || [];
      target.innerHTML = `<strong>All potential candidates are scope-suppressed.</strong><span>${scopeBlocked} candidate${scopeBlocked === 1 ? '' : 's'} were withheld by analysis-scope safety${reasons.length ? `: ${escapeHtml(reasons.join(', '))}` : '.'}</span>`;
      target.dataset.cfriEmptyState = 'scope_suppressed';
      return;
    }
    if (potential === 0) {
      target.innerHTML = '<strong>No potential recommendation candidate.</strong><span>The governed analysis found no candidate in the current store and date scope.</span>';
      target.dataset.cfriEmptyState = 'no_potential_candidate';
      return;
    }
    target.innerHTML = '<strong>Recommendation output remains fail-closed.</strong><span>Potential candidates exist, but the current contract did not emit a governed review row.</span>';
    target.dataset.cfriEmptyState = 'fail_closed_unknown';
  }

  function currentScope() {
    const panel = state.panel;
    return {
      storeId: currentStoreId(),
      startDate: value(panel, 'startDate'),
      endDate: value(panel, 'endDate'),
      profileId: value(panel, 'profileId'),
      limit: value(panel, 'limit') || '50',
      sort: value(panel, 'sort') || 'cost',
    };
  }

  function currentStoreId() {
    return String(global.CloudflareOperatorContext?.getContext?.().storeId || global.CloudflareOperatorWorkspace?.currentStoreId?.() || '').trim();
  }

  function currentSource() {
    return state.panel?.querySelector('[name="dataSource"]')?.value || 'csv';
  }

  function value(panel, name) {
    return String(panel?.querySelector(`[name="${name}"]`)?.value || '').trim();
  }

  function sanitizePageSize(value) {
    const numeric = Number(value);
    return PAGE_SIZES.includes(numeric) ? numeric : DEFAULT_PAGE_SIZE;
  }

  function nonNegative(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
  }

  function scopeCell(label, value, kind) {
    return `<div class="cfri-scope-cell ${escapeHtml(kind || '')}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]));
  }

  function injectStyles() {
    if (document.getElementById('cfriUsabilityStylesV1')) return;
    const style = document.createElement('style');
    style.id = 'cfriUsabilityStylesV1';
    style.textContent = `
      .cfri-scope-context{display:grid;grid-template-columns:repeat(6,minmax(120px,1fr));gap:8px;margin:8px 0 10px}
      .cfri-scope-cell{padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:var(--card);min-width:0}
      .cfri-scope-cell span{display:block;color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.05em}
      .cfri-scope-cell strong{display:block;margin-top:3px;font-size:11px;overflow-wrap:anywhere}
      .cfri-scope-cell.safe{border-color:color-mix(in srgb,#16a34a 35%,var(--line));background:color-mix(in srgb,#16a34a 7%,var(--card))}
      .cfri-scope-cell.warn{border-color:color-mix(in srgb,#d97706 38%,var(--line));background:color-mix(in srgb,#d97706 7%,var(--card))}
      .cfri-pagination{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:9px 0 12px;color:var(--muted);font-size:10px}
      .cfri-page-size label{display:flex;align-items:center;gap:7px}.cfri-page-size select{height:30px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text);padding:0 8px;font:inherit}
      .cfri-page-actions{display:flex;align-items:center;gap:8px}.cfri-page-actions .btn:disabled{opacity:.45;cursor:not-allowed}
      .cfri-empty strong,.cfri-empty span{display:block}.cfri-empty span{margin-top:4px;color:var(--muted);font-size:10px;line-height:1.5}
      @media(max-width:980px){.cfri-scope-context{grid-template-columns:repeat(3,minmax(0,1fr))}}
      @media(max-width:640px){.cfri-scope-context{grid-template-columns:repeat(2,minmax(0,1fr))}.cfri-pagination{align-items:flex-start;flex-direction:column}}
    `;
    document.head.appendChild(style);
  }
})(globalThis);
