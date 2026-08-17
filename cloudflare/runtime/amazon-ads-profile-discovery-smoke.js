import { createAmazonAdsAccessTokenProviderFromEnv } from './amazon-ads-credential-provider.js';
import { createAmazonAdsBootstrapTransport } from './amazon-ads-bootstrap-transport.js';
import { resolveCanonicalProfile } from './amazon-profile-contract.js';

export const AMAZON_ADS_PROFILE_DISCOVERY_SMOKE_PATH = '/health/amazon-profile';
export const AMAZON_ADS_PROFILE_DISCOVERY_SMOKE_HEADERS = Object.freeze({
  timestamp:'x-ads-profile-smoke-timestamp',
  proof:'x-ads-profile-smoke-proof',
});

const STORE_ID = 'store-dev-01';
const DEFAULT_MAX_CLOCK_SKEW_MS = 30_000;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const encoder = new TextEncoder();

export async function handleAmazonAdsProfileDiscoverySmoke(request, env, options = {}) {
  if (!request || typeof request !== 'object') return jsonError('profile_smoke_request_invalid', 400);
  if (request.method !== 'POST') return jsonError('profile_smoke_method_not_allowed', 405, null, { allow:'POST' });
  if (env?.APP_ENV !== 'development') return jsonError('not_found', 404);
  if (env?.AMAZON_ADS_ENABLED === 'true') {
    return jsonError('profile_smoke_requires_amazon_ads_disabled', 409);
  }

  const runtimeVersion = runtimeVersionMetadata(env);
  if (!runtimeVersion?.tag || !GIT_SHA_PATTERN.test(runtimeVersion.tag)) {
    return jsonError('profile_smoke_runtime_version_invalid', 503);
  }

  const now = finiteNow(options.now ?? Date.now);
  const maxClockSkewMs = positiveInteger(options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS);
  const timestamp = parseTimestamp(request.headers?.get?.(AMAZON_ADS_PROFILE_DISCOVERY_SMOKE_HEADERS.timestamp));
  if (timestamp === null || Math.abs(now - timestamp) > maxClockSkewMs) {
    return jsonError('profile_smoke_request_expired', 401);
  }

  const refreshToken = String(env?.AMAZON_ADS_REFRESH_TOKEN ?? '').trim();
  if (!refreshToken) return jsonError('profile_smoke_not_provisioned', 503);
  const proof = String(request.headers?.get?.(AMAZON_ADS_PROFILE_DISCOVERY_SMOKE_HEADERS.proof) ?? '').trim();
  const message = buildAmazonAdsProfileDiscoverySmokeMessage({ tag:runtimeVersion.tag, timestamp });
  const proofValid = await verifyHmacSha256Hex({
    secret:refreshToken,
    message,
    proof,
    cryptoImpl:options.cryptoImpl ?? globalThis.crypto,
  });
  if (!proofValid) return jsonError('profile_smoke_proof_invalid', 403);

  const controlDb = env?.CONTROL_DB;
  if (!controlDb || typeof controlDb.prepare !== 'function') {
    return jsonError('profile_smoke_control_db_unavailable', 503);
  }

  let store;
  try {
    store = await controlDb.prepare(`
      SELECT store_id, store_code, marketplace_code, amazon_region, status
      FROM stores
      WHERE store_id = ?1
      LIMIT 1
    `).bind(STORE_ID).first();
  } catch {
    return jsonError('profile_smoke_store_route_read_failed', 503);
  }
  if (!store || store.status !== 'active') return jsonError('profile_smoke_store_not_active', 409);

  const credentialProviderFactory = options.credentialProviderFactory ?? createAmazonAdsAccessTokenProviderFromEnv;
  const transportFactory = options.transportFactory ?? createAmazonAdsBootstrapTransport;

  let canonical;
  try {
    const provider = credentialProviderFactory(env);
    if (!provider || typeof provider.getAccessToken !== 'function') {
      return jsonError('profile_smoke_provider_invalid', 503);
    }
    const accessToken = await provider.getAccessToken();
    if (typeof accessToken !== 'string' || !accessToken.trim()) {
      return jsonError('profile_smoke_access_token_invalid', 502);
    }
    const transport = transportFactory({
      clientId:String(env?.AMAZON_ADS_CLIENT_ID ?? '').trim(),
      accessToken,
      region:store.amazon_region,
      fetchImpl:options.fetchImpl,
    });
    if (!transport || typeof transport.listProfiles !== 'function') {
      return jsonError('profile_smoke_transport_invalid', 503);
    }
    const profiles = await transport.listProfiles();
    canonical = resolveCanonicalProfile(store, profiles);
  } catch (error) {
    const code = optionalText(error?.code ?? error?.message);
    if (code && [
      'CANONICAL_PROFILE_NOT_FOUND',
      'CANONICAL_PROFILE_AMBIGUOUS',
      'PROFILE_ACCOUNT_TYPE_UNSUPPORTED',
      'STORE_MARKETPLACE_UNSUPPORTED',
      'STORE_AMAZON_REGION_MISMATCH',
    ].includes(code)) {
      return jsonError('profile_smoke_canonical_profile_rejected', 409, { profileCode:code });
    }
    return jsonError('profile_smoke_amazon_read_failed', 502, {
      providerCode:code,
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
    profileDiscovery:{
      schemaVersion:'amazon-ads-profile-discovery-smoke-v1',
      storeId:STORE_ID,
      storeCode:String(store.store_code || ''),
      profileId:canonical.profileId,
      accountType:canonical.accountType,
      marketplaceId:canonical.marketplaceId,
      countryCode:canonical.countryCode,
      currencyCode:canonical.currencyCode,
      region:canonical.region,
      timezone:canonical.timezone,
      sideEffects:Object.freeze({
        controlD1Write:false,
        storeD1Read:false,
        storeD1Write:false,
        entityRead:false,
        createReport:false,
        pollReport:false,
        downloadReport:false,
        r2Read:false,
        r2Write:false,
      }),
    },
  }, 200);
}

export function buildAmazonAdsProfileDiscoverySmokeMessage({ tag, timestamp }) {
  const commit = String(tag ?? '').trim().toLowerCase();
  if (!GIT_SHA_PATTERN.test(commit)) throw new Error('profile_smoke_tag_invalid');
  const issuedAt = Number(timestamp);
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) throw new Error('profile_smoke_timestamp_invalid');
  return [
    'amazon-ads-profile-discovery-smoke-v1',
    'POST',
    AMAZON_ADS_PROFILE_DISCOVERY_SMOKE_PATH,
    commit,
    String(issuedAt),
  ].join('\n');
}

async function verifyHmacSha256Hex({ secret, message, proof, cryptoImpl }) {
  if (!HEX_SHA256_PATTERN.test(proof)) return false;
  if (!cryptoImpl?.subtle) throw new Error('profile_smoke_crypto_unavailable');
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
  if (!Number.isFinite(value)) throw new Error('profile_smoke_now_invalid');
  return value;
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('profile_smoke_clock_skew_invalid');
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
