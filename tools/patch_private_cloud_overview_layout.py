from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one occurrence, found {count}")
    return text.replace(old, new, 1)


loader_path = Path("assets/private-cloud-warehouse-v4.js")
loader = loader_path.read_text(encoding="utf-8")
loader = replace_once(
    loader,
    "const LOADER_VERSION = '4.3.1';",
    "const LOADER_VERSION = '4.3.0';",
    "loader version",
)
required_loader_markers = [
    "const directPanelChild = element =>",
    "panel.insertBefore(card, statusHost || null)",
    "#privateCloudImportPanel > .privateCloudActions",
    ".queryFirstOverviewCard{display:none;gap:8px;width:100%;min-width:0;max-width:100%",
]
for marker in required_loader_markers:
    if marker not in loader:
        raise SystemExit(f"layout marker missing: {marker}")
loader_path.write_text(loader, encoding="utf-8")


test_path = Path("scripts/test-progressive-loader.mjs")
test = test_path.read_text(encoding="utf-8")
test = replace_once(
    test,
    "/const LOADER_VERSION = '4\\.3\\.1'/",
    "/const LOADER_VERSION = '4\\.3\\.0'/",
    "test loader version",
)
test_path.write_text(test, encoding="utf-8")


index_path = Path("index.html")
index = index_path.read_text(encoding="utf-8")
index = replace_once(
    index,
    '<script src="assets/private-cloud-warehouse-v4.js?v=4.3.1"></script>',
    '<script src="assets/private-cloud-warehouse-v4.js"></script>',
    "loader script tag",
)
index_path.write_text(index, encoding="utf-8")

print("Private cloud overview layout hotfix normalized")
