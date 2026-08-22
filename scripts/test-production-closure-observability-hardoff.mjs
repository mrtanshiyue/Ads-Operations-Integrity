import assert from 'node:assert/strict';
import { buildProductionClosureStatus } from './production-closure-observability.mjs';

const sha = '535552f760dd9f94befc019a61f90b5f5ca145cb';
const runtime = (name) => ({
  workerName: name,
  workerTag: 'a'.repeat(32),
  sourceCommit: sha,
  buildUuid: 'build',
  deploymentId: 'deployment',
  versionId: 'version',
  traffic: 100,
});
const base = {
  mainSha: sha,
  generatedAt: '2026-08-22T04:00:00Z',
  dev: runtime('ads-operations-web-dev'),
  prod: runtime('ads-operations-web-prod'),
};
const hardOff = {
  syncTriggerEnabled: false,
  amazonAdsEnabled: false,
  phase5SingleRunPermitId: '',
  phase5SingleRunReportDate: '',
  schedules: [],
};

for (const key of ['phase5SingleRunPermitId', 'phase5SingleRunReportDate']) {
  const candidate = { ...hardOff };
  delete candidate[key];
  assert.throws(() => buildProductionClosureStatus({ ...base, hardOff: candidate }), /_MISSING/);
}

console.log(JSON.stringify({ ok: true, missingPhase5BindingsFailClosed: true }));
