import { parseJsonPreservingNumberLexemes } from './amazon-ads-bootstrap-transport.js';
import { resolveAmazonAdsApiBaseUrl } from './amazon-ads-report-transport.js';
import {
  buildNegativeKeywordTargetReadbackRequest,
  verifyNegativeKeywordTargetReadback,
} from './amazon-execution-reconciliation.js';

export const AMAZON_UNIFIED_TARGET_READ_DISPATCHER_VERSION = 'amazon-unified-target-read-dispatcher-v1';

const QUERY_TARGETS_PATH = '/adsApi/v1/query/targets';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_MAX_RETRY_AFTER_MS = 10_000;

export class AmazonUnifiedTargetReadError extends Error {
  constructor(code, options = {}) {
    super(code);
    this.name = 'AmazonUnifiedTargetReadError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? null;
    this.retryable = Boolean(options.retryable);
    this.cause = options.cause ?? null;
  }
}

export function createAmazonUnifiedTargetReadDispatcher(options = {}) {
  const clientId = requiredText(options.clientId, 'AMAZON_UNIFIED_TARGET_CLIENT_ID_REQUIRED');
  const accessToken = requiredText(options.accessToken, 'AMAZON_UNIFIED_TARGET_ACCESS_TOKEN_REQUIRED');
  const accountId = requiredText(options.accountId, 'AMAZON_UNIFIED_TARGET_ACCOUNT_ID_REQUIRED');
  const profileId = requiredText(options.profileId, 'AMAZON_UNIFIED_TARGET_PROFILE_ID_REQUIRED');
  const apiBaseUrl = options.apiBaseUrl
    ? requiredHttpsUrl(options.apiBaseUrl, 'AMAZON_UNIFIED_TARGET_API_BASE_URL_INVALID')
    : resolveAmazonAdsApiBaseUrl(options.region);
  const fetchImpl = requiredFunction(options.fetchImpl ?? globalThis.fetch, 'AMAZON_UNIFIED_TARGET_FETCH_INVALID');
  const sleep = requiredFunction(options.sleep ?? defaultSleep, 'AMAZON_UNIFIED_TARGET_SLEEP_INVALID');
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'AMAZON_UNIFIED_TARGET_TIMEOUT_INVALID');
  const maxRetries = nonNegativeInteger(options.maxRetries ?? DEFAULT_MAX_RETRIES, 'AMAZON_UNIFIED_TARGET_RETRY_POLICY_INVALID');
  const retryBaseMs = nonNegativeInteger(options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS, 'AMAZON_UNIFIED_TARGET_RETRY_BASE_INVALID');
  const maxRetryAfterMs = positiveInteger(options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS, 'AMAZON_UNIFIED_TARGET_RETRY_AFTER_INVALID');

  return Object.freeze({
    async queryNegativeKeywordTarget({ plan, observedAt = new Date() } = {}) {
      const request = buildNegativeKeywordTargetReadbackRequest(plan);
      if (!request.ready) {
        throw new AmazonUnifiedTargetReadError('AMAZON_UNIFIED_TARGET_READBACK_REQUEST_NOT_READY');
      }
      if (request.method !== 'POST' || request.endpointPath !== QUERY_TARGETS_PATH) {
        throw new AmazonUnifiedTargetReadError('AMAZON_UNIFIED_TARGET_READ_ENDPOINT_NOT_ALLOWLISTED');
      }
      if (text(plan?.action?.profileId) !== profileId) {
        throw new AmazonUnifiedTargetReadError('AMAZON_UNIFIED_TARGET_PROFILE_MISMATCH');
      }

      const response = await fetchWithSafeReadRetries({
        fetchImpl,
        url:`${apiBaseUrl}${QUERY_TARGETS_PATH}`,
        init:{
          method:'POST',
          headers:{
            Authorization:`Bearer ${accessToken}`,
            'Amazon-Ads-AccountId':accountId,
            'Amazon-Ads-ClientId':clientId,
            'Amazon-Advertising-API-Scope':profileId,
            'Content-Type':'application/json',
            Accept:'application/json',
          },
          body:JSON.stringify(request.body),
        },
        timeoutMs,
        maxRetries,
        retryBaseMs,
        maxRetryAfterMs,
        sleep,
      });

      if (!response.ok) {
        throw new AmazonUnifiedTargetReadError('AMAZON_UNIFIED_TARGET_READ_HTTP_ERROR', {
          httpStatus:response.status,
          retryable:isRetryableStatus(response.status),
        });
      }

      let rawBody;
      try {
        rawBody = await response.text();
      } catch (error) {
        throw new AmazonUnifiedTargetReadError('AMAZON_UNIFIED_TARGET_READ_BODY_FAILED', { cause:error });
      }

      let payload;
      try {
        payload = parseJsonPreservingNumberLexemes(rawBody);
      } catch (error) {
        throw new AmazonUnifiedTargetReadError('AMAZON_UNIFIED_TARGET_READ_SCHEMA_INVALID', { cause:error });
      }

      const verification = await verifyNegativeKeywordTargetReadback({
        plan,
        responseBody:payload,
        observedAt,
      });
      const duplicateExists = verification.result === 'confirmed';
      const safeToProceed = verification.result === 'not_found';

      return freeze({
        schemaVersion: AMAZON_UNIFIED_TARGET_READ_DISPATCHER_VERSION,
        requestContract: request.schemaVersion,
        httpStatus: response.status,
        duplicateExists,
        safeToProceed,
        verification,
        readOnlyNetworkDispatchAuthorized: true,
        mutationDispatchAuthorized: false,
        permitRequired: false,
        retryPolicy: 'idempotent_read_only_query_only',
      });
    },
  });
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
        throw new AmazonUnifiedTargetReadError('AMAZON_UNIFIED_TARGET_READ_TRANSPORT_ERROR', {
          retryable:true,
          cause:error,
        });
      }
      await sleep(Math.min(maxRetryAfterMs, retryBaseMs * (2 ** attempt)));
    }
  }
  throw new AmazonUnifiedTargetReadError('AMAZON_UNIFIED_TARGET_READ_TRANSPORT_ERROR', {
    retryable:true,
    cause:lastError,
  });
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('amazon_unified_target_read_timeout'), timeoutMs);
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
  const normalized = text(value);
  if (!normalized) return null;
  if (/^\d+(?:\.\d+)?$/.test(normalized)) return Math.max(0, Math.ceil(Number(normalized) * 1000));
  const date = Date.parse(normalized);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - Date.now());
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
function text(value) { return String(value ?? '').trim(); }
function requiredText(value, code) { const normalized = text(value); if (!normalized) throw new AmazonUnifiedTargetReadError(code); return normalized; }
function requiredHttpsUrl(value, code) { try { const url = new URL(String(value ?? '')); if (url.protocol !== 'https:') throw new Error('protocol'); return url.toString().replace(/\/$/, ''); } catch (error) { throw new AmazonUnifiedTargetReadError(code, { cause:error }); } }
function requiredFunction(value, code) { if (typeof value !== 'function') throw new AmazonUnifiedTargetReadError(code); return value; }
function positiveInteger(value, code) { if (!Number.isSafeInteger(value) || value <= 0) throw new AmazonUnifiedTargetReadError(code); return value; }
function nonNegativeInteger(value, code) { if (!Number.isSafeInteger(value) || value < 0) throw new AmazonUnifiedTargetReadError(code); return value; }
function defaultSleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function freeze(value) { if (Array.isArray(value)) return Object.freeze(value.map((item) => freeze(item))); if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).map(([key,item]) => [key, freeze(item)]))); return value; }
