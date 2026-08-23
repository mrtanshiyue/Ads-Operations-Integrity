import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ui = await readFile(new URL('../assets/cloudflare-native-csv-recommendation-human-review-v1.js', import.meta.url), 'utf8');
const loader = await readFile(new URL('../assets/generated/inline-script-01.js', import.meta.url), 'utf8');
const inbox = await readFile(new URL('../assets/cloudflare-native-csv-recommendation-inbox-v1.js', import.meta.url), 'utf8');
const usability = await readFile(new URL('../assets/cloudflare-native-csv-recommendation-inbox-usability-v1.js', import.meta.url), 'utf8');
const allowlist = await readFile(new URL('./enforce-cloudflare-native-asset-allowlist.mjs', import.meta.url), 'utf8');

assert.match(ui, /const VERSION = '1\.7\.0'/, 'Human Review UI version contract is missing');
assert.match(ui, /const CONTRACT_VERSION = 'csv-recommendation-human-review-v1'/, 'Human Review server contract version is missing');
assert.match(ui, /const DECISION_PACKET_VERSION = 'recommendation-decision-packet-v1'/,
  'Recommendation Decision Packet UI contract version is missing');
assert.match(ui, /const CANDIDATE_LIBRARY_VERSION = 'governed-keyword-negative-candidate-library-v1'/,
  'Governed Keyword \/ Negative Candidate Library UI contract version is missing');
assert.match(ui, /const HISTORICAL_LEARNING_VERSION = 'historical-review-learning-v1'/,
  'Historical Review Learning UI contract version is missing');
assert.match(ui, /candidateLibraryVersion: CANDIDATE_LIBRARY_VERSION/,
  'Human Review UI public contract must expose Candidate Library version');
assert.match(ui, /historicalLearningVersion: HISTORICAL_LEARNING_VERSION/,
  'Human Review UI public contract must expose Historical Learning version');
assert.match(ui, /const REVIEW_NOTE_MAX_LENGTH = 4000/,
  'Human Review rationale client guard must preserve the 4000-character server contract');
assert.match(ui, /const DURABLE_STATES = new Set\(\['acknowledged', 'needs_review', 'approved', 'rejected'\]\)/,
  'Human Review UI must expose the four schema-backed durable review states');
assert.match(ui, /reviewContract: CONTRACT_VERSION/, 'Human Review requests must select the dedicated persistence route');
assert.match(ui, /\/api\/v1\/stores\/\$\{encodeURIComponent\(scope\.storeId\)\}\/advisory-reviews\?\$\{params\}/,
  'Human Review requests must remain store-scoped and same-origin');
assert.match(ui, /if \(!\['GET', 'POST'\]\.includes\(method\)\)/,
  'Human Review UI transport must fail closed to GET/POST only');
assert.doesNotMatch(ui, /method\s*:\s*['"](?:PUT|PATCH|DELETE)['"]/i,
  'Human Review UI must not expose generic mutation verbs');

assert.match(ui, /data-cfhr-set="needs_review"/, 'Needs-review durable table action is missing');
assert.match(ui, /data-cfhr-set="acknowledged"/, 'Acknowledgement durable table action is missing');
assert.match(ui, /data-cfhr-set="approved"/, 'Approved review-only durable table action is missing');
assert.match(ui, /data-cfhr-set="rejected"/, 'Rejected review-only durable table action is missing');
assert.doesNotMatch(ui, /data-cfhr-set="execute"/, 'Execute action must remain unavailable');
assert.ok(ui.includes('Approved / Rejected are Human Review dispositions only. They do not execute Amazon changes.'),
  'Final disposition UI copy must preserve the execution boundary');
assert.match(ui, /persistenceAuthorized !== true/, 'Client controls must remain gated by server persistence authorization');
assert.match(ui, /await loadSnapshot\(scope, \{ force: true \}\)/,
  'POST success must be followed by a fresh server read');
assert.match(ui, /human_review_read_after_write_mismatch/,
  'UI must fail closed if read-after-write does not confirm requested durable state');
assert.match(ui, /No optimistic review, reconstructed evidence, or inferred learning state is shown/,
  'UI must explicitly reject optimistic durable presentation, evidence reconstruction, and inferred learning state');

assert.match(ui, /<span>Human Review rationale \(optional\)<\/span><textarea data-cfhr-rationale maxlength="4000"/,
  'Rationale editor must live in the existing Durable Human Review drawer with maxlength=4000');
assert.match(ui, /const currentNote = item\?\.review\?\.note == null \? '' : String\(item\.review\.note\)/,
  'Editable rationale must initialize only from exact-current server review.note');
assert.doesNotMatch(ui, /latestHistoricalReview\?\.note[\s\S]{0,300}data-cfhr-rationale/,
  'Stale historical rationale must never seed the editable current rationale');
assert.doesNotMatch(ui, /staleEvidence[\s\S]{0,300}data-cfhr-rationale/,
  'Stale Decision Packet rationale must never seed the editable current rationale');
for (const durableState of ['needs_review', 'acknowledged', 'approved', 'rejected']) {
  assert.match(ui, new RegExp(`data-cfhr-drawer-set="${durableState}"`),
    `Drawer rationale action missing: ${durableState}`);
}
assert.match(ui, /noteProvided: true, note: editor\.value/,
  'Drawer state actions must explicitly submit the rationale textarea value');
assert.match(ui, /if \(noteProvided\) body\.note = submittedNote/,
  'Drawer writes must add note only when the drawer explicitly supplies it');
assert.match(ui, /void persistReview\(inboxItemId, requestedState\);/,
  'Table-row durable state actions must remain note-omitting writes');
assert.match(ui, /const normalized = raw\.trim\(\);[\s\S]*return normalized \|\| null;/,
  'Blank drawer rationale must normalize to the explicit clear value for verification');
assert.match(ui, /normalizedReviewNote\(verified\?\.review\?\.note\) !== expectedNote/,
  'Fresh GET must verify the server-normalized rationale after drawer writes');
assert.match(ui, /human_review_rationale_read_after_write_mismatch/,
  'Rationale read-after-write mismatch must fail closed');
assert.ok(ui.includes('Human Review rationale only. Not effectiveness. Not execution authority. Not Amazon mutation authority.'),
  'Rationale authoring copy must preserve effectiveness/execution/Amazon authority boundaries');

assert.match(ui, /state\.observer\?\.disconnect\(\)/, 'Human Review UI must isolate its own DOM mutations from MutationObserver feedback');
assert.match(ui, /function mutatePresentation\(callback\)/, 'Observer-isolated presentation mutation helper is missing');
assert.match(ui, /clearPresentation\(\)/, 'Human Review UI must clear stale overlay when scope/source changes');
assert.match(ui, /human_review_scope_changed_during_write/, 'A store/scope change during a write must fail closed in presentation');
assert.ok(ui.includes("const REVIEW_SCOPE_CONTROLS = new Set(['profileId', 'startDate', 'endDate', 'limit', 'sort', 'dataSource']);"),
  'Human Review transient-state invalidation must cover every request-defining scope control plus data source');
assert.match(ui, /scopeGeneration:\s*0/,
  'Human Review scope generation counter is missing');
assert.match(ui, /const writeScopeGeneration = state\.scopeGeneration;/,
  'Each Human Review write must capture the active scope generation');
assert.match(ui, /function writeScopeIsCurrent\(writeScopeKey, writeScopeGeneration\) \{[\s\S]*state\.scopeGeneration === writeScopeGeneration[\s\S]*currentSource\(\) === 'csv'[\s\S]*scopeKey\(currentScope\(\)\) === writeScopeKey;/,
  'Human Review writes must require both generation identity and full current scope identity before presenting a response');
assert.match(ui, /if \(!writeScopeIsCurrent\(writeScopeKey, writeScopeGeneration\)\) return; \/\/ human_review_scope_changed_during_write: stale response suppressed/,
  'A stale Human Review POST response must be suppressed even when a prior scope later reappears');
assert.match(ui, /catch \(error\) \{\s*if \(!writeScopeIsCurrent\(writeScopeKey, writeScopeGeneration\)\) return;/,
  'Late Human Review write failures must not contaminate the current scope UI');
assert.match(ui, /if \(writeScopeIsCurrent\(writeScopeKey, writeScopeGeneration\)\) \{\s*state\.busy\.delete\(inboxItemId\);\s*applySnapshot\(recommendationSection\(\)\);\s*\}/,
  'A stale write finally block must not clear a newer same-item busy state or repaint another scope');
assert.match(ui, /if \(REVIEW_SCOPE_CONTROLS\.has\(controlName\)\) \{\s*state\.scopeGeneration \+= 1;\s*state\.busy\.clear\(\);\s*state\.errors\.clear\(\);/,
  'Changing Human Review request scope must immediately invalidate transient busy/error state');
assert.match(ui, /function resetScope\(\) \{\s*state\.scopeGeneration \+= 1;/,
  'Store changes must advance the Human Review scope generation before clearing presentation state');
assert.match(ui, /REQUEST_TIMEOUT_MS = 30000/, 'GET/POST requests must have a bounded timeout');

assert.match(ui, /data-cfri-filter="reviewState"/, 'Human Review layer must explicitly handle the legacy session-only review filter');
assert.match(ui, /control\.value = ''/, 'Legacy session-only review filter must be cleared before durable presentation');
assert.match(ui, /label\.hidden = true/, 'Legacy review filter must be hidden rather than misrepresent durable filter support');
assert.match(ui, /All review, library, recurrence, and evidence-drift context is server-projected\. Historical recurrence is not effectiveness; execution and Amazon mutation remain disabled\./,
  'Operator copy must preserve server-authoritative historical learning, review, execution, and Amazon boundaries');

assert.match(ui, /=== 'Inbox item ID'/,
  'Evidence drawer durable state must bind through the unique Inbox item ID rather than candidate title text');
assert.match(ui, /state\.reviews\.get\(inboxItemId\)/,
  'Evidence drawer must resolve the server review snapshot by Inbox item ID');
assert.doesNotMatch(ui, /rows\.find\([\s\S]*cfriDrawerTitle/,
  'Evidence drawer must not infer durable identity from a potentially duplicated candidate title');

for (const fragment of [
  'Recommendation Decision Packet',
  '1. Recommendation + Why',
  '2. Priority evidence',
  '3. Root + Lifecycle',
  '4. Financial comparability',
  '5. Fingerprint + review evidence',
  '6. Source evidence / provenance',
  'The UI will not reconstruct recommendation evidence client-side.',
]) assert.ok(ui.includes(fragment), `Decision Packet presentation contract missing: ${fragment}`);
assert.match(ui, /packet\?\.authority\?\.readOnly !== true/, 'Decision Packet must validate the read-only authority bit');
assert.match(ui, /packet\?\.authority\?\.executionAuthorized !== false/, 'Decision Packet must reject execution authority');
assert.match(ui, /packet\?\.authority\?\.amazonMutationAuthorized !== false/, 'Decision Packet must reject Amazon mutation authority');
assert.match(ui, /review\?\.inheritedAsCurrent !== false \|\| review\?\.stale !== true/,
  'Stale evidence must be validated as non-current before rendering');
assert.match(ui, /const currentRationale = packet\?\.reviewEvidence\?\.currentRationale/,
  'Decision Packet must validate the server-projected exact-current Human Review rationale');
assert.match(ui, /data-cfdp-current-rationale/,
  'Decision Packet must render current Human Review rationale only through the dedicated packet surface');
assert.match(ui, /const rationale = String\(review\?\.currentRationale \|\| ''\)\.trim\(\)/,
  'Current Decision Packet rationale must come only from the normalized server field');
assert.match(ui, /data-cfdp-stale-rationale/,
  'Decision Packet stale evidence must conditionally render prior Human Review rationale');
assert.match(ui, /const rationale = String\(row\?\.rationale \|\| ''\)\.trim\(\)/,
  'Stale Decision Packet rationale must come only from the normalized stale evidence field');
assert.ok(ui.includes('Current Human Review rationale'),
  'Decision Packet current rationale label is missing');
assert.ok(ui.includes('Stale Human Review context only. Never inherited as current; not effectiveness, execution authority, or Amazon mutation authority.'),
  'Decision Packet stale rationale must preserve stale/effectiveness/execution/Amazon boundaries');
assert.ok(ui.includes('Human Review rationale only. It is not effectiveness, execution authority, or Amazon mutation authority.'),
  'Decision Packet current rationale must preserve effectiveness/execution/Amazon boundaries');

assert.match(ui, /state\.library = payload\.candidateLibrary/, 'Candidate Library must come from the Human Review server response');
assert.match(ui, /validateCandidateLibrary\(payload\?\.candidateLibrary, payload\.items, expectedStoreId\)/,
  'Candidate Library server response must be validated before presentation');
assert.match(ui, /data-cfgl-filter/, 'Candidate Library server-projected filters must be present');
assert.match(ui, /cfgl-filtered-out/, 'Candidate Library filters must use additive row visibility state');
assert.match(ui, /Server-projected registry and historical review intelligence only\. Filters change row visibility; they do not recompute recommendations, fingerprints, review state, evidence, rules, or learning weights\./,
  'Candidate Library and Historical Learning must explicitly reject client-side authority recomputation');

assert.match(ui, /state\.historicalLearning = payload\.historicalLearning/,
  'Historical Learning must come from the same Human Review server response');
assert.match(ui, /validateHistoricalLearning\(payload\?\.historicalLearning, payload\.items, expectedStoreId\)/,
  'Historical Learning must be validated before presentation');
assert.match(ui, /historicalLearningDrawerHtml\(item\.inboxItemId\)/,
  'Existing Recommendation drawer must render the server Historical Learning context');
assert.ok(ui.includes('Recurrence and final disposition are not effectiveness. Approved is not executed or successful; rejected is not failed.'),
  'Historical Learning semantics copy must reject disposition effectiveness inference');
assert.match(ui, /const note = String\(context\?\.latestHistoricalReview\?\.note \|\| ''\)\.trim\(\)/,
  'Historical rationale must come directly from latestHistoricalReview.note');
assert.match(ui, /if \(!note\) return '';/,
  'Blank historical rationale must stay hidden');
assert.match(ui, /data-cfhl-rationale/,
  'Historical rationale must render inside the existing Historical Learning drawer');
assert.ok(ui.includes('Prior Human Review rationale'),
  'Historical rationale must be explicitly labeled as prior Human Review context');
assert.ok(ui.includes('Historical Human Review context only. This is not current recommendation evidence, effectiveness, execution authority, or Amazon mutation authority.'),
  'Historical rationale UI must preserve evidence/effectiveness/execution/Amazon boundaries');
assert.ok(ui.includes("['approved','Approved']") && ui.includes("['rejected','Rejected']"),
  'Candidate Library review filter must expose Approved and Rejected');
assert.doesNotMatch(ui, /\/historical-learning|\/historical-review-learning/i,
  'Historical Learning must not create an independent endpoint');

assert.doesNotMatch(ui, /localStorage|sessionStorage/, 'Durable review truth must not be stored in browser persistence');
assert.doesNotMatch(ui, /optimization-actions|optimization_action_events|execution-permits|amazon-ads-api|sp-api/i,
  'Human Review UI must not expose Optimization Action, execution permit, or Amazon transport endpoints');
assert.doesNotMatch(ui, /AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED|PHASE5_SINGLE_RUN/i,
  'Human Review UI must not touch Amazon/sync enablement controls');

for (const source of [inbox, usability]) {
  assert.doesNotMatch(source, /method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i,
    'Existing Recommendation Inbox layers must remain read-only');
}

assert.match(loader, /CloudflareCsvRecommendationInboxUsability/, 'Human Review loader must wait for the existing Inbox usability layer');
assert.match(loader, /cloudflare-native-csv-recommendation-human-review-v1\.js\?v=1\.0\.0/,
  'Human Review operator asset loader is missing');
assert.match(loader, /attempts>=200/, 'Independent Human Review loader must be bounded rather than polling forever');
assert.match(loader, /event\.target\?\.name\|\|''\)!=='profileId'/,
  'Profile changes must invalidate the legacy Inbox cache path used by Human Review presentation');
assert.match(loader, /CloudflareCsvRecommendationInboxUi\?\.refresh\?\.\(\)/,
  'Profile changes must force a fresh Recommendation Inbox read');
assert.match(loader, /CloudflareCsvRecommendationHumanReviewUi\?\.refresh\?\.\(\)/,
  'Profile changes must force a fresh durable Human Review snapshot');
assert.match(allowlist, /'cloudflare-native-csv-recommendation-human-review-v1\.js'/,
  'Human Review operator asset must be explicitly deployment-allowlisted');

console.log('recommendation human review operator UI contract: PASS');
