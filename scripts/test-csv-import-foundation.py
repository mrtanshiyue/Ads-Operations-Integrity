#!/usr/bin/env python3
import sqlite3
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / 'cloudflare/foundation/migrations/store'


def expect_integrity(conn, sql, params=()):
    try:
        conn.execute(sql, params)
        raise AssertionError('expected sqlite integrity failure')
    except sqlite3.IntegrityError:
        pass


def main():
    with tempfile.TemporaryDirectory(prefix='csv-import-foundation-') as tmp:
        conn = sqlite3.connect(Path(tmp) / 'store.sqlite')
        conn.execute('PRAGMA foreign_keys=ON')
        for migration in sorted(MIGRATIONS.glob('*.sql')):
            conn.executescript(migration.read_text(encoding='utf-8'))

        conn.execute('''INSERT INTO csv_import_batches(
          import_id,source_file_name,report_type,report_start_date,report_end_date,
          content_sha256,content_bytes,schema_version,row_count,accepted_rows,rejected_rows,
          duplicate_status,status,validation_summary_json,uploaded_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
          'imp-1','report.csv','spSearchTerm','2026-08-12','2026-08-12','a'*64,100,
          'csv-import-v1',1,1,0,'unique','validated','{"rowCount":1}','2026-08-18T01:00:00Z'
        ))
        conn.execute('''INSERT INTO csv_search_term_stage(import_id,source_row_ordinal,logical_row_key,canonical_row_json)
          VALUES('imp-1',0,'rk-1','{"rowKey":"rk-1"}')''')

        expect_integrity(conn, "UPDATE csv_import_batches SET content_bytes=101 WHERE import_id='imp-1'")
        expect_integrity(conn, '''INSERT INTO csv_import_batches(
          import_id,source_file_name,report_type,report_start_date,report_end_date,
          content_sha256,content_bytes,schema_version,row_count,accepted_rows,rejected_rows,
          duplicate_status,status,validation_summary_json,uploaded_at
        ) VALUES('imp-2','same.csv','spSearchTerm','2026-08-12','2026-08-12',?,100,'csv-import-v1',1,1,0,'unique','validated','{}','2026-08-18T01:01:00Z')''', ('a'*64,))
        expect_integrity(conn, "INSERT INTO csv_search_term_stage(import_id,source_row_ordinal,logical_row_key,canonical_row_json) VALUES('imp-1',1,'rk-x','{\"rowKey\":\"wrong\"}')")

        conn.execute("UPDATE csv_import_batches SET status='published', published_at='2026-08-18T01:02:00Z' WHERE import_id='imp-1'")
        expect_integrity(conn, "UPDATE csv_import_batches SET status='rejected' WHERE import_id='imp-1'")
        assert not conn.execute('PRAGMA foreign_key_check').fetchall()
        conn.close()

    print('{"ok":true,"csv_import_foundation":true}')


if __name__ == '__main__':
    main()
