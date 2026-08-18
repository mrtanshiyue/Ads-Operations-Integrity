(function initCloudflareCsvProductUi(global) {
  'use strict';

  const VERSION = '2.0.1';
  const REVIEW_STATES = Object.freeze(['open', 'acknowledged', 'dismissed', 'snoozed']);
  const state = {
    mounted: false,
    storeId: '',
    canImportRead: false,
    canAnalyticsRead: false,
    canWrite: false,
    reviews: [],
    selectedReviewId: '',
    authority: null,
    loading: false,
    message: null,
    reviewRoot: null,
    observer: null,
    navScheduled: false,
  };

  const publicApi = Object.freeze({
    version: VERSION,
    openImports,
    openCsvIntelligence,
    openAdvisoryReview,
    refreshAdvisoryReview,
    currentStoreId: () => state.storeId,
  });

  Object.defineProperty(global, 'CloudflareCsvProductUI', {
    value: publicApi,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  if (!global.document) return;
  if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();

  function mount() {
    if (state.mounted || !global.document?.body) return;
    state.mounted = true;
    installStyles();
    mountReviewSurface();
    global.document.addEventListener('click', onDocumentClick);
    global.document.addEventListener('change', onDocumentChange);
    global.addEventListener?.('cloudflare-operator-store-change', onStoreChange);
    state.observer = new MutationObserver(scheduleNavigationRepair);
    state.observer.observe(global.document.body, { childList: true, subtree: true });
    syncStore();
    ensureDataNavigation();
    void refreshPermissions();
  }

  function scheduleNavigationRepair() {
    if (state.navScheduled) return;
    state.navScheduled = true;
    queueMicrotask(() => {
      state.navScheduled = false;
      ensureDataNavigation();
    });
  }

  async function refreshPermissions() {
    syncStore();
    state.canImportRead = false;
    state.canAnalyticsRead = false;
    state.canWrite = false;
    try {
      const payload = await global.CloudflareNativeAPI?.capabilities?.();
      const globalPermissions = new Set(Array.isArray(payload?.globalPermissions) ? payload.globalPermissions : []);
      const scoped = new Set(Array.isArray(payload?.storePermissions?.[state.storeId]) ? payload.storePermissions[state.storeId] : []);
      const has = (permission) => globalPermissions.has(permission) || scoped.has(permission);
      state.canWrite = has('ads.write');
      state.canImportRead = state.canWrite || has('ads.read');
      state.canAnalyticsRead = has('analytics.read');
    } catch {
      state.canImportRead = false;
      state.canAnalyticsRead = false;
      state.canWrite = false;
    }
    ensureDataNavigation();
    renderReview();
  }

  function syncStore() {
    const next = String(global.CloudflareOperatorWorkspace?.currentStoreId?.() || state.storeId || '').trim();
    if (!next || next === state.storeId) return;
    state.storeId = next;
    state.reviews = [];
    state.selectedReviewId = '';
    state.authority = null;
  }

  function onStoreChange(event) {
    const next = String(event?.detail?.storeId || '').trim();
    if (!next || next === state.storeId) return;
    state.storeId = next;
    state.reviews = [];
    state.selectedReviewId = '';
    state.authority = null;
    state.message = null;
    void refreshPermissions().then(() => isReviewOpen() ? refreshAdvisoryReview() : null);
  }

  function ensureDataNavigation() {
    const groupsHost = global.document?.querySelector('#cfOperatorWorkspace .cfOperatorGroups');
    if (!groupsHost) return;

    let group = groupsHost.querySelector('[data-csv-product-group]');
    if (!group) {
      group = global.document.createElement('div');
      group.className = 'cfOperatorGroup cfCsvProductGroup';
      group.dataset.group = 'data';
      group.setAttribute('data-csv-product-group', 'true');
      const keywords = groupsHost.querySelector('.cfOperatorGroup[data-group="keywords"]');
      if (keywords?.nextSibling) groupsHost.insertBefore(group, keywords.nextSibling);
      else if (keywords) keywords.insertAdjacentElement('afterend', group);
      else groupsHost.appendChild(group);
    }

    const locale = detectLocale();
    const entries = [
      { key: 'imports', mark: 'I', zh: '数据导入', en: 'Imports', allowed: state.canImportRead },
      { key: 'intelligence', mark: 'C', zh: '搜索词智能', en: 'Search Term Intelligence', allowed: state.canAnalyticsRead },
      { key: 'advisory', mark: 'A', zh: '建议审核', en: 'Advisory Review', allowed: state.canAnalyticsRead },
    ];
    const markup = `<div class="cfOperatorGroupLabel">${locale === 'en' ? 'Data' : '数据'}</div><div class="cfOperatorGroupItems">${entries.map((entry) => {
      const label = locale === 'en' ? entry.en : entry.zh;
      return `<button class="cfOperatorNavItem" type="button" data-csv-product-nav="${entry.key}" title="${escapeHtml(label)}"${entry.allowed ? '' : ' aria-disabled="true" data-locked="true"'}><span class="cfOperatorMark">${entry.mark}</span><span class="cfOperatorNavText">${escapeHtml(label)}</span><span class="cfOperatorNavMeta">${entry.allowed ? '→' : '·'}</span></button>`;
    }).join('')}</div>`;
    if (group.innerHTML !== markup) group.innerHTML = markup;
  }

  async function onDocumentClick(event) {
    const nav = event.target.closest?.('[data-csv-product-nav]');
    if (nav) {
      if (nav.getAttribute('aria-disabled') === 'true') return;
      if (nav.dataset.csvProductNav === 'imports') return void openImports();
      if (nav.dataset.csvProductNav === 'intelligence') return void openCsvIntelligence();
      if (nav.dataset.csvProductNav === 'advisory') return void openAdvisoryReview();
    }

    if (!state.reviewRoot?.contains(event.target)) return;
    if (event.target.closest?.('[data-review-action="close"]')) return closeAdvisoryReview();
    if (event.target.closest?.('[data-review-action="refresh"]')) return void refreshAdvisoryReview();
    const row = event.target.closest?.('[data-review-id]');
    if (row) {
      state.selectedReviewId = row.dataset.reviewId || '';
      state.message = null;
      renderReview();
      return;
    }
    const transition = event.target.closest?.('[data-review-state]');
    if (transition) void transitionReview(transition.dataset.reviewState);
  }

  function onDocumentChange(event) {
    if (state.reviewRoot?.contains(event.target) && event.target?.id === 'cfAdvisoryStateFilter') void refreshAdvisoryReview();
  }

  async function openImports() {
    if (!state.canImportRead) await refreshPermissions();
    if (!state.canImportRead || typeof global.CloudflareImportsConsole?.open !== 'function') return false;
    await global.CloudflareImportsConsole.open();
    return true;
  }

  async function openCsvIntelligence() {
    if (!state.canAnalyticsRead) await refreshPermissions();
    if (!state.canAnalyticsRead || typeof global.CloudflareDecisionIntelligence?.open !== 'function') return false;
    await global.CloudflareDecisionIntelligence.open();
    global.document?.querySelector('#cfDecisionPanel [data-tab="intelligence"]')?.click();
    const select = await findCsvSourceSelect();
    if (!select) return false;
    if (select.value !== 'csv') {
      select.value = 'csv';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  }

  async function findCsvSourceSelect() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const select = global.document?.querySelector('#cfDecisionPanel [name="dataSource"]');
      if (select) return select;
      await new Promise((resolve) => global.setTimeout(resolve, 0));
    }
    return null;
  }

  async function openAdvisoryReview() {
    if (!state.canAnalyticsRead) await refreshPermissions();
    if (!state.canAnalyticsRead || !state.reviewRoot) return false;
    syncStore();
    state.reviewRoot.hidden = false;
    renderReview();
    await refreshAdvisoryReview();
    return true;
  }

  function closeAdvisoryReview() {
    if (state.reviewRoot) state.reviewRoot.hidden = true;
  }

  function isReviewOpen() {
    return Boolean(state.reviewRoot && !state.reviewRoot.hidden);
  }

  async function refreshAdvisoryReview() {
    syncStore();
    if (!state.storeId || !state.canAnalyticsRead || state.loading) return;
    state.loading = true;
    state.message = null;
    renderReview();
    try {
      const filter = String(state.reviewRoot?.querySelector('#cfAdvisoryStateFilter')?.value || '').trim();
      const params = new URLSearchParams({ sourceKind: 'csv_import', limit: '100' });
      if (filter) params.set('state', filter);
      const payload = await requestJson(`/api/v1/stores/${encodeURIComponent(state.storeId)}/advisory-reviews?${params}`);
      state.reviews = Array.isArray(payload?.items) ? payload.items : [];
      state.authority = payload?.authority || null;
      if (!state.reviews.some((item) => item.reviewId === state.selectedReviewId)) state.selectedReviewId = state.reviews[0]?.reviewId || '';
    } catch (error) {
      state.message = { kind: 'bad', text: error.message || 'Advisory Review request failed.' };
      state.reviews = [];
      state.selectedReviewId = '';
    } finally {
      state.loading = false;
      renderReview();
    }
  }

  async function transitionReview(nextState) {
    if (!state.canWrite || !REVIEW_STATES.includes(nextState) || nextState === 'open') return;
    const review = selectedReview();
    if (!review) return;
    const note = String(state.reviewRoot?.querySelector('#cfAdvisoryNote')?.value || '').trim();
    const body = { state: nextState };
    if (note) body.note = note;
    if (nextState === 'snoozed') {
      const raw = String(state.reviewRoot?.querySelector('#cfAdvisorySnoozedUntil')?.value || '').trim();
      const parsed = raw ? new Date(raw) : null;
      if (!parsed || Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
        state.message = { kind: 'warn', text: t('请选择未来的暂停截止时间。', 'Choose a future snooze-until time.') };
        renderReview();
        return;
      }
      body.snoozedUntil = parsed.toISOString();
    }

    state.message = { kind: 'loading', text: t('正在保存审核状态…', 'Saving review state…') };
    renderReview();
    try {
      const payload = await requestJson(`/api/v1/stores/${encodeURIComponent(state.storeId)}/advisory-reviews/${encodeURIComponent(review.reviewId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const updated = payload?.review;
      if (updated) state.reviews = state.reviews.map((item) => item.reviewId === updated.reviewId ? updated : item);
      state.message = { kind: 'ok', text: t('审核状态已保存。', 'Review state saved.') };
    } catch (error) {
      state.message = { kind: 'bad', text: error.message || 'Review update failed.' };
    }
    renderReview();
  }

  function mountReviewSurface() {
    const root = global.document.createElement('section');
    root.id = 'cfAdvisoryReviewPanel';
    root.className = 'cfAdvisoryReviewPanel';
    root.hidden = true;
    root.setAttribute('aria-label', 'Advisory Review');
    root.innerHTML = '<div class="cfAdvisoryBackdrop" data-review-action="close"></div><div class="cfAdvisoryDialog" role="dialog" aria-modal="true"><div class="cfAdvisoryBody"></div></div>';
    global.document.body.appendChild(root);
    state.reviewRoot = root;
  }

  function renderReview() {
    if (!state.reviewRoot || state.reviewRoot.hidden) return;
    const body = state.reviewRoot.querySelector('.cfAdvisoryBody');
    if (!body) return;
    const selected = selectedReview();
    const counts = Object.fromEntries(REVIEW_STATES.map((key) => [key, state.reviews.filter((item) => item.state === key).length]));
    const activeFilter = String(state.reviewRoot.querySelector('#cfAdvisoryStateFilter')?.value || '');
    body.innerHTML = `
      <header class="cfAdvisoryTopline"><div><strong>${escapeHtml(t('建议审核', 'Advisory Review'))}</strong><span>${escapeHtml(state.storeId || t('无店铺上下文', 'No store context'))}</span></div><div><button type="button" data-review-action="refresh" ${state.loading ? 'disabled' : ''}>${escapeHtml(t('刷新', 'Refresh'))}</button><button type="button" data-review-action="close" aria-label="Close">×</button></div></header>
      <div class="cfAdvisoryAuthority"><strong>CSV ADVISORY ONLY</strong><span>${escapeHtml(t('非权威建议 · 不写入 optimization_actions · Amazon 执行与变更均禁用', 'Non-authoritative advisory · no optimization_actions persistence · Amazon execution and mutation disabled'))}</span></div>
      ${state.message ? `<div class="cfAdvisoryMessage ${escapeHtml(state.message.kind)}">${escapeHtml(state.message.text)}</div>` : ''}
      <div class="cfAdvisoryToolbar"><label>${escapeHtml(t('状态', 'State'))}<select id="cfAdvisoryStateFilter"><option value=""${activeFilter === '' ? ' selected' : ''}>${escapeHtml(t('全部', 'All'))}</option>${REVIEW_STATES.map((item) => `<option value="${item}"${activeFilter === item ? ' selected' : ''}>${item}</option>`).join('')}</select></label><div class="cfAdvisoryCounts">${REVIEW_STATES.map((item) => `<span><b>${counts[item]}</b>${item}</span>`).join('')}</div></div>
      <div class="cfAdvisoryGrid"><section class="cfAdvisoryList">${reviewListMarkup()}</section><section class="cfAdvisoryDetail">${selected ? reviewDetailMarkup(selected) : emptyMarkup()}</section></div>`;
  }

  function reviewListMarkup() {
    if (state.loading) return `<div class="cfAdvisoryEmpty">${escapeHtml(t('正在读取审核记录…', 'Loading advisory reviews…'))}</div>`;
    if (!state.reviews.length) return `<div class="cfAdvisoryEmpty">${escapeHtml(t('当前筛选没有审核记录。', 'No advisory reviews match this filter.'))}</div>`;
    return state.reviews.map((review) => `<button type="button" class="cfAdvisoryRow${review.reviewId === state.selectedReviewId ? ' active' : ''}" data-review-id="${escapeHtml(review.reviewId)}"><span class="cfAdvisoryState ${escapeHtml(review.state)}">${escapeHtml(review.state)}</span><span><strong>${escapeHtml(review.recommendationFamily || 'advisory')} · ${escapeHtml(review.recommendationActionType || '')}</strong><small>${escapeHtml(review.entityId || '')}</small></span><time>${escapeHtml(formatDateTime(review.updatedAt))}</time></button>`).join('');
  }

  function reviewDetailMarkup(review) {
    const evidence = review.sourceEvidence || {};
    const authority = review.authority || state.authority || {};
    return `<div class="cfAdvisoryDetailHead"><div><span>${escapeHtml(review.state)}</span><h3>${escapeHtml(review.recommendationFamily || '')} · ${escapeHtml(review.recommendationActionType || '')}</h3><small>${escapeHtml(review.reviewId)}</small></div></div>
      <div class="cfAdvisoryFactGrid">${fact('Entity', review.entityId)}${fact('Reviewer', review.reviewerUserId || '—')}${fact('Created by', review.createdBy || '—')}${fact('Reviewed at', formatDateTime(review.reviewedAt))}${fact('Snoozed until', formatDateTime(review.snoozedUntil))}${fact('Evidence SHA-256', review.sourceEvidenceSha256 || '—')}</div>
      <section class="cfAdvisoryEvidence"><h4>${escapeHtml(t('真实来源证据', 'Source evidence'))}</h4><div class="cfAdvisoryFactGrid">${fact('Import ID', evidence.sourceImportId || join(evidence.sourceImportIds))}${fact('CSV SHA-256', join(evidence.contentSha256s))}${fact('Report date', evidence.reportDate)}${fact('Advertiser account', evidence.advertiserAccountId)}${fact('Campaign ID', evidence.campaignId)}${fact('Ad group ID', evidence.adGroupId)}${fact('Targeting ID', evidence.targetingId)}${fact('Targeting identity', evidence.targetingIdentityState)}${fact('Amazon Profile ID', evidence.amazonProfileId)}</div></section>
      <section class="cfAdvisoryAuthorityDetail"><h4>${escapeHtml(t('权限边界', 'Authority boundary'))}</h4><div class="cfAdvisoryFactGrid">${fact('authoritative', String(Boolean(authority.authoritative)))}${fact('optimizationActionPersistenceAuthorized', String(Boolean(authority.optimizationActionPersistenceAuthorized)))}${fact('executionAuthorized', String(Boolean(authority.executionAuthorized)))}${fact('amazonMutationAuthorized', String(Boolean(authority.amazonMutationAuthorized)))}</div></section>
      <section class="cfAdvisoryReviewControls"><label>${escapeHtml(t('审核备注', 'Reviewer note'))}<textarea id="cfAdvisoryNote" maxlength="4000" ${state.canWrite ? '' : 'disabled'}>${escapeHtml(review.note || '')}</textarea></label><label>${escapeHtml(t('暂停至', 'Snoozed until'))}<input id="cfAdvisorySnoozedUntil" type="datetime-local" ${state.canWrite ? '' : 'disabled'}></label><div class="cfAdvisoryReviewButtons"><button type="button" data-review-state="acknowledged" ${state.canWrite ? '' : 'disabled'}>${escapeHtml(t('已知悉', 'Acknowledge'))}</button><button type="button" data-review-state="dismissed" ${state.canWrite ? '' : 'disabled'}>${escapeHtml(t('忽略', 'Dismiss'))}</button><button type="button" data-review-state="snoozed" ${state.canWrite ? '' : 'disabled'}>${escapeHtml(t('暂停', 'Snooze'))}</button></div><p>${escapeHtml(t('这些操作只改变建议审核状态，不创建执行动作。', 'These controls only change advisory review state; they do not create execution actions.'))}</p></section>`;
  }

  function selectedReview() {
    return state.reviews.find((item) => item.reviewId === state.selectedReviewId) || null;
  }

  function emptyMarkup() {
    return `<div class="cfAdvisoryEmpty">${escapeHtml(t('选择一条记录查看审核者、备注、暂停时间与来源证据。', 'Select a record to inspect reviewer, note, snooze time, and source evidence.'))}</div>`;
  }

  function fact(label, value) {
    return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value == null || value === '' ? '—' : value)}</strong></div>`;
  }

  function join(value) {
    return Array.isArray(value) && value.length ? value.join(', ') : '—';
  }

  async function requestJson(url, options = {}) {
    const { headers = {}, ...rest } = options;
    const response = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...rest,
      headers: { accept: 'application/json', ...headers },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  function detectLocale() {
    return String(global.document?.documentElement?.lang || '').toLowerCase().startsWith('en') ? 'en' : 'zh';
  }

  function t(zh, en) {
    return detectLocale() === 'en' ? en : zh;
  }

  function formatDateTime(value) {
    if (!value) return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  }

  function installStyles() {
    if (global.document?.getElementById('cfCsvProductUiStyles')) return;
    const style = global.document.createElement('style');
    style.id = 'cfCsvProductUiStyles';
    style.textContent = `
      body.cfOperatorWorkspaceReady [data-csv-import-nav]{display:none!important}
      .cfCsvProductGroup{border-top:1px solid var(--line);padding-top:10px}
      .cfAdvisoryReviewPanel[hidden]{display:none!important}.cfAdvisoryReviewPanel{position:fixed;inset:0;z-index:10050;display:grid;place-items:center;padding:18px}.cfAdvisoryBackdrop{position:absolute;inset:0;background:rgba(15,23,42,.42);backdrop-filter:blur(6px)}.cfAdvisoryDialog{position:relative;width:min(1180px,96vw);height:min(780px,92vh);overflow:hidden;border:1px solid var(--line);border-radius:20px;background:var(--card);box-shadow:0 30px 90px rgba(15,23,42,.24)}.cfAdvisoryBody{height:100%;overflow:auto;padding:16px}.cfAdvisoryTopline{display:flex;align-items:center;justify-content:space-between;gap:12px}.cfAdvisoryTopline>div:first-child{display:grid;gap:2px}.cfAdvisoryTopline strong{font-size:17px}.cfAdvisoryTopline span{font-size:11px;color:var(--muted)}.cfAdvisoryTopline button,.cfAdvisoryReviewButtons button{border:1px solid var(--line);border-radius:10px;background:var(--input-bg);color:var(--text);padding:7px 10px;cursor:pointer}.cfAdvisoryTopline>div:last-child{display:flex;gap:6px}.cfAdvisoryAuthority{display:grid;gap:3px;margin:12px 0;padding:10px 12px;border:1px solid color-mix(in srgb,var(--warn) 32%,var(--line));border-radius:12px;background:var(--softWarn);color:var(--warn)}.cfAdvisoryAuthority strong{font-size:10px;letter-spacing:.08em}.cfAdvisoryAuthority span{font-size:11px}.cfAdvisoryMessage{margin:8px 0;padding:9px 10px;border-radius:10px;background:var(--hover-bg);font-size:11px}.cfAdvisoryMessage.ok{color:var(--good);background:var(--softGood)}.cfAdvisoryMessage.warn,.cfAdvisoryMessage.loading{color:var(--warn);background:var(--softWarn)}.cfAdvisoryMessage.bad{color:var(--bad);background:var(--softBad)}.cfAdvisoryToolbar{display:flex;align-items:end;justify-content:space-between;gap:12px;margin-bottom:10px}.cfAdvisoryToolbar label{display:grid;gap:4px;font-size:10px;color:var(--muted)}.cfAdvisoryToolbar select{min-width:160px;padding:7px 9px}.cfAdvisoryCounts{display:flex;gap:6px;flex-wrap:wrap}.cfAdvisoryCounts span{display:flex;gap:5px;padding:5px 8px;border-radius:999px;background:var(--chip);font-size:9.8px;color:var(--muted)}.cfAdvisoryCounts b{color:var(--text)}.cfAdvisoryGrid{display:grid;grid-template-columns:minmax(320px,.85fr) minmax(0,1.5fr);gap:12px;min-height:560px}.cfAdvisoryList,.cfAdvisoryDetail{border:1px solid var(--line);border-radius:14px;background:var(--card);overflow:auto}.cfAdvisoryList{padding:6px}.cfAdvisoryDetail{padding:14px}.cfAdvisoryRow{width:100%;display:grid;grid-template-columns:100px minmax(0,1fr) auto;align-items:center;gap:8px;border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--text);padding:9px;text-align:left;cursor:pointer}.cfAdvisoryRow.active{border-radius:9px;background:color-mix(in srgb,var(--accent) 8%,var(--card))}.cfAdvisoryRow span:nth-child(2){display:grid;gap:3px;min-width:0}.cfAdvisoryRow strong,.cfAdvisoryRow small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cfAdvisoryRow small,.cfAdvisoryRow time{font-size:9.5px;color:var(--muted)}.cfAdvisoryState{font-size:9.5px;font-weight:800}.cfAdvisoryState.open{color:var(--accent)}.cfAdvisoryState.acknowledged{color:var(--good)}.cfAdvisoryState.dismissed{color:var(--muted)}.cfAdvisoryState.snoozed{color:var(--warn)}.cfAdvisoryDetailHead h3{margin:4px 0;font-size:16px}.cfAdvisoryDetailHead span,.cfAdvisoryDetailHead small{font-size:10px;color:var(--muted)}.cfAdvisoryFactGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-top:10px}.cfAdvisoryFactGrid>div{min-width:0;padding:8px;border:1px solid var(--line);border-radius:10px;background:var(--hover-bg)}.cfAdvisoryFactGrid span{display:block;font-size:9px;color:var(--muted)}.cfAdvisoryFactGrid strong{display:block;margin-top:3px;font-size:10.5px;overflow-wrap:anywhere}.cfAdvisoryEvidence,.cfAdvisoryAuthorityDetail,.cfAdvisoryReviewControls{margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}.cfAdvisoryEvidence h4,.cfAdvisoryAuthorityDetail h4{margin:0;font-size:12px}.cfAdvisoryReviewControls{display:grid;gap:8px}.cfAdvisoryReviewControls label{display:grid;gap:4px;font-size:10px;color:var(--muted)}.cfAdvisoryReviewControls textarea{min-height:74px;resize:vertical}.cfAdvisoryReviewControls input,.cfAdvisoryReviewControls textarea{width:100%;padding:8px;border:1px solid var(--line);border-radius:9px;background:var(--input-bg);color:var(--text)}.cfAdvisoryReviewButtons{display:flex;gap:7px;flex-wrap:wrap}.cfAdvisoryReviewControls p{margin:0;font-size:9.8px;color:var(--muted)}.cfAdvisoryEmpty{display:grid;place-items:center;min-height:180px;padding:20px;text-align:center;color:var(--muted);font-size:11px}@media(max-width:840px){.cfAdvisoryGrid{grid-template-columns:1fr}.cfAdvisoryDialog{height:94vh}.cfAdvisoryFactGrid{grid-template-columns:1fr}.cfAdvisoryToolbar{align-items:stretch;flex-direction:column}}
    `;
    global.document.head.appendChild(style);
  }
})(typeof window !== 'undefined' ? window : globalThis);