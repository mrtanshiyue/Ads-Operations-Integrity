export const CSV_PERIOD_UI_VERSION = '1.0.0';
const state = { mounted: false, rendering: false, requestSeq: 0, result: null };

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvPeriodUi', {
    value: Object.freeze({ version: CSV_PERIOD_UI_VERSION, authority: 'browser_local_observation_only' }),
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
  if (joint.querySelector('[data-csv-period-ui]')) return void (state.mounted = true);
  installStyles();
  const root = document.createElement('section');
  root.className = 'cfp';
  root.dataset.csvPeriodUi = CSV_PERIOD_UI_VERSION;
  root.innerHTML = `
    <div class="cfp-head"><div><b>Period-over-Period</b><small>7 / 14 / 30 / 60 / 90 day comparisons and calendar-month snapshots from local CSV evidence.</small></div><span>read-only · advisory</span></div>
    <div class="cfp-status" data-cfp-status>Run Joint CSV Analysis to populate period comparisons.</div>
    <div data-cfp-body hidden></div>`;
  const review = joint.querySelector('[data-csv-library-review]');
  if (review) review.insertAdjacentElement('beforebegin', root); else joint.appendChild(root);

  joint.querySelector('[data-csv-joint-files]')?.addEventListener('change', () => clear(root, 'CSV selection changed. Run Joint CSV Analysis again.'));
  joint.querySelector('[data-csv-joint-clear]')?.addEventListener('click', () => clear(root, 'Local period view cleared.'));
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
  const files = [...(joint.querySelector('[data-csv-joint-files]')?.files || [])];
  if (!files.length || typeof window.CloudflareCsvJointAnalysis?.analyzeLocalCsvInputs !== 'function') return;
  const seq = ++state.requestSeq;
  state.rendering = true;
  status(root, `Recomputing period views locally from ${files.length} file${files.length === 1 ? '' : 's'}…`, 'loading');
  try {
    const inputs = await Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() })));
    if (seq !== state.requestSeq) return;
    const result = await window.CloudflareCsvJointAnalysis.analyzeLocalCsvInputs(inputs);
    if (seq !== state.requestSeq) return;
    state.result = result;
    render(root);
    const periods = state.result.periods;
    const blocked = periods.summary.blockedTrailingComparisonCount;
    const incomplete = periods.summary.incompleteTrailingComparisonCount;
    status(root, `${periods.summary.trailingComparisonCount} trailing comparisons · ${periods.summary.monthlySnapshotCount} monthly snapshots · ${blocked} blocked · ${incomplete} incomplete. No persistence or execution authority.`, blocked ? 'bad' : incomplete ? 'warn' : 'ok');
  } catch (error) {
    if (seq !== state.requestSeq) return;
    clear(root, `Period rendering failed: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    if (seq === state.requestSeq) state.rendering = false;
  }
}

function clear(root, message, kind = '') {
  state.requestSeq += 1;
  state.rendering = false;
  state.result = null;
  const body = root.querySelector('[data-cfp-body]');
  body.hidden = true;
  body.innerHTML = '';
  status(root, message, kind);
}

function render(root) {
  if (!state.result?.periods) return;
  const periods = state.result.periods;
  const currency = state.result.analysis?.context?.currencyCode || state.result.imports?.find((item) => item.currencyCode)?.currencyCode || null;
  const body = root.querySelector('[data-cfp-body]');
  body.hidden = false;
  body.innerHTML = `
    <div class="cfp-range"><span>Observed fact range</span><b>${esc(periods.observationRange.startDate || '—')} → ${esc(periods.observationRange.endDate || '—')}</b><span>Aggregation safety</span><b>${periods.summary.aggregationSafe ? 'safe' : 'blocked'}</b></div>
    <div class="cfp-block" data-cfp-trailing><h5>Trailing windows</h5><div class="cfp-table"><table><thead><tr><th>Window</th><th>Coverage</th><th>Spend</th><th>Sales</th><th>Orders</th><th>ACoS</th><th>ROAS</th><th>Spend Δ</th><th>Sales Δ</th><th>Orders Δ</th><th>Decision use</th></tr></thead><tbody>${periods.trailingComparisons.map((item) => trailingRow(item, currency)).join('')}</tbody></table></div></div>
    <div class="cfp-block" data-cfp-monthly><h5>Calendar-month snapshots</h5><div class="cfp-table"><table><thead><tr><th>Month</th><th>Coverage</th><th>Spend</th><th>Sales</th><th>Orders</th><th>ACoS</th><th>ROAS</th><th>Ad contribution*</th><th>vs previous month</th><th>Decision use</th></tr></thead><tbody>${periods.monthlySnapshots.length ? periods.monthlySnapshots.map((item) => monthlyRow(item, currency)).join('') : '<tr><td colspan="10">No monthly snapshots.</td></tr>'}</tbody></table></div></div>
    <div class="cfp-foot"><b>* Ad contribution = attributed sales − ad spend, not net profit.</b> Percentage change from a zero prior baseline is shown as “n/a”, never Infinity. Partial coverage and overlapping windows remain advisory-only and require human review.</div>`;
}

function trailingRow(item, currency) {
  const current = item.current;
  const previous = item.previous;
  return `<tr><td><b>${item.days}d</b><small>${esc(current.startDate)}→${esc(current.endDate)} vs ${esc(previous.startDate)}→${esc(previous.endDate)}</small></td><td>${coverage(current)} / ${coverage(previous)}<small>current / previous</small></td><td>${money(current.metrics.spendMicros, currency)}<small>${money(previous.metrics.spendMicros, currency)} prior</small></td><td>${money(current.metrics.salesMicros, currency)}<small>${money(previous.metrics.salesMicros, currency)} prior</small></td><td>${num(current.metrics.orders)}<small>${num(previous.metrics.orders)} prior</small></td><td>${pct(current.metrics.acos)}<small>${deltaPoint(item.change.acosDelta)}</small></td><td>${dec(current.metrics.roas)}<small>${signed(item.change.roasDelta)}</small></td><td>${pctChange(item.change.spendPct)}</td><td>${pctChange(item.change.salesPct)}</td><td>${pctChange(item.change.ordersPct)}</td><td class="${item.reliability.analyticalDecisionUse === 'blocked' ? 'bad' : item.reliability.state === 'incomplete_coverage' ? 'warn' : ''}"><b>${esc(item.reliability.analyticalDecisionUse)}</b><small>${esc(item.reliability.state)}</small></td></tr>`;
}

function monthlyRow(item, currency) {
  const comparison = item.comparisonToPreviousMonth;
  const change = comparison?.change;
  return `<tr><td><b>${esc(item.month)}</b><small>${esc(item.startDate)}→${esc(item.endDate)}</small></td><td>${coverage(item)}</td><td>${money(item.metrics.spendMicros, currency)}</td><td>${money(item.metrics.salesMicros, currency)}</td><td>${num(item.metrics.orders)}</td><td>${pct(item.metrics.acos)}</td><td>${dec(item.metrics.roas)}</td><td>${money(item.adContributionMicros, currency)}</td><td>${comparison ? `spend ${pctChange(change.spendPct)} · sales ${pctChange(change.salesPct)} · orders ${pctChange(change.ordersPct)}` : '—'}</td><td class="${item.reliability.analyticalDecisionUse === 'blocked' ? 'bad' : item.reliability.state === 'incomplete_coverage' ? 'warn' : ''}"><b>${esc(item.reliability.analyticalDecisionUse)}</b><small>${item.monthComplete ? 'full month' : 'partial month'}</small></td></tr>`;
}

function coverage(item) { return `${num(item.coverage?.coveredDayCount)}/${num(item.coverage?.expectedDayCount)}d · ${pct(item.coverage?.coverageRatio)}`; }
function pctChange(value) { return value == null ? 'n/a' : signedPct(value); }
function signedPct(value) { const number = Number(value); return `${number > 0 ? '+' : ''}${(number * 100).toFixed(1)}%`; }
function deltaPoint(value) { const number = Number(value); return value == null || !Number.isFinite(number) ? '—' : `${number > 0 ? '+' : ''}${(number * 100).toFixed(1)}pp`; }
function signed(value) { const number = Number(value); return value == null || !Number.isFinite(number) ? '—' : `${number > 0 ? '+' : ''}${number.toFixed(2)}`; }
function status(root, message, kind = '') { const node = root.querySelector('[data-cfp-status]'); node.textContent = message; node.dataset.kind = kind; }
function num(value) { return value == null || !Number.isFinite(Number(value)) ? '0' : Math.round(Number(value)).toLocaleString(); }
function pct(value) { return value == null || !Number.isFinite(Number(value)) ? '—' : `${(Number(value) * 100).toFixed(1)}%`; }
function dec(value) { return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(2); }
function money(micros, currency) { if (micros == null || !Number.isFinite(Number(micros))) return '—'; const value = Number(micros) / 1_000_000; try { return currency ? new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value) : value.toFixed(2); } catch { return `${currency || ''} ${value.toFixed(2)}`.trim(); } }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }

function installStyles() {
  if (document.getElementById('cfp-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfp-style-v1';
  style.textContent = '.cfp{margin-top:14px;padding-top:14px;border-top:1px solid #e2e8f0}.cfp-head{display:flex;justify-content:space-between;gap:12px}.cfp-head small{display:block;color:#64748b}.cfp-head>span{font-size:11px;font-weight:800}.cfp-status,.cfp-foot,.cfp-range{margin-top:9px;padding:8px;border-radius:7px;background:#f8fafc}.cfp-status[data-kind="bad"],.cfp-table .bad{color:#b91c1c}.cfp-status[data-kind="warn"],.cfp-table .warn{color:#a16207}.cfp-status[data-kind="ok"]{color:#047857}.cfp-range{display:grid;grid-template-columns:auto 1fr auto 1fr;gap:6px}.cfp-range span{color:#64748b}.cfp-block{margin-top:10px}.cfp-block h5{margin:0 0 6px;font-size:12px}.cfp-table{overflow:auto}.cfp-table table{width:100%;border-collapse:collapse;font-size:11px}.cfp-table th,.cfp-table td{padding:6px;border-bottom:1px solid #edf2f7;text-align:left;vertical-align:top;white-space:nowrap}.cfp-table th{font-size:9px;color:#64748b;text-transform:uppercase}.cfp-table small{display:block;color:#64748b}.cfp-foot{font-size:10px;color:#64748b}@media(max-width:760px){.cfp-range{grid-template-columns:1fr 2fr}}';
  document.head.appendChild(style);
}
