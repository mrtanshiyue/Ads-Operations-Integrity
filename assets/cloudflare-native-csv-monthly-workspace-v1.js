export const CSV_MONTHLY_WORKSPACE_SCHEMA_VERSION = 'csv-monthly-operating-workspace-v1';
export const CSV_MONTHLY_WORKSPACE_UI_VERSION = '1.0.0';

const state = { mounted: false, busy: false, requestSeq: 0, workspace: null };
const NON_AUTHORITY = Object.freeze({
  mode: 'browser_local_monthly_workspace_only',
  authoritative: false,
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
});

export function buildCsvMonthlyOperatingWorkspace(result) {
  assertAdvisoryOnly(result);
  const imports = result.imports || [];
  const snapshots = result.periods?.monthlySnapshots || [];
  const months = snapshots.map((snapshot) => {
    const sources = imports
      .filter((item) => windowsIntersect(snapshot.startDate, snapshot.endDate, item.reportStartDate, item.reportEndDate))
      .map((item) => Object.freeze({
        sourceFileName: item.sourceFileName || null,
        contentSha256: item.contentSha256 || null,
        reportStartDate: item.reportStartDate || null,
        reportEndDate: item.reportEndDate || null,
        rowCount: finiteOrNull(item.rowCount),
        currencyCode: item.currencyCode || null,
      }));
    const previous = snapshot.comparisonToPreviousMonth || null;
    return Object.freeze({
      month: snapshot.month,
      startDate: snapshot.startDate,
      endDate: snapshot.endDate,
      monthComplete: snapshot.monthComplete === true,
      coverage: Object.freeze({ ...(snapshot.coverage || {}) }),
      metrics: Object.freeze({ ...(snapshot.metrics || {}) }),
      adContributionMicros: finiteOrNull(snapshot.adContributionMicros),
      profitabilityBasis: snapshot.profitabilityBasis || 'sales_minus_ad_spend_only_not_net_profit',
      reliability: Object.freeze({ ...(snapshot.reliability || {}) }),
      comparisonToPreviousMonth: previous ? Object.freeze({
        change: Object.freeze({ ...(previous.change || {}) }),
        reliability: Object.freeze({ ...(previous.reliability || {}) }),
      }) : null,
      sourceReceipts: Object.freeze(sources),
      sourceReceiptCount: sources.length,
      operatingState: deriveOperatingState(snapshot),
      requiresHumanReview: snapshot.requiresHumanReview !== false,
    });
  });
  return Object.freeze({
    schemaVersion: CSV_MONTHLY_WORKSPACE_SCHEMA_VERSION,
    authority: NON_AUTHORITY,
    source: Object.freeze({
      inputSetFingerprint: result.source.inputSetFingerprint,
      reportStartDate: result.range?.startDate || null,
      reportEndDate: result.range?.endDate || null,
      sourceReceiptCount: imports.length,
    }),
    summary: Object.freeze({
      monthCount: months.length,
      fullMonthCount: months.filter((item) => item.operatingState === 'full_month_review').length,
      partialMonthCount: months.filter((item) => item.operatingState === 'partial_month_review').length,
      blockedMonthCount: months.filter((item) => item.operatingState === 'blocked').length,
    }),
    months: Object.freeze(months),
  });
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvMonthlyWorkspace', {
    value: Object.freeze({
      version: CSV_MONTHLY_WORKSPACE_UI_VERSION,
      schemaVersion: CSV_MONTHLY_WORKSPACE_SCHEMA_VERSION,
      authority: 'browser_local_monthly_workspace_only',
      buildCsvMonthlyOperatingWorkspace,
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
  if (joint.querySelector('[data-csv-monthly-workspace]')) return void (state.mounted = true);
  installStyles();
  const root = document.createElement('section');
  root.className = 'cfmw';
  root.dataset.csvMonthlyWorkspace = CSV_MONTHLY_WORKSPACE_UI_VERSION;
  root.innerHTML = `
    <div class="cfmw-head"><div><b>Monthly Multi-CSV Operating Workspace</b><small>Month-by-month operating view from the currently selected local CSV evidence. Partial coverage stays partial; overlapping or invalid windows stay blocked.</small></div><span>local · advisory</span></div>
    <div class="cfmw-toolbar"><label>Operating month <select data-cfmw-month disabled><option>Run Joint CSV Analysis</option></select></label><button type="button" data-cfmw-refresh disabled>Refresh workspace</button></div>
    <div class="cfmw-status" data-cfmw-status>Run Joint CSV Analysis to build the monthly workspace.</div>
    <div class="cfmw-body" data-cfmw-body hidden></div>`;
  const provenance = joint.querySelector('[data-csv-provenance-audit]');
  const exportUi = joint.querySelector('[data-csv-analysis-export]');
  const reviewUi = joint.querySelector('[data-csv-library-review]');
  if (provenance) provenance.insertAdjacentElement('beforebegin', root);
  else if (exportUi) exportUi.insertAdjacentElement('beforebegin', root);
  else if (reviewUi) reviewUi.insertAdjacentElement('beforebegin', root);
  else joint.appendChild(root);

  root.querySelector('[data-cfmw-refresh]').addEventListener('click', () => void refresh(root, joint));
  root.querySelector('[data-cfmw-month]').addEventListener('change', () => renderSelected(root));
  joint.querySelector('[data-csv-joint-files]')?.addEventListener('change', () => reset(root, 'CSV selection changed. Run Joint CSV Analysis again.'));
  joint.querySelector('[data-csv-joint-clear]')?.addEventListener('click', () => reset(root, 'Local monthly workspace cleared.'));
  const jointStatus = joint.querySelector('[data-csv-joint-status]');
  if (jointStatus) {
    const sync = () => {
      const enabled = jointStatus.dataset.kind === 'success';
      setEnabled(root, enabled);
      if (enabled && !state.workspace) void refresh(root, joint);
    };
    new MutationObserver(sync).observe(jointStatus, { attributes: true, childList: true, characterData: true, subtree: true });
    sync();
  }
  state.mounted = true;
}

async function refresh(root, joint) {
  const files = [...(joint.querySelector('[data-csv-joint-files]')?.files || [])];
  if (!files.length || typeof window.CloudflareCsvJointAnalysis?.analyzeLocalCsvInputs !== 'function') return status(root, 'Joint CSV inputs are unavailable.', 'bad');
  const seq = ++state.requestSeq;
  state.busy = true;
  setEnabled(root, false);
  status(root, `Building monthly workspace locally from ${files.length} file${files.length === 1 ? '' : 's'}…`, 'loading');
  try {
    const inputs = await Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() })));
    if (seq !== state.requestSeq) return;
    const result = await window.CloudflareCsvJointAnalysis.analyzeLocalCsvInputs(inputs);
    if (seq !== state.requestSeq) return;
    state.workspace = buildCsvMonthlyOperatingWorkspace(result);
    populateMonthSelect(root);
    renderSelected(root);
    const s = state.workspace.summary;
    status(root, `${s.monthCount} month(s) · ${s.fullMonthCount} full coverage · ${s.partialMonthCount} partial · ${s.blockedMonthCount} blocked. No persistence or execution authority.`, s.blockedMonthCount ? 'bad' : s.partialMonthCount ? 'warn' : 'ok');
  } catch (error) {
    if (seq !== state.requestSeq) return;
    state.workspace = null;
    root.querySelector('[data-cfmw-body]').hidden = true;
    status(root, `Monthly workspace failed: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    if (seq !== state.requestSeq) return;
    state.busy = false;
    setEnabled(root, true);
  }
}

function populateMonthSelect(root) {
  const select = root.querySelector('[data-cfmw-month]');
  const months = [...(state.workspace?.months || [])].sort((a, b) => b.month.localeCompare(a.month));
  select.innerHTML = months.length ? months.map((item) => `<option value="${esc(item.month)}">${esc(item.month)} · ${esc(item.operatingState)}</option>`).join('') : '<option value="">No monthly snapshots</option>';
  select.disabled = months.length === 0;
}

function renderSelected(root) {
  const body = root.querySelector('[data-cfmw-body]');
  const monthKey = root.querySelector('[data-cfmw-month]').value;
  const item = state.workspace?.months.find((month) => month.month === monthKey);
  if (!item) { body.hidden = true; body.innerHTML = ''; return; }
  const currency = inferCurrency(item);
  const change = item.comparisonToPreviousMonth?.change || null;
  body.hidden = false;
  body.innerHTML = `
    <div class="cfmw-grid">
      ${card('Operating state', `<b>${esc(item.operatingState)}</b><small>${esc(item.reliability?.analyticalDecisionUse || 'unknown')}</small>`)}
      ${card('Coverage', `<b>${num(item.coverage?.coveredDayCount)}/${num(item.coverage?.expectedDayCount)} days · ${pct(item.coverage?.coverageRatio)}</b><small>${item.monthComplete ? 'full calendar month' : 'partial calendar month'}</small>`)}
      ${card('Ad spend', `<b>${money(item.metrics?.spendMicros, currency)}</b><small>vs prior ${pctChange(change?.spendPct)}</small>`)}
      ${card('Attributed sales', `<b>${money(item.metrics?.salesMicros, currency)}</b><small>vs prior ${pctChange(change?.salesPct)}</small>`)}
      ${card('Orders', `<b>${num(item.metrics?.orders)}</b><small>vs prior ${pctChange(change?.ordersPct)}</small>`)}
      ${card('ACoS / ROAS', `<b>${pct(item.metrics?.acos)} / ${dec(item.metrics?.roas)}</b><small>ACoS Δ ${deltaPoint(change?.acosDelta)}</small>`)}
      ${card('Ad contribution*', `<b>${money(item.adContributionMicros, currency)}</b><small>Sales - Ad Spend only; not net profit</small>`)}
      ${card('Source receipts', `<b>${item.sourceReceiptCount}</b><small>input-set ${esc(state.workspace.source.inputSetFingerprint.slice(0, 12))}</small>`)}
    </div>
    <div class="cfmw-receipts"><h5>${esc(item.month)} source evidence</h5>${receiptTable(item.sourceReceipts)}</div>
    <div class="cfmw-note"><b>Decision discipline:</b> this workspace is observational. Incomplete coverage is not promoted to a complete month; overlap or invalid-window states remain blocked. Observed CSV identity is not canonical Amazon identity.</div>`;
}

function receiptTable(receipts) {
  if (!receipts.length) return '<p>No overlapping source receipts were found for this month.</p>';
  return `<div class="cfmw-table"><table><thead><tr><th>Source file</th><th>Report window</th><th>Rows</th><th>Content SHA-256</th></tr></thead><tbody>${receipts.map((item) => `<tr><td>${esc(item.sourceFileName || 'unnamed')}</td><td>${esc(item.reportStartDate || '—')} → ${esc(item.reportEndDate || '—')}</td><td>${num(item.rowCount)}</td><td><code>${esc(item.contentSha256 || '—')}</code></td></tr>`).join('')}</tbody></table></div>`;
}
function deriveOperatingState(snapshot) { if (snapshot.reliability?.analyticalDecisionUse === 'blocked') return 'blocked'; if (snapshot.monthComplete === true) return 'full_month_review'; return 'partial_month_review'; }
function windowsIntersect(aStart, aEnd, bStart, bEnd) { if (!validDate(aStart) || !validDate(aEnd) || !validDate(bStart) || !validDate(bEnd)) return false; return bStart <= aEnd && bEnd >= aStart; }
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')); }
function inferCurrency(item) { return item.sourceReceipts.find((receipt) => receipt.currencyCode)?.currencyCode || null; }
function finiteOrNull(value) { return value == null || !Number.isFinite(Number(value)) ? null : Number(value); }
function card(label, value) { return `<div class="cfmw-card"><span>${esc(label)}</span>${value}</div>`; }
function setEnabled(root, enabled) { root.querySelector('[data-cfmw-refresh]').disabled = !enabled || state.busy; if (!enabled) root.querySelector('[data-cfmw-month]').disabled = true; }
function reset(root, message) { state.requestSeq += 1; state.busy = false; state.workspace = null; const select = root.querySelector('[data-cfmw-month]'); select.innerHTML = '<option>Run Joint CSV Analysis</option>'; select.disabled = true; const body = root.querySelector('[data-cfmw-body]'); body.hidden = true; body.innerHTML = ''; status(root, message); }
function status(root, message, kind = '') { const node = root.querySelector('[data-cfmw-status]'); node.textContent = message; node.dataset.kind = kind; }
function num(value) { return value == null || !Number.isFinite(Number(value)) ? '0' : Math.round(Number(value)).toLocaleString(); }
function pct(value) { return value == null || !Number.isFinite(Number(value)) ? '—' : `${(Number(value) * 100).toFixed(1)}%`; }
function dec(value) { return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(2); }
function pctChange(value) { return value == null || !Number.isFinite(Number(value)) ? 'n/a' : `${Number(value) > 0 ? '+' : ''}${(Number(value) * 100).toFixed(1)}%`; }
function deltaPoint(value) { return value == null || !Number.isFinite(Number(value)) ? '—' : `${Number(value) > 0 ? '+' : ''}${(Number(value) * 100).toFixed(1)}pp`; }
function money(micros, currency) { if (micros == null || !Number.isFinite(Number(micros))) return '—'; const value = Number(micros) / 1_000_000; try { return currency ? new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value) : value.toFixed(2); } catch { return `${currency || ''} ${value.toFixed(2)}`.trim(); } }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }

function assertAdvisoryOnly(result) {
  if (!result || typeof result !== 'object') throw workspaceError('CSV_MONTHLY_WORKSPACE_RESULT_REQUIRED');
  if (!/^[a-f0-9]{64}$/i.test(String(result.source?.inputSetFingerprint || ''))) throw workspaceError('CSV_MONTHLY_WORKSPACE_FINGERPRINT_INVALID');
  const flags = [
    result.source?.canonicalAmazonIdentityResolved, result.source?.governancePersistenceAllowed, result.source?.executionAuthorized, result.source?.amazonMutationAuthorized,
    result.analysis?.authority?.authoritative, result.analysis?.authority?.governancePersistenceAllowed, result.analysis?.authority?.executionAuthorized, result.analysis?.authority?.amazonMutationAuthorized,
    result.periods?.authority?.authoritative, result.periods?.authority?.governancePersistenceAllowed, result.periods?.authority?.executionAuthorized, result.periods?.authority?.amazonMutationAuthorized,
  ];
  if (flags.some((value) => value === true)) throw workspaceError('CSV_MONTHLY_WORKSPACE_AUTHORITY_ESCALATION_BLOCKED');
  for (const item of result.imports || []) if (!/^[a-f0-9]{64}$/i.test(String(item?.contentSha256 || ''))) throw workspaceError('CSV_MONTHLY_WORKSPACE_CONTENT_HASH_INVALID');
}
function workspaceError(code) { const error = new Error(code); error.name = 'CsvMonthlyOperatingWorkspaceError'; error.code = code; return error; }

function installStyles() {
  if (document.getElementById('cfmw-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfmw-style-v1';
  style.textContent = '.cfmw{margin-top:14px;padding-top:14px;border-top:1px solid #e2e8f0}.cfmw-head{display:flex;justify-content:space-between;gap:12px}.cfmw-head small{display:block;color:#64748b;max-width:780px}.cfmw-head>span{font-size:11px;font-weight:800}.cfmw-toolbar{display:flex;gap:8px;align-items:end;flex-wrap:wrap;margin-top:9px}.cfmw-toolbar label{display:grid;gap:3px;font-size:11px;color:#64748b}.cfmw select,.cfmw button{border:1px solid #cbd5e1;border-radius:7px;padding:7px 9px;background:#fff;font:inherit}.cfmw button{font-weight:700;cursor:pointer}.cfmw button:disabled,.cfmw select:disabled{opacity:.45}.cfmw-status,.cfmw-note{margin-top:8px;padding:8px;border-radius:7px;background:#f8fafc}.cfmw-status[data-kind="bad"]{color:#b91c1c}.cfmw-status[data-kind="warn"]{color:#a16207}.cfmw-status[data-kind="ok"]{color:#047857}.cfmw-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-top:10px}.cfmw-card{padding:9px;border:1px solid #e2e8f0;border-radius:8px;background:#fff}.cfmw-card>span,.cfmw-card small{display:block;color:#64748b;font-size:10px}.cfmw-card b{display:block;margin-top:2px}.cfmw-receipts{margin-top:10px}.cfmw-receipts h5{margin:0 0 6px}.cfmw-table{overflow:auto}.cfmw table{width:100%;border-collapse:collapse;font-size:11px}.cfmw th,.cfmw td{padding:6px;border-bottom:1px solid #edf2f7;text-align:left;vertical-align:top}.cfmw th{font-size:9px;color:#64748b;text-transform:uppercase}.cfmw code{font-size:10px;word-break:break-all}.cfmw-note{font-size:10px;color:#64748b}';
  document.head.appendChild(style);
}