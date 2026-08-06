# Ads Operations Integrity

Amazon 广告运营、经营分析、交易财务与执行治理工作台。

本仓库是系统的**公共前端与 GitHub Pages 生产仓库**。页面代码可以公开审查，但业务报表、交易数据、数据库连接和访问凭据不存放在这里。受治理数据由私有仓库 `mrtanshiyue/Amazon-Data-Warehouse`、TiDB Cloud 和经过认证的 Cloudflare Worker 提供。

- 在线应用：<https://mrtanshiyue.github.io/Ads-Operations-Integrity/>
- 生产数据 API：`https://amazon-warehouse-cloud-v4.tanshiyuesir.workers.dev`
- 生产分支：`main`
- Loader：`4.2.3`
- Query Client：`1.1.0`
- Worker API：`4.2.2`
- Cloudflare Worker 版本：`39`（100% 流量）
- 最后一次完整生产验收：Warehouse Run `31074460434`
- 最后一个应用代码基线：`5f9a4bd8190e57bcbf993884028cef9c70467c87`
- 最新成功 GitHub Pages：Run `31073518918`

> README 是项目交接文档，不是实时监控面板。文件数、行数、版本和健康状态应以当前 `main`、Worker `/api/v1/health`、Manifest、Query Status 和最新成功的生产 Run 为准。

---

## 新对话接手入口

新的开发对话在修改项目前，应按以下顺序建立上下文：

1. 阅读本 README。
2. 阅读私有仓库 `Amazon-Data-Warehouse/README.md`。
3. 获取两个仓库当前 `main`、开放 PR、最近 CI 和最近生产部署 Run。
4. 区分“当前生产代码提交”和其后的 README-only 文档提交。
5. 确认当前 Worker、Loader、Query Client 三方版本是否匹配。
6. 涉及数据、Worker、API 或浏览器协议时，先改 Warehouse，生产验收通过后再改前端。
7. 所有生产变更使用独立分支和 Pull Request；不得绕过 CI。
8. 未经所有者明确确认，不自动开始下一批大改造。

给新对话的最小任务说明可以直接使用：

```text
请先读取 Ads-Operations-Integrity 和 Amazon-Data-Warehouse 两个仓库的 README，
再检查两个仓库当前 main、开放 PR、最近 CI 和最新生产 Run。
以 README 中“当前生产状态、发布顺序、安全边界、已接受风险、禁止事项”为约束，
直接在独立分支实施修改，通过 PR、CI、Pages/Worker 部署和 Chromium 验收后再合并。
不要恢复旧 V2 Worker、远程 CDN、持久化密码、高并发 Raw 下载或浏览器直连私有 GitHub。
```

### 所有者工作方式

- 希望直接实施并交付，不只给建议。
- 大改造按批次推进；当前批次关闭或明确接受阻塞后，才能进入下一批。
- 发现阻塞必须如实说明，不以弱化校验或跳过门禁换取“成功”。
- 架构保持全云端，不引入群晖或本地常驻服务器依赖。
- Warehouse 必须保持 Private，不得为了分支保护而公开。

---

## 当前生产基线

### 版本与仓库

| 项目 | 当前生产基线 |
|---|---|
| Public Frontend | `mrtanshiyue/Ads-Operations-Integrity` |
| Private Warehouse | `mrtanshiyue/Amazon-Data-Warehouse` |
| GitHub Pages | `https://mrtanshiyue.github.io/Ads-Operations-Integrity/` |
| Worker | `amazon-warehouse-cloud-v4` / API `4.2.2` |
| Worker deployment | Cloudflare version `39` / 100% traffic |
| Loader | `assets/private-cloud-warehouse-v4.js` / `4.2.3` |
| Query Client | `assets/private-cloud-query-v1.js` / `1.1.0` |
| Query primary storage | TiDB Cloud |
| Archive / recovery source | Private GitHub immutable objects |
| Browser credential | Current-tab JavaScript closure memory only |

### 最终 Phase 8 验收快照

| 项目 | 验收结果 |
|---|---:|
| 当前文件 | 32 |
| 总目录行数 | 215,800 |
| 广告事实行 | 160,833 |
| 财务事实行 | 54,967 |
| 脱敏交易文件 | 18 |
| TiDB 内容字节 | 80,236,592 |
| TiDB 内容覆盖 | 32 / 32 |
| 分析覆盖 | 32 / 32 |
| 失败文件 | 0 |
| 月度 Overview 期间 | 18 |
| 浏览器导入阶段 | `complete` |
| 页面错误 | 0 |
| 控制台错误 | 0 |
| Query Status / Overview | 通过 |
| 最终 Chromium 总耗时 | 约 135 秒 |

最后一次完整生产关闭门禁同时验证：Worker、TiDB 迁移与对账、Raw、Query APIs、32 文件历史完整性审计、GitHub Pages、Loader、Query Client 和真实 Chromium 全量导入。

---

## 项目目标与业务范围

本项目不是单一广告报表查看器，而是 Amazon 运营数据的“完整性、联动决策和执行治理”工作台。主要目标：

- 将多个店铺、月份和报表类型统一到可追踪的数据范围中。
- 防止混合粒度报表、重复导入和过期文件造成双重计算。
- 联动广告销售、业务销售和交易财务数据。
- 给出广告结构、竞价、否定、利润和执行优先级分析。
- 保证交易隐私、内容摘要、版本可追踪和生产可回滚。

### 前端主要模块

- 经营大盘与 Executive Overview
- 经营联动趋势
- 广告 Campaign / Ad Group / Targeting / Search Term 分析
- 关键词、搜索词、词根和长尾词分析
- ACOS、ROAS、CPC、CTR、CVR、订单和销售额分析
- 成熟归因与 Pending 归因拆分
- 广告结构完整性、竞价、否定和执行优先级
- 广告销售、业务销售和交易销售对账
- 交易财务报表：销售、退款、销售费用、FBA 费用和其他支出
- SKU 月度盈利、成本、利润和运营费用调整
- 日期范围、店铺范围、明细筛选和导出

交易财务模块依赖联合交易报表；经营联动趋势应纳入交易/联合报告销售额。页面可以本地导入文件，也可以通过私有云加载受治理生产数据。

### 支持的数据类别

主要报表类型包括：

```text
advertising-report
combined-report
business-report
ads-search-term
ads-targeting
ads-campaign
ads-advertised-product
ads-placement
```

生产范围支持：

```text
ALL
YTDBNS
YY
JJ
```

当前版本由 Warehouse Manifest 和 TiDB `report_slots` 决定，不应从文件名或目录数量猜测。

---

## 系统架构

```text
Browser / GitHub Pages
        │
        │ HTTPS + Bearer credential held in current-tab memory
        ▼
Cloudflare Worker V4.2.2
        │
        ├──────────────► TiDB Cloud（生产主存储与查询平面）
        │                ├─ 当前文件目录与槽位
        │                ├─ 文件内容与完整性元数据
        │                ├─ 广告与财务 staging / facts
        │                ├─ current-version views
        │                └─ import / access audit
        │
        └──────────────► Amazon-Data-Warehouse（Private）
                         ├─ immutable source-sanitized objects
                         ├─ immutable serving objects
                         ├─ migrations / Worker / tests
                         └─ Git history / recovery branches
```

### 两个仓库的职责边界

| 仓库 | 可见性 | 负责内容 |
|---|---|---|
| `Ads-Operations-Integrity` | Public | 页面、Loader、Query Client、CSP、同源第三方依赖、前端 CI、Pages |
| `Amazon-Data-Warehouse` | Private | 受治理报表、TiDB、Worker、API、上传、脱敏、迁移、审计、部署和浏览器验收 |

### 明确禁止进入公共仓库的内容

- Amazon 原始订单或未脱敏交易报表
- 姓名、邮箱、电话、地址、原始订单号或结算编号
- GitHub、Cloudflare、TiDB 或应用密码
- PAT、Cookie、Session、私钥、`.env`、`.dev.vars`
- 可让浏览器直接访问私有仓库的凭据或代码

---

## 前端实现

### 目录结构

```text
Ads-Operations-Integrity/
├─ index.html
│  └─ 页面结构、样式、业务模块、筛选与渲染逻辑
├─ assets/
│  ├─ private-cloud-warehouse-v4.js  正式 Loader 4.2.3
│  ├─ private-cloud-query-v1.js      Query Client 1.1.0
│  ├─ private-cloud-warehouse-v3.js  历史兼容桥接，不是正式 Loader
│  ├─ generated/                     外置的历史内联脚本
│  └─ vendor/                        锁定字节的第三方依赖
├─ scripts/
│  ├─ harden-static-site.mjs
│  └─ vendor-lock.json
├─ docs/
│  ├─ CLOUD_V4_CANARY.md
│  └─ CLOUD_V4_PRODUCTION_CUTOVER.md
└─ .github/workflows/
   ├─ ci-main.yml
   └─ pages.yml
```

`index.html` 仍是体量较大的单页应用。重构时必须保持业务模块、全局事件和历史导入兼容性；不要一次性拆分全部模块后才测试。

### 已固定的运行依赖

第三方运行依赖不从公共 CDN 动态加载，而是保存在 `assets/vendor/`，并由 `scripts/vendor-lock.json` 锁定 SHA-256：

| 依赖 | 固定版本 |
|---|---:|
| PapaParse | 5.4.1 |
| SheetJS | 0.20.3 |
| Chart.js | 4.4.1 |
| ExcelJS | 4.4.0 |
| FileSaver | 2.0.5 |
| idb-keyval | 6.2.1 |
| html2pdf | 0.10.1 |

变更依赖时必须同时更新 Vendor 文件、锁文件和 CI 断言；不得恢复运行时 CDN fallback。

---

## 私有云 Loader

### 加载流程

```text
1. 用户选择 ALL 或单店铺范围
2. 点击“加载私有云数据”
3. 输入访问密码
4. Loader 调用 /api/v1/health
5. Worker 返回 Manifest 与 Summary
6. Loader 按 Manifest 串行请求 TiDB Raw CSV
7. 校验响应摘要、ETag、行数、脱敏状态和 TiDB 来源
8. 页面解析并追加本批文件
9. 最终批次统一去重、索引、聚合和渲染
10. Query Client 调用 Status 与 Overview
11. 页面触发 lr:cloud-loaded 等状态事件
```

### 凭据模型

密码只存在于 `assets/private-cloud-warehouse-v4.js` 的闭包内存：

- 不写入 `sessionStorage`
- 不写入 `localStorage`
- 不写入 IndexedDB
- 不暴露 `getPassword`
- Query Client 只能调用受限的 `queryRequest`
- 点击“清除密码”、刷新或关闭标签页后失效

任何新功能都不得把密码复制到全局变量、DOM 属性、事件详情、日志或错误对象。

### Raw 读取稳定性参数

生产 Loader 当前固定：

```text
LOADER_VERSION = 4.2.3
BATCH_SIZE = 6
FETCH_CONCURRENCY = 1
Raw maxAttempts = 8
Raw timeout = 300000 ms
```

设计原因：Cloudflare + TiDB BLOB 在浏览器同时发出多个大 Raw 请求时曾出现平台级失败，响应在进入 Worker 前缺少 CORS 头。32 文件历史审计的串行模式稳定通过，因此浏览器也采用串行读取。

只对 408、425、429、5xx 和网络错误进行有限重试；永久 4xx 立即失败。重试附加唯一查询参数，避免重复命中相同失败链路。

**不得未经完整生产 Chromium 验收提高 `FETCH_CONCURRENCY`。**

### 不可变文件缓存

```text
IndexedDB database: amazon-warehouse-v4-cache
Object store: immutable-files
Key: verified SHA-256
```

只缓存 Worker 已确认内容摘要的安全服务文件，不缓存密码。Manifest 摘要变化会产生新的不可变缓存对象。

---

## TiDB Query Client

`assets/private-cloud-query-v1.js` 是只读浏览器查询层。

```javascript
await window.PrivateCloudQuery.status({ scope: 'ALL' });
await window.PrivateCloudQuery.overview({ scope: 'ALL', grain: 'month' });
await window.PrivateCloudQuery.ads({ scope: 'YTDBNS', limit: 250, offset: 0 });
await window.PrivateCloudQuery.transactions({
  scope: 'ALL',
  from: '2026-01-01',
  to: '2026-06-30'
});
```

公开方法：

```text
status
overview
ads
transactions
allAds
allTransactions
refresh
state
```

约束：

- 只允许 `/api/v1/query/` 路径
- 默认分页 250 行
- 单页最大 500 行
- 日期必须是真实有效的 `YYYY-MM-DD`
- 明细查询必须有界
- 凭据由 Loader 闭包附加，Query Client 不读取或保存密码

Query Client 当前用于状态、概览和受控明细查询。页面仍保留完整 CSV 导入路径，不能假设所有旧模块已完全改成服务端聚合。

---

## 安全模型

### Content Security Policy

生产页面的关键规则：

```text
script-src 'self'
script-src-attr 'none'
object-src 'none'
connect-src 'self' + production Worker origin
```

历史样式仍需要内联样式兼容，但脚本必须同源。CI 会拒绝：

- 远程 JavaScript URL
- 可执行内联脚本
- Vendor 字节漂移
- 持久化私有云密码
- 意外工作流和一次性诊断文件

### 分支保护

Frontend `main` 已保护，要求：

```text
Static site and security invariants
```

不得直接编辑 `main` 或 `gh-pages`。README-only 修改也应通过 Pull Request 和 CI。

---

## CI、Pages 与跨仓库发布顺序

### 前端 CI

`.github/workflows/ci-main.yml` 验证：

- JavaScript 语法
- Vendor SHA-256
- CSP 与同源依赖
- Loader / Query Client 版本和安全不变量
- 内存凭据
- Raw 串行读取和重试参数
- Pages 资产完整性
- 主分支只保留正式工作流

### GitHub Pages

`.github/workflows/pages.yml` 从 `main` 发布。`gh-pages` 是生成结果，不直接修改。

### 跨仓库标准发布顺序

涉及 Worker、TiDB、API、Loader 或 Query Client 时：

```text
1. 从 Warehouse main 创建候选分支
2. 修改迁移 / Worker / tests / workflow
3. Warehouse PR CI 通过
4. 合并 Warehouse 并完成生产部署、Raw、Query 和完整性审计
5. 从 Frontend main 创建候选分支
6. 更新 Loader / Query Client / CSP / UI
7. Frontend PR CI 通过
8. 合并并等待 GitHub Pages 发布
9. 再由 Warehouse Chromium Job 验证真实线上页面
10. 保存脱敏部署和浏览器产物
```

不要先发布前端，再等待尚未部署的 Worker 协议。

---

## 已完成的三批改造

### 第一批：数据完整性与 Manifest 治理

完成内容：

- 修正联合交易报表白名单和测试。
- 清理 Manifest 与真实仓库文件不一致问题。
- 动态化 smoke / browser 文件数和行数断言。
- 全量历史完整性审计。
- 完整性元数据回填。
- 32 文件、215,800 行、18 个脱敏交易文件全部对账。

Warehouse 关键提交：

```text
0cfc90edcaa420d1607efbd1348c0fcac8d7ce5d
```

### 第二批：安全收敛与旧系统退役

Frontend：

- 7 个运行依赖本地化并锁定 SHA-256。
- 11 个内联脚本外置。
- CSP 收敛到同源脚本。
- 密码从 `sessionStorage` 改为 Loader 闭包内存。
- 删除运行时 CDN fallback。
- 删除诊断、修复和一次性工作流。

Warehouse：

- 删除旧 `worker/` V2 代码和 V2 部署流程。
- 删除 Worker `amazon-ad-private-api-v2`。
- 保留 V4 单一生产路径。
- 清理完成的诊断、修复和重复验证工作流。

关键提交：

```text
Frontend: dd6941df2debe7fb6a8d3a76dd6d456dd55f761c
Warehouse: 955de3abd1512eaf3397db1f9dd8bf1525a8d494
```

Frontend `main` 分支保护已启用。Warehouse 因私有仓库分支保护需要 GitHub Pro，而所有者明确不升级 Pro，因此 Warehouse 分支保护被接受为例外。

### 第三批：Phase 8 TiDB 主存储与 Query Plane

完成内容：

- 迁移 `0010`、`0011`。
- TiDB 文件内容主存储与规范化分析事实。
- Status、Overview、Ads、Transactions Query APIs。
- 前端 Query Client。
- Raw 内容长度、SHA-256、ETag 和 TiDB 来源验证。
- Worker 二进制容器兼容。
- 有限重试和精确版本收敛门禁。
- 32 文件历史审计与 Chromium 全量导入。

最后生产代码基线：

```text
Frontend: 5f9a4bd8190e57bcbf993884028cef9c70467c87
Warehouse: b43bab4bc7a953b1555aca56268b17489af17307
Final Run: 31074460434
```

旧 Phase 8 草案已被正式实现取代。不要复活 Frontend PR #4、Warehouse PR #5 或 #14；新工作从当前 `main` 重建。

---

## 已解决的生产问题与设计原因

| 问题 | 根因 | 正式处理 |
|---|---|---|
| Raw 返回 502 | 旧 TiDB Serverless 驱动的 BLOB 表示 | 固定 `@tidbcloud/serverless 0.1.0` |
| Worker 中摘要不一致 | Edge runtime 二进制对象形态不同 | 严格规范化 Uint8Array、ArrayBuffer、Blob、Buffer-compatible 等，再做长度和 SHA-256 验证 |
| 历史审计偶发 503 | Cloudflare/TiDB 瞬时服务故障 | 仅对瞬时状态有限重试，永久 4xx 不重试 |
| 浏览器健康检查被 CORS 拦截 | Loader 添加了未在允许头中的 `Cache-Control` | 删除该请求头，保留 URL retry marker |
| 浏览器大 Raw 并发失败 | 两个 TiDB BLOB 请求同时进入平台 | `FETCH_CONCURRENCY = 1` |
| 混合版本被误接受 | Cloudflare 发布期间节点版本不一致 | smoke 要求精确 Worker 版本 |

历史上 2026-08-05 有多次候选构建、补丁和浏览器 Run 失败，它们是排障过程，不代表当前未解决故障。当前权威状态是最终成功 Run `31074460434`。

---

## 已接受风险与补偿控制

### Warehouse `main` 未保护

所有者明确决定不升级 GitHub Pro，并保持 Warehouse Private，因此 Warehouse `main` 当前未启用 GitHub 分支保护。

这意味着具有写权限的身份理论上可以直接 push、force-push 或删除分支。补偿控制：

- 实际变更仍使用 Pull Request。
- `Validate Warehouse Main` 必须通过。
- 生产部署执行迁移、回填、对账、Raw、Query、审计和 Chromium 门禁。
- 使用不可变 GitHub 归档和 TiDB 完整性摘要交叉验证。
- 保留恢复分支。
- PAT 遵循最小权限并避免多人共享。

不要把这些补偿控制描述为与原生分支保护完全等价。

### Fine-grained PAT 注意事项

曾创建 `warehouse-branch-protection` Token，具有两个仓库的 `Administration: Read and write`。该权限可用于分支管理，但**不能替代生产 Worker 使用的仓库内容 Token**，除非同时具有 Warehouse `Contents: Read and write`。

不要重新生成、替换或扩大生产 Token 权限，除非任务明确需要并完成 Secret 影响分析。

---

## 不可违反的工程约束

- 不公开 Warehouse。
- 不恢复 V2 Worker 或 V2 部署流程。
- 不让浏览器直接访问私有 GitHub Contents API。
- 不把密码写入任何持久化浏览器存储。
- 不恢复公共 CDN JavaScript 或动态 fallback。
- 不绕过 Worker 的认证、CORS、范围和内容完整性校验。
- 不把未脱敏交易文件写入公共仓库、TiDB 服务内容或浏览器缓存。
- 不直接修改 `gh-pages`。
- 不未经生产 Chromium 验收提高 Raw 并发。
- 不用 README 静态数字代替实时 Manifest / Query Status。
- 不在大数组上使用 `Math.max(...largeArray)` 或 `target.push(...largeArray)`；使用循环或分块。
- 不在导入中间批次重复执行完整聚合和全页面渲染。
- 不把完成的一次性诊断工作流提交到 `main`。

---

## 安全修改流程

### 只改前端 UI

```text
1. 从 Frontend main 创建分支
2. 修改 index.html 或同源 assets
3. node --check 相关脚本
4. 运行/等待 Frontend CI
5. PR 合并
6. 等待 Pages
7. 浏览器检查页面和 Console
```

### 修改 Loader / Query Client

除前端步骤外，还必须：

- 更新精确版本号。
- 更新 CI 版本断言。
- 检查 CORS 预检。
- 验证密码仍不可读取和不可持久化。
- 从 Warehouse 运行真实 Chromium 全量导入与 Query 验收。

### 修改跨仓库协议

严格使用“Warehouse 先、Frontend 后”的发布顺序，并为不兼容变更提供兼容窗口或原子切换方案。

---

## 恢复与回滚

当前可达的历史恢复点：

| 用途 | 分支 | Commit |
|---|---|---|
| 云迁移前恢复点 | `recovery-2026-07-24-pre-cloud-migration` | `151115608b2677bcf0d6029532eccf5b1daf0930` |
| V4 切换前回滚点 | `rollback/pre-v4-cutover-2026-08-04` | `151115608b2677bcf0d6029532eccf5b1daf0930` |

两个前端恢复分支目前指向同一旧基线。它们用于灾难恢复参考，不是推荐的日常回滚方式。

日常回滚优先：

1. 回退最近的前端应用提交。
2. 等待 Pages 重新发布。
3. 保留 TiDB、V4 Worker 和不可变归档，不做破坏性删除。
4. 重新执行健康检查、Manifest 和 Chromium 验收。

---

## 当前技术债与推荐改进入口

以下是未来可评估的方向，不代表已经批准执行：

1. **逐步模块化 `index.html`**：按业务模块拆分，但保持全局事件和导入兼容。
2. **服务端聚合替代部分全量 CSV 解析**：优先迁移 Overview、趋势和大明细分页，降低浏览器内存。
3. **Query Client 契约测试**：为所有查询参数、分页、日期和错误结构增加浏览器级测试。
4. **可观测性**：增加不含凭据和业务明细的耗时、重试、缓存命中和失败阶段指标。
5. **导出稳定性**：统一 Excel/PDF 依赖加载状态和导出错误提示。
6. **UI 一致性**：经营大盘、交易财务、广告治理统一组件、间距、图表和空状态。
7. **增量页面更新**：避免每次范围变化重建所有模块。
8. **数据契约文档化**：让前端字段映射与 Warehouse 注册表形成自动校验。

开展其中任何一项前，应先建立明确批次边界、成功标准和回滚点。

---

## 故障排查

### 页面仍显示旧版本

- Windows：`Ctrl + Shift + R`
- macOS：`Command + Shift + R`

或使用：

```text
https://mrtanshiyue.github.io/Ads-Operations-Integrity/?v=YYYYMMDD-01
```

### 私有云加载失败

按顺序检查：

1. Worker `/api/v1/health`。
2. 密码是否正确。
3. GitHub Pages Origin 是否在 CORS 白名单。
4. Manifest / Summary 是否正常。
5. 页面显示的首个失败文件。
6. Raw 是否为 408、425、429、5xx 或浏览器网络错误。
7. Loader 是否仍是 4.2.3、串行读取、8 次有限重试。
8. Console 和页面错误指示器。

不要添加 `Cache-Control` 等未经 Worker CORS 允许的请求头。

### 文件数或行数不一致

比较：

```text
Manifest totalFiles / rowCount
Summary totals
Query Status fileCount / catalogRows
Page importedFiles / importedRows
```

同时确认范围、月份、缓存脚本版本和导入阶段。

### 模块空白或导出失败

检查运行时错误、依赖是否在 `assets/vendor/`、生成脚本是否存在、导入是否 `complete`、Query Client 是否 ready，以及 ExcelJS / SheetJS / FileSaver 是否通过锁校验。

---

## 相关文件与文档

```text
README.md
index.html
assets/private-cloud-warehouse-v4.js
assets/private-cloud-query-v1.js
assets/private-cloud-warehouse-v3.js
scripts/harden-static-site.mjs
scripts/vendor-lock.json
docs/CLOUD_V4_CANARY.md
docs/CLOUD_V4_PRODUCTION_CUTOVER.md
.github/workflows/ci-main.yml
.github/workflows/pages.yml
```

私有仓库 README 是后端、数据、部署、迁移和安全风险的权威交接文档。前端 README 和 Warehouse README 应在每次跨仓库生产变更后同步更新。

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

