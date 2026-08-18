export const CSV_HIERARCHY_QUALITY_UI_VERSION = '1.0.0';
const MAX_ROWS = 100;
const state = { mounted: false, rendering: false, result: null, level: 'campaigns' };

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvHierarchyQualityUi', {
    value: Object.freeze({ version: CSV_HIERARCHY_QUALITY_UI_VERSION, authority: 'browser_local_observation_only' }),
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
  if (joint.querySelector('[data-csv-hierarchy-quality]')) return void (state.mounted = true);
  installStyles();
  const root = document.createElement('section');
  root.className = 'cfhq';
  root.dataset.csvHierarchyQuality = CSV_HIERARCHY_QUALITY_UI_VERSION;
  root.innerHTML = `
    <div class="cfhq-head"><div><b>Data Quality & Hierarchy Analytics</b><small>Browser-local evidence from the same selected Search Term CSVs.</small></div><span>read-only · advisory</span></div>
    <div class="cfhq-status" data-cfhq-status>Run Joint CSV Analysis to populate date-window quality and hierarchy profitability.</div>
    <div data-cfhq-body hidden></div>`;
  const review = joint.querySelector('[data-csv-library-review]');
  if (review) review.insertAdjacentElement('beforebegin', root); else joint.appendChild(root);

  root.addEventListener('change', (event) => {
    if (!event.target.matches?.('[data-cfhq-level]')) return;
    state.level = event.target.value;
    render(root);
  });
  joint.querySelector('[data-csv-joint-files]')?.addEventListener('change', () => clear(root, 'CSV selection changed. Run Joint CSV Analysis again.'));
  joint.querySelector('[data-csv-joint-clear]')?.addEventListener('click', () => clear(root, 'Local hierarchy/quality view cleared.'));
  const jointStatus = joint.querySelector('[data-csv-joint-status]');
  if (jointStatus) {
    new MutationObserver(() => {
      if (jointStatus.dataset.kind === 'success') void refresh(root, joint);
      else if (jointStatus.dataset.kind === 'error') clear(root, 'Joint CSV Analysis did not complete successfully.');
    }).observe(jointStatus, { attributes: true, childList: true, characterData: true, subtree: true });
  }
  state.mounted = true;
}

async function refresh(root, joint) {
  if (state.rendering) return;
  const files = [...(joint.querySelector('[data-csv-joint-files]')?.files || [])];
  if (!files.length || typeof window.CloudflareCsvJointAnalysis?.analyzeLocalCsvInputs !== 'function') return;
  state.rendering = true;
  status(root, `Recomputing quality and hierarchy locally from ${files.length} file${files.length === 1 ? '' : 's'}…`, 'loading');
  try {
    const inputs = await Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() })));
    state.result = await window.CloudflareCsvJointAnalysis.analyzeLocalCsvInputs(inputs);
    state.level = 'campaigns';
    render(root);
    const quality = state.result.dataQuality;
    status(root, `${qualityLabel(quality)} · aggregation ${quality.safeForNaiveAggregation ? 'safe' : 'blocked'} · period ${quality.contiguousCoverage ? 'contiguous' : 'incomplete'}. No persistence or execution authority.`, quality.safeForNaiveAggregation ? 'ok' : 'bad');
  } catch (error) {
    clear(root, `Hierarchy/quality rendering failed: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.rendering = false;
  }
}

function clear(root, message, kind = '') {
  state.result = null;
  const body = root.querySelector('[data-cfhq-body]');
  body.hidden = true;
  body.innerHTML = '';
  status(root, message, kind);
}

function render(root) {
  if (!state.result) return;
  const quality = state.result.dataQuality || {};
  const hierarchy = state.result.hierarchy || {};
  const body = root.querySelector('[data-cfhq-body]');
  const items = hierarchy[state.level] || [];
  const currency = state.result.analysis?.context?.currencyCode || state.result.imports?.find((item) => item.currencyCode)?.currencyCode || null;
  body.hidden = false;
  body.innerHTML = `
    <div class="cfhq-cards" data-cfhq-quality>
      ${card('Quality', qualityLabel(quality))}
      ${card('Overlap pairs', num(quality.summary?.overlapPairCount))}
      ${card('Duplicate windows', num(quality.summary?.exactDuplicateWindowCount))}
      ${card('Gaps', `${num(quality.summary?.gapCount)} · ${num(quality.summary?.gapDayCount)} days`)}
      ${card('Reported days', num(quality.summary?.reportedWindowDayCount))}
      ${card('Unique covered days', num(quality.summary?.uniqueCoveredDayCount))}
      ${card('Overlap excess', num(quality.summary?.overlapExcessDayCount))}
      ${card('Decision use', hierarchy.reliability?.analyticalDecisionUse || '—')}
    </div>
    ${qualityEvidence(quality)}
    <div class="cfhq-toolbar"><label>Hierarchy <select data-cfhq-level><option value="campaigns" ${selected('campaigns')}>Campaign</option><option value="adGroups" ${selected('adGroups')}>Ad group</option><option value="targetings" ${selected('targetings')}>Targeting</option></select></label><span>${num(items.length)} observed rows · canonical Amazon identity unresolved</span></div>
    <div class="cfhq-table" data-cfhq-hierarchy><table><thead><tr><th>Observed identity</th><th>Spend</th><th>Sales</th><th>Orders</th><th>ACoS</th><th>ROAS</th><th>CVR</th><th>CPC</th><th>Ad contribution*</th><th>Quality</th></tr></thead><tbody>${items.length ? items.slice(0, MAX_ROWS).map((item) => hierarchyRow(item, currency)).join('') : '<tr><td colspan="10">No observed hierarchy rows.</td></tr>'}</tbody></table></div>
    ${items.length > MAX_ROWS ? `<div class="cfhq-limit">Showing first ${MAX_ROWS} of ${num(items.length)} rows.</div>` : ''}
    <div class="cfhq-foot"><b>* Ad contribution = attributed sales − ad spend.</b> It is not net profit and excludes product cost, Amazon fees, refunds, taxes, shipping and other operating costs. All hierarchy identities are CSV-observed only; persistence, execution and Amazon mutation remain disabled.</div>`;
}

function qualityEvidence(quality) {
  const overlaps = quality.overlapPairs || [];
  const gaps = quality.gaps || [];
  if (!overlaps.length && !gaps.length) return '<div class="cfhq-evidence ok"><b>No overlap or coverage-gap evidence detected.</b> Date-window aggregation is structurally clean for the supplied imports.</div>';
  const overlapText = overlaps.slice(0, 12).map((item) => `${esc(item.relation)}: ${esc(item.overlapStartDate)}→${esc(item.overlapEndDate)} (${num(item.overlapDayCount)}d)`).join('<br>');
  const gapText = gaps.slice(0, 12).map((item) => `${esc(item.gapStartDate)}→${esc(item.gapEndDate)} (${num(item.gapDayCount)}d)`).join('<br>');
  return `<div class="cfhq-evidence bad"><b>Human review required.</b>${overlapText ? `<div>Overlap: ${overlapText}</div>` : ''}${gapText ? `<div>Gap: ${gapText}</div>` : ''}</div>`;
}

function hierarchyRow(item, currency) {
  const metrics = item.metrics || {};
  const identity = item.identity || {};
  const observed = item.observedIdentity || {};
  const label = state.level === 'campaigns'
    ? (identity.campaign?.name || identity.campaign?.id || 'unresolved')
    : state.level === 'adGroups'
      ? (identity.adGroup?.name || identity.adGroup?.id || 'unresolved')
      : (identity.targeting?.text || identity.targeting?.id || 'unresolved');
  const parent = state.level === 'campaigns' ? '' : state.level === 'adGroups'
    ? (identity.campaign?.name || identity.campaign?.id || '')
    : [identity.campaign?.name || identity.campaign?.id, identity.adGroup?.name || identity.adGroup?.id].filter(Boolean).join(' / ');
  return `<tr><td><b>${esc(label)}</b><small>${esc(parent)}</small></td><td>${money(metrics.spendMicros, currency)}</td><td>${money(metrics.salesMicros, currency)}</td><td>${num(metrics.orders)}</td><td>${pct(metrics.acos)}</td><td>${dec(metrics.roas)}</td><td>${pct(metrics.cvr)}</td><td>${money(metrics.cpcMicros, currency)}</td><td>${money(item.adContributionMicros, currency)}</td><td class="${observed.ambiguous ? 'bad' : ''}"><b>${esc(item.performanceBand || 'observe')}</b><small>${observed.ambiguous ? `identity blocked · ${esc((observed.conflictCodes || []).join(', '))}` : esc(observed.confidence || 'observed_only')}</small></td></tr>`;
}

function selected(level) { return state.level === level ? 'selected' : ''; }
function qualityLabel(quality) { return String(quality?.qualityState || 'unknown'); }
function card(label, value) { return `<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`; }
function status(root, message, kind = '') { const node = root.querySelector('[data-cfhq-status]'); node.textContent = message; node.dataset.kind = kind; }
function num(value) { return value == null || !Number.isFinite(Number(value)) ? '0' : Math.round(Number(value)).toLocaleString(); }
function pct(value) { return value == null || !Number.isFinite(Number(value)) ? '—' : `${(Number(value) * 100).toFixed(1)}%`; }
function dec(value) { return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(2); }
function money(micros, currency) { if (micros == null || !Number.isFinite(Number(micros))) return '—'; const value = Number(micros) / 1_000_000; try { return currency ? new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value) : value.toFixed(2); } catch { return `${currency || ''} ${value.toFixed(2)}`.trim(); } }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }

function installStyles() {
  if (document.getElementById('cfhq-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfhq-style-v1';
  style.textContent = '.cfhq{margin-top:14px;padding-top:14px;border-top:1px solid #e2e8f0}.cfhq-head{display:flex;justify-content:space-between;gap:12px}.cfhq-head small{display:block;color:#64748b}.cfhq-head>span{font-size:11px;font-weight:800}.cfhq-status,.cfhq-evidence,.cfhq-foot{margin-top:9px;padding:8px;border-radius:7px;background:#f8fafc}.cfhq-status[data-kind="bad"],.cfhq-evidence.bad,.cfhq-table .bad{color:#b91c1c}.cfhq-status[data-kind="ok"],.cfhq-evidence.ok{color:#047857}.cfhq-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin-top:9px}.cfhq-cards>div{border:1px solid #e2e8f0;border-radius:7px;padding:7px}.cfhq-cards span{display:block;color:#64748b;font-size:10px}.cfhq-cards b{display:block;margin-top:2px}.cfhq-toolbar{display:flex;justify-content:space-between;align-items:end;gap:10px;margin-top:10px}.cfhq-toolbar label{display:flex;flex-direction:column;font-size:11px}.cfhq-toolbar select{border:1px solid #cbd5e1;border-radius:6px;padding:6px;background:#fff}.cfhq-toolbar>span{font-size:10px;color:#64748b}.cfhq-table{overflow:auto;margin-top:7px}.cfhq-table table{width:100%;border-collapse:collapse;font-size:11px}.cfhq-table th,.cfhq-table td{padding:6px;border-bottom:1px solid #edf2f7;text-align:left;vertical-align:top;white-space:nowrap}.cfhq-table th{font-size:9px;color:#64748b;text-transform:uppercase}.cfhq-table small{display:block;color:#64748b;max-width:320px;white-space:normal}.cfhq-limit{font-size:10px;color:#64748b;margin-top:5px}.cfhq-foot{font-size:10px;color:#64748b}@media(max-width:900px){.cfhq-cards{grid-template-columns:repeat(2,minmax(0,1fr))}}';
  document.head.appendChild(style);
}
