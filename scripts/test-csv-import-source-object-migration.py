import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / 'cloudflare' / 'foundation' / 'migrations' / 'store'

conn = sqlite3.connect(':memory:')
conn.execute('PRAGMA foreign_keys = ON')
conn.executescript((MIGRATIONS / '0017_store_csv_import_foundation.sql').read_text())
conn.executescript((MIGRATIONS / '0021_store_csv_import_source_objects.sql').read_text())

columns = {row[1] for row in conn.execute('PRAGMA table_info(csv_import_source_objects)')}
required = {
    'import_id', 'source_object_id', 'source_kind', 'r2_binding_key', 'object_key',
    'content_sha256', 'content_bytes', 'content_type', 'source_file_name',
    'importer_user_id', 'uploaded_at', 'r2_etag', 'r2_version', 'created_at',
}
assert required <= columns

HASH = 'a' * 64
UPLOADED = '2026-08-19T02:40:00.000Z'

conn.execute(
    '''INSERT INTO csv_import_source_objects(
         import_id, source_object_id, object_key, content_sha256, content_bytes,
         content_type, source_file_name, importer_user_id, uploaded_at
       ) VALUES(?,?,?,?,?,?,?,?,?)''',
    ('csv-ok', f'csv-source-{HASH}', f'csv/raw/store-01/spSearchTerm/sha256/aa/{HASH}', HASH, 10,
     'text/csv', 'search-terms.csv', 'user-dev-owner', UPLOADED),
)
conn.execute(
    '''INSERT INTO csv_import_batches(
         import_id, source_file_name, report_type, report_start_date, report_end_date,
         content_sha256, content_bytes, schema_version, row_count, accepted_rows,
         rejected_rows, duplicate_status, status, validation_summary_json, uploaded_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
    ('csv-ok', 'search-terms.csv', 'spSearchTerm', '2026-08-01', '2026-08-01', HASH, 10,
     'csv-import-v1', 1, 0, 1, 'unique', 'rejected', '{}', UPLOADED),
)

for sql in (
    "UPDATE csv_import_source_objects SET r2_etag='changed' WHERE import_id='csv-ok'",
    "DELETE FROM csv_import_source_objects WHERE import_id='csv-ok'",
):
    try:
        conn.execute(sql)
        raise AssertionError('source receipt mutation unexpectedly succeeded')
    except sqlite3.IntegrityError as exc:
        assert 'CSV_IMPORT_SOURCE_OBJECT_IMMUTABLE' in str(exc)

try:
    conn.execute(
        '''INSERT INTO csv_import_batches(
             import_id, source_file_name, report_type, report_start_date, report_end_date,
             content_sha256, content_bytes, schema_version, row_count, accepted_rows,
             rejected_rows, duplicate_status, status, validation_summary_json, uploaded_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
        ('csv-no-source', 'missing.csv', 'spSearchTerm', '2026-08-01', '2026-08-01', 'b' * 64, 5,
         'csv-import-v1', 1, 0, 1, 'unique', 'rejected', '{}', UPLOADED),
    )
    raise AssertionError('batch authority without source receipt unexpectedly succeeded')
except sqlite3.IntegrityError as exc:
    assert 'CSV_IMPORT_SOURCE_OBJECT_REQUIRED' in str(exc)

conn.execute(
    '''INSERT INTO csv_import_source_objects(
         import_id, source_object_id, object_key, content_sha256, content_bytes,
         source_file_name, importer_user_id, uploaded_at
       ) VALUES(?,?,?,?,?,?,?,?)''',
    ('csv-mismatch', 'csv-source-mismatch', 'csv/raw/store-01/mismatch', 'c' * 64, 7,
     'mismatch.csv', 'user-dev-owner', UPLOADED),
)
try:
    conn.execute(
        '''INSERT INTO csv_import_batches(
             import_id, source_file_name, report_type, report_start_date, report_end_date,
             content_sha256, content_bytes, schema_version, row_count, accepted_rows,
             rejected_rows, duplicate_status, status, validation_summary_json, uploaded_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
        ('csv-mismatch', 'mismatch.csv', 'spSearchTerm', '2026-08-01', '2026-08-01', 'd' * 64, 7,
         'csv-import-v1', 1, 0, 1, 'unique', 'rejected', '{}', UPLOADED),
    )
    raise AssertionError('mismatched source receipt unexpectedly authorized batch')
except sqlite3.IntegrityError as exc:
    assert 'CSV_IMPORT_SOURCE_OBJECT_REQUIRED' in str(exc)

print(json.dumps({
    'ok': True,
    'migration': '0021_store_csv_import_source_objects.sql',
    'appendOnly': True,
    'batchRequiresMatchingSourceReceipt': True,
    'remoteWrites': False,
}))
