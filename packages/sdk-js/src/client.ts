import {
  evaluateFlag,
  indexSnapshot,
  type EvaluationContext,
  type EvaluationEnvironment,
  type EvaluationResult,
  type RulesetSnapshot,
} from '@flagship/core';

export interface FlagshipOptions {
  sdkKey: string;
  /** Data-plane base URL. */
  baseUrl: string;
  /** Ruleset used before the first stream frame arrives, and if the network never comes up. */
  bootstrap?: RulesetSnapshot;
  /** Invoked for each evaluation, for the exposure pipeline. Must not block. */
  onExposure?: (event: ExposureRecord) => void;
  /** Surfaces internal faults without routing them through the host's error handling. */
  onError?: (error: Error) => void;
}

export interface ExposureRecord {
  flagKey: string;
  variationKey: string;
  contextKey: string;
  rulesetVersion: number;
  reason: EvaluationResult['reason'];
}

/**
 * In-process flag client.
 *
 * `evaluate` performs no network I/O and never throws: on any fault it returns
 * the caller's fallback. Both properties are load-bearing — this object lives in
 * someone else's request path and must never be the reason their request fails.
 */
export class FlagshipClient {
  readonly #options: FlagshipOptions;
  #snapshot: RulesetSnapshot | undefined;
  /** Rebuilt only when a snapshot is applied, never during evaluation. */
  #env: EvaluationEnvironment | undefined;

  constructor(options: FlagshipOptions) {
    this.#options = options;
    if (options.bootstrap) this.#apply(options.bootstrap);
  }

  /** Version currently held, or -1 before any ruleset has been applied. */
  get version(): number {
    return this.#snapshot?.version ?? -1;
  }

  /** True once a ruleset is available and evaluation will return real values. */
  get ready(): boolean {
    return this.#env !== undefined;
  }

  async start(): Promise<void> {
    throw new Error('not implemented: streaming connection');
  }

  async close(): Promise<void> {
    throw new Error('not implemented: streaming connection');
  }

  /**
   * Evaluates a flag against a context.
   *
   * Returns `fallback` when no ruleset has loaded yet, so a cold start or a
   * total backend outage degrades to the caller's default rather than an error.
   */
  evaluate<T>(flagKey: string, context: EvaluationContext, fallback: T): EvaluationResult<T> {
    const env = this.#env;
    if (env === undefined) {
      return {
        value: fallback,
        variationKey: '',
        reason: { kind: 'error', message: 'no ruleset loaded' },
      };
    }

    const result = evaluateFlag(flagKey, context, env, fallback);
    this.#recordExposure(flagKey, context, result);
    return result;
  }

  /** Convenience wrapper for the common boolean case. */
  isEnabled(flagKey: string, context: EvaluationContext, fallback = false): boolean {
    const result = this.evaluate(flagKey, context, fallback);
    return typeof result.value === 'boolean' ? result.value : fallback;
  }

  /**
   * Applies a ruleset, rejecting anything not newer than what is held.
   *
   * This is what makes out-of-order SSE delivery safe: a delayed frame carrying
   * an older version is dropped rather than regressing every evaluation.
   * Returns true if the snapshot was applied.
   */
  applySnapshot(next: RulesetSnapshot): boolean {
    if (this.#snapshot !== undefined && next.version <= this.#snapshot.version) return false;
    this.#apply(next);
    return true;
  }

  #apply(snapshot: RulesetSnapshot): void {
    this.#snapshot = snapshot;
    // Index once per apply. Evaluation must never pay this cost.
    this.#env = indexSnapshot(snapshot);
  }

  /**
   * Exposure recording must never propagate into the caller. A throwing
   * callback is the host's bug, but it would surface as a flag check failing.
   */
  #recordExposure<T>(
    flagKey: string,
    context: EvaluationContext,
    result: EvaluationResult<T>,
  ): void {
    const { onExposure } = this.#options;
    if (onExposure === undefined) return;
    // An errored evaluation is not an exposure — the user never saw a variation.
    if (result.reason.kind === 'error') return;

    try {
      onExposure({
        flagKey,
        variationKey: result.variationKey,
        contextKey: context.key,
        rulesetVersion: this.version,
        reason: result.reason,
      });
    } catch (error) {
      this.#reportError(error);
    }
  }

  #reportError(error: unknown): void {
    const { onError } = this.#options;
    if (onError === undefined) return;
    try {
      onError(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // A throwing error handler is where we stop. Swallowing here is the only
      // way to guarantee the host never sees an exception from this SDK.
    }
  }
}
