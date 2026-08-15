#!/usr/bin/env python3
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / 'cloudflare' / 'foundation' / 'migrations' / 'store'


def apply_through(conn, through='0012_store_report_plan_membership.sql'):
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


def seed_run(conn, run_id, profile='p1'):
    conn.execute("INSERT OR IGNORE INTO amazon_profiles(profile_id,status) VALUES(?, 'active')", (profile,))
    conn.execute("""
      INSERT INTO sync_runs(run_id,profile_id,trigger_type,scope_key,status,intent_fingerprint)
      VALUES(?,NULL,'manual','scope','queued',?)
    """, (run_id, f'fp-{run_id}'))
    conn.execute("UPDATE sync_runs SET profile_id=?,status='running',started_at='t0' WHERE run_id=?", (profile,run_id))


def membership(conn, run_id, job_id, fingerprint, profile='p1', request_fingerprint=None, request_json='{}'):
    request_fingerprint = request_fingerprint or f'req-{job_id}'
    conn.execute("""
      INSERT INTO sync_report_plan_jobs(
        run_id,job_id,profile_id,report_plan_fingerprint,dataset_key,contract_id,
        ad_product,report_type,start_date,end_date,idempotency_key,request_fingerprint,request_json
      ) VALUES(?,?,?,?,'search_term_daily','search-term-sp-v1','SPONSORED_PRODUCTS','spSearchTerm',
        '2026-08-12','2026-08-12',?,?,?)
    """, (run_id,job_id,profile,fingerprint,f'idem-{job_id}',request_fingerprint,request_json))


def report_job(conn, run_id, job_id, profile='p1', request_fingerprint=None, request_json='{}'):
    request_fingerprint = request_fingerprint or f'req-{job_id}'
    conn.execute("""
      INSERT INTO report_jobs(
        job_id,run_id,profile_id,ad_product,report_type,start_date,end_date,status,
        idempotency_key,request_fingerprint,request_json
      ) VALUES(?,?,?,'SPONSORED_PRODUCTS','spSearchTerm','2026-08-12','2026-08-12','queued',?,?,?)
    """, (job_id,run_id,profile,f'idem-{job_id}',request_fingerprint,request_json))


def main():
    conn = sqlite3.connect(':memory:')
    conn.execute('PRAGMA foreign_keys=ON')
    apply_through(conn)
    fingerprint = 'a' * 64
    seed_run(conn, 'run1')
    conn.execute("INSERT INTO amazon_profiles(profile_id,status) VALUES('p2','active')")

    expect_integrity(conn,
        "UPDATE sync_runs SET report_plan_fingerprint=?,report_plan_job_count=1 WHERE run_id='run1'",
        (fingerprint,), code='REPORT_PLAN_MEMBERSHIP_COUNT_MISMATCH')

    expect_integrity(conn, """
      INSERT INTO sync_report_plan_jobs(
        run_id,job_id,profile_id,report_plan_fingerprint,dataset_key,contract_id,
        ad_product,report_type,start_date,end_date,idempotency_key,request_fingerprint,request_json
      ) VALUES('run1','wrong-profile','p2',?,'search_term_daily','c','SPONSORED_PRODUCTS','spSearchTerm',
        '2026-08-12','2026-08-12','idem-wrong','req-wrong','{}')
    """, (fingerprint,), code='REPORT_PLAN_MEMBERSHIP_RUN_NOT_STAGING')

    membership(conn, 'run1', 'job1', fingerprint)
    membership(conn, 'run1', 'job2', fingerprint)
    expect_integrity(conn,
        "UPDATE sync_runs SET report_plan_fingerprint=?,report_plan_job_count=1 WHERE run_id='run1'",
        (fingerprint,), code='REPORT_PLAN_MEMBERSHIP_COUNT_MISMATCH')
    conn.execute("UPDATE sync_runs SET report_plan_fingerprint=?,report_plan_job_count=2 WHERE run_id='run1'", (fingerprint,))

    expect_integrity(conn,
        "UPDATE sync_report_plan_jobs SET dataset_key='other' WHERE run_id='run1' AND job_id='job1'",
        code='REPORT_PLAN_MEMBERSHIP_IMMUTABLE')
    expect_integrity(conn,
        "DELETE FROM sync_report_plan_jobs WHERE run_id='run1' AND job_id='job1'",
        code='REPORT_PLAN_MEMBERSHIP_IMMUTABLE')
    expect_integrity(conn, """
      INSERT INTO sync_report_plan_jobs(
        run_id,job_id,profile_id,report_plan_fingerprint,dataset_key,contract_id,
        ad_product,report_type,start_date,end_date,idempotency_key,request_fingerprint,request_json
      ) VALUES('run1','job3','p1',?,'search_term_daily','c','SPONSORED_PRODUCTS','spSearchTerm',
        '2026-08-12','2026-08-12','idem-job3','req-job3','{}')
    """, (fingerprint,), code='REPORT_PLAN_MEMBERSHIP_RUN_NOT_STAGING')

    report_job(conn, 'run1', 'job1')
    expect_integrity(conn,
        "DELETE FROM report_jobs WHERE job_id='job1'",
        code='REPORT_JOB_FROZEN_PLAN_DELETE_FORBIDDEN')
    conn.execute("UPDATE report_jobs SET status='requested' WHERE job_id='job1'")

    expect_integrity(conn, """
      INSERT INTO report_jobs(
        job_id,run_id,profile_id,ad_product,report_type,start_date,end_date,status,
        idempotency_key,request_fingerprint,request_json
      ) VALUES('extra','run1','p1','SPONSORED_PRODUCTS','spSearchTerm','2026-08-12','2026-08-12',
        'queued','idem-extra','req-extra','{}')
    """, code='REPORT_JOB_NOT_IN_FROZEN_PLAN')

    expect_integrity(conn, """
      INSERT INTO report_jobs(
        job_id,run_id,profile_id,ad_product,report_type,start_date,end_date,status,
        idempotency_key,request_fingerprint,request_json
      ) VALUES('job2','run1','p1','SPONSORED_PRODUCTS','spSearchTerm','2026-08-12','2026-08-12',
        'queued','idem-job2','wrong-request','{}')
    """, code='REPORT_JOB_NOT_IN_FROZEN_PLAN')
    report_job(conn, 'run1', 'job2')
    expect_integrity(conn,
        "DELETE FROM sync_runs WHERE run_id='run1'",
        code='SYNC_RUN_FROZEN_PLAN_DELETE_FORBIDDEN')

    # Matching legacy report_jobs can be attested by a newly frozen plan.
    seed_run(conn, 'run2')
    membership(conn, 'run2', 'legacy-ok', 'b'*64)
    report_job(conn, 'run2', 'legacy-ok')
    conn.execute("UPDATE sync_runs SET report_plan_fingerprint=?,report_plan_job_count=1 WHERE run_id='run2'", ('b'*64,))

    # A pre-existing job whose immutable identity disagrees with membership blocks plan freeze.
    seed_run(conn, 'run3')
    membership(conn, 'run3', 'legacy-bad', 'c'*64, request_fingerprint='expected-request')
    report_job(conn, 'run3', 'legacy-bad', request_fingerprint='different-request')
    expect_integrity(conn,
        "UPDATE sync_runs SET report_plan_fingerprint=?,report_plan_job_count=1 WHERE run_id='run3'",
        ('c'*64,), code='REPORT_PLAN_EXISTING_JOB_CONFLICT')

    assert conn.execute('PRAGMA foreign_key_check').fetchall() == []
    conn.close()
    print('phase-e report plan membership migration invariants: PASS')


if __name__ == '__main__':
    main()
