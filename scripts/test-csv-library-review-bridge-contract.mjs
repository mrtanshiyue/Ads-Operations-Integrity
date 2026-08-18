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
assert.equal(bridge.CSV_LIBRARY_REVIEW_BRIDGE_SCHEMA_VERSION, 'csv-library-review-bridge-v1');
assert.equal(typeof bridge.buildCsvLibraryReviewBridge, 'function');

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
assert.equal(queue.summary.reviewItemCount, 5);
assert.equal(queue.summary.keywordLibraryCandidateCount, 2);
assert.equal(queue.summary.negativeLibraryCandidateCount, 3);
assert.equal(queue.summary.exactNegativeCandidateCount, 2);
assert.equal(queue.summary.phraseNegativeReviewCount, 1);
assert.equal(queue.summary.blockedObservedIdentityCount, 3);
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
assert.ok(queue.items.filter((item) => item.destination === 'negative_keyword_library').every((item) => item.observedIdentity.confidenceBlocked === true));
assert.ok(queue.items.filter((item) => item.destination === 'keyword_library').every((item) => item.observedIdentity.confidenceBlocked === false));

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
  inputSetFingerprint: queue.source.inputSetFingerprint,
}, null, 2));

function csv(headers, rows) {
  return [headers, ...rows].map((row) => row.map(cell).join(',')).join('\n');
}
function cell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
