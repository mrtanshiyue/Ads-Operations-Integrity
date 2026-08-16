#!/usr/bin/env python3
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / 'cloudflare' / 'foundation' / 'migrations' / 'store'

BASE_SCHEMA = r'''
PRAGMA foreign_keys = ON;
CREATE TABLE amazon_profiles (
  profile_id TEXT PRIMARY KEY, marketplace_id TEXT, country_code TEXT, currency_code TEXT, timezone TEXT,
  account_name TEXT, account_type TEXT, status TEXT NOT NULL DEFAULT 'active', source_updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE campaigns (
  campaign_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, portfolio_id TEXT, ad_product TEXT NOT NULL,
  name TEXT NOT NULL, state TEXT NOT NULL, targeting_type TEXT, bidding_strategy TEXT,
  daily_budget_micros INTEGER, start_date TEXT, end_date TEXT, source_updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, payload_hash TEXT,
  FOREIGN KEY(profile_id) REFERENCES amazon_profiles(profile_id)
);
CREATE TABLE ad_groups (
  ad_group_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, campaign_id TEXT NOT NULL,
  name TEXT NOT NULL, state TEXT NOT NULL, default_bid_micros INTEGER, source_updated_at TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, payload_hash TEXT,
  FOREIGN KEY(profile_id) REFERENCES amazon_profiles(profile_id), FOREIGN KEY(campaign_id) REFERENCES campaigns(campaign_id)
);
CREATE TABLE keywords (
  keyword_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, campaign_id TEXT NOT NULL, ad_group_id TEXT NOT NULL,
  keyword_text TEXT NOT NULL, normalized_keyword TEXT NOT NULL, match_type TEXT NOT NULL, state TEXT NOT NULL,
  bid_micros INTEGER, source_updated_at TEXT, synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, payload_hash TEXT,
  FOREIGN KEY(profile_id) REFERENCES amazon_profiles(profile_id), FOREIGN KEY(campaign_id) REFERENCES campaigns(campaign_id),
  FOREIGN KEY(ad_group_id) REFERENCES ad_groups(ad_group_id)
);
CREATE TABLE targets (
  target_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, campaign_id TEXT NOT NULL, ad_group_id TEXT NOT NULL,
  target_type TEXT, expression_json TEXT NOT NULL, expression_text TEXT, state TEXT NOT NULL, bid_micros INTEGER,
  source_updated_at TEXT, synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, payload_hash TEXT,
  FOREIGN KEY(profile_id) REFERENCES amazon_profiles(profile_id), FOREIGN KEY(campaign_id) REFERENCES campaigns(campaign_id),
  FOREIGN KEY(ad_group_id) REFERENCES ad_groups(ad_group_id)
);
CREATE TABLE sync_runs (
  run_id TEXT PRIMARY KEY, profile_id TEXT,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('scheduled','manual','recovery','backfill')),
  scope_key TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','partial','failed','cancelled')),
  requested_by TEXT, started_at TEXT, completed_at TEXT, stats_json TEXT, error_summary TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(profile_id) REFERENCES amazon_profiles(profile_id) ON DELETE SET NULL
);
CREATE TABLE report_jobs (
  job_id TEXT PRIMARY KEY, run_id TEXT, profile_id TEXT NOT NULL, amazon_report_id TEXT UNIQUE,
  ad_product TEXT NOT NULL, report_type TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','requested','processing','ready','downloaded','ingested','failed','cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE, request_fingerprint TEXT NOT NULL, request_json TEXT,
  r2_object_key TEXT, content_sha256 TEXT, content_bytes INTEGER, row_count INTEGER,
  amazon_created_at TEXT, downloaded_at TEXT, ingested_at TEXT, error_code TEXT, error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(run_id) REFERENCES sync_runs(run_id) ON DELETE SET NULL,
  FOREIGN KEY(profile_id) REFERENCES amazon_profiles(profile_id) ON DELETE RESTRICT
);
CREATE TABLE search_term_daily (
  row_key TEXT PRIMARY KEY, profile_id TEXT NOT NULL, report_date TEXT NOT NULL, ad_product TEXT NOT NULL,
  campaign_id TEXT NOT NULL, ad_group_id TEXT NOT NULL, keyword_id TEXT, target_id TEXT,
  search_term TEXT NOT NULL, normalized_search_term TEXT NOT NULL, match_type TEXT,
  impressions INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, cost_micros INTEGER NOT NULL DEFAULT 0,
  purchases INTEGER NOT NULL DEFAULT 0, units_sold INTEGER NOT NULL DEFAULT 0, sales_micros INTEGER NOT NULL DEFAULT 0,
  metrics_json TEXT, source_report_job_id TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(profile_id) REFERENCES amazon_profiles(profile_id), FOREIGN KEY(campaign_id) REFERENCES campaigns(campaign_id),
  FOREIGN KEY(ad_group_id) REFERENCES ad_groups(ad_group_id), FOREIGN KEY(keyword_id) REFERENCES keywords(keyword_id) ON DELETE SET NULL,
  FOREIGN KEY(target_id) REFERENCES targets(target_id) ON DELETE SET NULL,
  FOREIGN KEY(source_report_job_id) REFERENCES report_jobs(job_id) ON DELETE SET NULL
);
'''

def integrity_error(conn, sql, params=(), contains=None):
    try:
        conn.execute(sql, params)
    except sqlite3.IntegrityError as exc:
        if contains:
            assert contains in str(exc), (contains, str(exc))
        return
    raise AssertionError(f'expected IntegrityError: {contains or sql}')

def apply_phase_migrations(conn):
    conn.executescript((MIGRATIONS / '0005_store_report_authority.sql').read_text())
    conn.executescript((MIGRATIONS / '0006_store_ingestion_staging.sql').read_text())

def seed_entities(conn):
    conn.execute("INSERT INTO amazon_profiles(profile_id) VALUES('p1')")
    conn.execute("INSERT INTO amazon_profiles(profile_id) VALUES('p2')")
    conn.execute("INSERT INTO campaigns(campaign_id,profile_id,ad_product,name,state) VALUES('c1','p1','SPONSORED_PRODUCTS','C1','ENABLED')")
    conn.execute("INSERT INTO campaigns(campaign_id,profile_id,ad_product,name,state) VALUES('c2','p2','SPONSORED_PRODUCTS','C2','ENABLED')")
    conn.execute("INSERT INTO ad_groups(ad_group_id,profile_id,campaign_id,name,state) VALUES('a1','p1','c1','A1','ENABLED')")
    conn.execute("INSERT INTO ad_groups(ad_group_id,profile_id,campaign_id,name,state) VALUES('a2','p2','c2','A2','ENABLED')")
    conn.execute("INSERT INTO keywords(keyword_id,profile_id,campaign_id,ad_group_id,keyword_text,normalized_keyword,match_type,state) VALUES('k1','p1','c1','a1','reading glasses','reading glasses','BROAD','ENABLED')")
    conn.execute("INSERT INTO targets(target_id,profile_id,campaign_id,ad_group_id,expression_json,state) VALUES('t1','p1','c1','a1','[]','ENABLED')")

def make_run(conn, run_id='run1', profile='p1'):
    conn.execute("INSERT INTO sync_runs(run_id,profile_id,trigger_type,scope_key,status,intent_fingerprint) VALUES(?,NULL,'manual','scope','queued',?)", (run_id, f'fp-{run_id}'))
    conn.execute("UPDATE sync_runs SET profile_id=?, status='running' WHERE run_id=?", (profile, run_id))

def make_downloaded_job(conn, job_id='j1', run_id='run1', profile='p1', start='2026-08-12', end='2026-08-12'):
    conn.execute('''INSERT INTO report_jobs(
      job_id,run_id,profile_id,ad_product,report_type,start_date,end_date,status,idempotency_key,request_fingerprint,request_json
    ) VALUES(?,?,?,?,?,?,?,'queued',?,?,?)''',
    (job_id, run_id, profile, 'SPONSORED_PRODUCTS', 'spSearchTerm', start, end, f'idem-{job_id}', f'reqfp-{job_id}', '{}'))
    conn.execute("UPDATE report_jobs SET status='requested' WHERE job_id=?", (job_id,))
    conn.execute("UPDATE report_jobs SET amazon_report_id=?, amazon_created_at='2026-08-15T00:00:00Z', status='processing' WHERE job_id=?", (f'amz-{job_id}', job_id))
    conn.execute("UPDATE report_jobs SET status='ready' WHERE job_id=?", (job_id,))
    conn.execute("""UPDATE report_jobs SET
      r2_object_key=?, content_sha256=?, content_bytes=100,
      r2_initial_version=?, r2_initial_etag=?, downloaded_at='2026-08-15T00:10:00Z', status='downloaded'
      WHERE job_id=?""", (f'raw/{job_id}.json.gz', 'a'*64, f'ver-{job_id}', f'etag-{job_id}', job_id))

def search_insert(conn, **overrides):
    row = dict(
      row_key='row1', profile_id='p1', report_date='2026-08-12', ad_product='SPONSORED_PRODUCTS',
      campaign_id='c1', ad_group_id='a1', keyword_id='k1', target_id=None,
      search_term='Reading Glasses', normalized_search_term='reading glasses', match_type='BROAD',
      source_report_job_id='j1', source_keyword_type='BROAD'
    )
    row.update(overrides)
    conn.execute('''INSERT INTO search_term_daily(
      row_key,profile_id,report_date,ad_product,campaign_id,ad_group_id,keyword_id,target_id,
      search_term,normalized_search_term,match_type,source_report_job_id,source_keyword_type
    ) VALUES(:row_key,:profile_id,:report_date,:ad_product,:campaign_id,:ad_group_id,:keyword_id,:target_id,
      :search_term,:normalized_search_term,:match_type,:source_report_job_id,:source_keyword_type)''', row)

def main():
    conn = sqlite3.connect(':memory:')
    conn.execute('PRAGMA foreign_keys=ON')
    conn.executescript(BASE_SCHEMA)
    apply_phase_migrations(conn)
    seed_entities(conn)

    conn.execute("INSERT INTO sync_runs(run_id,profile_id,trigger_type,scope_key,status,intent_fingerprint) VALUES('run0',NULL,'manual','scope','queued','fp0')")
    integrity_error(conn, "UPDATE sync_runs SET profile_id='p1' WHERE run_id='run0'", contains='SYNC_CANONICAL_PROFILE_ASSIGNMENT_INVALID')
    conn.execute("UPDATE sync_runs SET profile_id='p1', status='running' WHERE run_id='run0'")
    integrity_error(conn, "UPDATE sync_runs SET profile_id='p2' WHERE run_id='run0'", contains='SYNC_CANONICAL_PROFILE_IMMUTABLE')
    integrity_error(conn, "UPDATE sync_runs SET intent_fingerprint='other' WHERE run_id='run0'", contains='SYNC_INTENT_FINGERPRINT_IMMUTABLE')
    integrity_error(conn, "UPDATE sync_runs SET status='queued' WHERE run_id='run0'", contains='SYNC_RUN_STATUS_TRANSITION_INVALID')

    make_run(conn, 'run1')

    conn.execute("""INSERT INTO report_jobs(job_id,run_id,profile_id,ad_product,report_type,start_date,end_date,status,idempotency_key,request_fingerprint,request_json)
      VALUES('jl','run1','p1','SPONSORED_PRODUCTS','spSearchTerm','2026-08-12','2026-08-12','queued','idem-jl','fp-jl','{}')""")
    conn.execute("UPDATE report_jobs SET status='requested' WHERE job_id='jl'")
    integrity_error(conn, "UPDATE report_jobs SET status='processing' WHERE job_id='jl'", contains='REPORT_JOB_AMAZON_REPORT_RECEIPT_REQUIRED')
    conn.execute("UPDATE report_jobs SET amazon_report_id='amz-jl', amazon_created_at='2026-08-15T00:00:00Z', status='processing' WHERE job_id='jl'")
    conn.execute("UPDATE report_jobs SET status='ready' WHERE job_id='jl'")
    integrity_error(conn, "UPDATE report_jobs SET status='downloaded' WHERE job_id='jl'", contains='REPORT_JOB_RAW_AUTHORITY_REQUIRED')
    conn.execute("""UPDATE report_jobs SET r2_object_key='raw/jl',content_sha256=?,content_bytes=10,
      r2_initial_version='v1',r2_initial_etag='e1',downloaded_at='t',status='downloaded' WHERE job_id='jl'""", ('b'*64,))
    conn.execute("UPDATE report_jobs SET raw_row_count=1 WHERE job_id='jl'")
    integrity_error(conn, "INSERT INTO report_fact_stage(job_id,dataset_key,source_row_ordinal,logical_row_key,canonical_row_json) VALUES('jl','search_term_daily',0,'jl-rk0','{}')", contains='REPORT_FACT_STAGE_FROZEN')
    integrity_error(conn, "UPDATE report_jobs SET content_sha256='changed' WHERE job_id='jl'", contains='REPORT_JOB_CONTENT_SHA256_IMMUTABLE')
    integrity_error(conn, "UPDATE report_jobs SET status='ready' WHERE job_id='jl'", contains='REPORT_JOB_STATUS_TRANSITION_INVALID')
    conn.execute("UPDATE report_jobs SET row_count=1,ingested_at='t2',status='ingested' WHERE job_id='jl'")
    integrity_error(conn, "UPDATE report_jobs SET status='downloaded' WHERE job_id='jl'", contains='REPORT_JOB_STATUS_TRANSITION_INVALID')

    make_downloaded_job(conn, 'j1', 'run1')
    search_insert(conn, row_key='kw-row')
    search_insert(conn, row_key='target-row', keyword_id=None, target_id='t1', source_keyword_type='TARGETING_EXPRESSION', match_type=None)

    for name, overrides, code in [
      ('both-null', dict(keyword_id=None,target_id=None), 'SEARCH_TERM_TARGETING_XOR_INVALID'),
      ('both-set', dict(keyword_id='k1',target_id='t1'), 'SEARCH_TERM_TARGETING_XOR_INVALID'),
      ('type-mismatch', dict(keyword_id=None,target_id='t1',source_keyword_type='BROAD'), 'SEARCH_TERM_KEYWORD_TYPE_PATH_MISMATCH'),
      ('campaign-mismatch', dict(campaign_id='c2'), 'SEARCH_TERM_CAMPAIGN_HIERARCHY_MISMATCH'),
      ('adgroup-mismatch', dict(ad_group_id='a2'), 'SEARCH_TERM_AD_GROUP_HIERARCHY_MISMATCH'),
      ('job-required', dict(source_report_job_id=None), 'SEARCH_TERM_SOURCE_REPORT_JOB_REQUIRED'),
      ('date-range', dict(report_date='2026-08-13'), 'SEARCH_TERM_SOURCE_REPORT_JOB_MISMATCH'),
    ]:
      try:
        search_insert(conn, row_key=f'bad-{name}', **overrides)
      except sqlite3.IntegrityError as exc:
        assert code in str(exc), (name, code, str(exc))
      else:
        raise AssertionError(f'{name} unexpectedly accepted')

    integrity_error(conn, "UPDATE search_term_daily SET source_report_job_id=NULL WHERE row_key='kw-row'", contains='SEARCH_TERM_SOURCE_REPORT_JOB_IMMUTABLE')
    integrity_error(conn, "UPDATE search_term_daily SET source_report_job_id=NULL, source_keyword_type=NULL WHERE row_key='kw-row'", contains='SEARCH_TERM_SOURCE_KEYWORD_TYPE_IMMUTABLE')

    conn.execute("INSERT INTO report_fact_stage(job_id,dataset_key,source_row_ordinal,logical_row_key,canonical_row_json) VALUES('j1','search_term_daily',0,'rk1','{}')")
    integrity_error(conn, "INSERT INTO report_fact_stage(job_id,dataset_key,source_row_ordinal,logical_row_key,canonical_row_json) VALUES('j1','search_term_daily',0,'rk2','{}')")
    integrity_error(conn, "INSERT INTO report_fact_stage(job_id,dataset_key,source_row_ordinal,logical_row_key,canonical_row_json) VALUES('j1','search_term_daily',1,'rk1','{}')")

    conn.execute("INSERT INTO amazon_entity_stage(run_id,profile_id,entity_type,source_row_ordinal,entity_id,canonical_entity_json) VALUES('run1','p1','campaign',0,'c1','{}')")
    conn.execute("INSERT INTO amazon_entity_stage(run_id,profile_id,entity_type,source_row_ordinal,entity_id,canonical_entity_json) VALUES('run1','p1','keyword',0,'k1','{}')")
    integrity_error(conn, "INSERT INTO amazon_entity_stage(run_id,profile_id,entity_type,source_row_ordinal,entity_id,canonical_entity_json) VALUES('run1','p2','target',0,'t-bad','{}')", contains='ENTITY_STAGE_SYNC_RUN_PROFILE_MISMATCH')
    integrity_error(conn, "INSERT INTO amazon_entity_stage(run_id,profile_id,entity_type,source_row_ordinal,entity_id,canonical_entity_json) VALUES('run1','p1','campaign',1,'c1','{}')")
    conn.execute("INSERT INTO amazon_entity_snapshot_receipts(run_id,profile_id,snapshot_synced_at,campaign_count,ad_group_count,keyword_count,target_count) VALUES('run1','p1','t',1,1,1,1)")
    integrity_error(conn, "UPDATE amazon_entity_snapshot_receipts SET campaign_count=2 WHERE run_id='run1'", contains='ENTITY_SNAPSHOT_RECEIPT_IMMUTABLE')

    make_downloaded_job(conn, 'jnew', 'run1')
    conn.commit()
    conn.execute('BEGIN')
    try:
      conn.execute("DELETE FROM search_term_daily WHERE profile_id='p1' AND report_date='2026-08-12' AND ad_product='SPONSORED_PRODUCTS'")
      search_insert(conn, row_key='new-row', source_report_job_id='jnew', search_term='New Term', normalized_search_term='new term')
      conn.execute("UPDATE report_jobs SET status='ingested' WHERE job_id='jnew'")
      conn.commit()
      raise AssertionError('rollback failure was not triggered')
    except sqlite3.IntegrityError as exc:
      assert 'REPORT_JOB_INGESTION_RECEIPT_REQUIRED' in str(exc)
      conn.rollback()
    rows = conn.execute("SELECT row_key FROM search_term_daily ORDER BY row_key").fetchall()
    assert ('kw-row',) in rows and ('target-row',) in rows and ('new-row',) not in rows, rows

    conn.execute('BEGIN')
    conn.execute("DELETE FROM search_term_daily WHERE profile_id='p1' AND report_date='2026-08-12' AND ad_product='SPONSORED_PRODUCTS'")
    search_insert(conn, row_key='new-row', source_report_job_id='jnew', search_term='New Term', normalized_search_term='new term')
    conn.execute("UPDATE report_jobs SET raw_row_count=1,row_count=1,ingested_at='t3',status='ingested' WHERE job_id='jnew'")
    conn.execute("DELETE FROM report_fact_stage WHERE job_id='jnew'")
    conn.commit()
    rows = conn.execute("SELECT row_key,source_report_job_id FROM search_term_daily").fetchall()
    assert rows == [('new-row','jnew')], rows

    assert conn.execute('PRAGMA foreign_key_check').fetchall() == []
    print('phase-e migration invariants: PASS')

if __name__ == '__main__':
    main()
