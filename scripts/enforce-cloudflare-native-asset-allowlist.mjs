import { access, readdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsRoot = path.join(repoRoot, 'dist-cloudflare-native', 'assets');

const allowedAssets = new Set([
  'bid-governance-parity-audit-v1.js',
  'cloudflare-gate6-acceptance-v1.js',
  'cloudflare-gate7-ui-acceptance-v1.js',
  'cloudflare-native-access-console-v1.js',
  'cloudflare-native-api-v1.js',
  'cloudflare-native-audit-console-v1.js',
  'cloudflare-native-csv-intelligence-v1.js',
  'cloudflare-native-csv-joint-analysis-v1.js',
  'cloudflare-native-csv-data-quality-command-center-v1.js',
  'cloudflare-native-csv-hierarchy-quality-v1.js',
  'cloudflare-native-csv-hierarchy-drilldown-v1.js',
  'cloudflare-native-csv-period-ui-v1.js',
  'cloudflare-native-csv-monthly-workspace-v1.js',
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
  'csv-analysis-engine/decision-intelligence.js',
  'csv-analysis-engine/csv-search-term-import.js',
  'csv-analysis-engine/csv-term-profitability-analysis.js',
  'csv-analysis-engine/csv-observed-targeting-identity.js',
  'csv-analysis-engine/csv-window-quality-analysis.js',
  'csv-analysis-engine/csv-hierarchy-profitability-analysis.js',
  'csv-analysis-engine/csv-period-over-period-analysis.js',
  'csv-analysis-engine/csv-joint-report-analysis.js',
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
  removedAssetCount: removed.length,
  removedAssets: removed,
  forbiddenAssets: [...forbiddenAssets],
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
