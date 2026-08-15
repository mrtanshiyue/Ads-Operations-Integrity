import { assertProducerIntentSupported } from './sync-producer-capability.js';
import { hydrateCanonicalProfileReceipt } from './amazon-profile-contract.js';
import { persistCanonicalProfileReceipt } from './amazon-profile-producer.js';
import { canonicalizeEntitySnapshot } from './amazon-entity-contract.js';
import {
  inspectEntityMirrorReceipt,
  stageEntityMirrorSnapshot,
  publishDurableEntityMirrorStage,
} from './amazon-entity-mirror-producer.js';
import { planReportJobs, reserveReportJob } from './amazon-report-producer.js';

export class ProducerBootstrapError extends Error {
  constructor(code, cause = null) {
    super(code);
    this.name = 'ProducerBootstrapError';
    this.code = code;
    this.cause = cause;
  }
}

export async function prepareProducerBootstrap({ execution, store, repositories, adapters, now }) {
  assertProducerIntentSupported(execution?.intent);
  const timestamp = requiredText(now, 'PRODUCER_BOOTSTRAP_TIMESTAMP_REQUIRED');
  const profile = await resolveOrReuseCanonicalProfile({
    execution,
    store,
    repository: repositories?.profile,
    listProfiles: adapters?.listProfiles,
    now: timestamp,
  });

  const entity = await ensureEntityMirror({
    execution,
    store,
    profile,
    repository: repositories?.entity,
    fetchEntitySnapshot: adapters?.fetchEntitySnapshot,
    now: timestamp,
  });

  const reports = await reserveProducerReportJobs({
    execution,
    profile,
    repository: repositories?.report,
  });

  return Object.freeze({
    profile,
    entityReceipt: entity.receipt,
    reportJobs: Object.freeze(reports),
  });
}

export async function resolveOrReuseCanonicalProfile({ execution, store, repository, listProfiles, now }) {
  requireRepository(repository, ['loadRun', 'loadCanonicalProfile'], 'PROFILE_REPOSITORY_INVALID');
  const stage = String(execution?.profileStage || '');
  const runId = requiredText(execution?.instanceId, 'WORKFLOW_INSTANCE_ID_REQUIRED');

  if (stage === 'REUSE_CANONICAL_PROFILE') {
    const profileId = requiredText(execution?.run?.profile_id, 'CANONICAL_PROFILE_RECEIPT_MISSING');
    const row = await repository.loadCanonicalProfile(profileId);
    return hydrateCanonicalProfileReceipt(store, row, profileId);
  }

  if (stage !== 'RESOLVE_CANONICAL_PROFILE') {
    throw new ProducerBootstrapError('PRODUCER_PROFILE_STAGE_INVALID');
  }
  if (typeof listProfiles !== 'function') throw new ProducerBootstrapError('AMAZON_PROFILE_ADAPTER_REQUIRED');
  requireRepository(repository, ['upsertCanonicalProfile', 'assignProfileToQueuedRun'], 'PROFILE_REPOSITORY_INVALID');

  const amazonProfiles = await listProfiles(Object.freeze({
    storeId: execution.intent.storeId,
    marketplaceCode: store?.marketplace_code,
    amazonRegion: store?.amazon_region,
  }));
  const result = await persistCanonicalProfileReceipt({
    repository,
    runId,
    store,
    amazonProfiles,
    syncedAt: now,
  });
  return result.profile;
}

export async function ensureEntityMirror({ execution, store, profile, repository, fetchEntitySnapshot, now }) {
  requireRepository(repository, ['loadRun', 'loadReceipt', 'loadStageReceipt', 'loadStageSummary', 'publishStage'], 'ENTITY_REPOSITORY_INVALID');
  const runId = requiredText(execution?.instanceId, 'WORKFLOW_INSTANCE_ID_REQUIRED');
  const profileId = requiredText(profile?.profileId, 'PROFILE_ID_REQUIRED');
  const run = await repository.loadRun(runId);
  const finalReceipt = await repository.loadReceipt(runId);
  const stageReceipt = await repository.loadStageReceipt(runId);
  const decision = inspectEntityMirrorReceipt({ run, finalReceipt, stageReceipt, profileId });

  if (decision === 'REUSE_ENTITY_MIRROR_RECEIPT') {
    if (!finalReceipt.published_at) throw new ProducerBootstrapError('ENTITY_MIRROR_FINAL_RECEIPT_INCOMPLETE');
    return { reused: true, receipt: finalReceipt };
  }

  if (decision === 'REUSE_ENTITY_STAGE_RECEIPT') {
    return publishDurableEntityMirrorStage({ repository, runId, profileId, publishedAt: now });
  }

  if (typeof fetchEntitySnapshot !== 'function') throw new ProducerBootstrapError('AMAZON_ENTITY_ADAPTER_REQUIRED');
  requireRepository(repository, ['replaceStageAndPersistReceipt'], 'ENTITY_REPOSITORY_INVALID');
  const source = await fetchEntitySnapshot(Object.freeze({
    storeId: execution.intent.storeId,
    storeCode: store?.store_code,
    profile,
  }));
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new ProducerBootstrapError('AMAZON_ENTITY_SNAPSHOT_INVALID');
  }

  const snapshot = await canonicalizeEntitySnapshot({
    profileId,
    syncedAt: now,
    campaigns: source.campaigns,
    adGroups: source.adGroups,
    keywords: source.keywords,
    targets: source.targets,
  });
  await stageEntityMirrorSnapshot({ repository, runId, snapshot, stagedAt: now });
  return publishDurableEntityMirrorStage({ repository, runId, profileId, publishedAt: now });
}

export async function reserveProducerReportJobs({ execution, profile, repository }) {
  requireRepository(repository, ['insertQueued', 'loadByIdempotencyKey'], 'REPORT_REPOSITORY_INVALID');
  const plans = await planReportJobs({
    workflowInstanceId: execution?.instanceId,
    intent: execution?.intent,
    profile,
  });
  const receipts = [];
  for (const plan of plans) receipts.push(await reserveReportJob(repository, plan));
  return receipts;
}

function requireRepository(repository, methods, code) {
  if (!repository || methods.some((method) => typeof repository[method] !== 'function')) {
    throw new ProducerBootstrapError(code);
  }
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new ProducerBootstrapError(code);
  return text;
}
