#!/usr/bin/env python3
import sqlite3
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTROL_MIGRATIONS = ROOT / 'cloudflare/foundation/migrations/control'


def apply_migrations(conn: sqlite3.Connection) -> list[str]:
    applied = []
    for migration in sorted(CONTROL_MIGRATIONS.glob('*.sql')):
        conn.executescript(migration.read_text(encoding='utf-8'))
        applied.append(migration.name)
    return applied


def expect_integrity_error(conn: sqlite3.Connection, sql: str, params=(), contains: str | None = None):
    try:
        conn.execute(sql, params)
    except sqlite3.IntegrityError as error:
        if contains is not None:
            assert contains in str(error), f'expected {contains!r} in {error!r}'
        return
    raise AssertionError(f'expected integrity failure: {sql}')


def seed_user(conn: sqlite3.Connection, user_id: str, status='active', access_bound=True):
    sub = f'sub-{user_id}' if access_bound else None
    email = f'{user_id}@example.invalid'
    conn.execute(
        'INSERT INTO users(user_id,cf_access_sub,email,email_norm,status) VALUES(?,?,?,?,?)',
        (user_id, sub, email, email, status),
    )


def main():
    with tempfile.TemporaryDirectory(prefix='ads-ops-security-integrity-') as tmp:
        db_path = Path(tmp) / 'control.sqlite'
        conn = sqlite3.connect(db_path)
        conn.execute('PRAGMA foreign_keys = ON')
        migrations = apply_migrations(conn)
        assert migrations[-1] == '0005_control_security_integrity.sql'

        for user_id in ('owner-a', 'owner-b', 'admin-a', 'ordinary-a', 'ordinary-b', 'disabled-a'):
            seed_user(conn, user_id, status='disabled' if user_id == 'disabled-a' else 'active')
        # Bootstrap compatibility: an active Access-unbound owner is still legal before first bind.
        seed_user(conn, 'bootstrap-owner', access_bound=False)

        conn.execute(
            "INSERT INTO stores(store_id,store_code,display_name,d1_binding_key) VALUES('store-01','S01','Store 01','STORE_01_DB')"
        )

        conn.execute(
            "INSERT INTO user_global_roles(user_id,role_key,granted_by) VALUES('owner-a','owner','owner-a')"
        )
        conn.execute(
            "INSERT INTO user_global_roles(user_id,role_key,granted_by) VALUES('admin-a','admin','owner-a')"
        )
        conn.execute(
            "INSERT INTO user_global_roles(user_id,role_key,granted_by) VALUES('bootstrap-owner','owner','owner-a')"
        )

        # Single-global-role invariant closes owner+admin dual-role state.
        expect_integrity_error(
            conn,
            "INSERT INTO user_global_roles(user_id,role_key,granted_by) VALUES('admin-a','owner','owner-a')",
            contains='UNIQUE constraint failed: user_global_roles.user_id',
        )

        # Role-scope assignments are enforced by the database, not only by API joins.
        expect_integrity_error(
            conn,
            "INSERT INTO user_global_roles(user_id,role_key,granted_by) VALUES('ordinary-a','operator','owner-a')",
            contains='user_global_roles_requires_global_role',
        )
        expect_integrity_error(
            conn,
            "INSERT INTO store_members(store_id,user_id,role_key) VALUES('store-01','ordinary-a','owner')",
            contains='store_members_requires_store_role',
        )

        # Global and store role models are mutually exclusive for the same user.
        conn.execute(
            "INSERT INTO store_members(store_id,user_id,role_key) VALUES('store-01','ordinary-a','operator')"
        )
        expect_integrity_error(
            conn,
            "INSERT INTO user_global_roles(user_id,role_key,granted_by) VALUES('ordinary-a','admin','owner-a')",
            contains='global_role_store_membership_conflict',
        )
        expect_integrity_error(
            conn,
            "INSERT INTO store_members(store_id,user_id,role_key) VALUES('store-01','admin-a','viewer')",
            contains='store_member_global_role_conflict',
        )

        # Disabled users cannot newly receive global governance roles.
        expect_integrity_error(
            conn,
            "INSERT INTO user_global_roles(user_id,role_key,granted_by) VALUES('disabled-a','admin','owner-a')",
            contains='global_role_user_must_be_active',
        )

        # A user holding a global role cannot be disabled behind the application API.
        expect_integrity_error(
            conn,
            "UPDATE users SET status='disabled' WHERE user_id='admin-a'",
            contains='global_role_user_must_remain_active',
        )

        # Last-active-owner protection is enforced at relation and user deletion boundaries.
        # bootstrap-owner is a second active owner, so owner-a can be removed safely.
        conn.execute("DELETE FROM user_global_roles WHERE user_id='owner-a' AND role_key='owner'")
        expect_integrity_error(
            conn,
            "DELETE FROM user_global_roles WHERE user_id='bootstrap-owner' AND role_key='owner'",
            contains='last_active_owner_protection',
        )
        expect_integrity_error(
            conn,
            "UPDATE user_global_roles SET role_key='admin' WHERE user_id='bootstrap-owner' AND role_key='owner'",
            contains='last_active_owner_protection',
        )
        expect_integrity_error(
            conn,
            "DELETE FROM users WHERE user_id='bootstrap-owner'",
            contains='last_active_owner_protection',
        )

        # Once a second active owner exists, safe owner rotation is permitted.
        conn.execute(
            "INSERT INTO user_global_roles(user_id,role_key,granted_by) VALUES('owner-b','owner','bootstrap-owner')"
        )
        conn.execute("DELETE FROM user_global_roles WHERE user_id='bootstrap-owner' AND role_key='owner'")
        owner_count = conn.execute(
            """
            SELECT COUNT(*)
            FROM user_global_roles ugr
            JOIN users u ON u.user_id=ugr.user_id
            WHERE ugr.role_key='owner' AND u.status='active'
            """
        ).fetchone()[0]
        assert owner_count == 1

        # Assigned role catalog scope cannot be changed underneath existing assignments.
        expect_integrity_error(
            conn,
            "UPDATE app_roles SET role_scope='store' WHERE role_key='admin'",
            contains='assigned_role_scope_change_forbidden',
        )
        expect_integrity_error(
            conn,
            "UPDATE app_roles SET role_scope='global' WHERE role_key='operator'",
            contains='assigned_role_scope_change_forbidden',
        )

        fk_errors = conn.execute('PRAGMA foreign_key_check').fetchall()
        assert not fk_errors, f'foreign-key violations: {fk_errors}'

        trigger_names = {
            row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_%'"
            )
        }
        required_triggers = {
            'trg_user_global_roles_scope_insert',
            'trg_store_members_scope_insert',
            'trg_user_global_roles_active_user_insert',
            'trg_user_global_roles_store_conflict_insert',
            'trg_store_members_global_role_conflict_insert',
            'trg_users_global_role_status_update',
            'trg_user_global_roles_last_owner_delete',
            'trg_user_global_roles_last_owner_role_update',
            'trg_users_last_owner_delete',
            'trg_app_roles_scope_update_guard',
        }
        assert required_triggers.issubset(trigger_names)

        print({
            'ok': True,
            'migration': migrations[-1],
            'single_global_role': True,
            'role_scope_enforced': True,
            'global_store_exclusive': True,
            'global_role_lifecycle_guarded': True,
            'last_active_owner_guarded': True,
            'bootstrap_unbound_owner_compatible': True,
        })
        conn.close()


if __name__ == '__main__':
    main()
