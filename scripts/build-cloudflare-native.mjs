// Canonical Cloudflare Native build entrypoint.
// The migration-era implementation still performs source validation, HTML rewrites,
// and compatibility transforms. The final deployment artifact is then constrained
// by an explicit file allowlist so repository assets cannot enter production by accident.

import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
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
const csvJointAnalysisAssetPath = path.join(repoRoot, 'dist-cloudflare-native', 'assets', 'cloudflare-native-csv-joint-analysis-v1.js');
const csvHierarchyQualityAssetPath = path.join(repoRoot, 'dist-cloudflare-native', 'assets', 'cloudflare-native-csv-hierarchy-quality-v1.js');
const csvLibraryReviewAssetPath = path.join(repoRoot, 'dist-cloudflare-native', 'assets', 'cloudflare-native-csv-library-review-v1.js');
const csvProductUiAssetPath = path.join(repoRoot, 'dist-cloudflare-native', 'assets', 'cloudflare-native-csv-product-ui-v2.js');
const phase9AssetPath = path.join(repoRoot, 'dist-cloudflare-native', 'assets', 'cloudflare-native-phase9-productization-v1.js');
const phase11AssetPath = path.join(repoRoot, 'dist-cloudflare-native', 'assets', 'cloudflare-native-phase11-execution-readiness-v1.js');
const csvAnalysisEngineOutputDir = path.join(repoRoot, 'dist-cloudflare-native', 'assets', 'csv-analysis-engine');
const CSV_ANALYSIS_ENGINE_FILES = Object.freeze([
  'amazon-numeric.js',
  'canonical-json.js',
  'decision-intelligence.js',
  'csv-search-term-import.js',
  'csv-term-profitability-analysis.js',
  'csv-observed-targeting-identity.js',
  'csv-window-quality-analysis.js',
  'csv-hierarchy-profitability-analysis.js',
  'csv-period-over-period-analysis.js',
  'csv-joint-report-analysis.js',
  'csv-library-review-bridge.js',
]);
const CSV_INTELLIGENCE_ASSET_VERSION = '1.0.4';
const CSV_JOINT_ANALYSIS_ASSET_VERSION = '1.0.0';
const CSV_HIERARCHY_QUALITY_ASSET_VERSION = '1.0.0';
const CSV_LIBRARY_REVIEW_ASSET_VERSION = '1.0.0';
const PHASE9_ASSET_VERSION = '1.2.1';
const operatorTag = '<script src="assets/cloudflare-native-operator-workspace-v1.js"></script>';
const importsTag = '<script src="assets/cloudflare-native-imports-console-v1.js"></script>';
const contextTag = '<script src="assets/cloudflare-native-operator-context-v1.js"></script>';
const decisionTag = '<script src="assets/cloudflare-native-decision-intelligence-v1.js"></script>';
const csvIntelligenceTag = `<script src="assets/cloudflare-native-csv-intelligence-v1.js?v=${CSV_INTELLIGENCE_ASSET_VERSION}"></script>`;
const csvIntelligenceTagPattern = /<script src="assets\/cloudflare-native-csv-intelligence-v1\.js(?:\?v=[^"]*)?"><\/script>/g;
const csvJointAnalysisTag = `<script type="module" src="assets/cloudflare-native-csv-joint-analysis-v1.js?v=${CSV_JOINT_ANALYSIS_ASSET_VERSION}"></script>`;
const csvJointAnalysisTagPattern = /<script type="module" src="assets\/cloudflare-native-csv-joint-analysis-v1\.js(?:\?v=[^"]*)?"><\/script>/g;
const csvHierarchyQualityTag = `<script type="module" src="assets/cloudflare-native-csv-hierarchy-quality-v1.js?v=${CSV_HIERARCHY_QUALITY_ASSET_VERSION}"></script>`;
const csvHierarchyQualityTagPattern = /<script type="module" src="assets\/cloudflare-native-csv-hierarchy-quality-v1\.js(?:\?v=[^"]*)?"><\/script>/g;
const csvLibraryReviewTag = `<script type="module" src="assets/cloudflare-native-csv-library-review-v1.js?v=${CSV_LIBRARY_REVIEW_ASSET_VERSION}"></script>`;
const csvLibraryReviewTagPattern = /<script type="module" src="assets\/cloudflare-native-csv-library-review-v1\.js(?:\?v=[^"]*)?"><\/script>/g;
const csvProductUiTag = '<script src="assets/cloudflare-native-csv-product-ui-v2.js"></script>';
const phase9Tag = `<script src="assets/cloudflare-native-phase9-productization-v1.js?v=${PHASE9_ASSET_VERSION}"></script>`;
const phase9TagPattern = /<script src="assets\/cloudflare-native-phase9-productization-v1\.js(?:\?v=[^"]*)?"><\/script>/g;
const phase11Tag = '<script src="assets/cloudflare-native-phase11-execution-readiness-v1.js"></script>';

await import('./build-cloudflare-native-copy-all.mjs');
await mkdir(csvAnalysisEngineOutputDir, { recursive: true });
for (const file of CSV_ANALYSIS_ENGINE_FILES) {
  await copyFile(path.join(repoRoot, 'cloudflare', 'runtime', file), path.join(csvAnalysisEngineOutputDir, file));
}
await access(operatorAssetPath, constants.R_OK);
await access(importsAssetPath, constants.R_OK);
await access(contextAssetPath, constants.R_OK);
await access(decisionAssetPath, constants.R_OK);
await access(csvIntelligenceAssetPath, constants.R_OK);
await access(csvJointAnalysisAssetPath, constants.R_OK);
await access(csvHierarchyQualityAssetPath, constants.R_OK);
await access(csvLibraryReviewAssetPath, constants.R_OK);
await access(csvProductUiAssetPath, constants.R_OK);
await access(phase9AssetPath, constants.R_OK);
await access(phase11AssetPath, constants.R_OK);
for (const file of CSV_ANALYSIS_ENGINE_FILES) await access(path.join(csvAnalysisEngineOutputDir, file), constants.R_OK);

let nativeIndex = await readFile(distIndexPath, 'utf8');
for (const tag of [operatorTag, importsTag, contextTag, decisionTag, csvProductUiTag, phase11Tag]) nativeIndex = nativeIndex.replaceAll(tag, '');
nativeIndex = nativeIndex.replace(csvIntelligenceTagPattern, '');
nativeIndex = nativeIndex.replace(csvJointAnalysisTagPattern, '');
nativeIndex = nativeIndex.replace(csvHierarchyQualityTagPattern, '');
nativeIndex = nativeIndex.replace(csvLibraryReviewTagPattern, '');
nativeIndex = nativeIndex.replace(phase9TagPattern, '');
if (!/<\/head>/i.test(nativeIndex)) throw new Error('Native artifact is missing </head>; cannot inject Operator Workspace');
nativeIndex = nativeIndex.replace(/<\/head>/i, `  ${operatorTag}\n  ${importsTag}\n  ${contextTag}\n  ${decisionTag}\n  ${csvIntelligenceTag}\n  ${csvJointAnalysisTag}\n  ${csvHierarchyQualityTag}\n  ${csvLibraryReviewTag}\n  ${csvProductUiTag}\n  ${phase9Tag}\n  ${phase11Tag}\n</head>`);

for (const [tag, label] of [
  [operatorTag, 'Operator Workspace'], [importsTag, 'Imports console'], [contextTag, 'Operator Context'],
  [decisionTag, 'Decision Intelligence'], [csvIntelligenceTag, 'CSV Intelligence extension'],
  [csvJointAnalysisTag, 'Joint CSV Analysis extension'], [csvHierarchyQualityTag, 'CSV hierarchy quality extension'],
  [csvLibraryReviewTag, 'CSV Library Review extension'], [csvProductUiTag, 'CSV product UI integration'],
  [phase9Tag, 'Phase 9 productization extension'], [phase11Tag, 'Phase 11 execution readiness extension'],
]) {
  if ((nativeIndex.split(tag).length - 1) !== 1) throw new Error(`${label} must be injected exactly once`);
}
if (nativeIndex.indexOf(operatorTag) > nativeIndex.indexOf(importsTag)) throw new Error('Imports console must load after Operator Workspace');
if (nativeIndex.indexOf(importsTag) > nativeIndex.indexOf(contextTag)) throw new Error('Operator Context must load after Imports console');
if (nativeIndex.indexOf(contextTag) > nativeIndex.indexOf(decisionTag)) throw new Error('Decision Intelligence must load after Operator Context');
if (nativeIndex.indexOf(decisionTag) > nativeIndex.indexOf(csvIntelligenceTag)) throw new Error('CSV Intelligence extension must load after Decision Intelligence');
if (nativeIndex.indexOf(csvIntelligenceTag) > nativeIndex.indexOf(csvJointAnalysisTag)) throw new Error('Joint CSV Analysis must load after CSV Intelligence');
if (nativeIndex.indexOf(csvJointAnalysisTag) > nativeIndex.indexOf(csvHierarchyQualityTag)) throw new Error('CSV hierarchy quality UI must load after Joint CSV Analysis');
if (nativeIndex.indexOf(csvHierarchyQualityTag) > nativeIndex.indexOf(csvLibraryReviewTag)) throw new Error('CSV Library Review must load after CSV hierarchy quality UI');
if (nativeIndex.indexOf(csvLibraryReviewTag) > nativeIndex.indexOf(csvProductUiTag)) throw new Error('CSV product UI integration must load after CSV Library Review');
if (nativeIndex.indexOf(csvProductUiTag) > nativeIndex.indexOf(phase9Tag)) throw new Error('Phase 9 productization extension must load after CSV product UI integration');
if (nativeIndex.indexOf(phase9Tag) > nativeIndex.indexOf(phase11Tag)) throw new Error('Phase 11 execution readiness extension must load after Phase 9 productization');
await writeFile(distIndexPath, nativeIndex, 'utf8');

await import('./enforce-cloudflare-native-asset-allowlist.mjs');
await import('./test-operator-workspace-contract.mjs');
await import('./test-csv-imports-ui-contract.mjs');
await import('./test-operator-context-contract.mjs');
await import('./test-decision-intelligence-contract.mjs');
await import('./test-csv-real-data-intelligence-ui-contract.mjs');
await import('./test-csv-joint-analysis-ui-contract.mjs');
await import('./test-csv-window-quality-diagnostics.mjs');
await import('./test-csv-hierarchy-profitability.mjs');
await import('./test-csv-period-over-period.mjs');
await import('./test-csv-hierarchy-quality-ui-contract.mjs');
await import('./test-csv-library-review-bridge-contract.mjs');
await import('./test-csv-product-ui-navigation-contract.mjs');
await import('./test-phase9-productization-ui-contract.mjs');
await import('./test-phase11-execution-readiness-ui-contract.mjs');
await import('./test-phase11-execution-safety.mjs');
await import('./test-phase11-execution-reconciliation.mjs');
