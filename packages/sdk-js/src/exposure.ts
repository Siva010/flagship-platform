/**
 * Exposure event pipeline.
 *
 * The hard requirement: this must never slow down the host application. A flag
 * platform that adds latency to its customer's request path has failed at its
 * one job, no matter how good its analytics are.
 *
 * That constraint rules out the obvious designs. Sending per-event is a network
 * call on the hot path. Awaiting the send makes the caller wait. An unbounded
 * queue trades latency for a memory leak under load. What is left:
 *
 *  - Buffer in memory, flush on a timer or when the batch fills.
 *  - Bound the buffer. When it is full, drop events rather than growing or
 *    blocking. Analytics data is worth less than the host's availability.
 *  - Sample adaptively as volume rises, so a traffic spike degrades resolution
 *    rather than dropping everything once the buffer saturates.
 *  - Never let a transport failure surface to the caller.
 */

export interface ExposureEvent {
  flagKey: string;
  variationKey: string;
  contextKey: string;
  rulesetVersion: number;
  timestamp: string;
  /** Idempotency key. At-least-once delivery means the server will see repeats. */
  dedupeKey: string;
}

export interface ExposureTransport {
  send(events: ExposureEvent[]): Promise<void>;
}

export interface ExposureBufferOptions {
  transport: ExposureTransport;
  /** Flush once this many events are queued. */
  batchSize?: number;
  /** Flush at least this often, even when the batch is not full. */
  flushIntervalMs?: number;
  /** Hard cap on queued events. Beyond this, events are dropped. */
  maxQueueSize?: number;
  /**
   * Queue occupancy above which sampling begins, as a fraction of maxQueueSize.
   * Below it every event is recorded.
   */
  samplingThreshold?: number;
  onError?: (error: Error) => void;
  /** Injectable for tests. */
  now?: () => number;
}

export interface ExposureStats {
  recorded: number;
  dropped: number;
  sampled: number;
  sent: number;
  failed: number;
  queued: number;
  /** Current sampling rate in [0, 1]. 1 means everything is recorded. */
  samplingRate: number;
}

export class ExposureBuffer {
  readonly #transport: ExposureTransport;
  readonly #batchSize: number;
  readonly #flushIntervalMs: number;
  readonly #maxQueueSize: number;
  readonly #samplingThreshold: number;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #now: () => number;

  #queue: ExposureEvent[] = [];
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  #flushInFlight = false;
  #sequence = 0;

  #recorded = 0;
  #dropped = 0;
  #sampled = 0;
  #sent = 0;
  #failed = 0;

  constructor(options: ExposureBufferOptions) {
    this.#transport = options.transport;
    this.#batchSize = options.batchSize ?? 100;
    this.#flushIntervalMs = options.flushIntervalMs ?? 5000;
    this.#maxQueueSize = options.maxQueueSize ?? 10_000;
    this.#samplingThreshold = options.samplingThreshold ?? 0.5;
    this.#onError = options.onError;
    this.#now = options.now ?? Date.now;
  }

  /** Begins periodic flushing. */
  start(): void {
    if (this.#timer !== undefined || this.#closed) return;
    this.#timer = setInterval(() => {
      void this.flush();
    }, this.#flushIntervalMs);
    // Do not hold the process open just to flush analytics.
    this.#timer.unref?.();
  }

  /**
   * Current sampling rate.
   *
   * Full fidelity until the queue passes the threshold, then degrading toward
   * zero as it fills. Sampling early is better than dropping late: a uniform
   * 50% sample is analysable, whereas "everything until 14:03 then nothing" is
   * a biased dataset that quietly corrupts results.
   */
  get samplingRate(): number {
    const occupancy = this.#queue.length / this.#maxQueueSize;
    if (occupancy <= this.#samplingThreshold) return 1;
    const overage = (occupancy - this.#samplingThreshold) / (1 - this.#samplingThreshold);
    return Math.max(0, 1 - overage);
  }

  /**
   * Records an exposure. Returns false if the event was sampled out or dropped.
   *
   * Synchronous and non-throwing by contract: it is called from the host's
   * request path.
   */
  record(event: Omit<ExposureEvent, 'dedupeKey' | 'timestamp'> & Partial<ExposureEvent>): boolean {
    if (this.#closed) return false;

    if (this.#queue.length >= this.#maxQueueSize) {
      // Hard cap reached. Dropping is the only option that keeps the promise
      // never to block or grow without bound.
      this.#dropped += 1;
      return false;
    }

    const rate = this.samplingRate;
    if (rate < 1 && Math.random() >= rate) {
      this.#sampled += 1;
      return false;
    }

    this.#sequence += 1;
    this.#queue.push({
      flagKey: event.flagKey,
      variationKey: event.variationKey,
      contextKey: event.contextKey,
      rulesetVersion: event.rulesetVersion,
      timestamp: event.timestamp ?? new Date(this.#now()).toISOString(),
      // Deterministic per event so the server can deduplicate a retried batch.
      dedupeKey:
        event.dedupeKey ??
        `${event.contextKey}:${event.flagKey}:${event.rulesetVersion}:${this.#sequence}`,
    });
    this.#recorded += 1;

    if (this.#queue.length >= this.#batchSize) {
      // Fire and forget: the caller must not await the network.
      void this.flush();
    }
    return true;
  }

  /**
   * Sends queued events.
   *
   * Never rejects. A transport failure is reported through onError and the
   * batch is discarded — retrying in memory would grow the queue during exactly
   * the outage that caused the failure.
   */
  async flush(): Promise<void> {
    if (this.#flushInFlight || this.#queue.length === 0) return;

    this.#flushInFlight = true;
    const batch = this.#queue.splice(0, this.#queue.length);

    try {
      await this.#transport.send(batch);
      this.#sent += batch.length;
    } catch (error) {
      this.#failed += batch.length;
      this.#report(error);
    } finally {
      this.#flushInFlight = false;
    }
  }

  /** Flushes and stops. Safe to call more than once. */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.flush();
  }

  get stats(): ExposureStats {
    return {
      recorded: this.#recorded,
      dropped: this.#dropped,
      sampled: this.#sampled,
      sent: this.#sent,
      failed: this.#failed,
      queued: this.#queue.length,
      samplingRate: this.samplingRate,
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

/** HTTP transport. Failures propagate to the buffer, which absorbs them. */
export class HttpExposureTransport implements ExposureTransport {
  readonly #url: string;
  readonly #sdkKey: string;
  readonly #timeoutMs: number;

  constructor(options: { url: string; sdkKey: string; timeoutMs?: number }) {
    this.#url = options.url;
    this.#sdkKey = options.sdkKey;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async send(events: ExposureEvent[]): Promise<void> {
    // A hung request must not pin the buffer's in-flight flag forever.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await fetch(this.#url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.#sdkKey}`,
        },
        body: JSON.stringify({ events }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`exposure ingest returned ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
