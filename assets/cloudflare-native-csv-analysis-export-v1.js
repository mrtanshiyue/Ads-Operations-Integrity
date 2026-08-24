export const CSV_ANALYSIS_EXPORT_SCHEMA_VERSION = 'csv-analysis-export-v1';
export const CSV_ANALYSIS_EXPORT_UI_VERSION = '1.0.0';
export const CSV_OPERATOR_PACKAGE_SCHEMA_VERSION = 'csv-operator-package-v1';

const state = { mounted: false, busy: false, exportGeneration: 0 };
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_STORE_METHOD = 0;
const ZIP_DOS_TIME = 0;
const ZIP_DOS_DATE = 0x0021;

export function buildCsvAnalysisExportBundle(result) {
  assertAdvisoryOnly(result);
  return Object.freeze({
    exportSchemaVersion: CSV_ANALYSIS_EXPORT_SCHEMA_VERSION,
    authority: Object.freeze({
      mode: 'local_operator_export_only',
      authoritative: false,
      canonicalAmazonIdentityResolved: false,
      governancePersistenceAllowed: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    }),
    source: Object.freeze({
      inputSetFingerprint: result.source.inputSetFingerprint,
      contentSha256s: Object.freeze([...(result.source.contentSha256s || [])]),
      reportStartDate: result.range?.startDate || null,
      reportEndDate: result.range?.endDate || null,
    }),
    jointAnalysis: result,
  });
}

export function buildCandidateReviewCsv(result) {
  assertAdvisoryOnly(result);
  const rows = [];
  for (const item of result.analysis?.negativeSuggestions || []) {
    rows.push(candidateRow(result, item, item.matchScope === 'exact' ? 'negative_exact' : 'negative_phrase_review', 'negative_keyword_library', item.matchScope === 'exact' ? 'EXACT' : 'PHRASE_REVIEW'));
  }
  for (const item of result.analysis?.harvestSuggestions || []) {
    rows.push(candidateRow(result, item, 'keyword_harvest', 'keyword_library', item.matchScope === 'exact_review' ? 'EXACT_REVIEW' : 'REVIEW'));
  }
  rows.sort((a, b) => a.destination.localeCompare(b.destination) || b.priority_score - a.priority_score || a.value.localeCompare(b.value));
  return toCsv([
    'candidate_type','destination','value','match_intent','rationale_code','priority_score',
    'spend','sales','orders','acos','requires_human_review','canonical_amazon_identity_resolved',
    'persistence_authorized','execution_authorized','amazon_mutation_authorized','input_set_fingerprint',
    'report_start_date','report_end_date',
  ], rows);
}

export function buildHierarchyCsv(result) {
  assertAdvisoryOnly(result);
  const hierarchy = result.hierarchy || {};
  const rows = [];
  for (const [level, items] of [['campaign', hierarchy.campaigns || []], ['ad_group', hierarchy.adGroups || []], ['targeting', hierarchy.targetings || []]]) {
    for (const item of items) rows.push(hierarchyRow(result, level, item));
  }
  return toCsv([
    'level','campaign_id','campaign_name','ad_group_id','ad_group_name','targeting_id','targeting_text','match_type',
    'spend','sales','orders','acos','roas','cvr','cpc','ad_contribution','profitability_basis','performance_band',
    'identity_state','identity_confidence','identity_ambiguous','identity_conflicts','reliability_state','decision_use',
    'requires_human_review','canonical_amazon_identity_resolved','persistence_authorized','execution_authorized',
    'amazon_mutation_authorized','input_set_fingerprint',
  ], rows);
}

export function buildPeriodCsv(result) {
  assertAdvisoryOnly(result);
  const rows = [];
  for (const item of result.periods?.trailingComparisons || []) {
    rows.push(periodRow(result, `trailing_${item.days}d_current`, `${item.days}d current`, item.current, item.reliability));
    rows.push(periodRow(result, `trailing_${item.days}d_previous`, `${item.days}d previous`, item.previous, item.reliability));
  }
  for (const item of result.periods?.monthlySnapshots || []) {
    rows.push(periodRow(result, 'calendar_month', item.month, item, item.reliability));
  }
  return toCsv([
    'row_type','label','start_date','end_date','expected_days','covered_days','coverage_ratio','spend','sales','orders',
    'acos','roas','cvr','cpc','ad_contribution','profitability_basis','reliability_state','decision_use',
    'canonical_amazon_identity_resolved','persistence_authorized','execution_authorized','amazon_mutation_authorized',
    'input_set_fingerprint',
  ], rows);
}

export function buildCsvOperatorPackageFiles(result) {
  assertAdvisoryOnly(result);
  const fingerprint = result.source.inputSetFingerprint;
  const shortFingerprint = fingerprint.slice(0, 12);
  const payloads = [
    textPackageFile('README.txt', buildOperatorReadme(result)),
    textPackageFile('advisory.json', JSON.stringify(buildCsvAnalysisExportBundle(result), null, 2)),
    textPackageFile('candidate-review.csv', buildCandidateReviewCsv(result)),
    textPackageFile('hierarchy.csv', buildHierarchyCsv(result)),
    textPackageFile('periods.csv', buildPeriodCsv(result)),
  ];
  const manifest = Object.freeze({
    schemaVersion: CSV_OPERATOR_PACKAGE_SCHEMA_VERSION,
    authority: Object.freeze({
      mode: 'local_operator_package_only',
      authoritative: false,
      canonicalAmazonIdentityResolved: false,
      governancePersistenceAllowed: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    }),
    source: Object.freeze({
      inputSetFingerprint: fingerprint,
      shortFingerprint,
      contentSha256s: Object.freeze([...(result.source.contentSha256s || [])]),
      reportStartDate: result.range?.startDate || null,
      reportEndDate: result.range?.endDate || null,
    }),
    package: Object.freeze({
      archiveFormat: 'zip_store_utf8',
      deterministicTimestamp: '1980-01-01T00:00:00Z',
      reportFileCount: payloads.length,
      files: Object.freeze(payloads.map((file) => Object.freeze({
        name: file.name,
        byteLength: file.byteLength,
        crc32: file.crc32,
      }))),
    }),
    notes: Object.freeze([
      'Local advisory evidence only.',
      'Observed CSV identity is not canonical Amazon identity.',
      'Persistence, execution, and Amazon mutation authority remain disabled.',
      'Ad contribution = Sales - Ad Spend only; it is not net profit.',
    ]),
  });
  const manifestFile = textPackageFile('manifest.json', JSON.stringify(manifest, null, 2));
  return Object.freeze([manifestFile, ...payloads]);
}

export function buildStoredZip(files) {
  if (!Array.isArray(files) || !files.length) throw exportError('CSV_OPERATOR_PACKAGE_FILES_REQUIRED');
  const encoder = new TextEncoder();
  const seen = new Set();
  const entries = files.map((file) => {
    const name = String(file?.name || '');
    if (!isSafeZipEntryName(name) || seen.has(name)) throw exportError('CSV_OPERATOR_PACKAGE_ENTRY_NAME_INVALID');
    seen.add(name);
    const nameBytes = encoder.encode(name);
    const data = file.bytes instanceof Uint8Array ? file.bytes : encoder.encode(String(file?.text ?? ''));
    if (nameBytes.length > 0xffff || data.length > 0xffffffff) throw exportError('CSV_OPERATOR_PACKAGE_ENTRY_TOO_LARGE');
    const crc = crc32Bytes(data);
    return { name, nameBytes, data, crc };
  });
  if (entries.length > 0xffff) throw exportError('CSV_OPERATOR_PACKAGE_TOO_MANY_ENTRIES');

  const localChunks = [];
  const centralChunks = [];
  let localOffset = 0;
  for (const entry of entries) {
    const localHeader = new Uint8Array(30 + entry.nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    write32(localView, 0, 0x04034b50);
    write16(localView, 4, 20);
    write16(localView, 6, ZIP_UTF8_FLAG);
    write16(localView, 8, ZIP_STORE_METHOD);
    write16(localView, 10, ZIP_DOS_TIME);
    write16(localView, 12, ZIP_DOS_DATE);
    write32(localView, 14, entry.crc);
    write32(localView, 18, entry.data.length);
    write32(localView, 22, entry.data.length);
    write16(localView, 26, entry.nameBytes.length);
    write16(localView, 28, 0);
    localHeader.set(entry.nameBytes, 30);
    localChunks.push(localHeader, entry.data);

    const centralHeader = new Uint8Array(46 + entry.nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    write32(centralView, 0, 0x02014b50);
    write16(centralView, 4, 20);
    write16(centralView, 6, 20);
    write16(centralView, 8, ZIP_UTF8_FLAG);
    write16(centralView, 10, ZIP_STORE_METHOD);
    write16(centralView, 12, ZIP_DOS_TIME);
    write16(centralView, 14, ZIP_DOS_DATE);
    write32(centralView, 16, entry.crc);
    write32(centralView, 20, entry.data.length);
    write32(centralView, 24, entry.data.length);
    write16(centralView, 28, entry.nameBytes.length);
    write16(centralView, 30, 0);
    write16(centralView, 32, 0);
    write16(centralView, 34, 0);
    write16(centralView, 36, 0);
    write32(centralView, 38, 0);
    write32(centralView, 42, localOffset);
    centralHeader.set(entry.nameBytes, 46);
    centralChunks.push(centralHeader);
    localOffset += localHeader.length + entry.data.length;
  }

  const centralOffset = localOffset;
  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  write32(endView, 0, 0x06054b50);
  write16(endView, 4, 0);
  write16(endView, 6, 0);
  write16(endView, 8, entries.length);
  write16(endView, 10, entries.length);
  write32(endView, 12, centralSize);
  write32(endView, 16, centralOffset);
  write16(endView, 20, 0);
  return concatBytes([...localChunks, ...centralChunks, end]);
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvAnalysisExport', {
    value: Object.freeze({
      version: CSV_ANALYSIS_EXPORT_UI_VERSION,
      schemaVersion: CSV_ANALYSIS_EXPORT_SCHEMA_VERSION,
      operatorPackageSchemaVersion: CSV_OPERATOR_PACKAGE_SCHEMA_VERSION,
      authority: 'local_operator_export_only',
      buildCsvAnalysisExportBundle,
      buildCandidateReviewCsv,
      buildHierarchyCsv,
      buildPeriodCsv,
      buildCsvOperatorPackageFiles,
      buildStoredZip,
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
  if (joint.querySelector('[data-csv-analysis-export]')) return void (state.mounted = true);
  installStyles();
  const root = document.createElement('section');
  root.className = 'cfae';
  root.dataset.csvAnalysisExport = CSV_ANALYSIS_EXPORT_UI_VERSION;
  root.innerHTML = `
    <div class="cfae-head"><div><b>Local Analysis Export</b><small>Download operator-facing evidence files from the currently selected CSV inputs. Ad contribution = Sales - Ad Spend only; it is not net profit.</small></div><span>local files only</span></div>
    <div class="cfae-actions">
      <button type="button" data-cfae-kind="package" disabled>Operator package ZIP</button>
      <button type="button" data-cfae-kind="json" disabled>Full advisory JSON</button>
      <button type="button" data-cfae-kind="candidates" disabled>Candidate review CSV</button>
      <button type="button" data-cfae-kind="hierarchy" disabled>Hierarchy CSV</button>
      <button type="button" data-cfae-kind="periods" disabled>Period CSV</button>
    </div>
    <div class="cfae-status" data-cfae-status>Run Joint CSV Analysis before exporting. Exports do not write D1/R2, governance libraries, optimization state, or Amazon Ads.</div>`;
  const review = joint.querySelector('[data-csv-library-review]');
  if (review) review.insertAdjacentElement('beforebegin', root); else joint.appendChild(root);

  root.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-cfae-kind]');
    if (!button || button.disabled) return;
    void exportCurrent(root, joint, button.dataset.cfaeKind);
  });
  const jointStatus = joint.querySelector('[data-csv-joint-status]');
  if (jointStatus) {
    const sync = () => setEnabled(root, jointStatus.dataset.kind === 'success');
    new MutationObserver(sync).observe(jointStatus, { attributes: true, childList: true, characterData: true, subtree: true });
    sync();
  }
  joint.querySelector('[data-csv-joint-files]')?.addEventListener('change', () => {
    state.exportGeneration += 1;
    state.busy = false;
    setEnabled(root, false);
    status(root, 'CSV selection changed. Run Joint CSV Analysis again before exporting.');
  });
  joint.querySelector('[data-csv-joint-clear]')?.addEventListener('click', () => {
    state.exportGeneration += 1;
    state.busy = false;
    setEnabled(root, false);
    status(root, 'Local export state cleared.');
  });
  state.mounted = true;
}

async function exportCurrent(root, joint, kind) {
  if (state.busy) return;
  const files = [...(joint.querySelector('[data-csv-joint-files]')?.files || [])];
  if (!files.length || typeof window.CloudflareCsvJointAnalysis?.analyzeLocalCsvInputs !== 'function') return status(root, 'Joint CSV inputs are unavailable.', 'bad');
  const generation = ++state.exportGeneration;
  state.busy = true;
  setEnabled(root, false);
  status(root, `Building ${kind} export locally…`, 'loading');
  try {
    const inputs = await Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() })));
    if (generation !== state.exportGeneration) return;
    const result = await window.CloudflareCsvJointAnalysis.analyzeLocalCsvInputs(inputs);
    if (generation !== state.exportGeneration) return;
    const fingerprint = String(result.source.inputSetFingerprint || '').slice(0, 12) || 'local';
    if (kind === 'package') {
      const packageFiles = buildCsvOperatorPackageFiles(result);
      const zip = buildStoredZip(packageFiles);
      downloadBytes(`ads-ops-${fingerprint}-operator-package.zip`, zip, 'application/zip');
    } else if (kind === 'json') downloadText(`ads-ops-${fingerprint}-advisory.json`, JSON.stringify(buildCsvAnalysisExportBundle(result), null, 2), 'application/json;charset=utf-8');
    else if (kind === 'candidates') downloadText(`ads-ops-${fingerprint}-candidate-review.csv`, buildCandidateReviewCsv(result), 'text/csv;charset=utf-8');
    else if (kind === 'hierarchy') downloadText(`ads-ops-${fingerprint}-hierarchy.csv`, buildHierarchyCsv(result), 'text/csv;charset=utf-8');
    else if (kind === 'periods') downloadText(`ads-ops-${fingerprint}-periods.csv`, buildPeriodCsv(result), 'text/csv;charset=utf-8');
    else throw exportError('CSV_ANALYSIS_EXPORT_KIND_UNSUPPORTED');
    status(root, `${kind} export created locally for input set ${fingerprint}. Remote persistence and Amazon mutation remain disabled.`, 'ok');
  } catch (error) {
    if (generation !== state.exportGeneration) return;
    status(root, `Local export failed: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    if (generation !== state.exportGeneration) return;
    state.busy = false;
    setEnabled(root, true);
  }
}

function assertAdvisoryOnly(result) {
  if (!result || typeof result !== 'object') throw exportError('CSV_ANALYSIS_EXPORT_RESULT_REQUIRED');
  if (!/^[a-f0-9]{64}$/i.test(String(result.source?.inputSetFingerprint || ''))) throw exportError('CSV_ANALYSIS_EXPORT_FINGERPRINT_INVALID');
  const flags = [
    result.source?.canonicalAmazonIdentityResolved,
    result.source?.governancePersistenceAllowed,
    result.source?.executionAuthorized,
    result.source?.amazonMutationAuthorized,
    result.analysis?.authority?.authoritative,
    result.analysis?.authority?.governancePersistenceAllowed,
    result.analysis?.authority?.executionAuthorized,
    result.analysis?.authority?.amazonMutationAuthorized,
    result.hierarchy?.authority?.authoritative,
    result.hierarchy?.authority?.executionAuthorized,
    result.hierarchy?.authority?.amazonMutationAuthorized,
    result.periods?.authority?.authoritative,
    result.periods?.authority?.executionAuthorized,
    result.periods?.authority?.amazonMutationAuthorized,
  ];
  if (flags.some((value) => value === true)) throw exportError('CSV_ANALYSIS_EXPORT_AUTHORITY_ESCALATION_BLOCKED');
}

function buildOperatorReadme(result) {
  return [
    'Ads Operations Integrity — Local Operator Package',
    '',
    `Input-set fingerprint: ${result.source.inputSetFingerprint}`,
    `Report range: ${result.range?.startDate || 'unknown'} to ${result.range?.endDate || 'unknown'}`,
    '',
    'Authority: local advisory evidence only.',
    'Observed CSV identity is not canonical Amazon identity.',
    'Governance persistence is disabled.',
    'Execution is disabled.',
    'Amazon mutation is disabled.',
    'Ad contribution = Sales - Ad Spend only; it is not net profit.',
    '',
    'Files:',
    '- manifest.json — package evidence index, byte lengths, CRC32 values, and authority boundary',
    '- advisory.json — full Joint CSV Analysis advisory object',
    '- candidate-review.csv — keyword / negative review candidates',
    '- hierarchy.csv — campaign / ad group / targeting analytical hierarchy',
    '- periods.csv — trailing-window and calendar-month analytics',
    '',
  ].join('\n');
}

function textPackageFile(name, text) {
  const bytes = new TextEncoder().encode(String(text));
  return Object.freeze({ name, text: String(text), byteLength: bytes.length, crc32: crc32Hex(bytes), bytes });
}

function candidateRow(result, item, candidateType, destination, matchIntent) {
  const metrics = item.metrics || {};
  return {
    candidate_type: candidateType,
    destination,
    value: item.value || '',
    match_intent: matchIntent,
    rationale_code: item.rationaleCode || '',
    priority_score: numberOrBlank(item.priorityScore),
    spend: moneyNumber(metrics.spendMicros),
    sales: moneyNumber(metrics.salesMicros),
    orders: numberOrBlank(metrics.orders ?? metrics.purchases),
    acos: numberOrBlank(metrics.acos),
    requires_human_review: item.requiresHumanReview === true,
    canonical_amazon_identity_resolved: false,
    persistence_authorized: false,
    execution_authorized: false,
    amazon_mutation_authorized: false,
    input_set_fingerprint: result.source.inputSetFingerprint,
    report_start_date: result.range?.startDate || '',
    report_end_date: result.range?.endDate || '',
  };
}

function hierarchyRow(result, level, item) {
  const identity = item.identity || {};
  const metrics = item.metrics || {};
  const observed = item.observedIdentity || {};
  return {
    level,
    campaign_id: identity.campaign?.id || '',
    campaign_name: identity.campaign?.name || '',
    ad_group_id: identity.adGroup?.id || '',
    ad_group_name: identity.adGroup?.name || '',
    targeting_id: identity.targeting?.id || '',
    targeting_text: identity.targeting?.text || '',
    match_type: identity.targeting?.matchType || '',
    spend: moneyNumber(metrics.spendMicros),
    sales: moneyNumber(metrics.salesMicros),
    orders: numberOrBlank(metrics.orders),
    acos: numberOrBlank(metrics.acos),
    roas: numberOrBlank(metrics.roas),
    cvr: numberOrBlank(metrics.cvr),
    cpc: moneyNumber(metrics.cpcMicros),
    ad_contribution: moneyNumber(item.adContributionMicros),
    profitability_basis: item.profitabilityBasis || '',
    performance_band: item.performanceBand || '',
    identity_state: observed.state || '',
    identity_confidence: observed.confidence || '',
    identity_ambiguous: observed.ambiguous === true,
    identity_conflicts: (observed.conflictCodes || []).join('|'),
    reliability_state: item.reliability?.state || '',
    decision_use: item.reliability?.analyticalDecisionUse || '',
    requires_human_review: item.requiresHumanReview === true,
    canonical_amazon_identity_resolved: false,
    persistence_authorized: false,
    execution_authorized: false,
    amazon_mutation_authorized: false,
    input_set_fingerprint: result.source.inputSetFingerprint,
  };
}

function periodRow(result, rowType, label, item, comparisonReliability) {
  const metrics = item.metrics || {};
  return {
    row_type: rowType,
    label,
    start_date: item.startDate || '',
    end_date: item.endDate || '',
    expected_days: numberOrBlank(item.coverage?.expectedDayCount),
    covered_days: numberOrBlank(item.coverage?.coveredDayCount),
    coverage_ratio: numberOrBlank(item.coverage?.coverageRatio),
    spend: moneyNumber(metrics.spendMicros),
    sales: moneyNumber(metrics.salesMicros),
    orders: numberOrBlank(metrics.orders),
    acos: numberOrBlank(metrics.acos),
    roas: numberOrBlank(metrics.roas),
    cvr: numberOrBlank(metrics.cvr),
    cpc: moneyNumber(metrics.cpcMicros),
    ad_contribution: moneyNumber(item.adContributionMicros),
    profitability_basis: item.profitabilityBasis || '',
    reliability_state: item.reliability?.state || comparisonReliability?.state || '',
    decision_use: item.reliability?.analyticalDecisionUse || comparisonReliability?.analyticalDecisionUse || '',
    canonical_amazon_identity_resolved: false,
    persistence_authorized: false,
    execution_authorized: false,
    amazon_mutation_authorized: false,
    input_set_fingerprint: result.source.inputSetFingerprint,
  };
}

function toCsv(headers, rows) {
  return [headers.join(','), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(','))].join('\n');
}
function csvCell(value) { const text = String(value ?? ''); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function moneyNumber(micros) { return micros == null || !Number.isFinite(Number(micros)) ? '' : (Number(micros) / 1_000_000).toFixed(6); }
function numberOrBlank(value) { return value == null || !Number.isFinite(Number(value)) ? '' : String(Number(value)); }
function crc32Hex(bytes) { return crc32Bytes(bytes).toString(16).padStart(8, '0'); }
function crc32Bytes(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function isSafeZipEntryName(name) { return Boolean(name) && !name.includes('/') && !name.includes('\\') && !name.includes('..') && !/^[.]/.test(name); }
function write16(view, offset, value) { view.setUint16(offset, value, true); }
function write32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }
function concatBytes(chunks) { const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0); const output = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; } return output; }
function downloadText(fileName, text, mimeType) { downloadBytes(fileName, new TextEncoder().encode(text), mimeType); }
function downloadBytes(fileName, bytes, mimeType) { const blob = new Blob([bytes], { type: mimeType }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.style.display = 'none'; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url); }
function setEnabled(root, enabled) { for (const button of root.querySelectorAll('[data-cfae-kind]')) button.disabled = !enabled || state.busy; }
function status(root, message, kind = '') { const node = root.querySelector('[data-cfae-status]'); node.textContent = message; node.dataset.kind = kind; }
function exportError(code) { const error = new Error(code); error.name = 'CsvAnalysisExportError'; error.code = code; return error; }

function installStyles() {
  if (document.getElementById('cfae-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfae-style-v1';
  style.textContent = '.cfae{margin-top:14px;padding-top:14px;border-top:1px solid #e2e8f0}.cfae-head{display:flex;justify-content:space-between;gap:12px}.cfae-head small{display:block;color:#64748b}.cfae-head>span{font-size:11px;font-weight:800}.cfae-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}.cfae-actions button{border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;background:#fff;font:inherit;font-weight:700;cursor:pointer}.cfae-actions button:disabled{opacity:.45;cursor:not-allowed}.cfae-status{margin-top:8px;padding:8px;border-radius:7px;background:#f8fafc}.cfae-status[data-kind="bad"]{color:#b91c1c}.cfae-status[data-kind="ok"]{color:#047857}';
  document.head.appendChild(style);
}
