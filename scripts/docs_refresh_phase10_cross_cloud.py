from pathlib import Path
import re

p = Path('README.md')
s = p.read_text(encoding='utf-8')

s = s.replace('- Query-native Module Adapter：`1.1.0`', '- Query-native Module Adapter：`1.2.0`')
s = s.replace('- Ads Trend Controller：`1.0.0`', '- Ads Trend Controller：`1.1.0`')
if '- Bid Governance Parity Audit：`1.0.3`' not in s:
    s = s.replace('- Ads Trend Host Guard：`1.0.0`', '- Ads Trend Host Guard：`1.0.0`\n- Bid Governance Parity Audit：`1.0.3`')

section = '''# 2. 当前权威生产基线

最后核验日期：`2026-08-07`。

## Frontend

| 项目 | 当前已验证状态 |
|---|---|
| 当前生产行为提交 | `df81e84f4c9a1683fe021ab8477fabe3b23c5605` |
| 对应 PR | `#34 Phase 8: canonicalize parity identity and Bid comparability` |
| main CI | Run `31170611396` ✅ |
| GitHub Pages | Run `31170611374` ✅ |
| gh-pages `source_sha` | `df81e84f4c9a1683fe021ab8477fabe3b23c5605` |
| Loader | `4.3.0` |
| Query Client | `1.3.0` |
| Query-native Adapter | `1.2.0` |
| Ads Trend Controller | `1.1.0` |
| Bid Governance Parity Audit | `1.0.3` |
| `main` 保护 | **已启用**，要求 `Static site and security invariants` |

Phase 4 第一批交易财务 Query-native 的生产提交仍为：

```text
dd02299794197e8530cb1036f891cc665dec8c0b
```

Phase 4 第二批广告趋势 Query-native 的生产提交仍为：

```text
2d4bb9ca8d7c3bad76933749025ba51804f90178
```

Phase 8 在此基础上增加真实 Legacy / Query Parity 诊断，并在 `df81e84f...` 完成 canonical identity 与 Bid comparability 语义修正。

## Warehouse / Worker

| 项目 | 当前已验证状态 |
|---|---|
| Warehouse 可见性 | **Private，必须保持 Private** |
| 当前 Warehouse `main` | docs-only 基线已前进；新对话必须实时读取 |
| 最后改变 Warehouse/Worker 生产行为的代码基线 | `7364babfd3f108f668da95b74eab4d514e29e3a8` — Phase 10 / PR #61 |
| Phase 9 Source-Provenance 基线 | `ec8f73d7fd13c50abe7ef64ec1032980b66a7eda` — PR #60 |
| 最后一次完整 Warehouse 生产验收 | Run `31177671671` ✅ |
| Worker | `amazon-warehouse-cloud-v4` |
| Worker API | `4.2.2` |
| Worker entry | `cloud-worker/src/query_first_plane.js` |
| 主存储 / Query Plane | TiDB Cloud / `tidb-primary` |
| 私有归档 / recovery | Private GitHub Warehouse |
| 已应用 migration | through `0015_refresh_ads_current_view_purchased_identity.sql`；生产验收后 `0 pending` |
| current 文件 / facts | `32` / `215800` |
| facts 分布 | advertising `160833` / finance `54967` |

Warehouse README-only 提交不会重新部署 Worker；判断后端真实行为必须以最后成功生产 Run 对应的行为 SHA、Worker smoke、TiDB reconciliation 和历史完整性审计为准。

## Phase 8–10 跨云生产验收

Phase 8 生产月份 `2026-06` 的真实 Chromium 双源结果：

```text
legacyRows=8753
queryRows=8753
metricParityPass=true
identityPass=true
groupOverlap=1.000000
legacyOnly=0
queryOnly=0
bidComparable=false
bidParityPass=false
bidGovernanceReady=false
migrationCandidate=false
executionAuthorized=false
```

当前迁移 blocker 仍明确为：

```text
adProductReady
advertisedProductIdentityReady
attributionMaturityReady
legacyBidComparable
```

这些 blocker 不能通过前端默认值或推断清除。尤其禁止把缺失 Ad Product 当成 `SP`、伪造 advertised ASIN/SKU 或 attribution window、以及给 Legacy Search-Term parity 行补假 Bid。

### Phase 9 Warehouse Source-Provenance

Warehouse 已在生产完成 source-provenance alignment：future richer Amazon advertising source 的真实 `adProduct` / attribution evidence 会沿 normalizer → facts → Query governance 保存；空值、partial、mixed、unknown 继续 fail-closed。现有历史源字段缺失时保持 `source-unavailable`，不会被 legacy 默认值误证明。

### Phase 10 Purchased Product Attribution

Warehouse 已在生产以 additive migration 扩展：

- `fact_ads_performance.purchased_sku / purchased_asin` nullable；
- `/api/v1/query/ads` 可返回并筛选 purchased SKU / ASIN；
- current view 仍只由 `report_slots.current_file_id` 决定；
- governance contract 为 `ads-governance-source-contract-v1.3`，value evidence 为 `ads-governance-value-coverage-v2`；
- purchased identity 允许合法稀疏的非购买行，但源列全空不能证明 ready；
- 新增 `purchasedProductIdentityReady` / `productAttributionReady`，不改变现有 Bid / Campaign execution readiness。

Phase 10 生产 migration 后旧 `32` 个 current 文件全部 `already-ready` 跳过，facts 仍为 `215800`；V4、Phase 7、Phase 8 Chromium 全部成功，Phase 8 上述四个 blocker 原样保留。

### 下一批原则

Frontend 暂不因为 Phase 9/10 自动迁移 Advanced Bid Governance / Campaign Studio。下一批仍需 Warehouse-first：真实 richer source 只在有源证据时提升 readiness；`legacyBidComparable` 需要独立 Targeting / Bid Control Parity。只有 source readiness + Bid comparability + production parity 全部通过后，Frontend 才允许进入下一次 Query-native 迁移。
'''

s, n = re.subn(r'# 2\. 当前权威生产基线\n.*?(?=\n---\n\n# 3\.)', section.rstrip(), s, count=1, flags=re.S)
assert n == 1, f'baseline section replacement count={n}'

required = [
    'df81e84f4c9a1683fe021ab8477fabe3b23c5605',
    '31170611396', '31170611374',
    '7364babfd3f108f668da95b74eab4d514e29e3a8',
    '31177671671',
    'ads-governance-source-contract-v1.3',
    'ads-governance-value-coverage-v2',
    'migrationCandidate=false', 'executionAuthorized=false',
    'Static site and security invariants',
]
for needle in required:
    assert needle in s, needle
p.write_text(s, encoding='utf-8')
print('Frontend README cross-cloud production baseline refreshed')
