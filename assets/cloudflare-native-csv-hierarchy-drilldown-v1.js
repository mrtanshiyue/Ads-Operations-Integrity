export const CSV_HIERARCHY_DRILLDOWN_SCHEMA_VERSION = 'csv-hierarchy-drilldown-v1';
export const CSV_HIERARCHY_DRILLDOWN_UI_VERSION = '1.0.0';

const SORT_MODES = Object.freeze(['spend_desc', 'sales_desc', 'contribution_desc', 'acos_desc', 'name_asc']);
const PERFORMANCE_BANDS = Object.freeze(['', 'at_or_below_target_acos', 'above_target_acos', 'spend_without_sales', 'no_spend', 'observe']);
const state = {
  mounted: false,
  building: false,
  result: null,
  campaignKey: '',
  adGroupKey: '',
  targetingKey: '',
  targetingSearch: '',
  performanceBand: '',
  sort: 'spend_desc',
};

const NON_AUTHORITY = Object.freeze({
  mode: 'browser_local_hierarchy_drilldown_only',
  authoritative: false,
  canonicalAmazonIdentityResolved: false,
  governancePersistenceAllowed: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
});

export function buildCsvHierarchyDrilldown(result, selection = {}) {
  assertDrilldownSafe(result);
  const hierarchy = result.hierarchy || {};
  const campaigns = Object.freeze([...(hierarchy.campaigns || [])]);
  const requestedCampaignKey = String(selection.campaignKey || '');
  const selectedCampaign = campaigns.find((item) => item.observedKey === requestedCampaignKey) || campaigns[0] || null;

  const adGroups = Object.freeze(selectedCampaign
    ? (hierarchy.adGroups || []).filter((item) => item.observedKey.startsWith(`${selectedCampaign.observedKey}/ad_group:`))
    : []);
  const requestedAdGroupKey = String(selection.adGroupKey || '');
  const selectedAdGroup = adGroups.find((item) => item.observedKey === requestedAdGroupKey) || adGroups[0] || null;

  const search = normalizeText(selection.targetingSearch);
  const performanceBand = PERFORMANCE_BANDS.includes(String(selection.performanceBand || '')) ? String(selection.performanceBand || '') : '';
  const sort = SORT_MODES.includes(String(selection.sort || '')) ? String(selection.sort || '') : 'spend_desc';
  const allTargetings = selectedAdGroup
    ? (hierarchy.targetings || []).filter((item) => item.observedKey.startsWith(`${selectedAdGroup.observedKey}/targeting:`))
    : [];
  const targetings = Object.freeze(allTargetings
    .filter((item) => !performanceBand || item.performanceBand === performanceBand)
    .filter((item) => !search || targetingHaystack(item).includes(search))
    .sort((left, right) => compareRows(left, right, sort)));
  const requestedTargetingKey = String(selection.targetingKey || '');
  const selectedTargeting = targetings.find((item) => item.observedKey === requestedTargetingKey) || targetings[0] || null;

  return Object.freeze({
    schemaVersion: CSV_HIERARCHY_DRILLDOWN_SCHEMA_VERSION,
    authority: NON_AUTHORITY,
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    targetAcos: finiteOrNull(hierarchy.targetAcos),
    reliability: Object.freeze({ ...(hierarchy.reliability || {}) }),
    source: Object.freeze({
      inputSetFingerprint: String(result.source.inputSetFingerprint).toLowerCase(),
      sourceReceiptCount: result.imports.length,
      receiptHashSetVerified: true,
      reportStartDate: result.range?.startDate || null,
      reportEndDate: result.range?.endDate || null,
    }),
    summary: Object.freeze({
      campaignCount: campaigns.length,
      selectedCampaignAdGroupCount: adGroups.length,
      selectedAdGroupTargetingCount: allTargetings.length,
      visibleTargetingCount: targetings.length,
      ambiguousCampaignCount: nonNegativeInteger(hierarchy.summary?.ambiguousCampaignCount),
      ambiguousAdGroupCount: nonNegativeInteger(hierarchy.summary?.ambiguousAdGroupCount),
      ambiguousTargetingCount: nonNegativeInteger(hierarchy.summary?.ambiguousTargetingCount),
    }),
    selection: Object.freeze({
      campaignKey: selectedCampaign?.observedKey || null,
      adGroupKey: selectedAdGroup?.observedKey || null,
      targetingKey: selectedTargeting?.observedKey || null,
      targetingSearch: String(selection.targetingSearch || ''),
      performanceBand,
      sort,
    }),
    campaigns,
    adGroups,
    targetings,
    selectedCampaign,
    selectedAdGroup,
    selectedTargeting,
    breadcrumbs: Object.freeze([
      selectedCampaign ? breadcrumb('campaign', selectedCampaign) : null,
      selectedAdGroup ? breadcrumb('ad_group', selectedAdGroup) : null,
      selectedTargeting ? breadcrumb('targeting', selectedTargeting) : null,
    ].filter(Boolean)),
  });
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'CloudflareCsvHierarchyDrilldown', {
    value: Object.freeze({
      version: CSV_HIERARCHY_DRILLDOWN_UI_VERSION,
      schemaVersion: CSV_HIERARCHY_DRILLDOWN_SCHEMA_VERSION,
      authority: 'browser_local_hierarchy_drilldown_only',
      buildCsvHierarchyDrilldown,
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
  if (joint.querySelector('[data-csv-hierarchy-drilldown]')) return void (state.mounted = true);

  installStyles();
  const root = document.createElement('section');
  root.className = 'cfhd';
  root.dataset.csvHierarchyDrilldown = CSV_HIERARCHY_DRILLDOWN_UI_VERSION;
  root.innerHTML = `
    <div class="cfhd-head"><div><b>Campaign → Ad Group → Targeting Drilldown</b><small>Browser-local hierarchy navigation from CSV-observed evidence. Identity is observational, not canonical Amazon identity.</small></div><span>review only · no execution</span></div>
    <div class="cfhd-status" data-cfhd-status>Run Joint CSV Analysis to build the hierarchy drilldown.</div>
    <div data-cfhd-body hidden></div>`;
  const periodPanel = joint.querySelector('[data-csv-period-ui]');
  if (periodPanel) periodPanel.insertAdjacentElement('beforebegin', root);
  else joint.appendChild(root);

  joint.querySelector('[data-csv-joint-files]')?.addEventListener('change', () => reset(root, 'CSV selection changed. Run Joint CSV Analysis again.'));
  joint.querySelector('[data-csv-joint-clear]')?.addEventListener('click', () => reset(root, 'Local hierarchy drilldown cleared.'));
  const jointStatus = joint.querySelector('[data-csv-joint-status]');
  if (jointStatus) {
    const sync = () => {
      if (jointStatus.dataset.kind === 'success') void rebuild(root, joint);
      else if (jointStatus.dataset.kind === 'error') reset(root, 'Joint CSV Analysis did not complete successfully.', 'bad');
    };
    new MutationObserver(sync).observe(jointStatus, { attributes: true, childList: true, characterData: true, subtree: true });
    sync();
  }
  root.addEventListener('change', (event) => {
    const campaign = event.target.closest?.('[data-cfhd-campaign]');
    const adGroup = event.target.closest?.('[data-cfhd-ad-group]');
    const band = event.target.closest?.('[data-cfhd-band]');
    const sort = event.target.closest?.('[data-cfhd-sort]');
    if (campaign) {
      state.campaignKey = campaign.value;
      state.adGroupKey = '';
      state.targetingKey = '';
      return renderFromState(root);
    }
    if (adGroup) {
      state.adGroupKey = adGroup.value;
      state.targetingKey = '';
      return renderFromState(root);
    }
    if (band) {
      state.performanceBand = band.value;
      state.targetingKey = '';
      return renderFromState(root);
    }
    if (sort) {
      state.sort = sort.value;
      return renderFromState(root);
    }
  });
  root.addEventListener('input', (event) => {
    const search = event.target.closest?.('[data-cfhd-search]');
    if (!search) return;
    state.targetingSearch = search.value;
    state.targetingKey = '';
    renderFromState(root);
    const next = root.querySelector('[data-cfhd-search]');
    if (next) {
      next.focus();
      next.setSelectionRange(next.value.length, next.value.length);
    }
  });
  root.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-cfhd-targeting]');
    if (!button) return;
    state.targetingKey = button.dataset.cfhdTargeting || '';
    renderFromState(root);
  });
  state.mounted = true;
}

async function rebuild(root, joint) {
  if (state.building) return;
  const files = [...(joint.querySelector('[data-csv-joint-files]')?.files || [])];
  if (!files.length || typeof window.CloudflareCsvJointAnalysis?.analyzeLocalCsvInputs !== 'function') return;
  state.building = true;
  status(root, `Building hierarchy drilldown locally from ${files.length} file${files.length === 1 ? '' : 's'}…`, 'loading');
  try {
    const inputs = await Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() })));
    state.result = await window.CloudflareCsvJointAnalysis.analyzeLocalCsvInputs(inputs);
    state.campaignKey = '';
    state.adGroupKey = '';
    state.targetingKey = '';
    state.targetingSearch = '';
    state.performanceBand = '';
    state.sort = 'spend_desc';
    renderFromState(root);
    const hierarchy = state.result.hierarchy;
    status(root, `${hierarchy.summary.campaignCount} campaign(s) · ${hierarchy.summary.adGroupCount} ad group(s) · ${hierarchy.summary.targetingCount} targeting row(s). Analytical decision use: ${hierarchy.reliability.analyticalDecisionUse}.`, hierarchy.reliability.analyticalDecisionUse === 'blocked' ? 'bad' : hierarchy.reliability.analyticalDecisionUse === 'review_only' ? 'ok' : 'warn');
  } catch (error) {
    state.result = null;
    root.querySelector('[data-cfhd-body]').hidden = true;
    status(root, `Hierarchy drilldown failed: ${String(error?.code || error?.message || 'unknown_error')}`, 'bad');
  } finally {
    state.building = false;
  }
}

function renderFromState(root) {
  if (!state.result) return;
  const model = buildCsvHierarchyDrilldown(state.result, state);
  state.campaignKey = model.selection.campaignKey || '';
  state.adGroupKey = model.selection.adGroupKey || '';
  state.targetingKey = model.selection.targetingKey || '';
  render(root, model);
}

function render(root, model) {
  const body = root.querySelector('[data-cfhd-body]');
  body.hidden = false;
  if (!model.selectedCampaign) {
    body.innerHTML = '<div class="cfhd-empty">No hierarchy rows were produced from the selected local CSV evidence.</div>';
    return;
  }
  body.innerHTML = `
    <div class="cfhd-controls">
      <label>Campaign <select data-cfhd-campaign>${model.campaigns.map((item) => option(item.observedKey, hierarchyLabel(item, 'campaign'), item.observedKey === model.selection.campaignKey)).join('')}</select></label>
      <label>Ad Group <select data-cfhd-ad-group>${model.adGroups.map((item) => option(item.observedKey, hierarchyLabel(item, 'ad_group'), item.observedKey === model.selection.adGroupKey)).join('')}</select></label>
      <label>Targeting search <input type="search" data-cfhd-search value="${esc(model.selection.targetingSearch)}" placeholder="targeting, match type, search term"></label>
      <label>Performance <select data-cfhd-band>${PERFORMANCE_BANDS.map((value) => option(value, performanceBandLabel(value), value === model.selection.performanceBand)).join('')}</select></label>
      <label>Sort <select data-cfhd-sort>${SORT_MODES.map((value) => option(value, sortLabel(value), value === model.selection.sort)).join('')}</select></label>
    </div>
    <div class="cfhd-breadcrumbs">${model.breadcrumbs.map((item) => `<span>${esc(item.level)}: <b>${esc(item.label)}</b></span>`).join('<i>→</i>')}</div>
    <div class="cfhd-cards">
      ${metricCard('Campaign spend', money(model.selectedCampaign.metrics?.spendMicros), `${money(model.selectedCampaign.metrics?.salesMicros)} sales`)}
      ${metricCard('Ad Group spend', money(model.selectedAdGroup?.metrics?.spendMicros), `${money(model.selectedAdGroup?.metrics?.salesMicros)} sales`)}
      ${metricCard('Visible targetings', `${num(model.summary.visibleTargetingCount)}/${num(model.summary.selectedAdGroupTargetingCount)}`, `${num(model.summary.ambiguousTargetingCount)} ambiguous overall`)}
      ${metricCard('Decision use', model.reliability?.analyticalDecisionUse || 'unknown', model.reliability?.state || 'unknown')}
    </div>
    <div class="cfhd-grid">
      <div class="cfhd-targetings"><h4>Targeting rows</h4>${targetingList(model)}</div>
      <div class="cfhd-detail"><h4>Selected targeting evidence</h4>${targetingDetail(model.selectedTargeting, model)}</div>
    </div>
    <div class="cfhd-rule"><b>Ad contribution = Sales - Ad Spend only; it is not net profit.</b> Observed IDs/names are local CSV evidence and do not establish canonical Amazon identity. No persistence, optimization execution, or Amazon mutation is authorized.</div>`;
}

function targetingList(model) {
  if (!model.targetings.length) return '<div class="cfhd-empty">No targeting rows match the current local filters.</div>';
  return `<div class="cfhd-target-list">${model.targetings.map((item) => `<button type="button" data-cfhd-targeting="${esc(item.observedKey)}" class="${item.observedKey === model.selection.targetingKey ? 'active' : ''}"><span><b>${esc(hierarchyLabel(item, 'targeting'))}</b><small>${esc((item.identity?.targeting?.matchType || item.observedVariants?.matchTypes?.[0] || 'UNSPECIFIED'))} · ${esc(item.performanceBand)}</small></span><span><b>${money(item.metrics?.spendMicros)}</b><small>${money(item.metrics?.salesMicros)} sales · ${pct(item.metrics?.acos)} ACoS</small></span></button>`).join('')}</div>`;
}

function targetingDetail(item, model) {
  if (!item) return '<div class="cfhd-empty">Select a targeting row to inspect local evidence.</div>';
  const identity = item.observedIdentity || {};
  const metrics = item.metrics || {};
  return `
    <div class="cfhd-detail-cards">
      ${metricCard('Spend', money(metrics.spendMicros), `${money(metrics.salesMicros)} attributed sales`)}
      ${metricCard('ACoS / ROAS', `${pct(metrics.acos)} / ${dec(metrics.roas)}`, `target ACoS ${pct(model.targetAcos)}`)}
      ${metricCard('Orders / CVR', `${num(metrics.purchases ?? metrics.orders)} / ${pct(metrics.cvr)}`, `${num(metrics.clicks)} clicks`)}
      ${metricCard('Ad contribution*', money(item.adContributionMicros), 'not net profit')}
    </div>
    <dl class="cfhd-dl">
      <dt>Performance band</dt><dd>${esc(item.performanceBand)}</dd>
      <dt>Observed identity</dt><dd class="${identity.ambiguous ? 'bad' : ''}">${esc(identity.state || 'unresolved')} · confidence ${esc(identity.confidence || 'low')}</dd>
      <dt>Identity conflicts</dt><dd>${identity.conflictCodes?.length ? identity.conflictCodes.map(esc).join(', ') : 'none detected'}</dd>
      <dt>Observed targeting</dt><dd>${esc(item.identity?.targeting?.text || '—')}</dd>
      <dt>Targeting ID</dt><dd><code>${esc(item.identity?.targeting?.id || 'not observed')}</code></dd>
      <dt>Search terms</dt><dd>${item.searchTerms?.length ? item.searchTerms.slice(0, 20).map((term) => `<span class="cfhd-chip">${esc(term)}</span>`).join(' ') : 'none'}</dd>
      <dt>Source imports</dt><dd>${num(item.sourceImportCount)} · ${item.sourceImportIds?.map((value) => `<code>${esc(value)}</code>`).join(' ') || '—'}</dd>
    </dl>`;
}

function assertDrilldownSafe(result) {
  if (!result || typeof result !== 'object') throw drilldownError('CSV_HIERARCHY_DRILLDOWN_RESULT_REQUIRED');
  if (result.source?.kind !== 'csv_import_set') throw drilldownError('CSV_HIERARCHY_DRILLDOWN_SOURCE_KIND_INVALID');
  if (!/^[a-f0-9]{64}$/i.test(String(result.source?.inputSetFingerprint || ''))) throw drilldownError('CSV_HIERARCHY_DRILLDOWN_FINGERPRINT_INVALID');
  if (!Array.isArray(result.imports) || result.imports.length === 0) throw drilldownError('CSV_HIERARCHY_DRILLDOWN_IMPORTS_REQUIRED');
  if (!result.hierarchy || !Array.isArray(result.hierarchy.campaigns) || !Array.isArray(result.hierarchy.adGroups) || !Array.isArray(result.hierarchy.targetings)) {
    throw drilldownError('CSV_HIERARCHY_DRILLDOWN_HIERARCHY_REQUIRED');
  }

  const receiptHashes = result.imports.map((item) => {
    const hash = String(item?.contentSha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) throw drilldownError('CSV_HIERARCHY_DRILLDOWN_CONTENT_HASH_INVALID');
    return hash;
  });
  const sourceHashes = Array.isArray(result.source?.contentSha256s) ? result.source.contentSha256s.map((value) => String(value || '').toLowerCase()) : [];
  if (sourceHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) throw drilldownError('CSV_HIERARCHY_DRILLDOWN_SOURCE_HASH_SET_INVALID');
  if (new Set(receiptHashes).size !== receiptHashes.length || new Set(sourceHashes).size !== sourceHashes.length) throw drilldownError('CSV_HIERARCHY_DRILLDOWN_DUPLICATE_HASH_EVIDENCE');
  const receiptSorted = [...receiptHashes].sort();
  const sourceSorted = [...sourceHashes].sort();
  if (receiptSorted.length !== sourceSorted.length || receiptSorted.some((hash, index) => hash !== sourceSorted[index])) throw drilldownError('CSV_HIERARCHY_DRILLDOWN_SOURCE_RECEIPT_MISMATCH');
  if (result.source?.batchCount != null && Number(result.source.batchCount) !== result.imports.length) throw drilldownError('CSV_HIERARCHY_DRILLDOWN_BATCH_COUNT_MISMATCH');

  const flags = [
    result.source?.canonicalAmazonIdentityResolved,
    result.source?.governancePersistenceAllowed,
    result.source?.executionAuthorized,
    result.source?.amazonMutationAuthorized,
    result.dataQuality?.authority?.authoritative,
    result.dataQuality?.authority?.governancePersistenceAllowed,
    result.dataQuality?.authority?.executionAuthorized,
    result.dataQuality?.authority?.amazonMutationAuthorized,
    result.hierarchy?.authority?.authoritative,
    result.hierarchy?.authority?.governancePersistenceAllowed,
    result.hierarchy?.authority?.executionAuthorized,
    result.hierarchy?.authority?.amazonMutationAuthorized,
  ];
  if (flags.some((value) => value === true)) throw drilldownError('CSV_HIERARCHY_DRILLDOWN_AUTHORITY_ESCALATION_BLOCKED');
}

function breadcrumb(level, item) { return Object.freeze({ level, observedKey: item.observedKey, label: hierarchyLabel(item, level) }); }
function targetingHaystack(item) { return normalizeText([hierarchyLabel(item, 'targeting'), item.identity?.targeting?.matchType, ...(item.searchTerms || []), ...(item.observedVariants?.targetingTexts || [])].join(' ')); }
function hierarchyLabel(item, level) {
  if (!item) return '—';
  if (level === 'campaign') return item.identity?.campaign?.name || item.identity?.campaign?.id || item.observedKey;
  if (level === 'ad_group') return item.identity?.adGroup?.name || item.identity?.adGroup?.id || item.observedKey;
  return item.identity?.targeting?.text || item.identity?.targeting?.id || item.observedKey;
}
function compareRows(left, right, mode) {
  if (mode === 'sales_desc') return metric(right, 'salesMicros') - metric(left, 'salesMicros') || fallback(left, right);
  if (mode === 'contribution_desc') return Number(right.adContributionMicros || 0) - Number(left.adContributionMicros || 0) || fallback(left, right);
  if (mode === 'acos_desc') return nullableMetric(right.metrics?.acos) - nullableMetric(left.metrics?.acos) || fallback(left, right);
  if (mode === 'name_asc') return hierarchyLabel(left, 'targeting').localeCompare(hierarchyLabel(right, 'targeting')) || fallback(left, right);
  return metric(right, 'spendMicros') - metric(left, 'spendMicros') || fallback(left, right);
}
function fallback(left, right) { return String(left.observedKey || '').localeCompare(String(right.observedKey || '')); }
function metric(item, key) { const value = Number(item?.metrics?.[key]); return Number.isFinite(value) ? value : 0; }
function nullableMetric(value) { const number = Number(value); return value == null || !Number.isFinite(number) ? -Infinity : number; }
function performanceBandLabel(value) { return ({ '': 'All bands', at_or_below_target_acos: 'At/below target ACoS', above_target_acos: 'Above target ACoS', spend_without_sales: 'Spend without sales', no_spend: 'No spend', observe: 'Observe' })[value] || value; }
function sortLabel(value) { return ({ spend_desc: 'Spend ↓', sales_desc: 'Sales ↓', contribution_desc: 'Ad contribution ↓', acos_desc: 'ACoS ↓', name_asc: 'Targeting A–Z' })[value] || value; }
function option(value, label, selected) { return `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`; }
function metricCard(label, value, sub) { return `<div class="cfhd-card"><span>${esc(label)}</span><b>${value}</b><small>${sub}</small></div>`; }
function normalizeText(value) { return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim(); }
function finiteOrNull(value) { const number = Number(value); return value == null || !Number.isFinite(number) ? null : number; }
function nonNegativeInteger(value) { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0; }
function num(value) { const number = Number(value); return Number.isFinite(number) ? Math.round(number).toLocaleString() : '0'; }
function money(value) { const number = Number(value); return value == null || !Number.isFinite(number) ? '—' : (number / 1_000_000).toFixed(2); }
function pct(value) { const number = Number(value); return value == null || !Number.isFinite(number) ? '—' : `${(number * 100).toFixed(1)}%`; }
function dec(value) { const number = Number(value); return value == null || !Number.isFinite(number) ? '—' : number.toFixed(2); }
function reset(root, message, kind = '') { state.result = null; state.campaignKey = ''; state.adGroupKey = ''; state.targetingKey = ''; const body = root.querySelector('[data-cfhd-body]'); body.hidden = true; body.innerHTML = ''; status(root, message, kind); }
function status(root, message, kind = '') { const node = root.querySelector('[data-cfhd-status]'); node.textContent = message; node.dataset.kind = kind; }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function drilldownError(code) { const error = new Error(code); error.name = 'CsvHierarchyDrilldownError'; error.code = code; return error; }

function installStyles() {
  if (document.getElementById('cfhd-style-v1')) return;
  const style = document.createElement('style');
  style.id = 'cfhd-style-v1';
  style.textContent = '.cfhd{margin-top:14px;padding-top:14px;border-top:1px solid #e2e8f0}.cfhd-head{display:flex;justify-content:space-between;gap:12px}.cfhd-head small{display:block;color:#64748b;max-width:780px}.cfhd-head>span{font-size:11px;font-weight:800}.cfhd-status,.cfhd-rule,.cfhd-empty{margin-top:8px;padding:8px;border-radius:7px;background:#f8fafc}.cfhd-status[data-kind="bad"],.cfhd .bad{color:#b91c1c}.cfhd-status[data-kind="warn"]{color:#a16207}.cfhd-status[data-kind="ok"]{color:#047857}.cfhd-controls{display:grid;grid-template-columns:1.1fr 1.1fr 1.3fr 1fr 1fr;gap:7px;margin-top:9px}.cfhd-controls label{display:grid;gap:3px;font-size:10px;color:#64748b}.cfhd-controls select,.cfhd-controls input{min-width:0;border:1px solid #cbd5e1;border-radius:6px;padding:7px;background:#fff}.cfhd-breadcrumbs{display:flex;gap:7px;flex-wrap:wrap;margin-top:8px;font-size:10px}.cfhd-breadcrumbs i{color:#94a3b8}.cfhd-cards,.cfhd-detail-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin-top:8px}.cfhd-card{border:1px solid #e2e8f0;border-radius:7px;padding:8px}.cfhd-card span,.cfhd-card small{display:block;color:#64748b;font-size:9.5px}.cfhd-card b{display:block;margin:2px 0}.cfhd-grid{display:grid;grid-template-columns:minmax(280px,.9fr) minmax(380px,1.1fr);gap:10px;margin-top:10px}.cfhd-grid h4{margin:0 0 6px}.cfhd-target-list{max-height:460px;overflow:auto;border:1px solid #e2e8f0;border-radius:7px}.cfhd-target-list button{display:flex;justify-content:space-between;gap:10px;width:100%;border:0;border-top:1px solid #edf2f7;background:#fff;padding:8px;text-align:left;cursor:pointer}.cfhd-target-list button:first-child{border-top:0}.cfhd-target-list button.active{background:#f0fdf4}.cfhd-target-list span{min-width:0}.cfhd-target-list small{display:block;color:#64748b}.cfhd-detail{border:1px solid #e2e8f0;border-radius:7px;padding:9px}.cfhd-detail-cards{grid-template-columns:repeat(2,minmax(0,1fr));margin-top:0}.cfhd-dl{display:grid;grid-template-columns:150px 1fr;gap:6px;margin:10px 0 0}.cfhd-dl dt{color:#64748b}.cfhd-dl dd{margin:0;min-width:0}.cfhd-chip{display:inline-block;padding:2px 5px;margin:1px;border-radius:999px;background:#f1f5f9}.cfhd code{font-size:10px;word-break:break-all}.cfhd-rule{font-size:10px;color:#64748b}@media(max-width:1000px){.cfhd-controls{grid-template-columns:repeat(2,minmax(0,1fr))}.cfhd-grid{grid-template-columns:1fr}.cfhd-cards{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:600px){.cfhd-controls,.cfhd-cards,.cfhd-detail-cards{grid-template-columns:1fr}.cfhd-dl{grid-template-columns:1fr}}';
  document.head.appendChild(style);
}
