from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one occurrence, found {count}")
    return text.replace(old, new, 1)


loader_path = Path("assets/private-cloud-warehouse-v4.js")
loader = loader_path.read_text(encoding="utf-8")
loader = replace_once(
    loader,
    "const LOADER_VERSION = '4.3.0';",
    "const LOADER_VERSION = '4.3.1';",
    "loader version",
)

panel_css = "#privateCloudImportPanel{display:grid;grid-template-columns:1fr;gap:8px;margin-top:8px;padding:9px;border:1px solid color-mix(in srgb,var(--accent) 22%,var(--line));border-radius:12px;background:color-mix(in srgb,var(--accent) 5%,var(--input-bg))}"
panel_css_fixed = "#privateCloudImportPanel{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;width:100%;min-width:0;max-width:100%;margin-top:8px;padding:9px;border:1px solid color-mix(in srgb,var(--accent) 22%,var(--line));border-radius:12px;background:color-mix(in srgb,var(--accent) 5%,var(--input-bg));overflow:hidden}\n      #privateCloudImportPanel > .privateCloudActions,#privateCloudImportPanel > .queryFirstRawActions,#privateCloudImportPanel > .queryFirstOverviewCard,#privateCloudImportPanel > #privateCloudImportStatus{grid-column:1 / -1;width:100%;min-width:0;max-width:100%;justify-self:stretch}"
loader = replace_once(loader, panel_css, panel_css_fixed, "panel CSS")
loader = replace_once(
    loader,
    ".queryFirstOverviewCard{display:none;gap:8px;padding:9px;border:1px solid var(--line);border-radius:11px;background:var(--card)}",
    ".queryFirstOverviewCard{display:none;gap:8px;width:100%;min-width:0;max-width:100%;padding:9px;border:1px solid var(--line);border-radius:11px;background:var(--card);overflow:hidden}",
    "overview card CSS",
)
loader = replace_once(
    loader,
    ".queryFirstOverviewHead{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}",
    ".queryFirstOverviewHead{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;min-width:0}.queryFirstOverviewHead>div{min-width:0}",
    "overview head CSS",
)
loader = replace_once(
    loader,
    ".queryFirstFingerprint{font:600 9.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);white-space:nowrap}",
    ".queryFirstFingerprint{font:600 9.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);white-space:nowrap;max-width:45%;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto}",
    "fingerprint CSS",
)
loader = replace_once(
    loader,
    ".queryFirstKpis{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}",
    ".queryFirstKpis{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;width:100%;min-width:0}",
    "KPI CSS",
)
loader = replace_once(
    loader,
    ".queryFirstRawState{padding-top:6px;border-top:1px solid var(--line);font-size:10.2px;line-height:1.45;color:var(--muted)}",
    ".queryFirstRawState{padding-top:6px;border-top:1px solid var(--line);font-size:10.2px;line-height:1.45;color:var(--muted);overflow-wrap:anywhere}",
    "raw state CSS",
)

new_ui_function = r'''  function ensureProgressiveUi() {
    const panel = byId('privateCloudImportPanel');
    if (!panel) return;
    const directPanelChild = element => {
      if (!element) return null;
      return [...panel.children].find(child => child === element || child.contains(element)) || null;
    };

    let actions = byId('queryFirstRawActions');
    if (!actions) {
      actions = document.createElement('div');
      actions.id = 'queryFirstRawActions';
      actions.className = 'queryFirstRawActions';
      actions.innerHTML = `
        <button class="btn" id="btnPrivateCloudCurrentMonth" type="button" disabled>最新月明细</button>
        <button class="btn" id="btnPrivateCloudRecentMonths" type="button" disabled>近 3 月明细</button>
        <button class="btn" id="btnPrivateCloudFullHistory" type="button" disabled>完整历史</button>
      `;
    }

    const baseActionsHost = directPanelChild(panel.querySelector('.privateCloudActions'));
    const status = byId('privateCloudImportStatus');
    let statusHost = directPanelChild(status);
    if (actions.parentElement !== panel || (baseActionsHost && actions.previousElementSibling !== baseActionsHost)) {
      panel.insertBefore(actions, baseActionsHost?.nextElementSibling || statusHost || null);
    }

    let card = byId('queryFirstOverviewCard');
    if (!card) {
      card = document.createElement('div');
      card.id = 'queryFirstOverviewCard';
      card.className = 'queryFirstOverviewCard';
      card.dataset.ready = '0';
      card.innerHTML = `
        <div class="queryFirstOverviewHead">
          <div>
            <div class="queryFirstOverviewTitle">TiDB 云端经营概览</div>
            <div class="queryFirstOverviewMeta" id="queryFirstOverviewMeta">尚未连接</div>
          </div>
          <span class="queryFirstFingerprint" id="queryFirstFingerprint"></span>
        </div>
        <div class="queryFirstSourceBadges" id="queryFirstSourceBadges"></div>
        <div class="queryFirstKpis" id="queryFirstKpis"></div>
        <div class="queryFirstRawState" id="queryFirstRawState">明细数据尚未加载；当前卡片为服务端聚合，不代表页面深度分析库已就绪。</div>
      `;
    }

    statusHost = directPanelChild(status);
    if (card.parentElement !== panel || (statusHost && card.nextElementSibling !== statusHost)) {
      panel.insertBefore(card, statusHost || null);
    }
    updateRawButtons();
  }'''
pattern = re.compile(r"  function ensureProgressiveUi\(\) \{.*?\n  \}\n\n  const bindUi", re.S)
loader, count = pattern.subn(new_ui_function + "\n\n  const bindUi", loader, count=1)
if count != 1:
    raise SystemExit(f"progressive UI function: expected one replacement, found {count}")
loader_path.write_text(loader, encoding="utf-8")


test_path = Path("scripts/test-progressive-loader.mjs")
test = test_path.read_text(encoding="utf-8")
test = replace_once(test, "/const LOADER_VERSION = '4\\.3\\.0'/", "/const LOADER_VERSION = '4\\.3\\.1'/", "test loader version")
insert_marker = "assert.match(loader, /dataFingerprint/);\n"
layout_assertions = """assert.match(loader, /const directPanelChild = element =>/);\nassert.match(loader, /panel\\.insertBefore\\(card, statusHost \\|\\| null\\)/);\nassert.match(loader, /#privateCloudImportPanel > \\.queryFirstOverviewCard/);\nassert.match(loader, /\\.queryFirstOverviewCard\\{[^}]*width:100%;[^}]*min-width:0/);\nassert.doesNotMatch(loader, /status\\.insertAdjacentElement\\('beforebegin', card\\)/);\n"""
test = replace_once(test, insert_marker, insert_marker + layout_assertions, "layout assertions")
test_path.write_text(test, encoding="utf-8")


index_path = Path("index.html")
index = index_path.read_text(encoding="utf-8")
index, count = re.subn(
    r'<script src="assets/private-cloud-warehouse-v4\.js(?:\?[^\"]*)?"></script>',
    '<script src="assets/private-cloud-warehouse-v4.js?v=4.3.1"></script>',
    index,
    count=1,
)
if count != 1:
    raise SystemExit(f"loader script tag: expected one replacement, found {count}")
index_path.write_text(index, encoding="utf-8")

print("Private cloud overview layout patch applied")
