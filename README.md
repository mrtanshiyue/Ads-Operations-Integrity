# Ads Operations Integrity

面向 Amazon 广告运营、经营分析和财务决策的浏览器端工作台。

应用以静态单页形式部署到 GitHub Pages。受保护的业务数据保存在独立的私有仓库中，通过经过认证的 Cloudflare Worker V4 加载，公共前端仓库不保存订单明细、交易文件或任何访问凭据。

> **生产状态：已于 2026-08-04 正式切换至 Cloud Warehouse V4。**  
> 在线应用：<https://mrtanshiyue.github.io/Ads-Operations-Integrity/>  
> 数据 API：`https://amazon-warehouse-cloud-v4.tanshiyuesir.workers.dev`

## 生产验证快照

正式切换后，真实 Chromium 已在 GitHub Pages 线上环境完成全量加载验证：

| 项目 | 结果 |
|---|---:|
| Manifest 文件数 | 32 |
| 加载数据行数 | 215,800 |
| 脱敏交易报表 | 18 |
| 非敏感报表 | 14 |
| 月份范围 | 2025-01 至 2026-06 |
| 导入阶段 | `complete` |
| UI 状态 | `good` |
| 页面错误 | 0 |
| 控制台错误 | 0 |

该表是 2026-08-04 上线时的验收快照。后续数据增加后，以实时 Manifest 和页面状态为准。

## 核心能力

### 数据接入与治理

- 本地 CSV、XLSX 和 XLS 文件导入
- 认证后的私有云数据加载
- 广告、交易和业务报表自动识别
- 表头规范化与日期标准化
- 重复检测、异常行隔离和导入诊断
- 大文件分批下载、重试和延迟汇总
- 多月份数据合并与店铺范围隔离
- Manifest、文件行数和脱敏状态显示

### 广告运营分析

- Portfolio、Campaign、Ad Group、Targeting 和 Search Term 多级筛选
- 成熟归因与 Pending 归因拆分
- ACOS、ROAS、CPC、CTR、CVR、订单和销售额分析
- 关键词、搜索词、词根和长尾词分析
- 广告结构完整性和投放治理
- 竞价调整、否定建议和执行优先级
- 广告销售与业务销售联动

### 经营与财务分析

- 经营大盘与经营联动趋势
- 广告销售、交易销售和业务销售对账
- 退款、销售费用、FBA 费用和其他交易费用分析
- 交易财务报表
- SKU 月度盈利与成本分析
- 实际运营费用和利润调整
- 日期区间和店铺范围联动
- 总览与明细导出入口

## 系统架构

```text
GitHub Pages / Browser
        │
        │ HTTPS + 当前标签页认证信息
        ▼
Cloudflare Worker V4
        │
        ├──────────────► TiDB Cloud
        │                ├─ 文件目录
        │                ├─ 当前报表槽位
        │                ├─ 导入任务
        │                ├─ 访问审计
        │                └─ 分析与质量模型
        │
        └──────────────► 私有 GitHub 数据仓库
                         ├─ source-sanitized
                         └─ serving
```

### 仓库边界

| 仓库 | 可见性 | 职责 |
|---|---|---|
| `Ads-Operations-Integrity` | Public | 前端应用、GitHub Pages、加载器、校验和维护脚本 |
| `Amazon-Data-Warehouse` | Private | 报表对象、Worker V4、TiDB 迁移、脱敏、审计和历史验证 |

公共仓库不得包含业务报表、客户信息、GitHub Token、Cloudflare Token、数据库连接或访问密码。

## 私有云加载流程

```text
1. 用户选择 ALL 或单店铺范围
2. 点击“加载私有云数据”
3. 输入访问密码
4. 浏览器检查 Worker /health
5. Worker 返回当前范围 Manifest
6. 浏览器按批次请求 Raw CSV
7. 各文件解析并追加到内存数据集
8. 最终批次执行去重、索引、聚合和筛选
9. 广告、经营和交易财务模块统一渲染
10. 页面显示文件数、行数、月份范围和脱敏数量
```

访问密码只保存在当前浏览器标签页的 `sessionStorage` 中。关闭标签页或清除会话后需要重新输入。

## 数据隐私

联合交易报表在进入 V4 存储和浏览器前已经完成脱敏：

- 删除姓名、邮箱和电话号码
- 删除城市、州、省、邮编和地址字段
- 删除收货与配送地址字段
- 订单号使用稳定、不可逆的假名
- 结算编号使用稳定、不可逆的假名
- 保留销售、退款、费用和结算分析所需字段

前端只接收脱敏后的交易 CSV。不得在浏览器代码中加入绕过 Worker、直接读取私有仓库或请求原始交易文件的逻辑。

## 在线使用

打开：

<https://mrtanshiyue.github.io/Ads-Operations-Integrity/>

推荐流程：

1. 选择分析范围
2. 点击 **加载私有云数据**
3. 输入访问密码
4. 等待状态显示导入完成
5. 选择日期范围
6. 检查经营大盘和广告分析
7. 打开交易财务报表核对销售、退款和费用
8. 按需要使用导出入口

大批量导入期间不要刷新页面、关闭标签页或让电脑进入休眠。

## 关键文件

```text
index.html
├─ 页面结构和样式
├─ 报表解析与字段规范化
├─ 广告分析与经营分析引擎
├─ 交易财务模块
└─ 状态、筛选和渲染逻辑

assets/private-cloud-warehouse-v3.js
└─ 私有云认证、Manifest、批次下载、重试和导入桥接

.github/workflows/pages.yml
└─ GitHub Pages 校验和部署

scripts/
└─ 诊断、修复和回归验证工具

docs/
├─ CLOUD_V4_CANARY.md
└─ CLOUD_V4_PRODUCTION_CUTOVER.md
```

`assets/private-cloud-warehouse-v3.js` 保留了历史文件名，但生产内容已经连接 Cloud Warehouse V4。重命名该文件会影响 `index.html` 和部署流程，必须作为独立兼容性变更处理。

## 本地开发

本项目是静态单页应用，不需要前端构建框架。

```bash
git clone https://github.com/mrtanshiyue/Ads-Operations-Integrity.git
cd Ads-Operations-Integrity
python3 -m http.server 8000
```

打开：

```text
http://localhost:8000
```

本地测试私有云功能前，必须确认 Worker CORS 允许本地 Origin。

## GitHub Pages 部署

生产分支：

```text
main
```

主要工作流：

```text
.github/workflows/pages.yml
```

部署原则：

- `main` 是生产源码
- `index.html` 或相关生产资源变更会触发页面发布
- 发布前执行内联 JavaScript 提取和语法检查
- `gh-pages` 是自动生成的部署分支
- 不直接编辑 `gh-pages`
- README 修改不应改变应用运行逻辑

生产变更完成后，应等待 Pages 发布完成，再对正式 URL 做浏览器验证。

## 发布前检查

前端生产变更至少检查：

```text
1. index.html 与外部加载器语法
2. V4 Worker Origin 一致性
3. Worker health 和 Manifest
4. 全量文件数、行数和脱敏数量
5. 私有云事件只完成一次
6. import stage 为 complete
7. 经营大盘正常渲染
8. 广告分析正常渲染
9. 交易财务弹窗正常打开
10. 日期筛选可应用并恢复
11. 导出入口可用
12. 页面和控制台错误为 0
13. 宽表处于横向滚动容器中
14. GitHub Pages 正式 URL 验证
15. 回滚分支可达
```

## 大数据量设计

当前实现包含以下保护：

- Manifest 驱动的按需加载
- 文件分批下载
- 请求失败重试
- 长请求超时控制
- 中间批次只追加，不重复执行完整分析
- 最终批次统一去重、索引和渲染
- 导入后释放原始批次引用
- 避免将大型数组展开为函数参数
- 非敏感 CSV 保持原始字节
- 交易报表使用脱敏后的规范化文件

禁止在大数组上使用：

```javascript
Math.max(...largeArray);
target.push(...largeArray);
```

应使用循环、分块或安全辅助函数。

## 故障排查

### 页面仍显示旧版本

关闭旧标签页并重新打开，或使用缓存破坏参数：

```text
https://mrtanshiyue.github.io/Ads-Operations-Integrity/?v=YYYYMMDD-01
```

强制刷新：

- Windows：`Ctrl + Shift + R`
- macOS：`Command + Shift + R`

### 私有云加载失败

依次检查：

1. Worker `/api/v1/health` 是否正常
2. 输入的访问密码是否正确
3. Worker CORS 是否允许当前 GitHub Pages Origin
4. Manifest 是否返回预期范围
5. 文件槽位是否为 `ready`
6. TiDB 是否存在 `processing` 任务
7. Raw CSV 请求是否成功
8. 浏览器控制台和页面错误指示器

### 文件数或行数不一致

检查：

- 当前选择的店铺范围
- Manifest 的文件数量和月份列表
- 页面是否在加载过程中切换过范围
- 是否存在失败或重试中的批次
- 最终汇总是否使用 Manifest 的文件行数
- 浏览器是否加载了缓存中的旧脚本

### 模块空白或出现 `... is not defined`

语法检查只能发现解析错误，不能发现所有浏览器运行时作用域问题。应查看：

- 页面右下角运行时错误提示
- 浏览器 Console
- 当前导入阶段
- 模块依赖的全局函数是否已加载
- Chromium 回归测试结果

### 宽表超出视口

部分广告和交易表格设计为容器内横向滚动。判断故障时应区分：

- 正常：表格宽于视口，但父容器具有 `overflow-x:auto/scroll`
- 异常：整个页面产生全局横向滚动，或表格没有受保护容器

## 安全要求

- 不在前端代码中保存任何 Token 或数据库连接
- 不在公共仓库提交原始订单或交易报表
- 不在 README、Issue、PR、提交信息或日志中粘贴密码
- 不将访问密码写入 `localStorage`
- 交易报表必须先在后端脱敏
- 不公开内部店铺标识和账户信息
- 不允许浏览器直接访问私有 GitHub Contents API
- CORS、认证和范围逻辑变更必须做全量回归

## 回滚

生产切换前的 V3 基线保存在：

```text
rollback/pre-v4-cutover-2026-08-04
```

前端回滚步骤：

1. 将 `main` 恢复到回滚分支或回退生产切换合并提交
2. 等待 GitHub Pages 重新发布
3. 确认前端重新使用上一版数据源
4. 验证页面加载、筛选和财务模块
5. 保留 TiDB 和 V4 仓库对象，不执行破坏性删除

## 维护原则

- `main` 代表线上生产版本
- 复杂改动先在独立分支完成
- 数据层、Worker 和前端协议变更必须协调发布
- 不依赖 README 中的静态数据规模判断实时状态
- 每次正式发布都保留可达的回滚基线
- 发布结果应记录 Merge SHA、线上 URL 和浏览器验证结果
- 修复导入统计时必须区分“本批新增”与“累计总数”
- 修改私有云加载器时同步检查外部脚本和 `index.html` 内嵌副本

## 相关文档

```text
docs/CLOUD_V4_CANARY.md
docs/CLOUD_V4_PRODUCTION_CUTOVER.md
.github/workflows/pages.yml
assets/private-cloud-warehouse-v3.js
```

---

本项目用于内部 Amazon 广告运营与经营决策。公共仓库仅保存应用代码；受保护的运营数据、交易文件和凭据全部由私有数据仓库和后端服务管理。
