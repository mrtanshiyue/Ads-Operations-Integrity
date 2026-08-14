import { access, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(repoRoot, 'dist-cloudflare-native');
const required = ['index.html', 'assets'];

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

// The Cloudflare-native runtime exposes all browser APIs on the same origin under /api/*.
// Remove legacy external API origins from the deployment artifact without mutating source index.html.
const nativeIndex = sourceIndex.replace(connectSrcPattern, "connect-src 'self';");
if (!/connect-src\s+'self';/i.test(nativeIndex)) {
  throw new Error('Failed to enforce same-origin connect-src in native build');
}
await writeFile(path.join(outputDir, 'index.html'), nativeIndex, 'utf8');

await cp(path.join(repoRoot, 'assets'), path.join(outputDir, 'assets'), {
  recursive: true,
  filter(source) {
    const base = path.basename(source);
    return base !== '.DS_Store' && base !== 'Thumbs.db';
  },
});

await writeFile(path.join(outputDir, '_headers'), `/*\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: strict-origin-when-cross-origin\n  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()\n\n/index.html\n  Cache-Control: no-cache\n`, 'utf8');

const indexStat = await stat(path.join(outputDir, 'index.html'));
if (indexStat.size < 1024) throw new Error('Built index.html is unexpectedly small');

console.log(JSON.stringify({
  ok: true,
  output: path.relative(repoRoot, outputDir),
  indexBytes: indexStat.size,
  browserConnectPolicy: "'self'",
}, null, 2));
