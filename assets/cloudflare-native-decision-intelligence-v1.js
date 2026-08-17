(function initDecisionIntelligence(global) {
  'use strict';

  const VERSION = '1.0.0';
  const STORAGE_PROFILE = 'aoi.decision.profileId';
  const STORAGE_RANGE = 'aoi.decision.rangeDays';
  const state = { mounted: false, open: false, tab: 'intelligence', loading: false, payload: null, actions: null, error: '' };

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
    panel.querySelector('[name="profileId"]').value = localStorage.getItem(STORAGE_PROFILE) || '';
    panel.querySelector('[name="rangeDays"]').value = localStorage.getItem(STORAGE_RANGE) || '30';
    setDates();

    global.addEventListener?.('cloudflare-operator-store-change', () => {
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
          <p>Deterministic scoring, evidence, confidence and recommendation fingerprints. Amazon execution is disabled.</p>
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
          <div><strong>Read-only Action Inbox</strong><span>Apply / revert are server-side fail-closed until Phase 11.</span></div>
          <button type="button" data-refresh-actions>Refresh</button>
        </div>
        <div class="cfdi-status" data-actions-status></div>
        <div data-actions-results></div>
      </div>`;
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

    localStorage.setItem(STORAGE_PROFILE, profileId);
    setStatus('Computing deterministic preview…', 'loading');
    state.loading = true;
    try {
      const params = new URLSearchParams({
        profileId,
        startDate,
        endDate,
        limit: value(panel, 'limit') || '50',
        sort: value(panel, 'sort') || 'cost',
      });
      const payload = await requestJson(`/api/v1/stores/${encodeURIComponent(storeId)}/search-term-intelligence?${params}`);
      state.payload = payload;
      renderIntelligence(payload);
      const label = payload?.authority?.authoritative ? 'Authoritative' : 'Development preview / non-authoritative';
      setStatus(`${label}. ${payload?.summary?.recommendationCandidateCount || 0} preview candidates from ${payload?.summary?.itemCount || 0} rows.`, payload?.authority?.authoritative ? 'ok' : 'warn');
    } catch (error) {
      state.payload = null;
      panel.querySelector('[data-results]').innerHTML = '';
      setStatus(error.message || 'Decision Intelligence request failed.', 'error');
    } finally {
      state.loading = false;
    }
  }

  async function loadActions() {
    const storeId = currentStoreId();
    const target = panelNode().querySelector('[data-actions-results]');
    const status = panelNode().querySelector('[data-actions-status]');
    if (!storeId) {
      status.textContent = 'Select a store in Operator Workspace first.';
      target.innerHTML = '';
      return;
    }
    status.textContent = 'Loading Action Inbox…';
    try {
      const payload = await requestJson(`/api/v1/stores/${encodeURIComponent(storeId)}/optimization-actions?limit=50`);
      state.actions = payload;
      status.textContent = `${payload.items?.length || 0} actions. Amazon execution remains disabled.`;
      target.innerHTML = actionTable(payload.items || []);
    } catch (error) {
      state.actions = null;
      status.textContent = error.message || 'Action Inbox unavailable.';
      target.innerHTML = '';
    }
  }

  function renderIntelligence(payload) {
    const target = panelNode().querySelector('[data-results]');
    const summary = payload.summary || {};
    const cards = `
      <div class="cfdi-summary">
        ${summaryCard('Rows', summary.itemCount || 0)}
        ${summaryCard('Candidates', summary.recommendationCandidateCount || 0)}
        ${summaryCard('Lineage valid', summary.lineageValidItemCount || 0)}
        ${summaryCard('Authoritative', summary.authoritativeRecommendationCount || 0)}
      </div>`;
    const items = (payload.items || []).map((item) => intelligenceRow(item, payload)).join('');
    target.innerHTML = `${cards}<div class="cfdi-table-wrap"><table class="cfdi-table"><thead><tr><th>Search term</th><th>Spend</th><th>Sales</th><th>Orders</th><th>ACoS</th><th>CVR</th><th>Decision</th><th>Confidence</th></tr></thead><tbody>${items || '<tr><td colspan="8">No rows in this scoped window.</td></tr>'}</tbody></table></div>`;
  }

  function intelligenceRow(item, payload) {
    const m = item.metrics || {};
    const rec = item.recommendation;
    const suppressed = item.suppression;
    const decision = rec ? `${escapeHtml(rec.family)} · ${escapeHtml(rec.actionType)}` : (suppressed ? `Suppressed · ${escapeHtml(suppressed.code)}` : 'Observe');
    const fingerprint = item.fingerprint ? `<small title="${escapeHtml(item.fingerprint)}">${escapeHtml(item.fingerprint.slice(0, 12))}…</small>` : '';
    return `<tr>
      <td><strong>${escapeHtml(item.entity?.searchTerm || '')}</strong><small>${escapeHtml(item.entity?.campaignName || item.entity?.campaignId || '')}</small></td>
      <td>${money(m.spendMicros, payload.profile?.currencyCode)}</td>
      <td>${money(m.salesMicros, payload.profile?.currencyCode)}</td>
      <td>${number(m.orders)}</td>
      <td>${percent(m.acos)}</td>
      <td>${percent(m.cvr)}</td>
      <td><span class="cfdi-pill ${rec ? 'candidate' : ''}">${decision}</span>${fingerprint}</td>
      <td><span class="cfdi-confidence">${escapeHtml(item.confidence?.band || 'low')} · ${percent(item.confidence?.score)}</span><small>${item.evidence?.lineageValid ? 'provenance valid' : 'non-authoritative lineage'}</small></td>
    </tr>`;
  }

  function actionTable(items) {
    const rows = items.map((item) => `<tr>
      <td><strong>${escapeHtml(item.actionType || '')}</strong><small>${escapeHtml(item.actionId || '')}</small></td>
      <td>${escapeHtml(item.profileId || '')}</td>
      <td>${escapeHtml(item.entityType || '')}<small>${escapeHtml(item.entityId || '')}</small></td>
      <td><span class="cfdi-pill">${escapeHtml(item.status || '')}</span></td>
      <td>${escapeHtml(item.ruleKey || '')}</td>
      <td>${escapeHtml(item.createdAt || '')}</td>
    </tr>`).join('');
    return `<div class="cfdi-table-wrap"><table class="cfdi-table"><thead><tr><th>Action</th><th>Profile</th><th>Entity</th><th>Status</th><th>Rule</th><th>Created</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No actions.</td></tr>'}</tbody></table></div>`;
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
    target.innerHTML = `<span>Store</span><strong>${escapeHtml(storeId || 'not selected')}</strong><span>Execution</span><strong>disabled</strong>`;
  }

  function setOpen(open) {
    state.open = Boolean(open);
    panelNode().classList.toggle('open', state.open);
    if (state.open) renderContext();
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

  async function requestJson(url, options) {
    const response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' }, ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function currentStoreId() {
    return String(global.CloudflareOperatorContext?.getContext?.().storeId || global.CloudflareOperatorWorkspace?.currentStoreId?.() || '').trim();
  }
  function panelNode() { return document.getElementById('cfDecisionPanel'); }
  function value(panel, name) { return String(panel.querySelector(`[name="${name}"]`)?.value || '').trim(); }
  function isoDate(date) { return date.toISOString().slice(0, 10); }
  function number(value) { return new Intl.NumberFormat().format(Number(value || 0)); }
  function money(micros, currency) {
    const value = Number(micros || 0) / 1_000_000;
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2 }).format(value); }
    catch { return value.toFixed(2); }
  }
  function percent(value) { return value === null || value === undefined ? '—' : `${(Number(value) * 100).toFixed(1)}%`; }
  function summaryCard(label, value) { return `<div><span>${escapeHtml(label)}</span><strong>${number(value)}</strong></div>`; }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }

  function installStyles() {
    if (document.getElementById('cfDecisionStyles')) return;
    const style = document.createElement('style');
    style.id = 'cfDecisionStyles';
    style.textContent = `
      #cfDecisionLauncher{position:fixed;right:22px;bottom:22px;z-index:2147482000;border:1px solid #d0d5dd;background:#101828;color:#fff;border-radius:999px;padding:11px 16px;font:600 13px/1.2 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 12px 30px rgba(16,24,40,.2);cursor:pointer}
      #cfDecisionPanel{position:fixed;right:20px;top:18px;bottom:18px;width:min(1040px,calc(100vw - 40px));z-index:2147482001;background:#fff;color:#101828;border:1px solid #e4e7ec;border-radius:18px;box-shadow:0 24px 80px rgba(16,24,40,.24);display:none;overflow:auto;font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
      #cfDecisionPanel.open{display:block} #cfDecisionPanel *{box-sizing:border-box}.cfdi-header{display:flex;justify-content:space-between;gap:24px;padding:24px 26px 18px;border-bottom:1px solid #eaecf0}.cfdi-header h2{font-size:22px;margin:3px 0 5px}.cfdi-header p{margin:0;color:#667085;max-width:720px}.cfdi-eyebrow{font-size:11px;font-weight:800;letter-spacing:.08em;color:#b54708}.cfdi-close{border:0;background:#f2f4f7;border-radius:10px;width:36px;height:36px;font-size:24px;cursor:pointer}.cfdi-context{display:flex;gap:8px;align-items:center;padding:12px 26px;background:#fffaeb;border-bottom:1px solid #fedf89}.cfdi-context span{color:#667085}.cfdi-context strong{margin-right:18px}.cfdi-tabs{padding:14px 26px 0;display:flex;gap:4px;border-bottom:1px solid #eaecf0}.cfdi-tabs button{border:0;background:transparent;padding:10px 13px;font-weight:650;color:#667085;cursor:pointer;border-bottom:2px solid transparent}.cfdi-tabs button.active{color:#101828;border-bottom-color:#101828}.cfdi-view{padding:20px 26px 28px}.cfdi-controls{display:grid;grid-template-columns:1.5fr repeat(4,minmax(110px,.7fr)) auto;gap:10px;align-items:end}.cfdi-controls label{display:grid;gap:5px;color:#475467;font-size:12px;font-weight:600}.cfdi-controls input,.cfdi-controls select{border:1px solid #d0d5dd;border-radius:9px;padding:9px 10px;background:#fff;color:#101828;min-width:0}.cfdi-primary,.cfdi-actions-bar button{border:0;border-radius:9px;background:#101828;color:#fff;padding:10px 14px;font-weight:700;cursor:pointer}.cfdi-hidden{display:none!important}.cfdi-status{margin:14px 0;padding:10px 12px;border-radius:10px;background:#f9fafb;color:#475467;border:1px solid #eaecf0}.cfdi-status[data-kind="warn"]{background:#fffaeb;border-color:#fedf89;color:#93370d}.cfdi-status[data-kind="error"]{background:#fef3f2;border-color:#fecdca;color:#b42318}.cfdi-status[data-kind="ok"]{background:#ecfdf3;border-color:#abefc6;color:#067647}.cfdi-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:12px 0}.cfdi-summary>div{border:1px solid #eaecf0;border-radius:12px;padding:13px;background:#fcfcfd}.cfdi-summary span{display:block;color:#667085;font-size:12px}.cfdi-summary strong{font-size:21px}.cfdi-table-wrap{overflow:auto;border:1px solid #eaecf0;border-radius:12px}.cfdi-table{width:100%;border-collapse:collapse;min-width:820px}.cfdi-table th,.cfdi-table td{text-align:left;padding:11px 12px;border-bottom:1px solid #f2f4f7;vertical-align:top}.cfdi-table th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#667085;background:#f9fafb;position:sticky;top:0}.cfdi-table td small{display:block;color:#98a2b3;margin-top:3px;max-width:260px;overflow:hidden;text-overflow:ellipsis}.cfdi-pill{display:inline-block;border-radius:999px;background:#f2f4f7;padding:3px 7px;font-size:11px;font-weight:700;color:#475467}.cfdi-pill.candidate{background:#fff4ed;color:#b93815}.cfdi-confidence{text-transform:capitalize;font-weight:700}.cfdi-actions-bar{display:flex;justify-content:space-between;align-items:center;gap:16px}.cfdi-actions-bar span{display:block;color:#667085;font-size:12px;margin-top:3px}@media(max-width:850px){.cfdi-controls{grid-template-columns:1fr 1fr}.cfdi-summary{grid-template-columns:1fr 1fr}#cfDecisionPanel{right:8px;top:8px;bottom:8px;width:calc(100vw - 16px)}}`;
    document.head.appendChild(style);
  }

  Object.defineProperty(global, 'CloudflareDecisionIntelligence', {
    value: Object.freeze({ version: VERSION, open: () => setOpen(true), close: () => setOpen(false), run: runIntelligence }),
    configurable: false,
    writable: false,
  });
})(globalThis);
