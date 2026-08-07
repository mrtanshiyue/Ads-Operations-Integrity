(() => {
  'use strict';

  const PREVIEW_VERSION = '1.0.0';
  const GOVERNANCE_VERSION = 'ads-query-governance-v2';
  const MAX_ROWS = 300000;
  const MAX_GROUPS = 20;
  const FILTER_IDS = [
    'dateStart', 'dateEnd', 'filterSource', 'filterPortfolio', 'filterCampaign',
    'filterAdGroup', 'filterTargeting', 'filterMatchType', 'filterAdType',
    'filterAdProduct', 'filterSearchTerm', 'filterSearchExact',
  ];
  const state = {
    status: 'idle',
    source: 'none',
    request: null,
    governance: null,
    summary: null,
    groups: [],
    lastError: '',
    refreshedAt: 0,
  };

  const byId = id => document.getElementById(id);
  const text = value => String(value ?? '').trim();
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
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const fmtMoney = value => Number.isFinite(Number(value))
    ? `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—';
  const fmtPct = value => Number.isFinite(Number(value))
    ? `${(Number(value) * 100).toFixed(1)}%`
    : '—';
  const fmtRatio = value => Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—';

  function currentRequest() {
    return {
      scope: text(window.ShopScope?.get?.() || window.ACTIVE_SHOP || 'ALL').toUpperCase() || 'ALL',
      from: text(byId('dateStart')?.value),
      to: text(byId('dateEnd')?.value),
      sourceFile: text(byId('filterSource')?.value),
      portfolio: text(byId('filterPortfolio')?.value),
      campaign: text(byId('filterCampaign')?.value),
      adGroup: text(byId('filterAdGroup')?.value),
      targeting: text(byId('filterTargeting')?.value),
      matchType: text(byId('filterMatchType')?.value),
      adType: text(byId('filterAdType')?.value),
      adProduct: text(byId('filterAdProduct')?.value),
      search: text(byId('filterSearchTerm')?.value),
      searchExact: Boolean(byId('filterSearchExact')?.checked),
    };
  }

  function governanceReasons(governance) {
    const readiness = governance?.readiness || {};
    const reasons = [];
    if (!readiness.targetingIdentityReady) reasons.push('Targeting identity 未验证');
    if (!readiness.bidSourceColumnReady) reasons.push('Bid 源列未验证');
    if (!readiness.bidValueNullabilityTrusted) reasons.push('Bid NULL/0 语义未验证');
    if (!readiness.adProductReady) reasons.push('Ad Product 源数据不可用');
    if (!readiness.advertisedProductIdentityReady) reasons.push('Advertised ASIN/SKU 源数据不可用');
    if (!readiness.attributionMaturityReady) reasons.push('归因窗口源数据不可用');
    return reasons;
  }

  function analyzeRows(rows, governance = null) {
    const input = Array.isArray(rows) ? rows : [];
    const totals = input.reduce((acc, row) => {
      acc.impressions += number(row?.impressions ?? row?.impr);
      acc.clicks += number(row?.clicks);
      acc.spend += number(row?.spend);
      acc.sales += number(row?.sales);
      acc.orders += number(row?.orders);
      if (row?.bidValueTrusted === true) acc.bidTrustedRows += 1;
      if (row?.bidValueTrusted === true && nullableNumber(row?.currentBid ?? row?.bid ?? row?.targetBid) !== null) {
        acc.bidKnownRows += 1;
      }
      return acc;
    }, {
      impressions: 0,
      clicks: 0,
      spend: 0,
      sales: 0,
      orders: 0,
      bidTrustedRows: 0,
      bidKnownRows: 0,
    });
    totals.ctr = totals.impressions > 0 ? totals.clicks / totals.impressions : 0;
    totals.cpc = totals.clicks > 0 ? totals.spend / totals.clicks : 0;
    totals.cvr = totals.clicks > 0 ? totals.orders / totals.clicks : 0;
    totals.roas = totals.spend > 0 ? totals.sales / totals.spend : 0;
    totals.acos = totals.sales > 0 ? totals.spend / totals.sales : (totals.spend > 0 ? Infinity : 0);
    totals.bidCoverage = input.length > 0 ? totals.bidKnownRows / input.length : 0;

    const grouped = new Map();
    input.forEach((row, index) => {
      const targetingId = text(row?.targetingId);
      const campaign = text(row?.campaign);
      const adGroup = text(row?.adGroup);
      const targeting = text(row?.targeting || row?.searchTerm);
      const key = targetingId || [campaign, adGroup, targeting].join('|') || `row:${index}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          targetingId,
          campaign,
          adGroup,
          targeting,
          advertisedAsin: text(row?.advertisedAsin),
          impressions: 0,
          clicks: 0,
          spend: 0,
          sales: 0,
          orders: 0,
          rowCount: 0,
          bidTrustedRows: 0,
          bidKnownRows: 0,
          latestBid: null,
          latestBidDate: '',
        });
      }
      const group = grouped.get(key);
      group.rowCount += 1;
      group.impressions += number(row?.impressions ?? row?.impr);
      group.clicks += number(row?.clicks);
      group.spend += number(row?.spend);
      group.sales += number(row?.sales);
      group.orders += number(row?.orders);
      if (!group.campaign) group.campaign = campaign;
      if (!group.adGroup) group.adGroup = adGroup;
      if (!group.targeting) group.targeting = targeting;
      if (!group.advertisedAsin) group.advertisedAsin = text(row?.advertisedAsin);
      const trusted = row?.bidValueTrusted === true;
      const bid = trusted ? nullableNumber(row?.currentBid ?? row?.bid ?? row?.targetBid) : null;
      if (trusted) group.bidTrustedRows += 1;
      if (bid !== null) {
        group.bidKnownRows += 1;
        const date = text(row?.date);
        if (!group.latestBidDate || date >= group.latestBidDate) {
          group.latestBid = bid;
          group.latestBidDate = date;
        }
      }
    });

    const readiness = governance?.readiness || {};
    const reasons = governanceReasons(governance);
    const groups = [...grouped.values()].map(group => {
      group.ctr = group.impressions > 0 ? group.clicks / group.impressions : 0;
      group.cpc = group.clicks > 0 ? group.spend / group.clicks : 0;
      group.cvr = group.clicks > 0 ? group.orders / group.clicks : 0;
      group.roas = group.spend > 0 ? group.sales / group.spend : 0;
      group.acos = group.sales > 0 ? group.spend / group.sales : (group.spend > 0 ? Infinity : 0);
      group.bidCoverage = group.rowCount > 0 ? group.bidKnownRows / group.rowCount : 0;
      group.signal = intelligenceSignal(group, readiness);
      return group;
    }).sort((left, right) => right.spend - left.spend || right.clicks - left.clicks);

    return {
      summary: {
        ...totals,
        rowCount: input.length,
        groupCount: groups.length,
        governanceVersion: text(governance?.schemaVersion),
        bidGovernanceReady: Boolean(readiness.bidGovernanceReady),
        attributionMaturityReady: Boolean(readiness.attributionMaturityReady),
        advertisedProductIdentityReady: Boolean(readiness.advertisedProductIdentityReady),
        adProductReady: Boolean(readiness.adProductReady),
        bidValueNullabilityTrusted: Boolean(readiness.bidValueNullabilityTrusted),
        blockers: reasons,
      },
      groups,
    };
  }

  function intelligenceSignal(group, readiness = {}) {
    if (!readiness.bidValueNullabilityTrusted) {
      return { key: 'data-block', label: 'Data Block', detail: 'Bid NULL/0 语义尚未验证', kind: 'bad' };
    }
    if (group.latestBid === null) {
      return { key: 'bid-missing', label: 'Bid Missing', detail: '当前对象没有可信 Current Bid', kind: 'warn' };
    }
    if (!readiness.attributionMaturityReady) {
      return { key: 'analysis-only', label: 'Analysis Only', detail: '归因窗口不可用，仅展示效率信号', kind: 'warn' };
    }
    if (!readiness.advertisedProductIdentityReady || !readiness.adProductReady) {
      return { key: 'identity-block', label: 'Identity Block', detail: '产品身份/广告类型未验证，禁止执行', kind: 'warn' };
    }
    if (group.orders === 0 && group.spend > 0) {
      return { key: 'zero-order-spend', label: 'Zero-order Spend', detail: '存在成熟前提下的0单花费信号，需人工复核', kind: 'bad' };
    }
    if (group.roas >= 3 && group.orders >= 2) {
      return { key: 'efficient', label: 'Efficient Signal', detail: 'ROAS 与订单信号较强；本模块不生成调价动作', kind: 'good' };
    }
    if (group.spend > 0 && group.roas > 0 && group.roas < 1) {
      return { key: 'weak', label: 'Weak Efficiency', detail: '销售低于花费；本模块不生成降价动作', kind: 'bad' };
    }
    return { key: 'observe', label: 'Observe', detail: '继续积累证据；本模块只做 Query 情报', kind: 'neutral' };
  }

  async function refresh({ force = true } = {}) {
    ensureUi();
    const adapter = window.QueryNativeModuleData;
    if (typeof adapter?.ads !== 'function') {
      throw previewError(503, 'Query-native Adapter 尚未就绪，请先连接私有云');
    }
    const request = currentRequest();
    setState({ status: 'loading', source: 'query-tidb', request, lastError: '' });
    renderLoading();
    try {
      const payload = await adapter.ads({ ...request, source: 'query', maxRows: MAX_ROWS, force });
      const governance = validateGovernance(payload?.governance);
      const analysis = analyzeRows(payload?.rows, governance);
      setState({
        status: 'ready',
        source: 'query-tidb',
        request,
        governance,
        summary: analysis.summary,
        groups: analysis.groups,
        lastError: '',
        refreshedAt: Date.now(),
      });
      render();
      dispatch('lr:query-native-bid-intelligence-ready', snapshot());
      return snapshot();
    } catch (error) {
      setState({
        status: 'error',
        source: 'query-error',
        governance: null,
        summary: null,
        groups: [],
        lastError: text(error?.message || error),
        refreshedAt: Date.now(),
      });
      renderError();
      dispatch('lr:query-native-bid-intelligence-error', {
        version: PREVIEW_VERSION,
        message: state.lastError,
        status: Number(error?.status || 0),
      });
      throw error;
    }
  }

  function validateGovernance(governance) {
    if (!governance || governance.schemaVersion !== GOVERNANCE_VERSION) {
      throw previewError(502, 'Warehouse 广告治理契约缺失或版本不兼容');
    }
    if (!governance.readiness || typeof governance.readiness !== 'object') {
      throw previewError(502, 'Warehouse 广告治理 readiness 缺失');
    }
    return governance;
  }

  function setState(patch) {
    Object.assign(state, patch);
  }

  function snapshot() {
    return {
      version: PREVIEW_VERSION,
      status: state.status,
      source: state.source,
      request: state.request ? { ...state.request } : null,
      governance: state.governance,
      summary: state.summary ? { ...state.summary, blockers: [...(state.summary.blockers || [])] } : null,
      groups: state.groups.map(group => ({ ...group, signal: { ...group.signal } })),
      lastError: state.lastError,
      refreshedAt: state.refreshedAt,
      executionAuthorized: false,
    };
  }

  function ensureStyles() {
    if (byId('queryNativeBidIntelligenceStyles')) return;
    const style = document.createElement('style');
    style.id = 'queryNativeBidIntelligenceStyles';
    style.textContent = `
      #queryNativeBidIntelligence{display:grid;gap:8px;margin:9px 0 11px;padding:10px;border:1px solid color-mix(in srgb,var(--accent) 18%,var(--line));border-radius:13px;background:color-mix(in srgb,var(--accent) 3%,var(--card));min-width:0}
      #queryNativeBidIntelligence .qnbiHead{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;min-width:0}
      #queryNativeBidIntelligence .qnbiTitle{font-size:12px;font-weight:850;color:var(--text)}
      #queryNativeBidIntelligence .qnbiSub{margin-top:2px;font-size:9.8px;line-height:1.4;color:var(--muted)}
      #queryNativeBidIntelligence .qnbiBtn{padding:6px 10px!important;font-size:10.4px!important;white-space:nowrap}
      #queryNativeBidIntelligence .qnbiKpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:5px}
      #queryNativeBidIntelligence .qnbiKpi{padding:7px;border-radius:9px;background:var(--chip);min-width:0}
      #queryNativeBidIntelligence .qnbiKpi span{display:block;font-size:9px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #queryNativeBidIntelligence .qnbiKpi b{display:block;margin-top:2px;font-size:11px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #queryNativeBidIntelligence .qnbiGate{padding:7px 8px;border-radius:9px;background:var(--softWarn);color:var(--warn);font-size:9.6px;line-height:1.45;overflow-wrap:anywhere}
      #queryNativeBidIntelligence .qnbiGate[data-ready="1"]{background:var(--softGood);color:var(--good)}
      #queryNativeBidIntelligence .qnbiTableWrap{overflow:auto;max-height:300px;border:1px solid var(--line);border-radius:10px;background:var(--card)}
      #queryNativeBidIntelligence table{min-width:980px;width:100%;border-collapse:separate;border-spacing:0}
      #queryNativeBidIntelligence th,#queryNativeBidIntelligence td{padding:6px 7px;font-size:9.7px;border-bottom:1px solid var(--line);white-space:nowrap;text-align:left}
      #queryNativeBidIntelligence th{position:sticky;top:0;background:var(--th-bg);color:var(--muted);z-index:1}
      #queryNativeBidIntelligence .qnbiSignal{display:inline-flex;padding:2px 6px;border-radius:999px;background:var(--chip);color:var(--muted)}
      #queryNativeBidIntelligence .qnbiSignal[data-kind="good"]{background:var(--softGood);color:var(--good)}
      #queryNativeBidIntelligence .qnbiSignal[data-kind="warn"]{background:var(--softWarn);color:var(--warn)}
      #queryNativeBidIntelligence .qnbiSignal[data-kind="bad"]{background:var(--softBad);color:var(--bad)}
      #queryNativeBidIntelligence .qnbiState{font-size:9.7px;line-height:1.45;color:var(--muted)}
      @media(max-width:980px){#queryNativeBidIntelligence .qnbiKpis{grid-template-columns:repeat(3,minmax(0,1fr))}}
      @media(max-width:520px){#queryNativeBidIntelligence .qnbiHead{display:grid}#queryNativeBidIntelligence .qnbiKpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
    `;
    document.head.appendChild(style);
  }

  function ensureUi() {
    const table = byId('rankTable');
    if (!table) return false;
    const wrap = table.closest?.('.bidGovTableWrap') || table.parentElement;
    const host = wrap?.parentElement;
    if (!host) return false;
    ensureStyles();
    let root = byId('queryNativeBidIntelligence');
    if (!root) {
      root = document.createElement('section');
      root.id = 'queryNativeBidIntelligence';
      root.innerHTML = `
        <div class="qnbiHead">
          <div>
            <div class="qnbiTitle">Query-native Bid Intelligence · Preview</div>
            <div class="qnbiSub">直接读取 TiDB Query；不读取 AdsStore Raw，不生成 Suggested Bid，不生成 Bulk，不改变执行 Gate。</div>
          </div>
          <button class="btn qnbiBtn" id="btnQueryNativeBidPreviewRefresh" type="button">刷新 Query 情报</button>
        </div>
        <div class="qnbiKpis" id="queryNativeBidPreviewKpis" hidden></div>
        <div class="qnbiGate" id="queryNativeBidPreviewGate" data-ready="0">尚未读取 Warehouse governance。</div>
        <div class="qnbiTableWrap" id="queryNativeBidPreviewTableWrap" hidden>
          <table>
            <thead><tr><th>Target</th><th>Campaign / Ad Group</th><th>Spend</th><th>Sales</th><th>Orders</th><th>ACOS</th><th>ROAS</th><th>Current Bid</th><th>Bid Coverage</th><th>Signal</th></tr></thead>
            <tbody id="queryNativeBidPreviewBody"></tbody>
          </table>
        </div>
        <div class="qnbiState" id="queryNativeBidPreviewState">点击“刷新 Query 情报”后读取当前筛选范围。</div>
      `;
      host.insertBefore(root, wrap);
    }
    bindUi(root);
    return true;
  }

  function bindUi(root) {
    if (root.dataset.bound === '1') return;
    root.dataset.bound = '1';
    byId('btnQueryNativeBidPreviewRefresh')?.addEventListener('click', () => {
      refresh({ force: true }).catch(() => {});
    });
    FILTER_IDS.forEach(id => byId(id)?.addEventListener('change', markStale));
    byId('filterSearchTerm')?.addEventListener('input', markStale);
    window.addEventListener('lr:shop-change', markStale);
    window.addEventListener('lr:cloud-overview-ready', markStale);
  }

  function markStale() {
    if (state.status === 'idle') return;
    setState({ status: 'stale' });
    const status = byId('queryNativeBidPreviewState');
    if (status) status.textContent = '筛选或数据作用域已变化；请重新刷新 Query 情报。';
  }

  function renderLoading() {
    const button = byId('btnQueryNativeBidPreviewRefresh');
    if (button) {
      button.disabled = true;
      button.textContent = '读取 TiDB…';
    }
    const status = byId('queryNativeBidPreviewState');
    if (status) status.textContent = '正在读取当前筛选范围的 Query-native 广告数据…';
  }

  function render() {
    ensureUi();
    const button = byId('btnQueryNativeBidPreviewRefresh');
    if (button) {
      button.disabled = false;
      button.textContent = '刷新 Query 情报';
    }
    const summary = state.summary || {};
    const kpis = byId('queryNativeBidPreviewKpis');
    if (kpis) {
      kpis.hidden = false;
      const values = [
        ['Query Rows', Number(summary.rowCount || 0).toLocaleString('en-US')],
        ['Spend', fmtMoney(summary.spend)],
        ['Sales', fmtMoney(summary.sales)],
        ['ACOS', summary.acos === Infinity ? '∞' : fmtPct(summary.acos)],
        ['ROAS', fmtRatio(summary.roas)],
        ['Trusted Bid', fmtPct(summary.bidCoverage)],
      ];
      kpis.innerHTML = values.map(([label, value]) => `<div class="qnbiKpi"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join('');
    }
    const gate = byId('queryNativeBidPreviewGate');
    if (gate) {
      const ready = Boolean(summary.bidGovernanceReady);
      gate.dataset.ready = ready ? '1' : '0';
      gate.textContent = ready
        ? 'Warehouse Bid Governance readiness 已满足；本 Preview 仍为分析只读，不承担执行。'
        : `执行继续阻断：${(summary.blockers || []).join('；') || 'Warehouse readiness 未满足'}`;
    }
    const body = byId('queryNativeBidPreviewBody');
    const tableWrap = byId('queryNativeBidPreviewTableWrap');
    const groups = state.groups.slice(0, MAX_GROUPS);
    if (body && tableWrap) {
      tableWrap.hidden = groups.length === 0;
      body.innerHTML = groups.map(group => {
        const target = group.targeting || group.targetingId || '—';
        const route = [group.campaign, group.adGroup].filter(Boolean).join(' › ') || '—';
        const bid = group.latestBid === null ? '—' : fmtMoney(group.latestBid);
        return `<tr>
          <td title="${escapeHtml(target)}">${escapeHtml(target)}</td>
          <td title="${escapeHtml(route)}">${escapeHtml(route)}</td>
          <td>${escapeHtml(fmtMoney(group.spend))}</td>
          <td>${escapeHtml(fmtMoney(group.sales))}</td>
          <td>${Number(group.orders || 0).toLocaleString('en-US')}</td>
          <td>${group.acos === Infinity ? '∞' : escapeHtml(fmtPct(group.acos))}</td>
          <td>${escapeHtml(fmtRatio(group.roas))}</td>
          <td>${escapeHtml(bid)}</td>
          <td>${escapeHtml(fmtPct(group.bidCoverage))}</td>
          <td title="${escapeHtml(group.signal.detail)}"><span class="qnbiSignal" data-kind="${escapeHtml(group.signal.kind)}">${escapeHtml(group.signal.label)}</span></td>
        </tr>`;
      }).join('');
    }
    const status = byId('queryNativeBidPreviewState');
    if (status) {
      const filtered = Math.max(0, Number(summary.groupCount || 0) - groups.length);
      status.textContent = `来源：Query TiDB · ${Number(summary.groupCount || 0)} 个对象 · 当前显示 ${groups.length}${filtered ? `，另有 ${filtered} 个对象未展开` : ''} · 不产生任何执行动作。`;
    }
  }

  function renderError() {
    ensureUi();
    const button = byId('btnQueryNativeBidPreviewRefresh');
    if (button) {
      button.disabled = false;
      button.textContent = '刷新 Query 情报';
    }
    const gate = byId('queryNativeBidPreviewGate');
    if (gate) {
      gate.dataset.ready = '0';
      gate.textContent = 'Query 情报读取失败；执行 Gate 保持阻断。';
    }
    const kpis = byId('queryNativeBidPreviewKpis');
    if (kpis) kpis.hidden = true;
    const tableWrap = byId('queryNativeBidPreviewTableWrap');
    if (tableWrap) tableWrap.hidden = true;
    const status = byId('queryNativeBidPreviewState');
    if (status) status.textContent = state.lastError || 'Query 情报读取失败';
  }

  function previewError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
  }

  function dispatch(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function init() {
    if (ensureUi()) {
      dispatch('lr:query-native-bid-intelligence-mounted', { version: PREVIEW_VERSION });
      return;
    }
    const observer = new MutationObserver(() => {
      if (!ensureUi()) return;
      observer.disconnect();
      dispatch('lr:query-native-bid-intelligence-mounted', { version: PREVIEW_VERSION });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  window.QueryNativeBidIntelligence = Object.freeze({
    version: PREVIEW_VERSION,
    refresh,
    analyzeRows,
    governanceReasons,
    state: snapshot,
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
