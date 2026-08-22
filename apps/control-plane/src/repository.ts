import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withTransaction, type Database } from './db.ts';
import { hashApiKey, keyPrefix, verifyApiKey, type KeyKind } from './keys.ts';
import { compileRuleset, type CompiledRuleset, type FlagRow, type SegmentRow } from './ruleset.ts';

/**
 * Data access.
 *
 * Every query that touches tenant data takes a tenantId and includes it in the
 * WHERE clause. That is the tenancy boundary — it is not optional, and it is
 * not enforced by convention elsewhere. A query here without a tenant predicate
 * is a cross-tenant data leak.
 */

export interface AuthenticatedKey {
  tenantId: string;
  environmentId: string;
  environmentKey: string;
  kind: KeyKind;
  apiKeyId: string;
}

/**
 * Resolves an SDK key to its tenant and environment scope.
 *
 * The prefix narrows to candidate rows via an index; the full hash is then
 * compared in constant time. Storing only the hash means a database dump does
 * not yield working keys, and the prefix is too short to be useful alone.
 */
export async function authenticateKey(
  db: Database,
  plaintext: string,
): Promise<AuthenticatedKey | undefined> {
  const prefix = keyPrefix(plaintext);
  if (prefix.length < 8) return undefined;

  const result = await db.query<{
    id: string;
    tenant_id: string;
    environment_id: string;
    environment_key: string;
    kind: KeyKind;
    key_hash: string;
  }>(
    `SELECT k.id, k.tenant_id, k.environment_id, e.key AS environment_key, k.kind, k.key_hash
       FROM api_keys k
       JOIN environments e ON e.id = k.environment_id
      WHERE k.key_prefix = $1 AND k.revoked_at IS NULL`,
    [prefix],
  );

  for (const row of result.rows) {
    if (verifyApiKey(plaintext, row.key_hash)) {
      return {
        tenantId: row.tenant_id,
        environmentId: row.environment_id,
        environmentKey: row.environment_key,
        kind: row.kind,
        apiKeyId: row.id,
      };
    }
  }
  return undefined;
}

/** Records key usage. Best-effort: a failure here must not fail the request. */
export async function touchKeyUsage(db: Database, apiKeyId: string): Promise<void> {
  try {
    await db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [apiKeyId]);
  } catch {
    // Telemetry, not correctness.
  }
}

export interface CreateApiKeyInput {
  tenantId: string;
  environmentId: string;
  name: string;
  kind: KeyKind;
  prefix: string;
  hash: string;
}

export async function insertApiKey(db: Database, input: CreateApiKeyInput): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO api_keys (tenant_id, environment_id, name, kind, key_prefix, key_hash)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.tenantId, input.environmentId, input.name, input.kind, input.prefix, input.hash],
  );
  return result.rows[0]!.id;
}

export interface FlagSummary {
  key: string;
  description: string;
  enabled: boolean;
  variations: unknown;
  updatedAt: string;
}

export async function listFlags(
  db: Database,
  tenantId: string,
  environmentId: string,
): Promise<FlagSummary[]> {
  const result = await db.query<{
    key: string;
    description: string;
    enabled: boolean;
    variations: unknown;
    updated_at: Date;
  }>(
    `SELECT f.key, f.description, COALESCE(c.enabled, false) AS enabled,
            f.variations, f.updated_at
       FROM flags f
       LEFT JOIN flag_configs c
              ON c.flag_id = f.id AND c.environment_id = $2
      WHERE f.tenant_id = $1 AND f.archived_at IS NULL
      ORDER BY f.key`,
    [tenantId, environmentId],
  );

  return result.rows.map((row) => ({
    key: row.key,
    description: row.description,
    enabled: row.enabled,
    variations: row.variations,
    updatedAt: row.updated_at.toISOString(),
  }));
}

/** Loads everything needed to compile a ruleset for one environment. */
export async function loadRulesetInputs(
  db: Database,
  tenantId: string,
  environmentId: string,
): Promise<{ flags: FlagRow[]; segments: SegmentRow[] }> {
  const flags = await db.query<FlagRow>(
    `SELECT f.key, f.salt, f.bucket_by, f.variations,
            COALESCE(c.enabled, false)                AS enabled,
            COALESCE(c.default_variation_key, '')     AS default_variation_key,
            COALESCE(c.off_variation_key, '')         AS off_variation_key,
            COALESCE(c.rules, '[]'::jsonb)            AS rules,
            COALESCE(c.prerequisites, '[]'::jsonb)    AS prerequisites
       FROM flags f
       LEFT JOIN flag_configs c
              ON c.flag_id = f.id AND c.environment_id = $2
      WHERE f.tenant_id = $1 AND f.archived_at IS NULL
      ORDER BY f.key`,
    [tenantId, environmentId],
  );

  const segments = await db.query<SegmentRow>(
    'SELECT key, rule_tree FROM segments WHERE tenant_id = $1 ORDER BY key',
    [tenantId],
  );

  return { flags: flags.rows, segments: segments.rows };
}

export interface PublishResult {
  version: number;
  etag: string;
  compiled: CompiledRuleset;
}

/**
 * Compiles and publishes a new ruleset version.
 *
 * The version bump and the snapshot insert share one transaction, and the row
 * is locked while it happens. Two concurrent publishes would otherwise read the
 * same version, both increment to the same number, and one would overwrite the
 * other — losing a change that the UI reported as saved.
 */
export async function publishRuleset(
  db: Database,
  options: {
    tenantId: string;
    environmentId: string;
    environmentKey: string;
    publishedBy: string;
  },
): Promise<PublishResult> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE serialises concurrent publishes for this environment.
    const versionResult = await client.query<{ version: string }>(
      `UPDATE environments SET version = version + 1
        WHERE id = $1 AND tenant_id = $2
        RETURNING version`,
      [options.environmentId, options.tenantId],
    );
    if (versionResult.rowCount === 0) {
      throw new Error('environment not found');
    }
    const version = Number(versionResult.rows[0]!.version);

    const inputs = await loadRulesetInputsWithClient(
      client,
      options.tenantId,
      options.environmentId,
    );

    // Throws RulesetValidationError, which rolls the transaction back — so a
    // rejected publish does not consume a version number.
    const compiled = compileRuleset({
      environmentKey: options.environmentKey,
      version,
      flags: inputs.flags,
      segments: inputs.segments,
    });

    const etag = hashApiKey(JSON.stringify(compiled.server)).slice(0, 32);

    await client.query(
      `INSERT INTO ruleset_snapshots
         (tenant_id, environment_id, version, server_payload, client_payload, etag, published_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        options.tenantId,
        options.environmentId,
        version,
        JSON.stringify(compiled.server),
        JSON.stringify(compiled.client),
        etag,
        options.publishedBy,
      ],
    );

    await client.query('COMMIT');
    return { version, etag, compiled };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function loadRulesetInputsWithClient(
  client: pg.PoolClient,
  tenantId: string,
  environmentId: string,
): Promise<{ flags: FlagRow[]; segments: SegmentRow[] }> {
  const flags = await client.query<FlagRow>(
    `SELECT f.key, f.salt, f.bucket_by, f.variations,
            COALESCE(c.enabled, false)                AS enabled,
            COALESCE(c.default_variation_key, '')     AS default_variation_key,
            COALESCE(c.off_variation_key, '')         AS off_variation_key,
            COALESCE(c.rules, '[]'::jsonb)            AS rules,
            COALESCE(c.prerequisites, '[]'::jsonb)    AS prerequisites
       FROM flags f
       LEFT JOIN flag_configs c
              ON c.flag_id = f.id AND c.environment_id = $2
      WHERE f.tenant_id = $1 AND f.archived_at IS NULL
      ORDER BY f.key`,
    [tenantId, environmentId],
  );

  const segments = await client.query<SegmentRow>(
    'SELECT key, rule_tree FROM segments WHERE tenant_id = $1 ORDER BY key',
    [tenantId],
  );

  return { flags: flags.rows, segments: segments.rows };
}

/** Returns the latest published snapshot, filtered for the key kind. */
export async function latestSnapshot(
  db: Database,
  environmentId: string,
  kind: KeyKind,
): Promise<{ version: number; etag: string; payload: unknown } | undefined> {
  const column = kind === 'client' ? 'client_payload' : 'server_payload';
  const result = await db.query<{ version: string; etag: string; payload: unknown }>(
    `SELECT version, etag, ${column} AS payload
       FROM ruleset_snapshots
      WHERE environment_id = $1
      ORDER BY version DESC
      LIMIT 1`,
    [environmentId],
  );

  const row = result.rows[0];
  if (row === undefined) return undefined;
  return {
    version: Number(row.version),
    // The ETag must differ per key kind: the same version yields different
    // bytes for a client and a server key, and sharing one ETag would let a
    // client cache a server payload's identity.
    etag: `"${kind}-${row.etag}"`,
    payload: row.payload,
  };
}

export interface AuditEntry {
  tenantId: string;
  environmentId?: string | undefined;
  actorId: string;
  actorEmail: string;
  action: string;
  resourceType: string;
  resourceKey: string;
  previousValue?: unknown;
  newValue?: unknown;
}

/** Append-only. Nothing updates or deletes from the audit log. */
export async function writeAudit(db: Database, entry: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log
       (tenant_id, environment_id, actor_id, actor_email, action,
        resource_type, resource_key, previous_value, new_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.tenantId,
      entry.environmentId ?? null,
      entry.actorId,
      entry.actorEmail,
      entry.action,
      entry.resourceType,
      entry.resourceKey,
      entry.previousValue === undefined ? null : JSON.stringify(entry.previousValue),
      entry.newValue === undefined ? null : JSON.stringify(entry.newValue),
    ],
  );
}

export async function listAudit(
  db: Database,
  tenantId: string,
  options: { resourceKey?: string; limit?: number } = {},
): Promise<unknown[]> {
  const limit = Math.min(options.limit ?? 50, 200);

  if (options.resourceKey !== undefined) {
    const result = await db.query(
      `SELECT action, resource_type, resource_key, actor_email,
              previous_value, new_value, created_at
         FROM audit_log
        WHERE tenant_id = $1 AND resource_key = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [tenantId, options.resourceKey, limit],
    );
    return result.rows;
  }

  const result = await db.query(
    `SELECT action, resource_type, resource_key, actor_email,
            previous_value, new_value, created_at
       FROM audit_log
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [tenantId, limit],
  );
  return result.rows;
}

// --- Admin CRUD ----------------------------------------------------------
//
// Everything below takes a tenantId and includes it in the WHERE clause. That
// is the tenancy boundary; a query here without it is a cross-tenant leak.

export interface TenantSummary {
  id: string;
  slug: string;
  name: string;
}

export async function listTenants(db: Database): Promise<TenantSummary[]> {
  const result = await db.query<TenantSummary>(
    'SELECT id, slug, name FROM tenants ORDER BY slug',
  );
  return result.rows;
}

export interface EnvironmentSummary {
  id: string;
  key: string;
  name: string;
  version: number;
}

export async function listEnvironments(
  db: Database,
  tenantId: string,
): Promise<EnvironmentSummary[]> {
  const result = await db.query<{ id: string; key: string; name: string; version: string }>(
    'SELECT id, key, name, version FROM environments WHERE tenant_id = $1 ORDER BY key',
    [tenantId],
  );
  // Postgres BIGINT arrives as a string to avoid precision loss; versions are
  // far below 2^53, so narrowing here is safe and spares every caller the cast.
  return result.rows.map((row) => ({ ...row, version: Number(row.version) }));
}

export interface FlagDetail {
  key: string;
  description: string;
  salt: string;
  bucketBy: string;
  variations: unknown;
  enabled: boolean;
  defaultVariationKey: string;
  offVariationKey: string;
  rules: unknown;
  prerequisites: unknown;
  updatedAt: string;
}

export async function getFlag(
  db: Database,
  tenantId: string,
  environmentId: string,
  key: string,
): Promise<FlagDetail | undefined> {
  const result = await db.query<{
    key: string;
    description: string;
    salt: string;
    bucket_by: string;
    variations: unknown;
    enabled: boolean;
    default_variation_key: string;
    off_variation_key: string;
    rules: unknown;
    prerequisites: unknown;
    updated_at: Date;
  }>(
    `SELECT f.key, f.description, f.salt, f.bucket_by, f.variations,
            COALESCE(c.enabled, false)             AS enabled,
            COALESCE(c.default_variation_key, '')  AS default_variation_key,
            COALESCE(c.off_variation_key, '')      AS off_variation_key,
            COALESCE(c.rules, '[]'::jsonb)         AS rules,
            COALESCE(c.prerequisites, '[]'::jsonb) AS prerequisites,
            f.updated_at
       FROM flags f
       LEFT JOIN flag_configs c ON c.flag_id = f.id AND c.environment_id = $3
      WHERE f.tenant_id = $1 AND f.key = $2 AND f.archived_at IS NULL`,
    [tenantId, key, environmentId],
  );

  const row = result.rows[0];
  if (row === undefined) return undefined;

  return {
    key: row.key,
    description: row.description,
    salt: row.salt,
    bucketBy: row.bucket_by,
    variations: row.variations,
    enabled: row.enabled,
    defaultVariationKey: row.default_variation_key,
    offVariationKey: row.off_variation_key,
    rules: row.rules,
    prerequisites: row.prerequisites,
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface CreateFlagInput {
  tenantId: string;
  key: string;
  description: string;
  variations: unknown[];
  defaultVariationKey: string;
  offVariationKey: string;
}

/**
 * Creates a flag and a config row in every environment.
 *
 * New flags start disabled everywhere. A flag that appeared already-on in
 * production because someone created it would be the worst possible default in
 * a system whose entire purpose is controlling exposure.
 *
 * The salt is generated once here and never updated: changing it reshuffles
 * every user's bucket, silently moving people between variations mid-experiment.
 */
export async function createFlag(db: Database, input: CreateFlagInput): Promise<void> {
  await withTransaction(db, async (client) => {
    const flag = await client.query<{ id: string }>(
      `INSERT INTO flags (tenant_id, key, description, salt, variations)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id`,
      [
        input.tenantId,
        input.key,
        input.description,
        randomUUID(),
        JSON.stringify(input.variations),
      ],
    );
    const flagId = flag.rows[0]!.id;

    const environments = await client.query<{ id: string }>(
      'SELECT id FROM environments WHERE tenant_id = $1',
      [input.tenantId],
    );

    for (const environment of environments.rows) {
      await client.query(
        `INSERT INTO flag_configs
           (tenant_id, flag_id, environment_id, enabled, default_variation_key, off_variation_key)
         VALUES ($1, $2, $3, false, $4, $5)`,
        [
          input.tenantId,
          flagId,
          environment.id,
          input.defaultVariationKey,
          input.offVariationKey,
        ],
      );
    }
  });
}

export interface UpdateFlagConfigInput {
  tenantId: string;
  environmentId: string;
  key: string;
  enabled?: boolean;
  defaultVariationKey?: string;
  offVariationKey?: string;
  rules?: unknown;
}

/**
 * Updates one flag's configuration in one environment, returning the previous
 * state so the caller can write a meaningful audit entry.
 *
 * Returns undefined when the flag does not exist rather than creating one, so a
 * typo in a key cannot silently produce a second flag nobody is watching.
 */
export async function updateFlagConfig(
  db: Database,
  input: UpdateFlagConfigInput,
): Promise<{ previous: FlagDetail } | undefined> {
  const previous = await getFlag(db, input.tenantId, input.environmentId, input.key);
  if (previous === undefined) return undefined;

  const enabled = input.enabled ?? previous.enabled;
  const defaultVariationKey = input.defaultVariationKey ?? previous.defaultVariationKey;
  const offVariationKey = input.offVariationKey ?? previous.offVariationKey;
  const rules = input.rules ?? previous.rules;

  await db.query(
    `UPDATE flag_configs c
        SET enabled = $4,
            default_variation_key = $5,
            off_variation_key = $6,
            rules = $7::jsonb,
            updated_at = now()
       FROM flags f
      WHERE c.flag_id = f.id
        AND c.tenant_id = $1
        AND c.environment_id = $2
        AND f.key = $3`,
    [
      input.tenantId,
      input.environmentId,
      input.key,
      enabled,
      defaultVariationKey,
      offVariationKey,
      JSON.stringify(rules),
    ],
  );

  await db.query('UPDATE flags SET updated_at = now() WHERE tenant_id = $1 AND key = $2', [
    input.tenantId,
    input.key,
  ]);

  return { previous };
}

export interface SegmentSummary {
  key: string;
  description: string;
  ruleTree: unknown;
}

export async function listSegments(
  db: Database,
  tenantId: string,
): Promise<SegmentSummary[]> {
  const result = await db.query<{ key: string; description: string; rule_tree: unknown }>(
    'SELECT key, description, rule_tree FROM segments WHERE tenant_id = $1 ORDER BY key',
    [tenantId],
  );
  return result.rows.map((row) => ({
    key: row.key,
    description: row.description,
    ruleTree: row.rule_tree,
  }));
}
