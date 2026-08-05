import { readFileSync, writeFileSync } from 'node:fs';

const loaderPath = 'assets/private-cloud-warehouse-v4.js';
let source = readFileSync(loaderPath, 'utf8');

function replaceOnce(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, found ${count}`);
  source = source.replace(before, after);
}

replaceOnce("  const LOADER_VERSION = '4.2.0';", "  const LOADER_VERSION = '4.2.1';", 'loader version');
replaceOnce('  const FETCH_CONCURRENCY = 3;', '  const FETCH_CONCURRENCY = 2;', 'download concurrency');
replaceOnce(
  "    const maxAttempts = Number(options.maxAttempts || 4);\n    let lastError = null;",
  "    const maxAttempts = Math.max(1, Math.min(8, Number(options.maxAttempts || 6)));\n    const retryBaseMs = Math.max(250, Number(options.retryBaseMs || 1200));\n    const retryMaxMs = Math.max(retryBaseMs, Number(options.retryMaxMs || 12000));\n    let lastError = null;",
  'retry configuration',
);
replaceOnce(
  "        const headers = new Headers(options.headers || {});\n        headers.set('Authorization', `Bearer ${password}`);\n        const response = await fetch(`${API_ORIGIN}${path}`, { method: 'GET', headers, cache: 'no-store', signal: controller.signal });",
  "        const headers = new Headers(options.headers || {});\n        headers.set('Authorization', `Bearer ${password}`);\n        headers.set('Cache-Control', 'no-cache');\n        const requestUrl = new URL(`${API_ORIGIN}${path}`);\n        if (attempt > 1) requestUrl.searchParams.set('__warehouseRetry', `${Date.now()}-${attempt}`);\n        const response = await fetch(requestUrl, { method: 'GET', headers, cache: 'no-store', signal: controller.signal });",
  'retry request URL',
);
replaceOnce(
  "        const retryAfter = Number(response.headers.get('Retry-After') || 0);\n        await sleep(retryAfter > 0 ? retryAfter * 1000 : 900 * (2 ** (attempt - 1)));",
  "        const retryAfter = Number(response.headers.get('Retry-After') || 0);\n        const backoff = Math.min(retryMaxMs, retryBaseMs * (2 ** (attempt - 1)));\n        await sleep(retryAfter > 0 ? Math.min(retryMaxMs, retryAfter * 1000) : backoff);",
  'HTTP retry backoff',
);
replaceOnce(
  "        if (attempt >= maxAttempts) break;\n        await sleep(900 * (2 ** (attempt - 1)));",
  "        if (attempt >= maxAttempts) break;\n        await sleep(Math.min(retryMaxMs, retryBaseMs * (2 ** (attempt - 1))));",
  'network retry backoff',
);
replaceOnce(
  "    const detail = lastError?.name === 'AbortError' ? '单个文件请求超过 4 分钟' : (lastError?.message || '网络错误');",
  "    const detail = lastError?.name === 'AbortError' ? `单个文件请求超过 ${Math.round(Number(options.timeoutMs || 240000) / 60000)} 分钟` : (lastError?.message || '网络错误');",
  'timeout message',
);
replaceOnce(
  "    const result = await requestApi(url, password, { responseType: 'blob', headers });",
  "    const result = await requestApi(url, password, { responseType: 'blob', headers, maxAttempts: 8, timeoutMs: 300000, retryBaseMs: 1500, retryMaxMs: 15000 });",
  'Raw request resilience',
);

if (/lr_private_cloud_password|sessionStorage|const sessionSafe|getPassword/.test(source)) {
  throw new Error('Persistent credential pattern detected after Raw resilience patch');
}
writeFileSync(loaderPath, source, 'utf8');
