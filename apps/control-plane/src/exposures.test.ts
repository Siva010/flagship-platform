/**
 * Exposure ingest and aggregation.
 *
 * Validation and routing are exercised without any infrastructure. The storage
 * tests need a real ClickHouse and skip when none is reachable, so `npm test`
 * stays green on a machine without Docker — run `npm run infra:up` to exercise
 * them.
 *
 * Nothing here touches Postgres. Key authentication is stubbed instead, both to
 * keep these tests runnable alone and because integration.test.ts truncates the
 * tenants table, which the runner may be doing in a parallel process.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { ClickHouseClient, migrateClickHouse } from './clickhouse.ts';
import type { Database } from './db.ts';
import {
  ExposureWriter,
  MAX_BATCH_SIZE,
  exposureDenominators,
  exposuresByFlag,
  exposuresByVariation,
  hourlyExposures,
  toBinarySamples,
  validateBatch,
} from './exposures.ts';
import { generateApiKey } from './keys.ts';
import type { AuthenticatedKey } from './repository.ts';
import { buildServer } from './server.ts';
import type { FastifyInstance } from 'fastify';

const scope: AuthenticatedKey = {
  tenantId: 'tenant-from-key',
  environmentId: 'environment-id',
  environmentKey: 'production',
  kind: 'server',
  apiKeyId: 'key-id',
};

function anEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    flagKey: 'checkout',
    variationKey: 'treatment',
    contextKey: 'user-1',
    rulesetVersion: 7,
    timestamp: new Date().toISOString(),
    dedupeKey: randomUUID(),
    ...overrides,
  };
}

describe('batch validation', () => {
  // The tenancy boundary. An SDK key may write only its own tenant's rows, and
  // there is no field in the payload that can widen that.
  it('takes tenant and environment from the key, never from the event body', () => {
    const { rows } = validateBatch(
      scope,
      [anEvent({ tenantId: 'victim-tenant', environment_key: 'victim-env', environmentKey: 'x' })],
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.tenant_id, 'tenant-from-key');
    assert.equal(rows[0]!.environment_key, 'production');
  });

  // One bad event must not cost the caller the 999 good ones sharing its batch:
  // the SDK has already discarded its copy and cannot resend them.
  it('drops malformed events individually and keeps the rest', () => {
    const { rows, rejected } = validateBatch(scope, [
      anEvent(),
      anEvent({ flagKey: '' }),
      anEvent({ rulesetVersion: 'seven' }),
      null,
      anEvent(),
    ]);

    assert.equal(rows.length, 2);
    assert.equal(rejected.length, 3);
    assert.deepEqual(
      rejected.map((entry) => entry.index),
      [1, 2, 3],
    );
  });

  // The table partitions on this value, so an unbounded client clock creates
  // partitions that no TTL ever reclaims.
  it('rejects timestamps outside the accepted clock-skew window', () => {
    const farFuture = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString();
    const farPast = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();

    const { rows, rejected } = validateBatch(scope, [
      anEvent({ timestamp: farFuture }),
      anEvent({ timestamp: farPast }),
      anEvent({ timestamp: 'not a date' }),
    ]);

    assert.equal(rows.length, 0);
    assert.equal(rejected.length, 3);
  });

  // ClickHouse rejects some ISO 8601 spellings on insert, and the failure lands
  // at runtime as a parse error rather than at review time.
  it('normalises the timestamp into a form ClickHouse parses unambiguously', () => {
    const instant = new Date(Date.now() - 60_000);
    const { rows } = validateBatch(scope, [anEvent({ timestamp: instant.toISOString() })]);

    assert.match(rows[0]!.timestamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    // The normalisation must not shift the instant into local time.
    assert.equal(new Date(`${rows[0]!.timestamp}Z`).getTime(), instant.getTime());
  });
});

describe('binary samples', () => {
  it('treats a variation with no conversion entry as a genuine zero', () => {
    const samples = toBinarySamples(
      new Map([
        ['control', 500],
        ['treatment', 480],
      ]),
      new Map([['control', 50]]),
    );

    assert.deepEqual(samples.get('control'), { n: 500, conversions: 50 });
    assert.deepEqual(samples.get('treatment'), { n: 480, conversions: 0 });
  });

  // Would otherwise hand the statistics a conversion rate above 1, which the
  // z-test happily consumes and reports a confident nonsense result from.
  it('refuses more conversions than exposed contexts', () => {
    assert.throws(
      () => toBinarySamples(new Map([['control', 10]]), new Map([['control', 11]])),
      /11 conversions against 10/,
    );
  });
});

/**
 * A Database that answers only the key lookup authenticateKey performs. Enough
 * to exercise the route without Postgres.
 */
function stubDatabase(rows: Record<string, unknown>[]): Database {
  return {
    query: async () => ({ rows, rowCount: rows.length }),
  } as unknown as Database;
}

describe('ingest route', () => {
  const key = generateApiKey('server');
  const db = stubDatabase([
    {
      id: scope.apiKeyId,
      tenant_id: scope.tenantId,
      environment_id: scope.environmentId,
      environment_key: scope.environmentKey,
      kind: 'server',
      key_hash: key.hash,
    },
  ]);

  /** Points at a port nothing listens on: enqueue is fire-and-forget, so the
   *  route's behaviour does not depend on the insert succeeding. */
  function unreachableWriter(): ExposureWriter {
    return new ExposureWriter({
      client: new ClickHouseClient({ url: 'http://127.0.0.1:1', timeoutMillis: 50 }),
    });
  }

  it('accepts a valid batch with 202 before the insert completes', async () => {
    const app = buildServer({ db, exposureWriter: unreachableWriter() });
    const response = await app.inject({
      method: 'POST',
      url: '/sdk/v1/exposures',
      headers: { authorization: `Bearer ${key.plaintext}` },
      payload: { events: [anEvent(), anEvent()] },
    });

    assert.equal(response.statusCode, 202);
    assert.deepEqual(JSON.parse(response.body), { accepted: 2, rejected: 0 });
    await app.close();
  });

  it('rejects a request without a valid key', async () => {
    const app = buildServer({ db, exposureWriter: unreachableWriter() });

    const noAuth = await app.inject({
      method: 'POST',
      url: '/sdk/v1/exposures',
      payload: { events: [] },
    });
    assert.equal(noAuth.statusCode, 401);

    const badAuth = await app.inject({
      method: 'POST',
      url: '/sdk/v1/exposures',
      headers: { authorization: 'Bearer fs_server_nonsense' },
      payload: { events: [] },
    });
    assert.equal(badAuth.statusCode, 401);
    await app.close();
  });

  it('rejects a batch larger than the cap whole rather than truncating it', async () => {
    const app = buildServer({ db, exposureWriter: unreachableWriter() });
    const response = await app.inject({
      method: 'POST',
      url: '/sdk/v1/exposures',
      headers: { authorization: `Bearer ${key.plaintext}` },
      payload: { events: Array.from({ length: MAX_BATCH_SIZE + 1 }, () => anEvent()) },
    });

    assert.equal(response.statusCode, 413);
    await app.close();
  });

  it('rejects a body without an events array', async () => {
    const app = buildServer({ db, exposureWriter: unreachableWriter() });
    const response = await app.inject({
      method: 'POST',
      url: '/sdk/v1/exposures',
      headers: { authorization: `Bearer ${key.plaintext}` },
      payload: { events: 'all of them' },
    });

    assert.equal(response.statusCode, 400);
    await app.close();
  });

  // A server built without a writer must say so, not accept events it has
  // nowhere to put.
  it('reports 503 when no exposure writer is configured', async () => {
    const app = buildServer({ db });
    const response = await app.inject({
      method: 'POST',
      url: '/sdk/v1/exposures',
      headers: { authorization: `Bearer ${key.plaintext}` },
      payload: { events: [anEvent()] },
    });

    assert.equal(response.statusCode, 503);
    await app.close();
  });

  it('sheds load rather than growing an unbounded backlog', async () => {
    // A sink that never settles, standing in for a ClickHouse that has gone
    // slow. A refused connection would resolve too fast to fill the bound.
    let release = () => {};
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = new ExposureWriter({
      client: { insert: async () => stalled },
      maxInFlightRows: 1,
    });
    const app = buildServer({ db, exposureWriter: writer });

    const first = await app.inject({
      method: 'POST',
      url: '/sdk/v1/exposures',
      headers: { authorization: `Bearer ${key.plaintext}` },
      payload: { events: [anEvent()] },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/sdk/v1/exposures',
      headers: { authorization: `Bearer ${key.plaintext}` },
      payload: { events: [anEvent()] },
    });

    assert.equal(first.statusCode, 202);
    assert.equal(second.statusCode, 429, 'the second batch should be shed, not queued');

    release();
    await writer.drain();
    await app.close();
  });
});

// --- Storage -------------------------------------------------------------

let clickhouse: ClickHouseClient;
let available = false;

before(async () => {
  clickhouse = new ClickHouseClient();
  available = await clickhouse.ping();
  if (!available) {
    console.log('  (skipping exposure storage tests: ClickHouse unreachable — run `npm run infra:up`)');
    return;
  }
  await migrateClickHouse(clickhouse);
});

/** A fresh tenant per test, so runs never see each other's rows. */
function isolatedScope(): AuthenticatedKey {
  return { ...scope, tenantId: `test-${randomUUID()}` };
}

async function insertEvents(
  tenantScope: AuthenticatedKey,
  events: Record<string, unknown>[],
): Promise<void> {
  const writer = new ExposureWriter({ client: clickhouse });
  const { rows, rejected } = validateBatch(tenantScope, events);
  assert.equal(rejected.length, 0, 'test fixture produced invalid events');
  assert.equal(writer.enqueue(rows), true);
  await writer.drain();
  assert.equal(writer.stats.failed, 0, 'insert into ClickHouse failed');
}

const WINDOW = {
  from: new Date(Date.now() - 60 * 60 * 1000),
  to: new Date(Date.now() + 60 * 60 * 1000),
};

describe('exposure storage', () => {
  it('applies the schema idempotently', async (t) => {
    if (!available) return t.skip('ClickHouse unreachable');
    // Re-applied on every boot, so a second run must be a no-op rather than an
    // error about the table already existing.
    await migrateClickHouse(clickhouse);

    const tables = await clickhouse.query<{ name: string }>(
      "SELECT name FROM system.tables WHERE database = currentDatabase() AND name IN ('exposures', 'exposures_hourly', 'exposures_hourly_mv')",
    );
    assert.equal(tables.length, 3);
  });

  it('counts exposures and distinct contexts per variation', async (t) => {
    if (!available) return t.skip('ClickHouse unreachable');

    const tenantScope = isolatedScope();
    await insertEvents(tenantScope, [
      anEvent({ variationKey: 'control', contextKey: 'a' }),
      anEvent({ variationKey: 'control', contextKey: 'b' }),
      // Same context seen twice: two exposures, one user.
      anEvent({ variationKey: 'control', contextKey: 'b' }),
      anEvent({ variationKey: 'treatment', contextKey: 'c' }),
    ]);

    const byVariation = await exposuresByVariation(clickhouse, {
      tenantId: tenantScope.tenantId,
      environmentKey: tenantScope.environmentKey,
      flagKey: 'checkout',
      ...WINDOW,
    });

    assert.deepEqual(byVariation, [
      { variationKey: 'control', exposures: 3, distinctContexts: 2 },
      { variationKey: 'treatment', exposures: 1, distinctContexts: 1 },
    ]);
  });

  // The whole reason the aggregations count uniqExact(dedupe_key) instead of
  // count(): ReplacingMergeTree collapses duplicates only at merge time, so a
  // retried batch is visible twice until then and a plain count would report it.
  it('is unmoved by a batch delivered twice', async (t) => {
    if (!available) return t.skip('ClickHouse unreachable');

    const tenantScope = isolatedScope();
    const batch = [
      anEvent({ variationKey: 'control', contextKey: 'a' }),
      anEvent({ variationKey: 'control', contextKey: 'b' }),
    ];

    await insertEvents(tenantScope, batch);
    const once = await exposuresByVariation(clickhouse, {
      tenantId: tenantScope.tenantId,
      environmentKey: tenantScope.environmentKey,
      flagKey: 'checkout',
      ...WINDOW,
    });

    await insertEvents(tenantScope, batch);
    const twice = await exposuresByVariation(clickhouse, {
      tenantId: tenantScope.tenantId,
      environmentKey: tenantScope.environmentKey,
      flagKey: 'checkout',
      ...WINDOW,
    });

    assert.deepEqual(once, [{ variationKey: 'control', exposures: 2, distinctContexts: 2 }]);
    assert.deepEqual(twice, once, 'a redelivered batch changed the counts');

    // The raw row count is deliberately NOT asserted to be exactly 4.
    //
    // ReplacingMergeTree collapses duplicates at merge time, on ClickHouse's
    // own schedule — a merge may or may not have run by now. Asserting 4 makes
    // the test fail whenever a merge happens to land between the insert and
    // this query, which is a real intermittent failure rather than a real bug.
    //
    // That nondeterminism is precisely the point. The aggregation above is
    // correct in both states, which is what the assertions actually check; a
    // plain count() would not be, and any future query reaching for one is
    // wrong without FINAL.
    const raw = await clickhouse.query<{ total: number }>(
      'SELECT count() AS total FROM exposures WHERE tenant_id = {tenantId:String}',
      { tenantId: tenantScope.tenantId },
    );
    const rawTotal = raw[0]!.total;
    assert.ok(
      rawTotal === 4 || rawTotal === 2,
      `raw rows = ${rawTotal}; expected 4 (unmerged) or 2 (merged), and nothing else`,
    );
  });

  it('never lets one tenant read another tenant exposures', async (t) => {
    if (!available) return t.skip('ClickHouse unreachable');

    const alpha = isolatedScope();
    const beta = isolatedScope();
    await insertEvents(alpha, [anEvent({ flagKey: 'alpha-only', contextKey: 'a' })]);
    await insertEvents(beta, [anEvent({ flagKey: 'beta-only', contextKey: 'b' })]);

    const flags = await exposuresByFlag(clickhouse, {
      tenantId: alpha.tenantId,
      environmentKey: alpha.environmentKey,
      ...WINDOW,
    });

    assert.deepEqual(
      flags.map((flag) => flag.flagKey),
      ['alpha-only'],
    );
  });

  it('separates environments sharing a tenant', async (t) => {
    if (!available) return t.skip('ClickHouse unreachable');

    const production = isolatedScope();
    const staging: AuthenticatedKey = { ...production, environmentKey: 'staging' };
    await insertEvents(production, [anEvent({ contextKey: 'a' }), anEvent({ contextKey: 'b' })]);
    await insertEvents(staging, [anEvent({ contextKey: 'c' })]);

    const byVariation = await exposuresByVariation(clickhouse, {
      tenantId: production.tenantId,
      environmentKey: 'production',
      flagKey: 'checkout',
      ...WINDOW,
    });

    assert.equal(byVariation[0]!.distinctContexts, 2);
  });

  it('restricts a window to one ruleset version when asked', async (t) => {
    if (!available) return t.skip('ClickHouse unreachable');

    const tenantScope = isolatedScope();
    await insertEvents(tenantScope, [
      anEvent({ contextKey: 'a', rulesetVersion: 7 }),
      anEvent({ contextKey: 'b', rulesetVersion: 8 }),
    ]);

    const version7 = await exposuresByVariation(clickhouse, {
      tenantId: tenantScope.tenantId,
      environmentKey: tenantScope.environmentKey,
      flagKey: 'checkout',
      rulesetVersion: 7,
      ...WINDOW,
    });

    assert.equal(version7.length, 1);
    assert.equal(version7[0]!.distinctContexts, 1);
  });

  it('excludes events outside the requested window', async (t) => {
    if (!available) return t.skip('ClickHouse unreachable');

    const tenantScope = isolatedScope();
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    await insertEvents(tenantScope, [
      anEvent({ contextKey: 'recent' }),
      anEvent({ contextKey: 'old', timestamp: old }),
    ]);

    const recent = await exposuresByVariation(clickhouse, {
      tenantId: tenantScope.tenantId,
      environmentKey: tenantScope.environmentKey,
      flagKey: 'checkout',
      ...WINDOW,
    });

    assert.equal(recent[0]!.distinctContexts, 1);
  });

  // If the materialized view stops firing, the dashboard silently reads zeroes
  // while the raw table is full of events.
  it('rolls up into hourly buckets as rows arrive', async (t) => {
    if (!available) return t.skip('ClickHouse unreachable');

    const tenantScope = isolatedScope();
    await insertEvents(tenantScope, [
      anEvent({ variationKey: 'control', contextKey: 'a' }),
      anEvent({ variationKey: 'control', contextKey: 'b' }),
      anEvent({ variationKey: 'treatment', contextKey: 'c' }),
    ]);

    const series = await hourlyExposures(clickhouse, {
      tenantId: tenantScope.tenantId,
      environmentKey: tenantScope.environmentKey,
      flagKey: 'checkout',
      ...WINDOW,
    });

    const control = series.find((point) => point.variationKey === 'control');
    assert.ok(control, 'the rollup produced no control bucket');
    assert.equal(control.exposures, 2);
    assert.equal(control.approximateDistinctContexts, 2);
  });

  it('produces denominators the statistics package can consume', async (t) => {
    if (!available) return t.skip('ClickHouse unreachable');

    const tenantScope = isolatedScope();
    await insertEvents(tenantScope, [
      ...Array.from({ length: 5 }, (_unused, index) =>
        anEvent({ variationKey: 'control', contextKey: `control-${index}` }),
      ),
      ...Array.from({ length: 4 }, (_unused, index) =>
        anEvent({ variationKey: 'treatment', contextKey: `treatment-${index}` }),
      ),
    ]);

    const denominators = await exposureDenominators(clickhouse, {
      tenantId: tenantScope.tenantId,
      environmentKey: tenantScope.environmentKey,
      flagKey: 'checkout',
      ...WINDOW,
    });
    const samples = toBinarySamples(denominators, new Map([['control', 2]]));

    assert.deepEqual(samples.get('control'), { n: 5, conversions: 2 });
    assert.deepEqual(samples.get('treatment'), { n: 4, conversions: 0 });
  });
});

describe('ingest route against ClickHouse', () => {
  let app: FastifyInstance | undefined;

  after(async () => {
    if (app) await app.close();
  });

  it('stores what it accepted, scoped to the key tenant', async (t) => {
    if (!available) return t.skip('ClickHouse unreachable');

    const tenantScope = isolatedScope();
    const key = generateApiKey('server');
    const writer = new ExposureWriter({ client: clickhouse });

    app = buildServer({
      db: stubDatabase([
        {
          id: tenantScope.apiKeyId,
          tenant_id: tenantScope.tenantId,
          environment_id: tenantScope.environmentId,
          environment_key: tenantScope.environmentKey,
          kind: 'server',
          key_hash: key.hash,
        },
      ]),
      exposureWriter: writer,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/sdk/v1/exposures',
      headers: { authorization: `Bearer ${key.plaintext}` },
      payload: {
        // The body names a different tenant. It must be ignored end to end.
        tenantId: 'victim-tenant',
        events: [
          anEvent({ variationKey: 'control', contextKey: 'a' }),
          anEvent({ variationKey: 'treatment', contextKey: 'b' }),
        ],
      },
    });

    assert.equal(response.statusCode, 202);
    await writer.drain();

    const byVariation = await exposuresByVariation(clickhouse, {
      tenantId: tenantScope.tenantId,
      environmentKey: tenantScope.environmentKey,
      flagKey: 'checkout',
      ...WINDOW,
    });
    assert.equal(byVariation.length, 2);

    const victim = await clickhouse.query<{ total: number }>(
      'SELECT count() AS total FROM exposures WHERE tenant_id = {tenantId:String}',
      { tenantId: 'victim-tenant' },
    );
    assert.equal(victim[0]!.total, 0, 'the request body set the tenant on a stored row');
  });
});
