import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const api = await readFile('cloudflare/runtime/csv-recommendation-human-review-api.js', 'utf8');
const ui = await readFile('assets/cloudflare-native-csv-recommendation-human-review-v1.js', 'utf8');
const builder = await readFile('cloudflare/runtime/recommendation-decision-packet.js', 'utf8');

for (const fragment of [
  "import { buildRecommendationDecisionPacket } from './recommendation-decision-packet.js';",
  'const staleByContext = groupStaleRowsByContext(stored);',
  'const currentReview = row ? publicReview(row) : null;',
  'const staleEvidence = staleRows.map(publicDecisionReviewEvidence);',
  'decisionPacket: buildRecommendationDecisionPacket({',
  'currentReview,',
  'staleReviews: staleEvidence,',
  'analysisScope: snapshot.analysisScope,',
]) assert(api.includes(fragment), `human_review_api_packet_projection_missing:${fragment}`);

assert.equal((api.match(/buildRecommendationReviewBinding\(/g) || []).length, 1, 'decision packet must reuse the existing current binding calculation');
assert(!api.includes('optimization_actions') && !api.includes('optimization_action_events'), 'decision packet GET projection must not create Optimization Action authority');

for (const fragment of [
  "const DECISION_PACKET_VERSION = 'recommendation-decision-packet-v1';",
  'validateDecisionPacket(item?.decisionPacket, item);',
  'Recommendation Decision Packet',
  '1. Recommendation + Why',
  '2. Priority evidence',
  '3. Root + Lifecycle',
  '4. Financial comparability',
  '5. Fingerprint + review evidence',
  '6. Source evidence / provenance',
  'The UI will not reconstruct recommendation evidence client-side.',
  'No auto acknowledge, auto approve, Optimization Action, execution permit, Store Score, or Amazon mutation is authorized.',
]) assert(ui.includes(fragment), `human_review_ui_packet_contract_missing:${fragment}`);

assert(!ui.includes('Store Score</'), 'packet must not introduce Store Score presentation');
assert(!ui.includes('autoExecute') && !ui.includes('amazonMutationAuthorized: true'), 'packet UI must not add execution or Amazon authority');

for (const fragment of [
  "export const RECOMMENDATION_DECISION_PACKET_SCHEMA_VERSION = 'recommendation-decision-packet-v1';",
  'readOnly: true',
  'executionAuthorized: false',
  'amazonMutationAuthorized: false',
  'optimizationActionPersistenceAuthorized: false',
  'currentFingerprint: binding.recommendationFingerprint',
  'staleEvidenceCount: stale.length',
  'inheritedAsCurrent: false',
  'sourceEvidenceJson: nullableText(binding.sourceEvidenceJson)',
]) assert(builder.includes(fragment), `decision_packet_builder_invariant_missing:${fragment}`);

console.log('Recommendation Decision Packet v1 integration: PASS');
