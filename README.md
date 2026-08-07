# Ads Operations Integrity

Amazon 广告运营、经营分析、交易财务与执行治理工作台。

本仓库是系统的**公共前端与 GitHub Pages 生产仓库**。页面代码可以公开审查，但业务报表、交易明细、数据库连接和访问凭据不存放在这里。受治理数据由私有仓库 `mrtanshiyue/Amazon-Data-Warehouse`、Cloudflare Worker 和 TiDB Cloud 共同提供。

- 在线应用：<https://mrtanshiyue.github.io/Ads-Operations-Integrity/>
- 生产 API：`https://amazon-warehouse-cloud-v4.tanshiyuesir.workers.dev`
- Frontend 正式 Loader：`4.3.0`
- Query Client：`1.3.0`
- Query-native Module Adapter：`1.1.0`
- Ads Trend Controller：`1.0.0`
- Ads Trend Host Guard：`1.0.0`
- Worker API：`4.2.2`

> **README 是交接与运行手册，不是实时监控面板。** 新对话开始工作前仍必须重新检查两个仓库当前 `main`、开放 PR、最近 CI、最新部署、Worker `/api/v1/health`、Query Status 与 Pages 状态。README 中的 SHA/Run 是“最后已验证生产基线”，不是替代实时检查的静态真值。

---

# 1. 新对话接手入口

新的开发对话应先完成以下动作，再开始改代码：

1. 阅读本 README。
2. 阅读私有仓库 `Amazon-Data-Warehouse/README.md`。
3. 检查两个仓库当前 `main`、开放 PR、最近 Actions Run、最近生产部署。
4. 区分“当前仓库 main”与“最后一个改变生产行为的代码提交”；README-only 提交可能让 `main` SHA 前进，但不会改变运行逻辑。
5. 检查 Worker Health、Query Status、Pages `source_sha` 和前端版本是否匹配。
6. 涉及 TiDB、Worker、API、数据契约或浏览器协议时，必须 **Warehouse 先、Frontend 后**。
7. 所有改动从独立分支开始，通过 PR 和 CI 后再合并；不要直接修改 `main` 或 `gh-pages`。
8. 遇到阻塞要修复根因，不通过删除测试、弱化摘要校验或绕过安全门禁换绿色状态。

给新对话的推荐启动提示可以直接复制：

```text
请先读取 mrtanshiyue/Ads-Operations-Integrity 和 mrtanshiyue/Amazon-Data-Warehouse 两个仓库 README，
然后检查两个仓库当前 main、开放 PR、最近 CI、最新 Worker/Pages 部署和分支保护状态。
以 README 中的生产行为基线、数据模型、发布顺序、安全边界、已接受风险和禁止事项为约束继续任务。
所有修改必须在独立分支实施；涉及数据/API 时 Warehouse 先上线并完成 TiDB 对账、Worker smoke、历史完整性审计，再修改 Frontend。
不要恢复 V2、不要做破坏性迁移、不要绕过脱敏、摘要、数据指纹或浏览器凭据边界。
```

### 所有者工作方式

- 希望直接实施并交付，不只给建议。
- 大改造按批次推进，一批完成生产验收后再进入下一批。
- 发现真实阻塞应明确说明并修复根因。
- 架构保持全云端，不引入本地常驻服务器或 NAS 作为生产依赖。
- `Amazon-Data-Warehouse` 必须保持 **Private**。

---

# 2. 当前权威生产基线

最后核验日期：`2026-08-07`。

## Frontend

| 项目 | 当前已验证状态 |
|---|---|
| 最后改变前端生产行为的提交 | `2d4bb9ca8d7c3bad76933749025ba51804f90178` |
| 对应 PR | `#23 Phase 4: make advertising trend Query-native` |
| main CI | Run `31137657882` ✅ |
| GitHub Pages | Run `31137657880` ✅ |
| gh-pages `source_sha` | `2d4bb9ca8d7c3bad76933749025ba51804f90178` |
| Frontend `main` | 新对话必须实时读取；README-only 提交可能晚于上述行为基线 |
| `main` 保护 | 已启用，要求 `Static site and security invariants` |

Phase 4 第一批交易财务 Query-native 的生产提交：

```text
dd02299794197e8530cb1036f891cc665dec8c0b
```

Phase 4 第二批广告趋势 Query-native 的生产提交：

```text
2d4bb9ca8d7c3bad76933749025ba51804f90178
```

## Warehouse / Worker

| 项目 | 当前已验证状态 |
|---|---|
| Private Warehouse 当前 README 快照基线 | `7504ea240d6e88194b14419a69db2d98ab863126` |
| 最后改变 Warehouse/Worker 生产行为的代码基线 | `3f008f756007949a8833aba1b6e7674c565b727a` |
| 最后一次完整 Warehouse 生产验收 | Run `31090843724` ✅ |
| Worker | `amazon-warehouse-cloud-v4` |
| Worker API | `4.2.2` |
| Worker entry | `cloud-worker/src/query_first_plane.js` |
| 主存储 / Query Plane | TiDB Cloud |
| 私有归档 / recovery | Private GitHub Warehouse |

Warehouse 的 README-only 提交不会重新部署 Worker；因此判断后端真实行为时应以最近成功生产 Run 对应的代码提交和 `/api/v1/health` 为准。

---

# 3. GitHub、Cloudflare、TiDB Cloud、GitHub Pages、IndexedDB 的关系

用户有时会把 TiDB Cloud、IndexedDB 混在一起。这里明确区分：

- **TiDB Cloud**：云端生产数据库，是当前数据目录、文件内容和 Query Plane 的主存储。
- **IndexedDB**：用户浏览器本地缓存，只保存已经过摘要验证的不可变服务文件，绝不是云数据库，也不保存密码。

## 总体架构

```text
GitHub Public Repo: Ads-Operations-Integrity
        │
        ├─ main ── GitHub Actions CI
        │
        └─ Pages workflow ──► gh-pages ──► GitHub Pages
                                      │
                                      ▼
                                User Browser
                                      │
                                      │ HTTPS + Bearer credential
                                      │ credential only in current-tab memory
                                      ▼
                       Cloudflare Worker V4.2.2
                       amazon-warehouse-cloud-v4
                          │                 │
                          │ DATABASE_URL    │ GITHUB_TOKEN
                          ▼                 ▼
                    TiDB Cloud       Private GitHub Warehouse
                    production       immutable governed archive
                    primary store    migrations / Worker / tests
                          │                 │
                          └──── integrity / fallback / recovery ────┘

Browser IndexedDB
└─ cache only verified immutable Raw bytes by SHA-256
   never stores DATABASE_URL / password / PAT / Worker secrets
```

## 各组件职责

| 组件 | 真实职责 | 不负责什么 |
|---|---|---|
| `Ads-Operations-Integrity` Public GitHub | 前端代码、Loader、Query Client、Query-native 模块、CSP、Vendor、CI、Pages | 不保存业务明细、数据库连接、Token |
| GitHub Pages | 发布前端静态站点 | 不存储后端业务数据库 |
| Browser | UI、筛选、Query 调用、按需 Raw 兼容、本地导出 | 不直接连接 TiDB、不直接访问 Private GitHub |
| Cloudflare Worker | 认证、CORS、Query/Raw/Manifest/Summary/Upload API、完整性边界 | 不允许浏览器绕过它访问后端 |
| TiDB Cloud | `report_slots`、目录、文件内容、staging/facts/views、Query Plane、审计 | 不是浏览器本地缓存 |
| `Amazon-Data-Warehouse` Private GitHub | 脱敏归档、serving objects、Worker 源码、迁移、测试、部署、恢复 | 不能公开 |
| Browser IndexedDB | 已验证不可变文件缓存 | 不保存密码，不决定“当前文件” |

### 一个最重要的规则

```text
Browser 不能直接访问 TiDB Cloud
Browser 不能直接访问 Private GitHub
Browser 只能访问 Cloudflare Worker
```

Cloudflare Worker 是浏览器和私有数据平面之间唯一正式网关。

---

# 4. 三条生产数据路径

## 4.1 Query-first 默认路径

默认“加载私有云数据”不再下载全部 CSV：

```text
User Browser
→ Worker /api/v1/health
→ Worker Summary
→ Worker /api/v1/query/bootstrap
→ TiDB Cloud 聚合结果
→ 首屏显示经营概览和数据覆盖
```

第三阶段真实 Chromium 验收：

- 首屏约 `5.8s`
- 3 个查询请求
- Manifest `0`
- Raw `0`
- 不阻塞首页等待 80MB+ 全历史下载

## 4.2 Query-native 模块路径

Phase 4 开始把业务模块从“依赖浏览器 Raw 全量数组”迁移成 Query-native：

```text
Business Module
→ Query-native Module Adapter
→ PrivateCloudQuery
→ Worker /api/v1/query/*
→ TiDB Cloud current views / facts
→ normalized front-end vocabulary
→ module renderer / export
```

**Query 失败不会自动回退 Raw。** 自动回退会掩盖 API、字段契约和数据完整性问题，因此 Raw 兼容只能由用户显式选择。

## 4.3 Raw 兼容路径

只有需要完整历史或尚未 Query-native 的深层模块才使用：

```text
User explicitly chooses month / recent months / full history
→ filtered Manifest
→ Worker /api/v1/raw/<store>/<filename>
→ Worker resolves current report_slots entry
→ TiDB warehouse_file_content
→ if needed, controlled archive hydration/fallback from Private GitHub
→ digest / row count / redaction / storage verification
→ serial browser load
→ IndexedDB cache by verified SHA-256
```

Raw 是**兼容与深分析路径**，不再是默认首页前置条件。

---

# 5. Warehouse 数据模型与前端为什么必须遵守它

前端不能根据文件名、目录时间或本地缓存猜测“最新数据”。当前文件身份由 Warehouse/TiDB 决定。

核心关系：

```text
report_slots
   └─ current_file_id
        ▼
ingestion_files
   ├─ store_id
   ├─ report_month
   ├─ report_type
   ├─ source/serving sha256
   ├─ row_count
   ├─ sanitized state
   └─ content/analytics status
        │
        ├─► warehouse_file_content  verified file bytes
        └─► staging / normalized facts / current-version views
```

`dataFingerprint` 对当前文件身份进行确定性 SHA-256，语义包括：

```text
store
month
reportType
verified content digest
rowCount
redaction flag
```

用途：

- 防止旧浏览器缓存被当成最新生产数据。
- 让 Bootstrap、Manifest、Raw 对同一数据范围可以交叉验证。
- 为真实 Chromium 验收提供确定性断言。

前端不得把 README 中的文件数、某个文件名中的 `latest/final` 或 IndexedDB 缓存时间当成当前版本。

---

# 6. 已完成优化的演进逻辑

## 第一批：数据完整性与 Manifest 治理

完成：

- 修正联合交易报表白名单与测试。
- Manifest 与真实受治理对象对齐。
- 文件数/行数断言动态化。
- 历史完整性审计。
- 内容 SHA-256、行数、脱敏状态回填与交叉验证。
- 32 个生产文件、215,800 行、18 个脱敏联合交易文件完成对账。

目标：先让“当前数据是谁、是否完整”可证明，再谈性能和模块迁移。

## 第二批：安全收敛与旧路径退役

Frontend：

- 运行依赖本地化，禁止公共 CDN fallback。
- Vendor 字节由 SHA-256 锁定。
- 可执行内联脚本外置。
- CSP 收敛到同源脚本。
- 私有云密码从持久化存储移到当前标签页闭包内存。
- 清理临时修复、诊断和一次性 workflow。

Warehouse：

- 旧 V2 Worker 与 V2 部署流程退役。
- V4 成为唯一生产后端。
- 生产完整性与浏览器验收固定进 CI/部署链路。

目标：先把安全边界固定，避免性能优化把旧风险重新带回来。

## 第三批：TiDB 主存储 + Query Plane + Query-first 渐进加载

Warehouse：

- TiDB 成为当前生产主存储与 Query Plane。
- `Status / Overview / Ads / Transactions` Query APIs。
- Query-first `Bootstrap`。
- filtered Manifest。
- deterministic `dataFingerprint`。
- stable nested ETag。
- Raw 内容长度、SHA-256、行数、脱敏和 TiDB 来源验证。

Frontend：

- Loader `4.3.0`。
- Query-first 首屏。
- 最新月、近 3 月、完整历史改为显式动作。
- Raw 并发固定为 `1`。
- 有界重试处理 Cloudflare/TiDB 瞬时传输故障。

真实全量验收快照：

```text
32 files
215,800 rows
160,833 advertising fact rows
54,967 finance fact rows
18 sanitized combined reports
80,236,592 TiDB content bytes
2025-01 .. 2026-06 historical coverage
~5.8s first Bootstrap
~110.6s explicit full history
0 page errors
1 recovered ERR_CONTENT_LENGTH_MISMATCH
```

## 第四批：业务模块 Query-native 迁移（正在持续）

### Batch 1：交易财务 Query-native — 已上线

生产提交：

```text
dd02299794197e8530cb1036f891cc665dec8c0b
PR #21
```

完成：

- 新增 `assets/query-native-module-data-v1.js`。
- 交易财务通过 `PrivateCloudQuery.allTransactions()` 查询 `/api/v1/query/transactions`。
- 支持分页、日期、店铺、settlement 状态和 marketplace 过滤。
- `US -> amazon.com`、`CA -> amazon.ca`、`JP -> amazon.co.jp` 等 marketplace alias。
- 当前期间和等长上一期间异步加载。
- Excel 导出使用与页面一致的 Query-native 数据集。
- 保持原有财务公式；`preTaxNet` 使用与 Warehouse 一致的规范化字段计算。
- Raw 只保留显式 compatibility mode；Query error 不静默 fallback。

### Batch 2：经营大盘广告趋势 Query-native — 已上线

生产提交：

```text
2d4bb9ca8d7c3bad76933749025ba51804f90178
PR #23
main CI 31137657882
Pages 31137657880
```

完成：

- Query Client 升级到 `1.3.0`。
- Module Adapter 升级到 `1.1.0`。
- 新增 `query-native-ads-trend-v1.js`，独立负责经营总览广告趋势。
- 新增 `query-native-ads-trend-host-v1.js`，阻止 legacy Raw renderer 抢占 Query-native 图表。
- account-level 趋势优先使用 `/query/overview`。
- 明细广告范围使用 `/query/ads`。
- 支持 store、date、portfolio、campaign、ad group、targeting、match type、auto/manual、search term 过滤。
- attribution maturity 显式使用 SP 归因窗口 + 配置 buffer。
- business-mode contribution 只标记为当前人工经济参数的 base estimate，不与 Raw business/transaction/product-cost 数据偷偷混算。
- 修复负向搜索边界：`reading -men` 不再因为 `women` 包含字符 `men` 而错误排除。
- CI/Pages 增加交易财务与广告趋势永久契约测试。

---

# 7. 当前模块数据源矩阵

| 模块 | 当前主要数据源 | Raw 是否默认需要 | 状态 |
|---|---|---:|---|
| 私有云首屏 / 数据覆盖 | `/query/bootstrap` | 否 | Query-first |
| Executive / account overview | `/query/overview` | 否 | Query-native |
| 交易财务报表 | `/query/transactions` | 否 | Query-native |
| 经营大盘广告趋势 | `/query/overview` + `/query/ads` | 否 | Query-native |
| 完整历史深度分析 | filtered Manifest + Raw | 是，用户显式触发 | Compatibility |
| Advanced Bid Governance | 仍依赖更完整广告维度 | 当前不能安全完全迁移 | 待 Warehouse 契约扩展 |
| 部分 legacy 业务模块 | 历史浏览器数据数组 | 可能 | 分批迁移中 |

**不要把“Query Client 已存在”误解为“所有页面模块已经 Query-native”。** 当前策略是一个模块一个模块迁移，并为每一批增加永久契约测试。

---

# 8. 为什么下一步不能直接迁移 Advanced Bid Governance

当前 Warehouse `/query/ads` 足以支撑经营趋势和多数聚合筛选，但高级竞价治理需要更强的可证明数据契约，例如：

```text
ad product
advertised ASIN / SKU
purchased ASIN / SKU
stable targeting identity
report granularity
attribution window dimensions
profit / product-cost join keys
```

Frontend Adapter 已为这些字段预留规范化位置，但**不能因为前端有字段名就假定 Warehouse 当前生产数据一定完整提供这些维度**。

下一批正确顺序：

```text
1. Warehouse 扩展并验证广告 Query schema / current views
2. 回填或证明历史覆盖
3. TiDB reconciliation
4. Worker query smoke
5. historical integrity audit
6. 部署 Worker
7. Frontend 再迁移 Bid Governance / Campaign Studio
8. PR CI + Pages
9. 真实 Chromium 验收
```

如果缺少这些维度就直接迁移，可能产生错误利润、成熟归因、ASIN 归属或竞价建议，因此属于生产风险，不允许用默认值掩盖。

---

# 9. 前端核心文件关系

```text
index.html
└─ application shell / legacy business modules

assets/private-cloud-warehouse-v4.js
└─ Loader 4.3.0
   ├─ current-tab credential memory
   ├─ Query-first Bootstrap
   ├─ explicit Raw loading controls
   ├─ verified IndexedDB cache
   └─ exposes restricted queryRequest bridge

assets/private-cloud-query-v1.js
└─ Query Client 1.3.0
   ├─ /api/v1/query/status
   ├─ /api/v1/query/bootstrap
   ├─ /api/v1/query/overview
   ├─ /api/v1/query/ads
   ├─ /api/v1/query/transactions
   └─ version-loads Query-native modules

assets/query-native-module-data-v1.js
└─ Module Adapter 1.1.0
   ├─ transaction normalization/filtering
   ├─ ad normalization/filtering
   ├─ pagination / dedupe / cache
   └─ explicit Raw compatibility only

assets/query-native-ads-trend-v1.js
└─ ads trend controller 1.0.0

assets/query-native-ads-trend-host-v1.js
└─ host guard 1.0.0
   └─ prevents legacy Raw trend renderer from overwriting Query-native chart
```

`index.html` 仍然很大。后续模块化必须渐进进行，不能一次拆完再测试；历史事件、筛选器、导出和本地文件导入兼容性仍需要保留。

---

# 10. Loader、凭据和 IndexedDB 安全模型

## 凭据

密码只存在于 Loader 的当前标签页 JavaScript closure：

- 不写 `sessionStorage`
- 不写 `localStorage`
- 不写 IndexedDB
- 不暴露 `getPassword`
- 不放进 DOM、事件详情、日志或错误对象
- Query Client 只调用 Loader 提供的受限 `queryRequest`
- 刷新/关闭标签页或“清除密码”后失效

## Raw 稳定性

当前固定：

```text
LOADER_VERSION = 4.3.0
FETCH_CONCURRENCY = 1
Raw maxAttempts = 8
Raw retry max delay = 15000 ms
```

原因：Cloudflare + TiDB BLOB 在多个大 Raw 请求并发时出现过平台级失败、截断或 CORS 不完整响应。串行读取 + 有界重试已经通过完整历史验收。

**不得未经完整生产 Chromium 验收提高 Raw 并发。**

## IndexedDB

```text
Database: amazon-warehouse-v4-cache
Store: immutable-files
Key: verified SHA-256
```

只缓存 Worker 已确认摘要的不可变文件字节。它不保存密码，也不决定当前版本；Manifest/dataFingerprint 变化会让新内容使用新摘要对象。

---

# 11. Cloudflare Worker 前端必须知道的契约

公开配置：

```text
Worker name: amazon-warehouse-cloud-v4
API: 4.2.2
Entry: cloud-worker/src/query_first_plane.js
Compatibility date: 2026-07-24
workers.dev: enabled
Production URL: https://amazon-warehouse-cloud-v4.tanshiyuesir.workers.dev
```

Worker `wrangler.jsonc` 的公开变量包括：

```text
STORES=YTDBNS,YY,JJ
ALLOWED_ORIGINS=https://mrtanshiyue.github.io,http://localhost:8000,http://127.0.0.1:8000
GITHUB_OWNER=mrtanshiyue
GITHUB_REPO=Amazon-Data-Warehouse
GITHUB_BRANCH=main
MAX_UPLOAD_BYTES=15728640
```

生产 Secret 只存在 Cloudflare：

```text
DATABASE_URL
DASHBOARD_PASSWORD
PII_HASH_SECRET
GITHUB_TOKEN
```

这些值**不得**写进公共仓库、README、PR、日志或截图。

前端不能随意增加 CORS 请求头。历史上曾因 Loader 自行添加 `Cache-Control`，导致浏览器预检失败。需要新请求头时必须先修改 Warehouse Worker CORS，再做真实浏览器验收。

---

# 12. TiDB Cloud 前端必须知道的契约

TiDB Cloud 是生产主存储与 Query Plane，不是浏览器直连数据库。

浏览器只能通过 Worker 获取：

```text
Health / Summary
Manifest
Raw
/api/v1/query/bootstrap
/api/v1/query/status
/api/v1/query/overview
/api/v1/query/ads
/api/v1/query/transactions
```

前端判断数据可用时应比较：

```text
Manifest totalFiles / totalRows
Summary totals
Query Status fileCount / catalogRows / analyticsReady
Bootstrap coverage / dataFingerprint
Page importedFiles / importedRows / importStage
```

当前生产历史快照曾验证：

```text
32 current files
215,800 rows
160,833 advertising rows
54,967 finance rows
18 sanitized transaction files
32/32 TiDB content coverage
32/32 analytics coverage
```

Business Report 当前生产目录可能不可用；`businessSales = 0` 必须结合 `sourceCoverage.business.available` 判断，不能把“无数据源”错误解释成“真实销售额为 0”。

---

# 13. CI、Pages 与发布顺序

## Frontend CI

`.github/workflows/ci-main.yml` 当前永久检查至少包括：

- JavaScript syntax
- Query-first progressive loading contract
- Query-native transaction contract
- Query-native ads trend contract
- Vendor SHA-256 lock
- CSP / same-origin dependency isolation
- Loader / Query Client / credential invariants
- Raw serial retry invariants
- temporary workflow / repair artifact rejection
- Pages artifact completeness

`main` 分支保护要求：

```text
Static site and security invariants
```

## Pages

`.github/workflows/pages.yml` 从 `main` 构建不可变静态制品并发布到 `gh-pages`。

`gh-pages` 是生成结果，**不要直接编辑**。生产验收应核对 `_pages_config_status.txt` 中的 `source_sha`。

## 跨仓库标准发布顺序

只改前端 UI 且不改变后端协议：

```text
Frontend branch → PR CI → merge → Pages → browser check
```

涉及数据 / Worker / API / Query schema：

```text
Warehouse branch
→ migrations / Worker / tests
→ Warehouse PR CI
→ TiDB migrate/reconcile
→ Worker deploy + smoke
→ Raw + Query + historical integrity audit
→ merge/production acceptance
→ Frontend branch
→ Loader / Query Client / module changes
→ Frontend PR CI
→ merge
→ Pages
→ real Chromium acceptance
```

不要先部署依赖新 API 的前端，再等待后端上线。

---

# 14. 已解决问题与保留设计原因

| 历史问题 | 根因 | 当前正式处理 |
|---|---|---|
| 首页加载约 200 秒 | 默认下载并解析全部 Raw | Query-first，首屏约 5.8 秒且 0 Raw |
| Raw 502 / BLOB 表示差异 | TiDB Serverless/Edge 二进制形态 | 规范化二进制，固定 `@tidbcloud/serverless 0.1.0` |
| 大 Raw 并发失败 | Cloudflare/TiDB 平台传输不稳定 | `FETCH_CONCURRENCY = 1` |
| 截断 / Content-Length mismatch | 网络响应体不完整 | incomplete body 视为 retryable，不缓存 0-byte Blob |
| Query ETag 每次变化 | 嵌套 `generatedAt` 进入哈希 | stable nested ETag 递归排除展示时间戳 |
| Business smoke 错误要求非零 | 把“接口支持”当成“当前有数据” | `sourceCoverage` 明确数据源可用性 |
| CORS 健康检查失败 | 前端添加不允许的 `Cache-Control` | 删除该头；新增头必须 Worker 先支持 |
| `reading -men` 排除了 `women` | negative token 使用子字符串匹配 | alphanumeric negative token 改为词边界匹配 |
| legacy trend 覆盖新趋势 | 两套 renderer 同时拥有图表 | Query-native host guard 明确 ownership |

历史失败 Run、临时补丁 workflow 和排障提交是排障过程，不代表当前存在同名生产阻塞。

---

# 15. 已接受风险与补偿控制

## Warehouse `main` 未受原生分支保护

Warehouse 必须保持 Private。当前账户方案对私有仓库的所需分支保护能力存在限制，因此 Warehouse `main` 未使用与 Frontend 相同的原生保护规则。

补偿控制：

- 实际改动仍走独立 branch + Pull Request。
- Warehouse CI 必须通过。
- 生产部署必须执行迁移、对账、Worker smoke、Query/Raw 校验和历史完整性审计。
- GitHub 私有不可变归档与 TiDB 摘要交叉验证。
- 保留恢复点。

不要把这些补偿控制描述成与 GitHub 原生 branch protection 完全等价。

---

# 16. 不可违反的工程约束

- 不公开 `Amazon-Data-Warehouse`。
- 不恢复 V2 Worker、V2 部署流程或旧生产 API。
- 不让浏览器直接访问 Private GitHub Contents API。
- 不让浏览器直接连接 TiDB Cloud。
- 不把密码写入 sessionStorage/localStorage/IndexedDB。
- 不恢复公共 CDN JavaScript 或 runtime CDN fallback。
- 不绕过 Worker 认证、CORS、范围和完整性校验。
- 不把未脱敏交易数据写入公共仓库或浏览器不可控缓存。
- 不直接修改 `gh-pages`。
- 不未经 Chromium 验收提高 Raw 并发。
- 不删除 SHA-256、字节、行数、脱敏、dataFingerprint 或历史审计门禁来追求通过。
- 不把 README 静态数字当作实时生产状态。
- 不把 Query error 静默转换成 Raw fallback。
- 不在缺少 Warehouse 维度时用前端默认值伪造 Bid Governance 数据契约。
- 不让一次性 patch/repair workflow 留在 `main`。
- 不做破坏性 TiDB migration；优先 additive schema + backfill + compatibility window。

---

# 17. 下一批推荐入口

当前最合理的下一批是：**先扩 Warehouse 广告 Query 契约，再迁移 Advanced Bid Governance / Campaign Studio。**

优先验证：

1. `/query/ads` 是否能可靠返回 ad product、advertised/purchased ASIN/SKU、report granularity、attribution window 和稳定 targeting identity。
2. 这些字段在 32 个历史文件中的覆盖率与缺失语义。
3. 是否需要 additive migration/current view，而不是在 Frontend 伪造默认值。
4. Profit / product cost 的 join key 和来源是否可证明。
5. 成熟归因与 Pending 的时间窗口能否由 Warehouse schema 明确表达。
6. 完成后再逐模块迁移，不一次性重写 44k+ 行核心页面。

每迁移一个模块，都应像交易财务和广告趋势一样：

```text
独立 owner
Query-native adapter
explicit Raw compatibility only
permanent contract test
CI gate
Pages gate
real Chromium acceptance
```

---

# 18. 故障排查顺序

## 页面显示旧版本

强制刷新，或给 Pages URL 加临时查询版本参数；同时核对 `gh-pages/_pages_config_status.txt` 的 `source_sha`。

## 私有云加载失败

依次检查：

1. Worker `/api/v1/health`。
2. 浏览器密码是否正确。
3. Origin 是否在 Worker CORS 白名单。
4. Query Bootstrap / Status 是否正常。
5. 是否为 408/425/429/5xx 或网络截断。
6. Loader 是否仍为 `4.3.0`、Raw 并发 `1`、有界重试。
7. 是否错误添加了未允许的请求头。

## Query-native 模块空白

检查：

1. `PrivateCloudQuery.state()` 是否 ready。
2. Query Client 是否为 `1.3.0`。
3. Adapter 是否为 `1.1.0`。
4. 请求日期、scope、marketplace/campaign 等过滤是否过窄。
5. 是否把 sourceCoverage unavailable 错当成数值 0。
6. Legacy renderer 是否仍在抢占该模块；广告趋势由 host guard 管理 ownership。
7. 不要通过自动 Raw fallback 掩盖 Query 错误。

## 文件数或行数不一致

比较：

```text
Manifest
Summary
Query Status
Bootstrap coverage
Page import counters
Data fingerprint
```

同时确认 scope、月份范围、当前 `report_slots` 和缓存摘要。

---

# 19. 关键文件

```text
README.md
index.html
assets/private-cloud-warehouse-v4.js
assets/private-cloud-query-v1.js
assets/query-native-module-data-v1.js
assets/query-native-ads-trend-v1.js
assets/query-native-ads-trend-host-v1.js
assets/private-cloud-warehouse-v3.js
scripts/test-progressive-loader.mjs
scripts/test-query-native-modules.mjs
scripts/test-query-native-ads-trend.mjs
scripts/harden-static-site.mjs
scripts/vendor-lock.json
.github/workflows/ci-main.yml
.github/workflows/pages.yml
```

后端、数据、TiDB、Worker、迁移和完整生产验收的权威文档是 Private Warehouse README。两个 README 应在每次跨仓库生产变更后同步更新。

---

# 20. 一句话理解整个系统

```text
Public GitHub 管前端和 Pages；Private GitHub 管受治理数据、Worker 源码和恢复；
Cloudflare Worker 是唯一受控 API 网关；TiDB Cloud 是生产主存储与 Query Plane；
浏览器优先 Query-native，只有显式深分析才加载 verified Raw；IndexedDB 只缓存已验证不可变文件；
任何跨层改动都必须 Warehouse 先验证、Frontend 后发布，并由 CI + Pages/Worker + Chromium 共同关闭生产门禁。
```
