from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
INDEX_PATH = ROOT / "index.html"
ASSET_PATH = ROOT / "assets/private-cloud-warehouse-v3.js"
DIAGNOSTIC_PATH = ROOT / ".diagnostics/cloud-transaction-repair.txt"


def replace_once(text: str, old: str, new: str, marker: str, label: str, log: list[str]) -> str:
    if old in text:
        log.append(f"PATCH {label}")
        return text.replace(old, new, 1)
    if marker in text:
        log.append(f"OK {label} already present")
        return text
    raise RuntimeError(f"Anchor not found: {label}")


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


def validate_javascript(index: str, asset: str) -> None:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is required for JavaScript validation")
    parser = InlineScriptExtractor()
    parser.feed(index)
    with tempfile.TemporaryDirectory(prefix="cloud-tx-validate-") as temp_dir:
        temp = Path(temp_dir)
        for number, script in enumerate(parser.scripts, 1):
            path = temp / f"inline-{number:03d}.js"
            path.write_text(script, encoding="utf-8")
            subprocess.run([node, "--check", str(path)], check=True)
        asset_file = temp / "private-cloud-warehouse-v3.js"
        asset_file.write_text(asset, encoding="utf-8")
        subprocess.run([node, "--check", str(asset_file)], check=True)


def main() -> None:
    index = INDEX_PATH.read_text(encoding="utf-8")
    asset = ASSET_PATH.read_text(encoding="utf-8")
    log: list[str] = []

    old = "const buildTransactionMap=rows=>{const h=rows.length?Object.keys(rows[0]):[],m={};for(const k in TRANSACTION_MAP_ALIASES)m[k]=pickCol(h,TRANSACTION_MAP_ALIASES[k]);return m;};"
    new = """const buildTransactionMap=rows=>{
  const h=rows.length?Object.keys(rows[0]):[],byCompact=new Map(h.map(col=>[cleanHeaderCompact(col),col])),m={};
  for(const k in TRANSACTION_MAP_ALIASES){
    m[k]=TRANSACTION_MAP_ALIASES[k].map(alias=>byCompact.get(cleanHeaderCompact(alias))).find(Boolean)||pickCol(h,TRANSACTION_MAP_ALIASES[k]);
  }
  return m;
};"""
    index = replace_once(
        index,
        old,
        new,
        "byCompact=new Map(h.map(col=>[cleanHeaderCompact(col),col]))",
        "robust transaction column map",
        log,
    )

    old = 'const isTransactionReport=(header=[])=>{const h=new Set(header.map(cleanHeaderCompact));return ["date/time","settlement id","type","product sales","selling fees","fba fees","total","transaction status"].every(x=>h.has(cleanHeaderCompact(x)));};'
    new = 'const isTransactionReport=(header=[])=>{const h=new Set(header.map(cleanHeaderCompact));return ["date/time","type","product sales","total","transaction status"].every(x=>h.has(cleanHeaderCompact(x)));};'
    index = replace_once(
        index,
        old,
        new,
        '["date/time","type","product sales","total","transaction status"]',
        "relaxed transaction detection",
        log,
    )

    old = "const hasTransaction=isTransactionReport(header);"
    new = "const hasTransaction=isTransactionReport(header)||/(?:^|__)\\d{4}-\\d{2}-combined-report\\.csv$/i.test(sourceLabel);"
    index = replace_once(
        index,
        old,
        new,
        "combined-report\\.csv$/i.test(sourceLabel)",
        "filename-backed transaction detection",
        log,
    )

    old = "const missing=validateReportMap(type,map);"
    new = 'const missing=type==="TRANSACTION_REPORT"?["postedAt","type","productSales","total","status"].filter(key=>!map[key]):validateReportMap(type,map);'
    index = replace_once(
        index,
        old,
        new,
        'type==="TRANSACTION_REPORT"?["postedAt","type","productSales","total","status"]',
        "transaction core-field validation",
        log,
    )

    old_block = "\n".join(
        [
            "      const expectsAds = entries.some(entry => String(entry?.dataType || '').toLowerCase().replace(/[^a-z]/g, '') === 'ads');",
            "      if (!importedRows || (expectsAds && !adsRows)) {",
            "        throw new Error(`报表已下载，但网页分析库未写入广告数据${quarantineText ? `：${quarantineText}` : '；请检查报表字段映射'}`);",
            "      }",
        ]
    )
    new_block = "\n".join(
        [
            "      const expectsAds = entries.some(entry => String(entry?.dataType || '').toLowerCase().replace(/[^a-z]/g, '') === 'ads');",
            "      const expectsTransactions = entries.some(entry => String(entry?.dataType || '').toLowerCase().replace(/[^a-z]/g, '') === 'transactions');",
            "      if (!importedRows || (expectsAds && !adsRows) || (expectsTransactions && !transactionRows)) {",
            "        const missingType = expectsAds && !adsRows ? '广告数据' : expectsTransactions && !transactionRows ? '联合交易数据' : '报表数据';",
            "        throw new Error(`报表已下载，但网页分析库未写入${missingType}${quarantineText ? `：${quarantineText}` : '；请检查报表字段映射与日期格式'}`);",
            "      }",
        ]
    )
    index = replace_once(
        index,
        old_block,
        new_block,
        "const expectsTransactions =",
        "embedded loader transaction acceptance check",
        log,
    )
    asset = replace_once(
        asset,
        old_block,
        new_block,
        "const expectsTransactions =",
        "source loader transaction acceptance check",
        log,
    )

    validate_javascript(index, asset)
    INDEX_PATH.write_text(index, encoding="utf-8")
    ASSET_PATH.write_text(asset, encoding="utf-8")
    DIAGNOSTIC_PATH.parent.mkdir(exist_ok=True)
    DIAGNOSTIC_PATH.write_text("\n".join(log) + "\nSUCCESS\n", encoding="utf-8")
    print("\n".join(log))
    print("SUCCESS")


if __name__ == "__main__":
    main()
