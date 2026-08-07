(() => {
  'use strict';

  const AUDIT_VERSION = '1.0.2';
  const MAX_ROWS = 300000;
  const MAX_MISMATCH_ROWS = 30;
  const FILTER_IDS = [
    'dateStart', 'dateEnd', 'filterSource', 'filterPortfolio', 'filterCampaign',
    'filterAdGroup', 'filterTargeting', 'filterMatchType', 'filterAdType',
    'filterAdProduct', 'filterSearchTerm', 'filterSearchExact',
  ];
  const METRIC_RULES = Object.freeze({
    impressions: { abs: 1, rel: 0.0005 },
    clicks: { abs: 1, rel: 0.0005 },
    spend: { abs: 0.01, rel: 0.0005 },
    sales: { abs: 0.01, rel: 0.0005 },
    orders: { abs: 0, rel: 0 },
  });
  const state = {
    status: 'idle', request: null, eligibility: null, legacy: null, query: null,
    comparison: null, governance: null, lastError: '', refreshedAt: 0,
  };

  const byId = id => document.getElementById(id);
  const text = value => String(value ?? '').trim();
  const lower = value => text(value).toLowerCase();
  const number = value => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const nullableNumber = value => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const escapeHtml = value => text(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmtMoney = value => Number.isFinite(Number(value))
    ? `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
  const fmtInt = value => Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const fmtPct = value => Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(2)}%` : '—';
  const fmtSigned = (value, digits = 2) => {
    const numeric = Number(value || 0);
    return `${numeric > 0 ? '+' : ''}${numeric.toFixed(digits)}`;
  };

  function currentRequest() {
    return {
      scope: text(window.ShopScope?.get?.() || window.ACTIVE_SHOP || 'ALL').toUpperCase() || 'ALL',
      from: text(byId('dateStart')?.value), to: text(byId('dateEnd')?.value),
      sourceFile: text(byId('filterSource')?.value), portfolio: text(byId('filterPortfolio')?.value),
      campaign: text(byId('filterCampaign')?.value), adGroup: text(byId('filterAdGroup')?.value),
      targeting: text(byId('filterTargeting')?.value), matchType: text(byId('filterMatchType')?.value),
      adType: text(byId('filterAdType')?.value), adProduct: text(byId('filterAdProduct')?.value).toUpperCase(),
      search: text(byId('filterSearchTerm')?.value), searchExact: Boolean(byId('filterSearchExact')?.checked),
    };
  }

  function requestedCoverageMonths(request, bootstrapMonths) {
    const available = Array.isArray(bootstrapMonths)
      ? [...new Set(bootstrapMonths.map(text).filter(Boolean))].sort() : [];
    if (!available.length) return [];
    const fromMonth = request.from ? request.from.slice(0, 7) : available[0];
    const toMonth = request.to ? request.to.slice(0, 7) : available.at(-1);
    return available.filter(month => month >= fromMonth && month <= toMonth);
  }

  function rawEligibility(request = currentRequest(), cloudState = window.PrivateCloudAds?.state?.() || {}) {
    const reasons = [];
    const loadedMonths = Array.isArray(cloudState.loadedMonths)
      ? [...new Set(cloudState.loadedMonths.map(text).filter(Boolean))].sort() : [];
    const loadedMonthSet = new Set(loadedMonths);
    const range = cloudState.loadedRange && typeof cloudState.loadedRange === 'object' ? cloudState.loadedRange : null;
    const bootstrapMonths = Array.isArray(cloudState.bootstrap?.coverage?.months)
      ? [...new Set(cloudState.bootstrap.coverage.months.map(text).filter(Boolean))].sort() : [];
    const rawFingerprint = text(cloudState.rawBootstrapFingerprint);
    const queryFingerprint = text(cloudState.dataFingerprint);

    if (!cloudState.loadedOnce) reasons.push('尚未显式加载 Raw 明细');
    if (cloudState.rawStale) reasons.push('Raw 明细已因 dataFingerprint 变化而过期');
    if (request.scope && text(cloudState.loadedScope).toUpperCase() !== request.scope) {
      reasons.push(`Raw scope=${text(cloudState.loadedScope) || 'none'}，当前 scope=${request.scope}`);
    }
    if (cloudState.loadedOnce && (!rawFingerprint || !queryFingerprint)) {
      reasons.push('Raw / Query dataFingerprint 缺失，禁止双源对账');
    } else if (rawFingerprint && queryFingerprint && rawFingerprint !== queryFingerprint) {
      reasons.push('Raw 与当前 Query dataFingerprint 不一致');
    }
    if (request.adProduct && request.adProduct !== 'SP') {
      reasons.push('旧 Bid Governance 只治理 Sponsored Products；Parity Audit 仅支持 SP');
    }
    if (!range && cloudState.loadedOnce) reasons.push('缺少 Raw loadedRange 元数据');

    const requiredMonths = requestedCoverageMonths(request, bootstrapMonths);
    const missingMonths = requiredMonths.filter(month => !loadedMonthSet.has(month));
    if (missingMonths.length) {
      if (!request.from && !request.to) {
        reasons.push(`未限定日期时必须显式加载完整历史 Raw；缺少月份：${missingMonths.slice(0, 8).join(', ')}${missingMonths.length > 8 ? '…' : ''}`);
      } else {
        reasons.push(`Raw 未覆盖当前日期范围；缺少月份：${missingMonths.slice(0, 8).join(', ')}${missingMonths.length > 8 ? '…' : ''}`);
      }
    }

    return {
      ready: reasons.length === 0, reasons, loadedOnce: Boolean(cloudState.loadedOnce),
      rawStale: Boolean(cloudState.rawStale), loadedScope: text(cloudState.loadedScope).toUpperCase(),
      loadedMonths, requiredMonths, missingMonths,
      loadedRange: range ? { fromMonth: text(range.fromMonth), toMonth: text(range.toMonth), months: Array.isArray(range.months) ? [...range.months] : [] } : null,
      fingerprintMatch: Boolean(rawFingerprint && queryFingerprint && rawFingerprint === queryFingerprint),
    };
  }

  function legacyRows() {
    const bridge = typeof AdsDashboardApp !== 'undefined'
      ? AdsDashboardApp?.debug?.getBidGovernanceScopedRowsForParity
      : null;
    if (typeof bridge !== 'function') {
      throw auditError(503, '旧 Bid Governance 只读 Parity bridge 不可用，无法进行真实 Legacy 对账');
    }
    const rows = bridge();
    if (!Array.isArray(rows)) throw auditError(502, '旧 Bid Governance Parity bridge 返回了无效数据');
    return rows.map(row => ({ ...row }));
  }

  function bidOf(row, trustedOnly = false) {
    if (trustedOnly && row?.bidValueTrusted !== true) return null;
    return nullableNumber(row?.currentBid ?? row?.bid ?? row?.targetBid);
  }

  function groupKey(row, index = 0) {
    const targetingId = text(row?.targetingId);
    if (targetingId) return `id:${targetingId}`;
    const composite = [
      lower(row?.campaignId || row?.campaign), lower(row?.adGroupId || row?.adGroup),
      lower(row?.targeting || row?.searchTerm), lower(row?.matchType),
    ].join('|');
    return composite.replace(/\|/g, '') ? `fallback:${composite}` : `row:${index}`;
  }

  function summarizeRows(rows, { trustedBidOnly = false } = {}) {
    const input = Array.isArray(rows) ? rows : [];
    const totals = { rowCount: input.length, impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0, bidKnownRows: 0, targetingIdRows: 0 };
    const groups = new Map();
    input.forEach((row, index) => {
      totals.impressions += number(row?.impressions ?? row?.impr);
      totals.clicks += number(row?.clicks); totals.spend += number(row?.spend);
      totals.sales += number(row?.sales); totals.orders += number(row?.orders);
      if (text(row?.targetingId)) totals.targetingIdRows += 1;
      const bid = bidOf(row, trustedBidOnly);
      if (bid !== null) totals.bidKnownRows += 1;
      const key = groupKey(row, index);
      if (!groups.has(key)) {
        groups.set(key, {
          key, targetingId: text(row?.targetingId), campaign: text(row?.campaign), adGroup: text(row?.adGroup),
          targeting: text(row?.targeting || row?.searchTerm), matchType: text(row?.matchType), rowCount: 0,
          impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0, latestBid: null, latestBidDate: '',
        });
      }
      const group = groups.get(key);
      group.rowCount += 1; group.impressions += number(row?.impressions ?? row?.impr);
      group.clicks += number(row?.clicks); group.spend += number(row?.spend);
      group.sales += number(row?.sales); group.orders += number(row?.orders);
      const date = text(row?.date);
      if (bid !== null && (!group.latestBidDate || date >= group.latestBidDate)) {
        group.latestBid = bid; group.latestBidDate = date;
      }
    });
    totals.acos = totals.sales > 0 ? totals.spend / totals.sales : (totals.spend > 0 ? Infinity : 0);
    totals.roas = totals.spend > 0 ? totals.sales / totals.spend : 0;
    totals.bidCoverage = totals.rowCount > 0 ? totals.bidKnownRows / totals.rowCount : 0;
    totals.targetingIdCoverage = totals.rowCount > 0 ? totals.targetingIdRows / totals.rowCount : 0;
    totals.groupCount = groups.size;
    return { totals, groups };
  }

  function metricDelta(legacyValue, queryValue, rule = { abs: 0, rel: 0 }) {
    const legacy = number(legacyValue); const query = number(queryValue);
    const absolute = query - legacy; const base = Math.max(Math.abs(legacy), Math.abs(query), 1e-9);
    const relative = Math.abs(absolute) / base;
    return { legacy, query, absolute, relative, pass: Math.abs(absolute) <= rule.abs || relative <= rule.rel };
  }

  function compareRows(legacyInput, queryInput) {
    const legacy = summarizeRows(legacyInput, { trustedBidOnly: false });
    const query = summarizeRows(queryInput, { trustedBidOnly: true });
    const metrics = Object.fromEntries(Object.entries(METRIC_RULES).map(([key, rule]) => [key, metricDelta(legacy.totals[key], query.totals[key], rule)]));
    const rowCount = metricDelta(legacy.totals.rowCount, query.totals.rowCount, { abs: 0, rel: 0 });
    const legacyKeys = new Set(legacy.groups.keys()); const queryKeys = new Set(query.groups.keys());
    const intersection = [...legacyKeys].filter(key => queryKeys.has(key));
    const union = new Set([...legacyKeys, ...queryKeys]);
    const groupOverlap = union.size ? intersection.length / union.size : 1;
    const legacyOnly = [...legacyKeys].filter(key => !queryKeys.has(key));
    const queryOnly = [...queryKeys].filter(key => !legacyKeys.has(key));
    const mismatches = []; let bidCompared = 0; let bidMismatch = 0; let bidMissingEither = 0;

    intersection.forEach(key => {
      const left = legacy.groups.get(key); const right = query.groups.get(key);
      const spend = metricDelta(left.spend, right.spend, METRIC_RULES.spend);
      const sales = metricDelta(left.sales, right.sales, METRIC_RULES.sales);
      const orders = metricDelta(left.orders, right.orders, METRIC_RULES.orders);
      const clicks = metricDelta(left.clicks, right.clicks, METRIC_RULES.clicks);
      const impressions = metricDelta(left.impressions, right.impressions, METRIC_RULES.impressions);
      let bidState = 'none'; let bidDelta = null;
      if (left.latestBid === null || right.latestBid === null) {
        if (left.latestBid !== right.latestBid) { bidState = 'missing'; bidMissingEither += 1; }
      } else {
        bidCompared += 1; bidDelta = right.latestBid - left.latestBid;
        if (Math.abs(bidDelta) > 0.000001) { bidState = 'mismatch'; bidMismatch += 1; } else bidState = 'match';
      }
      if ([spend, sales, orders, clicks, impressions].some(item => !item.pass) || ['mismatch', 'missing'].includes(bidState)) {
        mismatches.push({
          key, targetingId: left.targetingId || right.targetingId, campaign: left.campaign || right.campaign,
          adGroup: left.adGroup || right.adGroup, targeting: left.targeting || right.targeting, matchType: left.matchType || right.matchType,
          legacySpend: left.spend, querySpend: right.spend, spendDelta: spend.absolute,
          legacySales: left.sales, querySales: right.sales, salesDelta: sales.absolute,
          legacyOrders: left.orders, queryOrders: right.orders, ordersDelta: orders.absolute,
          legacyBid: left.latestBid, queryBid: right.latestBid, bidDelta, bidState,
        });
      }
    });
    legacyOnly.forEach(key => {
      const row = legacy.groups.get(key);
      mismatches.push({ key, side: 'legacy-only', targetingId: row.targetingId, campaign: row.campaign, adGroup: row.adGroup, targeting: row.targeting,
        matchType: row.matchType, legacySpend: row.spend, querySpend: 0, spendDelta: -row.spend, legacySales: row.sales, querySales: 0,
        salesDelta: -row.sales, legacyOrders: row.orders, queryOrders: 0, ordersDelta: -row.orders, legacyBid: row.latestBid, queryBid: null, bidDelta: null, bidState: 'missing' });
    });
    queryOnly.forEach(key => {
      const row = query.groups.get(key);
      mismatches.push({ key, side: 'query-only', targetingId: row.targetingId, campaign: row.campaign, adGroup: row.adGroup, targeting: row.targeting,
        matchType: row.matchType, legacySpend: 0, querySpend: row.spend, spendDelta: row.spend, legacySales: 0, querySales: row.sales,
        salesDelta: row.sales, legacyOrders: 0, queryOrders: row.orders, ordersDelta: row.orders, legacyBid: null, queryBid: row.latestBid, bidDelta: null, bidState: 'missing' });
    });
    mismatches.sort((a, b) => Math.abs(b.spendDelta || 0) - Math.abs(a.spendDelta || 0) || Math.abs(b.salesDelta || 0) - Math.abs(a.salesDelta || 0));

    const totalsPass = rowCount.pass && Object.values(metrics).every(item => item.pass);
    const identityPass = groupOverlap >= 0.995 && legacyOnly.length === 0 && queryOnly.length === 0;
    const bidPass = bidMismatch === 0 && bidMissingEither === 0;
    const pass = totalsPass && identityPass && bidPass;
    const near = !pass && Object.values(metrics).every(item => item.relative <= 0.01 || Math.abs(item.absolute) <= 1) && groupOverlap >= 0.98;
    return {
      verdict: pass ? 'pass' : near ? 'warn' : 'fail', metricParityPass: pass, migrationCandidate: false, executionAuthorized: false,
      totalsPass, identityPass, bidPass, rowCount, metrics, groupOverlap, matchedGroups: intersection.length,
      legacyOnlyCount: legacyOnly.length, queryOnlyCount: queryOnly.length, bidCompared, bidMismatch, bidMissingEither,
      legacy: legacy.totals, query: query.totals, mismatches: mismatches.slice(0, MAX_MISMATCH_ROWS),
    };
  }

  async function run({ force = true } = {}) {
    ensureUi();
    const request = currentRequest(); const eligibility = rawEligibility(request);
    setState({ request, eligibility, lastError: '' });
    if (!eligibility.ready) {
      setState({ status: 'blocked', legacy: null, query: null, comparison: null, governance: null, refreshedAt: Date.now() });
      render(); throw auditError(409, `Parity Audit 被阻止：${eligibility.reasons.join('；')}`);
    }
    if (typeof window.QueryNativeModuleData?.ads !== 'function') throw auditError(503, 'Query-native Adapter 尚未就绪');
    setState({ status: 'loading' }); render();
    try {
      const legacy = legacyRows();
      const payload = await window.QueryNativeModuleData.ads({ ...request, adProduct: '', source: 'query', maxRows: MAX_ROWS, force });
      if (payload?.source !== 'query-tidb') throw auditError(502, `Query 来源异常：${text(payload?.source) || 'missing'}`);
      if (payload?.truncated === true || payload?.nextOffset) throw auditError(409, 'Query 结果达到分页上限，禁止用截断数据做 Parity 结论');
      if (payload?.governance?.schemaVersion !== 'ads-query-governance-v2') throw auditError(502, 'Query governance v2 缺失');
      const readiness = payload.governance?.readiness || {};
      const adProductScopeProven = readiness.adProductReady === true;
      const allQueryRows = Array.isArray(payload.rows) ? payload.rows : [];
      const queryRows = adProductScopeProven
        ? allQueryRows.filter(row => text(row?.adProduct).toUpperCase() === 'SP')
        : allQueryRows;
      const comparison = compareRows(legacy, queryRows);
      comparison.adProductScopeProven = adProductScopeProven;
      comparison.queryScopeMode = adProductScopeProven ? 'source-proven-sp' : 'unproven-ad-product-diagnostic';
      comparison.scopeBlockers = adProductScopeProven ? [] : ['adProductReady'];
      comparison.migrationCandidate = Boolean(comparison.metricParityPass && adProductScopeProven);
      setState({ status: 'ready', legacy: summarizeRows(legacy).totals, query: summarizeRows(queryRows, { trustedBidOnly: true }).totals,
        comparison, governance: payload.governance, lastError: '', refreshedAt: Date.now() });
      render(); dispatch('lr:bid-governance-parity-ready', snapshot()); return snapshot();
    } catch (error) {
      setState({ status: 'error', legacy: null, query: null, comparison: null, governance: null, lastError: text(error?.message || error), refreshedAt: Date.now() });
      render(); dispatch('lr:bid-governance-parity-error', { version: AUDIT_VERSION, status: Number(error?.status || 0), message: state.lastError }); throw error;
    }
  }

  function snapshot() {
    return {
      version: AUDIT_VERSION, status: state.status, request: state.request ? { ...state.request } : null,
      eligibility: state.eligibility ? { ...state.eligibility, reasons: [...(state.eligibility.reasons || [])], loadedMonths: [...(state.eligibility.loadedMonths || [])], requiredMonths: [...(state.eligibility.requiredMonths || [])], missingMonths: [...(state.eligibility.missingMonths || [])] } : null,
      legacy: state.legacy ? { ...state.legacy } : null, query: state.query ? { ...state.query } : null,
      comparison: state.comparison ? { ...state.comparison, metrics: Object.fromEntries(Object.entries(state.comparison.metrics || {}).map(([key, value]) => [key, { ...value }])), mismatches: (state.comparison.mismatches || []).map(row => ({ ...row })) } : null,
      governance: state.governance, lastError: state.lastError, refreshedAt: state.refreshedAt, executionAuthorized: false,
    };
  }
  function setState(patch) { Object.assign(state, patch); }
  function verdictLabel(verdict) {
    if (verdict === 'pass') return 'Metric Parity Pass';
    if (verdict === 'warn') return 'Near Parity · 继续审计';
    return 'Parity Gap · 禁止迁移';
  }

  function ensureStyles() {
    if (byId('bidGovernanceParityAuditStyles')) return;
    const style = document.createElement('style'); style.id = 'bidGovernanceParityAuditStyles';
    style.textContent = `
      #bidGovernanceParityAudit{display:grid;gap:8px;margin:0 14px 10px;padding:10px;border:1px solid color-mix(in srgb,var(--fw-ai) 22%,var(--line));border-radius:11px;background:color-mix(in srgb,var(--fw-ai) 3%,var(--card));min-width:0}
      #bidGovernanceParityAudit .bgpaHead{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.bgpaTitle{font-size:12px;font-weight:850}.bgpaSub{margin-top:2px;font-size:9.8px;line-height:1.45;color:var(--muted)}
      #bidGovernanceParityAudit .bgpaBtn{padding:6px 10px!important;font-size:10.4px!important;white-space:nowrap}.bgpaBanner{padding:7px 8px;border-radius:9px;background:var(--chip);font-size:9.8px;line-height:1.45;color:var(--muted)}
      #bidGovernanceParityAudit .bgpaBanner[data-kind="good"]{background:var(--softGood);color:var(--good)}#bidGovernanceParityAudit .bgpaBanner[data-kind="warn"]{background:var(--softWarn);color:var(--warn)}#bidGovernanceParityAudit .bgpaBanner[data-kind="bad"]{background:var(--softBad);color:var(--bad)}
      #bidGovernanceParityAudit .bgpaKpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:5px}.bgpaKpi{padding:7px;border-radius:9px;background:var(--chip);min-width:0}.bgpaKpi span{display:block;font-size:9px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bgpaKpi b{display:block;margin-top:2px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #bidGovernanceParityAudit .bgpaGrid{display:grid;grid-template-columns:minmax(320px,.8fr) minmax(0,1.2fr);gap:7px}.bgpaTableWrap{overflow:auto;max-height:280px;border:1px solid var(--line);border-radius:9px;background:var(--card)}.bgpaTable{width:100%;border-collapse:collapse;font-size:9.5px}.bgpaTable th,.bgpaTable td{padding:6px 7px;text-align:left;white-space:nowrap;border-bottom:1px solid var(--line)}.bgpaTable th{position:sticky;top:0;background:var(--th-bg);z-index:1;color:var(--muted)}.bgpaTable td.num{text-align:right;font-variant-numeric:tabular-nums}.bgpaTag{display:inline-flex;padding:2px 5px;border-radius:999px;background:var(--chip);font-size:8.8px}.bgpaTag.good{background:var(--softGood);color:var(--good)}.bgpaTag.bad{background:var(--softBad);color:var(--bad)}
      #bidGovernanceParityAudit .bgpaFoot{font-size:9.3px;color:var(--muted);line-height:1.45}@media(max-width:900px){#bidGovernanceParityAudit .bgpaKpis{grid-template-columns:repeat(3,minmax(0,1fr))}#bidGovernanceParityAudit .bgpaGrid{grid-template-columns:1fr}}@media(max-width:520px){#bidGovernanceParityAudit .bgpaHead{display:grid}#bidGovernanceParityAudit .bgpaKpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
    `;
    document.head.appendChild(style);
  }

  function ensureUi() {
    const table = byId('rankTable'); if (!table) return false;
    const wrap = table.closest?.('.bidGovTableWrap') || table.parentElement; const host = wrap?.parentElement; if (!host) return false;
    ensureStyles(); let root = byId('bidGovernanceParityAudit');
    if (!root) {
      root = document.createElement('section'); root.id = 'bidGovernanceParityAudit';
      root.innerHTML = `<div class="bgpaHead"><div><div class="bgpaTitle">Phase 8 · Bid Governance 双源对账</div><div class="bgpaSub">Legacy Raw scoped-row parity bridge ↔ TiDB Query。只审计，不自动加载 Raw，不生成调价动作，不改变执行门禁。</div></div><button class="btn bgpaBtn" id="btnBidGovernanceParityAudit" type="button">运行双源对账</button></div><div class="bgpaBanner" id="bidGovernanceParityBanner">需要先由用户显式加载覆盖当前范围的 Raw 明细。</div><div class="bgpaKpis" id="bidGovernanceParityKpis"></div><div class="bgpaGrid" id="bidGovernanceParityGrid"></div><div class="bgpaFoot">Parity Pass 只代表“可进入下一阶段迁移审查”，不代表 Bid Governance / Campaign Studio / Bulk 执行解锁。</div>`;
      const bidPreview = byId('queryNativeBidIntelligence');
      if (bidPreview?.parentElement === host) host.insertBefore(root, bidPreview.nextElementSibling || wrap); else host.insertBefore(root, wrap);
    }
    bindUi(root); render(); return true;
  }
  function bindUi(root) {
    if (!root || root.dataset.bound === '1') return; root.dataset.bound = '1';
    byId('btnBidGovernanceParityAudit')?.addEventListener('click', () => run({ force: true }).catch(error => console.warn('Bid Governance parity audit blocked/failed:', error)));
  }

  function render() {
    const root = byId('bidGovernanceParityAudit'); if (!root) return;
    const banner = byId('bidGovernanceParityBanner'); const kpis = byId('bidGovernanceParityKpis'); const grid = byId('bidGovernanceParityGrid');
    const eligibility = state.eligibility || rawEligibility(currentRequest());
    if (state.status === 'loading') { banner.dataset.kind = 'warn'; banner.textContent = '正在对同一筛选范围执行 Legacy Raw ↔ TiDB Query 双源对账…'; kpis.innerHTML = ''; grid.innerHTML = ''; return; }
    if (state.status === 'error') { banner.dataset.kind = 'bad'; banner.textContent = `对账失败：${state.lastError || 'unknown error'}`; kpis.innerHTML = ''; grid.innerHTML = ''; return; }
    if (state.status === 'blocked' || !eligibility.ready) { banner.dataset.kind = 'warn'; banner.textContent = `只读门禁：${(eligibility.reasons || []).join('；') || '需要覆盖当前范围的 Raw 明细'}`; kpis.innerHTML = ''; grid.innerHTML = ''; return; }
    if (state.status !== 'ready' || !state.comparison) { banner.dataset.kind = 'good'; banner.textContent = `Raw 对账前提已满足：${eligibility.loadedMonths.join(', ') || '—'}。点击“运行双源对账”。`; kpis.innerHTML = ''; grid.innerHTML = ''; return; }
    const c = state.comparison; banner.dataset.kind = c.verdict === 'pass' ? 'good' : c.verdict === 'warn' ? 'warn' : 'bad';
    banner.textContent = `${verdictLabel(c.verdict)} · ${c.adProductScopeProven ? 'SP scope source-proven' : 'Ad Product scope unproven · diagnostic only'} · migrationCandidate=${Boolean(c.migrationCandidate)} · executionAuthorized=false · Query governance=${text(state.governance?.schemaVersion) || 'missing'}`;
    kpis.innerHTML = [ ['Rows L / Q', `${fmtInt(c.legacy.rowCount)} / ${fmtInt(c.query.rowCount)}`], ['Spend Δ', fmtMoney(c.metrics.spend.absolute)], ['Sales Δ', fmtMoney(c.metrics.sales.absolute)], ['Orders Δ', fmtSigned(c.metrics.orders.absolute, 0)], ['Group overlap', fmtPct(c.groupOverlap)], ['Bid mismatch', `${fmtInt(c.bidMismatch)} + ${fmtInt(c.bidMissingEither)} missing`] ].map(([label, value]) => `<div class="bgpaKpi"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join('');
    const metricRows = [ ['Rows', c.rowCount, fmtInt], ['Impressions', c.metrics.impressions, fmtInt], ['Clicks', c.metrics.clicks, fmtInt], ['Spend', c.metrics.spend, fmtMoney], ['Sales', c.metrics.sales, fmtMoney], ['Orders', c.metrics.orders, fmtInt] ];
    const metricTable = `<div class="bgpaTableWrap"><table class="bgpaTable"><thead><tr><th>Metric</th><th>Legacy</th><th>Query</th><th>Δ</th><th>Rel</th><th>State</th></tr></thead><tbody>${metricRows.map(([name,item,formatter]) => `<tr><td>${escapeHtml(name)}</td><td class="num">${escapeHtml(formatter(item.legacy))}</td><td class="num">${escapeHtml(formatter(item.query))}</td><td class="num">${escapeHtml(name === 'Spend' || name === 'Sales' ? fmtMoney(item.absolute) : fmtSigned(item.absolute, 0))}</td><td class="num">${escapeHtml(fmtPct(item.relative))}</td><td><span class="bgpaTag ${item.pass ? 'good' : 'bad'}">${item.pass ? 'PASS' : 'GAP'}</span></td></tr>`).join('')}</tbody></table></div>`;
    const mismatchTable = `<div class="bgpaTableWrap"><table class="bgpaTable"><thead><tr><th>Object</th><th>Side</th><th>Spend L/Q</th><th>Sales L/Q</th><th>Orders L/Q</th><th>Bid L/Q</th></tr></thead><tbody>${(c.mismatches || []).length ? c.mismatches.map(row => `<tr><td title="${escapeHtml([row.campaign,row.adGroup,row.targeting].filter(Boolean).join(' / '))}">${escapeHtml(row.targetingId || row.targeting || row.key)}</td><td>${escapeHtml(row.side || row.bidState || 'metric')}</td><td class="num">${escapeHtml(`${fmtMoney(row.legacySpend)} / ${fmtMoney(row.querySpend)}`)}</td><td class="num">${escapeHtml(`${fmtMoney(row.legacySales)} / ${fmtMoney(row.querySales)}`)}</td><td class="num">${escapeHtml(`${fmtInt(row.legacyOrders)} / ${fmtInt(row.queryOrders)}`)}</td><td class="num">${escapeHtml(`${row.legacyBid ?? '—'} / ${row.queryBid ?? '—'}`)}</td></tr>`).join('') : '<tr><td colspan="6">当前阈值下没有对象级差异。</td></tr>'}</tbody></table></div>`;
    grid.innerHTML = metricTable + mismatchTable;
  }

  function markStale(reason = '筛选条件已变化') {
    if (state.status === 'idle') { ensureUi(); return; }
    setState({ status: 'stale', lastError: reason }); const banner = byId('bidGovernanceParityBanner');
    if (banner) { banner.dataset.kind = 'warn'; banner.textContent = `${reason}；请重新运行双源对账。`; }
  }
  function bindScopeWatchers() {
    if (window.__BID_GOV_PARITY_WATCHERS_BOUND__) return; window.__BID_GOV_PARITY_WATCHERS_BOUND__ = true;
    document.addEventListener('change', event => { if (FILTER_IDS.includes(event.target?.id)) markStale('筛选条件已变化'); }, true);
    document.addEventListener('input', event => { if (event.target?.id === 'filterSearchTerm') markStale('搜索条件已变化'); }, true);
    window.addEventListener('lr:cloud-loaded', () => markStale('Raw 明细范围已更新'));
    window.addEventListener('lr:query-bootstrap', () => markStale('Query dataFingerprint 可能已更新'));
  }
  function dispatch(name, detail) { window.dispatchEvent?.(new CustomEvent(name, { detail })); }
  function auditError(status, message) { const error = new Error(message); error.status = status; return error; }

  window.BidGovernanceParityAudit = Object.freeze({ version: AUDIT_VERSION, run, compareRows, summarizeRows, rawEligibility, state: snapshot });
  const init = () => { ensureUi(); bindScopeWatchers(); dispatch('lr:bid-governance-parity-audit-ready', { version: AUDIT_VERSION, executionAuthorized: false }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
