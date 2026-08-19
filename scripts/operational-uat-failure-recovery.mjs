import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const REQUIRED_UAT_CASES = Object.freeze([
  'dashboard.date-preset',
  'dashboard.custom-date',
  'dashboard.invalid-range',
  'dashboard.pagination',
  'dashboard.page-size',
  'dashboard.sort',
  'dashboard.search',
  'dashboard.filter',
  'dashboard.drilldown',
  'dashboard.empty-state',
  'dashboard.retry',
  'dashboard.latest-request-wins',
  'csv.malformed',
  'csv.duplicate-import',
  'csv.empty',
  'csv.wrong-data-class',
  'csv.missing-identifiers',
  'csv.date-gaps',
  'csv.inconsistent-currency',
  'csv.inconsistent-marketplace',
  'csv.duplicate-logical-facts',
  'csv.import-overlap',
  'permission.unauthorized',
  'permission.store-access-mismatch',
  'permission.global-permission',
  'permission.store-permission',
  'failure.d1-query',
  'failure.stale-request',
  'failure.worker-error',
  'failure.missing-binding',
  'failure.release-rollback',
]);

export function evaluateOperationalUat(evidence = {}) {
  const cases = new Map((Array.isArray(evidence.cases) ? evidence.cases : []).map((item) => [item?.caseId, item]));
  const failures = [];

  for (const caseId of REQUIRED_UAT_CASES) {
    const item = cases.get(caseId);
    if (!item) {
      failures.push(`${caseId}:missing`);
      continue;
    }
    if (item.verified !== true) failures.push(`${caseId}:not_verified`);
    if (item.amazonExecutionAttempted !== false) failures.push(`${caseId}:amazon_execution_not_proven_absent`);
    if (item.crossStoreLeakageDetected !== false) failures.push(`${caseId}:cross_store_leakage_not_proven_absent`);
    if (item.fabricatedZeroPerformance !== false) failures.push(`${caseId}:fabricated_zero_performance_not_proven_absent`);
  }

  if (evidence.productionAmazonHardOff !== true) failures.push('production_amazon_hard_off_not_proven');
  if (evidence.failClosed !== true) failures.push('fail_closed_not_proven');

  return {
    schema: 'operational-uat-failure-recovery-v1',
    status: failures.length ? 'failed' : 'passed',
    requiredCaseCount: REQUIRED_UAT_CASES.length,
    verifiedCaseCount: REQUIRED_UAT_CASES.filter((caseId) => cases.get(caseId)?.verified === true).length,
    failures,
  };
}

async function main() {
  const inputFlag = process.argv.indexOf('--input');
  if (inputFlag < 0 || !process.argv[inputFlag + 1]) {
    console.log(JSON.stringify(evaluateOperationalUat({}), null, 2));
    process.exitCode = 2;
    return;
  }
  const raw = await fs.readFile(process.argv[inputFlag + 1], 'utf8');
  const result = evaluateOperationalUat(JSON.parse(raw));
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'passed') process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
