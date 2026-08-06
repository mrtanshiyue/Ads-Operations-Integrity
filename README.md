# Ads Operations Integrity

Amazon 广告运营、经营分析与交易财务决策工作台。

本仓库是系统的**公共前端与 GitHub Pages 生产仓库**。页面代码可以公开审查，但业务报表、交易数据、数据库连接和访问凭据均不存放在这里。受治理数据由私有仓库 `Amazon-Data-Warehouse`、TiDB Cloud 和经过认证的 Cloudflare Worker 提供。

- 在线应用：<https://mrtanshiyue.github.io/Ads-Operations-Integrity/>
- 数据 API：`https://amazon-warehouse-cloud-v4.tanshiyuesir.workers.dev`
- 生产分支：`main`
- 当前 Loader：`4.2.3`
- 当前 Query Client：`1.1.0`
- 当前 Worker API：`4.2.2`

> 最近一次完整生产验收：2026-08-05，Warehouse Run `31002270134`。  
> README 中的数据规模是验收快照；实时状态以 Worker Manifest、Query Status 和页面状态为准。

## 生产验收快照

| 项目 | 验收结果 |
|---|---:|
| 当前文件 | 32 |
| 总数据行 | 215,800 |
| 广告事实行 | 160,833 |
| 财务事实行 | 54,967 |
| 脱敏交易文件 | 18 |
| TiDB 内容字节 | 80,236,592 |
| 分析覆盖 | 32 / 32 |
| 失败文件 | 0 |
| 浏览器导入阶段 | `complete` |
| 页面错误 | 0 |
| 控制台错误 | 0 |
| Query Status | 通过 |
| 月度 Overview | 通过 |

## 系统架构

```text
GitHub Pages / Browser
        │
        │ HTTPS + 当前标签页内存凭据
        ▼
Cloudflare Worker V4.2.2
        │
        ├──────────────► TiDB Cloud（主数据与查询平面）
        │                ├─ 当前文件目录与槽位
        │                ├─ 文件内容与完整性元数据
        │                ├─ 广告与财务事实表
        │                ├─ 当前版本分析视图
        │                └─ 访问与导入审计
        │
        └──────────────► Amazon-Data-Warehouse（私有 GitHub 仓库）
                         ├─ 不可变脱敏归档
                         ├─ 服务对象与回滚基线
                         └─ Worker、迁移和验证流程
```

### 仓库职责边界

| 仓库 | 可见性 | 主要职责 |
|---|---|---|
| `Ads-Operations-Integrity` | Public | 页面、加载器、Query Client、同源依赖、CSP、CI 与 Pages 部署 |
| `Amazon-Data-Warehouse` | Private | 报表归档、TiDB、Worker、上传、脱敏、审计、迁移与生产验收 |

公共前端仓库不得包含：

- Amazon 原始订单或交易文件
- 客户姓名、邮箱、电话或地址
- GitHub、Cloudflare、TiDB 或应用密码
- `.env`、Cookie、Session 导出或私钥
- 可直接访问私有仓库的 Token

## 核心能力

### 数据接入

- 本地 CSV、XLSX、XLS 文件导入
- 认证后的私有云全量加载
- Manifest 驱动的文件发现与范围隔离
- 广告、交易和业务报表自动识别
- 表头规范化、日期标准化与重复控制
- 多月份、多店铺数据合并
- 文件数、行数、月份和脱敏状态显示

### 广告运营

- Portfolio、Campaign、Ad Group、Targeting、Search Term 多级分析
- ACOS、ROAS、CPC、CTR、CVR、订单和广告销售额
- 关键词、搜索词、词根与长尾词分析
- 成熟归因与 Pending 归因拆分
- 竞价、否定、结构完整性和执行优先级建议
- 广告销售与业务销售联动

### 经营与财务

- 经营大盘与经营联动趋势
- 广告销售、业务销售与交易销售对账
- 退款、销售费用、FBA 费用及其他交易费用
- 交易财务报表和多维占比
- SKU 月度盈利、成本和利润调整
- 店铺范围与日期区间联动
- 报表和明细导出

## 私有云加载机制

```text
1. 选择 ALL 或单店铺范围
2. 点击“加载私有云数据”
3. 输入访问密码
4. Loader 验证 Worker 健康状态
5. Worker 返回 Manifest 与 Summary
6. Loader 按 Manifest 串行请求 TiDB Raw CSV
7. 每个文件完成内容摘要、ETag 和完整性头校验
8. 页面解析文件并追加到内存数据集
9. 最终批次执行去重、索引、聚合和模块渲染
10. Query Client 请求 TiDB Status 与 Overview
```

### 凭据处理

访问密码只存在于 `assets/private-cloud-warehouse-v4.js` 的 JavaScript 闭包内存中：

- 不写入 `sessionStorage`
- 不写入 `localStorage`
- 不写入 IndexedDB
- 不通过 Query Client 暴露可读取的密码
- 点击“清除密码”或关闭/刷新标签页后需要重新输入

Query Client 只能通过 Loader 提供的受限桥接调用 `/api/v1/query/` 路径。

### Raw 读取与重试

当前生产 Loader 使用：

- `FETCH_CONCURRENCY = 1`，串行读取 TiDB BLOB，避免浏览器并发请求触发平台级瞬时故障
- 单文件最多 8 次有限重试
- 408、425、429 和 5xx 的指数退避
- 重试请求附加唯一查询标识，避免重复命中相同失败链路
- 单文件请求超时 5 分钟
- 不可变文件使用 SHA-256 与 ETag 作为缓存键

串行模式优先保证生产稳定性，不应未经完整 Chromium 验收而提高并发。

## TiDB Query Client

`assets/private-cloud-query-v1.js` 提供只读查询接口：

```javascript
await window.PrivateCloudQuery.status({ scope: 'ALL' });
await window.PrivateCloudQuery.overview({ scope: 'ALL', grain: 'month' });
await window.PrivateCloudQuery.ads({ scope: 'YTDBNS', limit: 250, offset: 0 });
await window.PrivateCloudQuery.transactions({ scope: 'ALL', from: '2026-01-01', to: '2026-06-30' });
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
- `from` 不得晚于 `to`
- 凭据由 Loader 在内存中附加，Query Client 不保存密码

## 缓存模型

经过内容验证的不可变 CSV 可以缓存在浏览器 IndexedDB：

```text
Database: amazon-warehouse-v4-cache
Store: immutable-files
Key: SHA-256 digest
```

缓存中只保存已经通过 Worker 内容摘要验证的脱敏或非敏感服务文件，不保存访问密码。Manifest 中的内容摘要变化时会自动形成新的缓存对象。

## 目录结构

```text
Ads-Operations-Integrity/
├─ index.html
│  └─ 页面结构、样式、业务模块、筛选与渲染逻辑
├─ assets/
│  ├─ private-cloud-warehouse-v4.js  正式私有云 Loader
│  ├─ private-cloud-query-v1.js      TiDB Query Client
│  ├─ private-cloud-warehouse-v3.js  历史兼容跳转/桥接文件
│  ├─ generated/                     从历史内联脚本外置的同源脚本
│  └─ vendor/                        锁定字节的第三方运行依赖
├─ scripts/
│  ├─ harden-static-site.mjs         静态站点安全与外置处理
│  └─ vendor-lock.json               Vendor SHA-256 锁
├─ docs/
│  ├─ CLOUD_V4_CANARY.md
│  └─ CLOUD_V4_PRODUCTION_CUTOVER.md
└─ .github/workflows/
   ├─ ci-main.yml                    前端与安全不变量校验
   └─ pages.yml                      GitHub Pages 构建与发布
```

`private-cloud-warehouse-v3.js` 不是当前正式 Loader。生产入口是 `private-cloud-warehouse-v4.js`，V3 文件仅为历史兼容保留。

## 前端安全模型

### Content Security Policy

生产页面采用同源脚本策略：

- `script-src 'self'`
- `script-src-attr 'none'`
- `object-src 'none'`
- `connect-src` 仅允许同源和正式 Worker Origin
- 不允许运行时从公共 CDN 注入 JavaScript

第三方库已固定在 `assets/vendor/`，并由 `scripts/vendor-lock.json` 记录 SHA-256。CI 会拒绝字节变化、远程脚本、可执行内联脚本和持久化密码模式。

### 分支保护

`main` 已启用保护并要求状态检查：

```text
Static site and security invariants
```

生产修改应通过 Pull Request 合并，不直接编辑 `main` 或 `gh-pages`。

## 本地运行

本项目是无框架静态单页应用，不需要 npm 构建前端。

```bash
git clone https://github.com/mrtanshiyue/Ads-Operations-Integrity.git
cd Ads-Operations-Integrity
python3 -m http.server 8000
```

打开：

```text
http://localhost:8000
```

本地使用私有云前必须确认 Worker CORS 允许：

```text
http://localhost:8000
http://127.0.0.1:8000
```

## CI 与部署

### 前端 CI

`.github/workflows/ci-main.yml` 负责：

- JavaScript 语法检查
- Vendor SHA-256 校验
- CSP 和同源依赖检查
- Loader、Query Client 和内存凭据不变量
- Raw 串行读取与重试参数检查
- 临时诊断文件与意外工作流检查
- Pages 产物完整性检查

### GitHub Pages

`.github/workflows/pages.yml` 负责：

- 从 `main` 构建静态站点
- 复制正式应用资源
- 运行发布前校验
- 发布到 GitHub Pages

规则：

- `main` 是生产源码
- `gh-pages` 是自动生成的发布结果
- 不直接编辑 `gh-pages`
- README 变更不会改变应用运行逻辑，但仍需通过 CI
- 前端代码合并后应等待 Pages 完成，再运行 Warehouse Chromium 验收

## 发布验收清单

涉及 Loader、Query Client、CSP、依赖或数据协议的变更至少验证：

1. 前端 CI 全部通过
2. GitHub Pages 发布成功
3. Loader、Query Client、Worker 版本完全匹配
4. Worker `/api/v1/health` 正常
5. Manifest、Summary 文件数与行数一致
6. 32 个当前文件或实时 Manifest 全部导入
7. Raw 来源为 `tidb`
8. Raw 内容已验证且 ETag 与摘要一致
9. `importStage = complete`
10. 内存凭据存在但不可读取
11. Query Status `analyticsReady = true`
12. Overview 返回有效序列和汇总
13. 页面错误为 0
14. 控制台错误为 0
15. Warehouse 历史完整性审计通过

## 故障排查

### 页面仍是旧版本

强制刷新：

- Windows：`Ctrl + Shift + R`
- macOS：`Command + Shift + R`

也可以增加缓存破坏参数：

```text
https://mrtanshiyue.github.io/Ads-Operations-Integrity/?v=YYYYMMDD-01
```

### 私有云加载失败

依次检查：

1. 正式 Worker `/api/v1/health`
2. 输入密码是否正确
3. 页面 Origin 是否在 Worker CORS 白名单
4. Manifest 是否返回预期范围
5. 页面是否显示具体失败文件
6. Raw 请求是否发生 408、429、5xx 或网络级失败
7. 是否仍有 8 次重试和串行读取
8. 浏览器 Console 与页面错误指示器

不要为绕过故障而恢复高并发或添加未经允许的自定义请求头；此前 `Cache-Control` 请求头曾触发 CORS 预检失败。

### 文件数或行数不一致

检查：

- 当前选择的店铺范围
- Manifest 中的文件和月份
- 是否在导入中途切换范围
- 是否存在失败批次
- 是否加载旧 Loader
- Query Status 的 `fileCount`、`catalogRows` 与 Manifest 是否一致

### 模块空白

检查：

- 页面右下角运行时错误
- Console 中的 `ReferenceError` 或资源加载错误
- 当前导入阶段
- Query Client 是否触发 `lr:query-client-ready`
- `lr:cloud-loaded` 是否只完成一次
- 最新 Chromium 验收产物

## 回滚

生产切换前基线：

```text
rollback/pre-v4-cutover-2026-08-04
```

回滚原则：

- 优先回退前端提交并重新发布 Pages
- 不删除 TiDB、Worker 或私有归档
- 保留当前 Manifest 和审计信息用于定位
- 回滚后重新验证 Loader、查询和交易财务模块
- 禁止直接删除缓存或数据对象作为常规回滚方式

## 维护规则

- `main` 始终代表线上源码
- 复杂变更使用独立分支和 Pull Request
- Loader、Worker、Query Client 版本必须协调发布
- 不把 README 快照当成实时容量配置
- 不在大数组上使用展开语法调用函数
- 不允许页面直接访问私有 GitHub Contents API
- 不允许 Query Client 接收任意完整 URL
- 不新增 `localStorage`、`sessionStorage` 密码兼容逻辑
- 修改 Raw 请求头、CORS 或并发时必须运行真实 Chromium
- 新依赖必须同源托管、固定版本并更新 Vendor SHA-256 锁

## 相关项目

- 私有后端仓库：`mrtanshiyue/Amazon-Data-Warehouse`
- 在线应用：<https://mrtanshiyue.github.io/Ads-Operations-Integrity/>
- 正式 Worker：`https://amazon-warehouse-cloud-v4.tanshiyuesir.workers.dev`

---

本项目用于内部 Amazon 广告运营与经营决策。公共仓库只保存应用代码和公开文档；业务数据、交易归档和生产凭据由私有数据仓库及受控运行环境管理。
