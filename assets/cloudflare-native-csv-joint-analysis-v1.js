import { parseAmazonSearchTermCsv } from './csv-analysis-engine/csv-search-term-import.js';
import { analyzeCsvImportBatches } from './csv-analysis-engine/csv-joint-report-analysis.js';

export const CSV_JOINT_ANALYSIS_UI_VERSION = '1.0.0';
const MAX_FILES = 24;
const MAX_RENDER_ROWS = 100;

export class CsvJointAnalysisUiError extends Error {
  constructor(code, details = null) {
    super(code);
    this.name = 'CsvJointAnalysisUiError';
    this.code = code;
    this.details = details;
  }
}

export async function analyzeLocalCsvInputs(inputs, options = {}) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new CsvJointAnalysisUiError('CSV_JOINT_UI_FILES_REQUIRED');
  }
  if (inputs.length > MAX_FILES) {
    throw new CsvJointAnalysisUiError('CSV_JOINT_UI_FILE_LIMIT_EXCEEDED', { maxFiles: MAX_FILES });
  }
  const uploadedAt = String(options.uploadedAt || new Date().toISOString());
  const batches = [];
  for (const input of inputs) {
    const sourceFileName = String(input?.name || '').trim();
    const csvText = input?.text;
    if (!sourceFileName || typeof csvText !== 'string') {
      throw new CsvJointAnalysisUiError('CSV_JOINT_UI_FILE_INVALID', { sourceFileName });
    }
    const batch = await parseAmazonSearchTermCsv({ csvText, sourceFileName, uploadedAt });
    if (!batch.ok) {
      throw new CsvJointAnalysisUiError('CSV_JOINT_UI_IMPORT_REJECTED', {
        sourceFileName,
        errors: batch.errors.slice(0, 12),
      });
    }
    batches.push(batch);
  }
  return analyzeCsvImportBatches(batches, options.rules ? { rules: options.rules } : {});
}

const browserState = {
  mounted: false,
  result: null,
};

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvJointAnalysis', {
    value: Object.freeze({
      version: CSV_JOINT_ANALYSIS_UI_VERSION,
      analyzeLocalCsvInputs,
      authority: 'csv_advisory_only',
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
  if (browserState.mounted) return;
  const host = document.getElementById('cfDecisionPanel');
  if (!host) {
    new MutationObserver((_, observer) => {
      if (!document.getElementById('cfDecisionPanel')) return;
      observer.disconnect();
      mount();
    }).observe(document.documentElement, { childList: true, subtree: true });
    return;
  }
  if (host.querySelector('[data-csv-joint-analysis]')) {
    browserState.mounted = true;
    return;
  }

  installStyles();
  const section = document.createElement('section');
  section.className = 'cfja-panel';
  section.dataset.csvJointAnalysis = CSV_JOINT_ANALYSIS_UI_VERSION;
  section.innerHTML = `
    <div class="cfja-header">
      <div>
        <span class="cfja-eyebrow">Joint CSV Analysis</span>
        <h3>Multi-report profitability & targeting identity</h3>
        <p>Files are parsed and analyzed in this browser. No upload, D1 write, Amazon request, persistence, or execution is performed.</p>
      </div>
      <div class="cfja-badges" aria-label="analysis authority">
        <span>Browser-local</span><span>Advisory only</span><span>Amazon mutation disabled</span>
      </div>
    </div>
    <div class="cfja-controls">
      <label class="cfja-file-control">Search Term CSV files
        <input type="file" accept=".csv,text/csv" multiple data-csv-joint-files>
      </label>
      <button type="button" class="cfja-primary" data-csv-joint-run disabled>Analyze selected CSVs</button>
      <button type="button" class="cfja-secondary" data-csv-joint-clear>Clear local result</button>
    </div>
    <div class="cfja-status" data-csv-joint-status data-kind="idle">Select up to ${MAX_FILES} Search Term CSV files. Duplicate content is rejected by SHA-256.</div>
    <div class="cfja-results" data-csv-joint-results hidden></div>`;

  const controls = host.querySelector('.cfdi-controls');
  if (controls?.parentElement) controls.insertAdjacentElement('afterend', section);
  else host.prepend(section);

  const input = section.querySelector('[data-csv-joint-files]');
  const run = section.querySelector('[data-csv-joint-run]');
  const clear = section.querySelector('[data-csv-joint-clear]');
  input.addEventListener('change', () => {
    const count = input.files?.length || 0;
    run.disabled = count === 0 || count > MAX_FILES;
    setStatus(section, count > MAX_FILES
      ? `Too many files selected. Limit is ${MAX_FILES}.`
      : count
        ? `${count} file${count === 1 ? '' : 's'} selected. Analysis remains browser-local until you clear or leave the page.`
        : `Select up to ${MAX_FILES} Search Term CSV files. Duplicate content is rejected by SHA-256.`, count > MAX_FILES ? 'error' : 'idle');
  });
  run.addEventListener('click', () => void runAnalysis(section));
  clear.addEventListener('click', () => clearAnalysis(section));
  browserState.mounted = true;
}

async function runAnalysis(section) {
  const input = section.querySelector('[data-csv-joint-files]');
  const run = section.querySelector('[data-csv-joint-run]');
  const files = [...(input.files || [])];
  if (!files.length) return setStatus(section, 'Select one or more Search Term CSV files.', 'error');
  if (files.length > MAX_FILES) return setStatus(section, `Too many files selected. Limit is ${MAX_FILES}.`, 'error');

  run.disabled = true;
  run.setAttribute('aria-busy', 'true');
  setStatus(section, `Parsing and joining ${files.length} local CSV file${files.length === 1 ? '' : 's'}…`, 'loading');
  try {
    const inputs = await Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() })));
    const result = await analyzeLocalCsvInputs(inputs);
    browserState.result = result;
    renderResult(section, result);
    setStatus(section, `${result.summary.batchCount} imports · ${result.summary.factCount} facts · ${result.summary.analyzedTermCount} terms. Advisory output only; canonical Amazon identity remains unresolved.`, 'success');
  } catch (error) {
    browserState.result = null;
    const results = section.querySelector('[data-csv-joint-results]');
    results.hidden = true;
    results.innerHTML = '';
    setStatus(section, friendlyError(error), 'error');
  } finally {
    run.removeAttribute('aria-busy');
    run.disabled = !(input.files?.length > 0 && input.files.length <= MAX_FILES);
  }
}

function clearAnalysis(section) {
  browserState.result = null;
  const input = section.querySelector('[data-csv-joint-files]');
  const results = section.querySelector('[data-csv-joint-results]');
  input.value = '';
  results.hidden = true;
  results.innerHTML = '';
  section.querySelector('[data-csv-joint-run]').disabled = true;
  setStatus(section, `Local selection and rendered analysis cleared. Select up to ${MAX_FILES} Search Term CSV files.`, 'idle');
}

function renderResult(section, result) {
  const target = section.querySelector('[data-csv-joint-results]');
  const summary = result.summary || {};
  const metrics = summary.metrics || {};
  const analysis = result.analysis || {};
  const identity = result.observedIdentity || {};
  const currency = analysis.context?.currencyCode || result.imports?.find((item) => item.currencyCode)?.currencyCode || null;

  target.hidden = false;
  target.innerHTML = `
    <div class="cfja-authority-callout">
      <strong>Non-authoritative CSV observation.</strong>
      Observed campaign/ad-group/targeting IDs are evidence only. Governance persistence, optimization execution, and Amazon mutation remain disabled.
    </div>
    <div class="cfja-summary-grid" data-csv-joint-summary>
      ${summaryCard('Spend', money(metrics.spendMicros, currency))}
      ${summaryCard('Sales', money(metrics.salesMicros, currency))}
      ${summaryCard('ACoS', percent(metrics.acos))}
      ${summaryCard('ROAS', decimal(metrics.roas))}
      ${summaryCard('Orders', integer(metrics.orders))}
      ${summaryCard('CVR', percent(metrics.cvr))}
      ${summaryCard('CPC', money(metrics.cpcMicros, currency))}
      ${summaryCard('Date range', `${esc(result.range?.startDate || '—')} → ${esc(result.range?.endDate || '—')}`)}
    </div>
    <div class="cfja-count-grid">
      ${countCard('Profit terms', summary.profitTermCount)}
      ${countCard('Waste terms', summary.wasteTermCount)}
      ${countCard('Toxic roots', summary.toxicRootCount)}
      ${countCard('Protected roots', analysis.summary?.protectedRootCount)}
      ${countCard('Exact negatives', summary.exactNegativeCandidateCount)}
      ${countCard('Phrase reviews', summary.phraseRootReviewCount)}
      ${countCard('Harvest reviews', summary.harvestCandidateCount)}
      ${countCard('Ambiguous identities', summary.ambiguousObservedIdentityCount)}
    </div>
    ${twoColumnSection(
      'Profit Terms',
      termTable(analysis.profitTerms || [], currency, 'No profit terms meet the current evidence threshold.'),
      'Waste Terms',
      termTable(analysis.wasteTerms || [], currency, 'No waste terms meet the current evidence threshold.'),
    )}
    ${twoColumnSection(
      'Toxic Roots',
      rootTable(analysis.toxicRoots || [], currency, 'No toxic roots detected.'),
      'Profitable / Protected Roots',
      protectedRootTable(analysis, currency),
    )}
    ${sectionBlock('Advisory Candidates', suggestionTable(analysis, currency), 'candidates')}
    ${sectionBlock('Observed Targeting Identity', identityTable(identity.identities || []), 'identity')}
    ${sectionBlock('Source Imports & Provenance', importsTable(result.imports || []), 'imports')}
    <div class="cfja-fingerprint-grid">
      <div><span>Input-set fingerprint</span><code title="${esc(result.source?.inputSetFingerprint || '')}">${esc(result.source?.inputSetFingerprint || '—')}</code></div>
      <div><span>Canonical Amazon identity</span><strong>unresolved</strong></div>
      <div><span>Persistence authority</span><strong>disabled</strong></div>
      <div><span>Execution / Amazon mutation</span><strong>disabled</strong></div>
    </div>`;
}

function termTable(items, currency, empty) {
  const rows = items.slice(0, MAX_RENDER_ROWS).map((item) => `<tr>
    <td><strong>${esc(item.searchTerm)}</strong></td>
    <td>${money(item.metrics?.spendMicros, currency)}</td>
    <td>${money(item.metrics?.salesMicros, currency)}</td>
    <td>${integer(item.metrics?.orders)}</td>
    <td>${percent(item.metrics?.acos)}</td>
    <td>${percent(item.metrics?.cvr)}</td>
    <td>${decimal(item.priorityScore)}</td>
  </tr>`).join('');
  return table(`<tr><th>Search term</th><th>Spend</th><th>Sales</th><th>Orders</th><th>ACoS</th><th>CVR</th><th>Priority</th></tr>`, rows, 7, empty, items.length);
}

function rootTable(items, currency, empty) {
  const rows = items.slice(0, MAX_RENDER_ROWS).map((item) => `<tr>
    <td><strong>${esc(item.root)}</strong></td><td>${integer(item.termCount)}</td><td>${money(item.metrics?.spendMicros, currency)}</td>
    <td>${integer(item.metrics?.orders)}</td><td>${percent(item.metrics?.acos)}</td><td>${decimal(item.priorityScore)}</td>
  </tr>`).join('');
  return table(`<tr><th>Root</th><th>Terms</th><th>Spend</th><th>Orders</th><th>ACoS</th><th>Priority</th></tr>`, rows, 6, empty, items.length);
}

function protectedRootTable(analysis, currency) {
  const merged = new Map();
  for (const item of analysis.profitableRoots || []) merged.set(item.root, { ...item, label: 'profitable' });
  for (const item of analysis.protectedRoots || []) merged.set(item.root, { ...item, label: item.classification === 'profitable' ? 'profitable + protected' : 'protected from phrase negative' });
  const items = [...merged.values()].sort((a, b) => b.priorityScore - a.priorityScore || a.root.localeCompare(b.root));
  const rows = items.slice(0, MAX_RENDER_ROWS).map((item) => `<tr>
    <td><strong>${esc(item.root)}</strong><small>${esc(item.label)}</small></td><td>${integer(item.termCount)}</td>
    <td>${integer(item.profitTermCount)}</td><td>${money(item.metrics?.spendMicros, currency)}</td><td>${percent(item.metrics?.acos)}</td>
  </tr>`).join('');
  return table(`<tr><th>Root</th><th>Terms</th><th>Profit terms</th><th>Spend</th><th>ACoS</th></tr>`, rows, 5, 'No profitable or profit-protected roots detected.', items.length);
}

function suggestionTable(analysis, currency) {
  const suggestions = [
    ...(analysis.negativeSuggestions || []).map((item) => ({ ...item, group: item.matchScope === 'exact' ? 'Exact negative' : 'Phrase review' })),
    ...(analysis.harvestSuggestions || []).map((item) => ({ ...item, group: 'Harvest review' })),
  ];
  const rows = suggestions.slice(0, MAX_RENDER_ROWS).map((item) => `<tr>
    <td><span class="cfja-pill">${esc(item.group)}</span></td><td><strong>${esc(item.value)}</strong></td>
    <td>${money(item.metrics?.spendMicros, currency)}</td><td>${integer(item.metrics?.orders)}</td><td>${percent(item.metrics?.acos)}</td>
    <td>${decimal(item.priorityScore)}</td><td><span class="cfja-review">Human review required</span></td>
  </tr>`).join('');
  return table(`<tr><th>Candidate</th><th>Value</th><th>Spend</th><th>Orders</th><th>ACoS</th><th>Priority</th><th>Authority</th></tr>`, rows, 7, 'No advisory candidates generated.', suggestions.length);
}

function identityTable(items) {
  const rows = items.slice(0, MAX_RENDER_ROWS).map((item) => {
    const basis = item.identityBasis || {};
    const confidence = item.confidence || {};
    return `<tr>
      <td><strong>${esc(item.observedIdentityState || 'unresolved')}</strong><small>${item.evidence?.ambiguous ? 'ambiguous · blocked' : esc(confidence.band || 'low_observed')}</small></td>
      <td>${esc(basis.campaignName || basis.campaignId || '—')}</td>
      <td>${esc(basis.adGroupName || basis.adGroupId || '—')}</td>
      <td>${esc(basis.targeting || basis.targetingId || '—')}<small>${esc(basis.targetingId || '')}</small></td>
      <td>${percent(confidence.score)}</td>
      <td><code title="${esc(item.localIdentityFingerprint || '')}">${shortHash(item.localIdentityFingerprint)}</code></td>
      <td>${item.evidence?.ambiguous ? `<span class="cfja-danger">${esc((item.evidence.conflictCodes || []).join(', '))}</span>` : 'observed only'}</td>
    </tr>`;
  }).join('');
  return table(`<tr><th>State</th><th>Campaign</th><th>Ad group</th><th>Targeting</th><th>Observed confidence</th><th>Local fingerprint</th><th>Quality</th></tr>`, rows, 7, 'No observed targeting identity was available in the selected CSVs.', items.length);
}

function importsTable(items) {
  const rows = items.map((item) => `<tr>
    <td><strong>${esc(item.sourceFileName || '—')}</strong></td>
    <td>${esc(item.reportStartDate || '—')} → ${esc(item.reportEndDate || '—')}</td>
    <td>${integer(item.rowCount)}</td><td>${esc(item.marketplace || '—')}</td><td>${esc(item.currencyCode || '—')}</td>
    <td><code title="${esc(item.contentSha256 || '')}">${shortHash(item.contentSha256)}</code></td>
  </tr>`).join('');
  return table(`<tr><th>File</th><th>Report range</th><th>Rows</th><th>Marketplace</th><th>Currency</th><th>Content SHA-256</th></tr>`, rows, 6, 'No source imports.', items.length);
}

function summaryCard(label, value) {
  return `<div class="cfja-summary-card"><span>${esc(label)}</span><strong>${value}</strong></div>`;
}
function countCard(label, value) {
  return `<div class="cfja-count-card"><span>${esc(label)}</span><strong>${integer(value)}</strong></div>`;
}
function sectionBlock(title, content, key) {
  return `<section class="cfja-block" data-csv-joint-${key}><h4>${esc(title)}</h4>${content}</section>`;
}
function twoColumnSection(leftTitle, leftContent, rightTitle, rightContent) {
  return `<div class="cfja-columns"><section class="cfja-block"><h4>${esc(leftTitle)}</h4>${leftContent}</section><section class="cfja-block"><h4>${esc(rightTitle)}</h4>${rightContent}</section></div>`;
}
function table(head, rows, colspan, empty, count) {
  const clipped = count > MAX_RENDER_ROWS ? `<div class="cfja-clipped">Showing first ${MAX_RENDER_ROWS} of ${integer(count)} rows.</div>` : '';
  return `${clipped}<div class="cfja-table-wrap"><table class="cfja-table"><thead>${head}</thead><tbody>${rows || `<tr><td colspan="${colspan}">${esc(empty)}</td></tr>`}</tbody></table></div>`;
}

function setStatus(section, text, kind) {
  const node = section.querySelector('[data-csv-joint-status]');
  node.textContent = text;
  node.dataset.kind = kind || 'idle';
}

function friendlyError(error) {
  const code = String(error?.code || error?.message || 'CSV_JOINT_UI_ANALYSIS_FAILED');
  if (code === 'CSV_JOINT_ANALYSIS_DUPLICATE_CONTENT') return 'Duplicate CSV content detected by SHA-256. Remove the duplicate report and run again.';
  if (code === 'CSV_JOINT_UI_IMPORT_REJECTED') {
    const details = error.details || {};
    const codes = (details.errors || []).map((item) => item.code).filter(Boolean).slice(0, 5).join(', ');
    return `${details.sourceFileName || 'CSV'} was rejected by the canonical parser${codes ? `: ${codes}` : '.'}`;
  }
  if (/MIXED_(ADVERTISER|PROFILE|MARKETPLACE|CURRENCY)_SCOPE/.test(code)) {
    return `Selected files do not share one analytical scope (${code}). Split them into separate joint analyses.`;
  }
  if (code === 'CSV_JOINT_UI_FILE_LIMIT_EXCEEDED') return `Too many files selected. Limit is ${MAX_FILES}.`;
  return `Joint CSV analysis failed: ${code}`;
}

function installStyles() {
  if (document.getElementById('cfja-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfja-style-v1';
  style.textContent = `
    .cfja-panel{margin:16px 0;padding:18px;border:1px solid #d8dee9;border-radius:12px;background:#fff;color:#182230;font:13px/1.45 Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .cfja-header{display:flex;justify-content:space-between;gap:18px;align-items:flex-start}.cfja-eyebrow{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#53657d}.cfja-header h3{margin:3px 0 4px;font-size:18px}.cfja-header p{margin:0;color:#637083;max-width:780px}
    .cfja-badges{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}.cfja-badges span,.cfja-pill{border:1px solid #cbd5e1;border-radius:999px;padding:4px 8px;background:#f8fafc;font-size:11px;font-weight:700;white-space:nowrap}
    .cfja-controls{display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin:16px 0 10px}.cfja-file-control{display:flex;flex-direction:column;gap:5px;font-weight:700;min-width:320px}.cfja-file-control input{font:inherit;border:1px solid #cbd5e1;border-radius:8px;padding:8px;background:#fff}
    .cfja-primary,.cfja-secondary{border-radius:8px;padding:9px 12px;font:inherit;font-weight:800;cursor:pointer}.cfja-primary{border:1px solid #1f2937;background:#1f2937;color:#fff}.cfja-primary:disabled{opacity:.45;cursor:not-allowed}.cfja-secondary{border:1px solid #cbd5e1;background:#fff;color:#334155}
    .cfja-status{padding:9px 11px;border-radius:8px;background:#f8fafc;color:#475569}.cfja-status[data-kind="loading"]{background:#eff6ff;color:#1d4ed8}.cfja-status[data-kind="success"]{background:#ecfdf5;color:#047857}.cfja-status[data-kind="error"]{background:#fef2f2;color:#b91c1c}
    .cfja-results{margin-top:14px}.cfja-authority-callout{padding:11px 12px;border:1px solid #fde68a;background:#fffbeb;border-radius:8px;color:#854d0e}.cfja-summary-grid,.cfja-count-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:12px}.cfja-summary-card,.cfja-count-card{border:1px solid #e2e8f0;border-radius:9px;padding:10px;background:#fff}.cfja-summary-card span,.cfja-count-card span,.cfja-fingerprint-grid span{display:block;color:#64748b;font-size:11px}.cfja-summary-card strong,.cfja-count-card strong{display:block;margin-top:3px;font-size:15px}.cfja-count-card strong{font-size:18px}
    .cfja-columns{display:grid;grid-template-columns:1fr 1fr;gap:12px}.cfja-block{margin-top:14px;border:1px solid #e2e8f0;border-radius:10px;padding:12px;min-width:0}.cfja-block h4{margin:0 0 9px;font-size:14px}.cfja-table-wrap{overflow:auto}.cfja-table{width:100%;border-collapse:collapse;font-size:12px}.cfja-table th,.cfja-table td{padding:7px 8px;border-bottom:1px solid #edf2f7;text-align:left;vertical-align:top}.cfja-table th{color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}.cfja-table td small{display:block;color:#64748b;margin-top:2px}.cfja-table code{font-size:10px;word-break:break-all}.cfja-review{color:#92400e;font-weight:700}.cfja-danger{color:#b91c1c;font-weight:700}.cfja-clipped{font-size:11px;color:#64748b;margin-bottom:6px}
    .cfja-fingerprint-grid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:8px;margin-top:12px;padding:10px;border-radius:9px;background:#f8fafc}.cfja-fingerprint-grid code{display:block;font-size:10px;word-break:break-all;margin-top:3px}.cfja-fingerprint-grid strong{display:block;margin-top:3px}
    @media(max-width:1000px){.cfja-summary-grid,.cfja-count-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.cfja-columns{grid-template-columns:1fr}.cfja-fingerprint-grid{grid-template-columns:1fr 1fr}.cfja-header{flex-direction:column}.cfja-badges{justify-content:flex-start}}
    @media(max-width:620px){.cfja-summary-grid,.cfja-count-grid,.cfja-fingerprint-grid{grid-template-columns:1fr}.cfja-file-control{min-width:100%;width:100%}}
  `;
  document.head.appendChild(style);
}

function money(micros, currencyCode) {
  if (micros == null || !Number.isFinite(Number(micros))) return '—';
  const value = Number(micros) / 1_000_000;
  const currency = String(currencyCode || '').trim().toUpperCase();
  if (!currency) return value.toFixed(2);
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value); }
  catch { return `${currency} ${value.toFixed(2)}`; }
}
function percent(value) { return value == null || !Number.isFinite(Number(value)) ? '—' : `${(Number(value) * 100).toFixed(1)}%`; }
function decimal(value) { return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(2); }
function integer(value) { return value == null || !Number.isFinite(Number(value)) ? '0' : Math.round(Number(value)).toLocaleString(); }
function shortHash(value) { const text = String(value || ''); return text ? `${esc(text.slice(0, 12))}…${esc(text.slice(-8))}` : '—'; }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
