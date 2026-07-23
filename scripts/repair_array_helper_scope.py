from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "index.html"
DIAG = ROOT / ".diagnostics/array-helper-scope-repair.txt"


class InlineScriptExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.active = False
        self.current: list[str] = []
        self.scripts: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() != "script":
            return
        values = {k.lower(): (v or "") for k, v in attrs}
        script_type = values.get("type", "").lower()
        self.active = "src" not in values and script_type in ("", "text/javascript", "application/javascript")
        self.current = []

    def handle_endtag(self, tag):
        if tag.lower() == "script" and self.active:
            self.scripts.append("".join(self.current))
            self.active = False
            self.current = []

    def handle_data(self, data):
        if self.active:
            self.current.append(data)


def validate_js(html: str) -> None:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is required")
    parser = InlineScriptExtractor()
    parser.feed(html)
    with tempfile.TemporaryDirectory(prefix="array-helper-scope-") as temp_dir:
        temp = Path(temp_dir)
        for index, script in enumerate(parser.scripts, 1):
            path = temp / f"inline-{index:03d}.js"
            path.write_text(script, encoding="utf-8")
            subprocess.run([node, "--check", str(path)], check=True)


def main() -> None:
    text = INDEX.read_text(encoding="utf-8")
    log: list[str] = []

    anchor = "window.PRIVATE_API_VERSION='v1';"
    helper = """window.PRIVATE_API_VERSION='v1';
window.__arrayMaxSafe=window.__arrayMaxSafe||function(values,fallback){let result=arguments.length>1?fallback:-Infinity;const source=values||[];for(let i=0;i<source.length;i++){const value=Number(source[i]);if(!Number.isNaN(value)&&value>result)result=value;}return result;};
window.__arrayMinSafe=window.__arrayMinSafe||function(values,fallback){let result=arguments.length>1?fallback:Infinity;const source=values||[];for(let i=0;i<source.length;i++){const value=Number(source[i]);if(!Number.isNaN(value)&&value<result)result=value;}return result;};"""
    marker = "window.__arrayMaxSafe=window.__arrayMaxSafe||function"
    if marker not in text:
        if anchor not in text:
            raise RuntimeError("Global helper insertion anchor not found")
        text = text.replace(anchor, helper, 1)
        log.append("PATCH global safe array helpers")
    else:
        log.append("OK global safe array helpers already present")

    max_pattern = re.compile(r"(?<![\w.])arrayMax\s*\(")
    min_pattern = re.compile(r"(?<![\w.])arrayMin\s*\(")
    text, max_count = max_pattern.subn("window.__arrayMaxSafe(", text)
    text, min_count = min_pattern.subn("window.__arrayMinSafe(", text)
    log.append(f"PATCH bare arrayMax calls: {max_count}")
    log.append(f"PATCH bare arrayMin calls: {min_count}")

    remaining_max = max_pattern.findall(text)
    remaining_min = min_pattern.findall(text)
    if remaining_max or remaining_min:
        raise RuntimeError(f"Bare array helper calls remain: max={len(remaining_max)} min={len(remaining_min)}")

    if "window.__arrayMaxSafe(" not in text:
        raise RuntimeError("No global arrayMax calls found after repair")

    validate_js(text)
    INDEX.write_text(text, encoding="utf-8")
    DIAG.parent.mkdir(exist_ok=True)
    log.append("remaining bare arrayMax calls: 0")
    log.append("remaining bare arrayMin calls: 0")
    log.append("SUCCESS")
    DIAG.write_text("\n".join(log) + "\n", encoding="utf-8")
    print("\n".join(log))


if __name__ == "__main__":
    main()
