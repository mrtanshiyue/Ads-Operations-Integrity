import { buildFinalClosureEvidence, FINAL_CLOSURE_EXPECTED as EXPECTED } from './final-closure-evidence-contract.mjs';

const SHA40 = /^[0-9a-f]{40}$/i;

export async function collectFinalClosureEvidence(options = {}) {
  const repo = requiredText(options.repo || process.env.GITHUB_REPOSITORY, 'FINAL_CLOSURE_GITHUB_REPOSITORY_REQUIRED');
  const githubToken = requiredText(options.githubToken || process.env.GITHUB_TOKEN, 'FINAL_CLOSURE_GITHUB_TOKEN_REQUIRED');
  const accountId = requiredText(options.accountId || process.env.CLOUDFLARE_ACCOUNT_ID, 'FINAL_CLOSURE_CLOUDFLARE_ACCOUNT_ID_REQUIRED');
  const cfToken = requiredText(options.cfToken || process.env.CLOUDFLARE_API_TOKEN, 'FINAL_CLOSURE_CLOUDFLARE_TOKEN_REQUIRED');
  const fetchImpl = options.fetchImpl || fetch;
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error('FINAL_CLOSURE_GITHUB_REPOSITORY_INVALID');

  const gh = (path) => githubGet({ fetchImpl, githubToken, path });
  const cf = (method, path, body) => cloudflareJson({ fetchImpl, accountId, cfToken, method, path, body });

  const mainBranch = await gh(`/repos/${owner}/${name}/branches/main`);
  const mainSha = requireSha(mainBranch?.commit?.sha, 'FINAL_CLOSURE_MAIN_SHA_INVALID');
  const checks = await gh(`/repos/${owner}/${name}/commits/${mainSha}/check-runs?per_page=100`);
  const requiredCheck = (checks?.check_runs || []).filter((check) => check?.name === EXPECTED.requiredContext).sort((a, b) => Date.parse(b.completed_at || 0) - Date.parse(a.completed_at || 0))[0];
  const ci = { requiredContext: EXPECTED.requiredContext, conclusion: String(requiredCheck?.conclusion || 'missing') };

  const workers = await cf('GET', '/workers/scripts');
  const workerTagByName = new Map((Array.isArray(workers?.result) ? workers.result : []).map((worker) => [worker.id, worker.tag]));
  const [dev, prod, sync] = await Promise.all([
    collectRuntime({ cf, workerName: 'ads-operations-web-dev', workerTag: workerTagByName.get('ads-operations-web-dev') }),
    collectRuntime({ cf, workerName: 'ads-operations-web-prod', workerTag: workerTagByName.get('ads-operations-web-prod') }),
    collectRuntime({ cf, workerName: 'ads-operations-sync-prod', workerTag: workerTagByName.get('ads-operations-sync-prod'), buildRequired: false }),
  ]);
  const [devVersion, prodVersion, syncVersion, syncSchedules] = await Promise.all([
    cf('GET', `/workers/scripts/ads-operations-web-dev/versions/${encodeURIComponent(dev.versionId)}`),
    cf('GET', `/workers/scripts/ads-operations-web-prod/versions/${encodeURIComponent(prod.versionId)}`),
    cf('GET', `/workers/scripts/ads-operations-sync-prod/versions/${encodeURIComponent(sync.versionId)}`),
    cf('GET', '/workers/scripts/ads-operations-sync-prod/schedules'),
  ]);
  const prodEnv = plainBindings(prodVersion?.result);
  const syncEnv = plainBindings(syncVersion?.result);
  const schedules = Array.isArray(syncSchedules?.result?.schedules) ? syncSchedules.result.schedules : Array.isArray(syncSchedules?.result) ? syncSchedules.result : null;
  if (!schedules) throw new Error('FINAL_CLOSURE_SYNC_SCHEDULES_INVALID');
  const hardOff = {
    syncTriggerEnabled: booleanBinding(prodEnv.SYNC_TRIGGER_ENABLED, 'SYNC_TRIGGER_ENABLED'),
    amazonAdsEnabled: booleanBinding(syncEnv.AMAZON_ADS_ENABLED, 'AMAZON_ADS_ENABLED'),
    phase5SingleRunPermitId: bindingText(prodEnv.PHASE5_SINGLE_RUN_PERMIT_ID, 'PHASE5_SINGLE_RUN_PERMIT_ID'),
    phase5SingleRunReportDate: bindingText(prodEnv.PHASE5_SINGLE_RUN_REPORT_DATE, 'PHASE5_SINGLE_RUN_REPORT_DATE'),
    schedules,
  };

  const devD1 = d1Bindings(devVersion?.result);
  const prodD1 = d1Bindings(prodVersion?.result);
  const devControlId = requiredText(devD1.CONTROL_DB, 'FINAL_CLOSURE_DEV_CONTROL_DB_REQUIRED');
  const devStoreId = requiredText(devD1.STORE_01_DB, 'FINAL_CLOSURE_DEV_STORE_DB_REQUIRED');
  const prodControlId = requiredText(prodD1.CONTROL_DB, 'FINAL_CLOSURE_PROD_CONTROL_DB_REQUIRED');
  const prodStoreIds = {
    Store01: requiredText(prodD1.STORE_01_DB, 'FINAL_CLOSURE_STORE01_DB_REQUIRED'),
    Store02: requiredText(prodD1.STORE_02_DB, 'FINAL_CLOSURE_STORE02_DB_REQUIRED'),
    Store03: requiredText(prodD1.STORE_03_DB, 'FINAL_CLOSURE_STORE03_DB_REQUIRED'),
    Store04: requiredText(prodD1.STORE_04_DB, 'FINAL_CLOSURE_STORE04_DB_REQUIRED'),
  };
  const migrationSql = 'SELECT name FROM d1_migrations ORDER BY id; PRAGMA foreign_key_check;';
  const [devControl, devStore, prodControl] = await Promise.all([
    d1Query(cf, devControlId, migrationSql),
    d1Query(cf, devStoreId, migrationSql),
    d1Query(cf, prodControlId, migrationSql),
  ]);
  const migrations = {
    devControl: rows(devControl, 0).map((row) => row.name),
    devControlFkViolations: rows(devControl, 1).length,
    devStore: rows(devStore, 0).map((row) => row.name),
    devStoreFkViolations: rows(devStore, 1).length,
    prodControl: rows(prodControl, 0).map((row) => row.name),
    prodControlFkViolations: rows(prodControl, 1).length,
    prodStores: [],
  };
  const stores = [];
  for (const storeId of ['Store01', 'Store02', 'Store03', 'Store04']) {
    const databaseId = prodStoreIds[storeId];
    const result = await d1Query(cf, databaseId, `SELECT name FROM d1_migrations ORDER BY id; PRAGMA foreign_key_check; SELECT b.import_id,b.content_sha256,b.content_bytes,b.row_count,b.accepted_rows,b.report_start_date,b.report_end_date,b.marketplace,b.currency_code,a.data_class,a.provenance_class,a.authority_version,s.object_key,s.r2_version,s.r2_etag FROM csv_import_batches b JOIN csv_import_authority a ON a.import_id=b.import_id JOIN csv_import_source_objects s ON s.import_id=b.import_id WHERE b.status='published' AND a.data_class='business' ORDER BY b.created_at DESC LIMIT 2; SELECT COUNT(*) AS fact_rows FROM csv_search_term_daily; SELECT COUNT(*) AS action_count FROM optimization_actions;`);
    migrations.prodStores.push({ storeId, names: rows(result, 0).map((row) => row.name), fkViolations: rows(result, 1).length });
    const imports = rows(result, 2);
    const source = imports[0] || {};
    stores.push({
      storeId,
      databaseId,
      businessImportCount: imports.length,
      importId: source.import_id,
      contentSha256: source.content_sha256,
      contentBytes: Number(source.content_bytes),
      rowCount: Number(source.row_count),
      acceptedRows: Number(source.accepted_rows),
      rangeStart: source.report_start_date,
      rangeEnd: source.report_end_date,
      marketplace: source.marketplace,
      currencyCode: source.currency_code,
      dataClass: source.data_class,
      provenanceClass: source.provenance_class,
      authorityVersion: Number(source.authority_version),
      objectKey: source.object_key,
      r2Version: source.r2_version,
      r2Etag: source.r2_etag,
      factRows: Number(rows(result, 3)[0]?.fact_rows),
      optimizationActionCount: Number(rows(result, 4)[0]?.action_count),
    });
  }

  const [accessApp, accessPolicies, serviceTokens, bucket] = await Promise.all([
    cf('GET', `/access/apps/${EXPECTED.accessAppId}`),
    cf('GET', `/access/apps/${EXPECTED.accessAppId}/policies?per_page=100`),
    cf('GET', '/access/service_tokens?per_page=100'),
    cf('GET', `/r2/buckets/${EXPECTED.r2Bucket}`),
  ]);
  const policies = Array.isArray(accessPolicies?.result) ? accessPolicies.result : [];
  const serviceTokenList = Array.isArray(serviceTokens?.result) ? serviceTokens.result : [];
  const access = {
    appStatus: accessApp?._httpStatus,
    policyStatus: accessPolicies?._httpStatus,
    serviceTokenStatus: serviceTokens?._httpStatus,
    nonIdentityPolicyCount: policies.filter((policy) => policy?.decision === 'non_identity').length,
    serviceTokenCount: serviceTokenList.length,
  };

  let verifiedObjectCount = 0;
  for (const store of stores) {
    if (!store.objectKey) continue;
    const listed = await cf('GET', `/r2/buckets/${EXPECTED.r2Bucket}/objects?prefix=${encodeURIComponent(store.objectKey)}&per_page=10`);
    const objects = Array.isArray(listed?.result) ? listed.result : [];
    const exact = objects.find((object) => object?.key === store.objectKey);
    const expectedEtag = String(store.r2Etag || '').replaceAll('"', '');
    if (exact && Number(exact.size) === store.contentBytes && String(exact.etag || '') === expectedEtag) verifiedObjectCount += 1;
  }
  const r2 = { bucketName: bucket?.result?.name, location: bucket?.result?.location, verifiedObjectCount };

  const releaseTrace = {
    development: await verifyExactArtifact({ gh, owner, name, artifactName: `cloudflare-release-trace-development-${mainSha}`, expectedWorkflow: 'Cloudflare Release Trace' }),
    production: await verifyExactArtifact({ gh, owner, name, artifactName: `cloudflare-release-trace-production-${mainSha}`, expectedWorkflow: 'Cloudflare Release Trace' }),
  };
  const acceptance = await verifyLatestAcceptanceArtifact({ gh, owner, name });

  return buildFinalClosureEvidence({ generatedAt: new Date().toISOString(), mainSha, ci, dev, prod, sync, hardOff, migrations, stores, access, r2, releaseTrace, acceptance });
}

async function collectRuntime({ cf, workerName, workerTag, buildRequired = true }) {
  const dep = await cf('GET', `/workers/scripts/${encodeURIComponent(workerName)}/deployments`);
  const active = Array.isArray(dep?.result?.deployments) ? dep.result.deployments[0] : null;
  const versions = Array.isArray(active?.versions) ? active.versions : [];
  if (!active || versions.length !== 1) throw new Error(`FINAL_CLOSURE_RUNTIME_DEPLOYMENT_INVALID:${workerName}`);
  const versionId = requiredText(versions[0]?.version_id, `FINAL_CLOSURE_VERSION_REQUIRED:${workerName}`);
  const traffic = Number(versions[0]?.percentage);
  const runtime = { workerName, workerTag: requiredText(workerTag, `FINAL_CLOSURE_WORKER_TAG_REQUIRED:${workerName}`), deploymentId: requiredText(active.id, `FINAL_CLOSURE_DEPLOYMENT_REQUIRED:${workerName}`), versionId, traffic };
  if (!buildRequired) return runtime;
  const builds = await cf('GET', `/builds/builds?version_ids=${encodeURIComponent(versionId)}`);
  const build = builds?.result?.builds?.[versionId];
  if (!build) throw new Error(`FINAL_CLOSURE_BUILD_REQUIRED:${workerName}`);
  return { ...runtime, buildUuid: requiredText(build.build_uuid, `FINAL_CLOSURE_BUILD_UUID_REQUIRED:${workerName}`), buildOutcome: String(build.build_outcome || ''), sourceCommit: requireSha(build?.build_trigger_metadata?.commit_hash, `FINAL_CLOSURE_SOURCE_SHA_INVALID:${workerName}`), buildTriggerUuid: String(build?.trigger?.trigger_uuid || '') };
}

async function d1Query(cf, databaseId, sql) {
  const body = await cf('POST', `/d1/database/${databaseId}/query`, { sql });
  if (!Array.isArray(body?.result)) throw new Error(`FINAL_CLOSURE_D1_RESULT_INVALID:${databaseId}`);
  return body.result;
}
function rows(result, index) { return Array.isArray(result?.[index]?.results) ? result[index].results : []; }

async function verifyExactArtifact({ gh, owner, name, artifactName, expectedWorkflow }) {
  const artifacts = await findArtifacts({ gh, owner, name, predicate: (artifact) => artifact?.name === artifactName, maxPages: 10 });
  for (const artifact of artifacts) {
    const runId = artifact?.workflow_run?.id;
    if (!runId) continue;
    const run = await gh(`/repos/${owner}/${name}/actions/runs/${runId}`);
    if (run?.conclusion === 'success' && run?.name === expectedWorkflow) return { verified: true, artifact: artifact.name, artifactId: artifact.id, runId, headSha: run.head_sha, conclusion: run.conclusion };
  }
  return { verified: false, artifact: artifactName };
}

async function verifyLatestAcceptanceArtifact({ gh, owner, name }) {
  const artifacts = await findArtifacts({ gh, owner, name, predicate: (artifact) => String(artifact?.name || '').startsWith('live-human-review-service-auth-acceptance-'), maxPages: 10 });
  artifacts.sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));
  for (const artifact of artifacts) {
    const runId = artifact?.workflow_run?.id;
    if (!runId) continue;
    const run = await gh(`/repos/${owner}/${name}/actions/runs/${runId}`);
    if (run?.conclusion === 'success' && run?.event === 'workflow_dispatch' && run?.head_branch === EXPECTED.acceptanceBranch && String(run?.head_sha || '').toLowerCase() === EXPECTED.acceptanceHeadSha) {
      return { verified: true, artifact: artifact.name, artifactId: artifact.id, runId, headSha: String(run.head_sha).toLowerCase(), conclusion: run.conclusion };
    }
  }
  return { verified: false, artifact: null, runId: null, headSha: null };
}

async function findArtifacts({ gh, owner, name, predicate, maxPages }) {
  const found = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const body = await gh(`/repos/${owner}/${name}/actions/artifacts?per_page=100&page=${page}`);
    const artifacts = Array.isArray(body?.artifacts) ? body.artifacts : [];
    found.push(...artifacts.filter(predicate));
    if (artifacts.length < 100) break;
  }
  return found;
}

async function githubGet({ fetchImpl, githubToken, path }) {
  const response = await fetchImpl(`https://api.github.com${path}`, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${githubToken}`, 'x-github-api-version': '2022-11-28' } });
  if (!response.ok) throw new Error(`FINAL_CLOSURE_GITHUB_GET_FAILED:${response.status}:${path}`);
  return response.json();
}

async function cloudflareJson({ fetchImpl, accountId, cfToken, method, path, body }) {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}${path}`, { method, headers: { accept: 'application/json', authorization: `Bearer ${cfToken}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let payload;
  try { payload = await response.json(); } catch { throw new Error(`FINAL_CLOSURE_CLOUDFLARE_JSON_INVALID:${response.status}:${path}`); }
  if (!response.ok || payload?.success !== true) throw new Error(`FINAL_CLOSURE_CLOUDFLARE_REQUEST_FAILED:${response.status}:${path}`);
  return { ...payload, _httpStatus: response.status };
}

function d1Bindings(version) {
  const out = {};
  for (const list of [version?.resources?.bindings, version?.bindings]) if (Array.isArray(list)) for (const binding of list) if (binding?.type === 'd1' && binding?.name && binding?.id) out[binding.name] = String(binding.id);
  return out;
}
function plainBindings(version) {
  const out = {};
  if (version?.env && typeof version.env === 'object') for (const [name, binding] of Object.entries(version.env)) if (binding?.type === 'plain_text') out[name] = String(binding.text ?? '');
  for (const list of [version?.resources?.bindings, version?.bindings]) if (Array.isArray(list)) for (const binding of list) if (binding?.type === 'plain_text' && binding?.name) out[binding.name] = String(binding.text ?? '');
  return out;
}
function booleanBinding(value, key) { if (value === 'false' || value === false) return false; if (value === 'true' || value === true) return true; throw new Error(`FINAL_CLOSURE_BINDING_INVALID:${key}`); }
function bindingText(value, key) { if (typeof value !== 'string') throw new Error(`FINAL_CLOSURE_BINDING_MISSING:${key}`); return value; }
function requireSha(value, code) { const text = String(value ?? '').trim().toLowerCase(); if (!SHA40.test(text)) throw new Error(code); return text; }
function requiredText(value, code) { const text = String(value ?? '').trim(); if (!text) throw new Error(code); return text; }
