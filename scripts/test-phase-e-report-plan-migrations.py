#!/usr/bin/env python3
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / 'cloudflare' / 'foundation' / 'migrations' / 'store'


def apply_through(conn, through='0011_store_report_plan_receipt.sql'):
    for migration in sorted(STORE.glob('*.sql')):
        conn.executescript(migration.read_text(encoding='utf-8'))
        if migration.name == through:
            return
    raise AssertionError(f'migration not found: {through}')


def expect_integrity(conn, sql, params=(), code=None):
    try:
        conn.execute(sql, params)
    except sqlite3.IntegrityError as exc:
        if code:
            assert code in str(exc), (code, str(exc))
        return
    raise AssertionError(f'expected IntegrityError: {code or sql}')


def main():
    conn = sqlite3.connect(':memory:')
    conn.execute('PRAGMA foreign_keys=ON')
    apply_through(conn)
    conn.execute("INSERT INTO amazon_profiles(profile_id,status) VALUES('p1','active')")

    expect_integrity(conn, """
      INSERT INTO sync_runs(
        run_id,profile_id,trigger_type,scope_key,status,intent_fingerprint,
        report_plan_fingerprint,report_plan_job_count
      ) VALUES('bad-insert',NULL,'manual','scope','queued','fp-bad',?,1)
    """, ('a'*64,), code='REPORT_PLAN_INITIAL_RECEIPT_FORBIDDEN')

    conn.execute("""
      INSERT INTO sync_runs(run_id,profile_id,trigger_type,scope_key,status,intent_fingerprint)
      VALUES('run1',NULL,'manual','scope','queued','fp-run1')
    """)

    expect_integrity(conn,
        "UPDATE sync_runs SET report_plan_fingerprint=? WHERE run_id='run1'",
        ('a'*64,), code='REPORT_PLAN_RECEIPT_PARTIAL')
    expect_integrity(conn,
        "UPDATE sync_runs SET report_plan_fingerprint=?,report_plan_job_count=1 WHERE run_id='run1'",
        ('a'*64,), code='REPORT_PLAN_ASSIGNMENT_STATE_INVALID')

    conn.execute("UPDATE sync_runs SET profile_id='p1',status='running',started_at='t0' WHERE run_id='run1'")
    expect_integrity(conn,
        "UPDATE sync_runs SET report_plan_fingerprint=?,report_plan_job_count=1 WHERE run_id='run1'",
        ('A'*64,), code='REPORT_PLAN_FINGERPRINT_INVALID')
    expect_integrity(conn,
        "UPDATE sync_runs SET report_plan_fingerprint=?,report_plan_job_count=0 WHERE run_id='run1'",
        ('a'*64,), code='REPORT_PLAN_JOB_COUNT_INVALID')
    expect_integrity(conn,
        "UPDATE sync_runs SET report_plan_fingerprint=?,report_plan_job_count=1.5 WHERE run_id='run1'",
        ('a'*64,), code='REPORT_PLAN_JOB_COUNT_INVALID')

    conn.execute("UPDATE sync_runs SET report_plan_fingerprint=?,report_plan_job_count=2 WHERE run_id='run1'", ('a'*64,))
    row = conn.execute("SELECT report_plan_fingerprint,report_plan_job_count FROM sync_runs WHERE run_id='run1'").fetchone()
    assert row == ('a'*64, 2)

    expect_integrity(conn,
        "UPDATE sync_runs SET report_plan_fingerprint=? WHERE run_id='run1'",
        ('b'*64,), code='REPORT_PLAN_FINGERPRINT_IMMUTABLE')
    expect_integrity(conn,
        "UPDATE sync_runs SET report_plan_job_count=3 WHERE run_id='run1'",
        code='REPORT_PLAN_JOB_COUNT_IMMUTABLE')
    expect_integrity(conn,
        "UPDATE sync_runs SET report_plan_fingerprint=NULL,report_plan_job_count=NULL WHERE run_id='run1'",
        code='REPORT_PLAN_FINGERPRINT_IMMUTABLE')

    # Terminal transition is allowed only by preserving the durable report plan receipt.
    conn.execute("UPDATE sync_runs SET status='succeeded',completed_at='t1' WHERE run_id='run1'")
    terminal = conn.execute("SELECT status,report_plan_fingerprint,report_plan_job_count FROM sync_runs WHERE run_id='run1'").fetchone()
    assert terminal == ('succeeded', 'a'*64, 2)
    expect_integrity(conn,
        "UPDATE sync_runs SET report_plan_job_count=3 WHERE run_id='run1'",
        code='REPORT_PLAN_JOB_COUNT_IMMUTABLE')

    assert conn.execute('PRAGMA foreign_key_check').fetchall() == []
    conn.close()
    print('phase-e report plan receipt migration invariants: PASS')


if __name__ == '__main__':
    main()
