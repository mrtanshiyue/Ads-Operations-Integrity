import assert from 'node:assert/strict';
import {
  ProducerCapabilityError,
  assertProducerIntentSupported,
  implementedProducerDatasets,
} from '../cloudflare/runtime/sync-producer-capability.js';

assert.deepEqual(implementedProducerDatasets(), ['search_term_daily']);

const supported = assertProducerIntentSupported({ datasets: ['search_term_daily'] });
assert.deepEqual(supported.datasets, ['search_term_daily']);
assert.equal(supported.searchTermDaily, true);
assert.equal(supported.entityMirrorRequired, true);
assert.equal(supported.reportContract, 'search_term_daily.sp.v1');

for (const datasets of [
  [],
  ['campaign_daily'],
  ['search_term_daily', 'placement_daily'],
  ['keyword_daily', 'campaign_daily'],
]) {
  assert.throws(
    () => assertProducerIntentSupported({ datasets }),
    (error) => {
      assert(error instanceof ProducerCapabilityError);
      if (!datasets.length) return error.code === 'PRODUCER_DATASETS_REQUIRED';
      const unsupported = datasets.filter((dataset) => dataset !== 'search_term_daily').sort().join(',');
      return error.code === `PRODUCER_DATASET_NOT_IMPLEMENTED:${unsupported}`;
    },
  );
}

console.log(JSON.stringify({
  ok: true,
  implementedDatasets: implementedProducerDatasets(),
  unsupportedIntentFailsBeforeProducerComposition: true,
}, null, 2));
