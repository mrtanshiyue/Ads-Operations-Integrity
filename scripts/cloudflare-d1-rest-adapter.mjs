const MAX_BATCH_STATEMENTS = 900;

export function createD1RestDatabase({ accountId, databaseId, apiToken, fetchImpl = globalThis.fetch }) {
  for (const [name, value] of Object.entries({ accountId, databaseId, apiToken })) {
    if (!String(value || '').trim()) throw new Error(`d1_rest_${name}_required`);
  }
  if (typeof fetchImpl !== 'function') throw new Error('d1_rest_fetch_required');
  return new D1RestDatabase({ accountId, databaseId, apiToken, fetchImpl });
}

class D1RestDatabase {
  constructor({ accountId, databaseId, apiToken, fetchImpl }) {
    this.accountId = accountId;
    this.databaseId = databaseId;
    this.apiToken = apiToken;
    this.fetchImpl = fetchImpl;
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
    });
  }

  async query(payload) {
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
    if (!response.ok || !body?.success || !Array.isArray(body.result)) {
      const code = body?.errors?.[0]?.code || response.status || 'unknown';
      throw new Error(`d1_rest_query_failed:${code}`);
    }
    const failed = body.result.find((item) => item?.success === false);
    if (failed) throw new Error('d1_rest_statement_failed');
    return body.result;
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
    const result = await this.db.query({ sql: this.sql, params: this.args });
    return normalizeResult(result[0]);
  }

  async first() {
    const result = await this.all();
    return result.results[0] || null;
  }

  async run() {
    const result = await this.db.query({ sql: this.sql, params: this.args });
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
