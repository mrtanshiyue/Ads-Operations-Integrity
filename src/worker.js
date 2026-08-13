import { accessRuntimeConfig, evaluateAccessIdentity } from './access.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const SPOOFABLE_IDENTITY_HEADERS = [
  'cf-access-jwt-assertion',
  'cf-access-authenticated-user-email',
  'cf-access-user-email',
  'x-ops-user-sub',
  'x-ops-user-email',
  'x-ops-request-id',
  'x-ops-auth-source',
];

function json(body, init = {}) {
  const headers = new Headers(init.headers || {});
  for (const [key, value] of Object.entries(JSON_HEADERS)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

function accessNotConfigured(context) {
  return json(
    {
      ok: false,
      error: 'ACCESS_NOT_CONFIGURED',
      message: 'Cloudflare Access mode is enabled but TEAM_DOMAIN and ACCESS_AUD are not fully configured.',
      access: {
        mode: context.mode,
        configured: false,
        authenticated: false,
      },
    },
    { status: 503 },
  );
}

function accessDenied(context) {
  return json(
    {
      ok: false,
      error: 'ACCESS_REQUIRED',
      message: 'Cloudflare Access identity is required for this API route.',
      access: {
        mode: context.mode,
        configured: context.configured,
        authenticated: false,
      },
    },
    { status: 401 },
  );
}

function sanitizedWarehouseHeaders(input, accessContext) {
  const headers = new Headers(input);
  headers.delete('host');
  headers.delete('origin');
  headers.delete('cookie');
  for (const name of SPOOFABLE_IDENTITY_HEADERS) headers.delete(name);

  const requestId = input.get('cf-ray') || crypto.randomUUID();
  headers.set('x-ops-request-id', requestId);

  if (accessContext?.authenticated && accessContext.identity) {
    headers.set('x-ops-user-sub', accessContext.identity.sub);
    if (accessContext.identity.email) {
      headers.set('x-ops-user-email', accessContext.identity.email);
    }
    headers.set('x-ops-auth-source', 'cloudflare-access');
  }

  return headers;
}

async function proxyWarehouse(request, env, accessContext) {
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

  if (accessContext?.mode === 'enforce' && !accessContext.configured) {
    return accessNotConfigured(accessContext);
  }

  if (accessContext?.mode === 'enforce' && !accessContext.authenticated) {
    return accessDenied(accessContext);
  }

  const url = new URL(request.url);
  const upstreamUrl = new URL(`${url.pathname}${url.search}`, 'https://amazon-warehouse-cloud-v4.internal');
  const headers = sanitizedWarehouseHeaders(request.headers, accessContext);

  // This hop is server-to-server through a Service Binding. Browser Origin and
  // Access cookies/assertions never cross into the Warehouse. The existing
  // Authorization Bearer password is intentionally preserved during Phase 2B.
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
    const accessConfig = accessRuntimeConfig(env);

    if (url.pathname === '/api/_migration/health') {
      return json({
        ok: true,
        service: 'ads-operations-integrity',
        hosting: 'cloudflare-workers-static-assets',
        dataBackendCutover: false,
        warehouseTransport: env.WAREHOUSE ? 'service-binding' : 'unbound',
        accessIdentityLayer: 'phase-2b',
        accessMode: accessConfig.mode,
        accessConfigured: accessConfig.configured,
        accessActivationReady: accessConfig.configured,
        accessRuntimeSafe: accessConfig.mode === 'off' || accessConfig.configured,
      });
    }

    if (url.pathname === '/api/_auth/session') {
      if (request.method !== 'GET') {
        return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, { status: 405 });
      }

      const context = await evaluateAccessIdentity(request, env);
      if (context.mode !== 'off' && !context.configured) {
        return accessNotConfigured(context);
      }

      const status = context.mode === 'enforce' && !context.authenticated ? 401 : 200;
      return json(
        {
          ok: status === 200,
          access: {
            mode: context.mode,
            configured: context.configured,
            authenticated: context.authenticated,
          },
          user: context.authenticated
            ? {
                sub: context.identity.sub,
                email: context.identity.email || null,
              }
            : null,
        },
        { status },
      );
    }

    if (url.pathname === '/api/v1' || url.pathname.startsWith('/api/v1/')) {
      const accessContext = await evaluateAccessIdentity(request, env);
      return proxyWarehouse(request, env, accessContext);
    }

    if (url.pathname.startsWith('/api/')) {
      return json(
        {
          ok: false,
          error: 'API_NOT_MIGRATED',
          message: 'Only the existing Warehouse /api/v1/* contract and Phase 2B identity endpoints are enabled.',
        },
        { status: 404 },
      );
    }

    return env.ASSETS.fetch(request);
  },
};
