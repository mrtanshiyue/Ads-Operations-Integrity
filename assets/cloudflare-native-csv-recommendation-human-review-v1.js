(function initCsvRecommendationHumanReviewUi(global) {
  'use strict';

  const VERSION = '1.0.0';
  const CONTRACT_VERSION = 'csv-recommendation-human-review-v1';
  const REQUEST_TIMEOUT_MS = 30000;
  const DURABLE_STATES = new Set(['acknowledged', 'needs_review']);
  const state = {
    mounted: false,
    panel: null,
    observer: null,
    syncTimer: null,
    scopeKey: '',
    requestId: 0,
    requestController: null,
    reviews: new Map(),
    authority: null,
    busy: new Set(),
    errors: new Map(),
  };

  Object.defineProperty(global, 'CloudflareCsvRecommendationHumanReviewUi', {
    value: Object.freeze({
      version: VERSION,
      contractVersion: CONTRACT_VERSION,
      refresh: () => refresh(true),
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
    panel.dataset.csvRecommendationHumanReviewUiVersion = VERSION;
    panel.addEventListener('click', handleClick);
    global.addEventListener?.('cloudflare-operator-store-change', resetScope);
    state.observer = new MutationObserver(scheduleSync);
    state.observer.observe(panel, { childList: true, subtree: true });
    scheduleSync();
  }

  function scheduleSync() {
    if (state.syncTimer) global.clearTimeout(state.syncTimer);
    state.syncTimer = global.setTimeout(() => {
      state.syncTimer = null;
      void sync();
    }, 35);
  }

  async function sync() {
    if (currentSource() !== 'csv') {
      clearState();
      return;
    }
    const section = recommendationSection();
    if (!section) return;
    if (!suppressLegacyReviewFilter(section)) return;
    const scope = currentScope();
    renderGlobalStatus(section, scopeComplete(scope) ? 'loading' : 'scope_required', null);
    if (!scopeComplete(scope)) {
      state.scopeKey = '';
      state.reviews.clear();
      applySnapshot(section);
      return;
    }
    const key = scopeKey(scope);
    if (key !== state.scopeKey) await loadSnapshot(scope, { force: true });
    else applySnapshot(section);
  }

  async function refresh(force = true) {
    const section = recommendationSection();
    const scope = currentScope();
    if (!section || !scopeComplete(scope) || currentSource() !== 'csv') return;
    await loadSnapshot(scope, { force });
  }

  async function loadSnapshot(scope, { force = false } = {}) {
    const key = scopeKey(scope);
    if (!force && state.scopeKey === key && state.reviews.size) {
      applySnapshot(recommendationSection());
      return;
    }
    state.requestController?.abort();
    const controller = new AbortController();
    const requestId = ++state.requestId;
    state.requestController = controller;
    renderGlobalStatus(recommendationSection(), 'loading', null);
    let timeoutId = null;
    try {
      timeoutId = global.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const payload = await requestReview(scope, { method: 'GET', signal: controller.signal });
      if (requestId !== state.requestId) return;
      validateSnapshot(payload, scope.storeId);
      state.scopeKey = key;
      state.authority = payload.authority || null;
      state.reviews = new Map((payload.items || []).map((item) => [String(item?.inboxItemId || ''), item]).filter(([id]) => id));
      renderGlobalStatus(recommendationSection(), 'ready', null);
      applySnapshot(recommendationSection());
    } catch (error) {
      if (requestId !== state.requestId) return;
      state.scopeKey = key;
      state.authority = null;
      state.reviews.clear();
      renderGlobalStatus(recommendationSection(), 'failed', errorCode(error));
      applySnapshot(recommendationSection());
    } finally {
      if (timeoutId !== null) global.clearTimeout(timeoutId);
      if (state.requestController === controller) state.requestController = null;
    }
  }

  async function persistReview(inboxItemId, requestedState) {
    if (!DURABLE_STATES.has(requestedState)) return;
    const scope = currentScope();
    if (!scopeComplete(scope) || currentSource() !== 'csv') return;
    const current = state.reviews.get(inboxItemId);
    if (current?.persistenceAuthorized !== true) {
      state.errors.set(inboxItemId, 'review_persistence_not_authorized');
      applySnapshot(recommendationSection());
      return;
    }
    if (state.busy.has(inboxItemId)) return;
    state.busy.add(inboxItemId);
    state.errors.delete(inboxItemId);
    applySnapshot(recommendationSection());
    try {
      const payload = await requestReview(scope, {
        method: 'POST',
        body: { inboxItemId, state: requestedState },
      });
      validateWriteResponse(payload, scope.storeId);
      // UI never trusts an optimistic POST response as durable presentation truth.
      // Re-read the current server-generated recommendation snapshot and persisted review.
      await loadSnapshot(scope, { force: true });
      const verified = state.reviews.get(inboxItemId);
      if (verified?.review?.persisted !== true || verified?.review?.state !== requestedState) {
        throw new Error('human_review_read_after_write_mismatch');
      }
    } catch (error) {
      state.errors.set(inboxItemId, errorCode(error));
      renderGlobalStatus(recommendationSection(), 'failed', errorCode(error));
    } finally {
      state.busy.delete(inboxItemId);
      applySnapshot(recommendationSection());
    }
  }

  async function requestReview(scope, { method, body, signal } = {}) {
    if (!['GET', 'POST'].includes(method)) throw new Error('human_review_method_not_allowed');
    const params = new URLSearchParams({
      reviewContract: CONTRACT_VERSION,
      startDate: scope.startDate,
      endDate: scope.endDate,
      limit: scope.limit,
      sort: scope.sort,
    });
    if (scope.profileId) params.set('profileId', scope.profileId);
    const url = `/api/v1/stores/${encodeURIComponent(scope.storeId)}/advisory-reviews?${params}`;
    const options = {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal,
    };
    if (method === 'POST') {
      options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify(body || {});
    }
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.error || `HTTP ${response.status}`);
      error.code = payload?.error || `HTTP_${response.status}`;
      throw error;
    }
    return payload;
  }

  function validateSnapshot(payload, expectedStoreId) {
    if (payload?.schemaVersion !== CONTRACT_VERSION) throw new Error('human_review_contract_version_mismatch');
    if (String(payload?.storeId || '') !== expectedStoreId) throw new Error('human_review_store_scope_mismatch');
    if (!Array.isArray(payload?.items)) throw new Error('human_review_items_missing');
    validateAuthority(payload.authority);
    for (const item of payload.items) {
      if (!String(item?.inboxItemId || '')) throw new Error('human_review_inbox_item_id_missing');
      const reviewState = String(item?.review?.state || 'unreviewed');
      if (!['unreviewed', 'acknowledged', 'needs_review'].includes(reviewState)) throw new Error('human_review_state_unsupported');
      if (item?.review?.persisted === true && !DURABLE_STATES.has(reviewState)) throw new Error('human_review_persisted_state_invalid');
    }
  }

  function validateWriteResponse(payload, expectedStoreId) {
    if (payload?.schemaVersion !== CONTRACT_VERSION) throw new Error('human_review_write_contract_version_mismatch');
    if (String(payload?.storeId || '') !== expectedStoreId) throw new Error('human_review_write_store_scope_mismatch');
    validateAuthority(payload.authority);
    if (payload?.review?.persisted !== true) throw new Error('human_review_write_not_persisted');
    if (!DURABLE_STATES.has(String(payload?.review?.state || ''))) throw new Error('human_review_write_state_invalid');
  }

  function validateAuthority(authority) {
    if (authority?.reviewPersistenceSupported !== true) throw new Error('human_review_persistence_authority_missing');
    if (authority?.optimizationActionPersistenceAuthorized !== false) throw new Error('human_review_optimization_action_boundary_invalid');
    if (authority?.executionAuthorized !== false) throw new Error('human_review_execution_boundary_invalid');
    if (authority?.amazonMutationAuthorized !== false) throw new Error('human_review_amazon_boundary_invalid');
    const durableStates = Array.isArray(authority?.durableStates) ? authority.durableStates : [];
    if (durableStates.length !== 2 || !durableStates.includes('acknowledged') || !durableStates.includes('needs_review')) {
      throw new Error('human_review_durable_state_contract_invalid');
    }
  }

  function suppressLegacyReviewFilter(section) {
    const control = section?.querySelector('[data-cfri-filter="reviewState"]');
    if (!control) return true;
    const label = control.closest('label');
    if (control.value) {
      control.value = '';
      control.dispatchEvent(new Event('change', { bubbles: true }));
      return false;
    }
    if (label) {
      label.hidden = true;
      label.dataset.cfhrLegacyReviewFilterSuppressed = 'true';
    }
    const meta = section.querySelector('.cfri-table-meta span:last-child');
    if (meta) meta.textContent = 'Durable review state comes from the server; viewed remains session-only. Legacy session review filtering is disabled in Human Review v1.';
    return true;
  }

  function applySnapshot(section) {
    if (!section) return;
    for (const row of section.querySelectorAll('tr[data-cfri-item]')) {
      const inboxItemId = String(row.dataset.cfriItem || '');
      const cell = row.children?.[6];
      if (!inboxItemId || !cell) continue;
      const baseStateNode = cell.querySelector('.cfri-review');
      const baseState = String(baseStateNode?.textContent || '').trim();
      const viewedThisSession = baseState === 'viewed';
      if (baseStateNode) baseStateNode.hidden = true;
      const baseSmall = baseStateNode?.nextElementSibling;
      if (baseSmall?.tagName === 'SMALL') baseSmall.hidden = true;
      const item = state.reviews.get(inboxItemId) || null;
      let host = cell.querySelector('[data-cfhr-review]');
      if (!host) {
        host = document.createElement('div');
        host.dataset.cfhrReview = '';
        cell.appendChild(host);
      }
      host.innerHTML = reviewCellHtml(inboxItemId, item, viewedThisSession);
      cell.dataset.cfhrDurableState = String(item?.review?.state || 'unavailable');
    }
    renderDrawerPersistence(section);
  }

  function reviewCellHtml(inboxItemId, item, viewedThisSession) {
    const busy = state.busy.has(inboxItemId);
    const error = state.errors.get(inboxItemId) || '';
    if (!item) {
      return `<span class="cfhr-state unavailable">unavailable</span><small>Persistence snapshot unavailable${viewedThisSession ? ' · viewed this session' : ''}</small>${error ? `<em>${esc(error)}</em>` : ''}`;
    }
    const review = item.review || {};
    const reviewState = String(review.state || 'unreviewed');
    const persisted = review.persisted === true;
    const allowed = item.persistenceAuthorized === true;
    const staleCount = Array.isArray(item.staleReviewIds) ? item.staleReviewIds.length : 0;
    const status = `<span class="cfhr-state ${esc(reviewState)}">${esc(reviewState)}</span><small>${persisted ? 'persisted' : 'not persisted'}${viewedThisSession ? ' · viewed this session' : ''}${staleCount ? ` · ${staleCount} stale prior evidence record${staleCount === 1 ? '' : 's'}` : ''}</small>`;
    const controls = allowed
      ? `<div class="cfhr-actions" role="group" aria-label="Human review actions">
          <button type="button" class="btn" data-cfhr-set="needs_review" data-cfhr-item="${esc(inboxItemId)}"${busy ? ' disabled' : ''}>Needs review</button>
          <button type="button" class="btn" data-cfhr-set="acknowledged" data-cfhr-item="${esc(inboxItemId)}"${busy ? ' disabled' : ''}>Acknowledge</button>
        </div>`
      : '<small class="cfhr-blocked">Durable review is not authorized for this candidate.</small>';
    return `${status}${controls}${busy ? '<small class="cfhr-busy" role="status">Saving and verifying…</small>' : ''}${error ? `<em class="cfhr-error" role="alert">${esc(error)}</em>` : ''}`;
  }

  function renderDrawerPersistence(section) {
    const drawer = section.querySelector('[data-cfri-drawer]');
    const scroll = drawer?.querySelector('.cfri-drawer-scroll');
    const title = drawer?.querySelector('#cfriDrawerTitle');
    if (!scroll || !title || drawer.hidden) return;
    const rowButton = section.querySelector('[data-cfri-drawer]:not([hidden])');
    void rowButton;
    const item = currentDrawerReview(section);
    let block = scroll.querySelector('[data-cfhr-drawer]');
    if (!block) {
      block = document.createElement('section');
      block.className = 'cfri-drawer-section cfhr-drawer-section';
      block.dataset.cfhrDrawer = '';
      scroll.appendChild(block);
    }
    if (!item) {
      block.innerHTML = '<h4>Durable Human Review</h4><div class="cfri-callout warn"><strong>Persistence snapshot unavailable.</strong> No durable state is inferred from the presentation-only drawer.</div>';
      return;
    }
    block.innerHTML = `<h4>Durable Human Review</h4><div class="cfhr-drawer-grid">
      <div><span>State</span><strong>${esc(item.review?.state || 'unreviewed')}</strong></div>
      <div><span>Persisted</span><strong>${item.review?.persisted === true ? 'yes' : 'no'}</strong></div>
      <div><span>Reviewer</span><strong>${esc(item.review?.reviewerUserId || '—')}</strong></div>
      <div><span>Updated</span><strong>${esc(item.review?.updatedAt || '—')}</strong></div>
    </div><div class="cfri-callout warn"><strong>Authority boundary:</strong> Acknowledged / needs-review persistence never creates an Optimization Action, execution permit, or Amazon mutation authority.</div>`;
  }

  function currentDrawerReview(section) {
    const drawer = section.querySelector('[data-cfri-drawer]');
    if (!drawer || drawer.hidden) return null;
    const title = String(drawer.querySelector('#cfriDrawerTitle')?.textContent || '').trim();
    if (!title) return null;
    const rows = [...section.querySelectorAll('tr[data-cfri-item]')];
    const matching = rows.find((row) => String(row.children?.[1]?.querySelector('strong')?.textContent || '').trim() === title);
    return matching ? state.reviews.get(String(matching.dataset.cfriItem || '')) || null : null;
  }

  function renderGlobalStatus(section, mode, detail) {
    if (!section) return;
    let host = section.querySelector('[data-cfhr-status]');
    if (!host) {
      host = document.createElement('div');
      host.className = 'cfhr-status';
      host.dataset.cfhrStatus = '';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      const safety = section.querySelector('.cfri-safety-grid');
      if (safety) safety.insertAdjacentElement('afterend', host);
      else section.prepend(host);
    }
    host.dataset.mode = mode;
    if (mode === 'ready') {
      host.innerHTML = '<strong>Human Review persistence connected.</strong><span>Only acknowledged and needs_review are durable. Viewed is session-only; approved/rejected remain fail-closed.</span>';
    } else if (mode === 'loading') {
      host.innerHTML = '<strong>Human Review persistence checking current scope…</strong><span>No optimistic review state is shown.</span>';
    } else if (mode === 'scope_required') {
      host.innerHTML = '<strong>Human Review persistence unavailable.</strong><span>Select a current store and date range first.</span>';
    } else {
      host.innerHTML = `<strong>Human Review persistence failed closed.</strong><span>${esc(detail || 'request_failed')}. Existing governed recommendations remain read-only; no durable state is inferred.</span>`;
    }
  }

  function handleClick(event) {
    const button = event.target.closest?.('[data-cfhr-set]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const requestedState = String(button.dataset.cfhrSet || '');
    const inboxItemId = String(button.dataset.cfhrItem || '');
    if (!DURABLE_STATES.has(requestedState) || !inboxItemId) return;
    void persistReview(inboxItemId, requestedState);
  }

  function resetScope() {
    state.requestId += 1;
    state.requestController?.abort();
    state.requestController = null;
    clearState();
    scheduleSync();
  }

  function clearState() {
    state.scopeKey = '';
    state.authority = null;
    state.reviews.clear();
    state.busy.clear();
    state.errors.clear();
  }

  function recommendationSection() {
    return state.panel?.querySelector('[data-csv-recommendation-inbox-workspace]') || null;
  }

  function currentScope() {
    const panel = state.panel;
    return {
      storeId: String(global.CloudflareOperatorContext?.getContext?.().storeId || global.CloudflareOperatorWorkspace?.currentStoreId?.() || '').trim(),
      startDate: value(panel, 'startDate'),
      endDate: value(panel, 'endDate'),
      profileId: value(panel, 'profileId'),
      limit: value(panel, 'limit') || '50',
      sort: value(panel, 'sort') || 'cost',
    };
  }

  function scopeKey(scope) {
    return [scope.storeId, scope.startDate, scope.endDate, scope.profileId, scope.limit, scope.sort].join('|');
  }

  function scopeComplete(scope) {
    return Boolean(scope.storeId && /^\d{4}-\d{2}-\d{2}$/.test(scope.startDate) && /^\d{4}-\d{2}-\d{2}$/.test(scope.endDate) && scope.startDate <= scope.endDate);
  }

  function currentSource() {
    return state.panel?.querySelector('[name="dataSource"]')?.value || 'csv';
  }

  function value(panel, name) {
    return String(panel?.querySelector(`[name="${name}"]`)?.value || '').trim();
  }

  function errorCode(error) {
    return String(error?.code || error?.message || 'request_failed').slice(0, 200);
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  }

  function injectStyles() {
    if (document.getElementById('cfhrStylesV1')) return;
    const style = document.createElement('style');
    style.id = 'cfhrStylesV1';
    style.textContent = `
      .cfhr-status{display:flex;gap:8px;align-items:center;margin:8px 0;padding:8px 10px;border:1px solid var(--line);border-radius:9px;background:var(--hover-bg);font-size:10px}.cfhr-status span{color:var(--muted)}
      .cfhr-status[data-mode="ready"]{border-color:color-mix(in srgb,#16a34a 35%,var(--line));background:color-mix(in srgb,#16a34a 7%,var(--card))}.cfhr-status[data-mode="failed"]{border-color:color-mix(in srgb,#dc2626 35%,var(--line));background:color-mix(in srgb,#dc2626 7%,var(--card))}
      [data-cfhr-review]{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:145px}.cfhr-state{display:inline-flex;padding:3px 6px;border-radius:6px;background:var(--hover-bg);font-weight:800}.cfhr-state.acknowledged{color:var(--good);background:var(--softGood)}.cfhr-state.needs_review{color:var(--warn);background:var(--softWarn)}.cfhr-state.unavailable{color:var(--bad);background:var(--softBad)}
      .cfhr-actions{display:flex;gap:4px;flex-wrap:wrap}.cfhr-actions .btn{padding:4px 6px;font-size:9px}.cfhr-busy{color:var(--muted)}.cfhr-error{display:block;color:var(--bad);font-size:9px;font-style:normal;overflow-wrap:anywhere}.cfhr-blocked{color:var(--muted)}
      .cfhr-drawer-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-bottom:8px}.cfhr-drawer-grid>div{padding:7px 8px;border:1px solid var(--line);border-radius:8px}.cfhr-drawer-grid span,.cfhr-drawer-grid strong{display:block}.cfhr-drawer-grid span{font-size:9px;color:var(--muted)}.cfhr-drawer-grid strong{margin-top:2px;font-size:10px;overflow-wrap:anywhere}
      @media(max-width:640px){.cfhr-status{align-items:flex-start;flex-direction:column}.cfhr-drawer-grid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }
})(globalThis);
