-- Ads Operations Integrity - Control D1
-- Migration 0005: security-integrity invariants for global/store roles and owner governance.
-- Append-only defense-in-depth. Existing invalid state causes migration failure rather than silent repair.

PRAGMA foreign_keys = ON;

CREATE TABLE __security_integrity_guard (
  invalid_count INTEGER NOT NULL CHECK (invalid_count = 0)
);

INSERT INTO __security_integrity_guard(invalid_count)
SELECT
  (SELECT COUNT(*) FROM (
    SELECT user_id
    FROM user_global_roles
    GROUP BY user_id
    HAVING COUNT(*) > 1
  ))
  +
  (SELECT COUNT(*)
   FROM user_global_roles ugr
   LEFT JOIN app_roles ar ON ar.role_key = ugr.role_key
   WHERE ar.role_scope IS NULL OR ar.role_scope <> 'global')
  +
  (SELECT COUNT(*)
   FROM store_members sm
   LEFT JOIN app_roles ar ON ar.role_key = sm.role_key
   WHERE ar.role_scope IS NULL OR ar.role_scope <> 'store')
  +
  (SELECT COUNT(*)
   FROM user_global_roles ugr
   JOIN users u ON u.user_id = ugr.user_id
   WHERE u.status <> 'active')
  +
  (SELECT COUNT(*)
   FROM user_global_roles ugr
   WHERE EXISTS (
     SELECT 1 FROM store_members sm WHERE sm.user_id = ugr.user_id
   ));

DROP TABLE __security_integrity_guard;

-- A user may hold at most one global role. The original composite PK remains historical schema;
-- this unique index closes the owner+admin dual-role gap without rebuilding the table.
CREATE UNIQUE INDEX ux_user_global_roles_single_role
  ON user_global_roles(user_id);

CREATE TRIGGER trg_user_global_roles_scope_insert
BEFORE INSERT ON user_global_roles
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM app_roles ar
  WHERE ar.role_key = NEW.role_key AND ar.role_scope = 'global'
)
BEGIN
  SELECT RAISE(ABORT, 'user_global_roles_requires_global_role');
END;

CREATE TRIGGER trg_user_global_roles_scope_update
BEFORE UPDATE OF role_key ON user_global_roles
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM app_roles ar
  WHERE ar.role_key = NEW.role_key AND ar.role_scope = 'global'
)
BEGIN
  SELECT RAISE(ABORT, 'user_global_roles_requires_global_role');
END;

CREATE TRIGGER trg_store_members_scope_insert
BEFORE INSERT ON store_members
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM app_roles ar
  WHERE ar.role_key = NEW.role_key AND ar.role_scope = 'store'
)
BEGIN
  SELECT RAISE(ABORT, 'store_members_requires_store_role');
END;

CREATE TRIGGER trg_store_members_scope_update
BEFORE UPDATE OF role_key ON store_members
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM app_roles ar
  WHERE ar.role_key = NEW.role_key AND ar.role_scope = 'store'
)
BEGIN
  SELECT RAISE(ABORT, 'store_members_requires_store_role');
END;

-- Bootstrap may seed an Access-unbound owner before first-bind, so binding is intentionally
-- not a DB invariant. Active lifecycle and scope/exclusivity remain DB invariants.
CREATE TRIGGER trg_user_global_roles_active_user_insert
BEFORE INSERT ON user_global_roles
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM users u
  WHERE u.user_id = NEW.user_id AND u.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'global_role_user_must_be_active');
END;

CREATE TRIGGER trg_user_global_roles_store_conflict_insert
BEFORE INSERT ON user_global_roles
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM store_members sm WHERE sm.user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'global_role_store_membership_conflict');
END;

CREATE TRIGGER trg_store_members_global_role_conflict_insert
BEFORE INSERT ON store_members
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM user_global_roles ugr WHERE ugr.user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'store_member_global_role_conflict');
END;

CREATE TRIGGER trg_store_members_global_role_conflict_user_update
BEFORE UPDATE OF user_id ON store_members
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM user_global_roles ugr WHERE ugr.user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'store_member_global_role_conflict');
END;

CREATE TRIGGER trg_users_global_role_status_update
BEFORE UPDATE OF status ON users
FOR EACH ROW
WHEN NEW.status <> 'active'
 AND EXISTS (
   SELECT 1 FROM user_global_roles ugr WHERE ugr.user_id = OLD.user_id
 )
BEGIN
  SELECT RAISE(ABORT, 'global_role_user_must_remain_active');
END;

-- Prevent the last active owner from being removed even if application authorization is bypassed.
CREATE TRIGGER trg_user_global_roles_last_owner_delete
BEFORE DELETE ON user_global_roles
FOR EACH ROW
WHEN OLD.role_key = 'owner'
 AND EXISTS (
   SELECT 1 FROM users u
   WHERE u.user_id = OLD.user_id AND u.status = 'active'
 )
 AND (
   SELECT COUNT(*)
   FROM user_global_roles owner_role
   JOIN users owner_user ON owner_user.user_id = owner_role.user_id
   WHERE owner_role.role_key = 'owner'
     AND owner_user.status = 'active'
 ) <= 1
BEGIN
  SELECT RAISE(ABORT, 'last_active_owner_protection');
END;

CREATE TRIGGER trg_user_global_roles_last_owner_role_update
BEFORE UPDATE OF role_key ON user_global_roles
FOR EACH ROW
WHEN OLD.role_key = 'owner'
 AND NEW.role_key <> 'owner'
 AND EXISTS (
   SELECT 1 FROM users u
   WHERE u.user_id = OLD.user_id AND u.status = 'active'
 )
 AND (
   SELECT COUNT(*)
   FROM user_global_roles owner_role
   JOIN users owner_user ON owner_user.user_id = owner_role.user_id
   WHERE owner_role.role_key = 'owner'
     AND owner_user.status = 'active'
 ) <= 1
BEGIN
  SELECT RAISE(ABORT, 'last_active_owner_protection');
END;

CREATE TRIGGER trg_users_last_owner_delete
BEFORE DELETE ON users
FOR EACH ROW
WHEN OLD.status = 'active'
 AND EXISTS (
   SELECT 1 FROM user_global_roles ugr
   WHERE ugr.user_id = OLD.user_id AND ugr.role_key = 'owner'
 )
 AND (
   SELECT COUNT(*)
   FROM user_global_roles owner_role
   JOIN users owner_user ON owner_user.user_id = owner_role.user_id
   WHERE owner_role.role_key = 'owner'
     AND owner_user.status = 'active'
 ) <= 1
BEGIN
  SELECT RAISE(ABORT, 'last_active_owner_protection');
END;

-- Assigned role scopes are immutable while relations exist; changing the role catalog cannot
-- retroactively turn a global assignment into a store assignment (or vice versa).
CREATE TRIGGER trg_app_roles_scope_update_guard
BEFORE UPDATE OF role_scope ON app_roles
FOR EACH ROW
WHEN NEW.role_scope <> OLD.role_scope
 AND (
   EXISTS (SELECT 1 FROM user_global_roles ugr WHERE ugr.role_key = OLD.role_key)
   OR EXISTS (SELECT 1 FROM store_members sm WHERE sm.role_key = OLD.role_key)
 )
BEGIN
  SELECT RAISE(ABORT, 'assigned_role_scope_change_forbidden');
END;

PRAGMA optimize;
