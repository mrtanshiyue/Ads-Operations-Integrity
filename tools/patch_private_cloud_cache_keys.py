from pathlib import Path

path = Path('index.html')
text = path.read_text(encoding='utf-8')
replacements = [
    (
        '<script id="shopScopeUiV1" src="assets/generated/inline-script-11.js"></script>',
        '<script id="shopScopeUiV1" src="assets/generated/inline-script-11.js?v=1.1.0"></script>',
    ),
    (
        '<script src="assets/private-cloud-warehouse-v4.js"></script>',
        '<script src="assets/private-cloud-warehouse-v4.js?v=4.3.0-layout2"></script>',
    ),
]
for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'Expected one cache-key target, found {count}: {old}')
    text = text.replace(old, new, 1)
path.write_text(text, encoding='utf-8')
print('Private cloud cache keys updated')
