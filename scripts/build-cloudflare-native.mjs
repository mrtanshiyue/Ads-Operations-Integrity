import { access, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(repoRoot, 'dist-cloudflare-native');
const required = [
  'index.html',
  'assets',
  'assets/cloudflare-native-api-v1.js',
  'assets/cloudflare-native-negative-governance-v1.js',
  'assets/cloudflare-native-query-bridge-v1.js',
  'assets/cloudflare-gate6-acceptance-v1.js',
  'assets/cloudflare-gate7-ui-acceptance-v1.js',
];

for (const entry of required) {
  await access(path.join(repoRoot, entry), constants.R_OK);
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

// The native runtime owns the Query Client transport. Strip the previous browser query client
// from the deployment artifact only; the repository source remains untouched for rollback.
const legacyQueryScriptPattern = /<script\b[^>]*src=["'][^"']*assets\/private-cloud-query-v1\.js[^"']*["'][^>]*>\s*<\/script>\s*/gi;
const legacyQueryMatches = nativeIndex.match(legacyQueryScriptPattern) || [];
nativeIndex = nativeIndex.replace(legacyQueryScriptPattern, '');

const nativeClientTag = '<script src="assets/cloudflare-native-api-v1.js"></script>';
const negativeGovernanceTag = '<script src="assets/cloudflare-native-negative-governance-v1.js"></script>';
const nativeBridgeTag = '<script src="assets/cloudflare-native-query-bridge-v1.js"></script>';
const gate6AcceptanceTag = '<script src="assets/cloudflare-gate6-acceptance-v1.js"></script>';
const gate7AcceptanceTag = '<script src="assets/cloudflare-gate7-ui-acceptance-v1.js"></script>';
const nativeTags = `  ${nativeClientTag}\n  ${negativeGovernanceTag}\n  ${nativeBridgeTag}\n  ${gate6AcceptanceTag}\n  ${gate7AcceptanceTag}\n`;
for (const tag of [nativeClientTag, negativeGovernanceTag, nativeBridgeTag, gate6AcceptanceTag, gate7AcceptanceTag]) {
  nativeIndex = nativeIndex.replaceAll(tag, '');
}
nativeIndex = nativeIndex.replace(/<\/head>/i, `${nativeTags}</head>`);
if (
  !nativeIndex.includes(nativeClientTag)
  || !nativeIndex.includes(negativeGovernanceTag)
  || !nativeIndex.includes(nativeBridgeTag)
  || !nativeIndex.includes(gate6AcceptanceTag)
  || !nativeIndex.includes(gate7AcceptanceTag)
) {
  throw new Error('Failed to inject the native browser API/negative governance/query bridge/Gate 6/Gate 7 clients');
}
if (legacyQueryScriptPattern.test(nativeIndex)) {
  throw new Error('Legacy private cloud query client remains in native index');
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
  negativeGovernanceClient: 'assets/cloudflare-native-negative-governance-v1.js',
  nativeQueryBridge: 'assets/cloudflare-native-query-bridge-v1.js',
  gate6AcceptanceClient: 'assets/cloudflare-gate6-acceptance-v1.js',
  gate7AcceptanceClient: 'assets/cloudflare-gate7-ui-acceptance-v1.js',
  legacyQueryScriptTagsRemoved: legacyQueryMatches.length,
}, null, 2));
