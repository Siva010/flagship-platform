# Running the stack

Three services — console, control plane, data plane — plus Postgres, Redis and
ClickHouse, in one compose file.

## Quick start

```bash
cp infra/.env.example infra/.env
```

Fill in every value. Generate the tokens rather than inventing them:

```bash
openssl rand -hex 32
```

```bash
docker compose -f infra/docker-compose.prod.yml up -d
```

The console is on `http://localhost:3000`, the control plane on `:4000`, the
data plane on `:8080`. Postgres, Redis and ClickHouse are reachable only from
inside the compose network — nothing outside needs them, and not publishing
them means a development machine cannot accidentally expose a database.

The control plane runs its Postgres migrations on boot, so the first start
takes a few seconds longer than later ones.

### A tenant to work with

The schema ships empty; there is no seed data and no signup flow yet.

```bash
docker compose -f infra/docker-compose.prod.yml exec postgres psql -U flagship -d flagship -c "INSERT INTO tenants (slug, name) VALUES ('acme','Acme'); INSERT INTO environments (tenant_id, key, name) SELECT id, 'production', 'Production' FROM tenants WHERE slug='acme';"
```

Reload the console and the tenant appears.

## Environment

| Variable | Used by | Purpose |
|---|---|---|
| `ADMIN_TOKEN` | control plane, console | Full administrative access to every tenant. The console holds it server-side and never sends it to the browser. |
| `PUBLISH_TOKEN` | control plane, data plane | Shared secret for ruleset publishes. Both services need the *same* value; the data plane disables its publish endpoint entirely when unset. |
| `POSTGRES_PASSWORD` | control plane, Postgres | |
| `CLICKHOUSE_PASSWORD` | control plane, ClickHouse | |

`infra/.env` is gitignored. These are the only secrets the stack has, there is
no secret manager in front of them, and they are visible in `docker inspect`.

## Images

| Service | Base | Size |
|---|---|---|
| data plane | Alpine | ~20 MB |
| control plane | Node slim | ~250 MB |
| console | Node slim, Next standalone | ~300 MB |

All three run as a non-root user and are built from the repository root so a
single `.dockerignore` governs every build.

The data plane uses Alpine rather than distroless, which would be a few
megabytes smaller. Distroless has no shell and no HTTP client, so nothing inside
the container could run a healthcheck against `/healthz` — an orchestrator would
have to probe from outside. Busybox `wget` is worth the size for a service whose
entire job is holding connections that need to be observed.

## What this is not

This runs the whole system on one machine. It is not a production deployment,
and these are the reasons rather than a disclaimer:

**No TLS.** Everything is plain HTTP. `ADMIN_TOKEN` and `PUBLISH_TOKEN` cross
the network in the clear, which is acceptable inside a compose network on one
host and is not acceptable anywhere else.

**No secret manager.** Secrets arrive as environment variables from a file on
disk. They appear in `docker inspect` and in the process environment.

**One data-plane replica, and it cannot be scaled by changing a number.** The
control plane pushes each publish to exactly one `DATA_PLANE_URL`. A second
replica would hold connections happily and never receive an update, so its
clients would silently serve a stale ruleset until they reconnected elsewhere.
Real horizontal scaling needs the publish fanned out over Redis Streams or NATS
so every node learns of every change. That work is not done.

**Admin authentication is a shared token, not OIDC.** Anyone holding it has
write access to every flag in every tenant. There are no user accounts, no
roles, and no per-user audit attribution — the audit log records `admin`.

**No orchestration.** No restart policy tuning beyond `unless-stopped`, no
rolling deploys, no connection draining. Restarting the data plane drops every
SSE connection at once; clients reconnect and resync, but they all do it
simultaneously.

**Single-node datastores.** Postgres and ClickHouse have no replication and no
backup. The compose volumes are the only copy of the data.

## Verified

The stack was brought up and exercised end to end: all six services reported
healthy, then through the console's own API — create a flag, enable it, publish,
confirm the data plane accepted the push, read the snapshot back, and observe
two ruleset versions arriving over SSE through the console's proxy while a
stream was open.

That run is also what caught the console missing `ADMIN_TOKEN`, which building
the images would never have revealed.
