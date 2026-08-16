import { resolveCanonicalProfile } from './amazon-profile-contract.js';
import { canonicalProfileReceiptDecision } from './amazon-producer-state.js';

export class ProfileProducerError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProfileProducerError';
    this.code = code;
  }
}

export async function persistCanonicalProfileReceipt({ repository, runId, store, amazonProfiles, syncedAt }) {
  const profile = resolveCanonicalProfile(store, amazonProfiles);
  let run = await repository.loadRun(runId);
  if (!run) throw new ProfileProducerError('SYNC_RUN_RECEIPT_MISSING');

  if (run.status === 'running') {
    const decision = canonicalProfileReceiptDecision(run, profile.profileId);
    if (decision !== 'REUSE_PROFILE_RECEIPT') throw new ProfileProducerError('CANONICAL_PROFILE_RECEIPT_INVALID');
    return { reused: true, profile, run };
  }
  if (run.status !== 'queued' || run.profile_id != null) {
    canonicalProfileReceiptDecision(run, profile.profileId);
    throw new ProfileProducerError('CANONICAL_PROFILE_ASSIGNMENT_STATE_INVALID');
  }

  // The profile mirror row is independently idempotent source data and must exist before the FK assignment.
  await repository.upsertCanonicalProfile(profile, requiredText(syncedAt, 'PROFILE_SYNCED_AT_REQUIRED'));
  const assigned = await repository.assignProfileToQueuedRun(runId, profile.profileId, syncedAt);
  run = await repository.loadRun(runId);

  if (run?.status === 'running') {
    const decision = canonicalProfileReceiptDecision(run, profile.profileId);
    if (decision !== 'REUSE_PROFILE_RECEIPT') throw new ProfileProducerError('CANONICAL_PROFILE_RECEIPT_INVALID');
    return { reused: !assigned, profile, run };
  }
  if (!assigned && run?.status === 'queued' && run?.profile_id == null) {
    throw new ProfileProducerError('CANONICAL_PROFILE_ASSIGNMENT_RECEIPT_MISSING');
  }
  canonicalProfileReceiptDecision(run, profile.profileId);
  throw new ProfileProducerError('CANONICAL_PROFILE_ASSIGNMENT_RECEIPT_INVALID');
}

export function createD1ProfileProducerRepository(db) {
  return {
    async loadRun(runId) {
      return db.prepare(`
        SELECT run_id, profile_id, trigger_type, status, requested_by, intent_fingerprint,
               started_at, completed_at, created_at
        FROM sync_runs
        WHERE run_id = ?1
        LIMIT 1
      `).bind(runId).first();
    },

    async loadCanonicalProfile(profileId) {
      return db.prepare(`
        SELECT profile_id, marketplace_id, country_code, currency_code, timezone,
               account_name, account_type, status, source_updated_at, synced_at
        FROM amazon_profiles
        WHERE profile_id = ?1
        LIMIT 1
      `).bind(profileId).first();
    },

    async upsertCanonicalProfile(profile, syncedAt) {
      await db.prepare(`
        INSERT INTO amazon_profiles(
          profile_id, marketplace_id, country_code, currency_code, timezone,
          account_name, account_type, status, source_updated_at, synced_at
        ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', NULL, ?8)
        ON CONFLICT(profile_id) DO UPDATE SET
          marketplace_id = excluded.marketplace_id,
          country_code = excluded.country_code,
          currency_code = excluded.currency_code,
          timezone = excluded.timezone,
          account_name = excluded.account_name,
          account_type = excluded.account_type,
          status = 'active',
          synced_at = excluded.synced_at
      `).bind(
        profile.profileId,
        profile.marketplaceId,
        profile.countryCode,
        profile.currencyCode,
        profile.timezone,
        profile.accountName,
        profile.accountType,
        syncedAt,
      ).run();
    },

    async assignProfileToQueuedRun(runId, profileId, startedAt) {
      const result = await db.prepare(`
        UPDATE sync_runs
        SET profile_id = ?2,
            status = 'running',
            started_at = COALESCE(started_at, ?3)
        WHERE run_id = ?1
          AND status = 'queued'
          AND profile_id IS NULL
      `).bind(runId, profileId, startedAt).run();
      return Number(result?.meta?.changes || 0) === 1;
    },
  };
}

function requiredText(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new ProfileProducerError(code);
  return text;
}
