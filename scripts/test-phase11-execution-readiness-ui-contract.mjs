import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetRelative = 'assets/cloudflare-native-phase11-execution-readiness-v1.js';
const assetPath = path.join(repoRoot, assetRelative);
const distIndexPath = path.join(repoRoot, 'dist-cloudflare-native', 'index.html');

const syntax = spawnSync(process.execPath, ['--check', assetPath], { encoding: 'utf8' });
assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout || 'Phase 11 execution readiness UI syntax check failed');

const [source, distIndex] = await Promise.all([
  readFile(assetPath, 'utf8'),
  readFile(distIndexPath, 'utf8'),
]);

for (const token of [
  'Execution Readiness',
  'Dry-run only',
  'No Amazon request will be sent',
  'Run execution readiness dry-run',
  '/apply?dryRun=true',
  'Action type',
  'Frozen campaignId',
  'Frozen adGroupId',
  'Mutation contract',
  'HTTP method',
  'Endpoint path',
  'Request fingerprint',
  'Target fingerprint',
  'Execution fingerprint',
  'Request body SHA-256',
  'permitIssuanceReady',
  'networkDispatchAuthorized',
  'Blocking reason',
  'Retry policy',
  'Read-back policy',
  'Governance approval is not execution authority',
]) {
  assert.match(source, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

assert.match(source, /credentials:\s*'same-origin'/);
assert.match(source, /method:\s*'POST'/);
assert.doesNotMatch(source, /advertising-api(?:-\w+)?\.amazon\.com/);
assert.doesNotMatch(source, />\s*Execute\s*</i);
assert.doesNotMatch(source, />\s*Apply now\s*</i);
assert.doesNotMatch(source, />\s*Send to Amazon\s*</i);
assert.doesNotMatch(source, /execution-permits/);

const phase11Tag = '<script src="assets/cloudflare-native-phase11-execution-readiness-v1.js"></script>';
const phase9Tag = '<script src="assets/cloudflare-native-phase9-productization-v1.js"></script>';
assert.equal(distIndex.split(phase11Tag).length - 1, 1);
assert.ok(distIndex.indexOf(phase9Tag) >= 0);
assert.ok(distIndex.indexOf(phase9Tag) < distIndex.indexOf(phase11Tag));

console.log(JSON.stringify({
  ok: true,
  contract: 'phase11-execution-readiness-ui-v1',
  approvedActionDetail: true,
  dryRunOnly: true,
  amazonRequestSent: false,
  permitIssuanceExposedInUi: false,
  realExecutionControls: false,
}, null, 2));
