import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../assets/cloudflare-native-negative-governance-v1.js', import.meta.url), 'utf8');

assert.match(
  source,
  /requestSerial: 0,\s*productLoadSerial: 0,/,
  'Negative Governance must track product-catalog request ownership separately from scope-row reads',
);
assert.match(
  source,
  /async function loadProducts\(\) \{\s*const storeId = state\.storeId;\s*const serial = \+\+state\.productLoadSerial;/,
  'product catalog loads must capture the selected store and their own generation before awaiting',
);
assert.match(
  source,
  /state\.products = \[\];\s*state\.productId = '';\s*renderProducts\(\);\s*if \(!storeId\) return;/,
  'changing stores must clear and disable the stale product selector before the replacement catalog resolves',
);
assert.match(
  source,
  /api\(\)\.storeProducts\(storeId, \{ limit: PAGE_LIMIT \}\);\s*if \(serial !== state\.productLoadSerial \|\| storeId !== state\.storeId\) return;/,
  'late product-catalog success responses must not overwrite the current store context',
);
assert.match(
  source,
  /catch \(error\) \{\s*if \(serial !== state\.productLoadSerial \|\| storeId !== state\.storeId\) return;\s*setStatus/,
  'late product-catalog errors must not pollute the current store status',
);
assert.match(
  source,
  /async function onStoreChange\(event\) \{\s*const storeId = String\(event\.target\.value \|\| ''\);\s*state\.storeId = storeId;\s*state\.requestSerial \+= 1;\s*await loadProducts\(\);\s*if \(storeId !== state\.storeId\) return;/,
  'store changes must immediately revoke old scope-row reads and stale store-change continuations',
);
assert.doesNotMatch(
  source,
  /const payload = await api\(\)\.storeProducts\(state\.storeId, \{ limit: PAGE_LIMIT \}\);\s*state\.products = normalizeProducts/,
  'product catalog must not apply a response without captured-store ownership',
);

console.log(JSON.stringify({
  ok: true,
  contract: 'negative-governance-cross-store-product-scope-v1',
  staleProductCatalogSuppression: true,
  staleScopeRowSuppressionOnStoreChange: true,
  amazonMutationAuthorized: false,
}, null, 2));
