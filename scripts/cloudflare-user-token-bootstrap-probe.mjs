import { mkdir, writeFile } from 'node:fs/promises';

const API_TOKEN = required('CLOUDFLARE_BOOTSTRAP_API_TOKEN');
const RUN_ID = String(process.env.GITHUB_RUN_ID || Date.now());
const OUT = 'artifacts/cloudflare-user-token-bootstrap-probe';

await mkdir(OUT, { recursive: true });

const receipt = {
  schemaVersion: 'cloudflare-user-token-bootstrap-probe-v1',
  runId: RUN_ID,
  sideEffectPolicy: 'GET-only; no token creation/update/roll/delete',
  statuses: {},
  checks: {},
  result: 'NO_USER_TOKEN_BOOTSTRAP_CAPABILITY',
  startedAt: new Date().toISOString(),
};

try {
  const verify = await cfGet('/user/tokens/verify');
  receipt.statuses.verify = verify.status;
  const tokenId = verify.body?.result?.id || null;
  receipt.checks.bootstrapTokenActive = verify.status === 200 && verify.body?.result?.status === 'active';

  if (tokenId) {
    const details = await cfGet(`/user/tokens/${encodeURIComponent(tokenId)}`);
    receipt.statuses.details = details.status;
    const permissionNames = Array.isArray(details.body?.result?.policies)
      ? details.body.result.policies.flatMap((policy) => Array.isArray(policy?.permission_groups)
        ? policy.permission_groups.map((group) => String(group?.name || '')).filter(Boolean)
        : [])
      : [];
    receipt.checks.userApiTokensWrite = permissionNames.includes('API Tokens Write');
  } else {
    receipt.statuses.details = null;
    receipt.checks.userApiTokensWrite = false;
  }

  const groups = await cfGet('/user/tokens/permission_groups');
  receipt.statuses.permissionGroups = groups.status;
  const names = Array.isArray(groups.body?.result)
    ? groups.body.result.map((group) => String(group?.name || '')).filter(Boolean)
    : [];
  const requiredChildGroups = [
    'Access: Apps and Policies Write',
    'Access: Service Tokens Write',
    'D1 Write',
    'Workers CI Write',
    'Workers Scripts Read',
  ];
  receipt.checks.requiredChildPermissionGroups = Object.fromEntries(
    requiredChildGroups.map((name) => [name, names.includes(name)]),
  );
  receipt.checks.permissionGroupsDiscoverable = groups.status === 200;

  const childGroupsAvailable = requiredChildGroups.every((name) => names.includes(name));
  if (receipt.checks.bootstrapTokenActive && receipt.checks.userApiTokensWrite && childGroupsAvailable) {
    receipt.result = 'BOOTSTRAP_CAN_MINT_USER_LEAST_PRIVILEGE_TOKEN';
  }
} catch (error) {
  receipt.error = { message: scrub(error?.message || String(error)) };
  receipt.result = 'NO_USER_TOKEN_BOOTSTRAP_CAPABILITY';
} finally {
  receipt.finishedAt = new Date().toISOString();
  await writeFile(`${OUT}/receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ result: receipt.result, statuses: receipt.statuses, checks: receipt.checks }));
}

async function cfGet(path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${API_TOKEN}`,
      accept: 'application/json',
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: response.status, body };
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function scrub(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(/cfat_[A-Za-z0-9_-]+/g, 'cfat_[REDACTED]');
}
