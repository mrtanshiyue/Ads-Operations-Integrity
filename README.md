# Ads Operations Integrity

亚马逊广告运营、经营分析与执行决策工作台。项目采用单页静态应用架构，通过 GitHub Pages 发布，并通过受保护的 Cloudflare Worker 连接私密数据仓库。

> 当前页面版本：`V61.5.4.7`  
> 在线地址：<https://mrtanshiyue.github.io/Ads-Operations-Integrity/>

## 项目定位

本项目用于将亚马逊广告报表、联合交易报表和业务报表统一导入同一个分析工作区，完成数据治理、经营联动、广告决策、归因成熟度判断和交易财务分析。

主要目标：

- 统一广告、交易和经营数据口径
- 支持多月份、大批量报表加载
- 按店铺隔离分析范围
- 将数据导入、治理、分析和执行建议形成闭环
- 保持前端公开代码与私密业务数据严格分离

## 核心能力

### 数据导入与治理

- 本地 CSV、XLSX、XLS 文件导入
- 私有云批量加载
- 广告报表、联合交易报表、业务报表识别
- 字段归一化、日期标准化、数据去重和异常隔离
- 文件级导入状态与错误中心
- 大数据量分批下载和延迟汇总

### 广告运营分析

- 广告组合、Campaign、Ad Group、Targeting、Search Term 多层筛选
- 成熟归因与归因中数据拆分
- ACOS、ROAS、CPC、CTR、CVR、订单和销售额分析
- 关键词、搜索词、词根和长尾机会分析
- 出价治理、否定词治理和执行建议
- 广告结构索引与执行门禁

### 经营与财务分析

- 经营大盘与联动趋势
- 广告销售和交易销售交叉验证
- 退款、费用、结算和经营损益分析
- 交易财务报表
- 商品成本库接入
- 真实经营费用和利润口径补充

### 多店铺范围

界面支持以下分析范围：

| 界面名称 | 内部代码 | 说明 |
|---|---|---|
| ALL | `ALL` | 全部店铺 |
| YT | `YTDBNS` | 界面简写为 YT，内部代码保持不变 |
| YY | `YY` | YY 店铺 |
| JJ | `JJ` | JJ 店铺 |

`YTDBNS` 仅作为内部数据范围代码使用。不要直接修改仓库目录、Worker 参数或数据清单中的内部代码。

## 系统架构

```text
浏览器 / GitHub Pages
        │
        │ HTTPS + X-Dashboard-Password
        ▼
Cloudflare Worker
        │
        │ GitHub API + 私密访问令牌
        ▼
Amazon-Data-Warehouse（私密仓库）
        │
        ├─ raw/YTDBNS/
        ├─ raw/YY/
        └─ raw/JJ/
```

### 仓库边界

| 仓库 | 可见性 | 用途 |
|---|---|---|
| `Ads-Operations-Integrity` | Public | 前端应用、部署配置和维护脚本 |
| `Amazon-Data-Warehouse` | Private | 亚马逊广告、交易和业务原始报表 |

业务报表、订单数据、访问密码、GitHub Token 和 Cloudflare Token 不得提交到本仓库。

## 私有云加载流程

当前私有云接口：

```text
https://amazon-ad-private-api-v2.tanshiyuesir.workers.dev
```

加载流程：

1. 网页执行 Worker 健康检查
2. 按当前店铺请求动态文件清单
3. 每 4 个文件作为一个下载批次
4. 普通广告报表由 Worker 流式透传
5. 联合交易报表在 Worker 中删除敏感地址字段，并对订单标识进行不可逆伪匿名化
6. 前面批次只解析和追加数据
7. 最后一个批次统一执行去重、索引、聚合、筛选和渲染
8. 完成后更新经营分析和交易财务报表

网页登录密码只保存在当前标签页的 `sessionStorage` 中，关闭标签页后不会长期保留。

## 数据文件规范

私密仓库中的文件路径：

```text
raw/<STORE_CODE>/<YYYY-MM>-<REPORT_TYPE>.csv
```

常用文件名：

```text
2026-06-advertising-report.csv
2026-06-combined-report.csv
2026-06-business-report.csv
2026-06-ads-search-term.csv
2026-06-ads-targeting.csv
2026-06-ads-campaign.csv
2026-06-ads-advertised-product.csv
2026-06-ads-placement.csv
```

必须遵守：

- 月份使用 `YYYY-MM`
- 文件扩展名使用 `.csv` 或 `.tsv`
- 不要写成 `combined-reportcsv.csv`
- 文件名不得包含临时后缀、重复扩展名或未注册报表类型
- 店铺目录必须使用内部代码，例如 `raw/YTDBNS/`

## 在线使用

打开：

<https://mrtanshiyue.github.io/Ads-Operations-Integrity/>

基本步骤：

1. 选择店铺范围
2. 点击“加载私有云数据”
3. 输入私密仓库网页登录密码
4. 等待所有批次完成
5. 使用左侧日期和业务筛选条件
6. 查看经营、广告和交易财务模块

大量报表加载期间不要刷新页面、切换店铺或让电脑进入休眠。

## 本地运行

项目是静态单页应用，不需要构建框架。

```bash
git clone https://github.com/mrtanshiyue/Ads-Operations-Integrity.git
cd Ads-Operations-Integrity
python3 -m http.server 8000
```

打开：

```text
http://localhost:8000
```

Worker 的允许来源中需包含本地地址，才能在本地测试私有云连接。

## GitHub Pages 部署

主部署工作流：

```text
.github/workflows/pages.yml
```

部署规则：

- `main` 是维护源分支
- 修改 `index.html` 会触发 GitHub Pages 部署
- 发布前自动提取并检查所有内联 JavaScript 语法
- `gh-pages` 是自动生成的发布分支
- 不要直接手工修改 `gh-pages`

`README.md` 更新不会改变线上应用代码，因此不需要单独重新部署页面。

## 关键文件

```text
index.html
├─ 页面结构
├─ 数据导入与归一化
├─ 广告与经营分析引擎
├─ 交易财务报表
└─ 前端状态与渲染逻辑

assets/private-cloud-warehouse-v3.js
└─ 私有云连接、批量下载、重试和店铺切换逻辑

.github/workflows/pages.yml
└─ GitHub Pages 校验和发布

scripts/
└─ 定向修复、诊断和维护脚本
```

## 大数据量处理原则

当前实现已针对多月份、大文件和高行数报表进行处理：

- 普通广告 CSV 通过 Worker 流式传输
- 单文件失败最多自动重试 4 次
- 单次文件请求超时为 4 分钟
- 下载完成后立即释放批次原始文件内存
- 中间批次不重复执行全量分析
- 最大值、最小值和数组合并使用迭代方式，禁止对超大数组使用参数展开

维护代码时避免以下写法：

```javascript
Math.max(...largeArray)
target.push(...largeArray)
```

应使用循环、分块处理或安全辅助函数。

## 故障排查

### 页面仍显示旧版本

关闭旧标签页后重新打开，或临时使用缓存破除参数：

```text
https://mrtanshiyue.github.io/Ads-Operations-Integrity/?v=YYYYMMDD-01
```

也可以执行强制刷新：

- Windows：`Ctrl + Shift + R`
- macOS：`Command + Shift + R`

### `Failed to fetch`

依次检查：

1. Cloudflare Worker 是否部署成功
2. Worker 健康检查是否可访问
3. `WAREHOUSE_GITHUB_TOKEN` 是否有效
4. 当前网页来源是否在 Worker 允许列表
5. 私密仓库文件名是否符合规范
6. GitHub Actions 是否存在校验或部署失败

### `Maximum call stack size exceeded`

通常表示某处对大数组使用了展开参数，或在导入期间重复执行全量计算。错误状态区会显示具体阶段和调用栈，应根据阶段定位：

```text
batch-appended
deduplicate
enrich-and-index
apply-filters
render-transactions
```

### 模块空白或 `... is not defined`

查看右下角“页面运行”错误提示。此类问题通常是辅助函数作用域或运行时依赖错误，不能只依赖 `node --check`，还需要检查实际调用链和作用域。

## 安全要求

- 不在前端代码中保存任何 GitHub Token 或 Cloudflare Token
- 不在公开仓库中保存原始订单数据
- 不在 README、Issue、Commit 或日志中粘贴密码
- 联合交易报表必须通过 Worker 脱敏后再返回浏览器
- Worker 密钥使用 GitHub Actions Secrets 和 Cloudflare Secrets 管理
- 修改 CORS、鉴权或数据范围逻辑时必须进行回归测试

## 维护约定

提交前至少完成：

```text
1. JavaScript 语法检查
2. 私有云加载回归测试
3. 大数组展开调用检查
4. 店铺范围与内部代码检查
5. 交易财务报表运行时检查
6. main 与 gh-pages 发布版本确认
```

提交信息应明确描述修改对象，例如：

```text
Fix transaction finance report runtime helper scope
Stream large advertising reports through Worker
Defer full analysis until final cloud import batch
```

---

本项目面向内部亚马逊运营与经营分析工作流。公开仓库只包含应用代码，业务数据由独立私密仓库管理。
