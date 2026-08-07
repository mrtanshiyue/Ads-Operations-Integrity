(() => {
  'use strict';

  const CONTROLLER_VERSION = '1.0.0';
  const DEFAULT_ATTRIBUTION_DAYS = 7;
  const DAY_MS = 86400000;
  let chart = null;
  let generation = 0;
  let sourceMode = 'query';
  let scheduled = 0;
  let lastResult = null;

  const byId = id => document.getElementById(id);
  const number = value => {
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const text = value => String(value || '').trim();
  const lower = value => text(value).toLowerCase();
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
  const formatMoney = value => Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const formatInteger = value => Math.round(number(value)).toLocaleString('zh-CN');
  const formatPercent = value => Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(2)}%` : '—';
  const currentScope = () => String(
    window.ShopScope?.get?.() || window.ACTIVE_SHOP || 'ALL',
  ).trim().toUpperCase();

  const currentMode = () => {
    const button = document.querySelector('[data-exec-trend-mode].active');
    const mode = lower(button?.dataset?.execTrendMode || 'efficiency');
    return ['efficiency', 'conversion', 'business'].includes(mode) ? mode : 'efficiency';
  };

  const normalizedGrain = () => {
    const selected = lower(byId('execGranularity')?.value || 'auto');
    if (['day', 'week', 'month'].includes(selected)) return selected;
    const from = parseDate(byId('dateStart')?.value);
    const to = parseDate(byId('dateEnd')?.value);
    if (!from || !to) return 'month';
    const days = Math.max(1, Math.round((to - from) / DAY_MS) + 1);
    return days <= 62 ? 'day' : days <= 240 ? 'week' : 'month';
  };

  const selectedFilters = () => ({
    scope: currentScope(),
    from: text(byId('dateStart')?.value),
    to: text(byId('dateEnd')?.value),
    sourceFile: text(byId('filterSource')?.value),
    portfolio: text(byId('filterPortfolio')?.value),
    campaign: text(byId('filterCampaign')?.value),
    adGroup: text(byId('filterAdGroup')?.value),
    targeting: text(byId('filterTargeting')?.value),
    matchType: text(byId('filterMatchType')?.value),
    adType: text(byId('filterAdType')?.value),
    adProduct: text(byId('filterAdProduct')?.value).toUpperCase(),
    search: text(byId('filterSearchTerm')?.value),
    searchExact: Boolean(byId('filterSearchExact')?.checked),
    grain: normalizedGrain(),
  });

  const hasDetailFilters = filters => Boolean(
    filters.sourceFile
    || filters.portfolio
    || filters.campaign
    || filters.adGroup
    || filters.targeting
    || filters.matchType
    || filters.adType
    || filters.adProduct
    || filters.search,
  );

  const queryUnsupportedReason = filters => {
    if (filters.sourceFile) return '当前 Query 分析表尚未保留来源文件维度，请清空“来源文件”筛选或使用显式 Raw 兼容模式。';
    if (filters.adProduct && filters.adProduct !== 'SP') return '当前 Warehouse 广告 Query 仅能可靠识别 Sponsored Products；其他广告类型仍需 Raw 明细。';
    return '';
  };

  const numericInput = (id, fallback, minimum = -Infinity, maximum = Infinity) => {
    const value = Number(byId(id)?.value);
    return Number.isFinite(value) ? clamp(value, minimum, maximum) : fallback;
  };

  const economicsConfig = () => ({
    cogsRate: numericInput('bizMargin', 0.30, 0, 1),
    referralFeeRate: numericInput('bizRef', 0.15, 0, 1),
    otherCostRate: numericInput('bizOtherCost', 0, 0, 1),
    promoRate: numericInput('bizPromoRate', 0.03, 0, 1),
    returnRate: numericInput('bizReturnRate', 0.08, 0, 1),
    returnLossRate: numericInput('bizReturnLossRate', 0.35, 0, 1),
    targetProfitRate: numericInput('bizTargetProfit', 0.10, 0, 1),
    fbaPerUnit: numericInput('bizFba', 4.5, 0, 1000),
    inboundPerUnit: numericInput('bizInboundPerUnit', 0.35, 0, 1000),
    storagePerUnit: numericInput('bizStoragePerUnit', 0.10, 0, 1000),
    unitsPerOrder: numericInput('bizUnitsPerOrder', 1.10, 0.1, 20),
    attributionBufferDays: Math.floor(numericInput('attributionBufferDays', 2, 0, 14)),
  });

  const parseDate = value => {
    const input = text(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
    const date = new Date(`${input}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  };

  const periodKey = (value, grain) => {
    const date = parseDate(value);
    if (!date) return text(value) || 'UNKNOWN';
    if (grain === 'month') return date.toISOString().slice(0, 7);
    if (grain === 'week') {
      const weekday = (date.getUTCDay() + 6) % 7;
      date.setUTCDate(date.getUTCDate() - weekday);
      return `${date.toISOString().slice(0, 10)} 周`;
    }
    return date.toISOString().slice(0, 10);
  };

  const isMature = (dateValue, attributionDays, bufferDays) => {
    const date = parseDate(dateValue);
    if (!date) return false;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const age = Math.floor((today.getTime() - date.getTime()) / DAY_MS);
    return age >= Math.max(1, number(attributionDays) || DEFAULT_ATTRIBUTION_DAYS) + bufferDays;
  };

  const emptyPeriod = label => ({
    label,
    impressions: 0,
    clicks: 0,
    spend: 0,
    pendingSpend: 0,
    sales: 0,
    orders: 0,
    units: 0,
    transactionSales: 0,
    transactionAvailable: false,
  });

  const ensurePeriod = (map, key) => {
    if (!map.has(key)) map.set(key, emptyPeriod(key));
    return map.get(key);
  };

  const estimateEconomics = (period, config) => {
    const units = period.units > 0 ? period.units : period.orders * config.unitsPerOrder;
    const variableRate = clamp(
      config.cogsRate
      + config.referralFeeRate
      + config.otherCostRate
      + config.promoRate
      + config.returnRate * config.returnLossRate,
      0,
      1.5,
    );
    const fixedPerUnit = config.fbaPerUnit + config.inboundPerUnit + config.storagePerUnit;
    const contributionProfit = period.sales * (1 - variableRate) - units * fixedPerUnit - period.spend;
    const aov = period.orders > 0 ? period.sales / period.orders : 0;
    const fixedRate = aov > 0 ? fixedPerUnit * config.unitsPerOrder / aov : null;
    const breakEvenAcos = fixedRate === null ? null : 1 - variableRate - fixedRate;
    const targetAcos = breakEvenAcos !== null && breakEvenAcos > config.targetProfitRate
      ? clamp(breakEvenAcos - config.targetProfitRate, 0.005, 0.95)
      : null;
    return {
      ...period,
      units,
      contributionProfit,
      targetAcos,
      ctr: period.impressions > 0 ? period.clicks / period.impressions : 0,
      cvr: period.clicks > 0 ? period.orders / period.clicks : 0,
      acos: period.sales > 0 ? period.spend / period.sales : (period.spend > 0 ? Infinity : 0),
      roas: period.spend > 0 ? period.sales / period.spend : 0,
    };
  };

  const aggregateAds = (rows, grain, config) => {
    const map = new Map();
    for (const row of rows || []) {
      const key = periodKey(row.date, grain);
      const period = ensurePeriod(map, key);
      period.impressions += number(row.impressions ?? row.impr);
      period.clicks += number(row.clicks);
      const mature = isMature(
        row.date,
        row.attributionWindowDays || DEFAULT_ATTRIBUTION_DAYS,
        config.attributionBufferDays,
      );
      if (mature) {
        period.spend += number(row.spend);
        period.sales += number(row.sales);
        period.orders += number(row.orders);
        period.units += number(row.units);
      } else {
        period.pendingSpend += number(row.spend);
      }
    }
    return [...map.values()]
      .sort((left, right) => left.label.localeCompare(right.label))
      .map(period => estimateEconomics(period, config));
  };

  const aggregateOverview = (series, grain, config) => {
    const map = new Map();
    for (const row of series || []) {
      const date = text(row.period);
      const key = periodKey(date, grain);
      const period = ensurePeriod(map, key);
      period.impressions += number(row.impressions);
      period.clicks += number(row.clicks);
      const mature = isMature(date, DEFAULT_ATTRIBUTION_DAYS, config.attributionBufferDays);
      if (mature) {
        period.spend += number(row.adSpend);
        period.sales += number(row.adSales);
        period.orders += number(row.adOrders);
        period.units += number(row.adUnits);
      } else {
        period.pendingSpend += number(row.adSpend);
      }
      if (row.netProductSales !== null && row.netProductSales !== undefined) {
        period.transactionSales += number(row.netProductSales);
        period.transactionAvailable = true;
      }
    }
    return [...map.values()]
      .sort((left, right) => left.label.localeCompare(right.label))
      .map(period => estimateEconomics(period, config));
  };

  const ensureControls = () => {
    let controls = byId('queryNativeTrendControls');
    if (controls) return controls;
    controls = document.createElement('div');
    controls.id = 'queryNativeTrendControls';
    controls.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:6px';
    const legend = byId('execTrendLegend');
    if (legend?.parentElement) legend.insertAdjacentElement('afterend', controls);
    return controls;
  };

  const buttonHtml = (id, label, primary = false) =>
    `<button class="btn${primary ? ' primary' : ''}" id="${id}" type="button" style="padding:5px 9px;font-size:10.5px">${label}</button>`;

  const renderControls = ({ loading = false, error = '', source = sourceMode } = {}) => {
    const controls = ensureControls();
    if (!controls) return;
    const label = source === 'raw' ? 'RAW COMPAT · 浏览器内存' : 'QUERY · TiDB';
    const parts = [`<span class="pill">${label}</span>`];
    if (loading) parts.push('<span class="pill">读取中…</span>');
    else if (error && source === 'query') parts.push(buttonHtml('btnQueryTrendUseRaw', '使用已导入 Raw 数据', true));
    else if (source === 'raw') parts.push(buttonHtml('btnQueryTrendUseQuery', '切回 Query', true));
    parts.push(buttonHtml('btnQueryTrendRefresh', '刷新'));
    controls.innerHTML = parts.join('');
    byId('btnQueryTrendRefresh')?.addEventListener('click', () => render({ force: true, reason: 'manual-refresh' }));
    byId('btnQueryTrendUseRaw')?.addEventListener('click', () => {
      sourceMode = 'raw';
      render({ force: true, reason: 'explicit-raw' });
    });
    byId('btnQueryTrendUseQuery')?.addEventListener('click', () => {
      sourceMode = 'query';
      render({ force: true, reason: 'return-query' });
    });
  };

  const setTrendCopy = (title, subtitle, legend = []) => {
    if (byId('execTrendTitle')) byId('execTrendTitle').textContent = title;
    if (byId('execTrendSubtitle')) byId('execTrendSubtitle').textContent = subtitle;
    if (byId('execTrendLegend')) {
      byId('execTrendLegend').innerHTML = legend.map(item => `<span class="pill">${item}</span>`).join('');
    }
  };

  const destroyHostChart = () => {
    try {
      if (typeof trendChart !== 'undefined' && trendChart) {
        trendChart.destroy();
        trendChart = null;
      }
    } catch (_) {}
  };

  const destroyOwnChart = () => {
    try { chart?.destroy?.(); } catch (_) {}
    chart = null;
  };

  const chartTheme = () => {
    const style = getComputedStyle(document.documentElement);
    return {
      text: style.getPropertyValue('--text').trim() || '#1d1d1f',
      muted: style.getPropertyValue('--muted').trim() || '#6e6e73',
      grid: style.getPropertyValue('--chart-grid').trim() || 'rgba(0,0,0,.08)',
      accent: style.getPropertyValue('--accent').trim() || '#2563eb',
      good: style.getPropertyValue('--good').trim() || '#16a34a',
      bad: style.getPropertyValue('--bad').trim() || '#dc2626',
      warn: style.getPropertyValue('--warn').trim() || '#d97706',
    };
  };

  const buildDatasets = (series, mode, theme) => {
    if (mode === 'conversion') {
      return [
        { type: 'line', label: 'CTR %', data: series.map(row => row.ctr * 100), borderColor: theme.accent, tension: 0.28, pointRadius: 1.5, yAxisID: 'y' },
        { type: 'line', label: 'CVR %', data: series.map(row => row.cvr * 100), borderColor: theme.good, tension: 0.28, pointRadius: 1.5, yAxisID: 'y' },
        { type: 'bar', label: 'Clicks', data: series.map(row => row.clicks), backgroundColor: `${theme.accent}44`, borderRadius: 3, yAxisID: 'y1' },
        { type: 'bar', label: 'Orders', data: series.map(row => row.orders), backgroundColor: `${theme.good}66`, borderRadius: 3, yAxisID: 'y1' },
      ];
    }
    if (mode === 'business') {
      const datasets = [
        { type: 'bar', label: 'Ad Sales', data: series.map(row => row.sales), backgroundColor: `${theme.accent}88`, borderRadius: 3, yAxisID: 'y' },
        { type: 'bar', label: 'Mature Spend', data: series.map(row => row.spend), backgroundColor: `${theme.bad}66`, borderRadius: 3, yAxisID: 'y' },
        { type: 'bar', label: 'Pending Spend', data: series.map(row => row.pendingSpend), backgroundColor: `${theme.muted}44`, borderRadius: 3, yAxisID: 'y' },
        { type: 'line', label: 'Base Contribution Estimate', data: series.map(row => row.contributionProfit), borderColor: theme.good, tension: 0.28, pointRadius: 1.5, yAxisID: 'y' },
      ];
      if (series.some(row => row.transactionAvailable)) {
        datasets.push({
          type: 'line',
          label: 'Net Product Sales',
          data: series.map(row => row.transactionAvailable ? row.transactionSales : null),
          borderColor: theme.warn,
          borderWidth: 2.2,
          tension: 0.25,
          pointRadius: 1.5,
          spanGaps: true,
          yAxisID: 'y',
        });
      }
      return datasets;
    }
    return [
      { type: 'line', label: 'ACOS %', data: series.map(row => row.acos === Infinity ? null : row.acos * 100), borderColor: theme.bad, tension: 0.28, pointRadius: 1.5, yAxisID: 'y' },
      { type: 'line', label: 'Target ACOS %', data: series.map(row => row.targetAcos === null ? null : row.targetAcos * 100), borderColor: theme.warn, borderDash: [5, 5], tension: 0, pointRadius: 0, yAxisID: 'y' },
      { type: 'line', label: 'ROAS', data: series.map(row => row.roas), borderColor: theme.accent, tension: 0.28, pointRadius: 1.5, yAxisID: 'y1' },
    ];
  };

  const chartOptions = (mode, theme) => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: context => {
            const label = context.dataset.label || '';
            const raw = number(context.raw);
            if (/%/.test(label)) return `${label}: ${raw.toFixed(2)}%`;
            if (label === 'ROAS') return `${label}: ${raw.toFixed(2)}`;
            if (label === 'Clicks' || label === 'Orders') return `${label}: ${formatInteger(raw)}`;
            return `${label}: ${formatMoney(raw)}`;
          },
        },
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: theme.muted, maxRotation: 0, maxTicksLimit: 12 } },
      y: {
        grid: { color: theme.grid },
        ticks: {
          color: theme.muted,
          callback: value => mode === 'efficiency' || mode === 'conversion' ? `${value}%` : formatMoney(value),
        },
      },
      y1: {
        display: mode !== 'business',
        position: 'right',
        grid: { drawOnChartArea: false },
        ticks: {
          color: theme.muted,
          callback: value => mode === 'conversion' ? formatInteger(value) : number(value).toFixed(2),
        },
      },
    },
  });

  const renderChart = (series, metadata) => {
    destroyHostChart();
    destroyOwnChart();
    const canvas = byId('trendChart');
    if (!canvas || !window.Chart) return;
    const mode = currentMode();
    const theme = chartTheme();
    const datasets = buildDatasets(series, mode, theme);
    const titles = {
      efficiency: 'Query-native 效率趋势',
      conversion: 'Query-native 转化趋势',
      business: 'Query-native 经营趋势',
    };
    const scopeLabel = metadata.accountLevel ? '账户范围' : '当前广告筛选范围';
    const sourceLabel = metadata.source === 'raw-compat' ? 'Raw 兼容' : 'TiDB Query';
    const warning = mode === 'business'
      ? '基础贡献为当前手工成本参数估算；不会静默混入 Raw 业务、交易或商品成本库。'
      : '归因成熟度按 SP 7 天窗口与当前缓冲天数计算。';
    setTrendCopy(
      titles[mode],
      `${sourceLabel} · ${scopeLabel} · ${metadata.grain.toUpperCase()} · ${warning}`,
      datasets.map(dataset => dataset.label),
    );
    chart = new Chart(canvas.getContext('2d'), {
      data: { labels: series.map(row => row.label), datasets },
      options: chartOptions(mode, theme),
    });
  };

  const loadQueryData = async (filters, force) => {
    const adapter = window.QueryNativeModuleData;
    if (typeof adapter?.ads !== 'function' || typeof adapter?.overview !== 'function') {
      throw new Error('Query-native 广告适配器尚未就绪，请刷新页面后重试。');
    }
    const unsupported = queryUnsupportedReason(filters);
    if (unsupported) {
      const error = new Error(unsupported);
      error.status = 409;
      throw error;
    }
    const accountLevel = !hasDetailFilters(filters);
    if (accountLevel) {
      const payload = await adapter.overview({
        scope: filters.scope,
        from: filters.from,
        to: filters.to,
        grain: 'day',
        force,
      });
      return {
        source: payload.source || 'query-tidb',
        accountLevel: true,
        series: aggregateOverview(payload.series, filters.grain, economicsConfig()),
      };
    }
    const payload = await adapter.ads({
      ...filters,
      source: 'query',
      force,
      maxRows: 300000,
    });
    return {
      source: payload.source || 'query-tidb',
      accountLevel: false,
      series: aggregateAds(payload.rows, filters.grain, economicsConfig()),
      truncated: Boolean(payload.truncated),
    };
  };

  const loadRawData = async (filters, force) => {
    const adapter = window.QueryNativeModuleData;
    if (typeof adapter?.ads !== 'function') throw new Error('Query-native 广告适配器尚未就绪。');
    const payload = await adapter.ads({
      ...filters,
      source: 'raw',
      force,
      maxRows: 300000,
    });
    return {
      source: payload.source || 'raw-compat',
      accountLevel: !hasDetailFilters(filters),
      series: aggregateAds(payload.rows, filters.grain, economicsConfig()),
      truncated: false,
    };
  };

  async function render({ force = false, reason = 'host' } = {}) {
    const details = byId('execTrendDetails');
    if (details && !details.open && reason !== 'init') return lastResult;
    const token = ++generation;
    const filters = selectedFilters();
    renderControls({ loading: true, source: sourceMode });
    setTrendCopy('Query-native 趋势', '正在按当前店铺、日期与筛选条件读取 TiDB Query 数据…', []);
    try {
      const result = sourceMode === 'raw'
        ? await loadRawData(filters, force)
        : await loadQueryData(filters, force);
      if (token !== generation) return null;
      lastResult = { ...result, filters, reason, loadedAt: new Date().toISOString() };
      if (!result.series.length) {
        destroyHostChart();
        destroyOwnChart();
        setTrendCopy('Query-native 趋势', '当前 Query 范围没有广告数据，请调整日期或筛选条件。', []);
      } else {
        renderChart(result.series, {
          ...result,
          grain: filters.grain,
        });
      }
      renderControls({ source: sourceMode });
      window.dispatchEvent(new CustomEvent('lr:query-native-trend-ready', {
        detail: {
          version: CONTROLLER_VERSION,
          source: result.source,
          count: result.series.length,
          accountLevel: result.accountLevel,
          grain: filters.grain,
        },
      }));
      return lastResult;
    } catch (error) {
      if (token !== generation) return null;
      destroyHostChart();
      destroyOwnChart();
      const message = text(error?.message || error);
      setTrendCopy(
        sourceMode === 'query' ? 'Query-native 趋势读取失败' : 'Raw 兼容趋势不可用',
        message,
        [],
      );
      renderControls({ error: message, source: sourceMode });
      window.dispatchEvent(new CustomEvent('lr:query-native-trend-error', {
        detail: {
          version: CONTROLLER_VERSION,
          source: sourceMode,
          message,
          status: number(error?.status),
        },
      }));
      return null;
    }
  }

  const schedule = (reason, force = false) => {
    clearTimeout(scheduled);
    scheduled = setTimeout(() => render({ force, reason }), 180);
  };

  const bind = () => {
    ensureControls();
    const changeIds = [
      'dateStart', 'dateEnd', 'filterSource', 'filterPortfolio', 'filterCampaign',
      'filterAdGroup', 'filterTargeting', 'filterMatchType', 'filterAdType',
      'filterAdProduct', 'filterSearchExact', 'execGranularity',
      'bizMargin', 'bizRef', 'bizOtherCost', 'bizPromoRate', 'bizReturnRate',
      'bizReturnLossRate', 'bizTargetProfit', 'bizFba', 'bizInboundPerUnit',
      'bizStoragePerUnit', 'bizUnitsPerOrder', 'attributionBufferDays',
    ];
    changeIds.forEach(id => byId(id)?.addEventListener('change', () => schedule(`change:${id}`)));
    byId('filterSearchTerm')?.addEventListener('input', () => schedule('search-input'));
    document.querySelectorAll('[data-exec-trend-mode]').forEach(button => {
      button.addEventListener('click', () => schedule('trend-mode'));
    });
    byId('execTrendDetails')?.addEventListener('toggle', () => {
      if (byId('execTrendDetails')?.open) schedule('trend-open', true);
    });
    window.addEventListener('lr:shop-change', () => schedule('shop-change', true));
    window.addEventListener('lr:query-client-ready', () => schedule('query-client-ready', true));
    window.addEventListener('lr:cloud-overview-ready', () => schedule('cloud-overview-ready', true));
    window.addEventListener('resize', () => chart?.resize?.(), { passive: true });
  };

  const init = () => {
    bind();
    destroyHostChart();
    renderControls({ source: sourceMode });
    if (byId('execTrendDetails')?.open) schedule('init', true);
  };

  window.QueryNativeAdsTrend = Object.freeze({
    version: CONTROLLER_VERSION,
    ownsTrend: () => true,
    render,
    renderFromHost: () => render({ reason: 'host-render' }),
    useQuery: () => {
      sourceMode = 'query';
      return render({ force: true, reason: 'api-query' });
    },
    useRawCompatibility: () => {
      sourceMode = 'raw';
      return render({ force: true, reason: 'api-raw' });
    },
    source: () => sourceMode,
    state: () => ({
      version: CONTROLLER_VERSION,
      sourceMode,
      generation,
      hasChart: Boolean(chart),
      lastResult,
    }),
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
