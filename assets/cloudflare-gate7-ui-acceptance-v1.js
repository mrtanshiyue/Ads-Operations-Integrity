(function initCloudflareGate7Acceptance(global) {
  'use strict';

  const QUERY_FLAG = 'cf_gate7';
  const EXPECTED_USER_ID = 'user-dev-owner';
  const EXPECTED_STORE_CODE = 'DEV01';
  const QUERY_FROM = '2026-08-11';
  const QUERY_TO = '2026-08-12';
  const RETIRED_BACKEND_HOST = 'amazon-warehouse-cloud-v4.tanshiyuesir.workers.dev';
  const RESULT_KEY = '__CF_GATE7_RESULT__';
  const EVENT_NAME = 'cf:gate7-ui-acceptance';
  const NAV_TARGETS = [
    'overviewSection',
    'growthCommandSection',
    'multiDimCard',
    'rankGovernanceCard',
    'rootMatrixCard',
    'businessReportCard',
    'transactionReportCard',
  ];
  const LOCAL_WORKFLOW_CONTROLS = [
    'fileInput',
    'mergeMode',
    'dedupeMode',
    'dateStart',
    'dateEnd',
    'filterSearchTerm',
  ];

  const api = global.CloudflareNativeAPI;
  const bridge = global.CloudflareNativeQueryBridge;
  const enabled = new URLSearchParams(global.location.search).get(QUERY_FLAG) === '1';

  async function runAcceptance() {
    const checks = [];
    const startedAt = new Date().toISOString();

    try {
      if (!api) throw new Error('native_api_unavailable');
      if (!bridge) throw new Error('native_query_bridge_unavailable');

      const health = await requestJson('/api/health');
      record(checks, 'environment_is_development', health?.environment === 'development', {
        environment: health?.environment || null,
      });
      if (health?.environment !== 'development') throw new Error('gate7_acceptance_dev_only');
      record(checks, 'sync_kill_switch_health', health?.syncTriggerEnabled === false);

      const session = await api.session();
      record(checks, 'session_authenticated', session?.authenticated === true);
      record(checks, 'session_provisioned', session?.provisioned === true);
      record(checks, 'owner_identity_mapping', session?.user?.userId === EXPECTED_USER_ID, {
        userId: session?.user?.userId || null,
      });

      const document = global.document;
      record(checks, 'workspace_shell_present', Boolean(
        document?.querySelector?.('.app')
        && document?.querySelector?.('.sidebar')
        && document?.querySelector?.('.content')
      ));
      record(checks, 'workspace_layout_version', document?.body?.classList?.contains?.('final-workspace-v60') === true);

      const navLinks = Array.from(document?.querySelectorAll?.('.sidebarNav a') || []);
      const hrefs = navLinks.map((link) => String(link.getAttribute?.('href') || ''));
      const expectedHrefs = NAV_TARGETS.map((target) => `#${target}`);
      record(checks, 'sidebar_navigation_contract', sameArray(hrefs, expectedHrefs), { hrefs });
      record(checks, 'sidebar_navigation_targets_resolve', NAV_TARGETS.every((target) => Boolean(document?.getElementById?.(target))));
      record(checks, 'local_raw_workflow_controls_present', LOCAL_WORKFLOW_CONTROLS.every((id) => Boolean(document?.getElementById?.(id))));

      const cspMeta = document?.querySelector?.('meta[http-equiv="Content-Security-Policy"]');
      const csp = String(cspMeta?.getAttribute?.('content') || '');
      record(checks, 'same_origin_connect_policy', /connect-src\s+'self';/i.test(csp));

      record(checks, 'native_query_bridge', bridge.source === 'query-cloudflare-d1');
      record(checks, 'private_cloud_alias_native', global.PrivateCloudQuery === bridge);

      const ads = await bridge.ads({
        scope: EXPECTED_STORE_CODE,
        from: QUERY_FROM,
        to: QUERY_TO,
        limit: 5,
      });
      const governance = ads?.governance || {};
      const readiness = governance.readiness || {};
      const rows = Array.isArray(ads?.rows) ? ads.rows : [];
      record(checks, 'ads_query_cloudflare_d1', ads?.source === 'query-cloudflare-d1' && governance.sourceBackend === 'cloudflare-d1');
      record(checks, 'query_dates_remain_daily', rows.every((row) => (
        row?.reportGranularity === 'DAY'
        && [QUERY_FROM, QUERY_TO].includes(String(row?.date || ''))
      )), { rowCount: rows.length });
      record(checks, 'bid_values_remain_untrusted', rows.every((row) => (
        row?.currentBid === null
        && row?.targetBid === null
        && row?.bid === null
        && row?.bidValueTrusted === false
        && row?.governanceReady === false
      )), { rowCount: rows.length });
      record(checks, 'governance_remains_closed', (
        readiness.targetingIdentityReady === false
        && readiness.bidSourceColumnReady === false
        && readiness.bidValueNullabilityTrusted === false
        && readiness.bidGovernanceReady === false
        && readiness.campaignStudioReady === false
      ));

      const resourceUrls = resourceEntries();
      const retiredRequests = resourceUrls.filter((url) => safeHostname(url) === RETIRED_BACKEND_HOST);
      record(checks, 'retired_query_backend_not_requested', retiredRequests.length === 0, { retiredRequests });
      const foreignOrigins = resourceUrls
        .filter((url) => isHttpUrl(url))
        .map((url) => safeOrigin(url))
        .filter((origin) => origin && origin !== global.location.origin);
      record(checks, 'runtime_resources_same_origin', foreignOrigins.length === 0, {
        foreignOrigins: [...new Set(foreignOrigins)],
      });

      let transactionsNotMigrated = false;
      try {
        await bridge.allTransactions();
      } catch (error) {
        transactionsNotMigrated = error?.status === 501 && error?.code === 'cloudflare_transactions_not_migrated';
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
    global.document?.documentElement?.setAttribute?.('data-cf-gate7', result.ok ? 'pass' : 'fail');
    render(result);
    try {
      global.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: result }));
    } catch {}
    if (result.ok) console.info('[Cloudflare Gate 7] PASS', result);
    else console.error('[Cloudflare Gate 7] FAIL', result);
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

  function resourceEntries() {
    try {
      return (global.performance?.getEntriesByType?.('resource') || [])
        .map((entry) => String(entry?.name || ''))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function safeHostname(value) {
    try { return new URL(value, global.location.origin).hostname; } catch { return ''; }
  }

  function safeOrigin(value) {
    try { return new URL(value, global.location.origin).origin; } catch { return ''; }
  }

  function isHttpUrl(value) {
    try { return ['http:', 'https:'].includes(new URL(value, global.location.origin).protocol); } catch { return false; }
  }

  function sameArray(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  function render(result) {
    const document = global.document;
    if (!document?.body || !enabled) return;
    document.getElementById('cf-gate7-acceptance')?.remove();
    const panel = document.createElement('aside');
    panel.id = 'cf-gate7-acceptance';
    panel.setAttribute('role', 'status');
    panel.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'width:min(500px,calc(100vw - 32px))', 'max-height:72vh', 'overflow:auto',
      'padding:14px 16px', 'border:1px solid rgba(0,0,0,.14)', 'border-radius:12px',
      'background:#fff', 'color:#111827', 'box-shadow:0 12px 40px rgba(0,0,0,.18)',
      'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', 'text-align:left',
    ].join(';');
    const lines = [
      `Cloudflare Gate 7 UI: ${result.ok ? 'PASS' : 'FAIL'}`,
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
  Object.defineProperty(global, 'CloudflareGate7Acceptance', {
    value: control,
    writable: false,
    configurable: false,
    enumerable: true,
  });

  if (enabled) control.pending = runAcceptance();
})(window);
