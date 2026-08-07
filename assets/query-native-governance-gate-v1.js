(() => {
  'use strict';

  const GATE_VERSION = '1.1.0';
  const GOVERNANCE_VERSION = 'ads-query-governance-v2';
  const STALE_MS = 30000;
  const PREFLIGHT_CARD_ID = 'adsSourcePreflightCard';
  const PREFLIGHT_FILE_MAX_BYTES = 25 * 1024 * 1024;
  const PREFLIGHT_MAX_SCAN_ROWS = 30;
  const PREFLIGHT_EXTENSIONS = /\.(csv|tsv|xlsx|xls|xlsb)$/i;
  const DIMENSION_LABELS = Object.freeze({
    reportDate: '日期',
    campaignId: 'Campaign ID',
    adGroupId: 'Ad Group ID',
    searchTerm: '搜索词',
    impressions: 'Impressions',
    clicks: 'Clicks',
    spend: 'Spend',
    orders: 'Orders',
    sales: 'Sales',
    targetingId: 'Targeting ID',
    targetBid: 'Bid',
    targetingType: 'Targeting Type',
    matchType: 'Match Type',
    adProduct: '广告产品类型',
    advertisedAsin: 'Advertised ASIN',
    advertisedSku: 'Advertised SKU',
    purchasedAsin: 'Purchased ASIN',
    purchasedSku: 'Purchased SKU',
    attributionWindowDays: '归因窗口',
    reportGranularity: '报表粒度',
    sourceFile: '源文件',
  });
  const ACTIONS = Object.freeze({
    btnAIBulk: 'bid',
    btnExportNeg: 'bid',
    btnActionSelectExecutable: 'bid',
    btnActionExportSelected: 'bid',
    btnExportActionBulk: 'bid',
    btnExportActionKeywordExact: 'bid',
    btnExportActionKeywordPhrase: 'bid',
    btnExportActionKeywordBroad: 'bid',
    btnCentralSelectReady: 'bid',
    btnCentralExport: 'bid',
    btnLtV5SelectReady: 'bid',
    btnLtV5ExportSelected: 'bid',
    btnCopyCampaignStudio: 'campaign',
    btnExportCampaignStudioBulk: 'campaign',
  });

  const state = {
    governance: null,
    requestSignature: '',
    source: 'none',
    status: 'unknown',
    lastError: '',
    lastCheckedAt: 0,
    bypassElement: null,
    preflightStatus: 'idle',
    preflightResult: null,
    preflightError: '',
  };

  const byId = id => document.getElementById(id);
  const text = value => String(value ?? '').trim();
  const normalizeScope = value => {
    const scope = text(value).toUpperCase();
    return ['ALL', 'YTDBNS', 'YY', 'JJ'].includes(scope) ? scope : 'ALL';
  };

  const currentRequest = () => ({
    scope: normalizeScope(window.ShopScope?.get?.() || window.ACTIVE_SHOP || 'ALL'),
    from: text(byId('dateStart')?.value),
    to: text(byId('dateEnd')?.value),
  });

  const requestSignature = request => JSON.stringify(request);

  const validateGovernance = governance => {
    if (!governance || typeof governance !== 'object') throw gateError('Warehouse 未返回广告治理契约');
    if (governance.schemaVersion !== GOVERNANCE_VERSION) {
      throw gateError(`广告治理契约版本不兼容：${text(governance.schemaVersion) || 'missing'}`);
    }
    if (!governance.readiness || typeof governance.readiness !== 'object') {
      throw gateError('广告治理 readiness 缺失');
    }
    return governance;
  };

  const bidReasons = governance => {
    if (!governance) return ['尚未取得 Warehouse source-proven governance'];
    const readiness = governance.readiness || {};
    const reasons = [];
    if (!readiness.targetingIdentityReady) reasons.push('Targeting identity 未验证');
    if (!readiness.bidSourceColumnReady) reasons.push('Bid 源列未验证');
    if (!readiness.bidValueNullabilityTrusted) reasons.push('Bid NULL/0 语义未验证');
    if (!readiness.adProductReady) reasons.push('广告产品类型源数据不可用');
    if (!readiness.advertisedProductIdentityReady) reasons.push('Advertised ASIN/SKU 源数据不可用');
    if (!readiness.attributionMaturityReady) reasons.push('归因窗口源数据不可用');
    return reasons;
  };

  const campaignReasons = governance => {
    if (!governance) return ['尚未取得 Warehouse source-proven governance'];
    const readiness = governance.readiness || {};
    const reasons = [];
    if (!readiness.targetingIdentityReady) reasons.push('Targeting identity 未验证');
    if (!readiness.adProductReady) reasons.push('广告产品类型源数据不可用');
    if (!readiness.advertisedProductIdentityReady) reasons.push('Advertised ASIN/SKU 源数据不可用');
    if (!readiness.attributionMaturityReady) reasons.push('归因窗口源数据不可用');
    return reasons;
  };

  const reasonsForKind = (kind, governance = state.governance) =>
    kind === 'campaign' ? campaignReasons(governance) : bidReasons(governance);

  const readinessForKind = (kind, governance = state.governance) => {
    const readiness = governance?.readiness || {};
    return kind === 'campaign'
      ? Boolean(readiness.campaignStudioReady)
      : Boolean(readiness.bidGovernanceReady);
  };

  const statusSnapshot = () => ({
    version: GATE_VERSION,
    governanceVersion: state.governance?.schemaVersion || '',
    source: state.source,
    status: state.status,
    requestSignature: state.requestSignature,
    lastError: state.lastError,
    lastCheckedAt: state.lastCheckedAt,
    bidGovernanceReady: readinessForKind('bid'),
    campaignStudioReady: readinessForKind('campaign'),
    bidReasons: reasonsForKind('bid'),
    campaignReasons: reasonsForKind('campaign'),
    governance: state.governance,
    preflightStatus: state.preflightStatus,
    preflightResult: state.preflightResult,
    preflightError: state.preflightError,
  });

  const refresh = async ({ force = false } = {}) => {
    const request = currentRequest();
    const signature = requestSignature(request);
    if (!force
      && state.governance
      && state.requestSignature === signature
      && Date.now() - state.lastCheckedAt < STALE_MS) {
      return statusSnapshot();
    }
    const client = window.PrivateCloudQuery;
    if (typeof client?.ads !== 'function') {
      state.governance = null;
      state.source = 'none';
      state.status = 'blocked';
      state.lastError = 'Query Client 尚未就绪';
      state.lastCheckedAt = Date.now();
      updateActionUi();
      throw gateError(state.lastError);
    }
    try {
      state.status = 'checking';
      updateActionUi();
      const payload = await client.ads({
        scope: request.scope,
        from: request.from,
        to: request.to,
        limit: 1,
        offset: 0,
      });
      state.governance = validateGovernance(payload?.governance);
      state.requestSignature = signature;
      state.source = 'query-tidb';
      state.status = readinessForKind('bid') && readinessForKind('campaign') ? 'ready' : 'blocked';
      state.lastError = '';
      state.lastCheckedAt = Date.now();
      updateActionUi();
      dispatch('lr:governance-gate-state', statusSnapshot());
      return statusSnapshot();
    } catch (error) {
      state.governance = null;
      state.requestSignature = signature;
      state.source = 'query-error';
      state.status = 'blocked';
      state.lastError = text(error?.message || error);
      state.lastCheckedAt = Date.now();
      updateActionUi();
      dispatch('lr:governance-gate-state', statusSnapshot());
      throw error;
    }
  };

  const assertActionAllowed = async actionId => {
    const kind = ACTIONS[actionId];
    if (!kind) return true;
    const snapshot = await refresh();
    if (readinessForKind(kind, snapshot.governance)) return true;
    const reasons = reasonsForKind(kind, snapshot.governance);
    throw gateError(`执行已阻断：${reasons.join('；') || '治理条件未满足'}`);
  };

  const handleGuardedClick = event => {
    const target = event.target?.closest?.('[id]');
    const actionId = target?.id || '';
    if (!ACTIONS[actionId] || state.bypassElement === target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    assertActionAllowed(actionId)
      .then(() => {
        state.bypassElement = target;
        try { target.click(); }
        finally { queueMicrotask(() => { if (state.bypassElement === target) state.bypassElement = null; }); }
      })
      .catch(error => showBlocked(actionId, text(error?.message || error)));
  };

  const blockedLabel = kind => kind === 'campaign' ? 'Campaign Studio 执行门禁' : '广告执行门禁';

  const showBlocked = (actionId, message) => {
    const kind = ACTIONS[actionId] || 'bid';
    const banner = ensureBanner();
    banner.dataset.kind = 'blocked';
    banner.innerHTML = `<b>${escapeHtml(blockedLabel(kind))}</b><span>${escapeHtml(message)}</span>`;
    banner.hidden = false;
    clearTimeout(showBlocked.timer);
    showBlocked.timer = setTimeout(() => { banner.hidden = true; }, 9000);
    dispatch('lr:governance-action-blocked', {
      actionId,
      kind,
      message,
      ...statusSnapshot(),
    });
  };

  const ensureBanner = () => {
    let banner = byId('queryNativeGovernanceGateBanner');
    if (banner) return banner;
    banner = document.createElement('div');
    banner.id = 'queryNativeGovernanceGateBanner';
    banner.hidden = true;
    banner.setAttribute('role', 'status');
    banner.style.cssText = [
      'position:fixed',
      'right:18px',
      'bottom:18px',
      'z-index:2147483000',
      'max-width:min(520px,calc(100vw - 36px))',
      'padding:12px 14px',
      'border:1px solid rgba(180,35,35,.32)',
      'border-radius:12px',
      'background:rgba(255,247,247,.98)',
      'box-shadow:0 12px 35px rgba(0,0,0,.18)',
      'color:#7f1d1d',
      'font:12px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'display:grid',
      'gap:4px',
    ].join(';');
    document.body.appendChild(banner);
    return banner;
  };

  const updateActionUi = () => {
    Object.entries(ACTIONS).forEach(([id, kind]) => {
      const element = byId(id);
      if (!element) return;
      const ready = readinessForKind(kind);
      const reasons = reasonsForKind(kind);
      element.dataset.governanceGate = ready ? 'ready' : state.status === 'checking' ? 'checking' : 'blocked';
      element.setAttribute('aria-disabled', ready ? 'false' : 'true');
      if (!ready) {
        element.title = `Source-proven execution gate: ${reasons.join('；') || state.lastError || '等待治理校验'}`;
        element.style.opacity = '0.62';
      } else {
        if (element.title.startsWith('Source-proven execution gate:')) element.title = '';
        element.style.opacity = '';
      }
    });
  };

  const ensurePreflightCard = () => {
    const panel = byId('privateCloudImportPanel');
    if (!panel || byId(PREFLIGHT_CARD_ID)) return Boolean(byId(PREFLIGHT_CARD_ID));
    const card = document.createElement('div');
    card.id = PREFLIGHT_CARD_ID;
    card.setAttribute('role', 'region');
    card.setAttribute('aria-label', '广告报表兼容性预检');
    card.style.cssText = [
      'display:grid',
      'gap:9px',
      'width:100%',
      'min-width:0',
      'padding:12px',
      'border:1px solid rgba(100,116,139,.22)',
      'border-radius:12px',
      'background:rgba(248,250,252,.84)',
      'box-sizing:border-box',
    ].join(';');
    card.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
        <div style="min-width:0;">
          <div style="font-weight:700;font-size:13px;color:#0f172a;">广告报表兼容性预检</div>
          <div style="margin-top:2px;font-size:11px;line-height:1.45;color:#64748b;">仅在浏览器本地读取表头；报表内容不会上传，也不会写入 Warehouse。</div>
        </div>
        <span style="flex:none;font-size:10px;font-weight:700;color:#475569;border:1px solid rgba(100,116,139,.22);border-radius:999px;padding:3px 7px;background:#fff;">READ ONLY</span>
      </div>
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;">
        <button id="btnAdsSourcePreflight" type="button" style="border:0;border-radius:9px;padding:8px 11px;background:#0f172a;color:#fff;font:600 12px/1 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;cursor:pointer;">选择广告报表预检</button>
        <input id="adsSourcePreflightFile" type="file" accept=".csv,.tsv,.xlsx,.xls,.xlsb" hidden>
        <span id="adsSourcePreflightStatus" style="font-size:11px;color:#64748b;">候选资格 ≠ 执行授权</span>
      </div>
      <pre id="adsSourcePreflightResult" hidden style="margin:0;padding:9px 10px;border-radius:9px;background:#fff;border:1px solid rgba(100,116,139,.18);white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.55 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#334155;"></pre>`;
    const statusRow = [...panel.children].find(child => child.matches?.('.cloudStatusRow')) || null;
    panel.insertBefore(card, statusRow);
    const button = byId('btnAdsSourcePreflight');
    const input = byId('adsSourcePreflightFile');
    button?.addEventListener('click', () => input?.click());
    input?.addEventListener('change', () => {
      const file = input.files?.[0] || null;
      input.value = '';
      if (file) runSourcePreflightFile(file).catch(error => renderPreflightError(error));
    });
    return true;
  };

  const runSourcePreflightFile = async file => {
    const status = byId('adsSourcePreflightStatus');
    const result = byId('adsSourcePreflightResult');
    state.preflightStatus = 'reading';
    state.preflightResult = null;
    state.preflightError = '';
    if (status) status.textContent = '正在本地读取表头…';
    if (result) result.hidden = true;
    const headers = await readCandidateHeaders(file);
    const client = window.PrivateCloudQuery;
    if (typeof client?.preflightAdsSource !== 'function') throw gateError('Query Client 预检能力尚未就绪');
    state.preflightStatus = 'checking';
    if (status) status.textContent = `已识别 ${headers.length} 列，正在校验治理契约…`;
    const payload = await client.preflightAdsSource(headers, { timeoutMs: 60000 });
    if (payload.activation?.authorizesExecution !== false) throw gateError('预检返回了非法执行授权');
    state.preflightStatus = 'ready';
    state.preflightResult = payload;
    state.preflightError = '';
    renderPreflightResult(file, payload);
    dispatch('lr:ads-source-preflight-ui-result', {
      schemaVersion: payload.schemaVersion || '',
      analysisReady: Boolean(payload.analysisReady),
      readiness: { ...(payload.readiness || {}) },
      missingForBidGovernance: [...(payload.missingForBidGovernance || [])],
      missingForCampaignStudio: [...(payload.missingForCampaignStudio || [])],
      executionAuthorized: false,
    });
    return payload;
  };

  const readCandidateHeaders = async file => {
    if (!file || typeof file.arrayBuffer !== 'function') throw gateError('请选择有效的本地报表文件');
    if (!PREFLIGHT_EXTENSIONS.test(text(file.name))) throw gateError('仅支持 CSV/TSV/XLSX/XLS/XLSB 广告报表');
    if (Number(file.size || 0) > PREFLIGHT_FILE_MAX_BYTES) throw gateError('预检文件超过 25 MB，请先导出更小的候选报表');
    const xlsx = window.XLSX;
    if (typeof xlsx?.read !== 'function' || typeof xlsx?.utils?.sheet_to_json !== 'function') {
      throw gateError('本地 Excel 解析器尚未就绪');
    }
    const bytes = await file.arrayBuffer();
    const workbook = xlsx.read(bytes, {
      type: 'array',
      dense: true,
      sheetRows: PREFLIGHT_MAX_SCAN_ROWS,
      cellDates: false,
    });
    const sheetName = workbook.SheetNames?.[0];
    const sheet = sheetName ? workbook.Sheets?.[sheetName] : null;
    if (!sheet) throw gateError('报表没有可读取的工作表');
    const rows = xlsx.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false,
    });
    return selectLikelyHeaderRow(rows);
  };

  const selectLikelyHeaderRow = rows => {
    let selected = [];
    let selectedCount = 0;
    (Array.isArray(rows) ? rows.slice(0, PREFLIGHT_MAX_SCAN_ROWS) : []).forEach(row => {
      if (!Array.isArray(row)) return;
      const headers = row.map(value => text(value).normalize('NFKC')).filter(Boolean);
      if (headers.length > selectedCount) {
        selected = headers;
        selectedCount = headers.length;
      }
    });
    if (selectedCount < 4) throw gateError('前 30 行未识别到有效广告报表表头');
    return selected;
  };

  const renderPreflightResult = (file, payload) => {
    const status = byId('adsSourcePreflightStatus');
    const result = byId('adsSourcePreflightResult');
    const readiness = payload?.readiness || {};
    const bidMissing = friendlyDimensions(payload?.missingForBidGovernance);
    const campaignMissing = friendlyDimensions(payload?.missingForCampaignStudio);
    if (status) status.textContent = '预检完成 · 仅候选评估，不改变生产执行权限';
    if (!result) return;
    result.textContent = [
      `本地文件：${text(file?.name) || '未命名文件'}`,
      `识别表头：${Number(payload?.headerCount || 0)} 列`,
      `Query 分析候选：${yesNo(readiness.queryAnalysisCandidate)}`,
      `Bid Governance 候选：${yesNo(readiness.bidGovernanceCandidate)}`,
      `Campaign Studio 候选：${yesNo(readiness.campaignStudioCandidate)}`,
      `Bid 缺失维度：${bidMissing || '无'}`,
      `Campaign 缺失维度：${campaignMissing || '无'}`,
      '执行授权：否（Preflight 永不授权执行）',
      '数据写入：否 · Current Slot 变更：否 · 完整报表上传：否',
    ].join('\n');
    result.hidden = false;
  };

  const renderPreflightError = error => {
    state.preflightStatus = 'error';
    state.preflightResult = null;
    state.preflightError = text(error?.message || error);
    const status = byId('adsSourcePreflightStatus');
    const result = byId('adsSourcePreflightResult');
    if (status) status.textContent = `预检失败：${state.preflightError || '未知错误'}`;
    if (result) {
      result.textContent = '未写入 Warehouse；未改变 Current Slot；未开放任何执行权限。';
      result.hidden = false;
    }
  };

  const friendlyDimensions = values => (Array.isArray(values) ? values : [])
    .map(value => DIMENSION_LABELS[value] || text(value))
    .filter(Boolean)
    .join('、');

  const yesNo = value => value ? '是' : '否';

  const adoptGovernance = governance => {
    try {
      state.governance = validateGovernance(governance);
      state.requestSignature = requestSignature(currentRequest());
      state.source = 'query-tidb';
      state.status = readinessForKind('bid') && readinessForKind('campaign') ? 'ready' : 'blocked';
      state.lastError = '';
      state.lastCheckedAt = Date.now();
      updateActionUi();
      dispatch('lr:governance-gate-state', statusSnapshot());
      return true;
    } catch (_) {
      return false;
    }
  };

  const clear = reason => {
    state.governance = null;
    state.requestSignature = '';
    state.source = 'none';
    state.status = 'unknown';
    state.lastError = text(reason);
    state.lastCheckedAt = 0;
    updateActionUi();
  };

  function gateError(message) {
    const error = new Error(message);
    error.status = 409;
    return error;
  }

  function escapeHtml(value) {
    return text(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function dispatch(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  const init = () => {
    document.addEventListener('click', handleGuardedClick, true);
    window.addEventListener('lr:module-data-ready', event => {
      if (event.detail?.module === 'ads' && event.detail?.governance) adoptGovernance(event.detail.governance);
    });
    window.addEventListener('lr:query-client-ready', () => ensurePreflightCard());
    window.addEventListener('lr:shop-change', () => clear('店铺作用域已变化，等待重新校验'));
    window.addEventListener('lr:cloud-overview-ready', () => clear('数据指纹可能变化，等待重新校验'));
    ['dateStart', 'dateEnd'].forEach(id => byId(id)?.addEventListener('change', () => clear('日期范围已变化，等待重新校验')));
    const observer = new MutationObserver(() => {
      updateActionUi();
      ensurePreflightCard();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    updateActionUi();
    ensurePreflightCard();
    dispatch('lr:governance-gate-ready', {
      version: GATE_VERSION,
      governedActions: Object.keys(ACTIONS),
      sourcePreflightUi: true,
    });
  };

  window.QueryNativeGovernanceGate = Object.freeze({
    version: GATE_VERSION,
    refresh,
    assertActionAllowed,
    reasons: kind => [...reasonsForKind(kind === 'campaign' ? 'campaign' : 'bid')],
    state: statusSnapshot,
    governedActions: () => ({ ...ACTIONS }),
    mountSourcePreflight: ensurePreflightCard,
    selectLikelyHeaderRow,
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();