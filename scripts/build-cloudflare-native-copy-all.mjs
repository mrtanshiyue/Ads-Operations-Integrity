import { access, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(repoRoot, 'dist-cloudflare-native');
const required = [
  'index.html',
  'assets',
  'assets/cloudflare-native-api-v1.js',
  'assets/cloudflare-native-keyword-governance-v1.js',
  'assets/cloudflare-native-negative-governance-v1.js',
  'assets/cloudflare-native-audit-console-v1.js',
  'assets/cloudflare-native-access-console-v1.js',
  'assets/cloudflare-native-query-bridge-v1.js',
  'assets/cloudflare-native-data-panel-v1.js',
  'assets/cloudflare-gate6-acceptance-v1.js',
  'assets/cloudflare-gate7-ui-acceptance-v1.js',
];

for (const entry of required) {
  await access(path.join(repoRoot, entry), constants.R_OK);
}

const keywordGovernancePath = path.join(repoRoot, 'assets/cloudflare-native-keyword-governance-v1.js');
const keywordGovernanceSource = await readFile(keywordGovernancePath, 'utf8');
new vm.Script(keywordGovernanceSource, { filename: 'cloudflare-native-keyword-governance-v1.js' });
if (/AMAZON_ADS|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED|startSync\s*\(|wrangler\s+deploy/i.test(keywordGovernanceSource)) {
  throw new Error('Keyword governance console must remain isolated from Amazon/sync/direct deployment transports');
}
if (!/CloudflareNativeAPI/.test(keywordGovernanceSource) || !/CloudflareKeywordGovernance/.test(keywordGovernanceSource)) {
  throw new Error('Keyword governance console must expose its Native API delegated public contract');
}

const auditConsolePath = path.join(repoRoot, 'assets/cloudflare-native-audit-console-v1.js');
const auditConsoleSource = await readFile(auditConsolePath, 'utf8');
new vm.Script(auditConsoleSource, { filename: 'cloudflare-native-audit-console-v1.js' });
if (/AMAZON_ADS|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED|startSync\s*\(|putStoreNegativeKeyword|putProductNegativeKeyword/.test(auditConsoleSource)) {
  throw new Error('Audit console must remain read-only and isolated from Amazon/sync/write transports');
}
const auditCalls = [];
const auditSandboxWindow = {
  CloudflareNativeAPI: {
    auditEvents(params) {
      auditCalls.push({ ...params });
      return Promise.resolve({ items: [], nextCursor: null });
    },
  },
};
vm.runInNewContext(auditConsoleSource, { window: auditSandboxWindow, console }, { filename: 'cloudflare-native-audit-console-v1.js' });
if (!auditSandboxWindow.CloudflareAuditConsole || auditSandboxWindow.CloudflareAuditConsole.version !== '1.0.0') {
  throw new Error('Audit console public contract was not installed');
}
await auditSandboxWindow.CloudflareAuditConsole.listEvents({ storeId: 'store-dev-01', limit: 7 });
if (auditCalls.length !== 1 || auditCalls[0].storeId !== 'store-dev-01' || auditCalls[0].limit !== 7) {
  throw new Error('Audit console must delegate reads to CloudflareNativeAPI.auditEvents');
}

const accessConsolePath = path.join(repoRoot, 'assets/cloudflare-native-access-console-v1.js');
const accessConsoleSource = await readFile(accessConsolePath, 'utf8');
new vm.Script(accessConsoleSource, { filename: 'cloudflare-native-access-console-v1.js' });
if (/AMAZON_ADS|AMAZON_SYNC_WORKFLOW|SYNC_TRIGGER_ENABLED|startSync\s*\(|user_global_roles|role_scope\s*=\s*['"]global/.test(accessConsoleSource)) {
  throw new Error('Access console must remain isolated from Amazon/sync/global-role write transports');
}
const accessCalls = [];
const accessSandboxWindow = {
  CloudflareNativeAPI: {
    accessRoles(params) {
      accessCalls.push({ method: 'roles', params: { ...params } });
      return Promise.resolve({ roles: [] });
    },
    accessUsers(params) {
      accessCalls.push({ method: 'users', params: { ...params } });
      return Promise.resolve({ items: [] });
    },
    createAccessUser(body) {
      accessCalls.push({ method: 'create-user', body: { ...body } });
      return Promise.resolve({
        user: {
          userId: 'user-new',
          email: body.email,
          displayName: body.displayName || null,
          status: 'active',
          cfAccessBound: false,
          globalRoles: [],
        },
      });
    },
    updateAccessUserStatus(userId, status) {
      accessCalls.push({ method: 'user-status', userId, status });
      return Promise.resolve({ changed: true, user: { userId, status } });
    },
    storeMembers(storeId, params) {
      accessCalls.push({ method: 'members', storeId, params: { ...params } });
      return Promise.resolve({ items: [] });
    },
    putStoreMember(storeId, userId, body) {
      accessCalls.push({ method: 'put', storeId, userId, body: { ...body } });
      return Promise.resolve({ member: { userId, roleKey: body.roleKey } });
    },
    deleteStoreMember(storeId, userId) {
      accessCalls.push({ method: 'delete', storeId, userId });
      return Promise.resolve({ deleted: true });
    },
  },
};
vm.runInNewContext(accessConsoleSource, { window: accessSandboxWindow, console }, { filename: 'cloudflare-native-access-console-v1.js' });
if (!accessSandboxWindow.CloudflareAccessConsole || accessSandboxWindow.CloudflareAccessConsole.version !== '1.2.0') {
  throw new Error('Access console public contract was not installed');
}
await auditSandboxWindow.CloudflareAuditConsole.listEvents({ limit: 1 });
await accessSandboxWindow.CloudflareAccessConsole.listRoles();
await accessSandboxWindow.CloudflareAccessConsole.listUsers();
await accessSandboxWindow.CloudflareAccessConsole.createUser(' new.user@example.test ', ' New User ');
await accessSandboxWindow.CloudflareAccessConsole.updateUserStatus('user-dev-01', 'disabled');
await accessSandboxWindow.CloudflareAccessConsole.listMembers('store-dev-01');
await accessSandboxWindow.CloudflareAccessConsole.putMember('store-dev-01', 'user-dev-01', 'analyst');
await accessSandboxWindow.CloudflareAccessConsole.deleteMember('store-dev-01', 'user-dev-01');
if (!accessCalls.some((call) => call.method === 'roles' && call.params.scope === 'store')) {
  throw new Error('Access console must read store-scoped role catalog');
}
if (!accessCalls.some((call) => call.method === 'users' && !('status' in call.params) && call.params.limit === 200)) {
  throw new Error('Access console must read the all-status user catalog through CloudflareNativeAPI');
}
const createUserCall = accessCalls.find((call) => call.method === 'create-user');
if (!createUserCall || createUserCall.body.email !== 'new.user@example.test' || createUserCall.body.displayName !== 'New User') {
  throw new Error('Access console must delegate user provisioning with email/displayName only');
}
if ('globalRoles' in createUserCall.body || 'roleKey' in createUserCall.body || 'status' in createUserCall.body) {
  throw new Error('Access console must not include privilege or lifecycle fields in user provisioning');
}
if (!accessCalls.some((call) => call.method === 'user-status' && call.userId === 'user-dev-01' && call.status === 'disabled')) {
  throw new Error('Access console must delegate ordinary-user lifecycle updates to CloudflareNativeAPI');
}
if (!accessCalls.some((call) => call.method === 'members' && call.storeId === 'store-dev-01' && call.params.limit === 200)) {
  throw new Error('Access console must read store members through CloudflareNativeAPI');
}
if (!accessCalls.some((call) => call.method === 'put' && call.body.roleKey === 'analyst')) {
  throw new Error('Access console must delegate store membership writes to CloudflareNativeAPI');
}
if (!accessCalls.some((call) => call.method === 'delete' && call.userId === 'user-dev-01')) {
  throw new Error('Access console must delegate member removal through CloudflareNativeAPI');
}

const dataPanelSource = await readFile(path.join(repoRoot, 'assets/cloudflare-native-data-panel-v1.js'), 'utf8');
new vm.Script(dataPanelSource, { filename: 'cloudflare-native-data-panel-v1.js' });
if (/sessionStorage|X-Dashboard-Password|amazon-warehouse-cloud-v4\.tanshiyuesir\.workers\.dev/.test(dataPanelSource)) {
  throw new Error('Native data panel must not retain Warehouse password/session transport');
}
if (!/CloudflareNativeQueryBridge/.test(dataPanelSource) || !/cloudflare_native_raw_import_not_migrated/.test(dataPanelSource)) {
  throw new Error('Native data panel must delegate to the native query bridge and fail closed for cloud Raw import');
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

const sourceIndex = await readFile(path.join(repoRoot, 'index.html'), 'utf8');
const connectSrcPattern = /connect-src\s+[^;]+;/i;
if (!connectSrcPattern.test(sourceIndex)) {
  throw new Error('index.html CSP is missing connect-src; refusing to build without an explicit network boundary');
}
if (!/<\/head>/i.test(sourceIndex)) {
  throw new Error('index.html is missing </head>; cannot inject the native API client safely');
}

// The Cloudflare-native runtime exposes all browser APIs on the same origin under /api/*.
// Remove legacy external API origins from the deployment artifact without mutating source index.html.
let nativeIndex = sourceIndex.replace(connectSrcPattern, "connect-src 'self';");
if (!/connect-src\s+'self';/i.test(nativeIndex)) {
  throw new Error('Failed to enforce same-origin connect-src in native build');
}

// The native runtime owns all cloud-query and cloud-data browser transports.
// Strip the old query client plus both generations of Warehouse browser loaders from the artifact.
const retiredScriptPatterns = [
  {
    name: 'private-cloud-query-v1',
    pattern: /<script\b[^>]*src=["'][^"']*assets\/private-cloud-query-v1\.js[^"']*["'][^>]*>\s*<\/script>\s*/gi,
  },
  {
    name: 'generated-inline-script-09',
    pattern: /<script\b[^>]*src=["'][^"']*assets\/generated\/inline-script-09\.js[^"']*["'][^>]*>\s*<\/script>\s*/gi,
  },
  {
    name: 'generated-inline-script-11',
    pattern: /<script\b[^>]*src=["'][^"']*assets\/generated\/inline-script-11\.js[^"']*["'][^>]*>\s*<\/script>\s*/gi,
  },
  {
    name: 'private-cloud-warehouse-v4',
    pattern: /<script\b[^>]*src=["'][^"']*assets\/private-cloud-warehouse-v4\.js[^"']*["'][^>]*>\s*<\/script>\s*/gi,
  },
];
const retiredScriptTagsRemoved = {};
for (const entry of retiredScriptPatterns) {
  const matches = nativeIndex.match(entry.pattern) || [];
  retiredScriptTagsRemoved[entry.name] = matches.length;
  nativeIndex = nativeIndex.replace(entry.pattern, '');
}

const nativeClientTag = '<script src="assets/cloudflare-native-api-v1.js"></script>';
const keywordGovernanceTag = '<script src="assets/cloudflare-native-keyword-governance-v1.js"></script>';
const negativeGovernanceTag = '<script src="assets/cloudflare-native-negative-governance-v1.js"></script>';
const auditConsoleTag = '<script src="assets/cloudflare-native-audit-console-v1.js"></script>';
const accessConsoleTag = '<script src="assets/cloudflare-native-access-console-v1.js"></script>';
const nativeBridgeTag = '<script src="assets/cloudflare-native-query-bridge-v1.js"></script>';
const nativeDataPanelTag = '<script src="assets/cloudflare-native-data-panel-v1.js"></script>';
const gate6AcceptanceTag = '<script src="assets/cloudflare-gate6-acceptance-v1.js"></script>';
const gate7AcceptanceTag = '<script src="assets/cloudflare-gate7-ui-acceptance-v1.js"></script>';
const nativeTags = `  ${nativeClientTag}\n  ${keywordGovernanceTag}\n  ${negativeGovernanceTag}\n  ${auditConsoleTag}\n  ${accessConsoleTag}\n  ${nativeBridgeTag}\n  ${nativeDataPanelTag}\n  ${gate6AcceptanceTag}\n  ${gate7AcceptanceTag}\n`;
for (const tag of [nativeClientTag, keywordGovernanceTag, negativeGovernanceTag, auditConsoleTag, accessConsoleTag, nativeBridgeTag, nativeDataPanelTag, gate6AcceptanceTag, gate7AcceptanceTag]) {
  nativeIndex = nativeIndex.replaceAll(tag, '');
}
nativeIndex = nativeIndex.replace(/<\/head>/i, `${nativeTags}</head>`);
if (
  !nativeIndex.includes(nativeClientTag)
  || !nativeIndex.includes(keywordGovernanceTag)
  || !nativeIndex.includes(negativeGovernanceTag)
  || !nativeIndex.includes(auditConsoleTag)
  || !nativeIndex.includes(accessConsoleTag)
  || !nativeIndex.includes(nativeBridgeTag)
  || !nativeIndex.includes(nativeDataPanelTag)
  || !nativeIndex.includes(gate6AcceptanceTag)
  || !nativeIndex.includes(gate7AcceptanceTag)
) {
  throw new Error('Failed to inject the native browser API/keyword/negative/audit/access/query/data-panel/Gate clients');
}
if ((nativeIndex.split(keywordGovernanceTag).length - 1) !== 1) {
  throw new Error('Keyword governance console client must be injected exactly once');
}
if ((nativeIndex.split(auditConsoleTag).length - 1) !== 1) {
  throw new Error('Audit console client must be injected exactly once');
}
if ((nativeIndex.split(accessConsoleTag).length - 1) !== 1) {
  throw new Error('Access console client must be injected exactly once');
}
if ((nativeIndex.split(nativeDataPanelTag).length - 1) !== 1) {
  throw new Error('Native data panel must be injected exactly once');
}
for (const entry of retiredScriptPatterns) {
  if ((nativeIndex.match(entry.pattern) || []).length) {
    throw new Error(`Retired cloud loader remains in native index: ${entry.name}`);
  }
}

await writeFile(path.join(outputDir, 'index.html'), nativeIndex, 'utf8');

await cp(path.join(repoRoot, 'assets'), path.join(outputDir, 'assets'), {
  recursive: true,
  filter(source) {
    const base = path.basename(source);
    return base !== '.DS_Store' && base !== 'Thumbs.db';
  },
});

// Native-only provenance correction. The adapter logic remains unchanged, but native builds
// must not claim the retired backend as their data source.
const moduleDataPath = path.join(outputDir, 'assets/query-native-module-data-v1.js');
try {
  const moduleData = await readFile(moduleDataPath, 'utf8');
  const sourceTokenCount = (moduleData.match(/query-tidb/g) || []).length;
  if (sourceTokenCount) {
    await writeFile(moduleDataPath, moduleData.replaceAll('query-tidb', 'query-cloudflare-d1'), 'utf8');
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

await writeFile(path.join(outputDir, '_headers'), `/*\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()\n\n/index.html\n  Cache-Control: no-cache\n`, 'utf8');

const indexStat = await stat(path.join(outputDir, 'index.html'));
if (indexStat.size < 1024) throw new Error('Built index.html is unexpectedly small');

console.log(JSON.stringify({
  ok: true,
  output: path.relative(repoRoot, outputDir),
  indexBytes: indexStat.size,
  browserConnectPolicy: "'self'",
  nativeApiClient: 'assets/cloudflare-native-api-v1.js',
  keywordGovernanceClient: 'assets/cloudflare-native-keyword-governance-v1.js',
  keywordGovernanceContract: 'control-d1-native-api-no-amazon-sync',
  negativeGovernanceClient: 'assets/cloudflare-native-negative-governance-v1.js',
  auditConsoleClient: 'assets/cloudflare-native-audit-console-v1.js',
  auditConsoleContract: 'read-only-native-api',
  accessConsoleClient: 'assets/cloudflare-native-access-console-v1.js',
  accessConsoleContract: 'user-provisioning-lifecycle-and-store-membership',
  nativeQueryBridge: 'assets/cloudflare-native-query-bridge-v1.js',
  nativeDataPanel: 'assets/cloudflare-native-data-panel-v1.js',
  nativeDataPanelContract: 'same-origin-query-and-raw-fail-closed',
  gate6AcceptanceClient: 'assets/cloudflare-gate6-acceptance-v1.js',
  gate7AcceptanceClient: 'assets/cloudflare-gate7-ui-acceptance-v1.js',
  retiredScriptTagsRemoved,
}, null, 2));