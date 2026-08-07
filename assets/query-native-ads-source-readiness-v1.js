(() => {
  'use strict';

  const INSPECTOR_VERSION = '1.0.0';
  const PREFLIGHT_VERSION = 'ads-source-preflight-v1';
  const CSV_PREFIX_BYTES = 262144;
  const MAX_XLSX_BYTES = 32 * 1024 * 1024;
  const HEADER_SCAN_ROWS = 20;
  const DIMENSION_LABELS = Object.freeze({
    targetingId: 'Targeting ID',
    targetBid: 'Bid',
    adProduct: 'Ad Product',
    advertisedAsin: 'Advertised ASIN',
    advertisedSku: 'Advertised SKU',
    purchasedAsin: 'Purchased ASIN',
    purchasedSku: 'Purchased SKU',
    targetingType: 'Targeting Type',
    matchType: 'Match Type',
    reportGranularity: 'Report Granularity',
    attributionWindowDays: 'Attribution Window',
    sourceFile: 'Source File',
  });
  const state = {
    status: 'idle',
    fileName: '',
    headerCount: 0,
    lastResult: null,
    lastError: '',
  };

  const byId = id => document.getElementById(id);
  const text = value => String(value ?? '').trim();
  const escapeHtml = value => text(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const setState = patch => Object.assign(state, patch);

  function ensureStyles() {
    if (byId('adsSourceReadinessInspectorStyles')) return;
    const style = document.createElement('style');
    style.id = 'adsSourceReadinessInspectorStyles';
    style.textContent = `
      #adsSourceReadinessInspector{display:grid;grid-template-columns:minmax(0,1fr);gap:7px;width:100%;min-width:0;padding:8px;border:1px solid color-mix(in srgb,var(--accent) 18%,var(--line));border-radius:11px;background:color-mix(in srgb,var(--accent) 3%,var(--card))}
      #adsSourceReadinessInspector .asriHead{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;min-width:0}
      #adsSourceReadinessInspector .asriTitle{font-size:11px;font-weight:800;color:var(--text)}
      #adsSourceReadinessInspector .asriSub{margin-top:2px;font-size:9.6px;line-height:1.35;color:var(--muted)}
      #adsSourceReadinessInspector .asriBtn{padding:6px 9px!important;font-size:10.2px!important;min-height:30px!important}
      #adsSourceReadinessInspector .asriGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}
      #adsSourceReadinessInspector .asriStatus{padding:6px;border-radius:9px;background:var(--chip);min-width:0}
      #adsSourceReadinessInspector .asriStatus[data-ready="1"]{background:var(--softGood);color:var(--good)}
      #adsSourceReadinessInspector .asriStatus[data-ready="0"]{background:var(--softWarn);color:var(--warn)}
      #adsSourceReadinessInspector .asriStatus b{display:block;font-size:9.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #adsSourceReadinessInspector .asriStatus span{display:block;margin-top:2px;font-size:10.3px;font-weight:800}
      #adsSourceReadinessInspector .asriResult{font-size:9.8px;line-height:1.45;color:var(--muted);overflow-wrap:anywhere;white-space:pre-line}
      #adsSourceReadinessInspector .asriResult[data-kind="bad"]{color:var(--bad)}
      #adsSourceReadinessInspector .asriResult[data-kind="warn"]{color:var(--warn)}
      #adsSourceReadinessInspector .asriResult[data-kind="good"]{color:var(--good)}
      #adsSourceReadinessInspector .asriSafety{padding-top:5px;border-top:1px solid var(--line);font-size:9.3px;line-height:1.4;color:var(--muted)}
      @media(max-width:420px){#adsSourceReadinessInspector .asriGrid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function ensureUi() {
    const panel = byId('privateCloudImportPanel');
    if (!panel) return false;
    ensureStyles();
    let root = byId('adsSourceReadinessInspector');
    if (!root) {
      root = document.createElement('div');
      root.id = 'adsSourceReadinessInspector';
      root.innerHTML = `
        <div class="asriHead">
          <div>
            <div class="asriTitle">广告报表兼容性预检</div>
            <div class="asriSub">只读取本地文件表头；文件内容不会上传。候选就绪 ≠ 生产执行解锁。</div>
          </div>
          <button class="btn asriBtn" id="btnAdsSourceReadinessInspect" type="button">选择报表</button>
        </div>
        <input id="adsSourceReadinessFile" type="file" accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" hidden>
        <div class="asriGrid" id="adsSourceReadinessGrid" hidden></div>
        <div class="asriResult" id="adsSourceReadinessResult">连接私有云后，可在正式导入新 Amazon Ads 报表前检查字段覆盖。</div>
        <div class="asriSafety">安全边界：不写入 TiDB · 不改变 current slot · 不授权 Bid Governance / Campaign Studio 执行。</div>
      `;
      const overview = byId('queryFirstOverviewCard');
      const status = byId('privateCloudImportStatus');
      panel.insertBefore(root, overview || status || null);
    }
    bindUi(root);
    return true;
  }

  function bindUi(root) {
    if (root.dataset.bound === '1') return;
    root.dataset.bound = '1';
    byId('btnAdsSourceReadinessInspect')?.addEventListener('click', () => {
      const input = byId('adsSourceReadinessFile');
      if (!input) return;
      input.value = '';
      input.click();
    });
    byId('adsSourceReadinessFile')?.addEventListener('change', event => {
      const file = event.target?.files?.[0];
      if (!file) return;
      inspectFile(file).catch(error => renderError(error));
    });
  }

  async function inspectFile(file) {
    setState({
      status: 'reading',
      fileName: text(file?.name),
      headerCount: 0,
      lastResult: null,
      lastError: '',
    });
    renderMessage(`正在读取 ${state.fileName || '本地报表'} 的表头…`, '');
    const headers = await extractHeaders(file);
    return inspectHeaders(headers, { fileName: state.fileName });
  }

  async function inspectHeaders(headers, options = {}) {
    const client = window.PrivateCloudQuery;
    if (typeof client?.preflightAdsSource !== 'function') {
      throw inspectorError(503, 'Query Client 尚未提供广告源预检能力，请先连接私有云并刷新页面');
    }
    const normalized = normalizeHeaders(headers);
    setState({
      status: 'checking',
      fileName: text(options.fileName || state.fileName),
      headerCount: normalized.length,
      lastResult: null,
      lastError: '',
    });
    renderMessage(`已识别 ${normalized.length} 个表头，正在进行 Warehouse 只读预检…`, '');
    const result = await client.preflightAdsSource(normalized);
    validateResult(result);
    setState({ status: 'ready', lastResult: result, lastError: '' });
    renderResult(result);
    return result;
  }

  async function extractHeaders(file) {
    if (!file || typeof file !== 'object') throw inspectorError(400, '请选择广告报表文件');
    const name = text(file.name).toLowerCase();
    if (name.endsWith('.csv')) return extractCsvHeaders(file);
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) return extractWorkbookHeaders(file);
    throw inspectorError(400, '仅支持 CSV、XLSX 或 XLS 广告报表');
  }

  async function extractCsvHeaders(file) {
    const prefix = await file.slice(0, CSV_PREFIX_BYTES).text();
    if (!prefix.trim()) throw inspectorError(400, 'CSV 文件为空');
    const Papa = window.Papa;
    if (!Papa?.parse) throw inspectorError(503, 'PapaParse 依赖未加载');
    const parsed = Papa.parse(prefix, { preview: HEADER_SCAN_ROWS, skipEmptyLines: 'greedy' });
    if (parsed?.errors?.some(error => error?.type === 'Quotes')) {
      throw inspectorError(400, 'CSV 表头解析失败：引号结构不完整');
    }
    return selectHeaderRow(parsed?.data || []);
  }

  async function extractWorkbookHeaders(file) {
    if (Number(file.size || 0) > MAX_XLSX_BYTES) {
      throw inspectorError(413, 'Excel 报表超过 32MB；请优先导出 CSV 后进行表头预检');
    }
    const XLSX = window.XLSX;
    if (!XLSX?.read || !XLSX?.utils?.sheet_to_json) throw inspectorError(503, 'SheetJS 依赖未加载');
    const bytes = await file.arrayBuffer();
    const workbook = XLSX.read(bytes, { type: 'array', sheetRows: HEADER_SCAN_ROWS });
    const firstSheet = workbook?.SheetNames?.[0];
    if (!firstSheet || !workbook.Sheets?.[firstSheet]) throw inspectorError(400, 'Excel 工作簿没有可读取的工作表');
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false,
    });
    return selectHeaderRow(rows);
  }

  function selectHeaderRow(rows) {
    const candidates = (Array.isArray(rows) ? rows : [])
      .map((row, index) => ({
        index,
        headers: normalizeCandidateRow(Array.isArray(row) ? row : []),
      }))
      .filter(candidate => candidate.headers.length >= 5)
      .map(candidate => ({ ...candidate, score: headerScore(candidate.headers) }));
    if (!candidates.length) throw inspectorError(400, '未找到可用的广告报表表头');
    candidates.sort((left, right) => right.score - left.score || left.index - right.index);
    return candidates[0].headers;
  }

  function normalizeCandidateRow(values) {
    const headers = (Array.isArray(values) ? values : []).map(value => text(value).normalize('NFKC'));
    while (headers.length && !headers[0]) headers.shift();
    while (headers.length && !headers[headers.length - 1]) headers.pop();
    return headers;
  }

  function normalizeHeaders(values) {
    const headers = normalizeCandidateRow(values);
    if (!headers.length) throw inspectorError(400, '广告报表表头为空');
    if (headers.some(value => !value)) throw inspectorError(400, '广告报表表头中存在空列，请检查导出格式');
    return headers;
  }

  function headerScore(headers) {
    const identities = headers.map(header => header.toLowerCase().replace(/\s+/g, ' '));
    const groups = [
      ['date', '日期'],
      ['impressions', '曝光量', '曝光次数'],
      ['clicks', '点击量', '点击次数'],
      ['spend', '花费', '支出'],
      ['orders', '订单'],
      ['sales', '销售额', '销售'],
      ['customer search term', 'search term', '客户搜索词', '搜索词'],
      ['targeting id', '投放 id', '投放id'],
    ];
    return groups.reduce((score, aliases) => (
      score + (identities.some(identity => aliases.includes(identity)) ? 10 : 0)
    ), Math.min(headers.length, 50) / 100);
  }

  function validateResult(result) {
    if (!result || result.schemaVersion !== PREFLIGHT_VERSION) {
      throw inspectorError(502, 'Warehouse 返回的广告源预检版本无效');
    }
    if (result.activation?.writesFacts !== false
      || result.activation?.changesCurrentSlot !== false
      || result.activation?.authorizesExecution !== false) {
      throw inspectorError(502, '广告源预检返回越过只读安全边界');
    }
  }

  function renderResult(result) {
    ensureUi();
    const readiness = result.readiness || {};
    const items = [
      ['Query 分析', Boolean(readiness.queryAnalysisCandidate)],
      ['Bid Governance', Boolean(readiness.bidGovernanceCandidate)],
      ['Campaign Studio', Boolean(readiness.campaignStudioCandidate)],
    ];
    const grid = byId('adsSourceReadinessGrid');
    if (grid) {
      grid.hidden = false;
      grid.innerHTML = items.map(([label, ready]) => `
        <div class="asriStatus" data-ready="${ready ? '1' : '0'}">
          <b>${escapeHtml(label)}</b>
          <span>${ready ? '候选就绪' : '字段不足'}</span>
        </div>
      `).join('');
    }
    const missingBid = formatMissing(result.missingForBidGovernance);
    const missingCampaign = formatMissing(result.missingForCampaignStudio);
    const meta = [
      state.fileName ? `文件：${state.fileName}` : '',
      `表头：${Number(result.headerCount || state.headerCount || 0)} 列`,
      result.recordType ? `类型：${result.recordType}` : '',
    ].filter(Boolean).join(' · ');
    const lines = [meta];
    if (!readiness.bidGovernanceCandidate) lines.push(`Bid 缺失：${missingBid || '未知字段'}`);
    if (!readiness.campaignStudioCandidate) lines.push(`Campaign 缺失：${missingCampaign || '未知字段'}`);
    if (readiness.bidGovernanceCandidate || readiness.campaignStudioCandidate) {
      lines.push('注意：这里仅表示“候选报表字段满足”；当前生产执行门禁不会因此自动解锁。');
    }
    renderMessage(lines.filter(Boolean).join('\n'), readiness.queryAnalysisCandidate ? 'good' : 'warn');
  }

  function formatMissing(values) {
    return (Array.isArray(values) ? values : [])
      .map(value => DIMENSION_LABELS[value] || text(value))
      .filter(Boolean)
      .join('、');
  }

  function renderMessage(message, kind = '') {
    ensureUi();
    const target = byId('adsSourceReadinessResult');
    if (!target) return;
    target.dataset.kind = kind;
    target.textContent = message;
  }

  function renderError(error) {
    const message = text(error?.message || error || '广告报表预检失败');
    setState({ status: 'error', lastError: message, lastResult: null });
    const grid = byId('adsSourceReadinessGrid');
    if (grid) grid.hidden = true;
    renderMessage(message, 'bad');
    window.dispatchEvent(new CustomEvent('lr:ads-source-readiness-error', {
      detail: { version: INSPECTOR_VERSION, message, status: Number(error?.status || 0) },
    }));
  }

  function inspectorError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
  }

  function mount() {
    if (ensureUi()) return true;
    return false;
  }

  const init = () => {
    mount();
    const observer = new MutationObserver(() => {
      if (mount()) observer.disconnect();
    });
    if (!byId('adsSourceReadinessInspector')) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    window.addEventListener('lr:cloud-overview-ready', mount);
    window.addEventListener('lr:query-client-ready', mount);
    window.dispatchEvent(new CustomEvent('lr:ads-source-readiness-inspector-ready', {
      detail: { version: INSPECTOR_VERSION, preflightVersion: PREFLIGHT_VERSION },
    }));
  };

  window.AdsSourceReadinessInspector = Object.freeze({
    version: INSPECTOR_VERSION,
    open: () => byId('adsSourceReadinessFile')?.click(),
    inspectFile,
    inspectHeaders,
    extractHeaders,
    state: () => ({ ...state }),
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
