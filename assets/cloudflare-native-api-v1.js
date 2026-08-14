(function initCloudflareNativeApi(global) {
  'use strict';

  class ApiError extends Error {
    constructor(message, options) {
      super(message);
      this.name = 'CloudflareNativeApiError';
      this.status = options?.status || 0;
      this.code = options?.code || 'api_error';
      this.requestId = options?.requestId || null;
      this.payload = options?.payload || null;
    }
  }

  async function request(path, options) {
    const response = await fetch(path, {
      method: options?.method || 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        ...(options?.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(options?.headers || {}),
      },
      body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    const requestId = response.headers.get('x-request-id');
    const contentType = response.headers.get('content-type') || '';
    let payload = null;
    if (contentType.includes('application/json')) {
      try { payload = await response.json(); } catch { payload = null; }
    } else {
      const text = await response.text();
      payload = text ? { message: text.slice(0, 500) } : null;
    }

    if (!response.ok) {
      const code = payload?.error || `http_${response.status}`;
      throw new ApiError(code, {
        status: response.status,
        code,
        requestId,
        payload,
      });
    }
    return payload;
  }

  function query(path, params) {
    const url = new URL(path, global.location.origin);
    for (const [key, value] of Object.entries(params || {})) {
      if (value === null || value === undefined || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url.pathname + url.search;
  }

  const api = Object.freeze({
    ApiError,
    session: () => request('/api/v1/session'),
    stores: () => request('/api/v1/stores'),
    capabilities: () => request('/api/v1/capabilities'),

    listProducts: (params) => request(query('/api/v1/products', params)),
    createProduct: (body) => request('/api/v1/products', { method: 'POST', body }),
    updateProduct: (productId, body) => request(`/api/v1/products/${encodeURIComponent(productId)}`, { method: 'PATCH', body }),

    listKeywords: (params) => request(query('/api/v1/keywords', params)),
    createKeyword: (body) => request('/api/v1/keywords', { method: 'POST', body }),
    updateKeyword: (keywordId, body) => request(`/api/v1/keywords/${encodeURIComponent(keywordId)}`, { method: 'PATCH', body }),

    listNegativeKeywords: (params) => request(query('/api/v1/negative-keywords', params)),
    createNegativeKeyword: (body) => request('/api/v1/negative-keywords', { method: 'POST', body }),
    updateNegativeKeyword: (id, body) => request(`/api/v1/negative-keywords/${encodeURIComponent(id)}`, { method: 'PATCH', body }),

    campaigns: (storeId, params) => request(query(`/api/v1/stores/${encodeURIComponent(storeId)}/campaigns`, params)),
    adGroups: (storeId, params) => request(query(`/api/v1/stores/${encodeURIComponent(storeId)}/ad-groups`, params)),
    storeKeywords: (storeId, params) => request(query(`/api/v1/stores/${encodeURIComponent(storeId)}/keywords`, params)),
    targets: (storeId, params) => request(query(`/api/v1/stores/${encodeURIComponent(storeId)}/targets`, params)),
    searchTerms: (storeId, params) => request(query(`/api/v1/stores/${encodeURIComponent(storeId)}/search-terms`, params)),
    searchTermsDaily: (storeId, params) => request(query(`/api/v1/stores/${encodeURIComponent(storeId)}/search-terms-daily`, params)),

    analyticsOverview: (params) => request(query('/api/v1/analytics/overview', params)),
    analyticsProducts: (params) => request(query('/api/v1/analytics/products', params)),
    analyticsKeywords: (params) => request(query('/api/v1/analytics/keywords', params)),
    analyticsDataHealth: (params) => request(query('/api/v1/analytics/data-health', params)),

    startSync: (storeId, body, idempotencyKey) => request(`/api/v1/stores/${encodeURIComponent(storeId)}/sync`, {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body,
    }),
    syncStatus: (storeId, instanceId) => request(`/api/v1/stores/${encodeURIComponent(storeId)}/sync/${encodeURIComponent(instanceId)}`),
  });

  Object.defineProperty(global, 'CloudflareNativeAPI', {
    value: api,
    writable: false,
    configurable: false,
    enumerable: true,
  });
})(window);
