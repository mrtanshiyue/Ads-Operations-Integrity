import { sourceR2ObjectStorageClassEvidence } from './source-object-storage-class.js';

const SOURCE_OBJECT_ETAG_CONTRACT_VERSION = 'store-search-term-source-object-etag-v1';
const SOURCE_OBJECT_STORAGE_CLASS_CONTRACT_VERSION = 'store-search-term-source-object-storage-class-v1';
const SUPPORTED_STORAGE_CLASSES = ['Standard', 'InfrequentAccess'];

export function createStoreDailySourceObjectStorageClassLayer({ env }) {
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

      const gate27ContractReady = validEtagContract(payload.sourceObjectEtagContract);
      const items = Array.isArray(payload.items) ? payload.items : [];
      const enrichedItems = await Promise.all(items.map(async (item) => {
        const eligible = storageClassEligible(item, gate27ContractReady);
        const observation = eligible
          ? await headCache.observe(nullableText(item.sourceR2ObjectKey))
          : { observed: false, object: null };
        const evidence = sourceR2ObjectStorageClassEvidence({ eligible }, observation);

        return {
          ...item,
          sourceR2ObjectStorageClass: evidence.storageClass,
          sourceR2ObjectStorageClassObserved: evidence.observed,
          sourceR2ObjectStorageClassValid: evidence.valid,
        };
      }));

      return new Response(JSON.stringify({
        ...payload,
        sourceObjectStorageClassContract: {
          schemaVersion: SOURCE_OBJECT_STORAGE_CLASS_CONTRACT_VERSION,
          storageBackend: 'r2',
          observedStorageClassSource: 'r2_head.storageClass',
          storageClassSemantic: 'object_storage_class',
          supportedStorageClasses: SUPPORTED_STORAGE_CLASSES,
          verificationMethod: 'head_object_storage_class',
          eligibilityRule: 'validated_source_r2_object_etag',
          evidenceRule: 'cloudflare_r2_storage_class_is_supported',
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

function validEtagContract(contract) {
  return contract?.schemaVersion === SOURCE_OBJECT_ETAG_CONTRACT_VERSION
    && contract?.storageBackend === 'r2'
    && contract?.observedEtagSource === 'r2_head.etag'
    && contract?.etagSemantic === 'object_upload_etag'
    && contract?.verificationMethod === 'head_object_etag'
    && contract?.eligibilityRule === 'validated_source_r2_object_version'
    && contract?.evidenceRule === 'cloudflare_r2_object_etag_is_non_empty_string';
}

function storageClassEligible(item, gate27ContractReady) {
  return gate27ContractReady
    && item?.sourceR2ObjectEtagObserved === true
    && item?.sourceR2ObjectEtagValid === true
    && nullableText(item?.sourceR2ObjectKey) !== null;
}

function nullableText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}
