import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / 'cloudflare' / 'foundation' / 'migrations' / 'store'

conn = sqlite3.connect(':memory:')
conn.execute('PRAGMA foreign_keys = ON')

# Reproduce a true legacy batch: it existed before 0021 introduced mandatory source-object receipts.
conn.executescript((MIGRATIONS / '0017_store_csv_import_foundation.sql').read_text())
BATCH_SHA = 'a' * 64
RAW_SHA = 'b' * 64
EVIDENCE_SHA = 'c' * 64
UPLOADED = '2026-07-01T00:00:00.000Z'

conn.execute(
    '''INSERT INTO csv_import_batches(
         import_id, source_file_name, report_type, report_start_date, report_end_date,
         content_sha256, content_bytes, schema_version, row_count, accepted_rows,
         rejected_rows, duplicate_status, status, validation_summary_json, uploaded_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
    ('csv-legacy', '202606 (1).csv', 'spSearchTerm', '2026-06-01', '2026-06-30',
     BATCH_SHA, 3202492, 'csv-import-v1', 8753, 8753, 0, 'unique', 'accepted', '{}', UPLOADED),
)

conn.executescript((MIGRATIONS / '0021_store_csv_import_source_objects.sql').read_text())
conn.executescript((MIGRATIONS / '0022_store_csv_import_authority.sql').read_text())
conn.execute(
    '''INSERT INTO csv_import_authority(
         import_id, data_class, provenance_class, authority_version,
         actor_user_id, reason, evidence_json, created_at, updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?)''',
    ('csv-legacy', 'business', 'legacy_batch_only', 1, 'user-owner',
     'legacy business import classified', '{}', UPLOADED, UPLOADED),
)
conn.executescript((MIGRATIONS / '0023_store_csv_legacy_reconciliation_receipts.sql').read_text())

# A normalized receipt that does not reproduce the canonical batch must fail closed.
try:
    conn.execute(
        '''INSERT INTO csv_import_reconciliation_receipts(
             reconciliation_id, import_id, source_file_name,
             raw_content_sha256, raw_content_bytes,
             normalized_content_sha256, normalized_content_bytes,
             normalization_transform, evidence_sha256, evidence_json,
             actor_user_id, reason, reconciled_at
           ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)''',
        ('rec-bad', 'csv-legacy', '202606 (1).csv', RAW_SHA, 3202495,
         'd' * 64, 3202492, 'utf8_bom_strip_v1', 'e' * 64, '{}',
         'user-owner', 'bad normalized hash', '2026-08-19T08:00:00Z'),
    )
    raise AssertionError('mismatched reconciliation unexpectedly succeeded')
except sqlite3.IntegrityError as exc:
    assert 'CSV_IMPORT_RECONCILIATION_BATCH_MISMATCH' in str(exc)

conn.execute(
    '''INSERT INTO csv_import_reconciliation_receipts(
         reconciliation_id, import_id, source_file_name,
         raw_content_sha256, raw_content_bytes,
         normalized_content_sha256, normalized_content_bytes,
         normalization_transform, evidence_sha256, evidence_json,
         actor_user_id, reason, reconciled_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)''',
    ('rec-june-2026', 'csv-legacy', '202606 (1).csv', RAW_SHA, 3202495,
     BATCH_SHA, 3202492, 'utf8_bom_strip_v1', EVIDENCE_SHA,
     json.dumps({'deterministicRows': 8753, 'normalization': 'utf8_bom_strip_v1'}),
     'user-owner', 'deterministic exact-source reconciliation', '2026-08-19T08:00:00Z'),
)

# Authority promotion must explicitly reference the immutable receipt.
try:
    conn.execute(
        '''UPDATE csv_import_authority
           SET provenance_class='reconciled_exact_source', authority_version=2,
               actor_user_id='user-owner', reason='missing receipt reference',
               evidence_json='{}', updated_at='2026-08-19T08:01:00Z'
           WHERE import_id='csv-legacy' ''')
    raise AssertionError('reconciled authority without receipt reference unexpectedly succeeded')
except sqlite3.IntegrityError as exc:
    assert 'CSV_IMPORT_AUTHORITY_RECONCILIATION_REQUIRED' in str(exc)

conn.execute(
    '''UPDATE csv_import_authority
       SET provenance_class='reconciled_exact_source', authority_version=2,
           actor_user_id='user-owner', reason='deterministic exact-source reconciliation',
           evidence_json=?, updated_at='2026-08-19T08:02:00Z'
       WHERE import_id='csv-legacy' ''',
    (json.dumps({'reconciliationId': 'rec-june-2026'}),),
)
row = conn.execute(
    'SELECT provenance_class, authority_version FROM csv_import_authority WHERE import_id=?',
    ('csv-legacy',),
).fetchone()
assert row == ('reconciled_exact_source', 2)
assert conn.execute(
    'SELECT COUNT(*) FROM csv_import_authority_events WHERE import_id=?', ('csv-legacy',)
).fetchone()[0] == 2

for sql in (
    "UPDATE csv_import_reconciliation_receipts SET reason='changed' WHERE import_id='csv-legacy'",
    "DELETE FROM csv_import_reconciliation_receipts WHERE import_id='csv-legacy'",
):
    try:
        conn.execute(sql)
        raise AssertionError('reconciliation receipt mutation unexpectedly succeeded')
    except sqlite3.IntegrityError as exc:
        assert 'CSV_IMPORT_RECONCILIATION_IMMUTABLE' in str(exc)

print(json.dumps({
    'ok': True,
    'migration': '0023_store_csv_legacy_reconciliation_receipts.sql',
    'legacyReceiptImmutable': True,
    'sourceObjectFabricationRequired': False,
    'authorityPromotionRequiresReceiptReference': True,
    'amazonNetwork': False,
}))
