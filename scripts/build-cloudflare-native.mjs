import { access, cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
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

await cp(path.join(repoRoot, 'index.html'), path.join(outputDir, 'index.html'));
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
}, null, 2));
