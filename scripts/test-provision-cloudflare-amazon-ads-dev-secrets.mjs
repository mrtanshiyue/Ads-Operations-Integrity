import assert from 'node:assert/strict';
import {
  AMAZON_ADS_DEV_SECRET_NAMES,
  AmazonAdsDevSecretProvisionError,
  buildAmazonAdsDevSecretPayload,
  parseAmazonAdsDevSecretList,
  resolveCurrentGitCommit,
  runAmazonAdsDevSecretProvision,
  sanitizeAmazonAdsDevProvisionEnv,
} from './provision-cloudflare-amazon-ads-dev-secrets.mjs';

const secrets = Object.freeze({
  AMAZON_ADS_CLIENT_ID:'client-id-value',
  AMAZON_ADS_CLIENT_SECRET:'client-secret-value',
  AMAZON_ADS_REFRESH_TOKEN:'refresh-token-value',
});
const sha = '0123456789abcdef0123456789abcdef01234567';

assert.deepEqual(buildAmazonAdsDevSecretPayload(secrets), secrets);
for (const name of AMAZON_ADS_DEV_SECRET_NAMES) {
  assert.throws(
    () => buildAmazonAdsDevSecretPayload({ ...secrets, [name]:' ' }),
    new RegExp(`AMAZON_ADS_DEV_SECRET_REQUIRED:${name}`),
  );
}

const sanitized = sanitizeAmazonAdsDevProvisionEnv({
  ...secrets,
  CLOUDFLARE_API_TOKEN:'cloudflare-token',
  CLOUDFLARE_ACCOUNT_ID:'19cd528b5c32e8da423da3cf66a9f05d',
  CI:'true',
});
for (const name of AMAZON_ADS_DEV_SECRET_NAMES) {
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, name), false);
}
assert.equal(sanitized.CLOUDFLARE_API_TOKEN, 'cloudflare-token');
assert.equal(sanitized.CLOUDFLARE_ACCOUNT_ID, '19cd528b5c32e8da423da3cf66a9f05d');
assert.equal(sanitized.CI, 'true');

assert.deepEqual(parseAmazonAdsDevSecretList(JSON.stringify([
  { name:'OTHER_SECRET', type:'secret_text' },
  ...AMAZON_ADS_DEV_SECRET_NAMES.map((name) => ({ name, type:'secret_text' })),
])), [...AMAZON_ADS_DEV_SECRET_NAMES, 'OTHER_SECRET'].sort());
assert.throws(
  () => parseAmazonAdsDevSecretList(JSON.stringify([
    { name:'AMAZON_ADS_CLIENT_ID', type:'secret_text' },
  ])),
  /AMAZON_ADS_DEV_SECRET_LIST_MISSING/,
);

assert.equal(resolveCurrentGitCommit({
  cwd:'/repo',
  spawn(command, args, options) {
    assert.equal(command, 'git');
    assert.deepEqual(args, ['rev-parse', 'HEAD']);
    assert.equal(options.shell, false);
    return { status:0, stdout:`${sha}\n` };
  },
}), sha);

{
  const events = [];
  const spawnCalls = [];
  const smokeCalls = [];
  const exactBuildCalls = [];
  const credentialSmokeCalls = [];
  const result = await runAmazonAdsDevSecretProvision({
    cwd:'/repo',
    env:{
      ...secrets,
      CLOUDFLARE_API_TOKEN:'cloudflare-token',
      CLOUDFLARE_ACCOUNT_ID:'19cd528b5c32e8da423da3cf66a9f05d',
      SYNC_DEV_HEALTH_URL:'https://sync.example.workers.dev/health',
      SYNC_DEV_CREDENTIAL_SMOKE_URL:'https://sync.example.workers.dev/health/amazon-credentials',
    },
    commitSha:sha,
    async exactBuild(options) {
      exactBuildCalls.push(options);
      const number = exactBuildCalls.length;
      events.push(`exact-build-${number}`);
      for (const name of AMAZON_ADS_DEV_SECRET_NAMES) {
        assert.equal(Object.prototype.hasOwnProperty.call(options.env, name), false);
      }
      return {
        ok:true,
        commitSha:sha,
        buildOutcome:'success',
        buildUuid:number === 1
          ? '11111111-1111-4111-8111-111111111111'
          : '22222222-2222-4222-8222-222222222222',
      };
    },
    spawn(command, args, options) {
      spawnCalls.push({ command, args, options });
      if (args.includes('bulk')) {
        events.push('secret-bulk');
        return { status:0 };
      }
      if (args.includes('list')) {
        events.push('secret-list');
        return {
          status:0,
          stdout:JSON.stringify(AMAZON_ADS_DEV_SECRET_NAMES.map((name) => ({ name, type:'secret_text' }))),
        };
      }
      throw new Error(`unexpected spawn: ${command} ${args.join(' ')}`);
    },
    async smoke(options) {
      smokeCalls.push(options);
      const number = smokeCalls.length;
      events.push(`health-${number}`);
      return {
        deploymentExact:true,
        amazonAdsEnabled:false,
        runtimeVersionId:number === 1 ? 'version-pre-secrets' : 'version-after-secrets',
      };
    },
    async credentialSmoke(options) {
      credentialSmokeCalls.push(options);
      events.push('credential-smoke');
      return {
        ok:true,
        lwaTokenRefresh:'pass',
        amazonAdsEnabled:false,
      };
    },
  });

  assert.deepEqual(events, [
    'exact-build-1',
    'health-1',
    'secret-bulk',
    'secret-list',
    'exact-build-2',
    'health-2',
    'credential-smoke',
  ]);
  assert.equal(exactBuildCalls.length, 2);
  assert.equal(exactBuildCalls[0].commitSha, sha);
  assert.equal(exactBuildCalls[1].commitSha, sha);

  assert.equal(spawnCalls.length, 2);
  const bulk = spawnCalls[0];
  assert.deepEqual(bulk.args, [
    '--no-install', 'wrangler', 'secret', 'bulk',
    '--env', 'dev', '--config', 'cloudflare/runtime/wrangler.sync.jsonc',
  ]);
  const payload = JSON.parse(bulk.options.input);
  assert.deepEqual(payload, secrets);
  for (const value of Object.values(secrets)) assert.equal(bulk.args.includes(value), false);
  for (const name of AMAZON_ADS_DEV_SECRET_NAMES) {
    assert.equal(Object.prototype.hasOwnProperty.call(bulk.options.env, name), false);
  }
  assert.equal(bulk.options.env.CLOUDFLARE_API_TOKEN, 'cloudflare-token');
  assert.deepEqual(spawnCalls[1].args, [
    '--no-install', 'wrangler', 'secret', 'list', '--format', 'json',
    '--env', 'dev', '--config', 'cloudflare/runtime/wrangler.sync.jsonc',
  ]);

  assert.equal(smokeCalls.length, 2);
  assert.equal(smokeCalls[0].expectedCommit, sha);
  assert.equal(smokeCalls[0].requireExact, true);
  assert.equal(smokeCalls[1].expectedCommit, sha);
  assert.equal(smokeCalls[1].requireExact, true);

  assert.equal(credentialSmokeCalls.length, 1);
  assert.equal(credentialSmokeCalls[0].refreshToken, secrets.AMAZON_ADS_REFRESH_TOKEN);
  assert.equal(credentialSmokeCalls[0].expectedCommit, sha);
  assert.equal(
    credentialSmokeCalls[0].url,
    'https://sync.example.workers.dev/health/amazon-credentials',
  );

  assert.deepEqual(result, {
    ok:true,
    commitSha:sha,
    secretNames:[...AMAZON_ADS_DEV_SECRET_NAMES].sort(),
    amazonAdsEnabled:false,
    prebuildUuid:'11111111-1111-4111-8111-111111111111',
    postbuildUuid:'22222222-2222-4222-8222-222222222222',
    runtimeVersionId:'version-after-secrets',
    lwaTokenRefresh:'pass',
  });
}

{
  let exactBuildCalls = 0;
  let smokeCalls = 0;
  let spawnCalls = 0;
  let credentialSmokeCalls = 0;
  await assert.rejects(
    () => runAmazonAdsDevSecretProvision({
      env:secrets,
      commitSha:sha,
      async exactBuild() {
        exactBuildCalls += 1;
        return { commitSha:sha, buildOutcome:'success', buildUuid:'11111111-1111-4111-8111-111111111111' };
      },
      async smoke() {
        smokeCalls += 1;
        return { deploymentExact:true, amazonAdsEnabled:false };
      },
      spawn() {
        spawnCalls += 1;
        return { status:17 };
      },
      async credentialSmoke() {
        credentialSmokeCalls += 1;
        return { lwaTokenRefresh:'pass' };
      },
    }),
    /AMAZON_ADS_DEV_SECRET_BULK_FAILED:17/,
  );
  assert.equal(exactBuildCalls, 1);
  assert.equal(smokeCalls, 1);
  assert.equal(spawnCalls, 1);
  assert.equal(credentialSmokeCalls, 0);
}

{
  let exactBuildCalls = 0;
  let credentialSmokeCalls = 0;
  await assert.rejects(
    () => runAmazonAdsDevSecretProvision({
      env:secrets,
      commitSha:sha,
      async exactBuild() {
        exactBuildCalls += 1;
        return { commitSha:sha, buildOutcome:'success', buildUuid:'11111111-1111-4111-8111-111111111111' };
      },
      async smoke() { return { deploymentExact:true, amazonAdsEnabled:false }; },
      spawn(command, args) {
        if (args.includes('bulk')) return { status:0 };
        if (args.includes('list')) return { status:0, stdout:'[]' };
        throw new Error(`unexpected command ${command}`);
      },
      async credentialSmoke() {
        credentialSmokeCalls += 1;
        return { lwaTokenRefresh:'pass' };
      },
    }),
    (error) => error instanceof AmazonAdsDevSecretProvisionError
      && error.code.startsWith('AMAZON_ADS_DEV_SECRET_LIST_MISSING:'),
  );
  assert.equal(exactBuildCalls, 1);
  assert.equal(credentialSmokeCalls, 0);
}

{
  let exactBuildCalls = 0;
  await assert.rejects(
    () => runAmazonAdsDevSecretProvision({
      env:secrets,
      commitSha:sha,
      async exactBuild() {
        exactBuildCalls += 1;
        return {
          commitSha:sha,
          buildOutcome:'success',
          buildUuid:exactBuildCalls === 1
            ? '11111111-1111-4111-8111-111111111111'
            : '22222222-2222-4222-8222-222222222222',
        };
      },
      async smoke() { return { deploymentExact:true, amazonAdsEnabled:false, runtimeVersionId:'version-after-secrets' }; },
      spawn(command, args) {
        if (args.includes('bulk')) return { status:0 };
        if (args.includes('list')) {
          return {
            status:0,
            stdout:JSON.stringify(AMAZON_ADS_DEV_SECRET_NAMES.map((name) => ({ name, type:'secret_text' }))),
          };
        }
        throw new Error(`unexpected command ${command}`);
      },
      async credentialSmoke() { return { lwaTokenRefresh:'fail' }; },
    }),
    /AMAZON_ADS_DEV_CREDENTIAL_SMOKE_NOT_PASS/,
  );
  assert.equal(exactBuildCalls, 2);
}

{
  let spawnCalls = 0;
  await assert.rejects(
    () => runAmazonAdsDevSecretProvision({
      env:secrets,
      commitSha:sha,
      async exactBuild() {
        return { commitSha:sha, buildOutcome:'failure', buildUuid:'11111111-1111-4111-8111-111111111111' };
      },
      spawn() {
        spawnCalls += 1;
        return { status:0 };
      },
      async smoke() {
        throw new Error('health must not run after failed prebuild');
      },
      async credentialSmoke() {
        throw new Error('credential smoke must not run after failed prebuild');
      },
    }),
    /AMAZON_ADS_DEV_PREBUILD_NOT_SUCCESS/,
  );
  assert.equal(spawnCalls, 0);
}

console.log('Cloudflare Amazon Ads Dev secret provisioning tests: PASS');
