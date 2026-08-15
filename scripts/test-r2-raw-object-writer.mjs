import assert from 'node:assert/strict';
import { buildCreateOnlyR2PutOptions } from '../cloudflare/runtime/amazon-raw-object-contract.js';
import {
  createR2CreateOnlyRawObjectWriter,
  R2RawObjectWriterError,
} from '../cloudflare/runtime/r2-raw-object-writer.js';

function expectCode(code, fn) {
  assert.throws(
    fn,
    (error) => error instanceof R2RawObjectWriterError && error.code === code,
  );
}

function bucketHarness({ result = null, error = null } = {}) {
  const calls = { put:0, get:0, head:0, list:0, delete:0 };
  const observed = [];
  return {
    calls,
    observed,
    bucket:{
      async put(key, bytes, options) {
        calls.put += 1;
        observed.push({ key, bytes, options });
        if (error) throw error;
        return typeof result === 'function' ? result({ key, bytes, options }) : result;
      },
      async get() { calls.get += 1; throw new Error('GET forbidden'); },
      async head() { calls.head += 1; throw new Error('HEAD forbidden'); },
      async list() { calls.list += 1; throw new Error('LIST forbidden'); },
      async delete() { calls.delete += 1; throw new Error('DELETE forbidden'); },
    },
  };
}

async function validInput() {
  const bytes = new TextEncoder().encode('compressed-artifact-fixture');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return {
    key:'raw/amazon-ads/DEV01/profile-1/SPONSORED_PRODUCTS/spSearchTerm/dt=2026-08-12/amazon-1.json.gz',
    bytes,
    options:buildCreateOnlyR2PutOptions(hex),
  };
}

expectCode('R2_RAW_WRITER_BUCKET_INVALID', () => createR2CreateOnlyRawObjectWriter());
expectCode('R2_RAW_WRITER_BUCKET_INVALID', () => createR2CreateOnlyRawObjectWriter({ bucket:{} }));

// Successful create-only PUT passes a copied body and the exact conditional/native checksum policy.
{
  const input = await validInput();
  const expectedReceipt = {
    key:input.key,
    size:input.bytes.byteLength,
    version:'version-1',
    etag:'etag-1',
    checksums:{ sha256:input.options.sha256 },
  };
  const h = bucketHarness({ result:expectedReceipt });
  const putRawObject = createR2CreateOnlyRawObjectWriter({ bucket:h.bucket });
  const result = await putRawObject(input);
  assert.equal(result, expectedReceipt);
  assert.deepEqual(h.calls, { put:1, get:0, head:0, list:0, delete:0 });
  assert.equal(h.observed[0].key, input.key);
  assert.deepEqual([...h.observed[0].bytes], [...input.bytes]);
  assert.notEqual(h.observed[0].bytes.buffer, input.bytes.buffer, 'writer must snapshot mutable input bytes');
  assert.deepEqual(h.observed[0].options.onlyIf, { etagDoesNotMatch:'*' });
  assert.equal(new Uint8Array(h.observed[0].options.sha256).byteLength, 32);
}

// Conditional failure is not returned as null. It becomes an error so the acquisition layer
// can perform its durable D1 race reread without any HEAD/GET provenance backfill.
{
  const input = await validInput();
  const h = bucketHarness({ result:null });
  const putRawObject = createR2CreateOnlyRawObjectWriter({ bucket:h.bucket });
  await assert.rejects(
    () => putRawObject(input),
    (error) => error instanceof R2RawObjectWriterError
      && error.code === 'R2_RAW_WRITER_CREATE_CONDITION_FAILED',
  );
  assert.deepEqual(h.calls, { put:1, get:0, head:0, list:0, delete:0 });
}

// Transport exceptions remain ambiguous and preserve the underlying cause for the acquisition layer.
{
  const input = await validInput();
  const h = bucketHarness({ error:new Error('simulated R2 transport failure') });
  const putRawObject = createR2CreateOnlyRawObjectWriter({ bucket:h.bucket });
  await assert.rejects(
    () => putRawObject(input),
    (error) => error instanceof R2RawObjectWriterError
      && error.code === 'R2_RAW_WRITER_PUT_FAILED'
      && error.cause?.message === 'simulated R2 transport failure',
  );
  assert.deepEqual(h.calls, { put:1, get:0, head:0, list:0, delete:0 });
}

// The adapter accepts only the frozen create-only policy built by the raw-object contract.
{
  const input = await validInput();
  const h = bucketHarness({ result:{} });
  const putRawObject = createR2CreateOnlyRawObjectWriter({ bucket:h.bucket });
  for (const [options, code] of [
    [{ sha256:input.options.sha256 }, 'R2_RAW_WRITER_OPTIONS_NOT_CREATE_ONLY'],
    [{ onlyIf:{ etagDoesNotMatch:'not-star' }, sha256:input.options.sha256 }, 'R2_RAW_WRITER_CREATE_ONLY_CONDITION_REQUIRED'],
    [{ onlyIf:{ etagDoesNotMatch:'*' }, sha256:input.options.sha256, httpMetadata:{} }, 'R2_RAW_WRITER_OPTIONS_NOT_CREATE_ONLY'],
  ]) {
    await assert.rejects(
      () => putRawObject({ ...input, options }),
      (error) => error instanceof R2RawObjectWriterError && error.code === code,
    );
  }
  assert.equal(h.calls.put, 0);
}

// A caller cannot provide a checksum that does not match the exact bytes passed to R2.
{
  const input = await validInput();
  const wrongHex = '00'.repeat(32);
  const h = bucketHarness({ result:{} });
  const putRawObject = createR2CreateOnlyRawObjectWriter({ bucket:h.bucket });
  await assert.rejects(
    () => putRawObject({ ...input, options:buildCreateOnlyR2PutOptions(wrongHex) }),
    (error) => error instanceof R2RawObjectWriterError
      && error.code === 'R2_RAW_WRITER_SHA256_MISMATCH',
  );
  assert.equal(h.calls.put, 0);
}

console.log('concrete R2 create-only raw object writer: PASS');
