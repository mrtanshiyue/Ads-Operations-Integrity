import assert from 'node:assert/strict';
import {
  inspectReportCycleAcquisitionCapability,
  assertReportCycleAcquisitionCapability,
  createReportCycleAcquisitionCapabilityGate,
  ReportCycleAcquisitionCapabilityError,
} from '../cloudflare/runtime/sync-report-cycle-acquisition-capability.js';

function expectCode(code, fn) {
  assert.throws(
    fn,
    (error) => error instanceof ReportCycleAcquisitionCapabilityError && error.code === code,
  );
}

assert.deepEqual(inspectReportCycleAcquisitionCapability({}), {
  syncTriggerEnabled:false,
  amazonAdsEnabled:false,
  enabled:false,
});
assert.deepEqual(inspectReportCycleAcquisitionCapability({
  SYNC_TRIGGER_ENABLED:'true',
  AMAZON_ADS_ENABLED:'true',
}), {
  syncTriggerEnabled:true,
  amazonAdsEnabled:true,
  enabled:true,
});
// Truthy/coerced values are not grants; only the exact deployment string "true" is accepted.
assert.equal(inspectReportCycleAcquisitionCapability({
  SYNC_TRIGGER_ENABLED:true,
  AMAZON_ADS_ENABLED:1,
}).enabled, false);

expectCode('REPORT_CYCLE_ACQUISITION_DISABLED:SYNC_TRIGGER_ENABLED', () =>
  assertReportCycleAcquisitionCapability({ AMAZON_ADS_ENABLED:'true' }),
);
expectCode('REPORT_CYCLE_ACQUISITION_DISABLED:AMAZON_ADS_ENABLED', () =>
  assertReportCycleAcquisitionCapability({ SYNC_TRIGGER_ENABLED:'true' }),
);

expectCode('REPORT_CYCLE_ACQUISITION_ADAPTERS_INVALID', () =>
  createReportCycleAcquisitionCapabilityGate({ env:{}, adapters:[] }),
);
expectCode('REPORT_CYCLE_ACQUISITION_ADAPTER_NOT_ALLOWED:finalizeRun', () =>
  createReportCycleAcquisitionCapabilityGate({ env:{}, adapters:{ finalizeRun() {} } }),
);
expectCode('REPORT_CYCLE_ACQUISITION_ADAPTER_INVALID:createAmazonReport', () =>
  createReportCycleAcquisitionCapabilityGate({ env:{}, adapters:{ createAmazonReport:true } }),
);

// Missing adapters remain missing; the gate never invents external capability.
{
  const guarded = createReportCycleAcquisitionCapabilityGate({ env:{}, adapters:{} });
  assert.deepEqual(Object.keys(guarded), []);
  assert.ok(Object.isFrozen(guarded));
}

// Every acquisition directive is blocked before its delegate when either runtime kill switch is off.
for (const [name, env, code] of [
  ['createAmazonReport', { SYNC_TRIGGER_ENABLED:'false', AMAZON_ADS_ENABLED:'true' }, 'REPORT_CYCLE_ACQUISITION_DISABLED:SYNC_TRIGGER_ENABLED'],
  ['pollAmazonReport', { SYNC_TRIGGER_ENABLED:'true', AMAZON_ADS_ENABLED:'false' }, 'REPORT_CYCLE_ACQUISITION_DISABLED:AMAZON_ADS_ENABLED'],
  ['materializeRawObject', { SYNC_TRIGGER_ENABLED:'true' }, 'REPORT_CYCLE_ACQUISITION_DISABLED:AMAZON_ADS_ENABLED'],
]) {
  let calls = 0;
  const guarded = createReportCycleAcquisitionCapabilityGate({
    env,
    adapters:{ [name]:async () => { calls += 1; return { ok:true }; } },
  });
  await assert.rejects(
    () => guarded[name]({ directive:name }),
    (error) => error instanceof ReportCycleAcquisitionCapabilityError && error.code === code,
  );
  assert.equal(calls, 0, `${name} delegate must remain untouched while capability is disabled`);
}

// Both exact grants are required; once present, the wrapper delegates without altering input/receipt.
{
  const env = { SYNC_TRIGGER_ENABLED:'true', AMAZON_ADS_ENABLED:'true' };
  const calls = [];
  const adapters = {
    createAmazonReport:async (input) => { calls.push(['create', input]); return { action:'created' }; },
    pollAmazonReport:async (input) => { calls.push(['poll', input]); return { action:'polled' }; },
    materializeRawObject:async (input) => { calls.push(['materialize', input]); return { action:'materialized' }; },
  };
  const guarded = createReportCycleAcquisitionCapabilityGate({ env, adapters });
  const payload = Object.freeze({ runId:'run-1', jobId:'job-1' });
  assert.deepEqual(await guarded.createAmazonReport(payload), { action:'created' });
  assert.deepEqual(await guarded.pollAmazonReport(payload), { action:'polled' });
  assert.deepEqual(await guarded.materializeRawObject(payload), { action:'materialized' });
  assert.deepEqual(calls, [
    ['create', payload],
    ['poll', payload],
    ['materialize', payload],
  ]);
}

// Capability is checked per invocation rather than frozen at wrapper construction.
{
  const env = { SYNC_TRIGGER_ENABLED:'true', AMAZON_ADS_ENABLED:'true' };
  let calls = 0;
  const guarded = createReportCycleAcquisitionCapabilityGate({
    env,
    adapters:{ createAmazonReport:async () => { calls += 1; return { ok:true }; } },
  });
  await guarded.createAmazonReport({});
  assert.equal(calls, 1);
  env.AMAZON_ADS_ENABLED = 'false';
  await assert.rejects(
    () => guarded.createAmazonReport({}),
    (error) => error.code === 'REPORT_CYCLE_ACQUISITION_DISABLED:AMAZON_ADS_ENABLED',
  );
  assert.equal(calls, 1);
}

console.log('report cycle acquisition capability gate: PASS');
