import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(process.cwd());
const htmlPath = join(root, 'index.html');
const loaderPath = join(root, 'assets/private-cloud-warehouse-v4.js');
const generatedDir = join(root, 'assets/generated');

if (!existsSync(htmlPath)) throw new Error('index.html is missing');
if (!existsSync(loaderPath)) throw new Error('V4 loader is missing');

const urlMap = new Map([
  ['https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js', 'assets/vendor/papaparse.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js', 'assets/vendor/papaparse.min.js'],
  ['https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js', 'assets/vendor/xlsx.full.min.js'],
  ['https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', 'assets/vendor/xlsx.full.min.js'],
  ['https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js', 'assets/vendor/chart.umd.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js', 'assets/vendor/chart.umd.min.js'],
  ['https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js', 'assets/vendor/exceljs.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js', 'assets/vendor/exceljs.min.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js', 'assets/vendor/FileSaver.min.js'],
  ['https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js', 'assets/vendor/FileSaver.min.js'],
  ['https://cdn.jsdelivr.net/npm/idb-keyval@6/dist/umd.js', 'assets/vendor/idb-keyval.umd.js'],
  ['https://cdn.jsdelivr.net/npm/idb-keyval@6.2.1/dist/umd.js', 'assets/vendor/idb-keyval.umd.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/idb-keyval/6.2.1/umd.js', 'assets/vendor/idb-keyval.umd.js'],
  ['https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js', 'assets/vendor/html2pdf.bundle.min.js'],
]);

let html = readFileSync(htmlPath, 'utf8');
for (const [remote, local] of urlMap) html = html.split(remote).join(local);

// The old fallback accepted arbitrary remote URLs and injected script tags.
html = html.replace(
  /window\.__loadDependencyFallback=\(name,url\)=>\{window\.__dependencyFallbacks=[\s\S]*?document\.head\.appendChild\(s\);\};/,
  'window.__loadDependencyFallback=()=>{};',
);
html = html.replace(/\s+onerror=(['"])__loadDependencyFallback\([\s\S]*?\)\1/gi, '');
html = html.replace(/(<script\b[^>]*?)\s+crossorigin=(['"])anonymous\2/gi, '$1');

// A blob Worker must import an absolute same-origin SheetJS URL.
html = html.replace(
  /((?:const|let|var)\s+XLSX_WORKER_LIB\s*=\s*)['"]assets\/vendor\/xlsx\.full\.min\.js['"]\s*;/,
  "$1new URL('assets/vendor/xlsx.full.min.js', document.baseURI).href;",
);

const executableTypes = new Set(['', 'text/javascript', 'application/javascript', 'module']);
const inlineHashes = [];
const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(match => !/\bsrc\s*=/i.test(match[1]));

if (inlineScripts.length) {
  rmSync(generatedDir, { recursive: true, force: true });
  mkdirSync(generatedDir, { recursive: true });
  let scriptNumber = 0;
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs, body) => {
    if (/\bsrc\s*=/i.test(attrs)) return full;
    const type = (attrs.match(/\btype=(['"])(.*?)\1/i)?.[2] || '').trim().toLowerCase();
    if (!executableTypes.has(type)) {
      const hash = createHash('sha256').update(body, 'utf8').digest('base64');
      inlineHashes.push(`'sha256-${hash}'`);
      return full;
    }
    scriptNumber += 1;
    const filename = `inline-script-${String(scriptNumber).padStart(2, '0')}.js`;
    writeFileSync(join(generatedDir, filename), `${body.trim()}\n`, 'utf8');
    const cleanAttrs = attrs.trim();
    return `<script${cleanAttrs ? ` ${cleanAttrs}` : ''} src="assets/generated/${filename}"></script>`;
  });
}

html = html.replace(/<meta\b[^>]*http-equiv=(['"])Content-Security-Policy\1[^>]*>\s*/gi, '');
const scriptSource = ["'self'", ...inlineHashes].join(' ');
const csp = [
  "default-src 'self'",
  `script-src ${scriptSource}`,
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://amazon-warehouse-cloud-v4.tanshiyuesir.workers.dev",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join('; ');
if (!/<head\b[^>]*>/i.test(html)) throw new Error('HTML head is missing');
html = html.replace(/<head\b([^>]*)>/i, `<head$1>\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`);
writeFileSync(htmlPath, html, 'utf8');

let loader = readFileSync(loaderPath, 'utf8');
loader = loader.replace(/\n\s*const SESSION_KEY = ['"]lr_private_cloud_password['"];?/, '');
loader = loader.replace(
  /\s*const sessionSafe = \{[\s\S]*?\n\s*\};/,
  `\n  const memoryCredential = {\n    value: '',\n    get: () => memoryCredential.value,\n    set: value => { memoryCredential.value = String(value || ''); return Boolean(memoryCredential.value); },\n    clear: () => { memoryCredential.value = ''; },\n  };`,
);
loader = loader
  .replaceAll('sessionSafe.get(SESSION_KEY)', 'memoryCredential.get()')
  .replaceAll('sessionSafe.set(SESSION_KEY, password)', 'memoryCredential.set(password)')
  .replaceAll('sessionSafe.remove(SESSION_KEY)', 'memoryCredential.clear()')
  .replaceAll('当前标签页保存的访问密码', '当前页面内存中的访问密码')
  .replaceAll('会话密码已清除', '内存访问密码已清除')
  .replaceAll('私有云会话密码已清除。', '私有云内存访问密码已清除。')
  .replaceAll('已保存当前标签页会话密码', '访问密码仅保存在当前页面内存中')
  .replace("const LOADER_VERSION = '4.1.0';", "const LOADER_VERSION = '4.1.1';");
if (!loader.includes('setPassword:')) {
  loader = loader.replace(
    "      reload: () => loadPrivateCloudData({ reason: 'shop-change' }),",
    "      reload: () => loadPrivateCloudData({ reason: 'shop-change' }),\n      setPassword: value => memoryCredential.set(value),",
  );
}
writeFileSync(loaderPath, loader, 'utf8');

const finalHtml = readFileSync(htmlPath, 'utf8');
const finalLoader = readFileSync(loaderPath, 'utf8');
const remoteScript = [...finalHtml.matchAll(/<script\b[^>]*\bsrc=(['"])(.*?)\1/gi)]
  .map(match => match[2])
  .find(src => /^https?:\/\//i.test(src));
const executableInline = [...finalHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(match => !/\bsrc\s*=/i.test(match[1]))
  .filter(match => executableTypes.has((match[1].match(/\btype=(['"])(.*?)\1/i)?.[2] || '').trim().toLowerCase()));

if (remoteScript) throw new Error(`Remote script remains: ${remoteScript}`);
if (executableInline.length) throw new Error(`Executable inline scripts remain: ${executableInline.length}`);
if (/cdn\.jsdelivr\.net|cdn\.sheetjs\.com|cdnjs\.cloudflare\.com/i.test(finalHtml)) throw new Error('CDN URL remains in index.html');
if (/onerror=(['"])__loadDependencyFallback/i.test(finalHtml)) throw new Error('Remote dependency fallback remains');
if (!/Content-Security-Policy/i.test(finalHtml) || !/script-src 'self'/.test(finalHtml)) throw new Error('Strict same-origin script CSP is missing');
if (/sessionStorage|lr_private_cloud_password|const sessionSafe/.test(finalLoader)) throw new Error('Raw credential persistence remains in V4 loader');
if (!/setPassword: value => memoryCredential\.set\(value\)/.test(finalLoader)) throw new Error('In-memory credential setter is missing');

const generated = existsSync(generatedDir)
  ? readdirSync(generatedDir).filter(name => name.endsWith('.js')).sort()
  : [];
console.log(JSON.stringify({
  csp: 'same-origin-script-only',
  generatedScriptCount: generated.length,
  vendorScriptCount: [...finalHtml.matchAll(/assets\/vendor\//g)].length,
  credentialStorage: 'memory-only',
  loaderVersion: '4.1.1',
  generatedDirectory: relative(root, generatedDir),
}));
