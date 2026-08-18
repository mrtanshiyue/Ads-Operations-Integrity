import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist-cloudflare-native');
const source = await readFile(path.join(root, 'assets', 'cloudflare-native-csv-product-ui-v2.js'), 'utf8');
const builtAsset = await readFile(path.join(dist, 'assets', 'cloudflare-native-csv-product-ui-v2.js'), 'utf8');
const index = await readFile(path.join(dist, 'index.html'), 'utf8');
const allowlist = await readFile(path.join(root, 'scripts/enforce-cloudflare-native-asset-allowlist.mjs'), 'utf8');
const tag = '<script src="assets/cloudflare-native-csv-product-ui-v2.js"></script>';
const csvIntelligenceTag = '<script src="assets/cloudflare-native-csv-intelligence-v1.js?v=1.0.3"></script>';
const phase9Tag = '<script src="assets/cloudflare-native-phase9-productization-v1.js?v=1.2.1"></script>';

new vm.Script(source, { filename: 'cloudflare-native-csv-product-ui-v2.js' });
assert.equal(source, builtAsset, 'CSV product UI asset must be copied without source drift');
assert.equal(index.split(tag).length - 1, 1, 'CSV product UI must be injected exactly once');
assert.ok(index.indexOf(csvIntelligenceTag) >= 0, 'Versioned CSV Intelligence asset must exist in built HTML');
assert.ok(index.indexOf(phase9Tag) >= 0, 'Versioned Phase 9 productization asset must exist in built HTML');
assert.ok(index.indexOf(csvIntelligenceTag) < index.indexOf(tag), 'CSV product UI must load after CSV Intelligence');
assert.ok(index.indexOf(tag) < index.indexOf(phase9Tag), 'CSV product UI must load before Phase 9 productization');
assert.match(allowlist, /'cloudflare-native-csv-product-ui-v2\.js'/, 'CSV product UI must be explicitly allowlisted');

for (const required of [
  'data-csv-product-group',
  "dataset.group = 'data'",
  "key: 'imports'",
  "key: 'intelligence'",
  "key: 'advisory'",
  "zh: '数据导入'",
  "en: 'Imports'",
  "zh: '搜索词智能'",
  "en: 'Search Term Intelligence'",
  "zh: '建议审核'",
  "en: 'Advisory Review'",
]) assert.ok(source.includes(required), `Missing CSV product navigation contract: ${required}`);

assert.match(source, /MutationObserver\(scheduleNavigationRepair\)/, 'Operator re-render recovery observer missing');
assert.match(source, /if \(group\.innerHTML !== markup\) group\.innerHTML = markup/, 'Navigation repair must not create a mutation loop');
assert.match(source, /\[data-csv-import-nav\]\{display:none!important\}/, 'Legacy Imports fallback must be hidden without DOM deletion');
assert.doesNotMatch(source, /querySelectorAll\('\[data-csv-import-nav\]'\).*remove/, 'CSV product UI must not fight the Imports observer by deleting its fallback node');
assert.match(source, /CloudflareImportsConsole\?\.open/, 'Imports must open through the existing Native console');
assert.match(source, /CloudflareDecisionIntelligence\?\.open/, 'CSV Intelligence must open through Decision Intelligence');
assert.match(source, /\[name="dataSource"\]/, 'CSV Intelligence must select the existing data-source control');
assert.match(source, /select\.value = 'csv'/, 'CSV Intelligence must force imported CSV mode');
assert.match(source, /\/advisory-reviews\?/, 'Advisory Review list endpoint missing');
assert.match(source, /\/advisory-reviews\/\$\{encodeURIComponent\(review\.reviewId\)\}/, 'Advisory Review transition endpoint missing');

for (const reviewState of ['open', 'acknowledged', 'dismissed', 'snoozed']) {
  assert.ok(source.includes(`'${reviewState}'`), `Advisory Review state missing: ${reviewState}`);
}
for (const evidenceField of [
  'sourceImportId', 'sourceImportIds', 'contentSha256s', 'reportDate',
  'advertiserAccountId', 'campaignId', 'adGroupId', 'targetingId',
  'targetingIdentityState', 'amazonProfileId', 'sourceEvidenceSha256',
  'reviewerUserId', 'note', 'reviewedAt', 'snoozedUntil',
]) assert.ok(source.includes(evidenceField), `Advisory evidence/review field missing: ${evidenceField}`);

for (const boundary of [
  'authoritative',
  'optimizationActionPersistenceAuthorized',
  'executionAuthorized',
  'amazonMutationAuthorized',
]) assert.ok(source.includes(boundary), `Authority boundary missing: ${boundary}`);

assert.doesNotMatch(source, /data-review-state=["'](?:approved|executable|applied)["']/i, 'CSV Advisory Review must never expose executable governance states');
assert.doesNotMatch(source, /Apply to Amazon|Execute on Amazon|Amazon mutation button/i, 'CSV Advisory Review must never expose Amazon mutation controls');
assert.doesNotMatch(source, /optimization-actions(?:\/|\?)/, 'CSV product UI must not persist advisory records into optimization_actions');
assert.match(source, /credentials: 'same-origin'/, 'CSV product UI must stay inside the authenticated same-origin Access session');
assert.match(source, /cloudflare-operator-store-change/, 'CSV product UI must follow Operator Workspace store context');

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-product-ui-navigation-v3-versioned-load-order',
  dataGroup: true,
  importsFirstClass: true,
  csvIntelligenceFirstClass: true,
  advisoryReviewFirstClass: true,
  navigationRepairLoopGuard: true,
  importsObserverContention: false,
  versionedLoadOrder: true,
  advisoryStates: ['open', 'acknowledged', 'dismissed', 'snoozed'],
  optimizationActionsIsolation: true,
  amazonMutationControls: false,
}, null, 2));