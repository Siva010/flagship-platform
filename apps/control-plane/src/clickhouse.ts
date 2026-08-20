import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ClickHouse access over the HTTP interface.
 *
 * Hand-rolled on fetch rather than pulling in a driver. The HTTP interface is
 * "POST a string, read a string back", the native protocol buys nothing at the
 * volumes the control plane writes, and an official client would add a
 * dependency whose connection pooling and retry behaviour we would then have to
 * learn before trusting it on a request path.
 *
 * Everything here speaks JSONEachRow: newline-delimited JSON objects, the one
 * format that is both cheap for ClickHouse to parse and trivial to produce from
 * JavaScript without a serialisation layer.
 */

export interface ClickHouseOptions {
  url?: string | undefined;
  username?: string | undefined;
  password?: string | undefined;
  database?: string | undefined;
  /** Applies to each request; a hung socket must not pin a caller forever. */
  timeoutMillis?: number | undefined;
}

export class ClickHouseError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ClickHouseError';
    this.status = status;
  }
}

/** Values substituted into `{name:Type}` placeholders. */
export type QueryParameters = Record<string, string | number>;

export class ClickHouseClient {
  readonly #url: string;
  readonly #username: string;
  readonly #password: string;
  readonly #database: string;
  readonly #timeoutMillis: number;

  constructor(options: ClickHouseOptions = {}) {
    this.#url = (options.url ?? process.env['CLICKHOUSE_URL'] ?? 'http://127.0.0.1:8123').replace(
      /\/+$/,
      '',
    );
    this.#username = options.username ?? process.env['CLICKHOUSE_USER'] ?? 'flagship';
    this.#password = options.password ?? process.env['CLICKHOUSE_PASSWORD'] ?? 'flagship';
    this.#database = options.database ?? process.env['CLICKHOUSE_DATABASE'] ?? 'flagship';
    this.#timeoutMillis = options.timeoutMillis ?? 10_000;
  }

  /**
   * Runs a SELECT and returns the rows.
   *
   * Parameters go through ClickHouse's own `{name:Type}` binding rather than
   * string interpolation. That is not a style preference: `tenant_id` reaches
   * these queries from an authenticated key, but `flag_key` and the time range
   * come from a caller, and a query built by concatenation is an injection
   * whenever someone downstream forgets that.
   */
  async query<Row>(sql: string, parameters: QueryParameters = {}): Promise<Row[]> {
    const body = await this.#send(`${sql}\nFORMAT JSONEachRow`, parameters);
    return body
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Row);
  }

  /** Runs a statement that returns nothing (DDL, INSERT ... SELECT). */
  async command(sql: string, parameters: QueryParameters = {}): Promise<void> {
    await this.#send(sql, parameters);
  }

  /**
   * Inserts rows as JSONEachRow.
   *
   * The table name is interpolated because ClickHouse cannot bind an identifier
   * as a parameter. Callers must pass a literal, never anything derived from a
   * request.
   */
  async insert(table: string, rows: readonly object[]): Promise<void> {
    if (rows.length === 0) return;
    const payload = rows.map((row) => JSON.stringify(row)).join('\n');
    await this.#send(`INSERT INTO ${table} FORMAT JSONEachRow`, {}, payload);
  }

  /** True when the server answers. Used by tests to decide whether to skip. */
  async ping(): Promise<boolean> {
    try {
      await this.query('SELECT 1 AS ok');
      return true;
    } catch {
      return false;
    }
  }

  async #send(sql: string, parameters: QueryParameters, body?: string): Promise<string> {
    const url = new URL(this.#url);
    url.searchParams.set('database', this.#database);
    // Without this, every UInt64 — which is what every count and uniq returns —
    // arrives as a quoted string and silently becomes NaN on arithmetic. The
    // precision this gives up only matters past 2^53, which no exposure count
    // reaches before the storage bill ends the discussion.
    url.searchParams.set('output_format_json_quote_64bit_integers', '0');

    for (const [name, value] of Object.entries(parameters)) {
      url.searchParams.set(`param_${name}`, String(value));
    }

    // The query travels in the body when there is no payload, and in the URL
    // when there is. Long SELECTs would otherwise hit URL length limits.
    let requestBody: string;
    if (body === undefined) {
      requestBody = sql;
    } else {
      url.searchParams.set('query', sql);
      requestBody = body;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        // Credentials as headers rather than URL parameters: a URL ends up in
        // access logs and error messages, and this one would carry a password.
        'X-ClickHouse-User': this.#username,
        'X-ClickHouse-Key': this.#password,
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: requestBody,
      signal: AbortSignal.timeout(this.#timeoutMillis),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new ClickHouseError(
        `ClickHouse returned ${response.status}: ${text.slice(0, 500)}`,
        response.status,
      );
    }
    return text;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = join(here, '..', 'migrations', 'clickhouse');

/**
 * Applies the ClickHouse DDL.
 *
 * Every statement is IF NOT EXISTS, so this re-runs on every boot and there is
 * no applied-migrations table. ClickHouse has no transactional DDL: a tracking
 * row could be written for a migration that half-applied, and would then lie
 * about the schema forever. Idempotent DDL cannot develop that inconsistency.
 *
 * Returns the statements executed, for logging.
 */
export async function migrateClickHouse(client: ClickHouseClient): Promise<number> {
  const files = readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  let applied = 0;
  for (const file of files) {
    const sql = readFileSync(join(migrationsDirectory, file), 'utf8');
    for (const statement of splitStatements(sql)) {
      try {
        await client.command(statement);
      } catch (error) {
        throw new Error(`ClickHouse migration ${file} failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
      applied += 1;
    }
  }
  return applied;
}

/**
 * Splits a migration file into statements.
 *
 * The HTTP interface executes one statement per request, so a multi-statement
 * file has to be taken apart here. Comments are dropped first, and only
 * whole-line comments are recognised — a trailing `--` after code would need
 * quote-aware parsing to strip safely, so the migration files do not use one.
 */
function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
