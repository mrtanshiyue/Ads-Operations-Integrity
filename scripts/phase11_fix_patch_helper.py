from pathlib import Path

p = Path('scripts/phase11_patch_bid_control_parity.py')
s = p.read_text(encoding='utf-8')
lines = s.splitlines()
filtered = [line for line in lines if not ('assert.match(legacyCore, /getBidGovernanceScopedRowsForParity:' in line and line.lstrip().startswith('("') is False and line.lstrip().startswith('("') is False)]
# Remove only the tuple entry in the Python replacements list.
filtered = [line for line in lines if not ('getBidGovernanceScopedRowsForParity:' in line and line.lstrip().startswith('("') )]
s = '\n'.join(filtered) + '\n'
marker = '''old = "console.log('Progressive Query-first loader and shop UI invariants passed');\\nawait import('./test-query-native-governance-gate.mjs');"'''
insert = '''legacy_bridge_assertions = [line for line in s.splitlines() if 'assert.match(legacyCore' in line and 'getBidGovernanceScopedRowsForParity:' in line]
assert len(legacy_bridge_assertions) == 1, f'legacy bridge progressive assertion count={len(legacy_bridge_assertions)}'
s = s.replace(legacy_bridge_assertions[0], "assert.match(legacyCore, /getBidGovernanceScopedRowsForParity/);\\nassert.match(legacyCore, /getBidGovernanceControlRowsForParity/);\\nassert.match(legacyCore, /投放方案编号/);\\nassert.match(legacyCore, /目标竞价/);")
old = "console.log('Progressive Query-first loader and shop UI invariants passed');\\nawait import('./test-query-native-governance-gate.mjs');"'''
assert s.count(marker) == 1, f'helper insertion marker count={s.count(marker)}'
s = s.replace(marker, insert)
p.write_text(s, encoding='utf-8')
print('Phase 11 one-shot helper matcher fixed')
