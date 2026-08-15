import { createD1SearchTermFactStageRepository } from './search-term-fact-stage-repository.js';
import { createR2RawObjectReader } from './r2-raw-object-reader.js';
import { createSearchTermIngestionRuntime } from './search-term-ingestion.js';

export class CloudflareSearchTermIngestionRuntimeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'CloudflareSearchTermIngestionRuntimeError';
    this.code = code;
  }
}

export const SEARCH_TERM_INGESTION_BINDINGS = Object.freeze({
  storeDb:'STORE_01_DB',
  dataBucket:'DATA_BUCKET',
});

// Bind the already-verified ingestion components to the exact Cloudflare Native
// Store 01 D1 and raw-data R2 bindings. This factory performs no I/O itself and
// does not expose any R2 write capability.
export function createCloudflareSearchTermIngestionRuntime(options = {}) {
  const {
    env,
    maxCompressedBytes,
    maxDecompressedBytes,
    now,
  } = options;

  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new CloudflareSearchTermIngestionRuntimeError('SEARCH_TERM_INGESTION_ENV_INVALID');
  }

  const db = env[SEARCH_TERM_INGESTION_BINDINGS.storeDb];
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    throw new CloudflareSearchTermIngestionRuntimeError('SEARCH_TERM_INGESTION_STORE_DB_BINDING_INVALID');
  }

  const bucket = env[SEARCH_TERM_INGESTION_BINDINGS.dataBucket];
  if (!bucket || typeof bucket.get !== 'function') {
    throw new CloudflareSearchTermIngestionRuntimeError('SEARCH_TERM_INGESTION_DATA_BUCKET_BINDING_INVALID');
  }

  if (!Number.isSafeInteger(maxCompressedBytes) || maxCompressedBytes <= 0) {
    throw new CloudflareSearchTermIngestionRuntimeError('SEARCH_TERM_INGESTION_COMPRESSED_SIZE_POLICY_INVALID');
  }
  if (!Number.isSafeInteger(maxDecompressedBytes) || maxDecompressedBytes <= 0) {
    throw new CloudflareSearchTermIngestionRuntimeError('SEARCH_TERM_INGESTION_DECOMPRESSED_SIZE_POLICY_INVALID');
  }

  const stageRepository = createD1SearchTermFactStageRepository(db);
  const readRawObject = createR2RawObjectReader({ bucket, maxBytes:maxCompressedBytes });

  return createSearchTermIngestionRuntime({
    stageRepository,
    db,
    readRawObject,
    maxCompressedBytes,
    maxDecompressedBytes,
    now,
  });
}
