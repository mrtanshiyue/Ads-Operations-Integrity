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
DIAGNOSTIC = ROOT / ".diagnostics/yt-shop-label-patch.txt"


def replace_once(text: str, old: str, new: str, marker: str, label: str, log: list[str]) -> str:
    if old in text:
        log.append(f"PATCH {label}")
        return text.replace(old, new, 1)
    if marker in text:
        log.append(f"OK {label} already present")
        return text
    raise RuntimeError(f"Anchor not found: {label}")


def regex_replace_once(text: str, pattern: str, replacement: str, marker: str, label: str, log: list[str]) -> str:
    if marker in text:
        log.append(f"OK {label} already present")
        return text
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.MULTILINE)
    if count != 1:
        raise RuntimeError(f"Anchor not found: {label}")
    log.append(f"PATCH {label}")
    return updated


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


def patch_shop_ui(text: str, log: list[str]) -> str:
    text = regex_replace_once(
        text,
        r"const SHOPS = Object\.freeze\(\['ALL','YTDBNS','YY','JJ'\]\);\s*const SHOP_LABELS = Object\.freeze\(\{ALL:'全部店铺',YTDBNS:'YTDBNS 店铺',YY:'YY 店铺',JJ:'JJ 店铺'\}\);",
        "const SHOPS = Object.freeze(['ALL','YTDBNS','YY','JJ']);\n  const SHOP_SHORT_LABELS = Object.freeze({ALL:'ALL',YTDBNS:'YT',YY:'YY',JJ:'JJ'});\n  const SHOP_LABELS = Object.freeze({ALL:'全部店铺',YTDBNS:'YT 店铺',YY:'YY 店铺',JJ:'JJ 店铺'});",
        "const SHOP_SHORT_LABELS = Object.freeze({ALL:'ALL',YTDBNS:'YT'",
        "shop short-label map",
        log,
    )
    text = replace_once(text, "if (hint) hint.textContent = `当前：${shop} · ${SHOP_LABELS[shop]}`;", "if (hint) hint.textContent = `当前：${SHOP_SHORT_LABELS[shop]} · ${SHOP_LABELS[shop]}`;", "当前：${SHOP_SHORT_LABELS[shop]}", "active shop hint", log)
    text = replace_once(text, "if (typeof notify === 'function') notify(`分析店铺已切换为 ${next} · ${SHOP_LABELS[next]}`, 'good');", "if (typeof notify === 'function') notify(`分析店铺已切换为 ${SHOP_SHORT_LABELS[next]} · ${SHOP_LABELS[next]}`, 'good');", "分析店铺已切换为 ${SHOP_SHORT_LABELS[next]}", "shop-change notification", log)
    text = replace_once(text, "${SHOPS.map(shop => `<button class=\"shopScopeButton\" type=\"button\" role=\"radio\" data-shop=\"${shop}\" aria-label=\"${SHOP_LABELS[shop]}\">${shop}</button>`).join('')}", "${SHOPS.map(shop => `<button class=\"shopScopeButton\" type=\"button\" role=\"radio\" data-shop=\"${shop}\" aria-label=\"${SHOP_LABELS[shop]}\">${SHOP_SHORT_LABELS[shop]}</button>`).join('')}", ">${SHOP_SHORT_LABELS[shop]}</button>", "shop selector button text", log)
    text = regex_replace_once(text, r"window\.ShopScope = Object\.freeze\(\{\s*options: SHOPS,\s*labels: SHOP_LABELS,\s*get: \(\) => activeShop,", "window.ShopScope = Object.freeze({\n    options: SHOPS,\n    labels: SHOP_LABELS,\n    shortLabels: SHOP_SHORT_LABELS,\n    display: value => SHOP_SHORT_LABELS[normalizeShop(value)],\n    get: () => activeShop,", "display: value => SHOP_SHORT_LABELS[normalizeShop(value)]", "ShopScope display API", log)
    return text


def patch_cloud_loader(text: str, log: list[str], label_prefix: str) -> str:
    text = replace_once(text, "  const activeScope = () => normalizeScope(window.ShopScope?.get?.() || window.ACTIVE_SHOP || 'ALL');", "  const activeScope = () => normalizeScope(window.ShopScope?.get?.() || window.ACTIVE_SHOP || 'ALL');\n  const displayScope = value => window.ShopScope?.display?.(value) || (normalizeScope(value) === 'YTDBNS' ? 'YT' : normalizeScope(value));", "const displayScope = value => window.ShopScope?.display?.(value)", f"{label_prefix} displayScope helper", log)
    replacements = [
        ("setStatus(`正在连接 Amazon-Data-Warehouse · ${scope}…`);", "setStatus(`正在连接 Amazon-Data-Warehouse · ${displayScope(scope)}…`);", "正在连接 Amazon-Data-Warehouse · ${displayScope(scope)}", "connect status"),
        ("setStatus(`正在扫描 ${scope} 店铺文件清单…`);", "setStatus(`正在扫描 ${displayScope(scope)} 店铺文件清单…`);", "正在扫描 ${displayScope(scope)}", "scan status"),
        ("if (!entries.length) throw new Error(`${scope} 当前没有可加载的广告、联合交易或业务报表`);", "if (!entries.length) throw new Error(`${displayScope(scope)} 当前没有可加载的广告、联合交易或业务报表`);", "`${displayScope(scope)} 当前没有可加载", "empty-scope error"),
        ("const label = `${entry.storeId || scope} · ${entry.month || entry.filename || index + 1}`;", "const label = `${displayScope(entry.storeId || scope)} · ${entry.month || entry.filename || index + 1}`;", "`${displayScope(entry.storeId || scope)} ·", "download label"),
        ("setStatus(`已下载 ${entries.length} 个文件，正在按 ${scope} 范围建立分析索引…`);", "setStatus(`已下载 ${entries.length} 个文件，正在按 ${displayScope(scope)} 范围建立分析索引…`);", "正在按 ${displayScope(scope)} 范围", "indexing status"),
        ("const statusText = `${scope} 私密仓库已加载：${totalRows.toLocaleString()} 行", "const statusText = `${displayScope(scope)} 私密仓库已加载：${totalRows.toLocaleString()} 行", "const statusText = `${displayScope(scope)} 私密仓库已加载", "loaded status"),
        ("if (brand) brand.textContent = `系统就绪 · ${scope} 私密仓库 ${totalRows.toLocaleString()} 行`;", "if (brand) brand.textContent = `系统就绪 · ${displayScope(scope)} 私密仓库 ${totalRows.toLocaleString()} 行`;", "系统就绪 · ${displayScope(scope)} 私密仓库", "brand status"),
        ("setStatus(`已切换到 ${scope}；点击“加载私有云数据”读取该店铺`, 'warn');", "setStatus(`已切换到 ${displayScope(scope)}；点击“加载私有云数据”读取该店铺`, 'warn');", "已切换到 ${displayScope(scope)}", "switch prompt"),
        ("setStatus(`正在切换云端数据到 ${scope}…`);", "setStatus(`正在切换云端数据到 ${displayScope(scope)}…`);", "正在切换云端数据到 ${displayScope(scope)}", "switch status"),
        ("setStatus(`已保存当前标签页会话密码；点击加载 ${activeScope()} 私密仓库数据`);", "setStatus(`已保存当前标签页会话密码；点击加载 ${displayScope(activeScope())} 私密仓库数据`);", "点击加载 ${displayScope(activeScope())}", "saved-password status"),
    ]
    for old, new, marker, label in replacements:
        text = replace_once(text, old, new, marker, f"{label_prefix} {label}", log)
    return text


def validate_javascript(index: str, asset: str) -> None:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is required")
    parser = InlineScriptExtractor()
    parser.feed(index)
    with tempfile.TemporaryDirectory(prefix="yt-label-validate-") as temp_dir:
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
    index = patch_shop_ui(index, log)
    index = patch_cloud_loader(index, log, "embedded loader")
    asset = patch_cloud_loader(asset, log, "source loader")
    validate_javascript(index, asset)
    INDEX.write_text(index, encoding="utf-8")
    ASSET.write_text(asset, encoding="utf-8")
    DIAGNOSTIC.parent.mkdir(exist_ok=True)
    DIAGNOSTIC.write_text("\n".join(log) + "\nSUCCESS\n", encoding="utf-8")
    print("\n".join(log))
    print("SUCCESS")


if __name__ == "__main__":
    main()
