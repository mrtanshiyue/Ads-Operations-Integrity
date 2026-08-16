export class R2RawObjectReaderError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'R2RawObjectReaderError';
    this.code = code;
    this.cause = cause;
  }
}

// Read exactly one immutable raw object through the bound R2 Workers API.
// This adapter is deliberately GET-only: it never HEADs, PUTs, lists, backfills, or
// invents provenance. Durable Store D1 receipts remain the authority checked by the
// downstream stage producer.
export function createR2RawObjectReader({ bucket, maxBytes }) {
  if (!bucket || typeof bucket.get !== 'function') {
    throw new R2RawObjectReaderError('R2_RAW_READER_BUCKET_INVALID');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new R2RawObjectReaderError('R2_RAW_READER_SIZE_POLICY_INVALID');
  }

  return async function readRawObject(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new R2RawObjectReaderError('R2_RAW_READER_INPUT_INVALID');
    }
    const key = requiredText(input.key, 'R2_RAW_READER_KEY_REQUIRED');
    requiredText(input.jobId, 'R2_RAW_READER_JOB_ID_REQUIRED');

    let object;
    try {
      object = await bucket.get(key);
    } catch (error) {
      throw new R2RawObjectReaderError('R2_RAW_READER_GET_FAILED', error);
    }
    if (!object) throw new R2RawObjectReaderError('R2_RAW_READER_OBJECT_NOT_FOUND');
    if (String(object.key ?? '') !== key) {
      throw new R2RawObjectReaderError('R2_RAW_READER_KEY_MISMATCH');
    }

    const version = requiredText(object.version, 'R2_RAW_READER_VERSION_MISSING');
    const etag = requiredText(object.etag, 'R2_RAW_READER_ETAG_MISSING');
    if (!Number.isSafeInteger(object.size) || object.size < 0) {
      throw new R2RawObjectReaderError('R2_RAW_READER_SIZE_INVALID');
    }
    if (object.size > maxBytes) {
      throw new R2RawObjectReaderError('R2_RAW_READER_SIZE_LIMIT_EXCEEDED');
    }
    const sha256 = copySha256(object?.checksums?.sha256);
    if (typeof object.arrayBuffer !== 'function') {
      throw new R2RawObjectReaderError('R2_RAW_READER_BODY_UNAVAILABLE');
    }

    let body;
    try {
      body = await object.arrayBuffer();
    } catch (error) {
      throw new R2RawObjectReaderError('R2_RAW_READER_BODY_READ_FAILED', error);
    }
    const bytes = asUint8Array(body);
    if (bytes.byteLength !== object.size) {
      throw new R2RawObjectReaderError('R2_RAW_READER_BODY_SIZE_MISMATCH');
    }

    return Object.freeze({
      key,
      size:object.size,
      version,
      etag,
      checksums:Object.freeze({ sha256 }),
      bytes,
    });
  };
}

function copySha256(value) {
  let bytes;
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new R2RawObjectReaderError('R2_RAW_READER_SHA256_MISSING');
  }
  if (bytes.byteLength !== 32) {
    throw new R2RawObjectReaderError('R2_RAW_READER_SHA256_INVALID');
  }
  return new Uint8Array(bytes).buffer;
}

function asUint8Array(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new R2RawObjectReaderError('R2_RAW_READER_BODY_INVALID');
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new R2RawObjectReaderError(code);
  return text;
}
