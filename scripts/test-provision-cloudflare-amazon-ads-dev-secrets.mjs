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
  CI:'true',
});
for (const name of AMAZON_ADS_DEV_SECRET_NAMES) {
  assert.equal(Object.prototype.hasOwnProperty.call(sanitized, name), false);
}
assert.equal(sanitized.CLOUDFLARE_API_TOKEN, 'cloudflare-token');
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
  const spawnCalls = [];
  const smokeCalls = [];
  const releaseCalls = [];
  const result = await runAmazonAdsDevSecretProvision({
    cwd:'/repo',
    env:{
      ...secrets,
      CLOUDFLARE_API_TOKEN:'cloudflare-token',
      SYNC_DEV_HEALTH_URL:'https://sync.example.workers.dev/health',
    },
    commitSha:sha,
    spawn(command, args, options) {
      spawnCalls.push({ command, args, options });
      if (args.includes('bulk')) return { status:0 };
      if (args.includes('list')) {
        return {
          status:0,
          stdout:JSON.stringify(AMAZON_ADS_DEV_SECRET_NAMES.map((name) => ({ name, type:'secret_text' }))),
        };
      }
      throw new Error(`unexpected spawn: ${command} ${args.join(' ')}`);
    },
    async smoke(options) {
      smokeCalls.push(options);
      return {
        deploymentExact:smokeCalls.length === 2,
        runtimeVersionId:'version-after-secrets',
      };
    },
    release(options) {
      releaseCalls.push(options);
    },
  });

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
  assert.equal(typeof smokeCalls[1].deploymentEquivalent, 'function');
  assert.equal(await smokeCalls[1].deploymentEquivalent(), false);
  assert.equal(releaseCalls.length, 1);
  assert.equal(releaseCalls[0].commitSha, sha);
  for (const name of AMAZON_ADS_DEV_SECRET_NAMES) {
    assert.equal(Object.prototype.hasOwnProperty.call(releaseCalls[0].env, name), false);
  }
  assert.deepEqual(result, {
    ok:true,
    commitSha:sha,
    secretNames:[...AMAZON_ADS_DEV_SECRET_NAMES].sort(),
    amazonAdsEnabled:false,
    runtimeVersionId:'version-after-secrets',
  });
}

{
  let smokeCalls = 0;
  let spawnCalls = 0;
  await assert.rejects(
    () => runAmazonAdsDevSecretProvision({
      env:secrets,
      commitSha:sha,
      async smoke() {
        smokeCalls += 1;
        return { deploymentExact:true };
      },
      spawn() {
        spawnCalls += 1;
        return { status:17 };
      },
      release() {
        throw new Error('release must not run');
      },
    }),
    /AMAZON_ADS_DEV_SECRET_BULK_FAILED:17/,
  );
  assert.equal(smokeCalls, 1);
  assert.equal(spawnCalls, 1);
}

{
  let releaseCalls = 0;
  await assert.rejects(
    () => runAmazonAdsDevSecretProvision({
      env:secrets,
      commitSha:sha,
      async smoke() { return { deploymentExact:true }; },
      spawn(command, args) {
        if (args.includes('bulk')) return { status:0 };
        if (args.includes('list')) return { status:0, stdout:'[]' };
        throw new Error(`unexpected command ${command}`);
      },
      release() { releaseCalls += 1; },
    }),
    (error) => error instanceof AmazonAdsDevSecretProvisionError
      && error.code.startsWith('AMAZON_ADS_DEV_SECRET_LIST_MISSING:'),
  );
  assert.equal(releaseCalls, 0);
}

console.log('Cloudflare Amazon Ads Dev secret provisioning tests: PASS');
