from pathlib import Path

path = Path("README.md")
text = path.read_text(encoding="utf-8")

replacements = {
    "4.2.3": "4.3.0",
    "1.1.0": "1.2.0",
    "31077568702": "31090843724",
    "5f9a4bd8190e57bcbf993884028cef9c70467c87": "94254f7b7c364d17f25807337ba3424262e92b39",
    "58d31c6867e40a6deaff70cd3eb8461a65e267a5": "3f008f756007949a8833aba1b6e7674c565b727a",
    "31073518918": "31087845759",
    "### 最终 Phase 8 验收快照": "### 第三阶段 Query-first 渐进式验收快照",
    "| 控制台错误 | 0 |": "| 控制台记录 | 1 次已恢复的 `ERR_CONTENT_LENGTH_MISMATCH` |",
    "| 最终 Chromium 总耗时 | 约 209 秒 |": "| 首屏 Bootstrap | 约 5.8 秒，3 个查询，0 Manifest / 0 Raw |\n| 显式完整历史 | 约 110.6 秒，18 个月 / 32 文件 / 215,800 行 |\n| 最终 Chromium 总耗时 | 约 125.8 秒 |",
}
for old, new in replacements.items():
    if old not in text:
        raise SystemExit(f"README marker missing: {old}")
    text = text.replace(old, new)

old_transport = "GitHub Actions 的生产 Chromium 验收为规避 Runner 到 workers.dev 的 HTTP/3 不稳定，仅在 CI 启动参数中使用 `--disable-quic`；真实用户浏览器和生产页面不受影响。Warehouse 历史审计只对已识别的瞬时 socket/stream 响应体中断做有界重试，所有摘要、行数、脱敏和 TiDB 来源断言保持 fail-closed。"
new_transport = "GitHub Actions 的生产 Chromium 验收为隔离 Runner 到 workers.dev 的 HTTP/3 与长连接 HTTP/2 不稳定，仅在 CI 启动参数中使用 `--disable-quic` 和 `--disable-http2`，强制验收浏览器使用 HTTP/1.1；真实用户浏览器和生产页面不受影响。最终验收中记录到一次被 Loader 有界重试恢复的 `ERR_CONTENT_LENGTH_MISMATCH`，但 32 个文件的字节、SHA-256、行数、脱敏状态和数据指纹均通过。"
if old_transport not in text:
    raise SystemExit("Transport paragraph marker missing")
text = text.replace(old_transport, new_transport, 1)

start = text.find("### 加载流程\n")
end = text.find("### 凭据模型\n", start)
if start < 0 or end < 0:
    raise SystemExit("Loader flow section markers missing")
new_flow = """### 加载流程

```text
1. 用户选择 ALL 或单店铺范围
2. 点击“加载私有云数据”并输入访问密码
3. Loader 调用 Health、Summary 与 Query-first Bootstrap
4. 首屏显示经营概览、数据覆盖、最新月份和数据指纹
5. 首屏不请求 Manifest，也不下载 Raw CSV
6. 用户按需选择“最新月明细”“近 3 月明细”或“完整历史”
7. Loader 使用月份过滤 Manifest，仅串行请求所需 TiDB Raw
8. 校验摘要、ETag、字节、行数、脱敏状态、TiDB 来源与数据指纹
9. 页面分批解析、去重、索引、聚合和渲染
10. 完整历史仍保留全部深度分析与导出能力
```

生产渐进式契约：

```text
loadingStrategy = query-first-progressive-v1
Loader = 4.3.0
Query Client = 1.2.0
Bootstrap = query-first-bootstrap-v1
```

"""
text = text[:start] + new_flow + text[end:]

marker = "---\n\n## 新对话接手入口"
if marker not in text:
    raise SystemExit("README insertion marker missing")
section = """---

## 第三阶段生产结果：Frontend 渐进式加载

```text
Frontend main / Pages source: 94254f7b7c364d17f25807337ba3424262e92b39
Frontend PR: #17
Frontend PR CI: 31087776985
Frontend main CI: 31087845755
Pages: 31087845759
Warehouse acceptance main: 3f008f756007949a8833aba1b6e7674c565b727a
Warehouse production Run: 31090843724
```

真实 Chromium 验收：

- Loader `4.3.0`，Query Client `1.2.0`。
- 首屏 Bootstrap 约 `5.8s`，3 个查询请求，Manifest `0`，Raw `0`。
- 数据指纹：`f2902e1920069ad54d7afbe20922a0fd8729e80491a6f66910be6d426a80800d`。
- 显式完整历史覆盖 `2025-01` 至 `2026-06` 共 18 个月。
- 完整历史 `32` 文件、`215,800` 行、`18` 个脱敏联合报告，约 `110.6s` 完成。
- Bootstrap、Manifest 与 Raw 数据指纹完全一致。
- 页面错误 `0`；有 1 次网络资源长度错误被有限重试恢复，最终内容完整性全部通过。

默认按钮不再下载全部 CSV。Raw 只在用户明确选择月份范围或完整历史时触发；店铺切换优先刷新服务端概览。

"""
text = text.replace(marker, section + "## 新对话接手入口", 1)
path.write_text(text, encoding="utf-8")
