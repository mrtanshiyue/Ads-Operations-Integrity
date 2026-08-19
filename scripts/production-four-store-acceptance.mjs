import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const REQUIRED_ANALYTICS = Object.freeze([
  'overview',
  'daily',
  'campaign',
  'ad-group',
  'targeting',
  'search-term',
  'quality',
  'diagnostics',
]);

export const REQUIRED_STORE_COUNT = 4;

export function evaluateProductionAcceptance(evidence = {}) {
  const stores = Array.isArray(evidence.stores) ? evidence.stores : [];
  const storeIds = stores.map((store) => String(store?.storeId || '').trim()).filter(Boolean);
  const uniqueStoreIds = new Set(storeIds);
  const blockers = [];
  const failures = [];

  if (evidence.realProductionCsv !== true) {
    blockers.push('real_production_csv_required');
  }
  if (stores.length !== REQUIRED_STORE_COUNT || uniqueStoreIds.size !== REQUIRED_STORE_COUNT) {
    failures.push('exactly_four_unique_stores_required');
  }

  for (const store of stores) {
    const storeId = String(store?.storeId || '').trim() || 'unknown-store';
    if (store?.csvImport?.accepted !== true) failures.push(`${storeId}:csv_import_not_accepted`);
    if (store?.csvImport?.classification !== 'business') failures.push(`${storeId}:business_classification_missing`);
    if (store?.csvImport?.businessFactsPresent !== true) failures.push(`${storeId}:business_facts_missing`);
    if (store?.csvImport?.observedIdentityAuthority !== 'non-canonical') {
      failures.push(`${storeId}:observed_csv_identity_authority_must_remain_non_canonical`);
    }
    if (store?.crossStoreLeakageDetected === true) failures.push(`${storeId}:cross_store_leakage_detected`);
    if (store?.exportVerified !== true) failures.push(`${storeId}:export_not_verified`);

    for (const dimension of REQUIRED_ANALYTICS) {
      if (store?.analytics?.[dimension]?.verified !== true) {
        failures.push(`${storeId}:analytics_${dimension}_not_verified`);
      }
      const returnedStoreIds = store?.analytics?.[dimension]?.returnedStoreIds;
      if (Array.isArray(returnedStoreIds) && returnedStoreIds.some((id) => String(id) !== storeId)) {
        failures.push(`${storeId}:analytics_${dimension}_cross_store_leakage`);
      }
    }
  }

  const status = failures.length > 0 ? 'failed' : blockers.length > 0 ? 'blocked' : 'passed';
  return {
    schema: 'production-four-store-acceptance-v1',
    status,
    storeCount: stores.length,
    uniqueStoreCount: uniqueStoreIds.size,
    blockers,
    failures,
  };
}

async function main() {
  const inputFlag = process.argv.indexOf('--input');
  if (inputFlag < 0 || !process.argv[inputFlag + 1]) {
    const result = evaluateProductionAcceptance({ realProductionCsv: false, stores: [] });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const raw = await fs.readFile(process.argv[inputFlag + 1], 'utf8');
  const evidence = JSON.parse(raw);
  const result = evaluateProductionAcceptance(evidence);
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'failed') process.exitCode = 1;
  if (result.status === 'blocked') process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
