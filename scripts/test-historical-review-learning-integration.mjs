import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const api = await readFile(new URL('../cloudflare/runtime/csv-recommendation-human-review-api.js', import.meta.url), 'utf8');
const learning = await readFile(new URL('../cloudflare/runtime/historical-review-learning.js', import.meta.url), 'utf8');

assert.match(api, /buildHistoricalReviewLearning/, 'Human Review GET must expose Historical Learning projection');
assert.equal((api.match(/buildHistoricalReviewLearning\(/g) || []).length, 1,
  'Historical Learning must be built exactly once per Human Review GET');
assert.equal((api.match(/await readStoredRecommendationReviews\(db\)/g) || []).length, 2,
  'Historical Learning must not add a historical review query beyond existing GET + persistence paths');
assert.match(api, /historicalEntries: stored\.map\(\(row\) => \(\{[\s\S]*contextKey: reviewContextKeyFromEvidenceJson\(row\.source_evidence_json\)/,
  'Historical review grouping must reuse the existing authoritative reviewContextKeyFromEvidenceJson helper');
assert.match(api, /currentEntries: enriched\.map\(\(entry\) => \(\{[\s\S]*contextKey: entry\.contextKey,[\s\S]*item: entry\.responseItem/,
  'Current Historical Learning context must reuse the context key already computed for Human Review enrichment');
assert.match(api, /candidateLibrary,[\s\S]*historicalLearning,[\s\S]*items,/, 'Human Review GET must return Library + Historical Learning + current items together');

assert.doesNotMatch(learning, /fetch\(|prepare\(|\.run\(|INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM/i,
  'Historical Learning builder must remain a pure in-memory projection');
assert.doesNotMatch(learning, /optimization_actions|optimization_action_events|startSync|AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED/i,
  'Historical Learning must not connect to execution or Amazon/sync controls');
assert.doesNotMatch(learning, /effectivenessScore|learningWeight|storeScore|financialImpactScore|ruleWeight/i,
  'Historical Learning must not invent adaptive or effectiveness scoring');
assert.match(learning, /adaptiveLearningAuthorized:\s*false/, 'Adaptive learning must remain unauthorized');
assert.match(learning, /ruleMutationAuthorized:\s*false/, 'Rule mutation must remain unauthorized');
assert.match(learning, /recommendationMutationAuthorized:\s*false/, 'Recommendation mutation must remain unauthorized');
assert.match(learning, /executionAuthorized:\s*false/, 'Execution must remain unauthorized');
assert.match(learning, /amazonMutationAuthorized:\s*false/, 'Amazon mutation must remain unauthorized');
assert.match(learning, /currentEvidenceDrift: currentItem \? stale\.length > 0 : null/,
  'Historical-only contexts must not fabricate a current evidence-drift state');

console.log(JSON.stringify({
  ok: true,
  contract: 'historical-review-learning-integration-v1',
  extraHistoricalQueryAdded: false,
  authoritativeContextKeyReused: true,
  adaptiveLearningAuthorized: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}));
