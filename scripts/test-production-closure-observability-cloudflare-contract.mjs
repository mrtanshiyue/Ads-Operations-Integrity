import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('./production-closure-observability.mjs', import.meta.url), 'utf8');
const workflow = await fs.readFile(new URL('../.github/workflows/production-closure-observability.yml', import.meta.url), 'utf8');

assert(
  source.includes('/workers/scripts/${encodeURIComponent(workerName)}/versions/${encodeURIComponent(versionId)}'),
  'collector must use Cloudflare Workers Scripts version-detail endpoint',
);
assert(
  !source.includes('/workers/workers/${encodeURIComponent(workerName)}/versions/'),
  'legacy invalid /workers/workers version endpoint must not return',
);
assert(
  source.includes('version?.resources?.bindings'),
  'collector must read plain-text bindings from the current version resources.bindings response shape',
);
assert(
  source.includes("method: 'GET'"),
  'Cloudflare observability transport must remain GET-only',
);
assert(
  workflow.includes('Checkout observability dispatch ref'),
  'Draft workflow must retain the observability implementation checkout',
);
assert(
  workflow.includes('git fetch --no-tags --depth=1 origin main'),
  'Draft workflow must resolve canonical main independently',
);
assert(
  workflow.includes('echo "EXPECTED_MAIN_SHA=$EXPECTED_MAIN_SHA" >> "$GITHUB_ENV"'),
  'canonical main SHA must be passed explicitly to the collector',
);
assert(
  !workflow.includes('ref: main'),
  'Draft live observability must not replace its own collector checkout with main',
);

console.log(JSON.stringify({
  ok: true,
  cloudflareWorkerVersionEndpointLocked: true,
  currentVersionBindingShapeLocked: true,
  readOnlyTransportLocked: true,
  draftCollectorUsesCanonicalMainTruth: true,
}));
