(function initDecisionIntelligence(global) {
  'use strict';

  const VERSION = '2.0.0';
  const STORAGE_PROFILE = 'aoi.decision.profileId';
  const STORAGE_RANGE = 'aoi.decision.rangeDays';
  const DECISION_SCOPE_CONTROLS = new Set(['profileId', 'startDate', 'endDate', 'limit', 'sort']);
  const state = {
    mounted: false,
    open: false,
    tab: 'intelligence',
    loading: false,
    payload: null,
    actions: null,
    intelligenceSerial: 0,
    actionsSerial: 0,
    detailSerial: 0,
    governanceSerial: 0,
    selectedIntelligenceIndex: null,
    selectedActionId: null,
    dryRuns: new Map(),
  };

  if (!global.document) return;
  if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();

  function mount() {
    if (state.mounted || !global.document.body) return;
    state.mounted = true;
    installStyles();

    const launcher = document.createElement('button');
    launcher.id = 'cfDecisionLauncher';
    launcher.type = 'button';
    launcher.textContent = 'Decision Intelligence';
    launcher.setAttribute('aria-haspopup', 'dialog');
    launcher.addEventListener('click', () => setOpen(true));
    document.body.appendChild(launcher);

    const panel = document.createElement('section');
    panel.id = 'cfDecisionPanel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', 'Search Term Decision Intelligence');
    panel.innerHTML = shell();
    document.body.appendChild(panel);

    panel.querySelector('[data-close]').addEventListener('click', () => setOpen(false));
    panel.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => {
      state.tab = button.dataset.tab;
      renderTabs();
      if (state.tab === 'actions') void loadActions();
    }));
    panel.querySelector('[data-run]').addEventListener('click', () => void runIntelligence());
    panel.querySelector('[data-refresh-actions]').addEventListener('click', () => void loadActions());
    panel.querySelector('[data-actions-filter]').addEventListener('change', () => void loadActions());
    panel.querySelector('[data-results]').addEventListener('click', handleIntelligenceClick);
    panel.querySelector('[data-actions-results]').addEventListener('click', handleActionClick);
    panel.querySelector('[data-drawer]').addEventListener('click', handleDrawerClick);
    panel.addEventListener('change', handleDecisionScopeChange);

    panel.querySelector('[name="profileId"]').value = localStorage.getItem(STORAGE_PROFILE) || '';
    panel.querySelector('[name="rangeDays"]').value = localStorage.getItem(STORAGE_RANGE) || '30';
    setDates();

    global.addEventListener?.('cloudflare-operator-store-change', () => {
      state.intelligenceSerial += 1;
      state.actionsSerial += 1;
      state.detailSerial += 1;
      state.governanceSerial += 1;
      state.loading = false;
      state.payload = null;
      state.actions = null;
      state.dryRuns.clear();
      panel.querySelector('[data-results]').innerHTML = '';
      panel.querySelector('[data-actions-results]').innerHTML = '';
      panel.querySelector('[data-actions-status]').textContent = '';
      setStatus('Store changed. Run preview for the selected store.', 'warn');
      closeDrawer();
      if (state.open && state.tab === 'actions') void loadActions();
      renderContext();
    });
    renderContext();
    renderTabs();
  }

  function shell() {
    return `
      <header class="cfdi-header">
        <div>
          <div class="cfdi-eyebrow">NON-AUTHORITATIVE PREVIEW</div>
          <h2>Search Term Decision Intelligence</h2>
          <p>Evidence-backed recommendation governance. Development preview / non-authoritative. Amazon execution remains disabled.</p>
        </div>
        <button type="button" class="cfdi-close" data-close aria-label="Close">×</button>
      </header>
      <div class="cfdi-context" data-context></div>
      <nav class="cfdi-tabs" aria-label="Decision Intelligence views">
        <button type="button" data-tab="intelligence">Intelligence</button>
        <button type="button" data-tab="actions">Action Inbox</button>
      </nav>
      <div class="cfdi-view" data-view="intelligence">
        <div class="cfdi-controls">
          <label>Profile ID<input name="profileId" autocomplete="off" placeholder="profile-synth-dev-01"></label>
          <label>Start<input name="startDate" type="date"></label>
          <label>End<input name="endDate" type="date"></label>
          <label>Rows<select name="limit"><option>25</option><option selected>50</option><option>100</option></select></label>
          <label>Sort<select name="sort"><option value="cost">Spend</option><option value="sales">Sales</option><option value="clicks">Clicks</option><option value="orders">Orders</option></select></label>
          <label class="cfdi-hidden">Range days<input name="rangeDays" value="30"></label>
          <button type="button" class="cfdi-primary" data-run>Run preview</button>
        </div>
        <div class="cfdi-status" data-status>Profile scope is required. Development and fixture data can never become recommendation authority.</div>
        <div data-results></div>
      </div>
      <div class="cfdi-view" data-view="actions" hidden>
        <div class="cfdi-actions-bar">
          <div><strong>Optimization Action Inbox</strong><span>Governance lifecycle only. Execution Disabled.</span></div>
          <button type="button" data-refresh-actions>Refresh</button>
        </div>
        <div class="cfdi-action-filters" data-actions-filter>
          <label>Status<select name="actionStatus"><option value="">All</option><option value="proposed">Proposed</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></label>
          <label>Type<select name="actionType"><option value="">All</option><option value="negative_keyword.create">Negative keyword</option><option value="keyword.create">Harvest keyword</option></select></label>
          <label>Confidence<select name="actionConfidence"><option value="">All</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
          <label>Freshness<select name="actionFreshness"><option value="">All</option><option value="fresh">Fresh</option><option value="aging">Aging</option><option value="stale">Stale</option><option value="unknown">Unknown</option></select></label>
          <label>Authority<select name="actionAuthority"><option value="">All</option><option value="non-authoritative">Non-authoritative</option><option value="authoritative">Authoritative</option></select></label>
          <label>Sort<select name="actionSort"><option value="actionable">Actionable first</option><option value="risk">Risk score</option><option value="newest">Newest</option></select></label>
        </div>
        <div class="cfdi-status" data-actions-status></div>
        <div data-actions-results></div>
      </div>
      <aside class="cfdi-drawer" data-drawer hidden aria-label="Evidence Drilldown"></aside>`;
  }

  function handleDecisionScopeChange(event) {
    const name = String(event.target?.name || '');
    if (!DECISION_SCOPE_CONTROLS.has(name)) return;
    state.intelligenceSerial += 1;
    state.detailSerial += 1;
    state.governanceSerial += 1;
    state.loading = false;
    state.payload = null;
    state.dryRuns.clear();
    panelNode().querySelector('[data-results]').innerHTML = '';
    setStatus('Decision scope changed. Run preview again before review or persistence.', 'warn');
    closeDrawer();
  }

  async function runIntelligence() {
    const panel = panelNode();
    const storeId = currentStoreId();
    const profileId = value(panel, 'profileId');
    const startDate = value(panel, 'startDate');
    const endDate = value(panel, 'endDate');
    if (!storeId) return setStatus('Select a store in Operator Workspace first.', 'warn');
    if (!profileId) return setStatus('Profile ID is required; unscoped intelligence is forbidden.', 'warn');
    if (!startDate || !endDate) return setStatus('Start and end dates are required.', 'warn');

    const serial = ++state.intelligenceSerial;
    localStorage.setItem(STORAGE_PROFILE, profileId);
    setStatus('Computing deterministic preview, trend context and freshness…', 'loading');
    state.loading = true;
    closeDrawer();
    try {
      const params = new URLSearchParams({
        profileId,
        startDate,
        endDate,
        limit: value(panel, 'limit') || '50',
        sort: value(panel, 'sort') || 'cost',
      });
      const payload = await requestJson(`/api/v1/stores/${encodeURIComponent(storeId)}/search-term-intelligence?${params}`);
      if (serial !== state.intelligenceSerial || storeId !== currentStoreId()) return;
      state.payload = payload;
      renderIntelligence(payload);
      const label = payload?.authority?.authoritative ? 'Authoritative' : 'Development preview / non-authoritative';
      setStatus(`${label}. ${payload?.summary?.recommendationCandidateCount || 0} preview candidates from ${payload?.summary?.itemCount || 0} rows. Amazon execution remains disabled.`, payload?.authority?.authoritative ? 'ok' : 'warn');
    } catch (error) {
      if (serial !== state.intelligenceSerial || storeId !== currentStoreId()) return;
      state.payload = null;
      panel.querySelector('[data-results]').innerHTML = '';
      setStatus(error.message || 'Decision Intelligence request failed.', 'error');
    } finally {
      if (serial === state.intelligenceSerial && storeId === currentStoreId()) state.loading = false;
    }
  }

  async function loadActions() {
    const storeId = currentStoreId();
    const serial = ++state.actionsSerial;
    const panel = panelNode();
    const target = panel.querySelector('[data-actions-results]');
    const status = panel.querySelector('[data-actions-status]');
    if (!storeId) {
      status.textContent = 'Select a store in Operator Workspace first.';
      target.innerHTML = '';
      return;
    }
    status.textContent = 'Loading Action Inbox…';
    closeDrawer();
    try {
      const params = new URLSearchParams({ limit: '100' });
      addParam(params, 'status', value(panel, 'actionStatus'));
      addParam(params, 'actionType', value(panel, 'actionType'));
      addParam(params, 'confidence', value(panel, 'actionConfidence'));
      addParam(params, 'freshness', value(panel, 'actionFreshness'));
      addParam(params, 'authority', value(panel, 'actionAuthority'));
      addParam(params, 'sort', value(panel, 'actionSort') || 'actionable');
      const profileId = value(panel, 'profileId');
      if (profileId) params.set('profileId', profileId);
      const payload = await requestJson(`/api/v1/stores/${encodeURIComponent(storeId)}/optimization-actions?${params}`);
      if (serial !== state.actionsSerial || storeId !== currentStoreId()) return;
      state.actions = payload;
      status.textContent = `${payload.items?.length || 0} actions. Governance only; Amazon execution remains disabled.`;
      target.innerHTML = actionTable(payload.items || []);
    } catch (error) {
      if (serial !== state.actionsSerial || storeId !== currentStoreId()) return;
      state.actions = null;
      status.textContent = error.message || 'Action Inbox unavailable.';
      target.innerHTML = '';
    }
  }

  function renderIntelligence(payload) {
    const target = panelNode().querySelector('[data-results]');
    const summary = payload.summary || {};
    const freshness = summary.freshness || {};
    const cards = `
      <div class="cfdi-summary">
        ${summaryCard('Rows', summary.itemCount || 0)}
        ${summaryCard('Candidates', summary.recommendationCandidateCount || 0)}
        ${summaryCard('Lineage valid', summary.lineageValidItemCount || 0)}
        ${summaryCard('Fresh', freshness.fresh || 0)}
        ${summaryCard('Stale', freshness.stale || 0)}
      </div>`;
    const items = (payload.items || []).map((item, index) => intelligenceRow(item, payload, index)).join('');
    target.innerHTML = `${cards}<div class="cfdi-table-wrap"><table class="cfdi-table"><thead><tr><th>Search term</th><th>Spend</th><th>Sales</th><th>Orders</th><th>ACoS</th><th>Trend</th><th>Decision</th><th>Confidence</th><th>Review</th></tr></thead><tbody>${items || '<tr><td colspan="9">No rows in this scoped window.</td></tr>'}</tbody></table></div>`;
  }

  function intelligenceRow(item, payload, index) {
    const m = item.metrics || {};
    const rec = item.recommendation;
    const suppressed = item.suppression;
    const decision = rec ? `${escapeHtml(rec.family)} · ${escapeHtml(rec.actionType)}` : (suppressed ? `Suppressed · ${escapeHtml(suppressed.code)}` : 'Observe');
    const fingerprint = item.fingerprint ? `<small title="${escapeHtml(item.fingerprint)}">FP ${escapeHtml(item.fingerprint.slice(0, 12))}…</small>` : '';
    const trend = item.trend?.delta || {};
    const freshness = item.freshness || { state: 'unknown' };
    const review = `<button type="button" class="cfdi-link" data-evidence-index="${index}">Evidence</button>`;
    return `<tr>
      <td><strong>${escapeHtml(item.entity?.searchTerm || '')}</strong><small>${escapeHtml(item.entity?.campaignName || item.entity?.campaignId || '')}</small></td>
      <td>${money(m.spendMicros, payload.profile?.currencyCode)}</td>
      <td>${money(m.salesMicros, payload.profile?.currencyCode)}</td>
      <td>${number(m.orders)}</td>
      <td>${percent(m.acos)}</td>
      <td><span class="${deltaClass(trend.spendPct)}">Spend ${signedPercent(trend.spendPct)}</span><small>Orders ${signedPercent(trend.ordersPct)}</small></td>
      <td><span class="cfdi-pill ${rec ? 'candidate' : ''}">${decision}</span>${fingerprint}</td>
      <td><span class="cfdi-confidence">${escapeHtml(item.confidence?.band || 'low')} · ${percent(item.confidence?.score)}</span><small>${escapeHtml(freshness.state)} · ${item.evidence?.lineageValid ? 'provenance valid' : 'lineage degraded'}</small></td>
      <td>${review}</td>
    </tr>`;
  }

  function actionTable(items) {
    const rows = items.map((item) => `<tr>
      <td><strong>${escapeHtml(item.actionType || '')}</strong><small>${escapeHtml(item.actionId || '')}</small></td>
      <td>${escapeHtml(item.profileId || '')}</td>
      <td>${escapeHtml(item.entityType || '')}<small>${escapeHtml(item.entityId || '')}</small></td>
      <td><span class="cfdi-pill">${escapeHtml(item.status || '')}</span></td>
      <td>${escapeHtml(item.confidence?.band || '—')}<small>${escapeHtml(item.freshness?.state || 'unknown')}</small></td>
      <td>${authorityBadge(item.authority)}</td>
      <td>${escapeHtml(item.createdAt || '')}</td>
      <td><button type="button" class="cfdi-link" data-action-id="${escapeHtml(item.actionId || '')}">Review</button></td>
    </tr>`).join('');
    return `<div class="cfdi-table-wrap"><table class="cfdi-table"><thead><tr><th>Action</th><th>Profile</th><th>Entity</th><th>Status</th><th>Confidence</th><th>Authority</th><th>Created</th><th>Review</th></tr></thead><tbody>${rows || '<tr><td colspan="8">No actions.</td></tr>'}</tbody></table></div>`;
  }

  function handleIntelligenceClick(event) {
    const button = event.target.closest('[data-evidence-index]');
    if (!button) return;
    const index = Number(button.dataset.evidenceIndex);
    const item = state.payload?.items?.[index];
    if (!item) return;
    state.selectedIntelligenceIndex = index;
    renderIntelligenceDrawer(item, state.payload);
  }

  async function handleActionClick(event) {
    const button = event.target.closest('[data-action-id]');
    if (!button) return;
    const actionId = button.dataset.actionId;
    if (!actionId) return;
    await openActionDetail(actionId);
  }

  async function handleDrawerClick(event) {
    if (event.target.closest('[data-drawer-close]')) return closeDrawer();
    const dryRunButton = event.target.closest('[data-dry-run]');
    if (dryRunButton) return void dryRunSelectedRecommendation();
    const proposeButton = event.target.closest('[data-propose]');
    if (proposeButton) return void persistSelectedRecommendation();
    const rejectButton = event.target.closest('[data-reject-action]');
    if (rejectButton) return void rejectSelectedAction(rejectButton.dataset.rejectAction);
    const approveButton = event.target.closest('[data-approve-action]');
    if (approveButton) return void approveSelectedAction(approveButton.dataset.approveAction);
  }

  function renderIntelligenceDrawer(item, payload) {
    const drawer = panelNode().querySelector('[data-drawer]');
    const rec = item.recommendation;
    const trend = item.trend || {};
    const delta = trend.delta || {};
    const evidence = item.evidence || {};
    const freshness = item.freshness || {};
    const dryRun = item.fingerprint ? state.dryRuns.get(item.fingerprint) : null;
    drawer.hidden = false;
    drawer.innerHTML = `
      ${drawerHeader('Evidence Drilldown', item.entity?.searchTerm || 'Search term')}
      <div class="cfdi-drawer-body">
        <div class="cfdi-badges">${authorityBadge(item.authority)} ${freshnessBadge(freshness)} <span class="cfdi-pill danger">Execution Disabled</span></div>
        ${detailSection('Why recommended?', `
          <dl>${kv('Decision', rec ? `${rec.family} · ${rec.actionType}` : (item.suppression?.code || 'Observe'))}${kv('Rule', payload.ruleVersion || '—')}${kv('Confidence', `${item.confidence?.band || 'low'} · ${percent(item.confidence?.score)}`)}${kv('Fingerprint', item.fingerprint || '—')}</dl>`)}
        ${detailSection('Performance evidence', `
          <div class="cfdi-metric-grid">
            ${metric('Impressions', number(item.metrics?.impressions))}${metric('Clicks', number(item.metrics?.clicks))}${metric('Spend', money(item.metrics?.spendMicros, payload.profile?.currencyCode))}${metric('Orders', number(item.metrics?.orders))}${metric('Sales', money(item.metrics?.salesMicros, payload.profile?.currencyCode))}${metric('CTR', percent(item.metrics?.ctr))}${metric('CPC', money(item.metrics?.cpcMicros, payload.profile?.currencyCode))}${metric('CVR', percent(item.metrics?.cvr))}${metric('ACoS', percent(item.metrics?.acos))}${metric('ROAS', decimal(item.metrics?.roas))}
          </div>`)}
        ${detailSection('Comparable trend', `
          <dl>${kv('Current window', formatWindow(trend.currentWindow))}${kv('Previous window', formatWindow(trend.previousWindow))}${kv('Spend Δ', signedPercent(delta.spendPct))}${kv('Sales Δ', signedPercent(delta.salesPct))}${kv('Orders Δ', signedPercent(delta.ordersPct))}${kv('ACoS Δ', signedPp(delta.acosPp))}${kv('ROAS Δ', signedNumber(delta.roas))}${kv('CVR Δ', signedPp(delta.cvrPp))}${kv('CPC Δ', signedPercent(delta.cpcPct))}</dl>`)}
        ${detailSection('Source provenance', `
          <dl>${kv('Store', payload.storeId)}${kv('Profile', payload.profile?.profileId)}${kv('Campaign', item.entity?.campaignName || item.entity?.campaignId)}${kv('Ad group', item.entity?.adGroupName || item.entity?.adGroupId)}${kv('Keyword / target', item.entity?.keywordText || item.entity?.keywordId || item.entity?.targetId || '—')}${kv('Fact rows', evidence.factRowCount)}${kv('Source report jobs', joinList(evidence.sourceReportJobIds))}${kv('Amazon report IDs', joinList(evidence.amazonReportIds))}${kv('R2 objects', joinList(evidence.r2ObjectKeys))}${kv('Content SHA-256', joinList(evidence.contentSha256s))}${kv('Latest report date', evidence.latestReportDate || freshness.latestReportDate || '—')}${kv('Fact updated', evidence.factUpdatedAt || freshness.factUpdatedAt || '—')}</dl>`)}
        ${rec ? recommendationControls(item, payload, dryRun) : '<div class="cfdi-callout">No persistable recommendation for this row.</div>'}
      </div>`;
  }

  function recommendationControls(item, payload, dryRun) {
    return detailSection('Governance controls', `
      <div class="cfdi-callout"><strong>Explicit operator action required.</strong> Preview never auto-persists. Dry-run performs validation only. Persist creates status <code>proposed</code>; it does not modify Amazon.</div>
      ${dryRun ? `<div class="cfdi-dry-result"><strong>Dry-run valid</strong><small>Request FP ${escapeHtml(dryRun.normalized?.requestFingerprint || '')}</small></div>` : ''}
      <div class="cfdi-button-row">
        <button type="button" data-dry-run>Dry-run validation</button>
        <button type="button" class="cfdi-primary" data-propose ${dryRun?.valid ? '' : 'disabled'}>Persist proposed action</button>
      </div>
      <small>Recommendation FP ${escapeHtml(item.fingerprint || '')} · ${escapeHtml(payload.ruleVersion || '')}</small>`);
  }

  async function dryRunSelectedRecommendation() {
    const item = selectedIntelligenceItem();
    const sourcePayload = state.payload;
    const storeId = currentStoreId();
    if (!item?.recommendation || !sourcePayload || !storeId) return;
    const serial = ++state.governanceSerial;
    setDrawerBusy('Validating dry-run…');
    try {
      const body = recommendationActionBody(item, sourcePayload, true);
      const payload = await requestJson(actionCollectionUrl(true, storeId), jsonPost(body));
      if (serial !== state.governanceSerial || storeId !== currentStoreId()) return;
      state.dryRuns.set(item.fingerprint, payload);
      renderIntelligenceDrawer(item, sourcePayload);
    } catch (error) {
      if (serial !== state.governanceSerial || storeId !== currentStoreId()) return;
      setDrawerError(error.message || 'Dry-run failed.');
    }
  }

  async function persistSelectedRecommendation() {
    const item = selectedIntelligenceItem();
    const sourcePayload = state.payload;
    const storeId = currentStoreId();
    if (!item?.recommendation || !sourcePayload || !storeId) return;
    const dryRun = state.dryRuns.get(item.fingerprint);
    if (!dryRun?.valid) return setDrawerError('Run a valid dry-run before persistence.');
    const serial = ++state.governanceSerial;
    setDrawerBusy('Persisting proposed action…');
    try {
      const payload = await requestJson(actionCollectionUrl(false, storeId), jsonPost(recommendationActionBody(item, sourcePayload, false)));
      if (serial !== state.governanceSerial || storeId !== currentStoreId()) return;
      state.tab = 'actions';
      renderTabs();
      closeDrawer();
      await loadActions();
      if (serial !== state.governanceSerial || storeId !== currentStoreId()) return;
      const status = panelNode().querySelector('[data-actions-status]');
      status.textContent = `${payload.idempotentReuse ? 'Existing' : 'New'} proposed action ${payload.action?.actionId || ''}. Amazon execution remains disabled.`;
    } catch (error) {
      if (serial !== state.governanceSerial || storeId !== currentStoreId()) return;
      setDrawerError(error.message || 'Proposed action persistence failed.');
    }
  }

  function recommendationActionBody(item, payload, dryRun) {
    const rec = item.recommendation;
    return {
      dryRun,
      idempotencyKey: item.fingerprint,
      fingerprint: item.fingerprint,
      schemaVersion: payload.schemaVersion,
      modelVersion: payload.modelVersion,
      ruleVersion: payload.ruleVersion,
      profileId: payload.profile?.profileId,
      entityType: rec.entityType,
      entityId: rec.entityId,
      actionType: rec.actionType,
      sourceType: 'rule',
      ruleKey: payload.ruleVersion,
      before: rec.before,
      proposed: rec.proposed,
      rationale: rec.explanation,
      analysisWindow: payload.range,
      evidence: item.evidence,
      confidence: item.confidence,
      scores: item.scores,
      trend: item.trend,
      freshness: item.freshness,
    };
  }

  async function openActionDetail(actionId) {
    const storeId = currentStoreId();
    if (!storeId) return;
    const serial = ++state.detailSerial;
    state.selectedActionId = actionId;
    const drawer = panelNode().querySelector('[data-drawer]');
    drawer.hidden = false;
    drawer.innerHTML = `${drawerHeader('Action Review', actionId)}<div class="cfdi-drawer-body">Loading governance record…</div>`;
    try {
      const payload = await requestJson(`/api/v1/stores/${encodeURIComponent(storeId)}/optimization-actions/${encodeURIComponent(actionId)}`);
      if (serial !== state.detailSerial || storeId !== currentStoreId()) return;
      renderActionDrawer(payload);
    } catch (error) {
      if (serial !== state.detailSerial || storeId !== currentStoreId()) return;
      setDrawerError(error.message || 'Action detail unavailable.');
    }
  }

  function renderActionDrawer(payload) {
    const drawer = panelNode().querySelector('[data-drawer]');
    const item = payload.action || {};
    const evidence = item.evidence || {};
    const trend = item.trend || {};
    const delta = trend.delta || {};
    const eligibility = payload.transitionEligibility || {};
    drawer.hidden = false;
    drawer.innerHTML = `
      ${drawerHeader('Action Review', item.actionId || '')}
      <div class="cfdi-drawer-body">
        <div class="cfdi-badges"><span class="cfdi-pill">${escapeHtml(item.status || '')}</span> ${authorityBadge(item.authority)} ${freshnessBadge(item.freshness)} <span class="cfdi-pill danger">Execution Disabled</span></div>
        ${detailSection('Action contract', `<dl>${kv('Action type', item.actionType)}${kv('Profile', item.profileId)}${kv('Entity', `${item.entityType || ''} · ${item.entityId || ''}`)}${kv('Rule', item.ruleKey || '—')}${kv('Recommendation fingerprint', item.fingerprint || '—')}${kv('Request fingerprint', item.requestFingerprint || '—')}${kv('Created by', item.createdBy || '—')}${kv('Approved by', item.approvedBy || '—')}${kv('Created', item.createdAt || '—')}</dl>`)}
        ${detailSection('Proposed mutation', `<pre>${escapeHtml(JSON.stringify(item.proposed || {}, null, 2))}</pre>`)}
        ${detailSection('Evidence & freshness', `<dl>${kv('Confidence', `${item.confidence?.band || '—'} · ${percent(item.confidence?.score)}`)}${kv('Freshness', item.freshness?.state || 'unknown')}${kv('Latest report', item.freshness?.latestReportDate || evidence.latestReportDate || '—')}${kv('Source jobs', joinList(evidence.sourceReportJobIds))}${kv('R2 objects', joinList(evidence.r2ObjectKeys))}${kv('Content SHA-256', joinList(evidence.contentSha256s))}</dl>`)}
        ${detailSection('Trend context', `<dl>${kv('Spend Δ', signedPercent(delta.spendPct))}${kv('Sales Δ', signedPercent(delta.salesPct))}${kv('Orders Δ', signedPercent(delta.ordersPct))}${kv('ACoS Δ', signedPp(delta.acosPp))}${kv('ROAS Δ', signedNumber(delta.roas))}</dl>`)}
        ${detailSection('Lifecycle audit', eventTimeline(payload.events || []))}
        ${governanceTransitionControls(item, eligibility)}
      </div>`;
  }

  function governanceTransitionControls(item, eligibility) {
    if (item.status !== 'proposed') return detailSection('Governance controls', '<div class="cfdi-callout">This action is no longer in proposed state. Conditional transitions are closed.</div>');
    return detailSection('Governance controls', `
      <div class="cfdi-callout">Approve means governance approval only. It does not authorize or trigger Amazon execution.</div>
      <label class="cfdi-reason">Rejection reason<textarea name="rejectionReason" maxlength="600" placeholder="Required for reject"></textarea></label>
      <div class="cfdi-button-row">
        <button type="button" class="cfdi-danger-button" data-reject-action="${escapeHtml(item.actionId || '')}" ${eligibility.reject ? '' : 'disabled'}>Reject</button>
        <button type="button" class="cfdi-primary" data-approve-action="${escapeHtml(item.actionId || '')}" ${eligibility.approve ? '' : 'disabled'}>Approve governance</button>
      </div>`);
  }

  async function rejectSelectedAction(actionId) {
    const reason = String(panelNode().querySelector('[name="rejectionReason"]')?.value || '').trim();
    if (!reason) return setDrawerError('Rejection reason is required.');
    const storeId = currentStoreId();
    if (!storeId) return;
    const serial = ++state.governanceSerial;
    setDrawerBusy('Rejecting proposed action…');
    try {
      await requestJson(actionTransitionUrl(actionId, 'reject', storeId), jsonPost({ reason }));
      if (serial !== state.governanceSerial || storeId !== currentStoreId()) return;
      await loadActions();
      if (serial !== state.governanceSerial || storeId !== currentStoreId()) return;
      await openActionDetail(actionId);
    } catch (error) {
      if (serial !== state.governanceSerial || storeId !== currentStoreId()) return;
      setDrawerError(error.message || 'Reject transition failed.');
    }
  }

  async function approveSelectedAction(actionId) {
    const storeId = currentStoreId();
    if (!storeId) return;
    const serial = ++state.governanceSerial;
    setDrawerBusy('Recording governance approval…');
    try {
      await requestJson(actionTransitionUrl(actionId, 'approve', storeId), jsonPost({}));
      if (serial !== state.governanceSerial || storeId !== currentStoreId()) return;
      await loadActions();
      if (serial !== state.governanceSerial || storeId !== currentStoreId()) return;
      await openActionDetail(actionId);
    } catch (error) {
      if (serial !== state.governanceSerial || storeId !== currentStoreId()) return;
      setDrawerError(error.message || 'Approve transition failed.');
    }
  }

  function renderTabs() {
    const panel = panelNode();
    panel.querySelectorAll('[data-tab]').forEach((button) => button.classList.toggle('active', button.dataset.tab === state.tab));
    panel.querySelectorAll('[data-view]').forEach((view) => { view.hidden = view.dataset.view !== state.tab; });
  }

  function renderContext() {
    const target = panelNode()?.querySelector('[data-context]');
    if (!target) return;
    const storeId = currentStoreId();
    target.innerHTML = `<span>Store</span><strong>${escapeHtml(storeId || 'not selected')}</strong><span>Authority</span><strong>fail-closed</strong><span>Execution</span><strong>disabled</strong>`;
  }

  function setOpen(open) {
    state.open = Boolean(open);
    panelNode().classList.toggle('open', state.open);
    if (state.open) renderContext();
    else closeDrawer();
  }

  function setDates() {
    const panel = panelNode();
    const end = new Date();
    const days = Math.min(93, Math.max(1, Number(panel.querySelector('[name="rangeDays"]').value || 30)));
    const start = new Date(end.getTime() - (days - 1) * 86400000);
    panel.querySelector('[name="startDate"]').value = isoDate(start);
    panel.querySelector('[name="endDate"]').value = isoDate(end);
  }

  function setStatus(message, kind) {
    const target = panelNode().querySelector('[data-status]');
    target.textContent = message;
    target.dataset.kind = kind || '';
  }

  function closeDrawer() {
    const drawer = panelNode()?.querySelector('[data-drawer]');
    if (!drawer) return;
    drawer.hidden = true;
    drawer.innerHTML = '';
    state.selectedIntelligenceIndex = null;
    state.selectedActionId = null;
  }

  function setDrawerBusy(message) {
    const body = panelNode().querySelector('[data-drawer] .cfdi-drawer-body');
    if (body) body.insertAdjacentHTML('afterbegin', `<div class="cfdi-drawer-message">${escapeHtml(message)}</div>`);
  }

  function setDrawerError(message) {
    const body = panelNode().querySelector('[data-drawer] .cfdi-drawer-body');
    if (body) body.insertAdjacentHTML('afterbegin', `<div class="cfdi-drawer-message error">${escapeHtml(message)}</div>`);
  }

  function selectedIntelligenceItem() {
    const index = state.selectedIntelligenceIndex;
    return Number.isInteger(index) ? state.payload?.items?.[index] : null;
  }

  async function requestJson(url, options) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(options?.headers || {}) },
      ...options,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function jsonPost(body) {
    return {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  function actionCollectionUrl(dryRun, storeId = currentStoreId()) {
    return `/api/v1/stores/${encodeURIComponent(storeId)}/optimization-actions${dryRun ? '?dryRun=true' : ''}`;
  }

  function actionTransitionUrl(actionId, transition, storeId = currentStoreId()) {
    return `/api/v1/stores/${encodeURIComponent(storeId)}/optimization-actions/${encodeURIComponent(actionId)}/${transition}`;
  }

  function currentStoreId() {
    return String(global.CloudflareOperatorContext?.getContext?.().storeId || global.CloudflareOperatorWorkspace?.currentStoreId?.() || '').trim();
  }
  function panelNode() { return document.getElementById('cfDecisionPanel'); }
  function value(panel, name) { return String(panel.querySelector(`[name="${name}"]`)?.value || '').trim(); }
  function addParam(params, key, val) { if (val) params.set(key, val); }
  function isoDate(date) { return date.toISOString().slice(0, 10); }
  function number(value) { return new Intl.NumberFormat().format(Number(value || 0)); }
  function decimal(value) { return value === null || value === undefined ? '—' : Number(value).toFixed(2); }
  function money(micros, currency) {
    const numeric = Number(micros);
    if (!Number.isFinite(numeric)) return '—';
    const amount = numeric / 1_000_000;
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2 }).format(amount); }
    catch { return amount.toFixed(2); }
  }
  function percent(value) { return value === null || value === undefined ? '—' : `${(Number(value) * 100).toFixed(1)}%`; }
  function signedPercent(value) { return value === null || value === undefined ? '—' : `${Number(value) >= 0 ? '+' : ''}${(Number(value) * 100).toFixed(1)}%`; }
  function signedPp(value) { return value === null || value === undefined ? '—' : `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(1)}pp`; }
  function signedNumber(value) { return value === null || value === undefined ? '—' : `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}`; }
  function deltaClass(value) { return value === null || value === undefined ? '' : (Number(value) > 0 ? 'cfdi-delta-up' : (Number(value) < 0 ? 'cfdi-delta-down' : '')); }
  function summaryCard(label, val) { return `<div><span>${escapeHtml(label)}</span><strong>${number(val)}</strong></div>`; }
  function metric(label, val) { return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(val)}</strong></div>`; }
  function kv(key, val) { return `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(val ?? '—')}</dd></div>`; }
  function joinList(value) { return Array.isArray(value) && value.length ? value.join(', ') : '—'; }
  function formatWindow(value) { return value?.startDate && value?.endDate ? `${value.startDate} → ${value.endDate}` : '—'; }
  function drawerHeader(title, subtitle) { return `<header class="cfdi-drawer-header"><div><span>Evidence Drilldown</span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(subtitle || '')}</small></div><button type="button" data-drawer-close aria-label="Close drawer">×</button></header>`; }
  function detailSection(title, content) { return `<section class="cfdi-detail-section"><h3>${escapeHtml(title)}</h3>${content}</section>`; }
  function authorityBadge(authority) { return `<span class="cfdi-pill ${authority?.authoritative ? 'ok' : 'warn'}">${authority?.authoritative ? 'Authoritative' : 'Non-authoritative'}</span>`; }
  function freshnessBadge(freshness) { return `<span class="cfdi-pill freshness-${escapeHtml(freshness?.state || 'unknown')}">${escapeHtml(freshness?.state || 'unknown')}</span>`; }
  function eventTimeline(events) {
    if (!events.length) return '<div class="cfdi-callout">No events.</div>';
    return `<ol class="cfdi-events">${events.map((event) => `<li><strong>${escapeHtml(event.eventType || '')}</strong><span>${escapeHtml(event.actorId || 'system')} · ${escapeHtml(event.occurredAt || '')}</span>${event.details?.reason ? `<small>${escapeHtml(event.details.reason)}</small>` : ''}</li>`).join('')}</ol>`;
  }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }

  function installStyles() {
    if (document.getElementById('cfDecisionStyles')) return;
    const style = document.createElement('style');
    style.id = 'cfDecisionStyles';
    style.textContent = `
      #cfDecisionLauncher{position:fixed;right:22px;bottom:22px;z-index:2147482000;border:1px solid #d0d5dd;background:#101828;color:#fff;border-radius:999px;padding:11px 16px;font:600 13px/1.2 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 12px 30px rgba(16,24,40,.2);cursor:pointer}
      #cfDecisionPanel{position:fixed;right:20px;top:18px;bottom:18px;width:min(1180px,calc(100vw - 40px));z-index:2147482001;background:#fff;color:#101828;border:1px solid #e4e7ec;border-radius:18px;box-shadow:0 24px 80px rgba(16,24,40,.24);display:none;overflow:auto;font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      #cfDecisionPanel.open{display:block}#cfDecisionPanel *{box-sizing:border-box}.cfdi-header{display:flex;justify-content:space-between;gap:24px;padding:24px 26px 18px;border-bottom:1px solid #eaecf0}.cfdi-header h2{font-size:22px;margin:3px 0 5px}.cfdi-header p{margin:0;color:#667085;max-width:760px}.cfdi-eyebrow{font-size:11px;font-weight:800;letter-spacing:.08em;color:#b54708}.cfdi-close,.cfdi-drawer-header button{border:0;background:#f2f4f7;border-radius:10px;width:36px;height:36px;font-size:24px;cursor:pointer}.cfdi-context{display:flex;gap:8px;align-items:center;padding:12px 26px;background:#fffaeb;border-bottom:1px solid #fedf89}.cfdi-context span{color:#667085}.cfdi-context strong{margin-right:18px}.cfdi-tabs{padding:14px 26px 0;display:flex;gap:4px;border-bottom:1px solid #eaecf0}.cfdi-tabs button{border:0;background:transparent;padding:10px 13px;color:#667085;font-weight:700;cursor:pointer;border-bottom:2px solid transparent}.cfdi-tabs button.active{color:#101828;border-color:#101828}.cfdi-view{padding:20px 26px 30px}.cfdi-controls,.cfdi-action-filters{display:grid;grid-template-columns:repeat(6,minmax(120px,1fr));gap:10px;align-items:end}.cfdi-controls label,.cfdi-action-filters label,.cfdi-reason{display:grid;gap:5px;color:#475467;font-size:12px;font-weight:700}.cfdi-controls input,.cfdi-controls select,.cfdi-action-filters select,.cfdi-reason textarea{width:100%;border:1px solid #d0d5dd;border-radius:9px;padding:9px 10px;background:#fff;color:#101828;font:inherit}.cfdi-reason textarea{min-height:84px;resize:vertical}.cfdi-controls button,.cfdi-actions-bar button,.cfdi-button-row button,.cfdi-link{border:1px solid #d0d5dd;background:#fff;color:#344054;border-radius:9px;padding:9px 12px;font-weight:700;cursor:pointer}.cfdi-primary{background:#101828!important;color:#fff!important;border-color:#101828!important}.cfdi-danger-button{color:#b42318!important;border-color:#fda29b!important}.cfdi-controls button:disabled,.cfdi-button-row button:disabled{opacity:.45;cursor:not-allowed}.cfdi-hidden{display:none!important}.cfdi-status{margin:14px 0;padding:10px 12px;border-radius:10px;background:#f9fafb;color:#475467}.cfdi-status[data-kind="warn"]{background:#fffaeb;color:#93370d}.cfdi-status[data-kind="error"]{background:#fef3f2;color:#b42318}.cfdi-status[data-kind="ok"]{background:#ecfdf3;color:#027a48}.cfdi-summary{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:0 0 14px}.cfdi-summary>div,.cfdi-metric-grid>div{border:1px solid #eaecf0;border-radius:12px;padding:12px;background:#fcfcfd}.cfdi-summary span,.cfdi-metric-grid span{display:block;color:#667085;font-size:12px}.cfdi-summary strong,.cfdi-metric-grid strong{display:block;margin-top:4px;font-size:19px}.cfdi-table-wrap{overflow:auto;border:1px solid #eaecf0;border-radius:12px}.cfdi-table{width:100%;border-collapse:collapse;min-width:940px}.cfdi-table th,.cfdi-table td{padding:10px 11px;text-align:left;border-bottom:1px solid #f2f4f7;vertical-align:top}.cfdi-table th{background:#f9fafb;color:#475467;font-size:11px;text-transform:uppercase;letter-spacing:.04em}.cfdi-table td strong{display:block}.cfdi-table small{display:block;color:#667085;margin-top:3px;max-width:280px;overflow-wrap:anywhere}.cfdi-pill{display:inline-flex;align-items:center;border-radius:999px;background:#f2f4f7;padding:3px 8px;font-size:11px;font-weight:800;color:#475467}.cfdi-pill.candidate,.cfdi-pill.ok{background:#ecfdf3;color:#027a48}.cfdi-pill.warn{background:#fffaeb;color:#b54708}.cfdi-pill.danger{background:#fef3f2;color:#b42318}.cfdi-pill.freshness-fresh{background:#ecfdf3;color:#027a48}.cfdi-pill.freshness-aging{background:#fffaeb;color:#b54708}.cfdi-pill.freshness-stale{background:#fef3f2;color:#b42318}.cfdi-confidence{font-weight:700}.cfdi-actions-bar{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:12px}.cfdi-actions-bar div{display:grid}.cfdi-actions-bar span{color:#667085;font-size:12px}.cfdi-action-filters{margin-bottom:12px}.cfdi-link{padding:5px 8px;font-size:12px}.cfdi-delta-up{color:#b54708}.cfdi-delta-down{color:#027a48}.cfdi-drawer{position:fixed;z-index:2147482002;right:20px;top:18px;bottom:18px;width:min(620px,calc(100vw - 44px));background:#fff;border-left:1px solid #e4e7ec;border-radius:0 18px 18px 0;box-shadow:-18px 0 46px rgba(16,24,40,.18);overflow:auto}.cfdi-drawer-header{position:sticky;top:0;background:#fff;border-bottom:1px solid #eaecf0;padding:18px 20px;display:flex;justify-content:space-between;gap:16px;z-index:2}.cfdi-drawer-header div{display:grid}.cfdi-drawer-header span{font-size:11px;font-weight:800;letter-spacing:.06em;color:#667085}.cfdi-drawer-header strong{font-size:18px}.cfdi-drawer-header small{color:#667085}.cfdi-drawer-body{padding:18px 20px 30px}.cfdi-badges{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}.cfdi-detail-section{border-top:1px solid #eaecf0;padding:16px 0}.cfdi-detail-section:first-of-type{border-top:0}.cfdi-detail-section h3{font-size:14px;margin:0 0 10px}.cfdi-detail-section dl{display:grid;gap:7px;margin:0}.cfdi-detail-section dl>div{display:grid;grid-template-columns:150px minmax(0,1fr);gap:12px}.cfdi-detail-section dt{color:#667085}.cfdi-detail-section dd{margin:0;overflow-wrap:anywhere}.cfdi-detail-section pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f9fafb;border:1px solid #eaecf0;border-radius:10px;padding:12px}.cfdi-metric-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.cfdi-metric-grid strong{font-size:15px}.cfdi-callout,.cfdi-dry-result,.cfdi-drawer-message{padding:10px 12px;border:1px solid #eaecf0;border-radius:10px;background:#f9fafb;margin-bottom:10px}.cfdi-dry-result{background:#ecfdf3;border-color:#abefc6;color:#027a48;display:grid}.cfdi-dry-result small{overflow-wrap:anywhere}.cfdi-drawer-message{background:#fffaeb;border-color:#fedf89}.cfdi-drawer-message.error{background:#fef3f2;border-color:#fecdca;color:#b42318}.cfdi-button-row{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.cfdi-events{list-style:none;padding:0;margin:0;display:grid;gap:8px}.cfdi-events li{border-left:3px solid #d0d5dd;padding-left:10px;display:grid}.cfdi-events span,.cfdi-events small{color:#667085;font-size:12px}
      @media(max-width:900px){#cfDecisionPanel{right:8px;left:8px;top:8px;bottom:8px;width:auto}.cfdi-controls,.cfdi-action-filters{grid-template-columns:repeat(2,1fr)}.cfdi-summary{grid-template-columns:repeat(2,1fr)}.cfdi-drawer{right:8px;top:8px;bottom:8px;width:calc(100vw - 16px);border-radius:16px}.cfdi-metric-grid{grid-template-columns:repeat(2,1fr)}}
    `;
    document.head.appendChild(style);
  }

  global.CloudflareDecisionIntelligence = Object.freeze({ version: VERSION, open: () => setOpen(true) });
})(window);
