import assert from 'node:assert/strict';
import {
  createR2RawObjectReader,
  R2RawObjectReaderError,
} from '../cloudflare/runtime/r2-raw-object-reader.js';

const KEY = 'raw/amazon-ads/DEV01/profile-1/SPONSORED_PRODUCTS/spSearchTerm/dt=2026-08-12/amazon-1.json.gz';
const SHA_BYTES = new Uint8Array(32).map((_, index) => index);
const BODY = new Uint8Array([0x1f,0x8b,0x08,0x00]);

function makeObject(overrides = {}) {
  let bodyReads = 0;
  const object = {
    key:KEY,
    version:'version-1',
    size:BODY.byteLength,
    etag:'etag-1',
    checksums:{ sha256:SHA_BYTES.buffer },
    async arrayBuffer() {
      bodyReads += 1;
      return BODY.buffer.slice(0);
    },
    ...overrides,
  };
  return { object, getBodyReads:() => bodyReads };
}

function makeBucket(objectOrFactory) {
  const calls = { get:0, head:0, put:0, list:0, delete:0 };
  return {
    calls,
    async get(key) {
      calls.get += 1;
      assert.equal(key, KEY);
      if (typeof objectOrFactory === 'function') return objectOrFactory();
      return objectOrFactory;
    },
    async head() { calls.head += 1; throw new Error('HEAD forbidden'); },
    async put() { calls.put += 1; throw new Error('PUT forbidden'); },
    async list() { calls.list += 1; throw new Error('LIST forbidden'); },
    async delete() { calls.delete += 1; throw new Error('DELETE forbidden'); },
  };
}

async function expectCode(code, fn) {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof R2RawObjectReaderError, error);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

assert.throws(
  () => createR2RawObjectReader({ bucket:{}, maxBytes:1024 }),
  (error) => error instanceof R2RawObjectReaderError && error.code === 'R2_RAW_READER_BUCKET_INVALID',
);
assert.throws(
  () => createR2RawObjectReader({ bucket:{ get(){} }, maxBytes:0 }),
  (error) => error instanceof R2RawObjectReaderError && error.code === 'R2_RAW_READER_SIZE_POLICY_INVALID',
);

// Happy path: exactly one GET, one body read, zero metadata-only or mutating calls.
{
  const source = makeObject();
  const bucket = makeBucket(source.object);
  const read = createR2RawObjectReader({ bucket, maxBytes:1024 });
  const result = await read({ key:KEY, jobId:'job-1' });
  assert.equal(result.key, KEY);
  assert.equal(result.version, 'version-1');
  assert.equal(result.etag, 'etag-1');
  assert.equal(result.size, BODY.byteLength);
  assert.deepEqual([...new Uint8Array(result.checksums.sha256)], [...SHA_BYTES]);
  assert.deepEqual([...result.bytes], [...BODY]);
  assert.equal(source.getBodyReads(), 1);
  assert.deepEqual(bucket.calls, { get:1, head:0, put:0, list:0, delete:0 });
}

// Returned checksum and body buffers do not alias caller-owned mutable metadata/body buffers.
{
  const source = makeObject();
  const bucket = makeBucket(source.object);
  const read = createR2RawObjectReader({ bucket, maxBytes:1024 });
  const result = await read({ key:KEY, jobId:'job-1' });
  SHA_BYTES[0] = 255;
  assert.equal(new Uint8Array(result.checksums.sha256)[0], 0);
  assert.equal(result.bytes[0], 0x1f);
  SHA_BYTES[0] = 0;
}

// Missing objects and GET transport failures remain distinct.
{
  const bucket = makeBucket(null);
  const read = createR2RawObjectReader({ bucket, maxBytes:1024 });
  await expectCode('R2_RAW_READER_OBJECT_NOT_FOUND', () => read({ key:KEY, jobId:'job-1' }));
  assert.deepEqual(bucket.calls, { get:1, head:0, put:0, list:0, delete:0 });
}
{
  const bucket = makeBucket(() => { throw new Error('R2 unavailable'); });
  const read = createR2RawObjectReader({ bucket, maxBytes:1024 });
  const error = await expectCode('R2_RAW_READER_GET_FAILED', () => read({ key:KEY, jobId:'job-1' }));
  assert.equal(error.cause.message, 'R2 unavailable');
}

// Metadata identity must be structurally complete before body consumption.
for (const [overrides, code] of [
  [{ key:'other-key' }, 'R2_RAW_READER_KEY_MISMATCH'],
  [{ version:'' }, 'R2_RAW_READER_VERSION_MISSING'],
  [{ etag:'' }, 'R2_RAW_READER_ETAG_MISSING'],
  [{ size:-1 }, 'R2_RAW_READER_SIZE_INVALID'],
  [{ checksums:{} }, 'R2_RAW_READER_SHA256_MISSING'],
  [{ checksums:{ sha256:new Uint8Array(31).buffer } }, 'R2_RAW_READER_SHA256_INVALID'],
  [{ arrayBuffer:null }, 'R2_RAW_READER_BODY_UNAVAILABLE'],
]) {
  const source = makeObject(overrides);
  const bucket = makeBucket(source.object);
  const read = createR2RawObjectReader({ bucket, maxBytes:1024 });
  await expectCode(code, () => read({ key:KEY, jobId:'job-1' }));
  assert.equal(source.getBodyReads(), 0, code);
  assert.equal(bucket.calls.head, 0, code);
  assert.equal(bucket.calls.put, 0, code);
}

// Oversize metadata stops before arrayBuffer(), preventing a large object from being loaded into Worker memory.
{
  const source = makeObject({ size:2048 });
  const bucket = makeBucket(source.object);
  const read = createR2RawObjectReader({ bucket, maxBytes:1024 });
  await expectCode('R2_RAW_READER_SIZE_LIMIT_EXCEEDED', () => read({ key:KEY, jobId:'job-1' }));
  assert.equal(source.getBodyReads(), 0);
}

// Body read failures and R2 metadata/body size disagreement are fail-closed.
{
  const source = makeObject({ async arrayBuffer(){ throw new Error('body stream failed'); } });
  const bucket = makeBucket(source.object);
  const read = createR2RawObjectReader({ bucket, maxBytes:1024 });
  const error = await expectCode('R2_RAW_READER_BODY_READ_FAILED', () => read({ key:KEY, jobId:'job-1' }));
  assert.equal(error.cause.message, 'body stream failed');
}
{
  const source = makeObject({ size:BODY.byteLength + 1 });
  const bucket = makeBucket(source.object);
  const read = createR2RawObjectReader({ bucket, maxBytes:1024 });
  await expectCode('R2_RAW_READER_BODY_SIZE_MISMATCH', () => read({ key:KEY, jobId:'job-1' }));
  assert.equal(source.getBodyReads(), 1);
}

// Input identity is required before R2 is touched.
{
  const source = makeObject();
  const bucket = makeBucket(source.object);
  const read = createR2RawObjectReader({ bucket, maxBytes:1024 });
  await expectCode('R2_RAW_READER_JOB_ID_REQUIRED', () => read({ key:KEY }));
  await expectCode('R2_RAW_READER_KEY_REQUIRED', () => read({ jobId:'job-1' }));
  assert.equal(bucket.calls.get, 0);
}

console.log('concrete R2 raw object reader contract: PASS');
