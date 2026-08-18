import { buildCsvLibraryReviewBridge } from './csv-analysis-engine/csv-library-review-bridge.js';

export const CSV_LIBRARY_REVIEW_UI_VERSION = '1.0.0';
const STATES = Object.freeze(['open', 'shortlisted', 'dismissed']);
const CANDIDATE_GROUPS = Object.freeze(['keyword_harvest', 'negative_exact', 'negative_phrase_root']);
const SORT_MODES = Object.freeze(['priority_desc', 'spend_desc', 'orders_desc', 'acos_desc', 'candidate_asc']);
const REVIEW_REASON_CODES = Object.freeze([
  'evidence_supports_follow_up',
  'identity_resolution_needed',
  'more_data_needed',
  'irrelevant_or_duplicate',
  'operator_other',
]);
const state = {
  mounted: false,
  building: false,
  queue: null,
  states: new Map(),
  annotations: new Map(),
  search: '',
  destination: '',
  reviewState: '',
  candidateGroup: '',
  confidence: '',
  sort: 'priority_desc',
};

export function selectCsvLibraryReviewItems(items, view = {}, reviewStates = new Map()) {
  const search = normalizeText(view.search);
  const destination = String(view.destination || '');
  const reviewState = String(view.reviewState || '');
  const candidateGroup = String(view.candidateGroup || '');
  const confidence = String(view.confidence || '');
  const sort = SORT_MODES.includes(view.sort) ? view.sort : 'priority_desc';
  const filtered = (Array.isArray(items) ? items : []).filter((item) => {
    const currentState = reviewStates.get?.(item.reviewId) || item.initialReviewState || 'open';
    if (destination && item.destination !== destination) return false;
    if (reviewState && currentState !== reviewState) return false;
    if (candidateGroup && item.candidateKind !== candidateGroup) return false;
    if (confidence && identityConfidenceKey(item.observedIdentity) !== confidence) return false;
    if (search) {
      const haystack = normalizeText([
        item.value,
        item.normalizedValue,
        item.rationaleCode,
        rationaleLabel(item.rationaleCode),
        candidateGroupLabel(item.candidateKind),
        item.suggestedMatchType,
      ].join(' '));
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
  return Object.freeze([...filtered].sort((left, right) => compareViewItems(left, right, sort)));
}

export function rationaleLabel(code) {
  const value = String(code || 'unspecified');
  const labels = {
    efficient_converting_search_term: 'Efficient converting search term',
    spend_without_orders: 'Spend without orders',
    toxic_root_pattern: 'Toxic root pattern',
    unspecified: 'Rationale not specified',
  };
  return labels[value] || value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function reviewReasonLabel(code) {
  return ({
    evidence_supports_follow_up: 'Evidence supports follow-up',
    identity_resolution_needed: 'Identity resolution needed',
    more_data_needed: 'More data needed',
    irrelevant_or_duplicate: 'Irrelevant or duplicate',
    operator_other: 'Other operator reason',
  })[String(code || '')] || 'Select decision reason';
}

export function canApplyLocalReviewTransition(nextState, annotation = {}) {
  const next = String(nextState || '');
  if (!STATES.includes(next)) return Object.freeze({ allowed: false, code: 'LOCAL_REVIEW_STATE_INVALID' });
  if (next === 'open') return Object.freeze({ allowed: true, code: 'LOCAL_REVIEW_OPEN_ALLOWED' });
  const reasonCode = String(annotation.reasonCode || '');
  if (!REVIEW_REASON_CODES.includes(reasonCode)) return Object.freeze({ allowed: false, code: 'LOCAL_REVIEW_REASON_REQUIRED' });
  if (reasonCode === 'operator_other' && !String(annotation.note || '').trim()) {
    return Object.freeze({ allowed: false, code: 'LOCAL_REVIEW_OTHER_NOTE_REQUIRED' });
  }
  return Object.freeze({ allowed: true, code: 'LOCAL_REVIEW_TRANSITION_ALLOWED' });
}

export function localFollowUpReadiness(item, reviewState, annotation = {}) {
  const current = String(reviewState || item?.initialReviewState || 'open');
  const transition = canApplyLocalReviewTransition(current, annotation);
  if (current === 'dismissed') return Object.freeze({ state: 'dismissed', label: 'Dismissed locally', persistenceReady: false, executionReady: false });
  if (current !== 'shortlisted') return Object.freeze({ state: 'not_shortlisted', label: 'Not shortlisted', persistenceReady: false, executionReady: false });
  if (!transition.allowed) return Object.freeze({ state: 'decision_reason_missing', label: 'Decision reason missing', persistenceReady: false, executionReady: false });
  const identity = item?.observedIdentity || {};
  if (identity.confidenceBlocked === true || identity.quality === 'blocked_observed_identity') {
    return Object.freeze({ state: 'blocked_observed_identity', label: 'Identity blocked', persistenceReady: false, executionReady: false });
  }
  if (identity.quality !== 'observed_only') {
    return Object.freeze({ state: 'identity_unresolved', label: 'Identity unresolved', persistenceReady: false, executionReady: false });
  }
  return Object.freeze({ state: 'local_follow_up_ready', label: 'Local follow-up ready', persistenceReady: false, executionReady: false });
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvLibraryReview', {
    value: Object.freeze({
      version: CSV_LIBRARY_REVIEW_UI_VERSION,
      buildCsvLibraryReviewBridge,
      selectCsvLibraryReviewItems,
      rationaleLabel,
      reviewReasonLabel,
      canApplyLocalReviewTransition,
      localFollowUpReadiness,
      authority: 'csv_library_review_local_only',
      currentQueue: () => state.queue,
      currentStates: () => Object.freeze(Object.fromEntries(state.states)),
      currentAnnotations: () => Object.freeze(Object.fromEntries([...state.annotations].map(([id, value]) => [id, Object.freeze({ ...value })]))),
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
      <label>Search <input type="search" data-cflr-search placeholder="candidate or rationale"></label>
      <label>Destination <select data-cflr-destination><option value="">All</option><option value="keyword_library">Keyword Library</option><option value="negative_keyword_library">Negative Library</option></select></label>
      <label>Candidate group <select data-cflr-group><option value="">All</option><option value="keyword_harvest">Keyword harvest</option><option value="negative_exact">Exact negative</option><option value="negative_phrase_root">Phrase negative review</option></select></label>
      <label>Identity confidence <select data-cflr-confidence><option value="">All</option><option value="observed">Observed-only</option><option value="blocked">Blocked</option><option value="unresolved">Unresolved</option></select></label>
      <label>State <select data-cflr-state><option value="">All</option><option value="open">open</option><option value="shortlisted">shortlisted</option><option value="dismissed">dismissed</option></select></label>
      <label>Sort <select data-cflr-sort><option value="priority_desc">Priority ↓</option><option value="spend_desc">Spend ↓</option><option value="orders_desc">Orders ↓</option><option value="acos_desc">ACoS ↓</option><option value="candidate_asc">Candidate A–Z</option></select></label>
    </div>
    <div class="cflr-status" data-cflr-status>Build from the same files selected above after joint analysis.</div>
    <div data-cflr-body hidden></div>`;
  panel.appendChild(root);

  root.querySelector('[data-cflr-build]').addEventListener('click', () => void build(root));
  root.querySelector('[data-cflr-clear]').addEventListener('click', () => reset(root, 'Local review queue cleared.'));
  root.querySelector('[data-cflr-search]').addEventListener('input', (event) => { state.search = event.target.value; render(root); });
  root.querySelector('[data-cflr-destination]').addEventListener('change', (event) => { state.destination = event.target.value; render(root); });
  root.querySelector('[data-cflr-group]').addEventListener('change', (event) => { state.candidateGroup = event.target.value; render(root); });
  root.querySelector('[data-cflr-confidence]').addEventListener('change', (event) => { state.confidence = event.target.value; render(root); });
  root.querySelector('[data-cflr-state]').addEventListener('change', (event) => { state.reviewState = event.target.value; render(root); });
  root.querySelector('[data-cflr-sort]').addEventListener('change', (event) => { state.sort = event.target.value; render(root); });
  root.addEventListener('change', (event) => {
    const select = event.target.closest?.('[data-cflr-reason]');
    if (!select) return;
    const id = String(select.dataset.reviewId || '');
    if (!state.annotations.has(id)) return;
    const current = state.annotations.get(id);
    state.annotations.set(id, Object.freeze({ ...current, reasonCode: String(select.value || '') }));
    render(root);
  });
  root.addEventListener('input', (event) => {
    const input = event.target.closest?.('[data-cflr-note]');
    if (!input) return;
    const id = String(input.dataset.reviewId || '');
    if (!state.annotations.has(id)) return;
    const current = state.annotations.get(id);
    state.annotations.set(id, Object.freeze({ ...current, note: String(input.value || '').slice(0, 240) }));
  });
  root.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-cflr-next]');
    if (!button) return;
    const id = String(button.dataset.reviewId || '');
    const next = String(button.dataset.cflrNext || '');
    if (!state.states.has(id) || !STATES.includes(next)) return;
    const annotation = state.annotations.get(id) || { reasonCode: '', note: '' };
    const gate = canApplyLocalReviewTransition(next, annotation);
    if (!gate.allowed) {
      const message = gate.code === 'LOCAL_REVIEW_OTHER_NOTE_REQUIRED'
        ? 'Add a local note when using Other operator reason.'
        : 'Choose a local decision reason before shortlisting or dismissing.';
      return status(root, message, 'bad');
    }
    state.states.set(id, next);
    render(root);
    status(root, `Local review state: ${next}. Decision annotation remains browser-memory only; nothing was persisted.`, 'ok');
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
    state.annotations = new Map(state.queue.items.map((item) => [item.reviewId, Object.freeze({ reasonCode: '', note: '' })]));
    resetViewControls(root);
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
  state.annotations = new Map();
  resetViewControls(root);
  const body = root.querySelector('[data-cflr-body]');
  body.hidden = true;
  body.innerHTML = '';
  status(root, message, kind);
}

function resetViewControls(root) {
  state.search = '';
  state.destination = '';
  state.reviewState = '';
  state.candidateGroup = '';
  state.confidence = '';
  state.sort = 'priority_desc';
  root.querySelector('[data-cflr-search]').value = '';
  root.querySelector('[data-cflr-destination]').value = '';
  root.querySelector('[data-cflr-state]').value = '';
  root.querySelector('[data-cflr-group]').value = '';
  root.querySelector('[data-cflr-confidence]').value = '';
  root.querySelector('[data-cflr-sort]').value = 'priority_desc';
}

function render(root) {
  const body = root.querySelector('[data-cflr-body]');
  if (!state.queue) return void (body.hidden = true);
  const counts = { open: 0, shortlisted: 0, dismissed: 0 };
  for (const item of state.queue.items) counts[state.states.get(item.reviewId) || 'open'] += 1;
  const items = selectCsvLibraryReviewItems(state.queue.items, state, state.states);
  const groups = groupReviewItems(items);
  body.hidden = false;
  body.innerHTML = `
    <div class="cflr-summary" data-cflr-summary>
      <span>Showing <b>${num(items.length)}/${num(state.queue.summary.reviewItemCount)}</b></span>
      <span>Keyword <b>${num(state.queue.summary.keywordLibraryCandidateCount)}</b></span>
      <span>Negative <b>${num(state.queue.summary.negativeLibraryCandidateCount)}</b></span>
      <span>Open <b>${num(counts.open)}</b></span>
      <span>Shortlisted <b>${num(counts.shortlisted)}</b></span>
      <span>Dismissed <b>${num(counts.dismissed)}</b></span>
      <span>Identity blocked <b>${num(state.queue.summary.blockedObservedIdentityCount)}</b></span>
    </div>
    <div class="cflr-group-summary">${CANDIDATE_GROUPS.map((kind) => `<span>${esc(candidateGroupLabel(kind))} <b>${num(state.queue.items.filter((item) => item.candidateKind === kind).length)}</b></span>`).join('')}</div>
    <div class="cflr-note"><b>Shortlisted = local follow-up intent only.</b> A decision reason is required for shortlist/dismiss. Notes and states are browser-memory only and never create persistence, execution, or Amazon mutation authority.</div>
    <div class="cflr-table"><table><thead><tr><th>Candidate</th><th>Match</th><th>Rationale</th><th>Evidence</th><th>Identity confidence</th><th>Local decision</th><th>State</th><th>Review</th></tr></thead><tbody>${groups.length ? groups.map(groupRows).join('') : '<tr><td colspan="8">No matching local items.</td></tr>'}</tbody></table></div>
    <div class="cflr-foot"><span>Input-set fingerprint</span><code>${esc(state.queue.source.inputSetFingerprint)}</code><span>Canonical identity</span><b>unresolved</b><span>Persistence / execution</span><b>disabled / disabled</b></div>`;
}

function groupReviewItems(items) {
  const buckets = new Map(CANDIDATE_GROUPS.map((kind) => [kind, []]));
  for (const item of items) {
    if (!buckets.has(item.candidateKind)) buckets.set(item.candidateKind, []);
    buckets.get(item.candidateKind).push(item);
  }
  return [...buckets.entries()].filter(([, values]) => values.length).map(([kind, values]) => Object.freeze({ kind, items: Object.freeze(values) }));
}

function groupRows(group) {
  const destination = group.kind === 'keyword_harvest' ? 'Keyword Library' : 'Negative Library';
  return `<tr class="cflr-group-row"><td colspan="8"><b>${esc(candidateGroupLabel(group.kind))}</b><span>${esc(destination)} · ${num(group.items.length)} item${group.items.length === 1 ? '' : 's'}</span></td></tr>${group.items.map(row).join('')}`;
}

function row(item) {
  const reviewState = state.states.get(item.reviewId) || 'open';
  const annotation = state.annotations.get(item.reviewId) || { reasonCode: '', note: '' };
  const metrics = item.metrics || {};
  const identity = item.observedIdentity || {};
  const confidence = identityConfidenceKey(identity);
  const readiness = localFollowUpReadiness(item, reviewState, annotation);
  return `<tr data-cflr-id="${esc(item.reviewId)}"><td><b>${esc(item.value)}</b><small>${esc(candidateGroupLabel(item.candidateKind))} · priority ${dec(item.priorityScore)}</small></td><td>${esc(item.suggestedMatchType)}</td><td><b>${esc(rationaleLabel(item.rationaleCode))}</b><small>${esc(item.rationaleCode)}</small></td><td>${money(metrics.spendMicros)} spend · ${num(metrics.orders ?? metrics.purchases)} orders<small>${pct(metrics.acos)} ACoS · ${num(item.sourceTermCount)} source term${Number(item.sourceTermCount) === 1 ? '' : 's'}</small></td><td class="${confidence === 'blocked' ? 'bad' : ''}"><b>${esc(confidenceLabel(confidence))}</b><small>${esc(identity.quality || 'unresolved')} · ${num(identity.linkCount)} links · ${num(identity.ambiguousLinkCount)} ambiguous</small></td><td><select data-cflr-reason data-review-id="${esc(item.reviewId)}"><option value="">Select decision reason</option>${REVIEW_REASON_CODES.map((code) => `<option value="${code}"${annotation.reasonCode === code ? ' selected' : ''}>${esc(reviewReasonLabel(code))}</option>`).join('')}</select><input data-cflr-note data-review-id="${esc(item.reviewId)}" maxlength="240" placeholder="Local note (optional*)" value="${esc(annotation.note)}"><small>*Required only for Other operator reason</small><span class="cflr-readiness ${readiness.state.includes('blocked') || readiness.state.includes('unresolved') || readiness.state.includes('missing') ? 'bad' : ''}">${esc(readiness.label)} · persistence disabled</span></td><td><b>${esc(reviewState)}</b></td><td>${STATES.filter((next) => next !== reviewState).map((next) => `<button type="button" data-cflr-next="${next}" data-review-id="${esc(item.reviewId)}">${next}</button>`).join('')}</td></tr>`;
}

function candidateGroupLabel(kind) {
  return ({ keyword_harvest: 'Keyword harvest', negative_exact: 'Exact negative', negative_phrase_root: 'Phrase negative review' })[kind] || String(kind || 'Other');
}
function identityConfidenceKey(identity = {}) {
  if (identity.confidenceBlocked === true || identity.quality === 'blocked_observed_identity') return 'blocked';
  if (identity.quality === 'observed_only') return 'observed';
  return 'unresolved';
}
function confidenceLabel(value) { return ({ blocked: 'Blocked', observed: 'Observed-only', unresolved: 'Unresolved' })[value] || 'Unresolved'; }
function compareViewItems(left, right, sort) {
  if (sort === 'spend_desc') return metricNumber(right, 'spendMicros') - metricNumber(left, 'spendMicros') || fallbackCompare(left, right);
  if (sort === 'orders_desc') return orders(right) - orders(left) || fallbackCompare(left, right);
  if (sort === 'acos_desc') return nullableMetric(right.metrics?.acos) - nullableMetric(left.metrics?.acos) || fallbackCompare(left, right);
  if (sort === 'candidate_asc') return String(left.normalizedValue || left.value || '').localeCompare(String(right.normalizedValue || right.value || '')) || fallbackCompare(left, right);
  return Number(right.priorityScore || 0) - Number(left.priorityScore || 0) || fallbackCompare(left, right);
}
function fallbackCompare(left, right) { return String(left.destination || '').localeCompare(String(right.destination || '')) || String(left.normalizedValue || left.value || '').localeCompare(String(right.normalizedValue || right.value || '')) || String(left.reviewId || '').localeCompare(String(right.reviewId || '')); }
function metricNumber(item, key) { const value = Number(item?.metrics?.[key]); return Number.isFinite(value) ? value : 0; }
function orders(item) { const value = Number(item?.metrics?.orders ?? item?.metrics?.purchases); return Number.isFinite(value) ? value : 0; }
function nullableMetric(value) { const number = Number(value); return value == null || !Number.isFinite(number) ? -Infinity : number; }
function normalizeText(value) { return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim(); }
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
  style.textContent = '.cflr{margin-top:14px;padding-top:14px;border-top:1px solid #e2e8f0}.cflr-head{display:flex;justify-content:space-between;gap:12px}.cflr-head small{display:block;color:#64748b}.cflr-head>span{font-size:11px;font-weight:800}.cflr-controls{display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin:10px 0}.cflr-controls label{display:flex;flex-direction:column;font-size:11px}.cflr-controls button,.cflr-controls select,.cflr-controls input,.cflr-table button,.cflr-table select,.cflr-table input{border:1px solid #cbd5e1;border-radius:6px;padding:6px;background:#fff}.cflr-controls input{min-width:170px}.cflr-status{padding:7px;background:#f8fafc;border-radius:6px}.cflr-status[data-kind="bad"]{color:#b91c1c}.cflr-status[data-kind="ok"]{color:#047857}.cflr-summary,.cflr-group-summary{display:flex;gap:7px;flex-wrap:wrap;margin:9px 0}.cflr-summary span,.cflr-group-summary span{border:1px solid #e2e8f0;border-radius:6px;padding:6px}.cflr-group-summary{font-size:10px;color:#475569}.cflr-note{padding:8px;background:#fffbeb;color:#854d0e;border-radius:6px}.cflr-table{overflow:auto;margin-top:8px}.cflr-table table{width:100%;border-collapse:collapse;font-size:11px}.cflr-table th,.cflr-table td{padding:6px;border-bottom:1px solid #edf2f7;text-align:left;vertical-align:top}.cflr-table small{display:block;color:#64748b}.cflr-table .bad{color:#b91c1c}.cflr-table button{margin:0 3px 3px 0}.cflr-table select,.cflr-table input{display:block;min-width:180px;max-width:220px;margin-bottom:4px}.cflr-readiness{display:inline-block;margin-top:4px;padding:3px 5px;border-radius:4px;background:#ecfdf5;color:#047857;font-size:10px}.cflr-readiness.bad{background:#fef2f2;color:#b91c1c}.cflr-group-row td{background:#f8fafc;border-top:1px solid #cbd5e1}.cflr-group-row span{margin-left:8px;color:#64748b}.cflr-foot{display:grid;grid-template-columns:auto 2fr auto 1fr auto 1fr;gap:6px;margin-top:8px;padding:7px;background:#f8fafc;font-size:10px}.cflr-foot code{word-break:break-all}@media(max-width:760px){.cflr-foot{grid-template-columns:1fr 2fr}}';
  document.head.appendChild(style);
}
