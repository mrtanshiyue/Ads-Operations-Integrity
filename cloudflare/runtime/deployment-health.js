const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});

const STORE_BINDINGS = Object.freeze([
  'STORE_01_DB',
  'STORE_02_DB',
  'STORE_03_DB',
  'STORE_04_DB',
]);

export function handleDeploymentHealthRoute({ request, env = {}, url }) {
  if (!request || !url) return null;
  if (request.method.toUpperCase() !== 'GET' || url.pathname !== '/api/health') return null;

  return json(request, {
    ok: true,
    service: 'ads-operations-web',
    environment: textOrFallback(env.APP_ENV, 'unknown'),
    deployment: runtimeVersionMetadata(env.CF_VERSION_METADATA),
    dependencies: {
      assets: Boolean(env.ASSETS),
      controlDb: Boolean(env.CONTROL_DB),
      dataBucket: Boolean(env.DATA_BUCKET),
      storeDatabases: configuredStoreDatabaseCount(env),
      syncWorkflow: Boolean(env.AMAZON_SYNC_WORKFLOW),
    },
    syncTriggerEnabled: env.SYNC_TRIGGER_ENABLED === 'true',
  }, 200);
}

export function runtimeVersionMetadata(value) {
  const metadata = value && typeof value === 'object' ? value : {};
  return Object.freeze({
    versionId: optionalText(metadata.id),
    versionTag: optionalText(metadata.tag),
    versionTimestamp: optionalTimestamp(metadata.timestamp),
  });
}

function configuredStoreDatabaseCount(env) {
  return STORE_BINDINGS.reduce((count, binding) => count + (env?.[binding] ? 1 : 0), 0);
}

function optionalTimestamp(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return optionalText(value);
}

function optionalText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function textOrFallback(value, fallback) {
  return optionalText(value) || fallback;
}

function json(request, payload, status) {
  const headers = new Headers(JSON_HEADERS);
  const ray = request.headers.get('cf-ray');
  if (ray) headers.set('x-request-id', ray);
  return new Response(JSON.stringify(payload), { status, headers });
}
