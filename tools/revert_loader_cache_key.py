from pathlib import Path

path = Path('index.html')
text = path.read_text(encoding='utf-8')
old = '<script src="assets/private-cloud-warehouse-v4.js?v=4.3.0-layout2"></script>'
new = '<script src="assets/private-cloud-warehouse-v4.js"></script>'
if text.count(old) != 1:
    raise SystemExit(f'Expected one versioned Loader URL, found {text.count(old)}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
