export class CanonicalJsonError extends Error {
  constructor(code) {
    super(code);
    this.name = 'CanonicalJsonError';
    this.code = code;
  }
}

export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

function normalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new CanonicalJsonError('CANONICAL_JSON_NUMBER_UNSAFE');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) throw new CanonicalJsonError('CANONICAL_JSON_UNDEFINED');
      out[key] = normalize(item);
    }
    return out;
  }
  throw new CanonicalJsonError('CANONICAL_JSON_TYPE_UNSUPPORTED');
}
