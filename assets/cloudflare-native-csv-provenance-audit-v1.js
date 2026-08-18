export const CSV_PROVENANCE_AUDIT_SCHEMA_VERSION = 'csv-provenance-audit-v1';
export const CSV_PROVENANCE_AUDIT_UI_VERSION = '1.0.0';

const state = { mounted: false, busy: false };
const NON_AUTHORITY = Object.freeze({
  mode: 'local_operator_audit_only',
  authoritative: false,
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
});

export function buildCsvProvenanceAudit(result) {
  assertAdvisoryOnly(result);
  const imports = (result.imports || []).map((item) => Object.freeze({
    schemaVersion: item.schemaVersion || null,
    reportType: item.reportType || null,
    sourceFileName: item.sourceFileName || null,
    contentSha256: item.contentSha256 || null,
    reportStartDate: item.reportStartDate || null,
    reportEndDate: item.reportEndDate || null,
    rowCount: finiteOrNull(item.rowCount),
    acceptedRows: finiteOrNull(item.acceptedRows),
    rejectedRows: finiteOrNull(item.rejectedRows),
    advertiserAccountId: item.advertiserAccountId || null,
    profileId: item.profileId || null,
    marketplace: item.marketplace || null,
    currencyCode: item.currencyCode || null,
  }));
  const quality = result.dataQuality || {};
  return Object.freeze({
    schemaVersion: CSV_PROVENANCE_AUDIT_SCHEMA_VERSION,
    authority: NON_AUTHORITY,
    source: Object.freeze({
      kind: result.source?.kind || 'csv_import_set',
      inputSetFingerprint: result.source.inputSetFingerprint,
      batchCount: finiteOrNull(result.source.batchCount ?? imports.length),
      contentSha256s: Object.freeze([...(result.source.contentSha256s || [])]),
      reportStartDate: result.range?.startDate || null,
      reportEndDate: result.range?.endDate || null,
    }),
    receipts: Object.freeze(imports),
    dataQuality: Object.freeze({
      schemaVersion: quality.schemaVersion || null,
      qualityState: quality.qualityState || null,
      safeForNaiveAggregation: quality.safeForNaiveAggregation === true,
      contiguousCoverage: quality.contiguousCoverage === true,
      requiresHumanReview: quality.requiresHumanReview === true,
      summary: Object.freeze({ ...(quality.summary || {}) }),
      windows: Object.freeze([...(quality.windows || [])]),
      overlapPairs: Object.freeze([...(quality.overlapPairs || [])]),
      gaps: Object.freeze([...(quality.gaps || [])]),
      mergedCoverage: Object.freeze([...(quality.mergedCoverage || [])]),
    }),
    observedIdentity: Object.freeze({
      state: 'csv_observed_only_not_canonical_amazon_identity',
      summary: Object.freeze({ ...(result.observedIdentity?.summary || {}) }),
    }),
  });
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvProvenanceAudit', {
    value: Object.freeze({
      version: CSV_PROVENANCE_AUDIT_UI_VERSION,
      schemaVersion: CSV_PROVENANCE_AUDIT_SCHEMA_VERSION,
      authority: 'local_operator_audit_only',
      buildCsvProvenanceAudit,
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
  if (joint.querySelector('[data-csv-provenance-audit]')) return void (state.mounted = true);
  installStyles();
  const root = document.createElement('section');
  root.className = 'cfpa';
  root.dataset.csvProvenanceAudit = CSV_PROVENANCE_AUDIT_UI_VERSION;
  root.innerHTML = `
    <div class="cfpa-head">
      <div><b>Provenance & Audit Drilldown</b><small>Observed CSV provenance is not canonical Amazon identity and does not authorize persistence, execution, or Amazon mutation.</small></div>
      <span>browser-local evidence</span>
    </div>
    <div class="cfpa-actions"><button type="button" data-cfpa-refresh disabled>Build audit view</button></div>
    <div class="cfpa-status" data-cfpa-status>Run Joint CSV Analysis to inspect source receipts and data-quality evidence.</div>
    <div class="cfpa-body" data-cfpa-body hidden></div>`;
  const exportUi = joint.querySelector('[data-csv-analysis-export]');
  const reviewUi = joint.querySelector('[data-csv-library-review]');
  if (exportUi) exportUi.insertAdjacentElement('beforebegin', root);
  else if (reviewUi) reviewUi.insertAdjacentElement('beforebegin', root);
  else joint.appendChild(root);

  root.querySelector('[data-cfpa-refresh]').addEventListener('click', () => void refresh(root, joint));
  const jointStatus = joint.querySelector('[data-csv-joint-status]');
  if (jointStatus) {
    const sync = () => {
      const enabled = jointStatus.dataset.kind === 'success';
      setEnabled(root, enabled);
      if (enabled && root.querySelector('[data-cfpa-body]').hidden) void refresh(root, joint);
    };
    new MutationObserver(sync).observe(jointStatus, { attributes: true, childList: true, characterData: true, subtree: true });
    sync();
  }
  joint.querySelector('[data-csv-joint-files]')?.addEventListener('change', () => reset(root, 'CSV selection changed. Run Joint CSV Analysis again before building audit evidence.'));
  joint.querySelector('[data-csv-joint-clear]')?.addEventListener('click', () => reset(root, 'Local provenance / audit view cleared.'));
  state.mounted = true;
}

async function refresh(root, joint) {
  if (state.busy) return;
  const files = [...(joint.querySelector('[data-csv-joint-files]')?.files || [])];
  if (!files.length || typeof window.CloudflareCsvJointAnalysis?.analyzeLocalCsvInputs !== 'function') {
    return status(root, 'Joint CSV inputs are unavailable.', 'bad');
  }
  state.busy = true;
  setEnabled(root, false);
  status(root, 'Building provenance evidence locally…', 'loading');
  try {
    const inputs = await Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() })));
    const result = await window.CloudflareCsvJointAnalysis.analyzeLocalCsvInputs(inputs);
    const audit = buildCsvProvenanceAudit(result);
    render(root, audit);
    status(root, `Audit evidence ready for input set ${audit.source.inputSetFingerprint.slice(0, 12)}. No remote persistence or Amazon action occurred.`, 'ok');
  } catch (error) {
    root.querySelector('[data-cfpa-body]').hidden = true;
    status(root, `Local audit failed: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    setEnabled(root, true);
  }
}

function render(root, audit) {
  const body = root.querySelector('[data-cfpa-body]');
  const q = audit.dataQuality;
  body.innerHTML = `
    <div class="cfpa-grid">
      ${card('Input-set fingerprint', `<code>${esc(audit.source.inputSetFingerprint)}</code>`)}
      ${card('Report evidence', `${esc(audit.source.reportStartDate || 'unknown')} → ${esc(audit.source.reportEndDate || 'unknown')}<br>${audit.receipts.length} source receipt(s)`)}
      ${card('Aggregation safety', `naive aggregation: <b>${q.safeForNaiveAggregation ? 'safe' : 'blocked'}</b><br>contiguous coverage: <b>${q.contiguousCoverage ? 'yes' : 'no'}</b>`)}
      ${card('Quality state', `<b>${esc(q.qualityState || 'unknown')}</b><br>human review: ${q.requiresHumanReview ? 'required' : 'not required'}`)}
    </div>
    <details open><summary>Source receipts (${audit.receipts.length})</summary>${receiptTable(audit.receipts)}</details>
    <details><summary>Overlap evidence (${q.overlapPairs.length})</summary>${jsonBlock(q.overlapPairs)}</details>
    <details><summary>Gap evidence (${q.gaps.length})</summary>${jsonBlock(q.gaps)}</details>
    <details><summary>Merged coverage (${q.mergedCoverage.length})</summary>${jsonBlock(q.mergedCoverage)}</details>
    <details><summary>Observed identity summary</summary>${jsonBlock(audit.observedIdentity)}</details>
    <details><summary>Full local audit JSON</summary>${jsonBlock(audit)}</details>`;
  body.hidden = false;
}

function receiptTable(receipts) {
  if (!receipts.length) return '<p>No source receipts.</p>';
  return `<div class="cfpa-table-wrap"><table><thead><tr><th>File</th><th>Window</th><th>Rows</th><th>SHA-256</th><th>Observed account/profile</th></tr></thead><tbody>${receipts.map((item) => `<tr><td>${esc(item.sourceFileName || 'unnamed')}</td><td>${esc(item.reportStartDate || '—')} → ${esc(item.reportEndDate || '—')}</td><td>${esc(item.rowCount ?? '—')}</td><td><code>${esc(item.contentSha256 || '—')}</code></td><td>${esc(item.advertiserAccountId || '—')} / ${esc(item.profileId || '—')}</td></tr>`).join('')}</tbody></table></div>`;
}
function card(label, value) { return `<div class="cfpa-card"><small>${esc(label)}</small><div>${value}</div></div>`; }
function jsonBlock(value) { return `<pre>${esc(JSON.stringify(value, null, 2))}</pre>`; }
function finiteOrNull(value) { return value == null || !Number.isFinite(Number(value)) ? null : Number(value); }
function setEnabled(root, enabled) { root.querySelector('[data-cfpa-refresh]').disabled = !enabled || state.busy; }
function reset(root, message) { root.querySelector('[data-cfpa-body]').hidden = true; setEnabled(root, false); status(root, message); }
function status(root, message, kind = '') { const node = root.querySelector('[data-cfpa-status]'); node.textContent = message; node.dataset.kind = kind; }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }

function assertAdvisoryOnly(result) {
  if (!result || typeof result !== 'object') throw auditError('CSV_PROVENANCE_AUDIT_RESULT_REQUIRED');
  if (!/^[a-f0-9]{64}$/i.test(String(result.source?.inputSetFingerprint || ''))) throw auditError('CSV_PROVENANCE_AUDIT_FINGERPRINT_INVALID');
  for (const receipt of result.imports || []) {
    if (!/^[a-f0-9]{64}$/i.test(String(receipt?.contentSha256 || ''))) throw auditError('CSV_PROVENANCE_AUDIT_CONTENT_HASH_INVALID');
  }
  const flags = [
    result.source?.canonicalAmazonIdentityResolved,
    result.source?.governancePersistenceAllowed,
    result.source?.executionAuthorized,
    result.source?.amazonMutationAuthorized,
    result.analysis?.authority?.authoritative,
    result.analysis?.authority?.governancePersistenceAllowed,
    result.analysis?.authority?.executionAuthorized,
    result.analysis?.authority?.amazonMutationAuthorized,
    result.dataQuality?.authority?.authoritative,
    result.dataQuality?.authority?.governancePersistenceAllowed,
    result.dataQuality?.authority?.executionAuthorized,
    result.dataQuality?.authority?.amazonMutationAuthorized,
    result.hierarchy?.authority?.authoritative,
    result.hierarchy?.authority?.governancePersistenceAllowed,
    result.hierarchy?.authority?.executionAuthorized,
    result.hierarchy?.authority?.amazonMutationAuthorized,
    result.periods?.authority?.authoritative,
    result.periods?.authority?.governancePersistenceAllowed,
    result.periods?.authority?.executionAuthorized,
    result.periods?.authority?.amazonMutationAuthorized,
  ];
  if (flags.some((value) => value === true)) throw auditError('CSV_PROVENANCE_AUDIT_AUTHORITY_ESCALATION_BLOCKED');
}

function auditError(code) { const error = new Error(code); error.name = 'CsvProvenanceAuditError'; error.code = code; return error; }

function installStyles() {
  if (document.getElementById('cfpa-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfpa-style-v1';
  style.textContent = '.cfpa{margin-top:14px;padding-top:14px;border-top:1px solid #e2e8f0}.cfpa-head{display:flex;justify-content:space-between;gap:12px}.cfpa-head small{display:block;color:#64748b;max-width:760px}.cfpa-head>span{font-size:11px;font-weight:800}.cfpa-actions{margin-top:9px}.cfpa-actions button{border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;background:#fff;font:inherit;font-weight:700;cursor:pointer}.cfpa-actions button:disabled{opacity:.45;cursor:not-allowed}.cfpa-status{margin-top:8px;padding:8px;border-radius:7px;background:#f8fafc}.cfpa-status[data-kind="bad"]{color:#b91c1c}.cfpa-status[data-kind="ok"]{color:#047857}.cfpa-body{margin-top:10px}.cfpa-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}.cfpa-card{padding:9px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;overflow-wrap:anywhere}.cfpa-card small{display:block;color:#64748b}.cfpa details{margin-top:8px;border:1px solid #e2e8f0;border-radius:8px;padding:8px}.cfpa summary{cursor:pointer;font-weight:700}.cfpa pre{max-height:340px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#f8fafc;padding:8px;border-radius:6px}.cfpa-table-wrap{overflow:auto}.cfpa table{width:100%;border-collapse:collapse;font-size:12px}.cfpa th,.cfpa td{text-align:left;vertical-align:top;padding:7px;border-bottom:1px solid #e2e8f0}.cfpa code{font-size:11px;word-break:break-all}';
  document.head.appendChild(style);
}
