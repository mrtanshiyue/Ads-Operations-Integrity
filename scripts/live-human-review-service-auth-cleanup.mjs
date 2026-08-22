import assert from 'node:assert/strict';
import { createD1RestDatabase } from './cloudflare-d1-rest-adapter.mjs';

const ACCOUNT_ID = required('CLOUDFLARE_ACCOUNT_ID');
const API_TOKEN = required('CLOUDFLARE_API_TOKEN');
const CONTROL_DB_ID = process.env.PROD_CONTROL_DB_ID || '2122248c-1fd4-4ccd-b611-9f9d2f3decbf';
const STORE01_DB_ID = process.env.PROD_STORE01_DB_ID || '2e53bbad-5680-431c-bcf7-68e89b231ea1';
const PROD_ACCESS_APP_ID = process.env.PROD_ACCESS_APP_ID || '499b5470-a257-4aec-9ede-7c3a460a42a4';
const RUN_ID = required('GITHUB_RUN_ID');
const PRINCIPAL_USER_ID = `svc-hr-acceptance-${RUN_ID}`;
const ROLE_KEY = `hr_acceptance_${RUN_ID}`;
const SERVICE_TOKEN_NAME = `ads-ops-human-review-acceptance-${RUN_ID}`;
const ACCESS_POLICY_NAME = `Human Review acceptance ${RUN_ID}`;

const controlDb = createD1RestDatabase({ accountId: ACCOUNT_ID, databaseId: CONTROL_DB_ID, apiToken: API_TOKEN });
const store01Db = createD1RestDatabase({ accountId: ACCOUNT_ID, databaseId: STORE01_DB_ID, apiToken: API_TOKEN });
const cleanupErrors = [];

await bestEffort('review_records', async () => {
  await store01Db.prepare(`DELETE FROM advisory_review_records WHERE reviewer_user_id=?1`).bind(PRINCIPAL_USER_ID).run();
});

await bestEffort('store_members', async () => {
  await controlDb.prepare(`DELETE FROM store_members WHERE user_id=?1`).bind(PRINCIPAL_USER_ID).run();
});

await bestEffort('role_permissions', async () => {
  await controlDb.prepare(`DELETE FROM role_permissions WHERE role_key=?1`).bind(ROLE_KEY).run();
});

await bestEffort('app_role', async () => {
  await controlDb.prepare(`DELETE FROM app_roles WHERE role_key=?1 AND is_system=0`).bind(ROLE_KEY).run();
});

await bestEffort('service_principal', async () => {
  await controlDb.prepare(`DELETE FROM users WHERE user_id=?1`).bind(PRINCIPAL_USER_ID).run();
});

await bestEffort('access_policy', async () => {
  const policies = await cf(`/access/apps/${encodeURIComponent(PROD_ACCESS_APP_ID)}/policies?per_page=100`);
  for (const policy of Array.isArray(policies.result) ? policies.result : []) {
    if (policy?.name === ACCESS_POLICY_NAME && policy?.id) {
      await cf(`/access/apps/${encodeURIComponent(PROD_ACCESS_APP_ID)}/policies/${encodeURIComponent(policy.id)}`, { method: 'DELETE' });
    }
  }
});

await bestEffort('service_token', async () => {
  const tokens = await cf('/access/service_tokens?per_page=100');
  for (const token of Array.isArray(tokens.result) ? tokens.result : []) {
    if (token?.name === SERVICE_TOKEN_NAME && token?.id) {
      await cf(`/access/service_tokens/${encodeURIComponent(token.id)}`, { method: 'DELETE' });
    }
  }
});

const verification = {
  reviewRecords: await count(store01Db, `SELECT COUNT(*) AS count FROM advisory_review_records WHERE reviewer_user_id=?1`, PRINCIPAL_USER_ID),
  storeMemberships: await count(controlDb, `SELECT COUNT(*) AS count FROM store_members WHERE user_id=?1`, PRINCIPAL_USER_ID),
  rolePermissions: await count(controlDb, `SELECT COUNT(*) AS count FROM role_permissions WHERE role_key=?1`, ROLE_KEY),
  roles: await count(controlDb, `SELECT COUNT(*) AS count FROM app_roles WHERE role_key=?1`, ROLE_KEY),
  servicePrincipals: await count(controlDb, `SELECT COUNT(*) AS count FROM users WHERE user_id=?1`, PRINCIPAL_USER_ID),
  accessPolicies: await countNamedAccessPolicies(),
  serviceTokens: await countNamedServiceTokens(),
};

for (const [resource, value] of Object.entries(verification)) {
  assert.equal(value, 0, `temporary_acceptance_resource_leaked:${resource}:${value}`);
}

if (cleanupErrors.length) {
  throw new Error(`temporary_acceptance_cleanup_errors:${cleanupErrors.join('|')}`);
}

console.log(JSON.stringify({
  result: 'PASS',
  runId: RUN_ID,
  verification,
  amazonRequests: 0,
}));

async function bestEffort(resource, operation) {
  try {
    await operation();
  } catch (error) {
    cleanupErrors.push(`${resource}:${scrub(error?.message || String(error))}`);
  }
}

async function count(db, sql, param) {
  const row = await db.prepare(sql).bind(param).first();
  return Number(row?.count ?? -1);
}

async function countNamedAccessPolicies() {
  const policies = await cf(`/access/apps/${encodeURIComponent(PROD_ACCESS_APP_ID)}/policies?per_page=100`);
  return (Array.isArray(policies.result) ? policies.result : []).filter((policy) => policy?.name === ACCESS_POLICY_NAME).length;
}

async function countNamedServiceTokens() {
  const tokens = await cf('/access/service_tokens?per_page=100');
  return (Array.isArray(tokens.result) ? tokens.result : []).filter((token) => token?.name === SERVICE_TOKEN_NAME).length;
}

async function cf(path, { method = 'GET' } = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(ACCOUNT_ID)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      accept: 'application/json',
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.success === false) {
    const code = payload?.errors?.[0]?.code || response.status;
    const message = payload?.errors?.[0]?.message || `HTTP ${response.status}`;
    throw new Error(`cloudflare_api_failed:${path}:${code}:${scrub(message)}`);
  }
  return payload;
}

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}

function scrub(value) {
  let text = String(value || '');
  if (API_TOKEN) text = text.split(API_TOKEN).join('[REDACTED_API_TOKEN]');
  return text.replace(/[\r\n\t]+/g, ' ').trim();
}
