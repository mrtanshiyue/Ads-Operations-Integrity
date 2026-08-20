(function initCsvIntelligenceExtension(global) {
  'use strict';

  const VERSION = '1.0.5';
  const STORAGE_SOURCE = 'aoi.decision.source';
  const REQUEST_TIMEOUT_MS = 30000;
  const TIMEOUT_ERROR_CODE = 'CSV_INTELLIGENCE_TIMEOUT';
  const state = {
    mounted: false,
    payload: null,
    amazonProfileId: '',
    requestId: 0,
    requestController: null,
    timedOutRequestId: 0,
  };

  Object.defineProperty(global, 'CloudflareCsvIntelligence', {
    value: Object.freeze({ version: VERSION, source: () => currentSource() }),
    writable: false,
    configurable: false,
    enumerable: true,
  });

  if (!global.document) return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();

  function mount() {
    if (state.mounted) return;
    const panel = document.getElementById('cfDecisionPanel');
    if (!panel) {
      new MutationObserver((_, observer) => {
        if (!document.getElementById('cfDecisionPanel')) return;
        observer.disconnect();
        mount();
      }).observe(document.documentElement, { childList: true, subtree: true });
      return;
    }
    state.mounted = true;
    panel.dataset.csvIntelligenceVersion = VERSION;
    const controls = panel.querySelector('.cfdi-controls');
    if (!controls || controls.querySelector('[name="dataSource"]')) return;

    const profile = panel.querySelector('[name="profileId"]');
    state.amazonProfileId = String(profile?.value || '').trim();
    const label = document.createElement('label');
    label.className = 'cfdi-source-control';
    label.innerHTML = 'Data source<select name="dataSource"><option value="csv">Imported CSV</option><option value="amazon">Amazon lineage</option></select>';
    controls.insertBefore(label, controls.firstChild);
    const select = label.querySelector('select');
    select.value = localStorage.getItem(STORAGE_SOURCE) || 'csv';
    select.addEventListener('change', () => {
      const next = select.value;
      if (next === 'csv') state.amazonProfileId = String(profile?.value || state.amazonProfileId || '').trim();
      localStorage.setItem(STORAGE_SOURCE, next);
      cancelActiveRequest();
      state.payload = null;
      applySourceMode();
    });

    panel.addEventListener('click', captureClick, true);
    global.addEventListener?.('cloudflare-operator-store-change', () => {
      cancelActiveRequest();
      state.payload = null;
      if (currentSource() === 'csv') clearCsvResults();
    });
    applySourceMode();
  }

  function captureClick(event) {
    if (currentSource() !== 'csv') return;
    const run = event.target.closest?.('[data-run]');
    if (run) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (state.requestController) return;
      void runCsvIntelligence();
      return;
    }

    const evidence = event.target.closest?.('[data-csv-evidence-index]');
    if (evidence) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const item = state.payload?.items?.[Number(evidence.dataset.csvEvidenceIndex)];
      if (item) renderCsvEvidence(item, state.payload);
      return;
    }

    const productEvidence = event.target.closest?.('[data-csv-product-term]');
    if (productEvidence) {
      event.preventDefault();
      event.stopImmediatePropagation();
      renderProductEvidence(productEvidence.dataset.csvProductTerm || '', state.payload);
    }
  }

  function applySourceMode() {
    const panel = document.getElementById('cfDecisionPanel');
    if (!panel) return;
    const csv = currentSource() === 'csv';
    const profile = panel.querySelector('[name="profileId"]');
    if (profile) {
      if (csv) {
        if (profile.value) state.amazonProfileId = String(profile.value).trim();
        profile.value = '';
        profile.placeholder = 'optional for imported CSV';
      } else {
        profile.value = state.amazonProfileId || localStorage.getItem('aoi.decision.profileId') || '';
        profile.placeholder = 'profile-synth-dev-01';
      }
    }
    const status = panel.querySelector('[data-status]');
    if (status) {
      status.dataset.kind = csv ? 'warn' : '';
      status.textContent = csv
        ? 'Imported CSV advisory mode. Profile ID is optional and defaults to unscoped imported facts. Recommendations are non-authoritative and cannot be persisted until canonical Amazon profile/entity identity is verified.'
        : 'Amazon lineage mode. Profile scope is required; execution remains disabled.';
    }
    if (csv) clearCsvResults();
  }

  async function runCsvIntelligence() {
    const panel = document.getElementById('cfDecisionPanel');
    const storeId = currentStoreId();
    const startDate = value(panel, 'startDate');
    const endDate = value(panel, 'endDate');
    if (!storeId) return setStatus('Select a store in Operator Workspace first.', 'warn');
    if (!startDate || !endDate) return setStatus('Start and end dates are required.', 'warn');

    const params = new URLSearchParams({
      source: 'csv',
      startDate,
      endDate,
      limit: value(panel, 'limit') || '50',
      sort: value(panel, 'sort') || 'cost',
    });
    const profileId = value(panel, 'profileId');
    if (profileId) params.set('profileId', profileId);

    const requestId = ++state.requestId;
    const controller = new AbortController();
    state.requestController = controller;
    state.timedOutRequestId = 0;
    let timeoutId = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = global.setTimeout(() => {
        if (state.requestId !== requestId || state.requestController !== controller) return;
        state.timedOutRequestId = requestId;
        controller.abort();
        const error = new Error('Imported CSV intelligence timed out after 30 seconds. No data was changed. Retry once; if it repeats, the server-side query needs investigation.');
        error.code = TIMEOUT_ERROR_CODE;
        reject(error);
      }, REQUEST_TIMEOUT_MS);
    });

    setRunPending(panel, true);
    setStatus('Computing advisory intelligence over imported CSV facts…', 'loading');
    closeDrawer();

    try {
      const payload = await Promise.race([
        requestJson(
          `/api/v1/stores/${encodeURIComponent(storeId)}/search-term-intelligence?${params}`,
          { signal: controller.signal },
        ),
        timeoutPromise,
      ]);
      if (requestId !== state.requestId) return;
      state.payload = payload;
      renderCsvResults(payload);
      const valid = Number(payload?.summary?.csvProvenanceValidItemCount || 0);
      const itemCount = Number(payload?.summary?.itemCount || 0);
      const productization = payload?.productization;
      const business = productization?.businessIntelligence;
      const scope = productization?.analysisScope;
      const emitted = Number(business?.summary?.emittedCandidateCount ?? payload?.summary?.recommendationCandidateCount ?? 0);
      const scopeState = scope
        ? `Universe ${scope.complete ? 'complete' : 'incomplete'} · Financials ${scope.financiallyComparable ? 'comparable' : 'suppressed'} · Candidate emission ${scope.candidateEmissionAuthorized ? 'authorized for review' : 'blocked'}`
        : 'Legacy row-level advisory view';
      setStatus(`Imported CSV · ${valid}/${itemCount} display rows with valid CSV provenance · ${emitted} review candidates · ${scopeState}. Persistence and Amazon execution are disabled.`, 'warn');
    } catch (error) {
      if (requestId !== state.requestId) return;
      state.payload = null;
      clearCsvResults();
      const timedOut = error?.code === TIMEOUT_ERROR_CODE
        || (controller.signal.aborted && state.timedOutRequestId === requestId);
      if (timedOut) {
        setStatus('Imported CSV intelligence timed out after 30 seconds. No data was changed. Retry once; if it repeats, the server-side query needs investigation.', 'error');
      } else if (!controller.signal.aborted) {
        setStatus(error.message || 'Imported CSV intelligence request failed.', 'error');
      }
    } finally {
      if (timeoutId !== null) global.clearTimeout(timeoutId);
      if (requestId === state.requestId) {
        state.requestController = null;
        state.timedOutRequestId = 0;
        setRunPending(panel, false);
      }
    }
  }

  function cancelActiveRequest() {
    if (!state.requestController) return;
    state.requestId += 1;
    state.requestController.abort();
    state.requestController = null;
    state.timedOutRequestId = 0;
    setRunPending(document.getElementById('cfDecisionPanel'), false);
  }

  function setRunPending(panel, pending) {
    const run = panel?.querySelector('[data-run]');
    if (!run) return;
    run.disabled = Boolean(pending);
    if (pending) run.setAttribute('aria-busy', 'true');
    else run.removeAttribute('aria-busy');
  }

  function renderCsvResults(payload) {
    const target = document.querySelector('#cfDecisionPanel [data-results]');
    if (!target) return;
    const productization = payload?.productization;
    const productWorkspace = productization
      ? renderOperatorWorkspace(payload, productization)
      : renderLegacyProductizationNotice();
    const legacyRows = renderLegacyRows(payload);
    target.innerHTML = `${productWorkspace}${legacyRows}`;
  }

  function renderOperatorWorkspace(payload, productization) {
    const business = productization.businessIntelligence || {};
    const historical = productization.historicalIntelligence || {};
    const scope = productization.analysisScope || business.analysisScope || historical.analysisScope || {};
    const summary = business.summary || {};
    const roots = business.rootIntelligence?.roots || [];
    const lifecycleItems = historical.lifecycle?.items || [];
    const candidates = business.candidates || [];
    const currency = scope.financiallyComparable ? single(scope.currencyCodes) || payload.profile?.currencyCode : null;
    const lifecycleMap = new Map(lifecycleItems.map((item) => [normalizeTerm(item.searchTerm), item]));
    const rootMap = buildRootMap(roots);
    const candidateMap = buildCandidateMap(candidates, roots);

    const cards = `<div class="cfdi-summary" data-csv-product-overview>
      ${summaryCard('Profit Winners', summary.profitWinnerCount || 0)}
      ${summaryCard('Scale Opportunities', summary.scaleOpportunityCount || 0)}
      ${summaryCard('Waste Terms', summary.wasteTermCount || 0)}
      ${summaryCard('Watchlist', summary.watchlistCount || 0)}
      ${summaryCard('Candidate Count', summary.emittedCandidateCount ?? candidates.length)}
      ${summaryCard('Root Count', roots.length)}
      ${summaryCard('Lifecycle Count', historical.summary?.lifecycleTermCount ?? lifecycleItems.length)}
    </div>`;

    const scopeHealth = renderScopeHealth(scope);
    const groups = business.groups || {};
    const sections = [
      renderTermGroup('Profit Winners', groups.profitWinners, { currency, scope, lifecycleMap, rootMap, candidateMap, mode: 'profit' }),
      renderTermGroup('Scale Opportunities', groups.scaleOpportunities, { currency, scope, lifecycleMap, rootMap, candidateMap, mode: 'scale' }),
      renderTermGroup('Waste Terms', groups.wasteTerms, { currency, scope, lifecycleMap, rootMap, candidateMap, mode: 'waste' }),
      renderTermGroup('Watchlist', groups.watchlist, { currency, scope, lifecycleMap, rootMap, candidateMap, mode: 'watch' }),
    ].join('');

    return `<div data-csv-operator-workspace>
      <div class="cfdi-callout"><strong>Search Term Intelligence Operator Workspace.</strong> Business classification is computed over the complete filtered normalized search-term universe when scope permits. This surface is human-review only; governance persistence and Amazon mutation remain disabled.</div>
      ${cards}
      ${scopeHealth}
      ${sections}
    </div>`;
  }

  function renderLegacyProductizationNotice() {
    return `<div class="cfdi-callout" data-csv-productization-fallback><strong>Productization payload unavailable.</strong> Showing the compatibility row-level advisory view only. No candidate is treated as complete-universe intelligence.</div>`;
  }

  function renderScopeHealth(scope) {
    const reasons = Array.isArray(scope?.reasons) && scope.reasons.length ? scope.reasons.join(', ') : 'none';
    const currency = join(scope?.currencyCodes);
    const marketplace = join(scope?.marketplaces);
    const complete = scope?.complete === true;
    const comparable = scope?.financiallyComparable === true;
    const emission = scope?.candidateEmissionAuthorized === true;
    const kind = complete && comparable && emission ? 'ok' : 'warn';
    return `<section class="cfdi-detail-section" data-csv-scope-health>
      <h3>Analysis Scope</h3>
      <div class="cfdi-badges">
        <span class="cfdi-pill ${complete ? '' : 'warn'}">Universe ${complete ? 'Complete' : 'Incomplete'}</span>
        <span class="cfdi-pill ${comparable ? '' : 'warn'}">Financially ${comparable ? 'Comparable' : 'Suppressed'}</span>
        <span class="cfdi-pill ${emission ? 'candidate' : 'warn'}">Candidate Emission ${emission ? 'Authorized for Review' : 'Blocked'}</span>
        <span class="cfdi-pill danger">Amazon Execution Disabled</span>
      </div>
      <dl>
        ${kv('Universe Complete?', yesNo(complete))}
        ${kv('Financially Comparable?', yesNo(comparable))}
        ${kv('Candidate Emission Authorized?', yesNo(emission))}
        ${kv('Currency', currency)}
        ${kv('Marketplace', marketplace)}
        ${kv('Observed Search Term Count', scope?.observedTermCount ?? scope?.itemCount ?? 0)}
        ${kv('Hard Cap', scope?.hardCap ?? '—')}
        ${kv('Overflow Observed', yesNo(scope?.overflowObserved === true))}
        ${kv('Scope Reasons', reasons)}
      </dl>
      ${!complete ? `<div class="cfdi-callout" data-kind="${kind}"><strong>Fail-closed.</strong> Bounded analytics remain visible, but incomplete-universe data cannot emit Negative, Harvest, or Scale candidates.</div>` : ''}
      ${complete && !comparable ? `<div class="cfdi-callout" data-kind="${kind}"><strong>Financial comparability gate blocked.</strong> Spend, sales, ACoS, and ROAS are suppressed here rather than aggregating incompatible currency/marketplace values.</div>` : ''}
    </section>`;
  }

  function renderTermGroup(title, items, context) {
    const rows = Array.isArray(items) ? items : [];
    const empty = `<tr><td colspan="11">No ${esc(title)} in this analysis scope.</td></tr>`;
    const body = rows.map((item) => productTermRow(item, context)).join('') || empty;
    return `<section class="cfdi-detail-section" data-csv-business-group="${esc(title)}">
      <h3>${esc(title)} <small>${number(rows.length)}</small></h3>
      <div class="cfdi-table-wrap"><table class="cfdi-table">
        <thead><tr><th>Search term</th><th>Spend</th><th>Sales</th><th>Orders</th><th>ACoS</th><th>ROAS</th><th>CVR</th><th>Root</th><th>Lifecycle</th><th>Reason / Candidate</th><th>Evidence</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </section>`;
  }

  function productTermRow(item, { currency, scope, lifecycleMap, rootMap, candidateMap, mode }) {
    const metrics = item?.metrics || {};
    const term = String(item?.searchTerm || '');
    const lifecycle = lifecycleMap.get(normalizeTerm(term));
    const roots = rootMap.get(normalizeTerm(term)) || [];
    const candidates = candidateMap.get(normalizeTerm(term)) || [];
    const financiallyComparable = scope?.financiallyComparable === true;
    const rootNames = roots.length ? roots.map((root) => root.root).join(', ') : '—';
    const rootStates = join(item?.rootStates);
    const reason = item?.reason || classificationReasonFallback(mode);
    const candidateText = candidates.length ? candidates.map((candidate) => candidate.candidateType).join(', ') : 'No emitted candidate';
    const candidateNote = scope?.candidateEmissionAuthorized === true ? candidateText : 'Candidate emission blocked by scope';
    return `<tr>
      <td><strong>${esc(term)}</strong><small>${esc(item?.classificationLabel || '')} · priority ${number(item?.priorityScore || 0)}</small></td>
      <td>${financialValue(money(metrics.spendMicros, currency), financiallyComparable)}</td>
      <td>${financialValue(money(metrics.salesMicros, currency), financiallyComparable)}</td>
      <td>${number(metrics.orders)}</td>
      <td>${financialValue(percent(metrics.acos), financiallyComparable)}</td>
      <td>${financialValue(decimal(metrics.roas), financiallyComparable)}</td>
      <td>${percent(metrics.cvr)}</td>
      <td><span class="cfdi-pill">${esc(rootNames)}</span><small>${esc(rootStates)}</small></td>
      <td><span class="cfdi-pill">${esc(lifecycle?.stateLabel || lifecycle?.state || '—')}</span><small>${esc(lifecycle?.reason || '')}</small></td>
      <td><span>${esc(reason)}</span><small>${esc(candidateNote)}</small></td>
      <td><button type="button" class="cfdi-link" data-csv-product-term="${esc(term)}">Evidence</button></td>
    </tr>`;
  }

  function renderLegacyRows(payload) {
    const summary = payload.summary || {};
    const freshness = summary.freshness || {};
    const scope = payload?.productization?.analysisScope;
    const comparable = scope ? scope.financiallyComparable === true : true;
    const cards = `<div class="cfdi-summary" data-csv-compatibility-summary>
      ${summaryCard('Display Rows', summary.itemCount || 0)}
      ${summaryCard('Legacy advisory candidates', summary.recommendationCandidateCount || 0)}
      ${summaryCard('CSV provenance valid', summary.csvProvenanceValidItemCount || 0)}
      ${summaryCard('Fresh', freshness.fresh || 0)}
      ${summaryCard('Stale', freshness.stale || 0)}
    </div>`;
    const rows = (payload.items || []).map((item, index) => csvRow(item, payload, index, comparable)).join('');
    return `<section class="cfdi-detail-section" data-csv-compatibility-table>
      <h3>Row-level Compatibility Detail</h3>
      ${cards}
      <div class="cfdi-callout"><strong>Imported real data.</strong> CSV content/import provenance is validated and observed CSV campaign/ad-group/target IDs may be present, but canonical Amazon profile/entity binding is not verified. Recommendations are advisory only.</div>
      <div class="cfdi-table-wrap"><table class="cfdi-table"><thead><tr><th>Search term</th><th>Spend</th><th>Sales</th><th>Orders</th><th>ACoS</th><th>Trend</th><th>Decision</th><th>Confidence</th><th>Evidence</th></tr></thead><tbody>${rows || '<tr><td colspan="9">No imported CSV facts in this window.</td></tr>'}</tbody></table></div>
    </section>`;
  }

  function csvRow(item, payload, index, financiallyComparable = true) {
    const m = item.metrics || {};
    const rec = item.recommendation;
    const suppressed = item.suppression;
    const decision = rec ? `${esc(rec.family)} · ${esc(rec.actionType)}` : suppressed ? `Suppressed · ${esc(suppressed.code)}` : 'Observe';
    const trend = item.trend?.delta || {};
    const evidence = item.evidence || {};
    const currency = financiallyComparable ? single(payload?.productization?.analysisScope?.currencyCodes) || payload.profile?.currencyCode : null;
    return `<tr>
      <td><strong>${esc(item.entity?.searchTerm || '')}</strong><small>${esc(item.entity?.campaignName || '')} · ${esc(item.entity?.adGroupName || '')}</small></td>
      <td>${financialValue(money(m.spendMicros, currency), financiallyComparable)}</td>
      <td>${financialValue(money(m.salesMicros, currency), financiallyComparable)}</td>
      <td>${number(m.orders)}</td>
      <td>${financialValue(percent(m.acos), financiallyComparable)}</td>
      <td><span>Spend ${financialValue(signedPercent(trend.spendPct), financiallyComparable)}</span><small>Orders ${signedPercent(trend.ordersPct)}</small></td>
      <td><span class="cfdi-pill ${rec ? 'candidate' : ''}">${decision}</span><small>${rec ? 'canonical identity verification required' : 'advisory only'}</small></td>
      <td><span class="cfdi-confidence">${esc(item.confidence?.band || 'low')} · ${percent(item.confidence?.score)}</span><small>${esc(item.freshness?.state || 'unknown')} · ${evidence.csvProvenanceValid ? 'CSV provenance valid' : 'CSV provenance invalid'}</small></td>
      <td><button type="button" class="cfdi-link" data-csv-evidence-index="${index}">Evidence</button></td>
    </tr>`;
  }

  function renderProductEvidence(searchTerm, payload) {
    if (!searchTerm || !payload?.productization) return;
    const productization = payload.productization;
    const business = productization.businessIntelligence || {};
    const historical = productization.historicalIntelligence || {};
    const term = allBusinessTerms(business).find((item) => normalizeTerm(item.searchTerm) === normalizeTerm(searchTerm));
    const lifecycle = (historical.lifecycle?.items || []).find((item) => normalizeTerm(item.searchTerm) === normalizeTerm(searchTerm));
    const roots = (business.rootIntelligence?.roots || []).filter((root) => (root.searchTerms || []).some((value) => normalizeTerm(value) === normalizeTerm(searchTerm)));
    const rootNames = roots.map((root) => root.root);
    const candidates = (business.candidates || []).filter((item) => {
      if (normalizeTerm(item.value) === normalizeTerm(searchTerm)) return true;
      return item.matchScope === 'phrase_review' && roots.some((root) => normalizeTerm(root.root) === normalizeTerm(item.value));
    });
    if (!term) return;
    const drawer = document.querySelector('#cfDecisionPanel [data-drawer]');
    if (!drawer) return;
    const scope = productization.analysisScope || {};
    const currency = scope.financiallyComparable ? single(scope.currencyCodes) || payload.profile?.currencyCode : null;
    const metrics = term.metrics || {};
    const candidateHtml = candidates.length
      ? candidates.map((candidate) => `<div><dt>${esc(candidate.candidateType)}</dt><dd>${esc(candidate.evidence?.reason || candidate.actionType || 'Human review required')}</dd></div>`).join('')
      : kv('Candidate', scope.candidateEmissionAuthorized ? 'No emitted candidate' : 'Suppressed by scope gate');
    drawer.hidden = false;
    drawer.innerHTML = `<header class="cfdi-drawer-header"><div><span>CSV Product Intelligence Evidence</span><strong>${esc(term.searchTerm)}</strong><small>Human review only · Non-authoritative · Amazon mutation disabled</small></div><button type="button" data-drawer-close aria-label="Close drawer">×</button></header>
      <div class="cfdi-drawer-body">
        <div class="cfdi-badges"><span class="cfdi-pill">${esc(term.classificationLabel || term.classification || 'Watchlist')}</span><span class="cfdi-pill">${esc(join(term.rootStates))}</span><span class="cfdi-pill warn">Persistence Disabled</span><span class="cfdi-pill danger">Amazon Execution Disabled</span></div>
        ${section('Classification', `<dl>${kv('Classification', term.classificationLabel || term.classification)}${kv('Priority', term.priorityScore)}${kv('Reason', term.reason)}${kv('Roots', join(rootNames))}${kv('Root states', join(term.rootStates))}${kv('Recommendation governed', yesNo(term.recommendationGoverned === true))}</dl>`)}
        ${section('Current performance', `<dl>${kv('Spend', financialValue(money(metrics.spendMicros, currency), scope.financiallyComparable === true))}${kv('Sales', financialValue(money(metrics.salesMicros, currency), scope.financiallyComparable === true))}${kv('Orders', number(metrics.orders))}${kv('ACoS', financialValue(percent(metrics.acos), scope.financiallyComparable === true))}${kv('ROAS', financialValue(decimal(metrics.roas), scope.financiallyComparable === true))}${kv('CVR', percent(metrics.cvr))}</dl>`)}
        ${section('Lifecycle', `<dl>${kv('Current lifecycle', lifecycle?.stateLabel || lifecycle?.state || '—')}${kv('Lifecycle reason', lifecycle?.reason || '—')}${kv('Current window', dateWindow(lifecycle?.currentWindow))}${kv('Previous window', dateWindow(lifecycle?.previousWindow))}${kv('Current classification', lifecycle?.currentClassification || '—')}${kv('Previous classification', lifecycle?.previousClassification || '—')}</dl>`)}
        ${section('Candidate review', `<dl>${candidateHtml}</dl>`)}
        ${section('Governance', `<dl>${kv('Universe complete', yesNo(scope.complete === true))}${kv('Financially comparable', yesNo(scope.financiallyComparable === true))}${kv('Candidate emission authorized', yesNo(scope.candidateEmissionAuthorized === true))}${kv('Source import IDs', join(term.sourceImportIds))}${kv('Governance persistence allowed', 'no')}${kv('Execution authorized', 'no')}${kv('Amazon mutation authorized', 'no')}</dl>`)}
        <div class="cfdi-callout"><strong>Human review boundary.</strong> Product intelligence can classify, prioritize, and surface candidates, but this UI does not create Optimization Actions or mutate Amazon. Candidate persistence remains behind the existing governance plane.</div>
      </div>`;
  }

  function renderCsvEvidence(item, payload) {
    const drawer = document.querySelector('#cfDecisionPanel [data-drawer]');
    if (!drawer) return;
    const evidence = item.evidence || {};
    const rec = item.recommendation;
    const delta = item.trend?.delta || {};
    const scope = payload?.productization?.analysisScope;
    const comparable = scope ? scope.financiallyComparable === true : true;
    const currency = comparable ? single(scope?.currencyCodes) || payload.profile?.currencyCode : null;
    drawer.hidden = false;
    drawer.innerHTML = `<header class="cfdi-drawer-header"><div><span>Imported CSV Evidence</span><strong>${esc(item.entity?.searchTerm || '')}</strong><small>Non-authoritative · Canonical Amazon identity unverified</small></div><button type="button" data-drawer-close aria-label="Close drawer">×</button></header>
      <div class="cfdi-drawer-body">
        <div class="cfdi-badges"><span class="cfdi-pill warn">Non-authoritative</span><span class="cfdi-pill">CSV provenance ${evidence.csvProvenanceValid ? 'valid' : 'invalid'}</span><span class="cfdi-pill danger">Execution Disabled</span></div>
        ${section('Decision', `<dl>${kv('Decision', rec ? `${rec.family} · ${rec.actionType}` : item.suppression?.code || 'Observe')}${kv('Confidence', `${item.confidence?.band || 'low'} · ${percent(item.confidence?.score)}`)}${kv('Fingerprint', item.fingerprint || '—')}${kv('Canonical identity verified', 'no')}</dl>`)}
        ${section('Performance', `<dl>${kv('Spend', financialValue(money(item.metrics?.spendMicros, currency), comparable))}${kv('Sales', financialValue(money(item.metrics?.salesMicros, currency), comparable))}${kv('Orders', number(item.metrics?.orders))}${kv('ACoS', financialValue(percent(item.metrics?.acos), comparable))}${kv('ROAS', financialValue(decimal(item.metrics?.roas), comparable))}${kv('CVR', percent(item.metrics?.cvr))}</dl>`)}
        ${section('Imported provenance', `<dl>${kv('Source kind', 'csv_import')}${kv('Import IDs', join(evidence.sourceImportIds))}${kv('Content SHA-256', join(evidence.contentSha256s))}${kv('Fact rows', evidence.factRowCount)}${kv('Latest report', evidence.latestReportDate || item.freshness?.latestReportDate || '—')}${kv('Observed advertiser account ID', evidence.advertiserAccountId || '—')}${kv('Observed campaign ID', evidence.campaignId || item.entity?.campaignId || '—')}${kv('Observed ad group ID', evidence.adGroupId || item.entity?.adGroupId || '—')}${kv('Observed targeting ID', evidence.targetingId || item.entity?.targetId || '—')}${kv('CSV targeting identity state', evidence.targetingIdentityState || item.entity?.targetingIdentityState || '—')}${kv('Campaign name', item.entity?.campaignName || '—')}${kv('Ad group name', item.entity?.adGroupName || '—')}${kv('Targeting', item.entity?.targeting || '—')}</dl>`)}
        ${section('Comparable trend', `<dl>${kv('Spend Δ', financialValue(signedPercent(delta.spendPct), comparable))}${kv('Sales Δ', financialValue(signedPercent(delta.salesPct), comparable))}${kv('Orders Δ', signedPercent(delta.ordersPct))}${kv('ACoS Δ', financialValue(signedPp(delta.acosPp), comparable))}</dl>`)}
        <div class="cfdi-callout"><strong>Governance persistence disabled.</strong> Verify canonical Amazon profile/campaign/ad-group/keyword or target identity before creating an Optimization Action. Observed CSV IDs alone do not authorize persistence or Amazon mutation.</div>
      </div>`;
  }

  function buildRootMap(roots) {
    const map = new Map();
    for (const root of Array.isArray(roots) ? roots : []) {
      for (const term of root?.searchTerms || []) {
        const key = normalizeTerm(term);
        if (!key) continue;
        const current = map.get(key) || [];
        current.push(root);
        map.set(key, current);
      }
    }
    return map;
  }

  function buildCandidateMap(candidates, roots) {
    const map = new Map();
    const rootByName = new Map((Array.isArray(roots) ? roots : []).map((root) => [normalizeTerm(root?.root), root]));
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const keys = candidate?.matchScope === 'phrase_review'
        ? (rootByName.get(normalizeTerm(candidate?.value))?.searchTerms || []).map(normalizeTerm)
        : [normalizeTerm(candidate?.value)];
      for (const key of keys) {
        if (!key) continue;
        const current = map.get(key) || [];
        current.push(candidate);
        map.set(key, current);
      }
    }
    return map;
  }

  function allBusinessTerms(business) {
    const groups = business?.groups || {};
    return [
      ...(groups.profitWinners || []),
      ...(groups.scaleOpportunities || []),
      ...(groups.wasteTerms || []),
      ...(groups.watchlist || []),
    ];
  }

  function classificationReasonFallback(mode) {
    if (mode === 'scale') return 'Profitable term with enough evidence to review for scale.';
    if (mode === 'waste') return 'Waste threshold reached; review evidence before negative action.';
    if (mode === 'profit') return 'Profitable term within the current governed analysis window.';
    return 'Insufficient or unstable evidence; continue observation.';
  }

  function clearCsvResults() {
    const target = document.querySelector('#cfDecisionPanel [data-results]');
    if (target && currentSource() === 'csv') target.innerHTML = '';
    closeDrawer();
  }

  function closeDrawer() {
    const drawer = document.querySelector('#cfDecisionPanel [data-drawer]');
    if (drawer) {
      drawer.hidden = true;
      drawer.innerHTML = '';
    }
  }

  function setStatus(text, kind) {
    const status = document.querySelector('#cfDecisionPanel [data-status]');
    if (status) {
      status.textContent = text;
      status.dataset.kind = kind || '';
    }
  }

  function currentSource() {
    return document.querySelector('#cfDecisionPanel [name="dataSource"]')?.value || 'csv';
  }

  function currentStoreId() {
    return String(global.CloudflareOperatorContext?.getContext?.().storeId || global.CloudflareOperatorWorkspace?.currentStoreId?.() || '').trim();
  }

  function value(panel, name) {
    return String(panel?.querySelector(`[name="${name}"]`)?.value || '').trim();
  }

  async function requestJson(url, { signal } = {}) {
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

  function summaryCard(label, value) {
    return `<div><span>${esc(label)}</span><strong>${number(value)}</strong></div>`;
  }

  function section(title, content) {
    return `<section class="cfdi-detail-section"><h3>${esc(title)}</h3>${content}</section>`;
  }

  function kv(key, value) {
    return `<div><dt>${esc(key)}</dt><dd>${esc(value ?? '—')}</dd></div>`;
  }

  function join(value) {
    return Array.isArray(value) && value.length ? value.join(', ') : '—';
  }

  function single(value) {
    return Array.isArray(value) && value.length === 1 ? String(value[0] || '') : '';
  }

  function normalizeTerm(value) {
    return String(value || '').trim().toLowerCase();
  }

  function dateWindow(value) {
    return value?.startDate && value?.endDate ? `${value.startDate} → ${value.endDate}` : '—';
  }

  function yesNo(value) {
    return value ? 'yes' : 'no';
  }

  function financialValue(value, comparable) {
    return comparable ? value : '—';
  }

  function number(value) {
    return new Intl.NumberFormat().format(Number(value || 0));
  }

  function decimal(value) {
    return value == null ? '—' : Number(value).toFixed(2);
  }

  function money(micros, currency) {
    const numeric = Number(micros);
    if (!Number.isFinite(numeric)) return '—';
    const amount = numeric / 1_000_000;
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: currency || 'USD',
        maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      return amount.toFixed(2);
    }
  }

  function percent(value) {
    return value == null ? '—' : `${(Number(value) * 100).toFixed(1)}%`;
  }

  function signedPercent(value) {
    return value == null ? '—' : `${Number(value) >= 0 ? '+' : ''}${(Number(value) * 100).toFixed(1)}%`;
  }

  function signedPp(value) {
    return value == null ? '—' : `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(1)}pp`;
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
})(window);
