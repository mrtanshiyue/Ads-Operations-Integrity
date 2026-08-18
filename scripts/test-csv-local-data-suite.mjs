import { spawnSync } from 'node:child_process';

const skipBuild = process.argv.includes('--skip-build');

function run(command, args, label) {
  process.stdout.write(`\n[CSV local-data suite] ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`[CSV local-data suite] ${label} failed to start:`, result.error);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`[CSV local-data suite] ${label} failed with status ${result.status ?? 'unknown'}`);
    process.exit(result.status ?? 1);
  }
}

if (!skipBuild) {
  run(process.execPath, ['scripts/build-cloudflare-native.mjs'], 'build canonical Cloudflare Native assets');
}

const syntaxTargets = [
  'cloudflare/runtime/csv-search-term-import.js',
  'cloudflare/runtime/csv-search-term-import-repository.js',
  'cloudflare/runtime/csv-search-term-ingestion.js',
  'cloudflare/runtime/csv-imports-api.js',
  'cloudflare/runtime/csv-search-term-intelligence-api.js',
  'cloudflare/runtime/csv-productization-api.js',
  'cloudflare/runtime/csv-term-profitability-analysis.js',
  'cloudflare/runtime/csv-joint-report-analysis.js',
  'assets/cloudflare-native-imports-console-v1.js',
  'assets/cloudflare-native-csv-intelligence-v1.js',
  'assets/cloudflare-native-csv-product-ui-v2.js',
  'scripts/analyze-search-term-csv-files.mjs',
  'scripts/test-csv-search-term-import.mjs',
  'scripts/test-csv-import-workflow-contract.mjs',
  'scripts/test-csv-imports-ui-contract.mjs',
  'scripts/test-csv-real-data-intelligence-contract.mjs',
  'scripts/test-csv-real-data-intelligence-ui-contract.mjs',
  'scripts/test-csv-product-ui-navigation-contract.mjs',
  'scripts/test-csv-term-profitability-analysis.mjs',
  'scripts/test-csv-joint-report-analysis.mjs',
];

for (const target of syntaxTargets) {
  run(process.execPath, ['--check', target], `syntax: ${target}`);
}

const nodeContracts = [
  'scripts/test-csv-search-term-import.mjs',
  'scripts/test-csv-import-workflow-contract.mjs',
  'scripts/test-csv-imports-ui-contract.mjs',
  'scripts/test-csv-real-data-intelligence-contract.mjs',
  'scripts/test-csv-real-data-intelligence-ui-contract.mjs',
  'scripts/test-csv-product-ui-navigation-contract.mjs',
  'scripts/test-csv-term-profitability-analysis.mjs',
  'scripts/test-csv-joint-report-analysis.mjs',
];

for (const contract of nodeContracts) {
  run(process.execPath, [contract], `contract: ${contract}`);
}

run('python3', ['scripts/test-csv-import-foundation.py'], 'contract: scripts/test-csv-import-foundation.py');

console.log(JSON.stringify({
  ok: true,
  contract: 'csv-local-data-required-ci-v3-joint-analysis',
  buildSkipped: skipBuild,
  syntaxTargets: syntaxTargets.length,
  nodeContracts: nodeContracts.length,
  pythonContracts: 1,
  amazonLiveApiCalls: false,
  cloudflareWrites: false,
  d1RemoteWrites: false,
}, null, 2));
