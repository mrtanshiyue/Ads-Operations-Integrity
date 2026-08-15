import assert from 'node:assert/strict';
import { persistCanonicalProfileReceipt } from '../cloudflare/runtime/amazon-profile-producer.js';

const store = { marketplace_code: 'US', amazon_region: 'NA' };
const profiles = [{
  profileId: 'profile-1',
  countryCode: 'US',
  currencyCode: 'USD',
  timezone: 'America/Los_Angeles',
  accountInfo: { marketplaceStringId: 'ATVPDKIKX0DER', type: 'seller', name: 'Seller Account' },
}];

class FakeRepository {
  constructor(run, { raceTo = null } = {}) {
    this.run = { ...run };
    this.raceTo = raceTo;
    this.upserts = 0;
    this.assignCalls = 0;
  }
  async loadRun() { return { ...this.run }; }
  async upsertCanonicalProfile(profile, syncedAt) {
    this.upserts += 1;
    this.profile = { ...profile, syncedAt };
  }
  async assignProfileToQueuedRun(runId, profileId, startedAt) {
    this.assignCalls += 1;
    if (this.raceTo) {
      this.run = { ...this.run, ...this.raceTo };
      return false;
    }
    if (this.run.run_id === runId && this.run.status === 'queued' && this.run.profile_id == null) {
      this.run.profile_id = profileId;
      this.run.status = 'running';
      this.run.started_at ||= startedAt;
      return true;
    }
    return false;
  }
}

{
  const repository = new FakeRepository({ run_id: 'run-1', status: 'queued', profile_id: null });
  const result = await persistCanonicalProfileReceipt({
    repository, runId: 'run-1', store, amazonProfiles: profiles, syncedAt: '2026-08-15T11:20:00Z',
  });
  assert.equal(result.reused, false);
  assert.equal(result.run.status, 'running');
  assert.equal(result.run.profile_id, 'profile-1');
  assert.equal(repository.upserts, 1);
  assert.equal(repository.assignCalls, 1);
  assert.equal(repository.profile.accountType, 'seller');
}

{
  const repository = new FakeRepository({ run_id: 'run-1', status: 'running', profile_id: 'profile-1' });
  const result = await persistCanonicalProfileReceipt({
    repository, runId: 'run-1', store, amazonProfiles: profiles, syncedAt: 'ignored',
  });
  assert.equal(result.reused, true);
  assert.equal(repository.upserts, 0);
  assert.equal(repository.assignCalls, 0);
}

{
  const repository = new FakeRepository(
    { run_id: 'run-1', status: 'queued', profile_id: null },
    { raceTo: { status: 'running', profile_id: 'profile-1' } },
  );
  const result = await persistCanonicalProfileReceipt({
    repository, runId: 'run-1', store, amazonProfiles: profiles, syncedAt: '2026-08-15T11:20:00Z',
  });
  assert.equal(result.reused, true);
  assert.equal(repository.upserts, 1);
  assert.equal(repository.assignCalls, 1);
}

{
  const repository = new FakeRepository(
    { run_id: 'run-1', status: 'queued', profile_id: null },
    { raceTo: { status: 'running', profile_id: 'profile-other' } },
  );
  try {
    await persistCanonicalProfileReceipt({
      repository, runId: 'run-1', store, amazonProfiles: profiles, syncedAt: '2026-08-15T11:20:00Z',
    });
    assert.fail('conflicting canonical profile race accepted');
  } catch (error) {
    assert.equal(error.code, 'CANONICAL_PROFILE_RECEIPT_CONFLICT');
  }
}

{
  const repository = new FakeRepository(
    { run_id: 'run-1', status: 'queued', profile_id: null },
    { raceTo: { status: 'queued', profile_id: null } },
  );
  try {
    await persistCanonicalProfileReceipt({
      repository, runId: 'run-1', store, amazonProfiles: profiles, syncedAt: '2026-08-15T11:20:00Z',
    });
    assert.fail('missing assignment receipt accepted');
  } catch (error) {
    assert.equal(error.code, 'CANONICAL_PROFILE_ASSIGNMENT_RECEIPT_MISSING');
  }
}

console.log(JSON.stringify({
  ok: true,
  canonicalProfileWriteOnce: true,
  runningReceiptReused: true,
  sameProfileRaceRecovered: true,
  conflictingProfileRaceFailsClosed: true,
}, null, 2));
