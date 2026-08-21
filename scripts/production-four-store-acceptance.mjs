import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const REQUIRED_ANALYTICS = Object.freeze([
  'overview',
  'daily',
  'campaign',
  'ad-group',
  'targeting',
  'search-term',
  'quality',
  'diagnostics',
]);

export const REQUIRED_STORE_COUNT = 4;
export const FOUR_STORE_DECISION_INTELLIGENCE_CONTRACT = 'four-store-decision-intelligence-v1';
export const REQUIRED_RECOMMENDATION_AUTHORITY_FALSE = Object.freeze([
  'governancePersistenceAllowed',
  'executionAuthorized',
  'amazonMutationAuthorized',
]);

export function evaluateProductionAcceptance(evidence = {}) {
  const stores = Array.isArray(evidence.stores) ? evidence.stores : [];
  const storeIds = stores.map((store) => String(store?.storeId || '').trim()).filter(Boolean);
  const uniqueStoreIds = new Set(storeIds);
  const blockers = [];
  const failures = [];
  const decisionIntelligenceRequired = evidence.decisionIntelligenceRequired === true;

  if (evidence.realProductionCsv !== true) {
    blockers.push('real_production_csv_required');
  }
  if (stores.length !== REQUIRED_STORE_COUNT || uniqueStoreIds.size !== REQUIRED_STORE_COUNT) {
    failures.push('exactly_four_unique_stores_required');
  }

  for (const store of stores) {
    const storeId = String(store?.storeId || '').trim() || 'unknown-store';
    if (store?.csvImport?.accepted !== true) failures.push(`${storeId}:csv_import_not_accepted`);
    if (store?.csvImport?.classification !== 'business') failures.push(`${storeId}:business_classification_missing`);
    if (store?.csvImport?.businessFactsPresent !== true) failures.push(`${storeId}:business_facts_missing`);
    if (store?.csvImport?.observedIdentityAuthority !== 'non-canonical') {
      failures.push(`${storeId}:observed_csv_identity_authority_must_remain_non_canonical`);
    }
    if (store?.crossStoreLeakageDetected === true) failures.push(`${storeId}:cross_store_leakage_detected`);
    if (store?.exportVerified !== true) failures.push(`${storeId}:export_not_verified`);

    for (const dimension of REQUIRED_ANALYTICS) {
      if (store?.analytics?.[dimension]?.verified !== true) {
        failures.push(`${storeId}:analytics_${dimension}_not_verified`);
      }
      const returnedStoreIds = store?.analytics?.[dimension]?.returnedStoreIds;
      if (Array.isArray(returnedStoreIds) && returnedStoreIds.some((id) => String(id) !== storeId)) {
        failures.push(`${storeId}:analytics_${dimension}_cross_store_leakage`);
      }
    }

    if (decisionIntelligenceRequired || store?.decisionIntelligence) {
      validateDecisionIntelligence(storeId, store?.decisionIntelligence, failures);
    }
  }

  if (decisionIntelligenceRequired || stores.some((store) => store?.decisionIntelligence)) {
    validateSameSourceRollout(stores, failures);
  }

  const status = failures.length > 0 ? 'failed' : blockers.length > 0 ? 'blocked' : 'passed';
  return {
    schema: 'production-four-store-acceptance-v1',
    decisionIntelligenceContract: FOUR_STORE_DECISION_INTELLIGENCE_CONTRACT,
    decisionIntelligenceChecked: decisionIntelligenceRequired || stores.some((store) => store?.decisionIntelligence),
    status,
    storeCount: stores.length,
    uniqueStoreCount: uniqueStoreIds.size,
    blockers,
    failures,
  };
}

function validateDecisionIntelligence(storeId, intelligence, failures) {
  if (!intelligence || typeof intelligence !== 'object') {
    failures.push(`${storeId}:decision_intelligence_missing`);
    return;
  }
  if (intelligence.verified !== true) failures.push(`${storeId}:decision_intelligence_not_verified`);
  if (!positiveInteger(intelligence.businessFactCount)) failures.push(`${storeId}:business_fact_count_invalid`);
  if (!positiveInteger(intelligence.distinctTermCount)) failures.push(`${storeId}:distinct_term_count_invalid`);
  if (!validDate(intelligence?.range?.startDate) || !validDate(intelligence?.range?.endDate) || intelligence.range.startDate > intelligence.range.endDate) {
    failures.push(`${storeId}:decision_intelligence_range_invalid`);
  }
  if (!clean(intelligence.marketplace)) failures.push(`${storeId}:marketplace_missing`);
  if (!clean(intelligence.currencyCode)) failures.push(`${storeId}:currency_missing`);

  const source = intelligence.source || {};
  if (!sha256(source.contentSha256)) failures.push(`${storeId}:source_content_sha256_invalid`);
  if (source.dataClass !== 'business') failures.push(`${storeId}:decision_intelligence_source_not_business`);
  if (!['exact_source_object', 'reconciled_exact_source'].includes(source.provenanceClass)) {
    failures.push(`${storeId}:decision_intelligence_provenance_not_governed`);
  }
  if (!positiveInteger(source.authorityVersion)) failures.push(`${storeId}:decision_intelligence_authority_version_invalid`);
  for (const field of ['importId', 'objectKey', 'r2Version']) {
    if (!clean(source[field])) failures.push(`${storeId}:source_${field}_missing`);
  }

  const scope = intelligence.analysisScope || {};
  if (!positiveInteger(scope.hardCap)) failures.push(`${storeId}:analysis_scope_hard_cap_invalid`);
  if (typeof scope.complete !== 'boolean') failures.push(`${storeId}:analysis_scope_complete_missing`);
  if (typeof scope.overflowObserved !== 'boolean') failures.push(`${storeId}:analysis_scope_overflow_missing`);
  if (typeof scope.financiallyComparable !== 'boolean') failures.push(`${storeId}:analysis_scope_financial_comparability_missing`);
  if (typeof scope.candidateEmissionAuthorized !== 'boolean') failures.push(`${storeId}:candidate_emission_authority_missing`);
  if (scope.complete === false && scope.candidateEmissionAuthorized === true) failures.push(`${storeId}:incomplete_scope_candidate_emission_authorized`);
  if (scope.overflowObserved === true) {
    if (scope.complete !== false) failures.push(`${storeId}:overflow_scope_must_be_incomplete`);
    if (scope.candidateEmissionAuthorized !== false) failures.push(`${storeId}:overflow_scope_candidate_emission_must_fail_closed`);
    if (!Array.isArray(scope.reasons) || !scope.reasons.includes('search_term_universe_hard_cap_exceeded')) {
      failures.push(`${storeId}:overflow_scope_reason_missing`);
    }
  }

  const inbox = intelligence.recommendationInbox || {};
  const inboxFields = ['candidatePotentialCount', 'reviewCandidateCount', 'blockedByGovernanceCount', 'blockedByScopeCount'];
  for (const field of inboxFields) {
    if (!nonNegativeInteger(inbox[field])) failures.push(`${storeId}:recommendation_inbox_${field}_invalid`);
  }
  if (inboxFields.every((field) => nonNegativeInteger(inbox[field]))) {
    const accounted = inbox.reviewCandidateCount + inbox.blockedByGovernanceCount + inbox.blockedByScopeCount;
    if (inbox.candidatePotentialCount !== accounted) failures.push(`${storeId}:recommendation_inbox_candidate_accounting_mismatch`);
  }

  for (const field of REQUIRED_RECOMMENDATION_AUTHORITY_FALSE) {
    if (intelligence?.authority?.[field] !== false) failures.push(`${storeId}:decision_intelligence_${field}_must_be_false`);
  }

  if (!plainCountMap(intelligence?.rootIntelligence?.counts)) failures.push(`${storeId}:root_intelligence_counts_missing`);
  if (!plainCountMap(intelligence?.lifecycleIntelligence?.counts)) failures.push(`${storeId}:lifecycle_intelligence_counts_missing`);
  if (intelligence.unexpectedPersistenceDetected === true) failures.push(`${storeId}:unexpected_review_or_action_persistence_detected`);
}

function validateSameSourceRollout(stores, failures) {
  const groups = new Map();
  for (const store of stores) {
    const hash = clean(store?.decisionIntelligence?.source?.contentSha256)?.toLowerCase();
    if (!sha256(hash)) continue;
    if (!groups.has(hash)) groups.set(hash, []);
    groups.get(hash).push(store);
  }

  for (const [hash, group] of groups) {
    if (group.length < 2) continue;
    uniqueScopedField(group, 'importId', failures);
    uniqueScopedField(group, 'objectKey', failures);
    uniqueScopedField(group, 'r2Version', failures);

    const baseline = comparableDecisionSnapshot(group[0]?.decisionIntelligence);
    for (const store of group.slice(1)) {
      const current = comparableDecisionSnapshot(store?.decisionIntelligence);
      if (stableJson(current) !== stableJson(baseline)) {
        failures.push(`${clean(store?.storeId) || 'unknown-store'}:same_source_decision_intelligence_drift:${hash}`);
      }
    }
  }
}

function uniqueScopedField(group, field, failures) {
  const seen = new Map();
  for (const store of group) {
    const storeId = clean(store?.storeId) || 'unknown-store';
    const value = clean(store?.decisionIntelligence?.source?.[field]);
    if (!value) continue;
    if (seen.has(value)) {
      failures.push(`${storeId}:same_source_${field}_reused_across_stores`);
    } else {
      seen.set(value, storeId);
    }
  }
}

function comparableDecisionSnapshot(intelligence = {}) {
  return {
    businessFactCount: intelligence.businessFactCount,
    distinctTermCount: intelligence.distinctTermCount,
    range: intelligence.range || null,
    marketplace: intelligence.marketplace || null,
    currencyCode: intelligence.currencyCode || null,
    analysisScope: intelligence.analysisScope || null,
    recommendationInbox: intelligence.recommendationInbox || null,
    rootIntelligence: intelligence.rootIntelligence || null,
    lifecycleIntelligence: intelligence.lifecycleIntelligence || null,
    authority: intelligence.authority || null,
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function plainCountMap(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every(nonNegativeInteger));
}
function positiveInteger(value) { return Number.isInteger(value) && value > 0; }
function nonNegativeInteger(value) { return Number.isInteger(value) && value >= 0; }
function sha256(value) { return /^[a-f0-9]{64}$/i.test(clean(value)); }
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/u.test(clean(value)) && !Number.isNaN(Date.parse(`${clean(value)}T00:00:00.000Z`)); }
function clean(value) { return String(value ?? '').trim(); }

async function main() {
  const inputFlag = process.argv.indexOf('--input');
  if (inputFlag < 0 || !process.argv[inputFlag + 1]) {
    const result = evaluateProductionAcceptance({ realProductionCsv: false, stores: [] });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const raw = await fs.readFile(process.argv[inputFlag + 1], 'utf8');
  const evidence = JSON.parse(raw);
  const result = evaluateProductionAcceptance(evidence);
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'failed') process.exitCode = 1;
  if (result.status === 'blocked') process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
