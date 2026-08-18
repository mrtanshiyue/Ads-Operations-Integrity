import { canonicalJson } from './canonical-json.js';

export const CSV_HISTORY_DETERMINISTIC_RECEIPT_NUMBER_PROJECTION_VERSION = 'csv-history-number-projection-v1';

export class CsvHistoryDeterministicReceiptError extends Error {
  constructor(code) {
    super(code);
    this.name = 'CsvHistoryDeterministicReceiptError';
    this.code = code;
  }
}

export async function fingerprintDeterministicReceiptPayload(payload, { fingerprintField = 'receiptFingerprint' } = {}) {
  const projected = projectDeterministicReceiptNumbers(payload, { fingerprintField });
  return sha256Hex(canonicalJson(projected));
}

export function projectDeterministicReceiptNumbers(value, { fingerprintField = 'receiptFingerprint' } = {}) {
  return project(value, String(fingerprintField || 'receiptFingerprint'));
}

export function serializeDeterministicReceiptJson(value) {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

function project(value, fingerprintField) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CsvHistoryDeterministicReceiptError('CSV_HISTORY_DETERMINISTIC_RECEIPT_NUMBER_INVALID');
    return { $csvHistoryNumber: Object.is(value, -0) ? '0' : String(value) };
  }
  if (Array.isArray(value)) return value.map((item) => project(item, fingerprintField));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (key === fingerprintField) continue;
      const nested = value[key];
      if (nested === undefined) throw new CsvHistoryDeterministicReceiptError('CSV_HISTORY_DETERMINISTIC_RECEIPT_UNDEFINED');
      out[key] = project(nested, fingerprintField);
    }
    return out;
  }
  throw new CsvHistoryDeterministicReceiptError('CSV_HISTORY_DETERMINISTIC_RECEIPT_TYPE_UNSUPPORTED');
}

async function sha256Hex(text) {
  if (!globalThis.crypto?.subtle) throw new CsvHistoryDeterministicReceiptError('CSV_HISTORY_DETERMINISTIC_RECEIPT_CRYPTO_UNAVAILABLE');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}
