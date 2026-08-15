import { parseAmazonId, parseNonNegativeInteger, exactDecimalToMicros } from './amazon-numeric.js';
import { canonicalJson } from './canonical-json.js';

const KEYWORD_KINDS = new Set(['BROAD', 'PHRASE', 'EXACT']);
const TARGET_KINDS = new Set(['TARGETING_EXPRESSION', 'TARGETING_EXPRESSION_PREDEFINED']);
const WINDOWS = [1, 7, 14, 30];

export class SearchTermParserError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SearchTermParserError';
    this.code = code;
  }
}

export function classifySearchTermTargeting({ keywordType, keywordId }) {
  const type = String(keywordType ?? '').trim().toUpperCase();
  const id = parseAmazonId(keywordId);
  if (KEYWORD_KINDS.has(type)) {
    return Object.freeze({ sourceKeywordType: type, targetingKind: 'keyword', keywordId: id, targetId: null });
  }
  if (TARGET_KINDS.has(type)) {
    return Object.freeze({ sourceKeywordType: type, targetingKind: 'target', keywordId: null, targetId: id });
  }
  throw new SearchTermParserError('SOURCE_KEYWORD_TYPE_UNSUPPORTED');
}

export function normalizeSearchTermV1(value) {
  if (typeof value !== 'string') throw new SearchTermParserError('SOURCE_SEARCH_TERM_INVALID');
  const raw = value;
  const normalized = raw.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
  if (!normalized) throw new SearchTermParserError('SOURCE_SEARCH_TERM_EMPTY');
  return normalized;
}

export async function canonicalizeSearchTermFact({ row, profileId, accountType, sourceReportJobId }) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new SearchTermParserError('SOURCE_ROW_INVALID');
  const reportDate = isoDate(row.date);
  const canonicalProfileId = parseAmazonId(profileId);
  const campaignId = parseAmazonId(row.campaignId);
  const adGroupId = parseAmazonId(row.adGroupId);
  const targeting = classifySearchTermTargeting({ keywordType: row.keywordType, keywordId: row.keywordId });
  const rawSearchTerm = requiredString(row.searchTerm, 'SOURCE_SEARCH_TERM_INVALID');
  const matchType = row.matchType == null || row.matchType === '' ? null : String(row.matchType);
  const attributionWindow = String(accountType).toLowerCase() === 'seller' ? 7
    : String(accountType).toLowerCase() === 'vendor' ? 14
    : null;
  if (!attributionWindow) throw new SearchTermParserError('REPORT_ACCOUNT_TYPE_UNSUPPORTED');

  const impressions = parseNonNegativeInteger(row.impressions, 'SOURCE_IMPRESSIONS_INVALID');
  const clicks = parseNonNegativeInteger(row.clicks, 'SOURCE_CLICKS_INVALID');
  const costMicros = exactDecimalToMicros(row.cost);

  const purchasesByWindow = {};
  const unitsSoldByWindow = {};
  const salesMicrosByWindow = {};
  for (const days of WINDOWS) {
    purchasesByWindow[String(days)] = parseNonNegativeInteger(row[`purchases${days}d`], `SOURCE_PURCHASES_${days}D_INVALID`);
    unitsSoldByWindow[String(days)] = parseNonNegativeInteger(row[`unitsSoldClicks${days}d`], `SOURCE_UNITS_${days}D_INVALID`);
    salesMicrosByWindow[String(days)] = String(exactDecimalToMicros(row[`sales${days}d`]));
  }

  const keywordOrTargetId = targeting.keywordId || targeting.targetId;
  const rowKey = await buildSearchTermRowKey({
    profileId: canonicalProfileId,
    reportDate,
    campaignId,
    adGroupId,
    targetingKind: targeting.targetingKind,
    keywordOrTargetId,
    keywordType: targeting.sourceKeywordType,
    matchType,
    searchTerm: rawSearchTerm,
  });

  const metricsJson = canonicalJson({
    campaignBudgetCurrencyCode: row.campaignBudgetCurrencyCode == null ? null : String(row.campaignBudgetCurrencyCode),
    keyword: row.keyword == null ? null : String(row.keyword),
    targeting: row.targeting ?? null,
    attributionWindows: {
      purchases: purchasesByWindow,
      unitsSoldClicks: unitsSoldByWindow,
      salesMicros: salesMicrosByWindow,
    },
  });

  const fact = {
    rowKey,
    profileId: canonicalProfileId,
    reportDate,
    adProduct: 'SPONSORED_PRODUCTS',
    campaignId,
    adGroupId,
    keywordId: targeting.keywordId,
    targetId: targeting.targetId,
    sourceKeywordType: targeting.sourceKeywordType,
    searchTerm: rawSearchTerm,
    normalizedSearchTerm: normalizeSearchTermV1(rawSearchTerm),
    matchType,
    impressions,
    clicks,
    costMicros: String(costMicros),
    purchases: purchasesByWindow[String(attributionWindow)],
    unitsSold: unitsSoldByWindow[String(attributionWindow)],
    salesMicros: salesMicrosByWindow[String(attributionWindow)],
    metricsJson,
    sourceReportJobId: parseAmazonId(sourceReportJobId),
  };

  return Object.freeze({ fact: Object.freeze(fact), canonicalRowJson: canonicalJson(fact) });
}

export async function buildSearchTermRowKey({
  profileId, reportDate, campaignId, adGroupId, targetingKind, keywordOrTargetId,
  keywordType, matchType = null, searchTerm,
}) {
  const canonical = [
    'search_term_daily.sp.v1',
    parseAmazonId(profileId),
    String(reportDate),
    'SPONSORED_PRODUCTS',
    parseAmazonId(campaignId),
    parseAmazonId(adGroupId),
    String(targetingKind),
    parseAmazonId(keywordOrTargetId),
    String(keywordType),
    matchType == null ? null : String(matchType),
    String(searchTerm),
  ];
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function requiredString(value, code) {
  if (typeof value !== 'string') throw new SearchTermParserError(code);
  return value;
}

function isoDate(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new SearchTermParserError('SOURCE_REPORT_DATE_INVALID');
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new SearchTermParserError('SOURCE_REPORT_DATE_INVALID');
  }
  return text;
}
