import application from './web-entry.js';

export default {
  async fetch(request, env, ctx) {
    const startedAt = Date.now();
    const url = new URL(request.url);
    const workerVersion = runtimeWorkerVersion(env);
    let response;

    try {
      response = await application.fetch(request, env, ctx);
    } catch (error) {
      emitRuntimeEvidence({
        request,
        env,
        url,
        workerVersion,
        status: 500,
        durationMs: Date.now() - startedAt,
        errorCode: safeRuntimeErrorCode(error),
      });
      throw error;
    }

    emitRuntimeEvidence({
      request,
      env,
      url,
      workerVersion,
      status: response.status,
      durationMs: Date.now() - startedAt,
      errorCode: response.status >= 500 ? `http_${response.status}` : null,
    });

    return withRuntimeEvidenceHeaders(response, workerVersion);
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

export function runtimeEvidenceDataPoint(record = {}) {
  return {
    indexes: [String(record.workerVersion || 'unknown')],
    blobs: [
      String(record.event || 'runtime_request_evidence'),
      String(record.service || 'unknown'),
      String(record.environment || 'unknown'),
      String(record.cfRay || ''),
      String(record.method || 'GET'),
      String(record.routeClass || '/api/:other'),
      String(record.errorCode || ''),
    ],
    doubles: [
      Number(record.status || 0),
      Math.max(0, Number(record.durationMs || 0)),
    ],
  };
}

function emitRuntimeEvidence(input) {
  const dataset = input?.env?.RUNTIME_EVIDENCE;
  if (!dataset || typeof dataset.writeDataPoint !== 'function') return;
  dataset.writeDataPoint(runtimeEvidenceDataPoint(runtimeEvidenceRecord(input)));
}

function withRuntimeEvidenceHeaders(response, workerVersion) {
  const headers = new Headers(response.headers);
  headers.set('x-runtime-worker-version', String(workerVersion || 'unknown'));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function safeRuntimeErrorCode(error) {
  const raw = String(error?.code || error?.name || 'runtime_error').toLowerCase();
  return raw.replace(/[^a-z0-9_.-]/g, '_').slice(0, 80) || 'runtime_error';
}
