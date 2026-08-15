const ACQUISITION_ADAPTER_NAMES = Object.freeze([
  'createAmazonReport',
  'pollAmazonReport',
  'materializeRawObject',
]);
const ACQUISITION_ADAPTER_SET = new Set(ACQUISITION_ADAPTER_NAMES);

export class ReportCycleAcquisitionCapabilityError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ReportCycleAcquisitionCapabilityError';
    this.code = code;
  }
}

export function inspectReportCycleAcquisitionCapability(env) {
  const source = env && typeof env === 'object' && !Array.isArray(env) ? env : {};
  const syncTriggerEnabled = source.SYNC_TRIGGER_ENABLED === 'true';
  const amazonAdsEnabled = source.AMAZON_ADS_ENABLED === 'true';
  return Object.freeze({
    syncTriggerEnabled,
    amazonAdsEnabled,
    enabled:syncTriggerEnabled && amazonAdsEnabled,
  });
}

export function assertReportCycleAcquisitionCapability(env) {
  const capability = inspectReportCycleAcquisitionCapability(env);
  if (!capability.syncTriggerEnabled) {
    throw new ReportCycleAcquisitionCapabilityError(
      'REPORT_CYCLE_ACQUISITION_DISABLED:SYNC_TRIGGER_ENABLED',
    );
  }
  if (!capability.amazonAdsEnabled) {
    throw new ReportCycleAcquisitionCapabilityError(
      'REPORT_CYCLE_ACQUISITION_DISABLED:AMAZON_ADS_ENABLED',
    );
  }
  return capability;
}

// Wrap only explicitly supplied acquisition adapters. Missing adapters remain missing,
// preserving the executor's existing fail-closed behavior. The two runtime kill switches
// are re-evaluated immediately before every external acquisition side effect.
export function createReportCycleAcquisitionCapabilityGate({ env, adapters = {} } = {}) {
  if (!adapters || typeof adapters !== 'object' || Array.isArray(adapters)) {
    throw new ReportCycleAcquisitionCapabilityError(
      'REPORT_CYCLE_ACQUISITION_ADAPTERS_INVALID',
    );
  }

  const unknown = Object.keys(adapters)
    .filter((name) => !ACQUISITION_ADAPTER_SET.has(name))
    .sort();
  if (unknown.length) {
    throw new ReportCycleAcquisitionCapabilityError(
      `REPORT_CYCLE_ACQUISITION_ADAPTER_NOT_ALLOWED:${unknown.join(',')}`,
    );
  }

  const guarded = {};
  for (const name of ACQUISITION_ADAPTER_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(adapters, name)) continue;
    const delegate = adapters[name];
    if (typeof delegate !== 'function') {
      throw new ReportCycleAcquisitionCapabilityError(
        `REPORT_CYCLE_ACQUISITION_ADAPTER_INVALID:${name}`,
      );
    }
    guarded[name] = async (input) => {
      assertReportCycleAcquisitionCapability(env);
      return delegate(input);
    };
  }
  return Object.freeze(guarded);
}
