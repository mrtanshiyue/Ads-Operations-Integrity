from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "index.html"
ASSET = ROOT / "assets/private-cloud-warehouse-v3.js"
DIAG = ROOT / ".diagnostics/deferred-cloud-finalize.txt"


def replace_once(text: str, old: str, new: str, marker: str, label: str, log: list[str]) -> str:
    if marker in text:
        log.append(f"OK {label} already present")
        return text
    if old not in text:
        raise RuntimeError(f"Anchor not found: {label}")
    log.append(f"PATCH {label}")
    return text.replace(old, new, 1)


class InlineScriptExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.active = False
        self.buffer: list[str] = []
        self.scripts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "script":
            return
        values = {key.lower(): (value or "") for key, value in attrs}
        script_type = values.get("type", "").lower()
        self.active = "src" not in values and script_type in ("", "text/javascript", "application/javascript")
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
        raise RuntimeError("Node.js is required")
    parser = InlineScriptExtractor()
    parser.feed(index)
    with tempfile.TemporaryDirectory(prefix="deferred-finalize-") as temp_dir:
        temp = Path(temp_dir)
        for number, script in enumerate(parser.scripts, 1):
            path = temp / f"inline-{number:03d}.js"
            path.write_text(script, encoding="utf-8")
            subprocess.run([node, "--check", str(path)], check=True)
        asset_path = temp / "private-cloud-warehouse-v3.js"
        asset_path.write_text(asset, encoding="utf-8")
        subprocess.run([node, "--check", str(asset_path)], check=True)


def patch_index(text: str, log: list[str]) -> str:
    text = replace_once(
        text,
        "const importMultipleFiles = async (files) => {\n  clearLog(); if (!libsCheck()) return;",
        "const importMultipleFiles = async (files, options = {}) => {\n  const deferFinalize = Boolean(options?.deferFinalize);\n  const finalBatch = !deferFinalize;\n  window.__LR_IMPORT_STAGE__ = 'prepare';\n  if (!options?.preserveLog) clearLog(); if (!libsCheck()) return;",
        "const deferFinalize = Boolean(options?.deferFinalize)",
        "importer options and stage tracking",
        log,
    )

    old_finalize = """  setImportStatus(currentLang===\"zh\"?\"去重与建立索引\":\"Deduplicating and indexing\",72,true);await yieldToBrowser();
  if(dedupeMode===\"on\"){
    const before=AdsStore.all.length;AdsStore.all=dedupeRows(AdsStore.all);AdsStore.importStats.duplicateRows+=before-AdsStore.all.length;
    dedupeByKeyInPlace(AdsStore.biz,r=>`${r.workspaceKey||\"\"}|${r.marketplace||\"\"}|${r.date||\"\"}|${r.asin}|${r.sku||\"\"}|${safeNum(r.sessions)}|${safeNum(r.units)}|${safeNum(r.orders)}|${safeNum(r.sales).toFixed(2)}`);
    dedupeByKeyInPlace(AdsStore.placement,r=>`${r.workspaceKey||\"\"}|${r.date||\"\"}|${r.campaign}|${r.placement}|${safeNum(r.spend).toFixed(2)}|${safeNum(r.sales).toFixed(2)}|${safeNum(r.clicks)}|${safeNum(r.orders)}`);
    dedupeByKeyInPlace(AdsStore.sqp,r=>`${r.asin||\"\"}|${r.marketplace||\"\"}|${r.reportingPeriod||\"\"}|${r.startDate||\"\"}|${r.endDate||\"\"}|${r.query}|${safeNum(r.searchVolume)}`);
    dedupeByKeyInPlace(AdsStore.transactions,r=>`${r.settlementId}|${r.postedAt}|${r.releaseDate}|${r.type}|${r.orderId}|${r.sku}|${r.description}|${safeNum(r.quantity)}|${r.status}|${safeNum(r.productSales).toFixed(2)}|${safeNum(r.promotionalRebates).toFixed(2)}|${safeNum(r.sellingFees).toFixed(2)}|${safeNum(r.fbaFees).toFixed(2)}|${safeNum(r.otherTransactionFees).toFixed(2)}|${safeNum(r.other).toFixed(2)}|${safeNum(r.total).toFixed(2)}`.toLowerCase());
    dedupeByKeyInPlace(AdsStore.bulkStructure,r=>`${r.entity}|${r.campaignId}|${r.adGroupId}|${r.keywordId}|${r.targetId}|${r.campaign}|${r.adGroup}|${r.keyword}|${r.expression}|${r.matchType}`.toLowerCase());
  }
  let minDate=\"\",maxDate=\"\";for(const r of AdsStore.all){if(!r.date)continue;if(!minDate||r.date<minDate)minDate=r.date;if(!maxDate||r.date>maxDate)maxDate=r.date;}
  if(maxDate){$(\"dateEnd\").value=maxDate;if(AdsStore.all.length>PERF.LARGE_DATA_ROWS){const d=new Date(maxDate+\"T00:00:00Z\");d.setUTCDate(d.getUTCDate()-(PERF.AUTO_RECENT_DAYS-1));$(\"dateStart\").value=minDate&&d.toISOString().slice(0,10)<minDate?minDate:d.toISOString().slice(0,10);}else $(\"dateStart\").value=minDate;}
  enrichRowsWithBidControls();buildIndexes();getBulkStructureIndex();AdsStore.view=AdsStore.all;buildBusinessAggregates();AdsStore.transactionEconomicsCache={signature:\"\",snapshot:null};renderFileList();populateDropdowns();applyFilters(true);renderTransactionReport();scheduleIDBSave();
  setImportStatus(currentLang===\"zh\"?\"导入完成\":\"Import complete\",100,true);setTimeout(()=>{if(generation===importGeneration)setImportStatus(\"\",100,false);},1800);
  notify(`${currentLang===\"zh\"?\"导入完成\":\"Imported\"}: ${AdsStore.importStats.acceptedRows.toLocaleString()} rows · quarantine ${AdsStore.quarantine.length}`,AdsStore.quarantine.length?\"warn\":\"good\");
};"""

    new_finalize = """  if (deferFinalize) {
    window.__LR_IMPORT_STAGE__ = 'batch-appended';
    setImportStatus(currentLang===\"zh\"?\"批次数据已追加，等待最终汇总\":\"Batch appended; waiting for finalization\",68,true);
    return;
  }
  window.__LR_IMPORT_STAGE__ = 'deduplicate';
  setImportStatus(currentLang===\"zh\"?\"去重与建立索引\":\"Deduplicating and indexing\",72,true);await yieldToBrowser();
  if(dedupeMode===\"on\"){
    const before=AdsStore.all.length;AdsStore.all=dedupeRows(AdsStore.all);AdsStore.importStats.duplicateRows+=before-AdsStore.all.length;
    dedupeByKeyInPlace(AdsStore.biz,r=>`${r.workspaceKey||\"\"}|${r.marketplace||\"\"}|${r.date||\"\"}|${r.asin}|${r.sku||\"\"}|${safeNum(r.sessions)}|${safeNum(r.units)}|${safeNum(r.orders)}|${safeNum(r.sales).toFixed(2)}`);
    dedupeByKeyInPlace(AdsStore.placement,r=>`${r.workspaceKey||\"\"}|${r.date||\"\"}|${r.campaign}|${r.placement}|${safeNum(r.spend).toFixed(2)}|${safeNum(r.sales).toFixed(2)}|${safeNum(r.clicks)}|${safeNum(r.orders)}`);
    dedupeByKeyInPlace(AdsStore.sqp,r=>`${r.asin||\"\"}|${r.marketplace||\"\"}|${r.reportingPeriod||\"\"}|${r.startDate||\"\"}|${r.endDate||\"\"}|${r.query}|${safeNum(r.searchVolume)}`);
    dedupeByKeyInPlace(AdsStore.transactions,r=>`${r.settlementId}|${r.postedAt}|${r.releaseDate}|${r.type}|${r.orderId}|${r.sku}|${r.description}|${safeNum(r.quantity)}|${r.status}|${safeNum(r.productSales).toFixed(2)}|${safeNum(r.promotionalRebates).toFixed(2)}|${safeNum(r.sellingFees).toFixed(2)}|${safeNum(r.fbaFees).toFixed(2)}|${safeNum(r.otherTransactionFees).toFixed(2)}|${safeNum(r.other).toFixed(2)}|${safeNum(r.total).toFixed(2)}`.toLowerCase());
    dedupeByKeyInPlace(AdsStore.bulkStructure,r=>`${r.entity}|${r.campaignId}|${r.adGroupId}|${r.keywordId}|${r.targetId}|${r.campaign}|${r.adGroup}|${r.keyword}|${r.expression}|${r.matchType}`.toLowerCase());
  }
  window.__LR_IMPORT_STAGE__ = 'date-range';
  let minDate=\"\",maxDate=\"\";for(const r of AdsStore.all){if(!r.date)continue;if(!minDate||r.date<minDate)minDate=r.date;if(!maxDate||r.date>maxDate)maxDate=r.date;}
  if(maxDate){$(\"dateEnd\").value=maxDate;if(AdsStore.all.length>PERF.LARGE_DATA_ROWS){const d=new Date(maxDate+\"T00:00:00Z\");d.setUTCDate(d.getUTCDate()-(PERF.AUTO_RECENT_DAYS-1));$(\"dateStart\").value=minDate&&d.toISOString().slice(0,10)<minDate?minDate:d.toISOString().slice(0,10);}else $(\"dateStart\").value=minDate;}
  window.__LR_IMPORT_STAGE__ = 'enrich-and-index';
  enrichRowsWithBidControls();buildIndexes();getBulkStructureIndex();AdsStore.view=AdsStore.all;buildBusinessAggregates();AdsStore.transactionEconomicsCache={signature:\"\",snapshot:null};
  window.__LR_IMPORT_STAGE__ = 'render-file-list'; renderFileList();
  window.__LR_IMPORT_STAGE__ = 'populate-dropdowns'; populateDropdowns();
  window.__LR_IMPORT_STAGE__ = 'apply-filters'; applyFilters(true);
  window.__LR_IMPORT_STAGE__ = 'render-transactions'; renderTransactionReport();
  window.__LR_IMPORT_STAGE__ = 'schedule-idb-save'; scheduleIDBSave();
  window.__LR_IMPORT_STAGE__ = 'complete';
  setImportStatus(currentLang===\"zh\"?\"导入完成\":\"Import complete\",100,true);setTimeout(()=>{if(generation===importGeneration)setImportStatus(\"\",100,false);},1800);
  notify(`${currentLang===\"zh\"?\"导入完成\":\"Imported\"}: ${AdsStore.importStats.acceptedRows.toLocaleString()} rows · quarantine ${AdsStore.quarantine.length}`,AdsStore.quarantine.length?\"warn\":\"good\");
};"""
    text = replace_once(
        text,
        old_finalize,
        new_finalize,
        "window.__LR_IMPORT_STAGE__ = 'deduplicate'",
        "deferred finalization and detailed stages",
        log,
    )

    text = replace_once(
        text,
        "window.__LR_IMPORT_MULTIPLE_FILES__ = async files => {\n  await importMultipleFiles(files);",
        "window.__LR_IMPORT_MULTIPLE_FILES__ = async (files, options = {}) => {\n  try {\n    await importMultipleFiles(files, options);\n  } catch (error) {\n    const stage = window.__LR_IMPORT_STAGE__ || 'unknown';\n    const stack = String(error?.stack || '').split('\\n').slice(0, 6).join(' | ');\n    const wrapped = new Error(`[${stage}] ${error?.message || error}${stack ? ` · ${stack}` : ''}`);\n    wrapped.cause = error;\n    throw wrapped;\n  }",
        "const stage = window.__LR_IMPORT_STAGE__ || 'unknown'",
        "bridge stage-aware errors",
        log,
    )
    return text


def patch_loader(text: str, label: str, log: list[str]) -> str:
    old = """          const summary = await cloudImporter(batchFiles);
          let batchAccepted = Number(summary?.acceptedRows || 0);"""
    new = """          const isFinalBatch = batchStart + batchEntries.length >= entries.length;
          const summary = await cloudImporter(batchFiles, {
            deferFinalize: !isFinalBatch,
            preserveLog: !firstBatch,
            cloudBatchNumber: batchNumber,
            cloudBatchCount: batchCount,
          });
          let batchAccepted = Number(summary?.acceptedRows || 0);"""
    text = replace_once(
        text,
        old,
        new,
        "deferFinalize: !isFinalBatch",
        f"{label} defer intermediate finalization",
        log,
    )
    old_error = """      const message = error?.status === 401
        ? '网页登录密码错误，请清除密码后重新加载'"""
    new_error = """      const importStage = window.__LR_IMPORT_STAGE__ || '';
      const stackHint = String(error?.stack || '').split('\\n').slice(0, 4).join(' | ');
      const message = error?.status === 401
        ? '网页登录密码错误，请清除密码后重新加载'"""
    text = replace_once(
        text,
        old_error,
        new_error,
        "const importStage = window.__LR_IMPORT_STAGE__ || ''",
        f"{label} capture stage and stack",
        log,
    )
    old_tail = """          : (error?.message || String(error));
      setStatus(message, 'bad');"""
    new_tail = """          : (error?.message || String(error));
      const diagnosticMessage = importStage && importStage !== 'complete'
        ? `${message} · 阶段：${importStage}${stackHint ? ` · ${stackHint}` : ''}`
        : message;
      setStatus(diagnosticMessage, 'bad');"""
    text = replace_once(
        text,
        old_tail,
        new_tail,
        "const diagnosticMessage = importStage",
        f"{label} show stage diagnostic",
        log,
    )
    text = replace_once(
        text,
        "      notifyUser(message, 'bad');",
        "      notifyUser(diagnosticMessage, 'bad');",
        "notifyUser(diagnosticMessage, 'bad')",
        f"{label} notify diagnostic",
        log,
    )
    return text


def main() -> None:
    index = INDEX.read_text(encoding="utf-8")
    asset = ASSET.read_text(encoding="utf-8")
    log: list[str] = []
    index = patch_index(index, log)
    index = patch_loader(index, "embedded loader", log)
    asset = patch_loader(asset, "source loader", log)
    validate(index, asset)
    INDEX.write_text(index, encoding="utf-8")
    ASSET.write_text(asset, encoding="utf-8")
    DIAG.parent.mkdir(exist_ok=True)
    DIAG.write_text("\n".join(log) + "\nSUCCESS\n", encoding="utf-8")
    print("\n".join(log))
    print("SUCCESS")


if __name__ == "__main__":
    main()
