import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
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

// Cloudflare-only transport overlay: keep the repository-root/GitHub Pages asset
// pointed at the public Warehouse rollback URL, but make the Cloudflare build use
// the frontend Worker's same-origin /api/v1/* BFF. The BFF forwards privately
// through the WAREHOUSE Service Binding while preserving the existing Bearer
// password contract during Phase 2A.
const warehouseLoaderPath = resolve(dist, 'assets/private-cloud-warehouse-v4.js');
const publicWarehouseOrigin = "const API_ORIGIN = 'https://amazon-warehouse-cloud-v4.tanshiyuesir.workers.dev';";
const sameOriginWarehouse = 'const API_ORIGIN = window.location.origin;';
const warehouseLoader = await readFile(warehouseLoaderPath, 'utf8');
const matches = warehouseLoader.split(publicWarehouseOrigin).length - 1;
if (matches !== 1) {
  throw new Error(`Expected exactly one Warehouse API origin marker, found ${matches}`);
}
await writeFile(
  warehouseLoaderPath,
  warehouseLoader.replace(publicWarehouseOrigin, sameOriginWarehouse),
  'utf8',
);

for (const source of requiredSources) {
  const outputPath = source === 'index.html' ? 'index.html' : source;
  const info = await stat(resolve(dist, outputPath));
  if (!info.isFile() || info.size === 0) {
    throw new Error(`Cloudflare artifact is incomplete: ${outputPath}`);
  }
}

console.log('Cloudflare static artifact ready: dist/index.html + dist/assets/**');
console.log('Cloudflare transport overlay ready: Warehouse API -> same-origin /api/v1/*');
