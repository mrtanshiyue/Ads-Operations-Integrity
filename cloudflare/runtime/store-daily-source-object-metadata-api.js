import { handleStoreDailyApiRoute } from './store-daily-api.js';
import { loadSourceObjectHeads, sourceR2ObjectHeadIdentity } from './source-object-head.js';
import { sourceR2ObjectHeadMetadataSha256Identity } from './source-object-metadata.js';

const SOURCE_CONTENT_CONTRACT_VERSION = 'store-search-term-source-content-v1';
const SOURCE_OBJECT_HEAD_CONTRACT_VERSION = 'store-search-term-source-object-head-v1';
const SOURCE_OBJECT_METADATA_CONTRACT_VERSION = 'store-search-term-source-object-metadata-v1';

export async function handleStoreDailySourceObjectMetadataApiRoute({ request, env, actor, url }) {
  const response = await handleStoreDailyApiRoute({
    request,
    env: gate19Env(env),
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
  const items = Array.isArray(payload.items) ? payload.items : [];
  const contexts = items.map((item) => sourceObjectHeadContext(item, contentContractReady));
  const observations = await loadSourceObjectHeads(env, contexts);
  const enrichedItems = items.map((item, index) => {
    const context = contexts[index];
    const observation = observations.get(context.sourceObject.r2ObjectKey);
    const headEvidence = sourceR2ObjectHeadIdentity(
      context.sourceContent,
      context.sourceObject,
      observation,
    );
    const metadataEvidence = sourceR2ObjectHeadMetadataSha256Identity(
      context.sourceContent,
      headEvidence,
      observation,
    );
    return {
      ...item,
      sourceR2ObjectHeadObserved: headEvidence.observed,
      sourceR2ObjectExists: headEvidence.exists,
      sourceR2ObjectHeadIdentityValid: headEvidence.valid,
      sourceR2ObjectHeadMetadataObserved: metadataEvidence.observed,
      sourceR2ObjectHeadMetadataSha256: metadataEvidence.sha256,
      sourceR2ObjectHeadMetadataSha256IdentityValid: metadataEvidence.valid,
    };
  });

  return new Response(JSON.stringify({
    ...payload,
    sourceObjectHeadContract: {
      schemaVersion: SOURCE_OBJECT_HEAD_CONTRACT_VERSION,
      storageBackend: 'r2',
      verificationMethod: 'head',
      eligibilityRule: 'validated_source_content_sha256',
      identityRule: 'head_key_matches_validated_source_r2_object_key',
    },
    sourceObjectMetadataContract: {
      schemaVersion: SOURCE_OBJECT_METADATA_CONTRACT_VERSION,
      storageBackend: 'r2',
      verificationMethod: 'head_custom_metadata',
      metadataKey: 'sha256',
      eligibilityRule: 'validated_source_r2_object_head_identity',
      identityRule: 'r2_custom_metadata_sha256_matches_validated_d1_content_sha256',
    },
    items: enrichedItems,
  }), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function gate19Env(env) {
  const { DATA_BUCKET: _dataBucket, ...rest } = env || {};
  return rest;
}

function validSourceContentContract(contract) {
  return contract?.schemaVersion === SOURCE_CONTENT_CONTRACT_VERSION
    && contract?.contentSha256 === 'report_jobs.content_sha256'
    && contract?.digestAlgorithm === 'sha256'
    && contract?.identityRule === 'validated_source_r2_object_identity';
}

function sourceObjectHeadContext(item, contentContractReady) {
  const r2ObjectKey = nullableText(item?.sourceR2ObjectKey);
  const sha256 = nullableText(item?.sourceContentSha256);
  const sourceObjectValid = item?.sourceR2ObjectIdentityValid === true && r2ObjectKey !== null;
  const sourceContentValid = contentContractReady
    && sourceObjectValid
    && item?.sourceContentSha256IdentityValid === true
    && sha256 !== null
    && /^[0-9a-f]{64}$/i.test(sha256);
  return {
    sourceObject: { valid: sourceObjectValid, r2ObjectKey: sourceObjectValid ? r2ObjectKey : null },
    sourceContent: { valid: sourceContentValid, sha256: sourceContentValid ? sha256 : null },
  };
}

function nullableText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}
