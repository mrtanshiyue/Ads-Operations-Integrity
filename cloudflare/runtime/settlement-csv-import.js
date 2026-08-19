const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ROWS = 200_000;
export const SETTLEMENT_CSV_SCHEMA_VERSION = 'settlement-csv-import-v1';
export const SETTLEMENT_REPORT_TYPE = 'amazonSettlementTransaction';

const HEADER_ALIASES = Object.freeze({
  postedAt: ['date/time'],
  settlementId: ['settlement id'],
  transactionType: ['type'],
  orderId: ['order id'],
  sku: ['sku'],
  description: ['description'],
  quantity: ['quantity'],
  marketplace: ['marketplace'],
  accountType: ['account type'],
  fulfillment: ['fulfillment'],
  taxCollectionModel: ['tax collection model'],
  productSales: ['product sales'],
  productSalesTax: ['product sales tax'],
  shippingCredits: ['shipping credits'],
  shippingCreditsTax: ['shipping credits tax'],
  giftWrapCredits: ['gift wrap credits'],
  giftWrapCreditsTax: ['giftwrap credits tax', 'gift wrap credits tax'],
  regulatoryFee: ['regulatory fee'],
  taxOnRegulatoryFee: ['tax on regulatory fee'],
  promotionalRebates: ['promotional rebates'],
  promotionalRebatesTax: ['promotional rebates tax'],
  marketplaceWithheldTax: ['marketplace withheld tax'],
  sellingFees: ['selling fees'],
  fbaFees: ['fba fees'],
  otherTransactionFees: ['other transaction fees'],
  other: ['other'],
  total: ['total'],
  transactionStatus: ['transaction status'],
  transactionReleaseAt: ['transaction release date'],
});

const REQUIRED = Object.freeze([
  'postedAt','settlementId','transactionType','orderId','sku','description','quantity',
  'marketplace','accountType','fulfillment','taxCollectionModel','productSales','productSalesTax',
  'shippingCredits','shippingCreditsTax','giftWrapCredits','giftWrapCreditsTax','regulatoryFee',
  'taxOnRegulatoryFee','promotionalRebates','promotionalRebatesTax','marketplaceWithheldTax',
  'sellingFees','fbaFees','otherTransactionFees','other','total','transactionStatus','transactionReleaseAt',
]);

const MONEY_FIELDS = Object.freeze([
  ['productSales','productSalesMicros'],
  ['productSalesTax','productSalesTaxMicros'],
  ['shippingCredits','shippingCreditsMicros'],
  ['shippingCreditsTax','shippingCreditsTaxMicros'],
  ['giftWrapCredits','giftWrapCreditsMicros'],
  ['giftWrapCreditsTax','giftWrapCreditsTaxMicros'],
  ['regulatoryFee','regulatoryFeeMicros'],
  ['taxOnRegulatoryFee','taxOnRegulatoryFeeMicros'],
  ['promotionalRebates','promotionalRebatesMicros'],
  ['promotionalRebatesTax','promotionalRebatesTaxMicros'],
  ['marketplaceWithheldTax','marketplaceWithheldTaxMicros'],
  ['sellingFees','sellingFeesMicros'],
  ['fbaFees','fbaFeesMicros'],
  ['otherTransactionFees','otherTransactionFeesMicros'],
  ['other','otherMicros'],
]);

const MONTHS = Object.freeze({
  jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
  jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12',
});

export class SettlementCsvImportError extends Error {
  constructor(code, details = null) {
    super(code);
    this.name = 'SettlementCsvImportError';
    this.code = code;
    this.details = details;
  }
}

export async function parseAmazonSettlementCsv({
  csvBytes,
  sourceFileName,
  uploadedAt,
  currencyCode = null,
  marketplace = null,
  maxBytes = DEFAULT_MAX_BYTES,
  maxRows = DEFAULT_MAX_ROWS,
}) {
  const bytes = copyBytes(csvBytes);
  if (bytes.byteLength === 0) throw new SettlementCsvImportError('SETTLEMENT_CSV_EMPTY');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || bytes.byteLength > maxBytes) {
    throw new SettlementCsvImportError('SETTLEMENT_CSV_SIZE_LIMIT_EXCEEDED');
  }
  const fileName = requiredText(sourceFileName, 'SETTLEMENT_SOURCE_FILE_NAME_REQUIRED', 512);
  const timestamp = requiredText(uploadedAt, 'SETTLEMENT_UPLOADED_AT_REQUIRED', 100);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal:true }).decode(bytes);
  } catch {
    throw new SettlementCsvImportError('SETTLEMENT_CSV_UTF8_INVALID');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const allRows = parseCsvRows(text, maxRows + 64);
  const headerIndex = findHeaderIndex(allRows);
  if (headerIndex < 0) throw new SettlementCsvImportError('SETTLEMENT_HEADER_NOT_FOUND');
  const headerRow = allRows[headerIndex];
  const header = buildHeaderMap(headerRow);
  const missing = REQUIRED.filter((key) => header[key] == null);
  if (missing.length) throw new SettlementCsvImportError('SETTLEMENT_REQUIRED_HEADERS_MISSING', { missing });

  const envelopeCurrency = settlementEnvelopeCurrency(allRows.slice(0, headerIndex));
  const suppliedCurrency = optionalText(currencyCode, 10)?.toUpperCase() || null;
  if (envelopeCurrency && suppliedCurrency && envelopeCurrency !== suppliedCurrency) {
    throw new SettlementCsvImportError('SETTLEMENT_CURRENCY_CONTEXT_MISMATCH');
  }
  const finalCurrency = envelopeCurrency || suppliedCurrency;
  if (!/^[A-Z]{3}$/.test(finalCurrency || '')) {
    throw new SettlementCsvImportError('SETTLEMENT_CURRENCY_REQUIRED');
  }
  const suppliedMarketplace = normalizeMarketplace(optionalText(marketplace, 100));
  const contentSha256 = await sha256Hex(bytes);
  const dataRows = allRows.slice(headerIndex + 1).filter((row) => !isBlankRow(row));
  if (!dataRows.length) throw new SettlementCsvImportError('SETTLEMENT_DATA_ROWS_REQUIRED');
  if (dataRows.length > maxRows) throw new SettlementCsvImportError('SETTLEMENT_CSV_ROW_LIMIT_EXCEEDED');

  const canonicalRows = [];
  const errors = [];
  const marketplaces = new Set();
  let componentSumMicros = 0;
  let reportedTotalMicros = 0;
  let mismatchRows = 0;

  for (let index = 0; index < dataRows.length; index += 1) {
    const sourceRowOrdinal = index;
    const row = dataRows[index];
    if (row.length !== headerRow.length) {
      errors.push(rowError('SETTLEMENT_COLUMN_COUNT_MISMATCH', sourceRowOrdinal));
      continue;
    }
    try {
      const fact = canonicalizeRow({
        row, header, sourceRowOrdinal, contentSha256, currencyCode:finalCurrency, suppliedMarketplace,
      });
      if (fact.marketplace) marketplaces.add(fact.marketplace);
      componentSumMicros = safeAdd(componentSumMicros, fact.componentTotalMicros);
      reportedTotalMicros = safeAdd(reportedTotalMicros, fact.totalMicros);
      canonicalRows.push(Object.freeze({
        sourceRowOrdinal,
        logicalRowKey:fact.rowKey,
        canonicalRowJson:JSON.stringify(factForPersistence(fact)),
        fact:Object.freeze(factForPersistence(fact)),
      }));
    } catch (error) {
      if (error instanceof SettlementCsvImportError && error.code === 'SETTLEMENT_ROW_TOTAL_MISMATCH') mismatchRows += 1;
      errors.push(normalizeRowError(error, sourceRowOrdinal));
    }
  }

  if (suppliedMarketplace && marketplaces.size > 0
      && (marketplaces.size !== 1 || !marketplaces.has(suppliedMarketplace))) {
    errors.push(rowError('SETTLEMENT_MARKETPLACE_CONTEXT_MISMATCH', null));
  }
  const dates = canonicalRows.map((entry) => entry.fact.postedDate).sort();
  const rowCount = dataRows.length;
  const batchFailure = errors.some((error) => error.sourceRowOrdinal == null);
  const acceptedRows = batchFailure ? 0 : canonicalRows.length;
  const rejectedRows = batchFailure ? rowCount : rowCount - canonicalRows.length;
  const differenceMicros = safeAdd(componentSumMicros, -reportedTotalMicros);
  const ok = errors.length === 0 && acceptedRows === rowCount && rejectedRows === 0
    && mismatchRows === 0 && differenceMicros === 0;

  return Object.freeze({
    ok,
    schemaVersion:SETTLEMENT_CSV_SCHEMA_VERSION,
    reportType:SETTLEMENT_REPORT_TYPE,
    sourceFileName:fileName,
    contentSha256,
    contentBytes:bytes.byteLength,
    uploadedAt:timestamp,
    reportStartDate:dates[0] || null,
    reportEndDate:dates[dates.length - 1] || null,
    marketplace:marketplaces.size === 1 ? [...marketplaces][0] : suppliedMarketplace,
    currencyCode:finalCurrency,
    rowCount,
    acceptedRows,
    rejectedRows,
    rows:Object.freeze(canonicalRows),
    errors:Object.freeze(errors),
    reconciliation:Object.freeze({
      rowCount:acceptedRows,
      componentSumMicros,
      reportedTotalMicros,
      differenceMicros,
      mismatchRows,
      status:ok ? 'pass' : 'fail',
    }),
    validationSummary:Object.freeze({
      rowCount,acceptedRows,rejectedRows,
      headerLineNumber:headerIndex + 1,
      preambleLineCount:headerIndex,
      currencyCode:finalCurrency,
      marketplaceCount:marketplaces.size,
      errorCodes:Object.freeze(countErrorCodes(errors)),
      reconciliation:Object.freeze({
        componentSumMicros,reportedTotalMicros,differenceMicros,mismatchRows,
      }),
    }),
  });
}

function canonicalizeRow({ row, header, sourceRowOrdinal, contentSha256, currencyCode, suppliedMarketplace }) {
  const postedAt = requiredText(cell(row, header.postedAt), 'SETTLEMENT_POSTED_AT_REQUIRED', 100);
  const postedDate = postedDateFromAmazonTimestamp(postedAt);
  const settlementId = optionalText(cell(row, header.settlementId), 100);
  const transactionType = requiredText(cell(row, header.transactionType), 'SETTLEMENT_TRANSACTION_TYPE_REQUIRED', 100);
  const orderId = optionalText(cell(row, header.orderId), 100);
  const sku = optionalText(cell(row, header.sku), 200);
  const description = optionalText(cell(row, header.description), 2000);
  const quantity = optionalInteger(cell(row, header.quantity));
  const marketplace = normalizeMarketplace(optionalText(cell(row, header.marketplace), 100) || suppliedMarketplace);
  const accountType = optionalText(cell(row, header.accountType), 100);
  const fulfillment = optionalText(cell(row, header.fulfillment), 100);
  const taxCollectionModel = optionalText(cell(row, header.taxCollectionModel), 100);
  const money = {};
  let componentTotalMicros = 0;
  for (const [headerKey, factKey] of MONEY_FIELDS) {
    const value = signedDecimalToMicros(cell(row, header[headerKey]));
    money[factKey] = value;
    componentTotalMicros = safeAdd(componentTotalMicros, value);
  }
  const totalMicros = signedDecimalToMicros(cell(row, header.total));
  if (componentTotalMicros !== totalMicros) {
    throw new SettlementCsvImportError('SETTLEMENT_ROW_TOTAL_MISMATCH', {
      differenceMicros:componentTotalMicros - totalMicros,
    });
  }
  const transactionStatus = optionalText(cell(row, header.transactionStatus), 100);
  const transactionReleaseAt = optionalText(cell(row, header.transactionReleaseAt), 100);
  if (transactionReleaseAt) postedDateFromAmazonTimestamp(transactionReleaseAt);
  const rowKey = `stl:${contentSha256}:${sourceRowOrdinal}`;
  return Object.freeze({
    rowKey,sourceRowOrdinal,postedAt,postedDate,settlementId,transactionType,orderId,sku,description,quantity,
    marketplace,accountType,fulfillment,taxCollectionModel,...money,totalMicros,componentTotalMicros,
    transactionStatus,transactionReleaseAt,currencyCode,
  });
}

function factForPersistence(fact) {
  const { componentTotalMicros:_componentTotalMicros, ...persisted } = fact;
  return persisted;
}

function buildHeaderMap(headerRow) {
  const normalized = headerRow.map(normalizeHeader);
  if (new Set(normalized).size !== normalized.length) {
    throw new SettlementCsvImportError('SETTLEMENT_DUPLICATE_HEADERS');
  }
  const lookup = new Map();
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) lookup.set(normalizeHeader(alias), key);
  }
  const map = {};
  normalized.forEach((value, index) => {
    const key = lookup.get(value);
    if (key) {
      if (map[key] != null) throw new SettlementCsvImportError('SETTLEMENT_AMBIGUOUS_HEADER_ALIAS', { key });
      map[key] = index;
    }
  });
  return Object.freeze(map);
}

function findHeaderIndex(rows) {
  for (let i = 0; i < Math.min(rows.length, 64); i += 1) {
    const normalized = new Set(rows[i].map(normalizeHeader));
    if (normalized.has('date/time') && normalized.has('settlement id')
        && normalized.has('type') && normalized.has('total')
        && normalized.has('transaction status')) return i;
  }
  return -1;
}

function settlementEnvelopeCurrency(rows) {
  for (const row of rows) {
    for (const value of row) {
      const match = String(value || '').match(/\ball amounts in\s+([A-Z]{3})\b/i);
      if (match) return match[1].toUpperCase();
    }
  }
  return null;
}

function postedDateFromAmazonTimestamp(value) {
  const text = String(value || '').trim();
  const match = text.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})\s+/);
  const month = match ? MONTHS[match[1].toLowerCase()] : null;
  if (!match || !month) throw new SettlementCsvImportError('SETTLEMENT_TIMESTAMP_INVALID');
  const day = String(Number(match[2])).padStart(2, '0');
  return `${match[3]}-${month}-${day}`;
}

function signedDecimalToMicros(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') return 0;
  if (!/^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(raw)) {
    throw new SettlementCsvImportError('SETTLEMENT_MONEY_INVALID');
  }
  const text = raw.replace(/,/g, '');
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new SettlementCsvImportError('SETTLEMENT_MONEY_INVALID');
  const fractionRaw = match[3] || '';
  if (fractionRaw.length > 6 && /[1-9]/.test(fractionRaw.slice(6))) {
    throw new SettlementCsvImportError('SETTLEMENT_MONEY_PRECISION_EXCEEDED');
  }
  const fraction = fractionRaw.slice(0, 6).padEnd(6, '0');
  const whole = Number(match[2]);
  const frac = Number(fraction);
  if (!Number.isSafeInteger(whole) || !Number.isSafeInteger(frac)) {
    throw new SettlementCsvImportError('SETTLEMENT_MONEY_RANGE_EXCEEDED');
  }
  let micros = whole * 1_000_000 + frac;
  if (!Number.isSafeInteger(micros)) throw new SettlementCsvImportError('SETTLEMENT_MONEY_RANGE_EXCEEDED');
  if (match[1] === '-') micros = -micros;
  return micros;
}

function optionalInteger(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (!/^[+-]?\d+$/.test(text)) throw new SettlementCsvImportError('SETTLEMENT_QUANTITY_INVALID');
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new SettlementCsvImportError('SETTLEMENT_QUANTITY_RANGE_EXCEEDED');
  return parsed;
}

function parseCsvRows(input, maxRows) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field.length === 0) { quoted = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (!isBlankRow(row)) {
        rows.push(row);
        if (rows.length > maxRows) throw new SettlementCsvImportError('SETTLEMENT_CSV_ROW_LIMIT_EXCEEDED');
      }
      row = [];
      continue;
    }
    field += char;
  }
  if (quoted) throw new SettlementCsvImportError('SETTLEMENT_CSV_UNTERMINATED_QUOTE');
  row.push(field);
  if (!isBlankRow(row)) rows.push(row);
  if (rows.length > maxRows) throw new SettlementCsvImportError('SETTLEMENT_CSV_ROW_LIMIT_EXCEEDED');
  return rows;
}

function normalizeHeader(value) {
  return String(value ?? '').replace(/^\ufeff/u, '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function normalizeMarketplace(value) {
  const text = optionalText(value, 100);
  return text ? text.toLowerCase() : null;
}
function cell(row, index) { return index == null ? '' : row[index] ?? ''; }
function isBlankRow(row) { return row.every((value) => String(value ?? '').trim() === ''); }
function requiredText(value, code, maxLength) {
  const text = String(value ?? '').trim();
  if (!text) throw new SettlementCsvImportError(code);
  if (text.length > maxLength) throw new SettlementCsvImportError('SETTLEMENT_TEXT_TOO_LONG');
  return text;
}
function optionalText(value, maxLength) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.length > maxLength) throw new SettlementCsvImportError('SETTLEMENT_TEXT_TOO_LONG');
  return text;
}
function copyBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw new SettlementCsvImportError('SETTLEMENT_BYTES_REQUIRED');
}
async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}
function safeAdd(a, b) {
  const out = a + b;
  if (!Number.isSafeInteger(out)) throw new SettlementCsvImportError('SETTLEMENT_MONEY_RANGE_EXCEEDED');
  return out;
}
function rowError(code, sourceRowOrdinal, details = null) {
  return Object.freeze({ errorCode:code, sourceRowOrdinal, columnKey:null, safeValueExcerpt:null, details });
}
function normalizeRowError(error, sourceRowOrdinal) {
  if (error instanceof SettlementCsvImportError) return rowError(error.code, sourceRowOrdinal, error.details);
  return rowError('SETTLEMENT_ROW_INVALID', sourceRowOrdinal);
}
function countErrorCodes(errors) {
  const out = {};
  for (const error of errors) out[error.errorCode] = (out[error.errorCode] || 0) + 1;
  return out;
}
