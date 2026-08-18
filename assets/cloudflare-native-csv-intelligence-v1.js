(function initCsvIntelligenceExtension(global) {
  'use strict';

  const VERSION = '1.0.1';
  const STORAGE_SOURCE = 'aoi.decision.source';
  const state = { mounted: false, payload: null, amazonProfileId: '' };

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
      state.payload = null;
      applySourceMode();
    });

    panel.addEventListener('click', captureClick, true);
    global.addEventListener?.('cloudflare-operator-store-change', () => {
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
      void runCsvIntelligence();
      return;
    }
    const evidence = event.target.closest?.('[data-csv-evidence-index]');
    if (evidence) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const item = state.payload?.items?.[Number(evidence.dataset.csvEvidenceIndex)];
      if (item) renderCsvEvidence(item, state.payload);
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
        ? 'Imported CSV advisory mode. Profile ID is optional and defaults to unscoped imported facts. Recommendations are non-authoritative and cannot be persisted until Amazon entity identity is resolved.'
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
    setStatus('Computing advisory intelligence over imported CSV facts…', 'loading');
    closeDrawer();

    try {
      const payload = await requestJson(`/api/v1/stores/${encodeURIComponent(storeId)}/search-term-intelligence?${params}`);
      state.payload = payload;
      renderCsvResults(payload);
      const valid = Number(payload?.summary?.csvProvenanceValidItemCount || 0);
      const candidates = Number(payload?.summary?.recommendationCandidateCount || 0);
      setStatus(`Imported CSV · ${valid}/${payload?.summary?.itemCount || 0} rows with valid CSV provenance · ${candidates} advisory candidates. Persistence and Amazon execution are disabled.`, 'warn');
    } catch (error) {
      state.payload = null;
      clearCsvResults();
      setStatus(error.message || 'Imported CSV intelligence request failed.', 'error');
    }
  }

  function renderCsvResults(payload) {
    const target = document.querySelector('#cfDecisionPanel [data-results]');
    if (!target) return;
    const summary = payload.summary || {};
    const freshness = summary.freshness || {};
    const cards = `<div class="cfdi-summary">
      ${summaryCard('Rows', summary.itemCount || 0)}
      ${summaryCard('Advisory candidates', summary.recommendationCandidateCount || 0)}
      ${summaryCard('CSV provenance valid', summary.csvProvenanceValidItemCount || 0)}
      ${summaryCard('Fresh', freshness.fresh || 0)}
      ${summaryCard('Stale', freshness.stale || 0)}
    </div>`;
    const rows = (payload.items || []).map((item, index) => csvRow(item, payload, index)).join('');
    target.innerHTML = `${cards}<div class="cfdi-callout"><strong>Imported real data.</strong> CSV content/import provenance is validated, but Amazon campaign/ad-group/keyword IDs are unresolved. Recommendations are advisory only.</div><div class="cfdi-table-wrap"><table class="cfdi-table"><thead><tr><th>Search term</th><th>Spend</th><th>Sales</th><th>Orders</th><th>ACoS</th><th>Trend</th><th>Decision</th><th>Confidence</th><th>Evidence</th></tr></thead><tbody>${rows || '<tr><td colspan="9">No imported CSV facts in this window.</td></tr>'}</tbody></table></div>`;
  }

  function csvRow(item, payload, index) {
    const m = item.metrics || {};
    const rec = item.recommendation;
    const suppressed = item.suppression;
    const decision = rec ? `${esc(rec.family)} · ${esc(rec.actionType)}` : suppressed ? `Suppressed · ${esc(suppressed.code)}` : 'Observe';
    const trend = item.trend?.delta || {};
    const evidence = item.evidence || {};
    return `<tr>
      <td><strong>${esc(item.entity?.searchTerm || '')}</strong><small>${esc(item.entity?.campaignName || '')} · ${esc(item.entity?.adGroupName || '')}</small></td>
      <td>${money(m.spendMicros, payload.profile?.currencyCode)}</td>
      <td>${money(m.salesMicros, payload.profile?.currencyCode)}</td>
      <td>${number(m.orders)}</td>
      <td>${percent(m.acos)}</td>
      <td><span>Spend ${signedPercent(trend.spendPct)}</span><small>Orders ${signedPercent(trend.ordersPct)}</small></td>
      <td><span class="cfdi-pill ${rec ? 'candidate' : ''}">${decision}</span><small>${rec ? 'identity resolution required' : 'advisory only'}</small></td>
      <td><span class="cfdi-confidence">${esc(item.confidence?.band || 'low')} · ${percent(item.confidence?.score)}</span><small>${esc(item.freshness?.state || 'unknown')} · ${evidence.csvProvenanceValid ? 'CSV provenance valid' : 'CSV provenance invalid'}</small></td>
      <td><button type="button" class="cfdi-link" data-csv-evidence-index="${index}">Evidence</button></td>
    </tr>`;
  }

  function renderCsvEvidence(item, payload) {
    const drawer = document.querySelector('#cfDecisionPanel [data-drawer]');
    if (!drawer) return;
    const evidence = item.evidence || {};
    const rec = item.recommendation;
    const delta = item.trend?.delta || {};
    drawer.hidden = false;
    drawer.innerHTML = `<header class="cfdi-drawer-header"><div><span>Imported CSV Evidence</span><strong>${esc(item.entity?.searchTerm || '')}</strong><small>Non-authoritative · Amazon identity unresolved</small></div><button type="button" data-drawer-close aria-label="Close drawer">×</button></header>
      <div class="cfdi-drawer-body">
        <div class="cfdi-badges"><span class="cfdi-pill warn">Non-authoritative</span><span class="cfdi-pill">CSV provenance ${evidence.csvProvenanceValid ? 'valid' : 'invalid'}</span><span class="cfdi-pill danger">Execution Disabled</span></div>
        ${section('Decision', `<dl>${kv('Decision', rec ? `${rec.family} · ${rec.actionType}` : item.suppression?.code || 'Observe')}${kv('Confidence', `${item.confidence?.band || 'low'} · ${percent(item.confidence?.score)}`)}${kv('Fingerprint', item.fingerprint || '—')}${kv('Identity resolved', 'no')}</dl>`)}
        ${section('Performance', `<dl>${kv('Spend', money(item.metrics?.spendMicros, payload.profile?.currencyCode))}${kv('Sales', money(item.metrics?.salesMicros, payload.profile?.currencyCode))}${kv('Orders', number(item.metrics?.orders))}${kv('ACoS', percent(item.metrics?.acos))}${kv('ROAS', decimal(item.metrics?.roas))}${kv('CVR', percent(item.metrics?.cvr))}</dl>`)}
        ${section('Imported provenance', `<dl>${kv('Source kind', 'csv_import')}${kv('Import IDs', join(evidence.sourceImportIds))}${kv('Content SHA-256', join(evidence.contentSha256s))}${kv('Fact rows', evidence.factRowCount)}${kv('Latest report', evidence.latestReportDate || item.freshness?.latestReportDate || '—')}${kv('Campaign name', item.entity?.campaignName || '—')}${kv('Ad group name', item.entity?.adGroupName || '—')}${kv('Targeting', item.entity?.targeting || '—')}</dl>`)}
        ${section('Comparable trend', `<dl>${kv('Spend Δ', signedPercent(delta.spendPct))}${kv('Sales Δ', signedPercent(delta.salesPct))}${kv('Orders Δ', signedPercent(delta.ordersPct))}${kv('ACoS Δ', signedPp(delta.acosPp))}</dl>`)}
        <div class="cfdi-callout"><strong>Governance persistence disabled.</strong> Resolve canonical Amazon profile/campaign/ad-group/keyword or target identity before creating an Optimization Action. No Amazon mutation is authorized.</div>
      </div>`;
  }

  function clearCsvResults() {
    const target = document.querySelector('#cfDecisionPanel [data-results]');
    if (target && currentSource() === 'csv') target.innerHTML = '';
    closeDrawer();
  }
  function closeDrawer() {
    const drawer = document.querySelector('#cfDecisionPanel [data-drawer]');
    if (drawer) { drawer.hidden = true; drawer.innerHTML = ''; }
  }
  function setStatus(text, kind) {
    const status = document.querySelector('#cfDecisionPanel [data-status]');
    if (status) { status.textContent = text; status.dataset.kind = kind || ''; }
  }
  function currentSource() { return document.querySelector('#cfDecisionPanel [name="dataSource"]')?.value || 'csv'; }
  function currentStoreId() { return String(global.CloudflareOperatorContext?.getContext?.().storeId || global.CloudflareOperatorWorkspace?.currentStoreId?.() || '').trim(); }
  function value(panel, name) { return String(panel?.querySelector(`[name="${name}"]`)?.value || '').trim(); }

  async function requestJson(url) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
  }

  function summaryCard(label, value) { return `<div><span>${esc(label)}</span><strong>${number(value)}</strong></div>`; }
  function section(title, content) { return `<section class="cfdi-detail-section"><h3>${esc(title)}</h3>${content}</section>`; }
  function kv(key, value) { return `<div><dt>${esc(key)}</dt><dd>${esc(value ?? '—')}</dd></div>`; }
  function join(value) { return Array.isArray(value) && value.length ? value.join(', ') : '—'; }
  function number(value) { return new Intl.NumberFormat().format(Number(value || 0)); }
  function decimal(value) { return value == null ? '—' : Number(value).toFixed(2); }
  function money(micros, currency) {
    const numeric = Number(micros);
    if (!Number.isFinite(numeric)) return '—';
    const amount = numeric / 1_000_000;
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2 }).format(amount); }
    catch { return amount.toFixed(2); }
  }
  function percent(value) { return value == null ? '—' : `${(Number(value) * 100).toFixed(1)}%`; }
  function signedPercent(value) { return value == null ? '—' : `${Number(value) >= 0 ? '+' : ''}${(Number(value) * 100).toFixed(1)}%`; }
  function signedPp(value) { return value == null ? '—' : `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(1)}pp`; }
  function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char])); }
})(window);
