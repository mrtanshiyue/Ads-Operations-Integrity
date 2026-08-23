import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SEARCH_TERM_INTELLIGENCE_SCHEMA_VERSION,
  SEARCH_TERM_MODEL_VERSION,
  buildRecommendationAuthority,
  buildRecommendationPreview,
  canonicalJson,
  deriveSearchTermMetrics,
  deterministicFingerprint,
} from '../cloudflare/runtime/decision-intelligence.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const metrics = deriveSearchTermMetrics({ impressions: 1000, clicks: 20, purchases: 2, costMicros: 5_000_000, salesMicros: 10_000_000 });
assert.equal(metrics.acos, 0.5);
assert.equal(metrics.roas, 2);
assert.equal(metrics.cvr, 0.1);
assert.equal(metrics.cpcMicros, 250_000);
assert.equal(metrics.ctr, 0.02);
assert.equal(metrics.orders, 2);

const canonicalA = canonicalJson({ z: 1, a: { y: 2, x: 3 } });
const canonicalB = canonicalJson({ a: { x: 3, y: 2 }, z: 1 });
assert.equal(canonicalA, canonicalB);
assert.equal(await deterministicFingerprint({ z: 1, a: 2 }), await deterministicFingerprint({ a: 2, z: 1 }));

const validEvidence = {
  lineageValid: true,
  factRowCount: 2,
  invalidLineageCount: 0,
  sourceReportJobIds: ['job-01'],
  amazonReportIds: ['amazon-report-01'],
  r2ObjectKeys: ['amazon/store-01/report.json'],
  contentSha256s: ['a'.repeat(64)],
};

const wastePreview = await buildRecommendationPreview({
  storeId: 'store-dev-01',
  profileId: 'profile-synth-dev-01',
  analysisWindow: { startDate: '2026-08-01', endDate: '2026-08-17' },
  entity: { entityId: 'term-01', searchTerm: 'reading glasses' },
  metrics: { impressions: 500, clicks: 12, purchases: 0, costMicros: 2_000_000, salesMicros: 0 },
  evidence: validEvidence,
  env: { APP_ENV: 'development', RECOMMENDATION_AUTHORITY_ENABLED: 'false' },
});
assert.equal(wastePreview.schemaVersion, SEARCH_TERM_INTELLIGENCE_SCHEMA_VERSION);
assert.equal(wastePreview.modelVersion, SEARCH_TERM_MODEL_VERSION);
assert.equal(wastePreview.recommendation.actionType, 'negative_keyword.create');
assert.equal(wastePreview.recommendation.executionAuthorized, false);
assert.equal(wastePreview.recommendation.persistenceAuthorized, false);
assert.equal(wastePreview.authority.authoritative, false);
assert.equal(wastePreview.authority.mode, 'development_preview');
assert.match(wastePreview.fingerprint, /^[a-f0-9]{64}$/);

const harvestPreview = await buildRecommendationPreview({
  storeId: 'store-dev-01',
  profileId: 'profile-synth-dev-01',
  analysisWindow: { startDate: '2026-08-01', endDate: '2026-08-17' },
  entity: { entityId: 'term-02', searchTerm: 'blue light readers' },
  metrics: { impressions: 800, clicks: 20, purchases: 4, costMicros: 3_000_000, salesMicros: 15_000_000 },
  evidence: validEvidence,
  env: { APP_ENV: 'development' },
});
assert.equal(harvestPreview.recommendation.actionType, 'keyword.create');
assert.equal(harvestPreview.recommendation.proposed.bidMicros, null);
assert.equal(harvestPreview.authority.authoritative, false);

const productionWithoutAuthority = buildRecommendationAuthority({
  env: { APP_ENV: 'production' },
  profileId: 'real-profile-01',
  lineageValid: true,
});
assert.equal(productionWithoutAuthority.authoritative, false);
assert.ok(productionWithoutAuthority.reasons.includes('recommendation_authority_disabled'));
assert.equal(productionWithoutAuthority.amazonMutationAuthorized, false);

const [apiSource, actionsSource, uiSource] = await Promise.all([
  readFile(path.join(repoRoot, 'cloudflare/runtime/search-term-intelligence-api.js'), 'utf8'),
  readFile(path.join(repoRoot, 'cloudflare/runtime/optimization-actions-api.js'), 'utf8'),
  readFile(path.join(repoRoot, 'assets/cloudflare-native-decision-intelligence-v1.js'), 'utf8'),
]);

assert.match(apiSource, /profile_id_required/);
assert.match(apiSource, /search-term-intelligence/);
assert.match(apiSource, /recommendation-preview/);
assert.match(apiSource, /invalid_lineage_count/);
assert.match(apiSource, /content_sha256/);
assert.match(apiSource, /existing_negative_collision/);
assert.match(apiSource, /authoritativeRecommendationCount/);
assert.doesNotMatch(apiSource, /advertising-api\.amazon\.com/);

assert.match(actionsSource, /optimization-actions/);
assert.match(actionsSource, /action_execution_disabled/);
assert.match(actionsSource, /amazonMutationAttempted:\s*false/);
assert.match(actionsSource, /amazonMutationAuthorized:\s*false/);
assert.doesNotMatch(actionsSource, /fetch\s*\(/);

assert.match(uiSource, /NON-AUTHORITATIVE PREVIEW/);
assert.match(uiSource, /Development preview \/ non-authoritative/);
assert.match(uiSource, /Action Inbox/);
assert.match(uiSource, /Amazon execution remains disabled/);
assert.match(uiSource, /intelligenceSerial:\s*0,\s*actionsSerial:\s*0/);
assert.match(uiSource, /state\.intelligenceSerial \+= 1;\s*state\.actionsSerial \+= 1;/);
assert.match(uiSource, /const serial = \+\+state\.intelligenceSerial;/);
assert.match(uiSource, /serial !== state\.intelligenceSerial \|\| storeId !== currentStoreId\(\)/);
assert.match(uiSource, /const serial = \+\+state\.actionsSerial;/);
assert.match(uiSource, /serial !== state\.actionsSerial \|\| storeId !== currentStoreId\(\)/);

assert.match(uiSource, /DECISION_SCOPE_CONTROLS = new Set\(\['profileId', 'startDate', 'endDate', 'limit', 'sort'\]\)/,
  'Decision preview controls must define an explicit scope invalidation set');
assert.match(uiSource, /detailSerial:\s*0,\s*governanceSerial:\s*0/,
  'Decision UI must track governance response ownership independently');
assert.match(uiSource, /state\.governanceSerial \+= 1;[\s\S]{0,220}state\.dryRuns\.clear\(\)/,
  'Store changes must invalidate in-flight governance presentation and prior dry-run authorization');
assert.match(uiSource, /function handleDecisionScopeChange\(event\)[\s\S]{0,500}state\.payload = null;[\s\S]{0,200}state\.dryRuns\.clear\(\)/,
  'Profile/date/limit/sort changes must remove stale preview and dry-run state before further governance actions');
assert.match(uiSource, /function handleDecisionScopeChange\(event\)[\s\S]{0,900}if \(name === 'profileId'\) \{[\s\S]{0,180}state\.actionsSerial \+= 1;[\s\S]{0,120}state\.actions = null;[\s\S]{0,180}querySelector\('\[data-actions-results\]'\)\.innerHTML = '';[\s\S]{0,360}state\.open && state\.tab === 'actions'\) void loadActions\(\);/,
  'Profile changes must invalidate, clear, and refresh the profile-filtered Action Inbox');
assert.match(uiSource, /function setOpen\(open\)[\s\S]{0,260}if \(state\.tab === 'actions' && !state\.actions\) void loadActions\(\);/,
  'Reopening Decision Intelligence on an invalidated Action Inbox must load the current scope instead of presenting blank state');
assert.match(uiSource, /const profileId = value\(panel, 'profileId'\);\s*if \(profileId\) params\.set\('profileId', profileId\);/,
  'Action Inbox requests must remain explicitly filtered by the current profile when present');
assert.match(uiSource, /const serial = \+\+state\.governanceSerial;/,
  'Governance operations must capture a generation before awaiting');
assert.match(uiSource, /actionCollectionUrl\(true, storeId\)/,
  'Dry-run must bind its request URL to the captured store');
assert.match(uiSource, /actionCollectionUrl\(false, storeId\)/,
  'Proposed-action persistence must bind its request URL to the captured store');
assert.match(uiSource, /actionTransitionUrl\(actionId, 'reject', storeId\)/,
  'Reject transition must bind its request URL to the captured store');
assert.match(uiSource, /actionTransitionUrl\(actionId, 'approve', storeId\)/,
  'Approve transition must bind its request URL to the captured store');
assert.match(uiSource, /serial !== state\.governanceSerial \|\| storeId !== currentStoreId\(\)/,
  'Late governance responses must not update a different current store');
assert.match(uiSource, /function actionCollectionUrl\(dryRun, storeId = currentStoreId\(\)\)/,
  'Action collection URL helper must accept captured store ownership');
assert.match(uiSource, /function actionTransitionUrl\(actionId, transition, storeId = currentStoreId\(\)\)/,
  'Action transition URL helper must accept captured store ownership');
assert.doesNotMatch(uiSource, /\/apply['"`]/);

console.log(JSON.stringify({
  ok: true,
  contract: 'decision-intelligence-mvp-v1',
  schemaVersion: SEARCH_TERM_INTELLIGENCE_SCHEMA_VERSION,
  modelVersion: SEARCH_TERM_MODEL_VERSION,
  deterministicFingerprint: true,
  authorityGuard: 'fail-closed',
  crossStoreLateResponseSuppression: true,
  governanceScopeOwnership: true,
  decisionScopeInvalidation: true,
  actionInboxProfileScopeInvalidation: true,
  actionInboxReopenRefresh: true,
  amazonMutationAuthorized: false,
}, null, 2));
