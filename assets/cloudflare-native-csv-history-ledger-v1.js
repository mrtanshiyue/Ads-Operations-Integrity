import {
  CSV_HISTORY_LEDGER_SCHEMA_VERSION,
  buildCsvHistorySnapshot,
  createCsvHistoryLedger,
  mergeCsvHistoryLedger,
  parseCsvHistoryLedger,
  serializeCsvHistoryLedger,
  validateCsvHistoryLedger,
} from './csv-analysis-engine/csv-history-ledger.js';

export const CSV_HISTORY_LEDGER_UI_VERSION = '1.4.0';
export const CSV_HISTORY_MONTHLY_WORKSPACE_SCHEMA_VERSION = 'csv-history-monthly-workspace-v1';
export const CSV_HISTORY_TREND_SCHEMA_VERSION = 'csv-history-trend-v1';
export const CSV_HISTORY_EVIDENCE_DRILLDOWN_SCHEMA_VERSION = 'csv-history-evidence-drilldown-v1';
export const CSV_HISTORY_PERIOD_COMPARISON_SCHEMA_VERSION = 'csv-history-period-comparison-v1';
export const CSV_HISTORY_TREND_METRICS = Object.freeze([
  Object.freeze({ key: 'spendMicros', label: 'Spend', unit: 'micros' }),
  Object.freeze({ key: 'salesMicros', label: 'Sales', unit: 'micros' }),
  Object.freeze({ key: 'orders', label: 'Orders', unit: 'count' }),
  Object.freeze({ key: 'acos', label: 'ACoS', unit: 'ratio' }),
  Object.freeze({ key: 'roas', label: 'ROAS', unit: 'ratio' }),
  Object.freeze({ key: 'adContributionMicros', label: 'Ad Contribution', unit: 'micros' }),
]);

const state = {
  mounted: false,
  busy: false,
  evidenceSeq: 0,
  comparisonSeq: 0,
  ledger: null,
  importedFileName: null,
  comparisonA: null,
  comparisonB: null,
};

export function buildHistoricalMonthlyWorkspace(ledger) {
  assertLedgerForMonthlyWorkspace(ledger);
  const rows = [];
  for (const snapshot of ledger.snapshots) {
    for (const monthly of snapshot.monthlySnapshots || []) {
      const metrics = monthly?.metrics || {};
      const spendMicros = safeInteger(metrics.spendMicros, 'CSV_HISTORY_MONTHLY_SPEND_INVALID');
      const salesMicros = safeInteger(metrics.salesMicros, 'CSV_HISTORY_MONTHLY_SALES_INVALID');
      const adContributionMicros = safeInteger(monthly.adContributionMicros, 'CSV_HISTORY_MONTHLY_CONTRIBUTION_INVALID');
      if (adContributionMicros !== salesMicros - spendMicros) throw monthlyWorkspaceError('CSV_HISTORY_MONTHLY_CONTRIBUTION_MISMATCH');
      if (monthly.profitabilityBasis !== 'sales_minus_ad_spend_only_not_net_profit') throw monthlyWorkspaceError('CSV_HISTORY_MONTHLY_PROFITABILITY_BASIS_INVALID');
      const coverageRatio = finiteOrNull(monthly.coverage?.coverageRatio);
      rows.push(Object.freeze({
        month: String(monthly.month || monthly.startDate || 'unknown').slice(0, 7),
        periodStartDate: monthly.startDate || null,
        periodEndDate: monthly.endDate || null,
        spendMicros,
        salesMicros,
        orders: safeInteger(metrics.orders ?? 0, 'CSV_HISTORY_MONTHLY_ORDERS_INVALID'),
        acos: finiteOrNull(metrics.acos),
        roas: finiteOrNull(metrics.roas),
        adContributionMicros,
        profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
        coverageRatio,
        coverageComplete: monthly.coverage?.complete === true,
        qualityState: snapshot.qualityState || 'unknown',
        safeForNaiveAggregation: snapshot.safeForNaiveAggregation === true,
        contiguousCoverage: snapshot.contiguousCoverage === true,
        decisionState: monthlyDecisionState(snapshot, monthly),
        sourceInputSetFingerprint: snapshot.inputSetFingerprint,
        ledgerFingerprint: ledger.ledgerFingerprint,
        currencyCode: snapshot.sourceReceipts?.find((item) => item.currencyCode)?.currencyCode || null,
        canonicalAmazonIdentityResolved: false,
        governancePersistenceAllowed: false,
        executionAuthorized: false,
        amazonMutationAuthorized: false,
      }));
    }
  }
  rows.sort((left, right) => left.month.localeCompare(right.month) || left.sourceInputSetFingerprint.localeCompare(right.sourceInputSetFingerprint));
  const counts = new Map();
  for (const row of rows) counts.set(row.month, (counts.get(row.month) || 0) + 1);
  const annotatedRows = rows.map((row) => Object.freeze({
    ...row,
    sameMonthEvidenceCount: counts.get(row.month),
    sameMonthMultipleSnapshots: counts.get(row.month) > 1,
    crossSnapshotAggregationApplied: false,
  }));
  return Object.freeze({
    schemaVersion: CSV_HISTORY_MONTHLY_WORKSPACE_SCHEMA_VERSION,
    ledgerFingerprint: ledger.ledgerFingerprint,
    rowCount: annotatedRows.length,
    distinctMonthCount: counts.size,
    multiEvidenceMonthCount: [...counts.values()].filter((count) => count > 1).length,
    crossSnapshotAggregationApplied: false,
    normalizationApplied: false,
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    authority: Object.freeze({
      authoritative: false,
      canonicalAmazonIdentityResolved: false,
      governancePersistenceAllowed: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    }),
    rows: Object.freeze(annotatedRows),
  });
}

export function buildHistoricalTrend(ledger, metricKey = 'adContributionMicros') {
  const metric = CSV_HISTORY_TREND_METRICS.find((item) => item.key === metricKey);
  if (!metric) throw trendError('CSV_HISTORY_TREND_METRIC_UNSUPPORTED');
  const workspace = buildHistoricalMonthlyWorkspace(ledger);
  const points = workspace.rows.map((row, evidenceIndex) => {
    const rawValue = row[metric.key];
    const value = rawValue == null ? null : Number(rawValue);
    if (value != null && !Number.isFinite(value)) throw trendError('CSV_HISTORY_TREND_VALUE_INVALID');
    return Object.freeze({
      evidenceIndex,
      month: row.month,
      value,
      missingValue: value == null,
      metricKey: metric.key,
      metricLabel: metric.label,
      metricUnit: metric.unit,
      coverageRatio: row.coverageRatio,
      coverageComplete: row.coverageComplete,
      qualityState: row.qualityState,
      decisionState: row.decisionState,
      sourceInputSetFingerprint: row.sourceInputSetFingerprint,
      ledgerFingerprint: row.ledgerFingerprint,
      sameMonthEvidenceCount: row.sameMonthEvidenceCount,
      sameMonthMultipleSnapshots: row.sameMonthMultipleSnapshots,
      crossSnapshotAggregationApplied: false,
      canonicalAmazonIdentityResolved: false,
      governancePersistenceAllowed: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    });
  });
  return Object.freeze({
    schemaVersion: CSV_HISTORY_TREND_SCHEMA_VERSION,
    ledgerFingerprint: workspace.ledgerFingerprint,
    metricKey: metric.key,
    metricLabel: metric.label,
    metricUnit: metric.unit,
    pointCount: points.length,
    missingValueCount: points.filter((point) => point.missingValue).length,
    partialCoveragePointCount: points.filter((point) => !point.coverageComplete).length,
    blockedPointCount: points.filter((point) => point.decisionState === 'blocked_overlap_or_invalid_window').length,
    multiEvidencePointCount: points.filter((point) => point.sameMonthMultipleSnapshots).length,
    crossSnapshotAggregationApplied: false,
    normalizationApplied: false,
    partialPeriodsHidden: false,
    missingValuesHidden: false,
    coverageBound: true,
    qualityStateBound: true,
    sourceFingerprintBound: true,
    profitabilityBasis: metric.key === 'adContributionMicros' ? 'sales_minus_ad_spend_only_not_net_profit' : null,
    authority: workspace.authority,
    points: Object.freeze(points),
  });
}

export async function buildHistoricalEvidenceDrilldown(ledger, selection) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) throw evidenceDrilldownError('CSV_HISTORY_EVIDENCE_SELECTION_INVALID');
  const requestedLedgerFingerprint = selectionHash(selection.ledgerFingerprint, 'CSV_HISTORY_EVIDENCE_LEDGER_FINGERPRINT_INVALID');
  const requestedInputSetFingerprint = selectionHash(selection.sourceInputSetFingerprint, 'CSV_HISTORY_EVIDENCE_INPUT_SET_FINGERPRINT_INVALID');
  const month = String(selection.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) throw evidenceDrilldownError('CSV_HISTORY_EVIDENCE_MONTH_INVALID');
  const metricKey = String(selection.metricKey || 'adContributionMicros');
  const metric = CSV_HISTORY_TREND_METRICS.find((item) => item.key === metricKey);
  if (!metric) throw evidenceDrilldownError('CSV_HISTORY_EVIDENCE_METRIC_UNSUPPORTED');

  const validated = await validateCsvHistoryLedger(ledger);
  if (validated.ledgerFingerprint !== requestedLedgerFingerprint) throw evidenceDrilldownError('CSV_HISTORY_EVIDENCE_LEDGER_FINGERPRINT_UNKNOWN');

  const snapshots = validated.snapshots.filter((item) => item.inputSetFingerprint === requestedInputSetFingerprint);
  if (snapshots.length === 0) throw evidenceDrilldownError('CSV_HISTORY_EVIDENCE_INPUT_SET_FINGERPRINT_UNKNOWN');
  if (snapshots.length !== 1) throw evidenceDrilldownError('CSV_HISTORY_EVIDENCE_SELECTION_AMBIGUOUS');
  const snapshot = snapshots[0];

  const monthSnapshots = (snapshot.monthlySnapshots || []).filter((item) => String(item?.month || item?.startDate || '').slice(0, 7) === month);
  if (monthSnapshots.length === 0) throw evidenceDrilldownError('CSV_HISTORY_EVIDENCE_MONTH_NOT_IN_SNAPSHOT');
  if (monthSnapshots.length !== 1) throw evidenceDrilldownError('CSV_HISTORY_EVIDENCE_SELECTION_AMBIGUOUS');
  const monthly = monthSnapshots[0];

  const workspace = buildHistoricalMonthlyWorkspace(validated);
  const rows = workspace.rows.filter((item) => item.ledgerFingerprint === requestedLedgerFingerprint && item.sourceInputSetFingerprint === requestedInputSetFingerprint && item.month === month);
  if (rows.length !== 1) throw evidenceDrilldownError('CSV_HISTORY_EVIDENCE_SELECTION_AMBIGUOUS');
  const row = rows[0];

  const receipts = snapshot.sourceReceipts || [];
  if (!Array.isArray(receipts) || receipts.length === 0) throw evidenceDrilldownError('CSV_HISTORY_EVIDENCE_SOURCE_RECEIPTS_REQUIRED');
  if (snapshot.batchCount !== receipts.length) throw evidenceDrilldownError('CSV_HISTORY_EVIDENCE_BATCH_COUNT_MISMATCH');
  for (const receipt of receipts) {
    if (!/\.csv$/i.test(String(receipt?.sourceFileName || ''))) throw evidenceDrilldownError('CSV_HISTORY_EVIDENCE_SOURCE_FILE_INVALID');
    if (!/^[a-f0-9]{64}$/i.test(String(receipt?.contentSha256 || ''))) throw evidenceDrilldownError('CSV_HISTORY_EVIDENCE_SOURCE_HASH_INVALID');
  }
  const receiptHashes = receipts.map((item) => String(item.contentSha256).toLowerCase()).sort();
  const sourceHashes = (snapshot.contentSha256s || []).map((item) => String(item).toLowerCase()).sort();
  if (receiptHashes.length !== sourceHashes.length || receiptHashes.some((hash, index) => hash !== sourceHashes[index])) {
    throw evidenceDrilldownError('CSV_HISTORY_EVIDENCE_SOURCE_RECEIPT_MISMATCH');
  }

  const metricValue = row[metric.key] == null ? null : Number(row[metric.key]);
  if (metricValue != null && !Number.isFinite(metricValue)) throw evidenceDrilldownError('CSV_HISTORY_EVIDENCE_METRIC_VALUE_INVALID');
  const sourceFileNames = receipts.map((item) => item.sourceFileName);
  const marketplaceCodes = [...new Set(receipts.map((item) => item.marketplace).filter(Boolean))].sort();
  const currencyCodes = [...new Set(receipts.map((item) => item.currencyCode).filter(Boolean))].sort();
  const authority = noAuthority();

  return deepFreezeEvidence({
    schemaVersion: CSV_HISTORY_EVIDENCE_DRILLDOWN_SCHEMA_VERSION,
    navigationOnly: true,
    analyticalAuthorityCreated: false,
    evidenceKey: {
      ledgerFingerprint: requestedLedgerFingerprint,
      sourceInputSetFingerprint: requestedInputSetFingerprint,
      month,
    },
    selectedMonth: month,
    metric: {
      key: metric.key,
      label: metric.label,
      unit: metric.unit,
      value: metricValue,
      missingValue: metricValue == null,
    },
    metrics: {
      spendMicros: row.spendMicros,
      salesMicros: row.salesMicros,
      orders: row.orders,
      acos: row.acos,
      roas: row.roas,
      adContributionMicros: row.adContributionMicros,
    },
    coverage: {
      coverageRatio: row.coverageRatio,
      coverageComplete: row.coverageComplete,
      periodStartDate: row.periodStartDate,
      periodEndDate: row.periodEndDate,
    },
    decision: {
      qualityState: row.qualityState,
      decisionState: row.decisionState,
      safeForNaiveAggregation: row.safeForNaiveAggregation,
      contiguousCoverage: row.contiguousCoverage,
      sameMonthEvidenceCount: row.sameMonthEvidenceCount,
      sameMonthMultipleSnapshots: row.sameMonthMultipleSnapshots,
    },
    source: {
      ledgerFingerprint: requestedLedgerFingerprint,
      inputSetFingerprint: requestedInputSetFingerprint,
      sourceKind: snapshot.sourceKind,
      batchCount: snapshot.batchCount,
      sourceReceiptCount: receipts.length,
      sourceReceipts: [...receipts],
      sourceFileNames,
      contentSha256s: [...sourceHashes],
      reportStartDate: snapshot.reportStartDate,
      reportEndDate: snapshot.reportEndDate,
      rowCount: receipts.reduce((sum, item) => sum + Number(item.rowCount || 0), 0),
      acceptedRows: receipts.reduce((sum, item) => sum + Number(item.acceptedRows || 0), 0),
      rejectedRows: receipts.reduce((sum, item) => sum + Number(item.rejectedRows || 0), 0),
      marketplaceCodes,
      currencyCodes,
    },
    observedIdentity: {
      summary: snapshot.observedIdentitySummary || {},
      canonicalAmazonIdentityResolved: false,
    },
    hierarchy: {
      summary: snapshot.hierarchySummary || {},
    },
    period: {
      summary: snapshot.periodSummary || {},
      monthlySnapshot: monthly,
    },
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    crossSnapshotAggregationApplied: false,
    normalizationApplied: false,
    authority,
  });
}

export async function buildHistoricalPeriodComparison(ledger, periodASelection, periodBSelection) {
  const validated = await validateCsvHistoryLedger(ledger);
  const periodA = await buildHistoricalEvidenceDrilldown(validated, periodASelection);
  const periodB = await buildHistoricalEvidenceDrilldown(validated, periodBSelection);
  const overlapPairs = validated.historyWindowEvidence?.overlapPairs || [];
  const participatesInHistoricalOverlap = (fingerprint) => overlapPairs.some((pair) => pair.leftInputSetFingerprint === fingerprint || pair.rightInputSetFingerprint === fingerprint);
  const periodAWindowDays = inclusiveDayCount(periodA.coverage.periodStartDate, periodA.coverage.periodEndDate);
  const periodBWindowDays = inclusiveDayCount(periodB.coverage.periodStartDate, periodB.coverage.periodEndDate);
  const completeCalendarPeriods = periodA.coverage.coverageComplete === true
    && periodB.coverage.coverageComplete === true
    && periodA.period.monthlySnapshot?.periodRole === 'calendar_month'
    && periodB.period.monthlySnapshot?.periodRole === 'calendar_month';
  const ambiguousA = Number(periodA.observedIdentity.summary?.ambiguousIdentityCount);
  const ambiguousB = Number(periodB.observedIdentity.summary?.ambiguousIdentityCount);
  const metricsA = comparisonMetricValues(periodA);
  const metricsB = comparisonMetricValues(periodB);
  const metricValuesComplete = CSV_HISTORY_TREND_METRICS.every((metric) => metricsA[metric.key] != null && metricsB[metric.key] != null);

  const checks = {
    distinctEvidence: !sameEvidenceKey(periodA.evidenceKey, periodB.evidenceKey),
    sourceFingerprintsDistinct: periodA.source.inputSetFingerprint !== periodB.source.inputSetFingerprint,
    coverageComplete: periodA.coverage.coverageComplete === true && periodB.coverage.coverageComplete === true,
    safeForNaiveAggregation: periodA.decision.safeForNaiveAggregation === true && periodB.decision.safeForNaiveAggregation === true,
    contiguousCoverage: periodA.decision.contiguousCoverage === true && periodB.decision.contiguousCoverage === true,
    decisionStatesReviewable: periodA.decision.decisionState !== 'blocked_overlap_or_invalid_window' && periodB.decision.decisionState !== 'blocked_overlap_or_invalid_window',
    qualityStateCompatible: periodA.decision.qualityState !== 'unknown' && periodA.decision.qualityState === periodB.decision.qualityState,
    historicalOverlapFree: !participatesInHistoricalOverlap(periodA.source.inputSetFingerprint) && !participatesInHistoricalOverlap(periodB.source.inputSetFingerprint),
    observedIdentityUnambiguous: Number.isSafeInteger(ambiguousA) && Number.isSafeInteger(ambiguousB) && ambiguousA === 0 && ambiguousB === 0,
    marketplaceCompatible: periodA.source.marketplaceCodes.length === 1 && periodB.source.marketplaceCodes.length === 1 && periodA.source.marketplaceCodes[0] === periodB.source.marketplaceCodes[0],
    currencyCompatible: periodA.source.currencyCodes.length === 1 && periodB.source.currencyCodes.length === 1 && periodA.source.currencyCodes[0] === periodB.source.currencyCodes[0],
    reportWindowsKnown: periodAWindowDays != null && periodBWindowDays != null,
    reportWindowLengthCompatible: periodAWindowDays != null && periodBWindowDays != null && (periodAWindowDays === periodBWindowDays || completeCalendarPeriods),
    metricValuesComplete,
  };
  const reasons = [];
  for (const [key, allowed] of Object.entries(checks)) if (!allowed) reasons.push(comparisonReason(key));
  const comparisonAllowed = reasons.length === 0;
  const metrics = {};
  for (const metric of CSV_HISTORY_TREND_METRICS) {
    const valueA = metricsA[metric.key];
    const valueB = metricsB[metric.key];
    const delta = comparisonAllowed ? valueB - valueA : null;
    metrics[metric.key] = {
      label: metric.label,
      unit: metric.unit,
      periodAValue: valueA,
      periodBValue: valueB,
      delta,
      direction: comparisonAllowed ? deltaDirection(delta) : 'withheld_not_comparable',
      interpretationAllowed: comparisonAllowed,
    };
  }

  return deepFreezeEvidence({
    schemaVersion: CSV_HISTORY_PERIOD_COMPARISON_SCHEMA_VERSION,
    comparisonAllowed,
    interpretationAllowed: comparisonAllowed,
    rawEvidenceOnly: !comparisonAllowed,
    deltaBasis: 'period_b_minus_period_a',
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    periodA: comparisonEvidenceSummary(periodA),
    periodB: comparisonEvidenceSummary(periodB),
    comparabilityGate: {
      checks,
      reasons,
      periodAWindowDays,
      periodBWindowDays,
      completeCalendarPeriods,
      historicalOverlapPairCount: overlapPairs.length,
      canonicalAmazonIdentityResolved: false,
    },
    metrics,
    crossSnapshotAggregationApplied: false,
    normalizationApplied: false,
    authority: noAuthority(),
  });
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvHistoryLedger', {
    value: Object.freeze({
      version: CSV_HISTORY_LEDGER_UI_VERSION,
      schemaVersion: CSV_HISTORY_LEDGER_SCHEMA_VERSION,
      monthlyWorkspaceSchemaVersion: CSV_HISTORY_MONTHLY_WORKSPACE_SCHEMA_VERSION,
      trendSchemaVersion: CSV_HISTORY_TREND_SCHEMA_VERSION,
      evidenceDrilldownSchemaVersion: CSV_HISTORY_EVIDENCE_DRILLDOWN_SCHEMA_VERSION,
      periodComparisonSchemaVersion: CSV_HISTORY_PERIOD_COMPARISON_SCHEMA_VERSION,
      trendMetrics: CSV_HISTORY_TREND_METRICS,
      authority: 'local_file_history_ledger_only',
      buildCsvHistorySnapshot,
      createCsvHistoryLedger,
      mergeCsvHistoryLedger,
      parseCsvHistoryLedger,
      serializeCsvHistoryLedger,
      validateCsvHistoryLedger,
      buildHistoricalMonthlyWorkspace,
      buildHistoricalTrend,
      buildHistoricalEvidenceDrilldown,
      buildHistoricalPeriodComparison,
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
  const joint = document.querySelector('[data-csv-joint-analysis]');
  if (!joint) {
    new MutationObserver((_, observer) => {
      if (!document.querySelector('[data-csv-joint-analysis]')) return;
      observer.disconnect();
      mount();
    }).observe(document.documentElement, { childList: true, subtree: true });
    return;
  }
  if (joint.querySelector('[data-csv-history-ledger]')) return void (state.mounted = true);

  installStyles();
  const root = document.createElement('section');
  root.className = 'cfhl';
  root.dataset.csvHistoryLedger = CSV_HISTORY_LEDGER_UI_VERSION;
  root.innerHTML = `
    <div class="cfhl-head">
      <div>
        <b>Historical Local-Data Ledger</b>
        <small>Explicit local-file ownership. Import an existing ledger, append the current Joint CSV Analysis as an immutable evidence snapshot, then download a new deterministic ledger file.</small>
      </div>
      <span>browser-local · file-owned</span>
    </div>
    <div class="cfhl-guard">CSV-observed evidence only. Canonical Amazon identity, governance persistence, execution, and Amazon mutation remain disabled. Overlap or gaps are recorded, never silently normalized.</div>
    <div class="cfhl-actions">
      <label>Import history-ledger.json <input type="file" accept="application/json,.json" data-cfhl-import></label>
      <button type="button" data-cfhl-add disabled>Add current CSV snapshot</button>
      <button type="button" data-cfhl-download disabled>Download updated ledger</button>
      <button type="button" data-cfhl-clear>Clear in-memory ledger</button>
    </div>
    <div class="cfhl-status" data-cfhl-status>Run Joint CSV Analysis or import an existing ledger file.</div>
    <div class="cfhl-body" data-cfhl-body hidden></div>`;

  const provenance = joint.querySelector('[data-csv-provenance-audit]');
  const exportUi = joint.querySelector('[data-csv-analysis-export]');
  if (provenance) provenance.insertAdjacentElement('beforebegin', root);
  else if (exportUi) exportUi.insertAdjacentElement('beforebegin', root);
  else joint.appendChild(root);

  root.querySelector('[data-cfhl-import]').addEventListener('change', (event) => void importLedger(root, event.currentTarget));
  root.querySelector('[data-cfhl-add]').addEventListener('click', () => void addCurrentSnapshot(root, joint));
  root.querySelector('[data-cfhl-download]').addEventListener('click', () => downloadLedger(root));
  root.querySelector('[data-cfhl-clear]').addEventListener('click', () => clearLedger(root));

  const jointStatus = joint.querySelector('[data-csv-joint-status]');
  if (jointStatus) {
    const sync = () => syncButtons(root, jointStatus.dataset.kind === 'success');
    new MutationObserver(sync).observe(jointStatus, { attributes: true, childList: true, subtree: true });
    sync();
  }
  joint.querySelector('[data-csv-joint-files]')?.addEventListener('change', () => syncButtons(root, false));
  joint.querySelector('[data-csv-joint-clear]')?.addEventListener('click', () => syncButtons(root, false));
  state.mounted = true;
}

async function importLedger(root, input) {
  const file = input.files?.[0];
  if (!file) return;
  setBusy(root, true);
  setStatus(root, 'Validating local history ledger…', 'loading');
  try {
    const ledger = await parseCsvHistoryLedger(await file.text());
    state.ledger = ledger;
    state.importedFileName = file.name;
    renderLedger(root, ledger);
    setStatus(root, `Imported ${ledger.snapshots.length} validated snapshot(s). Fingerprint ${ledger.ledgerFingerprint.slice(0, 12)}.`, 'ok');
  } catch (error) {
    state.ledger = null;
    state.importedFileName = null;
    state.comparisonA = null;
    state.comparisonB = null;
    root.querySelector('[data-cfhl-body]').hidden = true;
    setStatus(root, `Ledger import blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    setBusy(root, false);
  }
}

async function addCurrentSnapshot(root, joint) {
  if (state.busy) return;
  const files = [...(joint.querySelector('[data-csv-joint-files]')?.files || [])];
  if (!files.length || typeof window.CloudflareCsvJointAnalysis?.analyzeLocalCsvInputs !== 'function') {
    return setStatus(root, 'Current Joint CSV Analysis inputs are unavailable.', 'bad');
  }
  setBusy(root, true);
  setStatus(root, 'Building immutable local evidence snapshot…', 'loading');
  try {
    const inputs = await Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() })));
    const result = await window.CloudflareCsvJointAnalysis.analyzeLocalCsvInputs(inputs);
    const next = state.ledger
      ? await mergeCsvHistoryLedger(state.ledger, result)
      : await createCsvHistoryLedger(result);
    state.ledger = next;
    state.importedFileName = state.importedFileName || null;
    renderLedger(root, next);
    setStatus(root, `Snapshot added. ${next.snapshots.length} total snapshot(s); ledger fingerprint ${next.ledgerFingerprint.slice(0, 12)}.`, 'ok');
  } catch (error) {
    setStatus(root, `Snapshot append blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    setBusy(root, false);
  }
}

function downloadLedger(root) {
  if (!state.ledger || state.busy) return;
  const text = serializeCsvHistoryLedger(state.ledger);
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `csv-history-ledger-v1-${state.ledger.ledgerFingerprint.slice(0, 12)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  setStatus(root, `Downloaded deterministic ledger ${state.ledger.ledgerFingerprint.slice(0, 12)}. Local file ownership remains explicit.`, 'ok');
}

function clearLedger(root) {
  state.evidenceSeq += 1;
  state.comparisonSeq += 1;
  state.ledger = null;
  state.importedFileName = null;
  state.comparisonA = null;
  state.comparisonB = null;
  const input = root.querySelector('[data-cfhl-import]');
  input.value = '';
  root.querySelector('[data-cfhl-body]').hidden = true;
  setStatus(root, 'In-memory ledger cleared. No remote deletion was required because no remote persistence exists.');
  syncButtons(root, document.querySelector('[data-csv-joint-status]')?.dataset.kind === 'success');
}

function renderLedger(root, ledger) {
  state.evidenceSeq += 1;
  state.comparisonSeq += 1;
  state.comparisonA = null;
  state.comparisonB = null;
  const body = root.querySelector('[data-cfhl-body]');
  const windowEvidence = ledger.historyWindowEvidence;
  const monthlyWorkspace = buildHistoricalMonthlyWorkspace(ledger);
  body.innerHTML = `
    <div class="cfhl-grid">
      ${card('Ledger fingerprint', `<code>${esc(ledger.ledgerFingerprint)}</code>`)}
      ${card('Snapshots', `<b>${ledger.snapshots.length}</b><br>${state.importedFileName ? `imported from ${esc(state.importedFileName)}` : 'new local ledger'}`)}
      ${card('Historical windows', `overlap pairs: <b>${windowEvidence.overlapPairCount}</b><br>gaps: <b>${windowEvidence.gapCount}</b><br>incomplete windows: <b>${windowEvidence.incompleteWindowCount}</b>`)}
      ${card('Normalization', `<b>none</b><br>business-row dedupe: <b>none</b>`)}
    </div>
    <div class="cfhl-table-wrap"><table>
      <thead><tr><th>Window</th><th>Quality</th><th>Aggregation</th><th>Coverage</th><th>Monthly</th><th>Input fingerprint</th></tr></thead>
      <tbody>${ledger.snapshots.map(snapshotRow).join('')}</tbody>
    </table></div>
    ${renderMonthlyWorkspace(monthlyWorkspace)}
    ${renderHistoricalTrendSection(ledger)}
    ${renderSelectedEvidenceShell()}
    ${renderComparisonShell()}
    <details><summary>Historical overlap / gap evidence</summary><pre>${esc(JSON.stringify(windowEvidence, null, 2))}</pre></details>
    <details><summary>Ledger authority boundary</summary><pre>${esc(JSON.stringify(ledger.authority, null, 2))}</pre></details>`;
  bindTrendControls(body, ledger);
  bindEvidenceNavigation(body, ledger);
  bindComparisonControls(body, ledger);
  body.hidden = false;
  syncButtons(root, document.querySelector('[data-csv-joint-status]')?.dataset.kind === 'success');
}

function renderMonthlyWorkspace(workspace) {
  return `
    <section class="cfhl-monthly" data-cfhl-monthly-workspace="${CSV_HISTORY_MONTHLY_WORKSPACE_SCHEMA_VERSION}">
      <div class="cfhl-monthly-head">
        <div><b>Historical Monthly Workspace</b><small>Each row stays bound to coverage, quality state, and source input fingerprint. Same-month evidence from multiple snapshots is displayed separately, never cross-snapshot aggregated. Select a row to audit its exact immutable evidence.</small></div>
        <span>${workspace.distinctMonthCount} month(s) · ${workspace.rowCount} evidence row(s)</span>
      </div>
      <div class="cfhl-guard">Ad Contribution = Sales - Ad Spend only; it is not Net Profit. Multi-evidence months: ${workspace.multiEvidenceMonthCount}. Cross-snapshot aggregation: none.</div>
      <div class="cfhl-table-wrap"><table>
        <thead><tr><th>Month</th><th>Spend</th><th>Sales</th><th>Orders</th><th>ACoS</th><th>ROAS</th><th>Ad Contribution</th><th>Coverage</th><th>Decision state</th><th>Source fingerprint</th></tr></thead>
        <tbody>${workspace.rows.length ? workspace.rows.map(monthlyRow).join('') : '<tr><td colspan="10">No monthly evidence in this ledger.</td></tr>'}</tbody>
      </table></div>
    </section>`;
}

function renderHistoricalTrendSection(ledger) {
  const trend = buildHistoricalTrend(ledger, 'adContributionMicros');
  return `
    <section class="cfhl-trend" data-cfhl-history-trend="${CSV_HISTORY_TREND_SCHEMA_VERSION}">
      <div class="cfhl-monthly-head">
        <div><b>Historical Trend Evidence</b><small>Every plotted point remains bound to coverage, quality state, and source input fingerprint. Partial, blocked, duplicate-month, and missing-value evidence is never hidden or merged. Select a point to audit its exact immutable evidence.</small></div>
        <label>Metric <select data-cfhl-trend-metric>${CSV_HISTORY_TREND_METRICS.map((item) => `<option value="${esc(item.key)}"${item.key === trend.metricKey ? ' selected' : ''}>${esc(item.label)}</option>`).join('')}</select></label>
      </div>
      <div class="cfhl-guard">Ad Contribution uses Sales - Ad Spend only and is not Net Profit. Trend normalization: none. Cross-snapshot aggregation: none.</div>
      <div data-cfhl-trend-chart>${renderTrendEvidence(trend)}</div>
    </section>`;
}

function renderSelectedEvidenceShell() {
  return `
    <section class="cfhl-evidence" data-cfhl-selected-evidence="${CSV_HISTORY_EVIDENCE_DRILLDOWN_SCHEMA_VERSION}">
      <div class="cfhl-monthly-head">
        <div><b>Selected Historical Evidence</b><small>Choose a Historical Monthly row or Historical Trend point. The deterministic key is ledger fingerprint + input-set fingerprint + month.</small></div>
        <span>navigation only</span>
      </div>
      <div class="cfhl-evidence-empty">No historical evidence selected.</div>
    </section>`;
}

function renderComparisonShell() {
  return `
    <section class="cfhl-comparison" data-cfhl-history-comparison="${CSV_HISTORY_PERIOD_COMPARISON_SCHEMA_VERSION}">
      <div class="cfhl-monthly-head">
        <div><b>Historical Period Comparison</b><small>Select an audited evidence point as Period A and another as Period B. Deltas and direction are withheld unless the comparability gate passes.</small></div>
        <span>comparability-gated</span>
      </div>
      <div class="cfhl-comparison-empty">Period A: not selected · Period B: not selected</div>
    </section>`;
}

function bindTrendControls(body, ledger) {
  const select = body.querySelector('[data-cfhl-trend-metric]');
  const target = body.querySelector('[data-cfhl-trend-chart]');
  if (!select || !target) return;
  select.addEventListener('change', () => {
    target.innerHTML = renderTrendEvidence(buildHistoricalTrend(ledger, select.value));
  });
}

function bindEvidenceNavigation(body, ledger) {
  const activate = (trigger) => void selectHistoricalEvidence(body, ledger, trigger);
  body.addEventListener('click', (event) => {
    const trigger = event.target?.closest?.('[data-cfhl-evidence-nav]');
    if (trigger && body.contains(trigger)) activate(trigger);
  });
  body.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const trigger = event.target?.closest?.('[data-cfhl-evidence-nav]');
    if (!trigger || !body.contains(trigger)) return;
    event.preventDefault();
    activate(trigger);
  });
}

function bindComparisonControls(body, ledger) {
  body.addEventListener('click', (event) => {
    const trigger = event.target?.closest?.('[data-cfhl-comparison-slot]');
    if (!trigger || !body.contains(trigger)) return;
    const selection = Object.freeze({
      ledgerFingerprint: trigger.dataset.ledgerFingerprint,
      sourceInputSetFingerprint: trigger.dataset.inputSetFingerprint,
      month: trigger.dataset.evidenceMonth,
    });
    if (trigger.dataset.cfhlComparisonSlot === 'A') state.comparisonA = selection;
    else if (trigger.dataset.cfhlComparisonSlot === 'B') state.comparisonB = selection;
    else return;
    void renderComparisonState(body, ledger);
  });
}

async function selectHistoricalEvidence(body, ledger, trigger) {
  const target = body.querySelector('[data-cfhl-selected-evidence]');
  if (!target) return;
  const seq = ++state.evidenceSeq;
  target.dataset.kind = 'loading';
  target.innerHTML = '<div class="cfhl-evidence-empty">Validating exact historical evidence…</div>';
  try {
    const evidence = await buildHistoricalEvidenceDrilldown(ledger, {
      ledgerFingerprint: trigger.dataset.ledgerFingerprint,
      sourceInputSetFingerprint: trigger.dataset.inputSetFingerprint,
      month: trigger.dataset.evidenceMonth,
      metricKey: trigger.dataset.metricKey || 'adContributionMicros',
    });
    if (seq !== state.evidenceSeq) return;
    target.dataset.kind = 'ok';
    target.innerHTML = renderSelectedEvidence(evidence);
  } catch (error) {
    if (seq !== state.evidenceSeq) return;
    target.dataset.kind = 'bad';
    target.innerHTML = `<div class="cfhl-evidence-empty">Evidence selection blocked: ${esc(String(error?.code || error?.message || 'unknown_error'))}</div>`;
  }
}

async function renderComparisonState(body, ledger) {
  const target = body.querySelector('[data-cfhl-history-comparison]');
  if (!target) return;
  const seq = ++state.comparisonSeq;
  if (!state.comparisonA || !state.comparisonB) {
    target.dataset.kind = '';
    target.innerHTML = `
      <div class="cfhl-monthly-head"><div><b>Historical Period Comparison</b><small>Deltas remain withheld until both evidence periods are selected and the comparability gate passes.</small></div><span>comparability-gated</span></div>
      <div class="cfhl-comparison-empty">Period A: ${state.comparisonA ? esc(selectionLabel(state.comparisonA)) : 'not selected'} · Period B: ${state.comparisonB ? esc(selectionLabel(state.comparisonB)) : 'not selected'}</div>`;
    return;
  }
  target.dataset.kind = 'loading';
  target.innerHTML = '<div class="cfhl-comparison-empty">Validating comparability gate…</div>';
  try {
    const comparison = await buildHistoricalPeriodComparison(ledger, state.comparisonA, state.comparisonB);
    if (seq !== state.comparisonSeq) return;
    target.dataset.kind = comparison.comparisonAllowed ? 'ok' : 'blocked';
    target.innerHTML = renderComparisonResult(comparison);
  } catch (error) {
    if (seq !== state.comparisonSeq) return;
    target.dataset.kind = 'bad';
    target.innerHTML = `<div class="cfhl-comparison-empty">Comparison blocked: ${esc(String(error?.code || error?.message || 'unknown_error'))}</div>`;
  }
}

function renderSelectedEvidence(evidence) {
  const currency = evidence.source.currencyCodes[0] || null;
  const metricValue = evidence.metric.missingValue
    ? 'missing'
    : (evidence.metric.unit === 'micros' ? money(evidence.metric.value, currency) : evidence.metric.unit === 'ratio' ? decimal(evidence.metric.value) : String(evidence.metric.value));
  const receipts = evidence.source.sourceReceipts.map((receipt) => `<tr>
    <td>${esc(receipt.sourceFileName)}</td>
    <td><code>${esc(receipt.contentSha256)}</code></td>
    <td>${esc(receipt.reportStartDate || 'unknown')} → ${esc(receipt.reportEndDate || 'unknown')}</td>
    <td>${receipt.rowCount}</td>
    <td>${receipt.acceptedRows}</td>
    <td>${receipt.rejectedRows}</td>
  </tr>`).join('');
  const selectionAttrs = `data-ledger-fingerprint="${esc(evidence.evidenceKey.ledgerFingerprint)}" data-input-set-fingerprint="${esc(evidence.evidenceKey.sourceInputSetFingerprint)}" data-evidence-month="${esc(evidence.evidenceKey.month)}"`;
  return `
    <div class="cfhl-monthly-head">
      <div><b>Selected Historical Evidence</b><small>This is navigation into immutable evidence, not new analytical authority, canonical Amazon identity, governance state, or an execution target.</small></div>
      <span>${esc(evidence.schemaVersion)}</span>
    </div>
    <div class="cfhl-guard">Evidence key = ledger fingerprint + input-set fingerprint + month. Same-month snapshots remain independently addressable. Ad Contribution = Sales - Ad Spend only; it is not Net Profit.</div>
    <div class="cfhl-comparison-actions"><button type="button" data-cfhl-comparison-slot="A" ${selectionAttrs}>Use as Period A</button><button type="button" data-cfhl-comparison-slot="B" ${selectionAttrs}>Use as Period B</button></div>
    <div class="cfhl-grid cfhl-evidence-grid">
      ${card('Selected month', `<b>${esc(evidence.selectedMonth)}</b>`)}
      ${card('Metric', `${esc(evidence.metric.label)}<br><b>${esc(metricValue)}</b>`)}
      ${card('Coverage', `${evidence.coverage.coverageRatio == null ? 'unknown' : percent(evidence.coverage.coverageRatio)}<br>${evidence.coverage.coverageComplete ? 'complete' : 'partial'}`)}
      ${card('Decision', `${esc(evidence.decision.decisionState)}<br>${esc(evidence.decision.qualityState)}`)}
      ${card('Aggregation', `${evidence.decision.safeForNaiveAggregation ? 'safe for naive aggregation' : 'blocked / review'}<br>${evidence.decision.contiguousCoverage ? 'contiguous coverage' : 'incomplete / gap'}`)}
      ${card('Duplicate-month evidence', `${evidence.decision.sameMonthEvidenceCount}<br>${evidence.decision.sameMonthMultipleSnapshots ? 'multiple snapshots preserved' : 'single snapshot evidence'}`)}
    </div>
    <div class="cfhl-evidence-key"><b>Ledger fingerprint</b><code>${esc(evidence.evidenceKey.ledgerFingerprint)}</code><b>Input-set fingerprint</b><code>${esc(evidence.evidenceKey.sourceInputSetFingerprint)}</code></div>
    <div class="cfhl-table-wrap"><table>
      <thead><tr><th>Source file</th><th>SHA-256</th><th>Report window</th><th>Rows</th><th>Accepted</th><th>Rejected</th></tr></thead>
      <tbody>${receipts}</tbody>
    </table></div>
    <div class="cfhl-grid cfhl-evidence-grid">
      ${card('Source totals', `files ${evidence.source.sourceReceiptCount} · rows ${evidence.source.rowCount}<br>accepted ${evidence.source.acceptedRows} · rejected ${evidence.source.rejectedRows}`)}
      ${card('Snapshot window', `${esc(evidence.source.reportStartDate || 'unknown')} → ${esc(evidence.source.reportEndDate || 'unknown')}`)}
      ${card('Marketplace', evidence.source.marketplaceCodes.length ? esc(evidence.source.marketplaceCodes.join(', ')) : 'unknown')}
      ${card('Currency', evidence.source.currencyCodes.length ? esc(evidence.source.currencyCodes.join(', ')) : 'unknown')}
    </div>
    <details open><summary>Observed Identity</summary><pre>${esc(JSON.stringify(evidence.observedIdentity, null, 2))}</pre></details>
    <details><summary>Hierarchy</summary><pre>${esc(JSON.stringify(evidence.hierarchy, null, 2))}</pre></details>
    <details><summary>Period evidence</summary><pre>${esc(JSON.stringify(evidence.period, null, 2))}</pre></details>
    <details><summary>Authority boundary</summary><pre>${esc(JSON.stringify(evidence.authority, null, 2))}</pre></details>`;
}

function renderComparisonResult(comparison) {
  const currencyA = comparison.periodA.source.currencyCodes[0] || null;
  const currencyB = comparison.periodB.source.currencyCodes[0] || null;
  const rows = CSV_HISTORY_TREND_METRICS.map((metric) => {
    const item = comparison.metrics[metric.key];
    return `<tr><td>${esc(item.label)}</td><td>${formatComparisonValue(item.periodAValue, item.unit, currencyA)}</td><td>${formatComparisonValue(item.periodBValue, item.unit, currencyB)}</td><td>${item.delta == null ? 'withheld' : formatComparisonValue(item.delta, item.unit, currencyB)}</td><td>${esc(item.direction)}</td></tr>`;
  }).join('');
  const gateRows = Object.entries(comparison.comparabilityGate.checks).map(([key, allowed]) => `<tr><td>${esc(key)}</td><td>${allowed ? 'pass' : 'block'}</td></tr>`).join('');
  const reasons = comparison.comparabilityGate.reasons.length ? comparison.comparabilityGate.reasons.map((item) => `<li>${esc(item)}</li>`).join('') : '<li>all comparability checks passed</li>';
  return `
    <div class="cfhl-monthly-head"><div><b>Historical Period Comparison</b><small>${comparison.comparisonAllowed ? 'Comparability gate passed. Deltas are B - A and may be interpreted for analytical review only.' : 'Comparability gate blocked interpretation. Raw evidence remains visible; deltas and increase/decrease conclusions are withheld.'}</small></div><span>${comparison.comparisonAllowed ? 'comparison allowed' : 'raw evidence only'}</span></div>
    <div class="cfhl-guard">Ad Contribution = Sales - Ad Spend only; it is not Net Profit. Cross-snapshot aggregation: none. Normalization: none. Canonical Amazon identity remains unresolved.</div>
    <div class="cfhl-grid cfhl-evidence-grid">
      ${card('Period A', `<b>${esc(comparison.periodA.selectedMonth)}</b><br>${esc(comparison.periodA.decision.decisionState)}`)}
      ${card('Period B', `<b>${esc(comparison.periodB.selectedMonth)}</b><br>${esc(comparison.periodB.decision.decisionState)}`)}
      ${card('Coverage A / B', `${comparison.periodA.coverage.coverageComplete ? 'complete' : 'partial'} / ${comparison.periodB.coverage.coverageComplete ? 'complete' : 'partial'}`)}
      ${card('Window days A / B', `${comparison.comparabilityGate.periodAWindowDays ?? 'unknown'} / ${comparison.comparabilityGate.periodBWindowDays ?? 'unknown'}`)}
    </div>
    <div class="cfhl-table-wrap"><table><thead><tr><th>Metric</th><th>Period A</th><th>Period B</th><th>Δ B-A</th><th>Direction</th></tr></thead><tbody>${rows}</tbody></table></div>
    <details open><summary>Comparability gate</summary><div class="cfhl-table-wrap"><table><thead><tr><th>Check</th><th>State</th></tr></thead><tbody>${gateRows}</tbody></table></div><ul>${reasons}</ul></details>
    <details><summary>Period A raw evidence</summary><pre>${esc(JSON.stringify(comparison.periodA, null, 2))}</pre></details>
    <details><summary>Period B raw evidence</summary><pre>${esc(JSON.stringify(comparison.periodB, null, 2))}</pre></details>
    <details><summary>Comparison authority boundary</summary><pre>${esc(JSON.stringify(comparison.authority, null, 2))}</pre></details>`;
}

function renderTrendEvidence(trend) {
  const visiblePoints = trend.points.filter((point) => !point.missingValue);
  const values = visiblePoints.map((point) => point.value);
  const minValue = values.length ? Math.min(...values) : 0;
  const maxValue = values.length ? Math.max(...values) : 0;
  const width = 760;
  const height = 190;
  const padX = 36;
  const padTop = 18;
  const padBottom = 38;
  const drawableHeight = height - padTop - padBottom;
  const span = maxValue - minValue || 1;
  const xAt = (index) => trend.points.length <= 1 ? width / 2 : padX + index * ((width - padX * 2) / (trend.points.length - 1));
  const yAt = (value) => padTop + (maxValue - value) * (drawableHeight / span);
  const segments = [];
  for (let index = 1; index < trend.points.length; index += 1) {
    const left = trend.points[index - 1];
    const right = trend.points[index];
    if (left.missingValue || right.missingValue) continue;
    segments.push(`<line x1="${xAt(index - 1).toFixed(2)}" y1="${yAt(left.value).toFixed(2)}" x2="${xAt(index).toFixed(2)}" y2="${yAt(right.value).toFixed(2)}" class="cfhl-trend-line"/>`);
  }
  const marks = trend.points.map((point, index) => {
    const x = xAt(index);
    const title = `${point.month} · ${formatTrendValue(point.value, trend.metricUnit)} · coverage ${point.coverageRatio == null ? 'unknown' : percent(point.coverageRatio)} · ${point.qualityState} · ${point.decisionState} · ${point.sourceInputSetFingerprint}`;
    const nav = `data-cfhl-evidence-nav data-ledger-fingerprint="${esc(point.ledgerFingerprint)}" data-input-set-fingerprint="${esc(point.sourceInputSetFingerprint)}" data-evidence-month="${esc(point.month)}" data-metric-key="${esc(point.metricKey)}" role="button" tabindex="0"`;
    if (point.missingValue) {
      return `<g ${nav}><text x="${x.toFixed(2)}" y="${(padTop + drawableHeight / 2).toFixed(2)}" class="cfhl-trend-missing">×<title>${esc(title)}</title></text><text x="${x.toFixed(2)}" y="${height - 10}" class="cfhl-trend-label">${esc(point.month)}</text></g>`;
    }
    const y = yAt(point.value);
    const status = point.decisionState === 'blocked_overlap_or_invalid_window' ? ' blocked' : (!point.coverageComplete ? ' partial' : '');
    return `<g ${nav}><circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="5" class="cfhl-trend-point${status}"><title>${esc(title)}</title></circle><text x="${x.toFixed(2)}" y="${height - 10}" class="cfhl-trend-label">${esc(point.month)}</text></g>`;
  }).join('');
  const chart = trend.points.length
    ? `<svg class="cfhl-trend-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(trend.metricLabel)} historical evidence trend"><line x1="${padX}" y1="${padTop + drawableHeight}" x2="${width - padX}" y2="${padTop + drawableHeight}" class="cfhl-trend-axis"/>${segments.join('')}${marks}</svg>`
    : '<div class="cfhl-empty">No monthly evidence points are available.</div>';
  return `${chart}<div class="cfhl-trend-meta"><b>${esc(trend.metricLabel)}</b> · points ${trend.pointCount} · partial ${trend.partialCoveragePointCount} · blocked ${trend.blockedPointCount} · missing ${trend.missingValueCount} · multi-evidence ${trend.multiEvidencePointCount}. Every point remains in the evidence sequence.</div>`;
}

function snapshotRow(item) {
  return `<tr>
    <td>${esc(item.reportStartDate || 'unknown')} → ${esc(item.reportEndDate || 'unknown')}</td>
    <td>${esc(item.qualityState || 'unknown')}<br>overlaps ${item.overlapPairCount} · gaps ${item.gapCount}</td>
    <td>${item.safeForNaiveAggregation ? 'safe' : 'blocked / review'}</td>
    <td>${item.contiguousCoverage ? 'contiguous' : 'incomplete / gap'}</td>
    <td>${item.monthlySnapshots.length}</td>
    <td><code>${esc(item.inputSetFingerprint)}</code></td>
  </tr>`;
}

function monthlyRow(item) {
  const multi = item.sameMonthMultipleSnapshots ? `<br><b>${item.sameMonthEvidenceCount} separate evidence rows</b>` : '';
  return `<tr data-cfhl-evidence-nav data-ledger-fingerprint="${esc(item.ledgerFingerprint)}" data-input-set-fingerprint="${esc(item.sourceInputSetFingerprint)}" data-evidence-month="${esc(item.month)}" data-metric-key="adContributionMicros" role="button" tabindex="0">
    <td><b>${esc(item.month)}</b>${multi}</td>
    <td>${money(item.spendMicros, item.currencyCode)}</td>
    <td>${money(item.salesMicros, item.currencyCode)}</td>
    <td>${item.orders}</td>
    <td>${percent(item.acos)}</td>
    <td>${decimal(item.roas)}</td>
    <td>${money(item.adContributionMicros, item.currencyCode)}</td>
    <td>${item.coverageRatio == null ? 'unknown' : percent(item.coverageRatio)}<br>${item.coverageComplete ? 'complete' : 'partial'}</td>
    <td>${esc(item.decisionState)}<br>${esc(item.qualityState)}</td>
    <td><code>${esc(item.sourceInputSetFingerprint)}</code></td>
  </tr>`;
}

function monthlyDecisionState(snapshot, monthly) {
  if (snapshot.safeForNaiveAggregation !== true) return 'blocked_overlap_or_invalid_window';
  if (monthly?.reliability?.state === 'blocked_overlap_or_invalid_window') return 'blocked_overlap_or_invalid_window';
  if (monthly?.coverage?.complete === true && snapshot.contiguousCoverage === true) return 'observed_review_only';
  return 'partial_coverage_review';
}

function assertLedgerForMonthlyWorkspace(ledger) {
  if (!ledger || ledger.schemaVersion !== CSV_HISTORY_LEDGER_SCHEMA_VERSION || !Array.isArray(ledger.snapshots)) throw monthlyWorkspaceError('CSV_HISTORY_MONTHLY_LEDGER_INVALID');
  const flags = [ledger.authority?.authoritative, ledger.authority?.canonicalAmazonIdentityResolved, ledger.authority?.governancePersistenceAllowed, ledger.authority?.executionAuthorized, ledger.authority?.amazonMutationAuthorized];
  if (flags.some((value) => value === true)) throw monthlyWorkspaceError('CSV_HISTORY_MONTHLY_AUTHORITY_ESCALATION_BLOCKED');
  if (!/^[a-f0-9]{64}$/i.test(String(ledger.ledgerFingerprint || ''))) throw monthlyWorkspaceError('CSV_HISTORY_MONTHLY_LEDGER_FINGERPRINT_INVALID');
  for (const snapshot of ledger.snapshots) {
    if (!/^[a-f0-9]{64}$/i.test(String(snapshot?.inputSetFingerprint || ''))) throw monthlyWorkspaceError('CSV_HISTORY_MONTHLY_SOURCE_FINGERPRINT_INVALID');
  }
}

function comparisonMetricValues(evidence) {
  const values = { ...evidence.metrics };
  if (values.adContributionMicros !== values.salesMicros - values.spendMicros) throw periodComparisonError('CSV_HISTORY_COMPARISON_CONTRIBUTION_MISMATCH');
  return values;
}
function comparisonEvidenceSummary(evidence) {
  return {
    evidenceKey: evidence.evidenceKey,
    selectedMonth: evidence.selectedMonth,
    metrics: evidence.metrics,
    coverage: evidence.coverage,
    decision: evidence.decision,
    source: evidence.source,
    observedIdentity: evidence.observedIdentity,
    period: evidence.period,
    authority: evidence.authority,
  };
}
function sameEvidenceKey(left, right) {
  return left.ledgerFingerprint === right.ledgerFingerprint && left.sourceInputSetFingerprint === right.sourceInputSetFingerprint && left.month === right.month;
}
function inclusiveDayCount(startDate, endDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(endDate || ''))) return null;
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.floor((end - start) / 86400000) + 1;
}
function comparisonReason(key) {
  return ({
    distinctEvidence: 'same_evidence_selected_twice',
    sourceFingerprintsDistinct: 'source_fingerprint_reused',
    coverageComplete: 'incomplete_coverage',
    safeForNaiveAggregation: 'unsafe_quality_state',
    contiguousCoverage: 'noncontiguous_coverage',
    decisionStatesReviewable: 'blocked_decision_state',
    qualityStateCompatible: 'quality_state_mismatch_or_unknown',
    historicalOverlapFree: 'historical_overlap_detected',
    observedIdentityUnambiguous: 'observed_identity_ambiguous_or_unknown',
    marketplaceCompatible: 'marketplace_mismatch_or_unknown',
    currencyCompatible: 'currency_mismatch_or_unknown',
    reportWindowsKnown: 'report_window_unknown',
    reportWindowLengthCompatible: 'report_window_length_incompatible',
    metricValuesComplete: 'comparison_metric_missing',
  })[key] || `comparison_gate_failed_${key}`;
}
function deltaDirection(delta) { return delta > 0 ? 'increase' : delta < 0 ? 'decrease' : 'flat'; }
function selectionLabel(selection) { return `${selection.month} · ${String(selection.sourceInputSetFingerprint || '').slice(0, 12)}`; }
function formatComparisonValue(value, unit, currency) {
  if (value == null || !Number.isFinite(Number(value))) return 'missing';
  if (unit === 'micros') return money(value, currency);
  if (unit === 'ratio') return decimal(value);
  return String(value);
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
function selectionHash(value, code) {
  const normalized = String(value || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw evidenceDrilldownError(code);
  return normalized;
}
function deepFreezeEvidence(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreezeEvidence(nested);
  return Object.freeze(value);
}
function safeInteger(value, code) { const number = Number(value); if (!Number.isSafeInteger(number)) throw monthlyWorkspaceError(code); return number; }
function finiteOrNull(value) { if (value == null) return null; const number = Number(value); if (!Number.isFinite(number)) throw monthlyWorkspaceError('CSV_HISTORY_MONTHLY_METRIC_INVALID'); return number; }
function money(micros, currency) { const value = Number(micros || 0) / 1_000_000; try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2 }).format(value); } catch { return value.toFixed(2); } }
function percent(value) { return value == null || !Number.isFinite(Number(value)) ? '—' : `${(Number(value) * 100).toFixed(1)}%`; }
function decimal(value) { return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(2); }
function formatTrendValue(value, unit) { if (value == null) return 'missing'; if (unit === 'micros') return money(value, 'USD'); if (unit === 'ratio') return decimal(value); return String(value); }
function monthlyWorkspaceError(code) { const error = new Error(code); error.name = 'CsvHistoryMonthlyWorkspaceError'; error.code = code; return error; }
function trendError(code) { const error = new Error(code); error.name = 'CsvHistoryTrendError'; error.code = code; return error; }
function evidenceDrilldownError(code) { const error = new Error(code); error.name = 'CsvHistoryEvidenceDrilldownError'; error.code = code; return error; }
function periodComparisonError(code) { const error = new Error(code); error.name = 'CsvHistoryPeriodComparisonError'; error.code = code; return error; }
function card(label, value) { return `<div class="cfhl-card"><small>${esc(label)}</small><div>${value}</div></div>`; }
function setBusy(root, busy) { state.busy = busy; syncButtons(root, document.querySelector('[data-csv-joint-status]')?.dataset.kind === 'success'); }
function syncButtons(root, jointReady) {
  root.querySelector('[data-cfhl-add]').disabled = state.busy || !jointReady;
  root.querySelector('[data-cfhl-download]').disabled = state.busy || !state.ledger;
  root.querySelector('[data-cfhl-import]').disabled = state.busy;
  root.querySelector('[data-cfhl-clear]').disabled = state.busy;
}
function setStatus(root, message, kind = '') { const node = root.querySelector('[data-cfhl-status]'); node.textContent = message; node.dataset.kind = kind; }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }

function installStyles() {
  if (document.getElementById('cfhl-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfhl-style-v1';
  style.textContent = '.cfhl{margin-top:14px;padding-top:14px;border-top:1px solid #e2e8f0}.cfhl-head,.cfhl-monthly-head{display:flex;justify-content:space-between;gap:12px}.cfhl-head small,.cfhl-monthly-head small{display:block;color:#64748b;max-width:780px}.cfhl-head>span,.cfhl-monthly-head>span{font-size:11px;font-weight:800}.cfhl-guard{margin-top:8px;padding:8px;border-radius:7px;background:#f8fafc;color:#475569}.cfhl-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:9px}.cfhl-actions label,.cfhl-actions button,.cfhl-trend select,.cfhl-comparison-actions button{border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;background:#fff;font:inherit;font-weight:700}.cfhl-actions input{max-width:220px}.cfhl-actions button,.cfhl-comparison-actions button{cursor:pointer}.cfhl-actions button:disabled{opacity:.45;cursor:not-allowed}.cfhl-status{margin-top:8px;padding:8px;border-radius:7px;background:#f8fafc}.cfhl-status[data-kind="bad"]{color:#b91c1c}.cfhl-status[data-kind="ok"]{color:#047857}.cfhl-body{margin-top:10px}.cfhl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}.cfhl-card{padding:9px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;overflow-wrap:anywhere}.cfhl-card small{display:block;color:#64748b}.cfhl-table-wrap{overflow:auto;margin-top:9px}.cfhl table{width:100%;border-collapse:collapse;font-size:12px}.cfhl th,.cfhl td{text-align:left;vertical-align:top;padding:7px;border-bottom:1px solid #e2e8f0}.cfhl code{font-size:11px;word-break:break-all}.cfhl details{margin-top:8px;border:1px solid #e2e8f0;border-radius:8px;padding:8px}.cfhl summary{cursor:pointer;font-weight:700}.cfhl pre{max-height:300px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#f8fafc;padding:8px;border-radius:6px}.cfhl-monthly,.cfhl-trend,.cfhl-evidence,.cfhl-comparison{margin-top:12px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#fff}.cfhl-trend-svg{width:100%;min-width:520px;display:block;margin-top:8px;overflow:visible}.cfhl-trend-axis{stroke:#cbd5e1;stroke-width:1}.cfhl-trend-line{stroke:#475569;stroke-width:2}.cfhl-trend-point{fill:#0f172a}.cfhl-trend-point.partial{fill:#b45309}.cfhl-trend-point.blocked{fill:#b91c1c}.cfhl-trend-label{font-size:10px;text-anchor:middle;fill:#64748b}.cfhl-trend-missing{font-size:18px;text-anchor:middle;fill:#64748b}.cfhl-trend-meta{font-size:12px;color:#475569;margin-top:6px}.cfhl-empty,.cfhl-evidence-empty,.cfhl-comparison-empty{padding:12px;color:#64748b}.cfhl [data-cfhl-evidence-nav]{cursor:pointer}.cfhl tr[data-cfhl-evidence-nav]:hover{background:#f8fafc}.cfhl [data-cfhl-evidence-nav]:focus{outline:2px solid #94a3b8;outline-offset:2px}.cfhl-evidence[data-kind="bad"],.cfhl-comparison[data-kind="bad"]{border-color:#fecaca}.cfhl-comparison[data-kind="blocked"]{border-color:#fde68a}.cfhl-evidence[data-kind="loading"],.cfhl-comparison[data-kind="loading"]{opacity:.8}.cfhl-evidence-grid{margin-top:9px}.cfhl-evidence-key{display:grid;grid-template-columns:auto 1fr;gap:5px 8px;align-items:start;margin-top:9px;padding:8px;border:1px solid #e2e8f0;border-radius:8px}.cfhl-evidence-key code{overflow-wrap:anywhere}.cfhl-comparison-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:9px}.cfhl-comparison ul{margin:8px 0 0 18px;padding:0}';
  document.head.appendChild(style);
}
