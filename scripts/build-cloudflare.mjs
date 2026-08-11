import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist');
const requiredSources = [
  'index.html',
  'assets/private-cloud-warehouse-v4.js',
  'assets/private-cloud-query-v1.js',
  'assets/query-native-module-data-v1.js',
  'assets/query-native-ads-trend-v1.js',
  'assets/query-native-ads-trend-host-v1.js',
];

async function assertFile(relativePath) {
  const info = await stat(resolve(root, relativePath));
  if (!info.isFile() || info.size === 0) {
    throw new Error(`Required source is missing or empty: ${relativePath}`);
  }
}

for (const source of requiredSources) await assertFile(source);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(root, 'index.html'), resolve(dist, 'index.html'));
await cp(resolve(root, 'assets'), resolve(dist, 'assets'), { recursive: true });

for (const source of requiredSources) {
  const outputPath = source === 'index.html' ? 'index.html' : source;
  const info = await stat(resolve(dist, outputPath));
  if (!info.isFile() || info.size === 0) {
    throw new Error(`Cloudflare artifact is incomplete: ${outputPath}`);
  }
}

console.log('Cloudflare static artifact ready: dist/index.html + dist/assets/**');
