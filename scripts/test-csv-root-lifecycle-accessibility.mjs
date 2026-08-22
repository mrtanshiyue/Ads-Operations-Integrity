import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../assets/cloudflare-native-csv-root-lifecycle-usability-v1.js', import.meta.url), 'utf8');

assert.match(source, /focusedLifecycleControlKey\(controls\)/,
  'Lifecycle render must snapshot the focused presentation control before rebuilding controls');
assert.match(source, /document\.activeElement/,
  'Keyboard focus preservation must derive from the actual active element');
assert.match(source, /restoreLifecycleControlFocus\(controls, focusedControlKey\)/,
  'Lifecycle render must restore focus after rebuilding the select controls');
assert.match(source, /focus\(\{ preventScroll: true \}\)/,
  'Focus restoration must avoid unexpected scroll jumps');
assert.match(source, /setAttribute\('role', 'group'\)/,
  'Lifecycle presentation controls must expose a semantic group');
assert.match(source, /setAttribute\('aria-label', 'Lifecycle presentation controls'\)/,
  'Lifecycle presentation controls must have a stable accessible label');
assert.match(source, /data-crlu-lifecycle-empty[\s\S]*setAttribute\('role', 'status'\)[\s\S]*setAttribute\('aria-live', 'polite'\)/,
  'Lifecycle filter empty state must be announced without requiring pointer interaction');
assert.match(source, /const VERSION = '1\.0\.2'/,
  'Accessibility hardening must preserve the current Root\/Lifecycle asset version contract');
assert.doesNotMatch(source, /method:\s*['"](?:POST|PUT|PATCH|DELETE)/i,
  'Accessibility hardening must remain read-only');
assert.doesNotMatch(source, /startSync\s*\(|optimization-actions|execution-permits|amazon-ads-api/i,
  'Accessibility hardening must not introduce execution or Amazon transport paths');

console.log('csv root lifecycle accessibility contract: PASS');
