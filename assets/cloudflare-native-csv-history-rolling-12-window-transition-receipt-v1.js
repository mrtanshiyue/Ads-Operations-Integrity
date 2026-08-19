import { parseCsvHistoryLedger } from './csv-analysis-engine/csv-history-ledger.js';
import {
  CSV_HISTORY_DETERMINISTIC_RECEIPT_NUMBER_PROJECTION_VERSION,
  fingerprintDeterministicReceiptPayload,
  serializeDeterministicReceiptJson,
} from './csv-analysis-engine/csv-history-deterministic-receipt.js';
import { buildHistoricalRolling12OperatingReview } from './cloudflare-native-csv-history-rolling-12-operating-review-v1.js';
import { buildHistoricalRolling12WindowTransitionReview } from './cloudflare-native-csv-history-rolling-12-window-transition-review-v1.js';

export const CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_RECEIPT_SCHEMA_VERSION = 'csv-history-rolling-12-window-transition-receipt-v1';
export const CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_RECEIPT_UI_VERSION = '1.0.0';

const PROFITABILITY_BASIS = 'sales_minus_ad_spend_only_not_net_profit';
const TRANSITION_SCHEMA = 'csv-history-rolling-12-window-transition-review-v1';
const state = { mounted: false, busy: false, ledger: null, windows: [], receipt: null };

export async function buildHistoricalRolling12WindowTransitionReceipt(ledger, previousWindowKey, currentWindowKey, options = {}) {
  const currentLedger = Object.prototype.hasOwnProperty.call(options || {}, 'currentLedger') ? options.currentLedger : ledger;
  const transition = await buildHistoricalRolling12WindowTransitionReview(ledger, previousWindowKey, currentWindowKey, { currentLedger });
  const source = projectSourceBinding(transition);
  const payload = {
    schemaVersion: CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_RECEIPT_SCHEMA_VERSION,
    receiptPurpose: 'local_historical_rolling_12_window_transition_audit_only',
    source,
    transition,
    deterministic: {
      generatedTimestampIncluded: false,
      canonicalProjectionVersion: CSV_HISTORY_DETERMINISTIC_RECEIPT_NUMBER_PROJECTION_VERSION,
      transitionRecomputedFromLedgerEvidence: true,
      previousAndCurrentLedgerEvidenceBound: true,
      sharedQuarterEvidenceIdentityBound: true,
    },
    authority: noAuthority(),
  };
  assertReceiptBoundary(payload);
  const receiptFingerprint = await fingerprintDeterministicReceiptPayload(payload);
  return deepFreeze({ ...payload, receiptFingerprint });
}

export async function validateHistoricalRolling12WindowTransitionReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_INVALID');
  if (receipt.schemaVersion !== CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_RECEIPT_SCHEMA_VERSION) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_SCHEMA_UNSUPPORTED');
  assertReceiptBoundary(receipt);
  const fingerprint = String(receipt.receiptFingerprint || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_FINGERPRINT_INVALID');
  const { receiptFingerprint: _ignored, ...payload } = receipt;
  const expected = await fingerprintDeterministicReceiptPayload(payload);
  if (expected !== fingerprint) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_FINGERPRINT_MISMATCH');
  assertSourceBinding(receipt);
  return deepFreeze(structuredClone(receipt));
}

export async function parseHistoricalRolling12WindowTransitionReceipt(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_JSON_INVALID');
  }
  return validateHistoricalRolling12WindowTransitionReceipt(parsed);
}

export function serializeHistoricalRolling12WindowTransitionReceipt(receipt) {
  assertReceiptBoundary(receipt);
  if (!/^[a-f0-9]{64}$/i.test(String(receipt?.receiptFingerprint || ''))) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_FINGERPRINT_INVALID');
  return serializeDeterministicReceiptJson(receipt);
}

function projectSourceBinding(transition) {
  const previousWindow = transition.previousWindow;
  const currentWindow = transition.currentWindow;
  const outgoing = transition.decomposition.outgoingQuarter;
  const incoming = transition.decomposition.incomingQuarter;
  return {
    previousLedgerFingerprint: transition.previousLedgerFingerprint,
    currentLedgerFingerprint: transition.currentLedgerFingerprint,
    previousWindowKey: previousWindow.windowKey,
    currentWindowKey: currentWindow.windowKey,
    previousWindowSourceInputSetFingerprints: [...(previousWindow.sourceInputSetFingerprints || [])],
    currentWindowSourceInputSetFingerprints: [...(currentWindow.sourceInputSetFingerprints || [])],
    outgoingQuarterKey: transition.decomposition.outgoingQuarterKey,
    incomingQuarterKey: transition.decomposition.incomingQuarterKey,
    sharedQuarterKeys: [...transition.decomposition.sharedQuarterKeys],
    outgoingCanonicalQuarterFingerprint: outgoing?.canonicalQuarterFingerprint || null,
    incomingCanonicalQuarterFingerprint: incoming?.canonicalQuarterFingerprint || null,
    sharedQuarterBindings: transition.decomposition.sharedQuarterEvidence.map((item) => ({
      quarter: item.quarter,
      previousCanonicalQuarterFingerprint: item.previousCanonicalQuarterFingerprint,
      currentCanonicalQuarterFingerprint: item.currentCanonicalQuarterFingerprint,
      previousSourceInputSetFingerprints: [...item.previousSourceInputSetFingerprints],
      currentSourceInputSetFingerprints: [...item.currentSourceInputSetFingerprints],
      previousSourceContentSha256s: [...item.previousSourceContentSha256s],
      currentSourceContentSha256s: [...item.currentSourceContentSha256s],
    })),
  };
}

function assertReceiptBoundary(receipt) {
  assertAuthorityFalse(receipt?.authority);
  if (receipt?.receiptPurpose !== 'local_historical_rolling_12_window_transition_audit_only') throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_PURPOSE_INVALID');
  const deterministic = receipt?.deterministic;
  if (!deterministic || deterministic.generatedTimestampIncluded !== false
    || deterministic.canonicalProjectionVersion !== CSV_HISTORY_DETERMINISTIC_RECEIPT_NUMBER_PROJECTION_VERSION
    || deterministic.transitionRecomputedFromLedgerEvidence !== true
    || deterministic.previousAndCurrentLedgerEvidenceBound !== true
    || deterministic.sharedQuarterEvidenceIdentityBound !== true) {
    throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_DETERMINISM_BOUNDARY_INVALID');
  }

  const transition = receipt?.transition;
  if (!transition || transition.schemaVersion !== TRANSITION_SCHEMA) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_TRANSITION_INVALID');
  assertAuthorityFalse(transition.authority);
  assertAuthorityFalse(transition.previousWindow?.authority);
  assertAuthorityFalse(transition.currentWindow?.authority);
  if (transition.decomposition?.outgoingQuarter) assertAuthorityFalse(transition.decomposition.outgoingQuarter.authority);
  if (transition.decomposition?.incomingQuarter) assertAuthorityFalse(transition.decomposition.incomingQuarter.authority);
  for (const item of transition.decomposition?.sharedQuarterEvidence || []) assertAuthorityFalse(item.authority);
  if (transition.profitabilityBasis !== PROFITABILITY_BASIS) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_PROFITABILITY_BASIS_INVALID');
  if (transition.transitionSemantics !== 'overlap_aware_one_quarter_out_one_quarter_in_three_quarters_shared') throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_SEMANTICS_INVALID');
  if (transition.additiveDeltaBasis !== 'incoming_quarter_minus_outgoing_quarter_equivalent_to_current_r12_minus_previous_r12') throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_ADDITIVE_BASIS_INVALID');
  if (transition.ratioDeltaBasis !== 'current_full_rolling_12_ratio_minus_previous_full_rolling_12_ratio_recomputed_from_full_window_totals') throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_RATIO_BASIS_INVALID');
  if (transition.selectionPolicy !== 'operator_selected_forward_adjacent_quarter_aligned_rolling_12_windows_no_auto_reorder_or_repair') throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_SELECTION_POLICY_INVALID');
  for (const [key, expected] of Object.entries({
    crossWindowAggregationApplied: false,
    crossWindowNormalizationApplied: false,
    overlapCollapseApplied: false,
    sharedEvidenceAutoReconciled: false,
    gapRepairApplied: false,
    windowSelectionAutoReordered: false,
    recommendationGenerated: false,
    actionGenerated: false,
  })) {
    if (transition[key] !== expected) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_INTEGRITY_BOUNDARY_INVALID');
  }
  if (transition.comparabilityGate?.sameQuarterKeyDoesNotImplySameEvidence !== true
    || transition.comparabilityGate?.sharedEvidenceIdentityMustMatch !== true
    || transition.comparabilityGate?.exactlyThreeSharedQuartersRequired !== true) {
    throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_COMPARABILITY_BOUNDARY_INVALID');
  }
  assertRatioTransitionBoundary(transition);
  if (transition.transitionAllowed === true) {
    if (transition.interpretationAllowed !== true || transition.rawEvidenceOnly !== false) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_ALLOWED_STATE_INVALID');
    if (transition.decomposition?.sharedQuarterCount !== 3 || transition.decomposition?.overlapMonths !== 9) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_OVERLAP_SHAPE_INVALID');
    if (!Object.values(transition.comparabilityGate?.checks || {}).every((value) => value === true)) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_ALLOWED_GATE_INVALID');
    assertAllowedTransitionMetrics(transition.transitionMetrics);
  } else {
    if (transition.rawEvidenceOnly !== true || transition.interpretationAllowed !== false) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_BLOCKED_STATE_INVALID');
    if (!Array.isArray(transition.comparabilityGate?.blockers) || transition.comparabilityGate.blockers.length === 0) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_BLOCKED_REASON_INVALID');
    assertWithheldTransitionMetrics(transition.transitionMetrics);
  }
}

function assertRatioTransitionBoundary(transition) {
  for (const key of ['acos', 'roas']) {
    const metric = transition.transitionMetrics?.ratios?.[key];
    if (!metric || metric.incomingOutgoingQuarterRatioDeltaUsed !== false) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_RATIO_TRANSITION_INVALID');
  }
}

function assertAllowedTransitionMetrics(metrics) {
  for (const item of Object.values(metrics?.additive || {})) {
    if (![item.previousRolling12Value, item.currentRolling12Value, item.outgoingQuarterValue, item.incomingQuarterValue, item.rolling12Delta, item.fullWindowDelta].every(Number.isSafeInteger)
      || item.rolling12Delta !== item.fullWindowDelta
      || item.currentRolling12Value - item.previousRolling12Value !== item.incomingQuarterValue - item.outgoingQuarterValue
      || item.interpretationAllowed !== true) {
      throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_ADDITIVE_TRANSITION_INVALID');
    }
  }
  for (const item of Object.values(metrics?.ratios || {})) {
    if (![item.previousRolling12Value, item.currentRolling12Value, item.rolling12Delta].every(finiteMetric)
      || item.rolling12Delta !== item.currentRolling12Value - item.previousRolling12Value
      || item.interpretationAllowed !== true) {
      throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_RATIO_TRANSITION_INVALID');
    }
  }
}

function assertWithheldTransitionMetrics(metrics) {
  for (const item of Object.values(metrics?.additive || {})) {
    for (const key of ['previousRolling12Value', 'currentRolling12Value', 'outgoingQuarterValue', 'incomingQuarterValue', 'rolling12Delta', 'fullWindowDelta']) {
      if (item[key] !== null) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_BLOCKED_METRIC_INVALID');
    }
    if (item.interpretationAllowed !== false) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_BLOCKED_METRIC_INVALID');
  }
  for (const item of Object.values(metrics?.ratios || {})) {
    for (const key of ['previousRolling12Value', 'currentRolling12Value', 'rolling12Delta']) {
      if (item[key] !== null) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_BLOCKED_METRIC_INVALID');
    }
    if (item.incomingOutgoingQuarterRatioDeltaUsed !== false || item.interpretationAllowed !== false) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_BLOCKED_METRIC_INVALID');
  }
}

function assertSourceBinding(receipt) {
  const source = receipt?.source;
  const transition = receipt?.transition;
  if (!source || source.previousLedgerFingerprint !== transition?.previousLedgerFingerprint) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_PREVIOUS_LEDGER_BINDING_MISMATCH');
  if (source.currentLedgerFingerprint !== transition?.currentLedgerFingerprint) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_CURRENT_LEDGER_BINDING_MISMATCH');
  if (source.previousWindowKey !== transition?.previousWindow?.windowKey) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_PREVIOUS_WINDOW_BINDING_MISMATCH');
  if (source.currentWindowKey !== transition?.currentWindow?.windowKey) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_CURRENT_WINDOW_BINDING_MISMATCH');
  if (!sameStringArray(source.previousWindowSourceInputSetFingerprints, transition?.previousWindow?.sourceInputSetFingerprints)) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_PREVIOUS_SOURCE_BINDING_MISMATCH');
  if (!sameStringArray(source.currentWindowSourceInputSetFingerprints, transition?.currentWindow?.sourceInputSetFingerprints)) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_CURRENT_SOURCE_BINDING_MISMATCH');
  if (source.outgoingQuarterKey !== transition?.decomposition?.outgoingQuarterKey) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_OUTGOING_QUARTER_BINDING_MISMATCH');
  if (source.incomingQuarterKey !== transition?.decomposition?.incomingQuarterKey) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_INCOMING_QUARTER_BINDING_MISMATCH');
  if (!sameStringArray(source.sharedQuarterKeys, transition?.decomposition?.sharedQuarterKeys)) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_SHARED_QUARTER_BINDING_MISMATCH');
  if (source.outgoingCanonicalQuarterFingerprint !== (transition?.decomposition?.outgoingQuarter?.canonicalQuarterFingerprint || null)) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_OUTGOING_IDENTITY_BINDING_MISMATCH');
  if (source.incomingCanonicalQuarterFingerprint !== (transition?.decomposition?.incomingQuarter?.canonicalQuarterFingerprint || null)) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_INCOMING_IDENTITY_BINDING_MISMATCH');
  const expectedShared = (transition?.decomposition?.sharedQuarterEvidence || []).map((item) => ({
    quarter: item.quarter,
    previousCanonicalQuarterFingerprint: item.previousCanonicalQuarterFingerprint,
    currentCanonicalQuarterFingerprint: item.currentCanonicalQuarterFingerprint,
    previousSourceInputSetFingerprints: [...item.previousSourceInputSetFingerprints],
    currentSourceInputSetFingerprints: [...item.currentSourceInputSetFingerprints],
    previousSourceContentSha256s: [...item.previousSourceContentSha256s],
    currentSourceContentSha256s: [...item.currentSourceContentSha256s],
  }));
  if (!sameSharedQuarterBindings(source.sharedQuarterBindings, expectedShared)) throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_SHARED_EVIDENCE_BINDING_MISMATCH');
}

function sameSharedQuarterBindings(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((item, index) => {
      const expected = right[index];
      return item?.quarter === expected?.quarter
        && item?.previousCanonicalQuarterFingerprint === expected?.previousCanonicalQuarterFingerprint
        && item?.currentCanonicalQuarterFingerprint === expected?.currentCanonicalQuarterFingerprint
        && sameStringArray(item?.previousSourceInputSetFingerprints, expected?.previousSourceInputSetFingerprints)
        && sameStringArray(item?.currentSourceInputSetFingerprints, expected?.currentSourceInputSetFingerprints)
        && sameStringArray(item?.previousSourceContentSha256s, expected?.previousSourceContentSha256s)
        && sameStringArray(item?.currentSourceContentSha256s, expected?.currentSourceContentSha256s);
    });
}
function sameStringArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
}
function finiteMetric(value) { return typeof value === 'number' && Number.isFinite(value); }
function assertAuthorityFalse(authority) {
  if (!authority || authority.authoritative !== false || authority.canonicalAmazonIdentityResolved !== false || authority.governancePersistenceAllowed !== false || authority.executionAuthorized !== false || authority.amazonMutationAuthorized !== false) {
    throw receiptError('CSV_HISTORY_R12_TRANSITION_RECEIPT_AUTHORITY_ESCALATION_BLOCKED');
  }
}
function noAuthority() {
  return { authoritative: false, canonicalAmazonIdentityResolved: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false };
}
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
function receiptError(code) {
  const error = new Error(code);
  error.name = 'CsvHistoryRolling12WindowTransitionReceiptError';
  error.code = code;
  return error;
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvHistoryRolling12WindowTransitionReceipt', {
    value: Object.freeze({
      version: CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_RECEIPT_UI_VERSION,
      schemaVersion: CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_RECEIPT_SCHEMA_VERSION,
      authority: 'local_historical_rolling_12_window_transition_audit_only',
      buildHistoricalRolling12WindowTransitionReceipt,
      validateHistoricalRolling12WindowTransitionReceipt,
      parseHistoricalRolling12WindowTransitionReceipt,
      serializeHistoricalRolling12WindowTransitionReceipt,
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
  const host = document.querySelector('[data-csv-history-rolling-12-window-transition-review]');
  if (!host) {
    new MutationObserver((_, observer) => {
      if (!document.querySelector('[data-csv-history-rolling-12-window-transition-review]')) return;
      observer.disconnect();
      mount();
    }).observe(document.documentElement, { childList: true, subtree: true });
    return;
  }
  if (document.querySelector('[data-csv-history-rolling-12-window-transition-receipt]')) return void (state.mounted = true);
  installStyles();
  const root = document.createElement('section');
  root.className = 'cfhr12tr';
  root.dataset.csvHistoryRolling12WindowTransitionReceipt = CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_RECEIPT_UI_VERSION;
  root.innerHTML = `
    <div class="cfhr12tr-head"><div><b>Rolling-12 Transition Receipt</b><small>Recompute an overlap-aware Rolling-12 window transition from an explicit local history ledger and produce a deterministic audit receipt bound to both window identities and all shared/outgoing/incoming evidence identities.</small></div><span>local replay · deterministic</span></div>
    <div class="cfhr12tr-guard">Receipt generation does not upgrade transition comparability or authority. Blocked transitions remain exportable as raw-evidence-only receipts with all transition metrics withheld. Same quarter key does not imply same evidence.</div>
    <div class="cfhr12tr-controls"><label>History ledger <input type="file" accept="application/json,.json" data-cfhr12tr-ledger></label><label>Previous R12 <select data-cfhr12tr-previous disabled><option value="">Import ledger first</option></select></label><label>Current R12 <select data-cfhr12tr-current disabled><option value="">Import ledger first</option></select></label><button type="button" data-cfhr12tr-build disabled>Build receipt</button><button type="button" data-cfhr12tr-download disabled>Download receipt</button></div>
    <div class="cfhr12tr-status" data-cfhr12tr-status>Explicit local-file ownership only. No ledger or receipt is silently persisted.</div>
    <div class="cfhr12tr-result" data-cfhr12tr-result hidden></div>`;
  host.insertAdjacentElement('afterend', root);
  root.querySelector('[data-cfhr12tr-ledger]').addEventListener('change', (event) => void importLedger(root, event.currentTarget));
  root.querySelector('[data-cfhr12tr-previous]').addEventListener('change', () => syncControls(root));
  root.querySelector('[data-cfhr12tr-current]').addEventListener('change', () => syncControls(root));
  root.querySelector('[data-cfhr12tr-build]').addEventListener('click', () => void buildReceiptFromUi(root));
  root.querySelector('[data-cfhr12tr-download]').addEventListener('click', () => downloadReceipt(root));
  state.mounted = true;
}

async function importLedger(root, input) {
  const file = input.files?.[0];
  if (!file || state.busy) return;
  state.busy = true;
  state.ledger = null;
  state.windows = [];
  state.receipt = null;
  clearResult(root);
  setStatus(root, 'Validating local ledger and rebuilding quarter-aligned Rolling-12 windows…', 'loading');
  syncControls(root);
  try {
    const ledger = await parseCsvHistoryLedger(await file.text());
    const review = await buildHistoricalRolling12OperatingReview(ledger);
    state.ledger = ledger;
    state.windows = review.windows.map((item) => item.windowKey);
    populateSelectors(root, review.windows);
    setStatus(root, `Validated ${review.windowCount} Rolling-12 endpoint(s). Ledger ${ledger.ledgerFingerprint.slice(0, 12)}.`, 'ok');
  } catch (error) {
    populateSelectors(root, []);
    setStatus(root, `Ledger import blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

async function buildReceiptFromUi(root) {
  if (!state.ledger || state.busy) return;
  const previousWindowKey = root.querySelector('[data-cfhr12tr-previous]').value;
  const currentWindowKey = root.querySelector('[data-cfhr12tr-current]').value;
  if (!state.windows.includes(previousWindowKey) || !state.windows.includes(currentWindowKey)) return setStatus(root, 'Select valid previous and current Rolling-12 windows.', 'bad');
  state.busy = true;
  state.receipt = null;
  syncControls(root);
  setStatus(root, 'Recomputing overlap-aware transition and fingerprinting deterministic receipt…', 'loading');
  try {
    state.receipt = await buildHistoricalRolling12WindowTransitionReceipt(state.ledger, previousWindowKey, currentWindowKey);
    renderReceipt(root, state.receipt);
    setStatus(root, `Receipt ${state.receipt.receiptFingerprint.slice(0, 12)} built locally. ${state.receipt.transition.transitionAllowed ? 'Transition gate passed.' : 'Transition blocked; raw evidence preserved with metrics withheld.'}`, 'ok');
  } catch (error) {
    clearResult(root);
    setStatus(root, `Receipt generation blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

function downloadReceipt(root) {
  if (!state.receipt || state.busy) return;
  const blob = new Blob([serializeHistoricalRolling12WindowTransitionReceipt(state.receipt)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `csv-history-rolling-12-window-transition-receipt-v1-${state.receipt.receiptFingerprint.slice(0, 12)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  setStatus(root, `Downloaded deterministic transition receipt ${state.receipt.receiptFingerprint.slice(0, 12)}. No remote persistence occurred.`, 'ok');
}

function populateSelectors(root, windows) {
  const keys = windows.map((item) => typeof item === 'string' ? item : item.windowKey);
  const options = keys.length ? keys.map((key) => `<option value="${esc(key)}">${esc(key)}</option>`).join('') : '<option value="">No Rolling-12 evidence</option>';
  const previous = root.querySelector('[data-cfhr12tr-previous]');
  const current = root.querySelector('[data-cfhr12tr-current]');
  previous.innerHTML = options;
  current.innerHTML = options;
  if (keys.length > 1) current.value = keys[1];
}
function syncControls(root) {
  const ready = Boolean(state.ledger && state.windows.length);
  const previous = root.querySelector('[data-cfhr12tr-previous]');
  const current = root.querySelector('[data-cfhr12tr-current]');
  previous.disabled = state.busy || !ready;
  current.disabled = state.busy || !ready;
  root.querySelector('[data-cfhr12tr-build]').disabled = state.busy || !ready || !state.windows.includes(previous.value) || !state.windows.includes(current.value);
  root.querySelector('[data-cfhr12tr-download]').disabled = state.busy || !state.receipt;
  root.querySelector('[data-cfhr12tr-ledger]').disabled = state.busy;
}
function clearResult(root) { const node = root.querySelector('[data-cfhr12tr-result]'); node.hidden = true; node.innerHTML = ''; }
function renderReceipt(root, receipt) {
  const transition = receipt.transition;
  const result = root.querySelector('[data-cfhr12tr-result]');
  result.innerHTML = `<div class="cfhr12tr-grid">${card('Receipt', `<b>${esc(receipt.receiptFingerprint.slice(0, 12))}</b>`)}${card('Transition', transition.transitionAllowed ? '<b>allowed</b>' : '<b>blocked</b><br>raw evidence only')}${card('Outgoing', `<b>${esc(transition.decomposition.outgoingQuarterKey || '—')}</b>`)}${card('Shared evidence', `<b>${transition.decomposition.sharedQuarterCount}</b> quarters / ${transition.decomposition.overlapMonths} months`)}${card('Incoming', `<b>${esc(transition.decomposition.incomingQuarterKey || '—')}</b>`)}</div><div class="cfhr12tr-guard">${transition.transitionAllowed ? 'Receipt binds the exact previous/current windows plus outgoing, incoming, and all three shared evidence identities.' : `Blockers remain canonical: ${esc(transition.comparabilityGate.blockers.join(', '))}`}</div>`;
  result.hidden = false;
}
function card(label, body) { return `<div class="cfhr12tr-card"><small>${esc(label)}</small>${body}</div>`; }
function setStatus(root, text, tone) { const node = root.querySelector('[data-cfhr12tr-status]'); node.textContent = text; node.dataset.tone = tone; }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function installStyles() {
  if (document.getElementById('cfhr12tr-style')) return;
  const style = document.createElement('style');
  style.id = 'cfhr12tr-style';
  style.textContent = `.cfhr12tr{margin:24px 0;padding:20px;border:1px solid rgba(127,127,127,.24);border-radius:18px;background:rgba(255,255,255,.72)}.cfhr12tr-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.cfhr12tr-head b{font-size:18px}.cfhr12tr-head small{display:block;max-width:820px;margin-top:5px;line-height:1.45}.cfhr12tr-head span,.cfhr12tr-guard,.cfhr12tr-status{font-size:12px}.cfhr12tr-guard,.cfhr12tr-status{margin-top:12px;padding:10px 12px;border-radius:12px;background:rgba(127,127,127,.08)}.cfhr12tr-controls{display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin-top:14px}.cfhr12tr-controls label{display:grid;gap:5px;font-size:12px}.cfhr12tr-controls select,.cfhr12tr-controls input,.cfhr12tr-controls button{min-height:34px}.cfhr12tr-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:14px}.cfhr12tr-card{padding:12px;border:1px solid rgba(127,127,127,.2);border-radius:12px}.cfhr12tr-card small{display:block;margin-bottom:5px}`;
  document.head.append(style);
}
