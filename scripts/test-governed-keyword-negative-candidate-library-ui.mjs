import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ui = await readFile(new URL('../assets/cloudflare-native-csv-recommendation-human-review-v1.js', import.meta.url), 'utf8');

assert.match(ui, /CANDIDATE_LIBRARY_VERSION = 'governed-keyword-negative-candidate-library-v1'/,
  'Candidate Library UI contract version missing');
assert.match(ui, /state\.library = payload\.candidateLibrary/,
  'Candidate Library must consume the existing Human Review GET server projection');
assert.match(ui, /state\.libraryItems = new Map\(\(payload\.candidateLibrary\?\.items \|\| \[\]\)/,
  'Candidate Library item index must come directly from server library items');
assert.match(ui, /validateCandidateLibrary\(payload\?\.candidateLibrary, payload\.items, expectedStoreId\)/,
  'Server library must be validated against Human Review items');
assert.match(ui, /candidate_library_fingerprint_mismatch/,
  'Library UI must fail closed on current fingerprint mismatch');
assert.match(ui, /candidate_library_review_state_mismatch/,
  'Library UI must fail closed on Human Review state mismatch');
assert.match(ui, /candidate_library_decision_packet_missing/,
  'Library UI must require #248 Decision Packet availability');
assert.match(ui, /candidate_emission_not_authorized/,
  'Candidate-emission blocked scope must remain explicit in UI');
assert.match(ui, /candidate_library_blocked_scope_not_null/,
  'Blocked scope must reject fabricated zero candidate counts');

for (const filter of ['family', 'kind', 'priority', 'review', 'stale']) {
  assert.match(ui, new RegExp(`librarySelect\\('${filter}'`), `Candidate Library filter missing: ${filter}`);
}
for (const value of ['keyword', 'negative', 'harvest', 'scale', 'exact_negative', 'phrase_negative_review', 'critical', 'high', 'medium', 'low', 'unreviewed', 'needs_review', 'acknowledged', 'has_stale', 'no_stale']) {
  assert.ok(ui.includes(`'${value}'`), `Candidate Library filter value missing: ${value}`);
}

assert.match(ui, /row\.classList\.toggle\('cfgl-filtered-out', !libraryRowVisible\(inboxItemId\)\)/,
  'Library filters must only add an independent visibility class to existing Inbox rows');
assert.doesNotMatch(ui, /row\.hidden\s*=|row\.style\.display\s*=/,
  'Library layer must not overwrite existing Inbox row visibility authority');
assert.match(ui, /function currentDrawerReview\(section\)/,
  'Existing drawer binding must remain present');
assert.match(ui, /decisionPacketHtml\(item\.decisionPacket\)/,
  'Library drill-through must reuse #248 Decision Packet in the existing drawer');
assert.doesNotMatch(ui, /fetch\([^\n]*candidate-library|\/candidate-library|\/keyword-library|\/negative-library/i,
  'Library UI must not create an independent network endpoint');
assert.match(ui, /Server-projected registry only\. Filters change row visibility; they do not recompute recommendations, fingerprints, review state, or evidence\./,
  'Library UI must state that filters are presentation-only');
assert.doesNotMatch(ui, /\bstoreScore\b|urgencyMultiplier|financialImpactScore/i,
  'Library UI must not implement an opaque score');
assert.match(ui, /No auto acknowledge, auto approve, Optimization Action, execution permit, Store Score, or Amazon mutation is authorized\./,
  'Decision Packet safety copy must continue to prohibit Store Score and execution authority');
assert.doesNotMatch(ui, /data-cfhr-set="(?:approved|rejected|execute)"/,
  'Library UI must not expose approve/reject/execute actions');
assert.doesNotMatch(ui, /amazon-ads-api|sp-api|AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED|startSync/i,
  'Library UI must have no Amazon or sync path');

console.log(JSON.stringify({
  ok: true,
  contract: 'governed-keyword-negative-candidate-library-ui-v1',
  serverProjectionOnly: true,
  filters: ['family', 'kind', 'priority', 'review', 'stale'],
  decisionPacketReused: true,
  storeScoreImplemented: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}));
