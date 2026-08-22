import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  FOUR_STORE_DECISION_QUEUE_SUMMARY_SCHEMA_VERSION,
  handleDataHealthApiRoute,
  summarizeDecisionQueueReviewState,
} from '../cloudflare/runtime/data-health-api.js';
import { buildRecommendationReviewBinding } from '../cloudflare/runtime/csv-recommendation-human-review-contract.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(repoRoot, 'assets/cloudflare-native-operations-health-v1.js'), 'utf8');
const dataHealthSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/data-health-api.js'), 'utf8');
const buildSource = await readFile(path.join(repoRoot, 'scripts/build-cloudflare-native-copy-all.mjs'), 'utf8');
const allowlistSource = await readFile(path.join(repoRoot, 'scripts/enforce-cloudflare-native-asset-allowlist.mjs'), 'utf8');

new vm.Script(source, { filename: 'cloudflare-native-operations-health-v1.js' });
assert.doesNotMatch(source, /AMAZON_ADS|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED|wrangler\s+deploy/i);
assert.doesNotMatch(source, /\.startSync\s*\(|startSync\s*\(/, 'operations health console must never start sync');
assert.doesNotMatch(source, /fetch\s*\(/, 'operations health console must delegate transport to CloudflareNativeAPI');
assert.doesNotMatch(source, /createProduct|updateProduct|createKeyword|updateKeyword|putStoreProduct|deleteStoreProduct|putProductKeyword|deleteProductKeyword|putStoreNegativeKeyword|putProductNegativeKeyword/,
  'operations health console must remain read-only');
assert.doesNotMatch(source, /confidenceScore|actionabilityScore|financialImpact/,
  'executive operations overview must not invent confidence, actionability, or financial impact');
assert.match(source, /analytics\.read/);
assert.match(source, /audit\.read/);
assert.match(source, /unmapped/);
assert.match(source, /ambiguous/);
assert.match(source, /FAIL-CLOSED EVIDENCE/);
assert.match(source, /Four-Store Command Board/);
assert.match(source, /ATTENTION ORDER/);
assert.match(source, /Evidence gap/);
assert.match(source, /reported lag/);
assert.match(source, /unresolved mapping/);

const calls = [];
const window = {
  CloudflareNativeAPI: {
    analyticsDataHealth(params) {
      calls.push({ method: 'analyticsDataHealth', params: { ...params } });
      return Promise.resolve({ generatedAt: '2026-08-22T12:00:00.000Z', stores: [], recentRollupFailures: [] });
    },
    auditEvents(params) {
      calls.push({ method: 'auditEvents', params: { ...params } });
      return Promise.resolve({ items: [], nextCursor: null });
    },
    stores() {
      calls.push({ method: 'stores' });
      return Promise.resolve({ stores: [] });
    },
    capabilities() {
      calls.push({ method: 'capabilities' });
      return Promise.resolve({ globalPermissions: [], storePermissions: {} });
    },
  },
};

vm.runInNewContext(source, { window, console, Set, Object, Array, String, Number, Boolean, Error, Promise, Date }, {
  filename: 'cloudflare-native-operations-health-v1.js',
});

const health = window.CloudflareOperationsHealth;
assert(health, 'CloudflareOperationsHealth was not installed');
assert.equal(health.version, '1.1.0');

await health.dataHealth(' store-dev-01 ');
await health.auditEvents(' store-dev-01 ', { action: 'product.update' });
await health.listStores();
await health.capabilities();

const dataCall = calls.find((call) => call.method === 'analyticsDataHealth');
assert.deepEqual(dataCall.params, { storeId: 'store-dev-01' });
const auditCall = calls.find((call) => call.method === 'auditEvents');
assert.equal(auditCall.params.limit, 20);
assert.equal(auditCall.params.storeId, 'store-dev-01');
assert.equal(auditCall.params.action, 'product.update');
assert(calls.some((call) => call.method === 'stores'));
assert(calls.some((call) => call.method === 'capabilities'));

await assert.rejects(() => health.dataHealth(''), /store_id_required/);
await assert.rejects(() => health.auditEvents('   '), /store_id_required/);

const baseStore = {
  storeId: 'store-healthy',
  storeCode: 'STORE04',
  displayName: 'Healthy store',
  sync: {
    status: 'idle',
    lastSuccessAt: '2026-08-22T11:58:00.000Z',
    lastErrorAt: null,
    lastErrorCode: null,
    lagMinutes: 0,
    updatedAt: '2026-08-22T11:59:00.000Z',
  },
  rollups: [],
};

const healthy = health.classifyStoreHealth(baseStore, []);
assert.equal(healthy.priority, 4);
assert.equal(healthy.attentionKey, 'healthy');

const mapping = health.classifyStoreHealth({
  ...baseStore,
  storeId: 'store-mapping',
  rollups: [{ unmappedRows: 3, ambiguousRows: 2, updatedAt: '2026-08-22T11:59:00.000Z' }],
}, []);
assert.equal(mapping.priority, 3);
assert.equal(mapping.attentionKey, 'mapping_anomaly');
assert.equal(mapping.unmappedRows, 3);
assert.equal(mapping.ambiguousRows, 2);

const freshness = health.classifyStoreHealth({
  ...baseStore,
  storeId: 'store-lag',
  sync: { ...baseStore.sync, lagMinutes: 17 },
}, []);
assert.equal(freshness.priority, 2);
assert.equal(freshness.attentionKey, 'freshness_attention');
assert.match(freshness.reason, /17 min/);

const failure = health.classifyStoreHealth(baseStore, [{
  storeId: baseStore.storeId,
  rollupType: 'search_term',
  partitionKey: '2026-08',
  errorCode: 'rollup_failed',
}]);
assert.equal(failure.priority, 1);
assert.equal(failure.attentionKey, 'health_failure');

const errorAfterSuccess = health.classifyStoreHealth({
  ...baseStore,
  sync: {
    ...baseStore.sync,
    lastSuccessAt: '2026-08-22T11:00:00.000Z',
    lastErrorAt: '2026-08-22T11:30:00.000Z',
    lastErrorCode: 'latest_error',
  },
}, []);
assert.equal(errorAfterSuccess.priority, 1);
assert.equal(errorAfterSuccess.attentionKey, 'health_failure');

const evidenceGap = health.classifyStoreHealth({
  storeId: 'store-gap',
  storeCode: 'STORE01',
  displayName: 'Evidence gap',
  sync: { status: 'never', lastSuccessAt: null, lastErrorAt: null, lagMinutes: null, updatedAt: null },
  rollups: [],
}, []);
assert.equal(evidenceGap.priority, 1);
assert.equal(evidenceGap.attentionKey, 'evidence_gap');
assert.match(evidenceGap.reason, /No sync or rollup freshness evidence/);

const readFailure = health.classifyStoreHealth(null, [], Object.assign(new Error('health_unavailable'), { code: 'health_unavailable' }));
assert.equal(readFailure.priority, 1);
assert.equal(readFailure.attentionKey, 'evidence_gap');

const payload = (store, failures = []) => ({
  generatedAt: '2026-08-22T12:00:00.000Z',
  stores: [store],
  recentRollupFailures: failures,
});
const rows = [
  health.buildCommandRow({ storeId: 'healthy', storeCode: 'STORE04' }, payload({ ...baseStore, storeId: 'healthy' }), null, 3),
  health.buildCommandRow({ storeId: 'mapping', storeCode: 'STORE03' }, payload({
    ...baseStore,
    storeId: 'mapping',
    rollups: [{ unmappedRows: 1, ambiguousRows: 0, updatedAt: '2026-08-22T11:59:00.000Z' }],
  }), null, 2),
  health.buildCommandRow({ storeId: 'lag', storeCode: 'STORE02' }, payload({
    ...baseStore,
    storeId: 'lag',
    sync: { ...baseStore.sync, lagMinutes: 5 },
  }), null, 1),
  health.buildCommandRow({ storeId: 'failure', storeCode: 'STORE01' }, payload(
    { ...baseStore, storeId: 'failure' },
    [{ storeId: 'failure', rollupType: 'daily', errorCode: 'failed' }],
  ), null, 0),
  health.buildCommandRow({ storeId: 'gap', storeCode: 'STORE05' }, payload({
    storeId: 'gap',
    sync: { status: 'never', lagMinutes: null },
    rollups: [],
  }), null, 4),
];

const ranked = health.rankStoreHealthRows(rows);
assert.deepEqual(
  ranked.map((row) => [row.attentionKey, row.priority, row.storeOrder]),
  [
    ['health_failure', 1, 0],
    ['evidence_gap', 1, 4],
    ['freshness_attention', 2, 1],
    ['mapping_anomaly', 3, 2],
    ['healthy', 4, 3],
  ],
  'command board must use deterministic health -> freshness -> mapping -> healthy ordering',
);

assert.match(buildSource, /cloudflare-native-operations-health-v1\.js/,
  'native build must include the operations health console');
assert.match(allowlistSource, /cloudflare-native-operations-health-v1\.js/,
  'native asset allowlist must include the operations health console');

// #244 server-authoritative Decision Queue contract.
assert.equal(FOUR_STORE_DECISION_QUEUE_SUMMARY_SCHEMA_VERSION, 'four-store-decision-queue-summary-v1');
assert.match(dataHealthSource, /includeDecisionQueue/);
assert.match(dataHealthSource, /decision_queue_date_range_required/);
assert.match(dataHealthSource, /itemClass === 'recommendation_candidate'/,
  'only recommendation_candidate items may be fingerprint-bound');
assert.match(dataHealthSource, /FROM advisory_review_records[\s\S]*WHERE source_kind = \?1/);
assert.doesNotMatch(dataHealthSource, /\.run\s*\(/, 'Decision Queue server contract must not write D1');
assert.doesNotMatch(dataHealthSource, /startSync\s*\(|optimization-actions|AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED/,
  'Decision Queue server contract must not activate sync, Optimization Actions, or Amazon controls');
assert.match(dataHealthSource, /readOnly:\s*true/);
assert.match(dataHealthSource, /executionAuthorized:\s*false/);
assert.match(dataHealthSource, /amazonMutationAuthorized:\s*false/);
assert.match(dataHealthSource, /evidenceState:\s*'unavailable'/,
  'single-store calculation failures must fail closed without failing the whole endpoint');

const missingDateUrl = new URL('https://example.test/api/v1/analytics/data-health?includeDecisionQueue=true');
const missingDateResponse = await handleDataHealthApiRoute({
  request: new Request(missingDateUrl),
  env: {},
  actor: { user_id: 'operator-test' },
  url: missingDateUrl,
});
assert.equal(missingDateResponse.status, 400);
assert.deepEqual(await missingDateResponse.json(), { error: 'decision_queue_date_range_required' });

function controlDb({ globalRead = true, accessibleStoreIds = ['store-01'], rows: storeRows = null } = {}) {
  const effectiveRows = storeRows || accessibleStoreIds.map((storeId, index) => ({
    store_id: storeId,
    store_code: `STORE0${index + 1}`,
    display_name: `Store ${index + 1}`,
    status: 'active',
    d1_binding_key: `STORE_0${index + 1}_DB`,
    sync_status: null,
    active_run_id: null,
    last_success_at: null,
    last_error_at: null,
    last_error_code: null,
    lag_minutes: null,
    sync_updated_at: null,
  }));
  return {
    prepare(sql) {
      const statement = String(sql);
      const all = async () => {
        if (statement.includes('SELECT store_id FROM stores WHERE status')) {
          return { results: accessibleStoreIds.map((store_id) => ({ store_id })) };
        }
        if (statement.includes('SELECT DISTINCT sm.store_id')) {
          return { results: accessibleStoreIds.map((store_id) => ({ store_id })) };
        }
        if (statement.includes('FROM stores s')) return { results: effectiveRows };
        if (statement.includes('FROM rollup_watermarks')) return { results: [] };
        if (statement.includes('FROM rollup_runs')) return { results: [] };
        return { results: [] };
      };
      return {
        all,
        bind() {
          return {
            async first() {
              if (statement.includes('FROM user_global_roles')) return globalRead ? { ok: 1 } : null;
              return null;
            },
            all,
          };
        },
      };
    },
  };
}

const compatibilityUrl = new URL('https://example.test/api/v1/analytics/data-health');
const compatibilityResponse = await handleDataHealthApiRoute({
  request: new Request(compatibilityUrl),
  env: { CONTROL_DB: controlDb() },
  actor: { user_id: 'operator-test' },
  url: compatibilityUrl,
});
assert.equal(compatibilityResponse.status, 200);
const compatibilityPayload = await compatibilityResponse.json();
assert.equal(Object.prototype.hasOwnProperty.call(compatibilityPayload, 'decisionQueue'), false,
  'default data-health response must remain backward-compatible');
assert.equal(Object.prototype.hasOwnProperty.call(compatibilityPayload.stores[0], 'd1BindingKey'), false,
  'internal store D1 binding identity must not leak');

const rbacUrl = new URL('https://example.test/api/v1/analytics/data-health?includeDecisionQueue=true&startDate=2026-06-01&endDate=2026-06-30');
const rbacResponse = await handleDataHealthApiRoute({
  request: new Request(rbacUrl),
  env: { CONTROL_DB: controlDb({ globalRead: false, accessibleStoreIds: ['store-01'] }) },
  actor: { user_id: 'operator-test' },
  url: rbacUrl,
});
assert.equal(rbacResponse.status, 200, 'per-store Decision Queue failure must not turn the endpoint into 500');
const rbacPayload = await rbacResponse.json();
assert.deepEqual(rbacPayload.decisionQueue.stores.map((store) => store.storeId), ['store-01'],
  'stores outside analytics.read scope must not appear even as zero-count rows');
assert.equal(rbacPayload.decisionQueue.stores[0].evidenceState, 'unavailable');
assert.equal(rbacPayload.decisionQueue.stores[0].recommendationCandidateCount, null,
  'unavailable stores must fail closed rather than emit fabricated zeroes');

function candidate({ id, value, priority, window = { startDate: '2026-06-01', endDate: '2026-06-30' }, importId = 'import-current' }) {
  return {
    inboxItemId: id,
    itemClass: 'recommendation_candidate',
    candidateType: 'exact_negative',
    actionType: 'negative_exact',
    matchScope: 'exact',
    value,
    priority,
    priorityScore: priority === 'critical' ? 95 : priority === 'high' ? 80 : priority === 'medium' ? 60 : 20,
    reason: 'governed test recommendation',
    evidenceSummary: {
      spendMicros: 1000000,
      salesMicros: 0,
      orders: 0,
      clicks: 8,
      acos: null,
      cvr: 0,
      analysisWindow: window,
      sourceImportIds: [importId],
      rootStates: ['toxic'],
      recommendationGoverned: true,
      provenanceGate: 'exact_source_object',
      identityConfidence: { state: 'observed_csv_targeting_ids_unresolved', score: 0 },
    },
    review: { state: 'unreviewed', persisted: false, persistenceAuthorized: false },
    authority: {
      governancePersistenceAllowed: false,
      executionAuthorized: false,
      amazonMutationAuthorized: false,
    },
  };
}

const critical = candidate({ id: 'csv-inbox:critical', value: 'critical term', priority: 'critical' });
const high = candidate({ id: 'csv-inbox:high', value: 'high term', priority: 'high' });
const medium = candidate({ id: 'csv-inbox:medium', value: 'medium term', priority: 'medium' });
const staleCurrent = candidate({ id: 'csv-inbox:stale', value: 'stale term', priority: 'low' });
const staleOld = candidate({
  id: 'csv-inbox:stale',
  value: 'stale term',
  priority: 'low',
  window: { startDate: '2026-05-01', endDate: '2026-05-31' },
  importId: 'import-old',
});

const [highBinding, mediumBinding, staleOldBinding] = await Promise.all([
  buildRecommendationReviewBinding(high),
  buildRecommendationReviewBinding(medium),
  buildRecommendationReviewBinding(staleOld),
]);
const summarized = await summarizeDecisionQueueReviewState({
  inbox: {
    summary: { blockedByGovernanceCount: 2, blockedByScopeCount: 3 },
    items: [
      critical,
      high,
      medium,
      staleCurrent,
      { itemClass: 'diagnostic_observation', priority: 'critical' },
    ],
  },
  analysisScope: { financiallyComparable: true, candidateEmissionAuthorized: true },
  storedReviews: [
    {
      review_id: 'review-high',
      recommendation_fingerprint: highBinding.recommendationFingerprint,
      state: 'open',
      source_evidence_json: highBinding.sourceEvidenceJson,
    },
    {
      review_id: 'review-medium',
      recommendation_fingerprint: mediumBinding.recommendationFingerprint,
      state: 'acknowledged',
      source_evidence_json: mediumBinding.sourceEvidenceJson,
    },
    {
      review_id: 'review-stale-old',
      recommendation_fingerprint: staleOldBinding.recommendationFingerprint,
      state: 'acknowledged',
      source_evidence_json: staleOldBinding.sourceEvidenceJson,
    },
  ],
});
assert.deepEqual(summarized, {
  recommendationCandidateCount: 4,
  criticalHighCandidateCount: 2,
  governanceBlockedCount: 2,
  scopeBlockedCount: 3,
  unreviewedCount: 2,
  needsReviewCount: 1,
  acknowledgedCount: 1,
  staleReviewEvidenceCount: 1,
  highUnreviewedCount: 1,
  analysisScopeComplete: false,
  financiallyComparable: true,
  candidateEmissionAuthorized: true,
});

console.log(JSON.stringify({
  ok: true,
  contract: 'four-store-decision-queue-summary-v1',
  operationalContract: 'executive-operations-overview-v1',
  transport: 'CloudflareNativeAPI-read-only',
  analyticsRead: true,
  auditRead: true,
  explicitDecisionDateScope: true,
  inaccessibleStoresOmitted: true,
  perStoreFailClosed: true,
  durableReviewTruth: true,
  staleReviewEvidence: true,
  recommendationCandidateFiltering: true,
  attentionOrder: ['health_failure_or_evidence_gap', 'reported_lag', 'mapping_anomaly', 'healthy'],
  failClosedEvidenceGap: true,
  inventedThresholds: false,
  syncStartBlocked: true,
  amazonDormant: true,
  productionMutation: false,
  calls: calls.map((call) => call.method),
}, null, 2));
