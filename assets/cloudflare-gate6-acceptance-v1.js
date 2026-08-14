(function initCloudflareGate6Acceptance(global) {
  'use strict';

  const QUERY_FLAG = 'cf_gate6';
  const EXPECTED_USER_ID = 'user-dev-owner';
  const EXPECTED_STORE_CODE = 'DEV01';
  const RESULT_KEY = '__CF_GATE6_RESULT__';
  const EVENT_NAME = 'cf:gate6-acceptance';

  const api = global.CloudflareNativeAPI;
  const bridge = global.CloudflareNativeQueryBridge;
  const enabled = new URLSearchParams(global.location.search).get(QUERY_FLAG) === '1';

  async function runAcceptance() {
    const checks = [];
    const startedAt = new Date().toISOString();

    try {
      if (!api) throw new Error('native_api_unavailable');

      const health = await requestJson('/api/health');
      record(checks, 'environment_is_development', health?.environment === 'development', {
        environment: health?.environment || null,
      });
      if (health?.environment !== 'development') {
        throw new Error('gate6_acceptance_dev_only');
      }
      record(checks, 'sync_kill_switch_health', health?.syncTriggerEnabled === false);

      const session = await api.session();
      record(checks, 'session_authenticated', session?.authenticated === true);
      record(checks, 'session_provisioned', session?.provisioned === true);
      record(checks, 'owner_identity_mapping', session?.user?.userId === EXPECTED_USER_ID, {
        userId: session?.user?.userId || null,
      });
      record(checks, 'owner_role', Array.isArray(session?.globalRoles) && session.globalRoles.includes('owner'), {
        globalRoles: Array.isArray(session?.globalRoles) ? session.globalRoles : [],
      });

      const storesPayload = await api.stores();
      const stores = Array.isArray(storesPayload?.stores) ? storesPayload.stores : [];
      const store = stores.find((item) => (item.store_code || item.storeCode) === EXPECTED_STORE_CODE);
      record(checks, 'store_scope_dev01', Boolean(store), {
        storeCodes: stores.map((item) => item.store_code || item.storeCode).filter(Boolean),
      });
      if (!store) throw new Error('dev01_store_scope_missing');

      const storeId = store.store_id || store.storeId;
      const storeHealth = await requestJson(`/api/v1/stores/${encodeURIComponent(storeId)}/health`);
      record(checks, 'store_health', storeHealth?.health?.ok === true, {
        storeId,
        storeCode: storeHealth?.store?.storeCode || storeHealth?.store?.store_code || EXPECTED_STORE_CODE,
      });

      const capabilities = await api.capabilities();
      record(checks, 'capabilities_available', Boolean(capabilities && typeof capabilities === 'object'));
      record(checks, 'sync_kill_switch_capabilities', capabilities?.syncTriggerEnabled === false);

      const dataHealth = await api.analyticsDataHealth();
      record(checks, 'analytics_data_health', Array.isArray(dataHealth?.stores) && Array.isArray(dataHealth?.recentRollupFailures));

      let syncRejected = false;
      try {
        await api.startSync(storeId, {}, 'gate6-browser-disabled-sync-check');
      } catch (error) {
        syncRejected = error?.status === 503 && error?.code === 'sync_trigger_disabled';
      }
      record(checks, 'sync_post_rejected_by_kill_switch', syncRejected);

      record(checks, 'native_query_bridge', Boolean(bridge && bridge.source === 'query-cloudflare-d1'));
      record(checks, 'private_cloud_alias_native', global.PrivateCloudQuery === bridge);

      let transactionsNotMigrated = false;
      if (bridge?.allTransactions) {
        try {
          await bridge.allTransactions();
        } catch (error) {
          transactionsNotMigrated = error?.status === 501 && error?.code === 'cloudflare_transactions_not_migrated';
        }
      }
      record(checks, 'transactions_explicit_not_migrated', transactionsNotMigrated);

      const failed = checks.filter((check) => !check.ok);
      return finish({
        ok: failed.length === 0,
        startedAt,
        completedAt: new Date().toISOString(),
        environment: health?.environment || null,
        userId: session?.user?.userId || null,
        storeCode: EXPECTED_STORE_CODE,
        checks,
      });
    } catch (error) {
      return finish({
        ok: false,
        startedAt,
        completedAt: new Date().toISOString(),
        error: error?.code || error?.message || String(error),
        checks,
      });
    }
  }

  function finish(result) {
    global[RESULT_KEY] = result;
    global.document?.documentElement?.setAttribute?.('data-cf-gate6', result.ok ? 'pass' : 'fail');
    render(result);
    try {
      global.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: result }));
    } catch {}
    if (result.ok) console.info('[Cloudflare Gate 6] PASS', result);
    else console.error('[Cloudflare Gate 6] FAIL', result);
    return result;
  }

  function record(checks, name, ok, detail) {
    checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  }

  async function requestJson(path) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      const error = new Error(payload?.error || `http_${response.status}`);
      error.status = response.status;
      error.code = payload?.error || `http_${response.status}`;
      throw error;
    }
    return payload;
  }

  function render(result) {
    const document = global.document;
    if (!document?.body || !enabled) return;
    document.getElementById('cf-gate6-acceptance')?.remove();
    const panel = document.createElement('aside');
    panel.id = 'cf-gate6-acceptance';
    panel.setAttribute('role', 'status');
    panel.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'width:min(460px,calc(100vw - 32px))', 'max-height:70vh', 'overflow:auto',
      'padding:14px 16px', 'border:1px solid rgba(0,0,0,.14)', 'border-radius:12px',
      'background:#fff', 'color:#111827', 'box-shadow:0 12px 40px rgba(0,0,0,.18)',
      'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', 'text-align:left',
    ].join(';');
    const lines = [
      `Cloudflare Gate 6: ${result.ok ? 'PASS' : 'FAIL'}`,
      result.userId ? `User: ${result.userId}` : null,
      result.storeCode ? `Store: ${result.storeCode}` : null,
      result.error ? `Error: ${result.error}` : null,
      '',
      ...(result.checks || []).map((check) => `${check.ok ? 'PASS' : 'FAIL'}  ${check.name}`),
    ].filter((line) => line !== null);
    panel.textContent = lines.join('\n');
    document.body.appendChild(panel);
  }

  const control = {
    enabled,
    run: runAcceptance,
    pending: null,
  };
  Object.defineProperty(global, 'CloudflareGate6Acceptance', {
    value: control,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  if (enabled) control.pending = runAcceptance();
})(window);
