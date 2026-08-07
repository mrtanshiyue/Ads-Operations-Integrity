(() => {
  'use strict';

  const GATE_VERSION = '1.0.0';
  const GOVERNANCE_VERSION = 'ads-query-governance-v2';
  const STALE_MS = 30000;
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
    window.addEventListener('lr:shop-change', () => clear('店铺作用域已变化，等待重新校验'));
    window.addEventListener('lr:cloud-overview-ready', () => clear('数据指纹可能变化，等待重新校验'));
    ['dateStart', 'dateEnd'].forEach(id => byId(id)?.addEventListener('change', () => clear('日期范围已变化，等待重新校验')));
    const observer = new MutationObserver(() => updateActionUi());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    updateActionUi();
    dispatch('lr:governance-gate-ready', {
      version: GATE_VERSION,
      governedActions: Object.keys(ACTIONS),
    });
  };

  window.QueryNativeGovernanceGate = Object.freeze({
    version: GATE_VERSION,
    refresh,
    assertActionAllowed,
    reasons: kind => [...reasonsForKind(kind === 'campaign' ? 'campaign' : 'bid')],
    state: statusSnapshot,
    governedActions: () => ({ ...ACTIONS }),
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();