import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ui = await readFile(new URL('../assets/cloudflare-native-csv-recommendation-human-review-v1.js', import.meta.url), 'utf8');

assert.match(ui, /HISTORICAL_LEARNING_VERSION = 'historical-review-learning-v1'/,
  'Historical Learning UI contract version missing');
assert.match(ui, /historicalLearningVersion: HISTORICAL_LEARNING_VERSION/,
  'Historical Learning version must be exposed through the existing Human Review UI contract');
assert.match(ui, /state\.historicalLearning = payload\.historicalLearning/,
  'Historical Learning must come from the existing Human Review GET payload');
assert.match(ui, /state\.historicalCurrentByInboxItem = new Map\(\(payload\.historicalLearning\?\.contexts \|\| \[\]\)/,
  'Current historical context index must come directly from server contexts');
assert.match(ui, /\.filter\(\(context\) => context\?\.currentCandidateActive === true && String\(context\?\.inboxItemId \|\| ''\)\)/,
  'Only current-active contexts may be indexed onto Recommendation Inbox rows');
assert.match(ui, /validateHistoricalLearning\(payload\?\.historicalLearning, payload\.items, expectedStoreId\)/,
  'Historical Learning must be validated before presentation');

for (const flag of ['adaptiveLearningAuthorized', 'ruleMutationAuthorized', 'recommendationMutationAuthorized', 'executionAuthorized', 'amazonMutationAuthorized']) {
  assert.ok(ui.includes(`'${flag}'`), `Historical Learning authority validation missing: ${flag}`);
}
for (const semantic of [
  'recurrenceIsEffectiveness',
  'acknowledgedMeansApproved',
  'acknowledgedMeansExecuted',
  'needsReviewMeansRejected',
  'approvedMeansExecuted',
  'approvedMeansSuccessful',
  'rejectedMeansFailed',
  'finalDispositionIsEffectiveness',
  'historicalOutcomeAvailable',
  'automaticFeedbackIntoRecommendations',
]) {
  assert.ok(ui.includes(`'${semantic}'`), `Historical Learning semantic validation missing: ${semantic}`);
}

assert.match(ui, /historical_learning_historical_only_current_state_invalid/,
  'Historical-only contexts must fail closed if they claim current state');
assert.match(ui, /historical_learning_current_item_coverage_mismatch/,
  'Every current Recommendation item must have exactly one Historical Learning current context');
assert.match(ui, /historical_learning_current_fingerprint_mismatch/,
  'Historical Learning current fingerprint must match Human Review current fingerprint');
assert.match(ui, /historical_learning_current_review_state_mismatch/,
  'Historical Learning current review state must match Human Review current state');

assert.match(ui, /librarySelect\('history', 'History', filters\.history, \[\['all','All'\],\['recurring','Recurring'\],\['no_history','No review history'\]\]\)/,
  'Historical Learning must extend the existing Candidate Library with presentation-only history filters');
assert.match(ui, /filters\.history === 'recurring' && learning\?\.recurrent !== true/,
  'Recurring filter must use the server recurrence flag');
assert.match(ui, /filters\.history === 'no_history' && Number\(learning\?\.historicalRecordCount\) !== 0/,
  'No-history filter must use the server historical record count');
assert.doesNotMatch(ui, /(?:context|learning)\?*\.?recurrent\s*=(?!=)|(?:context|learning)\?*\.?historicalRecordCount\s*=(?!=)|(?:context|learning)\?*\.?currentEvidenceDrift\s*=(?!=)/,
  'UI must not assign/recompute Historical Learning facts');

assert.match(ui, /data-cfhl-historical-only/,
  'Historical-only contexts must be presented in a separate compact details surface');
assert.match(ui, /historicalOnly = \(learning\?\.contexts \|\| \[\]\)\.filter\(\(context\) => context\?\.currentCandidateActive !== true/,
  'Historical-only contexts must be selected explicitly by server currentCandidateActive=false');
assert.doesNotMatch(ui, /createElement\(['"]tr['"]\)|insertRow\(/,
  'Historical-only contexts must never be injected as current Recommendation Inbox rows');
assert.match(ui, /historicalLearningDrawerHtml\(item\.inboxItemId\)/,
  'Current Recommendation drawer must reuse server Historical Learning context');
assert.match(ui, /state\.historicalCurrentByInboxItem\.get\(String\(inboxItemId \|\| ''\)\)/,
  'Drawer historical context must bind by current Inbox item ID');

for (const fragment of [
  'Historical Review Learning',
  'Recurrence and final disposition are not effectiveness.',
  'Approved is not executed or successful; rejected is not failed.',
  'Historical Learning never changes recommendation rules or execution authority.',
  'No learning weight, rule mutation, recommendation mutation, execution, or Amazon authority is created.',
]) assert.ok(ui.includes(fragment), `Historical Learning safety copy missing: ${fragment}`);

assert.doesNotMatch(ui, /\/historical-learning|\/historical-review-learning/i,
  'Historical Learning UI must not introduce an independent network endpoint');
assert.equal((ui.match(/const response = await fetch\(url, options\)/g) || []).length, 1,
  'Historical Learning must reuse the existing Human Review transport rather than add a second fetch');
assert.doesNotMatch(ui, /effectivenessScore|learningWeight|ruleWeight|\bstoreScore\b|financialImpactScore/i,
  'Historical Learning UI must not implement an effectiveness/adaptive score');
assert.doesNotMatch(ui, /data-cfhr-set="execute"/,
  'Historical Learning must not expose execution actions');
assert.ok(ui.includes('Approved / Rejected are Human Review dispositions only. They do not execute Amazon changes.'),
  'Historical Learning must preserve the Human Review final-disposition execution boundary');
assert.doesNotMatch(ui, /amazon-ads-api|sp-api|AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED|startSync/i,
  'Historical Learning UI must have no Amazon or sync path');

console.log(JSON.stringify({
  ok: true,
  contract: 'historical-review-learning-ui-v1',
  sameHumanReviewPayload: true,
  historicalOnlyContextsSeparated: true,
  recurrenceIsEffectiveness: false,
  finalDispositionIsEffectiveness: false,
  approvedMeansExecuted: false,
  approvedMeansSuccessful: false,
  rejectedMeansFailed: false,
  adaptiveLearningAuthorized: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}));
