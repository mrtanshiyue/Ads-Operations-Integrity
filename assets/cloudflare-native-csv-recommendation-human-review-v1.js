(function initCsvRecommendationHumanReviewUi(global) {
  'use strict';

  const VERSION = '1.4.0';
  const CONTRACT_VERSION = 'csv-recommendation-human-review-v1';
  const DECISION_PACKET_VERSION = 'recommendation-decision-packet-v1';
  const CANDIDATE_LIBRARY_VERSION = 'governed-keyword-negative-candidate-library-v1';
  const HISTORICAL_LEARNING_VERSION = 'historical-review-learning-v1';
  const REQUEST_TIMEOUT_MS = 30000;
  const DURABLE_STATES = new Set(['acknowledged', 'needs_review', 'approved', 'rejected']);
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
    library: null,
    libraryItems: new Map(),
    historicalLearning: null,
    historicalCurrentByInboxItem: new Map(),
    libraryFilters: defaultLibraryFilters(),
    busy: new Set(),
    errors: new Map(),
  };

  Object.defineProperty(global, 'CloudflareCsvRecommendationHumanReviewUi', {
    value: Object.freeze({
      version: VERSION,
      contractVersion: CONTRACT_VERSION,
      decisionPacketVersion: DECISION_PACKET_VERSION,
      candidateLibraryVersion: CANDIDATE_LIBRARY_VERSION,
      historicalLearningVersion: HISTORICAL_LEARNING_VERSION,
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
    panel.addEventListener('change', handleChange);
    global.addEventListener?.('cloudflare-operator-store-change', resetScope);
    state.observer = new MutationObserver(scheduleSync);
    observePanel();
    scheduleSync();
  }

  function observePanel() {
    state.observer?.observe(state.panel, { childList: true, subtree: true });
  }

  function mutatePresentation(callback) {
    state.observer?.disconnect();
    try {
      return callback();
    } finally {
      observePanel();
    }
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
      clearPresentation();
      return;
    }
    const section = recommendationSection();
    if (!section) return;
    if (!suppressLegacyReviewFilter(section)) return;
    const scope = currentScope();
    if (!scopeComplete(scope)) {
      state.scopeKey = '';
      state.reviews.clear();
      state.library = null;
      state.libraryItems.clear();
      state.historicalLearning = null;
      state.historicalCurrentByInboxItem.clear();
      renderGlobalStatus(section, 'scope_required', null);
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
      state.library = payload.candidateLibrary;
      state.libraryItems = new Map((payload.candidateLibrary?.items || []).map((item) => [String(item?.inboxItemId || ''), item]).filter(([id]) => id));
      state.historicalLearning = payload.historicalLearning;
      state.historicalCurrentByInboxItem = new Map((payload.historicalLearning?.contexts || [])
        .filter((context) => context?.currentCandidateActive === true && String(context?.inboxItemId || ''))
        .map((context) => [String(context.inboxItemId), context]));
      renderGlobalStatus(recommendationSection(), 'ready', null);
      applySnapshot(recommendationSection());
    } catch (error) {
      if (requestId !== state.requestId) return;
      state.scopeKey = key;
      state.authority = null;
      state.reviews.clear();
      state.library = null;
      state.libraryItems.clear();
      state.historicalLearning = null;
      state.historicalCurrentByInboxItem.clear();
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
    const writeScopeKey = scopeKey(scope);
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
    const controller = new AbortController();
    const timeoutId = global.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const payload = await requestReview(scope, {
        method: 'POST',
        body: { inboxItemId, state: requestedState },
        signal: controller.signal,
      });
      validateWriteResponse(payload, scope.storeId);
      if (scopeKey(currentScope()) !== writeScopeKey) throw new Error('human_review_scope_changed_during_write');
      await loadSnapshot(scope, { force: true });
      const verified = state.reviews.get(inboxItemId);
      if (verified?.review?.persisted !== true || verified?.review?.state !== requestedState) {
        throw new Error('human_review_read_after_write_mismatch');
      }
    } catch (error) {
      state.errors.set(inboxItemId, errorCode(error));
      renderGlobalStatus(recommendationSection(), 'failed', errorCode(error));
    } finally {
      global.clearTimeout(timeoutId);
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
      if (!['unreviewed', 'acknowledged', 'needs_review', 'approved', 'rejected'].includes(reviewState)) throw new Error('human_review_state_unsupported');
      if (item?.review?.persisted === true && !DURABLE_STATES.has(reviewState)) throw new Error('human_review_persisted_state_invalid');
      validateDecisionPacket(item?.decisionPacket, item);
    }
    validateCandidateLibrary(payload?.candidateLibrary, payload.items, expectedStoreId);
    validateHistoricalLearning(payload?.historicalLearning, payload.items, expectedStoreId);
  }

  function validateDecisionPacket(packet, item) {
    if (packet?.schemaVersion !== DECISION_PACKET_VERSION) throw new Error('decision_packet_contract_version_mismatch');
    if (packet?.authority?.readOnly !== true) throw new Error('decision_packet_read_only_boundary_invalid');
    if (packet?.authority?.executionAuthorized !== false) throw new Error('decision_packet_execution_boundary_invalid');
    if (packet?.authority?.amazonMutationAuthorized !== false) throw new Error('decision_packet_amazon_boundary_invalid');
    if (String(packet?.recommendation?.inboxItemId || '') !== String(item?.inboxItemId || '')) throw new Error('decision_packet_item_identity_mismatch');
    if (!String(packet?.reviewEvidence?.currentFingerprint || '')) throw new Error('decision_packet_current_fingerprint_missing');
    const stale = Array.isArray(packet?.reviewEvidence?.staleEvidence) ? packet.reviewEvidence.staleEvidence : [];
    if (Number(packet?.reviewEvidence?.staleEvidenceCount) !== stale.length) throw new Error('decision_packet_stale_count_mismatch');
    if (stale.some((review) => review?.inheritedAsCurrent !== false || review?.stale !== true)) throw new Error('decision_packet_stale_inheritance_boundary_invalid');
  }

  function validateCandidateLibrary(library, reviewItems, expectedStoreId) {
    if (library?.schemaVersion !== CANDIDATE_LIBRARY_VERSION) throw new Error('candidate_library_contract_version_mismatch');
    if (String(library?.storeId || '') !== expectedStoreId) throw new Error('candidate_library_store_scope_mismatch');
    if (library?.authority?.readOnly !== true) throw new Error('candidate_library_read_only_boundary_invalid');
    if (library?.authority?.executionAuthorized !== false) throw new Error('candidate_library_execution_boundary_invalid');
    if (library?.authority?.amazonMutationAuthorized !== false) throw new Error('candidate_library_amazon_boundary_invalid');
    const available = library?.status?.available === true;
    const items = Array.isArray(library?.items) ? library.items : [];
    if (!available) {
      if (library?.status?.reasonCode !== 'candidate_emission_not_authorized') throw new Error('candidate_library_fail_closed_reason_missing');
      if (library?.summary?.candidateCount !== null || items.length !== 0) throw new Error('candidate_library_blocked_scope_not_null');
      return;
    }
    if (Number(library?.summary?.candidateCount) !== items.length) throw new Error('candidate_library_count_mismatch');
    const reviewById = new Map((reviewItems || []).map((item) => [String(item?.inboxItemId || ''), item]));
    if (items.length !== reviewById.size) throw new Error('candidate_library_review_item_coverage_mismatch');
    for (const item of items) {
      const reviewItem = reviewById.get(String(item?.inboxItemId || ''));
      if (!reviewItem) throw new Error('candidate_library_unknown_inbox_item');
      if (!['keyword', 'negative'].includes(String(item?.libraryFamily || ''))) throw new Error('candidate_library_family_invalid');
      if (!['harvest', 'scale', 'exact_negative', 'phrase_negative_review'].includes(String(item?.libraryKind || ''))) throw new Error('candidate_library_kind_invalid');
      if (String(item?.currentFingerprint || '') !== String(reviewItem?.recommendationFingerprint || '')) throw new Error('candidate_library_fingerprint_mismatch');
      if (String(item?.currentReviewState || '') !== String(reviewItem?.review?.state || 'unreviewed')) throw new Error('candidate_library_review_state_mismatch');
      if (item?.decisionPacketAvailable !== true) throw new Error('candidate_library_decision_packet_missing');
      if (item?.authority?.executionAuthorized !== false || item?.authority?.amazonMutationAuthorized !== false) throw new Error('candidate_library_item_authority_invalid');
    }
  }

  function validateHistoricalLearning(learning, reviewItems, expectedStoreId) {
    if (learning?.schemaVersion !== HISTORICAL_LEARNING_VERSION) throw new Error('historical_learning_contract_version_mismatch');
    if (String(learning?.storeId || '') !== expectedStoreId) throw new Error('historical_learning_store_scope_mismatch');
    const authority = learning?.authority || {};
    if (authority.readOnly !== true) throw new Error('historical_learning_read_only_boundary_invalid');
    for (const key of ['adaptiveLearningAuthorized', 'ruleMutationAuthorized', 'recommendationMutationAuthorized', 'executionAuthorized', 'amazonMutationAuthorized']) {
      if (authority[key] !== false) throw new Error(`historical_learning_${key}_boundary_invalid`);
    }
    const semantics = learning?.semantics || {};
    for (const key of ['recurrenceIsEffectiveness', 'acknowledgedMeansApproved', 'acknowledgedMeansExecuted', 'needsReviewMeansRejected', 'approvedMeansExecuted', 'approvedMeansSuccessful', 'rejectedMeansFailed', 'finalDispositionIsEffectiveness', 'historicalOutcomeAvailable', 'automaticFeedbackIntoRecommendations']) {
      if (semantics[key] !== false) throw new Error(`historical_learning_${key}_semantic_invalid`);
    }
    const contexts = Array.isArray(learning?.contexts) ? learning.contexts : null;
    if (!contexts) throw new Error('historical_learning_contexts_missing');
    const reviewById = new Map((reviewItems || []).map((item) => [String(item?.inboxItemId || ''), item]));
    const currentIds = new Set();
    for (const context of contexts) {
      if (context?.authority?.readOnly !== true || context?.authority?.executionAuthorized !== false || context?.authority?.amazonMutationAuthorized !== false) {
        throw new Error('historical_learning_context_authority_invalid');
      }
      if (typeof context?.recurrent !== 'boolean') throw new Error('historical_learning_recurrence_invalid');
      if (context?.currentCandidateActive === true) {
        const inboxItemId = String(context?.inboxItemId || '');
        const current = reviewById.get(inboxItemId);
        if (!current || currentIds.has(inboxItemId)) throw new Error('historical_learning_current_context_coverage_invalid');
        currentIds.add(inboxItemId);
        if (String(context?.currentFingerprint || '') !== String(current?.recommendationFingerprint || '')) throw new Error('historical_learning_current_fingerprint_mismatch');
        if (String(context?.currentReviewState || '') !== String(current?.review?.state || 'unreviewed')) throw new Error('historical_learning_current_review_state_mismatch');
        if (!nonNegativeInteger(context?.historicalRecordCount) || !nonNegativeInteger(context?.distinctFingerprintCount)
          || !nonNegativeInteger(context?.currentMatchedRecordCount) || !nonNegativeInteger(context?.staleEvidenceCount)) {
          throw new Error('historical_learning_current_counts_invalid');
        }
        if (typeof context?.currentEvidenceDrift !== 'boolean') throw new Error('historical_learning_current_drift_invalid');
      } else {
        for (const key of ['currentFingerprint', 'currentReviewState', 'currentReviewPersisted', 'currentMatchedRecordCount', 'staleEvidenceCount', 'currentEvidenceDrift']) {
          if (context?.[key] !== null) throw new Error('historical_learning_historical_only_current_state_invalid');
        }
      }
    }
    if (currentIds.size !== reviewById.size) throw new Error('historical_learning_current_item_coverage_mismatch');
    const summary = learning?.summary || {};
    for (const key of ['historicalRecordCount', 'usableHistoricalRecordCount', 'unusableHistoricalRecordCount', 'historicalContextCount', 'currentContextCount', 'recurrentContextCount', 'currentMatchedRecordCount', 'staleEvidenceRecordCount', 'historicalOnlyContextCount']) {
      if (!nonNegativeInteger(summary[key])) throw new Error('historical_learning_summary_count_invalid');
    }
    const historicalOnlyCount = contexts.filter((context) => context?.currentCandidateActive !== true && Number(context?.historicalRecordCount) > 0).length;
    if (summary.historicalOnlyContextCount !== historicalOnlyCount) throw new Error('historical_learning_historical_only_count_mismatch');
    if (summary.currentContextCount !== currentIds.size) throw new Error('historical_learning_current_count_mismatch');
  }

  function nonNegativeInteger(value) {
    return Number.isInteger(value) && value >= 0;
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
    if (durableStates.length !== 4 || !['acknowledged', 'needs_review', 'approved', 'rejected'].every((value) => durableStates.includes(value))) {
      throw new Error('human_review_durable_state_contract_invalid');
    }
    if (authority?.approvedRejectedPersistenceSupported !== true || authority?.finalDispositionReviewOnly !== true) {
      throw new Error('human_review_final_disposition_authority_invalid');
    }
  }

  function suppressLegacyReviewFilter(section) {
    const control = section?.querySelector('[data-cfri-filter="reviewState"]');
    if (!control) return true;
    let proceed = true;
    mutatePresentation(() => {
      const label = control.closest('label');
      if (control.value) {
        control.value = '';
        control.dispatchEvent(new Event('change', { bubbles: true }));
        proceed = false;
        return;
      }
      if (label) {
        label.hidden = true;
        label.dataset.cfhrLegacyReviewFilterSuppressed = 'true';
      }
      const meta = section.querySelector('.cfri-table-meta span:last-child');
      if (meta) meta.textContent = 'Durable review state comes from the server; viewed remains session-only. Legacy session review filtering is disabled in Human Review v1.';
    });
    return proceed;
  }

  function applySnapshot(section) {
    if (!section) return;
    mutatePresentation(() => {
      renderLibraryControls(section);
      for (const row of section.querySelectorAll('tr[data-cfri-item]')) {
        const inboxItemId = String(row.dataset.cfriItem || '');
        row.classList.toggle('cfgl-filtered-out', !libraryRowVisible(inboxItemId));
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
        const html = reviewCellHtml(inboxItemId, item, viewedThisSession);
        if (host.innerHTML !== html) host.innerHTML = html;
        cell.dataset.cfhrDurableState = String(item?.review?.state || 'unavailable');
      }
      renderDrawerPersistence(section);
    });
  }

  function renderLibraryControls(section) {
    let host = section.querySelector('[data-cfgl-library]');
    if (!host) {
      host = document.createElement('section');
      host.className = 'cfgl-library';
      host.dataset.cfglLibrary = '';
      const status = section.querySelector('[data-cfhr-status]');
      if (status) status.insertAdjacentElement('afterend', host);
      else section.prepend(host);
    }
    const library = state.library;
    const learning = state.historicalLearning;
    if (!library || !learning) {
      host.innerHTML = '<strong>Keyword / Negative Candidate Library + Historical Learning</strong><span>Server projection unavailable. No candidate class, review state, recurrence, or evidence drift is inferred client-side.</span>';
      host.dataset.mode = 'unavailable';
      return;
    }
    if (library?.status?.available !== true) {
      host.innerHTML = `<strong>Keyword / Negative Candidate Library unavailable.</strong><span>${esc(library?.status?.reasonCode || 'candidate_emission_not_authorized')} · governed candidate emission is blocked for this scope. Historical review records are not presented as current candidates.</span>${historicalSummaryHtml(learning)}`;
      host.dataset.mode = 'blocked';
      return;
    }
    host.dataset.mode = 'ready';
    const summary = library.summary || {};
    const filters = state.libraryFilters;
    host.innerHTML = `<div class="cfgl-head"><div><strong>Keyword / Negative Candidate Library</strong><span>${esc(display(summary.candidateCount))} candidates · ${esc(display(summary.keywordCount))} keyword · ${esc(display(summary.negativeCount))} negative · ${esc(display(summary.staleEvidenceCandidateCount))} with stale evidence</span></div><button type="button" class="btn" data-cfgl-reset>Reset filters</button></div>
      ${historicalSummaryHtml(learning)}
      <div class="cfgl-filters" role="group" aria-label="Governed candidate library filters">
        ${librarySelect('family', 'Family', filters.family, [['all','All'],['keyword','Keyword'],['negative','Negative']])}
        ${librarySelect('kind', 'Kind', filters.kind, [['all','All'],['harvest','Harvest'],['scale','Scale'],['exact_negative','Exact negative'],['phrase_negative_review','Phrase negative review']])}
        ${librarySelect('priority', 'Priority', filters.priority, [['all','All'],['critical','Critical'],['high','High'],['medium','Medium'],['low','Low']])}
        ${librarySelect('review', 'Review', filters.review, [['all','All'],['unreviewed','Unreviewed'],['needs_review','Needs review'],['acknowledged','Acknowledged'],['approved','Approved'],['rejected','Rejected']])}
        ${librarySelect('stale', 'Evidence', filters.stale, [['all','All'],['has_stale','Has stale evidence'],['no_stale','No stale evidence']])}
        ${librarySelect('history', 'History', filters.history, [['all','All'],['recurring','Recurring'],['no_history','No review history']])}
      </div><small>Server-projected registry and historical review intelligence only. Filters change row visibility; they do not recompute recommendations, fingerprints, review state, evidence, rules, or learning weights.</small>`;
  }

  function historicalSummaryHtml(learning) {
    const summary = learning?.summary || {};
    const historicalOnly = (learning?.contexts || []).filter((context) => context?.currentCandidateActive !== true && Number(context?.historicalRecordCount) > 0);
    return `<div class="cfhl-summary" data-cfhl-summary>
      <strong>Historical Review Learning</strong>
      <span>${esc(display(summary.historicalRecordCount))} historical reviews · ${esc(display(summary.recurrentContextCount))} recurrent contexts · ${esc(display(summary.staleEvidenceRecordCount))} stale-evidence records · ${esc(display(summary.historicalOnlyContextCount))} historical-only contexts</span>
      ${historicalOnly.length ? `<details data-cfhl-historical-only><summary>${historicalOnly.length} historical-only context${historicalOnly.length === 1 ? '' : 's'}</summary>${historicalOnly.map(historicalOnlyContextHtml).join('')}</details>` : '<small>No historical-only review contexts.</small>'}
      <small>Recurrence and final disposition are not effectiveness. Approved is not executed or successful; rejected is not failed. Historical Learning never changes recommendation rules or execution authority.</small>
    </div>`;
  }

  function historicalOnlyContextHtml(context) {
    return `<div class="cfhl-historical-only"><strong>${esc(context.value || context.inboxItemId || 'Historical context')}</strong><span>${esc(context.actionType || 'unknown action')} · ${esc(display(context.historicalRecordCount))} review record${Number(context.historicalRecordCount) === 1 ? '' : 's'} · latest ${esc(context.latestObservedAt || 'unavailable')}</span></div>`;
  }

  function librarySelect(key, label, selected, options) {
    return `<label><span>${esc(label)}</span><select data-cfgl-filter="${esc(key)}">${options.map(([value, text]) => `<option value="${esc(value)}"${selected === value ? ' selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`;
  }

  function libraryRowVisible(inboxItemId) {
    const library = state.library;
    if (!library || library?.status?.available !== true) return true;
    const item = state.libraryItems.get(inboxItemId);
    if (!item) return false;
    const learning = state.historicalCurrentByInboxItem.get(inboxItemId);
    const filters = state.libraryFilters;
    if (filters.family !== 'all' && item.libraryFamily !== filters.family) return false;
    if (filters.kind !== 'all' && item.libraryKind !== filters.kind) return false;
    if (filters.priority !== 'all' && item.priority !== filters.priority) return false;
    if (filters.review !== 'all' && item.currentReviewState !== filters.review) return false;
    if (filters.stale === 'has_stale' && Number(item.staleEvidenceCount) <= 0) return false;
    if (filters.stale === 'no_stale' && Number(item.staleEvidenceCount) > 0) return false;
    if (filters.history === 'recurring' && learning?.recurrent !== true) return false;
    if (filters.history === 'no_history' && Number(learning?.historicalRecordCount) !== 0) return false;
    return true;
  }

  function reviewCellHtml(inboxItemId, item, viewedThisSession) {
    const busy = state.busy.has(inboxItemId);
    const error = state.errors.get(inboxItemId) || '';
    if (!item) {
      return `<span class="cfhr-state unavailable">unavailable</span><small>Persistence snapshot unavailable${viewedThisSession ? ' · viewed this session' : ''}</small>${error ? `<em class="cfhr-error" role="alert">${esc(error)}</em>` : ''}`;
    }
    const review = item.review || {};
    const reviewState = String(review.state || 'unreviewed');
    const persisted = review.persisted === true;
    const allowed = item.persistenceAuthorized === true;
    const staleCount = Number(item?.decisionPacket?.reviewEvidence?.staleEvidenceCount ?? (Array.isArray(item.staleReviewIds) ? item.staleReviewIds.length : 0));
    const learning = state.historicalCurrentByInboxItem.get(inboxItemId);
    const historicalCount = Number(learning?.historicalRecordCount || 0);
    const historyMeta = ` · ${historicalCount} historical review record${historicalCount === 1 ? '' : 's'}${learning?.recurrent === true ? ' · recurring' : ''}`;
    const status = `<span class="cfhr-state ${esc(reviewState)}">${esc(reviewState)}</span><small>${persisted ? 'persisted' : 'not persisted'}${viewedThisSession ? ' · viewed this session' : ''}${staleCount ? ` · ${staleCount} stale prior evidence record${staleCount === 1 ? '' : 's'}` : ''}${historyMeta}</small>`;
    const controls = allowed
      ? `<div class="cfhr-actions" role="group" aria-label="Human review actions">
          <button type="button" class="btn" data-cfhr-set="needs_review" data-cfhr-item="${esc(inboxItemId)}"${busy ? ' disabled' : ''}>Needs review</button>
          <button type="button" class="btn" data-cfhr-set="acknowledged" data-cfhr-item="${esc(inboxItemId)}"${busy ? ' disabled' : ''}>Acknowledge</button>
<button type="button" class="btn" data-cfhr-set="approved" data-cfhr-item="${esc(inboxItemId)}"${busy ? ' disabled' : ''}>Approve review decision</button>
<button type="button" class="btn" data-cfhr-set="rejected" data-cfhr-item="${esc(inboxItemId)}"${busy ? ' disabled' : ''}>Reject review decision</button>
<small class="cfhr-boundary">Approved / Rejected are Human Review dispositions only. They do not execute Amazon changes.</small>
        </div>`
      : '<small class="cfhr-blocked">Durable review is not authorized for this candidate.</small>';
    return `${status}${controls}${busy ? '<small class="cfhr-busy" role="status">Saving and verifying…</small>' : ''}${error ? `<em class="cfhr-error" role="alert">${esc(error)}</em>` : ''}`;
  }

  function renderDrawerPersistence(section) {
    const drawer = section.querySelector('[data-cfri-drawer]');
    const scroll = drawer?.querySelector('.cfri-drawer-scroll');
    const title = drawer?.querySelector('#cfriDrawerTitle');
    if (!scroll || !title || drawer.hidden) return;
    const item = currentDrawerReview(section);
    let block = scroll.querySelector('[data-cfhr-drawer]');
    if (!block) {
      block = document.createElement('section');
      block.className = 'cfri-drawer-section cfhr-drawer-section';
      block.dataset.cfhrDrawer = '';
      scroll.appendChild(block);
    }
    const html = item
      ? `${decisionPacketHtml(item.decisionPacket)}${historicalLearningDrawerHtml(item.inboxItemId)}<h4>Durable Human Review</h4><div class="cfhr-drawer-grid">
          <div><span>State</span><strong>${esc(item.review?.state || 'unreviewed')}</strong></div>
          <div><span>Persisted</span><strong>${item.review?.persisted === true ? 'yes' : 'no'}</strong></div>
          <div><span>Reviewer</span><strong>${esc(item.review?.reviewerUserId || '—')}</strong></div>
          <div><span>Updated</span><strong>${esc(item.review?.updatedAt || '—')}</strong></div>
        </div><div class="cfri-callout warn"><strong>Authority boundary:</strong> Acknowledged / needs-review / approved / rejected are Human Review states only. Approved does not approve an Optimization Action, create an execution permit, or authorize an Amazon mutation.</div>`
      : '<h4>Recommendation Decision Packet</h4><div class="cfri-callout warn"><strong>Packet unavailable.</strong> No recommendation, review state, financial evidence, historical learning, or provenance is inferred from the presentation layer.</div>';
    if (block.innerHTML !== html) block.innerHTML = html;
  }

  function historicalLearningDrawerHtml(inboxItemId) {
    const context = state.historicalCurrentByInboxItem.get(String(inboxItemId || ''));
    if (!context) {
      return '<div class="cfhl-drawer"><h4>Historical Review Learning</h4><div class="cfri-callout warn"><strong>Historical context unavailable.</strong> The UI does not reconstruct recurrence or evidence drift.</div></div>';
    }
    return `<div class="cfhl-drawer" data-cfhl-drawer><h4>Historical Review Learning</h4><div class="cfhr-drawer-grid">
      <div><span>Historical reviews</span><strong>${esc(display(context.historicalRecordCount))}</strong></div>
      <div><span>Distinct fingerprints</span><strong>${esc(display(context.distinctFingerprintCount))}</strong></div>
      <div><span>Current fingerprint matches</span><strong>${esc(display(context.currentMatchedRecordCount))}</strong></div>
      <div><span>Stale evidence</span><strong>${esc(display(context.staleEvidenceCount))}</strong></div>
      <div><span>Acknowledged / Needs review</span><strong>${esc(display(context.acknowledgedCount))} / ${esc(display(context.needsReviewCount))}</strong></div>
      <div><span>Approved / Rejected</span><strong>${esc(display(context.approvedCount))} / ${esc(display(context.rejectedCount))}</strong></div>
      <div><span>Recurring / Evidence drift</span><strong>${esc(display(context.recurrent))} / ${esc(display(context.currentEvidenceDrift))}</strong></div>
      <div><span>First observed</span><strong>${esc(context.firstObservedAt || 'unavailable')}</strong></div>
      <div><span>Latest observed</span><strong>${esc(context.latestObservedAt || 'unavailable')}</strong></div>
    </div><div class="cfri-callout warn"><strong>Learning boundary:</strong> Recurrence and evidence drift are historical review context only, not effectiveness. No learning weight, rule mutation, recommendation mutation, execution, or Amazon authority is created.</div></div>`;
  }

  function decisionPacketHtml(packet) {
    if (packet?.schemaVersion !== DECISION_PACKET_VERSION) {
      return '<h4>Recommendation Decision Packet</h4><div class="cfri-callout warn"><strong>Server packet unavailable.</strong> The UI will not reconstruct recommendation evidence client-side.</div>';
    }
    const recommendation = packet.recommendation || {};
    const why = packet.why || {};
    const priority = packet.priorityEvidence || {};
    const financial = packet.financialComparability || {};
    const review = packet.reviewEvidence || {};
    const source = packet.sourceEvidence || {};
    const roots = Array.isArray(packet?.root?.impactedRoots) ? packet.root.impactedRoots : [];
    const lifecycle = Array.isArray(packet?.lifecycle?.items) ? packet.lifecycle.items : [];
    const stale = Array.isArray(review.staleEvidence) ? review.staleEvidence : [];
    return `<div class="cfdp" data-cfdp-packet>
      <h4>Recommendation Decision Packet</h4>
      <div class="cfdp-section"><h5>1. Recommendation + Why</h5><div class="cfhr-drawer-grid">
        <div><span>Recommendation</span><strong>${esc(recommendation.actionType || '—')} · ${esc(recommendation.value || '—')}</strong></div>
        <div><span>Candidate</span><strong>${esc(recommendation.candidateType || '—')} / ${esc(recommendation.matchScope || '—')}</strong></div>
      </div><p>${esc(why.reason || 'No reason supplied by the server')}</p></div>
      <div class="cfdp-section"><h5>2. Priority evidence</h5><div class="cfhr-drawer-grid">
        <div><span>Priority</span><strong>${esc(display(priority.priority))} · score ${esc(display(priority.priorityScore))}</strong></div>
        <div><span>Spend / Sales</span><strong>${esc(display(priority.spendMicros))} / ${esc(display(priority.salesMicros))}</strong></div>
        <div><span>Orders / Clicks</span><strong>${esc(display(priority.orders))} / ${esc(display(priority.clicks))}</strong></div>
        <div><span>ACOS / CVR</span><strong>${esc(display(priority.acos))} / ${esc(display(priority.cvr))}</strong></div>
      </div></div>
      <div class="cfdp-section"><h5>3. Root + Lifecycle</h5>${contextList('Root', roots, (row) => `${row.root || '—'} · ${row.primaryState || (Array.isArray(row.states) ? row.states.join(', ') : '—')}`)}${contextList('Lifecycle', lifecycle, (row) => `${row.searchTerm || '—'} · ${row.state || '—'} · ${row.previousClassification || '—'} → ${row.currentClassification || '—'}`)}</div>
      <div class="cfdp-section"><h5>4. Financial comparability</h5><div class="cfhr-drawer-grid">
        <div><span>Financially comparable</span><strong>${esc(display(financial.financiallyComparable))}</strong></div>
        <div><span>Analysis scope complete</span><strong>${esc(display(financial.analysisScopeComplete))}</strong></div>
      </div>${financial.reasons?.length ? `<small>${esc(financial.reasons.join(' · '))}</small>` : ''}</div>
      <div class="cfdp-section"><h5>5. Fingerprint + review evidence</h5><div class="cfdp-evidence"><span>Current fingerprint</span><code>${esc(review.currentFingerprint || '—')}</code><span>Prior review state</span><strong>${esc(review.priorReviewState || 'unreviewed')}</strong><span>Stale evidence</span><strong>${stale.length}</strong></div>${staleEvidenceHtml(stale)}</div>
      <div class="cfdp-section"><h5>6. Source evidence / provenance</h5><div class="cfdp-evidence"><span>Source evidence SHA-256</span><code>${esc(source.sourceEvidenceSha256 || '—')}</code><span>Provenance gate</span><strong>${esc(source.provenanceGate || '—')}</strong><span>Analysis window</span><strong>${esc(source.analysisWindow ? `${source.analysisWindow.startDate} → ${source.analysisWindow.endDate}` : '—')}</strong><span>Source imports</span><strong>${esc(Array.isArray(source.sourceImportIds) && source.sourceImportIds.length ? source.sourceImportIds.join(', ') : '—')}</strong></div><details><summary>Bound source evidence</summary><pre>${esc(source.sourceEvidenceJson || 'null')}</pre></details></div>
      <div class="cfri-callout warn"><strong>Read-only packet:</strong> This is server-authoritative review context only. No auto acknowledge, auto approve, Optimization Action, execution permit, Store Score, or Amazon mutation is authorized.</div>
    </div>`;
  }

  function contextList(label, rows, line) {
    if (!rows.length) return `<p><strong>${esc(label)}:</strong> unavailable</p>`;
    return `<div class="cfdp-list"><strong>${esc(label)}</strong>${rows.map((row) => `<span>${esc(line(row))}</span>`).join('')}</div>`;
  }

  function staleEvidenceHtml(rows) {
    if (!rows.length) return '<small>No same-context stale review evidence.</small>';
    return `<details><summary>${rows.length} stale prior evidence record${rows.length === 1 ? '' : 's'}</summary>${rows.map((row) => `<div class="cfdp-stale"><strong>${esc(row.state || 'unsupported')}</strong><code>${esc(row.recommendationFingerprint || '—')}</code><small>${esc(row.updatedAt || row.reviewedAt || '—')} · never inherited as current</small></div>`).join('')}</details>`;
  }

  function display(value) {
    if (value === null || value === undefined || value === '') return 'unavailable';
    if (value === true) return 'yes';
    if (value === false) return 'no';
    return String(value);
  }

  function currentDrawerReview(section) {
    const drawer = section.querySelector('[data-cfri-drawer]');
    if (!drawer || drawer.hidden) return null;
    const inboxPair = [...drawer.querySelectorAll('.cfri-dl > div')]
      .find((node) => String(node.querySelector('dt')?.textContent || '').trim() === 'Inbox item ID');
    const inboxItemId = String(inboxPair?.querySelector('dd')?.textContent || '').trim();
    return inboxItemId ? state.reviews.get(inboxItemId) || null : null;
  }

  function renderGlobalStatus(section, mode, detail) {
    if (!section) return;
    mutatePresentation(() => {
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
      const html = mode === 'ready'
        ? '<strong>Human Review + Decision Packet + Candidate Library + Historical Learning connected.</strong><span>All review, library, recurrence, and evidence-drift context is server-projected. Historical recurrence is not effectiveness; execution and Amazon mutation remain disabled.</span>'
        : mode === 'loading'
          ? '<strong>Human Review / Decision Packet / Candidate Library / Historical Learning checking current scope…</strong><span>No optimistic review, reconstructed evidence, or inferred learning state is shown.</span>'
          : mode === 'scope_required'
            ? '<strong>Human Review / Decision Packet / Candidate Library / Historical Learning unavailable.</strong><span>Select a current store and date range first.</span>'
            : `<strong>Human Review / Decision Packet / Candidate Library / Historical Learning failed closed.</strong><span>${esc(detail || 'request_failed')}. Existing governed recommendations remain read-only; no review, evidence, library, or learning state is inferred.</span>`;
      if (host.innerHTML !== html) host.innerHTML = html;
    });
  }

  function handleClick(event) {
    const reset = event.target.closest?.('[data-cfgl-reset]');
    if (reset) {
      event.preventDefault();
      event.stopPropagation();
      state.libraryFilters = defaultLibraryFilters();
      applySnapshot(recommendationSection());
      return;
    }
    const button = event.target.closest?.('[data-cfhr-set]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const requestedState = String(button.dataset.cfhrSet || '');
    const inboxItemId = String(button.dataset.cfhrItem || '');
    if (!DURABLE_STATES.has(requestedState) || !inboxItemId) return;
    void persistReview(inboxItemId, requestedState);
  }

  function handleChange(event) {
    const control = event.target.closest?.('[data-cfgl-filter]');
    if (!control) return;
    const key = String(control.dataset.cfglFilter || '');
    if (!Object.prototype.hasOwnProperty.call(state.libraryFilters, key)) return;
    state.libraryFilters = { ...state.libraryFilters, [key]: String(control.value || 'all') };
    applySnapshot(recommendationSection());
  }

  function resetScope() {
    state.requestId += 1;
    state.requestController?.abort();
    state.requestController = null;
    clearState();
    clearPresentation();
    scheduleSync();
  }

  function clearState() {
    state.scopeKey = '';
    state.authority = null;
    state.reviews.clear();
    state.library = null;
    state.libraryItems.clear();
    state.historicalLearning = null;
    state.historicalCurrentByInboxItem.clear();
    state.libraryFilters = defaultLibraryFilters();
    state.busy.clear();
    state.errors.clear();
  }

  function clearPresentation() {
    const section = recommendationSection();
    if (!section) return;
    mutatePresentation(() => {
      section.querySelectorAll('[data-cfhr-status],[data-cfhr-review],[data-cfhr-drawer],[data-cfgl-library]').forEach((node) => node.remove());
      section.querySelectorAll('tr.cfgl-filtered-out').forEach((row) => row.classList.remove('cfgl-filtered-out'));
      section.querySelectorAll('.cfri-review[hidden]').forEach((node) => { node.hidden = false; });
      section.querySelectorAll('.cfri-review + small[hidden]').forEach((node) => { node.hidden = false; });
      section.querySelectorAll('[data-cfhr-durable-state]').forEach((node) => delete node.dataset.cfhrDurableState);
      const control = section.querySelector('[data-cfri-filter="reviewState"]');
      const label = control?.closest('label');
      if (label?.dataset.cfhrLegacyReviewFilterSuppressed === 'true') {
        label.hidden = false;
        delete label.dataset.cfhrLegacyReviewFilterSuppressed;
      }
    });
  }

  function defaultLibraryFilters() {
    return { family: 'all', kind: 'all', priority: 'all', review: 'all', stale: 'all', history: 'all' };
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
      .cfgl-library{display:flex;flex-direction:column;gap:7px;margin:8px 0;padding:9px 10px;border:1px solid var(--line);border-radius:10px;background:var(--card)}.cfgl-library>span,.cfgl-library small,.cfgl-head span{font-size:9px;color:var(--muted)}.cfgl-head{display:flex;justify-content:space-between;align-items:center;gap:8px}.cfgl-head>div{display:flex;flex-direction:column;gap:2px}.cfgl-head .btn{padding:4px 7px;font-size:9px}.cfgl-filters{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px}.cfgl-filters label{display:flex;flex-direction:column;gap:3px}.cfgl-filters label span{font-size:8px;color:var(--muted)}.cfgl-filters select{width:100%;min-width:0;padding:5px 6px;border:1px solid var(--line);border-radius:7px;background:var(--input-bg);color:var(--text);font-size:9px}.cfgl-filtered-out{display:none!important}.cfgl-library[data-mode="blocked"],.cfgl-library[data-mode="unavailable"]{border-color:color-mix(in srgb,var(--warn) 35%,var(--line));background:color-mix(in srgb,var(--warn) 6%,var(--card))}
      .cfhl-summary{display:flex;flex-direction:column;gap:4px;padding:7px 8px;border:1px solid var(--line);border-radius:8px;background:var(--hover-bg)}.cfhl-summary>span,.cfhl-summary small,.cfhl-historical-only span{font-size:9px;color:var(--muted)}.cfhl-summary details{margin-top:2px}.cfhl-summary summary{cursor:pointer;font-size:9px;font-weight:700}.cfhl-historical-only{display:flex;flex-direction:column;gap:2px;padding:6px 0;border-bottom:1px solid var(--line)}.cfhl-historical-only strong{font-size:9px}.cfhl-drawer{margin:10px 0}.cfhl-drawer h4{margin:0 0 7px}
      [data-cfhr-review]{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:145px}.cfhr-state{display:inline-flex;padding:3px 6px;border-radius:6px;background:var(--hover-bg);font-weight:800}.cfhr-state.acknowledged{color:var(--good);background:var(--softGood)}.cfhr-state.needs_review{color:var(--warn);background:var(--softWarn)}.cfhr-state.unavailable{color:var(--bad);background:var(--softBad)}
      .cfhr-actions{display:flex;gap:4px;flex-wrap:wrap}.cfhr-actions .btn{padding:4px 6px;font-size:9px}.cfhr-busy{color:var(--muted)}.cfhr-error{display:block;color:var(--bad);font-size:9px;font-style:normal;overflow-wrap:anywhere}.cfhr-blocked{color:var(--muted)}
      .cfhr-drawer-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-bottom:8px}.cfhr-drawer-grid>div{padding:7px 8px;border:1px solid var(--line);border-radius:8px}.cfhr-drawer-grid span,.cfhr-drawer-grid strong{display:block}.cfhr-drawer-grid span{font-size:9px;color:var(--muted)}.cfhr-drawer-grid strong{margin-top:2px;font-size:10px;overflow-wrap:anywhere}
      .cfdp{display:flex;flex-direction:column;gap:9px;margin-bottom:12px}.cfdp h4{margin:0}.cfdp-section{padding:9px;border:1px solid var(--line);border-radius:9px;background:var(--card)}.cfdp-section h5{margin:0 0 7px;font-size:10px}.cfdp-section p,.cfdp-section small{margin:5px 0;color:var(--muted);font-size:9px}.cfdp-list{display:grid;gap:4px;margin-top:5px}.cfdp-list>strong{font-size:9px}.cfdp-list>span{font-size:9px;color:var(--muted)}.cfdp-evidence{display:grid;grid-template-columns:minmax(100px,auto) minmax(0,1fr);gap:5px 8px;align-items:start}.cfdp-evidence span{font-size:9px;color:var(--muted)}.cfdp-evidence strong,.cfdp-evidence code{font-size:9px;overflow-wrap:anywhere}.cfdp details{margin-top:7px}.cfdp summary{cursor:pointer;font-size:9px;font-weight:700}.cfdp pre{max-height:180px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;padding:7px;border:1px solid var(--line);border-radius:7px;font-size:8px}.cfdp-stale{display:grid;gap:3px;padding:6px 0;border-bottom:1px solid var(--line)}.cfdp-stale code{overflow-wrap:anywhere;font-size:8px}
      @media(max-width:1050px){.cfgl-filters{grid-template-columns:repeat(3,minmax(0,1fr))}}
      @media(max-width:640px){.cfhr-status{align-items:flex-start;flex-direction:column}.cfhr-drawer-grid{grid-template-columns:1fr}.cfdp-evidence{grid-template-columns:1fr}.cfgl-head{align-items:flex-start;flex-direction:column}.cfgl-filters{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }
})(globalThis);
