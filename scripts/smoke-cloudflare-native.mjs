const baseUrl = normalizeBaseUrl(process.env.CF_NATIVE_BASE_URL);
const cookie = String(process.env.CF_NATIVE_COOKIE || '').trim();
const accessClientId = String(process.env.CF_ACCESS_CLIENT_ID || '').trim();
const accessClientSecret = String(process.env.CF_ACCESS_CLIENT_SECRET || '').trim();
const startDate = String(process.env.CF_SMOKE_START_DATE || '').trim();
const endDate = String(process.env.CF_SMOKE_END_DATE || '').trim();
const authenticated = process.argv.includes('--authenticated');

if (!baseUrl) {
  console.error('CF_NATIVE_BASE_URL is required, for example https://ads-operations-web-dev.example.workers.dev');
  process.exit(2);
}
if (authenticated && !cookie && !(accessClientId && accessClientSecret)) {
  console.error('Authenticated smoke mode requires CF_NATIVE_COOKIE or CF_ACCESS_CLIENT_ID + CF_ACCESS_CLIENT_SECRET');
  process.exit(2);
}

const checks = [];
await checkStaticRuntime();
await checkHealth();
if (authenticated) await checkAuthenticatedRuntime();

const failed = checks.filter((item) => !item.ok);
console.log(JSON.stringify({
  ok: failed.length === 0,
  baseUrl,
  mode: authenticated ? 'authenticated' : 'public',
  checks,
}, null, 2));
if (failed.length) process.exit(1);

async function checkStaticRuntime() {
  const response = await request('/');
  const html = await response.text();
  record('index_status', response.status === 200, { status: response.status });
  record('index_content_type', (response.headers.get('content-type') || '').includes('text/html'), {
    contentType: response.headers.get('content-type'),
  });
  record('native_api_client_injected', html.includes('assets/cloudflare-native-api-v1.js'));
  record('native_query_bridge_injected', html.includes('assets/cloudflare-native-query-bridge-v1.js'));
  record('legacy_query_client_removed', !html.includes('assets/private-cloud-query-v1.js'));
  record('legacy_external_worker_removed', !/amazon-warehouse-cloud-v4\.tanshiyuesir\.workers\.dev/i.test(html));
  record('same_origin_connect_policy', /connect-src\s+'self';/i.test(html));

  for (const asset of [
    '/assets/cloudflare-native-api-v1.js',
    '/assets/cloudflare-native-query-bridge-v1.js',
  ]) {
    const assetResponse = await request(asset);
    record(`asset_${asset.split('/').at(-1)}`, assetResponse.status === 200, { status: assetResponse.status });
  }
}

async function checkHealth() {
  const response = await request('/api/health', { acceptJson: true });
  const payload = await jsonSafe(response);
  record('api_health_status', response.status === 200, { status: response.status });
  record('api_health_contract', payload?.ok === true && payload?.service === 'ads-operations-web', {
    service: payload?.service || null,
    environment: payload?.environment || null,
  });
  record('api_health_control_db', payload?.dependencies?.controlDb === true);
  record('api_health_store_db', Number(payload?.dependencies?.storeDatabases || 0) >= 1, {
    storeDatabases: payload?.dependencies?.storeDatabases ?? null,
  });
  record('api_health_r2', payload?.dependencies?.dataBucket === true);
  record('api_health_sync_disabled', payload?.syncTriggerEnabled === false);
}

async function checkAuthenticatedRuntime() {
  const sessionResponse = await request('/api/v1/session', { acceptJson: true, auth: true });
  const session = await jsonSafe(sessionResponse);
  record('session_status', sessionResponse.status === 200, { status: sessionResponse.status });
  record('session_provisioned', session?.authenticated === true && session?.provisioned === true, {
    authenticated: session?.authenticated ?? null,
    provisioned: session?.provisioned ?? null,
  });
  if (!(session?.authenticated && session?.provisioned)) return;

  const storesResponse = await request('/api/v1/stores', { acceptJson: true, auth: true });
  const storesPayload = await jsonSafe(storesResponse);
  const stores = Array.isArray(storesPayload?.stores) ? storesPayload.stores : [];
  record('stores_status', storesResponse.status === 200, { status: storesResponse.status });
  record('stores_available', stores.length >= 1, { count: stores.length });
  if (!stores.length) return;

  const first = stores[0];
  const storeId = first.store_id || first.storeId;
  const storeHealthResponse = await request(`/api/v1/stores/${encodeURIComponent(storeId)}/health`, {
    acceptJson: true,
    auth: true,
  });
  const storeHealth = await jsonSafe(storeHealthResponse);
  record('store_health_status', storeHealthResponse.status === 200, { status: storeHealthResponse.status });
  record('store_health_contract', storeHealth?.health?.ok === true);

  const capabilitiesResponse = await request('/api/v1/capabilities', { acceptJson: true, auth: true });
  const capabilities = await jsonSafe(capabilitiesResponse);
  record('capabilities_status', capabilitiesResponse.status === 200, { status: capabilitiesResponse.status });
  record('capabilities_sync_disabled', capabilities?.syncTriggerEnabled === false);

  const dataHealthResponse = await request('/api/v1/analytics/data-health', { acceptJson: true, auth: true });
  const dataHealth = await jsonSafe(dataHealthResponse);
  record('analytics_data_health_status', dataHealthResponse.status === 200, { status: dataHealthResponse.status });
  record('analytics_data_health_contract', Array.isArray(dataHealth?.stores) && Array.isArray(dataHealth?.recentRollupFailures));

  if (isIsoDate(startDate) && isIsoDate(endDate) && endDate >= startDate) {
    const analyticsResponse = await request(`/api/v1/analytics/overview?startDate=${startDate}&endDate=${endDate}`, {
      acceptJson: true,
      auth: true,
    });
    const analytics = await jsonSafe(analyticsResponse);
    record('analytics_overview_status', analyticsResponse.status === 200, { status: analyticsResponse.status });
    record('analytics_overview_contract', Boolean(analytics?.range && analytics?.totals && Array.isArray(analytics?.daily)));
  }

  const syncResponse = await request(`/api/v1/stores/${encodeURIComponent(storeId)}/sync`, {
    method: 'POST',
    auth: true,
    acceptJson: true,
    headers: { 'idempotency-key': 'smoke-disabled-sync-check' },
    body: {},
  });
  const syncPayload = await jsonSafe(syncResponse);
  record('sync_kill_switch', syncResponse.status === 503 && syncPayload?.error === 'sync_trigger_disabled', {
    status: syncResponse.status,
    error: syncPayload?.error || null,
  });
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.acceptJson) headers.set('accept', 'application/json');
  if (options.auth) {
    if (cookie) headers.set('cookie', cookie);
    if (accessClientId && accessClientSecret) {
      headers.set('CF-Access-Client-Id', accessClientId);
      headers.set('CF-Access-Client-Secret', accessClientSecret);
    }
  }
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return fetch(new URL(path, baseUrl), {
    method: options.method || 'GET',
    headers,
    redirect: 'manual',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

async function jsonSafe(response) {
  try { return await response.json(); } catch { return null; }
}

function record(name, ok, detail = undefined) {
  checks.push({ name, ok: Boolean(ok), ...(detail ? { detail } : {}) });
}

function normalizeBaseUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    return url.origin;
  } catch {
    return '';
  }
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
