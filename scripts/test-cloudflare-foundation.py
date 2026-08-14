#!/usr/bin/env python3
import json
import sqlite3
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTROL_MIGRATIONS = ROOT / "cloudflare/foundation/migrations/control"
STORE_MIGRATIONS = ROOT / "cloudflare/foundation/migrations/store"


def apply_migrations(conn: sqlite3.Connection, directory: Path) -> list[str]:
    applied = []
    for migration in sorted(directory.glob("*.sql")):
        conn.executescript(migration.read_text(encoding="utf-8"))
        applied.append(migration.name)
    return applied


def fk_errors(conn: sqlite3.Connection):
    return conn.execute("PRAGMA foreign_key_check").fetchall()


def has_permission(conn, user_id: str, store_id: str, permission: str) -> bool:
    global_hit = conn.execute(
        """
        SELECT 1
        FROM user_global_roles ugr
        JOIN role_permissions rp ON rp.role_key = ugr.role_key
        WHERE ugr.user_id = ? AND rp.permission_key = ?
        LIMIT 1
        """,
        (user_id, permission),
    ).fetchone()
    if global_hit:
        return True

    store_hit = conn.execute(
        """
        SELECT 1
        FROM store_members sm
        JOIN role_permissions rp ON rp.role_key = sm.role_key
        WHERE sm.user_id = ? AND sm.store_id = ? AND rp.permission_key = ?
        LIMIT 1
        """,
        (user_id, store_id, permission),
    ).fetchone()
    return store_hit is not None


def test_control_schema(db_path: Path):
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys = ON")
    migrations = apply_migrations(conn, CONTROL_MIGRATIONS)

    users = [
        ("u-owner", "owner@example.invalid", "owner@example.invalid", "Owner"),
        ("u-operator", "operator@example.invalid", "operator@example.invalid", "Operator"),
        ("u-viewer", "viewer@example.invalid", "viewer@example.invalid", "Viewer"),
    ]
    conn.executemany(
        "INSERT INTO users(user_id,email,email_norm,display_name) VALUES(?,?,?,?)",
        users,
    )
    conn.executemany(
        """
        INSERT INTO stores(store_id,store_code,display_name,d1_binding_key,sort_order)
        VALUES(?,?,?,?,?)
        """,
        [
            ("store-01", "S01", "Store 01", "STORE_01_DB", 10),
            ("store-02", "S02", "Store 02", "STORE_02_DB", 20),
        ],
    )
    conn.execute(
        "INSERT INTO user_global_roles(user_id,role_key,granted_by) VALUES('u-owner','owner','u-owner')"
    )
    conn.execute(
        "INSERT INTO store_members(store_id,user_id,role_key) VALUES('store-01','u-operator','operator')"
    )
    conn.execute(
        "INSERT INTO store_members(store_id,user_id,role_key) VALUES('store-02','u-viewer','viewer')"
    )

    assert has_permission(conn, "u-owner", "store-01", "ads.write")
    assert has_permission(conn, "u-owner", "store-02", "ads.write")
    assert has_permission(conn, "u-owner", "store-02", "system.manage")

    assert has_permission(conn, "u-operator", "store-01", "ads.write")
    assert not has_permission(conn, "u-operator", "store-02", "ads.write")
    assert not has_permission(conn, "u-operator", "store-02", "ads.read")

    assert has_permission(conn, "u-viewer", "store-02", "ads.read")
    assert not has_permission(conn, "u-viewer", "store-02", "ads.write")
    assert not has_permission(conn, "u-viewer", "store-01", "ads.read")

    errors = fk_errors(conn)
    assert not errors, f"Control FK errors: {errors}"

    role_count = conn.execute("SELECT COUNT(*) FROM app_roles").fetchone()[0]
    permission_count = conn.execute("SELECT COUNT(*) FROM role_permissions").fetchone()[0]
    conn.close()
    return {
        "migrations": migrations,
        "roles": role_count,
        "role_permissions": permission_count,
        "foreign_key_errors": len(errors),
        "rbac_isolation": True,
    }


def test_store_schema(db_path: Path):
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys = ON")
    migrations = apply_migrations(conn, STORE_MIGRATIONS)

    conn.execute("INSERT INTO amazon_profiles(profile_id) VALUES('p1')")
    conn.execute(
        """
        INSERT INTO campaigns(campaign_id,profile_id,ad_product,name,state)
        VALUES('c1','p1','SP','Campaign','ENABLED')
        """
    )
    conn.execute(
        """
        INSERT INTO ad_groups(ad_group_id,profile_id,campaign_id,name,state)
        VALUES('a1','p1','c1','Ad Group','ENABLED')
        """
    )
    conn.execute(
        """
        INSERT INTO keywords(
          keyword_id,profile_id,campaign_id,ad_group_id,keyword_text,normalized_keyword,match_type,state
        ) VALUES('k1','p1','c1','a1','reading glasses','reading glasses','EXACT','ENABLED')
        """
    )

    upsert_sql = """
      INSERT INTO keyword_daily(
        profile_id,report_date,ad_product,campaign_id,ad_group_id,keyword_id,
        impressions,clicks,cost_micros,purchases,units_sold,sales_micros
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(profile_id,report_date,ad_product,keyword_id) DO UPDATE SET
        campaign_id=excluded.campaign_id,
        ad_group_id=excluded.ad_group_id,
        impressions=excluded.impressions,
        clicks=excluded.clicks,
        cost_micros=excluded.cost_micros,
        purchases=excluded.purchases,
        units_sold=excluded.units_sold,
        sales_micros=excluded.sales_micros,
        updated_at=CURRENT_TIMESTAMP
    """

    conn.execute(
        upsert_sql,
        ("p1", "2026-08-14", "SP", "c1", "a1", "k1", 100, 5, 1_000_000, 1, 1, 5_000_000),
    )
    conn.execute(
        upsert_sql,
        ("p1", "2026-08-14", "SP", "c1", "a1", "k1", 120, 8, 1_500_000, 2, 2, 7_000_000),
    )

    row = conn.execute(
        """
        SELECT COUNT(*), MAX(clicks), MAX(cost_micros), MAX(sales_micros)
        FROM keyword_daily
        WHERE profile_id='p1' AND report_date='2026-08-14' AND ad_product='SP' AND keyword_id='k1'
        """
    ).fetchone()
    assert row == (1, 8, 1_500_000, 7_000_000), f"UPSERT failed: {row}"

    conn.execute(
        """
        INSERT INTO report_jobs(
          job_id,profile_id,ad_product,report_type,start_date,end_date,status,
          idempotency_key,request_fingerprint
        ) VALUES('j1','p1','SP','keyword','2026-08-14','2026-08-14','queued','same-key','fp1')
        """
    )
    try:
        conn.execute(
            """
            INSERT INTO report_jobs(
              job_id,profile_id,ad_product,report_type,start_date,end_date,status,
              idempotency_key,request_fingerprint
            ) VALUES('j2','p1','SP','keyword','2026-08-14','2026-08-14','queued','same-key','fp2')
            """
        )
        raise AssertionError("Duplicate report idempotency_key was accepted")
    except sqlite3.IntegrityError:
        pass

    try:
        conn.execute(
            """
            INSERT INTO campaign_daily(
              profile_id,report_date,ad_product,campaign_id,cost_micros
            ) VALUES('p1','2026-08-14','SP','c1',-1)
            """
        )
        raise AssertionError("Negative cost_micros was accepted")
    except sqlite3.IntegrityError:
        pass

    errors = fk_errors(conn)
    assert not errors, f"Store FK errors: {errors}"
    fact_count = conn.execute("SELECT COUNT(*) FROM keyword_daily").fetchone()[0]
    conn.close()
    return {
        "migrations": migrations,
        "foreign_key_errors": len(errors),
        "keyword_daily_rows_after_retry": fact_count,
        "upsert_idempotency": True,
        "report_job_idempotency": True,
        "money_check_constraints": True,
    }


def main():
    with tempfile.TemporaryDirectory(prefix="ads-ops-foundation-") as tmp:
        tmp_path = Path(tmp)
        result = {
            "control": test_control_schema(tmp_path / "control.sqlite"),
            "store": test_store_schema(tmp_path / "store.sqlite"),
        }
    print(json.dumps({"ok": True, **result}, indent=2))


if __name__ == "__main__":
    main()
