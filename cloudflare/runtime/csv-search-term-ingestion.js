import { parseAmazonSearchTermCsv } from './csv-search-term-import.js';

export class CsvSearchTermIngestionError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'CsvSearchTermIngestionError';
    this.code = code;
    this.cause = cause;
  }
}

export async function ingestSearchTermCsvOnce({ importId, input, repository, now }) {
  const id = requiredText(importId, 'CSV_IMPORT_ID_REQUIRED');
  assertRepository(repository);

  let parsed;
  try {
    parsed = await parseAmazonSearchTermCsv(input);
  } catch (error) {
    throw new CsvSearchTermIngestionError('CSV_IMPORT_PARSE_FAILED', error);
  }

  if (!parsed.reportStartDate || !parsed.reportEndDate) {
    return Object.freeze({
      action:'csv_import_rejected_unpersisted',
      reused:false,
      published:false,
      importId:id,
      parsed,
      batch:null,
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
    });
  }

  if (!parsed.ok) {
    let batch;
    try {
      batch = await repository.recordRejectedImport({ importId:id, parsed, now });
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
    });
  }

  let batch;
  try {
    batch = await repository.commitValidatedImport({ importId:id, parsed, now });
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

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new CsvSearchTermIngestionError(code);
  return text;
}
