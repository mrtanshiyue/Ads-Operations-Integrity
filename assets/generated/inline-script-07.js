(() => {
  const $u = id => document.getElementById(id);
  const showPanel = (name, persist=true) => {
    const decision = name !== 'execution';
    const decisionPanel=$u('unifiedDecisionPanel'), executionPanel=$u('unifiedExecutionPanel');
    const decisionTab=$u('unifiedDecisionTab'), executionTab=$u('unifiedExecutionTab');
    if(!decisionPanel||!executionPanel)return;
    decisionPanel.hidden=!decision; executionPanel.hidden=decision;
    decisionPanel.classList.toggle('active',decision); executionPanel.classList.toggle('active',!decision);
    decisionTab?.classList.toggle('active',decision); executionTab?.classList.toggle('active',!decision);
    decisionTab?.setAttribute('aria-selected',String(decision)); executionTab?.setAttribute('aria-selected',String(!decision));
    decisionTab && (decisionTab.tabIndex=decision?0:-1); executionTab && (executionTab.tabIndex=decision?-1:0);
    if(persist){try{localStorage.setItem('unified_decision_panel_v59',decision?'decision':'execution');}catch(e){}}
    if(!decision && typeof renderCentralDecisionRegistry==='function') renderCentralDecisionRegistry();
  };
  window.unifiedDecisionHubShow=showPanel;
  const init = () => {
    document.documentElement.dataset.visualVersion='60';
    document.body.classList.add('final-workspace-v60');
    const saved=(()=>{try{return localStorage.getItem('unified_decision_panel_v59')||localStorage.getItem('unified_decision_panel_v58')||'decision';}catch(e){return 'decision';}})();
    showPanel(saved,false);
    $u('unifiedHubTabs')?.addEventListener('click',e=>{const btn=e.target.closest?.('[data-unified-panel]');if(btn)showPanel(btn.dataset.unifiedPanel);});
    $u('unifiedHubTabs')?.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;const tabs=[$u('unifiedDecisionTab'),$u('unifiedExecutionTab')].filter(Boolean),i=tabs.indexOf(document.activeElement);if(i<0)return;e.preventDefault();const n=e.key==='Home'?0:e.key==='End'?tabs.length-1:e.key==='ArrowRight'?(i+1)%tabs.length:(i-1+tabs.length)%tabs.length;tabs[n].focus();tabs[n].click();});
    $u('btnCentralSelectReady')?.addEventListener('click',()=>setTimeout(()=>showPanel('execution'),0));
    $u('btnActionExportSelected')?.addEventListener('click',()=>setTimeout(()=>showPanel('execution'),40));
    $u('btnExportActionBulk')?.addEventListener('click',()=>setTimeout(()=>showPanel('execution'),40));
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
