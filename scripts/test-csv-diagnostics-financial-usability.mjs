import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const diagnostics = await readFile(new URL('../assets/cloudflare-native-csv-local-diagnostics-v1.js', import.meta.url), 'utf8');

assert.match(diagnostics, /data-cfdiag-financial/, 'Diagnostics must expose a dedicated financial-comparability status surface');
assert.match(diagnostics, /aria-label="Financial diagnostics comparability"/, 'Financial status must have a non-color accessibility label');
assert.match(diagnostics, /Financial diagnostics active/, 'Comparable scope must have a concise active state');
assert.match(diagnostics, /Financial diagnostics suppressed/, 'Non-comparable scope must visibly declare financial suppression');
assert.match(diagnostics, /Financial diagnostics status unavailable/, 'Missing comparability metadata must fail closed without a positive claim');
assert.match(diagnostics, /financialObservationsSuppressed/, 'UI must consume the server-side financial suppression contract');
assert.match(diagnostics, /financialObservationPolicy/, 'UI must consume the explicit server-side financial observation policy');
assert.match(diagnostics, /financialEvidenceSuppressed/, 'UI evidence rendering must honor server-side financial evidence suppression');
assert.match(diagnostics, /Traffic and conversion diagnostics remain available/, 'Operator copy must explain which non-financial diagnostics remain usable');
assert.match(diagnostics, /financial evidence is hidden/, 'Operator copy must state that financial evidence is hidden');

for (const [reason, label] of [
  ['multiple_currency_codes', 'Multiple currencies in current scope'],
  ['multiple_marketplaces', 'Multiple marketplaces in current scope'],
  ['currency_code_missing', 'Currency metadata missing'],
  ['marketplace_missing', 'Marketplace metadata missing'],
]) {
  assert.match(diagnostics, new RegExp(reason), `Missing financial suppression reason: ${reason}`);
  assert.match(diagnostics, new RegExp(label), `Missing operator-facing financial suppression label: ${label}`);
}

assert.match(diagnostics, /if \(financialSuppressed\) \{[\s\S]*Financial evidence suppressed[\s\S]*\} else \{[\s\S]*Spend \$\{money\(evidence\.spendMicros\)\}/,
  'Suppressed evidence path must omit financial values while comparable evidence retains them');
assert.match(diagnostics, /role="note"/, 'Financial comparability state should remain informational rather than interactive');
assert.match(diagnostics, /const VERSION = '1\.1\.0'/, 'Usability hardening must preserve the existing asset version contract');
assert.doesNotMatch(diagnostics, /\bfetch\s*\(/, 'Financial usability must continue delegating transport to CloudflareNativeAPI');
assert.doesNotMatch(diagnostics, /startSync\s*\(|optimization-actions|execution-permits|method:\s*['"](?:POST|PUT|PATCH|DELETE)/i,
  'Financial usability must remain read-only and isolated from execution/write controls');
assert.doesNotMatch(diagnostics, /AMAZON_ADS_ENABLED|SYNC_TRIGGER_ENABLED|amazon-ads-api/i,
  'Financial usability must not touch Amazon transport switches');

console.log('csv diagnostics financial usability contract: PASS');
