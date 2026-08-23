import assert from 'node:assert/strict';
import { handleCsvProductizationApiRoute } from '../cloudflare/runtime/csv-productization-api.js';

const STORE_ID = 'store-01';
const IMPORT_ID = 'csv-import-123';
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
  first() { return this.db.first(this.sql, this.args); }
  run() { return this.db.run(this.sql, this.args); }
}

class ControlDb {
  constructor() { this.audits = []; }
  prepare(sql) { return new Statement(this, sql); }
  async first(sql) {
    if (sql.includes('FROM user_global_roles')) return { ok:1 };
    if (sql.includes('FROM stores')) {
      return {
        store_id:STORE_ID,
        store_code:'Store01',
        display_name:'Store 01',
        marketplace_code:'US',
        d1_binding_key:'STORE_01_DB',
        status:'active',
      };
    }
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
  constructor({ authority = defaultAuthority(), beforeUpdate = null, insertRace = null } = {}) {
    this.authority = authority ? { ...authority } : null;
    this.beforeUpdate = beforeUpdate;
    this.beforeUpdateUsed = false;
    this.insertRace = insertRace;
    this.insertRaceUsed = false;
  }
  prepare(sql) { return new Statement(this, sql); }
  async first(sql) {
    if (sql.includes('FROM csv_import_batches b')) {
      return {
        import_id:IMPORT_ID,
        source_file_name:'search-term.csv',
        content_sha256:'a'.repeat(64),
        status:'published',
        data_class:this.authority?.data_class ?? null,
        provenance_class:this.authority?.provenance_class ?? null,
        authority_version:this.authority?.authority_version ?? null,
        actor_user_id:this.authority?.actor_user_id ?? null,
        reason:this.authority?.reason ?? null,
        evidence_json:this.authority?.evidence_json ?? null,
        authority_created_at:this.authority?.created_at ?? null,
        authority_updated_at:this.authority?.updated_at ?? null,
      };
    }
    if (sql.includes('FROM csv_import_authority WHERE import_id=')) {
      return this.authority ? { ...this.authority } : null;
    }
    throw new Error(`unexpected store first: ${compact(sql)}`);
  }
  async run(sql, args) {
    if (sql.includes('UPDATE csv_import_authority')) {
      assert.match(sql, /authority_version=\?9/);
      assert.match(sql, /data_class=\?10/);
      assert.match(sql, /provenance_class=\?11/);
      if (!this.beforeUpdateUsed && this.beforeUpdate) {
        this.beforeUpdateUsed = true;
        this.beforeUpdate(this);
      }
      const [importId, targetClass, targetProvenance, nextVersion, actorUserId, reason, evidenceJson, updatedAt,
        expectedVersion, expectedClass, expectedProvenance] = args;
      const matches = this.authority
        && importId === this.authority.import_id
        && Number(this.authority.authority_version) === Number(expectedVersion)
        && this.authority.data_class === expectedClass
        && this.authority.provenance_class === expectedProvenance;
      if (!matches) return { meta:{ changes:0 } };
      this.authority = {
        ...this.authority,
        data_class:targetClass,
        provenance_class:targetProvenance,
        authority_version:Number(nextVersion),
        actor_user_id:actorUserId,
        reason,
        evidence_json:evidenceJson,
        updated_at:updatedAt,
      };
      return { meta:{ changes:1 } };
    }
    if (sql.includes('INSERT INTO csv_import_authority')) {
      if (!this.insertRaceUsed && this.insertRace) {
        this.insertRaceUsed = true;
        this.insertRace(this);
        throw new Error('D1_ERROR: UNIQUE constraint failed: csv_import_authority.import_id');
      }
      if (this.authority) throw new Error('D1_ERROR: UNIQUE constraint failed: csv_import_authority.import_id');
      const [importId, dataClass, provenanceClass, actorUserId, reason, evidenceJson, now] = args;
      this.authority = {
        import_id:importId,
        data_class:dataClass,
        provenance_class:provenanceClass,
        authority_version:1,
        actor_user_id:actorUserId,
        reason,
        evidence_json:evidenceJson,
        created_at:now,
        updated_at:now,
      };
      return { meta:{ changes:1 } };
    }
    throw new Error(`unexpected store run: ${compact(sql)}`);
  }
}

function defaultAuthority(overrides = {}) {
  return {
    import_id:IMPORT_ID,
    data_class:'unclassified',
    provenance_class:'exact_source_object',
    authority_version:1,
    actor_user_id:'system',
    reason:'initial import authority',
    evidence_json:'{}',
    created_at:'2026-08-23T00:00:00.000Z',
    updated_at:'2026-08-23T00:00:00.000Z',
    ...overrides,
  };
}

async function patchAuthority({ authority = defaultAuthority(), body = null, beforeUpdate = null, insertRace = null } = {}) {
  const controlDb = new ControlDb();
  const storeDb = new StoreDb({ authority, beforeUpdate, insertRace });
  const url = new URL(`https://example.test/api/v1/stores/${STORE_ID}/imports/${IMPORT_ID}`);
  const request = new Request(url, {
    method:'PATCH',
    headers:{ 'content-type':'application/json', 'cf-ray':'csv-authority-cas-test' },
    body:JSON.stringify(body || {
      dataClass:'business',
      provenanceClass:'exact_source_object',
      reason:'operator classification',
      evidence:{ source:'test' },
    }),
  });
  const response = await handleCsvProductizationApiRoute({
    request,
    env:{ CONTROL_DB:controlDb, STORE_01_DB:storeDb },
    actor:ACTOR,
    url,
  });
  assert.ok(response, 'CSV authority route must be handled');
  return { response, body:await response.json(), controlDb, storeDb };
}

// Existing authority: normal optimistic update succeeds and advances exactly one revision.
{
  const result = await patchAuthority();
  assert.equal(result.response.status, 200);
  assert.equal(result.body.authority.dataClass, 'business');
  assert.equal(result.body.authority.provenanceClass, 'exact_source_object');
  assert.equal(result.body.authority.authorityVersion, 2);
  assert.equal(result.storeDb.authority.authority_version, 2);
  assert.equal(result.controlDb.audits.length, 1);
}

// Existing authority: a different competing classification wins before our mutation.
{
  const result = await patchAuthority({
    beforeUpdate(db) { db.authority = defaultAuthority({ data_class:'acceptance', authority_version:2 }); },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.error, 'import_authority_conflict');
  assert.equal(result.storeDb.authority.data_class, 'acceptance');
  assert.equal(result.storeDb.authority.authority_version, 2);
  assert.equal(result.controlDb.audits.length, 0);
}

// Existing authority: a competing writer already reached the requested classification.
{
  const result = await patchAuthority({
    beforeUpdate(db) { db.authority = defaultAuthority({ data_class:'business', authority_version:2 }); },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.error, 'import_authority_no_change');
  assert.equal(result.storeDb.authority.authority_version, 2);
  assert.equal(result.controlDb.audits.length, 0);
}

// Legacy/no-authority import: first classification remains supported.
{
  const result = await patchAuthority({ authority:null });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.authority.dataClass, 'business');
  assert.equal(result.body.authority.authorityVersion, 1);
  assert.equal(result.controlDb.audits.length, 1);
}

// Legacy/no-authority import: a different competing first writer maps the unique race to conflict.
{
  const result = await patchAuthority({
    authority:null,
    insertRace(db) { db.authority = defaultAuthority({ data_class:'acceptance' }); },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.error, 'import_authority_conflict');
  assert.equal(result.storeDb.authority.data_class, 'acceptance');
  assert.equal(result.controlDb.audits.length, 0);
}

// Legacy/no-authority import: a competing writer reaching the same target maps to no-change.
{
  const result = await patchAuthority({
    authority:null,
    insertRace(db) { db.authority = defaultAuthority({ data_class:'business' }); },
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.error, 'import_authority_no_change');
  assert.equal(result.controlDb.audits.length, 0);
}

function compact(sql) { return String(sql).replace(/\s+/g, ' ').trim(); }

console.log('CSV import authority CAS and first-writer race contract: PASS');
