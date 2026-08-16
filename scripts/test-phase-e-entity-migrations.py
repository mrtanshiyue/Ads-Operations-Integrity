#!/usr/bin/env python3
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / 'cloudflare' / 'foundation' / 'migrations' / 'store'


def apply(conn, through=None):
    for migration in sorted(STORE.glob('*.sql')):
        if through and migration.name > through:
            break
        conn.executescript(migration.read_text(encoding='utf-8'))


def expect_integrity(conn, sql, params=(), code=None):
    try:
        conn.execute(sql, params)
    except sqlite3.IntegrityError as exc:
        if code:
            assert code in str(exc), (code, str(exc))
        return
    raise AssertionError(f'expected IntegrityError: {code or sql}')


def seed_running(conn, run_id='run1', profile='p1'):
    conn.execute("INSERT INTO amazon_profiles(profile_id,status) VALUES(?, 'active')", (profile,))
    conn.execute("""
      INSERT INTO sync_runs(run_id,profile_id,trigger_type,scope_key,status,requested_by,intent_fingerprint)
      VALUES(?,NULL,'manual','scope','queued','u1',?)
    """, (run_id, f'fp-{run_id}'))
    conn.execute("UPDATE sync_runs SET profile_id=?,status='running',started_at='t0' WHERE run_id=?", (profile,run_id))


def canonical(entity_type, entity_id, synced_at='t1'):
    base = {'entityType':entity_type, 'profileId':'p1', 'syncedAt':synced_at, 'payloadHash':'a'*64}
    if entity_type == 'campaign':
        base.update({'campaignId':entity_id,'portfolioId':None,'adProduct':'SPONSORED_PRODUCTS','name':'C','state':'ENABLED','targetingType':'MANUAL','biddingStrategy':None,'dailyBudgetMicros':'1000000','startDate':None,'endDate':None,'sourceUpdatedAt':None})
    elif entity_type == 'ad_group':
        base.update({'adGroupId':entity_id,'campaignId':'c1','name':'A','state':'ENABLED','defaultBidMicros':'2000000','sourceUpdatedAt':'source-adgroup'})
    elif entity_type == 'keyword':
        base.update({'keywordId':entity_id,'campaignId':'c1','adGroupId':'a1','keywordText':'Reading Glasses','normalizedKeyword':'reading glasses','matchType':'BROAD','state':'ARCHIVED','bidMicros':None,'sourceUpdatedAt':'source-keyword'})
    elif entity_type == 'target':
        base.update({'targetId':entity_id,'campaignId':'c1','adGroupId':'a1','targetType':'MANUAL','expressionJson':'[{"type":"asinSameAs","value":"B0TEST"}]','expressionText':'{"type":"asinSameAs","value":"B0TEST"}','state':'ENABLED','bidMicros':'0','sourceUpdatedAt':None})
    return json.dumps(base, separators=(',',':'), sort_keys=True)


def insert_stage(conn, rows, run_id='run1', profile='p1'):
    conn.executemany("""
      INSERT INTO amazon_entity_stage(run_id,profile_id,entity_type,source_row_ordinal,entity_id,canonical_entity_json)
      VALUES(?,?,?, ?,?,?)
    """, [(run_id, profile, *row) for row in rows])


def insert_stage_receipt(conn, counts, snapshot_hash='a'*64, run_id='run1', profile='p1', synced_at='t1'):
    conn.execute("""
      INSERT INTO amazon_entity_stage_receipts(
        run_id,profile_id,snapshot_synced_at,snapshot_sha256,
        campaign_count,ad_group_count,keyword_count,target_count,staged_at
      ) VALUES(?,?,?,?,?,?,?,?, 't2')
    """, (
        run_id, profile, synced_at, snapshot_hash,
        counts.get('campaign', 0), counts.get('ad_group', 0),
        counts.get('keyword', 0), counts.get('target', 0),
    ))


def expect_stage_receipt_failure(conn, rows, counts, code):
    insert_stage(conn, rows)
    try:
        insert_stage_receipt(conn, counts)
    except sqlite3.IntegrityError as exc:
        assert code in str(exc), (code, str(exc))
    else:
        raise AssertionError(f'expected IntegrityError: {code}')
    conn.execute("DELETE FROM amazon_entity_stage WHERE run_id='run1'")


def test_new_invariants():
    conn = sqlite3.connect(':memory:')
    conn.execute('PRAGMA foreign_keys=ON')
    apply(conn)
    seed_running(conn)
    conn.execute("INSERT INTO amazon_profiles(profile_id,status) VALUES('p2','active')")
    conn.execute("INSERT INTO campaigns(campaign_id,profile_id,ad_product,name,state) VALUES('c1','p1','SPONSORED_PRODUCTS','C','ENABLED')")
    conn.execute("INSERT INTO campaigns(campaign_id,profile_id,ad_product,name,state) VALUES('c2','p2','SPONSORED_PRODUCTS','C2','ENABLED')")
    conn.execute("INSERT INTO ad_groups(ad_group_id,profile_id,campaign_id,name,state) VALUES('a1','p1','c1','A','ENABLED')")
    conn.execute("INSERT INTO keywords(keyword_id,profile_id,campaign_id,ad_group_id,keyword_text,normalized_keyword,match_type,state) VALUES('k1','p1','c1','a1','x','x','BROAD','ENABLED')")
    conn.execute("INSERT INTO targets(target_id,profile_id,campaign_id,ad_group_id,expression_json,state) VALUES('t1','p1','c1','a1','[]','ENABLED')")

    expect_integrity(conn, "UPDATE campaigns SET profile_id='p2' WHERE campaign_id='c1'", code='CAMPAIGN_PROFILE_IMMUTABLE')
    expect_integrity(conn, "INSERT INTO ad_groups(ad_group_id,profile_id,campaign_id,name,state) VALUES('bad-a','p1','c2','Bad','ENABLED')", code='AD_GROUP_CAMPAIGN_HIERARCHY_MISMATCH')
    expect_integrity(conn, "UPDATE ad_groups SET campaign_id='c2' WHERE ad_group_id='a1'", code='AD_GROUP_IDENTITY_IMMUTABLE')
    expect_integrity(conn, "UPDATE keywords SET ad_group_id='missing' WHERE keyword_id='k1'", code='KEYWORD_IDENTITY_IMMUTABLE')
    expect_integrity(conn, "UPDATE targets SET campaign_id='c2' WHERE target_id='t1'", code='TARGET_IDENTITY_IMMUTABLE')

    rows = [
        ('campaign',0,'c1',canonical('campaign','c1')),
        ('ad_group',0,'a1',canonical('ad_group','a1')),
        ('keyword',0,'k1',canonical('keyword','k1')),
        ('target',0,'t1',canonical('target','t1')),
    ]
    insert_stage(conn, rows)

    expect_integrity(conn, """
      INSERT INTO amazon_entity_stage_receipts(
        run_id,profile_id,snapshot_synced_at,snapshot_sha256,campaign_count,ad_group_count,keyword_count,target_count,staged_at
      ) VALUES('run1','p1','t1',?,1,1,2,1,'t2')
    """, ('a'*64,), code='ENTITY_STAGE_RECEIPT_COUNTS_MISMATCH')

    insert_stage_receipt(conn, {'campaign':1,'ad_group':1,'keyword':1,'target':1}, snapshot_hash='b'*64)

    expect_integrity(conn, "INSERT INTO amazon_entity_stage(run_id,profile_id,entity_type,source_row_ordinal,entity_id,canonical_entity_json) VALUES('run1','p1','campaign',1,'c-new','{}')", code='ENTITY_STAGE_FROZEN')
    expect_integrity(conn, "UPDATE amazon_entity_stage SET canonical_entity_json='{}' WHERE run_id='run1' AND entity_type='campaign'", code='ENTITY_STAGE_FROZEN')
    expect_integrity(conn, "DELETE FROM amazon_entity_stage WHERE run_id='run1'", code='ENTITY_STAGE_FROZEN')
    expect_integrity(conn, "UPDATE amazon_entity_stage_receipts SET campaign_count=2 WHERE run_id='run1'", code='ENTITY_STAGE_RECEIPT_IMMUTABLE')
    expect_integrity(conn, "DELETE FROM amazon_entity_stage_receipts WHERE run_id='run1'", code='ENTITY_STAGE_RECEIPT_IMMUTABLE')

    expect_integrity(conn, """
      INSERT INTO amazon_entity_snapshot_receipts(
        run_id,profile_id,snapshot_synced_at,campaign_count,ad_group_count,keyword_count,target_count,published_at,snapshot_sha256
      ) VALUES('run1','p1','t1',1,1,1,1,'t3',NULL)
    """, code='ENTITY_SNAPSHOT_HASH_REQUIRED')

    expect_integrity(conn, """
      INSERT INTO amazon_entity_snapshot_receipts(
        run_id,profile_id,snapshot_synced_at,campaign_count,ad_group_count,keyword_count,target_count,published_at,snapshot_sha256
      ) VALUES('run1','p1','t1',1,1,1,1,'t3',?)
    """, ('c'*64,), code='ENTITY_SNAPSHOT_STAGE_RECEIPT_REQUIRED')

    conn.execute("""
      INSERT INTO amazon_entity_snapshot_receipts(
        run_id,profile_id,snapshot_synced_at,campaign_count,ad_group_count,keyword_count,target_count,published_at,snapshot_sha256
      ) VALUES('run1','p1','t1',1,1,1,1,'t3',?)
    """, ('b'*64,))
    conn.execute("DELETE FROM amazon_entity_stage WHERE run_id='run1'")
    assert conn.execute("SELECT COUNT(*) FROM amazon_entity_stage WHERE run_id='run1'").fetchone()[0] == 0
    expect_integrity(conn, "DELETE FROM amazon_entity_snapshot_receipts WHERE run_id='run1'", code='ENTITY_SNAPSHOT_RECEIPT_IMMUTABLE')
    expect_integrity(conn, "UPDATE amazon_entity_snapshot_receipts SET snapshot_sha256=? WHERE run_id='run1'", ('c'*64,), code='ENTITY_SNAPSHOT_RECEIPT_IMMUTABLE')
    expect_integrity(conn, "INSERT INTO amazon_entity_stage(run_id,profile_id,entity_type,source_row_ordinal,entity_id,canonical_entity_json) VALUES('run1','p1','campaign',0,'c1','{}')", code='ENTITY_STAGE_FROZEN')

    assert conn.execute('PRAGMA foreign_key_check').fetchall() == []
    conn.close()


def test_existing_entity_identity_conflicts_fail_closed():
    conn = sqlite3.connect(':memory:')
    conn.execute('PRAGMA foreign_keys=ON')
    apply(conn)
    seed_running(conn)
    conn.execute("INSERT INTO amazon_profiles(profile_id,status) VALUES('p2','active')")
    conn.execute("INSERT INTO campaigns(campaign_id,profile_id,ad_product,name,state) VALUES('c1','p1','SPONSORED_PRODUCTS','C1','ENABLED')")
    conn.execute("INSERT INTO campaigns(campaign_id,profile_id,ad_product,name,state) VALUES('c2','p2','SPONSORED_PRODUCTS','C2','ENABLED')")
    conn.execute("INSERT INTO ad_groups(ad_group_id,profile_id,campaign_id,name,state) VALUES('a1','p1','c1','A1','ENABLED')")
    conn.execute("INSERT INTO ad_groups(ad_group_id,profile_id,campaign_id,name,state) VALUES('a2','p2','c2','A2','ENABLED')")
    conn.execute("INSERT INTO keywords(keyword_id,profile_id,campaign_id,ad_group_id,keyword_text,normalized_keyword,match_type,state) VALUES('k2','p2','c2','a2','x','x','BROAD','ENABLED')")
    conn.execute("INSERT INTO targets(target_id,profile_id,campaign_id,ad_group_id,expression_json,state) VALUES('t2','p2','c2','a2','[]','ENABLED')")

    expect_stage_receipt_failure(
        conn,
        [('campaign',0,'c2',canonical('campaign','c2'))],
        {'campaign':1},
        'ENTITY_STAGE_CAMPAIGN_IDENTITY_CONFLICT',
    )

    expect_stage_receipt_failure(
        conn,
        [
            ('campaign',0,'c1',canonical('campaign','c1')),
            ('ad_group',0,'a2',canonical('ad_group','a2')),
        ],
        {'campaign':1,'ad_group':1},
        'ENTITY_STAGE_AD_GROUP_IDENTITY_CONFLICT',
    )

    expect_stage_receipt_failure(
        conn,
        [
            ('campaign',0,'c1',canonical('campaign','c1')),
            ('ad_group',0,'a1',canonical('ad_group','a1')),
            ('keyword',0,'k2',canonical('keyword','k2')),
        ],
        {'campaign':1,'ad_group':1,'keyword':1},
        'ENTITY_STAGE_KEYWORD_IDENTITY_CONFLICT',
    )

    expect_stage_receipt_failure(
        conn,
        [
            ('campaign',0,'c1',canonical('campaign','c1')),
            ('ad_group',0,'a1',canonical('ad_group','a1')),
            ('target',0,'t2',canonical('target','t2')),
        ],
        {'campaign':1,'ad_group':1,'target':1},
        'ENTITY_STAGE_TARGET_IDENTITY_CONFLICT',
    )

    bad_ad_group = json.loads(canonical('ad_group','a-bad'))
    bad_ad_group['campaignId'] = 'missing-campaign'
    expect_stage_receipt_failure(
        conn,
        [
            ('campaign',0,'c1',canonical('campaign','c1')),
            ('ad_group',0,'a-bad',json.dumps(bad_ad_group, separators=(',',':'), sort_keys=True)),
        ],
        {'campaign':1,'ad_group':1},
        'ENTITY_STAGE_AD_GROUP_HIERARCHY_INVALID',
    )

    assert conn.execute('PRAGMA foreign_key_check').fetchall() == []
    conn.close()


def test_legacy_final_receipt_cannot_be_backfilled():
    conn = sqlite3.connect(':memory:')
    conn.execute('PRAGMA foreign_keys=ON')
    apply(conn, through='0006_store_ingestion_staging.sql')
    seed_running(conn, run_id='legacy-run')
    conn.execute("""
      INSERT INTO amazon_entity_snapshot_receipts(
        run_id,profile_id,snapshot_synced_at,campaign_count,ad_group_count,keyword_count,target_count,published_at
      ) VALUES('legacy-run','p1','legacy-time',0,0,0,0,'legacy-published')
    """)
    for migration_name in (
        '0007_store_entity_mirror_invariants.sql',
        '0008_store_entity_mirror_hardening.sql',
        '0009_store_entity_stage_identity_guard.sql',
    ):
        conn.executescript((STORE / migration_name).read_text(encoding='utf-8'))
    row = conn.execute("SELECT snapshot_sha256 FROM amazon_entity_snapshot_receipts WHERE run_id='legacy-run'").fetchone()
    assert row == (None,)
    expect_integrity(conn, "UPDATE amazon_entity_snapshot_receipts SET snapshot_sha256=? WHERE run_id='legacy-run'", ('d'*64,), code='ENTITY_SNAPSHOT_RECEIPT_IMMUTABLE')
    conn.close()


def main():
    test_new_invariants()
    test_existing_entity_identity_conflicts_fail_closed()
    test_legacy_final_receipt_cannot_be_backfilled()
    print('phase-e entity migration invariants: PASS')


if __name__ == '__main__':
    main()
