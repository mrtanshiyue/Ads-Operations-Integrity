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
  'Governance Queue Health',
  'Awaiting review',
  'Approval rate',
  'Rejection rate',
  'Stale rate',
  'Aging >24h',
  'Aging >72h',
  'High risk',
  'Failed status',
  '/governance-health',
  'Request-time only',
  'Amazon execution disabled',
  'cloudflare-operator-store-change',
]) {
  assert.match(source, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

assert.match(source, /credentials:\s*'same-origin'/);
assert.match(source, /method\s*===?\s*['"]GET['"]|requestJson/);
assert.doesNotMatch(source, /method:\s*['"]POST['"]/);
assert.doesNotMatch(source, /method:\s*['"]PUT['"]/);
assert.doesNotMatch(source, /method:\s*['"]PATCH['"]/);
assert.doesNotMatch(source, /method:\s*['"]DELETE['"]/);
assert.doesNotMatch(source, /advertising-api\.amazon\.com/);
assert.doesNotMatch(source, /\/apply['"`]/);
assert.doesNotMatch(source, /\/revert['"`]/);

const tag = '<script src="assets/cloudflare-native-phase9-productization-v1.js"></script>';
assert.equal(distIndex.split(tag).length - 1, 1);
const decisionTag = '<script src="assets/cloudflare-native-decision-intelligence-v1.js"></script>';
assert.ok(distIndex.indexOf(decisionTag) >= 0);
assert.ok(distIndex.indexOf(decisionTag) < distIndex.indexOf(tag));

console.log(JSON.stringify({
  ok: true,
  contract: 'phase9-productization-ui-v1',
  surface: 'Action Inbox governance health',
  requestMode: 'read-only',
  execution: 'disabled',
}, null, 2));
