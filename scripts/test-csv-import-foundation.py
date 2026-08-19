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


def insert_batch(conn, import_id, file_name, sha256, content_bytes, uploaded_at, status='validated'):
    published_at = '2026-08-18T01:02:00Z' if status == 'published' else None
    conn.execute('''INSERT INTO csv_import_batches(
      import_id,source_file_name,report_type,report_start_date,report_end_date,
      content_sha256,content_bytes,schema_version,row_count,accepted_rows,rejected_rows,
      duplicate_status,status,validation_summary_json,uploaded_at,published_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
      import_id,file_name,'spSearchTerm','2026-08-12','2026-08-12',sha256,content_bytes,
      'csv-import-v1',1,1,0,'unique',status,'{"rowCount":1}',uploaded_at,published_at
    ))


def insert_fact(conn, row_key, import_id, search_term='reading glasses men'):
    conn.execute('''INSERT INTO csv_search_term_daily(
      row_key,report_date,campaign_name,ad_group_name,targeting,search_term,normalized_search_term,
      source_import_id,source_row_ordinal
    ) VALUES(?,?,?,?,?,?,?,?,?)''', (
      row_key,'2026-08-12','Campaign','Ad Group','reading glasses',search_term,search_term.lower(),import_id,0
    ))


def insert_review(conn, review_id, fingerprint, row_key, import_ids):
    evidence = '{"sourceImportIds":[' + ','.join(f'"{value}"' for value in import_ids) + ']}'
    conn.execute('''INSERT INTO advisory_review_records(
      review_id,source_kind,recommendation_fingerprint,entity_type,entity_id,
      recommendation_family,recommendation_action_type,state,source_evidence_json,
      source_evidence_sha256,created_by,created_at,updated_at
    ) VALUES(?, 'csv_import', ?, 'search_term', ?, 'waste', 'negative_keyword', 'open', ?, ?, 'user-test', ?, ?)''', (
      review_id,fingerprint,row_key,evidence,'e'*64,'2026-08-18T02:00:00Z','2026-08-18T02:00:00Z'
    ))


def test_current_import_authority(conn):
    # New authorities must fail closed unless immutable raw-source evidence exists first.
    expect_integrity(conn, '''INSERT INTO csv_import_batches(
      import_id,source_file_name,report_type,report_start_date,report_end_date,
      content_sha256,content_bytes,schema_version,row_count,accepted_rows,rejected_rows,
      duplicate_status,status,validation_summary_json,uploaded_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
      'imp-no-source','missing.csv','spSearchTerm','2026-08-10','2026-08-10','f'*64,50,
      'csv-import-v1',1,1,0,'unique','validated','{}','2026-08-18T00:59:00Z'
    ), contains='CSV_IMPORT_SOURCE_OBJECT_REQUIRED')

    insert_source_receipt(conn, 'imp-1', 'a'*64, 100, 'report.csv', '2026-08-18T01:00:00Z')
    insert_batch(conn, 'imp-1', 'report.csv', 'a'*64, 100, '2026-08-18T01:00:00Z')

    seeded = conn.execute('''SELECT data_class,provenance_class,authority_version
      FROM csv_import_authority WHERE import_id='imp-1' ''').fetchone()
    assert seeded == ('unclassified', 'exact_source_object', 1), seeded
    assert conn.execute("SELECT COUNT(*) FROM csv_import_authority_events WHERE import_id='imp-1'").fetchone()[0] == 1

    conn.execute('''INSERT INTO csv_search_term_stage(import_id,source_row_ordinal,logical_row_key,canonical_row_json)
      VALUES('imp-1',0,'rk-1','{"rowKey":"rk-1","sourceRowOrdinal":0}')''')
    expect_integrity(conn, "UPDATE csv_import_batches SET content_bytes=101 WHERE import_id='imp-1'")

    # Preserve the duplicate-authority constraint while satisfying the 0021 source gate first.
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

    insert_fact(conn, 'rk-1', 'imp-1')
    # Unclassified data is fail-closed for both analytics and governed recommendation/review.
    assert conn.execute("SELECT COUNT(*) FROM csv_business_search_term_daily WHERE row_key='rk-1'").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM csv_governed_search_term_daily WHERE row_key='rk-1'").fetchone()[0] == 0
    expect_integrity(
      conn,
      "INSERT INTO advisory_review_records(review_id,source_kind,recommendation_fingerprint,entity_type,entity_id,recommendation_family,recommendation_action_type,state,source_evidence_json,source_evidence_sha256,created_by,created_at,updated_at) VALUES('adv-unclassified','csv_import',?,'search_term','rk-1','waste','negative_keyword','open','{\"sourceImportIds\":[\"imp-1\"]}',?,'user-test','2026-08-18T02:00:00Z','2026-08-18T02:00:00Z')",
      ('1'*64,'2'*64),
      contains='CSV_ADVISORY_REVIEW_AUTHORITY_REQUIRED',
    )

    conn.execute('''UPDATE csv_import_authority
      SET data_class='business', authority_version=2, actor_user_id='user-test',
          reason='classified_as_business', evidence_json='{"ticket":"test"}',
          updated_at='2026-08-18T02:01:00Z'
      WHERE import_id='imp-1' ''')
    assert conn.execute("SELECT COUNT(*) FROM csv_business_search_term_daily WHERE row_key='rk-1'").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM csv_governed_search_term_daily WHERE row_key='rk-1'").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM csv_import_authority_events WHERE import_id='imp-1'").fetchone()[0] == 2

    expect_integrity(
      conn,
      "UPDATE csv_import_authority SET data_class='acceptance', reason='missing version bump' WHERE import_id='imp-1'",
      contains='CSV_IMPORT_AUTHORITY_VERSION_INVALID',
    )
    expect_integrity(
      conn,
      "UPDATE csv_import_authority SET provenance_class='legacy_batch_only', authority_version=3, reason='downgrade', updated_at='2026-08-18T02:02:00Z' WHERE import_id='imp-1'",
      contains='CSV_IMPORT_PROVENANCE_TRANSITION_INVALID',
    )
    insert_review(conn, 'adv-business-exact', '3'*64, 'rk-1', ['imp-1'])

    # Acceptance data can have exact bytes but must never enter business analytics or review.
    insert_source_receipt(conn, 'imp-accept', 'b'*64, 120, 'acceptance.csv', '2026-08-18T03:00:00Z')
    insert_batch(conn, 'imp-accept', 'acceptance.csv', 'b'*64, 120, '2026-08-18T03:00:00Z', status='published')
    insert_fact(conn, 'rk-accept', 'imp-accept', 'synthetic acceptance term')
    conn.execute('''UPDATE csv_import_authority
      SET data_class='acceptance', authority_version=2, actor_user_id='user-test',
          reason='synthetic_acceptance_fixture', updated_at='2026-08-18T03:01:00Z'
      WHERE import_id='imp-accept' ''')
    assert conn.execute("SELECT COUNT(*) FROM csv_business_search_term_daily WHERE row_key='rk-accept'").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM csv_governed_search_term_daily WHERE row_key='rk-accept'").fetchone()[0] == 0
    expect_integrity(
      conn,
      "INSERT INTO advisory_review_records(review_id,source_kind,recommendation_fingerprint,entity_type,entity_id,recommendation_family,recommendation_action_type,state,source_evidence_json,source_evidence_sha256,created_by,created_at,updated_at) VALUES('adv-acceptance','csv_import',?,'search_term','rk-accept','waste','negative_keyword','open','{\"sourceImportIds\":[\"imp-accept\"]}',?,'user-test','2026-08-18T03:02:00Z','2026-08-18T03:02:00Z')",
      ('4'*64,'5'*64),
      contains='CSV_ADVISORY_REVIEW_AUTHORITY_REQUIRED',
    )

    expect_integrity(conn, "DELETE FROM csv_import_authority WHERE import_id='imp-1'", contains='CSV_IMPORT_AUTHORITY_DELETE_FORBIDDEN')
    expect_integrity(conn, "UPDATE csv_import_authority_events SET reason='mutated' WHERE import_id='imp-1' AND authority_version=1", contains='CSV_IMPORT_AUTHORITY_EVENT_IMMUTABLE')
    expect_integrity(conn, "DELETE FROM csv_import_authority_events WHERE import_id='imp-1' AND authority_version=1", contains='CSV_IMPORT_AUTHORITY_EVENT_IMMUTABLE')

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


def test_legacy_reconciliation(tmp_path):
    conn = sqlite3.connect(tmp_path / 'legacy.sqlite')
    conn.execute('PRAGMA foreign_keys=ON')

    # Reproduce a real pre-0021 import: batch/facts exist before source-object persistence.
    for migration in sorted(MIGRATIONS.glob('*.sql')):
        if migration.name >= '0021_store_csv_import_source_objects.sql':
            break
        conn.executescript(migration.read_text(encoding='utf-8'))

    insert_batch(conn, 'imp-legacy', 'legacy.csv', 'c'*64, 140, '2026-06-30T00:00:00Z', status='published')
    insert_fact(conn, 'rk-legacy', 'imp-legacy', 'legacy business term')

    conn.executescript((MIGRATIONS / '0021_store_csv_import_source_objects.sql').read_text(encoding='utf-8'))
    conn.executescript((MIGRATIONS / '0022_store_csv_import_authority.sql').read_text(encoding='utf-8'))

    # Existing rows are deliberately not inferred by migration.
    assert conn.execute("SELECT COUNT(*) FROM csv_import_authority WHERE import_id='imp-legacy'").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM csv_business_search_term_daily WHERE row_key='rk-legacy'").fetchone()[0] == 0

    conn.execute('''INSERT INTO csv_import_authority(
      import_id,data_class,provenance_class,authority_version,actor_user_id,reason,evidence_json,created_at,updated_at
    ) VALUES('imp-legacy','business','legacy_batch_only',1,'user-test','explicit_legacy_business_classification','{}','2026-08-19T00:00:00Z','2026-08-19T00:00:00Z')''')
    assert conn.execute("SELECT COUNT(*) FROM csv_business_search_term_daily WHERE row_key='rk-legacy'").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM csv_governed_search_term_daily WHERE row_key='rk-legacy'").fetchone()[0] == 0

    expect_integrity(
      conn,
      "INSERT INTO advisory_review_records(review_id,source_kind,recommendation_fingerprint,entity_type,entity_id,recommendation_family,recommendation_action_type,state,source_evidence_json,source_evidence_sha256,created_by,created_at,updated_at) VALUES('adv-legacy','csv_import',?,'search_term','rk-legacy','waste','negative_keyword','open','{\"sourceImportIds\":[\"imp-legacy\"]}',?,'user-test','2026-08-19T00:01:00Z','2026-08-19T00:01:00Z')",
      ('6'*64,'7'*64),
      contains='CSV_ADVISORY_REVIEW_AUTHORITY_REQUIRED',
    )
    expect_integrity(
      conn,
      "UPDATE csv_import_authority SET provenance_class='reconciled_exact_source', authority_version=2, actor_user_id='user-test', reason='reconcile_without_bytes', updated_at='2026-08-19T00:02:00Z' WHERE import_id='imp-legacy'",
      contains='CSV_IMPORT_AUTHORITY_SOURCE_OBJECT_REQUIRED',
    )

    # Only exact matching bytes/receipt allow the monotonic provenance upgrade.
    insert_source_receipt(conn, 'imp-legacy', 'c'*64, 140, 'legacy.csv', '2026-06-30T00:00:00Z')
    conn.execute('''UPDATE csv_import_authority
      SET provenance_class='reconciled_exact_source', authority_version=2,
          actor_user_id='user-test', reason='deterministic_reconciliation_passed',
          evidence_json='{"sha256Matched":true,"factsMatched":true}',
          updated_at='2026-08-19T00:03:00Z'
      WHERE import_id='imp-legacy' ''')
    assert conn.execute("SELECT COUNT(*) FROM csv_governed_search_term_daily WHERE row_key='rk-legacy'").fetchone()[0] == 1
    insert_review(conn, 'adv-legacy-reconciled', '8'*64, 'rk-legacy', ['imp-legacy'])
    assert conn.execute("SELECT COUNT(*) FROM csv_import_authority_events WHERE import_id='imp-legacy'").fetchone()[0] == 2
    assert not conn.execute('PRAGMA foreign_key_check').fetchall()
    conn.close()


def main():
    with tempfile.TemporaryDirectory(prefix='csv-import-foundation-') as tmp:
        tmp_path = Path(tmp)
        conn = sqlite3.connect(tmp_path / 'store.sqlite')
        conn.execute('PRAGMA foreign_keys=ON')
        for migration in sorted(MIGRATIONS.glob('*.sql')):
            conn.executescript(migration.read_text(encoding='utf-8'))

        test_current_import_authority(conn)
        assert not conn.execute('PRAGMA foreign_key_check').fetchall()
        conn.close()

        test_legacy_reconciliation(tmp_path)

    print('{"ok":true,"csv_import_foundation":true,"persistent_source_required":true,"source_receipt_immutable":true,"classification_provenance_separated":true,"analytics_gate":true,"governed_review_gate":true,"legacy_reconciliation_gate":true}')


if __name__ == '__main__':
    main()
