import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(repoRoot, 'assets/cloudflare-native-csv-recommendation-inbox-v1.js'), 'utf8');

assert.match(source, /drawerTrigger:\s*null/);
assert.match(source, /FOCUSABLE_SELECTOR/);
assert.match(source, /role="dialog"\s+aria-modal="true"\s+aria-labelledby="cfriDrawerTitle"\s+tabindex="-1"/);
assert.match(source, /openEvidence\(evidenceButton\.dataset\.cfriEvidence\s*\|\|\s*'',\s*evidenceButton\)/);
assert.match(source, /drawer\.querySelector\('\[data-cfri-close\]'\)\?\.focus\(\{\s*preventScroll:\s*true\s*\}\)/);
assert.match(source, /event\.key\s*!==\s*'Tab'/);
assert.match(source, /event\.shiftKey/);
assert.match(source, /drawer\.contains\(active\)/);
assert.match(source, /closeDrawer\(\{\s*restoreFocus\s*=\s*true\s*\}\s*=\s*\{\}\)/);
assert.match(source, /trigger\?\.isConnected/);
assert.match(source, /closeDrawer\(\{\s*restoreFocus:\s*false\s*\}\)/);

console.log('Recommendation drawer focus contract PASS');
