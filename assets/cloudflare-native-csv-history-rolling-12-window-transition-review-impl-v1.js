import { buildHistoricalRolling12OperatingReview } from './cloudflare-native-csv-history-rolling-12-operating-review-v1.js';

export const CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_REVIEW_SCHEMA_VERSION = 'csv-history-rolling-12-window-transition-review-v1';
export const CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_REVIEW_UI_VERSION = '1.0.0';

const ADDITIVE_METRICS = Object.freeze([
  Object.freeze({ key: 'spendMicros', label: 'Spend', unit: 'micros' }),
  Object.freeze({ key: 'salesMicros', label: 'Sales', unit: 'micros' }),
  Object.freeze({ key: 'orders', label: 'Orders', unit: 'count' }),
  Object.freeze({ key: 'adContributionMicros', label: 'Ad Contribution', unit: 'micros' }),
]);
const RATIO_METRICS = Object.freeze([
  Object.freeze({ key: 'acos', label: 'ACoS', unit: 'ratio' }),
  Object.freeze({ key: 'roas', label: 'ROAS', unit: 'ratio' }),
]);
const ALL_METRIC_KEYS = Object.freeze([...ADDITIVE_METRICS, ...RATIO_METRICS].map((item) => item.key));
const PROFITABILITY_BASIS = 'sales_minus_ad_spend_only_not_net_profit';
const state = { mounted: false, busy: false, ledger: null, review: null };

export async function buildHistoricalRolling12WindowTransitionReview(ledger, previousWindowKey, currentWindowKey, options = {}) {
  const currentLedger = Object.prototype.hasOwnProperty.call(options || {}, 'currentLedger') ? options.currentLedger : ledger;
  const previousReview = await buildHistoricalRolling12OperatingReview(ledger);
  const currentReview = currentLedger === ledger ? previousReview : await buildHistoricalRolling12OperatingReview(currentLedger);
  const previousWindow = selectWindow(previousReview, previousWindowKey, 'PREVIOUS');
  const currentWindow = selectWindow(currentReview, currentWindowKey, 'CURRENT');

  const previousKeys = [...previousWindow.expectedQuarterKeys];
  const currentKeys = [...currentWindow.expectedQuarterKeys];
  const sharedQuarterKeys = previousKeys.filter((key) => currentKeys.includes(key));
  const outgoingQuarterKeys = previousKeys.filter((key) => !currentKeys.includes(key));
  const incomingQuarterKeys = currentKeys.filter((key) => !previousKeys.includes(key));
  const outgoingQuarter = outgoingQuarterKeys.length === 1 ? quarterEvidence(previousWindow, outgoingQuarterKeys[0]) : null;
  const incomingQuarter = incomingQuarterKeys.length === 1 ? quarterEvidence(currentWindow, incomingQuarterKeys[0]) : null;
  const sharedQuarterEvidence = await Promise.all(sharedQuarterKeys.map(async (quarterKey) => {
    const previousQuarter = quarterEvidence(previousWindow, quarterKey);
    const currentQuarter = quarterEvidence(currentWindow, quarterKey);
    const previousFingerprint = previousQuarter ? await canonicalQuarterEvidenceFingerprint(previousQuarter) : null;
    const currentFingerprint = currentQuarter ? await canonicalQuarterEvidenceFingerprint(currentQuarter) : null;
    const previousInputSetFingerprints = sortedStrings(previousQuarter?.sourceInputSetFingerprints || []);
    const currentInputSetFingerprints = sortedStrings(currentQuarter?.sourceInputSetFingerprints || []);
    const previousSourceContentSha256s = quarterSourceContentSha256s(previousQuarter);
    const currentSourceContentSha256s = quarterSourceContentSha256s(currentQuarter);
    return deepFreeze({
      quarter: quarterKey,
      previousCanonicalQuarterFingerprint: previousFingerprint,
      currentCanonicalQuarterFingerprint: currentFingerprint,
      canonicalQuarterFingerprintConsistent: Boolean(previousFingerprint) && previousFingerprint === currentFingerprint,
      sourceInputSetFingerprintsConsistent: arraysEqual(previousInputSetFingerprints, currentInputSetFingerprints),
      sourceContentSha256sConsistent: arraysEqual(previousSourceContentSha256s, currentSourceContentSha256s),
      previousSourceInputSetFingerprints: previousInputSetFingerprints,
      currentSourceInputSetFingerprints: currentInputSetFingerprints,
      previousSourceContentSha256s,
      currentSourceContentSha256s,
      previousRawEvidence: previousQuarter,
      currentRawEvidence: currentQuarter,
      authority: noAuthority(),
    });
  }));

  const outgoingFingerprint = outgoingQuarter ? await canonicalQuarterEvidenceFingerprint(outgoingQuarter) : null;
  const incomingFingerprint = incomingQuarter ? await canonicalQuarterEvidenceFingerprint(incomingQuarter) : null;
  const checks = {
    previousWindowValid: previousWindow.rolling12AggregationAllowed === true && previousWindow.interpretationAllowed === true && previousWindow.rawEvidenceOnly === false,
    currentWindowValid: currentWindow.rolling12AggregationAllowed === true && currentWindow.interpretationAllowed === true && currentWindow.rawEvidenceOnly === false,
    endpointsForwardAdjacentNaturalQuarters: nextQuarterKey(previousWindow.throughQuarter) === currentWindow.throughQuarter,
    previousWindowShapeExact: validRollingWindowShape(previousWindow),
    currentWindowShapeExact: validRollingWindowShape(currentWindow),
    exactlyThreeSharedQuarters: sharedQuarterKeys.length === 3,
    exactlyOneOutgoingQuarter: outgoingQuarterKeys.length === 1 && Boolean(outgoingQuarter),
    exactlyOneIncomingQuarter: incomingQuarterKeys.length === 1 && Boolean(incomingQuarter),
    sharedQuarterSequenceExact: arraysEqual(previousKeys.slice(1), currentKeys.slice(0, 3)) && arraysEqual(previousKeys.slice(1), sharedQuarterKeys),
    marketplaceCompatible: Boolean(previousWindow.marketplace) && previousWindow.marketplace === currentWindow.marketplace,
    currencyCompatible: Boolean(previousWindow.currencyCode) && previousWindow.currencyCode === currentWindow.currencyCode,
    profitabilityBasisCompatible: previousWindow.profitabilityBasis === PROFITABILITY_BASIS && currentWindow.profitabilityBasis === PROFITABILITY_BASIS
      && [...previousWindow.rawQuarterEvidence, ...currentWindow.rawQuarterEvidence].every((item) => item.profitabilityBasis === PROFITABILITY_BASIS),
    sharedQuarterEvidenceIdentityConsistent: sharedQuarterEvidence.length === 3 && sharedQuarterEvidence.every((item) => item.canonicalQuarterFingerprintConsistent),
    sharedQuarterSourceFingerprintsConsistent: sharedQuarterEvidence.length === 3 && sharedQuarterEvidence.every((item) => item.sourceInputSetFingerprintsConsistent),
    sharedQuarterSourceSha256EvidenceConsistent: sharedQuarterEvidence.length === 3 && sharedQuarterEvidence.every((item) => item.sourceContentSha256sConsistent),
    noHiddenRepair: noRepair(previousWindow) && noRepair(currentWindow),
    noOverlapCollapse: previousWindow.overlapCollapseApplied === false && currentWindow.overlapCollapseApplied === false,
    noAutoNormalization: previousWindow.normalizationApplied === false && currentWindow.normalizationApplied === false
      && previousWindow.quarterSelectionAutoReordered === false && currentWindow.quarterSelectionAutoReordered === false,
    metricsComplete: windowMetricsComplete(previousWindow) && windowMetricsComplete(currentWindow)
      && quarterMetricsComplete(outgoingQuarter) && quarterMetricsComplete(incomingQuarter),
    additiveWindowTransitionIdentityValid: additiveWindowTransitionIdentityValid(previousWindow, currentWindow, outgoingQuarter, incomingQuarter),
    ratioWindowTotalsConsistent: ratioWindowTotalsConsistent(previousWindow) && ratioWindowTotalsConsistent(currentWindow),
  };

  const blockers = Object.entries(checks).filter(([, allowed]) => !allowed).map(([key]) => transitionBlocker(key));
  const transitionAllowed = blockers.length === 0;
  const transitionMetrics = transitionAllowed
    ? buildTransitionMetrics(previousWindow, currentWindow, outgoingQuarter, incomingQuarter)
    : withheldTransitionMetrics();

  return deepFreeze({
    schemaVersion: CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_REVIEW_SCHEMA_VERSION,
    previousLedgerFingerprint: previousReview.ledgerFingerprint,
    currentLedgerFingerprint: currentReview.ledgerFingerprint,
    sameLedgerFingerprint: previousReview.ledgerFingerprint === currentReview.ledgerFingerprint,
    transitionAllowed,
    interpretationAllowed: transitionAllowed,
    rawEvidenceOnly: !transitionAllowed,
    transitionSemantics: 'overlap_aware_one_quarter_out_one_quarter_in_three_quarters_shared',
    additiveDeltaBasis: 'incoming_quarter_minus_outgoing_quarter_equivalent_to_current_r12_minus_previous_r12',
    ratioDeltaBasis: 'current_full_rolling_12_ratio_minus_previous_full_rolling_12_ratio_recomputed_from_full_window_totals',
    selectionPolicy: 'operator_selected_forward_adjacent_quarter_aligned_rolling_12_windows_no_auto_reorder_or_repair',
    previousWindow: projectWindow(previousWindow),
    currentWindow: projectWindow(currentWindow),
    decomposition: {
      outgoingQuarterKey: outgoingQuarterKeys.length === 1 ? outgoingQuarterKeys[0] : null,
      incomingQuarterKey: incomingQuarterKeys.length === 1 ? incomingQuarterKeys[0] : null,
      sharedQuarterKeys,
      outgoingQuarter: projectQuarterWithFingerprint(outgoingQuarter, outgoingFingerprint),
      incomingQuarter: projectQuarterWithFingerprint(incomingQuarter, incomingFingerprint),
      sharedQuarterEvidence,
      sharedQuarterCount: sharedQuarterKeys.length,
      overlapMonths: sharedQuarterKeys.length * 3,
      overlapCollapsed: false,
    },
    comparabilityGate: {
      checks,
      blockers,
      previousAndCurrentWindowsMustBeAllowed: true,
      forwardAdjacentEndpointsRequired: true,
      exactlyThreeSharedQuartersRequired: true,
      sharedEvidenceIdentityMustMatch: true,
      sameQuarterKeyDoesNotImplySameEvidence: true,
      blockedWindowCannotBeUpgraded: true,
    },
    transitionMetrics,
    rawPreviousWindowEvidence: projectWindow(previousWindow),
    rawCurrentWindowEvidence: projectWindow(currentWindow),
    rawEvidenceRetainedWhenBlocked: true,
    crossWindowAggregationApplied: false,
    crossWindowNormalizationApplied: false,
    overlapCollapseApplied: false,
    sharedEvidenceAutoReconciled: false,
    gapRepairApplied: false,
    windowSelectionAutoReordered: false,
    recommendationGenerated: false,
    actionGenerated: false,
    profitabilityBasis: PROFITABILITY_BASIS,
    authority: noAuthority(),
  });
}

function buildTransitionMetrics(previousWindow, currentWindow, outgoingQuarter, incomingQuarter) {
  const additive = {};
  for (const metric of ADDITIVE_METRICS) {
    const previousRolling12Value = previousWindow.metrics[metric.key];
    const currentRolling12Value = currentWindow.metrics[metric.key];
    const outgoingQuarterValue = outgoingQuarter.metrics[metric.key];
    const incomingQuarterValue = incomingQuarter.metrics[metric.key];
    additive[metric.key] = {
      label: metric.label,
      unit: metric.unit,
      previousRolling12Value,
      currentRolling12Value,
      outgoingQuarterValue,
      incomingQuarterValue,
      rolling12Delta: incomingQuarterValue - outgoingQuarterValue,
      fullWindowDelta: currentRolling12Value - previousRolling12Value,
      identity: 'current_r12_minus_previous_r12_equals_incoming_quarter_minus_outgoing_quarter',
      interpretationAllowed: true,
    };
  }
  const previousAcos = previousWindow.metrics.spendMicros / previousWindow.metrics.salesMicros;
  const currentAcos = currentWindow.metrics.spendMicros / currentWindow.metrics.salesMicros;
  const previousRoas = previousWindow.metrics.salesMicros / previousWindow.metrics.spendMicros;
  const currentRoas = currentWindow.metrics.salesMicros / currentWindow.metrics.spendMicros;
  return {
    additive,
    ratios: {
      acos: {
        label: 'ACoS', unit: 'ratio', previousRolling12Value: previousAcos, currentRolling12Value: currentAcos,
        rolling12Delta: currentAcos - previousAcos,
        deltaBasis: 'current_full_r12_spend_over_sales_minus_previous_full_r12_spend_over_sales',
        incomingOutgoingQuarterRatioDeltaUsed: false,
        interpretationAllowed: true,
      },
      roas: {
        label: 'ROAS', unit: 'ratio', previousRolling12Value: previousRoas, currentRolling12Value: currentRoas,
        rolling12Delta: currentRoas - previousRoas,
        deltaBasis: 'current_full_r12_sales_over_spend_minus_previous_full_r12_sales_over_spend',
        incomingOutgoingQuarterRatioDeltaUsed: false,
        interpretationAllowed: true,
      },
    },
  };
}

function withheldTransitionMetrics() {
  const additive = {};
  for (const metric of ADDITIVE_METRICS) additive[metric.key] = {
    label: metric.label, unit: metric.unit, previousRolling12Value: null, currentRolling12Value: null,
    outgoingQuarterValue: null, incomingQuarterValue: null, rolling12Delta: null, fullWindowDelta: null,
    identity: 'withheld_not_comparable', interpretationAllowed: false,
  };
  const ratios = {};
  for (const metric of RATIO_METRICS) ratios[metric.key] = {
    label: metric.label, unit: metric.unit, previousRolling12Value: null, currentRolling12Value: null,
    rolling12Delta: null, deltaBasis: 'withheld_not_comparable', incomingOutgoingQuarterRatioDeltaUsed: false,
    interpretationAllowed: false,
  };
  return { additive, ratios };
}

function additiveWindowTransitionIdentityValid(previousWindow, currentWindow, outgoingQuarter, incomingQuarter) {
  if (!outgoingQuarter || !incomingQuarter) return false;
  return ADDITIVE_METRICS.every((metric) => {
    const previousValue = previousWindow.metrics?.[metric.key];
    const currentValue = currentWindow.metrics?.[metric.key];
    const outgoingValue = outgoingQuarter.metrics?.[metric.key];
    const incomingValue = incomingQuarter.metrics?.[metric.key];
    return [previousValue, currentValue, outgoingValue, incomingValue].every(Number.isSafeInteger)
      && currentValue === previousValue - outgoingValue + incomingValue
      && currentValue - previousValue === incomingValue - outgoingValue;
  });
}

function ratioWindowTotalsConsistent(window) {
  const { spendMicros, salesMicros, acos, roas } = window.metrics || {};
  if (![spendMicros, salesMicros].every(Number.isSafeInteger) || salesMicros === 0 || spendMicros === 0) return false;
  return finiteMetric(acos) && finiteMetric(roas) && acos === spendMicros / salesMicros && roas === salesMicros / spendMicros;
}

function validRollingWindowShape(window) {
  return /^\d{4}-Q[1-4]-R12$/.test(String(window.windowKey || ''))
    && /^\d{4}-Q[1-4]$/.test(String(window.throughQuarter || ''))
    && window.windowKey === `${window.throughQuarter}-R12`
    && Array.isArray(window.expectedQuarterKeys) && window.expectedQuarterKeys.length === 4
    && window.windowLengthMonths === 12 && window.windowLengthQuarters === 4;
}

function noRepair(window) {
  return window.normalizationApplied === false
    && window.sameMonthAggregationApplied === false
    && window.businessRowDeduplicationApplied === false
    && window.overlapCollapseApplied === false
    && window.gapRepairApplied === false
    && window.quarterSelectionAutoReordered === false
    && window.crossWindowAggregationApplied === false;
}

function windowMetricsComplete(window) { return ALL_METRIC_KEYS.every((key) => finiteMetric(window.metrics?.[key])); }
function quarterMetricsComplete(quarter) { return Boolean(quarter) && ALL_METRIC_KEYS.every((key) => finiteMetric(quarter.metrics?.[key])); }

async function canonicalQuarterEvidenceFingerprint(quarter) {
  const payload = {
    schemaVersion: 'csv-history-rolling-12-quarter-evidence-fingerprint-v1',
    quarter: quarter.quarter,
    quarterStartDate: quarter.quarterStartDate,
    quarterEndDate: quarter.quarterEndDate,
    marketplace: quarter.marketplace,
    currencyCode: quarter.currencyCode,
    profitabilityBasis: quarter.profitabilityBasis,
    quarterAggregationAllowed: quarter.quarterAggregationAllowed === true,
    sourceInputSetFingerprints: sortedStrings(quarter.sourceInputSetFingerprints || []),
    sourceContentSha256s: quarterSourceContentSha256s(quarter),
    monthlyEvidenceIdentity: (quarter.rawMonthlyEvidence || []).map((item) => ({
      month: item.month || null,
      sourceInputSetFingerprint: item.evidenceKey?.sourceInputSetFingerprint || null,
      contentSha256s: sortedStrings(item.contentSha256s || []),
    })).sort((a, b) => String(a.month).localeCompare(String(b.month)) || String(a.sourceInputSetFingerprint).localeCompare(String(b.sourceInputSetFingerprint))),
    additiveMetrics: {
      spendMicros: safeIntegerOrNull(quarter.metrics?.spendMicros),
      salesMicros: safeIntegerOrNull(quarter.metrics?.salesMicros),
      orders: safeIntegerOrNull(quarter.metrics?.orders),
      adContributionMicros: safeIntegerOrNull(quarter.metrics?.adContributionMicros),
    },
  };
  return sha256Hex(JSON.stringify(payload));
}

async function sha256Hex(text) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw transitionError('CSV_HISTORY_R12_TRANSITION_CRYPTO_UNAVAILABLE');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function quarterSourceContentSha256s(quarter) {
  return sortedStrings((quarter?.rawMonthlyEvidence || []).flatMap((item) => item.contentSha256s || []));
}
function quarterEvidence(window, quarterKey) {
  const matches = (window.rawQuarterEvidence || []).filter((item) => item.quarter === quarterKey);
  return matches.length === 1 ? matches[0] : null;
}
function projectQuarterWithFingerprint(quarter, fingerprint) {
  if (!quarter) return null;
  return { ...quarter, canonicalQuarterFingerprint: fingerprint, authority: noAuthority() };
}
function projectWindow(window) { return { ...window, authority: noAuthority() }; }
function sortedStrings(values) { return [...values].map(String).sort(); }
function arraysEqual(left, right) { return left.length === right.length && left.every((value, index) => value === right[index]); }
function safeIntegerOrNull(value) { return Number.isSafeInteger(value) ? value : null; }
function finiteMetric(value) { return typeof value === 'number' && Number.isFinite(value); }
function nextQuarterKey(quarterKey) {
  const match = /^(\d{4})-Q([1-4])$/.exec(String(quarterKey || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const quarter = Number(match[2]);
  return quarter === 4 ? `${year + 1}-Q1` : `${year}-Q${quarter + 1}`;
}
function selectWindow(review, windowKey, role) {
  if (!/^\d{4}-Q[1-4]-R12$/.test(String(windowKey || ''))) throw transitionError(`CSV_HISTORY_R12_TRANSITION_${role}_WINDOW_KEY_INVALID`);
  const matches = review.windows.filter((item) => item.windowKey === windowKey);
  if (matches.length !== 1) throw transitionError(`CSV_HISTORY_R12_TRANSITION_${role}_WINDOW_SELECTION_NOT_EXACT`);
  return matches[0];
}
function transitionBlocker(key) {
  return ({
    previousWindowValid: 'previous_rolling_12_window_blocked',
    currentWindowValid: 'current_rolling_12_window_blocked',
    endpointsForwardAdjacentNaturalQuarters: 'rolling_12_endpoints_not_forward_adjacent_natural_quarters',
    previousWindowShapeExact: 'previous_rolling_12_window_shape_invalid',
    currentWindowShapeExact: 'current_rolling_12_window_shape_invalid',
    exactlyThreeSharedQuarters: 'shared_quarter_count_not_three',
    exactlyOneOutgoingQuarter: 'outgoing_quarter_count_not_one',
    exactlyOneIncomingQuarter: 'incoming_quarter_count_not_one',
    sharedQuarterSequenceExact: 'shared_quarter_sequence_invalid',
    marketplaceCompatible: 'marketplace_mismatch_or_unknown',
    currencyCompatible: 'currency_mismatch_or_unknown',
    profitabilityBasisCompatible: 'profitability_basis_incompatible',
    sharedQuarterEvidenceIdentityConsistent: 'shared_quarter_evidence_identity_mismatch',
    sharedQuarterSourceFingerprintsConsistent: 'shared_quarter_source_input_set_fingerprint_mismatch',
    sharedQuarterSourceSha256EvidenceConsistent: 'shared_quarter_source_sha256_mismatch',
    noHiddenRepair: 'hidden_repair_or_cross_window_aggregation_detected',
    noOverlapCollapse: 'overlap_collapse_detected',
    noAutoNormalization: 'auto_normalization_or_reorder_detected',
    metricsComplete: 'transition_metric_values_incomplete',
    additiveWindowTransitionIdentityValid: 'additive_window_transition_identity_failed',
    ratioWindowTotalsConsistent: 'rolling_12_ratio_totals_inconsistent',
  })[key] || `rolling12_transition_gate_failed:${key}`;
}
function noAuthority() {
  return { authoritative: false, canonicalAmazonIdentityResolved: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false };
}
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
function transitionError(code) {
  const error = new Error(code);
  error.name = 'CsvHistoryRolling12WindowTransitionReviewError';
  error.code = code;
  return error;
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvHistoryRolling12WindowTransitionReview', {
    value: Object.freeze({
      version: CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_REVIEW_UI_VERSION,
      schemaVersion: CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_REVIEW_SCHEMA_VERSION,
      authority: 'local_historical_overlap_aware_rolling_12_window_transition_review_only',
      buildHistoricalRolling12WindowTransitionReview,
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
  const host = document.querySelector('[data-csv-history-rolling-12-operating-review]');
  if (!host) {
    new MutationObserver((_, observer) => {
      if (!document.querySelector('[data-csv-history-rolling-12-operating-review]')) return;
      observer.disconnect();
      mount();
    }).observe(document.documentElement, { childList: true, subtree: true });
    return;
  }
  if (document.querySelector('[data-csv-history-rolling-12-window-transition-review]')) return void (state.mounted = true);
  installStyles();
  const root = document.createElement('section');
  root.className = 'cfhr12t';
  root.dataset.csvHistoryRolling12WindowTransitionReview = CSV_HISTORY_ROLLING_12_WINDOW_TRANSITION_REVIEW_UI_VERSION;
  root.innerHTML = `
    <div class="cfhr12t-head"><div><b>Rolling-12 Window Transition Review</b><small>Overlap-aware transition semantics: one quarter exits, three quarters remain shared, and one quarter enters. This is not an independent-period comparison.</small></div><span>3 shared · 1 out · 1 in · fail closed</span></div>
    <div class="cfhr12t-guard">Additive ΔR12 = incoming quarter − outgoing quarter. ACoS and ROAS transition deltas are recomputed from the two complete Rolling-12 totals, never from incoming/outgoing quarter ratio deltas. Same quarter key does not imply same evidence.</div>
    <div class="cfhr12t-controls"><label>History ledger <input type="file" accept="application/json,.json" data-cfhr12t-ledger></label><label>Previous R12 <select data-cfhr12t-previous disabled></select></label><label>Current R12 <select data-cfhr12t-current disabled></select></label><button type="button" data-cfhr12t-review disabled>Review transition</button></div>
    <div class="cfhr12t-status" data-cfhr12t-status>Explicit local-file ownership only. No repair, overlap collapse, hidden persistence, recommendation, or execution.</div>
    <div class="cfhr12t-result" data-cfhr12t-result hidden></div>`;
  host.insertAdjacentElement('afterend', root);
  root.querySelector('[data-cfhr12t-ledger]').addEventListener('change', (event) => void loadLedger(root, event.currentTarget));
  root.querySelector('[data-cfhr12t-previous]').addEventListener('change', () => syncControls(root));
  root.querySelector('[data-cfhr12t-current]').addEventListener('change', () => syncControls(root));
  root.querySelector('[data-cfhr12t-review]').addEventListener('click', () => void reviewFromUi(root));
  state.mounted = true;
}

async function loadLedger(root, input) {
  const file = input.files?.[0];
  state.ledger = null;
  state.review = null;
  clearResult(root);
  resetSelects(root);
  if (!file) return syncControls(root);
  state.busy = true;
  syncControls(root);
  setStatus(root, 'Rebuilding quarter-aligned Rolling-12 evidence…', 'loading');
  try {
    const parsed = JSON.parse(await file.text());
    state.ledger = parsed;
    state.review = await buildHistoricalRolling12OperatingReview(parsed);
    fillSelects(root, state.review.windows);
    setStatus(root, `Rolling-12 evidence rebuilt from ledger ${state.review.ledgerFingerprint.slice(0, 12)}. Select two forward-adjacent endpoints.`, 'ok');
  } catch (error) {
    state.ledger = null;
    state.review = null;
    setStatus(root, `Ledger blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

async function reviewFromUi(root) {
  const previousKey = root.querySelector('[data-cfhr12t-previous]').value;
  const currentKey = root.querySelector('[data-cfhr12t-current]').value;
  if (!state.ledger || !previousKey || !currentKey || state.busy) return;
  state.busy = true;
  clearResult(root);
  syncControls(root);
  setStatus(root, 'Replaying overlap-aware transition gate…', 'loading');
  try {
    const review = await buildHistoricalRolling12WindowTransitionReview(state.ledger, previousKey, currentKey);
    renderReview(root, review);
    setStatus(root, review.transitionAllowed
      ? `${previousKey} → ${currentKey} transition allowed. Shared evidence identity is consistent.`
      : `${previousKey} → ${currentKey} transition blocked. Raw evidence retained; transition metrics withheld.`, review.transitionAllowed ? 'ok' : 'bad');
  } catch (error) {
    setStatus(root, `Transition blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

function fillSelects(root, windows) {
  const options = ['<option value="">Select R12 window</option>', ...windows.map((item) => `<option value="${esc(item.windowKey)}">${esc(item.windowKey)} · ${item.rolling12AggregationAllowed ? 'allowed' : 'blocked/raw-only'}</option>`)].join('');
  for (const selector of ['[data-cfhr12t-previous]', '[data-cfhr12t-current]']) {
    const node = root.querySelector(selector);
    node.innerHTML = options;
    node.disabled = false;
  }
}
function resetSelects(root) {
  for (const selector of ['[data-cfhr12t-previous]', '[data-cfhr12t-current]']) {
    const node = root.querySelector(selector);
    node.innerHTML = '<option value="">Select R12 window</option>';
    node.disabled = true;
  }
}
function syncControls(root) {
  const previous = root.querySelector('[data-cfhr12t-previous]');
  const current = root.querySelector('[data-cfhr12t-current]');
  root.querySelector('[data-cfhr12t-review]').disabled = state.busy || !state.ledger || !previous.value || !current.value;
}
function clearResult(root) { const node = root.querySelector('[data-cfhr12t-result]'); node.hidden = true; node.innerHTML = ''; }
function renderReview(root, review) {
  const result = root.querySelector('[data-cfhr12t-result]');
  const additiveRows = ADDITIVE_METRICS.map((metric) => {
    const item = review.transitionMetrics.additive[metric.key];
    return `<tr><td>${esc(item.label)}</td><td>${formatMetric(item.previousRolling12Value, item.unit)}</td><td>${formatMetric(item.outgoingQuarterValue, item.unit)}</td><td>${formatMetric(item.incomingQuarterValue, item.unit)}</td><td>${formatMetric(item.currentRolling12Value, item.unit)}</td><td>${formatMetric(item.rolling12Delta, item.unit)}</td></tr>`;
  }).join('');
  const ratioRows = RATIO_METRICS.map((metric) => {
    const item = review.transitionMetrics.ratios[metric.key];
    return `<tr><td>${esc(item.label)}</td><td>${formatMetric(item.previousRolling12Value, item.unit)}</td><td>${formatMetric(item.currentRolling12Value, item.unit)}</td><td>${formatMetric(item.rolling12Delta, item.unit)}</td></tr>`;
  }).join('');
  result.innerHTML = `
    <div class="cfhr12t-grid">${card('Transition', review.transitionAllowed ? '<b>allowed</b>' : '<b>blocked</b><br>raw evidence only')}${card('Outgoing', `<b>${esc(review.decomposition.outgoingQuarterKey || '—')}</b>`)}${card('Shared', `<b>${review.decomposition.sharedQuarterCount}</b> quarters / ${review.decomposition.overlapMonths} months`)}${card('Incoming', `<b>${esc(review.decomposition.incomingQuarterKey || '—')}</b>`)}</div>
    <div class="cfhr12t-table"><table><thead><tr><th>Additive metric</th><th>Previous R12</th><th>Outgoing</th><th>Incoming</th><th>Current R12</th><th>ΔR12</th></tr></thead><tbody>${additiveRows}</tbody></table></div>
    <div class="cfhr12t-table"><table><thead><tr><th>Ratio</th><th>Previous R12</th><th>Current R12</th><th>Δ</th></tr></thead><tbody>${ratioRows}</tbody></table></div>
    <div class="cfhr12t-guard">${review.transitionAllowed ? 'All gates passed. The three shared quarters have matching canonical fingerprints, input-set fingerprints, and source SHA-256 evidence.' : `Blockers: ${esc(review.comparabilityGate.blockers.join(', ') || 'unknown')}`}</div>`;
  result.hidden = false;
}
function card(label, body) { return `<div class="cfhr12t-card"><small>${esc(label)}</small>${body}</div>`; }
function formatMetric(value, unit) {
  if (value == null || !Number.isFinite(value)) return 'withheld';
  if (unit === 'ratio') return Number(value).toFixed(4);
  if (unit === 'micros') return (Number(value) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return Number(value).toLocaleString();
}
function setStatus(root, text, tone) { const node = root.querySelector('[data-cfhr12t-status]'); node.textContent = text; node.dataset.tone = tone; }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function installStyles() {
  if (document.getElementById('cfhr12t-style')) return;
  const style = document.createElement('style');
  style.id = 'cfhr12t-style';
  style.textContent = `.cfhr12t{margin:24px 0;padding:20px;border:1px solid rgba(127,127,127,.24);border-radius:18px;background:rgba(255,255,255,.72)}.cfhr12t-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.cfhr12t-head b{font-size:18px}.cfhr12t-head small{display:block;max-width:820px;margin-top:5px;line-height:1.45}.cfhr12t-head span,.cfhr12t-guard,.cfhr12t-status{font-size:12px}.cfhr12t-guard,.cfhr12t-status{margin-top:12px;padding:10px 12px;border-radius:12px;background:rgba(127,127,127,.08)}.cfhr12t-controls{display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin-top:14px}.cfhr12t-controls label{display:grid;gap:5px;font-size:12px}.cfhr12t-controls select,.cfhr12t-controls input,.cfhr12t-controls button{min-height:34px}.cfhr12t-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:14px}.cfhr12t-card{padding:12px;border:1px solid rgba(127,127,127,.2);border-radius:12px}.cfhr12t-card small{display:block;margin-bottom:5px}.cfhr12t-table{overflow:auto;margin-top:12px}.cfhr12t-table table{width:100%;border-collapse:collapse;font-size:12px}.cfhr12t-table th,.cfhr12t-table td{text-align:left;padding:8px;border-bottom:1px solid rgba(127,127,127,.15);white-space:nowrap}`;
  document.head.append(style);
}
