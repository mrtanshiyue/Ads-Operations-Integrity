import {
  CSV_HISTORY_AUDIT_PACKAGE_INDEX_SCHEMA_VERSION,
  buildHistoricalAuditPackageIndex,
  serializeHistoricalAuditPackageIndex,
  validateHistoricalAuditPackageIndex,
} from './cloudflare-native-csv-history-comparison-receipt-verification-v1.js';

export const CSV_HISTORY_AUDIT_PACKAGE_INDEX_VERIFICATION_SCHEMA_VERSION = 'csv-history-audit-package-index-verification-v1';
export const CSV_HISTORY_AUDIT_PACKAGE_INDEX_VERIFICATION_UI_VERSION = '1.0.0';

const state = {
  mounted: false,
  busy: false,
  indexText: null,
  zipInputs: [],
};

export async function parseHistoricalAuditPackageIndex(indexText) {
  if (typeof indexText !== 'string' || !indexText.trim()) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INDEX_TEXT_REQUIRED');
  let parsed;
  try { parsed = JSON.parse(indexText); }
  catch { throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INDEX_JSON_INVALID'); }
  const validated = await validateHistoricalAuditPackageIndex(parsed);
  if (serializeHistoricalAuditPackageIndex(validated) !== indexText) {
    throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INDEX_SERIALIZATION_MISMATCH');
  }
  return validated;
}

export async function verifyHistoricalAuditPackageIndexAgainstZipSet(indexText, zipInputs, zipBuilder) {
  const validatedIndex = await parseHistoricalAuditPackageIndex(indexText);
  if (!Array.isArray(zipInputs) || zipInputs.length === 0) throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INDEX_VERIFICATION_ZIPS_REQUIRED');
  const rebuilt = await buildHistoricalAuditPackageIndex(zipInputs, zipBuilder);
  if (rebuilt.indexFingerprint !== validatedIndex.indexFingerprint) {
    throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INDEX_REPLAY_FINGERPRINT_MISMATCH');
  }
  const originalSerialized = serializeHistoricalAuditPackageIndex(validatedIndex);
  const rebuiltSerialized = serializeHistoricalAuditPackageIndex(rebuilt);
  if (rebuiltSerialized !== originalSerialized) {
    throw verificationError('CSV_HISTORY_AUDIT_PACKAGE_INDEX_REPLAY_SERIALIZATION_MISMATCH');
  }

  return deepFreeze({
    schemaVersion: CSV_HISTORY_AUDIT_PACKAGE_INDEX_VERIFICATION_SCHEMA_VERSION,
    verificationState: 'audit_package_index_verified_against_local_zip_set',
    indexSchemaVersion: CSV_HISTORY_AUDIT_PACKAGE_INDEX_SCHEMA_VERSION,
    indexFingerprint: validatedIndex.indexFingerprint,
    recomputedIndexFingerprint: rebuilt.indexFingerprint,
    packageCount: rebuilt.packageCount,
    packageFingerprints: rebuilt.packages.map((item) => item.packageFingerprint),
    indexFingerprintMatch: true,
    indexSerializationMatch: true,
    archiveSetMatch: true,
    replayedFromExplicitLocalZipSet: true,
    selectionOrderIndependent: true,
    generatedTimestampIncluded: false,
    sourceFileNameIncluded: false,
    crossPackageAggregationApplied: false,
    normalizationApplied: false,
    deduplicationApplied: false,
    sameMonthAggregationApplied: false,
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    authority: noAuthority(),
  });
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvHistoryAuditPackageIndexVerification', {
    value: Object.freeze({
      version: CSV_HISTORY_AUDIT_PACKAGE_INDEX_VERIFICATION_UI_VERSION,
      schemaVersion: CSV_HISTORY_AUDIT_PACKAGE_INDEX_VERIFICATION_SCHEMA_VERSION,
      authority: 'local_historical_audit_package_index_verification_only',
      parseHistoricalAuditPackageIndex,
      verifyHistoricalAuditPackageIndexAgainstZipSet,
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
  const host = document.querySelector('[data-csv-history-comparison-receipt-verification]');
  if (!host) {
    new MutationObserver((_, observer) => {
      const found = document.querySelector('[data-csv-history-comparison-receipt-verification]');
      if (!found) return;
      observer.disconnect();
      mount();
    }).observe(document.documentElement, { childList: true, subtree: true });
    return;
  }
  if (host.querySelector('[data-csv-history-audit-package-index-verification]')) return void (state.mounted = true);

  const root = document.createElement('section');
  root.className = 'cfhaiv';
  root.dataset.csvHistoryAuditPackageIndexVerification = CSV_HISTORY_AUDIT_PACKAGE_INDEX_VERIFICATION_UI_VERSION;
  root.innerHTML = `
    <div class="cfhaiv-head">
      <div><b>Audit Package Index Verification</b><small>Re-import a downloaded deterministic package index and the exact local audit ZIP set. Every ZIP is independently replay-verified before the index is rebuilt.</small></div>
      <span>index-bound replay</span>
    </div>
    <div class="cfhaiv-guard">Verification requires the downloaded index fingerprint and deterministic serialization to match a fresh index rebuilt from the explicit local ZIP set. Missing, extra, duplicate, tampered, or non-canonical packages fail closed.</div>
    <div class="cfhaiv-controls">
      <label>Package index JSON <input type="file" accept="application/json,.json" data-cfhaiv-index></label>
      <label>Audit package ZIP set <input type="file" accept="application/zip,.zip" multiple data-cfhaiv-zips></label>
      <button type="button" data-cfhaiv-verify disabled>Verify index against ZIP set</button>
    </div>
    <div class="cfhaiv-status" data-cfhaiv-status>Select the downloaded index and its explicit local audit ZIP set. Nothing is stored remotely or in hidden browser persistence.</div>
    <div class="cfhaiv-result" data-cfhaiv-result hidden></div>`;
  host.insertAdjacentElement('afterend', root);
  installStyles();

  root.querySelector('[data-cfhaiv-index]').addEventListener('change', (event) => void loadIndex(root, event.currentTarget));
  root.querySelector('[data-cfhaiv-zips]').addEventListener('change', (event) => void loadZipSet(root, event.currentTarget));
  root.querySelector('[data-cfhaiv-verify]').addEventListener('click', () => void verifyFromUi(root));
  state.mounted = true;
}

async function loadIndex(root, input) {
  const file = input.files?.[0];
  state.indexText = null;
  clearResult(root);
  if (!file) return syncControls(root);
  state.busy = true;
  syncControls(root);
  setStatus(root, 'Validating downloaded package index integrity and serialization…', 'loading');
  try {
    const text = await file.text();
    const index = await parseHistoricalAuditPackageIndex(text);
    state.indexText = text;
    setStatus(root, `Index validated: ${index.indexFingerprint.slice(0, 12)} · ${index.packageCount} package${index.packageCount === 1 ? '' : 's'}.`, 'ok');
  } catch (error) {
    setStatus(root, `Index blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

async function loadZipSet(root, input) {
  const files = [...(input.files || [])];
  state.zipInputs = [];
  clearResult(root);
  if (!files.length) return syncControls(root);
  state.busy = true;
  syncControls(root);
  setStatus(root, `Reading ${files.length} explicit local audit ZIP${files.length === 1 ? '' : 's'}…`, 'loading');
  try {
    state.zipInputs = await Promise.all(files.map(async (file) => new Uint8Array(await file.arrayBuffer())));
    setStatus(root, `${files.length} local audit ZIP${files.length === 1 ? '' : 's'} loaded. Verification will replay every package before rebuilding the index.`, 'ok');
  } catch (error) {
    state.zipInputs = [];
    setStatus(root, `ZIP set blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

async function verifyFromUi(root) {
  if (!state.indexText || !state.zipInputs.length || state.busy) return;
  state.busy = true;
  clearResult(root);
  syncControls(root);
  setStatus(root, 'Replaying every audit ZIP and rebuilding deterministic package index…', 'loading');
  try {
    const zipBuilder = window.CloudflareCsvAnalysisExport?.buildStoredZip;
    const verification = await verifyHistoricalAuditPackageIndexAgainstZipSet(state.indexText, state.zipInputs, zipBuilder);
    renderVerification(root, verification);
    setStatus(root, `Index ${verification.indexFingerprint.slice(0, 12)} verified against the explicit local ZIP set.`, 'ok');
  } catch (error) {
    setStatus(root, `Index verification blocked: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.busy = false;
    syncControls(root);
  }
}

function renderVerification(root, verification) {
  const result = root.querySelector('[data-cfhaiv-result]');
  result.innerHTML = `
    <div class="cfhaiv-grid">
      ${card('Index verification', '<b>verified against local ZIP set</b>')}
      ${card('Index fingerprint', `<code>${esc(verification.indexFingerprint)}</code>`)}
      ${card('Verified packages', `<b>${esc(verification.packageCount)}</b>`)}
      ${card('Archive set', '<b>exact match</b><br>all packages replayed')}
    </div>
    <div class="cfhaiv-guard">Fingerprint match: true · deterministic serialization match: true · selection order ignored · cross-package aggregation: none · same-month aggregation: none.</div>
    <details><summary>Verified package fingerprints</summary><pre>${esc(JSON.stringify(verification.packageFingerprints, null, 2))}</pre></details>
    <details><summary>Authority boundary</summary><pre>${esc(JSON.stringify(verification.authority, null, 2))}</pre></details>`;
  result.hidden = false;
}

function syncControls(root) {
  root.querySelector('[data-cfhaiv-index]').disabled = state.busy;
  root.querySelector('[data-cfhaiv-zips]').disabled = state.busy;
  root.querySelector('[data-cfhaiv-verify]').disabled = state.busy || !state.indexText || !state.zipInputs.length;
}

function clearResult(root) {
  const result = root.querySelector('[data-cfhaiv-result]');
  result.hidden = true;
  result.innerHTML = '';
}

function setStatus(root, text, kind = '') {
  const node = root.querySelector('[data-cfhaiv-status]');
  node.textContent = text;
  node.dataset.kind = kind;
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

function verificationError(code) {
  const error = new Error(code);
  error.name = 'CsvHistoryAuditPackageIndexVerificationError';
  error.code = code;
  return error;
}

function card(label, value) {
  return `<div class="cfhaiv-card"><small>${esc(label)}</small><div>${value}</div></div>`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function installStyles() {
  if (document.getElementById('cfhaiv-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfhaiv-style-v1';
  style.textContent = '.cfhaiv{margin-top:12px;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#fff}.cfhaiv-head{display:flex;justify-content:space-between;gap:12px}.cfhaiv-head small{display:block;color:#64748b;max-width:780px}.cfhaiv-head>span{font-size:11px;font-weight:800}.cfhaiv-guard,.cfhaiv-status{margin-top:8px;padding:8px;border-radius:7px;background:#f8fafc;color:#475569}.cfhaiv-status[data-kind="bad"]{color:#b91c1c}.cfhaiv-status[data-kind="ok"]{color:#047857}.cfhaiv-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-top:9px}.cfhaiv-controls label{display:grid;gap:4px;font-size:12px;font-weight:700}.cfhaiv-controls input,.cfhaiv-controls button{border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;background:#fff;font:inherit}.cfhaiv-controls button{font-weight:700;cursor:pointer}.cfhaiv-controls button:disabled{opacity:.45;cursor:not-allowed}.cfhaiv-result{margin-top:10px}.cfhaiv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}.cfhaiv-card{padding:9px;border:1px solid #e2e8f0;border-radius:8px;overflow-wrap:anywhere}.cfhaiv-card small{display:block;color:#64748b}.cfhaiv code{font-size:11px;word-break:break-all}.cfhaiv details{margin-top:8px;border:1px solid #e2e8f0;border-radius:8px;padding:8px}.cfhaiv summary{cursor:pointer;font-weight:700}.cfhaiv pre{white-space:pre-wrap;word-break:break-word;background:#f8fafc;padding:8px;border-radius:6px}';
  document.head.appendChild(style);
}
