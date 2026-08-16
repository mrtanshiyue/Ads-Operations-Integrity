import { createAmazonAdsAccessTokenProviderFromEnv } from './amazon-ads-credential-provider.js';

export const AMAZON_ADS_CREDENTIAL_SMOKE_PATH = '/health/amazon-credentials';
export const AMAZON_ADS_CREDENTIAL_SMOKE_HEADERS = Object.freeze({
  timestamp:'x-ads-credential-smoke-timestamp',
  proof:'x-ads-credential-smoke-proof',
});

const DEFAULT_MAX_CLOCK_SKEW_MS = 30_000;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const encoder = new TextEncoder();

export async function handleAmazonAdsCredentialSmoke(request, env, options = {}) {
  if (!request || typeof request !== 'object') return jsonError('credential_smoke_request_invalid', 400);
  if (request.method !== 'POST') {
    return jsonError('credential_smoke_method_not_allowed', 405, null, { allow:'POST' });
  }
  if (env?.APP_ENV !== 'development') return jsonError('not_found', 404);
  if (env?.AMAZON_ADS_ENABLED === 'true') {
    return jsonError('credential_smoke_requires_amazon_ads_disabled', 409);
  }

  const runtimeVersion = runtimeVersionMetadata(env);
  if (!runtimeVersion?.tag || !GIT_SHA_PATTERN.test(runtimeVersion.tag)) {
    return jsonError('credential_smoke_runtime_version_invalid', 503);
  }

  const now = finiteNow(options.now ?? Date.now);
  const maxClockSkewMs = positiveInteger(
    options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS,
    'credential_smoke_clock_skew_invalid',
  );
  const timestamp = parseTimestamp(request.headers?.get?.(AMAZON_ADS_CREDENTIAL_SMOKE_HEADERS.timestamp));
  if (timestamp === null || Math.abs(now - timestamp) > maxClockSkewMs) {
    return jsonError('credential_smoke_request_expired', 401);
  }

  const refreshToken = String(env?.AMAZON_ADS_REFRESH_TOKEN ?? '').trim();
  if (!refreshToken) return jsonError('credential_smoke_not_provisioned', 503);

  const proof = String(request.headers?.get?.(AMAZON_ADS_CREDENTIAL_SMOKE_HEADERS.proof) ?? '').trim();
  const message = buildAmazonAdsCredentialSmokeMessage({
    tag:runtimeVersion.tag,
    timestamp,
  });
  const proofValid = await verifyHmacSha256Hex({
    secret:refreshToken,
    message,
    proof,
    cryptoImpl:options.cryptoImpl ?? globalThis.crypto,
  });
  if (!proofValid) return jsonError('credential_smoke_proof_invalid', 403);

  const credentialProviderFactory = options.credentialProviderFactory
    ?? createAmazonAdsAccessTokenProviderFromEnv;
  try {
    const provider = credentialProviderFactory(env);
    if (!provider || typeof provider.getAccessToken !== 'function') {
      return jsonError('credential_smoke_provider_invalid', 503);
    }
    const accessToken = await provider.getAccessToken();
    if (typeof accessToken !== 'string' || !accessToken.trim()) {
      return jsonError('credential_smoke_access_token_invalid', 502);
    }
  } catch (error) {
    return jsonError('credential_smoke_lwa_refresh_failed', 502, {
      providerCode:optionalText(error?.code ?? error?.message),
      providerHttpStatus:Number.isInteger(error?.httpStatus) ? error.httpStatus : null,
      providerRetryable:Boolean(error?.retryable),
    });
  }

  return jsonResponse({
    ok:true,
    service:'ads-operations-sync',
    environment:'development',
    amazonAdsEnabled:false,
    runtimeVersion,
    credentialSmoke:{
      schemaVersion:'amazon-ads-credential-smoke-v1',
      lwaTokenRefresh:'pass',
      sideEffects:Object.freeze({
        createReport:false,
        pollReport:false,
        downloadReport:false,
        d1Write:false,
        r2Write:false,
      }),
    },
  }, 200);
}

export function buildAmazonAdsCredentialSmokeMessage({ tag, timestamp }) {
  const commit = String(tag ?? '').trim().toLowerCase();
  if (!GIT_SHA_PATTERN.test(commit)) throw new Error('credential_smoke_tag_invalid');
  const issuedAt = Number(timestamp);
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new Error('credential_smoke_timestamp_invalid');
  return [
    'amazon-ads-credential-smoke-v1',
    'POST',
    AMAZON_ADS_CREDENTIAL_SMOKE_PATH,
    commit,
    String(issuedAt),
  ].join('\n');
}

async function verifyHmacSha256Hex({ secret, message, proof, cryptoImpl }) {
  if (!HEX_SHA256_PATTERN.test(proof)) return false;
  if (!cryptoImpl?.subtle) throw new Error('credential_smoke_crypto_unavailable');
  const key = await cryptoImpl.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name:'HMAC', hash:'SHA-256' },
    false,
    ['verify'],
  );
  return cryptoImpl.subtle.verify(
    'HMAC',
    key,
    hexToBytes(proof),
    encoder.encode(message),
  );
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes;
}

function runtimeVersionMetadata(env) {
  const metadata = env?.CF_VERSION_METADATA;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const id = optionalText(metadata.id);
  const tag = optionalText(metadata.tag)?.toLowerCase() ?? null;
  const timestamp = optionalText(metadata.timestamp);
  if (!id && !tag && !timestamp) return null;
  return Object.freeze({ id, tag, timestamp });
}

function parseTimestamp(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{13}$/.test(text)) return null;
  const timestamp = Number(text);
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
}

function finiteNow(now) {
  const value = Number(now());
  if (!Number.isFinite(value)) throw new Error('credential_smoke_now_invalid');
  return value;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
  return value;
}

function optionalText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function jsonError(errorCode, status, details = null, extraHeaders = {}) {
  const body = details ? { ok:false, errorCode, ...details } : { ok:false, errorCode };
  return jsonResponse(body, status, extraHeaders);
}

function jsonResponse(payload, status, extraHeaders = {}) {
  return Response.json(payload, {
    status,
    headers:{
      'cache-control':'no-store',
      'x-content-type-options':'nosniff',
      ...extraHeaders,
    },
  });
}
