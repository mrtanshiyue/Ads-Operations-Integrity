import { buildHistoricalYearOverYearYtdComparison } from './cloudflare-native-csv-history-year-over-year-ytd-comparison-v1.js';

export const CSV_HISTORY_YEAR_OVER_YEAR_YTD_REVIEW_BOARD_SCHEMA_VERSION = 'csv-history-year-over-year-ytd-review-board-v1';
export const CSV_HISTORY_YEAR_OVER_YEAR_YTD_REVIEW_BOARD_UI_VERSION = '1.0.0';

const METRIC_ORDER = Object.freeze(['spendMicros', 'salesMicros', 'orders', 'acos', 'roas', 'adContributionMicros']);
const state = { mounted: false, busy: false, ledger: null, periods: [] };

export async function buildHistoricalYearOverYearYtdReviewBoard(ledger, periodAKey, periodBKey) {
  const comparison = await buildHistoricalYearOverYearYtdComparison(ledger, periodAKey, periodBKey);
  const allowed = comparison.comparisonAllowed === true;
  const metrics = METRIC_ORDER.map((key) => {
    const metric = comparison.metrics[key];
    if (!metric) throw boardError('CSV_HISTORY_YOY_YTD_REVIEW_BOARD_METRIC_MISSING');
    return deepFreeze({
      key,
      label: metric.label,
      unit: metric.unit,
      periodAValue: metric.periodAValue,
      periodBValue: metric.periodBValue,
      delta: allowed ? metric.delta : null,
      movementDirection: allowed ? metric.direction : 'withheld_not_comparable',
      interpretationAllowed: allowed,
      outcomeQualityClassification: 'not_assigned',
      recommendationGenerated: false,
    });
  });

  return deepFreeze({
    schemaVersion: CSV_HISTORY_YEAR_OVER_YEAR_YTD_REVIEW_BOARD_SCHEMA_VERSION,
    ledgerFingerprint: comparison.ledgerFingerprint,
    operatorState: allowed ? 'comparable_review_only' : 'blocked_raw_evidence_only',
    comparisonAllowed: allowed,
    interpretationAllowed: allowed,
    rawEvidenceOnly: !allowed,
    boardPurpose: 'read_only_projection_of_explicit_yoy_ytd_comparison',
    selectionPolicy: comparison.selectionPolicy,
    deltaBasis: comparison.deltaBasis,
    selection: {
      periodAKey: comparison.periodA.periodKey,
      periodBKey: comparison.periodB.periodKey,
      selectionAutoReordered: false,
    },
    gate: {
      checks: comparison.comparabilityGate.checks,
      reasons: comparison.comparabilityGate.reasons,
      forwardAdjacentYearsRequired: true,
      sameThroughQuarterRequired: true,
      blockedComparisonCannotBeUpgraded: true,
    },
    evidence: {
      periodA: projectEvidence(comparison.periodA),
      periodB: projectEvidence(comparison.periodB),
      rawEvidenceRetained: true,
    },
    metrics,
    recommendationGenerated: false,
    actionGenerated: false,
    outcomeQualityClassificationApplied: false,
    crossYearAggregationApplied: false,
    crossYearNormalizationApplied: false,
    ytdPeriodReaggregationApplied: false,
    sameMonthAggregationApplied: false,
    businessRowDeduplicationApplied: false,
    overlapCollapseApplied: false,
    gapRepairApplied: false,
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    authority: noAuthority(),
  });
}

function projectEvidence(period) {
  return {
    periodKey: period.periodKey,
    year: period.year,
    throughQuarter: period.throughQuarter,
    periodStartDate: period.periodStartDate,
    periodEndDate: period.periodEndDate,
    ytdAggregationAllowed: period.ytdAggregationAllowed,
    interpretationAllowed: period.interpretationAllowed,
    rawEvidenceOnly: period.rawEvidenceOnly,
    marketplace: period.marketplace,
    currencyCode: period.currencyCode,
    sourceQuarterCount: period.sourceQuarterCount,
    sourceInputSetFingerprintCount: period.sourceInputSetFingerprints?.length || 0,
    sourceContentSha256Count: period.sourceContentSha256s?.length || 0,
    expectedQuarterKeys: period.expectedQuarterKeys,
    observedQuarterKeys: period.observedQuarterKeys,
    missingQuarterKeys: period.missingQuarterKeys,
    blockers: period.blockers,
    rawQuarterEvidence: period.rawQuarterEvidence,
    profitabilityBasis: period.profitabilityBasis,
    authority: noAuthority(),
  };
}

function noAuthority() {
  return {
    authoritative: false,
    canonicalAmazonIdentityResolved: false,
    governancePersistenceAllowed: false,
    executionAuthorized: false,
    amazonMutationAuthorized: false,
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function boardError(code) {
  const error = new Error(code);
  error.name = 'CsvHistoryYearOverYearYtdReviewBoardError';
  error.code = code;
  return error;
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvHistoryYearOverYearYtdReviewBoard', {
    value: Object.freeze({
      version: CSV_HISTORY_YEAR_OVER_YEAR_YTD_REVIEW_BOARD_UI_VERSION,
      schemaVersion: CSV_HISTORY_YEAR_OVER_YEAR_YTD_REVIEW_BOARD_SCHEMA_VERSION,
      authority: 'local_historical_yoy_ytd_read_only_review_board',
      buildHistoricalYearOverYearYtdReviewBoard,
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
  const host = document.querySelector('[data-csv-history-year-over-year-ytd-comparison]');
  if (!host) {
    new MutationObserver((_, observer) => {
      if (!document.querySelector('[data-csv-history-year-over-year-ytd-comparison]')) return;
      observer.disconnect();
      mount();
    }).observe(document.documentElement, { childList: true, subtree: true });
    return;
  }
  if (document.querySelector('[data-csv-history-year-over-year-ytd-review-board]')) return void (state.mounted = true);

  installStyles();
  const root = document.createElement('section');
  root.className = 'cfhyoyb';
  root.dataset.csvHistoryYearOverYearYtdReviewBoard = CSV_HISTORY_YEAR_OVER_YEAR_YTD_REVIEW_BOARD_UI_VERSION;
  root.innerHTML = `
    <div class="cfhyoyb-head"><div><b>YoY YTD Review Board</b><small>Read-only projection of one explicit YoY YTD comparison. It reports movement direction and evidence state only; it does not classify business outcomes, recommend actions, or authorize execution.</small></div><span>explicit selection · no recommendation</span></div>
    <div class="cfhyoyb-guard">Period B must remain the next natural year with the same YTD quarter endpoint. Blocked comparisons remain raw-evidence-only and all deltas stay withheld. Ad Contribution = Sales - Ad Spend only; it is not Net Profit.</div>
    <div class="cfhyoyb-controls">
      <label>History ledger <input type="file" accept="application/json,.json" data-cfhyoyb-ledger></label>
      <label>Period A <select data-cfhyoyb-a disabled><option value="">Import ledger first</option></select></label>
      <label>Period B <select data-cfhyoyb-b disabled><option value="">Import ledger first</option></select></label>
      <button type="button" data-cfhyoyb-build disabled>Build review board</button>
    </div>
    <div class="cfhyoyb-status" data-cfhyoyb-status>Explicit local-file ownership only. Nothing is silently persisted.</div>
    <div class="cfhyoyb-result" data-cfhyoyb-result hidden></div>`;
  host.insertAdjacentElement('afterend', root);

  root.querySelector('[data-cfhyoyb-ledger]').addEventListener('change', (event) => void importLedger(root, event.currentTarget));
  root.querySelector('[data-cfhyoyb-a]').addEventListener('change', () => syncControls(root));
  root.querySelector('[data-cfhyoyb-b]').addEventListener('change', () => syncControls(root));
  root.querySelector('[data-cfhyoyb-build]').addEventListener('click', () => void buildBoardFromUi(root));
  state.mounted = true;
}

async function importLedger(root, input) {
  const file = input.files?.[0];
  state.ledger = null;
  state.periods = [];
  clearResult(root);
  if (!file || state.busy) return;
  state.busy = true;
  syncControls(root);
  setStatus(root, 'Reading explicit local ledger and discovering YTD period keys…', 'loading');
  try {
    const parsed = JSON.parse(await file.text());
    const ytdApi = window.CloudflareCsvHistoryYearToDateOperatingReview;
    if (typeof ytdApi?.buildHistoricalYearToDateOperatingReview !== 'function') throw boardError('CSV_HISTORY_YOY_YTD_REVIEW_BOARD_YTD_API_UNAVAILABLE');
    const review = await ytdApi.buildHistoricalYearToDateOperatingReview(parsed);
    state.ledger = parsed;
    state.periods = review.periods.map((item) => item.periodKey);
    fillSelects(root, state.periods);
    setStatus(root, `Loaded ${state.periods.length} quarter-aligned YTD period(s) from ledger ${review.ledgerFingerprint.slice(0, 12)}.`, 'ok');
  } catch (error) {
    fillSelects(root, []);
    setStatus(root, `Ledger blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

async function buildBoardFromUi(root) {
  const a = root.querySelector('[data-cfhyoyb-a]').value;
  const b = root.querySelector('[data-cfhyoyb-b]').value;
  if (!state.ledger || !a || !b || state.busy) return;
  state.busy = true;
  clearResult(root);
  syncControls(root);
  setStatus(root, 'Replaying canonical YoY YTD comparison into read-only board…', 'loading');
  try {
    const board = await buildHistoricalYearOverYearYtdReviewBoard(state.ledger, a, b);
    renderBoard(root, board);
    setStatus(root, board.comparisonAllowed ? 'Comparable review only. Movement is shown without outcome-quality judgment.' : `Blocked/raw evidence only: ${board.gate.reasons.join(', ')}`, board.comparisonAllowed ? 'ok' : 'bad');
  } catch (error) {
    setStatus(root, `Review board blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

function fillSelects(root, periods) {
  const html = periods.length ? ['<option value="">Select YTD period</option>', ...periods.map((key) => `<option value="${esc(key)}">${esc(key)}</option>`)].join('') : '<option value="">No YTD periods</option>';
  root.querySelector('[data-cfhyoyb-a]').innerHTML = html;
  root.querySelector('[data-cfhyoyb-b]').innerHTML = html;
}

function renderBoard(root, board) {
  const rows = board.metrics.map((item) => `<tr><td>${esc(item.label)}</td><td>${format(item.periodAValue)}</td><td>${format(item.periodBValue)}</td><td>${format(item.delta)}</td><td>${esc(item.movementDirection)}</td><td>not assigned</td></tr>`).join('');
  const result = root.querySelector('[data-cfhyoyb-result]');
  result.innerHTML = `
    <div class="cfhyoyb-grid">
      ${card('Operator state', `<b>${esc(board.operatorState)}</b>`)}
      ${card('Period A', `<b>${esc(board.selection.periodAKey)}</b>`)}
      ${card('Period B', `<b>${esc(board.selection.periodBKey)}</b>`)}
      ${card('Gate', board.comparisonAllowed ? '<b>allowed</b>' : '<b>blocked</b>')}
      ${card('Recommendation', '<b>none generated</b>')}
      ${card('Authority', '<b>none</b>')}
    </div>
    <div class="cfhyoyb-table"><table><thead><tr><th>Metric</th><th>A</th><th>B</th><th>Δ B-A</th><th>Movement</th><th>Outcome quality</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="cfhyoyb-evidence"><b>Evidence:</b> A ${board.evidence.periodA.sourceQuarterCount} quarter(s) / ${board.evidence.periodA.sourceContentSha256Count} source hash(es) · B ${board.evidence.periodB.sourceQuarterCount} quarter(s) / ${board.evidence.periodB.sourceContentSha256Count} source hash(es). Raw quarter/month evidence remains attached to the model.</div>`;
  result.hidden = false;
}

function syncControls(root) {
  const a = root.querySelector('[data-cfhyoyb-a]');
  const b = root.querySelector('[data-cfhyoyb-b]');
  root.querySelector('[data-cfhyoyb-ledger]').disabled = state.busy;
  a.disabled = state.busy || !state.ledger;
  b.disabled = state.busy || !state.ledger;
  root.querySelector('[data-cfhyoyb-build]').disabled = state.busy || !state.ledger || !a.value || !b.value;
}

function clearResult(root) { root.querySelector('[data-cfhyoyb-result]').hidden = true; }
function setStatus(root, text, kind = '') { const node = root.querySelector('[data-cfhyoyb-status]'); node.textContent = text; node.dataset.kind = kind; }
function card(label, value) { return `<div class="cfhyoyb-card"><small>${esc(label)}</small><div>${value}</div></div>`; }
function format(value) { return value == null || !Number.isFinite(Number(value)) ? 'withheld' : Number.isInteger(value) ? String(value) : Number(value).toPrecision(8).replace(/0+$/, '').replace(/\.$/, ''); }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }

function installStyles() {
  if (document.getElementById('cfhyoyb-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfhyoyb-style-v1';
  style.textContent = '.cfhyoyb{margin-top:12px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#fff}.cfhyoyb-head{display:flex;justify-content:space-between;gap:12px}.cfhyoyb-head small{display:block;color:#64748b;max-width:820px}.cfhyoyb-head>span{font-size:11px;font-weight:800}.cfhyoyb-guard,.cfhyoyb-status,.cfhyoyb-evidence{margin-top:8px;padding:8px;border-radius:7px;background:#f8fafc;color:#475569}.cfhyoyb-status[data-kind="bad"]{color:#b91c1c}.cfhyoyb-status[data-kind="ok"]{color:#047857}.cfhyoyb-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-top:9px}.cfhyoyb-controls label{display:grid;gap:4px;font-size:12px;font-weight:700}.cfhyoyb-controls input,.cfhyoyb-controls select,.cfhyoyb-controls button{border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;background:#fff;font:inherit}.cfhyoyb-controls button{font-weight:700;cursor:pointer}.cfhyoyb-controls button:disabled{opacity:.45;cursor:not-allowed}.cfhyoyb-result{margin-top:10px}.cfhyoyb-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px}.cfhyoyb-card{padding:9px;border:1px solid #e2e8f0;border-radius:8px}.cfhyoyb-card small{display:block;color:#64748b}.cfhyoyb-table{overflow:auto;margin-top:9px}.cfhyoyb table{width:100%;border-collapse:collapse;font-size:12px}.cfhyoyb th,.cfhyoyb td{text-align:left;padding:7px;border-bottom:1px solid #e2e8f0}';
  document.head.appendChild(style);
}
