import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(repoRoot, 'cloudflare/runtime/governance-health-api.js'), 'utf8');

const expectedPredicates = [
  "e.event_type IN ('action.approved','approved','action.rejected','rejected')",
  "e.event_type IN ('action.rejected','rejected')",
  "e.event_type IN ('action.proposed','proposed')",
  "e.event_type IN ('action.approved','approved')",
];
for (const predicate of expectedPredicates) assert.ok(source.includes(predicate), `missing event vocabulary compatibility: ${predicate}`);

assert.match(source, /legacyUnprefixedReadCompatibility:\s*true/);
assert.match(source, /canonical:\s*'action\.<transition>'/);
assert.match(source, /acceptedTransitions:\s*\['proposed', 'approved', 'rejected'\]/);
assert.doesNotMatch(source, /e\.event_type='action\.(?:proposed|approved|rejected)'/);
assert.doesNotMatch(source, /advertising-api\.amazon\.com/);
assert.match(source, /amazonMutationAuthorized:\s*false/);

console.log(JSON.stringify({
  ok: true,
  contract: 'phase9-action-event-vocabulary-read-compat-v1',
  canonicalVocabulary: 'action.<transition>',
  legacyUnprefixedReadCompatibility: true,
  transitions: ['proposed', 'approved', 'rejected'],
  mutationAuthority: false,
}, null, 2));
