from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
INDEX_PATH = ROOT / "index.html"
ASSET_PATH = ROOT / "assets/private-cloud-warehouse-v3.js"
DIAG_PATH = ROOT / ".diagnostics/direct-transaction-fallback.txt"

BRIDGE_MARKER = "window.__LR_IMPORT_TRANSACTION_FILE__"
BRIDGE_ANCHOR = "window.__LR_IMPORT_PRODUCT_COSTS__ = payload => importProductCosts(payload);"
BRIDGE = r'''window.__LR_IMPORT_TRANSACTION_FILE__ = async file => {
  if(!file)throw new Error("联合交易文件不存在");
  const sourceFile=String(file.name||"combined-report.csv"),rows=await parseCSV(file);
  if(!Array.isArray(rows)||!rows.length)throw new Error(`${sourceFile}: CSV解析后没有数据行`);
  const map=buildTransactionMap(rows),required=["postedAt","type","productSales","total"],missing=required.filter(key=>!map[key]);
  if(missing.length){
    const headers=Object.keys(rows[0]||{}).slice(0,40).join(" | ");
    throw new Error(`${sourceFile}: 联合交易缺少字段 ${missing.join(", ")}；实际表头：${headers}`);
  }
  let rowErrors=0,firstError="";
  const normalized=await processInChunks(rows,raw=>{
    try{return normalizeTransactionRow(raw,map,sourceFile);}
    catch(error){rowErrors++;if(!firstError)firstError=error?.message||String(error);return null;}
  });
  const norm=compactArrayInPlace(normalized,row=>row&&row.date&&row.type);
  if(!norm.length){
    const first=rows[0]||{},posted=map.postedAt?String(first[map.postedAt]||""):"",type=map.type?String(first[map.type]||""):"";
    throw new Error(`${sourceFile}: 联合交易归一化后为0行；首行日期=${posted||"空"}，类型=${type||"空"}${firstError?`，异常=${firstError}`:""}`);
  }
  appendArray(AdsStore.transactions,norm);
  dedupeByKeyInPlace(AdsStore.transactions,row=>`${row.settlementId}|${row.postedAt}|${row.releaseDate}|${row.type}|${row.orderId}|${row.sku}|${row.description}|${safeNum(row.quantity)}|${row.status}|${safeNum(row.productSales).toFixed(2)}|${safeNum(row.promotionalRebates).toFixed(2)}|${safeNum(row.sellingFees).toFixed(2)}|${safeNum(row.fbaFees).toFixed(2)}|${safeNum(row.otherTransactionFees).toFixed(2)}|${safeNum(row.other).toFixed(2)}|${safeNum(row.total).toFixed(2)}`.toLowerCase());
  AdsStore.dataVersions.transaction=(AdsStore.dataVersions.transaction||0)+1;
  AdsStore.dataVersions.derived=(AdsStore.dataVersions.derived||0)+1;
  AdsStore.transactionEconomicsCache={signature:"",snapshot:null};
  AdsStore.importStats.acceptedRows=(AdsStore.importStats.acceptedRows||0)+norm.length;
  AdsStore.quarantine=(AdsStore.quarantine||[]).filter(item=>String(item?.fileName||"")!==sourceFile);
  const fileRecord=(AdsStore.files||[]).find(item=>String(item?.name||"")===sourceFile);
  if(fileRecord){fileRecord.rows=norm.length;fileRecord.type="联合交易";}
  else AdsStore.files.push({name:sourceFile,rows:norm.length,type:"联合交易"});
  UnifiedDecisionEngine.invalidate("direct_transaction_import");
  renderFileList();renderTransactionReport();updateWorkspaceState();applyFilters(true);scheduleIDBSave();
  return{rows:norm.length,rawRows:rows.length,rowErrors};
};
'''

OLD_SUMMARY = r'''      const importedRows = Number(importSummary?.acceptedRows || 0);
      const adsRows = Number(importSummary?.adsRows || 0);
      const transactionRows = Number(importSummary?.transactionRows || 0);
      const quarantineText = (importSummary?.quarantine || [])
        .flatMap(item => (item.reasons || []).map(reason => `${item.fileName || item.reportType}: ${reason}`))
        .slice(0, 3)
        .join('；');
      const expectsAds = entries.some(entry => String(entry?.dataType || '').toLowerCase().replace(/[^a-z]/g, '') === 'ads');
      const expectsTransactions = entries.some(entry => String(entry?.dataType || '').toLowerCase().replace(/[^a-z]/g, '') === 'transactions');
      if (!importedRows || (expectsAds && !adsRows) || (expectsTransactions && !transactionRows)) {
        const missingType = expectsAds && !adsRows ? '广告数据' : expectsTransactions && !transactionRows ? '联合交易数据' : '报表数据';
        throw new Error(`报表已下载，但网页分析库未写入${missingType}${quarantineText ? `：${quarantineText}` : '；请检查报表字段映射与日期格式'}`);
      }'''

NEW_SUMMARY = r'''      const importedRows = Number(importSummary?.acceptedRows || 0);
      const adsRows = Number(importSummary?.adsRows || 0);
      let transactionRows = Number(importSummary?.transactionRows || 0);
      const expectsAds = entries.some(entry => String(entry?.dataType || '').toLowerCase().replace(/[^a-z]/g, '') === 'ads');
      const expectsTransactions = entries.some(entry => String(entry?.dataType || '').toLowerCase().replace(/[^a-z]/g, '') === 'transactions');
      if (expectsTransactions && !transactionRows) {
        const directImporter = window.__LR_IMPORT_TRANSACTION_FILE__;
        if (typeof directImporter !== 'function') throw new Error('联合交易专用导入桥接未初始化，请强制刷新页面');
        for (let index = 0; index < entries.length; index += 1) {
          const dataType = String(entries[index]?.dataType || '').toLowerCase().replace(/[^a-z]/g, '');
          if (dataType !== 'transactions') continue;
          const result = await directImporter(csvFiles[index]);
          transactionRows += Number(result?.rows || 0);
        }
      }
      const quarantineText = (importSummary?.quarantine || [])
        .flatMap(item => (item.reasons || []).map(reason => `${item.fileName || item.reportType}: ${reason}`))
        .slice(0, 3)
        .join('；');
      if (!importedRows || (expectsAds && !adsRows) || (expectsTransactions && !transactionRows)) {
        const missingType = expectsAds && !adsRows ? '广告数据' : expectsTransactions && !transactionRows ? '联合交易数据' : '报表数据';
        throw new Error(`报表已下载，但网页分析库未写入${missingType}${quarantineText ? `：${quarantineText}` : '；请检查报表字段映射与日期格式'}`);
      }'''


class ScriptExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.active = False
        self.buffer: list[str] = []
        self.scripts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "script":
            return
        values = {key.lower(): (value or "") for key, value in attrs}
        self.active = "src" not in values and values.get("type", "").lower() in ("", "text/javascript", "application/javascript")
        self.buffer = []

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "script" and self.active:
            self.scripts.append("".join(self.buffer))
            self.active = False
            self.buffer = []

    def handle_data(self, data: str) -> None:
        if self.active:
            self.buffer.append(data)


def validate(index: str, asset: str) -> None:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is unavailable")
    parser = ScriptExtractor()
    parser.feed(index)
    with tempfile.TemporaryDirectory(prefix="tx-fallback-") as temp_dir:
        temp = Path(temp_dir)
        for number, script in enumerate(parser.scripts, 1):
            path = temp / f"inline-{number:03d}.js"
            path.write_text(script, encoding="utf-8")
            subprocess.run([node, "--check", str(path)], check=True)
        path = temp / "loader.js"
        path.write_text(asset, encoding="utf-8")
        subprocess.run([node, "--check", str(path)], check=True)


def install_bridge(index: str, log: list[str]) -> str:
    if BRIDGE_MARKER in index:
        log.append("OK direct transaction bridge already present")
        return index
    if BRIDGE_ANCHOR not in index:
        raise RuntimeError("Bridge insertion anchor not found")
    log.append("PATCH direct transaction bridge")
    return index.replace(BRIDGE_ANCHOR, BRIDGE + BRIDGE_ANCHOR, 1)


def install_fallback(text: str, label: str, log: list[str]) -> str:
    if "const directImporter = window.__LR_IMPORT_TRANSACTION_FILE__;" in text:
        log.append(f"OK {label} fallback already present")
        return text
    if OLD_SUMMARY not in text:
        raise RuntimeError(f"Cloud summary anchor not found: {label}")
    log.append(f"PATCH {label} direct transaction fallback")
    return text.replace(OLD_SUMMARY, NEW_SUMMARY, 1)


def main() -> None:
    index = INDEX_PATH.read_text(encoding="utf-8")
    asset = ASSET_PATH.read_text(encoding="utf-8")
    log: list[str] = []
    index = install_bridge(index, log)
    index = install_fallback(index, "embedded loader", log)
    asset = install_fallback(asset, "source loader", log)
    validate(index, asset)
    INDEX_PATH.write_text(index, encoding="utf-8")
    ASSET_PATH.write_text(asset, encoding="utf-8")
    DIAG_PATH.parent.mkdir(exist_ok=True)
    DIAG_PATH.write_text("\n".join(log) + "\nSUCCESS\n", encoding="utf-8")
    print("\n".join(log))
    print("SUCCESS")


if __name__ == "__main__":
    main()
