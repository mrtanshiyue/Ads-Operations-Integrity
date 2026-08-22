import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const api = await readFile(new URL('../cloudflare/runtime/csv-recommendation-human-review-api.js', import.meta.url), 'utf8');
const library = await readFile(new URL('../cloudflare/runtime/governed-keyword-negative-candidate-library.js', import.meta.url), 'utf8');

assert.match(api, /buildGovernedKeywordNegativeCandidateLibrary/, 'Human Review GET must build the governed candidate library');
assert.match(api, /const candidateLibrary = buildGovernedKeywordNegativeCandidateLibrary\(\{[\s\S]*storeId,[\s\S]*analysisScope: snapshot\.analysisScope,[\s\S]*items,[\s\S]*\}\)/,
  'Candidate Library must project from the already-built Human Review response items');
assert.match(api, /candidateLibrary,[\s\S]*items,/, 'Human Review GET response must expose candidateLibrary beside authoritative items');
assert.equal((api.match(/buildGovernedKeywordNegativeCandidateLibrary\(/g) || []).length, 1,
  'Human Review route must build the Candidate Library exactly once');
assert.equal((api.match(/buildRecommendationReviewBinding\(/g) || []).length, 2,
  'Library integration must not add a second recommendation binding pass beyond existing GET + persistence paths');
assert.equal((api.match(/readStoredRecommendationReviews\(db\)/g) || []).length, 2,
  'Library integration must not add another stored-review query beyond existing GET + persistence paths');

assert.doesNotMatch(library, /fetch\(|prepare\(|\.run\(|INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM/i,
  'Candidate Library builder must remain a pure projection without network or database writes');
assert.doesNotMatch(library, /optimization_actions|optimization_action_events|startSync|AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED/i,
  'Candidate Library builder must not connect to execution or Amazon/sync controls');
assert.match(library, /readOnly:\s*true/, 'Candidate Library authority must remain read-only');
assert.match(library, /executionAuthorized:\s*false/, 'Candidate Library must never authorize execution');
assert.match(library, /amazonMutationAuthorized:\s*false/, 'Candidate Library must never authorize Amazon mutation');
assert.match(library, /candidate_emission_not_authorized/, 'Candidate-emission blocked scope must fail closed');
assert.match(library, /CANDIDATE_LIBRARY_STALE_INHERITANCE_INVALID/, 'Stale evidence inheritance must fail closed');

console.log(JSON.stringify({
  ok: true,
  contract: 'governed-keyword-negative-candidate-library-integration-v1',
  serverProjectionOnly: true,
  extraReviewQueryAdded: false,
  extraBindingPassAdded: false,
  executionAuthorized: false,
  amazonMutationAuthorized: false,
}));
