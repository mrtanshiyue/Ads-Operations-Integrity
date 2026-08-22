const nativeFetch = globalThis.fetch;
const prodHost = new URL(process.env.PROD_BASE_URL || 'https://ads-operations-web-prod.tanshiyuesir.workers.dev').hostname.toLowerCase();
let serviceAuth = null;

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  let requestInit = init;

  if (url.hostname.toLowerCase() === prodHost && url.pathname === '/api/health' && serviceAuth) {
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('CF-Access-Client-Id', serviceAuth.clientId);
    headers.set('CF-Access-Client-Secret', serviceAuth.clientSecret);
    headers.set('accept', 'application/json');
    requestInit = { ...init, headers, redirect: 'manual', cache: 'no-store' };
  }

  const response = await nativeFetch(input, requestInit);

  if (
    url.hostname.toLowerCase() === 'api.cloudflare.com'
    && /\/access\/service_tokens$/.test(url.pathname)
    && method === 'POST'
  ) {
    const payload = await response.clone().json().catch(() => null);
    const clientId = payload?.result?.client_id;
    const clientSecret = payload?.result?.client_secret;
    if (clientId && clientSecret) serviceAuth = { clientId, clientSecret };
  }

  return response;
};

await import('./live-human-review-service-auth-acceptance.mjs');
