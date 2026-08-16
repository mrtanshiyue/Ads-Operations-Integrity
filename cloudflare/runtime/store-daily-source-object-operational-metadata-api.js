import { sourceR2ObjectOperationalMetadataIdentity } from './source-object-operational-metadata.js';

const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const SOURCE_OBJECT_NATIVE_CHECKSUM_CONTRACT_VERSION = 'store-search-term-source-object-native-checksum-v1';
const SOURCE_OBJECT_OPERATIONAL_METADATA_CONTRACT_VERSION = 'store-search-term-source-object-operational-metadata-v1';
const OPERATIONAL_METADATA_KEYS = ['store_code', 'profile_id', 'report_type', 'ad_product', 'run_id'];

export function createStoreDailySourceObjectOperationalMetadataLayer({ env, url }) {
  const headCache = createHeadCache(env?.DATA_BUCKET);
  const downstreamEnv = headCache.bucket ? { ...(env || {}), DATA_BUCKET: headCache.bucket } : env;

  return {
    env: downstreamEnv,
    async enrich(response) {
      if (!response || response.status !== 200) return response;

      let payload;
      try {
        payload = await response.clone().json();
      } catch {
        return response;
      }
      if (!payload || typeof payload !== 'object') return response;

      const nativeChecksumContractReady = validNativeChecksumContract(payload.sourceObjectNativeChecksumContract);
      const items = Array.isArray(payload.items) ? payload.items : [];
      const eligibleJobIds = [...new Set(items
        .filter((item) => operationalMetadataEligible(item, nativeChecksumContractReady))
        .map((item) => nullableText(item.sourceReportJobId))
        .filter(Boolean))];

      const storeContext = eligibleJobIds.length ? await loadStoreContext(env, url) : null;
      const reportContexts = storeContext
        ? await loadReportContexts(storeContext.storeDb, eligibleJobIds)
        : new Map();

      const enrichedItems = await Promise.all(items.map(async (item) => {
        const expected = expectedOperationalMetadata(item, nativeChecksumContractReady, storeContext, reportContexts);
        const observation = expected.valid
          ? await headCache.observe(nullableText(item.sourceR2ObjectKey))
          : { observed: false, object: null };
        const evidence = sourceR2ObjectOperationalMetadataIdentity(expected, observation);
        return {
          ...item,
          sourceR2ObjectOperationalMetadataObserved: evidence.observed,
          sourceR2ObjectOperationalMetadataIdentityValid: evidence.valid,
        };
      }));

      return new Response(JSON.stringify({
        ...payload,
        sourceObjectOperationalMetadataContract: {
          schemaVersion: SOURCE_OBJECT_OPERATIONAL_METADATA_CONTRACT_VERSION,
          storageBackend: 'r2',
          verificationMethod: 'head_custom_metadata_context',
          metadataKeys: OPERATIONAL_METADATA_KEYS,
          eligibilityRule: 'validated_source_r2_object_native_sha256_identity',
          identityRule: 'r2_operational_metadata_matches_validated_store_report_context',
        },
        items: enrichedItems,
      }), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  };
}

function createHeadCache(bucket) {
  const cache = new Map();
  if (!bucket || typeof bucket.head !== 'function') {
    return {
      bucket: null,
      async observe() { return { observed: false, object: null }; },
    };
  }

  const memoizedBucket = {
    head(key) {
      if (!cache.has(key)) cache.set(key, Promise.resolve().then(() => bucket.head(key)));
      return cache.get(key);
    },
  };

  return {
    bucket: memoizedBucket,
    async observe(key) {
      if (!key) return { observed: false, object: null };
      const promise = cache.get(key);
      if (!promise) return { observed: false, object: null };
      try {
        const object = await promise;
        return { observed: true, object: object || null };
      } catch {
        return { observed: false, object: null };
      }
    },
  };
}

function validNativeChecksumContract(contract) {
  return contract?.schemaVersion === SOURCE_OBJECT_NATIVE_CHECKSUM_CONTRACT_VERSION
    && contract?.storageBackend === 'r2'
    && contract?.verificationMethod === 'head_native_checksum'
    && contract?.checksumField === 'checksums.sha256'
    && contract?.digestAlgorithm === 'sha256'
    && contract?.eligibilityRule === 'validated_source_r2_object_head_metadata_sha256_identity'
    && contract?.identityRule === 'r2_native_sha256_checksum_matches_validated_d1_content_sha256';
}

function operationalMetadataEligible(item, nativeChecksumContractReady) {
  return nativeChecksumContractReady
    && item?.sourceReportJobIdentityValid === true
    && nullableText(item?.sourceReportJobId) !== null
    && item?.sourceR2ObjectNativeChecksumSha256IdentityValid === true
    && nullableText(item?.sourceR2ObjectKey) !== null;
}

async function loadStoreContext(env, url) {
  try {
    const match = url?.pathname?.match(/^\/api\/v1\/stores\/([^/]+)\/search-terms-daily$/);
    const storeId = match ? decodeURIComponent(match[1]) : null;
    if (!storeId || !env?.CONTROL_DB) return null;
    const store = await env.CONTROL_DB.prepare(`
      SELECT store_id, store_code, d1_binding_key, status
      FROM stores
      WHERE store_id = ?1 AND status <> 'disabled'
      LIMIT 1
    `).bind(storeId).first();
    const storeCode = nullableText(store?.store_code);
    const bindingKey = nullableText(store?.d1_binding_key);
    if (!store || !storeCode || !bindingKey || !STORE_BINDINGS.has(bindingKey)) return null;
    const storeDb = env[bindingKey];
    if (!storeDb) return null;
    return { storeId, storeCode, storeDb };
  } catch {
    return null;
  }
}

async function loadReportContexts(storeDb, jobIds) {
  if (!storeDb || !jobIds.length) return new Map();
  try {
    const placeholders = jobIds.map((_, index) => `?${index + 1}`).join(',');
    const result = await storeDb.prepare(`
      SELECT job_id, run_id, profile_id, ad_product, report_type
      FROM report_jobs
      WHERE job_id IN (${placeholders})
    `).bind(...jobIds).all();
    return new Map((result.results || [])
      .map((row) => [nullableText(row.job_id), row])
      .filter(([jobId]) => jobId !== null));
  } catch {
    return new Map();
  }
}

function expectedOperationalMetadata(item, nativeChecksumContractReady, storeContext, reportContexts) {
  if (!operationalMetadataEligible(item, nativeChecksumContractReady) || !storeContext) {
    return invalidExpected();
  }
  const jobId = nullableText(item.sourceReportJobId);
  const report = reportContexts.get(jobId);
  if (!report) return invalidExpected();

  const storeCode = nullableText(storeContext.storeCode);
  const profileId = nullableText(item.profileId);
  const adProduct = nullableText(item.adProduct);
  const reportType = nullableText(report.report_type);
  const runId = nullableText(report.run_id);
  const reportProfileId = nullableText(report.profile_id);
  const reportAdProduct = nullableText(report.ad_product);
  const reportJobId = nullableText(report.job_id);
  const valid = storeCode !== null
    && profileId !== null
    && adProduct !== null
    && reportType !== null
    && runId !== null
    && reportJobId === jobId
    && reportProfileId === profileId
    && reportAdProduct === adProduct;

  return valid
    ? { valid: true, storeCode, profileId, reportType, adProduct, runId }
    : invalidExpected();
}

function invalidExpected() {
  return { valid: false, storeCode: null, profileId: null, reportType: null, adProduct: null, runId: null };
}

function nullableText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}
