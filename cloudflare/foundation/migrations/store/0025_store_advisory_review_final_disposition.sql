-- Human Review Final Disposition v1.
-- Extends the advisory-review-only state machine with approved / rejected.
-- These states are review dispositions only: they do not authorize Optimization Action
-- approval, execution, Amazon mutation, sync, or recommendation/rule adaptation.

BEGIN TRANSACTION;

DROP TRIGGER trg_advisory_review_binding_immutable;
DROP TRIGGER trg_advisory_review_no_delete;

ALTER TABLE advisory_review_records RENAME TO advisory_review_records_legacy_0025;

CREATE TABLE advisory_review_records (
  review_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (
    length(source_kind) BETWEEN 1 AND 64
    AND source_kind NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  recommendation_fingerprint TEXT NOT NULL CHECK (
    length(recommendation_fingerprint) = 64
    AND recommendation_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  entity_type TEXT NOT NULL CHECK (entity_type = 'search_term'),
  entity_id TEXT NOT NULL,
  recommendation_family TEXT NOT NULL,
  recommendation_action_type TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open'
    CHECK (state IN ('open','acknowledged','dismissed','snoozed','approved','rejected')),
  reviewer_user_id TEXT,
  reviewer_note TEXT,
  reviewed_at TEXT,
  snoozed_until TEXT,
  source_evidence_json TEXT NOT NULL CHECK (json_valid(source_evidence_json)),
  source_evidence_sha256 TEXT NOT NULL CHECK (
    length(source_evidence_sha256) = 64
    AND source_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (state = 'snoozed' AND snoozed_until IS NOT NULL)
    OR (state <> 'snoozed' AND snoozed_until IS NULL)
  )
);

INSERT INTO advisory_review_records(
  review_id, source_kind, recommendation_fingerprint, entity_type, entity_id,
  recommendation_family, recommendation_action_type, state,
  reviewer_user_id, reviewer_note, reviewed_at, snoozed_until,
  source_evidence_json, source_evidence_sha256,
  created_by, created_at, updated_at
)
SELECT
  review_id, source_kind, recommendation_fingerprint, entity_type, entity_id,
  recommendation_family, recommendation_action_type, state,
  reviewer_user_id, reviewer_note, reviewed_at, snoozed_until,
  source_evidence_json, source_evidence_sha256,
  created_by, created_at, updated_at
FROM advisory_review_records_legacy_0025;

DROP TABLE advisory_review_records_legacy_0025;

CREATE UNIQUE INDEX uq_advisory_review_source_recommendation
ON advisory_review_records(source_kind, recommendation_fingerprint);

CREATE INDEX idx_advisory_review_state_updated
ON advisory_review_records(source_kind, state, updated_at DESC);

CREATE INDEX idx_advisory_review_entity
ON advisory_review_records(entity_type, entity_id, updated_at DESC);

CREATE TRIGGER trg_advisory_review_binding_immutable
BEFORE UPDATE ON advisory_review_records
WHEN OLD.source_kind IS NOT NEW.source_kind
  OR OLD.recommendation_fingerprint IS NOT NEW.recommendation_fingerprint
  OR OLD.entity_type IS NOT NEW.entity_type
  OR OLD.entity_id IS NOT NEW.entity_id
  OR OLD.recommendation_family IS NOT NEW.recommendation_family
  OR OLD.recommendation_action_type IS NOT NEW.recommendation_action_type
  OR OLD.source_evidence_json IS NOT NEW.source_evidence_json
  OR OLD.source_evidence_sha256 IS NOT NEW.source_evidence_sha256
  OR OLD.created_by IS NOT NEW.created_by
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'ADVISORY_REVIEW_BINDING_IMMUTABLE');
END;

CREATE TRIGGER trg_advisory_review_no_delete
BEFORE DELETE ON advisory_review_records
BEGIN
  SELECT RAISE(ABORT, 'ADVISORY_REVIEW_DELETE_FORBIDDEN');
END;

COMMIT;

PRAGMA optimize;
