from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)

adapter_path = Path('assets/query-native-module-data-v1.js')
adapter = adapter_path.read_text(encoding='utf-8')
adapter = replace_once(
    adapter,
    "  const normalizeMarketplace = value => String(value || '').trim().toUpperCase();",
    "  const MARKETPLACE_ALIASES = Object.freeze({\n"
    "    US: ['US', 'AMAZON.COM', 'WWW.AMAZON.COM'],\n"
    "    CA: ['CA', 'AMAZON.CA', 'WWW.AMAZON.CA'],\n"
    "    MX: ['MX', 'AMAZON.COM.MX', 'WWW.AMAZON.COM.MX'],\n"
    "    UK: ['UK', 'GB', 'AMAZON.CO.UK', 'WWW.AMAZON.CO.UK'],\n"
    "    DE: ['DE', 'AMAZON.DE', 'WWW.AMAZON.DE'],\n"
    "    FR: ['FR', 'AMAZON.FR', 'WWW.AMAZON.FR'],\n"
    "    IT: ['IT', 'AMAZON.IT', 'WWW.AMAZON.IT'],\n"
    "    ES: ['ES', 'AMAZON.ES', 'WWW.AMAZON.ES'],\n"
    "    JP: ['JP', 'AMAZON.CO.JP', 'WWW.AMAZON.CO.JP'],\n"
    "    AU: ['AU', 'AMAZON.COM.AU', 'WWW.AMAZON.COM.AU'],\n"
    "  });\n\n"
    "  const marketplaceToken = value => String(value || '')\n"
    "    .trim()\n"
    "    .toUpperCase()\n"
    "    .replace(/^HTTPS?:\\/\\//, '')\n"
    "    .replace(/\\/.*$/, '');\n\n"
    "  const normalizeMarketplace = value => marketplaceToken(value);\n\n"
    "  const marketplaceMatches = (rowValue, requestedValue) => {\n"
    "    const row = marketplaceToken(rowValue);\n"
    "    const requested = marketplaceToken(requestedValue);\n"
    "    if (!row || !requested) return true;\n"
    "    return (MARKETPLACE_ALIASES[requested] || [requested]).includes(row);\n"
    "  };",
    'marketplace aliases',
)
adapter = replace_once(
    adapter,
    "    if (request.marketplace && row.marketplace\n      && String(row.marketplace).trim().toUpperCase() !== request.marketplace) return false;",
    "    if (request.marketplace && row.marketplace\n      && !marketplaceMatches(row.marketplace, request.marketplace)) return false;",
    'marketplace filter',
)
adapter_path.write_text(adapter, encoding='utf-8')

finance_path = Path('assets/generated/inline-script-08.js')
finance = finance_path.read_text(encoding='utf-8')
finance = replace_once(
    finance,
    "  const validDate=r=>/^\\d{4}-\\d{2}-\\d{2}$/.test(String(r?.date||''));\n  const statusIncluded=(r,mode)=>{const s=String(r?.status||'Released').trim().toLowerCase();return mode==='cash'?s==='released':s==='released'||s==='deferred';};\n  const marketIncluded=(r,market)=>!market||!r?.marketplace||String(r.marketplace).trim().toUpperCase()===market;\n  const rowsFor=(all,start,end,mode,market)=>all.filter(r=>validDate(r)&&statusIncluded(r,mode)&&marketIncluded(r,market)&&(!start||r.date>=start)&&(!end||r.date<=end));\n",
    "",
    'remove legacy module filters',
)
finance = replace_once(
    finance,
    "    body.innerHTML='<div class=\"txFinanceEmpty\"><b>正在读取 Query 数据…</b><br>按当前店铺、日期与结算口径从 TiDB 分页查询交易明细。</div>';",
    "    body.innerHTML=sourceMode==='raw'\n      ? '<div class=\"txFinanceEmpty\"><b>正在读取 Raw 兼容数据…</b><br>仅使用当前浏览器已显式导入的联合交易明细。</div>'\n      : '<div class=\"txFinanceEmpty\"><b>正在读取 Query 数据…</b><br>按当前店铺、日期与结算口径从 TiDB 分页查询交易明细。</div>';",
    'source-aware loading state',
)
finance_path.write_text(finance, encoding='utf-8')

test_path = Path('scripts/test-query-native-modules.mjs')
test = test_path.read_text(encoding='utf-8')
needle = "  marketplace: 'amazon.com',\n  force: true,"
if test.count(needle) != 2:
    raise SystemExit(f'test marketplace request: expected two matches, found {test.count(needle)}')
test = test.replace(needle, "  marketplace: 'US',\n  force: true,")
test = replace_once(
    test,
    "assert.match(adapter, /transactionPreTaxNet/);",
    "assert.match(adapter, /transactionPreTaxNet/);\nassert.match(adapter, /MARKETPLACE_ALIASES/);\nassert.match(adapter, /marketplaceMatches/);",
    'marketplace contract assertions',
)
test = replace_once(
    test,
    "assert.match(finance, /使用已导入 Raw 数据/);",
    "assert.match(finance, /使用已导入 Raw 数据/);\nassert.match(finance, /正在读取 Raw 兼容数据/);\nassert.doesNotMatch(finance, /const rowsFor=/);",
    'finance loading assertions',
)
test_path.write_text(test, encoding='utf-8')

print('Query-native marketplace hardening applied')
