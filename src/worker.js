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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/_migration/health') {
      return json({
        ok: true,
        service: 'ads-operations-integrity',
        hosting: 'cloudflare-workers-static-assets',
        dataBackendCutover: false,
      });
    }

    if (url.pathname.startsWith('/api/')) {
      return json(
        {
          ok: false,
          error: 'API_NOT_MIGRATED',
          message: 'Cloudflare frontend migration is active; the application data backend has not been cut over yet.',
        },
        { status: 404 },
      );
    }

    return env.ASSETS.fetch(request);
  },
};
