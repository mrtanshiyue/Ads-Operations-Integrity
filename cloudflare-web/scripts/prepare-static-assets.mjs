import { cp, copyFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cloudflareWebDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(cloudflareWebDir, '..');
const distDir = path.join(cloudflareWebDir, 'dist');
const sourceIndex = path.join(repoRoot, 'index.html');
const sourceAssets = path.join(repoRoot, 'assets');

await assertExists(sourceIndex, 'index.html');
await assertExists(sourceAssets, 'assets directory');

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await copyFile(sourceIndex, path.join(distDir, 'index.html'));
await cp(sourceAssets, path.join(distDir, 'assets'), { recursive: true });

console.log(`Prepared Cloudflare Static Assets in ${path.relative(repoRoot, distDir)}`);

async function assertExists(target, label) {
  try {
    await stat(target);
  } catch {
    throw new Error(`Required ${label} not found at ${target}`);
  }
}
