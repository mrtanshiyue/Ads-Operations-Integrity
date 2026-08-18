export const CSV_PROVENANCE_AUDIT_SCHEMA_VERSION = 'csv-provenance-audit-v1';
export const CSV_PROVENANCE_AUDIT_UI_VERSION = '1.0.0';

const state = { mounted: false, busy: false };

export function buildCsvProvenanceAuditModel(result) {
  assertAuditSafe(result);
  const imports = [...(result.imports || [])];
  const sourceHashes = [...(result.source?.contentSha256s || [])].map((value) => String(value).toLowerCase()).sort();
  const importHashes = imports.map((item) => String(item.contentSha256 || '').toLowerCase()).sort();
  if (sourceHashes.length !== importHashes.length || sourceHashes.some((value, index) => value !== importHashes[index])) {
    throw auditError('CSV_PROVENANCE_AUDIT_SOURCE_HASH_MISMATCH');
  }

  const quality = result.dataQuality || {};
  return Object.freeze({
    schemaVersion: CSV_PROVENANCE_AUDIT_SCHEMA_VERSION,
    authority: Object.freeze({
      mode: 'local_csv_provenance_audit_only',
      authoritative: false,
      canonicalAmazonIdentityResolved: false,
      governancePersistenceAllowed: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    }),
    inputSetFingerprint: String(result.source.inputSetFingerprint).toLowerCase(),
    range: Object.freeze({
      startDate: result.range?.startDate || null,
      endDate: result.range?.endDate || null,
    }),
    summary: Object.freeze({
      importCount: imports.length,
      factCount: Number(result.summary?.factCount || 0),
      sourceRowCount: Number(result.summary?.sourceRowCount || 0),
      qualityState: quality.qualityState || 'unknown',
      safeForNaiveAggregation: quality.safeForNaiveAggregation === true,
      contiguousCoverage: quality.contiguousCoverage === true,
      requiresHumanReview: quality.requiresHumanReview === true,
      overlapPairCount: Number(quality.summary?.overlapPairCount || 0),
      gapCount: Number(quality.summary?.gapCount || 0),
      gapDayCount: Number(quality.summary?.gapDayCount || 0),
      uniqueCoveredDayCount: Number(quality.summary?.uniqueCoveredDayCount || 0),
      overlapExcessDayCount: Number(quality.summary?.overlapExcessDayCount || 0),
    }),
    receipts: Object.freeze(imports.map((item) => Object.freeze({
      receiptId: `csv-content:${String(item.contentSha256).toLowerCase()}`,
      schemaVersion: item.schemaVersion || null,
      reportType: item.reportType || null,
      sourceFileName: item.sourceFileName || null,
      contentSha256: String(item.contentSha256).toLowerCase(),
      reportStartDate: item.reportStartDate || null,
      reportEndDate: item.reportEndDate || null,
      rowCount: Number(item.rowCount || 0),
      acceptedRows: Number(item.acceptedRows || 0),
      rejectedRows: Number(item.rejectedRows || 0),
      advertiserAccountId: item.advertiserAccountId || null,
      profileId: item.profileId || null,
      marketplace: item.marketplace || null,
      currencyCode: item.currencyCode || null,
      canonicalAmazonIdentityResolved: false,
      governancePersistenceAllowed: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    }))),
    quality: Object.freeze({
      schemaVersion: quality.schemaVersion || null,
      qualityState: quality.qualityState || 'unknown',
      safeForNaiveAggregation: quality.safeForNaiveAggregation === true,
      contiguousCoverage: quality.contiguousCoverage === true,
      requiresHumanReview: quality.requiresHumanReview === true,
      windows: Object.freeze([...(quality.windows || [])]),
      overlapPairs: Object.freeze([...(quality.overlapPairs || [])]),
      gaps: Object.freeze([...(quality.gaps || [])]),
      mergedCoverage: Object.freeze([...(quality.mergedCoverage || [])]),
    }),
  });
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvProvenanceAudit', {
    value: Object.freeze({
      version: CSV_PROVENANCE_AUDIT_UI_VERSION,
      schemaVersion: CSV_PROVENANCE_AUDIT_SCHEMA_VERSION,
      authority: 'local_csv_provenance_audit_only',
      buildCsvProvenanceAuditModel,
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
      <div><b>Provenance / Audit Drilldown</b><small>Trace each local CSV receipt into the current input-set fingerprint and inspect date-window integrity before operational review.</small></div>
      <div class="cfpa-badges"><span>browser-local</span><span>evidence only</span><span>no persistence</span></div>
    </div>
    <div class="cfpa-controls">
      <button type="button" data-cfpa-refresh disabled>Build local audit drilldown</button>
      <span data-cfpa-status>Run Joint CSV Analysis first.</span>
    </div>
    <div data-cfpa-results hidden></div>`;

  const exportPanel = joint.querySelector('[data-csv-analysis-export]');
  const reviewPanel = joint.querySelector('[data-csv-library-review]');
  if (reviewPanel) reviewPanel.insertAdjacentElement('beforebegin', root);
  else if (exportPanel) exportPanel.insertAdjacentElement('afterend', root);
  else joint.appendChild(root);

  const refresh = root.querySelector('[data-cfpa-refresh]');
  refresh.addEventListener('click', () => void refreshAudit(root, joint));
  const jointStatus = joint.querySelector('[data-csv-joint-status]');
  if (jointStatus) {
    const sync = () => {
      const enabled = jointStatus.dataset.kind === 'success';
      refresh.disabled = !enabled || state.busy;
      if (!enabled) clearRendered(root, 'Run Joint CSV Analysis first.');
    };
    new MutationObserver(sync).observe(jointStatus, { attributes: true, childList: true, characterData: true, subtree: true });
    sync();
  }
  joint.querySelector('[data-csv-joint-files]')?.addEventListener('change', () => clearRendered(root, 'CSV selection changed. Re-run Joint CSV Analysis before rebuilding the audit.'));
  joint.querySelector('[data-csv-joint-clear]')?.addEventListener('click', () => clearRendered(root, 'Local audit state cleared.'));
  state.mounted = true;
}

async function refreshAudit(root, joint) {
  if (state.busy) return;
  const files = [...(joint.querySelector('[data-csv-joint-files]')?.files || [])];
  if (!files.length || typeof window.CloudflareCsvJointAnalysis?.analyzeLocalCsvInputs !== 'function') {
    return setStatus(root, 'Joint CSV inputs are unavailable.', 'bad');
  }
  state.busy = true;
  root.querySelector('[data-cfpa-refresh]').disabled = true;
  setStatus(root, 'Rebuilding provenance evidence from local CSV bytes…', 'loading');
  try {
    const inputs = await Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() })));
    const result = await window.CloudflareCsvJointAnalysis.analyzeLocalCsvInputs(inputs);
    const model = buildCsvProvenanceAuditModel(result);
    renderAudit(root, model);
    setStatus(root, `Audit built locally for input set ${model.inputSetFingerprint.slice(0, 12)}. No Amazon request, D1/R2 write, governance persistence, or execution permit was used.`, 'ok');
  } catch (error) {
    root.querySelector('[data-cfpa-results]').hidden = true;
    setStatus(root, `Local audit failed: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    const jointStatus = joint.querySelector('[data-csv-joint-status]');
    root.querySelector('[data-cfpa-refresh]').disabled = jointStatus?.dataset.kind !== 'success';
  }
}

function renderAudit(root, model) {
  const target = root.querySelector('[data-cfpa-results]');
  target.hidden = false;
  target.innerHTML = `
    <div class="cfpa-callout"><strong>Observed CSV evidence is not canonical Amazon identity.</strong> This drilldown exposes provenance and quality evidence only; persistence, execution, and Amazon mutation remain disabled.</div>
    <div class="cfpa-grid">
      ${stat('Imports', model.summary.importCount)}
      ${stat('Source rows', model.summary.sourceRowCount)}
      ${stat('Facts', model.summary.factCount)}
      ${stat('Quality', model.summary.qualityState)}
      ${stat('Overlap pairs', model.summary.overlapPairCount)}
      ${stat('Gap days', model.summary.gapDayCount)}
    </div>
    <div class="cfpa-fingerprint"><span>Input-set fingerprint</span><code title="${esc(model.inputSetFingerprint)}">${esc(model.inputSetFingerprint)}</code><small>${esc(model.range.startDate || '—')} → ${esc(model.range.endDate || '—')}</small></div>
    <div class="cfpa-authority">
      ${flag('Canonical Amazon identity', 'unresolved')}
      ${flag('Governance persistence', 'disabled')}
      ${flag('Execution authority', 'disabled')}
      ${flag('Amazon mutation', 'disabled')}
      ${flag('Naive aggregation', model.summary.safeForNaiveAggregation ? 'safe' : 'blocked')}
      ${flag('Coverage continuity', model.summary.contiguousCoverage ? 'contiguous' : 'review')}
    </div>
    <div class="cfpa-section"><h4>Import receipts</h4>${model.receipts.map(receiptDetails).join('')}</div>
    <div class="cfpa-section"><h4>Date-window evidence</h4>${windowEvidence(model.quality.windows)}</div>
    <div class="cfpa-section"><h4>Overlap diagnostics</h4>${overlapEvidence(model.quality.overlapPairs)}</div>
    <div class="cfpa-section"><h4>Gap diagnostics</h4>${gapEvidence(model.quality.gaps)}</div>
    <div class="cfpa-section"><h4>Merged coverage segments</h4>${coverageEvidence(model.quality.mergedCoverage)}</div>`;
}

function receiptDetails(item) {
  return `<details class="cfpa-receipt"><summary><b>${esc(item.sourceFileName || 'Unnamed CSV')}</b><span>${esc(item.reportStartDate || '—')} → ${esc(item.reportEndDate || '—')}</span><span>${item.rowCount} rows</span></summary>
    <div class="cfpa-detail-grid">
      <div><span>Receipt ID</span><code>${esc(item.receiptId)}</code></div>
      <div><span>Content SHA-256</span><code>${esc(item.contentSha256)}</code></div>
      <div><span>Report type</span><strong>${esc(item.reportType || '—')}</strong></div>
      <div><span>Accepted / rejected</span><strong>${item.acceptedRows} / ${item.rejectedRows}</strong></div>
      <div><span>Advertiser account ID</span><strong>${esc(item.advertiserAccountId || 'not observed')}</strong></div>
      <div><span>Profile ID</span><strong>${esc(item.profileId || 'not observed')}</strong></div>
      <div><span>Marketplace</span><strong>${esc(item.marketplace || 'not observed')}</strong></div>
      <div><span>Currency</span><strong>${esc(item.currencyCode || 'not observed')}</strong></div>
    </div></details>`;
}

function windowEvidence(items) {
  if (!items.length) return '<p class="cfpa-empty">No date-window evidence is available.</p>';
  return `<div class="cfpa-table">${items.map((item) => `<div><b>${esc(item.sourceFileName || 'Unnamed CSV')}</b><span>${esc(item.reportStartDate || '—')} → ${esc(item.reportEndDate || '—')}</span><span>${item.validDateRange ? `${Number(item.windowDayCount || 0)} days` : esc(item.issueCode || 'invalid')}</span><code>${esc(String(item.contentSha256 || '').slice(0, 12))}</code></div>`).join('')}</div>`;
}

function overlapEvidence(items) {
  if (!items.length) return '<p class="cfpa-empty">No overlapping report windows detected.</p>';
  return `<div class="cfpa-table">${items.map((item) => `<div><b>${esc(item.relation || 'overlap')}</b><span>${esc(item.overlapStartDate || '—')} → ${esc(item.overlapEndDate || '—')}</span><span>${Number(item.overlapDayCount || 0)} overlapping days</span><small>${esc(item.left?.sourceFileName || 'left')} ↔ ${esc(item.right?.sourceFileName || 'right')}</small></div>`).join('')}</div>`;
}

function gapEvidence(items) {
  if (!items.length) return '<p class="cfpa-empty">No coverage gaps detected between reported windows.</p>';
  return `<div class="cfpa-table">${items.map((item) => `<div><b>Coverage gap</b><span>${esc(item.gapStartDate || '—')} → ${esc(item.gapEndDate || '—')}</span><span>${Number(item.gapDayCount || 0)} missing days</span><small>${esc(item.previousCoverageEndDate || '—')} → ${esc(item.nextCoverageStartDate || '—')}</small></div>`).join('')}</div>`;
}

function coverageEvidence(items) {
  if (!items.length) return '<p class="cfpa-empty">No merged coverage segment is available.</p>';
  return `<div class="cfpa-table">${items.map((item) => `<div><b>${esc(item.startDate || '—')} → ${esc(item.endDate || '—')}</b><span>${Number(item.coveredDayCount || 0)} covered days</span><span>${(item.sourceContentSha256s || []).length} source hash${(item.sourceContentSha256s || []).length === 1 ? '' : 'es'}</span><code>${esc((item.sourceContentSha256s || []).map((hash) => String(hash).slice(0, 8)).join(' · '))}</code></div>`).join('')}</div>`;
}

function assertAuditSafe(result) {
  if (!result || typeof result !== 'object') throw auditError('CSV_PROVENANCE_AUDIT_RESULT_REQUIRED');
  if (result.source?.kind !== 'csv_import_set') throw auditError('CSV_PROVENANCE_AUDIT_SOURCE_KIND_INVALID');
  if (!/^[a-f0-9]{64}$/i.test(String(result.source?.inputSetFingerprint || ''))) throw auditError('CSV_PROVENANCE_AUDIT_FINGERPRINT_INVALID');
  if (!Array.isArray(result.imports) || result.imports.length === 0) throw auditError('CSV_PROVENANCE_AUDIT_IMPORTS_REQUIRED');
  for (const item of result.imports) {
    if (!/^[a-f0-9]{64}$/i.test(String(item?.contentSha256 || ''))) throw auditError('CSV_PROVENANCE_AUDIT_CONTENT_HASH_INVALID');
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
  ];
  if (flags.some((value) => value === true)) throw auditError('CSV_PROVENANCE_AUDIT_AUTHORITY_ESCALATION_BLOCKED');
}

function clearRendered(root, message) {
  const target = root.querySelector('[data-cfpa-results]');
  target.hidden = true;
  target.innerHTML = '';
  setStatus(root, message);
}
function stat(label, value) { return `<div class="cfpa-stat"><span>${esc(label)}</span><b>${esc(value)}</b></div>`; }
function flag(label, value) { return `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`; }
function setStatus(root, message, kind = '') { const node = root.querySelector('[data-cfpa-status]'); node.textContent = message; node.dataset.kind = kind; }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char])); }
function auditError(code) { const error = new Error(code); error.name = 'CsvProvenanceAuditError'; error.code = code; return error; }

function installStyles() {
  if (document.getElementById('cfpa-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfpa-style-v1';
  style.textContent = `
    .cfpa{margin-top:14px;padding:14px;border:1px solid var(--line);border-radius:14px;background:var(--card)}
    .cfpa-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start}.cfpa-head b{display:block;font-size:13px}.cfpa-head small{display:block;margin-top:4px;color:var(--muted);line-height:1.45;max-width:820px}.cfpa-badges{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.cfpa-badges span{padding:4px 8px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font-size:10.5px}
    .cfpa-controls{display:flex;gap:10px;align-items:center;margin-top:12px}.cfpa-controls button{border:1px solid var(--line);background:var(--input-bg);color:var(--text);border-radius:999px;padding:7px 11px;cursor:pointer;font-weight:700}.cfpa-controls button:disabled{opacity:.45;cursor:not-allowed}.cfpa-controls span{color:var(--muted);font-size:11px}.cfpa-controls span[data-kind="bad"]{color:var(--bad)}.cfpa-controls span[data-kind="ok"]{color:var(--good)}
    .cfpa-callout{margin-top:12px;padding:10px 12px;border-left:3px solid var(--warn);background:var(--hover-bg);font-size:11px;line-height:1.5}.cfpa-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin-top:12px}.cfpa-stat{padding:9px;border:1px solid var(--line);border-radius:10px}.cfpa-stat span{display:block;color:var(--muted);font-size:10px}.cfpa-stat b{display:block;margin-top:4px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .cfpa-fingerprint{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center;margin-top:10px;padding:9px 10px;border:1px solid var(--line);border-radius:10px}.cfpa-fingerprint span,.cfpa-fingerprint small{color:var(--muted);font-size:10px}.cfpa-fingerprint code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}
    .cfpa-authority{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:10px}.cfpa-authority>div{display:flex;justify-content:space-between;gap:8px;padding:8px 9px;background:var(--hover-bg);border-radius:9px}.cfpa-authority span{color:var(--muted);font-size:10px}.cfpa-authority strong{font-size:10px;text-align:right}
    .cfpa-section{margin-top:14px}.cfpa-section h4{margin:0 0 8px;font-size:11.5px}.cfpa-receipt{border:1px solid var(--line);border-radius:10px;margin-top:7px;overflow:hidden}.cfpa-receipt summary{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;padding:9px 10px;cursor:pointer}.cfpa-receipt summary span{color:var(--muted);font-size:10px}.cfpa-detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:10px;border-top:1px solid var(--line);background:var(--hover-bg)}.cfpa-detail-grid>div{min-width:0}.cfpa-detail-grid span{display:block;color:var(--muted);font-size:9.7px}.cfpa-detail-grid strong,.cfpa-detail-grid code{display:block;margin-top:3px;font-size:10px;overflow-wrap:anywhere}
    .cfpa-table{border:1px solid var(--line);border-radius:10px;overflow:hidden}.cfpa-table>div{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(150px,.8fr) minmax(110px,.5fr) minmax(110px,.7fr);gap:10px;padding:8px 10px;border-top:1px solid var(--line);align-items:center}.cfpa-table>div:first-child{border-top:0}.cfpa-table span,.cfpa-table small,.cfpa-table code{color:var(--muted);font-size:9.8px;overflow-wrap:anywhere}.cfpa-empty{margin:0;padding:9px 10px;border:1px dashed var(--line);border-radius:10px;color:var(--muted);font-size:10.5px}
    @media(max-width:1000px){.cfpa-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.cfpa-authority{grid-template-columns:repeat(2,minmax(0,1fr))}.cfpa-table>div{grid-template-columns:1fr 1fr}.cfpa-fingerprint{grid-template-columns:1fr}.cfpa-head{flex-direction:column}.cfpa-badges{justify-content:flex-start}}
    @media(max-width:640px){.cfpa-grid,.cfpa-authority,.cfpa-detail-grid{grid-template-columns:1fr}.cfpa-receipt summary,.cfpa-table>div{grid-template-columns:1fr}.cfpa-controls{align-items:flex-start;flex-direction:column}}
  `;
  document.head.appendChild(style);
}
