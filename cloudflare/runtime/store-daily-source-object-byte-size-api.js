import { sourceR2ObjectByteSizeIdentity } from './source-object-byte-size.js';

const STORE_BINDINGS = new Set(['STORE_01_DB', 'STORE_02_DB', 'STORE_03_DB', 'STORE_04_DB']);
const SOURCE_OBJECT_OPERATIONAL_METADATA_CONTRACT_VERSION = 'store-search-term-source-object-operational-metadata-v1';
const SOURCE_OBJECT_BYTE_SIZE_CONTRACT_VERSION = 'store-search-term-source-object-byte-size-v1';
const OPERATIONAL_METADATA_KEYS = ['store_code', 'profile_id', 'report_type', 'ad_product', 'run_id'];

export function createStoreDailySourceObjectByteSizeLayer({ env, url }) {
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

      const gate23ContractReady = validOperationalMetadataContract(payload.sourceObjectOperationalMetadataContract);
      const items = Array.isArray(payload.items) ? payload.items : [];
      const eligibleJobIds = [...new Set(items
        .filter((item) => byteSizeEligible(item, gate23ContractReady))
        .map((item) => nullableText(item.sourceReportJobId))
        .filter(Boolean))];

      const storeDb = eligibleJobIds.length ? await loadStoreDb(env, url) : null;
      const contentBytesByJobId = storeDb
        ? await loadContentBytes(storeDb, eligibleJobIds)
        : new Map();

      const enrichedItems = await Promise.all(items.map(async (item) => {
        const eligible = byteSizeEligible(item, gate23ContractReady);
        const jobId = eligible ? nullableText(item.sourceReportJobId) : null;
        const report = jobId ? contentBytesByJobId.get(jobId) : null;
        const observation = eligible
          ? await headCache.observe(nullableText(item.sourceR2ObjectKey))
          : { observed: false, object: null };
        const evidence = sourceR2ObjectByteSizeIdentity({
          eligible,
          sourceContentBytes: report?.content_bytes,
        }, observation);

        return {
          ...item,
          sourceContentBytes: evidence.sourceContentBytes,
          sourceR2ObjectSizeBytes: evidence.sourceR2ObjectSizeBytes,
          sourceR2ObjectByteSizeObserved: evidence.observed,
          sourceR2ObjectByteSizeIdentityValid: evidence.valid,
        };
      }));

      return new Response(JSON.stringify({
        ...payload,
        sourceObjectByteSizeContract: {
          schemaVersion: SOURCE_OBJECT_BYTE_SIZE_CONTRACT_VERSION,
          storageBackend: 'r2',
          expectedSizeSource: 'report_jobs.content_bytes',
          observedSizeSource: 'r2_head.size',
          sizeUnit: 'bytes',
          verificationMethod: 'head_object_size',
          eligibilityRule: 'validated_source_r2_object_operational_metadata_identity',
          identityRule: 'r2_object_size_matches_validated_d1_content_bytes',
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

function validOperationalMetadataContract(contract) {
  return contract?.schemaVersion === SOURCE_OBJECT_OPERATIONAL_METADATA_CONTRACT_VERSION
    && contract?.storageBackend === 'r2'
    && contract?.verificationMethod === 'head_custom_metadata_context'
    && Array.isArray(contract?.metadataKeys)
    && contract.metadataKeys.length === OPERATIONAL_METADATA_KEYS.length
    && contract.metadataKeys.every((key, index) => key === OPERATIONAL_METADATA_KEYS[index])
    && contract?.eligibilityRule === 'validated_source_r2_object_native_sha256_identity'
    && contract?.identityRule === 'r2_operational_metadata_matches_validated_store_report_context';
}

function byteSizeEligible(item, gate23ContractReady) {
  return gate23ContractReady
    && item?.sourceReportJobIdentityValid === true
    && nullableText(item?.sourceReportJobId) !== null
    && item?.sourceR2ObjectOperationalMetadataObserved === true
    && item?.sourceR2ObjectOperationalMetadataIdentityValid === true
    && nullableText(item?.sourceR2ObjectKey) !== null;
}

async function loadStoreDb(env, url) {
  try {
    const match = url?.pathname?.match(/^\/api\/v1\/stores\/([^/]+)\/search-terms-daily$/);
    const storeId = match ? decodeURIComponent(match[1]) : null;
    if (!storeId || !env?.CONTROL_DB) return null;
    const store = await env.CONTROL_DB.prepare(`
      SELECT store_id, d1_binding_key, status
      FROM stores
      WHERE store_id = ?1 AND status <> 'disabled'
      LIMIT 1
    `).bind(storeId).first();
    const bindingKey = nullableText(store?.d1_binding_key);
    if (!store || !bindingKey || !STORE_BINDINGS.has(bindingKey)) return null;
    return env[bindingKey] || null;
  } catch {
    return null;
  }
}

async function loadContentBytes(storeDb, jobIds) {
  if (!storeDb || !jobIds.length) return new Map();
  try {
    const placeholders = jobIds.map((_, index) => `?${index + 1}`).join(',');
    const result = await storeDb.prepare(`
      SELECT job_id, content_bytes
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

function nullableText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}
