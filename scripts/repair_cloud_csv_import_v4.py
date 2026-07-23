from __future__ import annotations

from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
INDEX_PATH = ROOT / "index.html"
CLOUD_SOURCE_PATH = ROOT / "assets" / "private-cloud-warehouse-v3.js"
LOG_PATH = ROOT / ".diagnostics" / "repair-cloud-csv-v4.log"

log: list[str] = []


def note(message: str) -> None:
    print(message)
    log.append(message)


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        note(f"OK already patched: {label}")
        return text
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly 1 source match, found {count}")
    note(f"PATCH: {label}")
    return text.replace(old, new, 1)


def patch_alias(text: str, key: str, anchor: str, additions: list[str]) -> str:
    pattern = re.compile(rf'({re.escape(key)}\s*:\s*\[)([^\]]*)(\])')
    matches = list(pattern.finditer(text))
    match = next((candidate for candidate in matches if anchor in candidate.group(2)), None)
    if not match:
        raise RuntimeError(f"Alias array containing anchor not found for {key}: {anchor}; candidates={len(matches)}")
    body = match.group(2)
    missing = [value for value in additions if f'"{value}"' not in body]
    if not missing:
        note(f"OK already patched: alias {key}")
        return text
    insertion = "".join(f'"{value}",' for value in missing)
    patched_body = body.replace(f'"{anchor}",', f'"{anchor}",{insertion}', 1)
    note(f"PATCH: alias {key} += {', '.join(missing)}")
    return text[: match.start(2)] + patched_body + text[match.end(2) :]


def patch_index(text: str) -> str:
    date_old = """  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2].padStart(2,'0')}-${isoMatch[3].padStart(2,'0')}`;
  const euMatch = s.match(/^(\\d{1,2})[-\\/.](\\d{1,2})[-\\/.](\\d{4})/);"""
    date_new = """  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2].padStart(2,'0')}-${isoMatch[3].padStart(2,'0')}`;
  const zhMatch = s.match(/^(\\d{4})年\\s*(\\d{1,2})月\\s*(\\d{1,2})日?/);
  if (zhMatch) return `${zhMatch[1]}-${zhMatch[2].padStart(2,'0')}-${zhMatch[3].padStart(2,'0')}`;
  const euMatch = s.match(/^(\\d{1,2})[-\\/.](\\d{1,2})[-\\/.](\\d{4})/);"""
    text = replace_once(text, date_old, date_new, "Chinese yyyy年m月d日 date parsing")

    alias_specs = [
        ("targeting", "投放", ["投放方案", "匹配的目标"]),
        ("matchType", "匹配类型", ["投放匹配类型", "投放匹配类型-Targeting match type"]),
        ("searchTerm", "客户搜索词", ["搜索词"]),
        ("spend", "花费", ["总成本"]),
        ("sales7d", "7天总销售额", ["销售额"]),
        ("orders7d", "7天总订单数", ["购买量"]),
        ("units", "7天总销售量(#)", ["已售商品数量"]),
        ("cvr", "7天的转化率", ["购买率"]),
        ("advertisedSales", "7天内广告SKU销售额", ["推广商品的销量"]),
        ("advertisedUnits", "7天内广告SKU销售量(#)", ["已售商品数量（推广）"]),
        ("otherSkuSales", "7天内其他SKU销售额", ["销售额（光环）"]),
        ("otherSkuUnits", "7天内其他SKU销售量(#)", ["已售商品数量（光环）"]),
    ]
    for key, anchor, additions in alias_specs:
        text = patch_alias(text, key, anchor, additions)

    parse_pattern = re.compile(
        r"const parseCSV = async file => \{.*?\};\nconst XLSX_WORKER_LIB",
        re.S,
    )
    if "const isCloudFile=/^(?:ALL|YTDBNS|YY|JJ)__/" not in text:
        replacement = r'''const parseCSV = async file => {
  const prefix=await file.slice(0,262144).text();
  const headerLine=findTransactionHeaderLine(prefix);
  const isCloudFile=/^(?:ALL|YTDBNS|YY|JJ)__/.test(String(file?.name||"").toUpperCase());
  if(headerLine>=0||isCloudFile){
    const rawText=await file.text();
    const lines=rawText.replace(/^\uFEFF/,"").split(/\r?\n/);
    const start=headerLine>=0?findTransactionHeaderLine(rawText):0;
    const body=lines.slice(Math.max(0,start)).join("\n");
    return new Promise((resolve,reject)=>Papa.parse(body,{header:true,skipEmptyLines:"greedy",worker:false,dynamicTyping:false,complete:res=>resolve(res.data||[]),error:reject}));
  }
  return new Promise((resolve,reject)=>Papa.parse(file,{header:true,skipEmptyLines:"greedy",worker:true,dynamicTyping:false,complete:res=>resolve(res.data||[]),error:reject}));
};
const XLSX_WORKER_LIB'''
        text, count = parse_pattern.subn(lambda _match: replacement, text, count=1)
        if count != 1:
            raise RuntimeError(f"Cloud CSV parser replacement count={count}")
        note("PATCH: parse cloud-created File objects on main thread")
    else:
        note("OK already patched: cloud CSV parser")

    bridge_old = "window.__LR_IMPORT_MULTIPLE_FILES__ = async files => importMultipleFiles(files);"
    bridge_new = '''window.__LR_IMPORT_MULTIPLE_FILES__ = async files => {
  await importMultipleFiles(files);
  return {
    acceptedRows: Number(AdsStore.importStats?.acceptedRows || 0),
    adsRows: Number(AdsStore.all?.length || 0),
    transactionRows: Number(AdsStore.transactions?.length || 0),
    businessRows: Number(AdsStore.biz?.length || 0),
    files: (AdsStore.files || []).map(item => ({ name: item.name, rows: Number(item.rows || 0), type: item.type || "" })),
    quarantine: (AdsStore.quarantine || []).map(item => ({
      fileName: item.fileName || "",
      reportType: item.reportType || "",
      reasons: Array.isArray(item.reasons) ? item.reasons : [],
    })),
  };
};'''
    text = replace_once(text, bridge_old, bridge_new, "cloud importer result summary bridge")
    return text


IMPORT_OLD = '''      setStatus(`已下载 ${entries.length} 个文件，正在按 ${scope} 范围建立分析索引…`);
      try {
        await cloudImporter(csvFiles);
      } finally {
        if (mergeSelect) mergeSelect.value = previousMerge;
      }

      let costSummary = null;'''

IMPORT_NEW = '''      setStatus(`已下载 ${entries.length} 个文件，正在按 ${scope} 范围建立分析索引…`);
      let importSummary = null;
      try {
        importSummary = await cloudImporter(csvFiles);
      } finally {
        if (mergeSelect) mergeSelect.value = previousMerge;
      }
      const importedRows = Number(importSummary?.acceptedRows || 0);
      const adsRows = Number(importSummary?.adsRows || 0);
      const transactionRows = Number(importSummary?.transactionRows || 0);
      const quarantineText = (importSummary?.quarantine || [])
        .flatMap(item => (item.reasons || []).map(reason => `${item.fileName || item.reportType}: ${reason}`))
        .slice(0, 3)
        .join('；');
      const expectsAds = entries.some(entry => String(entry?.dataType || '').toLowerCase().replace(/[^a-z]/g, '') === 'ads');
      if (!importedRows || (expectsAds && !adsRows)) {
        throw new Error(`报表已下载，但网页分析库未写入广告数据${quarantineText ? `：${quarantineText}` : '；请检查报表字段映射'}`);
      }

      let costSummary = null;'''


def patch_cloud_loader(text: str, label: str) -> str:
    text = replace_once(text, IMPORT_OLD, IMPORT_NEW, f"actual import validation in {label}")
    text = replace_once(
        text,
        "const totalRows = Number(fetchedRows || manifest?.totalRows || 0);",
        "const totalRows = Number(importedRows || fetchedRows || manifest?.totalRows || 0);",
        f"use accepted row count in {label}",
    )
    return text


def validate(index_text: str, cloud_text: str) -> None:
    required_index = [
        '"总成本"',
        '"购买量"',
        '"销售额"',
        '"搜索词"',
        "const zhMatch",
        "const isCloudFile",
        "acceptedRows: Number(AdsStore.importStats",
        "let importSummary = null;",
    ]
    missing = [item for item in required_index if item not in index_text]
    if missing:
        raise RuntimeError(f"Index validation missing: {missing}")
    if "let importSummary = null;" not in cloud_text:
        raise RuntimeError("Cloud source validation missing importSummary")
    if "const totalRows = Number(importedRows ||" not in index_text or "const totalRows = Number(importedRows ||" not in cloud_text:
        raise RuntimeError("Accepted-row total validation missing")
    note("VERIFY: all required cloud import compatibility patches are present")


def main() -> int:
    try:
        index_text = INDEX_PATH.read_text(encoding="utf-8")
        cloud_text = CLOUD_SOURCE_PATH.read_text(encoding="utf-8")
        index_text = patch_index(index_text)
        index_text = patch_cloud_loader(index_text, "embedded loader")
        cloud_text = patch_cloud_loader(cloud_text, "source loader")
        validate(index_text, cloud_text)
        INDEX_PATH.write_text(index_text, encoding="utf-8")
        CLOUD_SOURCE_PATH.write_text(cloud_text, encoding="utf-8")
        note("SUCCESS: cloud CSV import repair completed")
        return 0
    except Exception as exc:
        note(f"ERROR: {exc}")
        return 1
    finally:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        LOG_PATH.write_text("\n".join(log) + "\n", encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
