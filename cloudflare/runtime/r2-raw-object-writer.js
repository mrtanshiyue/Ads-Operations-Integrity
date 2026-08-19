export class R2RawObjectWriterError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'R2RawObjectWriterError';
    this.code = code;
    this.cause = cause;
  }
}

// Write exactly one raw object through the bound R2 Workers API under a strict create-only
// conditional. This adapter never HEADs, GETs, lists, deletes, overwrites, or backfills an
// ambiguous upload. A null conditional result is converted into an error so the acquisition
// layer can reread durable Store D1 authority before deciding whether a concurrent winner exists.
export function createR2CreateOnlyRawObjectWriter({ bucket } = {}) {
  if (!bucket || typeof bucket.put !== 'function') {
    throw new R2RawObjectWriterError('R2_RAW_WRITER_BUCKET_INVALID');
  }

  return async function putRawObject(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new R2RawObjectWriterError('R2_RAW_WRITER_INPUT_INVALID');
    }
    const key = requiredText(input.key, 'R2_RAW_WRITER_KEY_REQUIRED');
    const bytes = copyBytes(input.bytes);
    const options = normalizeCreateOnlyOptions(input.options);

    let digest;
    try {
      digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    } catch (error) {
      throw new R2RawObjectWriterError('R2_RAW_WRITER_SHA256_FAILED', error);
    }
    if (!equalBytes(digest, new Uint8Array(options.sha256))) {
      throw new R2RawObjectWriterError('R2_RAW_WRITER_SHA256_MISMATCH');
    }

    let object;
    try {
      object = await bucket.put(key, bytes, options);
    } catch (error) {
      throw new R2RawObjectWriterError('R2_RAW_WRITER_PUT_FAILED', error);
    }
    if (!object) {
      throw new R2RawObjectWriterError('R2_RAW_WRITER_CREATE_CONDITION_FAILED');
    }
    return object;
  };
}

function normalizeCreateOnlyOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new R2RawObjectWriterError('R2_RAW_WRITER_OPTIONS_INVALID');
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'onlyIf' || keys[1] !== 'sha256') {
    throw new R2RawObjectWriterError('R2_RAW_WRITER_OPTIONS_NOT_CREATE_ONLY');
  }

  const onlyIf = value.onlyIf;
  if (!onlyIf || typeof onlyIf !== 'object' || Array.isArray(onlyIf)) {
    throw new R2RawObjectWriterError('R2_RAW_WRITER_ONLY_IF_INVALID');
  }
  const conditionalKeys = Object.keys(onlyIf).sort();
  if (conditionalKeys.length !== 1
      || conditionalKeys[0] !== 'etagDoesNotMatch'
      || onlyIf.etagDoesNotMatch !== '*') {
    throw new R2RawObjectWriterError('R2_RAW_WRITER_CREATE_ONLY_CONDITION_REQUIRED');
  }

  // Preserve the internal caller contract while translating the wildcard into the HTTP
  // conditional form R2 Workers bindings implement as create-if-absent. The object-form
  // etagDoesNotMatch:'*' must not be sent to R2 because it can be interpreted as a literal ETag.
  const sha256 = copySha256(value.sha256);
  const conditionalHeaders = new Headers({ 'If-None-Match':'*' });
  return Object.freeze({
    onlyIf:conditionalHeaders,
    sha256,
  });
}

function copyBytes(value) {
  let bytes;
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new R2RawObjectWriterError('R2_RAW_WRITER_BYTES_INVALID');
  }
  return new Uint8Array(bytes);
}

function copySha256(value) {
  let bytes;
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new R2RawObjectWriterError('R2_RAW_WRITER_SHA256_INVALID');
  }
  if (bytes.byteLength !== 32) {
    throw new R2RawObjectWriterError('R2_RAW_WRITER_SHA256_INVALID');
  }
  return new Uint8Array(bytes).buffer;
}

function equalBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new R2RawObjectWriterError(code);
  return text;
}
