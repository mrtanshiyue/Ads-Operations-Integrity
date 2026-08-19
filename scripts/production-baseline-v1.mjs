import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const REQUIRED_HARD_OFF = Object.freeze({
  SYNC_TRIGGER_ENABLED: 'false',
  PHASE5_SINGLE_RUN_PERMIT_ID: '',
  PHASE5_SINGLE_RUN_REPORT_DATE: '',
  AMAZON_ADS_ENABLED: 'false',
});

export function buildProductionBaseline(liveTruth = {}) {
  requireValue(liveTruth.sourceKind === 'live-control-plane', 'sourceKind_live_control_plane_required');
  requireString(liveTruth.generatedAt, 'generatedAt');
  requireString(liveTruth.git?.mainSha, 'git.mainSha');
  requireString(liveTruth.ci?.requiredContext, 'ci.requiredContext');
  requireString(liveTruth.ci?.conclusion, 'ci.conclusion');
  requireString(liveTruth.dev?.buildUuid, 'dev.buildUuid');
  requireString(liveTruth.dev?.workerVersion, 'dev.workerVersion');
  requireString(liveTruth.dev?.deploymentId, 'dev.deploymentId');
  requireNumber(liveTruth.dev?.traffic, 'dev.traffic');
  requireString(liveTruth.dev?.sourceCommit, 'dev.sourceCommit');
  requireString(liveTruth.prod?.buildUuid, 'prod.buildUuid');
  requireString(liveTruth.prod?.workerVersion, 'prod.workerVersion');
  requireString(liveTruth.prod?.deploymentId, 'prod.deploymentId');
  requireNumber(liveTruth.prod?.traffic, 'prod.traffic');
  requireString(liveTruth.prod?.sourceCommit, 'prod.sourceCommit');
  requireArray(liveTruth.migrations?.devControl, 'migrations.devControl');
  requireArray(liveTruth.migrations?.devStore, 'migrations.devStore');
  requireArray(liveTruth.migrations?.prodControl, 'migrations.prodControl');
  requireArray(liveTruth.migrations?.prodStores, 'migrations.prodStores');
  requireString(liveTruth.releaseTrace?.artifact, 'releaseTrace.artifact');
  requireString(liveTruth.acceptance?.status, 'acceptance.status');
  requireArray(liveTruth.acceptance?.remainingBlockers, 'acceptance.remainingBlockers');

  for (const [key, required] of Object.entries(REQUIRED_HARD_OFF)) {
    if (String(liveTruth.hardOff?.[key] ?? '') !== required) {
      throw new Error(`production_hard_off_mismatch:${key}`);
    }
  }

  const mainSha = liveTruth.git.mainSha;
  if (liveTruth.dev.sourceCommit !== mainSha) throw new Error('dev_not_exact_main');
  if (liveTruth.prod.sourceCommit !== mainSha) throw new Error('prod_not_exact_main');
  if (liveTruth.dev.traffic !== 100) throw new Error('dev_traffic_not_100_percent');
  if (liveTruth.prod.traffic !== 100) throw new Error('prod_traffic_not_100_percent');
  if (liveTruth.ci.conclusion !== 'success') throw new Error('required_ci_not_success');

  return {
    schema: 'production-baseline-v1',
    authority: 'live-control-plane-derived',
    generatedAt: liveTruth.generatedAt,
    git: {
      mainSha,
      requiredContext: liveTruth.ci.requiredContext,
      ciConclusion: liveTruth.ci.conclusion,
    },
    development: {
      buildUuid: liveTruth.dev.buildUuid,
      workerVersion: liveTruth.dev.workerVersion,
      deploymentId: liveTruth.dev.deploymentId,
      traffic: liveTruth.dev.traffic,
      sourceCommit: liveTruth.dev.sourceCommit,
    },
    production: {
      buildUuid: liveTruth.prod.buildUuid,
      workerVersion: liveTruth.prod.workerVersion,
      deploymentId: liveTruth.prod.deploymentId,
      traffic: liveTruth.prod.traffic,
      sourceCommit: liveTruth.prod.sourceCommit,
    },
    migrations: liveTruth.migrations,
    hardOff: { ...REQUIRED_HARD_OFF },
    releaseTrace: liveTruth.releaseTrace,
    acceptance: liveTruth.acceptance,
  };
}

function requireValue(condition, code) {
  if (!condition) throw new Error(code);
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`live_truth_missing:${field}`);
}

function requireNumber(value, field) {
  if (!Number.isFinite(value)) throw new Error(`live_truth_missing:${field}`);
}

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new Error(`live_truth_missing:${field}`);
}

async function main() {
  const inputIndex = process.argv.indexOf('--input');
  const outputIndex = process.argv.indexOf('--output');
  if (inputIndex < 0 || !process.argv[inputIndex + 1]) throw new Error('--input live-truth.json is required');
  const input = JSON.parse(await fs.readFile(process.argv[inputIndex + 1], 'utf8'));
  const baseline = buildProductionBaseline(input);
  const body = `${JSON.stringify(baseline, null, 2)}\n`;
  if (outputIndex >= 0 && process.argv[outputIndex + 1]) {
    await fs.writeFile(process.argv[outputIndex + 1], body);
  } else {
    process.stdout.write(body);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
