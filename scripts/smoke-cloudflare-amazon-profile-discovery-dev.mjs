import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AMAZON_ADS_PROFILE_DISCOVERY_SMOKE_HEADERS,
  AMAZON_ADS_PROFILE_DISCOVERY_SMOKE_PATH,
  buildAmazonAdsProfileDiscoverySmokeMessage,
} from '../cloudflare/runtime/amazon-ads-profile-discovery-smoke.js';
import { resolveCredentialSmokeGitCommit } from './smoke-cloudflare-amazon-ads-credentials-dev.mjs';

const DEFAULT_ORIGIN = 'https://ads-operations-sync-dev.tanshiyuesir.workers.dev';
const DEFAULT_TIMEOUT_MS = 15_000;

export class CloudflareAmazonProfileDiscoverySmokeError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'CloudflareAmazonProfileDiscoverySmokeError';
    this.code = code;
    this.cause = cause;
  }
}

export function buildAmazonProfileDiscoverySmokeProof({ refreshToken, tag, timestamp }) {
  const secret = requiredText(refreshToken, 'AMAZON_PROFILE_SMOKE_REFRESH_TOKEN_REQUIRED');
  const message = buildAmazonAdsProfileDiscoverySmokeMessage({ tag, timestamp });
  return createHmac('sha256', secret).update(message).digest('hex');
}

export async function runCloudflareAmazonProfileDiscoverySmoke(options = {}) {
  const env = options.env ?? process.env;
  const refreshToken = requiredText(
    options.refreshToken ?? env.AMAZON_ADS_REFRESH_TOKEN,
    'AMAZON_PROFILE_SMOKE_REFRESH_TOKEN_REQUIRED',
  );
  const expectedCommit = resolveCredentialSmokeGitCommit({
    expectedCommit:options.expectedCommit ?? env.EXPECTED_GIT_SHA,
    spawn:options.spawn,
    cwd:options.cwd,
  });
  const timestamp = Number(options.timestamp ?? Date.now());
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new CloudflareAmazonProfileDiscoverySmokeError('AMAZON_PROFILE_SMOKE_TIMESTAMP_INVALID');
  }
  const origin = String(options.origin ?? env.SYNC_DEV_ORIGIN ?? DEFAULT_ORIGIN).trim().replace(/\/+$/, '');
  const url = String(options.url ?? env.SYNC_DEV_PROFILE_SMOKE_URL ?? `${origin}${AMAZON_ADS_PROFILE_DISCOVERY_SMOKE_PATH}`).trim();
  const timeoutMs = positiveInteger(
    Number(options.timeoutMs ?? env.SYNC_DEV_PROFILE_SMOKE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    'AMAZON_PROFILE_SMOKE_TIMEOUT_INVALID',
  );
  const proof = buildAmazonProfileDiscoverySmokeProof({ refreshToken, tag:expectedCommit, timestamp });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new CloudflareAmazonProfileDiscoverySmokeError('AMAZON_PROFILE_SMOKE_FETCH_INVALID');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('profile_smoke_timeout'), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method:'POST',
      headers:{
        accept:'application/json',
        [AMAZON_ADS_PROFILE_DISCOVERY_SMOKE_HEADERS.timestamp]:String(timestamp),
        [AMAZON_ADS_PROFILE_DISCOVERY_SMOKE_HEADERS.proof]:proof,
      },
      signal:controller.signal,
    });
  } catch (error) {
    throw new CloudflareAmazonProfileDiscoverySmokeError('AMAZON_PROFILE_SMOKE_REQUEST_FAILED', error);
  } finally {
    clearTimeout(timer);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new CloudflareAmazonProfileDiscoverySmokeError('AMAZON_PROFILE_SMOKE_RESPONSE_INVALID', error);
  }
  if (!response.ok || payload?.ok !== true) {
    throw new CloudflareAmazonProfileDiscoverySmokeError(
      `AMAZON_PROFILE_SMOKE_FAILED:${response.status}:${String(payload?.errorCode ?? 'unknown')}:${String(payload?.profileCode ?? '')}`,
    );
  }
  if (payload.amazonAdsEnabled !== false) throw new CloudflareAmazonProfileDiscoverySmokeError('AMAZON_PROFILE_SMOKE_KILL_SWITCH_INVALID');
  if (String(payload?.runtimeVersion?.tag ?? '').toLowerCase() !== expectedCommit) {
    throw new CloudflareAmazonProfileDiscoverySmokeError('AMAZON_PROFILE_SMOKE_VERSION_MISMATCH');
  }
  const profile = payload?.profileDiscovery;
  if (!profile || !['seller', 'vendor'].includes(profile.accountType)) {
    throw new CloudflareAmazonProfileDiscoverySmokeError('AMAZON_PROFILE_SMOKE_PROFILE_INVALID');
  }
  const sideEffects = profile.sideEffects;
  if (!sideEffects || Object.values(sideEffects).some((value) => value !== false)) {
    throw new CloudflareAmazonProfileDiscoverySmokeError('AMAZON_PROFILE_SMOKE_SIDE_EFFECT_CONTRACT_INVALID');
  }

  return Object.freeze({
    ok:true,
    expectedCommit,
    runtimeVersionId:payload.runtimeVersion?.id ?? null,
    amazonAdsEnabled:false,
    profile:Object.freeze({
      storeId:profile.storeId,
      storeCode:profile.storeCode,
      profileId:profile.profileId,
      accountType:profile.accountType,
      marketplaceId:profile.marketplaceId,
      countryCode:profile.countryCode,
      currencyCode:profile.currencyCode,
      region:profile.region,
      timezone:profile.timezone ?? null,
    }),
    sideEffects:Object.freeze({ ...sideEffects }),
  });
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new CloudflareAmazonProfileDiscoverySmokeError(code);
  return text;
}

function positiveInteger(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new CloudflareAmazonProfileDiscoverySmokeError(code);
  return value;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const result = await runCloudflareAmazonProfileDiscoverySmoke();
  console.log(JSON.stringify(result, null, 2));
}
