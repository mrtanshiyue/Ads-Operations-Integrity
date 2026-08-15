import { sourceR2ObjectUploadTimestampEvidence } from './source-object-upload-timestamp.js';

const SOURCE_OBJECT_BYTE_SIZE_CONTRACT_VERSION = 'store-search-term-source-object-byte-size-v1';
const SOURCE_OBJECT_UPLOAD_TIMESTAMP_CONTRACT_VERSION = 'store-search-term-source-object-upload-timestamp-v1';

export function createStoreDailySourceObjectUploadTimestampLayer({ env }) {
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

      const gate24ContractReady = validByteSizeContract(payload.sourceObjectByteSizeContract);
      const items = Array.isArray(payload.items) ? payload.items : [];
      const enrichedItems = await Promise.all(items.map(async (item) => {
        const eligible = uploadTimestampEligible(item, gate24ContractReady);
        const observation = eligible
          ? await headCache.observe(nullableText(item.sourceR2ObjectKey))
          : { observed: false, object: null };
        const evidence = sourceR2ObjectUploadTimestampEvidence({ eligible }, observation);

        return {
          ...item,
          sourceR2ObjectUploadedAt: evidence.uploadedAt,
          sourceR2ObjectUploadedAtObserved: evidence.observed,
          sourceR2ObjectUploadTimestampValid: evidence.valid,
        };
      }));

      return new Response(JSON.stringify({
        ...payload,
        sourceObjectUploadTimestampContract: {
          schemaVersion: SOURCE_OBJECT_UPLOAD_TIMESTAMP_CONTRACT_VERSION,
          storageBackend: 'r2',
          observedTimestampSource: 'r2_head.uploaded',
          timestampType: 'date',
          timestampSemantic: 'object_upload_time',
          verificationMethod: 'head_object_uploaded_timestamp',
          eligibilityRule: 'validated_source_r2_object_byte_size_identity',
          evidenceRule: 'cloudflare_r2_uploaded_timestamp_is_valid_date',
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

function validByteSizeContract(contract) {
  return contract?.schemaVersion === SOURCE_OBJECT_BYTE_SIZE_CONTRACT_VERSION
    && contract?.storageBackend === 'r2'
    && contract?.expectedSizeSource === 'report_jobs.content_bytes'
    && contract?.observedSizeSource === 'r2_head.size'
    && contract?.sizeUnit === 'bytes'
    && contract?.verificationMethod === 'head_object_size'
    && contract?.eligibilityRule === 'validated_source_r2_object_operational_metadata_identity'
    && contract?.identityRule === 'r2_object_size_matches_validated_d1_content_bytes';
}

function uploadTimestampEligible(item, gate24ContractReady) {
  return gate24ContractReady
    && item?.sourceR2ObjectByteSizeObserved === true
    && item?.sourceR2ObjectByteSizeIdentityValid === true
    && nullableText(item?.sourceR2ObjectKey) !== null;
}

function nullableText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}
