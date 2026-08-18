// Canonical Cloudflare Native build entrypoint.
// The migration-era implementation still performs source validation, HTML rewrites,
// and compatibility transforms. The final deployment artifact is then constrained
// by an explicit file allowlist so repository assets cannot enter production by accident.

import { access, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distIndexPath = path.join(repoRoot, 'dist-cloudflare-native', 'index.html');
const operatorAssetPath = path.join(repoRoot, 'dist-cloudflare-native', 'assets', 'cloudflare-native-operator-workspace-v1.js');
const importsAssetPath = path.join(repoRoot, 'dist-cloudflare-native', 'assets', 'cloudflare-native-imports-console-v1.js');
const contextAssetPath = path.join(repoRoot, 'dist-cloudflare-native', 'assets', 'cloudflare-native-operator-context-v1.js');
const decisionAssetPath = path.join(repoRoot, 'dist-cloudflare-native', 'assets', 'cloudflare-native-decision-intelligence-v1.js');
const csvIntelligenceAssetPath = path.join(repoRoot, 'dist-cloudflare-native', 'assets', 'cloudflare-native-csv-intelligence-v1.js');
const csvProductUiAssetPath = path.join(repoRoot, 'dist-cloudflare-native', 'assets', 'cloudflare-native-csv-product-ui-v2.js');
const phase9AssetPath = path.join(repoRoot, 'dist-cloudflare-native', 'assets', 'cloudflare-native-phase9-productization-v1.js');
const phase11AssetPath = path.join(repoRoot, 'dist-cloudflare-native', 'assets', 'cloudflare-native-phase11-execution-readiness-v1.js');
const CSV_INTELLIGENCE_ASSET_VERSION = '1.0.3';
const operatorTag = '<script src="assets/cloudflare-native-operator-workspace-v1.js"></script>';
const importsTag = '<script src="assets/cloudflare-native-imports-console-v1.js"></script>';
const contextTag = '<script src="assets/cloudflare-native-operator-context-v1.js"></script>';
const decisionTag = '<script src="assets/cloudflare-native-decision-intelligence-v1.js"></script>';
const csvIntelligenceTag = `<script src="assets/cloudflare-native-csv-intelligence-v1.js?v=${CSV_INTELLIGENCE_ASSET_VERSION}"></script>`;
const csvIntelligenceTagPattern = /<script src="assets\/cloudflare-native-csv-intelligence-v1\.js(?:\?v=[^"]*)?"><\/script>/g;
const csvProductUiTag = '<script src="assets/cloudflare-native-csv-product-ui-v2.js"></script>';
const phase9Tag = '<script src="assets/cloudflare-native-phase9-productization-v1.js"></script>';
const phase11Tag = '<script src="assets/cloudflare-native-phase11-execution-readiness-v1.js"></script>';

await import('./build-cloudflare-native-copy-all.mjs');
await access(operatorAssetPath, constants.R_OK);
await access(importsAssetPath, constants.R_OK);
await access(contextAssetPath, constants.R_OK);
await access(decisionAssetPath, constants.R_OK);
await access(csvIntelligenceAssetPath, constants.R_OK);
await access(csvProductUiAssetPath, constants.R_OK);
await access(phase9AssetPath, constants.R_OK);
await access(phase11AssetPath, constants.R_OK);

let nativeIndex = await readFile(distIndexPath, 'utf8');
for (const tag of [operatorTag, importsTag, contextTag, decisionTag, csvProductUiTag, phase9Tag, phase11Tag]) {
  nativeIndex = nativeIndex.replaceAll(tag, '');
}
nativeIndex = nativeIndex.replace(csvIntelligenceTagPattern, '');
if (!/<\/head>/i.test(nativeIndex)) throw new Error('Native artifact is missing </head>; cannot inject Operator Workspace');
nativeIndex = nativeIndex.replace(/<\/head>/i, `  ${operatorTag}\n  ${importsTag}\n  ${contextTag}\n  ${decisionTag}\n  ${csvIntelligenceTag}\n  ${csvProductUiTag}\n  ${phase9Tag}\n  ${phase11Tag}\n</head>`);

for (const [tag, label] of [
  [operatorTag, 'Operator Workspace'],
  [importsTag, 'Imports console'],
  [contextTag, 'Operator Context'],
  [decisionTag, 'Decision Intelligence'],
  [csvIntelligenceTag, 'CSV Intelligence extension'],
  [csvProductUiTag, 'CSV product UI integration'],
  [phase9Tag, 'Phase 9 productization extension'],
  [phase11Tag, 'Phase 11 execution readiness extension'],
]) {
  if ((nativeIndex.split(tag).length - 1) !== 1) throw new Error(`${label} must be injected exactly once`);
}
if (nativeIndex.indexOf(operatorTag) > nativeIndex.indexOf(importsTag)) throw new Error('Imports console must load after Operator Workspace');
if (nativeIndex.indexOf(importsTag) > nativeIndex.indexOf(contextTag)) throw new Error('Operator Context must load after Imports console');
if (nativeIndex.indexOf(contextTag) > nativeIndex.indexOf(decisionTag)) throw new Error('Decision Intelligence must load after Operator Context');
if (nativeIndex.indexOf(decisionTag) > nativeIndex.indexOf(csvIntelligenceTag)) throw new Error('CSV Intelligence extension must load after Decision Intelligence');
if (nativeIndex.indexOf(csvIntelligenceTag) > nativeIndex.indexOf(csvProductUiTag)) throw new Error('CSV product UI integration must load after CSV Intelligence');
if (nativeIndex.indexOf(csvProductUiTag) > nativeIndex.indexOf(phase9Tag)) throw new Error('Phase 9 productization extension must load after CSV product UI integration');
if (nativeIndex.indexOf(phase9Tag) > nativeIndex.indexOf(phase11Tag)) throw new Error('Phase 11 execution readiness extension must load after Phase 9 productization');
await writeFile(distIndexPath, nativeIndex, 'utf8');

await import('./enforce-cloudflare-native-asset-allowlist.mjs');
await import('./test-operator-workspace-contract.mjs');
await import('./test-csv-imports-ui-contract.mjs');
await import('./test-operator-context-contract.mjs');
await import('./test-decision-intelligence-contract.mjs');
await import('./test-csv-real-data-intelligence-ui-contract.mjs');
await import('./test-csv-product-ui-navigation-contract.mjs');
await import('./test-phase9-productization-ui-contract.mjs');
await import('./test-phase11-execution-readiness-ui-contract.mjs');
await import('./test-phase11-execution-safety.mjs');
await import('./test-phase11-execution-reconciliation.mjs');