(() => {
  'use strict';
  const byId=id=>document.getElementById(id);
  const num=v=>{const n=Number(v);return Number.isFinite(n)?n:0;};
  const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const sum=(rows,key)=>rows.reduce((a,r)=>a+num(typeof key==='function'?key(r):r[key]),0);
  const safeDiv=(a,b)=>b?num(a)/num(b):0;
  const currency=()=>String(byId('workspaceCurrency')?.value||'USD').toUpperCase();
  const money=v=>new Intl.NumberFormat('en-US',{style:'currency',currency:currency(),minimumFractionDigits:2,maximumFractionDigits:2}).format(num(v));
  const pct=v=>`${(num(v)*100).toFixed(2)}%`;
  const signedMoney=v=>`${num(v)>0?'+':''}${money(v)}`;
  const toneForSigned=v=>num(v)>0?'good':num(v)<0?'bad':'neutral';
  const categoryLabel={ORDER:'订单销售',REFUND:'退款',ADVERTISING:'广告扣费',INBOUND:'入库配置费',STORAGE:'仓储费',ACCOUNT_OVERHEAD:'账户级服务费',LIQUIDATION:'清算收入',ADJUSTMENT:'调整项',OTHER:'其他交易',TRANSFER:'转账'};
  let chartBag={},lastReport=null,activeTab='overview';

  const destroyCharts=(prefix='')=>{
    Object.entries(chartBag).forEach(([k,c])=>{if(!prefix||k.startsWith(prefix)){try{c?.destroy?.();}catch(e){}delete chartBag[k];}});
  };
  const parseDate=s=>{if(!s)return null;const d=new Date(`${s}T00:00:00`);return Number.isNaN(d.getTime())?null:d;};
  const fmtDate=d=>d?`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`:'';
  const addDays=(d,n)=>{const x=new Date(d);x.setDate(x.getDate()+n);return x;};
  const daySpan=(a,b)=>a&&b?Math.max(1,Math.round((b-a)/86400000)+1):0;
  const delta=(cur,prev,{invert=false,points=false}={})=>{
    if(!Number.isFinite(prev)||prev===0)return {text:'无上期',tone:'neutral',raw:null};
    const raw=points?(cur-prev):(cur-prev)/Math.abs(prev);
    const good=invert?raw<0:raw>0;
    const bad=invert?raw>0:raw<0;
    return {text:points?`${raw>0?'+':''}${(raw*100).toFixed(2)}pp`:`${raw>0?'+':''}${(raw*100).toFixed(1)}%`,tone:good?'good':bad?'bad':'neutral',raw};
  };
  const metric=(k,v,m,d)=>`<div class="txFinanceMetric"><div class="txFinanceMetricHead"><div class="k">${esc(k)}</div><span class="txFinanceDelta ${esc(d?.tone||'neutral')}">${esc(d?.text||'—')}</span></div><div class="v">${esc(v)}</div><div class="m">${esc(m)}</div></div>`;
  const ratio=(k,v,m)=>`<div class="txFinanceRatio"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="m">${esc(m)}</div></div>`;
  const mini=(k,v,m)=>`<div class="txFinanceMiniMetric"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="m">${esc(m)}</div></div>`;

  const ensureModal=()=>{
    let modal=byId('transactionFinanceModal');
    if(modal)return modal;
    modal=document.createElement('div');
    modal.className='modalOverlay txFinanceOverlay';
    modal.id='transactionFinanceModal';
    modal.setAttribute('role','dialog');
    modal.setAttribute('aria-modal','true');
    modal.setAttribute('aria-labelledby','transactionFinanceTitle');
    modal.innerHTML=`<div class="largeModal txFinanceModal">
      <div class="largeModalHeader">
        <div>
          <h2 id="transactionFinanceTitle">交易财务报表</h2>
          <div class="txFinanceHeaderMeta" id="transactionFinanceHeaderMeta"></div>
        </div>
        <div class="largeModalActions">
          <button class="btn" id="btnRefreshTransactionFinance" type="button">刷新</button>
          <button class="btn primary" id="btnExportTransactionFinance" type="button">导出 Excel</button>
          <button class="btn" id="btnCloseTransactionFinance" type="button">关闭</button>
        </div>
      </div>
      <div class="txFinanceTabsBar">
        <div class="txFinanceTabs" role="tablist" aria-label="交易财务报表维度">
          <button class="txFinanceTab active" data-tx-tab="overview" type="button">经营总览</button>
          <button class="txFinanceTab" data-tx-tab="costs" type="button">成本结构</button>
          <button class="txFinanceTab" data-tx-tab="refunds" type="button">退款质量</button>
          <button class="txFinanceTab" data-tx-tab="sku" type="button">SKU表现</button>
        </div>
        <div class="txFinanceTabMeta" id="transactionFinanceTabMeta">按左侧日期范围 · Posted Date</div>
      </div>
      <div class="largeModalBody"><div class="txFinanceContent" id="transactionFinanceBody"></div></div>
    </div>`;
    document.body.appendChild(modal);
    byId('btnCloseTransactionFinance')?.addEventListener('click',closeModal);
    byId('btnRefreshTransactionFinance')?.addEventListener('click',renderReport);
    byId('btnExportTransactionFinance')?.addEventListener('click',exportReport);
    modal.querySelector('.txFinanceTabs')?.addEventListener('click',e=>{const b=e.target.closest('[data-tx-tab]');if(b)switchTab(b.dataset.txTab);});
    modal.addEventListener('click',e=>{if(e.target===modal)closeModal();});
    return modal;
  };
  const closeModal=()=>{destroyCharts();const m=byId('transactionFinanceModal');if(m)m.style.display='none';};
  const getAllTransactionRows=()=>{try{const rows=AdsDashboardApp?.debug?.getTransactionRowsForFinance?.();return Array.isArray(rows)?rows:[];}catch(e){return[];}};
  const currentScope=()=>({start:byId('dateStart')?.value||'',end:byId('dateEnd')?.value||'',mode:byId('transactionStatusMode')?.value||'accrual',market:String(byId('workspaceMarketplace')?.value||'').trim().toUpperCase()});
  const validDate=r=>/^\d{4}-\d{2}-\d{2}$/.test(String(r?.date||''));
  const statusIncluded=(r,mode)=>{const s=String(r?.status||'Released').trim().toLowerCase();return mode==='cash'?s==='released':s==='released'||s==='deferred';};
  const marketIncluded=(r,market)=>!market||!r?.marketplace||String(r.marketplace).trim().toUpperCase()===market;
  const rowsFor=(all,start,end,mode,market)=>all.filter(r=>validDate(r)&&statusIncluded(r,mode)&&marketIncluded(r,market)&&(!start||r.date>=start)&&(!end||r.date<=end));
  const resolveCost=(sku,asin='')=>{try{return window.__LR_RESOLVE_PRODUCT_COST__?.(sku,asin)||null;}catch(_){return null;}};
  const isMerchantFulfilled=r=>/fbm|mfn|merchant|seller/i.test(String(r?.fulfillment||r?.fulfillmentType||r?.fulfillmentChannel||''));

  const aggregate=(rows,scope={})=>{
    const order=rows.filter(r=>r.category==='ORDER'),refund=rows.filter(r=>r.category==='REFUND'),trade=rows.filter(r=>r.category==='ORDER'||r.category==='REFUND');
    const categoryTotals=new Map();
    for(const r of rows){const key=r.category||'OTHER',x=categoryTotals.get(key)||{rows:0,total:0};x.rows++;x.total+=num(r.total);categoryTotals.set(key,x);}
    const taxFields=['productSalesTax','shippingCreditsTax','giftWrapCreditsTax','regulatoryFeeTax','promotionalRebatesTax','marketplaceWithheldTax'];
    const orderSales=sum(order,'productSales'),refundSales=Math.max(0,-sum(refund,'productSales')),netProductSales=orderSales-refundSales;
    const orderUnits=sum(order,r=>Math.max(0,num(r.quantity))),refundUnits=sum(refund,r=>Math.max(0,num(r.quantity))),netUnits=Math.max(0,orderUnits-refundUnits);
    const orderCredits=sum(order,r=>num(r.shippingCredits)+num(r.giftWrapCredits)+num(r.regulatoryFee));
    const refundCredits=Math.max(0,-sum(refund,r=>num(r.shippingCredits)+num(r.giftWrapCredits)+num(r.regulatoryFee)));
    const sellingFees=Math.max(0,-sum(trade,'sellingFees')),fbaFees=Math.max(0,-sum(trade,'fbaFees')),promo=Math.max(0,-sum(trade,'promotionalRebates')),otherTx=Math.max(0,-sum(trade,'otherTransactionFees')),otherTrade=Math.max(0,-sum(trade,'other'));
    const taxNet=sum(rows,r=>taxFields.reduce((a,k)=>a+num(r[k]),0));
    const orderSettlement=sum(order,'total'),refundSettlement=sum(refund,'total'),refundPreTaxLoss=Math.max(0,-sum(refund,'preTaxNet'));
    const cat=k=>categoryTotals.get(k)?.total||0;
    const advertising=Math.max(0,-cat('ADVERTISING')),inbound=Math.max(0,-cat('INBOUND')),storage=Math.max(0,-cat('STORAGE')),overhead=Math.max(0,-cat('ACCOUNT_OVERHEAD'));
    const otherCategory=cat('OTHER'),liquidation=cat('LIQUIDATION'),adjustments=cat('ADJUSTMENT'),transfer=cat('TRANSFER');
    const settlementTotal=sum(rows,'total'),operatingSettlement=settlementTotal-transfer;
    const amazonTradeFees=sellingFees+fbaFees+promo+otherTx+otherTrade;
    const operatingExpenses=advertising+inbound+storage+overhead+Math.max(0,-otherCategory)+Math.max(0,-adjustments);
    const nonAdOperatingExpenses=Math.max(0,operatingExpenses-advertising);
    const orderIds=new Set(order.map(r=>r.orderId).filter(Boolean)),skuSet=new Set(rows.map(r=>r.sku).filter(Boolean));
    const dailyMap=new Map(),skuMap=new Map();
    for(const r of rows){
      const d=r.date||'无日期',x=dailyMap.get(d)||{date:d,rows:0,sales:0,refund:0,fees:0,ads:0,net:0,units:0,refundUnits:0,productCost:0,matchedUnits:0,totalUnits:0};x.rows++;x.net+=num(r.total);
      if(r.category==='ORDER'){const u=Math.max(0,num(r.quantity));x.sales+=num(r.productSales);x.units+=u;x.totalUnits+=u;x.fees+=-(num(r.sellingFees)+num(r.fbaFees)+num(r.promotionalRebates)+num(r.otherTransactionFees)+num(r.other));}
      else if(r.category==='REFUND'){x.refund+=Math.max(0,-num(r.productSales));x.refundUnits+=Math.max(0,num(r.quantity));x.fees+=-(num(r.sellingFees)+num(r.fbaFees)+num(r.promotionalRebates)+num(r.otherTransactionFees)+num(r.other));}
      else if(r.category==='ADVERTISING')x.ads+=Math.max(0,-num(r.total));
      dailyMap.set(d,x);
      if(r.sku){
        const s=skuMap.get(r.sku)||{sku:r.sku,rows:0,units:0,refundUnits:0,sales:0,refund:0,fees:0,net:0,merchantUnits:0};s.rows++;s.net+=num(r.total);
        if(r.category==='ORDER'){const u=Math.max(0,num(r.quantity));s.units+=u;s.sales+=num(r.productSales);if(isMerchantFulfilled(r))s.merchantUnits+=u;s.fees+=-(num(r.sellingFees)+num(r.fbaFees)+num(r.promotionalRebates)+num(r.otherTransactionFees)+num(r.other));}
        else if(r.category==='REFUND'){s.refundUnits+=Math.max(0,num(r.quantity));s.refund+=Math.max(0,-num(r.productSales));s.fees+=-(num(r.sellingFees)+num(r.fbaFees)+num(r.promotionalRebates)+num(r.otherTransactionFees)+num(r.other));}
        skuMap.set(r.sku,s);
      }
    }
    let purchaseCost=0,fbmShippingCost=0,costMatchedOrderUnits=0;
    const sku=[...skuMap.values()].map(s=>{
      const cost=resolveCost(s.sku),soldUnits=Math.max(0,s.units-s.refundUnits),matched=Boolean(cost&&Number.isFinite(num(cost.landedCost))&&num(cost.landedCost)>0),unitCost=matched?num(cost.landedCost):0,itemCost=matched?soldUnits*unitCost:0,shipping=matched?s.merchantUnits*num(cost.fbmShippingCost):0,finalNet=s.net-itemCost-shipping;
      if(matched){purchaseCost+=itemCost;fbmShippingCost+=shipping;costMatchedOrderUnits+=s.units;}
      return {...s,netUnits:soldUnits,costMatched:matched,unitCost,purchaseCost:itemCost,fbmShippingCost:shipping,finalNet,refundRate:safeDiv(s.refund,s.sales),feeRate:safeDiv(s.fees,s.sales),netRate:safeDiv(s.net,s.sales),finalNetRate:safeDiv(finalNet,s.sales),costUpdatedAt:cost?.updatedAt||'',costAsin:cost?.asin||''};
    }).sort((a,b)=>b.sales-a.sales);
    const skuCostMap=new Map(sku.map(x=>[x.sku,x]));
    for(const x of dailyMap.values()){
      const dayRows=rows.filter(r=>r.date===x.date&&r.sku);
      const daySku=new Map();
      for(const r of dayRows){const key=r.sku,rec=daySku.get(key)||{units:0,refundUnits:0,merchantUnits:0};if(r.category==='ORDER'){const u=Math.max(0,num(r.quantity));rec.units+=u;if(isMerchantFulfilled(r))rec.merchantUnits+=u;}else if(r.category==='REFUND')rec.refundUnits+=Math.max(0,num(r.quantity));daySku.set(key,rec);}
      for(const [skuKey,rec] of daySku){const cost=resolveCost(skuKey);if(!cost||num(cost.landedCost)<=0)continue;const sold=Math.max(0,rec.units-rec.refundUnits);x.productCost+=sold*num(cost.landedCost)+rec.merchantUnits*num(cost.fbmShippingCost);x.matchedUnits+=rec.units;}
      x.finalNet=x.net-x.productCost;
    }
    const daily=[...dailyMap.values()].sort((a,b)=>String(a.date).localeCompare(String(b.date))).map(x=>({...x,refundRate:safeDiv(x.refund,x.sales),netRate:safeDiv(x.net,x.sales),finalNetRate:safeDiv(x.finalNet,x.sales),costCoverage:safeDiv(x.matchedUnits,x.totalUnits)}));
    const costCoverage=safeDiv(costMatchedOrderUnits,orderUnits),finalNetProfit=operatingSettlement-purchaseCost-fbmShippingCost,finalNetMargin=safeDiv(finalNetProfit,netProductSales);
    const categories=[...categoryTotals.entries()].map(([category,x])=>({category,label:categoryLabel[category]||category,rows:x.rows,total:x.total,share:safeDiv(Math.abs(x.total),Math.max(Math.abs(operatingSettlement),1))})).sort((a,b)=>Math.abs(b.total)-Math.abs(a.total));
    const expense=[
      ['商品采购及头程成本',purchaseCost,'GitHub SKU/ASIN cost library'],['FBM配送成本',fbmShippingCost,'Merchant fulfilled shipping cost'],['销售佣金',sellingFees,'Amazon referral fee'],['FBA配送费',fbaFees,'Fulfillment fees'],['促销折扣',promo,'Promotional rebates'],['其他交易费',otherTx,'Other transaction fees'],['订单/退款Other',otherTrade,'Order / refund other'],['广告扣费',advertising,'Cost of Advertising'],['仓储费',storage,'Storage fees'],['入库配置费',inbound,'Inbound placement'],['账户服务费',overhead,'Service fees'],['其他/负调整',Math.max(0,-otherCategory)+Math.max(0,-adjustments),'Other + negative adjustments']
    ].map(([name,value,note])=>({name,value,note,rate:safeDiv(value,netProductSales)}));
    const bridgeSeed=[
      {name:'商品销售',change:orderSales},{name:'Credits',change:orderCredits},{name:'退款',change:-(refundSales+refundCredits)},{name:'销售佣金',change:-sellingFees},{name:'FBA费用',change:-fbaFees},{name:'促销/交易费',change:-(promo+otherTx+otherTrade)},{name:'广告',change:-advertising},{name:'仓储/入库/服务',change:-(storage+inbound+overhead)},{name:'清算/调整/其他',change:liquidation+adjustments+otherCategory}
    ];
    const currentWithoutResidual=bridgeSeed.reduce((a,x)=>a+x.change,0),residual=operatingSettlement-currentWithoutResidual;
    if(Math.abs(residual)>.005)bridgeSeed.push({name:'税费及口径差',change:residual});
    bridgeSeed.push({name:'商品采购成本',change:-purchaseCost},{name:'FBM配送成本',change:-fbmShippingCost});
    let cursor=0;
    const waterfall=bridgeSeed.map(x=>{const start=cursor;cursor+=x.change;return {...x,start,end:cursor};});
    waterfall.push({name:'预估净利润',change:finalNetProfit,start:0,end:finalNetProfit,total:true});
    const top3Share=safeDiv(sku.slice(0,3).reduce((a,x)=>a+x.sales,0),orderSales);
    return {...scope,rows,orderSales,refundSales,netProductSales,orderUnits,refundUnits,netUnits,returnRate:safeDiv(refundUnits,orderUnits),refundSalesRate:safeDiv(refundSales,orderSales),orderCount:orderIds.size,skuCount:skuSet.size,orderCredits,refundCredits,sellingFees,fbaFees,promo,otherTx,otherTrade,taxNet,orderSettlement,refundSettlement,refundPreTaxLoss,advertising,inbound,storage,overhead,otherCategory,liquidation,adjustments,transfer,settlementTotal,operatingSettlement,purchaseCost,fbmShippingCost,finalNetProfit,finalNetMargin,costMatchedOrderUnits,costCoverage,amazonTradeFees,operatingExpenses,nonAdOperatingExpenses,tradeFeeRate:safeDiv(amazonTradeFees,netProductSales),adRate:safeDiv(advertising,netProductSales),nonAdRate:safeDiv(nonAdOperatingExpenses,netProductSales),expenseLoad:safeDiv(amazonTradeFees+operatingExpenses+purchaseCost+fbmShippingCost,netProductSales),operatingMargin:safeDiv(operatingSettlement,netProductSales),aov:safeDiv(orderSales,orderIds.size),netPerOrder:safeDiv(finalNetProfit,orderIds.size),unitNet:safeDiv(finalNetProfit,netUnits),unitFees:safeDiv(amazonTradeFees,orderUnits),unitAds:safeDiv(advertising,orderUnits),refundLossRate:safeDiv(refundPreTaxLoss,orderSales),daily,sku,categories,expense,waterfall,top3Share};
  };

  const buildReport=()=>{
    const all=getAllTransactionRows(),scope=currentScope(),rows=rowsFor(all,scope.start,scope.end,scope.mode,scope.market),current=aggregate(rows,scope);
    let previous=null,previousLabel='无上期数据';
    const startD=parseDate(scope.start),endD=parseDate(scope.end),span=daySpan(startD,endD);
    if(startD&&endD&&span){const prevEnd=addDays(startD,-1),prevStart=addDays(prevEnd,-span+1);const ps=fmtDate(prevStart),pe=fmtDate(prevEnd),pr=rowsFor(all,ps,pe,scope.mode,scope.market);previous=aggregate(pr,{start:ps,end:pe,mode:scope.mode,market:scope.market});previousLabel=`${ps} → ${pe}`;}
    return {all,current,previous,previousLabel};
  };

  const insightRows=r=>{
    const c=r.current,p=r.previous,out=[];
    const add=(tone,title,detail)=>out.push(`<div class="txFinInsight ${tone}"><div><b>${esc(title)}</b><span>${esc(detail)}</span></div></div>`);
    if(c.costCoverage<.9)add(c.costCoverage>0?'warn':'bad','采购成本覆盖不足',`当前仅 ${pct(c.costCoverage)} 的发货件数匹配成本库；未匹配SKU不会虚构采购成本。`);
    else if(c.finalNetMargin<.05)add('bad','预估净利率偏低',`扣除采购及头程成本后仅 ${pct(c.finalNetMargin)}，需要优先压缩广告、退款与FBA费用。`);
    else if(c.finalNetMargin<.15)add('warn','预估净利率一般',`当前 ${pct(c.finalNetMargin)}，扩量前应确认边际利润。`);
    else add('good','预估净利润健康',`预估净利率 ${pct(c.finalNetMargin)}，采购成本覆盖 ${pct(c.costCoverage)}。`);
    if(c.refundSalesRate>=.08)add('bad','退款压力高',`退款商品额占销售 ${pct(c.refundSalesRate)}，件数退款率 ${pct(c.returnRate)}。`);
    else if(c.refundSalesRate>=.04)add('warn','退款值得跟踪',`销售退款率 ${pct(c.refundSalesRate)}，建议进入退款质量页排查。`);
    else add('good','退款控制稳定',`销售退款率 ${pct(c.refundSalesRate)}。`);
    if(c.adRate>=.22)add('bad','广告占比过高',`广告扣费占净商品销售 ${pct(c.adRate)}，正在明显压缩利润。`);
    else if(c.adRate>=.14)add('warn','广告投入偏重',`广告占净销售 ${pct(c.adRate)}，需要结合Target ACOS治理。`);
    else add('good','广告占比可控',`广告占净销售 ${pct(c.adRate)}。`);
    if(c.top3Share>=.55)add('warn','SKU集中度较高',`Top 3 SKU贡献 ${pct(c.top3Share)} 的商品销售。`);
    if(p?.rows?.length){const d=delta(c.finalNetProfit,p.finalNetProfit);add(d.tone,'较上期预估净利润变化',`${d.text}，上期 ${money(p.finalNetProfit)}。`);}
    return out.slice(0,4).join('');
  };
  const topStat=(k,v,m)=>`<div class="txFinTopStat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="m">${esc(m)}</div></div>`;
  const ratioRow=(k,v,m)=>`<div class="txFinRatioRow"><div><b>${esc(k)}</b><span>${esc(m)}</span></div><strong>${esc(v)}</strong></div>`;

  const ledgerRow=(label,note,amount,ratioText,tone='')=>`<div class="txFinLedgerRow ${tone}"><div class="label"><b>${esc(label)}</b><span>${esc(note)}</span></div><div class="amount">${esc(amount)}</div><div class="ratio">${esc(ratioText)}</div></div>`;

  const renderOverview=r=>{
    const c=r.current,p=r.previous,dNet=delta(c.finalNetProfit,p?.finalNetProfit||0);
    const statement=[
      ledgerRow('商品销售','订单商品收入',money(c.orderSales),'100.00%','positive'),
      ledgerRow('退款与退款Credits','退款商品额及相关Credits',`-${money(c.refundSales+c.refundCredits)}`,pct(safeDiv(c.refundSales+c.refundCredits,c.orderSales)),'negative'),
      ledgerRow('Amazon交易费用','销售佣金、FBA、促销和其他交易费',`-${money(c.amazonTradeFees)}`,pct(c.tradeFeeRate),'negative'),
      ledgerRow('广告扣费','联合报告 Cost of Advertising',`-${money(c.advertising)}`,pct(c.adRate),'negative'),
      ledgerRow('其他运营支出','仓储、入库、服务费及负调整',`-${money(c.nonAdOperatingExpenses)}`,pct(c.nonAdRate),'negative'),
      ledgerRow('商品采购及头程成本','GitHub成本库 × 净销售件数',`-${money(c.purchaseCost)}`,`${pct(safeDiv(c.purchaseCost,c.netProductSales))} · 覆盖 ${pct(c.costCoverage)}`,'negative'),
      c.fbmShippingCost>0?ledgerRow('FBM配送成本','仅Merchant fulfilled订单',`-${money(c.fbmShippingCost)}`,pct(safeDiv(c.fbmShippingCost,c.netProductSales)),'negative'):'',
      ledgerRow('预估净利润','经营结算净额扣除商品采购、头程及FBM配送成本',money(c.finalNetProfit),pct(c.finalNetMargin),`total ${c.finalNetProfit>=0?'positive':'negative'}`)
    ].join('');
    return `<div class="txFinOverview">
      <section class="txFinStatement">
        <div class="txFinStatementHead"><div><div class="txFinKicker">Estimated net profit</div><div class="txFinStatementValue">${money(c.finalNetProfit)}</div><div class="txFinStatementSub">联合报告经营结算净额减去GitHub商品采购、头程及适用的FBM配送成本。成本覆盖 ${pct(c.costCoverage)}。</div></div><div class="txFinStatementDelta"><b>${esc(dNet.text)}</b><span>较上一等长周期</span></div></div>
        <div class="txFinLedger">${statement}</div>
      </section>
      <aside class="txFinRightRail">
        <section class="txFinRatioPanel">${ratioRow('预估净利率',pct(c.finalNetMargin),'预估净利润 ÷ 净商品销售')}${ratioRow('成本库覆盖',pct(c.costCoverage),'匹配成本的发货件数占比')}${ratioRow('销售退款率',pct(c.refundSalesRate),'退款商品额 ÷ 商品销售')}${ratioRow('Top 3销售占比',pct(c.top3Share),'SKU集中度')}</section>
        <section class="txFinInsightPanel"><div class="txFinInsightTitle">经营结论</div>${insightRows(r)}</section>
      </aside>
    </div>
    <div class="txFinChartGrid">
      <section class="txFinChartBlock"><div class="txFinSectionHead"><div><h3>每日销售与预估净利润</h3><p>同时看销售、退款、广告、经营结算和扣除采购成本后的净利润。</p></div></div><div class="txFinanceChart tall"><canvas id="txFinanceDailyChart"></canvas></div></section>
      <section class="txFinChartBlock"><div class="txFinSectionHead"><div><h3>利润桥接</h3><p>从商品销售逐层扣除退款、Amazon费用、广告和采购成本，回到预估净利润。</p></div></div><div class="txFinanceChart tall"><canvas id="txFinanceWaterfallChart"></canvas></div></section>
    </div>`;
  };
  const renderCosts=r=>{
    const c=r.current,max=window.__arrayMaxSafe(c.expense.map(x=>x.value),1);
    const rows=c.expense.map(x=>`<div class="txFinanceCostRow"><div class="txFinanceCostName"><b>${esc(x.name)}</b><span>${esc(x.note)}</span></div><div class="txFinanceCostTrack"><div class="txFinanceCostFill" style="width:${Math.min(100,x.value/max*100).toFixed(1)}%"></div></div><div class="txFinanceCostValue"><b>${money(x.value)}</b><span>${pct(x.rate)}</span></div></div>`).join('');
    const catRows=c.categories.map(x=>`<tr><td>${esc(x.label)}</td><td>${x.rows.toLocaleString()}</td><td class="${toneForSigned(x.total)}">${signedMoney(x.total)}</td><td>${pct(x.share)}</td></tr>`).join('');
    return `<div class="txFinTabHeader"><div><h3>成本结构</h3><p>同时管理Amazon费用、广告支出与GitHub商品采购成本。</p></div></div>
      <div class="txFinTopStats">${topStat('商品采购及头程',money(c.purchaseCost),`成本覆盖 ${pct(c.costCoverage)}`)}${topStat('预估净利润',money(c.finalNetProfit),`净利率 ${pct(c.finalNetMargin)}`)}${topStat('Amazon交易费用率',pct(c.tradeFeeRate),money(c.amazonTradeFees))}${topStat('综合支出率',pct(c.expenseLoad),'含采购成本')}</div>
      <div class="txFinAnalyticGrid"><section class="txFinPanel"><h4>成本项目强度</h4><div class="lead">横条按金额缩放，右侧展示金额和占净商品销售比例。</div><div class="txFinanceCostRows">${rows}</div></section><section class="txFinPanel"><h4>支出构成</h4><div class="lead">采购成本与Amazon费用统一展示，Transfer不计入经营支出。</div><div class="txFinanceChart compact"><canvas id="txFinanceCostMixChart"></canvas></div></section></div>
      <section class="txFinPanel" style="margin-top:22px"><h4>交易类别结算影响</h4><div class="lead">按标准化交易类别汇总；采购成本来自独立GitHub成本库，不属于Amazon交易类别。</div><div class="txFinanceTableWrap"><table class="txFinanceTable"><thead><tr><th>类别</th><th>交易行数</th><th>结算影响</th><th>占经营结算</th></tr></thead><tbody>${catRows}</tbody></table></div></section>`;
  };
  const renderRefunds=r=>{
    const c=r.current,refundSkuAll=[...c.sku].filter(x=>x.refund>0).sort((a,b)=>b.refund-a.refund),refundSku=refundSkuAll.slice(0,30);
    const rows=refundSku.map(x=>`<tr><td>${esc(x.sku)}</td><td>${x.units.toLocaleString()}</td><td>${x.refundUnits.toLocaleString()}</td><td>${money(x.sales)}</td><td>${money(x.refund)}</td><td>${pct(x.refundRate)}</td><td class="${x.net<0?'bad':'good'}">${signedMoney(x.net)}</td><td>${pct(x.netRate)}</td></tr>`).join('');
    return `<div class="txFinTabHeader"><div><h3>退款质量</h3><p>同时看退款金额、退款率和退款后经营沉淀。</p></div></div>
      <div class="txFinTopStats">${topStat('退款商品额',money(c.refundSales),`占销售 ${pct(c.refundSalesRate)}`)}${topStat('退款件数',c.refundUnits.toLocaleString(),`件数退款率 ${pct(c.returnRate)}`)}${topStat('退款税前净损失',money(c.refundPreTaxLoss),`占销售 ${pct(c.refundLossRate)}`)}${topStat('有退款SKU',refundSkuAll.length.toLocaleString(),'本期出现退款的SKU')}</div>
      <div class="txFinAnalyticGrid"><section class="txFinPanel"><h4>每日退款率与净结算率</h4><div class="lead">识别退款集中爆发日期以及对结算率的影响。</div><div class="txFinanceChart"><canvas id="txFinanceRefundTrendChart"></canvas></div></section><section class="txFinPanel"><h4>退款金额最高SKU</h4><div class="lead">优先处理高销售且高退款的SKU。</div><div class="txFinanceChart"><canvas id="txFinanceRefundSkuChart"></canvas></div></section></div>
      <section class="txFinPanel" style="margin-top:22px"><h4>退款SKU明细</h4><div class="txFinanceTableWrap"><table class="txFinanceTable"><thead><tr><th>SKU</th><th>发货件数</th><th>退款件数</th><th>销售</th><th>退款</th><th>退款率</th><th>净结算</th><th>净结算率</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  };

  const renderSku=r=>{
    const c=r.current,rows=c.sku.slice(0,200).map(x=>`<tr><td>${esc(x.sku)}</td><td>${x.units.toLocaleString()}</td><td>${x.refundUnits.toLocaleString()}</td><td>${x.netUnits.toLocaleString()}</td><td>${money(x.sales)}</td><td>${money(x.unitCost)}</td><td>${money(x.purchaseCost+x.fbmShippingCost)}</td><td>${pct(x.refundRate)}</td><td class="${x.finalNet<0?'bad':'good'}">${signedMoney(x.finalNet)}</td><td>${pct(x.finalNetRate)}</td><td>${x.costMatched?'已匹配':'未匹配'}</td></tr>`).join('');
    const top=c.sku[0],low=[...c.sku].filter(x=>x.sales>0).sort((a,b)=>a.finalNetRate-b.finalNetRate)[0];
    return `<div class="txFinTabHeader"><div><h3>SKU表现</h3><p>把销售、退款、Amazon费用、商品采购成本与预估净利润放到同一张SKU视图。</p></div></div>
      <div class="txFinTopStats">${topStat('SKU数量',c.skuCount.toLocaleString(),'本期有交易SKU')}${topStat('成本覆盖',pct(c.costCoverage),`${c.costMatchedOrderUnits.toLocaleString()} 件已匹配`)}${topStat('Top 3销售占比',pct(c.top3Share),'SKU集中度')}${topStat('最低预估净利率SKU',low?pct(low.finalNetRate):'—',low?.sku||'—')}</div>
      <div class="txFinAnalyticGrid"><section class="txFinPanel"><h4>Top SKU销售与预估净利润</h4><div class="lead">识别高销售但扣除采购成本后利润不足的SKU。</div><div class="txFinanceChart"><canvas id="txFinanceSkuBarChart"></canvas></div></section><section class="txFinPanel"><h4>销售规模与预估净利率</h4><div class="lead">气泡大小代表发货件数；未匹配成本的SKU应先补齐成本库。</div><div class="txFinanceChart"><canvas id="txFinanceSkuBubbleChart"></canvas></div></section></div>
      <section class="txFinPanel" style="margin-top:22px"><h4>SKU财务明细</h4><div class="txFinanceTableWrap"><table class="txFinanceTable"><thead><tr><th>SKU</th><th>发货件数</th><th>退款件数</th><th>净销售件数</th><th>销售</th><th>采购及头程/件</th><th>商品成本</th><th>退款率</th><th>预估净利润</th><th>预估净利率</th><th>成本状态</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  };
  const renderBody=r=>{
    const body=byId('transactionFinanceBody');if(!body)return;
    const c=r.current;
    if(!r.all.length){body.innerHTML='<div class="txFinanceEmpty"><b>尚未导入联合交易报告</b><br>请先导入 Amazon 联合报告（交易），再生成财务报表。</div>';return;}
    if(!c.rows.length){body.innerHTML='<div class="txFinanceEmpty"><b>当前日期范围没有联合交易记录</b><br>请调整左侧日期，确保与联合报告 Posted Date 重叠。</div>';return;}
    body.innerHTML=`<section class="txFinancePanel ${activeTab==='overview'?'active':''}" data-tx-panel="overview">${renderOverview(r)}</section><section class="txFinancePanel ${activeTab==='costs'?'active':''}" data-tx-panel="costs">${renderCosts(r)}</section><section class="txFinancePanel ${activeTab==='refunds'?'active':''}" data-tx-panel="refunds">${renderRefunds(r)}</section><section class="txFinancePanel ${activeTab==='sku'?'active':''}" data-tx-panel="sku">${renderSku(r)}</section><div class="txFinanceFootnote"><b>口径说明：</b>经营结算净额使用联合报告非Transfer交易Total；预估净利润在此基础上扣除GitHub成本库中的采购、头程及适用的FBM配送成本。成本库未匹配的SKU不虚构成本，请结合成本覆盖率判断结果完整性。Cost of Advertising只使用联合报告扣费，不与广告报表花费重复扣除。</div>`;
  };

  const chartTheme=()=>{const s=getComputedStyle(document.documentElement);return {text:s.getPropertyValue('--text').trim()||'#1d1d1f',muted:s.getPropertyValue('--muted').trim()||'#6e6e73',grid:s.getPropertyValue('--chart-grid').trim()||'rgba(0,0,0,.08)',accent:s.getPropertyValue('--accent').trim()||'#2563eb',good:s.getPropertyValue('--good').trim()||'#16a34a',bad:s.getPropertyValue('--bad').trim()||'#dc2626',warn:s.getPropertyValue('--warn').trim()||'#d97706',line:s.getPropertyValue('--line').trim()||'#e5e7eb'};};
  const baseOptions=(indexAxis='x')=>{const t=chartTheme();return {responsive:true,maintainAspectRatio:false,indexAxis,interaction:{mode:'index',intersect:false},plugins:{legend:{labels:{boxWidth:10,usePointStyle:true,color:t.text,font:{size:10}}},tooltip:{backgroundColor:'rgba(15,23,42,.92)',titleFont:{size:11},bodyFont:{size:10},padding:10}},scales:{x:{grid:{color:indexAxis==='x'?t.grid:'transparent'},ticks:{color:t.muted,font:{size:9.5}}},y:{grid:{color:indexAxis==='x'?t.grid:'transparent'},ticks:{color:t.muted,font:{size:9.5}}}}};};
  const renderChartsForTab=(tab,r)=>{
    if(!window.Chart||!r?.current?.rows?.length)return;
    const c=r.current,t=chartTheme();
    destroyCharts(tab);
    if(tab==='overview'){
      const wf=byId('txFinanceWaterfallChart');
      if(wf){chartBag.overviewWaterfall=new Chart(wf,{type:'bar',data:{labels:c.waterfall.map(x=>x.name),datasets:[{label:'利润桥接',data:c.waterfall.map(x=>[x.start,x.end]),backgroundColor:c.waterfall.map(x=>x.total?t.accent:x.change>=0?t.good:t.bad),borderRadius:5,borderSkipped:false}]},options:{...baseOptions(),plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>{const x=c.waterfall[ctx.dataIndex];return `${x.name}: ${signedMoney(x.total?x.end:x.change)} · 余额 ${money(x.end)}`;}}}},scales:{x:{grid:{display:false},ticks:{color:t.muted,font:{size:9},maxRotation:0,autoSkip:false}},y:{grid:{color:t.grid},ticks:{color:t.muted,callback:v=>money(v)}}}}});}
      const daily=byId('txFinanceDailyChart');
      if(daily){chartBag.overviewDaily=new Chart(daily,{data:{labels:c.daily.map(x=>x.date),datasets:[{type:'line',label:'商品销售',data:c.daily.map(x=>x.sales),borderColor:t.accent,backgroundColor:t.accent,tension:.28,pointRadius:1.5},{type:'line',label:'预估净利润',data:c.daily.map(x=>x.finalNet),borderColor:t.good,backgroundColor:t.good,tension:.28,pointRadius:1.5},{type:'bar',label:'退款',data:c.daily.map(x=>x.refund),backgroundColor:`${t.bad}55`,borderRadius:3},{type:'bar',label:'广告',data:c.daily.map(x=>x.ads),backgroundColor:`${t.warn}55`,borderRadius:3}]},options:{...baseOptions(),scales:{x:{grid:{display:false},ticks:{color:t.muted,maxTicksLimit:15,maxRotation:0}},y:{grid:{color:t.grid},ticks:{color:t.muted,callback:v=>money(v)}}}}});}
    } else if(tab==='costs'){
      const ctx=byId('txFinanceCostMixChart');if(ctx){const vals=c.expense.map(x=>x.value);chartBag.costsMix=new Chart(ctx,{type:'doughnut',data:{labels:c.expense.map(x=>x.name),datasets:[{data:vals,borderWidth:0,hoverOffset:5}]},options:{responsive:true,maintainAspectRatio:false,cutout:'66%',plugins:{legend:{position:'bottom',labels:{boxWidth:9,usePointStyle:true,color:t.text,font:{size:9}}},tooltip:{callbacks:{label:x=>`${x.label}: ${money(x.parsed)} · ${pct(safeDiv(x.parsed,vals.reduce((a,b)=>a+b,0)))}`}}}}});}
    } else if(tab==='refunds'){
      const trend=byId('txFinanceRefundTrendChart');if(trend){chartBag.refundsTrend=new Chart(trend,{type:'line',data:{labels:c.daily.map(x=>x.date),datasets:[{label:'每日退款率',data:c.daily.map(x=>x.refundRate),borderColor:t.bad,backgroundColor:`${t.bad}22`,fill:true,tension:.3,pointRadius:2},{label:'每日预估净利率',data:c.daily.map(x=>x.finalNetRate),borderColor:t.good,backgroundColor:t.good,tension:.3,pointRadius:1.5}]},options:{...baseOptions(),scales:{x:{grid:{display:false},ticks:{color:t.muted,maxTicksLimit:14,maxRotation:0}},y:{grid:{color:t.grid},ticks:{color:t.muted,callback:v=>pct(v)}}}}});}
      const refundSku=c.sku.filter(x=>x.refund>0).sort((a,b)=>b.refund-a.refund).slice(0,12),ctx=byId('txFinanceRefundSkuChart');if(ctx){chartBag.refundsSku=new Chart(ctx,{type:'bar',data:{labels:refundSku.map(x=>x.sku),datasets:[{label:'退款金额',data:refundSku.map(x=>x.refund),backgroundColor:`${t.bad}AA`,borderRadius:4},{label:'商品销售',data:refundSku.map(x=>x.sales),backgroundColor:`${t.accent}55`,borderRadius:4}]},options:{...baseOptions('y'),scales:{x:{grid:{color:t.grid},ticks:{color:t.muted,callback:v=>money(v)}},y:{grid:{display:false},ticks:{color:t.muted}}}}});}
    } else if(tab==='sku'){
      const top=c.sku.slice(0,12),bar=byId('txFinanceSkuBarChart');if(bar){chartBag.skuBar=new Chart(bar,{type:'bar',data:{labels:top.map(x=>x.sku),datasets:[{label:'商品销售',data:top.map(x=>x.sales),backgroundColor:`${t.accent}AA`,borderRadius:4},{label:'预估净利润',data:top.map(x=>x.finalNet),backgroundColor:`${t.good}AA`,borderRadius:4}]},options:{...baseOptions('y'),scales:{x:{grid:{color:t.grid},ticks:{color:t.muted,callback:v=>money(v)}},y:{grid:{display:false},ticks:{color:t.muted}}}}});}
      const bubble=byId('txFinanceSkuBubbleChart'),points=c.sku.filter(x=>x.sales>0).slice(0,80).map(x=>({x:x.sales,y:x.finalNetRate,r:Math.max(3,Math.min(14,Math.sqrt(Math.max(x.units,1)))) ,sku:x.sku,refundRate:x.refundRate}));if(bubble){chartBag.skuBubble=new Chart(bubble,{type:'bubble',data:{datasets:[{label:'SKU',data:points,backgroundColor:points.map(x=>x.y>=.2?`${t.good}88`:x.y>=0?`${t.warn}88`:`${t.bad}88`),borderWidth:0}]},options:{...baseOptions(),plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>{const p=ctx.raw;return `${p.sku} · 销售 ${money(p.x)} · 预估净利率 ${pct(p.y)} · 退款率 ${pct(p.refundRate)}`;}}}},scales:{x:{grid:{color:t.grid},title:{display:true,text:'商品销售',color:t.muted},ticks:{color:t.muted,callback:v=>money(v)}},y:{grid:{color:t.grid},title:{display:true,text:'预估净利率',color:t.muted},ticks:{color:t.muted,callback:v=>pct(v)}}}}});}
    }
  };

  const switchTab=tab=>{
    activeTab=tab||'overview';
    document.querySelectorAll('#transactionFinanceModal [data-tx-tab]').forEach(b=>b.classList.toggle('active',b.dataset.txTab===activeTab));
    document.querySelectorAll('#transactionFinanceModal [data-tx-panel]').forEach(p=>p.classList.toggle('active',p.dataset.txPanel===activeTab));
    requestAnimationFrame(()=>renderChartsForTab(activeTab,lastReport));
  };
  const renderReport=()=>{
    const body=byId('transactionFinanceBody');if(!body)return;
    destroyCharts();
    const r=buildReport();lastReport=r;
    const c=r.current,mode=c.mode==='cash'?'现金口径 · Released':'权责口径 · Released + Deferred';
    byId('transactionFinanceHeaderMeta').innerHTML=`<span class="txFinanceHeaderPill"><strong>${esc(c.start||'最早')}</strong> → <strong>${esc(c.end||'最新')}</strong></span><span class="txFinanceHeaderPill">${esc(c.market||'ALL')}</span><span class="txFinanceHeaderPill">${esc(mode)}</span><span class="txFinanceHeaderPill">对比：${esc(r.previousLabel)}</span>`;
    byId('transactionFinanceTabMeta').textContent=`${c.rows.length.toLocaleString()} 条交易 · ${c.skuCount.toLocaleString()} SKU · 成本覆盖 ${pct(c.costCoverage)} · Posted Date`;
    renderBody(r);
    switchTab(activeTab);
  };

  const downloadBlob=(blob,filename)=>{
    if(typeof window.saveAs==='function'){window.saveAs(blob,filename);return;}
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.style.display='none';document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(url);a.remove();},1200);
  };
  const cleanSheetName=name=>String(name||'Sheet').slice(0,31).replace(/[\\/?*\[\]:]/g,'_')||'Sheet';
  const normalizeCell=v=>{
    if(v===null||v===undefined||v===''||(typeof v==='number'&&!Number.isFinite(v)))return '';
    if(v instanceof Date)return v.toISOString();
    if(typeof v==='object'){try{return JSON.stringify(v);}catch(e){return String(v);}}
    return v;
  };
  const exportViaSheetJS=(sheets,filename)=>{
    if(!window.XLSX?.utils?.book_new)return false;
    const wb=window.XLSX.utils.book_new();
    for(const s of sheets){
      const aoa=[(s.headers||[]).map(normalizeCell),...(s.dataRows||[]).map(row=>(row||[]).map(normalizeCell))];
      const ws=window.XLSX.utils.aoa_to_sheet(aoa);
      if(aoa.length&&aoa[0].length){ws['!autofilter']={ref:window.XLSX.utils.encode_range({s:{r:0,c:0},e:{r:Math.max(0,aoa.length-1),c:aoa[0].length-1}})};ws['!freeze']={xSplit:0,ySplit:1};}
      const widths=(s.headers||[]).map((h,i)=>{let max=String(h??'').length;for(const row of (s.dataRows||[]).slice(0,2000))max=Math.max(max,String(normalizeCell(row?.[i])).length);return{wch:Math.min(50,Math.max(10,max+2))};});
      ws['!cols']=widths;
      window.XLSX.utils.book_append_sheet(wb,ws,cleanSheetName(s.sheetName));
    }
    window.XLSX.writeFile(wb,filename,{compression:true});
    return true;
  };
  const exportViaExcelJS=async(sheets,filename)=>{
    if(!window.ExcelJS?.Workbook)return false;
    const wb=new window.ExcelJS.Workbook();wb.creator='Ads Operations Integrity OS';wb.created=new Date();
    for(const s of sheets){
      const ws=wb.addWorksheet(cleanSheetName(s.sheetName),{views:[{state:'frozen',ySplit:1}]});
      const headers=(s.headers||[]).map(normalizeCell);const hr=ws.addRow(headers);hr.font={bold:true,color:{argb:'FFFFFFFF'}};hr.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF1F2937'}};hr.alignment={vertical:'middle'};
      if(headers.length)ws.autoFilter={from:{row:1,column:1},to:{row:1,column:headers.length}};
      for(const row of (s.dataRows||[]))ws.addRow((row||[]).map(normalizeCell));
      ws.columns.forEach((col,i)=>{let max=String(headers[i]??'').length;col.eachCell({includeEmpty:false},cell=>{max=Math.max(max,String(cell.value??'').length);});col.width=Math.min(50,Math.max(10,max+2));});
    }
    const buffer=await wb.xlsx.writeBuffer();downloadBlob(new Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),filename);return true;
  };
  const csvEscape=v=>{const s=String(normalizeCell(v));return /[",\n\r]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;};
  const exportCsvFallback=(sheets,filename)=>{
    const parts=[];for(const s of sheets){parts.push(`# ${s.sheetName}`);parts.push((s.headers||[]).map(csvEscape).join(','));for(const row of (s.dataRows||[]))parts.push((row||[]).map(csvEscape).join(','));parts.push('');}
    const csv='\uFEFF'+parts.join('\r\n');downloadBlob(new Blob([csv],{type:'text/csv;charset=utf-8'}),filename.replace(/\.xlsx$/i,'_fallback.csv'));
  };
  const exportFinanceWorkbook=async(sheets,filename)=>{
    const globalExporter=typeof window.exportRichExcelMultiSheet==='function'?window.exportRichExcelMultiSheet:null;
    if(globalExporter){try{await globalExporter(sheets,filename);return'RICH_EXCEL';}catch(e){console.warn('Rich Excel export failed; falling back.',e);}}
    try{if(exportViaSheetJS(sheets,filename))return'SHEETJS';}catch(e){console.warn('SheetJS export failed; falling back.',e);}
    try{if(await exportViaExcelJS(sheets,filename))return'EXCELJS';}catch(e){console.warn('ExcelJS export failed; falling back.',e);}
    exportCsvFallback(sheets,filename);return'CSV';
  };

  const exportReport=async()=>{
    const r=buildReport(),c=r.current;if(!c.rows.length){try{notify('当前日期范围没有联合交易数据。','warn');}catch(e){alert('当前日期范围没有联合交易数据。');}return;}
    const summary=[['日期开始',c.start],['日期结束',c.end],['站点',c.market||'ALL'],['交易口径',c.mode],['交易行数',c.rows.length],['订单数',c.orderCount],['SKU数',c.skuCount],['商品销售',c.orderSales],['退款商品额',c.refundSales],['净商品销售',c.netProductSales],['销售退款率',c.refundSalesRate],['件数退款率',c.returnRate],['交易费用',c.amazonTradeFees],['交易费用率',c.tradeFeeRate],['广告扣费',c.advertising],['广告占比',c.adRate],['非广告运营支出',c.nonAdOperatingExpenses],['商品采购及头程成本',c.purchaseCost],['FBM配送成本',c.fbmShippingCost],['成本库覆盖率',c.costCoverage],['经营结算净额',c.operatingSettlement],['预估净利润',c.finalNetProfit],['预估净利率',c.finalNetMargin],['Transfer',c.transfer],['结算总额',c.settlementTotal]];
    const expenses=c.expense.map(x=>[x.name,x.value,x.rate,x.note]);
    const daily=c.daily.map(x=>[x.date,x.rows,x.sales,x.refund,x.fees,x.ads,x.productCost,x.refundRate,x.net,x.finalNet,x.finalNetRate,x.costCoverage]);
    const sku=c.sku.slice(0,500).map(x=>[x.sku,x.costAsin,x.units,x.refundUnits,x.netUnits,x.sales,x.refund,x.fees,x.unitCost,x.purchaseCost,x.fbmShippingCost,x.refundRate,x.finalNet,x.finalNetRate,x.costMatched?'已匹配':'未匹配',x.costUpdatedAt]);
    const cats=c.categories.map(x=>[x.label,x.category,x.rows,x.total,x.share]);
    const ts=(typeof getTs==='function'?getTs():new Date().toISOString().replace(/[:.]/g,'-'));
    const sheets=[{sheetName:'财务摘要',headers:['指标','数值'],dataRows:summary},{sheetName:'成本结构',headers:['成本项目','金额','占净销售比例','口径'],dataRows:expenses},{sheetName:'每日明细',headers:['日期','交易行数','销售','退款','交易费用','广告扣费','商品成本','退款率','经营结算','预估净利润','预估净利率','成本覆盖'],dataRows:daily},{sheetName:'SKU明细',headers:['SKU','ASIN','发货件数','退款件数','净销售件数','销售','退款','交易费用','采购及头程/件','商品成本','FBM配送成本','退款率','预估净利润','预估净利率','成本状态','成本更新日期'],dataRows:sku},{sheetName:'交易类别',headers:['类别','代码','行数','结算影响','占经营结算'],dataRows:cats}];
    const filename=`Transaction_Finance_Report_${c.start||'start'}_${c.end||'end'}_${ts}.xlsx`;
    const btn=byId('btnExportTransactionFinance'),oldText=btn?.textContent;try{if(btn){btn.disabled=true;btn.textContent='正在导出…';}const method=await exportFinanceWorkbook(sheets,filename);const msg=method==='CSV'?'Excel库不可用，已自动导出兼容CSV。':'交易财务报表已导出。';try{notify(msg,method==='CSV'?'warn':'good');}catch(e){console.info(msg);}}catch(err){console.error(err);alert(`导出失败：${err?.message||err}`);}finally{if(btn){btn.disabled=false;btn.textContent=oldText||'导出 Excel';}}
  };
  const openModal=()=>{const m=ensureModal();m.style.display='flex';renderReport();setTimeout(()=>byId('btnCloseTransactionFinance')?.focus(),0);};
  const init=()=>{
    ensureModal();
    byId('btnTransactionFinanceReport')?.addEventListener('click',openModal);
    ['dateStart','dateEnd','transactionStatusMode'].forEach(id=>byId(id)?.addEventListener('change',()=>{const m=byId('transactionFinanceModal');if(m&&m.style.display!=='none')setTimeout(renderReport,260);}));
    document.addEventListener('keydown',e=>{if(e.key==='Escape'&&byId('transactionFinanceModal')?.style.display==='flex')closeModal();});
    window.TransactionFinanceReport={open:openModal,render:renderReport,build:buildReport,export:exportReport,switchTab};
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
