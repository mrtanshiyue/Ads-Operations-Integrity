import { readFileSync, writeFileSync } from 'node:fs';

const path = 'assets/private-cloud-warehouse-v4.js';
let source = readFileSync(path, 'utf8');

function replaceOnce(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, found ${count}`);
  source = source.replace(before, after);
}

replaceOnce("  const LOADER_VERSION = '4.2.2';", "  const LOADER_VERSION = '4.2.3';", 'loader version');
replaceOnce('  const FETCH_CONCURRENCY = 2;', '  const FETCH_CONCURRENCY = 1;', 'Raw concurrency');

if (!source.includes("requestUrl.searchParams.set('__warehouseRetry'")) throw new Error('Retry cache-buster is missing');
if (!source.includes('maxAttempts: 8')) throw new Error('Raw retry ceiling is missing');
if (source.includes("headers.set('Cache-Control'")) throw new Error('Unsupported CORS header returned');
if (/lr_private_cloud_password|sessionStorage|const sessionSafe|getPassword/.test(source)) throw new Error('Persistent credential pattern detected');
writeFileSync(path, source, 'utf8');
