import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('./production-closure-observability.mjs', import.meta.url), 'utf8');

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

console.log(JSON.stringify({
  ok: true,
  cloudflareWorkerVersionEndpointLocked: true,
  currentVersionBindingShapeLocked: true,
  readOnlyTransportLocked: true,
}));
