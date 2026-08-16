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

// Acquisition executes inside the sync Worker runtime. Its independent kill switch is
// AMAZON_ADS_ENABLED. SYNC_TRIGGER_ENABLED belongs to the web registration boundary and
// must not be treated as a second in-process execution grant.
export function inspectReportCycleAcquisitionCapability(env) {
  const source = env && typeof env === 'object' && !Array.isArray(env) ? env : {};
  const amazonAdsEnabled = source.AMAZON_ADS_ENABLED === 'true';
  return Object.freeze({
    amazonAdsEnabled,
    enabled:amazonAdsEnabled,
  });
}

export function assertReportCycleAcquisitionCapability(env) {
  const capability = inspectReportCycleAcquisitionCapability(env);
  if (!capability.amazonAdsEnabled) {
    throw new ReportCycleAcquisitionCapabilityError(
      'REPORT_CYCLE_ACQUISITION_DISABLED:AMAZON_ADS_ENABLED',
    );
  }
  return capability;
}

// Wrap only explicitly supplied acquisition adapters. Missing adapters remain missing,
// preserving the executor's existing fail-closed behavior. The sync-runtime Amazon kill
// switch is re-evaluated immediately before every external acquisition side effect.
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
