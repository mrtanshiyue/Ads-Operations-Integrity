const MAX_BATCH_STATEMENTS = 900;
const MAX_READ_ATTEMPTS = 3;
const READ_RETRY_DELAYS_MS = [100, 300];
const TRANSIENT_API_CODES = new Set([7500]);

export function createD1RestDatabase({
  accountId,
  databaseId,
  apiToken,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
}) {
  for (const [name, value] of Object.entries({ accountId, databaseId, apiToken })) {
    if (!String(value || '').trim()) throw new Error(`d1_rest_${name}_required`);
  }
  if (typeof fetchImpl !== 'function') throw new Error('d1_rest_fetch_required');
  if (typeof sleepImpl !== 'function') throw new Error('d1_rest_sleep_required');
  return new D1RestDatabase({ accountId, databaseId, apiToken, fetchImpl, sleepImpl });
}

class D1RestDatabase {
  constructor({ accountId, databaseId, apiToken, fetchImpl, sleepImpl }) {
    this.accountId = accountId;
    this.databaseId = databaseId;
    this.apiToken = apiToken;
    this.fetchImpl = fetchImpl;
    this.sleepImpl = sleepImpl;
  }

  prepare(sql) {
    return new D1RestStatement(this, requiredSql(sql));
  }

  async batch(statements) {
    if (!Array.isArray(statements) || !statements.length) return [];
    if (statements.length > MAX_BATCH_STATEMENTS) throw new Error('d1_rest_batch_statement_limit');
    for (const statement of statements) {
      if (!(statement instanceof D1RestStatement) || statement.db !== this) {
        throw new Error('d1_rest_batch_statement_invalid');
      }
    }
    return this.query({
      batch: statements.map((statement) => ({ sql: statement.sql, params: statement.args })),
    }, { retryable: false });
  }

  async query(payload, { retryable = false } = {}) {
    const attempts = retryable ? MAX_READ_ATTEMPTS : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(
          `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/d1/database/${encodeURIComponent(this.databaseId)}/query`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.apiToken}`,
              'content-type': 'application/json',
              accept: 'application/json',
            },
            body: JSON.stringify(payload),
          },
        );
        const body = await response.json().catch(() => null);
        if (response.ok && body?.success && Array.isArray(body.result)) {
          const failed = body.result.find((item) => item?.success === false);
          if (failed) throw new Error('d1_rest_statement_failed');
          return body.result;
        }

        const code = Number(body?.errors?.[0]?.code || 0);
        const error = new Error(`d1_rest_query_failed:${code || response.status || 'unknown'}`);
        if (!retryable || !isTransientFailure(response.status, code) || attempt === attempts) throw error;
        lastError = error;
      } catch (error) {
        if (!retryable || !isRetryableException(error) || attempt === attempts) throw error;
        lastError = error;
      }

      await this.sleepImpl(READ_RETRY_DELAYS_MS[attempt - 1] || READ_RETRY_DELAYS_MS.at(-1));
    }

    throw lastError || new Error('d1_rest_query_failed:unknown');
  }
}

class D1RestStatement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new D1RestStatement(this.db, this.sql, args);
  }

  async all() {
    const result = await this.db.query(
      { sql: this.sql, params: this.args },
      { retryable: isReadOnlySql(this.sql) },
    );
    return normalizeResult(result[0]);
  }

  async first() {
    const result = await this.all();
    return result.results[0] || null;
  }

  async run() {
    const result = await this.db.query({ sql: this.sql, params: this.args }, { retryable: false });
    return normalizeResult(result[0]);
  }
}

function normalizeResult(value) {
  return {
    success: value?.success !== false,
    results: Array.isArray(value?.results) ? value.results : [],
    meta: value?.meta || {},
  };
}

function requiredSql(value) {
  const sql = String(value || '').trim();
  if (!sql) throw new Error('d1_rest_sql_required');
  return sql;
}

function isReadOnlySql(sql) {
  const normalized = String(sql || '').trim().replace(/^--[^\n]*\n/gm, '').trim().toUpperCase();
  return /^(SELECT\b|WITH\b|EXPLAIN\b|PRAGMA\s+FOREIGN_KEY_CHECK\b)/.test(normalized);
}

function isTransientFailure(status, code) {
  return status === 429 || status >= 500 || TRANSIENT_API_CODES.has(Number(code));
}

function isRetryableException(error) {
  if (!error) return true;
  const message = String(error.message || error);
  if (message === 'd1_rest_statement_failed') return false;
  if (/^d1_rest_query_failed:/.test(message)) {
    const code = Number(message.split(':').at(-1));
    return TRANSIENT_API_CODES.has(code) || code === 429 || code >= 500;
  }
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
