from pathlib import Path

p = Path('scripts/test-progressive-loader.mjs')
s = p.read_text()
replacements = [
    ("assert.match(query, /const BID_GOVERNANCE_PARITY_AUDIT_VERSION = '1\\.0\\.2'/);", "assert.match(query, /const BID_GOVERNANCE_PARITY_AUDIT_VERSION = '1\\.0\\.3'/);"),
    ("assert.match(parityAudit, /metricParityPass: pass/);", "assert.match(parityAudit, /const metricParityPass = totalsPass && identityPass/);"),
]
for old, new in replacements:
    assert s.count(old) == 1, f'progressive assertion count={s.count(old)} for {old}'
    s = s.replace(old, new)
p.write_text(s)

p = Path('scripts/test-bid-governance-parity-audit.mjs')
s = p.read_text()
old = "assert.match(source, /metricParityPass: pass/);"
new = "assert.match(source, /const metricParityPass = totalsPass && identityPass/);"
assert s.count(old) == 1, f'dedicated assertion count={s.count(old)}'
p.write_text(s.replace(old, new))
