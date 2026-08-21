(function initCsvRecommendationInboxUi(global) {
  'use strict';

  const VERSION = '1.0.0';
  const SCHEMA_VERSION = 'csv-recommendation-inbox-v1';
  const REQUEST_TIMEOUT_MS = 30000;
  const STYLE_ID = 'cfriStylesV1';
  const state = {
    mounted: false,
    panel: null,
    resultsObserver: null,
    syncTimer: null,
    requestId: 0,
    requestController: null,
    scopeKey: '',
    inbox: null,
    context: null,
    viewed: new Set(),
    filters: {
      priority: '',
      candidateType: '',
      lifecycle: '',
      root: '',
      reviewState: '',
      search: '',
      sort: 'priority',
    },
  };

  Object.defineProperty(global, 'CloudflareCsvRecommendationInboxUi', {
    value: Object.freeze({
      version: VERSION,
      schemaVersion: SCHEMA_VERSION,
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
    panel.dataset.csvRecommendationInboxUiVersion = VERSION;
    panel.addEventListener('click', handleClick);
    panel.addEventListener('input', handleFilterEvent);
    panel.addEventListener('change', handleFilterEvent);
    document.addEventListener('keydown', handleKeydown);
    global.addEventListener?.('cloudflare-operator-store-change', resetForStoreChange);
    observeResults(panel);
    scheduleSync();
  }

  function observeResults(panel) {
    const results = panel.querySelector('[data-results]');
    if (!results) {
      const observer = new MutationObserver(() => {
        const next = panel.querySelector('[data-results]');
        if (!next) return;
        observer.disconnect();
        observeResults(panel);
        scheduleSync();
      });
      observer.observe(panel, { childList: true, subtree: true });
      return;
    }
    state.resultsObserver?.disconnect();
    state.resultsObserver = new MutationObserver(() => scheduleSync());
    state.resultsObserver.observe(results, { childList: true });
  }

  function scheduleSync() {
    if (state.syncTimer) global.clearTimeout(state.syncTimer);
    state.syncTimer = global.setTimeout(() => {
      state.syncTimer = null;
      syncWorkspace();
    }, 40);
  }

  function syncWorkspace() {
    const panel = state.panel;
    if (!panel) return;
    const workspace = panel.querySelector('[data-csv-operator-workspace]');
    if (!workspace || currentSource() !== 'csv') return;
    ensureSection(workspace);
    void refresh(false);
  }

  function ensureSection(workspace) {
    let section = workspace.querySelector('[data-csv-recommendation-inbox-workspace]');
    if (section) return section;
    section = document.createElement('section');
    section.className = 'cfdi-detail-section cfri-section';
    section.dataset.csvRecommendationInboxWorkspace = '';
    section.innerHTML = loadingShell('Recommendation Inbox is loading the governed review contract…');
    const scope = workspace.querySelector('[data-csv-scope-health]');
    if (scope) scope.insertAdjacentElement('afterend', section);
    else workspace.prepend(section);
    return section;
  }

  async function refresh(force) {
    const panel = state.panel;
    const workspace = panel?.querySelector('[data-csv-operator-workspace]');
    if (!panel || !workspace || currentSource() !== 'csv') return;
    const section = ensureSection(workspace);
    const storeId = currentStoreId();
    const startDate = value(panel, 'startDate');
    const endDate = value(panel, 'endDate');
    if (!storeId || !startDate || !endDate) {
      state.scopeKey = '';
      state.inbox = null;
      state.context = null;
      section.innerHTML = emptyShell('Select a store and a valid Start / End date in Search Term Intelligence first.');
      return;
    }

    const limit = value(panel, 'limit') || '50';
    const sort = value(panel, 'sort') || 'cost';
    const scopeKey = [storeId, startDate, endDate, limit, sort].join('|');
    if (!force && state.scopeKey === scopeKey && state.inbox) {
      renderInbox();
      return;
    }

    state.requestController?.abort();
    const controller = new AbortController();
    const requestId = ++state.requestId;
    state.requestController = controller;
    section.innerHTML = loadingShell('Loading governed Recommendation Inbox for the current store and date scope…');

    const params = new URLSearchParams({ source: 'csv', startDate, endDate, limit, sort });
    const profileId = value(panel, 'profileId');
    if (profileId) params.set('profileId', profileId);

    let timeoutId = null;
    try {
      timeoutId = global.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const payload = await requestJson(
        `/api/v1/stores/${encodeURIComponent(storeId)}/search-term-intelligence?${params}`,
        controller.signal,
      );
      if (requestId !== state.requestId) return;
      const productization = payload?.productization || {};
      const inbox = productization.recommendationInbox;
      if (!inbox || inbox.schemaVersion !== SCHEMA_VERSION) {
        state.scopeKey = '';
        state.inbox = null;
        state.context = null;
        section.innerHTML = failClosedShell(
          `Expected ${SCHEMA_VERSION}, but the governed Recommendation Inbox contract is unavailable. No recommendation is inferred from diagnostic observations.`,
        );
        return;
      }

      const currencyCodes = productization.analysisScope?.currencyCodes || [];
      state.scopeKey = scopeKey;
      state.inbox = inbox;
      state.context = {
        storeId,
        startDate,
        endDate,
        currency: Array.isArray(currencyCodes) && currencyCodes.length === 1 ? String(currencyCodes[0] || '') : '',
        productizationScope: productization.analysisScope || {},
      };
      state.viewed.clear();
      normalizeFilterState(inbox.items || []);
      renderInbox();
    } catch (error) {
      if (requestId !== state.requestId) return;
      state.scopeKey = '';
      state.inbox = null;
      state.context = null;
      const message = controller.signal.aborted
        ? 'Recommendation Inbox read timed out. No data was changed.'
        : (error?.message || 'Recommendation Inbox read failed.');
      section.innerHTML = failClosedShell(message);
    } finally {
      if (timeoutId !== null) global.clearTimeout(timeoutId);
      if (requestId === state.requestId) state.requestController = null;
    }
  }

  function renderInbox() {
    const section = state.panel?.querySelector('[data-csv-recommendation-inbox-workspace]');
    const inbox = state.inbox;
    if (!section || !inbox) return;
    const items = Array.isArray(inbox.items) ? inbox.items : [];
    const summary = inbox.summary || {};
    const scope = inbox.analysisScope || {};
    const priorityCounts = summary.priorityCounts || {};
    const blocked = Number(summary.blockedByGovernanceCount || 0) + Number(summary.blockedByScopeCount || 0);
    const scopeReasons = Array.isArray(scope.reasons) && scope.reasons.length ? scope.reasons.join(', ') : 'none';

    section.innerHTML = `<div class="cfri-head">
      <div>
        <div class="cfri-eyebrow">CSV DECISION INTELLIGENCE · HUMAN REVIEW ONLY</div>
        <h3>Recommendation Inbox <small>${formatNumber(summary.reviewCandidateCount || items.length)}</small></h3>
        <p>Only governed candidates enter this workspace. Diagnostic observations, review approval, persistence, and Amazon execution remain separate states.</p>
      </div>
      <div class="cfri-head-actions">
        <span class="cfri-badge safe">Read only</span>
        <span class="cfri-badge danger">Amazon execution disabled</span>
        <button type="button" class="btn" data-cfri-refresh>Refresh Inbox</button>
      </div>
    </div>

    <div class="cfri-summary" data-cfri-summary>
      ${summaryCard('Review candidates', summary.reviewCandidateCount || items.length)}
      ${summaryCard('Critical + High', Number(priorityCounts.critical || 0) + Number(priorityCounts.high || 0))}
      ${summaryCard('Governance blocked', summary.blockedByGovernanceCount || 0)}
      ${summaryCard('Scope blocked', summary.blockedByScopeCount || 0)}
      ${summaryCard('Unreviewed', summary.reviewStateCounts?.unreviewed ?? items.length)}
      ${summaryCard('Suppressed total', blocked)}
    </div>

    <div class="cfri-safety-grid">
      ${statusCard('Universe', scope.complete === true ? 'Complete' : 'Incomplete', scope.complete === true ? 'safe' : 'warn')}
      ${statusCard('Financials', scope.financiallyComparable === true ? 'Comparable' : 'Suppressed', scope.financiallyComparable === true ? 'safe' : 'warn')}
      ${statusCard('Candidate emission', scope.candidateEmissionAuthorized === true ? 'Review authorized' : 'Blocked', scope.candidateEmissionAuthorized === true ? 'safe' : 'warn')}
      ${statusCard('Persistence', inbox.authority?.governancePersistenceAllowed === true ? 'Allowed' : 'Disabled', inbox.authority?.governancePersistenceAllowed === true ? 'warn' : 'safe')}
      ${statusCard('Amazon mutation', inbox.authority?.amazonMutationAuthorized === true ? 'Authorized' : 'Disabled', inbox.authority?.amazonMutationAuthorized === true ? 'danger' : 'safe')}
    </div>

    <div class="cfri-callout ${scope.candidateEmissionAuthorized === true ? '' : 'warn'}">
      <strong>Governance:</strong> ${scope.candidateEmissionAuthorized === true
        ? 'The current analysis scope is eligible to emit governed candidates for human review.'
        : 'Fail-closed candidate emission is active; observations are not promoted into recommendations.'}
      <span> Scope reasons: ${esc(scopeReasons)}.</span>
    </div>

    <div class="cfri-callout neutral">
      <strong>Contract fidelity:</strong> ${SCHEMA_VERSION} does not expose campaign/ad-group fields or a recommendation-confidence field. This UI does not invent them; it shows priority score and identity-confidence evidence separately. Date scope follows the existing Search Term Intelligence controls.
    </div>

    <div class="cfri-controls" data-cfri-controls>
      <label>Priority<select data-cfri-filter="priority">${options(priorityOptions(items), state.filters.priority, 'All priorities')}</select></label>
      <label>Candidate type<select data-cfri-filter="candidateType">${options(unique(items.map((item) => item?.candidateType)), state.filters.candidateType, 'All candidate types')}</select></label>
      <label>Lifecycle<select data-cfri-filter="lifecycle">${options(unique(items.flatMap((item) => (item?.lifecycleContext || []).map((entry) => entry?.state))), state.filters.lifecycle, 'All lifecycle states')}</select></label>
      <label>Root<select data-cfri-filter="root">${options(unique(items.flatMap((item) => (item?.impactedRoots || []).map((entry) => entry?.root))), state.filters.root, 'All roots')}</select></label>
      <label>Review state<select data-cfri-filter="reviewState">${options(reviewStateOptions(items), state.filters.reviewState, 'All review states')}</select></label>
      <label class="cfri-search">Search term / reason<input type="search" data-cfri-filter="search" value="${esc(state.filters.search)}" placeholder="Filter terms, roots, reasons" autocomplete="off"></label>
      <label>Sort<select data-cfri-filter="sort">
        ${sortOption('priority', 'Priority', state.filters.sort)}
        ${sortOption('spend', 'Spend impact', state.filters.sort)}
        ${sortOption('sales', 'Sales impact', state.filters.sort)}
        ${sortOption('newest', 'Newest evidence', state.filters.sort)}
        ${sortOption('clicks', 'Clicks evidence', state.filters.sort)}
        ${sortOption('terms', 'Impacted term count', state.filters.sort)}
      </select></label>
    </div>

    <div class="cfri-table-meta"><span data-cfri-visible-count></span><span>Session review state is presentation-only and is never written to D1.</span></div>
    <div class="cfri-table-wrap">
      <table class="cfri-table">
        <thead><tr>
          <th>Priority</th>
          <th>Candidate</th>
          <th>Why</th>
          <th>Evidence</th>
          <th>Root / Lifecycle</th>
          <th>Governance</th>
          <th>Review</th>
          <th>Evidence period</th>
          <th>Details</th>
        </tr></thead>
        <tbody data-cfri-rows></tbody>
      </table>
    </div>
    <div data-cfri-suppression>${suppressionHtml(inbox)}</div>
    <aside class="cfri-drawer" data-cfri-drawer hidden aria-label="Recommendation evidence drawer"></aside>`;

    renderRows();
  }

  function renderRows() {
    const section = state.panel?.querySelector('[data-csv-recommendation-inbox-workspace]');
    const body = section?.querySelector('[data-cfri-rows]');
    const meta = section?.querySelector('[data-cfri-visible-count]');
    if (!section || !body || !state.inbox) return;
    const rows = filteredAndSortedItems();
    if (meta) meta.textContent = `${formatNumber(rows.length)} of ${formatNumber(state.inbox.items?.length || 0)} candidates visible`;
    body.innerHTML = rows.length
      ? rows.map(candidateRow).join('')
      : '<tr><td colspan="9"><div class="cfri-empty">No recommendation matches the current Inbox filters.</div></td></tr>';
  }

  function candidateRow(item) {
    const evidence = item?.evidenceSummary || {};
    const scope = state.inbox?.analysisScope || {};
    const comparable = scope.financiallyComparable === true;
    const roots = (item?.impactedRoots || []).map((entry) => entry?.root).filter(Boolean);
    const lifecycle = unique((item?.lifecycleContext || []).map((entry) => entry?.stateLabel || entry?.state)).join(', ') || '—';
    const reviewState = effectiveReviewState(item);
    const eligible = scope.candidateEmissionAuthorized === true && evidence.recommendationGoverned === true;
    const imports = Array.isArray(evidence.sourceImportIds) ? evidence.sourceImportIds.length : 0;
    const reason = item?.reason || 'No reason supplied by governed contract.';
    return `<tr data-cfri-item="${esc(item?.inboxItemId || '')}">
      <td><span class="cfri-priority ${esc(item?.priority || 'low')}">${esc(item?.priority || 'low')}</span><small>score ${formatNumber(item?.priorityScore || 0)}</small></td>
      <td><strong>${esc(item?.value || '—')}</strong><small>${esc(item?.candidateType || 'unknown')} · ${esc(item?.matchScope || '—')}</small></td>
      <td><span class="cfri-reason">${esc(reason)}</span><small>${formatNumber(item?.impactedSearchTerms?.length || 0)} impacted terms</small></td>
      <td>${evidenceCell(evidence, comparable)}</td>
      <td><span>${esc(roots.slice(0, 3).join(', ') || '—')}</span><small>${esc(lifecycle)}</small></td>
      <td><span class="cfri-badge ${eligible ? 'safe' : 'warn'}">${eligible ? 'Eligible for review' : 'Fail closed'}</span><small>${esc(evidence.provenanceGate || 'provenance gate unavailable')} · ${formatNumber(imports)} source import${imports === 1 ? '' : 's'}</small></td>
      <td><span class="cfri-review ${esc(reviewState)}">${esc(reviewState)}</span><small>${state.viewed.has(item?.inboxItemId) ? 'session only' : (item?.review?.persisted ? 'persisted' : 'not persisted')}</small></td>
      <td><span>${esc(dateWindow(evidence.analysisWindow))}</span><small>${esc(state.context?.storeId || '')}</small></td>
      <td><button type="button" class="cfdi-link" data-cfri-evidence="${esc(item?.inboxItemId || '')}">Evidence</button></td>
    </tr>`;
  }

  function evidenceCell(evidence, comparable) {
    if (!comparable) {
      return `<span>Financial metrics suppressed</span><small>${formatNumber(evidence?.orders || 0)} orders · ${formatNumber(evidence?.clicks || 0)} clicks · ${formatPercent(evidence?.cvr)} CVR</small>`;
    }
    return `<span>${formatMoney(evidence?.spendMicros)} spend · ${formatMoney(evidence?.salesMicros)} sales</span><small>${formatNumber(evidence?.orders || 0)} orders · ${formatPercent(evidence?.acos)} ACoS · ${formatPercent(evidence?.cvr)} CVR</small>`;
  }

  function suppressionHtml(inbox) {
    const summary = inbox?.summary || {};
    const governance = Number(summary.blockedByGovernanceCount || 0);
    const scope = Number(summary.blockedByScopeCount || 0);
    const items = Array.isArray(inbox?.items) ? inbox.items : [];
    if (governance || scope) {
      return `<div class="cfri-callout warn"><strong>Suppressed candidates stay outside the Inbox.</strong> ${formatNumber(governance)} blocked by governance and ${formatNumber(scope)} blocked by analysis scope. They are not silently converted into recommendations.</div>`;
    }
    if (!items.length) {
      return '<div class="cfri-callout neutral"><strong>No governed recommendations in this scope.</strong> Diagnostics may still exist, but zero eligible candidates were emitted.</div>';
    }
    return '';
  }

  function openEvidence(inboxItemId) {
    const item = (state.inbox?.items || []).find((entry) => String(entry?.inboxItemId || '') === String(inboxItemId || ''));
    const section = state.panel?.querySelector('[data-csv-recommendation-inbox-workspace]');
    const drawer = section?.querySelector('[data-cfri-drawer]');
    if (!item || !drawer) return;
    if (item.inboxItemId) state.viewed.add(item.inboxItemId);
    renderRows();

    const evidence = item.evidenceSummary || {};
    const authority = item.authority || state.inbox?.authority || {};
    const review = item.review || {};
    const roots = item.impactedRoots || [];
    const lifecycle = item.lifecycleContext || [];
    const business = item.businessContext || [];
    const comparable = state.inbox?.analysisScope?.financiallyComparable === true;
    drawer.hidden = false;
    drawer.innerHTML = `<div class="cfri-drawer-backdrop" data-cfri-close></div>
      <div class="cfri-drawer-panel" role="dialog" aria-modal="true" aria-labelledby="cfriDrawerTitle">
        <div class="cfri-drawer-head">
          <div><div class="cfri-eyebrow">GOVERNED EVIDENCE</div><h3 id="cfriDrawerTitle">${esc(item.value || 'Recommendation')}</h3><p>${esc(item.reason || '—')}</p></div>
          <button type="button" class="btn" data-cfri-close>Close</button>
        </div>
        <div class="cfri-drawer-scroll">
          ${drawerSection('Recommendation', `<dl class="cfri-dl">
            ${kv('Inbox item ID', item.inboxItemId)}
            ${kv('Candidate type', item.candidateType)}
            ${kv('Action type', item.actionType)}
            ${kv('Match scope', item.matchScope)}
            ${kv('Priority', `${item.priority || '—'} · score ${formatNumber(item.priorityScore || 0)}`)}
            ${kv('Impacted search terms', (item.impactedSearchTerms || []).join(', ') || '—')}
          </dl>`)}
          ${drawerSection('Financial & conversion evidence', `<dl class="cfri-dl">
            ${kv('Evidence period', dateWindow(evidence.analysisWindow))}
            ${kv('Spend', comparable ? formatMoney(evidence.spendMicros) : 'suppressed by financial comparability gate')}
            ${kv('Sales', comparable ? formatMoney(evidence.salesMicros) : 'suppressed by financial comparability gate')}
            ${kv('Orders', formatNumber(evidence.orders || 0))}
            ${kv('Clicks', formatNumber(evidence.clicks || 0))}
            ${kv('ACoS', comparable ? formatPercent(evidence.acos) : 'suppressed')}
            ${kv('CVR', formatPercent(evidence.cvr))}
          </dl>`)}
          ${drawerSection('Provenance & governance', `<dl class="cfri-dl">
            ${kv('Recommendation governed', yesNo(evidence.recommendationGoverned === true))}
            ${kv('Provenance gate', evidence.provenanceGate || '—')}
            ${kv('Source import IDs', (evidence.sourceImportIds || []).join(', ') || '—')}
            ${kv('Identity confidence state', evidence.identityConfidence?.state || '—')}
            ${kv('Identity confidence score', formatConfidence(evidence.identityConfidence?.score))}
            ${kv('Canonical Amazon identity resolved', yesNo(authority.canonicalAmazonIdentityResolved === true))}
          </dl>`)}
          ${drawerSection('Impacted roots', roots.length ? roots.map(rootEvidence).join('') : '<div class="cfri-empty">No impacted root context in contract.</div>')}
          ${drawerSection('Lifecycle context', lifecycle.length ? lifecycle.map(lifecycleEvidence).join('') : '<div class="cfri-empty">No lifecycle context in contract.</div>')}
          ${drawerSection('Search-term business context', business.length ? business.map(businessEvidence).join('') : '<div class="cfri-empty">No term-level business context in contract.</div>')}
          ${drawerSection('Human review boundary', `<dl class="cfri-dl">
            ${kv('Contract review state', review.state || 'unreviewed')}
            ${kv('Session presentation state', effectiveReviewState(item))}
            ${kv('Human review required', yesNo(review.humanReviewRequired !== false))}
            ${kv('Persisted', yesNo(review.persisted === true))}
            ${kv('Persistence authorized', yesNo(review.persistenceAuthorized === true))}
            ${kv('Future action entity', review.futurePersistenceContract?.actionEntity || 'optimization_actions')}
            ${kv('Future event entity', review.futurePersistenceContract?.eventEntity || 'optimization_action_events')}
            ${kv('Future persistence enabled', yesNo(review.futurePersistenceContract?.enabled === true))}
            ${kv('Governance persistence allowed', yesNo(authority.governancePersistenceAllowed === true))}
            ${kv('Execution authorized', yesNo(authority.executionAuthorized === true))}
            ${kv('Amazon mutation authorized', yesNo(authority.amazonMutationAuthorized === true))}
          </dl><div class="cfri-callout warn"><strong>Approval boundary:</strong> Human recognition of a recommendation never grants Amazon execution authority.</div>`)}
        </div>
      </div>`;
  }

  function rootEvidence(root) {
    return `<div class="cfri-evidence-card"><strong>${esc(root?.root || '—')}</strong><span>${esc(root?.primaryState || '—')}</span><small>${formatNumber(root?.termCount || 0)} terms · ${formatNumber(root?.profitTermCount || 0)} winner · ${formatNumber(root?.wasteTermCount || 0)} waste · ${root?.profitProtectionApplied ? 'profit protection applied' : 'no profit protection flag'}</small></div>`;
  }

  function lifecycleEvidence(item) {
    const change = item?.change || {};
    return `<div class="cfri-evidence-card"><strong>${esc(item?.searchTerm || '—')}</strong><span>${esc(item?.stateLabel || item?.state || '—')}</span><small>${esc(item?.previousClassification || '—')} → ${esc(item?.currentClassification || '—')} · orders ${formatSignedPercent(change.ordersPct)} · sales ${formatSignedPercent(change.salesPct)} · ACoS ${formatSignedRatio(change.acosDelta)}</small><em>${esc(item?.reason || '')}</em></div>`;
  }

  function businessEvidence(item) {
    return `<div class="cfri-evidence-card"><strong>${esc(item?.searchTerm || '—')}</strong><span>${esc(item?.classificationLabel || item?.classification || '—')}</span><small>priority ${formatNumber(item?.priorityScore || 0)} · recommendation governed ${yesNo(item?.recommendationGoverned === true)}</small><em>${esc(item?.reason || '')}</em></div>`;
  }

  function handleClick(event) {
    const refreshButton = event.target.closest?.('[data-cfri-refresh]');
    if (refreshButton) {
      event.preventDefault();
      void refresh(true);
      return;
    }
    const evidenceButton = event.target.closest?.('[data-cfri-evidence]');
    if (evidenceButton) {
      event.preventDefault();
      openEvidence(evidenceButton.dataset.cfriEvidence || '');
      return;
    }
    if (event.target.closest?.('[data-cfri-close]')) {
      event.preventDefault();
      closeDrawer();
    }
  }

  function handleFilterEvent(event) {
    const control = event.target.closest?.('[data-cfri-filter]');
    if (!control) return;
    const key = control.dataset.cfriFilter;
    if (!Object.prototype.hasOwnProperty.call(state.filters, key)) return;
    state.filters[key] = String(control.value || '');
    renderRows();
  }

  function handleKeydown(event) {
    if (event.key === 'Escape') closeDrawer();
  }

  function closeDrawer() {
    const drawer = state.panel?.querySelector('[data-cfri-drawer]');
    if (!drawer) return;
    drawer.hidden = true;
    drawer.innerHTML = '';
  }

  function resetForStoreChange() {
    state.requestId += 1;
    state.requestController?.abort();
    state.requestController = null;
    state.scopeKey = '';
    state.inbox = null;
    state.context = null;
    state.viewed.clear();
    closeDrawer();
    scheduleSync();
  }

  function filteredAndSortedItems() {
    const items = [...(state.inbox?.items || [])];
    const f = state.filters;
    const query = normalizeText(f.search);
    const filtered = items.filter((item) => {
      if (f.priority && item?.priority !== f.priority) return false;
      if (f.candidateType && item?.candidateType !== f.candidateType) return false;
      if (f.lifecycle && !(item?.lifecycleContext || []).some((entry) => (entry?.stateLabel || entry?.state) === f.lifecycle || entry?.state === f.lifecycle)) return false;
      if (f.root && !(item?.impactedRoots || []).some((entry) => entry?.root === f.root)) return false;
      if (f.reviewState && effectiveReviewState(item) !== f.reviewState) return false;
      if (query) {
        const haystack = normalizeText([
          item?.value,
          item?.reason,
          item?.candidateType,
          ...(item?.impactedSearchTerms || []),
          ...(item?.impactedRoots || []).map((entry) => entry?.root),
        ].filter(Boolean).join(' '));
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
    return filtered.sort(sorter(f.sort));
  }

  function sorter(sort) {
    const priorityRank = { critical: 0, high: 1, medium: 2, low: 3 };
    if (sort === 'spend') return (a, b) => numberValue(b?.evidenceSummary?.spendMicros) - numberValue(a?.evidenceSummary?.spendMicros) || priorityTie(a, b);
    if (sort === 'sales') return (a, b) => numberValue(b?.evidenceSummary?.salesMicros) - numberValue(a?.evidenceSummary?.salesMicros) || priorityTie(a, b);
    if (sort === 'newest') return (a, b) => String(b?.evidenceSummary?.analysisWindow?.endDate || '').localeCompare(String(a?.evidenceSummary?.analysisWindow?.endDate || '')) || priorityTie(a, b);
    if (sort === 'clicks') return (a, b) => numberValue(b?.evidenceSummary?.clicks) - numberValue(a?.evidenceSummary?.clicks) || priorityTie(a, b);
    if (sort === 'terms') return (a, b) => numberValue(b?.impactedSearchTerms?.length) - numberValue(a?.impactedSearchTerms?.length) || priorityTie(a, b);
    return (a, b) => (priorityRank[a?.priority] ?? 4) - (priorityRank[b?.priority] ?? 4)
      || numberValue(b?.priorityScore) - numberValue(a?.priorityScore)
      || String(a?.candidateType || '').localeCompare(String(b?.candidateType || ''))
      || String(a?.value || '').localeCompare(String(b?.value || ''));
  }

  function priorityTie(a, b) {
    return numberValue(b?.priorityScore) - numberValue(a?.priorityScore)
      || String(a?.value || '').localeCompare(String(b?.value || ''));
  }

  function effectiveReviewState(item) {
    if (state.viewed.has(item?.inboxItemId)) return 'viewed';
    return String(item?.review?.state || 'unreviewed');
  }

  function normalizeFilterState(items) {
    const priorities = new Set(priorityOptions(items));
    const candidateTypes = new Set(unique(items.map((item) => item?.candidateType)));
    const lifecycle = new Set(unique(items.flatMap((item) => (item?.lifecycleContext || []).flatMap((entry) => [entry?.state, entry?.stateLabel]))));
    const roots = new Set(unique(items.flatMap((item) => (item?.impactedRoots || []).map((entry) => entry?.root))));
    if (!priorities.has(state.filters.priority)) state.filters.priority = '';
    if (!candidateTypes.has(state.filters.candidateType)) state.filters.candidateType = '';
    if (!lifecycle.has(state.filters.lifecycle)) state.filters.lifecycle = '';
    if (!roots.has(state.filters.root)) state.filters.root = '';
    state.filters.reviewState = '';
    state.filters.search = '';
    if (!['priority', 'spend', 'sales', 'newest', 'clicks', 'terms'].includes(state.filters.sort)) state.filters.sort = 'priority';
  }

  function priorityOptions(items) {
    const order = ['critical', 'high', 'medium', 'low'];
    const present = new Set(items.map((item) => item?.priority).filter(Boolean));
    return order.filter((value) => present.has(value));
  }

  function reviewStateOptions(items) {
    return unique([...items.map((item) => item?.review?.state || 'unreviewed'), ...state.viewed.size ? ['viewed'] : []]);
  }

  function options(values, selected, allLabel) {
    return `<option value="">${esc(allLabel)}</option>${values.map((value) => `<option value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}>${esc(value)}</option>`).join('')}`;
  }

  function sortOption(value, label, selected) {
    return `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
  }

  async function requestJson(url, signal) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  function currentSource() {
    return state.panel?.querySelector('[name="dataSource"]')?.value || 'csv';
  }

  function currentStoreId() {
    return String(global.CloudflareOperatorContext?.getContext?.().storeId || global.CloudflareOperatorWorkspace?.currentStoreId?.() || '').trim();
  }

  function value(panel, name) {
    return String(panel?.querySelector(`[name="${name}"]`)?.value || '').trim();
  }

  function summaryCard(label, value) {
    return `<div><span>${esc(label)}</span><strong>${formatNumber(value)}</strong></div>`;
  }

  function statusCard(label, value, kind) {
    return `<div class="cfri-status-card ${esc(kind || '')}"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  }

  function drawerSection(title, content) {
    return `<section class="cfri-drawer-section"><h4>${esc(title)}</h4>${content}</section>`;
  }

  function kv(key, value) {
    return `<div><dt>${esc(key)}</dt><dd>${esc(value ?? '—')}</dd></div>`;
  }

  function loadingShell(message) {
    return `<div class="cfri-head"><div><div class="cfri-eyebrow">CSV DECISION INTELLIGENCE</div><h3>Recommendation Inbox</h3><p>${esc(message)}</p></div><span class="cfri-badge safe">Read only</span></div>`;
  }

  function emptyShell(message) {
    return `<div class="cfri-head"><div><div class="cfri-eyebrow">CSV DECISION INTELLIGENCE</div><h3>Recommendation Inbox</h3><p>${esc(message)}</p></div><span class="cfri-badge safe">Read only</span></div><div class="cfri-callout neutral"><strong>No scope selected.</strong> This workspace never falls back to an ungoverned recommendation.</div>`;
  }

  function failClosedShell(message) {
    return `<div class="cfri-head"><div><div class="cfri-eyebrow">CSV DECISION INTELLIGENCE</div><h3>Recommendation Inbox</h3><p>${esc(message)}</p></div><span class="cfri-badge danger">Fail closed</span></div><div class="cfri-callout warn"><strong>Recommendation output suppressed.</strong> No Amazon mutation or persistence path is available from this UI.</div>`;
  }

  function dateWindow(windowValue) {
    return windowValue?.startDate && windowValue?.endDate ? `${windowValue.startDate} → ${windowValue.endDate}` : '—';
  }

  function formatMoney(micros) {
    const numeric = Number(micros);
    if (!Number.isFinite(numeric)) return '—';
    const amount = numeric / 1_000_000;
    const currency = state.context?.currency || 'USD';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
    } catch {
      return amount.toFixed(2);
    }
  }

  function formatPercent(value) {
    if (value === null || value === undefined || value === '') return '—';
    const numeric = Number(value);
    return Number.isFinite(numeric) ? `${(numeric * 100).toFixed(1)}%` : '—';
  }

  function formatSignedPercent(value) {
    if (value === null || value === undefined || value === '') return '—';
    const numeric = Number(value);
    return Number.isFinite(numeric) ? `${numeric >= 0 ? '+' : ''}${(numeric * 100).toFixed(1)}%` : '—';
  }

  function formatSignedRatio(value) {
    if (value === null || value === undefined || value === '') return '—';
    const numeric = Number(value);
    return Number.isFinite(numeric) ? `${numeric >= 0 ? '+' : ''}${(numeric * 100).toFixed(1)}pp` : '—';
  }

  function formatConfidence(value) {
    if (value === null || value === undefined || value === '') return '—';
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '—';
    return numeric >= 0 && numeric <= 1 ? `${(numeric * 100).toFixed(0)}%` : numeric.toFixed(2);
  }

  function formatNumber(value) {
    const numeric = Number(value);
    return new Intl.NumberFormat().format(Number.isFinite(numeric) ? numeric : 0);
  }

  function numberValue(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  function yesNo(value) {
    return value ? 'yes' : 'no';
  }

  function normalizeText(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/gu, ' ');
  }

  function unique(values) {
    return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]));
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .cfri-section{position:relative;overflow:visible}
      .cfri-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:12px}
      .cfri-head h3{margin:2px 0 4px;font-size:18px}.cfri-head h3 small{font-size:12px;color:var(--muted);font-weight:700}
      .cfri-head p{margin:0;max-width:900px;color:var(--muted);font-size:12px;line-height:1.55}
      .cfri-eyebrow{font-size:10px;font-weight:800;letter-spacing:.12em;color:var(--accent);text-transform:uppercase}
      .cfri-head-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
      .cfri-badge,.cfri-priority,.cfri-review{display:inline-flex;align-items:center;max-width:100%;padding:3px 8px;border-radius:999px;border:1px solid var(--line);font-size:10px;font-weight:800;line-height:1.3;text-transform:capitalize;background:var(--card)}
      .cfri-badge.safe,.cfri-status-card.safe{border-color:color-mix(in srgb,#16a34a 35%,var(--line));background:color-mix(in srgb,#16a34a 8%,var(--card))}
      .cfri-badge.warn,.cfri-status-card.warn{border-color:color-mix(in srgb,#d97706 40%,var(--line));background:color-mix(in srgb,#d97706 8%,var(--card))}
      .cfri-badge.danger,.cfri-status-card.danger{border-color:color-mix(in srgb,#dc2626 40%,var(--line));background:color-mix(in srgb,#dc2626 8%,var(--card))}
      .cfri-summary{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin:10px 0}
      .cfri-summary>div{padding:10px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
      .cfri-summary span{display:block;color:var(--muted);font-size:10px}.cfri-summary strong{display:block;margin-top:4px;font-size:18px}
      .cfri-safety-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin:10px 0}
      .cfri-status-card{padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:var(--card)}
      .cfri-status-card span{display:block;color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.06em}.cfri-status-card strong{display:block;margin-top:3px;font-size:11px}
      .cfri-callout{margin:9px 0;padding:9px 11px;border:1px solid color-mix(in srgb,#16a34a 28%,var(--line));border-radius:10px;background:color-mix(in srgb,#16a34a 5%,var(--card));font-size:11px;line-height:1.5}
      .cfri-callout.warn{border-color:color-mix(in srgb,#d97706 34%,var(--line));background:color-mix(in srgb,#d97706 6%,var(--card))}.cfri-callout.neutral{border-color:var(--line);background:color-mix(in srgb,var(--muted) 4%,var(--card))}
      .cfri-controls{display:grid;grid-template-columns:repeat(5,minmax(130px,1fr));gap:8px;margin:12px 0 8px;align-items:end}
      .cfri-controls label{display:grid;gap:4px;color:var(--muted);font-size:10px;font-weight:700}.cfri-controls select,.cfri-controls input{width:100%;min-width:0;height:34px;border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--text);padding:0 9px;font:inherit;font-size:11px}.cfri-controls .cfri-search{grid-column:span 2}
      .cfri-table-meta{display:flex;justify-content:space-between;gap:12px;margin:7px 0;color:var(--muted);font-size:10px}
      .cfri-table-wrap{max-height:620px;overflow:auto;border:1px solid var(--line);border-radius:12px;background:var(--card)}
      .cfri-table{width:100%;border-collapse:separate;border-spacing:0;font-size:11px}.cfri-table th{position:sticky;top:0;z-index:2;padding:9px 8px;text-align:left;background:var(--card);border-bottom:1px solid var(--line);white-space:nowrap}.cfri-table td{padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top;min-width:105px}.cfri-table td:nth-child(2),.cfri-table td:nth-child(3){min-width:180px}.cfri-table td:nth-child(4){min-width:190px}.cfri-table tr:last-child td{border-bottom:0}.cfri-table td>span,.cfri-table td>strong{display:block}.cfri-table small{display:block;margin-top:3px;color:var(--muted);font-size:9.5px;line-height:1.4}.cfri-reason{max-width:300px;line-height:1.45}
      .cfri-priority.critical{border-color:color-mix(in srgb,#dc2626 45%,var(--line));background:color-mix(in srgb,#dc2626 10%,var(--card))}.cfri-priority.high{border-color:color-mix(in srgb,#d97706 45%,var(--line));background:color-mix(in srgb,#d97706 9%,var(--card))}.cfri-priority.medium{border-color:color-mix(in srgb,#2563eb 35%,var(--line));background:color-mix(in srgb,#2563eb 7%,var(--card))}
      .cfri-review.viewed{border-color:color-mix(in srgb,#16a34a 35%,var(--line));background:color-mix(in srgb,#16a34a 7%,var(--card))}.cfri-review.needs_review{border-color:color-mix(in srgb,#d97706 35%,var(--line));background:color-mix(in srgb,#d97706 7%,var(--card))}
      .cfri-empty{padding:18px;color:var(--muted);text-align:center;font-size:11px}
      .cfri-drawer[hidden]{display:none}.cfri-drawer{position:fixed;inset:0;z-index:10000}.cfri-drawer-backdrop{position:absolute;inset:0;background:rgba(15,23,42,.36);backdrop-filter:blur(2px)}.cfri-drawer-panel{position:absolute;top:0;right:0;width:min(720px,92vw);height:100%;display:flex;flex-direction:column;background:var(--card);border-left:1px solid var(--line);box-shadow:-16px 0 50px rgba(15,23,42,.18)}
      .cfri-drawer-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:18px;border-bottom:1px solid var(--line)}.cfri-drawer-head h3{margin:2px 0 4px;font-size:18px}.cfri-drawer-head p{margin:0;color:var(--muted);font-size:11px;line-height:1.45}.cfri-drawer-scroll{overflow:auto;padding:14px 18px 28px}.cfri-drawer-section{margin:0 0 14px;padding:12px;border:1px solid var(--line);border-radius:12px;background:color-mix(in srgb,var(--muted) 2%,var(--card))}.cfri-drawer-section h4{margin:0 0 9px;font-size:12px}
      .cfri-dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin:0}.cfri-dl>div{min-width:0;padding:7px 8px;border:1px solid var(--line);border-radius:9px;background:var(--card)}.cfri-dl dt{color:var(--muted);font-size:9px}.cfri-dl dd{margin:3px 0 0;overflow-wrap:anywhere;font-size:10.5px;font-weight:700}
      .cfri-evidence-card{display:grid;grid-template-columns:minmax(140px,1fr) auto;gap:3px 10px;padding:9px 0;border-bottom:1px solid var(--line)}.cfri-evidence-card:last-child{border-bottom:0}.cfri-evidence-card strong{font-size:11px}.cfri-evidence-card span{font-size:10px;font-weight:700}.cfri-evidence-card small,.cfri-evidence-card em{grid-column:1/-1;color:var(--muted);font-size:9.5px;line-height:1.4}.cfri-evidence-card em{font-style:normal}
      @media(max-width:1200px){.cfri-summary{grid-template-columns:repeat(3,minmax(0,1fr))}.cfri-safety-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.cfri-controls{grid-template-columns:repeat(3,minmax(130px,1fr))}}
      @media(max-width:760px){.cfri-head{display:grid}.cfri-head-actions{justify-content:flex-start}.cfri-summary,.cfri-safety-grid,.cfri-controls{grid-template-columns:1fr 1fr}.cfri-controls .cfri-search{grid-column:1/-1}.cfri-table-meta{display:grid}.cfri-dl{grid-template-columns:1fr}.cfri-drawer-panel{width:100%}}
    `;
    document.head.appendChild(style);
  }
})(window);
