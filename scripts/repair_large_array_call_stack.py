from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "index.html"
ASSET = ROOT / "assets/private-cloud-warehouse-v3.js"
DIAGNOSTIC = ROOT / ".diagnostics/large-array-call-stack-repair.txt"


def replace_required(text: str, old: str, new: str, marker: str, label: str, log: list[str]) -> str:
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
        raise RuntimeError("Node.js is required")
    parser = InlineScriptExtractor()
    parser.feed(index)
    with tempfile.TemporaryDirectory(prefix="large-array-stack-") as temp_dir:
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

    old_helper = 'const appendArray = (target, source) => { for (let i=0;i<source.length;i++) target.push(source[i]); return target; };'
    new_helper = '''const appendArray = (target, source) => { for (let i=0;i<source.length;i++) target.push(source[i]); return target; };
const arrayMax = (values, fallback=-Infinity) => { let result=fallback; for(let i=0;i<(values?.length||0);i++){const value=Number(values[i]);if(!Number.isNaN(value)&&value>result)result=value;} return result; };
const arrayMin = (values, fallback=Infinity) => { let result=fallback; for(let i=0;i<(values?.length||0);i++){const value=Number(values[i]);if(!Number.isNaN(value)&&value<result)result=value;} return result; };'''
    index = replace_required(index, old_helper, new_helper, 'const arrayMax = (values, fallback=-Infinity)', 'safe array helper functions', log)

    replacements = [
        ('    out.push(...kept);', '    appendArray(out,kept);', 'appendArray(out,kept)', 'phrase candidate append'),
        ('  if (explicit.length) return Math.max(...explicit);', '  if (explicit.length) return arrayMax(explicit);', 'return arrayMax(explicit)', 'explicit maximum'),
        ('    item.rows.push(...(c.sourceRows || []));', '    appendArray(item.rows,c.sourceRows || []);', 'appendArray(item.rows,c.sourceRows || [])', 'long-tail source rows append'),
        ('  rows.push(...actionV4CampaignActions(globalTarget,controls),...actionV4PlacementActions(globalTarget,controls));', '  appendArray(rows,actionV4CampaignActions(globalTarget,controls));appendArray(rows,actionV4PlacementActions(globalTarget,controls));', 'appendArray(rows,actionV4CampaignActions', 'action rows append'),
        ('Math.max(...vals)/Math.max(.1,Math.min(...vals))', 'arrayMax(vals)/Math.max(.1,arrayMin(vals))', 'arrayMax(vals)/Math.max(.1,arrayMin(vals))', 'segmentation max/min'),
        ('    output.push(...candidates);', '    appendArray(output,candidates);', 'appendArray(output,candidates)', 'candidate output append'),
        ('  exceptions.push(...overflow);exceptions.sort(', '  appendArray(exceptions,overflow);exceptions.sort(', 'appendArray(exceptions,overflow)', 'exception overflow append'),
        ('max=Math.max(...c.expense.map(x=>x.value),1)', 'max=arrayMax(c.expense.map(x=>x.value),1)', 'max=arrayMax(c.expense.map(x=>x.value),1)', 'financial expense maximum'),
        ('if (Array.isArray(summary?.quarantine)) quarantineItems.push(...summary.quarantine);', 'if (Array.isArray(summary?.quarantine)) for(const item of summary.quarantine) quarantineItems.push(item);', 'for(const item of summary.quarantine) quarantineItems.push(item)', 'embedded quarantine append'),
    ]
    for old, new, marker, label in replacements:
        index = replace_required(index, old, new, marker, label, log)

    asset = replace_required(
        asset,
        'if (Array.isArray(summary?.quarantine)) quarantineItems.push(...summary.quarantine);',
        'if (Array.isArray(summary?.quarantine)) for(const item of summary.quarantine) quarantineItems.push(item);',
        'for(const item of summary.quarantine) quarantineItems.push(item)',
        'source loader quarantine append',
        log,
    )

    validate_javascript(index, asset)

    remaining_push = len(re.findall(r'\b(?:push|unshift)\s*\(\s*\.\.\.', index))
    remaining_math = len(re.findall(r'Math\.(?:max|min)\s*\(\s*\.\.\.', index))
    log.append(f"remaining push/unshift spread calls: {remaining_push}")
    log.append(f"remaining Math max/min spread calls: {remaining_math}")
    if remaining_push or remaining_math:
        raise RuntimeError(f"Unsafe large-argument calls remain: push={remaining_push}, math={remaining_math}")

    INDEX.write_text(index, encoding="utf-8")
    ASSET.write_text(asset, encoding="utf-8")
    DIAGNOSTIC.parent.mkdir(exist_ok=True)
    DIAGNOSTIC.write_text("\n".join(log) + "\nSUCCESS\n", encoding="utf-8")
    print("\n".join(log))
    print("SUCCESS")


if __name__ == "__main__":
    main()
