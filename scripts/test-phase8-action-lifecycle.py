#!/usr/bin/env python3
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STORE_MIGRATIONS = ROOT / "cloudflare" / "foundation" / "migrations" / "store"

conn = sqlite3.connect(":memory:")
conn.row_factory = sqlite3.Row
conn.execute("PRAGMA foreign_keys = ON")
for name in ["0001_store_entities.sql", "0002_store_facts.sql", "0003_store_actions_views.sql"]:
    conn.executescript((STORE_MIGRATIONS / name).read_text(encoding="utf-8"))

conn.execute(
    """
    INSERT INTO amazon_profiles(profile_id, marketplace_id, country_code, currency_code, timezone, account_name, account_type, status)
    VALUES(?,?,?,?,?,?,?,'active')
    """,
    ("profile-phase8", "ATVPDKIKX0DER", "US", "USD", "America/Los_Angeles", "Phase 8 Fixture", "seller"),
)

fingerprint = "f" * 64
request_fingerprint = "e" * 64
rationale = json.dumps({
    "recommendation": {"code": "spend_without_orders"},
    "governance": {
        "schemaVersion": "optimization-action-governance-v1",
        "recommendationFingerprint": fingerprint,
        "requestFingerprint": request_fingerprint,
        "authority": {"authoritative": False, "mode": "development_preview", "amazonMutationAuthorized": False},
        "freshness": {"state": "aging", "confidenceFactor": 0.8},
        "executionAuthorized": False,
    },
})

conn.execute(
    """
    INSERT INTO optimization_actions(
      action_id, idempotency_key, profile_id, entity_type, entity_id, action_type,
      source_type, rule_key, before_json, proposed_json, rationale_json, status, created_by
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'proposed',?)
    """,
    (
        "act-phase8-01", fingerprint, "profile-phase8", "search_term", "row-phase8-01",
        "negative_keyword.create", "rule", "search-term-rules-v1",
        json.dumps({"negativeKeywordExists": False}),
        json.dumps({"keywordText": "reading glasses", "matchType": "EXACT"}),
        rationale,
        "operator-phase8",
    ),
)
conn.execute(
    "INSERT INTO optimization_action_events(event_id, action_id, event_type, actor_id, details_json) VALUES(?,?,?,?,?)",
    ("evt-proposed", "act-phase8-01", "action.proposed", "operator-phase8", json.dumps({"amazonMutationAttempted": False})),
)

row = conn.execute("SELECT status, approved_by, external_request_id FROM optimization_actions WHERE action_id=?", ("act-phase8-01",)).fetchone()
assert row["status"] == "proposed"
assert row["approved_by"] is None
assert row["external_request_id"] is None

try:
    conn.execute(
        """
        INSERT INTO optimization_actions(
          action_id, idempotency_key, profile_id, entity_type, entity_id, action_type,
          proposed_json, status
        ) VALUES(?,?,?,?,?,?,?,'proposed')
        """,
        ("act-phase8-duplicate", fingerprint, "profile-phase8", "search_term", "row-phase8-01", "negative_keyword.create", "{}"),
    )
    raise AssertionError("duplicate idempotency key unexpectedly accepted")
except sqlite3.IntegrityError:
    pass

reject = conn.execute(
    "UPDATE optimization_actions SET status='rejected', updated_at=CURRENT_TIMESTAMP WHERE action_id=? AND status='proposed'",
    ("act-phase8-01",),
)
assert reject.rowcount == 1
conn.execute(
    "INSERT INTO optimization_action_events(event_id, action_id, event_type, actor_id, details_json) VALUES(?,?,?,?,?)",
    ("evt-rejected", "act-phase8-01", "action.rejected", "operator-phase8", json.dumps({"reason": "fixture rejection", "amazonMutationAttempted": False})),
)

second_reject = conn.execute(
    "UPDATE optimization_actions SET status='rejected' WHERE action_id=? AND status='proposed'",
    ("act-phase8-01",),
)
assert second_reject.rowcount == 0
approve_after_reject = conn.execute(
    "UPDATE optimization_actions SET status='approved', approved_by=? WHERE action_id=? AND status='proposed'",
    ("operator-phase8", "act-phase8-01"),
)
assert approve_after_reject.rowcount == 0

row = conn.execute("SELECT status, approved_by, external_request_id, applied_at FROM optimization_actions WHERE action_id=?", ("act-phase8-01",)).fetchone()
assert row["status"] == "rejected"
assert row["approved_by"] is None
assert row["external_request_id"] is None
assert row["applied_at"] is None

events = conn.execute(
    "SELECT event_type, details_json FROM optimization_action_events WHERE action_id=? ORDER BY occurred_at, event_id",
    ("act-phase8-01",),
).fetchall()
assert {event["event_type"] for event in events} == {"action.proposed", "action.rejected"}
assert all(json.loads(event["details_json"])["amazonMutationAttempted"] is False for event in events)

conn.execute(
    """
    INSERT INTO optimization_actions(
      action_id, idempotency_key, profile_id, entity_type, entity_id, action_type,
      proposed_json, status, created_by
    ) VALUES(?,?,?,?,?,?,?,'proposed',?)
    """,
    ("act-phase8-02", "a" * 64, "profile-phase8", "search_term", "row-phase8-02", "keyword.create", "{}", "operator-phase8"),
)
approve = conn.execute(
    "UPDATE optimization_actions SET status='approved', approved_by=?, updated_at=CURRENT_TIMESTAMP WHERE action_id=? AND status='proposed'",
    ("operator-phase8", "act-phase8-02"),
)
assert approve.rowcount == 1
row = conn.execute("SELECT status, approved_by, external_request_id, applied_at FROM optimization_actions WHERE action_id=?", ("act-phase8-02",)).fetchone()
assert row["status"] == "approved"
assert row["approved_by"] == "operator-phase8"
assert row["external_request_id"] is None
assert row["applied_at"] is None

print(json.dumps({
    "ok": True,
    "contract": "phase8-store-d1-action-lifecycle-v1",
    "proposed": True,
    "idempotencyUnique": True,
    "rejectConditional": True,
    "approveRejectRaceClosed": True,
    "approvalStopsBeforeExecution": True,
    "amazonMutation": False,
}, indent=2))
