export const CSV_DATA_QUALITY_COMMAND_CENTER_SCHEMA_VERSION = 'csv-data-quality-command-center-v1';
export const CSV_DATA_QUALITY_COMMAND_CENTER_UI_VERSION = '1.0.0';

const state = { mounted: false, rendering: false, requestSeq: 0, model: null };
const NON_AUTHORITY = Object.freeze({
  mode: 'browser_local_decision_gate_only',
  authoritative: false,
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
});

export function buildCsvDataQualityCommandCenter(result) {
  assertCommandCenterSafe(result);
  const quality = result.dataQuality || {};
  const qualitySummary = quality.summary || {};
  const hierarchy = result.hierarchy || {};
  const hierarchySummary = hierarchy.summary || {};
  const periods = result.periods || {};
  const periodSummary = periods.summary || {};
  const identitySummary = result.observedIdentity?.summary || {};

  const aggregationSafe = quality.safeForNaiveAggregation === true;
  const contiguousCoverage = quality.contiguousCoverage === true;
  const invalidWindowCount = nonNegativeInteger(qualitySummary.invalidWindowCount);
  const overlapPairCount = nonNegativeInteger(qualitySummary.overlapPairCount);
  const exactDuplicateWindowCount = nonNegativeInteger(qualitySummary.exactDuplicateWindowCount);
  const gapCount = nonNegativeInteger(qualitySummary.gapCount);
  const gapDayCount = nonNegativeInteger(qualitySummary.gapDayCount);
  const ambiguousIdentityCount = nonNegativeInteger(identitySummary.ambiguousIdentityCount);
  const ambiguousHierarchyCount = nonNegativeInteger(hierarchySummary.ambiguousCampaignCount)
    + nonNegativeInteger(hierarchySummary.ambiguousAdGroupCount)
    + nonNegativeInteger(hierarchySummary.ambiguousTargetingCount);
  const incompletePeriodCount = nonNegativeInteger(periodSummary.incompleteTrailingComparisonCount);
  const blockedPeriodCount = nonNegativeInteger(periodSummary.blockedTrailingComparisonCount);
  const fullyCoveredPeriodCount = nonNegativeInteger(periodSummary.fullyCoveredTrailingComparisonCount);

  const issues = [];
  if (invalidWindowCount > 0) issues.push(issue(
    'invalid_date_evidence', 'blocker', 'aggregation', invalidWindowCount,
    'Invalid or missing report windows block analytical aggregation. Repair source date evidence before decision use.',
  ));
  if (overlapPairCount > 0) issues.push(issue(
    'overlap_double_count_risk', 'blocker', 'aggregation', overlapPairCount,
    `Overlapping report windows create double-count risk${exactDuplicateWindowCount ? `; ${exactDuplicateWindowCount} exact duplicate window(s) detected` : ''}. Review source windows; do not auto-dedupe business rows.`,
  ));
  if (gapCount > 0) issues.push(issue(
    'coverage_gap', 'constraint', 'coverage', gapCount,
    `${gapDayCount} uncovered day(s) across ${gapCount} gap(s). Aggregation may remain structurally safe, but period comparisons require coverage-aware review.`,
  ));
  if (ambiguousIdentityCount > 0 || ambiguousHierarchyCount > 0) issues.push(issue(
    'observed_identity_conflict', 'constraint', 'hierarchy', Math.max(ambiguousIdentityCount, ambiguousHierarchyCount),
    'Conflicting CSV-observed identity evidence blocks identity-dependent follow-up. Observed identity is never canonical Amazon identity.',
  ));
  if (blockedPeriodCount > 0) issues.push(issue(
    'period_comparison_blocked', 'blocker', 'period_comparisons', blockedPeriodCount,
    'One or more trailing comparisons are blocked because aggregation safety is not established.',
  ));
  if (incompletePeriodCount > 0) issues.push(issue(
    'period_coverage_incomplete', 'constraint', 'period_comparisons', incompletePeriodCount,
    'One or more trailing comparisons have incomplete current or previous coverage. Review ratios and absolute metrics with coverage context.',
  ));
  issues.push(issue(
    'canonical_amazon_identity_unresolved', 'info', 'identity', 1,
    'CSV-observed advertiser/profile/targeting evidence is non-authoritative. Canonical Amazon identity remains unresolved.',
  ));

  const gates = Object.freeze([
    gate('aggregation', aggregationSafe ? 'review_only' : 'blocked', aggregationSafe
      ? 'No invalid or overlapping report windows detected.'
      : 'Invalid or overlapping windows block analytical aggregation.'),
    gate('coverage', contiguousCoverage ? 'complete' : 'partial_or_gapped', contiguousCoverage
      ? 'Coverage is contiguous across the observed report span.'
      : 'Coverage contains one or more gaps or invalid date windows. No overlap does not imply complete coverage.'),
    gate('hierarchy', hierarchy.reliability?.analyticalDecisionUse || (aggregationSafe ? (contiguousCoverage ? 'review_only' : 'review_with_period_gap') : 'blocked'),
      ambiguousHierarchyCount > 0
        ? `${ambiguousHierarchyCount} ambiguous hierarchy observation(s) require identity review.`
        : 'Hierarchy remains CSV-observed and non-canonical.'),
    gate('period_comparisons', blockedPeriodCount > 0 ? 'blocked' : incompletePeriodCount > 0 ? 'review_with_constraints' : 'review_only',
      `${fullyCoveredPeriodCount} fully covered · ${incompletePeriodCount} incomplete · ${blockedPeriodCount} blocked trailing comparison(s).`),
    gate('observed_identity', ambiguousIdentityCount > 0 ? 'blocked_conflicts_present' : 'observed_only',
      ambiguousIdentityCount > 0
        ? `${ambiguousIdentityCount} ambiguous observed identity group(s). Canonical Amazon identity unresolved.`
        : 'Observed identity evidence has no detected conflict, but remains non-canonical.'),
  ]);

  const operatorState = !aggregationSafe
    ? 'blocked'
    : (!contiguousCoverage || ambiguousIdentityCount > 0 || ambiguousHierarchyCount > 0 || incompletePeriodCount > 0)
      ? 'review_with_constraints'
      : 'review_only';

  return Object.freeze({
    schemaVersion: CSV_DATA_QUALITY_COMMAND_CENTER_SCHEMA_VERSION,
    authority: NON_AUTHORITY,
    operatorState,
    source: Object.freeze({
      kind: 'csv_import_set',
      inputSetFingerprint: String(result.source.inputSetFingerprint).toLowerCase(),
      sourceReceiptCount: result.imports.length,
      receiptHashSetVerified: true,
      reportStartDate: result.range?.startDate || null,
      reportEndDate: result.range?.endDate || null,
    }),
    quality: Object.freeze({
      qualityState: quality.qualityState || 'unknown',
      safeForNaiveAggregation: aggregationSafe,
      contiguousCoverage,
      invalidWindowCount,
      overlapPairCount,
      exactDuplicateWindowCount,
      gapCount,
      gapDayCount,
      reportedWindowDayCount: nonNegativeInteger(qualitySummary.reportedWindowDayCount),
      uniqueCoveredDayCount: nonNegativeInteger(qualitySummary.uniqueCoveredDayCount),
      overlapExcessDayCount: nonNegativeInteger(qualitySummary.overlapExcessDayCount),
      coverageSpanDayCount: nonNegativeInteger(qualitySummary.coverageSpanDayCount),
    }),
    identity: Object.freeze({
      identityCount: nonNegativeInteger(identitySummary.identityCount),
      resolvedObservedIdCount: nonNegativeInteger(identitySummary.resolvedIdCount),
      ambiguousIdentityCount,
      ambiguousHierarchyCount,
      canonicalAmazonIdentityResolved: false,
    }),
    periods: Object.freeze({
      fullyCoveredTrailingComparisonCount: fullyCoveredPeriodCount,
      incompleteTrailingComparisonCount: incompletePeriodCount,
      blockedTrailingComparisonCount: blockedPeriodCount,
    }),
    gates,
    issueSummary: Object.freeze({
      blockerCount: issues.filter((item) => item.severity === 'blocker').length,
      constraintCount: issues.filter((item) => item.severity === 'constraint').length,
      infoCount: issues.filter((item) => item.severity === 'info').length,
    }),
    issues: Object.freeze(issues),
  });
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvDataQualityCommandCenter', {
    value: Object.freeze({
      version: CSV_DATA_QUALITY_COMMAND_CENTER_UI_VERSION,
      schemaVersion: CSV_DATA_QUALITY_COMMAND_CENTER_SCHEMA_VERSION,
      authority: 'browser_local_decision_gate_only',
      buildCsvDataQualityCommandCenter,
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
  if (joint.querySelector('[data-csv-data-quality-command-center]')) return void (state.mounted = true);

  installStyles();
  const root = document.createElement('section');
  root.className = 'cfdqcc';
  root.dataset.csvDataQualityCommandCenter = CSV_DATA_QUALITY_COMMAND_CENTER_UI_VERSION;
  root.innerHTML = `
    <div class="cfdqcc-head">
      <div><b>Data Quality Command Center</b><small>Decision gate matrix from browser-local CSV evidence. It does not authorize persistence, execution, or Amazon mutation.</small></div>
      <span>local evidence · no authority</span>
    </div>
    <div class="cfdqcc-status" data-cfdqcc-status>Run Joint CSV Analysis to evaluate data decision gates.</div>
    <div data-cfdqcc-body hidden></div>`;
  joint.appendChild(root);

  joint.querySelector('[data-csv-joint-files]')?.addEventListener('change', () => clear(root, 'CSV selection changed. Run Joint CSV Analysis again.'));
  joint.querySelector('[data-csv-joint-clear]')?.addEventListener('click', () => clear(root, 'Local decision-gate view cleared.'));
  const jointStatus = joint.querySelector('[data-csv-joint-status]');
  if (jointStatus) {
    const sync = () => {
      if (jointStatus.dataset.kind === 'success') void refresh(root, joint);
      else if (jointStatus.dataset.kind === 'error') clear(root, 'Joint CSV Analysis did not complete successfully.', 'bad');
    };
    new MutationObserver(sync).observe(jointStatus, { attributes: true, childList: true, characterData: true, subtree: true });
    sync();
  }
  state.mounted = true;
}

async function refresh(root, joint) {
  if (state.rendering) return;
  const files = [...(joint.querySelector('[data-csv-joint-files]')?.files || [])];
  if (!files.length || typeof window.CloudflareCsvJointAnalysis?.analyzeLocalCsvInputs !== 'function') return;
  const seq = ++state.requestSeq;
  state.rendering = true;
  status(root, `Evaluating decision gates locally from ${files.length} file${files.length === 1 ? '' : 's'}…`, 'loading');
  try {
    const inputs = await Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() })));
    if (seq !== state.requestSeq) return;
    const result = await window.CloudflareCsvJointAnalysis.analyzeLocalCsvInputs(inputs);
    if (seq !== state.requestSeq) return;
    state.model = buildCsvDataQualityCommandCenter(result);
    render(root, state.model);
    status(root, `Decision gate state: ${state.model.operatorState}. Fingerprint ${state.model.source.inputSetFingerprint.slice(0, 12)} · receipt/hash set verified.`, state.model.operatorState === 'blocked' ? 'bad' : state.model.operatorState === 'review_with_constraints' ? 'warn' : 'ok');
  } catch (error) {
    if (seq !== state.requestSeq) return;
    state.model = null;
    root.querySelector('[data-cfdqcc-body]').hidden = true;
    status(root, `Decision gate evaluation failed: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    if (seq === state.requestSeq) state.rendering = false;
  }
}

function clear(root, message, kind = '') {
  state.requestSeq += 1;
  state.rendering = false;
  state.model = null;
  const body = root.querySelector('[data-cfdqcc-body]');
  body.hidden = true;
  body.innerHTML = '';
  status(root, message, kind);
}

function render(root, model) {
  const body = root.querySelector('[data-cfdqcc-body]');
  body.hidden = false;
  body.innerHTML = `
    <div class="cfdqcc-cards">
      ${card('Operator state', model.operatorState)}
      ${card('Quality state', model.quality.qualityState)}
      ${card('Source receipts', `${num(model.source.sourceReceiptCount)} · hash set verified`)}
      ${card('Coverage', model.quality.contiguousCoverage ? 'contiguous' : `${num(model.quality.gapCount)} gap(s) · ${num(model.quality.gapDayCount)} day(s)`)}
      ${card('Overlap risk', model.quality.overlapPairCount ? `${num(model.quality.overlapPairCount)} pair(s) · blocked` : 'none detected')}
      ${card('Identity conflicts', `${num(model.identity.ambiguousIdentityCount)} observed · ${num(model.identity.ambiguousHierarchyCount)} hierarchy`)}
    </div>
    <div class="cfdqcc-rule"><b>No overlap ≠ complete coverage.</b> Aggregation safety and coverage completeness are separate gates. <b>Observed CSV identity ≠ canonical Amazon identity.</b></div>
    <div class="cfdqcc-gates"><h4>Decision gate matrix</h4>${model.gates.map(gateRow).join('')}</div>
    <div class="cfdqcc-issues"><h4>Prioritized evidence issues</h4>${issuesTable(model.issues)}</div>
    <div class="cfdqcc-foot"><span>Input-set fingerprint</span><code>${esc(model.source.inputSetFingerprint)}</code><span>Range</span><b>${esc(model.source.reportStartDate || '—')} → ${esc(model.source.reportEndDate || '—')}</b><span>Canonical identity</span><b>unresolved</b></div>
    <div class="cfdqcc-discipline"><b>Blocked means analytical decision use is blocked; the evidence remains observable.</b> This command center never grants persistence, execution, or Amazon mutation authority.</div>`;
}

function gateRow(item) {
  const cls = item.state === 'blocked' || item.state === 'blocked_conflicts_present' ? 'bad' : item.state === 'review_with_constraints' || item.state === 'review_with_period_gap' || item.state === 'partial_or_gapped' ? 'warn' : 'ok';
  return `<div class="cfdqcc-gate ${cls}"><b>${esc(gateLabel(item.scope))}</b><span>${esc(item.state)}</span><small>${esc(item.explanation)}</small></div>`;
}

function issuesTable(items) {
  if (!items.length) return '<p>No decision-gate issues detected.</p>';
  return `<div class="cfdqcc-table"><table><thead><tr><th>Severity</th><th>Scope</th><th>Issue</th><th>Evidence</th><th>Operator action</th></tr></thead><tbody>${items.map((item) => `<tr><td class="${item.severity === 'blocker' ? 'bad' : item.severity === 'constraint' ? 'warn' : ''}"><b>${esc(item.severity)}</b></td><td>${esc(item.scope)}</td><td><code>${esc(item.code)}</code></td><td>${num(item.evidenceCount)}</td><td>${esc(item.operatorAction)}</td></tr>`).join('')}</tbody></table></div>`;
}

function assertCommandCenterSafe(result) {
  if (!result || typeof result !== 'object') throw commandCenterError('CSV_DATA_QUALITY_COMMAND_CENTER_RESULT_REQUIRED');
  if (result.source?.kind !== 'csv_import_set') throw commandCenterError('CSV_DATA_QUALITY_COMMAND_CENTER_SOURCE_KIND_INVALID');
  if (!/^[a-f0-9]{64}$/i.test(String(result.source?.inputSetFingerprint || ''))) throw commandCenterError('CSV_DATA_QUALITY_COMMAND_CENTER_FINGERPRINT_INVALID');
  if (!Array.isArray(result.imports) || result.imports.length === 0) throw commandCenterError('CSV_DATA_QUALITY_COMMAND_CENTER_IMPORTS_REQUIRED');

  const receiptHashes = result.imports.map((item) => {
    const hash = String(item?.contentSha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) throw commandCenterError('CSV_DATA_QUALITY_COMMAND_CENTER_CONTENT_HASH_INVALID');
    return hash;
  });
  const sourceHashes = Array.isArray(result.source?.contentSha256s)
    ? result.source.contentSha256s.map((value) => String(value || '').toLowerCase())
    : [];
  if (sourceHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) throw commandCenterError('CSV_DATA_QUALITY_COMMAND_CENTER_SOURCE_HASH_SET_INVALID');
  if (new Set(receiptHashes).size !== receiptHashes.length || new Set(sourceHashes).size !== sourceHashes.length) {
    throw commandCenterError('CSV_DATA_QUALITY_COMMAND_CENTER_DUPLICATE_HASH_EVIDENCE');
  }
  const receiptsSorted = [...receiptHashes].sort();
  const sourceSorted = [...sourceHashes].sort();
  if (receiptsSorted.length !== sourceSorted.length || receiptsSorted.some((hash, index) => hash !== sourceSorted[index])) {
    throw commandCenterError('CSV_DATA_QUALITY_COMMAND_CENTER_SOURCE_RECEIPT_MISMATCH');
  }
  if (result.source?.batchCount != null && Number(result.source.batchCount) !== result.imports.length) {
    throw commandCenterError('CSV_DATA_QUALITY_COMMAND_CENTER_BATCH_COUNT_MISMATCH');
  }

  const flags = [
    result.source?.canonicalAmazonIdentityResolved,
    result.source?.governancePersistenceAllowed,
    result.source?.executionAuthorized,
    result.source?.amazonMutationAuthorized,
    result.dataQuality?.authority?.authoritative,
    result.dataQuality?.authority?.governancePersistenceAllowed,
    result.dataQuality?.authority?.executionAuthorized,
    result.dataQuality?.authority?.amazonMutationAuthorized,
    result.analysis?.authority?.authoritative,
    result.analysis?.authority?.governancePersistenceAllowed,
    result.analysis?.authority?.executionAuthorized,
    result.analysis?.authority?.amazonMutationAuthorized,
    result.hierarchy?.authority?.authoritative,
    result.hierarchy?.authority?.governancePersistenceAllowed,
    result.hierarchy?.authority?.executionAuthorized,
    result.hierarchy?.authority?.amazonMutationAuthorized,
    result.periods?.authority?.authoritative,
    result.periods?.authority?.governancePersistenceAllowed,
    result.periods?.authority?.executionAuthorized,
    result.periods?.authority?.amazonMutationAuthorized,
    result.observedIdentity?.authority?.authoritative,
    result.observedIdentity?.authority?.governancePersistenceAllowed,
    result.observedIdentity?.authority?.executionAuthorized,
    result.observedIdentity?.authority?.amazonMutationAuthorized,
  ];
  if (flags.some((value) => value === true)) throw commandCenterError('CSV_DATA_QUALITY_COMMAND_CENTER_AUTHORITY_ESCALATION_BLOCKED');
}

function issue(code, severity, scope, evidenceCount, operatorAction) {
  return Object.freeze({ code, severity, scope, evidenceCount: nonNegativeInteger(evidenceCount), operatorAction });
}
function gate(scope, stateValue, explanation) { return Object.freeze({ scope, state: stateValue, explanation }); }
function gateLabel(scope) { return ({ aggregation: 'Aggregation', coverage: 'Coverage', hierarchy: 'Hierarchy', period_comparisons: 'Period comparisons', observed_identity: 'Observed identity' })[scope] || scope; }
function nonNegativeInteger(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0; }
function card(label, value) { return `<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`; }
function num(value) { return value == null || !Number.isFinite(Number(value)) ? '0' : Math.round(Number(value)).toLocaleString(); }
function status(root, message, kind = '') { const node = root.querySelector('[data-cfdqcc-status]'); node.textContent = message; node.dataset.kind = kind; }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function commandCenterError(code) { const error = new Error(code); error.name = 'CsvDataQualityCommandCenterError'; error.code = code; return error; }

function installStyles() {
  if (document.getElementById('cfdqcc-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfdqcc-style-v1';
  style.textContent = '.cfdqcc{margin-top:14px;padding-top:14px;border-top:1px solid #e2e8f0}.cfdqcc-head{display:flex;justify-content:space-between;gap:12px}.cfdqcc-head small{display:block;color:#64748b;max-width:780px}.cfdqcc-head>span{font-size:11px;font-weight:800}.cfdqcc-status,.cfdqcc-rule,.cfdqcc-discipline{margin-top:9px;padding:8px;border-radius:7px;background:#f8fafc}.cfdqcc-status[data-kind="bad"],.cfdqcc .bad{color:#b91c1c}.cfdqcc-status[data-kind="warn"],.cfdqcc .warn{color:#a16207}.cfdqcc-status[data-kind="ok"],.cfdqcc .ok{color:#047857}.cfdqcc-cards{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin-top:9px}.cfdqcc-cards>div{border:1px solid #e2e8f0;border-radius:7px;padding:8px}.cfdqcc-cards span{display:block;color:#64748b;font-size:10px}.cfdqcc-cards b{display:block;margin-top:2px}.cfdqcc h4{margin:12px 0 6px}.cfdqcc-gate{display:grid;grid-template-columns:150px 190px 1fr;gap:9px;padding:8px;border-top:1px solid #edf2f7;align-items:start}.cfdqcc-gate span{font-weight:800}.cfdqcc-gate small{color:#64748b}.cfdqcc-table{overflow:auto}.cfdqcc table{width:100%;border-collapse:collapse;font-size:11px}.cfdqcc th,.cfdqcc td{padding:6px;border-bottom:1px solid #edf2f7;text-align:left;vertical-align:top}.cfdqcc th{font-size:9px;color:#64748b;text-transform:uppercase}.cfdqcc code{font-size:10px;word-break:break-all}.cfdqcc-foot{display:grid;grid-template-columns:auto minmax(220px,2fr) auto 1fr auto 1fr;gap:7px;margin-top:9px;padding:8px;background:#f8fafc;font-size:10px;align-items:start}.cfdqcc-foot span{color:#64748b}.cfdqcc-discipline{font-size:10px;color:#64748b}@media(max-width:900px){.cfdqcc-cards{grid-template-columns:repeat(2,minmax(0,1fr))}.cfdqcc-gate{grid-template-columns:1fr}.cfdqcc-foot{grid-template-columns:1fr 2fr}}@media(max-width:600px){.cfdqcc-cards{grid-template-columns:1fr}}';
  document.head.appendChild(style);
}