PRAGMA foreign_keys = ON;

-- Phase 11 execution safety plane. These tables do not authorize Amazon Ads mutation.
-- They provide durable single-use permit, transport receipt, and read-back verification evidence.

CREATE TABLE optimization_execution_permits (
  permit_id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  transition TEXT NOT NULL CHECK (transition IN ('apply','revert')),
  profile_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK (action_type IN ('negative_keyword.create','keyword.create')),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  target_fingerprint TEXT NOT NULL CHECK (length(target_fingerprint) = 64),
  execution_fingerprint TEXT NOT NULL CHECK (length(execution_fingerprint) = 64),
  state TEXT NOT NULL DEFAULT 'issued' CHECK (state IN ('issued','consumed','expired','revoked')),
  issued_by TEXT NOT NULL,
  issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  revoke_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (action_id) REFERENCES optimization_actions(action_id) ON DELETE RESTRICT,
  CHECK (
    (state = 'consumed' AND consumed_at IS NOT NULL AND consumed_by IS NOT NULL)
    OR (state <> 'consumed' AND consumed_at IS NULL AND consumed_by IS NULL)
  ),
  CHECK (
    (state = 'revoked' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
    OR (state <> 'revoked' AND revoked_at IS NULL AND revoked_by IS NULL)
  )
);

CREATE UNIQUE INDEX idx_execution_permits_one_issued_per_action_transition
  ON optimization_execution_permits(action_id, transition)
  WHERE state = 'issued';

CREATE INDEX idx_execution_permits_state_expiry
  ON optimization_execution_permits(state, expires_at);

CREATE INDEX idx_execution_permits_action
  ON optimization_execution_permits(action_id, issued_at DESC);

CREATE TRIGGER optimization_execution_permits_binding_immutable
BEFORE UPDATE ON optimization_execution_permits
WHEN NEW.action_id <> OLD.action_id
  OR NEW.transition <> OLD.transition
  OR NEW.profile_id <> OLD.profile_id
  OR NEW.entity_type <> OLD.entity_type
  OR NEW.entity_id <> OLD.entity_id
  OR NEW.action_type <> OLD.action_type
  OR NEW.request_fingerprint <> OLD.request_fingerprint
  OR NEW.target_fingerprint <> OLD.target_fingerprint
  OR NEW.execution_fingerprint <> OLD.execution_fingerprint
  OR NEW.issued_by <> OLD.issued_by
  OR NEW.issued_at <> OLD.issued_at
  OR NEW.expires_at <> OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'execution_permit_binding_immutable');
END;

CREATE TRIGGER optimization_execution_permits_no_delete
BEFORE DELETE ON optimization_execution_permits
BEGIN
  SELECT RAISE(ABORT, 'execution_permit_delete_forbidden');
END;

CREATE TABLE optimization_execution_receipts (
  receipt_id TEXT PRIMARY KEY,
  permit_id TEXT NOT NULL UNIQUE,
  action_id TEXT NOT NULL,
  transition TEXT NOT NULL CHECK (transition IN ('apply','revert')),
  execution_fingerprint TEXT NOT NULL CHECK (length(execution_fingerprint) = 64),
  request_body_sha256 TEXT NOT NULL CHECK (length(request_body_sha256) = 64),
  amazon_request_id TEXT,
  http_status INTEGER CHECK (http_status IS NULL OR (http_status >= 100 AND http_status <= 599)),
  transport_outcome TEXT NOT NULL CHECK (transport_outcome IN ('accepted','rejected','unknown')),
  retry_disposition TEXT NOT NULL CHECK (retry_disposition IN ('not_retryable','retry_before_dispatch','readback_required')),
  response_body_sha256 TEXT CHECK (response_body_sha256 IS NULL OR length(response_body_sha256) = 64),
  response_metadata_json TEXT,
  dispatched_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (permit_id) REFERENCES optimization_execution_permits(permit_id) ON DELETE RESTRICT,
  FOREIGN KEY (action_id) REFERENCES optimization_actions(action_id) ON DELETE RESTRICT
);

CREATE INDEX idx_execution_receipts_action
  ON optimization_execution_receipts(action_id, created_at DESC);

CREATE INDEX idx_execution_receipts_amazon_request
  ON optimization_execution_receipts(amazon_request_id)
  WHERE amazon_request_id IS NOT NULL;

CREATE TRIGGER optimization_execution_receipts_immutable_update
BEFORE UPDATE ON optimization_execution_receipts
BEGIN
  SELECT RAISE(ABORT, 'execution_receipt_immutable');
END;

CREATE TRIGGER optimization_execution_receipts_immutable_delete
BEFORE DELETE ON optimization_execution_receipts
BEGIN
  SELECT RAISE(ABORT, 'execution_receipt_immutable');
END;

CREATE TABLE optimization_execution_verifications (
  verification_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  verification_type TEXT NOT NULL DEFAULT 'amazon_readback' CHECK (verification_type = 'amazon_readback'),
  expected_fingerprint TEXT NOT NULL CHECK (length(expected_fingerprint) = 64),
  observed_fingerprint TEXT CHECK (observed_fingerprint IS NULL OR length(observed_fingerprint) = 64),
  result TEXT NOT NULL CHECK (result IN ('confirmed','mismatch','not_found','unknown')),
  details_json TEXT,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (receipt_id) REFERENCES optimization_execution_receipts(receipt_id) ON DELETE RESTRICT,
  FOREIGN KEY (action_id) REFERENCES optimization_actions(action_id) ON DELETE RESTRICT
);

CREATE INDEX idx_execution_verifications_receipt
  ON optimization_execution_verifications(receipt_id, observed_at DESC);

CREATE INDEX idx_execution_verifications_action
  ON optimization_execution_verifications(action_id, observed_at DESC);

CREATE TRIGGER optimization_execution_verifications_immutable_update
BEFORE UPDATE ON optimization_execution_verifications
BEGIN
  SELECT RAISE(ABORT, 'execution_verification_immutable');
END;

CREATE TRIGGER optimization_execution_verifications_immutable_delete
BEFORE DELETE ON optimization_execution_verifications
BEGIN
  SELECT RAISE(ABORT, 'execution_verification_immutable');
END;
