import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetRelative = 'assets/cloudflare-native-phase9-productization-v1.js';
const assetPath = path.join(repoRoot, assetRelative);
const distIndexPath = path.join(repoRoot, 'dist-cloudflare-native', 'index.html');

const syntax = spawnSync(process.execPath, ['--check', assetPath], { encoding: 'utf8' });
assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout || 'Phase 9 UI syntax check failed');

const [source, distIndex] = await Promise.all([
  readFile(assetPath, 'utf8'),
  readFile(distIndexPath, 'utf8'),
]);

for (const token of [
  "const VERSION = '1.2.1'",
  'Governance Queue Health',
  'Awaiting review',
  'Approved',
  'Rejected',
  'Total actions',
  'Approval rate',
  'Rejection rate',
  'Stale rate',
  'Aging >24h',
  'Aging >72h',
  'Oldest pending',
  'High risk',
  'Failed status',
  'Confidence Distribution',
  'High confidence',
  'Medium confidence',
  'Low confidence',
  'Durable Governance Signals · 7d',
  'Duplicate suppressed',
  'Already governed',
  'Quality suppressed',
  'Fingerprint conflicts',
  'Governance errors',
  'Recent Governance',
  'Reviewer',
  'Evidence',
  'Risk',
  'Freshness',
  'Confidence',
  'Source',
  'Find loaded rows',
  'Find action',
  'Decision / Governance',
  'Suppression reason',
  'recent_rejection_cooldown',
  'repeated_suggestion_cooldown',
  'approved_not_executed',
  '/governance-health',
  'durable audit-backed metrics',
  'Amazon execution disabled',
  'cloudflare-operator-store-change',
]) {
  assert.match(source, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

const idempotentFilterResultGuards = source.match(/result\.textContent !== nextText/g) || [];
assert.equal(
  idempotentFilterResultGuards.length,
  2,
  'Phase 9 intelligence and action filter result text must be idempotent so MutationObserver refreshes cannot self-trigger forever',
);
assert.doesNotMatch(source, /if \(result\) result\.textContent = `\$\{visible\}/);

assert.doesNotMatch(source, /Request-time only/);
assert.match(source, /credentials:\s*'same-origin'/);
assert.match(source, /method\s*===?\s*['"]GET['"]|requestJson/);
assert.doesNotMatch(source, /method:\s*['"]POST['"]/);
assert.doesNotMatch(source, /method:\s*['"]PUT['"]/);
assert.doesNotMatch(source, /method:\s*['"]PATCH['"]/);
assert.doesNotMatch(source, /method:\s*['"]DELETE['"]/);
assert.doesNotMatch(source, /advertising-api\.amazon\.com/);
assert.doesNotMatch(source, /\/apply['"`]/);
assert.doesNotMatch(source, /\/revert['"`]/);

const tag = '<script src="assets/cloudflare-native-phase9-productization-v1.js?v=1.2.1"></script>';
assert.equal(distIndex.split(tag).length - 1, 1);
assert.doesNotMatch(distIndex, /<script src="assets\/cloudflare-native-phase9-productization-v1\.js"><\/script>/);
const decisionTag = '<script src="assets/cloudflare-native-decision-intelligence-v1.js"></script>';
assert.ok(distIndex.indexOf(decisionTag) >= 0);
assert.ok(distIndex.indexOf(decisionTag) < distIndex.indexOf(tag));

console.log(JSON.stringify({
  ok: true,
  contract: 'phase9-productization-ui-v4-mutation-stable',
  surface: 'Search Term Intelligence filters, Recommendation Queue search, Governance Health and operator context',
  durableGovernanceSignals: true,
  recommendationQualitySuppressionVisible: true,
  reviewerAndEvidenceContext: true,
  suppressionReasonVisible: true,
  loadedResultFiltering: true,
  mutationObserverFilterRefreshIdempotent: true,
  cacheBustedAsset: true,
  requestMode: 'read-only',
  execution: 'disabled',
}, null, 2));