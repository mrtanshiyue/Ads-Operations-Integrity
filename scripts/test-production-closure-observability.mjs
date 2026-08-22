import assert from 'node:assert/strict';
import {
  buildProductionClosureStatus,
  renderProductionClosureMarkdown,
} from './production-closure-observability.mjs';

const main = '535552f760dd9f94befc019a61f90b5f5ca145cb';
const prod229 = '0557f4eaeae2e0a749d49653844f7ce8e1579f17';

const runtime = (workerName, sourceCommit, suffix) => ({
  workerName,
  workerTag: `${suffix}`.repeat(32).slice(0, 32),
  sourceCommit,
  buildUuid: `build-${suffix}`,
  deploymentId: `deployment-${suffix}`,
  versionId: `version-${suffix}`,
  traffic: 100,
  buildOutcome: 'success',
  buildTriggerSource: 'manual',
  buildTriggerUuid: `trigger-${suffix}`,
});

const hardOff = {
  syncTriggerEnabled: false,
  amazonAdsEnabled: false,
  phase5SingleRunPermitId: '',
  phase5SingleRunReportDate: '',
  schedules: [],
};

const staged = buildProductionClosureStatus({
  mainSha: main,
  generatedAt: '2026-08-22T03:30:00Z',
  dev: runtime('ads-operations-web-dev', main, 'a'),
  prod: runtime('ads-operations-web-prod', prod229, 'b'),
  hardOff,
});

assert.equal(staged.authority, 'live-cloudflare-control-plane-read-only');
assert.equal(staged.runtimeParity.devExactMain, true);
assert.equal(staged.runtimeParity.prodExactMain, false);
assert.equal(staged.runtimeParity.stagedRuntimeDrift, true);
assert.equal(staged.runtimeParity.status, 'blocked');
assert.equal(staged.amazonHardOff.status, 'HARD_OFF');
assert.deepEqual(staged.productionSyncSchedules, []);
assert.deepEqual(staged.blockers, ['production_not_exact_main']);
assert.equal(staged.formalClosure.releaseTrace, 'blocked_by_live_runtime_gate');
assert.equal(staged.formalClosure.driftReceipt, 'blocked_by_live_runtime_gate');
assert.equal(staged.formalClosure.productionBaseline, 'blocked_by_live_runtime_gate');
assert.equal(staged.formalClosure.finalClosure, 'blocked');

const parity = buildProductionClosureStatus({
  mainSha: main,
  generatedAt: '2026-08-22T04:00:00Z',
  dev: runtime('ads-operations-web-dev', main, 'a'),
  prod: runtime('ads-operations-web-prod', main, 'b'),
  hardOff,
});
assert.equal(parity.runtimeParity.status, 'exact_main_100_percent');
assert.equal(parity.runtimeParity.stagedRuntimeDrift, false);
assert.deepEqual(parity.blockers, []);
assert.equal(parity.formalClosure.releaseTrace, 'requires_formal_rerun');
assert.equal(parity.formalClosure.driftReceipt, 'requires_formal_rerun');
assert.equal(parity.formalClosure.productionBaseline, 'requires_formal_rerun');
assert.equal(parity.formalClosure.finalClosure, 'requires_formal_evidence');

const unsafe = buildProductionClosureStatus({
  mainSha: main,
  generatedAt: '2026-08-22T04:00:00Z',
  dev: runtime('ads-operations-web-dev', main, 'a'),
  prod: runtime('ads-operations-web-prod', main, 'b'),
  hardOff: { ...hardOff, amazonAdsEnabled: true },
});
assert.equal(unsafe.amazonHardOff.status, 'VIOLATION');
assert(unsafe.blockers.includes('amazon_transport_not_hard_off'));
assert.equal(unsafe.formalClosure.finalClosure, 'blocked');

const partialTraffic = buildProductionClosureStatus({
  mainSha: main,
  generatedAt: '2026-08-22T04:00:00Z',
  dev: runtime('ads-operations-web-dev', main, 'a'),
  prod: { ...runtime('ads-operations-web-prod', main, 'b'), traffic: 90 },
  hardOff,
});
assert(partialTraffic.blockers.includes('production_traffic_not_100_percent'));
assert.equal(partialTraffic.runtimeParity.bothFullTraffic, false);

const markdown = renderProductionClosureMarkdown(staged);
for (const expected of [
  'Canonical main',
  'Dev source',
  'Production source',
  'Production traffic',
  'Staged runtime drift',
  'Amazon HARD-OFF',
  'Production Sync schedules',
  'Release Trace',
  'Drift Receipt',
  'Production Baseline',
  'Final closure',
  'production_not_exact_main',
]) {
  assert(markdown.includes(expected), `markdown missing ${expected}`);
}
assert(markdown.includes('does not deploy'));
assert(markdown.includes('does not') && markdown.includes('call Amazon'));

assert.throws(
  () => buildProductionClosureStatus({
    mainSha: 'not-a-sha',
    generatedAt: '2026-08-22T04:00:00Z',
    dev: runtime('ads-operations-web-dev', main, 'a'),
    prod: runtime('ads-operations-web-prod', main, 'b'),
    hardOff,
  }),
  /CLOSURE_OBSERVABILITY_MAIN_SHA_INVALID/,
);

console.log(JSON.stringify({
  ok: true,
  contract: 'production-closure-observability-v1',
  stagedRuntimeDriftFailsClosed: true,
  exactMainRequiresFormalEvidence: true,
  amazonHardOffRequired: true,
  operatorClosureSignalsCovered: true,
}));
