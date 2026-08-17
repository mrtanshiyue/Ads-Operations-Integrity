const SEARCH_TERM_COLUMNS = Object.freeze([
  'date', 'campaignId', 'adGroupId',
  'keywordId', 'keywordType', 'keyword', 'matchType', 'targeting', 'searchTerm',
  'campaignBudgetCurrencyCode',
  'impressions', 'clicks', 'cost',
  'purchases1d', 'purchases7d', 'purchases14d', 'purchases30d',
  'unitsSoldClicks1d', 'unitsSoldClicks7d', 'unitsSoldClicks14d', 'unitsSoldClicks30d',
  'sales1d', 'sales7d', 'sales14d', 'sales30d',
]);

const KEYWORD_TYPES = Object.freeze([
  'BROAD', 'PHRASE', 'EXACT', 'TARGETING_EXPRESSION', 'TARGETING_EXPRESSION_PREDEFINED',
]);

export class ReportContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ReportContractError';
    this.code = code;
  }
}

export function resolveReportContract(datasetKey, accountType) {
  if (datasetKey !== 'search_term_daily') throw new ReportContractError('REPORT_DATASET_NOT_IMPLEMENTED');
  const type = String(accountType ?? '').toLowerCase();
  if (type !== 'seller' && type !== 'vendor') throw new ReportContractError('REPORT_ACCOUNT_TYPE_UNSUPPORTED');
  const windowDays = type === 'seller' ? 7 : 14;
  return Object.freeze({
    contractId: 'search_term_daily.sp.v1',
    adProduct: 'SPONSORED_PRODUCTS',
    reportTypeId: 'spSearchTerm',
    groupBy: Object.freeze(['searchTerm']),
    timeUnit: 'DAILY',
    format: 'GZIP_JSON',
    maxPeriodDays: 31,
    retentionDays: 65,
    keywordTypeFilters: KEYWORD_TYPES,
    columns: SEARCH_TERM_COLUMNS,
    attribution: Object.freeze({
      purchases: `purchases${windowDays}d`,
      unitsSold: `unitsSoldClicks${windowDays}d`,
      sales: `sales${windowDays}d`,
      windowDays,
    }),
    parserSemantics: 'amazon-search-term-parser-v1',
  });
}

export function planReportChunks(startDate, endDate, maxPeriodDays = 31) {
  const start = parseIsoDate(startDate, 'REPORT_START_DATE_INVALID');
  const end = parseIsoDate(endDate, 'REPORT_END_DATE_INVALID');
  if (end < start) throw new ReportContractError('REPORT_DATE_RANGE_INVALID');
  if (!Number.isInteger(maxPeriodDays) || maxPeriodDays < 1) throw new ReportContractError('REPORT_MAX_PERIOD_INVALID');

  const chunks = [];
  let cursor = start;
  while (cursor <= end) {
    const chunkEnd = Math.min(end, cursor + (maxPeriodDays - 1) * 86400000);
    chunks.push(Object.freeze({ startDate: iso(cursor), endDate: iso(chunkEnd) }));
    cursor = chunkEnd + 86400000;
  }
  return Object.freeze(chunks);
}

export function buildAmazonReportRequest(contract, chunk) {
  return Object.freeze({
    name: `${contract.contractId}:${chunk.startDate}:${chunk.endDate}`,
    startDate: chunk.startDate,
    endDate: chunk.endDate,
    configuration: Object.freeze({
      adProduct: contract.adProduct,
      groupBy: contract.groupBy,
      columns: contract.columns,
      reportTypeId: contract.reportTypeId,
      timeUnit: contract.timeUnit,
      format: contract.format,
      filters: Object.freeze([{ field: 'keywordType', values: contract.keywordTypeFilters }]),
    }),
  });
}

export async function computeRequestFingerprint({ contract, storeId, profileId, chunk }) {
  const canonical = [
    'amazon-report-request-fingerprint-v1',
    contract.contractId,
    storeId,
    profileId,
    chunk.startDate,
    chunk.endDate,
    contract.adProduct,
    contract.reportTypeId,
    contract.groupBy,
    contract.timeUnit,
    contract.format,
    contract.columns,
    contract.keywordTypeFilters,
    contract.attribution,
    contract.parserSemantics,
  ];
  return sha256Hex(JSON.stringify(canonical));
}

export async function computeReportAcquisitionIdentity({ workflowInstanceId, requestFingerprint }) {
  const digest = await sha256Hex(JSON.stringify([
    'amazon-report-acquisition-v1', workflowInstanceId, requestFingerprint,
  ]));
  return Object.freeze({
    jobId: `amazon-report-${digest}`,
    idempotencyKey: `amazon-ads:${digest}`,
  });
}

function parseIsoDate(value, code) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new ReportContractError(code);
  const ms = Date.parse(`${text}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== text) throw new ReportContractError(code);
  return ms;
}

function iso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
