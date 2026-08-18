import {
  CSV_HISTORY_LEDGER_SCHEMA_VERSION,
  buildCsvHistorySnapshot,
  createCsvHistoryLedger,
  mergeCsvHistoryLedger,
  parseCsvHistoryLedger,
  serializeCsvHistoryLedger,
  validateCsvHistoryLedger,
} from './csv-analysis-engine/csv-history-ledger.js';

export const CSV_HISTORY_LEDGER_UI_VERSION = '1.0.0';

const state = {
  mounted: false,
  busy: false,
  ledger: null,
  importedFileName: null,
};

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvHistoryLedger', {
    value: Object.freeze({
      version: CSV_HISTORY_LEDGER_UI_VERSION,
      schemaVersion: CSV_HISTORY_LEDGER_SCHEMA_VERSION,
      authority: 'local_file_history_ledger_only',
      buildCsvHistorySnapshot,
      createCsvHistoryLedger,
      mergeCsvHistoryLedger,
      parseCsvHistoryLedger,
      serializeCsvHistoryLedger,
      validateCsvHistoryLedger,
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
  state.ledger = null;
  state.importedFileName = null;
  const input = root.querySelector('[data-cfhl-import]');
  input.value = '';
  root.querySelector('[data-cfhl-body]').hidden = true;
  setStatus(root, 'In-memory ledger cleared. No remote deletion was required because no remote persistence exists.');
  syncButtons(root, document.querySelector('[data-csv-joint-status]')?.dataset.kind === 'success');
}

function renderLedger(root, ledger) {
  const body = root.querySelector('[data-cfhl-body]');
  const windowEvidence = ledger.historyWindowEvidence;
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
    <details><summary>Historical overlap / gap evidence</summary><pre>${esc(JSON.stringify(windowEvidence, null, 2))}</pre></details>
    <details><summary>Ledger authority boundary</summary><pre>${esc(JSON.stringify(ledger.authority, null, 2))}</pre></details>`;
  body.hidden = false;
  syncButtons(root, document.querySelector('[data-csv-joint-status]')?.dataset.kind === 'success');
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
  style.textContent = '.cfhl{margin-top:14px;padding-top:14px;border-top:1px solid #e2e8f0}.cfhl-head{display:flex;justify-content:space-between;gap:12px}.cfhl-head small{display:block;color:#64748b;max-width:780px}.cfhl-head>span{font-size:11px;font-weight:800}.cfhl-guard{margin-top:8px;padding:8px;border-radius:7px;background:#f8fafc;color:#475569}.cfhl-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:9px}.cfhl-actions label,.cfhl-actions button{border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;background:#fff;font:inherit;font-weight:700}.cfhl-actions input{max-width:220px}.cfhl-actions button{cursor:pointer}.cfhl-actions button:disabled{opacity:.45;cursor:not-allowed}.cfhl-status{margin-top:8px;padding:8px;border-radius:7px;background:#f8fafc}.cfhl-status[data-kind="bad"]{color:#b91c1c}.cfhl-status[data-kind="ok"]{color:#047857}.cfhl-body{margin-top:10px}.cfhl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}.cfhl-card{padding:9px;border:1px solid #e2e8f0;border-radius:8px;background:#fff;overflow-wrap:anywhere}.cfhl-card small{display:block;color:#64748b}.cfhl-table-wrap{overflow:auto;margin-top:9px}.cfhl table{width:100%;border-collapse:collapse;font-size:12px}.cfhl th,.cfhl td{text-align:left;vertical-align:top;padding:7px;border-bottom:1px solid #e2e8f0}.cfhl code{font-size:11px;word-break:break-all}.cfhl details{margin-top:8px;border:1px solid #e2e8f0;border-radius:8px;padding:8px}.cfhl summary{cursor:pointer;font-weight:700}.cfhl pre{max-height:300px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#f8fafc;padding:8px;border-radius:6px}';
  document.head.appendChild(style);
}
