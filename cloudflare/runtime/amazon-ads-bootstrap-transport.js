import { resolveAmazonAdsApiBaseUrl } from './amazon-ads-report-transport.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_MAX_RETRY_AFTER_MS = 10_000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10_000;

const ENTITY_LIST_SPECS = Object.freeze([
  Object.freeze({
    outputKey:'campaigns',
    responseKey:'campaigns',
    path:'/sp/campaigns/list',
    mediaType:'application/vnd.spCampaign.v3+json',
    includeExtendedDataFields:true,
    normalize:normalizeCampaign,
  }),
  Object.freeze({
    outputKey:'adGroups',
    responseKey:'adGroups',
    path:'/sp/adGroups/list',
    mediaType:'application/vnd.spAdGroup.v3+json',
    includeExtendedDataFields:true,
    normalize:identity,
  }),
  Object.freeze({
    outputKey:'keywords',
    responseKey:'keywords',
    path:'/sp/keywords/list',
    mediaType:'application/vnd.spKeyword.v3+json',
    includeExtendedDataFields:true,
    normalize:identity,
  }),
  Object.freeze({
    outputKey:'targets',
    responseKey:'targetingClauses',
    path:'/sp/targets/list',
    mediaType:'application/vnd.spTargetingClause.v3+json',
    includeExtendedDataFields:false,
    normalize:identity,
  }),
]);

export class AmazonAdsBootstrapTransportError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.name = 'AmazonAdsBootstrapTransportError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? null;
    this.retryable = Boolean(options.retryable);
    this.cause = options.cause ?? null;
  }
}

// JSON.parse immediately rounds numeric tokens through IEEE-754. Entity money contracts
// deliberately reject that authority. Quote every JSON number token before JSON.parse so
// campaign budgets and bids retain the exact decimal lexeme Amazon sent on the wire.
export function parseJsonPreservingNumberLexemes(input) {
  const text = String(input ?? '').replace(/^\uFEFF/, '');
  if (!text.trim()) throw new AmazonAdsBootstrapTransportError('AMAZON_ADS_JSON_BODY_EMPTY');
  let transformed = '';
  let index = 0;
  let inString = false;
  let escaped = false;

  while (index < text.length) {
    const char = text[index];
    if (inString) {
      transformed += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      transformed += char;
      index += 1;
      continue;
    }

    if (char === '-' || (char >= '0' && char <= '9')) {
      const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (!match) throw new AmazonAdsBootstrapTransportError('AMAZON_ADS_JSON_NUMBER_INVALID');
      transformed += JSON.stringify(match[0]);
      index += match[0].length;
      continue;
    }

    transformed += char;
    index += 1;
  }

  try {
    return JSON.parse(transformed);
  } catch (error) {
    throw new AmazonAdsBootstrapTransportError('AMAZON_ADS_JSON_BODY_INVALID', { cause:error });
  }
}

export function createAmazonAdsBootstrapTransport(options = {}) {
  const clientId = requiredText(options.clientId, 'AMAZON_ADS_CLIENT_ID_REQUIRED');
  const accessToken = requiredText(options.accessToken, 'AMAZON_ADS_ACCESS_TOKEN_REQUIRED');
  const apiBaseUrl = options.apiBaseUrl
    ? requiredHttpsUrl(options.apiBaseUrl, 'AMAZON_ADS_API_BASE_URL_INVALID')
    : resolveAmazonAdsApiBaseUrl(options.region);
  const fetchImpl = requiredFunction(options.fetchImpl ?? globalThis.fetch, 'AMAZON_ADS_FETCH_INVALID');
  const sleep = requiredFunction(options.sleep ?? defaultSleep, 'AMAZON_ADS_SLEEP_INVALID');
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'AMAZON_ADS_BOOTSTRAP_TIMEOUT_INVALID');
  const maxRetries = nonNegativeInteger(options.maxRetries ?? DEFAULT_MAX_RETRIES, 'AMAZON_ADS_BOOTSTRAP_RETRY_POLICY_INVALID');
  const retryBaseMs = nonNegativeInteger(options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS, 'AMAZON_ADS_BOOTSTRAP_RETRY_BASE_INVALID');
  const maxRetryAfterMs = positiveInteger(options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS, 'AMAZON_ADS_BOOTSTRAP_RETRY_AFTER_INVALID');
  const pageSize = positiveInteger(options.pageSize ?? DEFAULT_PAGE_SIZE, 'AMAZON_ADS_BOOTSTRAP_PAGE_SIZE_INVALID');
  const maxPages = positiveInteger(options.maxPages ?? DEFAULT_MAX_PAGES, 'AMAZON_ADS_BOOTSTRAP_MAX_PAGES_INVALID');

  const commonHeaders = () => ({
    'authorization':`Bearer ${accessToken}`,
    'amazon-advertising-api-clientid':clientId,
  });

  async function requestJson({ path, method, profileId = null, mediaType = null, body = null }) {
    const headers = commonHeaders();
    if (profileId) headers['amazon-advertising-api-scope'] = profileId;
    if (mediaType) {
      headers.accept = mediaType;
      headers['content-type'] = mediaType;
    }
    const response = await fetchWithSafeReadRetries({
      fetchImpl,
      url:`${apiBaseUrl}${path}`,
      init:{
        method,
        headers,
        ...(body == null ? {} : { body:JSON.stringify(body) }),
      },
      timeoutMs,
      maxRetries,
      retryBaseMs,
      maxRetryAfterMs,
      sleep,
    });
    if (!response.ok) {
      throw new AmazonAdsBootstrapTransportError('AMAZON_ADS_BOOTSTRAP_HTTP_ERROR', {
        httpStatus:response.status,
        retryable:isRetryableStatus(response.status),
      });
    }
    let text;
    try {
      text = await response.text();
    } catch (error) {
      throw new AmazonAdsBootstrapTransportError('AMAZON_ADS_BOOTSTRAP_BODY_READ_FAILED', { cause:error });
    }
    return parseJsonPreservingNumberLexemes(text);
  }

  async function listEntityPages(spec, profileId) {
    const rows = [];
    const seenTokens = new Set();
    let nextToken = null;

    for (let page = 0; page < maxPages; page += 1) {
      const body = {
        maxResults:pageSize,
        ...(spec.includeExtendedDataFields ? { includeExtendedDataFields:true } : {}),
        ...(nextToken ? { nextToken } : {}),
      };
      const payload = await requestJson({
        path:spec.path,
        method:'POST',
        profileId,
        mediaType:spec.mediaType,
        body,
      });
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new AmazonAdsBootstrapTransportError(`AMAZON_ADS_ENTITY_RESPONSE_INVALID:${spec.outputKey}`);
      }
      const pageRows = payload[spec.responseKey];
      if (!Array.isArray(pageRows)) {
        throw new AmazonAdsBootstrapTransportError(`AMAZON_ADS_ENTITY_ROWS_INVALID:${spec.outputKey}`);
      }
      for (const row of pageRows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) {
          throw new AmazonAdsBootstrapTransportError(`AMAZON_ADS_ENTITY_ROW_INVALID:${spec.outputKey}`);
        }
        rows.push(spec.normalize(row));
      }

      const token = optionalText(payload.nextToken);
      if (!token) return Object.freeze(rows);
      if (seenTokens.has(token)) {
        throw new AmazonAdsBootstrapTransportError(`AMAZON_ADS_ENTITY_PAGINATION_LOOP:${spec.outputKey}`);
      }
      seenTokens.add(token);
      nextToken = token;
    }

    throw new AmazonAdsBootstrapTransportError(`AMAZON_ADS_ENTITY_MAX_PAGES_EXCEEDED:${spec.outputKey}`);
  }

  return Object.freeze({
    async listProfiles() {
      const payload = await requestJson({ path:'/v2/profiles', method:'GET' });
      if (!Array.isArray(payload)) throw new AmazonAdsBootstrapTransportError('AMAZON_ADS_PROFILES_RESPONSE_INVALID');
      for (const profile of payload) {
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
          throw new AmazonAdsBootstrapTransportError('AMAZON_ADS_PROFILE_ROW_INVALID');
        }
      }
      return Object.freeze(payload);
    },

    async fetchEntitySnapshot(input) {
      const profileId = requiredText(input?.profile?.profileId ?? input?.profileId, 'AMAZON_ADS_PROFILE_ID_REQUIRED');
      const result = {};
      // Keep list requests sequential. Bootstrap correctness is more important than bursting
      // four independent Sponsored Products throttling buckets on a cold Worker invocation.
      for (const spec of ENTITY_LIST_SPECS) {
        result[spec.outputKey] = await listEntityPages(spec, profileId);
      }
      return Object.freeze(result);
    },
  });
}

function normalizeCampaign(source) {
  const budget = source?.budget;
  const dailyBudget = source?.dailyBudget ?? (
    budget && typeof budget === 'object' && !Array.isArray(budget) ? budget.budget : null
  );
  const dynamicBidding = source?.dynamicBidding;
  const biddingStrategy = source?.biddingStrategy ?? (
    dynamicBidding && typeof dynamicBidding === 'object' && !Array.isArray(dynamicBidding)
      ? dynamicBidding.strategy
      : null
  );
  return Object.freeze({ ...source, dailyBudget, biddingStrategy });
}

function identity(value) {
  return value;
}

async function fetchWithSafeReadRetries({
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
        throw new AmazonAdsBootstrapTransportError('AMAZON_ADS_BOOTSTRAP_TRANSPORT_ERROR', {
          retryable:true,
          cause:error,
        });
      }
      await sleep(Math.min(maxRetryAfterMs, retryBaseMs * (2 ** attempt)));
    }
  }
  throw new AmazonAdsBootstrapTransportError('AMAZON_ADS_BOOTSTRAP_TRANSPORT_ERROR', {
    retryable:true,
    cause:lastError,
  });
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('amazon_ads_bootstrap_timeout'), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal:controller.signal });
  } finally {
    clearTimeout(timer);
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

function optionalText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new AmazonAdsBootstrapTransportError(code);
  return text;
}

function requiredHttpsUrl(value, code) {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'https:') throw new Error('protocol');
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    throw new AmazonAdsBootstrapTransportError(code, { cause:error });
  }
}

function requiredFunction(value, code) {
  if (typeof value !== 'function') throw new AmazonAdsBootstrapTransportError(code);
  return value;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new AmazonAdsBootstrapTransportError(code);
  return value;
}

function nonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw new AmazonAdsBootstrapTransportError(code);
  return value;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
