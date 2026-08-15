const AMAZON_ADS_REGION_BASE_URLS = Object.freeze({
  NA: 'https://advertising-api.amazon.com',
  EU: 'https://advertising-api-eu.amazon.com',
  FE: 'https://advertising-api-fe.amazon.com',
});

const CREATE_REPORT_MEDIA_TYPE = 'application/vnd.createasyncreportrequest.v3+json';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_READ_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_MAX_RETRY_AFTER_MS = 10_000;
const DEFAULT_MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

export class AmazonAdsReportTransportError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.name = 'AmazonAdsReportTransportError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? null;
    this.retryable = Boolean(options.retryable);
    this.ambiguous = Boolean(options.ambiguous);
    this.cause = options.cause ?? null;
  }
}

export function resolveAmazonAdsApiBaseUrl(region) {
  const key = String(region ?? '').trim().toUpperCase();
  const url = AMAZON_ADS_REGION_BASE_URLS[key];
  if (!url) throw new AmazonAdsReportTransportError('AMAZON_ADS_REGION_UNSUPPORTED');
  return url;
}

export function createAmazonAdsReportTransport(options = {}) {
  const clientId = requiredText(options.clientId, 'AMAZON_ADS_CLIENT_ID_REQUIRED');
  const profileId = requiredText(options.profileId, 'AMAZON_ADS_PROFILE_ID_REQUIRED');
  const apiBaseUrl = options.apiBaseUrl
    ? requiredHttpsUrl(options.apiBaseUrl, 'AMAZON_ADS_API_BASE_URL_INVALID')
    : resolveAmazonAdsApiBaseUrl(options.region);
  const accessToken = requiredText(options.accessToken, 'AMAZON_ADS_ACCESS_TOKEN_REQUIRED');
  const fetchImpl = requiredFunction(options.fetchImpl ?? globalThis.fetch, 'AMAZON_ADS_FETCH_INVALID');
  const sleep = requiredFunction(options.sleep ?? defaultSleep, 'AMAZON_ADS_SLEEP_INVALID');
  const requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 'AMAZON_ADS_REQUEST_TIMEOUT_INVALID');
  const downloadTimeoutMs = positiveInteger(options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS, 'AMAZON_ADS_DOWNLOAD_TIMEOUT_INVALID');
  const maxReadRetries = nonNegativeInteger(options.maxReadRetries ?? DEFAULT_MAX_READ_RETRIES, 'AMAZON_ADS_READ_RETRY_POLICY_INVALID');
  const retryBaseMs = nonNegativeInteger(options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS, 'AMAZON_ADS_RETRY_BASE_INVALID');
  const maxRetryAfterMs = positiveInteger(options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS, 'AMAZON_ADS_RETRY_AFTER_INVALID');
  const maxDownloadBytes = positiveInteger(options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES, 'AMAZON_ADS_DOWNLOAD_SIZE_POLICY_INVALID');

  const reportUrl = (reportId = null) => reportId
    ? `${apiBaseUrl}/reporting/reports/${encodeURIComponent(requiredText(reportId, 'AMAZON_ADS_REPORT_ID_REQUIRED'))}`
    : `${apiBaseUrl}/reporting/reports`;

  const authHeaders = () => ({
    'authorization': `Bearer ${accessToken}`,
    'amazon-advertising-api-clientid': clientId,
    'amazon-advertising-api-scope': profileId,
  });

  const getReportDocument = async (reportId) => {
    const response = await fetchWithReadRetries({
      fetchImpl,
      url:reportUrl(reportId),
      init:{
        method:'GET',
        headers: {
          ...authHeaders(),
          'content-type': CREATE_REPORT_MEDIA_TYPE,
        },
      },
      timeoutMs:requestTimeoutMs,
      maxRetries:maxReadRetries,
      retryBaseMs,
      maxRetryAfterMs,
      sleep,
      errorPrefix:'AMAZON_ADS_REPORT_STATUS',
    });
    if (!response.ok) {
      throw httpError('AMAZON_ADS_REPORT_STATUS_HTTP_ERROR', response.status);
    }
    return parseJsonResponse(response, 'AMAZON_ADS_REPORT_STATUS_RESPONSE_INVALID');
  };

  return Object.freeze({
    async createReport(request) {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new AmazonAdsReportTransportError('AMAZON_ADS_CREATE_REQUEST_INVALID');
      }
      let response;
      try {
        response = await fetchWithTimeout(fetchImpl, reportUrl(), {
          method:'POST',
          headers: {
            ...authHeaders(),
            'content-type': CREATE_REPORT_MEDIA_TYPE,
          },
          body:JSON.stringify(request),
        }, requestTimeoutMs);
      } catch (error) {
        if (error instanceof AmazonAdsReportTransportError) throw error;
        // The request may have reached Amazon. Never retry this POST inside the transport.
        throw new AmazonAdsReportTransportError('AMAZON_ADS_CREATE_OUTCOME_AMBIGUOUS', {
          retryable:false,
          ambiguous:true,
          cause:error,
        });
      }
      if (!response.ok) {
        throw new AmazonAdsReportTransportError('AMAZON_ADS_CREATE_HTTP_REJECTED', {
          httpStatus:response.status,
          retryable:isRetryableStatus(response.status),
          ambiguous:false,
        });
      }
      const payload = await parseJsonResponse(response, 'AMAZON_ADS_CREATE_RESPONSE_INVALID');
      return Object.freeze({
        reportId:requiredText(payload?.reportId, 'AMAZON_ADS_CREATE_REPORT_ID_INVALID'),
        createdAt:requiredText(payload?.createdAt, 'AMAZON_ADS_CREATE_CREATED_AT_INVALID'),
      });
    },

    async pollReport(reportId) {
      const payload = await getReportDocument(reportId);
      return normalizePollPayload(payload);
    },

    async downloadReport(reportId) {
      // Re-read Amazon status on every materialization attempt so a Worker restart never
      // depends on an in-memory pre-signed URL captured by a prior polling invocation.
      const payload = await getReportDocument(reportId);
      const status = normalizedStatus(payload?.status);
      if (status !== 'COMPLETED') {
        throw new AmazonAdsReportTransportError(`AMAZON_ADS_DOWNLOAD_REPORT_NOT_READY:${status || 'EMPTY'}`);
      }
      const url = requiredHttpsUrl(payload?.url, 'AMAZON_ADS_DOWNLOAD_URL_INVALID');
      const urlExpiresAt = String(payload?.urlExpiresAt ?? '').trim();
      if (urlExpiresAt && !Number.isFinite(Date.parse(urlExpiresAt))) {
        throw new AmazonAdsReportTransportError('AMAZON_ADS_DOWNLOAD_URL_EXPIRY_INVALID');
      }

      const response = await fetchWithReadRetries({
        fetchImpl,
        url,
        init:{
          method:'GET',
          headers:{
            // Preserve the GZIP_JSON artifact itself rather than asking the transport layer
            // to apply an additional content-coding transformation.
            'accept-encoding':'identity',
          },
        },
        timeoutMs:downloadTimeoutMs,
        maxRetries:maxReadRetries,
        retryBaseMs,
        maxRetryAfterMs,
        sleep,
        errorPrefix:'AMAZON_ADS_REPORT_DOWNLOAD',
      });
      if (!response.ok) throw httpError('AMAZON_ADS_REPORT_DOWNLOAD_HTTP_ERROR', response.status);

      const contentLength = response.headers?.get?.('content-length');
      if (contentLength != null && String(contentLength).trim() !== '') {
        const length = Number(contentLength);
        if (!Number.isSafeInteger(length) || length < 0) {
          throw new AmazonAdsReportTransportError('AMAZON_ADS_REPORT_DOWNLOAD_CONTENT_LENGTH_INVALID');
        }
        if (length > maxDownloadBytes) {
          throw new AmazonAdsReportTransportError('AMAZON_ADS_REPORT_DOWNLOAD_TOO_LARGE');
        }
      }

      const bytes = await readResponseBytesWithLimit(response, maxDownloadBytes);
      return Object.freeze({
        bytes,
        contentEncoding:String(response.headers?.get?.('content-encoding') ?? '').trim().toLowerCase() || 'identity',
      });
    },
  });
}

function normalizePollPayload(payload) {
  const status = normalizedStatus(payload?.status);
  if (status === 'PENDING' || status === 'PROCESSING') {
    return Object.freeze({ state:'processing' });
  }
  if (status === 'COMPLETED') return Object.freeze({ state:'ready' });
  if (status === 'FAILED' || status === 'FAILURE') {
    const reason = String(payload?.failureReason ?? '').trim();
    return Object.freeze({
      state:'failed',
      failureCode:'AMAZON_REPORT_FAILED',
      failureMessage:reason || `Amazon Ads report status ${status}`,
    });
  }
  throw new AmazonAdsReportTransportError(`AMAZON_ADS_REPORT_STATUS_UNSUPPORTED:${status || 'EMPTY'}`);
}

async function readResponseBytesWithLimit(response, maxBytes) {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    let buffer;
    try {
      buffer = await response.arrayBuffer();
    } catch (error) {
      throw new AmazonAdsReportTransportError('AMAZON_ADS_REPORT_DOWNLOAD_BODY_INVALID', { cause:error });
    }
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength > maxBytes) {
      throw new AmazonAdsReportTransportError('AMAZON_ADS_REPORT_DOWNLOAD_TOO_LARGE');
    }
    return bytes;
  }

  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel('amazon_ads_download_too_large'); } catch {}
        throw new AmazonAdsReportTransportError('AMAZON_ADS_REPORT_DOWNLOAD_TOO_LARGE');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof AmazonAdsReportTransportError) throw error;
    throw new AmazonAdsReportTransportError('AMAZON_ADS_REPORT_DOWNLOAD_BODY_INVALID', { cause:error });
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchWithReadRetries({
  fetchImpl,
  url,
  init,
  timeoutMs,
  maxRetries,
  retryBaseMs,
  maxRetryAfterMs,
  sleep,
  errorPrefix,
}) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(fetchImpl, url, init, timeoutMs);
      if (!isRetryableStatus(response.status) || attempt === maxRetries) return response;
      await sleep(retryDelayMs(response, attempt, retryBaseMs, maxRetryAfterMs));
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) {
        throw new AmazonAdsReportTransportError(`${errorPrefix}_TRANSPORT_ERROR`, {
          retryable:true,
          cause:error,
        });
      }
      await sleep(Math.min(maxRetryAfterMs, retryBaseMs * (2 ** attempt)));
    }
  }
  throw new AmazonAdsReportTransportError(`${errorPrefix}_TRANSPORT_ERROR`, {
    retryable:true,
    cause:lastError,
  });
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('amazon_ads_request_timeout'), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal:controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function parseJsonResponse(response, code) {
  try {
    return await response.json();
  } catch (error) {
    throw new AmazonAdsReportTransportError(code, { cause:error });
  }
}

function httpError(code, status) {
  return new AmazonAdsReportTransportError(code, {
    httpStatus:status,
    retryable:isRetryableStatus(status),
  });
}

function retryDelayMs(response, attempt, retryBaseMs, maxRetryAfterMs) {
  const retryAfter = parseRetryAfter(response.headers?.get?.('retry-after'));
  if (retryAfter !== null) return Math.min(maxRetryAfterMs, retryAfter);
  return Math.min(maxRetryAfterMs, retryBaseMs * (2 ** attempt));
}

function parseRetryAfter(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.max(0, Math.ceil(Number(text) * 1000));
  const date = Date.parse(text);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - Date.now());
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function normalizedStatus(value) {
  return String(value ?? '').trim().toUpperCase();
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new AmazonAdsReportTransportError(code);
  return text;
}

function requiredHttpsUrl(value, code) {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'https:') throw new Error('protocol');
    return url.toString();
  } catch (error) {
    throw new AmazonAdsReportTransportError(code, { cause:error });
  }
}

function requiredFunction(value, code) {
  if (typeof value !== 'function') throw new AmazonAdsReportTransportError(code);
  return value;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new AmazonAdsReportTransportError(code);
  return value;
}

function nonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw new AmazonAdsReportTransportError(code);
  return value;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
