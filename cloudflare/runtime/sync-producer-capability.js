const IMPLEMENTED_DATASETS = new Set(['search_term_daily']);

export class ProducerCapabilityError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProducerCapabilityError';
    this.code = code;
  }
}

export function assertProducerIntentSupported(intent) {
  const datasets = Array.isArray(intent?.datasets) ? intent.datasets : [];
  if (!datasets.length) throw new ProducerCapabilityError('PRODUCER_DATASETS_REQUIRED');

  const unsupported = [...new Set(datasets
    .map((value) => String(value ?? '').trim())
    .filter(Boolean)
    .filter((dataset) => !IMPLEMENTED_DATASETS.has(dataset)))].sort();

  if (unsupported.length) {
    throw new ProducerCapabilityError(`PRODUCER_DATASET_NOT_IMPLEMENTED:${unsupported.join(',')}`);
  }

  return Object.freeze({
    datasets: Object.freeze([...datasets]),
    searchTermDaily: true,
    entityMirrorRequired: true,
    reportContract: 'search_term_daily.sp.v1',
  });
}

export function implementedProducerDatasets() {
  return Object.freeze([...IMPLEMENTED_DATASETS].sort());
}
