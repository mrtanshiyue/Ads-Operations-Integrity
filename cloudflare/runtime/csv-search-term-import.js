import { exactDecimalToMicros, parseNonNegativeInteger } from './amazon-numeric.js';
import { canonicalJson } from './canonical-json.js';

export const CSV_IMPORT_SCHEMA_VERSION = 'csv-import-v1';
export const CSV_SEARCH_TERM_REPORT_TYPE = 'spSearchTerm';
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ROWS = 200_000;
const FORMULA_PREFIX = /^[\t\r\n ]*[=+\-@]/u;

const HEADER_ALIASES = Object.freeze({
  reportDate: ['date', 'report date', 'start date'],
  portfolioName: ['portfolio name', 'portfolio'],
  campaignName: ['campaign name', 'campaign'],
  adGroupName: ['ad group name', 'ad group'],
  targeting: ['targeting', 'keyword', 'target'],
  matchType: ['match type'],
  searchTerm: ['customer search term', 'search term'],
  impressions: ['impressions'],
  clicks: ['clicks'],
  spend: ['spend', 'cost'],
  purchases: ['7 day total orders', '7 day total orders (#)', 'orders'],
  sales: ['7 day total sales', 'sales'],
  unitsSold: ['7 day total units', '7 day total units (#)', 'units'],
  marketplace: ['marketplace'],
  profileId: ['profile id', 'profileid'],
  currencyCode: ['currency', 'currency code'],
});

const REQUIRED = Object.freeze([
  'reportDate', 'campaignName', 'adGroupName', 'targeting', 'searchTerm',
  'impressions', 'clicks', 'spend', 'purchases', 'sales', 'unitsSold',
]);

export class CsvSearchTermImportError extends Error {
  constructor(code, details = null) {
    super(code);
    this.name = 'CsvSearchTermImportError';
    this.code = code;
    this.details = details;
  }
}

export async function parseAmazonSearchTermCsv({
  csvText,
  sourceFileName,
  marketplace = null,
  profileId = null,
  currencyCode = null,
  uploadedAt,
  maxBytes = DEFAULT_MAX_BYTES,
  maxRows = DEFAULT_MAX_ROWS,
}) {
  if (typeof csvText !== 'string') throw new CsvSearchTermImportError('CSV_TEXT_REQUIRED');
  const bytes = new TextEncoder().encode(csvText);
  if (bytes.byteLength === 0) throw new CsvSearchTermImportError('CSV_EMPTY');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || bytes.byteLength > maxBytes) {
    throw new CsvSearchTermImportError('CSV_SIZE_LIMIT_EXCEEDED');
  }
  const fileName = requiredSafeText(sourceFileName, 'CSV_SOURCE_FILE_NAME_REQUIRED');
  const timestamp = requiredText(uploadedAt, 'CSV_UPLOADED_AT_REQUIRED');
  const rows = parseBoundedCsv(csvText, maxRows);
  if (rows.length < 2) throw new CsvSearchTermImportError('CSV_DATA_ROWS_REQUIRED');

  const header = buildHeaderMap(rows[0]);
  const missing = REQUIRED.filter((key) => header[key] == null);
  if (missing.length) throw new CsvSearchTermImportError('CSV_REQUIRED_HEADERS_MISSING', { missing });

  const suppliedContext = Object.freeze({
    marketplace: optionalSafeText(marketplace),
    profileId: optionalSafeText(profileId),
    currencyCode: optionalSafeText(currencyCode)?.toUpperCase() || null,
  });
  const canonicalRows = [];
  const errors = [];
  const rowKeys = new Set();
  const observed = { marketplace:new Set(), profileId:new Set(), currencyCode:new Set() };

  for (let index = 1; index < rows.length; index += 1) {
    const sourceRowOrdinal = index - 1;
    try {
      const fact = await canonicalizeCsvSearchTermRow(rows[index], header, sourceRowOrdinal, suppliedContext);
      if (rowKeys.has(fact.rowKey)) throw new CsvSearchTermImportError('CSV_DUPLICATE_LOGICAL_ROW');
      rowKeys.add(fact.rowKey);
      canonicalRows.push(Object.freeze({
        sourceRowOrdinal,
        logicalRowKey: fact.rowKey,
        canonicalRowJson: canonicalJson(fact),
        fact,
      }));
      collectObserved(observed, fact);
    } catch (error) {
      errors.push(normalizeRowError(error, sourceRowOrdinal));
    }
  }

  validateSingleContext(observed, suppliedContext, errors);
  const dates = canonicalRows.map((row) => row.fact.reportDate).sort();
  const reportStartDate = dates[0] || null;
  const reportEndDate = dates[dates.length - 1] || null;
  const contentSha256 = await sha256Hex(bytes);
  const rowCount = rows.length - 1;
  const batchLevelFailure = errors.some((error) => error.sourceRowOrdinal == null);
  const acceptedRows = batchLevelFailure ? 0 : canonicalRows.length;
  const rejectedRows = batchLevelFailure ? rowCount : rowCount - canonicalRows.length;
  const ok = errors.length === 0 && rejectedRows === 0 && acceptedRows === rowCount && rowCount > 0;

  return Object.freeze({
    ok,
    schemaVersion:CSV_IMPORT_SCHEMA_VERSION,
    reportType:CSV_SEARCH_TERM_REPORT_TYPE,
    sourceFileName:fileName,
    contentSha256,
    contentBytes:bytes.byteLength,
    uploadedAt:timestamp,
    reportStartDate,
    reportEndDate,
    marketplace:singleValue(observed.marketplace) || suppliedContext.marketplace,
    profileId:singleValue(observed.profileId) || suppliedContext.profileId,
    currencyCode:singleValue(observed.currencyCode) || suppliedContext.currencyCode,
    rowCount,
    acceptedRows,
    rejectedRows,
    rows:Object.freeze(canonicalRows),
    errors:Object.freeze(errors),
    validationSummary:Object.freeze({
      rowCount, acceptedRows, rejectedRows,
      errorCodes:Object.freeze(countErrorCodes(errors)),
    }),
  });
}

export function parseBoundedCsv(input, maxRows = DEFAULT_MAX_ROWS) {
  if (typeof input !== 'string') throw new CsvSearchTermImportError('CSV_TEXT_REQUIRED');
  if (!Number.isSafeInteger(maxRows) || maxRows <= 0) throw new CsvSearchTermImportError('CSV_ROW_LIMIT_INVALID');
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"' && field.length === 0) { quoted = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (!isBlankRow(row)) {
        rows.push(row);
        if (rows.length > maxRows + 1) throw new CsvSearchTermImportError('CSV_ROW_LIMIT_EXCEEDED');
      }
      row = [];
      continue;
    }
    field += char;
  }
  if (quoted) throw new CsvSearchTermImportError('CSV_UNTERMINATED_QUOTE');
  row.push(field);
  if (!isBlankRow(row)) rows.push(row);
  if (rows.length > maxRows + 1) throw new CsvSearchTermImportError('CSV_ROW_LIMIT_EXCEEDED');
  const width = rows[0]?.length || 0;
  if (!width) throw new CsvSearchTermImportError('CSV_HEADER_REQUIRED');
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].length !== width) throw new CsvSearchTermImportError('CSV_COLUMN_COUNT_MISMATCH', { row:i + 1 });
  }
  return rows;
}

export function buildHeaderMap(headerRow) {
  if (!Array.isArray(headerRow) || headerRow.length === 0) throw new CsvSearchTermImportError('CSV_HEADER_REQUIRED');
  const normalized = headerRow.map(normalizeHeader);
  if (new Set(normalized).size !== normalized.length) throw new CsvSearchTermImportError('CSV_DUPLICATE_HEADERS');
  const aliasLookup = new Map();
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) aliasLookup.set(normalizeHeader(alias), key);
  }
  const map = {};
  normalized.forEach((header, index) => {
    const key = aliasLookup.get(header);
    if (key) {
      if (map[key] != null) throw new CsvSearchTermImportError('CSV_AMBIGUOUS_HEADER_ALIAS', { key });
      map[key] = index;
    }
  });
  return Object.freeze(map);
}

async function canonicalizeCsvSearchTermRow(row, header, sourceRowOrdinal, context) {
  const reportDate = isoDate(cell(row, header.reportDate));
  const campaignName = requiredSafeText(cell(row, header.campaignName), 'CSV_CAMPAIGN_NAME_REQUIRED');
  const adGroupName = requiredSafeText(cell(row, header.adGroupName), 'CSV_AD_GROUP_NAME_REQUIRED');
  const targeting = requiredSafeText(cell(row, header.targeting), 'CSV_TARGETING_REQUIRED');
  const searchTerm = requiredSafeText(cell(row, header.searchTerm), 'CSV_SEARCH_TERM_REQUIRED');
  const normalizedSearchTerm = normalizeSearchTerm(searchTerm);
  const portfolioName = optionalSafeText(cell(row, header.portfolioName));
  const matchType = optionalSafeText(cell(row, header.matchType))?.toUpperCase() || null;
  const marketplace = optionalSafeText(cell(row, header.marketplace)) || context.marketplace;
  const profileId = optionalSafeText(cell(row, header.profileId)) || context.profileId;
  const currencyCode = (optionalSafeText(cell(row, header.currencyCode)) || context.currencyCode)?.toUpperCase() || null;
  const impressions = parseNonNegativeInteger(cleanInteger(cell(row, header.impressions)), 'CSV_IMPRESSIONS_INVALID');
  const clicks = parseNonNegativeInteger(cleanInteger(cell(row, header.clicks)), 'CSV_CLICKS_INVALID');
  const costMicros = String(exactDecimalToMicros(cleanMoney(cell(row, header.spend))));
  const purchases = parseNonNegativeInteger(cleanInteger(cell(row, header.purchases)), 'CSV_PURCHASES_INVALID');
  const unitsSold = parseNonNegativeInteger(cleanInteger(cell(row, header.unitsSold)), 'CSV_UNITS_INVALID');
  const salesMicros = String(exactDecimalToMicros(cleanMoney(cell(row, header.sales))));
  const rowKey = await buildCsvSearchTermRowKey({
    reportDate, portfolioName, campaignName, adGroupName, targeting, matchType, searchTerm,
  });
  return Object.freeze({
    rowKey, reportDate, portfolioName, campaignName, adGroupName, targeting, matchType,
    searchTerm, normalizedSearchTerm, impressions, clicks, costMicros, purchases, unitsSold,
    salesMicros, marketplace, profileId, currencyCode, sourceRowOrdinal,
  });
}

export async function buildCsvSearchTermRowKey(input) {
  const identity = [
    'csv.search_term_daily.v1', input.reportDate, input.portfolioName || null,
    input.campaignName, input.adGroupName, input.targeting, input.matchType || null, input.searchTerm,
  ];
  return sha256Hex(new TextEncoder().encode(JSON.stringify(identity)));
}

function cleanMoney(value) {
  let text = String(value ?? '').trim();
  if (!text) throw new CsvSearchTermImportError('CSV_MONEY_REQUIRED');
  text = text.replace(/,/g, '');
  text = text.replace(/^[$£€¥]\s*/u, '');
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new CsvSearchTermImportError('CSV_MONEY_INVALID');
  return text;
}

function cleanInteger(value) {
  const text = String(value ?? '').trim().replace(/,/g, '');
  if (!/^\d+$/.test(text)) throw new CsvSearchTermImportError('CSV_INTEGER_INVALID');
  return text;
}

function normalizeHeader(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
}
function normalizeSearchTerm(value) {
  return requiredSafeText(value, 'CSV_SEARCH_TERM_REQUIRED').normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
}
function requiredSafeText(value, code) {
  const text = requiredText(value, code);
  if (FORMULA_PREFIX.test(text)) throw new CsvSearchTermImportError('CSV_FORMULA_INJECTION_BLOCKED');
  return text;
}
function optionalSafeText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (FORMULA_PREFIX.test(text)) throw new CsvSearchTermImportError('CSV_FORMULA_INJECTION_BLOCKED');
  return text;
}
function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new CsvSearchTermImportError(code);
  return text;
}
function cell(row, index) { return index == null ? null : row[index]; }
function isBlankRow(row) { return row.every((value) => String(value ?? '').trim() === ''); }
function isoDate(value) {
  const raw = String(value ?? '').trim();
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const text = mdy ? `${mdy[3]}-${mdy[1].padStart(2,'0')}-${mdy[2].padStart(2,'0')}` : raw;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new CsvSearchTermImportError('CSV_REPORT_DATE_INVALID');
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0,10) !== text) throw new CsvSearchTermImportError('CSV_REPORT_DATE_INVALID');
  return text;
}
function collectObserved(observed, fact) {
  for (const key of Object.keys(observed)) if (fact[key]) observed[key].add(fact[key]);
}
function validateSingleContext(observed, supplied, errors) {
  for (const key of Object.keys(observed)) {
    if (observed[key].size > 1) errors.push(Object.freeze({ sourceRowOrdinal:null, errorCode:`CSV_MIXED_${key.replace(/[A-Z]/g, m => `_${m}`).toUpperCase()}` }));
    const only = singleValue(observed[key]);
    if (supplied[key] && only && supplied[key] !== only) errors.push(Object.freeze({ sourceRowOrdinal:null, errorCode:`CSV_${key.replace(/[A-Z]/g, m => `_${m}`).toUpperCase()}_CONTEXT_MISMATCH` }));
  }
}
function singleValue(set) { return set.size === 1 ? [...set][0] : null; }
function normalizeRowError(error, sourceRowOrdinal) {
  if (error instanceof CsvSearchTermImportError) return Object.freeze({ sourceRowOrdinal, errorCode:error.code });
  return Object.freeze({ sourceRowOrdinal, errorCode:'CSV_ROW_INVALID' });
}
function countErrorCodes(errors) {
  const counts = {};
  for (const error of errors) counts[error.errorCode] = (counts[error.errorCode] || 0) + 1;
  return counts;
}
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2,'0')).join('');
}
