import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ClickHouseClient, migrateClickHouse } from './clickhouse.ts';
import { createPool, migrate, type Database } from './db.ts';
import { ExposureWriter, MAX_BATCH_SIZE, validateBatch } from './exposures.ts';
import { generateApiKey, type KeyKind } from './keys.ts';
import {
  authenticateKey,
  insertApiKey,
  latestSnapshot,
  listAudit,
  listFlags,
  publishRuleset,
  touchKeyUsage,
  writeAudit,
  type AuthenticatedKey,
} from './repository.ts';
import { RulesetValidationError } from './ruleset.ts';

export interface ServerOptions {
  db: Database;
  logger?: boolean;
  /** Where to push published rulesets. Omitted in tests. */
  dataPlaneUrl?: string | undefined;
  /** Shared secret the data plane requires on its internal publish endpoint. */
  dataPlaneToken?: string | undefined;
  /**
   * Where exposure events are written. Omitted in tests that do not need
   * ClickHouse, and when omitted the ingest endpoint reports itself unavailable
   * rather than pretending to accept events it will silently discard.
   */
  exposureWriter?: ExposureWriter | undefined;
}

declare module 'fastify' {
  interface FastifyRequest {
    sdkKey?: AuthenticatedKey;
  }
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const { db } = options;

  app.get('/healthz', async () => ({ status: 'ok' }));

  /**
   * Resolves an SDK key to its tenant and environment scope.
   *
   * Every SDK-facing route goes through this. The scope it returns is the only
   * thing a handler may act on — a handler that reads a tenant or environment
   * from the request body instead would let any key read any tenant's data.
   */
  async function requireSdkKey(request: FastifyRequest): Promise<AuthenticatedKey | undefined> {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;

    const scope = await authenticateKey(db, header.slice('Bearer '.length));
    if (scope === undefined) return undefined;

    void touchKeyUsage(db, scope.apiKeyId);
    request.sdkKey = scope;
    return scope;
  }

  /**
   * Serves the ruleset an SDK should hold.
   *
   * The payload served depends on the key kind: a client key gets the filtered
   * copy with server-only rules removed. That decision is made from the
   * authenticated key, never from a request parameter, so a client key cannot
   * ask for the server payload.
   */
  app.get('/sdk/v1/snapshot', async (request, reply) => {
    const scope = await requireSdkKey(request);
    if (scope === undefined) {
      return reply.code(401).send({ error: 'invalid or missing SDK key' });
    }

    const snapshot = await latestSnapshot(db, scope.environmentId, scope.kind);
    if (snapshot === undefined) {
      return reply.code(404).send({ error: 'no ruleset published for this environment' });
    }

    reply.header('ETag', snapshot.etag);
    reply.header('X-Flagship-Version', String(snapshot.version));
    reply.header('Cache-Control', 'no-cache, must-revalidate');

    if (request.headers['if-none-match'] === snapshot.etag) {
      return reply.code(304).send();
    }

    return reply.send(snapshot.payload);
  });

  /**
   * Receives a batch of exposure events from an SDK.
   *
   * Answers 202 rather than 200: the events are validated and handed to the
   * writer, but the ClickHouse insert has not completed and may still fail.
   * Awaiting it would put ClickHouse's tail latency on the request path of
   * every SDK flush, and the SDK cannot act on a write failure anyway — it has
   * already discarded its copy of the batch by the time this replies.
   */
  app.post<{ Body: { events?: unknown } }>('/sdk/v1/exposures', async (request, reply) => {
    const scope = await requireSdkKey(request);
    if (scope === undefined) {
      return reply.code(401).send({ error: 'invalid or missing SDK key' });
    }

    const writer = options.exposureWriter;
    if (writer === undefined) {
      return reply.code(503).send({ error: 'exposure ingest is not configured' });
    }

    const events = request.body?.events;
    if (!Array.isArray(events)) {
      return reply.code(400).send({ error: 'events must be an array' });
    }
    if (events.length > MAX_BATCH_SIZE) {
      // Rejected whole rather than truncated, so the SDK's accounting of what
      // was delivered cannot silently disagree with what was stored.
      return reply
        .code(413)
        .send({ error: `batch exceeds ${MAX_BATCH_SIZE} events`, maxBatchSize: MAX_BATCH_SIZE });
    }

    // The scope is what stamps tenant and environment onto every row. Nothing
    // in the body is consulted for either.
    const { rows, rejected } = validateBatch(scope, events);

    if (!writer.enqueue(rows)) {
      // Backpressure, not an error in the request. The SDK treats this like any
      // other failed flush and drops the batch, which is the intended outcome:
      // shedding analytics load is how ingest stays up.
      return reply.code(429).send({ error: 'ingest is saturated', accepted: 0 });
    }

    return reply.code(202).send({ accepted: rows.length, rejected: rejected.length });
  });

  // --- Admin routes -------------------------------------------------------
  //
  // Authenticated here by a bootstrap admin token. The spec calls for OIDC via
  // Auth.js for human users; this is a placeholder that must not ship as-is.

  function requireAdmin(request: FastifyRequest): boolean {
    const expected = process.env['ADMIN_TOKEN'];
    if (expected === undefined || expected === '') return false;
    const header = request.headers.authorization;
    return typeof header === 'string' && header === `Bearer ${expected}`;
  }

  app.get<{ Querystring: { tenantId: string; environmentId: string } }>(
    '/v1/flags',
    async (request, reply) => {
      if (!requireAdmin(request)) return reply.code(401).send({ error: 'unauthorized' });

      const { tenantId, environmentId } = request.query;
      if (!tenantId || !environmentId) {
        return reply.code(400).send({ error: 'tenantId and environmentId are required' });
      }

      return reply.send({ flags: await listFlags(db, tenantId, environmentId) });
    },
  );

  app.post<{
    Body: { tenantId: string; environmentId: string; environmentKey: string; actorEmail?: string };
  }>('/v1/publish', async (request, reply) => {
    if (!requireAdmin(request)) return reply.code(401).send({ error: 'unauthorized' });

    const { tenantId, environmentId, environmentKey, actorEmail } = request.body ?? {};
    if (!tenantId || !environmentId || !environmentKey) {
      return reply
        .code(400)
        .send({ error: 'tenantId, environmentId and environmentKey are required' });
    }

    let published;
    try {
      published = await publishRuleset(db, {
        tenantId,
        environmentId,
        environmentKey,
        publishedBy: actorEmail ?? 'unknown',
      });
    } catch (error) {
      if (error instanceof RulesetValidationError) {
        // The publish is rejected and the transaction rolled back, so no
        // version number was consumed by an invalid ruleset.
        return reply.code(422).send({ error: error.message, problems: error.problems });
      }
      throw error;
    }

    await writeAudit(db, {
      tenantId,
      environmentId,
      actorId: actorEmail ?? 'unknown',
      actorEmail: actorEmail ?? 'unknown',
      action: 'publish',
      resourceType: 'ruleset',
      resourceKey: environmentKey,
      newValue: { version: published.version },
    });

    // Push to the data plane so connected SDKs receive it over SSE. A failure
    // here does not fail the publish: the ruleset is durably stored, and data
    // plane nodes reconcile by polling the snapshot endpoint.
    let pushed = false;
    if (options.dataPlaneUrl) {
      try {
        const response = await fetch(`${options.dataPlaneUrl}/internal/v1/publish`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(options.dataPlaneToken
              ? { Authorization: `Bearer ${options.dataPlaneToken}` }
              : {}),
          },
          body: JSON.stringify({
            environment: environmentKey,
            version: published.version,
            payload: published.compiled.server,
          }),
          signal: AbortSignal.timeout(5000),
        });
        pushed = response.ok;
      } catch (error) {
        app.log.warn({ err: error }, 'data plane push failed; SDKs will reconcile by polling');
      }
    }

    return reply.send({ version: published.version, etag: published.etag, pushed });
  });

  app.post<{
    Body: { tenantId: string; environmentId: string; name: string; kind: KeyKind };
  }>('/v1/api-keys', async (request, reply) => {
    if (!requireAdmin(request)) return reply.code(401).send({ error: 'unauthorized' });

    const { tenantId, environmentId, name, kind } = request.body ?? {};
    if (!tenantId || !environmentId || !name) {
      return reply.code(400).send({ error: 'tenantId, environmentId and name are required' });
    }
    if (kind !== 'client' && kind !== 'server') {
      return reply.code(400).send({ error: 'kind must be "client" or "server"' });
    }

    const generated = generateApiKey(kind);
    const id = await insertApiKey(db, {
      tenantId,
      environmentId,
      name,
      kind,
      prefix: generated.prefix,
      hash: generated.hash,
    });

    await writeAudit(db, {
      tenantId,
      environmentId,
      actorId: 'admin',
      actorEmail: 'admin',
      action: 'create',
      resourceType: 'api_key',
      resourceKey: name,
      newValue: { kind, prefix: generated.prefix },
    });

    // The plaintext is returned exactly once and never stored.
    return reply.code(201).send({ id, key: generated.plaintext, kind, prefix: generated.prefix });
  });

  app.get<{ Querystring: { tenantId: string; resourceKey?: string } }>(
    '/v1/audit',
    async (request, reply) => {
      if (!requireAdmin(request)) return reply.code(401).send({ error: 'unauthorized' });

      const { tenantId, resourceKey } = request.query;
      if (!tenantId) return reply.code(400).send({ error: 'tenantId is required' });

      const entries = await listAudit(db, tenantId, resourceKey ? { resourceKey } : {});
      return reply.send({ entries });
    },
  );

  return app;
}

const entry = process.argv[1];
const isEntrypoint = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (isEntrypoint) {
  const port = Number(process.env['PORT'] ?? 4000);
  const db = createPool();
  const clickhouse = new ClickHouseClient();

  // The writer reports failures through the app's logger and the app needs the
  // writer at construction, so the logger is reached lazily through this
  // binding rather than by giving the writer a logger of its own.
  let app: FastifyInstance;
  const exposureWriter = new ExposureWriter({
    client: clickhouse,
    onError: (error) => app.log.warn({ err: error }, 'exposure insert failed'),
  });

  app = buildServer({
    db,
    logger: true,
    dataPlaneUrl: process.env['DATA_PLANE_URL'],
    dataPlaneToken: process.env['PUBLISH_TOKEN'],
    exposureWriter,
  });

  migrate(db)
    .then(async (ran) => {
      if (ran.length > 0) app.log.info({ migrations: ran }, 'applied migrations');

      // Analytics storage being down is not a reason to refuse to serve flags.
      // The ingest route reports it per request; flag delivery is unaffected.
      try {
        const statements = await migrateClickHouse(clickhouse);
        app.log.info({ statements }, 'applied ClickHouse schema');
      } catch (error) {
        app.log.warn({ err: error }, 'ClickHouse schema not applied; exposure ingest will fail');
      }

      return app.listen({ port, host: '0.0.0.0' });
    })
    .catch((error: unknown) => {
      app.log.error(error);
      process.exit(1);
    });
}
