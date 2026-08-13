const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(body, init = {}) {
  const headers = new Headers(init.headers || {});
  for (const [key, value] of Object.entries(JSON_HEADERS)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

async function proxyWarehouse(request, env) {
  if (!env.WAREHOUSE || typeof env.WAREHOUSE.fetch !== 'function') {
    return json(
      {
        ok: false,
        error: 'WAREHOUSE_BINDING_UNAVAILABLE',
        message: 'Warehouse Service Binding is not available on this Worker version.',
      },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const upstreamUrl = new URL(`${url.pathname}${url.search}`, 'https://amazon-warehouse-cloud-v4.internal');
  const headers = new Headers(request.headers);
  headers.delete('host');

  const init = {
    method: request.method,
    headers,
    redirect: 'manual',
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }

  return env.WAREHOUSE.fetch(new Request(upstreamUrl, init));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/_migration/health') {
      return json({
        ok: true,
        service: 'ads-operations-integrity',
        hosting: 'cloudflare-workers-static-assets',
        dataBackendCutover: false,
        warehouseTransport: env.WAREHOUSE ? 'service-binding' : 'unbound',
      });
    }

    if (url.pathname === '/api/v1' || url.pathname.startsWith('/api/v1/')) {
      return proxyWarehouse(request, env);
    }

    if (url.pathname.startsWith('/api/')) {
      return json(
        {
          ok: false,
          error: 'API_NOT_MIGRATED',
          message: 'Only the existing Warehouse /api/v1/* contract is enabled through the Phase 2A same-origin BFF.',
        },
        { status: 404 },
      );
    }

    return env.ASSETS.fetch(request);
  },
};
