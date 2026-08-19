import { createR2CreateOnlyRawObjectWriter } from './r2-raw-object-writer.js';

const SOURCE_KIND = 'manual_csv_upload';
const R2_BINDING_KEY = 'DATA_BUCKET';

export class CsvImportSourceObjectError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'CsvImportSourceObjectError';
    this.code = code;
    this.cause = cause;
  }
}

export function createCsvImportSourceObjectStore({ bucket } = {}) {
  const putRawObject = createR2CreateOnlyRawObjectWriter({ bucket });
  if (!bucket || typeof bucket.get !== 'function') {
    throw new CsvImportSourceObjectError('CSV_SOURCE_BUCKET_INVALID');
  }

  return Object.freeze({
    async describe({ bytes, storeId, sourceFileName, contentType = null, importerUserId, uploadedAt }) {
      const exactBytes = copyBytes(bytes);
      if (exactBytes.byteLength === 0) throw new CsvImportSourceObjectError('CSV_SOURCE_EMPTY');
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', exactBytes));
      const contentSha256 = bytesToHex(digest);
      const safeStoreId = keySegment(storeId, 'CSV_SOURCE_STORE_ID_REQUIRED');
      const fileName = requiredText(sourceFileName, 'CSV_SOURCE_FILE_NAME_REQUIRED');
      const actor = requiredText(importerUserId, 'CSV_SOURCE_IMPORTER_REQUIRED');
      const timestamp = requiredText(uploadedAt, 'CSV_SOURCE_UPLOADED_AT_REQUIRED');
      const objectKey = `csv/raw/${safeStoreId}/spSearchTerm/sha256/${contentSha256.slice(0, 2)}/${contentSha256}`;
      return Object.freeze({
        sourceObjectId:`csv-source-${contentSha256}`,
        sourceKind:SOURCE_KIND,
        r2BindingKey:R2_BINDING_KEY,
        objectKey,
        contentSha256,
        contentBytes:exactBytes.byteLength,
        contentType:optionalText(contentType),
        sourceFileName:fileName,
        importerUserId:actor,
        uploadedAt:timestamp,
        exactBytes,
      });
    },

    async persist(descriptor) {
      assertDescriptor(descriptor);
      let object;
      try {
        object = await putRawObject({
          key:descriptor.objectKey,
          bytes:descriptor.exactBytes,
          options:{
            onlyIf:{ etagDoesNotMatch:'*' },
            sha256:hexToBytes(descriptor.contentSha256).buffer,
          },
        });
      } catch (error) {
        throw new CsvImportSourceObjectError('CSV_SOURCE_R2_PERSIST_FAILED', error);
      }
      return Object.freeze({
        sourceObjectId:descriptor.sourceObjectId,
        sourceKind:descriptor.sourceKind,
        r2BindingKey:descriptor.r2BindingKey,
        objectKey:descriptor.objectKey,
        contentSha256:descriptor.contentSha256,
        contentBytes:descriptor.contentBytes,
        contentType:descriptor.contentType,
        sourceFileName:descriptor.sourceFileName,
        importerUserId:descriptor.importerUserId,
        uploadedAt:descriptor.uploadedAt,
        r2Etag:optionalText(object?.httpEtag || object?.etag),
        r2Version:optionalText(object?.version),
      });
    },

    async verify(receipt) {
      assertReceipt(receipt);
      let object;
      try { object = await bucket.get(receipt.objectKey); }
      catch (error) { throw new CsvImportSourceObjectError('CSV_SOURCE_R2_READ_FAILED', error); }
      if (!object || typeof object.arrayBuffer !== 'function') {
        throw new CsvImportSourceObjectError('CSV_SOURCE_R2_OBJECT_MISSING');
      }
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (bytes.byteLength !== receipt.contentBytes) {
        throw new CsvImportSourceObjectError('CSV_SOURCE_BYTE_LENGTH_MISMATCH');
      }
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const contentSha256 = bytesToHex(digest);
      if (contentSha256 !== receipt.contentSha256) {
        throw new CsvImportSourceObjectError('CSV_SOURCE_SHA256_MISMATCH');
      }
      return Object.freeze({
        ok:true,
        objectKey:receipt.objectKey,
        contentSha256,
        contentBytes:bytes.byteLength,
        bytes,
      });
    },
  });
}

export function bindCsvImportSourceReceipt(importId, persisted) {
  assertReceipt(persisted);
  return Object.freeze({ importId:requiredText(importId, 'CSV_IMPORT_ID_REQUIRED'), ...persisted });
}

function assertDescriptor(value) {
  assertReceipt(value);
  if (!(value.exactBytes instanceof Uint8Array)) throw new CsvImportSourceObjectError('CSV_SOURCE_BYTES_INVALID');
}

function assertReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CsvImportSourceObjectError('CSV_SOURCE_RECEIPT_INVALID');
  }
  requiredText(value.sourceObjectId, 'CSV_SOURCE_OBJECT_ID_REQUIRED');
  if (value.sourceKind !== SOURCE_KIND) throw new CsvImportSourceObjectError('CSV_SOURCE_KIND_INVALID');
  if (value.r2BindingKey !== R2_BINDING_KEY) throw new CsvImportSourceObjectError('CSV_SOURCE_BINDING_INVALID');
  requiredText(value.objectKey, 'CSV_SOURCE_OBJECT_KEY_REQUIRED');
  if (!/^[0-9a-f]{64}$/.test(String(value.contentSha256 || ''))) {
    throw new CsvImportSourceObjectError('CSV_SOURCE_SHA256_INVALID');
  }
  if (!Number.isSafeInteger(value.contentBytes) || value.contentBytes <= 0) {
    throw new CsvImportSourceObjectError('CSV_SOURCE_CONTENT_BYTES_INVALID');
  }
  requiredText(value.sourceFileName, 'CSV_SOURCE_FILE_NAME_REQUIRED');
  requiredText(value.importerUserId, 'CSV_SOURCE_IMPORTER_REQUIRED');
  requiredText(value.uploadedAt, 'CSV_SOURCE_UPLOADED_AT_REQUIRED');
}

function copyBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  throw new CsvImportSourceObjectError('CSV_SOURCE_BYTES_INVALID');
}

function hexToBytes(value) {
  const text = String(value || '');
  if (!/^[0-9a-f]{64}$/.test(text)) throw new CsvImportSourceObjectError('CSV_SOURCE_SHA256_INVALID');
  const out = new Uint8Array(32);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function keySegment(value, code) {
  const text = requiredText(value, code);
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(text)) throw new CsvImportSourceObjectError(code);
  return encodeURIComponent(text);
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new CsvImportSourceObjectError(code);
  return text;
}

function optionalText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}
