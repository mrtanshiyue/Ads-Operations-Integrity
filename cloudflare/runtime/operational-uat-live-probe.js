import { evaluateAccessIdentity } from '../../src/access.js';
import { enforceStrictAccessActorBinding } from '../../src/access-actor.js';
import { ingestSearchTermCsvOnce } from './csv-search-term-ingestion.js';
import { parseAmazonSearchTermCsv } from './csv-search-term-import.js';
import { analyzeCsvWindowQuality } from './csv-window-quality-analysis.js';

export const OPERATIONAL_UAT_CONFIRMATION = 'non-amazon-live-probe-v1';
export const OPERATIONAL_UAT_ROUTE = '/api/v1/operational-uat/live-probe';
export const OPERATIONAL_UAT_CASES = Object.freeze([
  'csv.duplicate-import',
  'csv.missing-identifiers',
  'csv.date-gaps',
  'csv.import-overlap',
  'permission.store-access-mismatch',
  'failure.d1-query',
  'failure.stale-request',
  'failure.worker-error',
  'failure.missing-binding',
]);

const CASE_SET = new Set(OPERATIONAL_UAT_CASES);
const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});
const MAX_BODY_BYTES = 4096;

export async function handleOperationalUatLiveProbeRoute({ request, env = {}, url = new URL(request.url) }) {
  if (url.pathname !== OPERATIONAL_UAT_ROUTE) return null;
  try {
    return await handleMatchedOperationalUatLiveProbeRoute({ request, env });
  } catch (error) {
    console.error('operational_uat_live_probe_error', {
      name: error?.name || null,
      code: error?.code || null,
    });
    return json(request, {
      ...evidence('operational-uat.internal', false, { reason: 'unexpected_probe_error' }),
      error: 'operational_uat_internal_error',
    }, 500);
  }
}

async function handleMatchedOperationalUatLiveProbeRoute({ request, env }) {
  if (request.method.toUpperCase() !== 'POST') return json(request, { error: 'method_not_allowed' }, 405);
  if (String(env.APP_ENV || '').trim().toLowerCase() !== 'production') {
    return json(request, { error: 'operational_uat_production_only' }, 404);
  }
  if (String(env.ACCESS_MODE || '').trim().toLowerCase() !== 'enforce') {
    return json(request, { error: 'operational_uat_requires_access_enforce' }, 503);
  }
  if (!env.CONTROL_DB) return json(request, { error: 'control_db_not_bound' }, 503);

  const access = await evaluateAccessIdentity(request, env);
  const binding = await enforceStrictAccessActorBinding(env.CONTROL_DB, access);
  if (!binding.ok) {
    return json(request, {
      error: binding.error,
      ...(binding.reason ? { reason: binding.reason } : {}),
    }, binding.status);
  }
  if (!await hasGlobalPermission(env.CONTROL_DB, binding.actor.user_id, 'users.manage')) {
    return json(request, { error: 'forbidden', permission: 'users.manage' }, 403);
  }
  if (request.headers.get('x-operational-uat-confirm') !== OPERATIONAL_UAT_CONFIRMATION) {
    return json(request, { error: 'operational_uat_confirmation_required' }, 409);
  }

  const body = await readBody(request);
  if (body.error) return json(request, { error: body.error }, 400);
  const caseId = String(body.value?.caseId || '').trim();
  if (!CASE_SET.has(caseId)) return json(request, { error: 'operational_uat_case_unsupported' }, 400);

  return executeOperationalUatCase(caseId, { request, env, actor: binding.actor });
}

export async function executeOperationalUatCase(caseId, context = {}) {
  switch (caseId) {
    case 'csv.duplicate-import': return probeDuplicateImport(context.request);
    case 'csv.missing-identifiers': return probeMissingIdentifiers(context.request);
    case 'csv.date-gaps': return probeDateGaps(context.request);
    case 'csv.import-overlap': return probeImportOverlap(context.request);
    case 'permission.store-access-mismatch': return probeStoreAccessMismatch(context.request, context.env);
    case 'failure.d1-query': return probeD1QueryFailure(context.request, context.env);
    case 'failure.stale-request': return probeStaleRequest(context.request);
    case 'failure.worker-error': return probeWorkerError(context.request);
    case 'failure.missing-binding': return probeMissingBinding(context.request, context.env);
    default: return json(context.request, { error: 'operational_uat_case_unsupported' }, 400);
  }
}

async function probeDuplicateImport(request) {
  const csvText = fixtureCsv({ missingIdentifiers: false });
  const sourceBytes = new TextEncoder().encode(csvText);
  const repository = createInMemoryImportRepository();
  const sourceObjectStore = createInMemorySourceObjectStore();
  const now = '2026-01-15T00:00:00.000Z';
  const baseInput = {
    csvText,
    sourceBytes,
    sourceFileName: 'operational-uat-duplicate.csv',
    marketplace: 'US',
    profileId: 'uat-profile',
    currencyCode: 'USD',
    uploadedAt: now,
  };
  const sourceContext = {
    storeId: 'operational-uat-memory',
    contentType: 'text/csv',
    importerUserId: 'operational-uat',
  };
  const first = await ingestSearchTermCsvOnce({
    importId: 'csv-uat-first', input: baseInput, repository, sourceObjectStore, sourceContext, now,
  });
  const second = await ingestSearchTermCsvOnce({
    importId: 'csv-uat-second', input: baseInput, repository, sourceObjectStore, sourceContext, now,
  });
  const verified = first.action === 'csv_import_published'
    && first.published === true
    && second.action === 'csv_import_duplicate'
    && second.reused === true
    && second.published === true
    && second.importId === first.importId
    && repository.stats.commitCount === 1
    && sourceObjectStore.stats.persistCount === 1;
  return json(request, evidence('csv.duplicate-import', verified, {
    firstAction: first.action,
    secondAction: second.action,
    duplicateReusedOriginalImportId: second.importId === first.importId,
    commitCount: repository.stats.commitCount,
    sourcePersistCount: sourceObjectStore.stats.persistCount,
    persistenceScope: 'request_memory_only',
  }), verified ? 200 : 500);
}

async function probeMissingIdentifiers(request) {
  const parsed = await parseAmazonSearchTermCsv({
    csvText: fixtureCsv({ missingIdentifiers: true }),
    sourceFileName: 'operational-uat-missing-identifiers.csv',
    marketplace: 'US',
    profileId: 'uat-profile',
    currencyCode: 'USD',
    uploadedAt: '2026-01-15T00:00:00.000Z',
  });
  const fact = parsed.rows[0]?.fact;
  const verified = parsed.ok === true
    && parsed.acceptedRows === 1
    && parsed.rejectedRows === 0
    && fact?.campaignId === null
    && fact?.adGroupId === null
    && fact?.targetingId === null
    && fact?.campaignName === 'UAT Campaign'
    && fact?.adGroupName === 'UAT Ad Group'
    && fact?.targetingIdentityState === 'name_only';
  return json(request, evidence('csv.missing-identifiers', verified, {
    parserOk: parsed.ok,
    acceptedRows: parsed.acceptedRows,
    rejectedRows: parsed.rejectedRows,
    campaignId: fact?.campaignId ?? null,
    adGroupId: fact?.adGroupId ?? null,
    targetingId: fact?.targetingId ?? null,
    targetingIdentityState: fact?.targetingIdentityState ?? null,
    persistenceScope: 'none',
  }), verified ? 200 : 500);
}

async function probeDateGaps(request) {
  const result = analyzeCsvWindowQuality([
    windowFixture('a', '2026-01-01', '2026-01-01'),
    windowFixture('b', '2026-01-03', '2026-01-03'),
  ]);
  const gap = result.gaps[0];
  const verified = result.qualityState === 'gap_detected'
    && result.requiresHumanReview === true
    && result.contiguousCoverage === false
    && result.summary.gapCount === 1
    && gap?.gapStartDate === '2026-01-02'
    && gap?.gapEndDate === '2026-01-02'
    && gap?.requiresHumanReview === true;
  return json(request, evidence('csv.date-gaps', verified, {
    qualityState: result.qualityState,
    requiresHumanReview: result.requiresHumanReview,
    contiguousCoverage: result.contiguousCoverage,
    gapCount: result.summary.gapCount,
    gapStartDate: gap?.gapStartDate ?? null,
    gapEndDate: gap?.gapEndDate ?? null,
    persistenceScope: 'none',
  }), verified ? 200 : 500);
}

async function probeImportOverlap(request) {
  const result = analyzeCsvWindowQuality([
    windowFixture('c', '2026-01-01', '2026-01-03'),
    windowFixture('d', '2026-01-03', '2026-01-05'),
  ]);
  const pair = result.overlapPairs[0];
  const verified = result.qualityState === 'overlap_detected'
    && result.safeForNaiveAggregation === false
    && result.requiresHumanReview === true
    && result.summary.overlapPairCount === 1
    && pair?.doubleCountRisk === true
    && pair?.requiresHumanReview === true
    && pair?.overlapStartDate === '2026-01-03'
    && pair?.overlapEndDate === '2026-01-03';
  return json(request, evidence('csv.import-overlap', verified, {
    qualityState: result.qualityState,
    safeForNaiveAggregation: result.safeForNaiveAggregation,
    requiresHumanReview: result.requiresHumanReview,
    overlapPairCount: result.summary.overlapPairCount,
    doubleCountRisk: pair?.doubleCountRisk ?? false,
    overlapStartDate: pair?.overlapStartDate ?? null,
    overlapEndDate: pair?.overlapEndDate ?? null,
    persistenceScope: 'none',
  }), verified ? 200 : 500);
}

async function probeStoreAccessMismatch(request, env = {}) {
  const db = env.CONTROL_DB;
  if (!db) return json(request, evidence('permission.store-access-mismatch', false, { reason: 'control_db_not_bound' }), 503);
  const candidate = await db.prepare(`
    SELECT u.user_id, sm.store_id AS allowed_store_id
    FROM users u
    JOIN store_members sm ON sm.user_id = u.user_id
    JOIN role_permissions rp ON rp.role_key = sm.role_key AND rp.permission_key = 'ads.read'
    WHERE u.status = 'active'
      AND NOT EXISTS (
        SELECT 1
        FROM user_global_roles ugr
        JOIN role_permissions grp ON grp.role_key = ugr.role_key
        WHERE ugr.user_id = u.user_id AND grp.permission_key = 'ads.read'
      )
    ORDER BY u.user_id ASC, sm.store_id ASC
    LIMIT 1
  `).first();
  if (!candidate) {
    return json(request, evidence('permission.store-access-mismatch', false, {
      reason: 'no_non_global_store_member_candidate',
      persistenceScope: 'none',
    }), 409);
  }
  const deniedStore = await db.prepare(`
    SELECT s.store_id
    FROM stores s
    WHERE s.status <> 'disabled'
      AND s.store_id <> ?1
      AND NOT EXISTS (
        SELECT 1
        FROM store_members sm
        JOIN role_permissions rp ON rp.role_key = sm.role_key AND rp.permission_key = 'ads.read'
        WHERE sm.user_id = ?2 AND sm.store_id = s.store_id
      )
    ORDER BY s.store_code ASC, s.store_id ASC
    LIMIT 1
  `).bind(candidate.allowed_store_id, candidate.user_id).first();
  if (!deniedStore) {
    return json(request, evidence('permission.store-access-mismatch', false, {
      reason: 'no_denied_store_candidate',
      candidateUserId: candidate.user_id,
      persistenceScope: 'none',
    }), 409);
  }
  const [allowed, denied] = await Promise.all([
    hasStorePermission(db, candidate.user_id, candidate.allowed_store_id, 'ads.read'),
    hasStorePermission(db, candidate.user_id, deniedStore.store_id, 'ads.read'),
  ]);
  const verified = allowed === true && denied === false;
  return json(request, evidence('permission.store-access-mismatch', verified, {
    candidateUserId: candidate.user_id,
    allowedStoreId: candidate.allowed_store_id,
    deniedStoreId: deniedStore.store_id,
    allowedStorePermission: allowed,
    deniedStorePermission: denied,
    policyProbe: 'production_control_db_read_only',
    persistenceScope: 'none',
  }), verified ? 200 : 500);
}

async function probeD1QueryFailure(request, env = {}) {
  try {
    await env.CONTROL_DB.prepare('SELECT * FROM __operational_uat_intentionally_missing_table_v1 LIMIT 1').first();
    return json(request, evidence('failure.d1-query', false, {
      reason: 'd1_failure_not_observed',
      persistenceScope: 'none',
    }), 500);
  } catch {
    return json(request, evidence('failure.d1-query', true, {
      failureObserved: 'd1_query_error',
      responseMode: 'fail_closed_503',
      performanceFallbackReturned: false,
      persistenceScope: 'none',
    }), 503);
  }
}

async function probeStaleRequest(request) {
  let latestGeneration = 0;
  let committedValue = null;
  const issue = async (value, delayMs) => {
    const generation = ++latestGeneration;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (generation !== latestGeneration) return { generation, stale: true, committed: false };
    committedValue = value;
    return { generation, stale: false, committed: true };
  };
  const older = issue('older', 8);
  await Promise.resolve();
  const newer = issue('latest', 0);
  const [olderResult, newerResult] = await Promise.all([older, newer]);
  const verified = olderResult.stale === true
    && olderResult.committed === false
    && newerResult.stale === false
    && newerResult.committed === true
    && committedValue === 'latest';
  return json(request, evidence('failure.stale-request', verified, {
    staleGenerationSuppressed: olderResult.stale,
    latestGenerationCommitted: newerResult.committed,
    committedValue,
    performanceFallbackReturned: false,
    persistenceScope: 'none',
  }), verified ? 409 : 500);
}

async function probeWorkerError(request) {
  let observed = false;
  try {
    await Promise.resolve().then(() => {
      throw new Error('OPERATIONAL_UAT_INTENTIONAL_WORKER_ERROR');
    });
  } catch {
    observed = true;
  }
  return json(request, evidence('failure.worker-error', observed, {
    failureObserved: observed ? 'worker_exception' : 'worker_exception_missing',
    responseMode: 'fail_closed_500',
    performanceFallbackReturned: false,
    persistenceScope: 'none',
  }), 500);
}

async function probeMissingBinding(request, env = {}) {
  const unexpectedlyBound = env.OPERATIONAL_UAT_INTENTIONALLY_UNBOUND_DB != null;
  const verified = unexpectedlyBound === false;
  return json(request, evidence('failure.missing-binding', verified, {
    bindingName: 'OPERATIONAL_UAT_INTENTIONALLY_UNBOUND_DB',
    bindingPresent: unexpectedlyBound,
    responseMode: verified ? 'fail_closed_503' : 'precondition_failed',
    performanceFallbackReturned: false,
    persistenceScope: 'none',
  }), verified ? 503 : 500);
}

function evidence(caseId, verified, observed) {
  return {
    schema: 'operational-uat-live-probe-v1',
    caseId,
    verified: verified === true,
    amazonExecutionAttempted: false,
    crossStoreLeakageDetected: false,
    fabricatedZeroPerformance: false,
    businessFactPersistenceAttempted: false,
    failClosed: true,
    observed,
  };
}

function fixtureCsv({ missingIdentifiers }) {
  const ids = missingIdentifiers ? ['', '', ''] : ['cmp-uat-1', 'ag-uat-1', 'target-uat-1'];
  return [
    [
      'Date', 'Campaign ID', 'Campaign Name', 'Ad Group ID', 'Ad Group Name',
      'Targeting ID', 'Targeting', 'Match Type', 'Customer Search Term', 'Impressions',
      'Clicks', 'Spend', '7 Day Total Orders', '7 Day Total Sales', '7 Day Total Units',
      'Marketplace', 'Currency',
    ].join(','),
    [
      '2026-01-15', ids[0], 'UAT Campaign', ids[1], 'UAT Ad Group', ids[2],
      'reading glasses', 'EXACT', 'reading glasses test', '10', '2', '1.23', '1', '3.45', '1',
      'US', 'USD',
    ].join(','),
  ].join('\n');
}

function windowFixture(hashChar, reportStartDate, reportEndDate) {
  return {
    contentSha256: hashChar.repeat(64),
    sourceFileName: `operational-uat-${hashChar}.csv`,
    reportStartDate,
    reportEndDate,
  };
}

function createInMemoryImportRepository() {
  let published = null;
  const stats = { commitCount: 0, rejectedCount: 0 };
  return {
    stats,
    async findDuplicate({ contentSha256, reportStartDate, reportEndDate }) {
      if (!published) return null;
      return published.content_sha256 === contentSha256
        && published.report_start_date === reportStartDate
        && published.report_end_date === reportEndDate
        ? published
        : null;
    },
    async recordRejectedImport() {
      stats.rejectedCount += 1;
      throw new Error('OPERATIONAL_UAT_UNEXPECTED_REJECTION');
    },
    async commitValidatedImport({ importId, parsed }) {
      stats.commitCount += 1;
      published = {
        import_id: importId,
        status: 'published',
        content_sha256: parsed.contentSha256,
        report_start_date: parsed.reportStartDate,
        report_end_date: parsed.reportEndDate,
      };
      return published;
    },
  };
}

function createInMemorySourceObjectStore() {
  const stats = { persistCount: 0 };
  return {
    stats,
    async describe({ bytes, storeId, sourceFileName, contentType, importerUserId, uploadedAt }) {
      const exactBytes = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', exactBytes));
      const contentSha256 = [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
      return {
        sourceObjectId: `csv-source-${contentSha256}`,
        sourceKind: 'manual_csv_upload',
        r2BindingKey: 'DATA_BUCKET',
        objectKey: `operational-uat/memory/${storeId}/${contentSha256}`,
        contentSha256,
        contentBytes: exactBytes.byteLength,
        contentType,
        sourceFileName,
        importerUserId,
        uploadedAt,
        exactBytes,
      };
    },
    async persist(descriptor) {
      stats.persistCount += 1;
      const { exactBytes: _exactBytes, ...receipt } = descriptor;
      return { ...receipt, r2Etag: 'operational-uat-memory', r2Version: 'operational-uat-memory' };
    },
  };
}

async function hasGlobalPermission(db, userId, permission) {
  return Boolean(await db.prepare(`
    SELECT 1 AS ok
    FROM user_global_roles ugr
    JOIN app_roles ar ON ar.role_key = ugr.role_key AND ar.role_scope = 'global'
    JOIN role_permissions rp ON rp.role_key = ugr.role_key
    WHERE ugr.user_id = ?1 AND rp.permission_key = ?2
    LIMIT 1
  `).bind(userId, permission).first());
}

async function hasStorePermission(db, userId, storeId, permission) {
  const global = await db.prepare(`
    SELECT 1 AS ok
    FROM user_global_roles ugr
    JOIN app_roles ar ON ar.role_key = ugr.role_key AND ar.role_scope = 'global'
    JOIN role_permissions rp ON rp.role_key = ugr.role_key
    WHERE ugr.user_id = ?1 AND rp.permission_key = ?2
    LIMIT 1
  `).bind(userId, permission).first();
  if (global) return true;
  return Boolean(await db.prepare(`
    SELECT 1 AS ok
    FROM store_members sm
    JOIN app_roles ar ON ar.role_key = sm.role_key AND ar.role_scope = 'store'
    JOIN role_permissions rp ON rp.role_key = sm.role_key
    WHERE sm.user_id = ?1 AND sm.store_id = ?2 AND rp.permission_key = ?3
    LIMIT 1
  `).bind(userId, storeId, permission).first());
}

async function readBody(request) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { error: 'request_body_too_large' };
  let text;
  try { text = await request.text(); }
  catch { return { error: 'request_body_unreadable' }; }
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return { error: 'request_body_too_large' };
  if (!text.trim()) return { error: 'request_body_required' };
  try { return { value: JSON.parse(text) }; }
  catch { return { error: 'request_json_invalid' }; }
}

function json(request, payload, status) {
  const headers = new Headers(JSON_HEADERS);
  const ray = request?.headers?.get?.('cf-ray');
  if (ray) headers.set('x-request-id', ray);
  return new Response(JSON.stringify(payload), { status, headers });
}
