import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createD1RestDatabase } from './cloudflare-d1-rest-adapter.mjs';

const ACCOUNT_ID = required('CLOUDFLARE_ACCOUNT_ID');
const API_TOKEN = required('CLOUDFLARE_API_TOKEN');
const CONTROL_DB_ID = required('PROD_CONTROL_DB_ID');
const PROD_ACCESS_APP_ID = required('PROD_ACCESS_APP_ID');
const RUN_ID = required('GITHUB_RUN_ID');
const PRINCIPAL_USER_ID = `svc-owq-acceptance-${RUN_ID}`;
const ROLE_KEY = `owq_acceptance_${RUN_ID}`;
const TOKEN_NAME = `ads-ops-owq-acceptance-${RUN_ID}`;
const POLICY_NAME = `OWQ #247 acceptance ${RUN_ID}`;
const OUT = 'artifacts/operator-work-queue-production-runtime-acceptance';

await mkdir(OUT, { recursive: true });
const controlDb = createD1RestDatabase({ accountId: ACCOUNT_ID, databaseId: CONTROL_DB_ID, apiToken: API_TOKEN });
const cleanupErrors = [];
const actions = {};

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
  try {
    await controlDb.prepare(`DELETE FROM users WHERE user_id=?1`).bind(PRINCIPAL_USER_ID).run();
    actions.principalDisposition = 'deleted';
  } catch {
    await controlDb.prepare(`UPDATE users SET status='disabled', updated_at=CURRENT_TIMESTAMP WHERE user_id=?1`).bind(PRINCIPAL_USER_ID).run();
    actions.principalDisposition = 'disabled_audit_residue';
  }
});
await bestEffort('access_policy', async () => {
  const payload = await cf(`/access/apps/${encodeURIComponent(PROD_ACCESS_APP_ID)}/policies?per_page=100`);
  for (const policy of Array.isArray(payload.result) ? payload.result : []) {
    if (policy?.name === POLICY_NAME && policy?.id) {
      await cf(`/access/apps/${encodeURIComponent(PROD_ACCESS_APP_ID)}/policies/${encodeURIComponent(policy.id)}`, { method: 'DELETE' });
    }
  }
});
await bestEffort('service_token', async () => {
  const payload = await cf('/access/service_tokens?per_page=100');
  for (const token of Array.isArray(payload.result) ? payload.result : []) {
    if (token?.name === TOKEN_NAME && token?.id) await cf(`/access/service_tokens/${encodeURIComponent(token.id)}`, { method: 'DELETE' });
  }
});

const verification = {
  activeStoreMemberships: await count(controlDb, `SELECT COUNT(*) AS count FROM store_members WHERE user_id=?1`, PRINCIPAL_USER_ID),
  rolePermissions: await count(controlDb, `SELECT COUNT(*) AS count FROM role_permissions WHERE role_key=?1`, ROLE_KEY),
  roles: await count(controlDb, `SELECT COUNT(*) AS count FROM app_roles WHERE role_key=?1`, ROLE_KEY),
  activeTemporaryPrincipals: await count(controlDb, `SELECT COUNT(*) AS count FROM users WHERE user_id=?1 AND status='active'`, PRINCIPAL_USER_ID),
  namedAccessPolicies: await countNamedPolicies(),
  namedServiceTokens: await countNamedTokens(),
  accountServiceTokens: await countAllTokens(),
};

for (const [name, value] of Object.entries(verification)) assert.equal(value, 0, `temporary_acceptance_resource_leaked:${name}:${value}`);
if (cleanupErrors.length) throw new Error(`temporary_acceptance_cleanup_errors:${cleanupErrors.join('|')}`);

const result = {
  schemaVersion: 'operator-work-queue-production-runtime-cleanup-v1',
  result: 'PASS',
  runId: RUN_ID,
  actions,
  verification,
  allowedAuditResidue: actions.principalDisposition === 'disabled_audit_residue' ? ['disabled_service_principal'] : [],
  amazonRequests: 0,
};
await writeFile(`${OUT}/cleanup.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));

async function bestEffort(name, operation) {
  try {
    await operation();
    actions[name] = true;
  } catch (error) {
    actions[name] = false;
    cleanupErrors.push(`${name}:${scrub(error?.message || String(error))}`);
  }
}

async function count(db, sql, ...params) {
  const statement = db.prepare(sql);
  const row = params.length ? await statement.bind(...params).first() : await statement.first();
  return Number(row?.count ?? -1);
}

async function countNamedPolicies() {
  const payload = await cf(`/access/apps/${encodeURIComponent(PROD_ACCESS_APP_ID)}/policies?per_page=100`);
  return (Array.isArray(payload.result) ? payload.result : []).filter((row) => row?.name === POLICY_NAME).length;
}

async function countNamedTokens() {
  const payload = await cf('/access/service_tokens?per_page=100');
  return (Array.isArray(payload.result) ? payload.result : []).filter((row) => row?.name === TOKEN_NAME).length;
}

async function countAllTokens() {
  const payload = await cf('/access/service_tokens?per_page=100');
  return (Array.isArray(payload.result) ? payload.result : []).length;
}

async function cf(path, { method = 'GET' } = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(ACCOUNT_ID)}${path}`, {
    method,
    headers: { authorization: `Bearer ${API_TOKEN}`, accept: 'application/json' },
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
