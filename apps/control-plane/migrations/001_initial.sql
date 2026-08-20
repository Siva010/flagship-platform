-- Flagship control plane schema.
--
-- Tenancy is enforced at the row level: every table that holds tenant data
-- carries tenant_id, and every query goes through a middleware that scopes it.
-- Postgres RLS is enabled as defence in depth, so a handler that forgets the
-- scope returns nothing rather than another tenant's data.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE environments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  name        TEXT NOT NULL,
  -- Monotonic per environment. Every ruleset publish bumps it, and SDKs reject
  -- any payload older than what they hold.
  version     BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE TABLE segments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- Rule trees are arbitrarily shaped, so JSONB rather than a table per node
  -- kind. GIN indexing keeps containment queries fast.
  rule_tree   JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE INDEX segments_rule_tree_idx ON segments USING GIN (rule_tree jsonb_path_ops);

CREATE TABLE flags (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  -- Bucketing salt. Stable for the life of the flag; changing it reshuffles
  -- every user, which is why it is set once at creation and never updated.
  salt            TEXT NOT NULL,
  bucket_by       TEXT NOT NULL DEFAULT 'key',
  variations      JSONB NOT NULL,
  -- Stale-flag detection reads this. A flag nobody has evaluated in months is
  -- almost always dead code behind a permanently-true condition.
  last_evaluated_at TIMESTAMPTZ,
  archived_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

-- A flag's configuration differs per environment: on in dev, off in prod.
CREATE TABLE flag_configs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  flag_id               UUID NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
  environment_id        UUID NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  enabled               BOOLEAN NOT NULL DEFAULT false,
  default_variation_key TEXT NOT NULL,
  off_variation_key     TEXT NOT NULL,
  rules                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  prerequisites         JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (flag_id, environment_id)
);

CREATE INDEX flag_configs_environment_idx ON flag_configs (environment_id);
CREATE INDEX flag_configs_rules_idx ON flag_configs USING GIN (rules jsonb_path_ops);

-- API keys are stored hashed. The prefix is indexed so lookup is a single
-- indexed probe rather than a scan hashing every row.
CREATE TABLE api_keys (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment_id UUID NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  -- 'client' keys ship in browser bundles and receive a filtered payload with
  -- server-only rules stripped. 'server' keys receive everything.
  kind           TEXT NOT NULL CHECK (kind IN ('client', 'server')),
  key_prefix     TEXT NOT NULL,
  key_hash       TEXT NOT NULL,
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX api_keys_prefix_idx ON api_keys (key_prefix) WHERE revoked_at IS NULL;

-- Append-only. Nothing updates or deletes from this table.
CREATE TABLE audit_log (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment_id UUID REFERENCES environments(id) ON DELETE SET NULL,
  actor_id       TEXT NOT NULL,
  actor_email    TEXT NOT NULL,
  action         TEXT NOT NULL,
  resource_type  TEXT NOT NULL,
  resource_key   TEXT NOT NULL,
  previous_value JSONB,
  new_value      JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial index for the common query: recent changes to one flag. Without the
-- predicate this index would cover the whole table for a query that never
-- looks past the last few weeks.
CREATE INDEX audit_log_resource_recent_idx
  ON audit_log (tenant_id, resource_type, resource_key, created_at DESC);

-- Published ruleset snapshots, for SDK bootstrap and rollback.
CREATE TABLE ruleset_snapshots (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  environment_id UUID NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  version        BIGINT NOT NULL,
  server_payload JSONB NOT NULL,
  client_payload JSONB NOT NULL,
  etag           TEXT NOT NULL,
  published_by   TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (environment_id, version)
);

CREATE INDEX ruleset_snapshots_latest_idx
  ON ruleset_snapshots (environment_id, version DESC);
