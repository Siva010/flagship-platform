import type { BinarySample } from '@flagship/core';
import type { ClickHouseClient } from './clickhouse.ts';
import type { AuthenticatedKey } from './repository.ts';

/**
 * Exposure ingest and aggregation.
 *
 * The tenancy rule from repository.ts holds here too, and harder: tenant_id and
 * environment_key are taken from the authenticated key and written onto every
 * row. The request body does not carry them and is not consulted for them. An
 * SDK key that could name its own tenant would be able to both poison and read
 * another customer's experiment results.
 */

/** One event as the SDK sends it. Mirrors ExposureEvent in @flagship/sdk-js. */
export interface IncomingExposure {
  flagKey: string;
  variationKey: string;
  contextKey: string;
  rulesetVersion: number;
  timestamp: string;
  dedupeKey: string;
}

/** A row as ClickHouse stores it. Field names are the column names. */
interface ExposureRow {
  tenant_id: string;
  environment_key: string;
  flag_key: string;
  variation_key: string;
  context_key: string;
  ruleset_version: number;
  timestamp: string;
  dedupe_key: string;
}

/** Beyond this, a batch is rejected rather than truncated. */
export const MAX_BATCH_SIZE = 1000;

/** Longest a string field may be before it is treated as junk. */
const MAX_FIELD_LENGTH = 512;

/** How far ahead of the server clock a client timestamp may sit. */
const MAX_CLOCK_SKEW_MILLIS = 24 * 60 * 60 * 1000;

/** How far behind. Late batches are normal; last year's are not. */
const MAX_BACKDATE_MILLIS = 30 * 24 * 60 * 60 * 1000;

export interface ValidationOutcome {
  rows: ExposureRow[];
  /** Events dropped for being malformed, with a reason each. */
  rejected: { index: number; reason: string }[];
}

function isUsableString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_LENGTH;
}

/**
 * Formats an instant the way ClickHouse parses DateTime64(3) without
 * ambiguity. `toISOString` output is accepted in most places but not all, and
 * the failure is a parse error on insert rather than at review time.
 */
function toClickHouseDateTime(instant: Date): string {
  return instant.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Validates a batch and stamps it with the key's tenant scope.
 *
 * Bad events are dropped individually rather than failing the batch. An SDK
 * cannot fix a rejected event — it has already discarded its copy — so a 400
 * would only convert one malformed event into the loss of the 999 good ones
 * sharing its batch.
 */
export function validateBatch(scope: AuthenticatedKey, events: unknown[]): ValidationOutcome {
  const now = Date.now();
  const rows: ExposureRow[] = [];
  const rejected: { index: number; reason: string }[] = [];

  events.forEach((candidate, index) => {
    if (typeof candidate !== 'object' || candidate === null) {
      rejected.push({ index, reason: 'not an object' });
      return;
    }
    const event = candidate as Partial<IncomingExposure>;

    for (const field of ['flagKey', 'variationKey', 'contextKey', 'dedupeKey'] as const) {
      if (!isUsableString(event[field])) {
        rejected.push({ index, reason: `${field} must be a string of 1..${MAX_FIELD_LENGTH}` });
        return;
      }
    }

    if (
      typeof event.rulesetVersion !== 'number' ||
      !Number.isInteger(event.rulesetVersion) ||
      event.rulesetVersion < 0
    ) {
      rejected.push({ index, reason: 'rulesetVersion must be a non-negative integer' });
      return;
    }

    const instant = new Date(String(event.timestamp));
    if (Number.isNaN(instant.getTime())) {
      rejected.push({ index, reason: 'timestamp is not a valid date' });
      return;
    }

    // The table partitions by toDate(timestamp), and this value is client
    // supplied. One event with a year-9999 clock creates a partition that
    // never expires under TTL and that every part-count metric then carries.
    // Bounding it keeps a broken client's damage inside its own window.
    const skew = instant.getTime() - now;
    if (skew > MAX_CLOCK_SKEW_MILLIS) {
      rejected.push({ index, reason: 'timestamp too far in the future' });
      return;
    }
    if (-skew > MAX_BACKDATE_MILLIS) {
      rejected.push({ index, reason: 'timestamp too far in the past' });
      return;
    }

    rows.push({
      tenant_id: scope.tenantId,
      environment_key: scope.environmentKey,
      flag_key: event.flagKey as string,
      variation_key: event.variationKey as string,
      context_key: event.contextKey as string,
      ruleset_version: event.rulesetVersion,
      timestamp: toClickHouseDateTime(instant),
      dedupe_key: event.dedupeKey as string,
    });
  });

  return { rows, rejected };
}

/**
 * The slice of ClickHouseClient the writer needs.
 *
 * Narrow on purpose: it lets a test supply a sink that stalls or fails on
 * demand, which is the only way to exercise backpressure deterministically.
 */
export interface ExposureSink {
  insert(table: string, rows: readonly object[]): Promise<void>;
}

export interface ExposureWriterOptions {
  client: ExposureSink;
  /**
   * Rows allowed to be mid-flight at once. Past this, batches are refused.
   */
  maxInFlightRows?: number | undefined;
  onError?: ((error: Error) => void) | undefined;
}

export interface WriterStats {
  accepted: number;
  refused: number;
  written: number;
  failed: number;
  inFlightRows: number;
}

/**
 * Writes batches to ClickHouse without making the caller wait.
 *
 * The route hands rows here and answers the SDK immediately. A ClickHouse that
 * has gone slow — merges, a disk filling, a network partition — must not turn
 * into request latency for every SDK in every customer's application, which is
 * exactly what awaiting the insert would do. Analytics durability is worth less
 * than the ingest endpoint staying responsive; the SDK already treats a failed
 * flush as data it can lose.
 *
 * In-flight rows are bounded for the same reason the SDK's queue is: an
 * unbounded backlog during an outage is a memory leak that outlives the outage.
 *
 * There is deliberately no second layer of batching here. The SDK already
 * coalesces into batches of ~100, and buffering those again server-side would
 * add a window in which a deploy loses acknowledged events, in exchange for an
 * insert rate ClickHouse handles comfortably as it is.
 */
export class ExposureWriter {
  readonly #client: ExposureSink;
  readonly #maxInFlightRows: number;
  readonly #onError: ((error: Error) => void) | undefined;

  #inFlight = new Set<Promise<void>>();
  #inFlightRows = 0;
  #accepted = 0;
  #refused = 0;
  #written = 0;
  #failed = 0;

  constructor(options: ExposureWriterOptions) {
    this.#client = options.client;
    this.#maxInFlightRows = options.maxInFlightRows ?? 50_000;
    this.#onError = options.onError;
  }

  /** Returns false when the batch was refused for backpressure. */
  enqueue(rows: ExposureRow[]): boolean {
    if (rows.length === 0) return true;
    if (this.#inFlightRows + rows.length > this.#maxInFlightRows) {
      this.#refused += rows.length;
      return false;
    }

    this.#inFlightRows += rows.length;
    this.#accepted += rows.length;

    const write = this.#client
      .insert('exposures', rows)
      .then(() => {
        this.#written += rows.length;
      })
      .catch((error: unknown) => {
        this.#failed += rows.length;
        this.#report(error);
      })
      .finally(() => {
        this.#inFlightRows -= rows.length;
        this.#inFlight.delete(write);
      });

    this.#inFlight.add(write);
    return true;
  }

  /**
   * Waits for in-flight writes to land. For shutdown and for tests, which
   * would otherwise assert against rows that have not been inserted yet.
   */
  async drain(): Promise<void> {
    // Settling one wave can enqueue nothing new, but a wave started while the
    // previous was settling is not in the first snapshot of the set.
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
    }
  }

  get stats(): WriterStats {
    return {
      accepted: this.#accepted,
      refused: this.#refused,
      written: this.#written,
      failed: this.#failed,
      inFlightRows: this.#inFlightRows,
    };
  }

  #report(error: unknown): void {
    if (this.#onError === undefined) return;
    try {
      this.#onError(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // A throwing error handler is where this stops.
    }
  }
}

// --- Aggregation ---------------------------------------------------------
//
// Every query below counts with uniqExact over an identity column rather than
// count(). That is what makes them immune to the duplicate rows described in
// migrations/clickhouse/001_exposures.sql: ReplacingMergeTree collapses only at
// merge time, so a retried batch is visible twice until then. uniqExact of a
// dedupe_key or a context_key does not move when its row is inserted again,
// which buys correct numbers without paying for FINAL on every read.

export interface ExposureQuery {
  /** From the authenticated key. Never from a request body. */
  tenantId: string;
  environmentKey: string;
  flagKey: string;
  from: Date;
  /** Exclusive, so adjacent windows neither overlap nor drop an instant. */
  to: Date;
  /** Restricts to one compiled ruleset, when assignment changed mid-flight. */
  rulesetVersion?: number | undefined;
}

export interface VariationExposures {
  variationKey: string;
  /** Distinct events. */
  exposures: number;
  /** Distinct contexts — the denominator an experiment is analysed on. */
  distinctContexts: number;
}

function windowParameters(query: ExposureQuery): Record<string, string | number> {
  return {
    tenantId: query.tenantId,
    environmentKey: query.environmentKey,
    flagKey: query.flagKey,
    from: toClickHouseDateTime(query.from),
    to: toClickHouseDateTime(query.to),
  };
}

/** Exposures and distinct contexts per variation, for one flag and window. */
export async function exposuresByVariation(
  client: ClickHouseClient,
  query: ExposureQuery,
): Promise<VariationExposures[]> {
  const parameters = windowParameters(query);
  let versionPredicate = '';
  if (query.rulesetVersion !== undefined) {
    versionPredicate = 'AND ruleset_version = {rulesetVersion:UInt32}';
    parameters['rulesetVersion'] = query.rulesetVersion;
  }

  const rows = await client.query<{
    variation_key: string;
    exposures: number;
    distinct_contexts: number;
  }>(
    `SELECT variation_key,
            uniqExact(dedupe_key)  AS exposures,
            uniqExact(context_key) AS distinct_contexts
       FROM exposures
      WHERE tenant_id = {tenantId:String}
        AND environment_key = {environmentKey:String}
        AND flag_key = {flagKey:String}
        AND timestamp >= {from:DateTime64(3)}
        AND timestamp <  {to:DateTime64(3)}
        ${versionPredicate}
      GROUP BY variation_key
      ORDER BY variation_key`,
    parameters,
  );

  return rows.map((row) => ({
    variationKey: row.variation_key,
    exposures: row.exposures,
    distinctContexts: row.distinct_contexts,
  }));
}

export interface FlagExposureSummary {
  flagKey: string;
  exposures: number;
  distinctContexts: number;
}

/**
 * Every flag a tenant recorded in the window. Feeds the stale-flag view: a
 * flag with exposures and one variation is a permanently-on flag nobody
 * removed.
 */
export async function exposuresByFlag(
  client: ClickHouseClient,
  query: Omit<ExposureQuery, 'flagKey' | 'rulesetVersion'>,
): Promise<FlagExposureSummary[]> {
  const rows = await client.query<{
    flag_key: string;
    exposures: number;
    distinct_contexts: number;
  }>(
    `SELECT flag_key,
            uniqExact(dedupe_key)  AS exposures,
            uniqExact(context_key) AS distinct_contexts
       FROM exposures
      WHERE tenant_id = {tenantId:String}
        AND environment_key = {environmentKey:String}
        AND timestamp >= {from:DateTime64(3)}
        AND timestamp <  {to:DateTime64(3)}
      GROUP BY flag_key
      ORDER BY distinct_contexts DESC, flag_key`,
    {
      tenantId: query.tenantId,
      environmentKey: query.environmentKey,
      from: toClickHouseDateTime(query.from),
      to: toClickHouseDateTime(query.to),
    },
  );

  return rows.map((row) => ({
    flagKey: row.flag_key,
    exposures: row.exposures,
    distinctContexts: row.distinct_contexts,
  }));
}

export interface HourlyExposures {
  /** Bucket start, ISO 8601 in UTC. */
  hour: string;
  variationKey: string;
  exposures: number;
  /** Approximate: the rollup stores a HyperLogLog sketch, ~0.5% error. */
  approximateDistinctContexts: number;
}

/**
 * Hourly series from the rollup rather than the raw table.
 *
 * This is the dashboard query, and the reason the materialized view exists: a
 * 30-day chart reads ~720 pre-aggregated rows per variation instead of every
 * event the tenant ever recorded. The distinct count it returns is approximate
 * — do not feed it to a significance test, use exposuresByVariation for that.
 */
export async function hourlyExposures(
  client: ClickHouseClient,
  query: ExposureQuery,
): Promise<HourlyExposures[]> {
  const rows = await client.query<{
    hour_utc: string;
    variation_key: string;
    exposures: number;
    distinct_contexts: number;
  }>(
    // Aliased away from the column name: reusing "hour" would make the GROUP BY
    // resolve to the formatted string instead of the DateTime it groups on.
    `SELECT formatDateTime(hour, '%Y-%m-%dT%H:%i:%SZ') AS hour_utc,
            variation_key,
            sum(exposure_count)            AS exposures,
            uniqMerge(distinct_contexts)   AS distinct_contexts
       FROM exposures_hourly
      WHERE tenant_id = {tenantId:String}
        AND environment_key = {environmentKey:String}
        AND flag_key = {flagKey:String}
        -- Converting the bound rather than the column: wrapping the hour column
        -- in a function keeps the result correct and loses the primary index.
        AND hour >= toDateTime({from:DateTime64(3)})
        AND hour <  toDateTime({to:DateTime64(3)})
      GROUP BY hour, variation_key
      ORDER BY hour, variation_key`,
    windowParameters(query),
  );

  return rows.map((row) => ({
    hour: row.hour_utc,
    variationKey: row.variation_key,
    exposures: row.exposures,
    approximateDistinctContexts: row.distinct_contexts,
  }));
}

/**
 * Exposure denominators shaped for the statistics in @flagship/core.
 *
 * Exposures supply `n` and nothing else. `conversions` has to come from the
 * caller's metric source, because whether a context converted is a fact about
 * the customer's product, not about the flag platform. Returning a
 * half-populated BinarySample from here would invite someone to run
 * twoProportionZTest on conversions that are structurally zero and read the
 * result as a real null.
 */
export async function exposureDenominators(
  client: ClickHouseClient,
  query: ExposureQuery,
): Promise<Map<string, number>> {
  const byVariation = await exposuresByVariation(client, query);
  return new Map(byVariation.map((row) => [row.variationKey, row.distinctContexts]));
}

/**
 * Joins exposure denominators to externally measured conversions.
 *
 * A variation with exposures but no conversion entry is a genuine zero, not
 * missing data — nobody in that arm converted. A variation with conversions
 * exceeding its exposures is not, and throws: it means the two sides were
 * measured over different windows or different populations, and silently
 * producing a rate above 1 would send a nonsense sample into the test.
 */
export function toBinarySamples(
  denominators: Map<string, number>,
  conversions: Map<string, number>,
): Map<string, BinarySample> {
  const samples = new Map<string, BinarySample>();

  for (const [variationKey, n] of denominators) {
    const converted = conversions.get(variationKey) ?? 0;
    if (converted > n) {
      throw new Error(
        `variation "${variationKey}" has ${converted} conversions against ${n} exposed contexts`,
      );
    }
    samples.set(variationKey, { n, conversions: converted });
  }

  return samples;
}
