import { createAmazonAdsBootstrapTransport } from './amazon-ads-bootstrap-transport.js';
import { createAmazonAdsReportTransport } from './amazon-ads-report-transport.js';
import { createD1ProfileProducerRepository } from './amazon-profile-producer.js';
import { createD1EntityMirrorRepository } from './amazon-entity-mirror-producer.js';
import { createD1ReportJobRepository } from './amazon-report-producer.js';
import { prepareProducerBootstrap } from './sync-producer-bootstrap.js';
import {
  createD1ReportCycleSnapshotRepository,
  loadAndDecideReportCycle,
} from './sync-report-cycle-snapshot.js';
import { createCloudflareReportCycleRuntime } from './sync-report-cycle-cloudflare-runtime.js';

const AMAZON_REPORT_DIRECTIVES = new Set([
  'CREATE_AMAZON_REPORT',
  'POLL_AMAZON_REPORT',
  'MATERIALIZE_RAW_OBJECT',
]);

export const AMAZON_ADS_SYNC_DEFAULTS = Object.freeze({
  maxCompressedBytes:8 * 1024 * 1024,
  maxDecompressedBytes:32 * 1024 * 1024,
  pollIntervalMs:30_000,
});

export class AmazonAdsSyncRuntimeError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'AmazonAdsSyncRuntimeError';
    this.code = code;
    this.cause = cause;
  }
}

export function amazonAdsExecutionEnabled(env) {
  return env?.AMAZON_ADS_ENABLED === 'true';
}

export function resolveAmazonAdsSyncPolicy(env = {}) {
  const maxCompressedBytes = optionalPositiveInteger(
    env.AMAZON_ADS_MAX_COMPRESSED_REPORT_BYTES,
    AMAZON_ADS_SYNC_DEFAULTS.maxCompressedBytes,
    'AMAZON_ADS_MAX_COMPRESSED_REPORT_BYTES_INVALID',
  );
  const maxDecompressedBytes = optionalPositiveInteger(
    env.AMAZON_ADS_MAX_DECOMPRESSED_REPORT_BYTES,
    AMAZON_ADS_SYNC_DEFAULTS.maxDecompressedBytes,
    'AMAZON_ADS_MAX_DECOMPRESSED_REPORT_BYTES_INVALID',
  );
  if (maxDecompressedBytes < maxCompressedBytes) {
    throw new AmazonAdsSyncRuntimeError('AMAZON_ADS_REPORT_SIZE_POLICY_INVALID');
  }
  const pollIntervalMs = optionalPositiveInteger(
    env.AMAZON_ADS_REPORT_POLL_INTERVAL_MS,
    AMAZON_ADS_SYNC_DEFAULTS.pollIntervalMs,
    'AMAZON_ADS_REPORT_POLL_INTERVAL_INVALID',
  );
  if (pollIntervalMs < 5_000) {
    throw new AmazonAdsSyncRuntimeError('AMAZON_ADS_REPORT_POLL_INTERVAL_TOO_SMALL');
  }
  return Object.freeze({ maxCompressedBytes, maxDecompressedBytes, pollIntervalMs });
}

// The existing concrete report-cycle factory intentionally binds STORE_01_DB. Route the
// selected store database into that verified internal slot without exposing other store DBs
// or Amazon credentials to the report-cycle dependency graph.
export function createScopedReportCycleEnv(env, storeDb) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new AmazonAdsSyncRuntimeError('AMAZON_ADS_SYNC_ENV_INVALID');
  }
  if (!storeDb || typeof storeDb.prepare !== 'function' || typeof storeDb.batch !== 'function') {
    throw new AmazonAdsSyncRuntimeError('AMAZON_ADS_SYNC_STORE_DB_INVALID');
  }
  if (!env.DATA_BUCKET || typeof env.DATA_BUCKET.get !== 'function' || typeof env.DATA_BUCKET.put !== 'function') {
    throw new AmazonAdsSyncRuntimeError('AMAZON_ADS_SYNC_DATA_BUCKET_INVALID');
  }
  return Object.freeze({
    STORE_01_DB:storeDb,
    DATA_BUCKET:env.DATA_BUCKET,
    AMAZON_ADS_ENABLED:env.AMAZON_ADS_ENABLED,
  });
}

export function requiresAmazonReportTransport(directive) {
  return AMAZON_REPORT_DIRECTIVES.has(String(directive ?? '').trim());
}

export function summarizeReportCycleAdvance(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new AmazonAdsSyncRuntimeError('AMAZON_ADS_REPORT_CYCLE_RESULT_INVALID');
  }
  const nested = result.result && typeof result.result === 'object' && !Array.isArray(result.result)
    ? result.result
    : null;
  const nestedResult = nested?.result && typeof nested.result === 'object' && !Array.isArray(nested.result)
    ? nested.result
    : null;
  const runStatus = optionalText(
    result.status
      ?? nested?.run?.status
      ?? nestedResult?.run?.status,
  );
  return Object.freeze({
    directive:requiredText(result.directive, 'AMAZON_ADS_REPORT_CYCLE_DIRECTIVE_REQUIRED'),
    executed:Boolean(result.executed),
    waiting:Boolean(result.waiting),
    jobId:optionalText(result.jobId),
    reason:optionalText(result.reason),
    action:optionalText(nested?.action ?? nestedResult?.action),
    actionWaiting:Boolean(nested?.waiting ?? nestedResult?.waiting),
    runStatus,
  });
}

export function shouldSleepAfterReportCycleAdvance(result) {
  const summary = result?.directive ? result : summarizeReportCycleAdvance(result);
  return (summary.directive === 'CREATE_AMAZON_REPORT' || summary.directive === 'POLL_AMAZON_REPORT')
    && summary.actionWaiting === true;
}

export async function prepareAmazonAdsProducerRuntime(options = {}) {
  const {
    env,
    execution,
    route,
    storeDb,
    credentialProvider,
    fetchImpl,
    now = defaultNow,
  } = options;
  assertCredentialProvider(credentialProvider);
  const canonicalRoute = validateRoute(route);
  const repositories = Object.freeze({
    profile:createD1ProfileProducerRepository(storeDb),
    entity:createD1EntityMirrorRepository(storeDb),
    report:createD1ReportJobRepository(storeDb),
  });

  const buildReadTransport = async () => {
    const accessToken = await credentialProvider.getAccessToken();
    return createAmazonAdsBootstrapTransport({
      clientId:requiredText(env?.AMAZON_ADS_CLIENT_ID, 'AMAZON_ADS_CLIENT_ID_REQUIRED'),
      accessToken,
      region:canonicalRoute.amazonRegion,
      fetchImpl,
    });
  };

  let bootstrap;
  try {
    bootstrap = await prepareProducerBootstrap({
      execution,
      store:Object.freeze({
        store_id:canonicalRoute.storeId,
        store_code:canonicalRoute.storeCode,
        marketplace_code:canonicalRoute.marketplaceCode,
        amazon_region:canonicalRoute.amazonRegion,
      }),
      repositories,
      adapters:Object.freeze({
        async listProfiles(input) {
          return (await buildReadTransport()).listProfiles(input);
        },
        async fetchEntitySnapshot(input) {
          return (await buildReadTransport()).fetchEntitySnapshot(input);
        },
      }),
      now:resolveNow(now),
    });
  } catch (error) {
    throw new AmazonAdsSyncRuntimeError('AMAZON_ADS_PRODUCER_BOOTSTRAP_FAILED', error);
  }

  return Object.freeze({
    profileId:requiredText(bootstrap?.profile?.profileId, 'AMAZON_ADS_BOOTSTRAP_PROFILE_ID_REQUIRED'),
    reportJobCount:Array.isArray(bootstrap?.reportJobs) ? bootstrap.reportJobs.length : 0,
  });
}

export async function advanceAmazonAdsReportCycle(options = {}) {
  const {
    env,
    route,
    storeDb,
    runId,
    profileId,
    credentialProvider,
    fetchImpl,
    policy = resolveAmazonAdsSyncPolicy(env),
    now = defaultNow,
  } = options;
  assertCredentialProvider(credentialProvider);
  const canonicalRoute = validateRoute(route);
  const canonicalRunId = requiredText(runId, 'AMAZON_ADS_SYNC_RUN_ID_REQUIRED');
  const canonicalProfileId = requiredText(profileId, 'AMAZON_ADS_PROFILE_ID_REQUIRED');
  const scopedEnv = createScopedReportCycleEnv(env, storeDb);

  // Read the durable directive before token acquisition. If this decision requires an Amazon
  // boundary, refresh the access token BEFORE runtime.advance can arm queued -> requested.
  // runtime.advance performs its own second fresh snapshot before any adapter executes.
  let preflight;
  try {
    preflight = await loadAndDecideReportCycle({
      repository:createD1ReportCycleSnapshotRepository(storeDb),
      runId:canonicalRunId,
    });
  } catch (error) {
    throw new AmazonAdsSyncRuntimeError('AMAZON_ADS_REPORT_CYCLE_PREFLIGHT_FAILED', error);
  }

  let amazonTransportAdapters;
  if (requiresAmazonReportTransport(preflight.decision.directive)) {
    const accessToken = await credentialProvider.getAccessToken();
    amazonTransportAdapters = createAmazonAdsReportTransport({
      clientId:requiredText(env?.AMAZON_ADS_CLIENT_ID, 'AMAZON_ADS_CLIENT_ID_REQUIRED'),
      profileId:canonicalProfileId,
      region:canonicalRoute.amazonRegion,
      accessToken,
      fetchImpl,
      maxDownloadBytes:policy.maxCompressedBytes,
    });
  }

  let runtime;
  try {
    runtime = createCloudflareReportCycleRuntime({
      env:scopedEnv,
      ...(amazonTransportAdapters ? { amazonTransportAdapters } : {}),
      storeCode:canonicalRoute.storeCode,
      maxCompressedBytes:policy.maxCompressedBytes,
      maxDecompressedBytes:policy.maxDecompressedBytes,
      now,
    });
  } catch (error) {
    throw new AmazonAdsSyncRuntimeError('AMAZON_ADS_REPORT_CYCLE_RUNTIME_BUILD_FAILED', error);
  }

  try {
    return summarizeReportCycleAdvance(await runtime.advance(canonicalRunId));
  } catch (error) {
    throw new AmazonAdsSyncRuntimeError('AMAZON_ADS_REPORT_CYCLE_ADVANCE_FAILED', error);
  }
}

function validateRoute(route) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    throw new AmazonAdsSyncRuntimeError('AMAZON_ADS_SYNC_ROUTE_INVALID');
  }
  return Object.freeze({
    storeId:requiredText(route.storeId, 'AMAZON_ADS_SYNC_STORE_ID_REQUIRED'),
    storeCode:requiredText(route.storeCode, 'AMAZON_ADS_SYNC_STORE_CODE_REQUIRED'),
    marketplaceCode:requiredText(route.marketplaceCode, 'AMAZON_ADS_SYNC_MARKETPLACE_REQUIRED'),
    amazonRegion:requiredText(route.amazonRegion, 'AMAZON_ADS_SYNC_REGION_REQUIRED'),
  });
}

function assertCredentialProvider(value) {
  if (!value || typeof value.getAccessToken !== 'function') {
    throw new AmazonAdsSyncRuntimeError('AMAZON_ADS_CREDENTIAL_PROVIDER_INVALID');
  }
}

function optionalPositiveInteger(value, fallback, code) {
  if (value == null || String(value).trim() === '') return fallback;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) throw new AmazonAdsSyncRuntimeError(code);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number <= 0) throw new AmazonAdsSyncRuntimeError(code);
  return number;
}

function resolveNow(now) {
  let value;
  try {
    value = typeof now === 'function' ? now() : now;
  } catch (error) {
    throw new AmazonAdsSyncRuntimeError('AMAZON_ADS_SYNC_NOW_FAILED', error);
  }
  return requiredText(value, 'AMAZON_ADS_SYNC_NOW_INVALID');
}

function defaultNow() {
  return new Date().toISOString();
}

function optionalText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function requiredText(value, code) {
  const text = optionalText(value);
  if (!text) throw new AmazonAdsSyncRuntimeError(code);
  return text;
}
