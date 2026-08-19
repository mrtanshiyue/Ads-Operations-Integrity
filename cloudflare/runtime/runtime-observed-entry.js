import application from './web-entry.js';

export default {
  async fetch(request, env, ctx) {
    const startedAt = Date.now();
    const url = new URL(request.url);
    const workerVersion = runtimeWorkerVersion(env);
    const response = await application.fetch(request, env, ctx);
    const record = runtimeEvidenceRecord({
      request,
      env,
      url,
      workerVersion,
      status: response.status,
      durationMs: Date.now() - startedAt,
      errorCode: response.status >= 500 ? `http_${response.status}` : null,
    });
    return withRuntimeEvidenceHeaders(response, record);
  },
};

export function runtimeWorkerVersion(env = {}) {
  const metadata = env.CF_VERSION_METADATA;
  if (!metadata || typeof metadata !== 'object') return 'unknown';
  return String(metadata.id || metadata.version_id || metadata.versionId || 'unknown');
}

export function normalizeRuntimeRoute(pathname) {
  const path = String(pathname || '');
  if (path === '/api/health') return '/api/health';
  if (/^\/api\/v1\/stores\/[^/]+\/csv-analytics\/[^/]+$/.test(path)) {
    return '/api/v1/stores/:store/csv-analytics/:dimension';
  }
  if (/^\/api\/v1\/stores\/[^/]+\/imports(?:\/[^/]+(?:\/errors)?)?$/.test(path)) {
    return '/api/v1/stores/:store/imports/:resource';
  }
  if (/^\/api\/v1\/stores\/[^/]+\/search-term-intelligence(?:\/recommendation-preview)?$/.test(path)) {
    return '/api/v1/stores/:store/search-term-intelligence/:action';
  }
  if (/^\/api\/v1\/stores\/[^/]+\/optimization-actions(?:\/[^/]+(?:\/[^/]+)?)?$/.test(path)) {
    return '/api/v1/stores/:store/optimization-actions/:resource';
  }
  if (/^\/api\/v1\/stores\/[^/]+\/[^/]+(?:\/[^/]+)?$/.test(path)) {
    return '/api/v1/stores/:store/:resource';
  }
  if (/^\/api\/v1\/analytics\/[^/]+$/.test(path)) return '/api/v1/analytics/:resource';
  if (/^\/api\/v1\/access\/[^/]+(?:\/[^/]+(?:\/[^/]+)?)?$/.test(path)) return '/api/v1/access/:resource';
  if (path.startsWith('/api/')) return '/api/:other';
  return 'asset';
}

export function runtimeEvidenceRecord({ request, env, url, workerVersion, status, durationMs, errorCode }) {
  return {
    event: 'runtime_request_evidence',
    service: String(env?.APP_ENV || '').toLowerCase() === 'production' ? 'ads-operations-web-prod' : 'ads-operations-web-dev',
    environment: String(env?.APP_ENV || 'unknown'),
    workerVersion: String(workerVersion || 'unknown'),
    cfRay: request.headers.get('cf-ray') || null,
    method: String(request.method || 'GET').toUpperCase(),
    routeClass: normalizeRuntimeRoute(url.pathname),
    status: Number(status || 0),
    durationMs: Math.max(0, Number(durationMs || 0)),
    errorCode: errorCode || null,
  };
}

export function runtimeEvidenceHeaders(record = {}) {
  return {
    'x-runtime-worker-version': String(record.workerVersion || 'unknown'),
    'x-runtime-route-class': String(record.routeClass || '/api/:other'),
    'x-runtime-duration-ms': String(Math.max(0, Number(record.durationMs || 0))),
    'x-runtime-error-code': String(record.errorCode || ''),
    'x-runtime-evidence-channel': 'response-headers',
  };
}

function withRuntimeEvidenceHeaders(response, record) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(runtimeEvidenceHeaders(record))) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
