import { access, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsRoot = path.join(repoRoot, 'dist-cloudflare-native', 'assets');

const legacyAutoDecisionExportPath = path.join(assetsRoot, 'generated', 'inline-script-04.js');
const legacyAutoDecisionUnsafeAnchor = 'const combined=[...(actionBulk.bulkRows||[]),...keywordRows],validation=validateSponsoredProductsBulkDraft(keywordHeaders,combined,"Auto Decision Center"),manualRows=';
const legacyAutoDecisionGuardMarker = 'const validationErrors=validation.filter(x=>String(x[0]||"").toUpperCase()==="ERROR");';
const legacyAutoDecisionHardenedAnchor = [
  'const combined=[...(actionBulk.bulkRows||[]),...keywordRows],validation=validateSponsoredProductsBulkDraft(keywordHeaders,combined,"Auto Decision Center");',
  legacyAutoDecisionGuardMarker,
  'if(validationErrors.length){notify(currentLang==="zh"?`Bulk Validator 发现 ${validationErrors.length} 个 ERROR；已阻止生成执行计划。请先修复后重试。`:`Bulk Validator found ${validationErrors.length} ERROR rows; execution-plan export is blocked until they are fixed.`,"warn");return;}',
  'const manualRows=',
].join('');

let legacyAutoDecisionExportSource = await readFile(legacyAutoDecisionExportPath, 'utf8');
const existingGuardCount = legacyAutoDecisionExportSource.split(legacyAutoDecisionGuardMarker).length - 1;
if (existingGuardCount === 0) {
  const unsafeAnchorCount = legacyAutoDecisionExportSource.split(legacyAutoDecisionUnsafeAnchor).length - 1;
  if (unsafeAnchorCount !== 1) {
    throw new Error(`Legacy Auto Decision export hardening expected exactly one unsafe validator/export anchor, found ${unsafeAnchorCount}`);
  }
  legacyAutoDecisionExportSource = legacyAutoDecisionExportSource.replace(legacyAutoDecisionUnsafeAnchor, legacyAutoDecisionHardenedAnchor);
  await writeFile(legacyAutoDecisionExportPath, legacyAutoDecisionExportSource, 'utf8');
} else if (existingGuardCount !== 1) {
  throw new Error(`Legacy Auto Decision export hardening guard must exist exactly once, found ${existingGuardCount}`);
}
const hardenedFunctionIndex = legacyAutoDecisionExportSource.indexOf('const exportCentralDecisionPackage = async () => {');
const hardenedGuardIndex = legacyAutoDecisionExportSource.indexOf(legacyAutoDecisionGuardMarker, hardenedFunctionIndex);
const hardenedExportIndex = legacyAutoDecisionExportSource.indexOf('await exportRichExcelMultiSheet', hardenedFunctionIndex);
if (hardenedFunctionIndex < 0 || hardenedGuardIndex < 0 || hardenedExportIndex < 0 || hardenedGuardIndex >= hardenedExportIndex) {
  throw new Error('Legacy Auto Decision export must fail closed on Bulk Validator ERROR before Excel generation');
}

const allowedAssets = new Set([
  'bid-governance-parity-audit-v1.js',
  'cloudflare-native-access-console-v1.js',
  'cloudflare-native-api-v1.js',
  'cloudflare-native-audit-console-v1.js',
  'cloudflare-native-csv-analytics-dashboard-v1.js',
  'cloudflare-native-csv-analytics-drilldown-v1.js',
  'cloudflare-native-csv-local-diagnostics-v1.js',
  'cloudflare-native-csv-intelligence-v1.js',
  'cloudflare-native-csv-recommendation-inbox-v1.js',
  'cloudflare-native-csv-recommendation-inbox-usability-v1.js',
  'cloudflare-native-csv-recommendation-operator-triage-v1.js',
  'cloudflare-native-csv-recommendation-human-review-v1.js',
  'cloudflare-native-csv-root-lifecycle-usability-v1.js',
  'cloudflare-native-csv-joint-analysis-v1.js',
  'cloudflare-native-csv-data-quality-command-center-v1.js',
  'cloudflare-native-csv-hierarchy-quality-v1.js',
  'cloudflare-native-csv-hierarchy-drilldown-v1.js',
  'cloudflare-native-csv-period-ui-v1.js',
  'cloudflare-native-csv-monthly-workspace-v1.js',
  'cloudflare-native-csv-history-ledger-v1.js',
  'cloudflare-native-csv-history-ledger-impl-v1.js',
  'cloudflare-native-csv-history-quarterly-operating-review-v1.js',
  'cloudflare-native-csv-history-quarterly-operating-review-impl-v1.js',
  'cloudflare-native-csv-history-quarter-over-quarter-comparison-v1.js',
  'cloudflare-native-csv-history-quarter-over-quarter-comparison-receipt-v1.js',
  'cloudflare-native-csv-history-quarter-over-quarter-comparison-receipt-verification-v1.js',
  'cloudflare-native-csv-history-year-to-date-operating-review-v1.js',
  'cloudflare-native-csv-history-year-over-year-ytd-comparison-v1.js',
  'cloudflare-native-csv-history-year-over-year-ytd-review-board-v1.js',
  'cloudflare-native-csv-history-rolling-12-operating-review-v1.js',
  'cloudflare-native-csv-history-rolling-12-window-transition-review-v1.js',
  'cloudflare-native-csv-history-rolling-12-window-transition-receipt-v1.js',
  'cloudflare-native-csv-history-rolling-12-window-transition-receipt-verification-v1.js',
  'cloudflare-native-csv-history-rolling-12-window-transition-review-board-v1.js',
  'cloudflare-native-csv-history-rolling-12-transition-chronology-v1.js',
  'cloudflare-native-csv-history-rolling-12-transition-chronology-receipt-v1.js',
  'cloudflare-native-csv-history-rolling-12-transition-chronology-receipt-verification-v1.js',
  'cloudflare-native-csv-history-audit-chain-index-v1.js',
  'cloudflare-native-csv-history-comparison-receipt-v1.js',
  'cloudflare-native-csv-history-comparison-receipt-impl-v1.js',
  'cloudflare-native-csv-history-comparison-receipt-verification-v1.js',
  'cloudflare-native-csv-history-audit-package-index-verification-v1.js',
  'cloudflare-native-csv-provenance-audit-v1.js',
  'cloudflare-native-csv-analysis-export-v1.js',
  'cloudflare-native-csv-library-review-v1.js',
  'cloudflare-native-csv-product-ui-v2.js',
  'cloudflare-native-data-panel-v1.js',
  'cloudflare-native-decision-intelligence-v1.js',
  'cloudflare-native-imports-console-v1.js',
  'cloudflare-native-phase9-productization-v1.js',
  'cloudflare-native-phase11-execution-readiness-v1.js',
  'cloudflare-native-keyword-governance-v1.js',
  'cloudflare-native-operator-context-v1.js',
  'cloudflare-native-operator-workspace-v1.js',
  'cloudflare-native-product-governance-v1.js',
  'cloudflare-native-operations-health-v1.js',
  'cloudflare-native-negative-governance-v1.js',
  'cloudflare-native-query-bridge-v1.js',
  'csv-analysis-engine/amazon-numeric.js',
  'csv-analysis-engine/canonical-json.js',
  'csv-analysis-engine/csv-history-deterministic-receipt.js',
  'csv-analysis-engine/decision-intelligence.js',
  'csv-analysis-engine/csv-search-term-import.js',
  'csv-analysis-engine/csv-term-profitability-analysis.js',
  'csv-analysis-engine/csv-observed-targeting-identity.js',
  'csv-analysis-engine/csv-window-quality-analysis.js',
  'csv-analysis-engine/csv-hierarchy-profitability-analysis.js',
  'csv-analysis-engine/csv-period-over-period-analysis.js',
  'csv-analysis-engine/csv-joint-report-analysis.js',
  'csv-analysis-engine/csv-history-ledger.js',
  'csv-analysis-engine/csv-library-review-bridge.js',
  'query-native-ads-source-readiness-v1.js',
  'query-native-ads-trend-host-v1.js',
  'query-native-ads-trend-v1.js',
  'query-native-bid-intelligence-v1.js',
  'query-native-governance-gate-v1.js',
  'query-native-module-data-v1.js',
  'generated/inline-script-01.js',
  'generated/inline-script-02.js',
  'generated/inline-script-03.js',
  'generated/inline-script-04.js',
  'generated/inline-script-05.js',
  'generated/inline-script-06.js',
  'generated/inline-script-07.js',
  'generated/inline-script-08.js',
  'generated/inline-script-10.js',
  'vendor/FileSaver.min.js',
  'vendor/chart.umd.min.js',
  'vendor/exceljs.min.js',
  'vendor/html2pdf.bundle.min.js',
  'vendor/idb-keyval.umd.js',
  'vendor/papaparse.min.js',
  'vendor/xlsx.full.min.js',
]);

const forbiddenAssets = new Set([
  'private-cloud-query-v1.js',
  'private-cloud-warehouse-v3.js',
  'private-cloud-warehouse-v4.js',
  'generated/inline-script-09.js',
  'generated/inline-script-11.js',
]);

const nativeApiSource = await readFile(path.join(repoRoot, 'assets', 'cloudflare-native-api-v1.js'), 'utf8');
const dynamicLoaderAssets = [...nativeApiSource.matchAll(/loadReadOnlyAnalyticsAsset\(['"]assets\/([^'"]+)['"]/g)]
  .map((match) => match[1]);
if (!dynamicLoaderAssets.length) throw new Error('Cloudflare Native API dynamic asset loader contract was not found');
const dynamicAssetsMissingFromAllowlist = dynamicLoaderAssets.filter((relativePath) => !allowedAssets.has(relativePath));
if (dynamicAssetsMissingFromAllowlist.length) {
  throw new Error(`Cloudflare Native dynamic loader assets missing from deployment allowlist: ${dynamicAssetsMissingFromAllowlist.join(', ')}`);
}

const discovered = await collectFiles(assetsRoot);
const removed = [];
for (const relativePath of discovered) {
  if (allowedAssets.has(relativePath)) continue;
  await rm(path.join(assetsRoot, relativePath), { force: true });
  removed.push(relativePath);
}

for (const relativePath of allowedAssets) await access(path.join(assetsRoot, relativePath), constants.R_OK);
for (const relativePath of forbiddenAssets) {
  try {
    await access(path.join(assetsRoot, relativePath), constants.F_OK);
    throw new Error(`Forbidden legacy asset remains in native artifact: ${relativePath}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

const finalFiles = await collectFiles(assetsRoot);
const unexpected = finalFiles.filter((relativePath) => !allowedAssets.has(relativePath));
if (unexpected.length) throw new Error(`Unexpected Cloudflare Native deployment assets: ${unexpected.join(', ')}`);
if (finalFiles.length !== allowedAssets.size) throw new Error(`Cloudflare Native asset count mismatch: expected ${allowedAssets.size}, found ${finalFiles.length}`);

console.log(JSON.stringify({
  ok: true,
  policy: 'explicit-file-allowlist-v2',
  allowedAssetCount: allowedAssets.size,
  dynamicLoaderAssets,
  removedAssetCount: removed.length,
  removedAssets: removed,
  forbiddenAssets: [...forbiddenAssets],
  legacyAutoDecisionExportFailClosed: true,
}, null, 2));

async function collectFiles(root) {
  const output = [];
  await walk(root, '');
  return output.sort();

  async function walk(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolutePath, relativePath);
      else if (entry.isFile()) output.push(relativePath);
      else throw new Error(`Unsupported asset filesystem entry: ${relativePath}`);
    }
  }
}
