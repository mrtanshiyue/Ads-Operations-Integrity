const DEFAULT_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REFRESH_SKEW_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_MAX_RETRY_AFTER_MS = 5_000;

export const AMAZON_ADS_CREDENTIAL_BINDINGS = Object.freeze({
  clientId: 'AMAZON_ADS_CLIENT_ID',
  clientSecret: 'AMAZON_ADS_CLIENT_SECRET',
  refreshToken: 'AMAZON_ADS_REFRESH_TOKEN',
});

export class AmazonAdsCredentialProviderError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.name = 'AmazonAdsCredentialProviderError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? null;
    this.retryable = Boolean(options.retryable);
    this.cause = options.cause ?? null;
  }
}

export function createAmazonAdsAccessTokenProviderFromEnv(env, options = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new AmazonAdsCredentialProviderError('AMAZON_ADS_CREDENTIAL_ENV_INVALID');
  }
  return createAmazonAdsAccessTokenProvider({
    ...options,
    clientId: env[AMAZON_ADS_CREDENTIAL_BINDINGS.clientId],
    clientSecret: env[AMAZON_ADS_CREDENTIAL_BINDINGS.clientSecret],
    refreshToken: env[AMAZON_ADS_CREDENTIAL_BINDINGS.refreshToken],
  });
}

export function createAmazonAdsAccessTokenProvider(options = {}) {
  const clientId = requiredSecret(options.clientId, 'AMAZON_ADS_CLIENT_ID_REQUIRED');
  const clientSecret = requiredSecret(options.clientSecret, 'AMAZON_ADS_CLIENT_SECRET_REQUIRED');
  const refreshToken = requiredSecret(options.refreshToken, 'AMAZON_ADS_REFRESH_TOKEN_REQUIRED');
  const tokenUrl = requiredHttpsUrl(options.tokenUrl ?? DEFAULT_TOKEN_URL, 'AMAZON_ADS_TOKEN_URL_INVALID');
  const fetchImpl = requiredFunction(options.fetchImpl ?? globalThis.fetch, 'AMAZON_ADS_TOKEN_FETCH_INVALID');
  const sleep = requiredFunction(options.sleep ?? defaultSleep, 'AMAZON_ADS_TOKEN_SLEEP_INVALID');
  const now = requiredFunction(options.now ?? Date.now, 'AMAZON_ADS_TOKEN_NOW_INVALID');
  const requestTimeoutMs = positiveInteger(options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS, 'AMAZON_ADS_TOKEN_TIMEOUT_INVALID');
  const refreshSkewMs = nonNegativeInteger(options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS, 'AMAZON_ADS_TOKEN_REFRESH_SKEW_INVALID');
  const maxRetries = nonNegativeInteger(options.maxRetries ?? DEFAULT_MAX_RETRIES, 'AMAZON_ADS_TOKEN_RETRY_POLICY_INVALID');
  const retryBaseMs = nonNegativeInteger(options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS, 'AMAZON_ADS_TOKEN_RETRY_BASE_INVALID');
  const maxRetryAfterMs = positiveInteger(options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS, 'AMAZON_ADS_TOKEN_RETRY_AFTER_INVALID');

  let cached = null;
  let refreshInFlight = null;

  const refresh = async () => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString();

    let response;
    try {
      response = await fetchWithSafeRetries({
        fetchImpl,
        url: tokenUrl,
        init: {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            'accept': 'application/json',
          },
          body,
        },
        timeoutMs: requestTimeoutMs,
        maxRetries,
        retryBaseMs,
        maxRetryAfterMs,
        sleep,
      });
    } catch (error) {
      if (error instanceof AmazonAdsCredentialProviderError) throw error;
      throw new AmazonAdsCredentialProviderError('AMAZON_ADS_TOKEN_REFRESH_FAILED', { cause:error });
    }

    if (!response.ok) {
      throw new AmazonAdsCredentialProviderError('AMAZON_ADS_TOKEN_HTTP_ERROR', {
        httpStatus:response.status,
        retryable:isRetryableStatus(response.status),
      });
    }

    const payload = await parseJsonResponse(response, 'AMAZON_ADS_TOKEN_RESPONSE_INVALID');
    const accessToken = requiredSecret(payload?.access_token, 'AMAZON_ADS_ACCESS_TOKEN_INVALID');
    const expiresInSeconds = positiveNumber(payload?.expires_in, 'AMAZON_ADS_TOKEN_EXPIRES_IN_INVALID');
    const issuedAt = finiteNow(now, 'AMAZON_ADS_TOKEN_NOW_FAILED');
    cached = Object.freeze({
      accessToken,
      expiresAt: issuedAt + Math.floor(expiresInSeconds * 1000),
    });
    return accessToken;
  };

  return Object.freeze({
    async getAccessToken() {
      const current = finiteNow(now, 'AMAZON_ADS_TOKEN_NOW_FAILED');
      if (cached && cached.expiresAt - current > refreshSkewMs) return cached.accessToken;
      if (!refreshInFlight) {
        refreshInFlight = refresh().finally(() => {
          refreshInFlight = null;
        });
      }
      return refreshInFlight;
    },
    clearCachedAccessToken() {
      cached = null;
    },
  });
}

async function fetchWithSafeRetries({
  fetchImpl,
  url,
  init,
  timeoutMs,
  maxRetries,
  retryBaseMs,
  maxRetryAfterMs,
  sleep,
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
        throw new AmazonAdsCredentialProviderError('AMAZON_ADS_TOKEN_TRANSPORT_ERROR', {
          retryable:true,
          cause:error,
        });
      }
      await sleep(Math.min(maxRetryAfterMs, retryBaseMs * (2 ** attempt)));
    }
  }
  throw new AmazonAdsCredentialProviderError('AMAZON_ADS_TOKEN_TRANSPORT_ERROR', {
    retryable:true,
    cause:lastError,
  });
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('amazon_ads_token_timeout'), timeoutMs);
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
    throw new AmazonAdsCredentialProviderError(code, { cause:error });
  }
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

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function finiteNow(now, code) {
  let value;
  try {
    value = Number(now());
  } catch (error) {
    throw new AmazonAdsCredentialProviderError(code, { cause:error });
  }
  if (!Number.isFinite(value)) throw new AmazonAdsCredentialProviderError(code);
  return value;
}

function requiredSecret(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new AmazonAdsCredentialProviderError(code);
  return text;
}

function requiredHttpsUrl(value, code) {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'https:') throw new Error('protocol');
    return url.toString();
  } catch (error) {
    throw new AmazonAdsCredentialProviderError(code, { cause:error });
  }
}

function requiredFunction(value, code) {
  if (typeof value !== 'function') throw new AmazonAdsCredentialProviderError(code);
  return value;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new AmazonAdsCredentialProviderError(code);
  return value;
}

function nonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw new AmazonAdsCredentialProviderError(code);
  return value;
}

function positiveNumber(value, code) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new AmazonAdsCredentialProviderError(code);
  return number;
}
