(function initPhase11ExecutionReadiness(global) {
  'use strict';

  const VERSION = '1.0.0';
  const PANEL_SELECTOR = '[data-phase11-execution-readiness]';
  let selectedActionId = '';
  let injectScheduled = false;

  if (!global.document) return;
  if (global.document.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();

  function mount() {
    installStyles();
    document.addEventListener('click', handleClick, true);
    const observer = new MutationObserver(scheduleInjection);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  }

  function handleClick(event) {
    const actionButton = event.target.closest('[data-action-id]');
    if (actionButton?.dataset.actionId) {
      selectedActionId = String(actionButton.dataset.actionId).trim();
      scheduleInjection();
      return;
    }

    const readinessButton = event.target.closest('[data-phase11-run-readiness]');
    if (readinessButton) {
      event.preventDefault();
      event.stopPropagation();
      void runExecutionReadinessDryRun(readinessButton);
    }
  }

  function scheduleInjection() {
    if (injectScheduled) return;
    injectScheduled = true;
    queueMicrotask(() => {
      injectScheduled = false;
      ensureExecutionReadinessSurface();
    });
  }

  function ensureExecutionReadinessSurface() {
    const drawer = document.querySelector('#cfDecisionPanel [data-drawer]');
    if (!drawer || drawer.hidden) return;
    const body = drawer.querySelector('.cfdi-drawer-body');
    if (!body || body.querySelector(PANEL_SELECTOR)) return;

    const statusPill = [...drawer.querySelectorAll('.cfdi-badges .cfdi-pill')]
      .map((node) => String(node.textContent || '').trim().toLowerCase())
      .find((value) => ['proposed', 'approved', 'rejected', 'applying', 'applied', 'failed', 'reverted'].includes(value));
    if (statusPill !== 'approved' || !selectedActionId) return;

    const section = document.createElement('section');
    section.className = 'cfp11-readiness';
    section.setAttribute('data-phase11-execution-readiness', '');
    section.dataset.actionId = selectedActionId;
    section.innerHTML = `
      <div class="cfp11-readiness-head">
        <div><strong>Execution Readiness</strong><span>Approved governance record · execution remains dormant</span></div>
        <span class="cfp11-dry-badge">Dry-run only</span>
      </div>
      <div class="cfp11-warning"><strong>No Amazon request will be sent.</strong> This check only builds and validates the deterministic execution plan.</div>
      <div class="cfp11-actions"><button type="button" data-phase11-run-readiness>Run execution readiness dry-run</button></div>
      <div class="cfp11-result" data-phase11-readiness-result>Readiness has not been evaluated for this action in this session.</div>`;
    body.appendChild(section);
  }

  async function runExecutionReadinessDryRun(button) {
    const section = button.closest(PANEL_SELECTOR);
    const actionId = String(section?.dataset.actionId || selectedActionId || '').trim();
    const storeId = currentStoreId();
    const result = section?.querySelector('[data-phase11-readiness-result]');
    if (!section || !result || !actionId) return;
    if (!storeId) {
      result.innerHTML = errorState('Select a store in Operator Workspace first.');
      return;
    }

    button.disabled = true;
    result.innerHTML = '<div class="cfp11-loading">Building deterministic execution plan…</div>';
    try {
      const payload = await requestJson(`/api/v1/stores/${encodeURIComponent(storeId)}/optimization-actions/${encodeURIComponent(actionId)}/apply?dryRun=true`, {
        method: 'POST',
      });
      renderReadiness(result, payload);
    } catch (error) {
      result.innerHTML = errorState(error.message || 'Execution readiness dry-run failed.');
    } finally {
      button.disabled = false;
    }
  }

  function renderReadiness(target, payload) {
    const plan = payload?.plan || {};
    const mutation = plan.mutation || {};
    const destination = mutation.target || {};
    const envelope = payload?.mutationEnvelope || {};
    const blockingReason = mutation.blockingReason
      || (Array.isArray(plan.errors) && plan.errors.length ? plan.errors.join(', ') : null)
      || (Array.isArray(envelope.errors) && envelope.errors.length ? envelope.errors.join(', ') : null)
      || 'none';
    const readiness = plan.permitIssuanceReady === true;
    const dispatch = plan.networkDispatchAuthorized === true;

    target.innerHTML = `
      <div class="cfp11-state ${readiness ? 'ready' : 'blocked'}">
        <strong>${readiness ? 'Permit issuance ready' : 'Execution blocked'}</strong>
        <span>${readiness ? 'Safety prerequisites for a single-use permit are satisfied.' : escapeHtml(blockingReason)}</span>
      </div>
      <dl class="cfp11-grid">
        ${kv('Action type', plan.action?.actionType)}
        ${kv('Frozen campaignId', destination.campaignId)}
        ${kv('Frozen adGroupId', destination.adGroupId)}
        ${kv('Mutation contract', mutation.frozenContract || mutation.apiContract)}
        ${kv('HTTP method', mutation.method)}
        ${kv('Endpoint path', mutation.endpointPath)}
        ${kv('Request fingerprint', plan.requestFingerprint)}
        ${kv('Target fingerprint', plan.targetFingerprint)}
        ${kv('Execution fingerprint', plan.executionFingerprint)}
        ${kv('Request body SHA-256', envelope.requestBodySha256)}
        ${kv('permitIssuanceReady', String(Boolean(plan.permitIssuanceReady)))}
        ${kv('networkDispatchAuthorized', String(Boolean(plan.networkDispatchAuthorized)))}
        ${kv('Blocking reason', blockingReason)}
        ${kv('Retry policy', plan.retryPolicy)}
        ${kv('Read-back policy', plan.finalizationPolicy)}
      </dl>
      <div class="cfp11-warning"><strong>Dry-run only. No Amazon request will be sent.</strong> Governance approval is not execution authority${dispatch ? ' — invalid dispatch state detected.' : '.'}</div>`;
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `HTTP ${response.status}`);
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function currentStoreId() {
    return String(global.CloudflareOperatorContext?.getContext?.().storeId || global.CloudflareOperatorWorkspace?.currentStoreId?.() || '').trim();
  }

  function kv(label, value) {
    const rendered = value === null || value === undefined || value === '' ? '—' : String(value);
    return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(rendered)}</dd></div>`;
  }

  function errorState(message) {
    return `<div class="cfp11-state blocked"><strong>Readiness unavailable</strong><span>${escapeHtml(message)}</span></div>`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }

  function installStyles() {
    if (document.getElementById('cfPhase11ExecutionReadinessStyles')) return;
    const style = document.createElement('style');
    style.id = 'cfPhase11ExecutionReadinessStyles';
    style.textContent = `
      .cfp11-readiness{margin-top:18px;padding:16px;border:1px solid rgba(127,127,127,.28);border-radius:14px;background:rgba(127,127,127,.05)}
      .cfp11-readiness-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}.cfp11-readiness-head>div{display:grid;gap:3px}.cfp11-readiness-head span{font-size:12px;opacity:.72}
      .cfp11-dry-badge{padding:4px 8px;border:1px solid currentColor;border-radius:999px;font-weight:700;white-space:nowrap}
      .cfp11-warning{margin:10px 0;padding:10px 12px;border-radius:10px;background:rgba(234,179,8,.10);line-height:1.45}.cfp11-warning strong{display:block;margin-bottom:2px}
      .cfp11-actions{margin:12px 0}.cfp11-actions button{cursor:pointer;font:inherit;padding:8px 12px;border-radius:9px;border:1px solid rgba(127,127,127,.45);background:transparent}.cfp11-actions button:disabled{opacity:.55;cursor:progress}
      .cfp11-result{display:grid;gap:10px}.cfp11-loading{padding:10px 0;opacity:.75}.cfp11-state{display:grid;gap:3px;padding:10px 12px;border-radius:10px}.cfp11-state.ready{background:rgba(34,197,94,.10)}.cfp11-state.blocked{background:rgba(239,68,68,.10)}.cfp11-state span{font-size:12px;overflow-wrap:anywhere}
      .cfp11-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0}.cfp11-grid>div{min-width:0;padding:9px 10px;border:1px solid rgba(127,127,127,.20);border-radius:9px}.cfp11-grid dt{font-size:11px;opacity:.65}.cfp11-grid dd{margin:3px 0 0;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}@media(max-width:720px){.cfp11-grid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  global.CloudflarePhase11ExecutionReadiness = Object.freeze({ version: VERSION });
})(window);
