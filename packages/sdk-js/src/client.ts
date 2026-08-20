import type {
  EvaluationContext,
  EvaluationResult,
  RulesetSnapshot,
} from '@flagship/core';

export interface FlagshipOptions {
  sdkKey: string;
  /** Data-plane base URL. */
  baseUrl: string;
  /** Ruleset used before the first stream frame arrives, and if the network never comes up. */
  bootstrap?: RulesetSnapshot;
  /** Fall back to ETag polling when SSE is unavailable. */
  pollIntervalMs?: number;
}

/**
 * Holds the whole ruleset in memory; `evaluate` never performs network I/O.
 */
export class FlagshipClient {
  readonly #options: FlagshipOptions;
  #snapshot: RulesetSnapshot | undefined;

  constructor(options: FlagshipOptions) {
    this.#options = options;
    this.#snapshot = options.bootstrap;
  }

  get version(): number {
    return this.#snapshot?.version ?? -1;
  }

  async start(): Promise<void> {
    throw new Error('not implemented: streaming connection');
  }

  async close(): Promise<void> {
    throw new Error('not implemented: streaming connection');
  }

  evaluate<T>(_flagKey: string, _context: EvaluationContext, _fallback: T): EvaluationResult<T> {
    throw new Error('not implemented: evaluation engine');
  }

  /** Rejects stale frames so out-of-order SSE delivery cannot regress state. */
  applySnapshot(next: RulesetSnapshot): boolean {
    if (this.#snapshot && next.version <= this.#snapshot.version) return false;
    this.#snapshot = next;
    return true;
  }
}
