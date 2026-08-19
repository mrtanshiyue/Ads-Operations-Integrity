import { parseAmazonSearchTermCsv } from './csv-search-term-import.js';
import { bindCsvImportSourceReceipt } from './csv-import-source-object.js';

export class CsvSearchTermIngestionError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'CsvSearchTermIngestionError';
    this.code = code;
    this.cause = cause;
  }
}

export async function ingestSearchTermCsvOnce({ importId, input, repository, sourceObjectStore, sourceContext, now }) {
  const id = requiredText(importId, 'CSV_IMPORT_ID_REQUIRED');
  assertRepository(repository);
  assertSourceObjectStore(sourceObjectStore);

  let descriptor;
  try {
    descriptor = await sourceObjectStore.describe({
      bytes:input?.sourceBytes,
      storeId:sourceContext?.storeId,
      sourceFileName:input?.sourceFileName,
      contentType:sourceContext?.contentType,
      importerUserId:sourceContext?.importerUserId,
      uploadedAt:input?.uploadedAt,
    });
  } catch (error) {
    throw new CsvSearchTermIngestionError('CSV_IMPORT_SOURCE_DESCRIBE_FAILED', error);
  }

  let parsed;
  try {
    parsed = await parseAmazonSearchTermCsv(input);
  } catch (error) {
    throw new CsvSearchTermIngestionError('CSV_IMPORT_PARSE_FAILED', error);
  }
  parsed = Object.freeze({
    ...parsed,
    contentSha256:descriptor.contentSha256,
    contentBytes:descriptor.contentBytes,
  });

  if (!parsed.reportStartDate || !parsed.reportEndDate) {
    return Object.freeze({
      action:'csv_import_rejected_unpersisted',
      reused:false,
      published:false,
      importId:id,
      parsed,
      batch:null,
      sourceObject:null,
    });
  }

  let duplicate;
  try {
    duplicate = await repository.findDuplicate({
      contentSha256:parsed.contentSha256,
      reportStartDate:parsed.reportStartDate,
      reportEndDate:parsed.reportEndDate,
    });
  } catch (error) {
    throw new CsvSearchTermIngestionError('CSV_IMPORT_DUPLICATE_CHECK_FAILED', error);
  }
  if (duplicate) {
    return Object.freeze({
      action:'csv_import_duplicate',
      reused:true,
      published:duplicate.status === 'published',
      importId:duplicate.import_id,
      parsed,
      batch:duplicate,
      sourceObject:null,
    });
  }

  let persistedSource;
  try {
    persistedSource = await sourceObjectStore.persist(descriptor);
  } catch (error) {
    throw new CsvSearchTermIngestionError('CSV_IMPORT_SOURCE_PERSIST_FAILED', error);
  }
  const sourceObject = bindCsvImportSourceReceipt(id, persistedSource);

  if (!parsed.ok) {
    let batch;
    try {
      batch = await repository.recordRejectedImport({ importId:id, parsed, sourceObject, now });
    } catch (error) {
      throw new CsvSearchTermIngestionError('CSV_IMPORT_REJECTION_PERSIST_FAILED', error);
    }
    return Object.freeze({
      action:'csv_import_rejected',
      reused:false,
      published:false,
      importId:id,
      parsed,
      batch,
      sourceObject,
    });
  }

  let batch;
  try {
    batch = await repository.commitValidatedImport({ importId:id, parsed, sourceObject, now });
  } catch (error) {
    throw new CsvSearchTermIngestionError('CSV_IMPORT_COMMIT_FAILED', error);
  }
  if (!batch || batch.status !== 'published') {
    throw new CsvSearchTermIngestionError('CSV_IMPORT_PUBLISH_RECEIPT_INVALID');
  }
  return Object.freeze({
    action:'csv_import_published',
    reused:false,
    published:true,
    importId:id,
    parsed,
    batch,
    sourceObject,
  });
}

function assertRepository(repository) {
  if (!repository
      || typeof repository.findDuplicate !== 'function'
      || typeof repository.recordRejectedImport !== 'function'
      || typeof repository.commitValidatedImport !== 'function') {
    throw new CsvSearchTermIngestionError('CSV_IMPORT_REPOSITORY_INVALID');
  }
}

function assertSourceObjectStore(store) {
  if (!store || typeof store.describe !== 'function' || typeof store.persist !== 'function') {
    throw new CsvSearchTermIngestionError('CSV_IMPORT_SOURCE_STORE_INVALID');
  }
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new CsvSearchTermIngestionError(code);
  return text;
}
