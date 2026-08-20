const SOURCE_KIND = 'csv_import';
const SCHEMA_VERSION = 'csv-business-candidate-review-v1';
const HEX64 = /^[a-f0-9]{64}$/u;
const GOVERNED_PROVENANCE = new Set(['exact_source_object', 'reconciled_exact_source']);

const CANDIDATE_CONTRACT = Object.freeze({
  'Exact Negative Candidate': Object.freeze({ actionType: 'negative_keyword.review_exact', matchScope: 'exact', family: 'negative_keyword' }),
  'Phrase Negative Review Candidate': Object.freeze({ actionType: 'negative_keyword.review_phrase', matchScope: 'phrase_review', family: 'negative_keyword' }),
  'Harvest Candidate': Object.freeze({ actionType: 'keyword.review_harvest', matchScope: 'exact_review', family: 'keyword' }),
  'Scale Candidate': Object.freeze({ actionType: 'keyword.review_scale', matchScope: 'operator_review', family: 'keyword' }),
});

export async function enrichCsvBusinessCandidateReviewBindings(db, productization, searchParams) {
  const business = productization?.businessIntelligence;
  const candidates = Array.isArray(business?.candidates) ? business.candidates : [];
  const scope = productization?.analysisScope || business?.analysisScope || {};
  if (!candidates.length || scope.candidateEmissionAuthorized !== true) return productization;

  const startDate = dateText(searchParams?.get?.('startDate'));
  const endDate = dateText(searchParams?.get?.('endDate'));
  if (!startDate || !endDate) return productization;

  const roots = Array.isArray(business?.rootIntelligence?.roots) ? business.rootIntelligence.roots : [];
  const rootByName = new Map(roots.map((root) => [key(root?.root), root]));
  const descriptors = candidates.map((candidate) => descriptorForCandidate(candidate, rootByName, startDate, endDate));
  const representativeTerms = [...new Set(descriptors.map((item) => item?.representativeSearchTerm).filter(Boolean))];
  const importIds = [...new Set(candidates.flatMap((candidate) => texts(candidate?.evidence?.sourceImportIds)))];
  if (!representativeTerms.length || !importIds.length) return productization;

  const [facts, batches] = await Promise.all([
    selectRepresentativeFacts(db, representativeTerms, {
      startDate,
      endDate,
      profileId: text(searchParams.get('profileId')) || null,
      campaignName: text(searchParams.get('campaignName')) || null,
      adGroupName: text(searchParams.get('adGroupName')) || null,
    }),
    selectImportBatches(db, importIds),
  ]);
  const factsByTerm = indexFactsByTerm(facts);
  const batchById = new Map(batches.map((row) => [row.import_id, row]));

  const boundCandidates = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const descriptor = descriptors[index];
    const binding = await buildReviewBinding(candidate, descriptor, factsByTerm, batchById, scope);
    boundCandidates.push(binding ? { ...candidate, reviewBinding: binding } : { ...candidate, reviewBinding: null });
  }

  return {
    ...productization,
    businessIntelligence: {
      ...business,
      candidates: boundCandidates,
      reviewBinding: {
        schemaVersion: SCHEMA_VERSION,
        sourceKind: SOURCE_KIND,
        emittedBindingCount: boundCandidates.filter((candidate) => candidate.reviewBinding).length,
        candidateCount: boundCandidates.length,
        authority: {
          authoritative: false,
          optimizationActionPersistenceAuthorized: false,
          executionAuthorized: false,
          amazonMutationAuthorized: false,
        },
      },
    },
  };
}

export async function validateCsvBusinessCandidateReviewBinding({
  fingerprint,
  entityId,
  family,
  actionType,
  evidenceInput,
  fact,
  importIds,
  contentSha256s,
}) {
  if (!plainObject(evidenceInput?.candidateReview)) return { value: null };
  const candidateReview = sanitizeCandidateReview(evidenceInput.candidateReview);
  if (!candidateReview) return { error: 'invalid_product_candidate_review_binding', status: 400 };

  const contract = CANDIDATE_CONTRACT[candidateReview.candidateType];
  if (!contract
      || contract.actionType !== candidateReview.actionType
      || contract.matchScope !== candidateReview.matchScope
      || contract.family !== family
      || contract.actionType !== actionType) {
    return { error: 'product_candidate_review_action_mismatch', status: 409 };
  }
  if (candidateReview.entityId !== entityId) {
    return { error: 'product_candidate_review_entity_mismatch', status: 409 };
  }
  if (!sameSet(candidateReview.sourceImportIds, sortedUnique(importIds))) {
    return { error: 'product_candidate_review_import_mismatch', status: 409 };
  }
  if (!sameSet(candidateReview.contentSha256s, sortedUnique(contentSha256s.map((value) => String(value || '').toLowerCase())))) {
    return { error: 'product_candidate_review_hash_mismatch', status: 409 };
  }
  const factKeys = new Set([key(fact?.search_term), key(fact?.normalized_search_term)].filter(Boolean));
  if (!factKeys.has(key(candidateReview.representativeSearchTerm))) {
    return { error: 'product_candidate_review_representative_term_mismatch', status: 409 };
  }

  const expected = await sha256Hex(JSON.stringify(candidateReview));
  if (expected !== String(fingerprint || '').toLowerCase()) {
    return { error: 'invalid_product_candidate_review_fingerprint', status: 409 };
  }
  return { value: candidateReview };
}

function descriptorForCandidate(candidate, rootByName, startDate, endDate) {
  const candidateType = text(candidate?.candidateType);
  const actionType = text(candidate?.actionType);
  const matchScope = text(candidate?.matchScope);
  const value = text(candidate?.value);
  const contract = CANDIDATE_CONTRACT[candidateType];
  if (!contract || contract.actionType !== actionType || contract.matchScope !== matchScope || !value) return null;

  let representativeSearchTerm = value;
  if (matchScope === 'phrase_review') {
    const root = rootByName.get(key(value));
    representativeSearchTerm = [...texts(root?.searchTerms)].sort((a, b) => a.localeCompare(b))[0] || '';
  }
  if (!representativeSearchTerm) return null;
  return { candidateType, actionType, matchScope, value, representativeSearchTerm, startDate, endDate, family: contract.family };
}

async function buildReviewBinding(candidate, descriptor, factsByTerm, batchById, scope) {
  if (!descriptor || candidate?.requiresHumanReview !== true || candidate?.evidence?.recommendationGoverned !== true) return null;
  const sourceImportIds = sortedUnique(texts(candidate?.evidence?.sourceImportIds));
  if (!sourceImportIds.length) return null;

  const batchRows = sourceImportIds.map((importId) => batchById.get(importId));
  if (batchRows.some((row) => !row
      || row.status !== 'published'
      || row.data_class !== 'business'
      || !GOVERNED_PROVENANCE.has(row.provenance_class)
      || !HEX64.test(String(row.content_sha256 || '').toLowerCase()))) return null;
  const contentSha256s = sortedUnique(batchRows.map((row) => String(row.content_sha256).toLowerCase()));

  const representativeFacts = factsByTerm.get(key(descriptor.representativeSearchTerm)) || [];
  const fact = representativeFacts.find((row) => sourceImportIds.includes(row.source_import_id));
  if (!fact?.row_key) return null;

  const candidateReview = sanitizeCandidateReview({
    schemaVersion: SCHEMA_VERSION,
    candidateType: descriptor.candidateType,
    actionType: descriptor.actionType,
    matchScope: descriptor.matchScope,
    value: descriptor.value,
    representativeSearchTerm: descriptor.representativeSearchTerm,
    entityId: fact.row_key,
    reason: text(candidate?.evidence?.reason),
    priorityScore: finite(candidate?.priorityScore),
    analysisWindow: { startDate: descriptor.startDate, endDate: descriptor.endDate },
    sourceImportIds,
    contentSha256s,
    metrics: metricSnapshot(candidate?.evidence?.metrics),
    rootStates: sortedUnique(texts(candidate?.evidence?.rootStates)),
    targetingIdentityStates: sortedUnique(texts(candidate?.evidence?.targetingIdentityStates)),
    analysisScope: scopeSnapshot(candidate?.evidence?.analysisScope || scope),
  });
  if (!candidateReview) return null;
  const recommendationFingerprint = await sha256Hex(JSON.stringify(candidateReview));
  return {
    sourceKind: SOURCE_KIND,
    recommendationFingerprint,
    entityType: 'search_term',
    entityId: fact.row_key,
    recommendationFamily: descriptor.family,
    recommendationActionType: descriptor.actionType,
    evidence: {
      sourceImportIds,
      contentSha256s,
      candidateReview,
    },
  };
}

function sanitizeCandidateReview(input) {
  if (!plainObject(input) || text(input.schemaVersion) !== SCHEMA_VERSION) return null;
  const candidateType = text(input.candidateType);
  const contract = CANDIDATE_CONTRACT[candidateType];
  const actionType = text(input.actionType);
  const matchScope = text(input.matchScope);
  const value = text(input.value);
  const representativeSearchTerm = text(input.representativeSearchTerm);
  const entityId = text(input.entityId);
  const startDate = dateText(input.analysisWindow?.startDate);
  const endDate = dateText(input.analysisWindow?.endDate);
  const sourceImportIds = sortedUnique(texts(input.sourceImportIds));
  const contentSha256s = sortedUnique(texts(input.contentSha256s).map((value) => value.toLowerCase()));
  if (!contract || contract.actionType !== actionType || contract.matchScope !== matchScope
      || !value || !representativeSearchTerm || !entityId || !startDate || !endDate
      || !sourceImportIds.length || !contentSha256s.length || contentSha256s.some((value) => !HEX64.test(value))) return null;

  return {
    schemaVersion: SCHEMA_VERSION,
    candidateType,
    actionType,
    matchScope,
    value,
    representativeSearchTerm,
    entityId,
    reason: text(input.reason),
    priorityScore: finite(input.priorityScore),
    analysisWindow: { startDate, endDate },
    sourceImportIds,
    contentSha256s,
    metrics: metricSnapshot(input.metrics),
    rootStates: sortedUnique(texts(input.rootStates)),
    targetingIdentityStates: sortedUnique(texts(input.targetingIdentityStates)),
    analysisScope: scopeSnapshot(input.analysisScope),
  };
}

async function selectRepresentativeFacts(db, terms, filters) {
  const output = [];
  for (let offset = 0; offset < terms.length; offset += 80) {
    const chunk = terms.slice(offset, offset + 80);
    const placeholders = chunk.map((_, index) => `?${index + 7}`).join(',');
    const sql = `
      SELECT row_key, source_import_id, advertiser_account_id, campaign_id, ad_group_id,
             targeting_id, targeting_identity_state, report_date, search_term, normalized_search_term
      FROM csv_search_term_daily
      WHERE report_date BETWEEN ?1 AND ?2
        AND (?3 IS NULL OR profile_id=?3)
        AND (?4 IS NULL OR campaign_name=?4)
        AND (?5 IS NULL OR ad_group_name=?5)
        AND (search_term IN (${placeholders}) OR normalized_search_term IN (${placeholders}))
      ORDER BY report_date DESC, row_key ASC
    `;
    const statement = db.prepare(sql);
    const result = await statement.bind(
      filters.startDate,
      filters.endDate,
      filters.profileId,
      filters.campaignName,
      filters.adGroupName,
      null,
      ...chunk,
      ...chunk,
    ).all();
    output.push(...(result.results || []));
  }
  return output;
}

async function selectImportBatches(db, importIds) {
  const output = [];
  for (let offset = 0; offset < importIds.length; offset += 80) {
    const chunk = importIds.slice(offset, offset + 80);
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(',');
    const result = await db.prepare(`
      SELECT b.import_id, b.content_sha256, b.status, a.data_class, a.provenance_class
      FROM csv_import_batches b
      LEFT JOIN csv_import_authority a ON a.import_id=b.import_id
      WHERE b.import_id IN (${placeholders})
    `).bind(...chunk).all();
    output.push(...(result.results || []));
  }
  return output;
}

function indexFactsByTerm(rows) {
  const map = new Map();
  for (const row of rows) {
    for (const termKey of new Set([key(row.search_term), key(row.normalized_search_term)].filter(Boolean))) {
      const current = map.get(termKey) || [];
      current.push(row);
      map.set(termKey, current);
    }
  }
  return map;
}

function metricSnapshot(metrics) {
  const value = plainObject(metrics) ? metrics : {};
  return {
    impressions: finite(value.impressions),
    clicks: finite(value.clicks),
    spendMicros: finite(value.spendMicros),
    orders: finite(value.orders),
    salesMicros: finite(value.salesMicros),
    acos: nullableFinite(value.acos),
    roas: nullableFinite(value.roas),
    cvr: nullableFinite(value.cvr),
    cpcMicros: nullableFinite(value.cpcMicros),
  };
}

function scopeSnapshot(scope) {
  const value = plainObject(scope) ? scope : {};
  return {
    complete: value.complete === true,
    financiallyComparable: value.financiallyComparable === true,
    candidateEmissionAuthorized: value.candidateEmissionAuthorized === true,
    observedTermCount: finite(value.observedTermCount ?? value.itemCount),
    hardCap: finite(value.hardCap),
    overflowObserved: value.overflowObserved === true,
    currencyCodes: sortedUnique(texts(value.currencyCodes)),
    marketplaces: sortedUnique(texts(value.marketplaces)),
    reasons: sortedUnique(texts(value.reasons)),
  };
}

function dateText(value) {
  const candidate = text(value);
  return /^\d{4}-\d{2}-\d{2}$/u.test(candidate) ? candidate : '';
}

function texts(values) {
  return Array.isArray(values) ? values.map(text).filter(Boolean) : [];
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function key(value) {
  return text(value).toLowerCase();
}

function finite(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function nullableFinite(value) {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
