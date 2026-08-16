import assert from 'node:assert/strict';
import {
  AMAZON_ADS_CREDENTIAL_SMOKE_HEADERS,
  buildAmazonAdsCredentialSmokeMessage,
} from '../cloudflare/runtime/amazon-ads-credential-smoke.js';
import {
  buildAmazonAdsCredentialSmokeProof,
  runCloudflareAmazonAdsCredentialSmoke,
} from './smoke-cloudflare-amazon-ads-credentials-dev.mjs';

const sha = '0123456789abcdef0123456789abcdef01234567';
const refreshToken = 'refresh-token-value';
const timestamp = 1786846500000;
const proof = buildAmazonAdsCredentialSmokeProof({ refreshToken, tag:sha, timestamp });
assert.equal(proof.length, 64);
assert.equal(buildAmazonAdsCredentialSmokeMessage({ tag:sha, timestamp }).includes(refreshToken), false);

let requestInit;
const result = await runCloudflareAmazonAdsCredentialSmoke({
  refreshToken,
  expectedCommit:sha,
  timestamp,
  url:'https://sync.example/health/amazon-credentials',
  timeoutMs:1000,
  async fetchImpl(url, init) {
    assert.equal(url, 'https://sync.example/health/amazon-credentials');
    requestInit = init;
    return Response.json({
      ok:true,
      amazonAdsEnabled:false,
      runtimeVersion:{ id:'version-after-secrets', tag:sha },
      credentialSmoke:{
        lwaTokenRefresh:'pass',
        sideEffects:{
          createReport:false,
          pollReport:false,
          downloadReport:false,
          d1Write:false,
          r2Write:false,
        },
      },
    });
  },
});
assert.equal(requestInit.method, 'POST');
assert.equal(requestInit.headers[AMAZON_ADS_CREDENTIAL_SMOKE_HEADERS.timestamp], String(timestamp));
assert.equal(requestInit.headers[AMAZON_ADS_CREDENTIAL_SMOKE_HEADERS.proof], proof);
assert.equal(Object.values(requestInit.headers).includes(refreshToken), false);
assert.deepEqual(result, {
  ok:true,
  expectedCommit:sha,
  runtimeVersionId:'version-after-secrets',
  lwaTokenRefresh:'pass',
  amazonAdsEnabled:false,
  sideEffects:{
    createReport:false,
    pollReport:false,
    downloadReport:false,
    d1Write:false,
    r2Write:false,
  },
});

await assert.rejects(
  () => runCloudflareAmazonAdsCredentialSmoke({
    refreshToken,
    expectedCommit:sha,
    timestamp,
    timeoutMs:1000,
    async fetchImpl() {
      return Response.json({
        ok:true,
        amazonAdsEnabled:false,
        runtimeVersion:{ tag:'f'.repeat(40) },
        credentialSmoke:{
          lwaTokenRefresh:'pass',
          sideEffects:{
            createReport:false,
            pollReport:false,
            downloadReport:false,
            d1Write:false,
            r2Write:false,
          },
        },
      });
    },
  }),
  /AMAZON_ADS_CREDENTIAL_SMOKE_VERSION_MISMATCH/,
);

console.log('Cloudflare Amazon Ads Dev credential smoke client tests: PASS');
