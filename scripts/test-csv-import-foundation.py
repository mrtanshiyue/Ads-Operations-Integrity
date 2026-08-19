#!/usr/bin/env python3
import sqlite3
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / 'cloudflare/foundation/migrations/store'


def expect_integrity(conn, sql, params=(), contains=None):
    try:
        conn.execute(sql, params)
        raise AssertionError('expected sqlite integrity failure')
    except sqlite3.IntegrityError as exc:
        if contains is not None:
            assert contains in str(exc), (contains, str(exc))


def insert_source_receipt(conn, import_id, sha256, content_bytes, file_name, uploaded_at, object_suffix=None):
    suffix = object_suffix or import_id
    conn.execute('''INSERT INTO csv_import_source_objects(
      import_id,source_object_id,source_kind,r2_binding_key,object_key,
      content_sha256,content_bytes,content_type,source_file_name,importer_user_id,uploaded_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)''', (
      import_id,
      f'csv-source-{suffix}',
      'manual_csv_upload',
      'DATA_BUCKET',
      f'csv/raw/test/{suffix}',
      sha256,
      content_bytes,
      'text/csv',
      file_name,
      'user-test',
      uploaded_at,
    ))


def main():
    with tempfile.TemporaryDirectory(prefix='csv-import-foundation-') as tmp:
        conn = sqlite3.connect(Path(tmp) / 'store.sqlite')
        conn.execute('PRAGMA foreign_keys=ON')
        for migration in sorted(MIGRATIONS.glob('*.sql')):
            conn.executescript(migration.read_text(encoding='utf-8'))

        # New authorities must fail closed unless immutable raw-source evidence exists first.
        expect_integrity(conn, '''INSERT INTO csv_import_batches(
          import_id,source_file_name,report_type,report_start_date,report_end_date,
          content_sha256,content_bytes,schema_version,row_count,accepted_rows,rejected_rows,
          duplicate_status,status,validation_summary_json,uploaded_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
          'imp-no-source','missing.csv','spSearchTerm','2026-08-10','2026-08-10','f'*64,50,
          'csv-import-v1',1,1,0,'unique','validated','{}','2026-08-18T00:59:00Z'
        ), contains='CSV_IMPORT_SOURCE_OBJECT_REQUIRED')

        insert_source_receipt(
          conn, 'imp-1', 'a'*64, 100, 'report.csv', '2026-08-18T01:00:00Z'
        )
        conn.execute('''INSERT INTO csv_import_batches(
          import_id,source_file_name,report_type,report_start_date,report_end_date,
          content_sha256,content_bytes,schema_version,row_count,accepted_rows,rejected_rows,
          duplicate_status,status,validation_summary_json,uploaded_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
          'imp-1','report.csv','spSearchTerm','2026-08-12','2026-08-12','a'*64,100,
          'csv-import-v1',1,1,0,'unique','validated','{"rowCount":1}','2026-08-18T01:00:00Z'
        ))
        conn.execute('''INSERT INTO csv_search_term_stage(import_id,source_row_ordinal,logical_row_key,canonical_row_json)
          VALUES('imp-1',0,'rk-1','{"rowKey":"rk-1","sourceRowOrdinal":0}')''')

        expect_integrity(conn, "UPDATE csv_import_batches SET content_bytes=101 WHERE import_id='imp-1'")

        # Preserve the original duplicate-authority constraint test while satisfying the new source gate first.
        insert_source_receipt(
          conn, 'imp-2', 'a'*64, 100, 'same.csv', '2026-08-18T01:01:00Z', object_suffix='imp-2-duplicate-fixture'
        )
        expect_integrity(conn, '''INSERT INTO csv_import_batches(
          import_id,source_file_name,report_type,report_start_date,report_end_date,
          content_sha256,content_bytes,schema_version,row_count,accepted_rows,rejected_rows,
          duplicate_status,status,validation_summary_json,uploaded_at
        ) VALUES('imp-2','same.csv','spSearchTerm','2026-08-12','2026-08-12',?,100,'csv-import-v1',1,1,0,'unique','validated','{}','2026-08-18T01:01:00Z')''', ('a'*64,))

        expect_integrity(conn, "INSERT INTO csv_search_term_stage(import_id,source_row_ordinal,logical_row_key,canonical_row_json) VALUES('imp-1',1,'rk-x','{\"rowKey\":\"wrong\",\"sourceRowOrdinal\":1}')")
        expect_integrity(conn, "UPDATE csv_search_term_stage SET logical_row_key='rk-2' WHERE import_id='imp-1' AND source_row_ordinal=0")
        expect_integrity(conn, "DELETE FROM csv_search_term_stage WHERE import_id='imp-1'")

        conn.execute("UPDATE csv_import_batches SET status='published', published_at='2026-08-18T01:02:00Z' WHERE import_id='imp-1'")
        expect_integrity(conn, "UPDATE csv_import_batches SET status='rejected' WHERE import_id='imp-1'")
        expect_integrity(conn, "UPDATE csv_import_batches SET published_at='2026-08-18T01:03:00Z' WHERE import_id='imp-1'")

        conn.execute('''INSERT INTO csv_search_term_daily(
          row_key,report_date,campaign_name,ad_group_name,targeting,search_term,normalized_search_term,
          source_import_id,source_row_ordinal
        ) VALUES('rk-1','2026-08-12','Campaign','Ad Group','reading glasses','reading glasses men','reading glasses men','imp-1',0)''')
        expect_integrity(conn, "UPDATE csv_search_term_daily SET campaign_name='Other' WHERE row_key='rk-1'")
        conn.execute("UPDATE csv_search_term_daily SET clicks=3, updated_at='2026-08-18T01:04:00Z' WHERE row_key='rk-1'")
        conn.execute("DELETE FROM csv_search_term_stage WHERE import_id='imp-1'")
        assert conn.execute("SELECT COUNT(*) FROM csv_search_term_stage WHERE import_id='imp-1'").fetchone()[0] == 0

        expect_integrity(
          conn,
          "UPDATE csv_import_source_objects SET r2_etag='mutated' WHERE import_id='imp-1'",
          contains='CSV_IMPORT_SOURCE_OBJECT_IMMUTABLE',
        )
        expect_integrity(
          conn,
          "DELETE FROM csv_import_source_objects WHERE import_id='imp-1'",
          contains='CSV_IMPORT_SOURCE_OBJECT_IMMUTABLE',
        )

        assert not conn.execute('PRAGMA foreign_key_check').fetchall()
        conn.close()

    print('{"ok":true,"csv_import_foundation":true,"persistent_source_required":true,"source_receipt_immutable":true}')


if __name__ == '__main__':
    main()
