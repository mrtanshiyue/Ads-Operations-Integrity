import assert from 'node:assert/strict';
import { createSettlementImportSourceObjectStore } from '../cloudflare/runtime/settlement-import-source-object.js';

class FakeR2Object {
  constructor(bytes, key, version = 'v1') {
    this.bytes = new Uint8Array(bytes);
    this.key = key;
    this.etag = 'etag-1';
    this.httpEtag = '"etag-1"';
    this.version = version;
  }
  async arrayBuffer() {
    return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength);
  }
}

class FakeBucket {
  constructor() { this.objects = new Map(); }
  async put(key, bytes, options) {
    assert.ok(options.onlyIf instanceof Headers);
    assert.equal(options.onlyIf.get('if-none-match'), '*');
    assert.deepEqual([...options.onlyIf.keys()], ['if-none-match']);
    assert.equal(new Uint8Array(options.sha256).byteLength, 32);
    if (this.objects.has(key)) return null;
    const object = new FakeR2Object(bytes, key);
    this.objects.set(key, object);
    return object;
  }
  async get(key) { return this.objects.get(key) || null; }
}

const bucket = new FakeBucket();
const store = createSettlementImportSourceObjectStore({ bucket });
const bytes = new TextEncoder().encode('exact settlement bytes');

const first = await store.describe({
  bytes,
  storeId:'store-01',
  sourceFileName:'settlement.csv',
  contentType:'text/csv',
  importerUserId:'user-1',
  uploadedAt:'2026-08-19T10:00:00.000Z',
});
const firstReceipt = await store.persist(first);
assert.equal(firstReceipt.reusedExisting, false);
assert.equal(bucket.objects.size, 1);

const retry = await store.describe({
  bytes,
  storeId:'store-01',
  sourceFileName:'settlement.csv',
  contentType:'text/csv',
  importerUserId:'user-1',
  uploadedAt:'2026-08-19T10:01:00.000Z',
});
assert.equal(retry.objectKey, first.objectKey);
assert.equal(retry.contentSha256, first.contentSha256);
const retryReceipt = await store.persist(retry);
assert.equal(retryReceipt.reusedExisting, true);
assert.equal(retryReceipt.contentSha256, first.contentSha256);
assert.equal(retryReceipt.contentBytes, bytes.byteLength);
assert.equal(bucket.objects.size, 1);

const existing = bucket.objects.get(first.objectKey);
existing.bytes[0] ^= 1;
await assert.rejects(
  store.persist(retry),
  (error) => error?.code === 'SETTLEMENT_SOURCE_R2_EXISTING_SHA256_MISMATCH',
);

console.log('settlement R2 source-object retry recovery: PASS');
