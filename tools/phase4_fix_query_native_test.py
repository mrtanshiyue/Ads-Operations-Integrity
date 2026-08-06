from pathlib import Path

path = Path('scripts/test-query-native-modules.mjs')
text = path.read_text(encoding='utf-8')
old = "assert.match(finance, /QueryNativeModuleData\\.periodTransactions/);"
new = "assert.match(finance, /adapter\\.periodTransactions/);"
if text.count(old) != 1:
    raise SystemExit(f'Expected one finance adapter assertion, found {text.count(old)}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
