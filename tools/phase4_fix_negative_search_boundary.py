from pathlib import Path

path = Path('assets/query-native-module-data-v1.js')
text = path.read_text(encoding='utf-8')
old = """  const advancedSearchMatches = (value, query, exact = false) => {
    const haystack = lower(value);
    const needle = text(query);
    if (!needle) return true;
    if (exact) return haystack === needle.toLowerCase();
    if (/^regex:/i.test(needle)) {
      const pattern = needle.slice(6).trim();
      if (!pattern) return true;
      try { return new RegExp(pattern, 'i').test(value); }
      catch (_) { throw moduleError(400, '搜索词正则表达式无效'); }
    }
    const tokens = needle.split(/\\s+/).filter(Boolean);
    const positives = tokens.filter(token => !token.startsWith('-')).map(lower);
    const negatives = tokens.filter(token => token.startsWith('-') && token.length > 1).map(token => lower(token.slice(1)));
    return positives.every(token => haystack.includes(token))
      && negatives.every(token => !haystack.includes(token));
  };
"""
new = """  const escapeRegExp = value => String(value || '').replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');

  const negativeTokenPresent = (value, token) => {
    const source = String(value || '');
    const normalized = lower(token);
    if (!normalized) return false;
    if (/^[a-z0-9]+$/i.test(normalized)) {
      return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(normalized)}(?:$|[^a-z0-9])`, 'i').test(source);
    }
    return lower(source).includes(normalized);
  };

  const advancedSearchMatches = (value, query, exact = false) => {
    const haystack = lower(value);
    const needle = text(query);
    if (!needle) return true;
    if (exact) return haystack === needle.toLowerCase();
    if (/^regex:/i.test(needle)) {
      const pattern = needle.slice(6).trim();
      if (!pattern) return true;
      try { return new RegExp(pattern, 'i').test(value); }
      catch (_) { throw moduleError(400, '搜索词正则表达式无效'); }
    }
    const tokens = needle.split(/\\s+/).filter(Boolean);
    const positives = tokens.filter(token => !token.startsWith('-')).map(lower);
    const negatives = tokens.filter(token => token.startsWith('-') && token.length > 1).map(token => lower(token.slice(1)));
    return positives.every(token => haystack.includes(token))
      && negatives.every(token => !negativeTokenPresent(value, token));
  };
"""
if text.count(old) != 1:
    raise SystemExit(f'Expected one advanced search block, found {text.count(old)}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
print('Negative search boundary fixed')
