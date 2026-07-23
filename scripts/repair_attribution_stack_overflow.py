from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / "index.html"
DIAG = ROOT / ".diagnostics/attribution-stack-repair.txt"


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
    with tempfile.TemporaryDirectory(prefix="attribution-stack-") as temp_dir:
        temp = Path(temp_dir)
        for index, script in enumerate(parser.scripts, 1):
            path = temp / f"inline-{index:03d}.js"
            path.write_text(script, encoding="utf-8")
            subprocess.run([node, "--check", str(path)], check=True)


def main() -> None:
    text = INDEX.read_text(encoding="utf-8")
    log: list[str] = []

    old = '''const splitAttributionRows = (rows=[], context=UnifiedDecisionEngine.context()) => {
  const today=new Date();today.setHours(0,0,0,0);
  const mature=[],pending=[],bufferDays=getAttributionBufferDays(context);let matureThrough="";
  for(const r of rows||[]){
    const d=toDateOnly(r.date);const windowDays=Math.max(1,safeNum(r.attributionWindowDays)||getAdProductMeta(r.adProduct||"SP").defaultAttributionDays||7),requiredAge=windowDays+bufferDays;
    if(!d){pending.push(r);continue;}
    const age=Math.floor((today.getTime()-d.getTime())/ATTRIBUTION_DAY_MS);
    (age>=requiredAge?mature:pending).push(r);
  }
  const maxWindow=Math.max(1,...(rows||[]).map(r=>safeNum(r.attributionWindowDays)||getAdProductMeta(r.adProduct||"SP").defaultAttributionDays||7))+bufferDays;
  const cut=new Date(today);cut.setDate(cut.getDate()-maxWindow);matureThrough=cut.toISOString().slice(0,10);
  return {mature,pending,matureMetrics:sumMetrics(mature,context),pendingMetrics:sumMetrics(pending,context),bufferDays,matureThrough,dataAsOf:today.toISOString().slice(0,10),contextSignature:context?.signature||""};
};'''

    new = '''const splitAttributionRows = (rows=[], context=UnifiedDecisionEngine.context()) => {
  const today=new Date();today.setHours(0,0,0,0);
  const mature=[],pending=[],bufferDays=getAttributionBufferDays(context);let matureThrough="",maxWindowDays=1;
  for(const r of rows||[]){
    const windowDays=Math.max(1,safeNum(r.attributionWindowDays)||getAdProductMeta(r.adProduct||"SP").defaultAttributionDays||7);
    if(windowDays>maxWindowDays)maxWindowDays=windowDays;
    const d=toDateOnly(r.date),requiredAge=windowDays+bufferDays;
    if(!d){pending.push(r);continue;}
    const age=Math.floor((today.getTime()-d.getTime())/ATTRIBUTION_DAY_MS);
    (age>=requiredAge?mature:pending).push(r);
  }
  const maxWindow=maxWindowDays+bufferDays;
  const cut=new Date(today);cut.setDate(cut.getDate()-maxWindow);matureThrough=cut.toISOString().slice(0,10);
  return {mature,pending,matureMetrics:sumMetrics(mature,context),pendingMetrics:sumMetrics(pending,context),bufferDays,matureThrough,dataAsOf:today.toISOString().slice(0,10),contextSignature:context?.signature||""};
};'''

    marker = "let matureThrough=\"\",maxWindowDays=1;"
    if old in text:
        text = text.replace(old, new, 1)
        log.append("PATCH splitAttributionRows single-pass max-window calculation")
    elif marker in text:
        log.append("OK splitAttributionRows already repaired")
    else:
        raise RuntimeError("splitAttributionRows anchor not found")

    old_grain = '  const maxSpend=Math.max(0,...Object.values(stats).map(x=>x.spend||0));'
    new_grain = '  let maxSpend=0;for(const x of Object.values(stats)){const spend=safeNum(x.spend);if(spend>maxSpend)maxSpend=spend;}'
    if old_grain in text:
        text = text.replace(old_grain, new_grain, 1)
        log.append("PATCH grain reconciliation maximum")
    elif new_grain in text:
        log.append("OK grain reconciliation maximum already repaired")

    risky_math = []
    risky_push = []
    for number, line in enumerate(text.splitlines(), 1):
        if re.search(r"Math\.(?:max|min)\([^\n;]*\.\.\.", line):
            risky_math.append(f"{number}: {line.strip()}")
        if re.search(r"\.(?:push|unshift|splice)\([^\n;]*\.\.\.", line):
            risky_push.append(f"{number}: {line.strip()}")

    validate_js(text)
    INDEX.write_text(text, encoding="utf-8")
    DIAG.parent.mkdir(exist_ok=True)
    log.append(f"remaining Math max/min spread warnings: {len(risky_math)}")
    log.extend(f"WARN {item}" for item in risky_math[:10])
    log.append(f"remaining push/unshift/splice spread warnings: {len(risky_push)}")
    log.extend(f"WARN {item}" for item in risky_push[:10])
    log.append("SUCCESS")
    DIAG.write_text("\n".join(log) + "\n", encoding="utf-8")
    print("\n".join(log))


if __name__ == "__main__":
    main()
