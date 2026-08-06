from pathlib import Path

path = Path("README.md")
text = path.read_text(encoding="utf-8")
marker = "## 外部平台运行交接：TiDB Cloud 与 Cloudflare"
if marker in text:
    raise SystemExit("platform handoff already present")

section = r'''

---

## 外部平台运行交接：TiDB Cloud 与 Cloudflare

这一节用于让新的开发对话理解外部平台在本项目中的真实职责、配置边界和安全约束。公共前端只消费 Worker API，不直接管理 TiDB Cloud 或 Cloudflare 账户。

### 平台数据路径

```text
Browser / GitHub Pages
        │
        │ HTTPS + Authorization: Bearer <current-tab password>
        ▼
Cloudflare Worker: amazon-warehouse-cloud-v4
        │
        ├─ DATABASE_URL ─────────► TiDB Cloud
        └─ GITHUB_TOKEN ─────────► Private GitHub archive fallback
```

前端仓库中不存在 `DATABASE_URL`、Cloudflare Account ID、TiDB 主机名、数据库用户名或任何平台 Token。新对话若需要修改外部平台，必须转到私有 Warehouse 仓库和相应平台控制台核验，不得从前端代码推断凭据。

### TiDB Cloud：前端必须知道的事实

- TiDB Cloud 是生产 `Raw + Query Plane` 的主存储，不是浏览器直连数据库。
- 浏览器只通过 Worker 访问 `Manifest`、`Summary`、`Raw` 和 `/api/v1/query/*`。
- 当前健康响应应报告：

```text
storage = tidb-primary
catalog = tidb-cloud
queryPlane = tidb-query-plane-v1
archive = github-private-repository
```

- 前端判断数据可用不能只看 `/health`，还应比较：

```text
Manifest totalFiles / rowCount
Summary totals
Query Status fileCount / catalogRows / analyticsReady
Page importedFiles / importedRows / importStage
```

- TiDB 当前文件由 `report_slots` 决定；前端不得把目录排序、文件名中的 `latest/final` 或缓存时间当成当前版本。
- TiDB 连接、迁移、事实表、逻辑恢复和数据库故障处理以 Warehouse README 为准。
- 精确 TiDB 项目、集群、主机、用户名和连接串属于敏感基础设施信息，不写入公共 README。

### Cloudflare：前端必须知道的事实

当前公开配置来自 Warehouse `cloud-worker/wrangler.jsonc`：

```text
Worker name: amazon-warehouse-cloud-v4
Worker API: 4.2.2
Entry: cloud-worker/src/query_plane.js
Compatibility date: 2026-07-24
workers.dev: enabled
Production URL: https://amazon-warehouse-cloud-v4.tanshiyuesir.workers.dev
```

当前 Worker 没有使用 KV、R2、D1、Queues、Durable Objects 或自定义域名路由绑定。不要在前端假设这些平台能力已经存在。

允许的浏览器 Origin：

```text
https://mrtanshiyue.github.io
http://localhost:8000
http://127.0.0.1:8000
```

允许的 CORS 请求头：

```text
Authorization
Content-Type
If-None-Match
X-Dashboard-Password
```

前端不得自行添加 `Cache-Control`、自定义追踪头或其他非简单请求头，除非先同步修改 Worker CORS 并完成真实浏览器预检验收。此前 Loader 增加 `Cache-Control` 后，浏览器连健康检查都被预检拦截。

Worker 可能在请求进入应用代码前发生 Cloudflare 平台级网络或 5xx 故障，这类响应可能没有 CORS 头。生产 Loader 因此采用：

```text
FETCH_CONCURRENCY = 1
maxAttempts = 8
bounded exponential backoff
unique retry query marker
```

不要把平台级无 CORS 错误误判为数据库内容损坏，也不要用提高并发的方式处理。

### Cloudflare 缓存语义

- Health 与一般错误响应使用私有、不存储策略。
- Query JSON 使用短时私有缓存和 ETag。
- 已验证 Raw CSV 使用内容 SHA 作为 ETag，并允许不可变私有缓存。
- 浏览器缓存命中仍必须受 Authorization、Origin、Manifest 摘要和当前范围约束。
- 前端请求可以使用 `If-None-Match`，但不要绕过 Worker 内容验证头。

### 外部平台变更前检查表

新对话涉及 TiDB Cloud 或 Cloudflare 时，至少完成：

1. 读取 Warehouse README 的 TiDB Cloud 与 Cloudflare 平台章节。
2. 检查 `cloud-worker/wrangler.jsonc`、`package.json`、部署工作流和当前 Worker Health。
3. 确认改动是否影响 `DATABASE_URL`、Worker Secret、CORS、API 版本或 Loader。
4. 不在前端仓库、PR、日志或截图中暴露平台 ID 和凭据。
5. 先完成 Warehouse CI、迁移/对账、Worker smoke、Raw、Query 和历史审计。
6. 再更新前端版本和 Pages。
7. 最后由 Warehouse Chromium 验证真实线上页面。

### 不应写入公共仓库的平台信息

```text
TiDB project / cluster ID
TiDB hostname and username
DATABASE_URL
Cloudflare account ID
Cloudflare API token
Worker runtime secret values
DASHBOARD_PASSWORD
PII_HASH_SECRET
GitHub PAT values
```

这些信息的“名称、用途和轮换影响”可以记录，但真实值只能保存在平台控制台和 GitHub Secrets 中。
'''

path.write_text(text.rstrip() + section + "\n", encoding="utf-8")
