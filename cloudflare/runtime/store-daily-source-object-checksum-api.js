import { handleStoreDailySourceObjectMetadataApiRoute } from './store-daily-source-object-metadata-api.js';
import { sourceR2ObjectNativeSha256Identity } from './source-object-checksum.js';

const SOURCE_CONTENT_CONTRACT_VERSION = 'store-search-term-source-content-v1';
const SOURCE_OBJECT_METADATA_CONTRACT_VERSION = 'store-search-term-source-object-metadata-v1';
const SOURCE_OBJECT_NATIVE_CHECKSUM_CONTRACT_VERSION = 'store-search-term-source-object-native-checksum-v1';

export async function handleStoreDailySourceObjectChecksumApiRoute({ request, env, actor, url }) {
  const headCache = createHeadCache(env?.DATA_BUCKET);
  const downstreamEnv = headCache.bucket ? { ...(env || {}), DATA_BUCKET: headCache.bucket } : env;
  const response = await handleStoreDailySourceObjectMetadataApiRoute({
    request,
    env: downstreamEnv,
    actor,
    url,
  });
  if (!response || response.status !== 200) return response;

  let payload;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }
  if (!payload || typeof payload !== 'object') return response;

  const contentContractReady = validSourceContentContract(payload.sourceContentContract);
  const metadataContractReady = validSourceObjectMetadataContract(payload.sourceObjectMetadataContract);
  const items = Array.isArray(payload.items) ? payload.items : [];
  const enrichedItems = await Promise.all(items.map(async (item) => {
    const context = sourceObjectChecksumContext(item, contentContractReady, metadataContractReady);
    const observation = context.eligible
      ? await headCache.observe(context.r2ObjectKey)
      : { observed: false, object: null };
    const evidence = sourceR2ObjectNativeSha256Identity(
      { valid: context.eligible, sha256: context.sha256 },
      { valid: context.eligible },
      observation,
    );
    return {
      ...item,
      sourceR2ObjectNativeChecksumObserved: evidence.observed,
      sourceR2ObjectNativeChecksumSha256: evidence.sha256,
      sourceR2ObjectNativeChecksumSha256IdentityValid: evidence.valid,
    };
  }));

  return new Response(JSON.stringify({
    ...payload,
    sourceObjectNativeChecksumContract: {
      schemaVersion: SOURCE_OBJECT_NATIVE_CHECKSUM_CONTRACT_VERSION,
      storageBackend: 'r2',
      verificationMethod: 'head_native_checksum',
      checksumField: 'checksums.sha256',
      digestAlgorithm: 'sha256',
      eligibilityRule: 'validated_source_r2_object_head_metadata_sha256_identity',
      identityRule: 'r2_native_sha256_checksum_matches_validated_d1_content_sha256',
    },
    items: enrichedItems,
  }), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
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
      if (!cache.has(key)) {
        cache.set(key, Promise.resolve().then(() => bucket.head(key)));
      }
      return cache.get(key);
    },
  };

  return {
    bucket: memoizedBucket,
    async observe(key) {
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

function validSourceContentContract(contract) {
  return contract?.schemaVersion === SOURCE_CONTENT_CONTRACT_VERSION
    && contract?.contentSha256 === 'report_jobs.content_sha256'
    && contract?.digestAlgorithm === 'sha256'
    && contract?.identityRule === 'validated_source_r2_object_identity';
}

function validSourceObjectMetadataContract(contract) {
  return contract?.schemaVersion === SOURCE_OBJECT_METADATA_CONTRACT_VERSION
    && contract?.storageBackend === 'r2'
    && contract?.verificationMethod === 'head_custom_metadata'
    && contract?.metadataKey === 'sha256'
    && contract?.eligibilityRule === 'validated_source_r2_object_head_identity'
    && contract?.identityRule === 'r2_custom_metadata_sha256_matches_validated_d1_content_sha256';
}

function sourceObjectChecksumContext(item, contentContractReady, metadataContractReady) {
  const r2ObjectKey = nullableText(item?.sourceR2ObjectKey);
  const sha256 = canonicalSha256(item?.sourceContentSha256);
  const eligible = contentContractReady
    && metadataContractReady
    && r2ObjectKey !== null
    && sha256 !== null
    && item?.sourceContentSha256IdentityValid === true
    && item?.sourceR2ObjectHeadIdentityValid === true
    && item?.sourceR2ObjectHeadMetadataSha256IdentityValid === true;
  return {
    eligible,
    r2ObjectKey: eligible ? r2ObjectKey : null,
    sha256: eligible ? sha256 : null,
  };
}

function nullableText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function canonicalSha256(value) {
  const text = nullableText(value);
  if (!text || !/^[0-9a-f]{64}$/i.test(text)) return null;
  return text.toLowerCase();
}
