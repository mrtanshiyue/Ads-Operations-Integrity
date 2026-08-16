-- Ads Operations Integrity - Control D1
-- Migration 0006: audited break-glass recovery for an existing active owner's
-- Cloudflare Access subject binding. This never creates or changes a global role.

PRAGMA foreign_keys = ON;

CREATE TABLE access_recovery_events (
  recovery_id TEXT PRIMARY KEY,
  target_user_id TEXT NOT NULL,
  expected_email_norm TEXT NOT NULL,
  expected_previous_cf_access_sub TEXT,
  new_cf_access_sub TEXT NOT NULL,
  operator_identity TEXT NOT NULL,
  reason TEXT NOT NULL,
  ticket TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (length(trim(recovery_id)) BETWEEN 16 AND 160),
  CHECK (length(trim(expected_email_norm)) BETWEEN 3 AND 320),
  CHECK (length(trim(new_cf_access_sub)) BETWEEN 1 AND 255),
  CHECK (new_cf_access_sub IS NOT expected_previous_cf_access_sub),
  CHECK (length(trim(operator_identity)) BETWEEN 3 AND 200),
  CHECK (length(trim(reason)) BETWEEN 12 AND 1000),
  CHECK (length(trim(ticket)) BETWEEN 3 AND 160),
  FOREIGN KEY (target_user_id) REFERENCES users(user_id) ON DELETE RESTRICT
);

CREATE INDEX idx_access_recovery_target_time
  ON access_recovery_events(target_user_id, occurred_at DESC);

CREATE TRIGGER trg_access_recovery_target_guard
BEFORE INSERT ON access_recovery_events
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM users u
  JOIN user_global_roles ugr
    ON ugr.user_id=u.user_id
   AND ugr.role_key='owner'
  JOIN app_roles ar
    ON ar.role_key=ugr.role_key
   AND ar.role_scope='global'
  WHERE u.user_id=NEW.target_user_id
    AND u.status='active'
    AND u.email_norm=lower(trim(NEW.expected_email_norm))
    AND u.cf_access_sub IS NEW.expected_previous_cf_access_sub
)
BEGIN
  SELECT RAISE(ABORT, 'break_glass_target_state_mismatch');
END;

CREATE TRIGGER trg_access_recovery_new_subject_guard
BEFORE INSERT ON access_recovery_events
FOR EACH ROW
WHEN EXISTS (
  SELECT 1
  FROM users other_user
  WHERE other_user.user_id<>NEW.target_user_id
    AND other_user.cf_access_sub=NEW.new_cf_access_sub
)
BEGIN
  SELECT RAISE(ABORT, 'break_glass_new_subject_conflict');
END;

-- Existing bound owners may only change to a different non-null subject through the
-- append-only recovery ledger. First-bind from NULL remains available to the normal
-- Cloudflare Access binding path.
CREATE TRIGGER trg_owner_access_subject_rebind_guard
BEFORE UPDATE OF cf_access_sub ON users
FOR EACH ROW
WHEN OLD.cf_access_sub IS NOT NULL
 AND NEW.cf_access_sub IS NOT OLD.cf_access_sub
 AND EXISTS (
   SELECT 1 FROM user_global_roles ugr
   WHERE ugr.user_id=OLD.user_id AND ugr.role_key='owner'
 )
 AND NOT EXISTS (
   SELECT 1
   FROM access_recovery_events recovery
   WHERE recovery.target_user_id=OLD.user_id
     AND recovery.expected_previous_cf_access_sub IS OLD.cf_access_sub
     AND recovery.new_cf_access_sub IS NEW.cf_access_sub
 )
BEGIN
  SELECT RAISE(ABORT, 'owner_access_subject_rebind_requires_recovery_event');
END;

CREATE TRIGGER trg_access_recovery_apply
AFTER INSERT ON access_recovery_events
FOR EACH ROW
BEGIN
  UPDATE users
  SET cf_access_sub=NEW.new_cf_access_sub,
      updated_at=CURRENT_TIMESTAMP
  WHERE user_id=NEW.target_user_id
    AND status='active'
    AND email_norm=lower(trim(NEW.expected_email_norm))
    AND cf_access_sub IS NEW.expected_previous_cf_access_sub
    AND EXISTS (
      SELECT 1 FROM user_global_roles ugr
      WHERE ugr.user_id=users.user_id AND ugr.role_key='owner'
    );

  INSERT INTO audit_log(
    event_id, actor_user_id, store_id, action, entity_type, entity_id,
    request_id, cf_ray, details_json
  ) VALUES (
    NEW.recovery_id,
    NULL,
    NULL,
    'security.break_glass.access_subject_rebind',
    'user',
    NEW.target_user_id,
    NEW.recovery_id,
    NULL,
    json_object(
      'recoveryId', NEW.recovery_id,
      'targetUserId', NEW.target_user_id,
      'expectedEmailNorm', NEW.expected_email_norm,
      'previousCfAccessSub', NEW.expected_previous_cf_access_sub,
      'newCfAccessSub', NEW.new_cf_access_sub,
      'operatorIdentity', NEW.operator_identity,
      'reason', NEW.reason,
      'ticket', NEW.ticket,
      'controlPlane', 'break-glass-cli',
      'globalRoleChanged', json('false')
    )
  );
END;

CREATE TRIGGER trg_access_recovery_immutable_update
BEFORE UPDATE ON access_recovery_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'access_recovery_ledger_immutable');
END;

CREATE TRIGGER trg_access_recovery_immutable_delete
BEFORE DELETE ON access_recovery_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'access_recovery_ledger_immutable');
END;

PRAGMA optimize;
