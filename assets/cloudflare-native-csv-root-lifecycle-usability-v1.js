(function initCsvRootLifecycleUsability(global) {
  'use strict';

  const VERSION = '1.0.2';
  const LIFECYCLE_STATES = Object.freeze([
    'new',
    'emergingWinner',
    'stableWinner',
    'declining',
    'emergingWaste',
    'persistentWaste',
    'recovered',
    'watchlist',
  ]);
  const HOST_SCOPE_CONTROL_NAMES = new Set([
    'dataSource',
    'startDate',
    'endDate',
    'profileId',
    'limit',
    'sort',
    'q',
    'campaignName',
    'adGroupName',
  ]);
  const HOST_SCOPE_TEXT_CONTROL_NAMES = new Set(['q', 'campaignName', 'adGroupName']);
  const state = {
    mounted: false,
    panel: null,
    observer: null,
    timer: null,
    scopeKey: '',
    payload: null,
    controller: null,
    lifecycleFilter: '',
    rootFilter: '',
    lifecycleSort: 'attention',
  };

  Object.defineProperty(global, 'CloudflareCsvRootLifecycleUsability', {
    value: Object.freeze({ version: VERSION, taxonomy: LIFECYCLE_STATES }),
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
    state.observer = new MutationObserver(scheduleSync);
    observePanel();
    panel.addEventListener('change', handleControlChange);
    panel.addEventListener('input', handleHostScopeInput);
    global.addEventListener?.('cloudflare-operator-store-change', resetScope);
    scheduleSync();
  }

  function observePanel() {
    if (!state.observer || !state.panel) return;
    state.observer.observe(state.panel, { childList: true, subtree: true });
  }

  function scheduleSync() {
    if (state.timer) global.clearTimeout(state.timer);
    state.timer = global.setTimeout(() => {
      state.timer = null;
      void sync();
    }, 40);
  }

  async function sync() {
    if (currentSource() !== 'csv') {
      clearPresentation({ resetFilters: true });
      return;
    }
    const rootSection = state.panel?.querySelector('[data-csv-root-intelligence]');
    const lifecycleSection = state.panel?.querySelector('[data-csv-lifecycle-workspace]');
    if (!rootSection || !lifecycleSection) {
      clearPresentation();
      return;
    }
    await ensureContext();
    const productization = state.payload?.productization;
    if (!productization) {
      clearPresentation();
      return;
    }

    // Rendering mutates the observed operator surface. Disconnect while applying the
    // presentation overlay so our own DOM writes cannot recursively schedule sync().
    state.observer?.disconnect();
    try {
      renderRootProductization(rootSection, productization);
      renderLifecycleProductization(lifecycleSection, productization);
    } finally {
      observePanel();
    }
  }

  function invalidateContext() {
    state.scopeKey = '';
    state.payload = null;
    state.controller?.abort();
    state.controller = null;
  }

  function resetScope() {
    invalidateContext();
    clearPresentation({ resetFilters: true });
    scheduleSync();
  }

  function clearPresentation({ resetFilters = false } = {}) {
    invalidateContext();
    state.observer?.disconnect();
    try {
      state.panel?.querySelectorAll('[data-crlu-root-productization],[data-crlu-lifecycle-controls],[data-crlu-lifecycle-empty],[data-crlu-root-context],[data-crlu-lifecycle-linkage]')
        .forEach((node) => node.remove());
      restoreLifecycleRows(state.panel);
      if (resetFilters) {
        state.lifecycleFilter = '';
        state.rootFilter = '';
        state.lifecycleSort = 'attention';
      }
    } finally {
      observePanel();
    }
  }

  function restoreLifecycleRows(root) {
    root?.querySelectorAll('[data-crlu-prior-hidden]').forEach((row) => {
      row.hidden = row.dataset.crluPriorHidden === 'true';
      delete row.dataset.crluPriorHidden;
    });
  }

  function resetLifecyclePresentation(section) {
    restoreLifecycleRows(section);
    section?.querySelectorAll('[data-crlu-lifecycle-linkage]').forEach((node) => node.remove());
  }

  async function ensureContext() {
    const scope = currentScope();
    if (!scope.storeId || !scope.startDate || !scope.endDate) return;
    const key = [
      scope.storeId,
      scope.startDate,
      scope.endDate,
      scope.profileId,
      scope.limit,
      scope.sort,
      scope.q,
      scope.campaignName,
      scope.adGroupName,
    ].join('|');
    if (state.scopeKey === key && state.payload) return;

    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    state.scopeKey = key;
    state.payload = null;

    const params = new URLSearchParams({
      source: 'csv',
      startDate: scope.startDate,
      endDate: scope.endDate,
      limit: scope.limit,
      sort: scope.sort,
    });
    for (const name of ['profileId', 'q', 'campaignName', 'adGroupName']) {
      if (scope[name]) params.set(name, scope[name]);
    }

    try {
      const response = await fetch(`/api/v1/stores/${encodeURIComponent(scope.storeId)}/search-term-intelligence?${params}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      if (!controller.signal.aborted) state.payload = payload;
    } catch {
      if (!controller.signal.aborted) state.payload = null;
    } finally {
      if (state.controller === controller) state.controller = null;
    }
  }

  function renderRootProductization(section, productization) {
    const business = productization.businessIntelligence || {};
    const historical = productization.historicalIntelligence || {};
    const scope = productization.analysisScope || business.analysisScope || historical.analysisScope || {};
    const roots = Array.isArray(business.rootIntelligence?.roots) ? business.rootIntelligence.roots : [];
    const lifecycleItems = Array.isArray(historical.lifecycle?.items) ? historical.lifecycle.items : [];
    const candidates = Array.isArray(business.candidates) ? business.candidates : [];
    const lifecycleMap = new Map(lifecycleItems.map((item) => [normalize(item?.searchTerm), item]));
    const comparable = scope.financiallyComparable === true;
    const totalSpend = sum(roots, (root) => root?.metrics?.spendMicros);
    const totalSales = sum(roots, (root) => root?.metrics?.salesMicros);
    const topSpend = [...roots].sort((a, b) => numeric(b?.metrics?.spendMicros) - numeric(a?.metrics?.spendMicros)).slice(0, 3);
    const topSales = [...roots].sort((a, b) => numeric(b?.metrics?.salesMicros) - numeric(a?.metrics?.salesMicros)).slice(0, 3);
    const winnerRoots = roots.filter((root) => numeric(root?.profitTermCount) > 0);
    const wasteRoots = roots.filter((root) => numeric(root?.wasteTermCount) > 0);
    const protectedRoots = roots.filter((root) => root?.profitProtectionApplied === true);

    let block = section.querySelector('[data-crlu-root-productization]');
    if (!block) {
      block = document.createElement('div');
      block.dataset.crluRootProductization = '';
      const callout = section.querySelector('.cfdi-callout');
      if (callout) callout.insertAdjacentElement('afterend', block);
      else section.prepend(block);
    }

    const cards = comparable
      ? `${metric('Top-3 spend concentration', ratio(sum(topSpend, (root) => root?.metrics?.spendMicros), totalSpend))}
         ${metric('Top-3 sales concentration', ratio(sum(topSales, (root) => root?.metrics?.salesMicros), totalSales))}
         ${metric('Winner-linked sales share', ratio(sum(winnerRoots, (root) => root?.metrics?.salesMicros), totalSales))}
         ${metric('Waste-exposed spend share', ratio(sum(wasteRoots, (root) => root?.metrics?.spendMicros), totalSpend))}
         ${metric('Profit-protected roots', `${protectedRoots.length}/${roots.length}`)}`
      : `${metric('Financial concentration', '<span class="crlu-muted">Suppressed by financial comparability gate</span>', true)}
         ${metric('Profit-protected roots', `${protectedRoots.length}/${roots.length}`)}`;

    const prioritized = [...roots]
      .sort((a, b) => numeric(b?.priorityScore) - numeric(a?.priorityScore)
        || numeric(b?.metrics?.spendMicros) - numeric(a?.metrics?.spendMicros)
        || String(a?.root || '').localeCompare(String(b?.root || '')))
      .slice(0, 8);
    const rows = prioritized.map((root) => {
      const mix = lifecycleMix(root, lifecycleMap);
      const linkage = candidateLinkage(root, candidates, scope);
      const spendShare = comparable ? ratio(numeric(root?.metrics?.spendMicros), totalSpend) : '—';
      const salesShare = comparable ? ratio(numeric(root?.metrics?.salesMicros), totalSales) : '—';
      return `<tr>
        <td><strong>${escapeHtml(root?.root || '')}</strong><small>${escapeHtml(root?.primaryState || root?.classification || '—')}</small></td>
        <td>${number(root?.priorityScore)}</td>
        <td>${escapeHtml(spendShare)}</td>
        <td>${escapeHtml(salesShare)}</td>
        <td>${escapeHtml(mix)}</td>
        <td>${escapeHtml(linkage)}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="6">No root prioritization in this analysis scope.</td></tr>';

    block.innerHTML = `<div class="crlu-summary">${cards}</div>
      <div class="crlu-note"><strong>Current-window concentration only.</strong> Shares are calculated within backend root aggregates; root membership may overlap. No historical root trend is inferred.</div>
      <div class="crlu-subhead"><strong>Root Priority Focus</strong><span>Backend priority score first; presentation only</span></div>
      <div class="cfdi-table-wrap"><table class="cfdi-table crlu-table"><thead><tr><th>Root</th><th>Priority</th><th>Spend share</th><th>Sales share</th><th>Lifecycle mix</th><th>Recommendation linkage</th></tr></thead><tbody>${rows}</tbody></table></div>`;

    section.querySelectorAll('[data-crlu-root-context]').forEach((node) => node.remove());
    annotateRootRows(section, roots, lifecycleMap, totalSpend, totalSales, comparable);
  }

  function renderLifecycleProductization(section, productization) {
    const business = productization.businessIntelligence || {};
    const historical = productization.historicalIntelligence || {};
    const scope = productization.analysisScope || business.analysisScope || historical.analysisScope || {};
    const roots = Array.isArray(business.rootIntelligence?.roots) ? business.rootIntelligence.roots : [];
    const lifecycleItems = Array.isArray(historical.lifecycle?.items) ? historical.lifecycle.items : [];
    const candidates = Array.isArray(business.candidates) ? business.candidates : [];
    const rootMap = buildRootMap(roots);

    resetLifecyclePresentation(section);

    let controls = section.querySelector('[data-crlu-lifecycle-controls]');
    if (!controls) {
      controls = document.createElement('div');
      controls.className = 'crlu-controls';
      controls.dataset.crluLifecycleControls = '';
      controls.setAttribute('role', 'group');
      controls.setAttribute('aria-label', 'Lifecycle presentation controls');
      const summary = section.querySelector('[data-csv-lifecycle-summary]');
      if (summary) summary.insertAdjacentElement('afterend', controls);
      else section.prepend(controls);
    }

    const focusedControlKey = focusedLifecycleControlKey(controls);
    const rootOptions = [...new Set(roots.map((root) => String(root?.root || '').trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    controls.innerHTML = `<label>Lifecycle state<select data-crlu-control="state"><option value="">All states</option>${LIFECYCLE_STATES.map((value) => `<option value="${value}"${state.lifecycleFilter === value ? ' selected' : ''}>${escapeHtml(lifecycleLabel(value))}</option>`).join('')}</select></label>
      <label>Linked root<select data-crlu-control="root"><option value="">All roots</option>${rootOptions.map((value) => `<option value="${escapeHtml(value)}"${state.rootFilter === value ? ' selected' : ''}>${escapeHtml(value)}</option>`).join('')}</select></label>
      <label>Sort<select data-crlu-control="sort">
        <option value="attention"${state.lifecycleSort === 'attention' ? ' selected' : ''}>Attention priority</option>
        <option value="spend"${state.lifecycleSort === 'spend' ? ' selected' : ''}>Spend movement</option>
        <option value="sales"${state.lifecycleSort === 'sales' ? ' selected' : ''}>Sales movement</option>
        <option value="orders"${state.lifecycleSort === 'orders' ? ' selected' : ''}>Order movement</option>
        <option value="term"${state.lifecycleSort === 'term' ? ' selected' : ''}>Search term</option>
      </select></label>
      <div class="crlu-authority"><strong>Presentation only</strong><span>${scope.candidateEmissionAuthorized === true ? 'Governed candidate linkage visible' : 'Candidate emission blocked by scope'}</span></div>`;
    restoreLifecycleControlFocus(controls, focusedControlKey);

    const byTerm = new Map(lifecycleItems.map((item) => [normalize(item?.searchTerm), item]));
    const tbody = section.querySelector('tbody');
    const rows = tbody ? [...tbody.querySelectorAll('tr')].filter((row) => !row.querySelector('td[colspan]')) : [];
    const visible = [];

    for (const row of rows) {
      const term = String(row.querySelector('td:first-child strong')?.textContent || '').trim();
      const item = byTerm.get(normalize(term));
      if (!item) continue;
      const linkedRoots = rootMap.get(normalize(term)) || [];
      const stateMatch = !state.lifecycleFilter || item?.state === state.lifecycleFilter;
      const rootMatch = !state.rootFilter || linkedRoots.some((root) => String(root?.root || '') === state.rootFilter);
      if (!row.hasAttribute('data-crlu-prior-hidden')) row.dataset.crluPriorHidden = row.hidden ? 'true' : 'false';
      row.hidden = !(stateMatch && rootMatch);
      if (!row.hidden) visible.push({ row, item });
      annotateLifecycleRow(row, item, linkedRoots, candidates, scope);
    }

    visible.sort((a, b) => lifecycleComparator(a.item, b.item));
    for (const entry of visible) tbody?.appendChild(entry.row);

    let empty = section.querySelector('[data-crlu-lifecycle-empty]');
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'crlu-note';
      empty.dataset.crluLifecycleEmpty = '';
      empty.hidden = true;
      empty.setAttribute('role', 'status');
      empty.setAttribute('aria-live', 'polite');
      controls.insertAdjacentElement('afterend', empty);
    }
    empty.hidden = visible.length > 0 || rows.length === 0;
    if (!empty.hidden) {
      empty.innerHTML = '<strong>No lifecycle rows match current presentation filters.</strong> Clear state or root filters; no governed data was changed.';
    }
  }

  function handleControlChange(event) {
    const control = event.target.closest?.('[data-crlu-control]');
    if (control) {
      const key = control.dataset.crluControl;
      if (key === 'state') state.lifecycleFilter = LIFECYCLE_STATES.includes(control.value) ? control.value : '';
      if (key === 'root') state.rootFilter = String(control.value || '');
      if (key === 'sort') state.lifecycleSort = ['attention', 'spend', 'sales', 'orders', 'term'].includes(control.value)
        ? control.value
        : 'attention';
      scheduleSync();
      return;
    }

    const name = String(event.target?.name || '');
    if (!HOST_SCOPE_CONTROL_NAMES.has(name)) return;
    invalidateContext();
    if (name === 'dataSource' && currentSource() !== 'csv') clearPresentation({ resetFilters: true });
    scheduleSync();
  }

  function handleHostScopeInput(event) {
    const name = String(event.target?.name || '');
    if (!HOST_SCOPE_TEXT_CONTROL_NAMES.has(name)) return;
    invalidateContext();
    scheduleSync();
  }

  function focusedLifecycleControlKey(controls) {
    const active = document.activeElement;
    if (!active || !controls?.contains(active)) return '';
    const key = String(active.closest?.('[data-crlu-control]')?.dataset?.crluControl || '');
    return ['state', 'root', 'sort'].includes(key) ? key : '';
  }

  function restoreLifecycleControlFocus(controls, key) {
    if (!key) return;
    const next = controls?.querySelector(`[data-crlu-control="${key}"]`);
    if (typeof next?.focus === 'function') next.focus({ preventScroll: true });
  }

  function lifecycleComparator(a, b) {
    if (state.lifecycleSort === 'term') return String(a?.searchTerm || '').localeCompare(String(b?.searchTerm || ''));
    if (state.lifecycleSort === 'spend') return absNumeric(b?.change?.spendPct) - absNumeric(a?.change?.spendPct) || lifecyclePriority(a?.state) - lifecyclePriority(b?.state);
    if (state.lifecycleSort === 'sales') return absNumeric(b?.change?.salesPct) - absNumeric(a?.change?.salesPct) || lifecyclePriority(a?.state) - lifecyclePriority(b?.state);
    if (state.lifecycleSort === 'orders') return absNumeric(b?.change?.ordersPct) - absNumeric(a?.change?.ordersPct) || lifecyclePriority(a?.state) - lifecyclePriority(b?.state);
    return lifecyclePriority(a?.state) - lifecyclePriority(b?.state)
      || String(a?.searchTerm || '').localeCompare(String(b?.searchTerm || ''));
  }

  function lifecyclePriority(value) {
    return ({ emergingWaste: 1, persistentWaste: 2, declining: 3, emergingWinner: 4, recovered: 5, stableWinner: 6, new: 7, watchlist: 8 })[value] || 9;
  }

  function lifecycleMix(root, lifecycleMap) {
    const counts = new Map();
    for (const term of Array.isArray(root?.searchTerms) ? root.searchTerms : []) {
      const lifecycle = lifecycleMap.get(normalize(term));
      if (!lifecycle?.state) continue;
      counts.set(lifecycle.state, (counts.get(lifecycle.state) || 0) + 1);
    }
    const parts = [...counts.entries()]
      .sort((a, b) => lifecyclePriority(a[0]) - lifecyclePriority(b[0]) || b[1] - a[1]);
    return parts.length
      ? parts.map(([key, value]) => `${lifecycleLabel(key)} ${value}`).join(' · ')
      : 'No linked lifecycle evidence';
  }

  function candidateLinkage(root, candidates, scope) {
    if (scope?.candidateEmissionAuthorized !== true) return 'Blocked by scope';
    const members = new Set((root?.searchTerms || []).map(normalize));
    const rootName = normalize(root?.root);
    const linked = candidates.filter((candidate) => {
      if (candidate?.matchScope === 'phrase_review') return normalize(candidate?.value) === rootName;
      return members.has(normalize(candidate?.value));
    });
    return linked.length ? `${linked.length} governed candidate${linked.length === 1 ? '' : 's'}` : 'No emitted candidate';
  }

  function annotateRootRows(section, roots, lifecycleMap, totalSpend, totalSales, comparable) {
    const rootByName = new Map(roots.map((root) => [normalize(root?.root), root]));
    for (const row of section.querySelectorAll('tbody tr')) {
      if (row.closest('[data-crlu-root-productization]')) continue;
      const cell = row.querySelector('td:first-child');
      const name = String(cell?.querySelector('strong')?.textContent || '').trim();
      const root = rootByName.get(normalize(name));
      if (!cell || !root) continue;
      let note = cell.querySelector('[data-crlu-root-context]');
      if (!note) {
        note = document.createElement('small');
        note.dataset.crluRootContext = '';
        cell.appendChild(note);
      }
      const spendShare = comparable ? ratio(numeric(root?.metrics?.spendMicros), totalSpend) : 'financial shares suppressed';
      const salesShare = comparable ? ratio(numeric(root?.metrics?.salesMicros), totalSales) : 'financial shares suppressed';
      note.textContent = `root aggregate share: spend ${spendShare} · sales ${salesShare} · ${lifecycleMix(root, lifecycleMap)}`;
    }
  }

  function annotateLifecycleRow(row, item, linkedRoots, candidates, scope) {
    const candidateCell = row.children?.[5];
    if (!candidateCell) return;
    let note = candidateCell.querySelector('[data-crlu-lifecycle-linkage]');
    if (!note) {
      note = document.createElement('small');
      note.dataset.crluLifecycleLinkage = '';
      candidateCell.appendChild(note);
    }
    const roots = linkedRoots.length ? linkedRoots.map((root) => root.root).join(', ') : 'none';
    if (scope?.candidateEmissionAuthorized !== true) {
      note.textContent = `linked roots: ${roots} · candidate linkage blocked by scope`;
      return;
    }
    const term = normalize(item?.searchTerm);
    const linked = candidates.filter((candidate) => normalize(candidate?.value) === term
      || (candidate?.matchScope === 'phrase_review'
        && linkedRoots.some((root) => normalize(root?.root) === normalize(candidate?.value))));
    note.textContent = `linked roots: ${roots} · ${linked.length} governed candidate${linked.length === 1 ? '' : 's'}`;
  }

  function buildRootMap(roots) {
    const map = new Map();
    for (const root of roots) {
      for (const term of Array.isArray(root?.searchTerms) ? root.searchTerms : []) {
        const key = normalize(term);
        const current = map.get(key) || [];
        current.push(root);
        map.set(key, current);
      }
    }
    return map;
  }

  function currentScope() {
    return {
      storeId: String(global.CloudflareOperatorContext?.getContext?.().storeId || global.CloudflareOperatorWorkspace?.currentStoreId?.() || '').trim(),
      startDate: value('startDate'),
      endDate: value('endDate'),
      profileId: value('profileId'),
      limit: value('limit') || '50',
      sort: value('sort') || 'cost',
      q: value('q'),
      campaignName: value('campaignName'),
      adGroupName: value('adGroupName'),
    };
  }

  function currentSource() {
    return state.panel?.querySelector('[name="dataSource"]')?.value || 'csv';
  }

  function value(name) {
    return String(state.panel?.querySelector(`[name="${name}"]`)?.value || '').trim();
  }

  function sum(items, getter) {
    return items.reduce((total, item) => total + numeric(getter(item)), 0);
  }

  function numeric(value) {
    const result = Number(value);
    return Number.isFinite(result) ? result : 0;
  }

  function absNumeric(value) {
    const result = Number(value);
    return Number.isFinite(result) ? Math.abs(result) : -1;
  }

  function ratio(value, total) {
    return total > 0 ? `${((numeric(value) / total) * 100).toFixed(1)}%` : '—';
  }

  function number(value) {
    return new Intl.NumberFormat().format(numeric(value));
  }

  function lifecycleLabel(value) {
    return ({
      new: 'New',
      emergingWinner: 'Emerging Winner',
      stableWinner: 'Stable Winner',
      declining: 'Declining',
      emergingWaste: 'Emerging Waste',
      persistentWaste: 'Persistent Waste',
      recovered: 'Recovered',
      watchlist: 'Watchlist',
    })[value] || String(value || '—');
  }

  function normalize(value) {
    return String(value || '').trim().toLowerCase();
  }

  function metric(label, value, raw = false) {
    return `<div class="crlu-metric"><span>${escapeHtml(label)}</span><strong>${raw ? value : escapeHtml(value)}</strong></div>`;
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
    if (document.getElementById('csvRootLifecycleUsabilityStylesV1')) return;
    const style = document.createElement('style');
    style.id = 'csvRootLifecycleUsabilityStylesV1';
    style.textContent = `
      .crlu-summary{display:grid;grid-template-columns:repeat(5,minmax(120px,1fr));gap:8px;margin:9px 0}
      .crlu-metric{border:1px solid var(--line);border-radius:10px;background:var(--card);padding:8px 10px;min-width:0}
      .crlu-metric span{display:block;color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.04em}
      .crlu-metric strong{display:block;margin-top:3px;font-size:13px;overflow-wrap:anywhere}
      .crlu-note{margin:8px 0;padding:8px 10px;border-left:3px solid var(--accent);border-radius:8px;background:var(--hover-bg);font-size:10px;line-height:1.5;color:var(--muted)}
      .crlu-note strong{color:var(--text)}
      .crlu-subhead{display:flex;justify-content:space-between;gap:10px;align-items:center;margin:10px 0 6px;font-size:10px}.crlu-subhead span{color:var(--muted)}
      .crlu-table{min-width:780px}.crlu-table td small{display:block;color:var(--muted);margin-top:2px}
      .crlu-controls{display:grid;grid-template-columns:repeat(3,minmax(150px,1fr)) minmax(180px,1fr);gap:8px;margin:8px 0 10px}
      .crlu-controls label{display:flex;flex-direction:column;gap:4px;color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.04em}
      .crlu-controls select{height:32px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text);padding:0 8px;font:inherit;text-transform:none;letter-spacing:normal}
      .crlu-authority{border:1px solid var(--line);border-radius:9px;background:var(--card);padding:7px 9px}.crlu-authority strong,.crlu-authority span{display:block}.crlu-authority span{margin-top:2px;color:var(--muted);font-size:9px}
      .crlu-muted{font-size:10px;color:var(--muted);font-weight:500}
      [data-crlu-root-context],[data-crlu-lifecycle-linkage]{display:block!important;margin-top:3px;color:var(--muted)!important;font-size:9px!important;line-height:1.35}
      @media(max-width:980px){.crlu-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.crlu-controls{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @media(max-width:640px){.crlu-summary,.crlu-controls{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }
})(globalThis);