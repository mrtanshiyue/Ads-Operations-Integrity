#!/usr/bin/env python3
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / 'cloudflare' / 'foundation' / 'migrations' / 'store'


def apply_through(conn, through='0014_store_report_plan_duplicate_guard.sql'):
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


def seed_run(conn, run_id='run-duplicate-guard', profile_id='p1'):
    conn.execute(
        "INSERT OR IGNORE INTO amazon_profiles(profile_id,status) VALUES(?, 'active')",
        (profile_id,),
    )
    conn.execute(
        """
        INSERT INTO sync_runs(run_id,profile_id,trigger_type,scope_key,status,intent_fingerprint)
        VALUES(?,NULL,'manual','scope','queued',?)
        """,
        (run_id, f'fp-{run_id}'),
    )
    conn.execute(
        "UPDATE sync_runs SET profile_id=?,status='running',started_at='t0' WHERE run_id=?",
        (profile_id, run_id),
    )


def insert_membership(
    conn,
    *,
    run_id='run-duplicate-guard',
    job_id='job-1',
    profile_id='p1',
    report_plan_fingerprint='d' * 64,
    dataset_key='search_term_daily',
    contract_id='search-term-sp-v1',
    ad_product='SPONSORED_PRODUCTS',
    report_type='spSearchTerm',
    start_date='2026-08-12',
    end_date='2026-08-12',
    idempotency_key='idem-job-1',
    request_fingerprint='req-job-1',
    request_json='{"dataset":"search_term_daily"}',
    or_ignore=False,
):
    verb = 'INSERT OR IGNORE' if or_ignore else 'INSERT'
    conn.execute(
        f"""
        {verb} INTO sync_report_plan_jobs(
          run_id,job_id,profile_id,report_plan_fingerprint,dataset_key,contract_id,
          ad_product,report_type,start_date,end_date,idempotency_key,request_fingerprint,request_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            run_id,
            job_id,
            profile_id,
            report_plan_fingerprint,
            dataset_key,
            contract_id,
            ad_product,
            report_type,
            start_date,
            end_date,
            idempotency_key,
            request_fingerprint,
            request_json,
        ),
    )


def main():
    conn = sqlite3.connect(':memory:')
    conn.execute('PRAGMA foreign_keys=ON')
    apply_through(conn)
    seed_run(conn)

    # Baseline durable membership.
    insert_membership(conn)
    assert conn.execute(
        "SELECT COUNT(*) FROM sync_report_plan_jobs WHERE run_id='run-duplicate-guard'"
    ).fetchone()[0] == 1

    # Exact identity duplicate remains idempotent under the repository's conflict-tolerant insert.
    before_changes = conn.total_changes
    insert_membership(conn, or_ignore=True)
    assert conn.total_changes == before_changes
    assert conn.execute(
        "SELECT COUNT(*) FROM sync_report_plan_jobs WHERE run_id='run-duplicate-guard'"
    ).fetchone()[0] == 1

    # Same job_id with a changed immutable identity must not be masked by INSERT OR IGNORE.
    expect_integrity(
        conn,
        """
        INSERT OR IGNORE INTO sync_report_plan_jobs(
          run_id,job_id,profile_id,report_plan_fingerprint,dataset_key,contract_id,
          ad_product,report_type,start_date,end_date,idempotency_key,request_fingerprint,request_json
        ) VALUES(
          'run-duplicate-guard','job-1','p1',?,'campaign_daily','search-term-sp-v1',
          'SPONSORED_PRODUCTS','spSearchTerm','2026-08-12','2026-08-12',
          'idem-job-1','req-job-1','{"dataset":"search_term_daily"}'
        )
        """,
        ('d' * 64,),
        code='REPORT_PLAN_MEMBERSHIP_DUPLICATE_CONFLICT',
    )

    # Same idempotency_key assigned to a different job is an identity collision, not idempotency.
    expect_integrity(
        conn,
        """
        INSERT OR IGNORE INTO sync_report_plan_jobs(
          run_id,job_id,profile_id,report_plan_fingerprint,dataset_key,contract_id,
          ad_product,report_type,start_date,end_date,idempotency_key,request_fingerprint,request_json
        ) VALUES(
          'run-duplicate-guard','job-2','p1',?,'search_term_daily','search-term-sp-v1',
          'SPONSORED_PRODUCTS','spSearchTerm','2026-08-12','2026-08-12',
          'idem-job-1','req-job-2','{"dataset":"search_term_daily"}'
        )
        """,
        ('d' * 64,),
        code='REPORT_PLAN_MEMBERSHIP_DUPLICATE_CONFLICT',
    )

    assert conn.execute(
        "SELECT COUNT(*) FROM sync_report_plan_jobs WHERE run_id='run-duplicate-guard'"
    ).fetchone()[0] == 1
    assert conn.execute('PRAGMA foreign_key_check').fetchall() == []
    conn.close()
    print('phase-e report plan duplicate collision guard invariants: PASS')


if __name__ == '__main__':
    main()
