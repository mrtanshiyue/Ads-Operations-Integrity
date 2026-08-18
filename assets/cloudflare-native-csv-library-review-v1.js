import { buildCsvLibraryReviewBridge } from './csv-analysis-engine/csv-library-review-bridge.js';

export const CSV_LIBRARY_REVIEW_UI_VERSION = '1.0.0';
const STATES = Object.freeze(['open', 'shortlisted', 'dismissed']);
const state = { mounted: false, building: false, queue: null, states: new Map(), destination: '', reviewState: '' };

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvLibraryReview', {
    value: Object.freeze({
      version: CSV_LIBRARY_REVIEW_UI_VERSION,
      buildCsvLibraryReviewBridge,
      authority: 'csv_library_review_local_only',
      currentQueue: () => state.queue,
      currentStates: () => Object.freeze(Object.fromEntries(state.states)),
    }),
    writable: false,
    configurable: false,
    enumerable: true,
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}

function mount() {
  if (state.mounted) return;
  const panel = document.querySelector('[data-csv-joint-analysis]');
  if (!panel) {
    new MutationObserver((_, observer) => {
      if (!document.querySelector('[data-csv-joint-analysis]')) return;
      observer.disconnect();
      mount();
    }).observe(document.documentElement, { childList: true, subtree: true });
    return;
  }
  if (panel.querySelector('[data-csv-library-review]')) return void (state.mounted = true);

  installStyles();
  const root = document.createElement('section');
  root.className = 'cflr';
  root.dataset.csvLibraryReview = CSV_LIBRARY_REVIEW_UI_VERSION;
  root.innerHTML = `
    <div class="cflr-head"><div><b>Local Library Review</b><small>CSV candidates → Keyword / Negative Library intent. Browser memory only.</small></div><span>no persistence</span></div>
    <div class="cflr-controls">
      <button type="button" data-cflr-build>Build review queue</button>
      <button type="button" data-cflr-clear>Clear</button>
      <label>Destination <select data-cflr-destination><option value="">All</option><option value="keyword_library">Keyword Library</option><option value="negative_keyword_library">Negative Library</option></select></label>
      <label>State <select data-cflr-state><option value="">All</option><option value="open">open</option><option value="shortlisted">shortlisted</option><option value="dismissed">dismissed</option></select></label>
    </div>
    <div class="cflr-status" data-cflr-status>Build from the same files selected above after joint analysis.</div>
    <div data-cflr-body hidden></div>`;
  panel.appendChild(root);

  root.querySelector('[data-cflr-build]').addEventListener('click', () => void build(root));
  root.querySelector('[data-cflr-clear]').addEventListener('click', () => reset(root, 'Local review queue cleared.'));
  root.querySelector('[data-cflr-destination]').addEventListener('change', (event) => { state.destination = event.target.value; render(root); });
  root.querySelector('[data-cflr-state]').addEventListener('change', (event) => { state.reviewState = event.target.value; render(root); });
  root.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-cflr-next]');
    if (!button) return;
    const id = String(button.dataset.reviewId || '');
    const next = String(button.dataset.cflrNext || '');
    if (!state.states.has(id) || !STATES.includes(next)) return;
    state.states.set(id, next);
    render(root);
    status(root, `Local review state: ${next}. Nothing was persisted.`);
  });
  panel.querySelector('[data-csv-joint-files]')?.addEventListener('change', () => reset(root, 'CSV selection changed. Rebuild the local queue.'));
  panel.querySelector('[data-csv-joint-clear]')?.addEventListener('click', () => reset(root, 'Local review queue cleared.'));
  state.mounted = true;
}

async function build(root) {
  if (state.building) return;
  const panel = root.closest('[data-csv-joint-analysis]');
  const files = [...(panel?.querySelector('[data-csv-joint-files]')?.files || [])];
  if (!files.length) return status(root, 'Select Search Term CSV files above first.', 'bad');
  if (typeof window.CloudflareCsvJointAnalysis?.analyzeLocalCsvInputs !== 'function') return status(root, 'Joint CSV analysis is unavailable.', 'bad');

  state.building = true;
  const buildButton = root.querySelector('[data-cflr-build]');
  buildButton.disabled = true;
  status(root, `Building from ${files.length} local CSV file${files.length === 1 ? '' : 's'}…`, 'loading');
  try {
    const inputs = await Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() })));
    const joint = await window.CloudflareCsvJointAnalysis.analyzeLocalCsvInputs(inputs);
    state.queue = await buildCsvLibraryReviewBridge(joint);
    state.states = new Map(state.queue.items.map((item) => [item.reviewId, item.initialReviewState]));
    state.destination = '';
    state.reviewState = '';
    root.querySelector('[data-cflr-destination]').value = '';
    root.querySelector('[data-cflr-state]').value = '';
    render(root);
    status(root, `${state.queue.summary.reviewItemCount} local items built. No library write occurred.`, 'ok');
  } catch (error) {
    reset(root, `Review queue failed: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.building = false;
    buildButton.disabled = false;
  }
}

function reset(root, message, kind = '') {
  state.queue = null;
  state.states = new Map();
  state.destination = '';
  state.reviewState = '';
  const body = root.querySelector('[data-cflr-body]');
  body.hidden = true;
  body.innerHTML = '';
  root.querySelector('[data-cflr-destination]').value = '';
  root.querySelector('[data-cflr-state]').value = '';
  status(root, message, kind);
}

function render(root) {
  const body = root.querySelector('[data-cflr-body]');
  if (!state.queue) return void (body.hidden = true);
  const counts = { open: 0, shortlisted: 0, dismissed: 0 };
  for (const item of state.queue.items) counts[state.states.get(item.reviewId) || 'open'] += 1;
  const items = state.queue.items.filter((item) => {
    const reviewState = state.states.get(item.reviewId) || 'open';
    return (!state.destination || item.destination === state.destination) && (!state.reviewState || reviewState === state.reviewState);
  });
  body.hidden = false;
  body.innerHTML = `
    <div class="cflr-summary" data-cflr-summary>
      <span>Keyword <b>${num(state.queue.summary.keywordLibraryCandidateCount)}</b></span>
      <span>Negative <b>${num(state.queue.summary.negativeLibraryCandidateCount)}</b></span>
      <span>Open <b>${num(counts.open)}</b></span>
      <span>Shortlisted <b>${num(counts.shortlisted)}</b></span>
      <span>Dismissed <b>${num(counts.dismissed)}</b></span>
      <span>Identity blocked <b>${num(state.queue.summary.blockedObservedIdentityCount)}</b></span>
    </div>
    <div class="cflr-note"><b>Shortlisted = follow-up intent only.</b> It does not create or modify a keyword, negative keyword, scope, optimization action, or external advertising object.</div>
    <div class="cflr-table"><table><thead><tr><th>Destination</th><th>Candidate</th><th>Match</th><th>Evidence</th><th>Identity</th><th>State</th><th>Review</th></tr></thead><tbody>${items.length ? items.map(row).join('') : '<tr><td colspan="7">No matching local items.</td></tr>'}</tbody></table></div>
    <div class="cflr-foot"><span>Input-set fingerprint</span><code>${esc(state.queue.source.inputSetFingerprint)}</code><span>Canonical identity</span><b>unresolved</b><span>Persistence / execution</span><b>disabled / disabled</b></div>`;
}

function row(item) {
  const reviewState = state.states.get(item.reviewId) || 'open';
  const metrics = item.metrics || {};
  const identity = item.observedIdentity || {};
  const destination = item.destination === 'keyword_library' ? 'Keyword Library' : 'Negative Library';
  return `<tr data-cflr-id="${esc(item.reviewId)}"><td><b>${esc(destination)}</b><small>${esc(item.candidateKind)}</small></td><td><b>${esc(item.value)}</b><small>${esc(item.rationaleCode)}</small></td><td>${esc(item.suggestedMatchType)}</td><td>${money(metrics.spendMicros)} spend · ${num(metrics.orders ?? metrics.purchases)} orders<small>${pct(metrics.acos)} ACoS · priority ${dec(item.priorityScore)}</small></td><td class="${identity.confidenceBlocked ? 'bad' : ''}">${esc(identity.quality)}<small>${num(identity.linkCount)} links · ${num(identity.ambiguousLinkCount)} ambiguous</small></td><td><b>${esc(reviewState)}</b></td><td>${STATES.filter((next) => next !== reviewState).map((next) => `<button type="button" data-cflr-next="${next}" data-review-id="${esc(item.reviewId)}">${next}</button>`).join('')}</td></tr>`;
}

function status(root, message, kind = '') { const node = root.querySelector('[data-cflr-status]'); node.textContent = message; node.dataset.kind = kind; }
function money(value) { return value == null || !Number.isFinite(Number(value)) ? '—' : (Number(value) / 1_000_000).toFixed(2); }
function pct(value) { return value == null || !Number.isFinite(Number(value)) ? '—' : `${(Number(value) * 100).toFixed(1)}%`; }
function dec(value) { return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(2); }
function num(value) { return value == null || !Number.isFinite(Number(value)) ? '0' : Math.round(Number(value)).toLocaleString(); }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }

function installStyles() {
  if (document.getElementById('cflr-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cflr-style-v1';
  style.textContent = '.cflr{margin-top:14px;padding-top:14px;border-top:1px solid #e2e8f0}.cflr-head{display:flex;justify-content:space-between;gap:12px}.cflr-head small{display:block;color:#64748b}.cflr-head>span{font-size:11px;font-weight:800}.cflr-controls{display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin:10px 0}.cflr-controls label{display:flex;flex-direction:column;font-size:11px}.cflr-controls button,.cflr-controls select,.cflr-table button{border:1px solid #cbd5e1;border-radius:6px;padding:6px;background:#fff}.cflr-status{padding:7px;background:#f8fafc;border-radius:6px}.cflr-status[data-kind="bad"]{color:#b91c1c}.cflr-status[data-kind="ok"]{color:#047857}.cflr-summary{display:flex;gap:7px;flex-wrap:wrap;margin:9px 0}.cflr-summary span{border:1px solid #e2e8f0;border-radius:6px;padding:6px}.cflr-note{padding:8px;background:#fffbeb;color:#854d0e;border-radius:6px}.cflr-table{overflow:auto;margin-top:8px}.cflr-table table{width:100%;border-collapse:collapse;font-size:11px}.cflr-table th,.cflr-table td{padding:6px;border-bottom:1px solid #edf2f7;text-align:left;vertical-align:top}.cflr-table small{display:block;color:#64748b}.cflr-table .bad{color:#b91c1c}.cflr-table button{margin:0 3px 3px 0}.cflr-foot{display:grid;grid-template-columns:auto 2fr auto 1fr auto 1fr;gap:6px;margin-top:8px;padding:7px;background:#f8fafc;font-size:10px}.cflr-foot code{word-break:break-all}';
  document.head.appendChild(style);
}
