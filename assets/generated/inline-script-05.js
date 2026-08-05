(() => {
  const titles = [
    '01 · 数据接入',
    '02 · 工作区与产品画像',
    '03 · 筛选与流量范围',
    '04 · 榜单分析范围',
    '05 · 利润与决策规则',
    '06 · 系统操作',
    '07 · 导入日志'
  ];
  document.querySelectorAll('.sidebar > .fieldGroup').forEach((group, i) => {
    group.dataset.sectionTitle = titles[i] || `配置模块 ${String(i + 1).padStart(2, '0')}`;
  });
  document.querySelectorAll('.sidebarNav a').forEach(link => {
    link.addEventListener('click', () => {
      document.querySelectorAll('.sidebarNav a').forEach(x => x.removeAttribute('data-active'));
      link.setAttribute('data-active', 'true');
    });
  });
})();
