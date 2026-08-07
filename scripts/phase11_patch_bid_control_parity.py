from pathlib import Path
import re

# 1) Legacy parser: preserve source targeting ID and target bid, expose a read-only control bridge.
p = Path('assets/generated/inline-script-04.js')
s = p.read_text(encoding='utf-8')
old = '  targeting: ["投放","投放方案","匹配的目标","Targeting","KeywordorProductTargeting","Keyword","关键词"], '
new = '  targeting: ["投放","投放方案","匹配的目标","Targeting","KeywordorProductTargeting","Keyword","关键词"], \n  targetingId: ["投放方案编号","Targeting ID","TargetingID","Targeting Id","Target ID","TargetID"], '
assert s.count(old) == 1, f'targeting alias insertion count={s.count(old)}'
s = s.replace(old, new)
old = '  currentBid: ["Bid","Keyword Bid","Current Bid","竞价","关键词竞价","Ad Group Default Bid"],'
new = '  currentBid: ["Bid","Keyword Bid","Current Bid","目标竞价","竞价","关键词竞价","Ad Group Default Bid"],'
assert s.count(old) == 1, f'currentBid alias count={s.count(old)}'
s = s.replace(old, new)
old = '    targeting: intern(String(raw[map.targeting] ?? "").trim()), \n    matchType: intern(String(raw[map.matchType] ?? "").trim()), '
new = '    targeting: intern(String(raw[map.targeting] ?? "").trim()), \n    targetingId: intern(String(map.targetingId ? raw[map.targetingId] : "").trim()), \n    matchType: intern(String(raw[map.matchType] ?? "").trim()), '
assert s.count(old) == 1, f'targeting row mapping count={s.count(old)}'
s = s.replace(old, new)
old = '    getBidGovernanceScopedRowsForParity:()=>getBidGovScopedRows("searchTerm").map(row=>({...row})),\n'
new = '''    getBidGovernanceScopedRowsForParity:()=>getBidGovScopedRows("searchTerm").map(row=>({...row})),
    getBidGovernanceControlRowsForParity:()=>getBidGovScopedRows("searchTerm").map(row=>({
      date:row.date||"",targetingId:row.targetingId||"",campaign:row.campaign||"",adGroup:row.adGroup||"",
      targeting:row.targeting||"",matchType:row.matchType||"",
      currentBid:Number.isFinite(row.currentBid)&&row.currentBid>0?row.currentBid:null
    })),
'''
assert s.count(old) == 1, f'parity debug bridge count={s.count(old)}'
s = s.replace(old, new)
p.write_text(s, encoding='utf-8')

# 2) Parity audit v1.0.4: performance-only parity + independent control-grain Bid parity.
p = Path('assets/bid-governance-parity-audit-v1.js')
s = p.read_text(encoding='utf-8')
assert s.count("const AUDIT_VERSION = '1.0.3';") == 1
s = s.replace("const AUDIT_VERSION = '1.0.3';", "const AUDIT_VERSION = '1.0.4';")

legacy_marker = '''  function bidOf(row, trustedOnly = false) {
    if (trustedOnly && row?.bidValueTrusted !== true) return null;
    return nullableNumber(row?.currentBid ?? row?.bid ?? row?.targetBid);
  }
'''
legacy_replacement = '''  function legacyControlRows() {
    const bridge = typeof AdsDashboardApp !== 'undefined'
      ? AdsDashboardApp?.debug?.getBidGovernanceControlRowsForParity
      : null;
    if (typeof bridge !== 'function') {
      throw auditError(503, '旧 Bid Governance Control Parity bridge 不可用，无法验证真实 Targeting / Bid');
    }
    const rows = bridge();
    if (!Array.isArray(rows)) throw auditError(502, '旧 Bid Governance Control Parity bridge 返回了无效数据');
    return rows.map(row => ({ ...row }));
  }

  function bidOf(row, trustedOnly = false) {
    if (trustedOnly && row?.bidValueTrusted !== true) return null;
    const value = nullableNumber(row?.currentBid ?? row?.bid ?? row?.targetBid);
    return value !== null && value > 0 ? value : null;
  }
'''
assert s.count(legacy_marker) == 1, 'legacy control bridge insertion point changed'
s = s.replace(legacy_marker, legacy_replacement)

compare_pattern = re.compile(r"  function compareRows\(legacyInput, queryInput\) \{.*?\n  \}\n\n  async function run", re.S)
compare_replacement = r'''  function compareRows(legacyInput, queryInput) {
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
    const mismatches = [];

    intersection.forEach(key => {
      const left = legacy.groups.get(key); const right = query.groups.get(key);
      const spend = metricDelta(left.spend, right.spend, METRIC_RULES.spend);
      const sales = metricDelta(left.sales, right.sales, METRIC_RULES.sales);
      const orders = metricDelta(left.orders, right.orders, METRIC_RULES.orders);
      const clicks = metricDelta(left.clicks, right.clicks, METRIC_RULES.clicks);
      const impressions = metricDelta(left.impressions, right.impressions, METRIC_RULES.impressions);
      if ([spend, sales, orders, clicks, impressions].some(item => !item.pass)) {
        mismatches.push({
          key, targetingId: left.targetingId || right.targetingId, campaign: left.campaign || right.campaign,
          adGroup: left.adGroup || right.adGroup, targeting: left.targeting || right.targeting, matchType: left.matchType || right.matchType,
          legacySpend: left.spend, querySpend: right.spend, spendDelta: spend.absolute,
          legacySales: left.sales, querySales: right.sales, salesDelta: sales.absolute,
          legacyOrders: left.orders, queryOrders: right.orders, ordersDelta: orders.absolute,
        });
      }
    });
    legacyOnly.forEach(key => {
      const row = legacy.groups.get(key);
      mismatches.push({ key, side: 'legacy-only', targetingId: row.targetingId, campaign: row.campaign, adGroup: row.adGroup, targeting: row.targeting,
        matchType: row.matchType, legacySpend: row.spend, querySpend: 0, spendDelta: -row.spend, legacySales: row.sales, querySales: 0,
        salesDelta: -row.sales, legacyOrders: row.orders, queryOrders: 0, ordersDelta: -row.orders });
    });
    queryOnly.forEach(key => {
      const row = query.groups.get(key);
      mismatches.push({ key, side: 'query-only', targetingId: row.targetingId, campaign: row.campaign, adGroup: row.adGroup, targeting: row.targeting,
        matchType: row.matchType, legacySpend: 0, querySpend: row.spend, spendDelta: row.spend, legacySales: 0, querySales: row.sales,
        salesDelta: row.sales, legacyOrders: 0, queryOrders: row.orders, ordersDelta: row.orders });
    });
    mismatches.sort((a, b) => Math.abs(b.spendDelta || 0) - Math.abs(a.spendDelta || 0) || Math.abs(b.salesDelta || 0) - Math.abs(a.salesDelta || 0));

    const totalsPass = rowCount.pass && Object.values(metrics).every(item => item.pass);
    const identityPass = groupOverlap >= 0.995 && legacyOnly.length === 0 && queryOnly.length === 0;
    const metricParityPass = totalsPass && identityPass;
    return {
      verdict: metricParityPass ? 'pass' : 'fail', metricParityPass, migrationCandidate: false, executionAuthorized: false,
      totalsPass, identityPass, rowCount, metrics, groupOverlap, matchedGroups: intersection.length,
      legacyOnlyCount: legacyOnly.length, queryOnlyCount: queryOnly.length,
      legacy: legacy.totals, query: query.totals, mismatches: mismatches.slice(0, MAX_MISMATCH_ROWS),
    };
  }

  function controlKey(row, index = 0) {
    const composite = [lower(row?.campaign), lower(row?.adGroup), lower(row?.targeting), lower(row?.matchType)].join('|');
    if (composite.replace(/\|/g, '')) return `route:${composite}`;
    const targetingId = text(row?.targetingId);
    return targetingId ? `id:${targetingId}` : `control:${index}`;
  }

  function summarizeBidControls(rows, { trustedBidOnly = false } = {}) {
    const input = Array.isArray(rows) ? rows : [];
    const groups = new Map();
    let targetingIdRows = 0; let bidRows = 0;
    input.forEach((row, index) => {
      const key = controlKey(row, index);
      if (!groups.has(key)) {
        groups.set(key, {
          key, campaign: text(row?.campaign), adGroup: text(row?.adGroup), targeting: text(row?.targeting), matchType: text(row?.matchType),
          targetingIds: new Set(), latestDate: '', latestBids: new Set(), rowCount: 0,
        });
      }
      const group = groups.get(key); group.rowCount += 1;
      const targetingId = text(row?.targetingId); if (targetingId) { targetingIdRows += 1; group.targetingIds.add(targetingId); }
      const bid = bidOf(row, trustedBidOnly); if (bid === null) return;
      bidRows += 1;
      const date = text(row?.date);
      const normalizedBid = Math.round(bid * 1000000) / 1000000;
      if (!group.latestDate || date > group.latestDate) {
        group.latestDate = date; group.latestBids = new Set([normalizedBid]);
      } else if (date === group.latestDate) {
        group.latestBids.add(normalizedBid);
      }
    });
    const normalizedGroups = new Map();
    let bidReadyGroups = 0; let bidMissingGroups = 0; let bidAmbiguousGroups = 0; let targetingIdMissingGroups = 0; let targetingIdAmbiguousGroups = 0;
    for (const [key, group] of groups.entries()) {
      const ids = [...group.targetingIds]; const bids = [...group.latestBids];
      const bidAmbiguous = bids.length > 1; const bidMissing = bids.length === 0;
      const targetingIdAmbiguous = ids.length > 1; const targetingIdMissing = ids.length === 0;
      if (bidAmbiguous) bidAmbiguousGroups += 1; else if (bidMissing) bidMissingGroups += 1; else bidReadyGroups += 1;
      if (targetingIdAmbiguous) targetingIdAmbiguousGroups += 1; else if (targetingIdMissing) targetingIdMissingGroups += 1;
      normalizedGroups.set(key, {
        ...group, targetingIds: ids, targetingId: ids.length === 1 ? ids[0] : '', latestBids: bids,
        latestBid: bids.length === 1 ? bids[0] : null, bidAmbiguous, bidMissing, targetingIdAmbiguous, targetingIdMissing,
      });
    }
    return {
      groups: normalizedGroups,
      totals: {
        rowCount: input.length, groupCount: normalizedGroups.size, targetingIdRows, bidRows,
        targetingIdCoverage: input.length ? targetingIdRows / input.length : 0,
        bidCoverage: input.length ? bidRows / input.length : 0,
        bidReadyGroups, bidMissingGroups, bidAmbiguousGroups, targetingIdMissingGroups, targetingIdAmbiguousGroups,
      },
    };
  }

  function compareBidControls(legacyInput, queryInput) {
    const legacy = summarizeBidControls(legacyInput, { trustedBidOnly: false });
    const query = summarizeBidControls(queryInput, { trustedBidOnly: true });
    const legacyKeys = new Set(legacy.groups.keys()); const queryKeys = new Set(query.groups.keys());
    const intersection = [...legacyKeys].filter(key => queryKeys.has(key));
    const union = new Set([...legacyKeys, ...queryKeys]);
    const groupOverlap = union.size ? intersection.length / union.size : 1;
    const legacyOnly = [...legacyKeys].filter(key => !queryKeys.has(key));
    const queryOnly = [...queryKeys].filter(key => !legacyKeys.has(key));
    let bidCompared = 0; let bidMismatch = 0; let bidMissingEither = 0; let bidAmbiguousEither = 0;
    let targetingIdMismatch = 0; let targetingIdMissingEither = 0; let targetingIdAmbiguousEither = 0;
    const mismatches = [];

    intersection.forEach(key => {
      const left = legacy.groups.get(key); const right = query.groups.get(key);
      let state = 'match'; let bidDelta = null;
      if (left.bidAmbiguous || right.bidAmbiguous) { state = 'bid-ambiguous'; bidAmbiguousEither += 1; }
      else if (left.bidMissing || right.bidMissing) { state = 'bid-missing'; bidMissingEither += 1; }
      else {
        bidCompared += 1; bidDelta = right.latestBid - left.latestBid;
        if (Math.abs(bidDelta) > 0.000001) { state = 'bid-mismatch'; bidMismatch += 1; }
      }
      if (left.targetingIdAmbiguous || right.targetingIdAmbiguous) { state = state === 'match' ? 'targeting-id-ambiguous' : state; targetingIdAmbiguousEither += 1; }
      else if (left.targetingIdMissing || right.targetingIdMissing) { state = state === 'match' ? 'targeting-id-missing' : state; targetingIdMissingEither += 1; }
      else if (left.targetingId !== right.targetingId) { state = state === 'match' ? 'targeting-id-mismatch' : state; targetingIdMismatch += 1; }
      if (state !== 'match') {
        mismatches.push({
          key, state, campaign: left.campaign || right.campaign, adGroup: left.adGroup || right.adGroup,
          targeting: left.targeting || right.targeting, matchType: left.matchType || right.matchType,
          legacyTargetingId: left.targetingId, queryTargetingId: right.targetingId,
          legacyBid: left.latestBid, queryBid: right.latestBid, bidDelta,
        });
      }
    });
    legacyOnly.forEach(key => {
      const row = legacy.groups.get(key); mismatches.push({ key, state: 'legacy-only', campaign: row.campaign, adGroup: row.adGroup, targeting: row.targeting, matchType: row.matchType, legacyTargetingId: row.targetingId, queryTargetingId: '', legacyBid: row.latestBid, queryBid: null, bidDelta: null });
    });
    queryOnly.forEach(key => {
      const row = query.groups.get(key); mismatches.push({ key, state: 'query-only', campaign: row.campaign, adGroup: row.adGroup, targeting: row.targeting, matchType: row.matchType, legacyTargetingId: '', queryTargetingId: row.targetingId, legacyBid: null, queryBid: row.latestBid, bidDelta: null });
    });

    const identityComparable = legacy.groups.size > 0 && query.groups.size > 0 && groupOverlap >= 0.995 && legacyOnly.length === 0 && queryOnly.length === 0;
    const comparable = identityComparable
      && bidMissingEither === 0 && bidAmbiguousEither === 0
      && targetingIdMissingEither === 0 && targetingIdAmbiguousEither === 0;
    const pass = comparable && bidMismatch === 0 && targetingIdMismatch === 0;
    return {
      comparable, pass, identityComparable, groupOverlap, matchedGroups: intersection.length,
      legacyOnlyCount: legacyOnly.length, queryOnlyCount: queryOnly.length,
      bidCompared, bidMismatch, bidMissingEither, bidAmbiguousEither,
      targetingIdMismatch, targetingIdMissingEither, targetingIdAmbiguousEither,
      legacy: legacy.totals, query: query.totals, mismatches: mismatches.slice(0, MAX_MISMATCH_ROWS),
    };
  }

  async function run'''
s, count = compare_pattern.subn(compare_replacement, s, count=1)
assert count == 1, f'compareRows replacement count={count}'

run_pattern = re.compile(r"  async function run\(\{ force = true \} = \{\}\) \{.*?\n  \}\n\n  function snapshot", re.S)
run_replacement = r'''  async function run({ force = true } = {}) {
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
      const legacyControls = legacyControlRows();
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
      const bidControl = compareBidControls(legacyControls, queryRows);
      const requiredReadiness = [
        'targetingIdentityReady', 'bidSourceColumnReady', 'bidValueNullabilityTrusted',
        'adProductReady', 'advertisedProductIdentityReady', 'attributionMaturityReady',
      ];
      const migrationBlockers = requiredReadiness.filter(key => readiness[key] !== true);
      if (!bidControl.comparable) migrationBlockers.push('legacyBidComparable');
      else if (!bidControl.pass) migrationBlockers.push('legacyBidParity');
      comparison.adProductScopeProven = adProductScopeProven;
      comparison.queryScopeMode = adProductScopeProven ? 'source-proven-sp' : 'unproven-ad-product-diagnostic';
      comparison.bidGovernanceReady = readiness.bidGovernanceReady === true;
      comparison.bidControl = bidControl;
      comparison.bidControlComparable = bidControl.comparable;
      comparison.bidControlParityPass = bidControl.pass;
      comparison.bidComparable = bidControl.comparable;
      comparison.bidParityPass = bidControl.pass;
      comparison.bidPass = bidControl.pass;
      comparison.bidCompared = bidControl.bidCompared;
      comparison.bidMismatch = bidControl.bidMismatch;
      comparison.bidMissingEither = bidControl.bidMissingEither;
      comparison.scopeBlockers = [...migrationBlockers];
      comparison.migrationBlockers = [...migrationBlockers];
      comparison.verdict = !comparison.metricParityPass || (bidControl.comparable && !bidControl.pass)
        ? 'fail' : migrationBlockers.length ? 'warn' : 'pass';
      comparison.migrationCandidate = Boolean(
        comparison.metricParityPass && bidControl.comparable && bidControl.pass
        && comparison.bidGovernanceReady && migrationBlockers.length === 0
      );
      setState({ status: 'ready', legacy: summarizeRows(legacy).totals, query: summarizeRows(queryRows, { trustedBidOnly: true }).totals,
        comparison, governance: payload.governance, lastError: '', refreshedAt: Date.now() });
      render(); dispatch('lr:bid-governance-parity-ready', snapshot()); return snapshot();
    } catch (error) {
      setState({ status: 'error', legacy: null, query: null, comparison: null, governance: null, lastError: text(error?.message || error), refreshedAt: Date.now() });
      render(); dispatch('lr:bid-governance-parity-error', { version: AUDIT_VERSION, status: Number(error?.status || 0), message: state.lastError }); throw error;
    }
  }

  function snapshot'''
s, count = run_pattern.subn(run_replacement, s, count=1)
assert count == 1, f'run replacement count={count}'

old = "comparison: state.comparison ? { ...state.comparison, metrics: Object.fromEntries(Object.entries(state.comparison.metrics || {}).map(([key, value]) => [key, { ...value }])), mismatches: (state.comparison.mismatches || []).map(row => ({ ...row })) } : null,"
new = "comparison: state.comparison ? { ...state.comparison, metrics: Object.fromEntries(Object.entries(state.comparison.metrics || {}).map(([key, value]) => [key, { ...value }])), mismatches: (state.comparison.mismatches || []).map(row => ({ ...row })), bidControl: state.comparison.bidControl ? { ...state.comparison.bidControl, legacy: { ...(state.comparison.bidControl.legacy || {}) }, query: { ...(state.comparison.bidControl.query || {}) }, mismatches: (state.comparison.bidControl.mismatches || []).map(row => ({ ...row })) } : null } : null,"
assert s.count(old) == 1, 'snapshot comparison clone shape changed'
s = s.replace(old, new)

old = '''  function verdictLabel(verdict) {
    if (verdict === 'pass') return 'Metric Parity Pass';
    if (verdict === 'warn') return 'Metric / Identity Parity · Bid / 治理待审计';
    return 'Parity Gap · 禁止迁移';
  }'''
new = '''  function verdictLabel(verdict) {
    if (verdict === 'pass') return 'Performance + Bid Control Parity Pass';
    if (verdict === 'warn') return 'Performance Parity · Bid Control / 治理待审计';
    return 'Parity Gap · 禁止迁移';
  }'''
assert s.count(old) == 1, 'verdictLabel block changed'
s = s.replace(old, new)

render_pattern = re.compile(r"    const c = state\.comparison; banner\.dataset\.kind = c\.verdict.*?\n    grid\.innerHTML = metricTable \+ mismatchTable;", re.S)
render_replacement = r'''    const c = state.comparison; const control = c.bidControl || {};
    banner.dataset.kind = c.verdict === 'pass' ? 'good' : c.verdict === 'warn' ? 'warn' : 'bad';
    banner.textContent = `${verdictLabel(c.verdict)} · ${c.adProductScopeProven ? 'SP scope source-proven' : 'Ad Product scope unproven · diagnostic only'} · BidControl=${c.bidControlComparable ? (c.bidControlParityPass ? 'comparable/pass' : 'comparable/gap') : 'not comparable'} · blockers=${(c.migrationBlockers || []).join(', ') || 'none'} · migrationCandidate=${Boolean(c.migrationCandidate)} · executionAuthorized=false`;
    kpis.innerHTML = [
      ['Rows L / Q', `${fmtInt(c.legacy.rowCount)} / ${fmtInt(c.query.rowCount)}`],
      ['Spend Δ', fmtMoney(c.metrics.spend.absolute)], ['Sales Δ', fmtMoney(c.metrics.sales.absolute)],
      ['Performance overlap', fmtPct(c.groupOverlap)],
      ['Controls L / Q', `${fmtInt(control.legacy?.groupCount)} / ${fmtInt(control.query?.groupCount)}`],
      ['Bid Control', c.bidControlComparable ? `${fmtInt(control.bidMismatch)} mismatch · ${fmtInt(control.targetingIdMismatch)} ID mismatch` : 'Not comparable'],
    ].map(([label, value]) => `<div class="bgpaKpi"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join('');
    const metricRows = [ ['Rows', c.rowCount, fmtInt], ['Impressions', c.metrics.impressions, fmtInt], ['Clicks', c.metrics.clicks, fmtInt], ['Spend', c.metrics.spend, fmtMoney], ['Sales', c.metrics.sales, fmtMoney], ['Orders', c.metrics.orders, fmtInt] ];
    const metricTable = `<div class="bgpaTableWrap"><table class="bgpaTable"><thead><tr><th>Performance Metric</th><th>Legacy</th><th>Query</th><th>Δ</th><th>Rel</th><th>State</th></tr></thead><tbody>${metricRows.map(([name,item,formatter]) => `<tr><td>${escapeHtml(name)}</td><td class="num">${escapeHtml(formatter(item.legacy))}</td><td class="num">${escapeHtml(formatter(item.query))}</td><td class="num">${escapeHtml(name === 'Spend' || name === 'Sales' ? fmtMoney(item.absolute) : fmtSigned(item.absolute, 0))}</td><td class="num">${escapeHtml(fmtPct(item.relative))}</td><td><span class="bgpaTag ${item.pass ? 'good' : 'bad'}">${item.pass ? 'PASS' : 'GAP'}</span></td></tr>`).join('')}</tbody></table></div>`;
    const controlTable = `<div class="bgpaTableWrap"><table class="bgpaTable"><thead><tr><th>Bid Control Object</th><th>State</th><th>Targeting ID L / Q</th><th>Latest Bid L / Q</th></tr></thead><tbody>${(control.mismatches || []).length ? control.mismatches.map(row => `<tr><td title="${escapeHtml([row.campaign,row.adGroup,row.targeting,row.matchType].filter(Boolean).join(' / '))}">${escapeHtml(row.targeting || row.key)}</td><td>${escapeHtml(row.state || 'gap')}</td><td>${escapeHtml(`${row.legacyTargetingId || '—'} / ${row.queryTargetingId || '—'}`)}</td><td class="num">${escapeHtml(`${row.legacyBid ?? '—'} / ${row.queryBid ?? '—'}`)}</td></tr>`).join('') : '<tr><td colspan="4">Bid Control Parity 当前没有控制对象差异。</td></tr>'}</tbody></table></div>`;
    const mismatchTable = `<div class="bgpaTableWrap"><table class="bgpaTable"><thead><tr><th>Performance Object</th><th>Side</th><th>Spend L/Q</th><th>Sales L/Q</th><th>Orders L/Q</th></tr></thead><tbody>${(c.mismatches || []).length ? c.mismatches.map(row => `<tr><td title="${escapeHtml([row.campaign,row.adGroup,row.targeting].filter(Boolean).join(' / '))}">${escapeHtml(row.targetingId || row.targeting || row.key)}</td><td>${escapeHtml(row.side || 'metric')}</td><td class="num">${escapeHtml(`${fmtMoney(row.legacySpend)} / ${fmtMoney(row.querySpend)}`)}</td><td class="num">${escapeHtml(`${fmtMoney(row.legacySales)} / ${fmtMoney(row.querySales)}`)}</td><td class="num">${escapeHtml(`${fmtInt(row.legacyOrders)} / ${fmtInt(row.queryOrders)}`)}</td></tr>`).join('') : '<tr><td colspan="5">Performance Parity 当前没有对象级差异。</td></tr>'}</tbody></table></div>`;
    grid.innerHTML = metricTable + controlTable + mismatchTable;'''
s, count = render_pattern.subn(render_replacement, s, count=1)
assert count == 1, f'render replacement count={count}'

old = 'window.BidGovernanceParityAudit = Object.freeze({ version: AUDIT_VERSION, run, compareRows, summarizeRows, rawEligibility, state: snapshot });'
new = 'window.BidGovernanceParityAudit = Object.freeze({ version: AUDIT_VERSION, run, compareRows, compareBidControls, summarizeRows, summarizeBidControls, rawEligibility, state: snapshot });'
assert s.count(old) == 1, 'public audit API shape changed'
s = s.replace(old, new)
p.write_text(s, encoding='utf-8')

# 3) Cache-bust the parity asset only.
p = Path('assets/private-cloud-query-v1.js')
s = p.read_text(encoding='utf-8')
old = "const BID_GOVERNANCE_PARITY_AUDIT_VERSION = '1.0.3';"
assert s.count(old) == 1
p.write_text(s.replace(old, "const BID_GOVERNANCE_PARITY_AUDIT_VERSION = '1.0.4';"), encoding='utf-8')

# 4) Add a permanent legacy-source static contract test.
Path('scripts/test-legacy-bid-control-source.mjs').write_text(r'''import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../assets/generated/inline-script-04.js', import.meta.url), 'utf8');

assert.match(source, /targetingId:\s*\["投放方案编号","Targeting ID","TargetingID","Targeting Id","Target ID","TargetID"\]/);
assert.match(source, /currentBid:\s*\["Bid","Keyword Bid","Current Bid","目标竞价","竞价","关键词竞价","Ad Group Default Bid"\]/);
assert.match(source, /targetingId:\s*intern\(String\(map\.targetingId \? raw\[map\.targetingId\] : ""\)\.trim\(\)\)/);
assert.match(source, /currentBid:\s*map\.currentBid \? safeNum\(raw\[map\.currentBid\]\) : null/);
assert.match(source, /getBidGovernanceControlRowsForParity:\(\)=>getBidGovScopedRows\("searchTerm"\)\.map\(row=>\(\{/);
assert.match(source, /currentBid:Number\.isFinite\(row\.currentBid\)&&row\.currentBid>0\?row\.currentBid:null/);

const bridgeStart = source.indexOf('getBidGovernanceControlRowsForParity:');
assert.notEqual(bridgeStart, -1);
const bridgeEnd = source.indexOf('getProductCostDiagnostics:', bridgeStart);
assert.notEqual(bridgeEnd, -1);
const bridge = source.slice(bridgeStart, bridgeEnd);
for (const forbidden of ['suggestedBid', 'bulkReady', 'export', 'execute', 'assertActionAllowed', 'QueryNativeGovernanceGate']) {
  assert.equal(bridge.includes(forbidden), false, `Read-only Bid Control parity bridge must not contain ${forbidden}`);
}

console.log('Legacy Bid Control source parsing and read-only bridge contracts passed');
''', encoding='utf-8')

# 5) Replace the parity behavior test with separated performance/control contracts.
Path('scripts/test-bid-governance-parity-audit.mjs').write_text(r'''import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/bid-governance-parity-audit-v1.js', import.meta.url), 'utf8');
assert.match(source, /const AUDIT_VERSION = '1\.0\.4'/);
assert.match(source, /getBidGovernanceScopedRowsForParity/);
assert.match(source, /getBidGovernanceControlRowsForParity/);
assert.match(source, /function compareBidControls\(/);
assert.match(source, /legacyBidComparable/);
assert.match(source, /legacyBidParity/);
assert.match(source, /executionAuthorized: false/);
assert.doesNotMatch(source, /PrivateCloudAds\?*\.?(?:loadRaw|loadFullHistory|loadCurrentMonth|loadRecentMonths)|QueryNativeGovernanceGate\.(?:adopt|refresh|assertActionAllowed)|suggestedBid|report_slots/);

const values = new Map([
  ['dateStart', { value: '2026-06-01' }], ['dateEnd', { value: '2026-06-30' }],
  ['filterSource', { value: '' }], ['filterPortfolio', { value: '' }], ['filterCampaign', { value: '' }],
  ['filterAdGroup', { value: '' }], ['filterTargeting', { value: '' }], ['filterMatchType', { value: '' }],
  ['filterAdType', { value: '' }], ['filterAdProduct', { value: '' }], ['filterSearchTerm', { value: '' }],
  ['filterSearchExact', { checked: false }],
]);
const document = {
  readyState: 'loading', addEventListener() {}, getElementById(id) { return values.get(id) || null; },
  createElement() { return { id: '', dataset: {}, style: {}, innerHTML: '', addEventListener() {}, appendChild() {} }; },
  head: { appendChild() {} },
};
class TestCustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }
const events = [];
let queryRequest = null; let queryTruncated = false; let rawLoadCalled = false;
const cloudState = {
  loadedOnce: true, rawStale: false, loadedScope: 'YTDBNS', loadedMonths: ['2026-06'],
  loadedRange: { fromMonth: '2026-06', toMonth: '2026-06', months: ['2026-06'] },
  rawBootstrapFingerprint: 'fp-1', dataFingerprint: 'fp-1', bootstrap: { coverage: { months: ['2026-06'] } },
};
let globalThisQueryRows = []; let readinessOverrides = {};
const baseReadiness = {
  targetingIdentityReady: true, bidSourceColumnReady: true, bidValueNullabilityTrusted: true,
  adProductReady: false, advertisedProductIdentityReady: false, attributionMaturityReady: false, bidGovernanceReady: false,
};
const window = {
  ACTIVE_SHOP: 'YTDBNS', ShopScope: { get: () => 'YTDBNS' },
  PrivateCloudAds: { state: () => ({ ...cloudState }), loadRaw() { rawLoadCalled = true; throw new Error('Parity audit must never load Raw'); } },
  QueryNativeModuleData: { async ads(request) { queryRequest = request; return { source: 'query-tidb', rows: globalThisQueryRows, truncated: queryTruncated, nextOffset: queryTruncated ? 500 : null, governance: { schemaVersion: 'ads-query-governance-v2', readiness: { ...baseReadiness, ...readinessOverrides } } }; } },
  addEventListener() {}, dispatchEvent(event) { events.push(event); return true; },
};
const context = vm.createContext({ window, document, CustomEvent: TestCustomEvent, console, Error, Date, Map, Set, Object, Array, String, Number, Boolean, Math, Promise });

const legacyRows = [
  { date: '2026-06-01', targetingId: 'T1', campaign: 'C1', adGroup: 'A1', targeting: 'reading glasses', matchType: 'EXACT', impressions: 1000, clicks: 50, spend: 10, sales: 50, orders: 2, currentBid: 0.50 },
  { date: '2026-06-02', targetingId: 'T1', campaign: 'C1', adGroup: 'A1', targeting: 'reading glasses', matchType: 'EXACT', impressions: 500, clicks: 20, spend: 5, sales: 25, orders: 1, currentBid: 0.55 },
  { date: '2026-06-02', targetingId: 'T2', campaign: 'C2', adGroup: 'A2', targeting: 'fashion readers', matchType: 'PHRASE', impressions: 300, clicks: 10, spend: 3, sales: 0, orders: 0, currentBid: 0.40 },
];
const legacyControls = legacyRows.map(({ date, targetingId, campaign, adGroup, targeting, matchType, currentBid }) => ({ date, targetingId, campaign, adGroup, targeting, matchType, currentBid }));
const queryRows = legacyRows.map(row => ({ ...row, bidValueTrusted: true, adProduct: 'SP' }));
globalThisQueryRows = queryRows;
context.__legacyRows = legacyRows; context.__legacyControls = legacyControls;
vm.runInContext('const AdsDashboardApp = { debug: { getBidGovernanceScopedRowsForParity: () => __legacyRows.map(row => ({ ...row })), getBidGovernanceControlRowsForParity: () => __legacyControls.map(row => ({ ...row })) } };', context);
vm.runInContext(source, context, { filename: 'bid-governance-parity-audit-v1.js' });
const audit = window.BidGovernanceParityAudit;
assert.equal(audit.version, '1.0.4');

// Performance parity must ignore Bid values completely.
const queryWithDifferentBids = queryRows.map((row, index) => ({ ...row, currentBid: 9 + index }));
const performance = audit.compareRows(legacyRows, queryWithDifferentBids);
assert.equal(performance.metricParityPass, true);
assert.equal(performance.verdict, 'pass');
assert.equal(performance.groupOverlap, 1);
assert.equal(performance.mismatches.length, 0);
assert.equal('bidParityPass' in performance, false);

// Control parity collapses repeated search-term rows to the latest Bid per route.
const controlPass = audit.compareBidControls(legacyControls, queryRows);
assert.equal(controlPass.comparable, true);
assert.equal(controlPass.pass, true);
assert.equal(controlPass.matchedGroups, 2);
assert.equal(controlPass.bidCompared, 2);
assert.equal(controlPass.bidMismatch, 0);
assert.equal(controlPass.targetingIdMismatch, 0);

const bidMismatchRows = queryRows.map(row => ({ ...row }));
bidMismatchRows[1].currentBid = 0.60;
const controlMismatch = audit.compareBidControls(legacyControls, bidMismatchRows);
assert.equal(controlMismatch.comparable, true);
assert.equal(controlMismatch.pass, false);
assert.equal(controlMismatch.bidMismatch, 1);
assert.ok(controlMismatch.mismatches.some(row => row.state === 'bid-mismatch'));

const ambiguousQuery = [...queryRows.map(row => ({ ...row })), { ...queryRows[1], currentBid: 0.61 }];
const ambiguous = audit.compareBidControls(legacyControls, ambiguousQuery);
assert.equal(ambiguous.comparable, false);
assert.equal(ambiguous.pass, false);
assert.equal(ambiguous.bidAmbiguousEither, 1);

const missingBidLegacy = legacyControls.map(row => ({ ...row }));
missingBidLegacy[2].currentBid = null;
const missingBid = audit.compareBidControls(missingBidLegacy, queryRows);
assert.equal(missingBid.comparable, false);
assert.equal(missingBid.bidMissingEither, 1);

const idMismatchRows = queryRows.map(row => ({ ...row }));
idMismatchRows[2].targetingId = 'T9';
const idMismatch = audit.compareBidControls(legacyControls, idMismatchRows);
assert.equal(idMismatch.comparable, true);
assert.equal(idMismatch.pass, false);
assert.equal(idMismatch.targetingIdMismatch, 1);

const notLoaded = audit.rawEligibility({ scope: 'YTDBNS', from: '2026-06-01', to: '2026-06-30', adProduct: '' }, { loadedOnce: false, loadedScope: '', loadedMonths: [], loadedRange: null, rawStale: false, rawBootstrapFingerprint: '', dataFingerprint: 'fp-1', bootstrap: { coverage: { months: ['2026-06'] } } });
assert.equal(notLoaded.ready, false);
assert.ok(notLoaded.reasons.some(reason => /显式加载 Raw/.test(reason)));

// Real run: Bid Control passes, but source governance blockers keep migration closed.
readinessOverrides = {};
const runResult = await audit.run({ force: true });
assert.equal(runResult.status, 'ready');
assert.equal(runResult.comparison.metricParityPass, true);
assert.equal(runResult.comparison.bidControlComparable, true);
assert.equal(runResult.comparison.bidControlParityPass, true);
assert.equal(runResult.comparison.bidComparable, true);
assert.equal(runResult.comparison.bidParityPass, true);
assert.equal(runResult.comparison.verdict, 'warn');
assert.deepEqual([...runResult.comparison.migrationBlockers], ['adProductReady', 'advertisedProductIdentityReady', 'attributionMaturityReady']);
assert.equal(runResult.comparison.migrationCandidate, false);
assert.equal(runResult.executionAuthorized, false);
assert.equal(queryRequest.source, 'query');
assert.equal(queryRequest.adProduct, '');
assert.equal(rawLoadCalled, false);
assert.ok(events.some(event => event.type === 'lr:bid-governance-parity-ready'));

// A control mismatch must fail even while execution remains closed.
context.__legacyControls[1].currentBid = 0.60;
const failedRun = await audit.run({ force: true });
assert.equal(failedRun.comparison.verdict, 'fail');
assert.equal(failedRun.comparison.bidControlComparable, true);
assert.equal(failedRun.comparison.bidControlParityPass, false);
assert.ok(failedRun.comparison.migrationBlockers.includes('legacyBidParity'));
assert.equal(failedRun.comparison.migrationCandidate, false);
assert.equal(failedRun.executionAuthorized, false);
context.__legacyControls[1].currentBid = 0.55;

// Hypothetical fully proven source + control parity can become a migration candidate, never execution authorization.
readinessOverrides = { adProductReady: true, advertisedProductIdentityReady: true, attributionMaturityReady: true, bidGovernanceReady: true };
const provenRun = await audit.run({ force: true });
assert.equal(provenRun.comparison.verdict, 'pass');
assert.deepEqual([...provenRun.comparison.migrationBlockers], []);
assert.equal(provenRun.comparison.migrationCandidate, true);
assert.equal(provenRun.executionAuthorized, false);

queryTruncated = true;
await assert.rejects(() => audit.run({ force: true }), error => { assert.equal(error.status, 409); assert.match(error.message, /分页上限/); return true; });
assert.equal(audit.state().status, 'error');
assert.equal(audit.state().comparison, null);
assert.equal(audit.state().executionAuthorized, false);
assert.equal(rawLoadCalled, false);

console.log('Bid Governance performance and Bid Control parity contracts passed');
''', encoding='utf-8')

# 6) Sync progressive contract and make it run the parser contract.
p = Path('scripts/test-progressive-loader.mjs')
s = p.read_text(encoding='utf-8')
replacements = [
  ("assert.match(query, /const BID_GOVERNANCE_PARITY_AUDIT_VERSION = '1\\.0\\.3'/);", "assert.match(query, /const BID_GOVERNANCE_PARITY_AUDIT_VERSION = '1\\.0\\.4'/);"),
  ("assert.match(parityAudit, /const AUDIT_VERSION = '1\\.0\\.3'/);", "assert.match(parityAudit, /const AUDIT_VERSION = '1\\.0\\.4'/);"),
  ("assert.match(legacyCore, /getBidGovernanceScopedRowsForParity:\\(\\)=>getBidGovScopedRows\\(\\\"searchTerm\\\"\\)\\.map\\(row=>\\(\\{\\.\\.\\.row\\}\\)\\)/);", "assert.match(legacyCore, /getBidGovernanceScopedRowsForParity/);\nassert.match(legacyCore, /getBidGovernanceControlRowsForParity/);\nassert.match(legacyCore, /投放方案编号/);\nassert.match(legacyCore, /目标竞价/);"),
  ("assert.match(parityAudit, /AdsDashboardApp\\?\\.debug\\?\\.getBidGovernanceScopedRowsForParity/);", "assert.match(parityAudit, /AdsDashboardApp\\?\\.debug\\?\\.getBidGovernanceScopedRowsForParity/);\nassert.match(parityAudit, /AdsDashboardApp\\?\\.debug\\?\\.getBidGovernanceControlRowsForParity/);\nassert.match(parityAudit, /function compareBidControls\\(/);"),
  ("assert.match(parityAudit, /comparison\\.bidParityPass/);", "assert.match(parityAudit, /comparison\\.bidControlParityPass/);\nassert.match(parityAudit, /comparison\\.bidParityPass/);"),
]
for old, new in replacements:
    assert s.count(old) == 1, f'progressive replacement count={s.count(old)} for {old}'
    s = s.replace(old, new)
old = "console.log('Progressive Query-first loader and shop UI invariants passed');\nawait import('./test-query-native-governance-gate.mjs');"
new = "console.log('Progressive Query-first loader and shop UI invariants passed');\nawait import('./test-legacy-bid-control-source.mjs');\nawait import('./test-query-native-governance-gate.mjs');"
assert s.count(old) == 1
s = s.replace(old, new)
p.write_text(s, encoding='utf-8')

print('Phase 11 Bid Control Parity v1.0.4 patch applied')
