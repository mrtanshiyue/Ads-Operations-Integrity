#!/usr/bin/env python3
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / 'cloudflare' / 'foundation' / 'migrations' / 'store'


def apply_through(conn, through='0013_store_sync_completion_receipt.sql'):
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


def stats(fp, job_count, ingested, failed, cancelled):
    return json.dumps({
        'schemaVersion':'sync-report-plan-completion-v1',
        'reportPlanFingerprint':fp,
        'jobCount':job_count,
        'ingestedCount':ingested,
        'failedCount':failed,
        'cancelledCount':cancelled,
    }, separators=(',',':'), sort_keys=True)


def seed_plan_run(conn, run_id, job_count=2, fingerprint=None):
    fingerprint = fingerprint or (run_id[-1].lower() if run_id[-1].lower() in 'abcdef' else 'a') * 64
    conn.execute("INSERT OR IGNORE INTO amazon_profiles(profile_id,status) VALUES('p1','active')")
    conn.execute("""
      INSERT INTO sync_runs(run_id,profile_id,trigger_type,scope_key,status,intent_fingerprint)
      VALUES(?,NULL,'manual','scope','queued',?)
    """, (run_id, f'intent-{run_id}'))
    conn.execute("UPDATE sync_runs SET profile_id='p1',status='running',started_at='t0' WHERE run_id=?", (run_id,))
    for index in range(job_count):
        job_id = f'{run_id}-j{index+1}'
        conn.execute("""
          INSERT INTO sync_report_plan_jobs(
            run_id,job_id,profile_id,report_plan_fingerprint,dataset_key,contract_id,
            ad_product,report_type,start_date,end_date,idempotency_key,request_fingerprint,request_json
          ) VALUES(?,?, 'p1',?,'search_term_daily','search-term-sp-v1','SPONSORED_PRODUCTS','spSearchTerm',
            '2026-08-12','2026-08-12',?,?, '{}')
        """, (run_id,job_id,fingerprint,f'idem-{job_id}',f'req-{job_id}'))
    conn.execute("UPDATE sync_runs SET report_plan_fingerprint=?,report_plan_job_count=? WHERE run_id=?", (fingerprint,job_count,run_id))
    for index in range(job_count):
        job_id = f'{run_id}-j{index+1}'
        conn.execute("""
          INSERT INTO report_jobs(
            job_id,run_id,profile_id,ad_product,report_type,start_date,end_date,status,
            idempotency_key,request_fingerprint,request_json
          ) VALUES(?,?, 'p1','SPONSORED_PRODUCTS','spSearchTerm','2026-08-12','2026-08-12',
            'queued',?,?, '{}')
        """, (job_id,run_id,f'idem-{job_id}',f'req-{job_id}'))
    return fingerprint


def make_ingested(conn, job_id, suffix='1'):
    conn.execute("UPDATE report_jobs SET status='requested' WHERE job_id=?", (job_id,))
    conn.execute("""
      UPDATE report_jobs
      SET amazon_report_id=?,amazon_created_at=?,status='processing'
      WHERE job_id=?
    """, (f'amz-{job_id}',f'source-{suffix}',job_id))
    conn.execute("UPDATE report_jobs SET status='ready' WHERE job_id=?", (job_id,))
    conn.execute("""
      UPDATE report_jobs
      SET r2_object_key=?,content_sha256=?,content_bytes=10
      WHERE job_id=?
    """, (f'raw/{job_id}','a'*64,job_id))
    conn.execute("""
      UPDATE report_jobs
      SET r2_initial_version=?,r2_initial_etag=?,downloaded_at=?,status='downloaded'
      WHERE job_id=?
    """, (f'v-{suffix}',f'etag-{suffix}',f'downloaded-{suffix}',job_id))
    conn.execute("UPDATE report_jobs SET raw_row_count=1 WHERE job_id=?", (job_id,))
    conn.execute("UPDATE report_jobs SET row_count=1,ingested_at=?,status='ingested' WHERE job_id=?", (f'ingested-{suffix}',job_id))


def make_downloaded(conn, job_id, suffix='2'):
    conn.execute("UPDATE report_jobs SET status='requested' WHERE job_id=?", (job_id,))
    conn.execute("""
      UPDATE report_jobs
      SET amazon_report_id=?,amazon_created_at=?,status='processing'
      WHERE job_id=?
    """, (f'amz-{job_id}',f'source-{suffix}',job_id))
    conn.execute("UPDATE report_jobs SET status='ready' WHERE job_id=?", (job_id,))
    conn.execute("UPDATE report_jobs SET r2_object_key=?,content_sha256=?,content_bytes=10 WHERE job_id=?", (f'raw/{job_id}','b'*64,job_id))
    conn.execute("""
      UPDATE report_jobs
      SET r2_initial_version=?,r2_initial_etag=?,downloaded_at=?,status='downloaded'
      WHERE job_id=?
    """, (f'v-{suffix}',f'etag-{suffix}',f'downloaded-{suffix}',job_id))
    conn.execute("UPDATE report_jobs SET raw_row_count=1 WHERE job_id=?", (job_id,))


def finalize(conn, run_id, status, stats_json, error_summary, completed_at='complete-t'):
    conn.execute("""
      UPDATE sync_runs
      SET status=?,stats_json=?,error_summary=?,completed_at=?
      WHERE run_id=?
    """, (status,stats_json,error_summary,completed_at,run_id))


def main():
    conn = sqlite3.connect(':memory:')
    conn.execute('PRAGMA foreign_keys=ON')
    apply_through(conn)

    # Nonterminal downloaded job blocks a forged succeeded receipt.
    fp = seed_plan_run(conn, 'run-a', fingerprint='a'*64)
    make_ingested(conn, 'run-a-j1', 'a1')
    make_downloaded(conn, 'run-a-j2', 'a2')
    expect_integrity(conn, """
      UPDATE sync_runs
      SET status='succeeded',stats_json=?,error_summary=NULL,completed_at='bad-success'
      WHERE run_id='run-a'
    """, (stats(fp,2,2,0,0),), code='SYNC_COMPLETION_NONTERMINAL_JOBS')

    # downloaded -> failed makes the plan terminal; exact mixed storage truth permits partial.
    conn.execute("UPDATE report_jobs SET status='failed' WHERE job_id='run-a-j2'")
    expect_integrity(conn, """
      UPDATE sync_runs
      SET status='partial',stats_json=?,error_summary='REPORT_PLAN_PARTIAL_FAILURE',completed_at='bad-counts'
      WHERE run_id='run-a'
    """, (stats(fp,2,2,0,0),), code='SYNC_COMPLETION_STORAGE_STATS_MISMATCH')
    finalize(conn, 'run-a', 'partial', stats(fp,2,1,1,0), 'REPORT_PLAN_PARTIAL_FAILURE', 'partial-t')
    row = conn.execute("SELECT status,error_summary,completed_at FROM sync_runs WHERE run_id='run-a'").fetchone()
    assert row == ('partial','REPORT_PLAN_PARTIAL_FAILURE','partial-t')
    expect_integrity(conn,
        "UPDATE sync_runs SET stats_json=? WHERE run_id='run-a'",
        (stats(fp,2,2,0,0),), code='SYNC_COMPLETION_RECEIPT_IMMUTABLE')

    # All ingested is the only succeeded shape.
    fp_b = seed_plan_run(conn, 'run-b', fingerprint='b'*64)
    make_ingested(conn, 'run-b-j1', 'b1')
    make_ingested(conn, 'run-b-j2', 'b2')
    expect_integrity(conn, """
      UPDATE sync_runs
      SET status='succeeded',stats_json=?,error_summary='synthetic-error',completed_at='bad'
      WHERE run_id='run-b'
    """, (stats(fp_b,2,2,0,0),), code='SYNC_COMPLETION_SUCCEEDED_INVALID')
    finalize(conn, 'run-b', 'succeeded', stats(fp_b,2,2,0,0), None, 'succeeded-t')

    # No ingested rows + all failed/cancelled produces failed only.
    fp_c = seed_plan_run(conn, 'run-c', fingerprint='c'*64)
    conn.execute("UPDATE report_jobs SET status='failed' WHERE job_id='run-c-j1'")
    conn.execute("UPDATE report_jobs SET status='cancelled' WHERE job_id='run-c-j2'")
    expect_integrity(conn, """
      UPDATE sync_runs
      SET status='partial',stats_json=?,error_summary='REPORT_PLAN_PARTIAL_FAILURE',completed_at='bad-partial'
      WHERE run_id='run-c'
    """, (stats(fp_c,2,0,1,1),), code='SYNC_COMPLETION_PARTIAL_INVALID')
    finalize(conn, 'run-c', 'failed', stats(fp_c,2,0,1,1), 'REPORT_PLAN_FAILED', 'failed-t')

    # requested + NULL Amazon report ID is nonterminal and can never be hidden by run completion.
    fp_d = seed_plan_run(conn, 'run-d', fingerprint='d'*64)
    make_ingested(conn, 'run-d-j1', 'd1')
    conn.execute("UPDATE report_jobs SET status='requested' WHERE job_id='run-d-j2'")
    expect_integrity(conn, """
      UPDATE sync_runs
      SET status='partial',stats_json=?,error_summary='REPORT_PLAN_PARTIAL_FAILURE',completed_at='ambiguous'
      WHERE run_id='run-d'
    """, (stats(fp_d,2,1,1,0),), code='SYNC_COMPLETION_NONTERMINAL_JOBS')

    assert conn.execute('PRAGMA foreign_key_check').fetchall() == []
    conn.close()
    print('phase-e sync completion migration invariants: PASS')


if __name__ == '__main__':
    main()
