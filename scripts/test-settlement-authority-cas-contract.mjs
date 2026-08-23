import assert from 'node:assert/strict';
import { handleSettlementImportsApiRoute } from '../cloudflare/runtime/settlement-imports-api.js';

const IMPORT_ID = 'settlement-1234567890';
const STORE_ID = 'store-01';
const ACTOR = { user_id:'operator-1' };

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }
  bind(...args) {
    this.args = args;
    return this;
  }
  first() {
    return this.db.first(this.sql, this.args);
  }
  run() {
    return this.db.run(this.sql, this.args);
  }
}

class ControlDb {
  constructor() {
    this.audits = [];
  }
  prepare(sql) {
    return new Statement(this, sql);
  }
  async first(sql) {
    if (sql.includes('FROM stores')) {
      return {
        store_id:STORE_ID,
        store_code:'Store01',
        display_name:'Store 01',
        marketplace_code:'US',
        amazon_region:'NA',
        d1_binding_key:'STORE_01_DB',
        status:'active',
      };
    }
    if (sql.includes('FROM user_global_roles')) return { ok:1 };
    if (sql.includes('FROM store_members')) return null;
    throw new Error(`unexpected control first: ${compact(sql)}`);
  }
  async run(sql, args) {
    if (sql.includes('INSERT INTO audit_log')) {
      this.audits.push({ sql, args });
      return { meta:{ changes:1 } };
    }
    throw new Error(`unexpected control run: ${compact(sql)}`);
  }
}

class StoreDb {
  constructor({ beforeMutation = null } = {}) {
    this.authority = {
      import_id:IMPORT_ID,
      data_class:'unclassified',
      provenance_class:'exact_source_object',
      authority_version:1,
      actor_user_id:'importer-1',
      reason:'initial import authority',
      evidence_json:'{}',
      created_at:'2026-08-23T00:00:00.000Z',
      updated_at:'2026-08-23T00:00:00.000Z',
    };
    this.batchStatus = 'published';
    this.reconciliationStatus = 'pass';
    this.differenceMicros = 0;
    this.mismatchRows = 0;
    this.beforeMutation = beforeMutation;
    this.beforeMutationUsed = false;
  }
  prepare(sql) {
    return new Statement(this, sql);
  }
  async first(sql) {
    if (sql.includes('FROM settlement_import_batches b')) {
      return {
        import_id:IMPORT_ID,
        status:this.batchStatus,
        content_sha256:'a'.repeat(64),
        reconciliation_status:this.reconciliationStatus,
        difference_micros:this.differenceMicros,
        mismatch_rows:this.mismatchRows,
        ...this.authority,
      };
    }
    if (sql.includes('FROM settlement_import_authority WHERE import_id=')) {
      return { ...this.authority };
    }
    throw new Error(`unexpected store first: ${compact(sql)}`);
  }
  async run(sql, args) {
    if (!sql.includes('UPDATE settlement_import_authority')) {
      throw new Error(`unexpected store run: ${compact(sql)}`);
    }

    assert.match(sql, /authority_version=\?8/);
    assert.match(sql, /data_class=\?9/);
    assert.match(sql, /AND EXISTS \(/);
    assert.match(sql, /b\.status='published'/);
    assert.match(sql, /r\.status='pass'/);
    assert.match(sql, /COALESCE\(r\.difference_micros,0\)=0/);
    assert.match(sql, /COALESCE\(r\.mismatch_rows,0\)=0/);

    if (!this.beforeMutationUsed && this.beforeMutation) {
      this.beforeMutationUsed = true;
      this.beforeMutation(this);
    }

    const [importId, targetClass, nextVersion, actorUserId, reason, evidenceJson, updatedAt,
      expectedVersion, expectedClass] = args;
    const matches = importId === this.authority.import_id
      && this.authority.provenance_class === 'exact_source_object'
      && Number(this.authority.authority_version) === Number(expectedVersion)
      && this.authority.data_class === expectedClass
      && this.batchStatus === 'published'
      && this.reconciliationStatus === 'pass'
      && Number(this.differenceMicros) === 0
      && Number(this.mismatchRows) === 0;

    if (!matches) return { meta:{ changes:0 } };
    this.authority = {
      ...this.authority,
      data_class:targetClass,
      authority_version:Number(nextVersion),
      actor_user_id:actorUserId,
      reason,
      evidence_json:evidenceJson,
      updated_at:updatedAt,
    };
    return { meta:{ changes:1 } };
  }
}

async function patchAuthority({ targetClass = 'business', beforeMutation = null } = {}) {
  const controlDb = new ControlDb();
  const storeDb = new StoreDb({ beforeMutation });
  const url = new URL(`https://example.test/api/v1/stores/${STORE_ID}/imports/settlements?importId=${IMPORT_ID}`);
  const request = new Request(url, {
    method:'PATCH',
    headers:{ 'content-type':'application/json', 'cf-ray':'settlement-cas-test' },
    body:JSON.stringify({ dataClass:targetClass, reason:'operator classification', evidence:{ source:'test' } }),
  });
  const response = await handleSettlementImportsApiRoute({
    request,
    env:{ CONTROL_DB:controlDb, STORE_01_DB:storeDb },
    actor:ACTOR,
    url,
  });
  return { response, body:await response.json(), controlDb, storeDb };
}

{
  const result = await patchAuthority();
  assert.equal(result.response.status, 200);
  assert.equal(result.body.authority.dataClass, 'business');
  assert.equal(result.body.authority.authorityVersion, 2);
  assert.equal(result.storeDb.authority.data_class, 'business');
  assert.equal(result.storeDb.authority.authority_version, 2);
  assert.equal(result.controlDb.audits.length, 1);
}

{
  const result = await patchAuthority({
    beforeMutation(db) {
      db.authority.data_class = 'acceptance';
      db.authority.authority_version = 2;
    },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.error, 'settlement_authority_conflict');
  assert.equal(result.storeDb.authority.data_class, 'acceptance');
  assert.equal(result.storeDb.authority.authority_version, 2);
  assert.equal(result.controlDb.audits.length, 0);
}

{
  const result = await patchAuthority({
    beforeMutation(db) {
      db.authority.data_class = 'business';
      db.authority.authority_version = 2;
    },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.error, 'settlement_authority_no_change');
  assert.equal(result.storeDb.authority.data_class, 'business');
  assert.equal(result.storeDb.authority.authority_version, 2);
  assert.equal(result.controlDb.audits.length, 0);
}

{
  const result = await patchAuthority({
    beforeMutation(db) {
      db.reconciliationStatus = 'fail';
      db.differenceMicros = 100;
    },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.error, 'settlement_authority_conflict');
  assert.equal(result.storeDb.authority.data_class, 'unclassified');
  assert.equal(result.storeDb.authority.authority_version, 1);
  assert.equal(result.controlDb.audits.length, 0);
}

function compact(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

console.log('settlement authority CAS and stale-writer contract: PASS');
await import('./test-csv-import-authority-cas-contract.mjs');
