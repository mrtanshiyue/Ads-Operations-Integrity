export class RawObjectContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RawObjectContractError';
    this.code = code;
  }
}

export function buildRawObjectKey({ storeCode, profileId, adProduct, reportType, startDate, amazonReportId }) {
  const parts = [storeCode, profileId, adProduct, reportType, amazonReportId].map(pathSegment);
  const date = String(startDate ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RawObjectContractError('RAW_OBJECT_PARTITION_DATE_INVALID');
  return `raw/amazon-ads/${parts[0]}/${parts[1]}/${parts[2]}/${parts[3]}/dt=${date}/${parts[4]}.json.gz`;
}

export async function validateDownloadedRawArtifact({ bytes, contentEncoding, maxCompressedBytes }) {
  const data = asUint8Array(bytes);
  const encoding = String(contentEncoding ?? '').trim().toLowerCase();
  if (encoding && encoding !== 'identity') throw new RawObjectContractError('RAW_DOWNLOAD_CONTENT_ENCODING_UNEXPECTED');
  if (!Number.isSafeInteger(maxCompressedBytes) || maxCompressedBytes <= 0) {
    throw new RawObjectContractError('RAW_DOWNLOAD_SIZE_POLICY_INVALID');
  }
  if (data.byteLength > maxCompressedBytes) throw new RawObjectContractError('RAW_DOWNLOAD_COMPRESSED_LIMIT_EXCEEDED');
  if (data.byteLength < 2 || data[0] !== 0x1f || data[1] !== 0x8b) throw new RawObjectContractError('RAW_DOWNLOAD_GZIP_MAGIC_INVALID');
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Object.freeze({ contentBytes: data.byteLength, contentSha256: bytesToHex(new Uint8Array(digest)) });
}

export function buildCreateOnlyR2PutOptions(contentSha256Hex) {
  return Object.freeze({
    onlyIf: Object.freeze({ etagDoesNotMatch: '*' }),
    sha256: hexToArrayBuffer(contentSha256Hex),
  });
}

export function verifyInitialR2PutReceipt({ expectedKey, expectedSha256, expectedBytes, object }) {
  if (!object) throw new RawObjectContractError('R2_UPLOAD_AMBIGUOUS');
  if (String(object.key ?? '') !== expectedKey) throw new RawObjectContractError('R2_PUT_RECEIPT_KEY_MISMATCH');
  if (!Number.isSafeInteger(object.size) || object.size !== expectedBytes) throw new RawObjectContractError('R2_PUT_RECEIPT_SIZE_MISMATCH');
  if (!object.version) throw new RawObjectContractError('R2_PUT_RECEIPT_VERSION_MISSING');
  if (!object.etag) throw new RawObjectContractError('R2_PUT_RECEIPT_ETAG_MISSING');
  const nativeSha256 = checksumHex(object?.checksums?.sha256);
  if (!nativeSha256 || nativeSha256 !== normalizeSha256(expectedSha256)) {
    throw new RawObjectContractError('R2_PUT_RECEIPT_SHA256_MISMATCH');
  }
  return Object.freeze({ r2InitialVersion: String(object.version), r2InitialEtag: String(object.etag) });
}

export function verifyRawObjectBeforeIngest({ job, observation }) {
  if (!observation?.observed || !observation.object) throw new RawObjectContractError('RAW_OBJECT_MUTATED_BEFORE_INGEST');
  const object = observation.object;
  const nativeSha256 = checksumHex(object?.checksums?.sha256);
  const matches = String(object.version ?? '') === String(job?.r2_initial_version ?? '')
    && String(object.etag ?? '') === String(job?.r2_initial_etag ?? '')
    && Number(object.size) === Number(job?.content_bytes)
    && nativeSha256 === normalizeSha256(job?.content_sha256);
  if (!matches) throw new RawObjectContractError('RAW_OBJECT_MUTATED_BEFORE_INGEST');
  return true;
}

function pathSegment(value) {
  const text = String(value ?? '').trim();
  if (!text || !/^[A-Za-z0-9._:-]+$/.test(text)) throw new RawObjectContractError('RAW_OBJECT_PATH_SEGMENT_INVALID');
  return text;
}

function asUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new RawObjectContractError('RAW_DOWNLOAD_BYTES_INVALID');
}

function normalizeSha256(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new RawObjectContractError('RAW_SHA256_INVALID');
  return text;
}

function checksumHex(value) {
  if (value == null) return null;
  if (value instanceof ArrayBuffer) return bytesToHex(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return bytesToHex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return null;
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToArrayBuffer(value) {
  const hex = normalizeSha256(value);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes.buffer;
}
