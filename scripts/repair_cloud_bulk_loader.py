from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "index.html"
ASSET = ROOT / "assets/private-cloud-warehouse-v3.js"
DIAGNOSTIC = ROOT / ".diagnostics/cloud-bulk-loader-repair.txt"


class InlineScriptExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.active = False
        self.current: list[str] = []
        self.scripts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "script":
            return
        values = {key.lower(): (value or "") for key, value in attrs}
        script_type = values.get("type", "").lower()
        self.active = "src" not in values and script_type in ("", "text/javascript", "application/javascript")
        self.current = []

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "script" and self.active:
            self.scripts.append("".join(self.current))
            self.active = False
            self.current = []

    def handle_data(self, data: str) -> None:
        if self.active:
            self.current.append(data)


def replace_block(text: str, start: str, end: str, replacement: str, marker: str, label: str, log: list[str]) -> str:
    if marker in text:
        log.append(f"OK {label}")
        return text
    start_index = text.find(start)
    end_index = text.find(end, start_index + len(start))
    if start_index < 0 or end_index < 0:
        raise RuntimeError(f"Block anchor not found: {label}")
    log.append(f"PATCH {label}")
    return text[:start_index] + replacement.rstrip() + "\n\n" + text[end_index:]


REQUEST_API = r'''  const requestApi = async (target, password, responseType = 'json') => {
    const path = normalizeApiTarget(target);
    const maxAttempts = 4;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 240000);
      try {
        const response = await fetch(`${API_ORIGIN}${path}`, {
          method: 'GET',
          headers: { 'X-Dashboard-Password': password },
          cache: 'no-store',
          signal: controller.signal,
        });
        const text = await response.text();
        let payload = null;
        if (responseType === 'json') {
          try { payload = text ? JSON.parse(text) : null; } catch (_) {}
        }
        if (response.ok) {
          clearTimeout(timeoutId);
          return {
            payload: responseType === 'json' ? payload : text,
            response,
            path,
          };
        }

        const detail = payload?.error || text || `HTTP ${response.status}`;
        const error = new Error(`${detail} · ${path}`);
        error.status = response.status;
        error.path = path;
        lastError = error;
        const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        if (!retryable || attempt >= maxAttempts) throw error;
        const retryAfter = Number(response.headers.get('Retry-After') || 0);
        await new Promise(resolve => setTimeout(resolve, retryAfter > 0 ? retryAfter * 1000 : 900 * (2 ** (attempt - 1))));
      } catch (networkError) {
        clearTimeout(timeoutId);
        if (networkError?.status && networkError.status < 500 && networkError.status !== 408 && networkError.status !== 425 && networkError.status !== 429) {
          throw networkError;
        }
        lastError = networkError;
        if (attempt >= maxAttempts) break;
        await new Promise(resolve => setTimeout(resolve, 900 * (2 ** (attempt - 1))));
      } finally {
        clearTimeout(timeoutId);
      }
    }

    const detail = lastError?.name === 'AbortError'
      ? '单个文件请求超过 4 分钟'
      : (lastError?.message || '网络错误');
    const error = new Error(`无法连接私有云接口（已重试 ${maxAttempts} 次）：${detail}`);
    error.status = lastError?.status;
    error.path = path;
    throw error;
  };'''


BATCH_IMPORT = r'''      const cloudImporter = window.__LR_IMPORT_MULTIPLE_FILES__;
      if (typeof cloudImporter !== 'function') {
        throw new Error('网页导入桥接未初始化，请强制刷新页面后重试');
      }
      const directImporter = window.__LR_IMPORT_TRANSACTION_FILE__;
      const mergeSelect = byId('mergeMode');
      const previousMerge = mergeSelect?.value || 'append';
      const batchSize = 4;
      const batchCount = Math.ceil(entries.length / batchSize);
      let fetchedRows = 0;
      let redactedFiles = 0;
      let importedRows = 0;
      let adsRows = 0;
      let transactionRows = 0;
      const quarantineItems = [];
      let firstBatch = true;

      try {
        for (let batchStart = 0; batchStart < entries.length; batchStart += batchSize) {
          const batchNumber = Math.floor(batchStart / batchSize) + 1;
          const batchEntries = entries.slice(batchStart, batchStart + batchSize);
          const batchFiles = [];

          for (let localIndex = 0; localIndex < batchEntries.length; localIndex += 1) {
            const entry = batchEntries[localIndex];
            const globalIndex = batchStart + localIndex;
            const label = `${displayScope(entry.storeId || scope)} · ${entry.month || entry.filename || globalIndex + 1}`;
            setStatus(`正在下载 ${label}（${globalIndex + 1}/${entries.length}）· 第 ${batchNumber}/${batchCount} 批…`);
            try {
              const loaded = await fetchManifestEntry(entry, password, scope);
              batchFiles.push(loaded.file);
              fetchedRows += Number(loaded.rowCount || 0);
              if (loaded.redacted) redactedFiles += 1;
            } catch (entryError) {
              const filename = entry.filename || entry.url || `第 ${globalIndex + 1} 个文件`;
              const wrapped = new Error(`${filename}（${globalIndex + 1}/${entries.length}）加载失败：${entryError?.message || entryError}`);
              wrapped.status = entryError?.status;
              wrapped.path = entryError?.path;
              throw wrapped;
            }
            await sleepFrame();
          }

          if (mergeSelect) mergeSelect.value = firstBatch ? 'replace' : 'append';
          setStatus(`已下载 ${batchStart + batchFiles.length}/${entries.length} 个文件，正在导入第 ${batchNumber}/${batchCount} 批并释放原始文件内存…`);
          const summary = await cloudImporter(batchFiles);
          let batchAccepted = Number(summary?.acceptedRows || 0);
          const batchAds = Number(summary?.adsRows || 0);
          let batchTransactions = Number(summary?.transactionRows || 0);
          const batchExpectsAds = batchEntries.some(entry => String(entry?.dataType || '').toLowerCase().replace(/[^a-z]/g, '') === 'ads');
          const batchExpectsTransactions = batchEntries.some(entry => String(entry?.dataType || '').toLowerCase().replace(/[^a-z]/g, '') === 'transactions');

          if (batchExpectsTransactions && !batchTransactions) {
            if (typeof directImporter !== 'function') throw new Error('联合交易专用导入桥接未初始化，请强制刷新页面');
            for (let index = 0; index < batchEntries.length; index += 1) {
              const dataType = String(batchEntries[index]?.dataType || '').toLowerCase().replace(/[^a-z]/g, '');
              if (dataType !== 'transactions') continue;
              const result = await directImporter(batchFiles[index]);
              const rows = Number(result?.rows || 0);
              batchTransactions += rows;
              batchAccepted += rows;
            }
          }

          if (Array.isArray(summary?.quarantine)) quarantineItems.push(...summary.quarantine);
          const batchQuarantine = (summary?.quarantine || [])
            .flatMap(item => (item.reasons || []).map(reason => `${item.fileName || item.reportType}: ${reason}`))
            .slice(0, 3)
            .join('；');
          if ((batchExpectsAds && !batchAds) || (batchExpectsTransactions && !batchTransactions)) {
            const missingType = batchExpectsAds && !batchAds ? '广告数据' : '联合交易数据';
            throw new Error(`第 ${batchNumber}/${batchCount} 批未写入${missingType}${batchQuarantine ? `：${batchQuarantine}` : ''}`);
          }

          importedRows += batchAccepted;
          adsRows += batchAds;
          transactionRows += batchTransactions;
          firstBatch = false;
          batchFiles.length = 0;
          await new Promise(resolve => setTimeout(resolve, 180));
        }
      } finally {
        if (mergeSelect) mergeSelect.value = previousMerge;
      }

      const expectsAds = entries.some(entry => String(entry?.dataType || '').toLowerCase().replace(/[^a-z]/g, '') === 'ads');
      const expectsTransactions = entries.some(entry => String(entry?.dataType || '').toLowerCase().replace(/[^a-z]/g, '') === 'transactions');
      const quarantineText = quarantineItems
        .flatMap(item => (item.reasons || []).map(reason => `${item.fileName || item.reportType}: ${reason}`))
        .slice(0, 3)
        .join('；');
      if (!importedRows || (expectsAds && !adsRows) || (expectsTransactions && !transactionRows)) {
        const missingType = expectsAds && !adsRows ? '广告数据' : expectsTransactions && !transactionRows ? '联合交易数据' : '报表数据';
        throw new Error(`报表已下载，但网页分析库未写入${missingType}${quarantineText ? `：${quarantineText}` : '；请检查报表字段映射与日期格式'}`);
      }'''


def patch(text: str, log: list[str], label: str) -> str:
    text = replace_block(
        text,
        "  const requestApi = async (target, password, responseType = 'json') => {",
        "  const apiFetchJson = async",
        REQUEST_API,
        "无法连接私有云接口（已重试 ${maxAttempts} 次）",
        f"{label} retrying request API",
        log,
    )
    text = replace_block(
        text,
        "      const csvFiles = [];",
        "      let costSummary = null;",
        BATCH_IMPORT,
        "const batchSize = 4;",
        f"{label} bounded-memory batch import",
        log,
    )
    return text


def validate(index: str, asset: str) -> None:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is required")
    parser = InlineScriptExtractor()
    parser.feed(index)
    with tempfile.TemporaryDirectory(prefix="cloud-bulk-loader-") as temp_dir:
        temp = Path(temp_dir)
        for number, script in enumerate(parser.scripts, 1):
            path = temp / f"inline-{number:03d}.js"
            path.write_text(script, encoding="utf-8")
            subprocess.run([node, "--check", str(path)], check=True)
        asset_path = temp / "private-cloud-warehouse-v3.js"
        asset_path.write_text(asset, encoding="utf-8")
        subprocess.run([node, "--check", str(asset_path)], check=True)


def main() -> None:
    index = INDEX.read_text(encoding="utf-8")
    asset = ASSET.read_text(encoding="utf-8")
    log: list[str] = []
    index = patch(index, log, "embedded loader")
    asset = patch(asset, log, "source loader")
    validate(index, asset)
    INDEX.write_text(index, encoding="utf-8")
    ASSET.write_text(asset, encoding="utf-8")
    DIAGNOSTIC.parent.mkdir(exist_ok=True)
    DIAGNOSTIC.write_text("\n".join(log) + "\nSUCCESS\n", encoding="utf-8")
    print("\n".join(log))
    print("SUCCESS")


if __name__ == "__main__":
    main()
