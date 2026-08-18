import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repoRoot, 'dist-cloudflare-native');
const uiRelative = 'assets/cloudflare-native-csv-monthly-workspace-v1.js';
const uiSource = await readFile(path.join(distRoot, uiRelative), 'utf8');
const indexSource = await readFile(path.join(distRoot, 'index.html'), 'utf8');
const periodTag = '<script type="module" src="assets/cloudflare-native-csv-period-ui-v1.js?v=1.0.0"></script>';
const workspaceTag = '<script type="module" src="assets/cloudflare-native-csv-monthly-workspace-v1.js?v=1.0.0"></script>';
const provenanceTag = '<script type="module" src="assets/cloudflare-native-csv-provenance-audit-v1.js?v=1.0.0"></script>';

assert.equal(indexSource.split(workspaceTag).length - 1, 1, 'Monthly workspace must be injected exactly once');
assert.ok(indexSource.indexOf(periodTag) < indexSource.indexOf(workspaceTag), 'Monthly workspace must load after period UI');
assert.ok(indexSource.indexOf(workspaceTag) < indexSource.indexOf(provenanceTag), 'Monthly workspace must load before provenance audit UI');
assert.match(uiSource, /Monthly Multi-CSV Operating Workspace/);
assert.match(uiSource, /Partial coverage stays partial/i);
assert.match(uiSource, /overlapping or invalid windows stay blocked/i);
assert.match(uiSource, /Observed CSV identity is not canonical Amazon identity/i);
assert.match(uiSource, /Sales - Ad Spend only; not net profit/i);
assert.match(uiSource, /browser_local_monthly_workspace_only/);
assert.match(uiSource, /CSV_MONTHLY_WORKSPACE_AUTHORITY_ESCALATION_BLOCKED/);
assert.match(uiSource, /CSV_MONTHLY_WORKSPACE_CONTENT_HASH_INVALID/);

for (const pattern of [
  /\bfetch\s*\(/,
  /XMLHttpRequest/,
  /navigator\.sendBeacon/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /CloudflareNativeAPI/,
  /\/api\/v1\//,
  /CONTROL_DB/,
  /STORE_01_DB/,
  /DATA_BUCKET/,
  /AMAZON_ADS_ENABLED/,
  /optimization-actions/,
  /execution-permits/,
]) assert.equal(pattern.test(uiSource), false, `Monthly workspace must not use remote/storage/execution transport: ${pattern}`);

const mod = await import(`${pathToFileURL(path.join(distRoot, uiRelative)).href}?contract=${Date.now()}`);
assert.equal(mod.CSV_MONTHLY_WORKSPACE_SCHEMA_VERSION, 'csv-monthly-operating-workspace-v1');
assert.equal(mod.CSV_MONTHLY_WORKSPACE_UI_VERSION, '1.0.0');

const result = fixture();
const workspace = mod.buildCsvMonthlyOperatingWorkspace(result);
assert.equal(workspace.authority.authoritative, false);
assert.equal(workspace.authority.canonicalAmazonIdentityResolved, false);
assert.equal(workspace.authority.governancePersistenceAllowed, false);
assert.equal(workspace.authority.executionAuthorized, false);
assert.equal(workspace.authority.amazonMutationAuthorized, false);
assert.equal(workspace.source.inputSetFingerprint, result.source.inputSetFingerprint);
assert.equal(workspace.summary.monthCount, 3);
assert.equal(workspace.summary.fullMonthCount, 2);
assert.equal(workspace.summary.partialMonthCount, 1);
assert.equal(workspace.summary.blockedMonthCount, 1);
assert.equal(workspace.months[0].operatingState, 'full_month_review');
assert.equal(workspace.months[1].operatingState, 'partial_month_review');
assert.equal(workspace.months[2].operatingState, 'blocked');
assert.equal(workspace.months[0].sourceReceiptCount, 1);
assert.equal(workspace.months[1].sourceReceiptCount, 2);
assert.equal(workspace.months[2].sourceReceiptCount, 1);
assert.equal(workspace.months[0].sourceReceipts[0].currencyCode, 'USD');
assert.equal(workspace.months[1].comparisonToPreviousMonth.change.salesPct, 0.2);
assert.equal(workspace.months[0].profitabilityBasis, 'sales_minus_ad_spend_only_not_net_profit');

assert.throws(
  () => mod.buildCsvMonthlyOperatingWorkspace({ ...result, source: { ...result.source, executionAuthorized: true } }),
  (error) => error?.code === 'CSV_MONTHLY_WORKSPACE_AUTHORITY_ESCALATION_BLOCKED',
  'Monthly workspace must fail closed if execution authority appears',
);
assert.throws(
  () => mod.buildCsvMonthlyOperatingWorkspace({ ...result, imports: [{ ...result.imports[0], contentSha256: 'bad' }] }),
  (error) => error?.code === 'CSV_MONTHLY_WORKSPACE_CONTENT_HASH_INVALID',
  'Monthly workspace must reject invalid receipt hashes',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-monthly-operating-workspace-v1',
  monthSelector: true,
  monthlyMetrics: true,
  monthOverMonth: true,
  sourceReceiptMapping: true,
  partialCoveragePreserved: true,
  blockedDecisionStatePreserved: true,
  remotePersistence: false,
  amazonMutationAuthorized: false,
}, null, 2));

function fixture() {
  const fingerprint = 'a'.repeat(64);
  const janHash = 'b'.repeat(64);
  const febHash = 'c'.repeat(64);
  const marHash = 'd'.repeat(64);
  const authority = { authoritative: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false };
  return {
    source: { kind: 'csv_import_set', inputSetFingerprint: fingerprint, canonicalAmazonIdentityResolved: false, governancePersistenceAllowed: false, executionAuthorized: false, amazonMutationAuthorized: false },
    range: { startDate: '2026-01-01', endDate: '2026-03-31' },
    imports: [
      { sourceFileName: 'jan.csv', contentSha256: janHash, reportStartDate: '2026-01-01', reportEndDate: '2026-01-31', rowCount: 100, currencyCode: 'USD' },
      { sourceFileName: 'feb-a.csv', contentSha256: febHash, reportStartDate: '2026-02-01', reportEndDate: '2026-02-15', rowCount: 50, currencyCode: 'USD' },
      { sourceFileName: 'feb-mar.csv', contentSha256: marHash, reportStartDate: '2026-02-16', reportEndDate: '2026-03-31', rowCount: 80, currencyCode: 'USD' },
    ],
    analysis: { authority },
    periods: {
      authority,
      monthlySnapshots: [
        month('2026-01', '2026-01-01', '2026-01-31', 31, 31, 'review_only', 'observed', null),
        month('2026-02', '2026-02-01', '2026-02-28', 28, 20, 'review_with_partial_coverage', 'incomplete_coverage', { salesPct: 0.2, spendPct: 0.1, ordersPct: 0.1, acosDelta: -0.02 }),
        month('2026-03', '2026-03-01', '2026-03-31', 31, 31, 'blocked', 'blocked_overlap_or_invalid_window', { salesPct: 0.1, spendPct: 0.3, ordersPct: 0.2, acosDelta: 0.04 }),
      ],
    },
  };
}

function month(key, startDate, endDate, expected, covered, analyticalDecisionUse, reliabilityState, change) {
  return {
    month: key, startDate, endDate, monthComplete: covered === expected,
    coverage: { expectedDayCount: expected, coveredDayCount: covered, coverageRatio: covered / expected },
    metrics: { spendMicros: 2_000_000, salesMicros: 10_000_000, orders: 5, acos: 0.2, roas: 5 },
    adContributionMicros: 8_000_000,
    profitabilityBasis: 'sales_minus_ad_spend_only_not_net_profit',
    reliability: { state: reliabilityState, analyticalDecisionUse },
    comparisonToPreviousMonth: change ? { change, reliability: { state: reliabilityState, analyticalDecisionUse } } : null,
    requiresHumanReview: true,
    persistenceAuthorized: false, executionAuthorized: false, amazonMutationAuthorized: false,
  };
}