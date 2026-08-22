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
assert.doesNotMatch(source, /\.startSync\s*\(|startSync\s*\(/, 'operations command board must never start sync');
assert.doesNotMatch(source, /fetch\s*\(/, 'operations command board must delegate transport to CloudflareNativeAPI');
assert.doesNotMatch(source, /createProduct|updateProduct|createKeyword|updateKeyword|putStoreProduct|deleteStoreProduct|putProductKeyword|deleteProductKeyword|putStoreNegativeKeyword|putProductNegativeKeyword/,
  'operations command board must remain read-only');
assert.doesNotMatch(source, /confidenceScore|actionabilityScore|financialImpact/,
  'command board must not invent confidence, actionability, or financial impact');
assert.doesNotMatch(source, /Store Score\s*=/i, 'Operational and Decision priorities must not collapse into an opaque Store Score');
assert.match(source, /OPERATIONAL ATTENTION ORDER/);
assert.match(source, /DECISION ATTENTION/);
assert.match(source, /Decision Workload/);
assert.match(source, /FAIL-CLOSED EVIDENCE/);
assert.match(source, /No sync or rollup freshness evidence is available/);
assert.match(source, /Decision order: authoritative read failure\/evidence gap/);
assert.match(source, /Open Decision Queue/);
assert.match(source, /CloudflareOperatorContext/);
assert.match(source, /cfDecisionLauncher/);
assert.match(source, /name="startDate"/);
assert.match(source, /name="endDate"/);
assert.match(source, /<input id="cfOpsDecisionStart" type="date" autocomplete="off">/,
  'Decision date scope must start blank and operator-provided');
assert.match(source, /<input id="cfOpsDecisionEnd" type="date" autocomplete="off">/,
  'Decision date scope must start blank and operator-provided');
assert.match(source, /decision_queue_date_range_required/);
assert.match(source, /includeDecisionQueue:\s*true/);
assert.match(source, /amazonMutationAuthorized\s*!==\s*false/,
  'UI must validate server authority before presenting Decision Workload');
assert.match(buildSource, /cloudflare-native-operations-health-v1\.js/);
assert.match(allowlistSource, /cloudflare-native-operations-health-v1\.js/);

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
assert.equal(health.version, '1.2.0');
assert.equal(health.decisionSchemaVersion, 'four-store-decision-queue-summary-v1');
await health.dataHealth(' store-dev-01 ');
await health.decisionDataHealth('2026-06-01', '2026-06-30');
await health.auditEvents(' store-dev-01 ', { action: 'product.update' });
await health.listStores();
await health.capabilities();
await assert.rejects(() => health.dataHealth(''), /store_id_required/);
await assert.rejects(() => health.decisionDataHealth('', ''), /decision_queue_date_range_required/);
await assert.rejects(() => health.decisionDataHealth('2026-07-01', '2026-06-30'), /decision_queue_date_range_required/);

const dataCalls = calls.filter((call) => call.method === 'analyticsDataHealth');
assert.deepEqual(dataCalls[0].params, { storeId: 'store-dev-01' });
assert.deepEqual(dataCalls[1].params, {
  includeDecisionQueue: true,
  startDate: '2026-06-01',
  endDate: '2026-06-30',
});
assert.equal(calls.find((call) => call.method === 'auditEvents').params.limit, 20);

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
assert.equal(health.classifyStoreHealth(baseStore, []).priority, 4);
assert.equal(health.classifyStoreHealth({ ...baseStore, sync: { ...baseStore.sync, lagMinutes: 17 } }, []).priority, 2);
assert.equal(health.classifyStoreHealth({ ...baseStore, rollups: [{ unmappedRows: 3, ambiguousRows: 2 }] }, []).priority, 3);
assert.equal(health.classifyStoreHealth(baseStore, [{ storeId: baseStore.storeId, errorCode: 'rollup_failed' }]).priority, 1);
assert.equal(health.classifyStoreHealth({
  storeId: 'store-gap',
  sync: { status: 'never', lastSuccessAt: null, lastErrorAt: null, lagMinutes: null, updatedAt: null },
  rollups: [],
}, []).attentionKey, 'evidence_gap');

const operationalRows = health.rankStoreHealthRows([
  health.buildCommandRow({ storeId: 'healthy', storeCode: 'STORE04' }, { generatedAt: 'x', stores: [{ ...baseStore, storeId: 'healthy' }], recentRollupFailures: [] }, null, 3),
  health.buildCommandRow({ storeId: 'lag', storeCode: 'STORE02' }, { generatedAt: 'x', stores: [{ ...baseStore, storeId: 'lag', sync: { ...baseStore.sync, lagMinutes: 5 } }], recentRollupFailures: [] }, null, 1),
  health.buildCommandRow({ storeId: 'mapping', storeCode: 'STORE03' }, { generatedAt: 'x', stores: [{ ...baseStore, storeId: 'mapping', rollups: [{ unmappedRows: 1, ambiguousRows: 0 }] }], recentRollupFailures: [] }, null, 2),
  health.buildCommandRow({ storeId: 'gap', storeCode: 'STORE01' }, { generatedAt: 'x', stores: [{ storeId: 'gap', sync: { status: 'never' }, rollups: [] }], recentRollupFailures: [] }, null, 0),
]);
assert.deepEqual(operationalRows.map((row) => row.attentionKey), ['evidence_gap', 'freshness_attention', 'mapping_anomaly', 'healthy']);

const decisionRows = health.rankDecisionRows([
  health.buildDecisionRow({ storeId: 'clear', storeCode: 'STORE04', evidenceState: 'available', unreviewedCount: 0, needsReviewCount: 0, acknowledgedCount: 2, highUnreviewedCount: 0, staleReviewEvidenceCount: 0 }, 3),
  health.buildDecisionRow({ storeId: 'other', storeCode: 'STORE03', evidenceState: 'available', unreviewedCount: 4, needsReviewCount: 0, acknowledgedCount: 0, highUnreviewedCount: 0, staleReviewEvidenceCount: 0 }, 2),
  health.buildDecisionRow({ storeId: 'high', storeCode: 'STORE02', evidenceState: 'available', unreviewedCount: 2, needsReviewCount: 0, acknowledgedCount: 0, highUnreviewedCount: 1, staleReviewEvidenceCount: 0 }, 1),
  health.buildDecisionRow({ storeId: 'review', storeCode: 'STORE01', evidenceState: 'available', unreviewedCount: 1, needsReviewCount: 2, acknowledgedCount: 0, highUnreviewedCount: 1, staleReviewEvidenceCount: 1 }, 0),
  health.buildDecisionRow({ storeId: 'gap', storeCode: 'STORE05', evidenceState: 'unavailable', unavailable: true, error: { code: 'snapshot_failed' } }, 4),
]);
assert.deepEqual(decisionRows.map((row) => row.decisionKey), [
  'decision_evidence_gap',
  'review_attention',
  'high_unreviewed',
  'other_unreviewed',
  'queue_clear',
]);
assert.equal(decisionRows[1].activeQueueCount, 3, 'active Decision Queue is unreviewed + needs_review only');
assert.equal(decisionRows[0].activeQueueCount, null, 'unavailable evidence must not become a fabricated zero queue');
assert.equal(health.classifyDecisionAttention({ evidenceState: 'available', needsReviewCount: 0, staleReviewEvidenceCount: 1 }).decisionKey, 'review_attention');
assert.equal(health.classifyDecisionAttention({ evidenceState: 'available', needsReviewCount: 0, staleReviewEvidenceCount: 0, highUnreviewedCount: 1 }).decisionKey, 'high_unreviewed');

assert.equal(FOUR_STORE_DECISION_QUEUE_SUMMARY_SCHEMA_VERSION, 'four-store-decision-queue-summary-v1');
assert.match(dataHealthSource, /includeDecisionQueue/);
assert.match(dataHealthSource, /decision_queue_date_range_required/);
assert.match(dataHealthSource, /itemClass === 'recommendation_candidate'/);
assert.match(dataHealthSource, /FROM advisory_review_records[\s\S]*WHERE source_kind = \?1/);
assert.doesNotMatch(dataHealthSource, /\.run\s*\(/, 'Decision Queue server contract must not write D1');
assert.doesNotMatch(dataHealthSource, /startSync\s*\(|optimization-actions|AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED/);
assert.match(dataHealthSource, /readOnly:\s*true/);
assert.match(dataHealthSource, /executionAuthorized:\s*false/);
assert.match(dataHealthSource, /amazonMutationAuthorized:\s*false/);
assert.match(dataHealthSource, /evidenceState:\s*'unavailable'/);

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
        if (statement.includes('SELECT store_id FROM stores WHERE status')) return { results: accessibleStoreIds.map((store_id) => ({ store_id })) };
        if (statement.includes('SELECT DISTINCT sm.store_id')) return { results: accessibleStoreIds.map((store_id) => ({ store_id })) };
        if (statement.includes('FROM stores s')) return { results: effectiveRows };
        if (statement.includes('FROM rollup_watermarks') || statement.includes('FROM rollup_runs')) return { results: [] };
        return { results: [] };
      };
      return {
        all,
        bind() {
          return {
            async first() { return statement.includes('FROM user_global_roles') && globalRead ? { ok: 1 } : null; },
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
assert.equal(Object.prototype.hasOwnProperty.call(compatibilityPayload, 'decisionQueue'), false);
assert.equal(Object.prototype.hasOwnProperty.call(compatibilityPayload.stores[0], 'd1BindingKey'), false);

const rbacUrl = new URL('https://example.test/api/v1/analytics/data-health?includeDecisionQueue=true&startDate=2026-06-01&endDate=2026-06-30');
const rbacResponse = await handleDataHealthApiRoute({
  request: new Request(rbacUrl),
  env: { CONTROL_DB: controlDb({ globalRead: false, accessibleStoreIds: ['store-01'] }) },
  actor: { user_id: 'operator-test' },
  url: rbacUrl,
});
assert.equal(rbacResponse.status, 200);
const rbacPayload = await rbacResponse.json();
assert.deepEqual(rbacPayload.decisionQueue.stores.map((store) => store.storeId), ['store-01']);
assert.equal(rbacPayload.decisionQueue.stores[0].evidenceState, 'unavailable');
assert.equal(rbacPayload.decisionQueue.stores[0].recommendationCandidateCount, null);

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
    authority: { governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false },
  };
}

const critical = candidate({ id: 'csv-inbox:critical', value: 'critical term', priority: 'critical' });
const high = candidate({ id: 'csv-inbox:high', value: 'high term', priority: 'high' });
const medium = candidate({ id: 'csv-inbox:medium', value: 'medium term', priority: 'medium' });
const staleCurrent = candidate({ id: 'csv-inbox:stale', value: 'stale term', priority: 'low' });
const staleOld = candidate({ id: 'csv-inbox:stale', value: 'stale term', priority: 'low', window: { startDate: '2026-05-01', endDate: '2026-05-31' }, importId: 'import-old' });
const [highBinding, mediumBinding, staleOldBinding] = await Promise.all([
  buildRecommendationReviewBinding(high),
  buildRecommendationReviewBinding(medium),
  buildRecommendationReviewBinding(staleOld),
]);
const summarized = await summarizeDecisionQueueReviewState({
  inbox: {
    summary: { blockedByGovernanceCount: 2, blockedByScopeCount: 3 },
    items: [critical, high, medium, staleCurrent, { itemClass: 'diagnostic_observation', priority: 'critical' }],
  },
  analysisScope: { financiallyComparable: true, candidateEmissionAuthorized: true },
  storedReviews: [
    { review_id: 'review-high', recommendation_fingerprint: highBinding.recommendationFingerprint, state: 'open', source_evidence_json: highBinding.sourceEvidenceJson },
    { review_id: 'review-medium', recommendation_fingerprint: mediumBinding.recommendationFingerprint, state: 'acknowledged', source_evidence_json: mediumBinding.sourceEvidenceJson },
    { review_id: 'review-stale-old', recommendation_fingerprint: staleOldBinding.recommendationFingerprint, state: 'acknowledged', source_evidence_json: staleOldBinding.sourceEvidenceJson },
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
  commandBoardVersion: health.version,
  operationalAttentionSeparate: true,
  decisionAttentionSeparate: true,
  explicitDecisionDateScope: true,
  noOpaqueStoreScore: true,
  openDecisionQueueDrilldown: true,
  inaccessibleStoresOmitted: true,
  perStoreFailClosed: true,
  durableReviewTruth: true,
  staleReviewEvidence: true,
  recommendationCandidateFiltering: true,
  syncStartBlocked: true,
  amazonDormant: true,
  productionMutation: false,
}, null, 2));
