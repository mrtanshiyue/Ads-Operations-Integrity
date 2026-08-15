#!/usr/bin/env python3
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / 'cloudflare' / 'foundation' / 'migrations' / 'store'


def apply_through(conn, through='0015_store_report_fact_stage_receipt_guard.sql'):
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


def seed(conn):
    conn.execute("INSERT INTO amazon_profiles(profile_id,account_type,status) VALUES('p1','seller','active')")
    conn.execute("""
      INSERT INTO sync_runs(run_id,profile_id,trigger_type,scope_key,status,intent_fingerprint)
      VALUES('run1',NULL,'manual','scope','queued','fp-run1')
    """)
    conn.execute("UPDATE sync_runs SET profile_id='p1',status='running',started_at='t0' WHERE run_id='run1'")


def make_downloaded_job(conn, job_id, report_type='spSearchTerm'):
    conn.execute("""
      INSERT INTO report_jobs(
        job_id,run_id,profile_id,ad_product,report_type,start_date,end_date,status,
        idempotency_key,request_fingerprint,request_json
      ) VALUES(?, 'run1','p1','SPONSORED_PRODUCTS',?,'2026-08-12','2026-08-12','queued',?,?, '{}')
    """, (job_id, report_type, f'idem-{job_id}', f'req-{job_id}'))
    conn.execute("UPDATE report_jobs SET status='requested' WHERE job_id=?", (job_id,))
    conn.execute("""
      UPDATE report_jobs
      SET amazon_report_id=?,amazon_created_at='source-time',status='processing'
      WHERE job_id=?
    """, (f'amz-{job_id}', job_id))
    conn.execute("UPDATE report_jobs SET status='ready' WHERE job_id=?", (job_id,))
    conn.execute("""
      UPDATE report_jobs
      SET r2_object_key=?,content_sha256=?,content_bytes=100,
          r2_initial_version=?,r2_initial_etag=?,downloaded_at='download-time',status='downloaded'
      WHERE job_id=?
    """, (f'raw/{job_id}.json.gz', 'a' * 64, f'version-{job_id}', f'etag-{job_id}', job_id))


def canonical(job_id='job-1', **overrides):
    value = {
        'rowKey': 'rk-0',
        'profileId': 'p1',
        'reportDate': '2026-08-12',
        'adProduct': 'SPONSORED_PRODUCTS',
        'sourceReportJobId': job_id,
    }
    value.update(overrides)
    return json.dumps(value, separators=(',', ':'), sort_keys=True)


def insert_stage(conn, job_id='job-1', ordinal=0, logical_row_key='rk-0', dataset='search_term_daily', payload=None):
    conn.execute("""
      INSERT INTO report_fact_stage(
        job_id,dataset_key,source_row_ordinal,logical_row_key,canonical_row_json
      ) VALUES(?,?,?,?,?)
    """, (job_id, dataset, ordinal, logical_row_key, payload if payload is not None else canonical(job_id)))


def reset_stage(conn, job_id='job-1'):
    conn.execute("DELETE FROM report_fact_stage WHERE job_id=?", (job_id,))
    assert conn.execute("SELECT raw_row_count FROM report_jobs WHERE job_id=?", (job_id,)).fetchone()[0] is None


def main():
    conn = sqlite3.connect(':memory:')
    conn.execute('PRAGMA foreign_keys=ON')
    apply_through(conn)
    seed(conn)
    make_downloaded_job(conn, 'job-1')

    # The completion receipt cannot be invented before the deterministic stage exists.
    expect_integrity(
        conn,
        "UPDATE report_jobs SET raw_row_count=1 WHERE job_id='job-1'",
        code='REPORT_FACT_STAGE_RECEIPT_COUNT_MISMATCH',
    )

    insert_stage(conn, dataset='campaign_daily')
    expect_integrity(
        conn,
        "UPDATE report_jobs SET raw_row_count=1 WHERE job_id='job-1'",
        code='REPORT_FACT_STAGE_RECEIPT_DATASET_MISMATCH',
    )
    reset_stage(conn)

    insert_stage(conn, ordinal=1)
    expect_integrity(
        conn,
        "UPDATE report_jobs SET raw_row_count=1 WHERE job_id='job-1'",
        code='REPORT_FACT_STAGE_RECEIPT_ORDINAL_GAP',
    )
    reset_stage(conn)

    insert_stage(conn, payload='{broken-json')
    expect_integrity(
        conn,
        "UPDATE report_jobs SET raw_row_count=1 WHERE job_id='job-1'",
        code='REPORT_FACT_STAGE_RECEIPT_CANONICAL_JSON_INVALID',
    )
    reset_stage(conn)

    insert_stage(conn, payload=canonical('job-1', rowKey='different'))
    expect_integrity(
        conn,
        "UPDATE report_jobs SET raw_row_count=1 WHERE job_id='job-1'",
        code='REPORT_FACT_STAGE_RECEIPT_ROW_KEY_MISMATCH',
    )
    reset_stage(conn)

    insert_stage(conn, payload=canonical('other-job'))
    expect_integrity(
        conn,
        "UPDATE report_jobs SET raw_row_count=1 WHERE job_id='job-1'",
        code='REPORT_FACT_STAGE_RECEIPT_SOURCE_JOB_MISMATCH',
    )
    reset_stage(conn)

    insert_stage(conn, payload=canonical('job-1', profileId='other-profile'))
    expect_integrity(
        conn,
        "UPDATE report_jobs SET raw_row_count=1 WHERE job_id='job-1'",
        code='REPORT_FACT_STAGE_RECEIPT_PROFILE_MISMATCH',
    )
    reset_stage(conn)

    insert_stage(conn, payload=canonical('job-1', adProduct='SPONSORED_BRANDS'))
    expect_integrity(
        conn,
        "UPDATE report_jobs SET raw_row_count=1 WHERE job_id='job-1'",
        code='REPORT_FACT_STAGE_RECEIPT_AD_PRODUCT_MISMATCH',
    )
    reset_stage(conn)

    insert_stage(conn, payload=canonical('job-1', reportDate='2026-08-13'))
    expect_integrity(
        conn,
        "UPDATE report_jobs SET raw_row_count=1 WHERE job_id='job-1'",
        code='REPORT_FACT_STAGE_RECEIPT_DATE_MISMATCH',
    )
    reset_stage(conn)

    # One exact deterministic row authorizes the immutable completion receipt.
    insert_stage(conn)
    conn.execute("UPDATE report_jobs SET raw_row_count=1 WHERE job_id='job-1'")
    assert conn.execute("SELECT raw_row_count FROM report_jobs WHERE job_id='job-1'").fetchone()[0] == 1
    expect_integrity(
        conn,
        "INSERT INTO report_fact_stage(job_id,dataset_key,source_row_ordinal,logical_row_key,canonical_row_json) VALUES('job-1','search_term_daily',1,'rk-1','{}')",
        code='REPORT_FACT_STAGE_FROZEN',
    )
    expect_integrity(
        conn,
        "UPDATE report_fact_stage SET canonical_row_json='{}' WHERE job_id='job-1' AND source_row_ordinal=0",
        code='REPORT_FACT_STAGE_FROZEN',
    )

    # Empty Amazon reports are valid: zero staged rows can freeze with raw_row_count=0.
    make_downloaded_job(conn, 'job-empty')
    conn.execute("UPDATE report_jobs SET raw_row_count=0 WHERE job_id='job-empty'")
    assert conn.execute("SELECT raw_row_count FROM report_jobs WHERE job_id='job-empty'").fetchone()[0] == 0

    # No unsupported report contract may manufacture this search-term stage receipt.
    make_downloaded_job(conn, 'job-unsupported', report_type='spCampaigns')
    expect_integrity(
        conn,
        "UPDATE report_jobs SET raw_row_count=0 WHERE job_id='job-unsupported'",
        code='REPORT_FACT_STAGE_RECEIPT_CONTRACT_UNSUPPORTED',
    )

    assert conn.execute('PRAGMA foreign_key_check').fetchall() == []
    conn.close()
    print('phase-e report fact stage completion receipt guard: PASS')


if __name__ == '__main__':
    main()
