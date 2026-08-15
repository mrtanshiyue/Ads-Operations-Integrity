import { sourceR2ObjectVersionEvidence } from './source-object-version.js';

const SOURCE_OBJECT_UPLOAD_TIMESTAMP_CONTRACT_VERSION = 'store-search-term-source-object-upload-timestamp-v1';
const SOURCE_OBJECT_VERSION_CONTRACT_VERSION = 'store-search-term-source-object-version-v1';

export function createStoreDailySourceObjectVersionLayer({ env }) {
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

      const gate25ContractReady = validUploadTimestampContract(payload.sourceObjectUploadTimestampContract);
      const items = Array.isArray(payload.items) ? payload.items : [];
      const enrichedItems = await Promise.all(items.map(async (item) => {
        const eligible = versionEligible(item, gate25ContractReady);
        const observation = eligible
          ? await headCache.observe(nullableText(item.sourceR2ObjectKey))
          : { observed: false, object: null };
        const evidence = sourceR2ObjectVersionEvidence({ eligible }, observation);

        return {
          ...item,
          sourceR2ObjectVersion: evidence.version,
          sourceR2ObjectVersionObserved: evidence.observed,
          sourceR2ObjectVersionValid: evidence.valid,
        };
      }));

      return new Response(JSON.stringify({
        ...payload,
        sourceObjectVersionContract: {
          schemaVersion: SOURCE_OBJECT_VERSION_CONTRACT_VERSION,
          storageBackend: 'r2',
          observedVersionSource: 'r2_head.version',
          versionSemantic: 'specific_object_upload_version',
          verificationMethod: 'head_object_version',
          eligibilityRule: 'validated_source_r2_object_upload_timestamp',
          evidenceRule: 'cloudflare_r2_object_version_is_non_empty_string',
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

function validUploadTimestampContract(contract) {
  return contract?.schemaVersion === SOURCE_OBJECT_UPLOAD_TIMESTAMP_CONTRACT_VERSION
    && contract?.storageBackend === 'r2'
    && contract?.observedTimestampSource === 'r2_head.uploaded'
    && contract?.timestampType === 'date'
    && contract?.timestampSemantic === 'object_upload_time'
    && contract?.verificationMethod === 'head_object_uploaded_timestamp'
    && contract?.eligibilityRule === 'validated_source_r2_object_byte_size_identity'
    && contract?.evidenceRule === 'cloudflare_r2_uploaded_timestamp_is_valid_date';
}

function versionEligible(item, gate25ContractReady) {
  return gate25ContractReady
    && item?.sourceR2ObjectUploadedAtObserved === true
    && item?.sourceR2ObjectUploadTimestampValid === true
    && nullableText(item?.sourceR2ObjectKey) !== null;
}

function nullableText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}
