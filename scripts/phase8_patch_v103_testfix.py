from pathlib import Path

p = Path('scripts/test-progressive-loader.mjs')
s = p.read_text()
old = "assert.match(query, /const BID_GOVERNANCE_PARITY_AUDIT_VERSION = '1\\.0\\.2'/);"
new = "assert.match(query, /const BID_GOVERNANCE_PARITY_AUDIT_VERSION = '1\\.0\\.3'/);"
assert s.count(old) == 1, f'query parity asset version assertion count={s.count(old)}'
p.write_text(s.replace(old, new))
