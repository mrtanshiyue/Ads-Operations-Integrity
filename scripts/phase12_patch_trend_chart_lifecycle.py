from pathlib import Path

core_path = Path('assets/generated/inline-script-04.js')
source = core_path.read_text(encoding='utf-8')
needle = '  const canvas=$("trendChart");if(!canvas)return;const options='
replacement = '''  const canvas=$("trendChart");if(!canvas)return;
  const registeredTrendChart=(typeof Chart!=="undefined"&&typeof Chart.getChart==="function")?Chart.getChart(canvas):null;
  if(trendChart?.canvas&&trendChart.canvas!==canvas){try{trendChart.destroy();}catch(e){reportError("renderTrend stale chart destroy",e);}trendChart=null;}
  if(!trendChart&&registeredTrendChart)return;
  const options='''
assert source.count(needle) == 1, f'renderTrend insertion point count={source.count(needle)}'
source = source.replace(needle, replacement)
core_path.write_text(source, encoding='utf-8')

test_path = Path('scripts/test-trend-chart-lifecycle.mjs')
test_path.write_text('''import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../assets/generated/inline-script-04.js', import.meta.url), 'utf8');
const start = source.indexOf('const renderTrend = rows => {');
const end = source.indexOf('const exportExecutiveOverviewExcel', start);
assert.notEqual(start, -1, 'renderTrend must exist');
assert.notEqual(end, -1, 'renderTrend end marker must exist');
const renderTrend = source.slice(start, end);

assert.match(renderTrend, /const registeredTrendChart=\(typeof Chart!=="undefined"&&typeof Chart\.getChart==="function"\)\?Chart\.getChart\(canvas\):null/);
assert.match(renderTrend, /trendChart\?\.canvas&&trendChart\.canvas!==canvas/);
assert.match(renderTrend, /trendChart\.destroy\(\)/);
assert.match(renderTrend, /if\(!trendChart&&registeredTrendChart\)return/);
assert.doesNotMatch(renderTrend, /trendChart\s*=\s*registeredTrendChart/, 'Legacy renderer must not adopt a Query-native-owned Chart instance');
const registryGuard = renderTrend.indexOf('if(!trendChart&&registeredTrendChart)return');
const creation = renderTrend.indexOf('trendChart=new Chart(');
assert.ok(registryGuard >= 0 && creation > registryGuard, 'Chart registry ownership guard must run before Legacy Chart creation');
assert.equal((renderTrend.match(/trendChart=new Chart\(/g) || []).length, 1, 'Legacy renderTrend must have a single Chart creation path');
assert.doesNotMatch(renderTrend, /Canvas is already in use/, 'Do not suppress the Chart.js ownership error by message matching');

console.log('Trend Chart lifecycle ownership contracts passed');
''', encoding='utf-8')

progressive_path = Path('scripts/test-progressive-loader.mjs')
progressive = progressive_path.read_text(encoding='utf-8')
marker = "console.log('Progressive Query-first loader and shop UI invariants passed');\nawait import('./test-legacy-bid-control-source.mjs');"
replacement = "console.log('Progressive Query-first loader and shop UI invariants passed');\nawait import('./test-trend-chart-lifecycle.mjs');\nawait import('./test-legacy-bid-control-source.mjs');"
assert progressive.count(marker) == 1, f'progressive import marker count={progressive.count(marker)}'
progressive = progressive.replace(marker, replacement)
progressive_path.write_text(progressive, encoding='utf-8')

print('Phase 12 trend Chart lifecycle patch applied')
