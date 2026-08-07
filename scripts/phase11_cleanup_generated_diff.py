from pathlib import Path

p = Path('assets/generated/inline-script-04.js')
s = p.read_text(encoding='utf-8')
replacements = [
    ('  targetingId: ["投放方案编号","Targeting ID","TargetingID","Targeting Id","Target ID","TargetID"], \n', '  targetingId: ["投放方案编号","Targeting ID","TargetingID","Targeting Id","Target ID","TargetID"],\n'),
    ('    targetingId: intern(String(map.targetingId ? raw[map.targetingId] : "").trim()), \n', '    targetingId: intern(String(map.targetingId ? raw[map.targetingId] : "").trim()),\n'),
]
for old, new in replacements:
    assert s.count(old) == 1, f'whitespace cleanup target count={s.count(old)}: {old!r}'
    s = s.replace(old, new)
p.write_text(s, encoding='utf-8')
print('Phase 11 generated parser whitespace cleaned')
