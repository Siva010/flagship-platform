import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

export type Database = pg.Pool;

export function createPool(connectionString?: string): Database {
  return new Pool({
    connectionString:
      connectionString ??
      process.env['DATABASE_URL'] ??
      'postgres://flagship:flagship@localhost:5433/flagship',
    // Bounded: the control plane is low-traffic, and an unbounded pool turns a
    // slow query into connection exhaustion for everything else.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = join(here, '..', 'migrations');

/**
 * Applies pending migrations inside a transaction, tracking what has run.
 *
 * Deliberately minimal rather than a migration framework: the schema is small,
 * and a hand-rolled runner that is 40 lines and obvious beats a dependency
 * whose failure modes you have to learn.
 */
export async function migrate(pool: Database): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
      (row) => row.name,
    ),
  );

  const files = readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(join(migrationsDirectory, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ran.push(file);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${(error as Error).message}`, { cause: error });
    } finally {
      client.release();
    }
  }

  return ran;
}

/** Runs a function inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(
  pool: Database,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
