import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationDir = path.join(repoRoot, 'cloudflare', 'foundation', 'migrations', 'store');
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON');

for (const name of ['0001_store_entities.sql', '0002_store_facts.sql', '0003_store_actions_views.sql']) {
  db.exec(await readFile(path.join(migrationDir, name), 'utf8'));
}

db.prepare(`
  INSERT INTO amazon_profiles(
    profile_id, marketplace_id, country_code, currency_code, timezone, account_name, account_type, status
  ) VALUES(?,?,?,?,?,?,?,'active')
`).run('profile-phase8', 'ATVPDKIKX0DER', 'US', 'USD', 'America/Los_Angeles', 'Phase 8 Fixture', 'seller');

const fingerprint = 'f'.repeat(64);
const requestFingerprint = 'e'.repeat(64);
const rationale = JSON.stringify({
  recommendation: { code: 'spend_without_orders' },
  governance: {
    schemaVersion: 'optimization-action-governance-v1',
    recommendationFingerprint: fingerprint,
    requestFingerprint,
    authority: { authoritative: false, mode: 'development_preview', amazonMutationAuthorized: false },
    freshness: { state: 'aging', confidenceFactor: 0.8 },
    executionAuthorized: false,
  },
});

db.prepare(`
  INSERT INTO optimization_actions(
    action_id, idempotency_key, profile_id, entity_type, entity_id, action_type,
    source_type, rule_key, before_json, proposed_json, rationale_json, status, created_by
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'proposed',?)
`).run(
  'act-phase8-01', fingerprint, 'profile-phase8', 'search_term', 'row-phase8-01',
  'negative_keyword.create', 'rule', 'search-term-rules-v1',
  JSON.stringify({ negativeKeywordExists: false }),
  JSON.stringify({ keywordText: 'reading glasses', matchType: 'EXACT' }),
  rationale,
  'operator-phase8',
);

db.prepare(`
  INSERT INTO optimization_action_events(event_id, action_id, event_type, actor_id, details_json)
  VALUES(?,?,?,?,?)
`).run('evt-proposed', 'act-phase8-01', 'action.proposed', 'operator-phase8', JSON.stringify({ amazonMutationAttempted: false }));

let row = db.prepare(`
  SELECT status, approved_by, external_request_id
  FROM optimization_actions WHERE action_id=?
`).get('act-phase8-01');
assert.equal(row.status, 'proposed');
assert.equal(row.approved_by, null);
assert.equal(row.external_request_id, null);

let duplicateRejected = false;
try {
  db.prepare(`
    INSERT INTO optimization_actions(
      action_id, idempotency_key, profile_id, entity_type, entity_id, action_type,
      proposed_json, status
    ) VALUES(?,?,?,?,?,?,?,'proposed')
  `).run('act-phase8-duplicate', fingerprint, 'profile-phase8', 'search_term', 'row-phase8-01', 'negative_keyword.create', '{}');
} catch {
  duplicateRejected = true;
}
assert.equal(duplicateRejected, true, 'duplicate idempotency key unexpectedly accepted');

const reject = db.prepare(`
  UPDATE optimization_actions
  SET status='rejected', updated_at=CURRENT_TIMESTAMP
  WHERE action_id=? AND status='proposed'
`).run('act-phase8-01');
assert.equal(Number(reject.changes), 1);

db.prepare(`
  INSERT INTO optimization_action_events(event_id, action_id, event_type, actor_id, details_json)
  VALUES(?,?,?,?,?)
`).run('evt-rejected', 'act-phase8-01', 'action.rejected', 'operator-phase8', JSON.stringify({
  reason: 'fixture rejection',
  amazonMutationAttempted: false,
}));

const secondReject = db.prepare(`
  UPDATE optimization_actions SET status='rejected'
  WHERE action_id=? AND status='proposed'
`).run('act-phase8-01');
assert.equal(Number(secondReject.changes), 0);

const approveAfterReject = db.prepare(`
  UPDATE optimization_actions SET status='approved', approved_by=?
  WHERE action_id=? AND status='proposed'
`).run('operator-phase8', 'act-phase8-01');
assert.equal(Number(approveAfterReject.changes), 0);

row = db.prepare(`
  SELECT status, approved_by, external_request_id, applied_at
  FROM optimization_actions WHERE action_id=?
`).get('act-phase8-01');
assert.equal(row.status, 'rejected');
assert.equal(row.approved_by, null);
assert.equal(row.external_request_id, null);
assert.equal(row.applied_at, null);

const events = db.prepare(`
  SELECT event_type, details_json
  FROM optimization_action_events
  WHERE action_id=?
  ORDER BY occurred_at, event_id
`).all('act-phase8-01');
assert.deepEqual(new Set(events.map((event) => event.event_type)), new Set(['action.proposed', 'action.rejected']));
assert.equal(events.every((event) => JSON.parse(event.details_json).amazonMutationAttempted === false), true);

db.prepare(`
  INSERT INTO optimization_actions(
    action_id, idempotency_key, profile_id, entity_type, entity_id, action_type,
    proposed_json, status, created_by
  ) VALUES(?,?,?,?,?,?,?,'proposed',?)
`).run('act-phase8-02', 'a'.repeat(64), 'profile-phase8', 'search_term', 'row-phase8-02', 'keyword.create', '{}', 'operator-phase8');

const approve = db.prepare(`
  UPDATE optimization_actions
  SET status='approved', approved_by=?, updated_at=CURRENT_TIMESTAMP
  WHERE action_id=? AND status='proposed'
`).run('operator-phase8', 'act-phase8-02');
assert.equal(Number(approve.changes), 1);

row = db.prepare(`
  SELECT status, approved_by, external_request_id, applied_at
  FROM optimization_actions WHERE action_id=?
`).get('act-phase8-02');
assert.equal(row.status, 'approved');
assert.equal(row.approved_by, 'operator-phase8');
assert.equal(row.external_request_id, null);
assert.equal(row.applied_at, null);

db.close();

console.log(JSON.stringify({
  ok: true,
  contract: 'phase8-store-d1-action-lifecycle-v1',
  sqliteRuntime: 'node:sqlite',
  proposed: true,
  idempotencyUnique: true,
  rejectConditional: true,
  approveRejectRaceClosed: true,
  approvalStopsBeforeExecution: true,
  amazonMutation: false,
}, null, 2));
