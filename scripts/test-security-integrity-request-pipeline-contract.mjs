import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (relativePath) => readFile(path.join(repoRoot, relativePath), 'utf8');

const [
  testConfig,
  integration,
  accessSource,
  actorSource,
  webEntry,
  canonicalCi,
] = await Promise.all([
  text('cloudflare/runtime/wrangler.access-integration-test.jsonc'),
  text('scripts/test-access-web-worker-integration.mjs'),
  text('src/access.js'),
  text('src/access-actor.js'),
  text('cloudflare/runtime/web-entry.js'),
  text('.github/workflows/cloudflare-native-canonical-ci.yml'),
]);

assert.match(testConfig, /"main"\s*:\s*"\.\/web-entry\.js"/);
assert.match(testConfig, /"ACCESS_MODE"\s*:\s*"enforce"/);
assert.match(testConfig, /"TEAM_DOMAIN"\s*:\s*"https:\/\/security-test\.cloudflareaccess\.com"/);
assert.match(testConfig, /"ACCESS_AUD"\s*:\s*"security-test-audience"/);
assert.match(testConfig, /"binding"\s*:\s*"CONTROL_DB"/);
assert.match(testConfig, /"migrations_dir"\s*:\s*"\.\.\/foundation\/migrations\/control"/);
assert.match(testConfig, /"SYNC_TRIGGER_ENABLED"\s*:\s*"false"/);
assert.match(testConfig, /"AMAZON_ADS_ENABLED"\s*:\s*"false"/);

assert.match(integration, /createTestHarness/);
assert.match(integration, /applyD1Migrations\('CONTROL_DB'\)/);
assert.match(integration, /crypto\.subtle\.generateKey/);
assert.match(integration, /RSASSA-PKCS1-v1_5/);
assert.match(integration, /alg:\s*'RS256'/);
assert.match(integration, /globalThis\.fetch\s*=\s*async/);
assert.match(integration, /\/cdn-cgi\/access\/certs/);
assert.match(integration, /cf-access-jwt-assertion/);
assert.match(integration, /assertMissingJwt/);
assert.match(integration, /assertInvalidSignature/);
assert.match(integration, /assertInvalidAudience/);
assert.match(integration, /assertSubjectMismatch/);
assert.match(integration, /assertFirstBind/);
assert.match(integration, /assertDisabledUserDenied/);
assert.match(integration, /assertOwnerGovernanceMutation/);
assert.match(integration, /user\.global_role\.grant/);
assert.match(integration, /remoteD1Touched:\s*false/);
assert.doesNotMatch(integration, /X-Test-User|x-test-user|auth[-_ ]?bypass|skip[-_ ]?auth/i);

assert.match(accessSource, /cf-access-jwt-assertion/);
assert.match(accessSource, /RS256/);
assert.match(accessSource, /\/cdn-cgi\/access\/certs/);
assert.match(accessSource, /crypto\.subtle\.verify/);
assert.match(accessSource, /cloudflareaccess\.com/);
assert.doesNotMatch(accessSource, /X-Test-User|x-test-user|auth[-_ ]?bypass|skip[-_ ]?auth/i);

assert.match(actorSource, /access_subject_mismatch/);
assert.match(actorSource, /cf_access_sub IS NULL/);
assert.match(actorSource, /status = 'active'/);
assert.doesNotMatch(actorSource, /X-Test-User|x-test-user|auth[-_ ]?bypass|skip[-_ ]?auth/i);

assert.match(webEntry, /evaluateAccessIdentity/);
assert.match(webEntry, /enforceStrictAccessActorBinding/);
assert.match(webEntry, /ACCESS_MODE/);
assert.match(webEntry, /handleGlobalRoleGovernanceApiRoute/);
assert.doesNotMatch(webEntry, /X-Test-User|x-test-user|auth[-_ ]?bypass|skip[-_ ]?auth/i);

assert.match(canonicalCi, /Validate full Access JWT request pipeline/);
assert.match(canonicalCi, /test-access-web-worker-integration\.mjs/);
assert.match(canonicalCi, /name:\s*Static site and security invariants/);

console.log(JSON.stringify({
  ok: true,
  contract: 'security-integrity-access-request-pipeline-v1',
  productionWebEntryExercised: true,
  accessModeEnforced: true,
  realRs256JwtRequired: true,
  jwksOutboundMockBoundary: 'node-global-fetch',
  strictActorBindingRequired: true,
  realLocalD1Required: true,
  governanceMutationAndAuditRequired: true,
  authBypassForbidden: true,
  remoteD1Forbidden: true,
}));
