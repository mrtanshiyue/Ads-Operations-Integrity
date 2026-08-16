import { sourceR2ObjectEtagEvidence } from './source-object-etag.js';

const SOURCE_OBJECT_VERSION_CONTRACT_VERSION = 'store-search-term-source-object-version-v1';
const SOURCE_OBJECT_ETAG_CONTRACT_VERSION = 'store-search-term-source-object-etag-v1';

export function createStoreDailySourceObjectEtagLayer({ env }) {
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

      const gate26ContractReady = validVersionContract(payload.sourceObjectVersionContract);
      const items = Array.isArray(payload.items) ? payload.items : [];
      const enrichedItems = await Promise.all(items.map(async (item) => {
        const eligible = etagEligible(item, gate26ContractReady);
        const observation = eligible
          ? await headCache.observe(nullableText(item.sourceR2ObjectKey))
          : { observed: false, object: null };
        const evidence = sourceR2ObjectEtagEvidence({ eligible }, observation);

        return {
          ...item,
          sourceR2ObjectEtag: evidence.etag,
          sourceR2ObjectEtagObserved: evidence.observed,
          sourceR2ObjectEtagValid: evidence.valid,
        };
      }));

      return new Response(JSON.stringify({
        ...payload,
        sourceObjectEtagContract: {
          schemaVersion: SOURCE_OBJECT_ETAG_CONTRACT_VERSION,
          storageBackend: 'r2',
          observedEtagSource: 'r2_head.etag',
          etagSemantic: 'object_upload_etag',
          verificationMethod: 'head_object_etag',
          eligibilityRule: 'validated_source_r2_object_version',
          evidenceRule: 'cloudflare_r2_object_etag_is_non_empty_string',
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

function validVersionContract(contract) {
  return contract?.schemaVersion === SOURCE_OBJECT_VERSION_CONTRACT_VERSION
    && contract?.storageBackend === 'r2'
    && contract?.observedVersionSource === 'r2_head.version'
    && contract?.versionSemantic === 'specific_object_upload_version'
    && contract?.verificationMethod === 'head_object_version'
    && contract?.eligibilityRule === 'validated_source_r2_object_upload_timestamp'
    && contract?.evidenceRule === 'cloudflare_r2_object_version_is_non_empty_string';
}

function etagEligible(item, gate26ContractReady) {
  return gate26ContractReady
    && item?.sourceR2ObjectVersionObserved === true
    && item?.sourceR2ObjectVersionValid === true
    && nullableText(item?.sourceR2ObjectKey) !== null;
}

function nullableText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}
