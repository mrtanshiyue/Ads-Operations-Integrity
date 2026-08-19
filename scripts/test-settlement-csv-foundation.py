#!/usr/bin/env python3
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / 'cloudflare/foundation/migrations/store/0024_store_settlement_csv_foundation.sql'


def expect_integrity(conn, sql, contains):
    try:
        conn.execute(sql)
        raise AssertionError(f'expected integrity failure containing {contains}')
    except sqlite3.IntegrityError as exc:
        assert contains in str(exc), (contains, str(exc))


def main():
    conn = sqlite3.connect(':memory:')
    conn.execute('PRAGMA foreign_keys=ON')
    conn.executescript(MIGRATION.read_text(encoding='utf-8'))

    expect_integrity(conn, '''
      INSERT INTO settlement_import_batches(
        import_id,source_file_name,report_type,currency_code,report_start_date,report_end_date,
        content_sha256,content_bytes,schema_version,row_count,accepted_rows,rejected_rows,
        duplicate_status,status,validation_summary_json,uploaded_at
      ) VALUES(
        'missing-source','report.csv','amazonSettlementTransaction','USD','2026-06-01','2026-06-30',
        'a'||replace(hex(zeroblob(31)),'00','a'),10,'settlement-csv-import-v1',1,1,0,
        'unique','validated','{}','2026-08-19T10:00:00Z'
      )
    ''', 'SETTLEMENT_SOURCE_OBJECT_REQUIRED')

    sha = 'a' * 64
    conn.execute('''
      INSERT INTO settlement_import_source_objects(
        import_id,source_object_id,source_kind,r2_binding_key,object_key,
        content_sha256,content_bytes,content_type,source_file_name,importer_user_id,uploaded_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ''', (
        'imp-1','settlement-source-a','manual_csv_upload','DATA_BUCKET','csv/raw/store-01/settlement/a',
        sha,100,'text/csv','settlement.csv','user-test','2026-08-19T10:00:00Z',
    ))
    conn.execute('''
      INSERT INTO settlement_import_batches(
        import_id,source_file_name,report_type,marketplace,currency_code,
        report_start_date,report_end_date,content_sha256,content_bytes,schema_version,
        row_count,accepted_rows,rejected_rows,duplicate_status,status,validation_summary_json,uploaded_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ''', (
        'imp-1','settlement.csv','amazonSettlementTransaction','amazon.com','USD',
        '2026-06-01','2026-06-30',sha,100,'settlement-csv-import-v1',
        1,1,0,'unique','validated','{}','2026-08-19T10:00:00Z',
    ))

    authority = conn.execute('''
      SELECT data_class,provenance_class,authority_version
      FROM settlement_import_authority WHERE import_id='imp-1'
    ''').fetchone()
    assert authority == ('unclassified','exact_source_object',1), authority
    assert conn.execute("SELECT COUNT(*) FROM settlement_import_authority_events WHERE import_id='imp-1'").fetchone()[0] == 1

    expect_integrity(conn, '''
      INSERT INTO settlement_transaction_stage(import_id,source_row_ordinal,logical_row_key,canonical_row_json)
      VALUES('imp-1',0,'rk-1','{"rowKey":"rk-1","sourceRowOrdinal":0,"orderCity":"Seattle"}')
    ''', 'SETTLEMENT_STAGE_LOCATION_DATA_FORBIDDEN')

    conn.execute('''
      INSERT INTO settlement_transaction_stage(import_id,source_row_ordinal,logical_row_key,canonical_row_json)
      VALUES('imp-1',0,'rk-1','{"rowKey":"rk-1","sourceRowOrdinal":0}')
    ''')
    conn.execute('''
      INSERT INTO settlement_transactions(
        row_key,posted_at,posted_date,transaction_type,marketplace,
        product_sales_micros,selling_fees_micros,total_micros,currency_code,
        source_import_id,source_row_ordinal
      ) VALUES(
        'rk-1','Jun 1, 2026 1:00:00 AM PDT','2026-06-01','Order','amazon.com',
        10000000,-1000000,9000000,'USD','imp-1',0
      )
    ''')

    expect_integrity(conn, "UPDATE settlement_import_batches SET status='published',published_at='2026-08-19T10:01:00Z' WHERE import_id='imp-1'", 'SETTLEMENT_RECONCILIATION_REQUIRED')

    conn.execute('''
      INSERT INTO settlement_import_reconciliation_receipts(
        import_id,row_count,component_sum_micros,reported_total_micros,difference_micros,
        mismatch_rows,status,evidence_json
      ) VALUES('imp-1',1,9000000,9000000,0,0,'pass','{}')
    ''')
    conn.execute("UPDATE settlement_import_batches SET status='published',published_at='2026-08-19T10:01:00Z' WHERE import_id='imp-1'")
    conn.execute("DELETE FROM settlement_transaction_stage WHERE import_id='imp-1'")

    assert conn.execute("SELECT COUNT(*) FROM settlement_business_transactions").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM settlement_governed_transactions").fetchone()[0] == 0

    conn.execute('''
      UPDATE settlement_import_authority
      SET data_class='business',authority_version=2,actor_user_id='user-test',
          reason='real_production_business_source',evidence_json='{"verified":true}',
          updated_at='2026-08-19T10:02:00Z'
      WHERE import_id='imp-1'
    ''')
    assert conn.execute("SELECT COUNT(*) FROM settlement_business_transactions").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM settlement_governed_transactions").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM settlement_import_authority_events WHERE import_id='imp-1'").fetchone()[0] == 2

    expect_integrity(conn, "UPDATE settlement_import_source_objects SET r2_etag='changed' WHERE import_id='imp-1'", 'SETTLEMENT_SOURCE_OBJECT_IMMUTABLE')
    expect_integrity(conn, "UPDATE settlement_import_reconciliation_receipts SET status='fail' WHERE import_id='imp-1'", 'SETTLEMENT_RECONCILIATION_IMMUTABLE')
    expect_integrity(conn, "DELETE FROM settlement_import_authority WHERE import_id='imp-1'", 'SETTLEMENT_AUTHORITY_DELETE_FORBIDDEN')
    assert conn.execute('PRAGMA foreign_key_check').fetchall() == []

    print('settlement D1 foundation invariants: PASS')


if __name__ == '__main__':
    main()
