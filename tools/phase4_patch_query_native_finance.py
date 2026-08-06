from pathlib import Path
import re


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def regex_once(text, pattern, replacement, label):
    output, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"{label}: expected one regex match, found {count}")
    return output


finance_path = Path('assets/generated/inline-script-08.js')
finance = finance_path.read_text(encoding='utf-8')
finance = replace_once(
    finance,
    "  let chartBag={},lastReport=null,activeTab='overview';",
    "  const MODULE_VERSION='2.0.0';\n  let chartBag={},lastReport=null,activeTab='overview',sourceMode='query',renderGeneration=0;",
    'finance version state',
)
finance = replace_once(
    finance,
    "    byId('btnRefreshTransactionFinance')?.addEventListener('click',renderReport);",
    "    byId('btnRefreshTransactionFinance')?.addEventListener('click',()=>renderReport({force:true}));",
    'refresh listener',
)
finance = replace_once(
    finance,
    "  const getAllTransactionRows=()=>{try{const rows=AdsDashboardApp?.debug?.getTransactionRowsForFinance?.();return Array.isArray(rows)?rows:[];}catch(e){return[];}};",
    "  const moduleData=()=>window.QueryNativeModuleData;\n"
    "  const queryScope=()=>String(window.ShopScope?.get?.()||window.ACTIVE_SHOP||'ALL').trim().toUpperCase();\n"
    "  const sourceLabel=value=>value==='raw-compat'?'RAW COMPAT · 浏览器内存':'QUERY · TiDB';\n"
    "  const isModalOpen=()=>byId('transactionFinanceModal')?.style.display==='flex';",
    'replace Raw getter',
)

build_report = """  const buildReport=async({force=false,source=sourceMode}={})=>{
    const adapter=moduleData();
    if(typeof adapter?.periodTransactions!=='function')throw new Error('Query-native 数据适配器尚未就绪，请刷新页面后重试。');
    const scope=currentScope(),startD=parseDate(scope.start),endD=parseDate(scope.end),span=daySpan(startD,endD);
    let previousRange=null,previousLabel='无上期数据';
    if(startD&&endD&&span){
      const prevEnd=addDays(startD,-1),prevStart=addDays(prevEnd,-span+1),ps=fmtDate(prevStart),pe=fmtDate(prevEnd);
      previousRange={from:ps,to:pe};previousLabel=`${ps} → ${pe}`;
    }
    const periods=await adapter.periodTransactions({
      scope:queryScope(),statusMode:scope.mode,marketplace:scope.market,source,force,maxRows:300000,
      current:{from:scope.start,to:scope.end},previous:previousRange
    });
    const currentRows=Array.isArray(periods?.current?.rows)?periods.current.rows:[];
    const resolvedSource=periods?.current?.source||'query-tidb';
    const current=aggregate(currentRows,{...scope,source:resolvedSource,sourceLabel:sourceLabel(resolvedSource)});
    let previous=null;
    if(periods?.previous){
      const previousRows=Array.isArray(periods.previous.rows)?periods.previous.rows:[];
      previous=aggregate(previousRows,{start:previousRange?.from||'',end:previousRange?.to||'',mode:scope.mode,market:scope.market,source:periods.previous.source||resolvedSource,sourceLabel:sourceLabel(periods.previous.source||resolvedSource)});
    }
    return {all:currentRows,current,previous,previousLabel,source:resolvedSource,sourceLabel:sourceLabel(resolvedSource),queryScope:queryScope(),loadedAt:new Date().toISOString()};
  };

  const insightRows"""
finance = regex_once(
    finance,
    r"  const buildReport=\(\)=>\{.*?\n  \};\n\n  const insightRows",
    build_report,
    'async buildReport',
)

finance = replace_once(
    finance,
    "    if(!r.all.length){body.innerHTML='<div class=\"txFinanceEmpty\"><b>尚未导入联合交易报告</b><br>请先导入 Amazon 联合报告（交易），再生成财务报表。</div>';return;}\n    if(!c.rows.length){body.innerHTML='<div class=\"txFinanceEmpty\"><b>当前日期范围没有联合交易记录</b><br>请调整左侧日期，确保与联合报告 Posted Date 重叠。</div>';return;}",
    "    if(!c.rows.length){body.innerHTML=`<div class=\"txFinanceEmpty\"><b>当前日期范围没有交易记录</b><br>${esc(r.sourceLabel)} 已完成查询，请调整左侧日期，确保与 Posted Date 重叠。</div>`;return;}",
    'empty state',
)
finance = replace_once(
    finance,
    "<div class=\"txFinanceFootnote\"><b>口径说明：</b>经营结算净额使用联合报告非Transfer交易Total；预估净利润在此基础上扣除GitHub成本库中的采购、头程及适用的FBM配送成本。成本库未匹配的SKU不虚构成本，请结合成本覆盖率判断结果完整性。Cost of Advertising只使用联合报告扣费，不与广告报表花费重复扣除。</div>",
    "<div class=\"txFinanceFootnote\"><b>数据来源：</b>${esc(r.sourceLabel)}。<b>口径说明：</b>经营结算净额使用联合报告非Transfer交易Total；预估净利润在此基础上扣除GitHub成本库中的采购、头程及适用的FBM配送成本。成本库未匹配的SKU不虚构成本，请结合成本覆盖率判断结果完整性。Cost of Advertising只使用联合报告扣费，不与广告报表花费重复扣除。</div>",
    'source footnote',
)

render_report = """  const renderReport=async({force=false}={})=>{
    const body=byId('transactionFinanceBody');if(!body)return;
    const generation=++renderGeneration;
    destroyCharts();
    body.innerHTML='<div class="txFinanceEmpty"><b>正在读取 Query 数据…</b><br>按当前店铺、日期与结算口径从 TiDB 分页查询交易明细。</div>';
    const refresh=byId('btnRefreshTransactionFinance'),exportButton=byId('btnExportTransactionFinance');
    if(refresh)refresh.disabled=true;if(exportButton)exportButton.disabled=true;
    try{
      const r=await buildReport({force,source:sourceMode});
      if(generation!==renderGeneration)return;
      lastReport=r;
      const c=r.current,mode=c.mode==='cash'?'现金口径 · Released':'权责口径 · Released + Deferred';
      const switchControl=sourceMode==='raw'?'<button class="btn" id="btnTxFinanceUseQuery" type="button">切回 Query</button>':'';
      byId('transactionFinanceHeaderMeta').innerHTML=`<span class="txFinanceHeaderPill"><strong>${esc(c.start||'最早')}</strong> → <strong>${esc(c.end||'最新')}</strong></span><span class="txFinanceHeaderPill">${esc(c.market||'ALL')}</span><span class="txFinanceHeaderPill">${esc(mode)}</span><span class="txFinanceHeaderPill">${esc(r.sourceLabel)}</span><span class="txFinanceHeaderPill">对比：${esc(r.previousLabel)}</span>${switchControl}`;
      byId('transactionFinanceTabMeta').textContent=`${c.rows.length.toLocaleString()} 条交易 · ${c.skuCount.toLocaleString()} SKU · 成本覆盖 ${pct(c.costCoverage)} · Posted Date · ${r.queryScope}`;
      renderBody(r);
      byId('btnTxFinanceUseQuery')?.addEventListener('click',()=>{sourceMode='query';renderReport({force:true});});
      switchTab(activeTab);
    }catch(error){
      if(generation!==renderGeneration)return;
      lastReport=null;
      const message=String(error?.message||error);
      const action=sourceMode==='query'
        ? '<button class="btn primary" id="btnTxFinanceUseRawCompat" type="button">使用已导入 Raw 数据</button>'
        : '<button class="btn primary" id="btnTxFinanceRetryQuery" type="button">返回 Query 模式</button>';
      body.innerHTML=`<div class="txFinanceEmpty"><b>${sourceMode==='query'?'Query-native 数据读取失败':'Raw 兼容数据不可用'}</b><br>${esc(message)}<div style="margin-top:12px">${action}</div></div>`;
      byId('transactionFinanceHeaderMeta').innerHTML=`<span class="txFinanceHeaderPill">${sourceMode==='query'?'QUERY · TiDB':'RAW COMPAT · 浏览器内存'}</span><span class="txFinanceHeaderPill">读取失败</span>`;
      byId('transactionFinanceTabMeta').textContent='未生成报表 · 数据源未就绪';
      byId('btnTxFinanceUseRawCompat')?.addEventListener('click',()=>{sourceMode='raw';renderReport({force:true});});
      byId('btnTxFinanceRetryQuery')?.addEventListener('click',()=>{sourceMode='query';renderReport({force:true});});
    }finally{
      if(generation===renderGeneration){if(refresh)refresh.disabled=false;if(exportButton)exportButton.disabled=false;}
    }
  };

  const downloadBlob"""
finance = regex_once(
    finance,
    r"  const renderReport=\(\)=>\{.*?\n  \};\n\n  const downloadBlob",
    render_report,
    'async renderReport',
)

finance = replace_once(
    finance,
    "  const exportReport=async()=>{\n    const r=buildReport(),c=r.current;if(!c.rows.length){try{notify('当前日期范围没有联合交易数据。','warn');}catch(e){alert('当前日期范围没有联合交易数据。');}return;}",
    "  const exportReport=async()=>{\n    let r;try{r=await buildReport({force:false,source:sourceMode});}catch(err){const message=`无法读取交易数据：${err?.message||err}`;try{notify(message,'bad');}catch(e){alert(message);}return;}\n    const c=r.current;if(!c.rows.length){try{notify('当前日期范围没有联合交易数据。','warn');}catch(e){alert('当前日期范围没有联合交易数据。');}return;}",
    'async export source',
)
finance = replace_once(
    finance,
    "  const openModal=()=>{const m=ensureModal();m.style.display='flex';renderReport();setTimeout(()=>byId('btnCloseTransactionFinance')?.focus(),0);};",
    "  const openModal=()=>{const m=ensureModal();m.style.display='flex';renderReport({force:false});setTimeout(()=>byId('btnCloseTransactionFinance')?.focus(),0);};",
    'open modal async render',
)
finance = replace_once(
    finance,
    "    ['dateStart','dateEnd','transactionStatusMode'].forEach(id=>byId(id)?.addEventListener('change',()=>{const m=byId('transactionFinanceModal');if(m&&m.style.display!=='none')setTimeout(renderReport,260);}));\n    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&byId('transactionFinanceModal')?.style.display==='flex')closeModal();});\n    window.TransactionFinanceReport={open:openModal,render:renderReport,build:buildReport,export:exportReport,switchTab};",
    "    ['dateStart','dateEnd','transactionStatusMode','workspaceMarketplace'].forEach(id=>byId(id)?.addEventListener('change',()=>{if(isModalOpen())setTimeout(()=>renderReport({force:false}),260);}));\n    window.addEventListener('lr:shop-change',()=>{if(isModalOpen())renderReport({force:true});});\n    window.addEventListener('lr:query-client-ready',()=>{if(isModalOpen()&&sourceMode==='query'&&!lastReport)renderReport({force:true});});\n    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&byId('transactionFinanceModal')?.style.display==='flex')closeModal();});\n    window.TransactionFinanceReport={version:MODULE_VERSION,open:openModal,render:renderReport,build:buildReport,export:exportReport,switchTab,useQuery:()=>{sourceMode='query';return renderReport({force:true});},useRawCompatibility:()=>{sourceMode='raw';return renderReport({force:true});},source:()=>sourceMode};",
    'init Query-native listeners',
)
finance_path.write_text(finance, encoding='utf-8')

index_path = Path('index.html')
index = index_path.read_text(encoding='utf-8')
index = replace_once(
    index,
    '<script id="transaction-finance-report-script" src="assets/generated/inline-script-08.js"></script>',
    '<script id="queryNativeModuleDataV1" src="assets/query-native-module-data-v1.js?v=1.0.0"></script>\n<script id="transaction-finance-report-script" src="assets/generated/inline-script-08.js?v=2.0.0"></script>',
    'index Query-native script order',
)
index_path.write_text(index, encoding='utf-8')

ci_path = Path('.github/workflows/ci-main.yml')
ci = ci_path.read_text(encoding='utf-8')
ci = replace_once(ci, '          test -s assets/private-cloud-query-v1.js\n          test -s scripts/test-progressive-loader.mjs', '          test -s assets/private-cloud-query-v1.js\n          test -s assets/query-native-module-data-v1.js\n          test -s scripts/test-progressive-loader.mjs\n          test -s scripts/test-query-native-modules.mjs', 'CI build inputs')
ci = replace_once(ci, '          node --check assets/private-cloud-query-v1.js\n          node --check scripts/harden-static-site.mjs\n          node --check scripts/test-progressive-loader.mjs', '          node --check assets/private-cloud-query-v1.js\n          node --check assets/query-native-module-data-v1.js\n          node --check scripts/harden-static-site.mjs\n          node --check scripts/test-progressive-loader.mjs\n          node --check scripts/test-query-native-modules.mjs', 'CI syntax inputs')
ci = replace_once(ci, '      - name: Verify locked vendor bytes', '      - name: Verify Query-native module contracts\n        shell: bash\n        run: node scripts/test-query-native-modules.mjs\n\n      - name: Verify locked vendor bytes', 'CI Query-native step')
ci = replace_once(ci, '          test -s _site/assets/private-cloud-query-v1.js\n          test -s _site/assets/vendor/xlsx.full.min.js', '          test -s _site/assets/private-cloud-query-v1.js\n          test -s _site/assets/query-native-module-data-v1.js\n          test -s _site/assets/vendor/xlsx.full.min.js', 'CI artifact adapter')
ci_path.write_text(ci, encoding='utf-8')

pages_path = Path('.github/workflows/pages.yml')
pages = pages_path.read_text(encoding='utf-8')
pages = replace_once(pages, '      - "scripts/test-progressive-loader.mjs"', '      - "scripts/test-progressive-loader.mjs"\n      - "scripts/test-query-native-modules.mjs"', 'Pages paths')
pages = replace_once(pages, '          test -s assets/private-cloud-query-v1.js\n          test -s scripts/test-progressive-loader.mjs', '          test -s assets/private-cloud-query-v1.js\n          test -s assets/query-native-module-data-v1.js\n          test -s scripts/test-progressive-loader.mjs\n          test -s scripts/test-query-native-modules.mjs', 'Pages build inputs')
pages = replace_once(pages, '          node --check scripts/test-progressive-loader.mjs\n          node scripts/test-progressive-loader.mjs', '          node --check scripts/test-progressive-loader.mjs\n          node --check scripts/test-query-native-modules.mjs\n          node scripts/test-progressive-loader.mjs\n          node scripts/test-query-native-modules.mjs', 'Pages tests')
pages = replace_once(pages, '          test -s _site/assets/private-cloud-query-v1.js', '          test -s _site/assets/private-cloud-query-v1.js\n          test -s _site/assets/query-native-module-data-v1.js', 'Pages artifact adapter')
pages_path.write_text(pages, encoding='utf-8')

print('Phase 4 Query-native finance patch applied')
