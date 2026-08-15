export class SourceNumericError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SourceNumericError';
    this.code = code;
  }
}

export function parseAmazonId(value) {
  if (typeof value === 'string') {
    if (!value.length) throw new SourceNumericError('SOURCE_ID_EMPTY');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new SourceNumericError('SOURCE_ID_PRECISION_UNSAFE');
    return String(value);
  }
  throw new SourceNumericError('SOURCE_ID_TYPE_INVALID');
}

export function parseNonNegativeInteger(value, code = 'SOURCE_INTEGER_INVALID') {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new SourceNumericError(code);
    return value;
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new SourceNumericError(code);
    return parsed;
  }
  throw new SourceNumericError(code);
}

export function exactDecimalToMicros(value) {
  if (typeof value !== 'string') {
    throw new SourceNumericError('SOURCE_MONEY_LEXICAL_REQUIRED');
  }
  const text = value.trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) throw new SourceNumericError('SOURCE_MONEY_DECIMAL_INVALID');
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] || '').padEnd(6, '0'));
  const micros = whole * 1000000n + fraction;
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new SourceNumericError('SOURCE_MONEY_MICROS_UNSAFE');
  return Number(micros);
}
