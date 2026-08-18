import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const reviewUiRelative = 'assets/cloudflare-native-csv-library-review-v1.js';
const bridgeRelative = 'assets/csv-analysis-engine/csv-library-review-bridge.js';
const reviewUiSource = await readFile(path.join(distRoot, reviewUiRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const bridgeSource = await readFile(path.join(repoRoot, 'cloudflare/runtime/csv-library-review-bridge.js'), 'utf8');
const builtBridgeSource = await readFile(path.join(distRoot, bridgeRelative), 'utf8');
const jointTag = '<script type="module" src="assets/cloudflare-native-csv-joint-analysis-v1.js?v=1.0.0"></script>';
const reviewTag = '<script type="module" src="assets/cloudflare-native-csv-library-review-v1.js?v=1.0.0"></script>';
const productTag = '<script src="assets/cloudflare-native-csv-product-ui-v2.js"></script>';

assert.equal(indexSource.split(reviewTag).length - 1, 1, 'Local library review UI must be injected exactly once');
assert.ok(indexSource.indexOf(jointTag) < indexSource.indexOf(reviewTag), 'Local review UI must load after joint analysis');
assert.ok(indexSource.indexOf(reviewTag) < indexSource.indexOf(productTag), 'Local review UI must load before CSV product UI');
assert.equal(builtBridgeSource, bridgeSource, 'Built local review bridge must be byte-identical to canonical runtime source');
assert.match(reviewUiSource, /buildCsvLibraryReviewBridge/);
assert.match(reviewUiSource, /keyword_library/);
assert.match(reviewUiSource, /negative_keyword_library/);
assert.match(reviewUiSource, /shortlisted/);
assert.match(reviewUiSource, /Browser memory only/);
assert.match(reviewUiSource, /No library write occurred/);
assert.match(reviewUiSource, /Candidate group/);
assert.match(reviewUiSource, /Identity confidence/);
assert.match(reviewUiSource, /Priority ↓/);
assert.match(reviewUiSource, /Spend ↓/);
assert.match(reviewUiSource, /Orders ↓/);
assert.match(reviewUiSource, /ACoS ↓/);
assert.match(reviewUiSource, /Candidate A–Z/);
assert.match(reviewUiSource, /Keyword harvest/);
assert.match(reviewUiSource, /Exact negative/);
assert.match(reviewUiSource, /Phrase negative review/);
assert.match(reviewUiSource, /Efficient converting search term/);
assert.match(reviewUiSource, /Spend without orders/);
assert.match(reviewUiSource, /Toxic root pattern/);
assert.match(reviewUiSource, /selectCsvLibraryReviewItems/);
assert.match(reviewUiSource, /Select decision reason/);
assert.match(reviewUiSource, /Evidence supports follow-up/);
assert.match(reviewUiSource, /Identity resolution needed/);
assert.match(reviewUiSource, /More data needed/);
assert.match(reviewUiSource, /Irrelevant or duplicate/);
assert.match(reviewUiSource, /Other operator reason/);
assert.match(reviewUiSource, /transition-compatible decision reason/i);
assert.match(reviewUiSource, /browser-memory only/i);
assert.match(reviewUiSource, /persistence disabled/i);
assert.match(reviewUiSource, /currentAnnotations/);
assert.match(reviewUiSource, /canApplyLocalReviewTransition/);
assert.match(reviewUiSource, /localFollowUpReadiness/);
assert.match(reviewUiSource, /LOCAL_REVIEW_REASON_STATE_MISMATCH/);

for (const pattern of [
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /navigator\.sendBeacon/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /CloudflareNativeAPI/,
  /\/api\/v1\//,
  /createKeyword/,
  /createNegativeKeyword/,
  /putProductKeyword/,
  /putStoreNegativeKeyword/,
  /putProductNegativeKeyword/,
  /optimization-actions/,
  /execution-permits/,
]) {
  assert.equal(pattern.test(reviewUiSource), false, `Local library review UI must remain side-effect free: ${pattern}`);
}

const jointUi = await import(`${pathToFileURL(path.join(distRoot, 'assets/cloudflare-native-csv-joint-analysis-v1.js')).href}?library-review=${Date.now()}`);
const bridge = await import(`${pathToFileURL(path.join(distRoot, bridgeRelative)).href}?library-review=${Date.now()}`);
const reviewUi = await import(`${pathToFileURL(path.join(distRoot, reviewUiRelative)).href}?library-review-ux=${Date.now()}`);
assert.equal(bridge.CSV_LIBRARY_REVIEW_BRIDGE_SCHEMA_VERSION, 'csv-library-review-bridge-v1');
assert.equal(typeof bridge.buildCsvLibraryReviewBridge, 'function');
assert.equal(reviewUi.CSV_LIBRARY_REVIEW_UI_VERSION, '1.0.0');
assert.equal(typeof reviewUi.selectCsvLibraryReviewItems, 'function');
assert.equal(typeof reviewUi.canApplyLocalReviewTransition, 'function');
assert.equal(typeof reviewUi.localFollowUpReadiness, 'function');
assert.equal(reviewUi.rationaleLabel('efficient_converting_search_term'), 'Efficient converting search term');
assert.equal(reviewUi.rationaleLabel('spend_without_orders'), 'Spend without orders');
assert.equal(reviewUi.rationaleLabel('toxic_root_pattern'), 'Toxic root pattern');
assert.equal(reviewUi.reviewReasonLabel('evidence_supports_follow_up'), 'Evidence supports follow-up');
assert.equal(reviewUi.reviewReasonLabel('irrelevant_or_duplicate'), 'Irrelevant or duplicate');
assert.deepEqual(reviewUi.canApplyLocalReviewTransition('open', {}), { allowed: true, code: 'LOCAL_REVIEW_OPEN_ALLOWED' });
assert.deepEqual(reviewUi.canApplyLocalReviewTransition('shortlisted', {}), { allowed: false, code: 'LOCAL_REVIEW_REASON_REQUIRED' });
assert.deepEqual(reviewUi.canApplyLocalReviewTransition('shortlisted', { reasonCode: 'evidence_supports_follow_up' }), { allowed: true, code: 'LOCAL_REVIEW_TRANSITION_ALLOWED' });
assert.deepEqual(reviewUi.canApplyLocalReviewTransition('shortlisted', { reasonCode: 'identity_resolution_needed' }), { allowed: true, code: 'LOCAL_REVIEW_TRANSITION_ALLOWED' });
assert.deepEqual(reviewUi.canApplyLocalReviewTransition('shortlisted', { reasonCode: 'more_data_needed' }), { allowed: true, code: 'LOCAL_REVIEW_TRANSITION_ALLOWED' });
assert.deepEqual(reviewUi.canApplyLocalReviewTransition('shortlisted', { reasonCode: 'irrelevant_or_duplicate' }), { allowed: false, code: 'LOCAL_REVIEW_REASON_STATE_MISMATCH' });
assert.deepEqual(reviewUi.canApplyLocalReviewTransition('dismissed', { reasonCode: 'irrelevant_or_duplicate' }), { allowed: true, code: 'LOCAL_REVIEW_TRANSITION_ALLOWED' });
assert.deepEqual(reviewUi.canApplyLocalReviewTransition('dismissed', { reasonCode: 'evidence_supports_follow_up' }), { allowed: false, code: 'LOCAL_REVIEW_REASON_STATE_MISMATCH' });
assert.deepEqual(reviewUi.canApplyLocalReviewTransition('dismissed', { reasonCode: 'identity_resolution_needed' }), { allowed: false, code: 'LOCAL_REVIEW_REASON_STATE_MISMATCH' });
assert.deepEqual(reviewUi.canApplyLocalReviewTransition('dismissed', { reasonCode: 'more_data_needed' }), { allowed: false, code: 'LOCAL_REVIEW_REASON_STATE_MISMATCH' });
assert.deepEqual(reviewUi.canApplyLocalReviewTransition('dismissed', { reasonCode: 'operator_other' }), { allowed: false, code: 'LOCAL_REVIEW_OTHER_NOTE_REQUIRED' });
assert.deepEqual(reviewUi.canApplyLocalReviewTransition('dismissed', { reasonCode: 'operator_other', note: 'Manual operator context' }), { allowed: true, code: 'LOCAL_REVIEW_TRANSITION_ALLOWED' });
assert.deepEqual(reviewUi.canApplyLocalReviewTransition('invalid', { reasonCode: 'evidence_supports_follow_up' }), { allowed: false, code: 'LOCAL_REVIEW_STATE_INVALID' });

const header = [
  'Date', 'Advertiser Account Id', 'Profile Id', 'Marketplace', 'Currency',
  'Campaign Id', 'Campaign Name', 'Ad Group Id', 'Ad Group Name',
  'Targeting Id', 'Targeting', 'Match Type', 'Customer Search Term',
  'Impressions', 'Clicks', 'Spend', '7 Day Total Orders', '7 Day Total Sales', '7 Day Total Units',
];
const fileA = csv(header, [
  ['2026-07-01', 'adv-1', 'profile-1', 'US', 'USD', 'campaign-1', 'Readers Core', 'adgroup-1', 'Core', 'target-profit', 'reading glasses', 'BROAD', 'reading glasses women', '1000', '10', '1.00', '3', '10.00', '3'],
  ['2026-07-01', 'adv-1', 'profile-1', 'US', 'USD', 'campaign-1', 'Readers Core', 'adgroup-1', 'Core', 'target-cheap', 'cheap readers', 'BROAD', 'cheap blue readers', '800', '10', '2.00', '0', '0.00', '0'],
]);
const fileB = csv(header, [
  ['2026-07-02', 'adv-1', 'profile-1', 'US', 'USD', 'campaign-1', 'Readers Core', 'adgroup-1', 'Core', 'target-profit', 'reading glasses', 'BROAD', 'reading glasses men', '900', '9', '1.00', '3', '10.00', '3'],
  ['2026-07-02', 'adv-1', 'profile-1', 'US', 'USD', 'campaign-1', 'Readers Core', 'adgroup-1', 'Core', 'target-cheap', 'cheap reading glasses', 'BROAD', 'cheap plastic readers', '700', '10', '2.00', '0', '0.00', '0'],
]);
const inputs = [
  { name: 'search-term-2026-07-01.csv', text: fileA },
  { name: 'search-term-2026-07-02.csv', text: fileB },
];
const options = { uploadedAt: '2026-08-18T08:00:00.000Z' };
const joint = await jointUi.analyzeLocalCsvInputs(inputs, options);
const queue = await bridge.buildCsvLibraryReviewBridge(joint);

assert.equal(queue.authority.authoritative, false);
assert.equal(queue.authority.canonicalAmazonIdentityResolved, false);
assert.equal(queue.authority.governancePersistenceAllowed, false);
assert.equal(queue.authority.executionAuthorized, false);
assert.equal(queue.authority.amazonMutationAuthorized, false);
assert.equal(queue.summary.reviewItemCount, 6);
assert.equal(queue.summary.keywordLibraryCandidateCount, 2);
assert.equal(queue.summary.negativeLibraryCandidateCount, 4);
assert.equal(queue.summary.exactNegativeCandidateCount, 2);
assert.equal(queue.summary.phraseNegativeReviewCount, 2);
assert.equal(queue.summary.blockedObservedIdentityCount, 4);
assert.equal(queue.source.inputSetFingerprint, joint.source.inputSetFingerprint);
assert.ok(queue.items.every((item) => item.initialReviewState === 'open'));
assert.ok(queue.items.every((item) => item.requiresHumanReview === true));
assert.ok(queue.items.every((item) => item.persistenceAuthorized === false));
assert.ok(queue.items.every((item) => item.executionAuthorized === false));
assert.ok(queue.items.every((item) => item.amazonMutationAuthorized === false));
assert.ok(queue.items.every((item) => item.source.canonicalAmazonIdentityResolved === false));
assert.ok(queue.items.every((item) => /^csv-library-review:[a-f0-9]{64}$/.test(item.reviewId)));
assert.ok(queue.items.some((item) => item.destination === 'keyword_library' && item.value === 'reading glasses women' && item.suggestedMatchType === 'EXACT'));
assert.ok(queue.items.some((item) => item.destination === 'negative_keyword_library' && item.value === 'cheap' && item.candidateKind === 'negative_phrase_root' && item.suggestedMatchType === 'PHRASE'));
assert.ok(queue.items.some((item) => item.destination === 'negative_keyword_library' && item.value === 'readers' && item.candidateKind === 'negative_phrase_root' && item.suggestedMatchType === 'PHRASE'));
assert.ok(queue.items.filter((item) => item.destination === 'negative_keyword_library').every((item) => item.observedIdentity.confidenceBlocked === true));
assert.ok(queue.items.filter((item) => item.destination === 'keyword_library').every((item) => item.observedIdentity.confidenceBlocked === false));

const allStates = new Map(queue.items.map((item) => [item.reviewId, 'open']));
const keywordGroup = reviewUi.selectCsvLibraryReviewItems(queue.items, { candidateGroup: 'keyword_harvest' }, allStates);
assert.equal(keywordGroup.length, 2);
assert.ok(keywordGroup.every((item) => item.candidateKind === 'keyword_harvest'));
const exactNegatives = reviewUi.selectCsvLibraryReviewItems(queue.items, { destination: 'negative_keyword_library', candidateGroup: 'negative_exact', confidence: 'blocked' }, allStates);
assert.equal(exactNegatives.length, 2);
assert.ok(exactNegatives.every((item) => item.candidateKind === 'negative_exact' && item.observedIdentity.confidenceBlocked === true));
const phraseByRationale = reviewUi.selectCsvLibraryReviewItems(queue.items, { search: 'toxic root pattern' }, allStates);
assert.equal(phraseByRationale.length, 2);
assert.ok(phraseByRationale.every((item) => item.rationaleCode === 'toxic_root_pattern'));
const exactByRationale = reviewUi.selectCsvLibraryReviewItems(queue.items, { search: 'spend without orders' }, allStates);
assert.equal(exactByRationale.length, 2);
assert.ok(exactByRationale.every((item) => item.rationaleCode === 'spend_without_orders'));
const observedOnly = reviewUi.selectCsvLibraryReviewItems(queue.items, { confidence: 'observed' }, allStates);
assert.equal(observedOnly.length, 2);
assert.ok(observedOnly.every((item) => item.observedIdentity.quality === 'observed_only'));
const spendSorted = reviewUi.selectCsvLibraryReviewItems(queue.items, { sort: 'spend_desc' }, allStates);
assert.ok(spendSorted.every((item, index) => index === 0 || Number(spendSorted[index - 1].metrics?.spendMicros || 0) >= Number(item.metrics?.spendMicros || 0)));
const candidateSorted = reviewUi.selectCsvLibraryReviewItems(queue.items, { sort: 'candidate_asc' }, allStates);
assert.deepEqual(
  candidateSorted.map((item) => item.normalizedValue),
  [...candidateSorted.map((item) => item.normalizedValue)].sort((a, b) => a.localeCompare(b)),
  'Candidate A-Z sort must be deterministic',
);
const shortlistedId = queue.items[0].reviewId;
const changedStates = new Map(allStates);
changedStates.set(shortlistedId, 'shortlisted');
const shortlisted = reviewUi.selectCsvLibraryReviewItems(queue.items, { reviewState: 'shortlisted' }, changedStates);
assert.deepEqual(shortlisted.map((item) => item.reviewId), [shortlistedId]);

const observedKeyword = queue.items.find((item) => item.destination === 'keyword_library' && item.observedIdentity.quality === 'observed_only');
const blockedNegative = queue.items.find((item) => item.destination === 'negative_keyword_library' && item.observedIdentity.confidenceBlocked === true);
assert.ok(observedKeyword);
assert.ok(blockedNegative);
assert.deepEqual(
  reviewUi.localFollowUpReadiness(observedKeyword, 'shortlisted', { reasonCode: 'evidence_supports_follow_up', note: '' }),
  { state: 'local_follow_up_ready', label: 'Local follow-up ready', persistenceReady: false, executionReady: false },
);
assert.deepEqual(
  reviewUi.localFollowUpReadiness(blockedNegative, 'shortlisted', { reasonCode: 'evidence_supports_follow_up', note: '' }),
  { state: 'blocked_observed_identity', label: 'Identity blocked', persistenceReady: false, executionReady: false },
);
assert.deepEqual(
  reviewUi.localFollowUpReadiness(observedKeyword, 'shortlisted', { reasonCode: 'identity_resolution_needed', note: '' }),
  { state: 'identity_resolution_needed', label: 'Identity resolution needed', persistenceReady: false, executionReady: false },
);
assert.deepEqual(
  reviewUi.localFollowUpReadiness(observedKeyword, 'shortlisted', { reasonCode: 'more_data_needed', note: '' }),
  { state: 'more_data_needed', label: 'More data needed', persistenceReady: false, executionReady: false },
);
assert.deepEqual(
  reviewUi.localFollowUpReadiness(observedKeyword, 'shortlisted', { reasonCode: 'operator_other', note: 'Keep for manual context review' }),
  { state: 'operator_context_review', label: 'Operator context review', persistenceReady: false, executionReady: false },
);
assert.deepEqual(
  reviewUi.localFollowUpReadiness(observedKeyword, 'shortlisted', { reasonCode: 'irrelevant_or_duplicate', note: '' }),
  { state: 'decision_reason_state_mismatch', label: 'Decision reason/state mismatch', persistenceReady: false, executionReady: false },
);
assert.deepEqual(
  reviewUi.localFollowUpReadiness(observedKeyword, 'open', {}),
  { state: 'not_shortlisted', label: 'Not shortlisted', persistenceReady: false, executionReady: false },
);
assert.deepEqual(
  reviewUi.localFollowUpReadiness(observedKeyword, 'shortlisted', {}),
  { state: 'decision_reason_missing', label: 'Decision reason missing', persistenceReady: false, executionReady: false },
);
assert.deepEqual(
  reviewUi.localFollowUpReadiness(observedKeyword, 'dismissed', { reasonCode: 'irrelevant_or_duplicate' }),
  { state: 'dismissed', label: 'Dismissed locally', persistenceReady: false, executionReady: false },
);
assert.deepEqual(
  reviewUi.localFollowUpReadiness(observedKeyword, 'dismissed', { reasonCode: 'evidence_supports_follow_up' }),
  { state: 'decision_reason_state_mismatch', label: 'Decision reason/state mismatch', persistenceReady: false, executionReady: false },
);

const reversedJoint = await jointUi.analyzeLocalCsvInputs([...inputs].reverse(), options);
const reversedQueue = await bridge.buildCsvLibraryReviewBridge(reversedJoint);
assert.equal(reversedQueue.source.inputSetFingerprint, queue.source.inputSetFingerprint);
assert.deepEqual(reversedQueue.items.map((item) => item.reviewId), queue.items.map((item) => item.reviewId), 'Review IDs must be stable across input order');

await assert.rejects(
  bridge.buildCsvLibraryReviewBridge({
    ...joint,
    source: { ...joint.source, executionAuthorized: true },
  }),
  (error) => error?.code === 'CSV_LIBRARY_REVIEW_AUTHORITY_ESCALATION_BLOCKED',
  'Local library review bridge must fail closed on authority escalation',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-library-review-bridge-v1',
  reviewItemCount: queue.summary.reviewItemCount,
  keywordLibraryCandidateCount: queue.summary.keywordLibraryCandidateCount,
  negativeLibraryCandidateCount: queue.summary.negativeLibraryCandidateCount,
  blockedObservedIdentityCount: queue.summary.blockedObservedIdentityCount,
  searchFilter: true,
  candidateGroupFilter: true,
  identityConfidenceFilter: true,
  reviewStateFilter: true,
  deterministicSorts: true,
  operatorRationaleLabels: true,
  transitionCompatibleDecisionReasons: true,
  localDecisionNotes: true,
  localFollowUpReadiness: true,
  persistenceReady: false,
  executionReady: false,
  inputSetFingerprint: queue.source.inputSetFingerprint,
}, null, 2));

function csv(headers, rows) {
  return [headers, ...rows].map((row) => row.map(cell).join(',')).join('\n');
}
function cell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
