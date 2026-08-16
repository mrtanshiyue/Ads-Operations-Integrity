import assert from 'node:assert/strict';
import {
  buildRawObjectKey, validateDownloadedRawArtifact, buildCreateOnlyR2PutOptions,
  verifyInitialR2PutReceipt, verifyRawObjectBeforeIngest,
} from '../cloudflare/runtime/amazon-raw-object-contract.js';

const key = buildRawObjectKey({
  storeCode:'DEV01', profileId:'12345', adProduct:'SPONSORED_PRODUCTS', reportType:'spSearchTerm',
  startDate:'2026-08-12', amazonReportId:'report-abc-123',
});
assert.equal(key, 'raw/amazon-ads/DEV01/12345/SPONSORED_PRODUCTS/spSearchTerm/dt=2026-08-12/report-abc-123.json.gz');

const bytes = new Uint8Array([0x1f,0x8b,0x08,0x00,0x01,0x02,0x03]);
const artifact = await validateDownloadedRawArtifact({ bytes, contentEncoding:'identity', maxCompressedBytes:1024 });
assert.equal(artifact.contentBytes, bytes.length);
assert.match(artifact.contentSha256, /^[0-9a-f]{64}$/);
const opts = buildCreateOnlyR2PutOptions(artifact.contentSha256);
assert.equal(opts.onlyIf.etagDoesNotMatch, '*');
assert.equal(new Uint8Array(opts.sha256).byteLength, 32);

const object = {
  key, size:artifact.contentBytes, version:'version-1', etag:'opaque-etag-1', checksums:{ sha256:opts.sha256 },
};
const receipt = verifyInitialR2PutReceipt({ expectedKey:key, expectedSha256:artifact.contentSha256, expectedBytes:artifact.contentBytes, object });
assert.deepEqual(receipt, { r2InitialVersion:'version-1', r2InitialEtag:'opaque-etag-1' });
assert.equal(verifyRawObjectBeforeIngest({
  job:{ r2_initial_version:'version-1', r2_initial_etag:'opaque-etag-1', content_bytes:artifact.contentBytes, content_sha256:artifact.contentSha256 },
  observation:{ observed:true, object },
}), true);

function expectCode(fn, code) {
  try { fn(); assert.fail(`expected ${code}`); } catch (e) { assert.equal(e.code, code); }
}
expectCode(() => verifyInitialR2PutReceipt({ expectedKey:key, expectedSha256:artifact.contentSha256, expectedBytes:artifact.contentBytes, object:null }), 'R2_UPLOAD_AMBIGUOUS');
expectCode(() => verifyRawObjectBeforeIngest({
  job:{ r2_initial_version:'version-original', r2_initial_etag:'opaque-etag-1', content_bytes:artifact.contentBytes, content_sha256:artifact.contentSha256 },
  observation:{ observed:true, object },
}), 'RAW_OBJECT_MUTATED_BEFORE_INGEST');

try {
  await validateDownloadedRawArtifact({ bytes, contentEncoding:'gzip', maxCompressedBytes:1024 });
  assert.fail('encoded transport accepted');
} catch (e) { assert.equal(e.code, 'RAW_DOWNLOAD_CONTENT_ENCODING_UNEXPECTED'); }
try {
  await validateDownloadedRawArtifact({ bytes:new Uint8Array([1,2,3]), contentEncoding:'identity', maxCompressedBytes:1024 });
  assert.fail('non-gzip accepted');
} catch (e) { assert.equal(e.code, 'RAW_DOWNLOAD_GZIP_MAGIC_INVALID'); }

console.log(JSON.stringify({ ok:true, createOnlyCondition:true, nativeSha256Receipt:true, originalVersionEtagReceipt:true, preIngestMutationGuard:true }, null, 2));
