-- Exposure event storage.
--
-- Postgres holds the control plane's authoritative state — flags, rulesets,
-- keys. This is the other half: an append-only firehose written by every SDK
-- in every customer application, read only by aggregation. Rows are never
-- updated and never fetched individually, which is what makes a columnar store
-- the right answer rather than a fashionable one.
--
-- Statements here are all IF NOT EXISTS and are re-applied on every boot. There
-- is no schema_migrations table as there is for Postgres: ClickHouse has no
-- transactional DDL, so a half-applied migration could not be rolled back and
-- the tracking row would lie about what actually exists. Idempotent DDL that
-- states the desired shape is honest about the guarantees available here.

CREATE TABLE IF NOT EXISTS exposures
(
    -- Tenancy. Written from the authenticated SDK key, never from the request
    -- body. A row whose tenant_id came from client input is a cross-tenant leak
    -- waiting for someone to notice the field is unvalidated.
    tenant_id         String,
    environment_key   LowCardinality(String),

    flag_key          LowCardinality(String),
    variation_key     LowCardinality(String),

    -- High cardinality by definition: one value per end user. Not
    -- LowCardinality — the dictionary would be larger than the data.
    context_key       String,

    -- Which compiled ruleset produced this assignment. An experiment analysed
    -- across a ruleset change is analysing two different assignments as one, so
    -- the analysis engine needs to be able to split on this.
    ruleset_version   UInt32,

    timestamp         DateTime64(3, 'UTC'),

    -- Idempotency key from the SDK, which delivers at-least-once.
    dedupe_key        String,

    -- Server receive time. Distinct from `timestamp`, which is client-supplied
    -- and therefore attacker- and clock-skew-controlled. Keeping both is what
    -- lets you tell a late batch from a wrong clock.
    ingested_at       DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree
PARTITION BY toDate(timestamp)
-- Ordered for the dominant read: "distinct contexts per flag per variation over
-- a time range, for one tenant". Tenant first because every query is scoped to
-- one and it is the most selective prefix available; timestamp last of the
-- filter columns so a range scan reads one contiguous run of granules.
--
-- dedupe_key is appended to make the sorting key an event identity, which is
-- what ReplacingMergeTree collapses on. A retried batch re-sends identical
-- values for every preceding column, so the duplicate sorts onto its original.
ORDER BY (tenant_id, environment_key, flag_key, variation_key, timestamp, dedupe_key)
TTL toDateTime(timestamp) + INTERVAL 180 DAY
SETTINGS index_granularity = 8192;

-- On ReplacingMergeTree, honestly:
--
-- It does NOT give you deduplicated reads. Collapsing happens only when parts
-- merge, on a schedule nobody controls, and never across partitions. A row
-- inserted twice is visible twice — possibly for hours, possibly forever if the
-- part never merges again. `FINAL` forces the collapse at query time but pays
-- for it with a merge on every read.
--
-- The way out taken here is to write aggregations that duplicates cannot move:
-- uniqExact(dedupe_key) counts events and uniqExact(context_key) counts users,
-- and both are idempotent under repeated insertion of an identical row. See
-- exposures.ts. ReplacingMergeTree is then a storage optimisation — it reclaims
-- the space eventually — rather than a correctness mechanism. Any query that
-- reaches for a plain count() over this table is wrong without FINAL.

-- Hourly rollup.
--
-- A dashboard asking "exposures per variation for the last 30 days" over raw
-- rows scans every event the tenant ever recorded. The rollup answers it from
-- roughly (flags x variations x 720) rows instead. Declared as an explicit
-- target table rather than an implicit one so it can be altered and backfilled
-- without dropping the view.
CREATE TABLE IF NOT EXISTS exposures_hourly
(
    tenant_id         String,
    environment_key   LowCardinality(String),
    flag_key          LowCardinality(String),
    variation_key     LowCardinality(String),
    hour              DateTime('UTC'),
    ruleset_version   UInt32,

    -- Raw insert count, so duplicates inflate it. Kept because it is nearly
    -- free and it is the signal you want when diagnosing SDK retry storms.
    exposure_count    SimpleAggregateFunction(sum, UInt64),

    -- uniq, not uniqExact: HyperLogLog in fixed memory with ~0.5% relative
    -- error. Correct trade for a dashboard, wrong for a significance test —
    -- the analysis engine reads exact counts from the raw table instead.
    distinct_contexts AggregateFunction(uniq, String)
)
ENGINE = AggregatingMergeTree
PARTITION BY toDate(hour)
ORDER BY (tenant_id, environment_key, flag_key, variation_key, hour, ruleset_version)
TTL hour + INTERVAL 400 DAY;

-- Fires on insert into `exposures` only. It does not see historical rows, and
-- it does not see the ReplacingMergeTree collapse either — a duplicate that is
-- later merged away has already been counted here. That is the same duplicate
-- sensitivity noted above, now baked into exposure_count.
CREATE MATERIALIZED VIEW IF NOT EXISTS exposures_hourly_mv TO exposures_hourly AS
SELECT
    tenant_id,
    environment_key,
    flag_key,
    variation_key,
    toStartOfHour(timestamp) AS hour,
    ruleset_version,
    count() AS exposure_count,
    uniqState(context_key) AS distinct_contexts
FROM exposures
GROUP BY tenant_id, environment_key, flag_key, variation_key, hour, ruleset_version;
