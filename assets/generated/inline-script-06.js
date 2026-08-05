(() => {
  const qs = (s, root=document) => root.querySelector(s);
  const qsa = (s, root=document) => [...root.querySelectorAll(s)];
  const safeStore = {
    get(k,d=''){ try { return localStorage.getItem(k) ?? d; } catch(e) { return d; } },
    set(k,v){ try { localStorage.setItem(k,v); } catch(e) {} }
  };
  const initShell = () => {
    document.documentElement.dataset.visualVersion = '60';
    document.body.classList.add('final-workspace-v60');
    const actions = qs('.header .actions');
    if (actions && !qs('#workspaceSidebarToggle')) {
      const btn = document.createElement('button');
      btn.id='workspaceSidebarToggle'; btn.type='button'; btn.className='btn'; btn.textContent='☰';
      btn.setAttribute('aria-controls','workspaceSidebar'); btn.setAttribute('aria-expanded','false');
      actions.insertBefore(btn, actions.firstChild);
      const sidebar=qs('.sidebar'); if(sidebar) sidebar.id='workspaceSidebar';
      const backdrop=document.createElement('div'); backdrop.className='sidebarBackdrop'; backdrop.setAttribute('aria-hidden','true'); document.body.appendChild(backdrop);
      const sync = () => {
        const narrow=matchMedia('(max-width:1180px)').matches;
        const open=narrow ? document.body.classList.contains('sidebar-drawer-open') : !document.body.classList.contains('sidebar-collapsed');
        btn.setAttribute('aria-expanded', String(open));
        btn.title=narrow?(open?'关闭筛选栏':'打开筛选栏'):(open?'收起筛选栏':'展开筛选栏');
        backdrop.classList.toggle('show', narrow && open);
      };
      if (!matchMedia('(max-width:1180px)').matches && safeStore.get('workspace_sidebar_collapsed')==='1') document.body.classList.add('sidebar-collapsed');
      btn.addEventListener('click',()=>{
        if(matchMedia('(max-width:1180px)').matches) document.body.classList.toggle('sidebar-drawer-open');
        else { document.body.classList.toggle('sidebar-collapsed'); safeStore.set('workspace_sidebar_collapsed',document.body.classList.contains('sidebar-collapsed')?'1':'0'); }
        sync(); setTimeout(()=>dispatchEvent(new Event('resize')),220);
      });
      backdrop.addEventListener('click',()=>{document.body.classList.remove('sidebar-drawer-open');sync();});
      addEventListener('resize',()=>{if(!matchMedia('(max-width:1180px)').matches)document.body.classList.remove('sidebar-drawer-open');sync();},{passive:true}); sync();
    }
    if (!qs('.backTopButton')) {
      const top=document.createElement('button'); top.type='button'; top.className='backTopButton'; top.textContent='↑'; top.title='返回顶部'; top.setAttribute('aria-label','返回顶部'); document.body.appendChild(top);
      top.addEventListener('click',()=>scrollTo({top:0,behavior:'smooth'}));
      const sync=()=>top.classList.toggle('show',scrollY>650); addEventListener('scroll',sync,{passive:true}); sync();
    }
    qsa('.sidebar > .fieldGroup').forEach((group,i)=>{
      if(qs('.fieldGroupToggle',group)) return;
      const btn=document.createElement('button'); btn.type='button'; btn.className='fieldGroupToggle';
      const key=`workspace_group_${i}`; const defaultCollapsed=[1,3,4,5,6,8].includes(i); const collapsed=safeStore.get(key,defaultCollapsed?'1':'0')==='1';
      group.classList.toggle('collapsed',collapsed); btn.textContent=collapsed?'展开':'收起'; btn.setAttribute('aria-expanded',String(!collapsed));
      btn.addEventListener('click',()=>{const next=!group.classList.contains('collapsed');group.classList.toggle('collapsed',next);btn.textContent=next?'展开':'收起';btn.setAttribute('aria-expanded',String(!next));safeStore.set(key,next?'1':'0');});
      group.insertBefore(btn,group.firstChild);
    });
    qs('#btnEmptyImport')?.addEventListener('click',()=>qs('#fileInput')?.click());
    qs('#btnCloseOpsUtility')?.addEventListener('click',()=>{const m=qs('#opsUtilityModal');if(m)m.style.display='none';});
    qsa('.sidebarNav a').forEach(link=>link.addEventListener('click',e=>{if(link.getAttribute('aria-disabled')==='true'){e.preventDefault();return;}if(matchMedia('(max-width:1180px)').matches){document.body.classList.remove('sidebar-drawer-open');qs('.sidebarBackdrop')?.classList.remove('show');}}));
  };
  const initDependencies = () => {
    const status=qs('#brandStatus');
    let banner=qs('#dependencyBanner');
    if(!banner){banner=document.createElement('div');banner.id='dependencyBanner';banner.className='dependencyBanner';banner.setAttribute('role','alert');qs('.header')?.insertAdjacentElement('afterend',banner);}
    const nativeDownload=typeof Blob!=="undefined"&&typeof URL?.createObjectURL==="function"&&"download" in HTMLAnchorElement.prototype;
    const deps={CSV:!!window.Papa,ExcelImport:!!window.XLSX,Charts:!!window.Chart,ExcelExport:!!window.ExcelJS,FileSave:!!window.saveAs,Persistence:!!window.idbKeyval};
    const missing=Object.entries(deps).filter(([,ok])=>!ok).map(([k])=>k);
    const importReady=Boolean(deps.CSV||deps.ExcelImport),critical=!importReady,exportReady=Boolean(window.ExcelJS?.Workbook||window.XLSX?.utils?.book_new),saveReady=Boolean(window.saveAs||nativeDownload);
    if(!missing.length){if(status){status.textContent='系统就绪 · 本地数据处理';status.classList.remove('dependency-warn','dependency-bad');}banner.classList.remove('show','bad');return;}
    const limitations=[];
    if(!deps.CSV)limitations.push('CSV 导入不可用');
    if(!deps.ExcelImport)limitations.push('Excel 导入不可用');
    if(!deps.Charts)limitations.push('图表不可用');
    if(!deps.Persistence)limitations.push('持久化缓存不可用');
    if(!deps.ExcelExport&&exportReady)limitations.push('已启用 SheetJS 兼容导出');
    if(!deps.FileSave&&saveReady)limitations.push('已启用浏览器原生下载');
    if(!exportReady||!saveReady)limitations.push('Excel 导出不可用');
    if(status){status.textContent=`${critical?'核心依赖异常':'兼容模式'} · 缺少 ${missing.length} 项`;status.classList.toggle('dependency-bad',critical);status.classList.toggle('dependency-warn',!critical);}
    banner.classList.add('show');banner.classList.toggle('bad',critical);banner.innerHTML=`<b>${critical?'文件导入能力不可用':'兼容模式已启用'}</b><span>缺少：${missing.join('、')}。${limitations.join('；')}。${critical?'请检查网络或 CDN 访问。':'现有可用能力继续运行，只有对应功能受限。'}</span>`;
    if(!exportReady||!saveReady) qsa('[id*="Export"], [data-i18n*="export"]').forEach(btn=>{if(btn.tagName==='BUTTON'){btn.disabled=true;btn.title='导出依赖与浏览器下载能力均不可用';}});
    if(!deps.Charts) qsa('canvas').forEach(c=>{c.setAttribute('aria-label','图表依赖未加载');c.style.display='none';});
    if(!deps.CSV&&!deps.ExcelImport){const fi=qs('#fileInput');if(fi){fi.disabled=true;fi.title='文件解析依赖未加载';}}
  };
  const initA11y = () => {
    qsa('[role="tablist"]').forEach(list=>{
      const tabs=qsa('button',list); tabs.forEach((tab,i)=>{tab.setAttribute('role','tab');const active=tab.classList.contains('active');tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;tab.addEventListener('click',()=>tabs.forEach(x=>{const on=x===tab;x.setAttribute('aria-selected',String(on));x.tabIndex=on?0:-1;}));});
      list.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;const current=tabs.indexOf(document.activeElement);if(current<0)return;e.preventDefault();let n=e.key==='Home'?0:e.key==='End'?tabs.length-1:e.key==='ArrowRight'?(current+1)%tabs.length:(current-1+tabs.length)%tabs.length;tabs[n].focus();tabs[n].click();});
    });
    qsa('thead th[data-sort], thead th[data-ltv5-sort], #multiDimCard thead th').forEach(th=>{th.setAttribute('role','button');th.tabIndex=0;th.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();th.click();}});});
    qsa('.table-container').forEach(x=>{if(!x.hasAttribute('tabindex'))x.tabIndex=0;});
  };
  const initNavObserver = () => {
    const links=qsa('.sidebarNav a[href^="#"]'); const targets=links.map(a=>qs(a.getAttribute('href'))).filter(Boolean);
    if(!('IntersectionObserver'in window)||!targets.length)return;
    const obs=new IntersectionObserver(entries=>{const current=entries.filter(x=>x.isIntersecting&&getComputedStyle(x.target).display!=='none').sort((a,b)=>b.intersectionRatio-a.intersectionRatio)[0];if(!current)return;links.forEach(a=>a.toggleAttribute('data-active',a.getAttribute('href')==='#'+current.target.id));},{rootMargin:'-14% 0px -72% 0px',threshold:[0,.1,.35]});targets.forEach(x=>obs.observe(x));
  };
  const init=()=>{initShell();initDependencies();initA11y();initNavObserver();document.body.classList.remove('preload');};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
