import assert from 'node:assert/strict';
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
