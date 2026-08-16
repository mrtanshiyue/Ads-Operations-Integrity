#!/usr/bin/env python3
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / 'cloudflare' / 'foundation' / 'migrations' / 'store'


def apply_through(conn, through='0010_store_report_receipt_hardening.sql'):
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
    conn.execute("INSERT INTO amazon_profiles(profile_id,status) VALUES('p1','active')")
    conn.execute("INSERT INTO sync_runs(run_id,profile_id,trigger_type,scope_key,status,intent_fingerprint) VALUES('run1',NULL,'manual','scope','queued','fp-run1')")
    conn.execute("UPDATE sync_runs SET profile_id='p1',status='running',started_at='t0' WHERE run_id='run1'")


def insert_job(conn, job_id):
    conn.execute("""
      INSERT INTO report_jobs(
        job_id,run_id,profile_id,ad_product,report_type,start_date,end_date,
        status,idempotency_key,request_fingerprint,request_json
      ) VALUES(?,?, 'p1','SPONSORED_PRODUCTS','spSearchTerm','2026-08-12','2026-08-12',
        'queued',?,?, '{}')
    """, (job_id, 'run1', f'idem-{job_id}', f'fp-{job_id}'))


def main():
    conn = sqlite3.connect(':memory:')
    conn.execute('PRAGMA foreign_keys=ON')
    apply_through(conn)
    seed(conn)

    # A queued reservation may never be born with lifecycle provenance already populated.
    expect_integrity(conn, """
      INSERT INTO report_jobs(
        job_id,run_id,profile_id,ad_product,report_type,start_date,end_date,status,
        idempotency_key,request_fingerprint,request_json,amazon_report_id
      ) VALUES('bad-insert','run1','p1','SPONSORED_PRODUCTS','spSearchTerm','2026-08-12','2026-08-12',
        'queued','idem-bad','fp-bad','{}','synthetic')
    """, code='REPORT_JOB_INITIAL_RECEIPT_FORBIDDEN')

    insert_job(conn, 'j1')
    conn.execute("UPDATE report_jobs SET status='requested' WHERE job_id='j1'")

    expect_integrity(conn,
        "UPDATE report_jobs SET amazon_report_id='amz-j1' WHERE job_id='j1'",
        code='REPORT_JOB_AMAZON_IDENTITY_PARTIAL')
    expect_integrity(conn,
        "UPDATE report_jobs SET amazon_report_id='amz-j1',amazon_created_at='source-t' WHERE job_id='j1'",
        code='REPORT_JOB_AMAZON_IDENTITY_STATUS_INVALID')

    conn.execute("""
      UPDATE report_jobs
      SET amazon_report_id='amz-j1',amazon_created_at='source-t',status='processing'
      WHERE job_id='j1'
    """)

    expect_integrity(conn,
        "UPDATE report_jobs SET r2_object_key='raw/key' WHERE job_id='j1'",
        code='REPORT_JOB_R2_EXPECTED_AUTHORITY_PARTIAL')
    expect_integrity(conn,
        "UPDATE report_jobs SET r2_object_key='raw/key',content_sha256=?,content_bytes=10 WHERE job_id='j1'",
        ('a'*64,), code='REPORT_JOB_R2_EXPECTED_AUTHORITY_STATUS_INVALID')

    conn.execute("UPDATE report_jobs SET status='ready' WHERE job_id='j1'")
    expect_integrity(conn,
        "UPDATE report_jobs SET r2_object_key='raw/key',content_sha256=?,content_bytes=10 WHERE job_id='j1'",
        ('A'*64,), code='REPORT_JOB_CONTENT_SHA256_INVALID')
    expect_integrity(conn,
        "UPDATE report_jobs SET r2_object_key='raw/key',content_sha256=?,content_bytes='not-integer' WHERE job_id='j1'",
        ('a'*64,), code='REPORT_JOB_CONTENT_BYTES_INVALID')

    conn.execute("""
      UPDATE report_jobs
      SET r2_object_key='raw/key',content_sha256=?,content_bytes=10
      WHERE job_id='j1'
    """, ('a'*64,))

    expect_integrity(conn,
        "UPDATE report_jobs SET r2_initial_version='v1' WHERE job_id='j1'",
        code='REPORT_JOB_R2_INITIAL_RECEIPT_PARTIAL')
    expect_integrity(conn,
        "UPDATE report_jobs SET r2_initial_version='v1',r2_initial_etag='e1',downloaded_at='t1' WHERE job_id='j1'",
        code='REPORT_JOB_R2_INITIAL_RECEIPT_STATUS_INVALID')

    conn.execute("""
      UPDATE report_jobs
      SET r2_initial_version='v1',r2_initial_etag='e1',downloaded_at='t1',status='downloaded'
      WHERE job_id='j1'
    """)

    expect_integrity(conn,
        "UPDATE report_jobs SET raw_row_count='not-integer' WHERE job_id='j1'",
        code='REPORT_JOB_RAW_ROW_COUNT_INVALID')
    conn.execute("UPDATE report_jobs SET raw_row_count=1 WHERE job_id='j1'")

    expect_integrity(conn,
        "UPDATE report_jobs SET row_count=1 WHERE job_id='j1'",
        code='REPORT_JOB_INGESTION_RECEIPT_PARTIAL')
    expect_integrity(conn,
        "UPDATE report_jobs SET row_count=1,ingested_at='t2' WHERE job_id='j1'",
        code='REPORT_JOB_INGESTION_RECEIPT_STATUS_INVALID')

    conn.execute("UPDATE report_jobs SET row_count=1,ingested_at='t2',status='ingested' WHERE job_id='j1'")
    row = conn.execute("""
      SELECT status,amazon_report_id,amazon_created_at,r2_object_key,content_sha256,content_bytes,
             r2_initial_version,r2_initial_etag,downloaded_at,raw_row_count,row_count,ingested_at
      FROM report_jobs WHERE job_id='j1'
    """).fetchone()
    assert row == ('ingested','amz-j1','source-t','raw/key','a'*64,10,'v1','e1','t1',1,1,'t2')

    # Existing immutable provenance remains immutable after the new completeness guard.
    expect_integrity(conn,
        "UPDATE report_jobs SET content_sha256=? WHERE job_id='j1'",
        ('b'*64,), code='REPORT_JOB_CONTENT_SHA256_IMMUTABLE')
    expect_integrity(conn,
        "UPDATE report_jobs SET amazon_created_at='rewritten' WHERE job_id='j1'",
        code='REPORT_JOB_AMAZON_CREATED_AT_IMMUTABLE')

    assert conn.execute('PRAGMA foreign_key_check').fetchall() == []
    conn.close()
    print('phase-e report receipt migration invariants: PASS')


if __name__ == '__main__':
    main()
