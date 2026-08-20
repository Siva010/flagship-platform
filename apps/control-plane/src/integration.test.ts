/**
 * Integration tests against a real Postgres.
 *
 * Skipped when no database is reachable, so `npm test` stays green on a machine
 * without Docker. Run `npm run infra:up` first to exercise them.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createPool, migrate, type Database } from './db.ts';
import { generateApiKey } from './keys.ts';
import { authenticateKey, insertApiKey, latestSnapshot, publishRuleset } from './repository.ts';
import { buildServer } from './server.ts';
import type { FastifyInstance } from 'fastify';

const ADMIN_TOKEN = 'test-admin-token';

let db: Database;
let app: FastifyInstance;
let available = false;

async function canConnect(pool: Database): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

before(async () => {
  process.env['ADMIN_TOKEN'] = ADMIN_TOKEN;
  db = createPool();
  available = await canConnect(db);
  if (!available) {
    console.log('  (skipping integration tests: Postgres unreachable — run `npm run infra:up`)');
    return;
  }

  await migrate(db);
  // Each run starts clean. CASCADE reaches every dependent row.
  await db.query('TRUNCATE tenants CASCADE');

  app = buildServer({ db });
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  if (db) await db.end();
});

/** Creates a tenant with one environment, returning both ids. */
async function seedTenant(slug: string, environmentKey = 'production') {
  const tenant = await db.query<{ id: string }>(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
    [slug, slug],
  );
  const tenantId = tenant.rows[0]!.id;

  const environment = await db.query<{ id: string }>(
    'INSERT INTO environments (tenant_id, key, name) VALUES ($1, $2, $3) RETURNING id',
    [tenantId, environmentKey, environmentKey],
  );
  return { tenantId, environmentId: environment.rows[0]!.id, environmentKey };
}

async function seedFlag(
  tenantId: string,
  environmentId: string,
  key: string,
  rules: unknown[] = [],
) {
  const flag = await db.query<{ id: string }>(
    `INSERT INTO flags (tenant_id, key, salt, variations)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [
      tenantId,
      key,
      `${key}-salt`,
      JSON.stringify([
        { key: 'on', value: true },
        { key: 'off', value: false },
      ]),
    ],
  );

  await db.query(
    `INSERT INTO flag_configs
       (tenant_id, flag_id, environment_id, enabled, default_variation_key, off_variation_key, rules)
     VALUES ($1, $2, $3, true, 'off', 'off', $4::jsonb)`,
    [tenantId, flag.rows[0]!.id, environmentId, JSON.stringify(rules)],
  );
}

describe('migrations', () => {
  it('are idempotent', async (t) => {
    if (!available) return t.skip('Postgres unreachable');
    // Running twice must be a no-op, or a redeploy would fail on every boot.
    const ran = await migrate(db);
    assert.deepEqual(ran, []);
  });
});

describe('API key authentication', () => {
  it('resolves a key to its tenant and environment scope', async (t) => {
    if (!available) return t.skip('Postgres unreachable');

    const { tenantId, environmentId } = await seedTenant('auth-test');
    const generated = generateApiKey('server');
    await insertApiKey(db, {
      tenantId,
      environmentId,
      name: 'test',
      kind: 'server',
      prefix: generated.prefix,
      hash: generated.hash,
    });

    const scope = await authenticateKey(db, generated.plaintext);
    assert.ok(scope, 'key should authenticate');
    assert.equal(scope.tenantId, tenantId);
    assert.equal(scope.kind, 'server');
  });

  it('rejects an unknown key', async (t) => {
    if (!available) return t.skip('Postgres unreachable');
    const stranger = generateApiKey('server');
    assert.equal(await authenticateKey(db, stranger.plaintext), undefined);
  });

  it('rejects a revoked key', async (t) => {
    if (!available) return t.skip('Postgres unreachable');

    const { tenantId, environmentId } = await seedTenant('revoked-test');
    const generated = generateApiKey('server');
    const id = await insertApiKey(db, {
      tenantId,
      environmentId,
      name: 'doomed',
      kind: 'server',
      prefix: generated.prefix,
      hash: generated.hash,
    });

    await db.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [id]);
    assert.equal(await authenticateKey(db, generated.plaintext), undefined);
  });
});

describe('publishing', () => {
  it('increments the version and stores both payloads', async (t) => {
    if (!available) return t.skip('Postgres unreachable');

    const seed = await seedTenant('publish-test');
    await seedFlag(seed.tenantId, seed.environmentId, 'checkout');

    const first = await publishRuleset(db, { ...seed, publishedBy: 'test' });
    assert.equal(first.version, 1);

    const second = await publishRuleset(db, { ...seed, publishedBy: 'test' });
    assert.equal(second.version, 2, 'version must advance');

    const server = await latestSnapshot(db, seed.environmentId, 'server');
    const client = await latestSnapshot(db, seed.environmentId, 'client');
    assert.equal(server?.version, 2);
    assert.equal(client?.version, 2);
    assert.notEqual(server?.etag, client?.etag, 'ETags must differ by key kind');
  });

  it('does not consume a version number when validation fails', async (t) => {
    if (!available) return t.skip('Postgres unreachable');

    const seed = await seedTenant('invalid-publish');
    // A rule referencing a segment that does not exist.
    await seedFlag(seed.tenantId, seed.environmentId, 'broken', [
      {
        id: 'r1',
        description: '',
        when: { kind: 'segment', segmentKey: 'ghost', negate: false },
        serve: { variationKey: 'on' },
      },
    ]);

    await assert.rejects(() => publishRuleset(db, { ...seed, publishedBy: 'test' }));

    const version = await db.query<{ version: string }>(
      'SELECT version FROM environments WHERE id = $1',
      [seed.environmentId],
    );
    assert.equal(
      Number(version.rows[0]!.version),
      0,
      'a rejected publish must roll back the version bump',
    );
  });

  it('strips server-only rules from the client payload end to end', async (t) => {
    if (!available) return t.skip('Postgres unreachable');

    const seed = await seedTenant('filter-test');
    await seedFlag(seed.tenantId, seed.environmentId, 'secret', [
      {
        id: 'r1',
        description: '',
        when: {
          kind: 'condition',
          attribute: 'email',
          operator: 'endsWith',
          values: ['@competitor.com'],
          visibility: 'server',
        },
        serve: { variationKey: 'on' },
      },
    ]);

    await publishRuleset(db, { ...seed, publishedBy: 'test' });

    const server = await latestSnapshot(db, seed.environmentId, 'server');
    const client = await latestSnapshot(db, seed.environmentId, 'client');

    assert.ok(JSON.stringify(server?.payload).includes('@competitor.com'));
    assert.equal(
      JSON.stringify(client?.payload).includes('@competitor.com'),
      false,
      'server-only value reached the client payload',
    );
  });
});

describe('SDK snapshot endpoint', () => {
  it('serves the payload matching the key kind, not a requested one', async (t) => {
    if (!available) return t.skip('Postgres unreachable');

    const seed = await seedTenant('sdk-test');
    await seedFlag(seed.tenantId, seed.environmentId, 'gated', [
      {
        id: 'r1',
        description: '',
        when: {
          kind: 'condition',
          attribute: 'email',
          operator: 'endsWith',
          values: ['@internal.example'],
          visibility: 'server',
        },
        serve: { variationKey: 'on' },
      },
    ]);
    await publishRuleset(db, { ...seed, publishedBy: 'test' });

    const clientKey = generateApiKey('client');
    await insertApiKey(db, {
      tenantId: seed.tenantId,
      environmentId: seed.environmentId,
      name: 'browser',
      kind: 'client',
      prefix: clientKey.prefix,
      hash: clientKey.hash,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/sdk/v1/snapshot',
      headers: { authorization: `Bearer ${clientKey.plaintext}` },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(
      response.body.includes('@internal.example'),
      false,
      'a client key must never receive server-only rules',
    );
    assert.ok(response.headers['etag']);
  });

  it('returns 304 for a matching ETag', async (t) => {
    if (!available) return t.skip('Postgres unreachable');

    const seed = await seedTenant('etag-test');
    await seedFlag(seed.tenantId, seed.environmentId, 'f');
    await publishRuleset(db, { ...seed, publishedBy: 'test' });

    const key = generateApiKey('server');
    await insertApiKey(db, {
      tenantId: seed.tenantId,
      environmentId: seed.environmentId,
      name: 'srv',
      kind: 'server',
      prefix: key.prefix,
      hash: key.hash,
    });

    const first = await app.inject({
      method: 'GET',
      url: '/sdk/v1/snapshot',
      headers: { authorization: `Bearer ${key.plaintext}` },
    });
    const etag = first.headers['etag'] as string;

    const second = await app.inject({
      method: 'GET',
      url: '/sdk/v1/snapshot',
      headers: { authorization: `Bearer ${key.plaintext}`, 'if-none-match': etag },
    });

    assert.equal(second.statusCode, 304);
    assert.equal(second.body, '');
  });

  it('rejects a missing or invalid key', async (t) => {
    if (!available) return t.skip('Postgres unreachable');

    const noAuth = await app.inject({ method: 'GET', url: '/sdk/v1/snapshot' });
    assert.equal(noAuth.statusCode, 401);

    const badAuth = await app.inject({
      method: 'GET',
      url: '/sdk/v1/snapshot',
      headers: { authorization: 'Bearer fs_server_nonsense' },
    });
    assert.equal(badAuth.statusCode, 401);
  });

  // The tenancy boundary. A key must see only its own tenant's data, and there
  // is no request parameter that can widen its scope.
  it('never lets one tenant see another tenant flags', async (t) => {
    if (!available) return t.skip('Postgres unreachable');

    const alpha = await seedTenant('tenant-alpha');
    const beta = await seedTenant('tenant-beta');

    await seedFlag(alpha.tenantId, alpha.environmentId, 'alpha-only-flag');
    await seedFlag(beta.tenantId, beta.environmentId, 'beta-only-flag');

    await publishRuleset(db, { ...alpha, publishedBy: 'test' });
    await publishRuleset(db, { ...beta, publishedBy: 'test' });

    const alphaKey = generateApiKey('server');
    await insertApiKey(db, {
      tenantId: alpha.tenantId,
      environmentId: alpha.environmentId,
      name: 'alpha',
      kind: 'server',
      prefix: alphaKey.prefix,
      hash: alphaKey.hash,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/sdk/v1/snapshot',
      headers: { authorization: `Bearer ${alphaKey.plaintext}` },
    });

    assert.ok(response.body.includes('alpha-only-flag'));
    assert.equal(
      response.body.includes('beta-only-flag'),
      false,
      'cross-tenant leak: alpha key saw a beta flag',
    );
  });
});

describe('admin routes', () => {
  it('reject requests without the admin token', async (t) => {
    if (!available) return t.skip('Postgres unreachable');

    for (const url of ['/v1/flags?tenantId=x&environmentId=y', '/v1/audit?tenantId=x']) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 401, `${url} should require auth`);
    }
  });

  it('return 422 with the problems when a publish is invalid', async (t) => {
    if (!available) return t.skip('Postgres unreachable');

    const seed = await seedTenant('admin-invalid');
    await seedFlag(seed.tenantId, seed.environmentId, 'bad', [
      {
        id: 'r1',
        description: '',
        when: { kind: 'segment', segmentKey: 'missing', negate: false },
        serve: { variationKey: 'on' },
      },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/publish',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {
        tenantId: seed.tenantId,
        environmentId: seed.environmentId,
        environmentKey: seed.environmentKey,
      },
    });

    assert.equal(response.statusCode, 422);
    const body = JSON.parse(response.body) as { problems: string[] };
    assert.ok(body.problems.some((problem) => /unknown segment/.test(problem)));
  });

  it('writes an audit entry on publish', async (t) => {
    if (!available) return t.skip('Postgres unreachable');

    const seed = await seedTenant('audit-test');
    await seedFlag(seed.tenantId, seed.environmentId, 'f');

    await app.inject({
      method: 'POST',
      url: '/v1/publish',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { ...seed, actorEmail: 'someone@example.com' },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/audit?tenantId=${seed.tenantId}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });

    const body = JSON.parse(response.body) as { entries: { action: string }[] };
    assert.ok(body.entries.some((entry) => entry.action === 'publish'));
  });

  it('returns a generated key exactly once', async (t) => {
    if (!available) return t.skip('Postgres unreachable');

    const seed = await seedTenant('keygen-test');
    const response = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {
        tenantId: seed.tenantId,
        environmentId: seed.environmentId,
        name: 'ci',
        kind: 'server',
      },
    });

    assert.equal(response.statusCode, 201);
    const body = JSON.parse(response.body) as { key: string };
    assert.ok(body.key.startsWith('fs_server_'));

    // The plaintext must not be recoverable from the database.
    const stored = await db.query<{ key_hash: string }>(
      'SELECT key_hash FROM api_keys WHERE tenant_id = $1',
      [seed.tenantId],
    );
    assert.notEqual(stored.rows[0]!.key_hash, body.key);
  });
});
